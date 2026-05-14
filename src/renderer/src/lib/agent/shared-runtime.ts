import { nanoid } from 'nanoid'
import type { AgentEvent, AgentLoopConfig, LoopEndReason, ToolCallState } from './types'
import type { ContentBlock, ToolResultContent, TokenUsage, UnifiedMessage } from '../api/types'
import type { ToolContext } from '../tools/tool-types'
import { buildSidecarAgentRunRequest } from '../ipc/sidecar-protocol'
import { agentBridge } from '../ipc/agent-bridge'
import { registerSidecarApprovalHandler } from '../ipc/sidecar-approval-registry'
import { runAgentViaSidecar } from './run-agent-via-sidecar'
import { runAgentLoop } from './agent-loop'
import { shouldUseRendererLoopForCompression } from './context-compression-routing'
import { compactToolResultForContext } from './context-payload-compaction'

export type SharedAgentRuntimeReason = LoopEndReason | 'shutdown'

const MAX_AGGREGATED_TEXT_CHARS = 500_000
const MAIN_RUNTIME_MESSAGE_POLL_MS = 100

export interface SharedAgentRuntimeState {
  iteration: number
  toolCallCount: number
  toolCalls: ToolCallState[]
  usage: TokenUsage
  aggregatedText: string
  currentAssistantText: string
  lastAssistantText: string
  finalLoopReason: LoopEndReason | null
}

export interface SharedAgentRuntimeControl {
  stop?: boolean
  reason?: SharedAgentRuntimeReason
}

export interface SharedAgentRuntimeHookArgs {
  event: AgentEvent
  state: Readonly<SharedAgentRuntimeState>
  buildToolResultMessage: typeof buildToolResultMessage
}

export interface SharedAgentRuntimeOptions {
  runId?: string
  initialMessages: UnifiedMessage[]
  loopConfig: AgentLoopConfig
  toolContext: ToolContext
  isReadOnlyTool?: (toolName: string) => boolean
  onApprovalNeeded?: (toolCall: ToolCallState) => Promise<boolean>
  hooks?: {
    beforeHandleEvent?: (
      args: SharedAgentRuntimeHookArgs
    ) => Promise<SharedAgentRuntimeControl | void> | SharedAgentRuntimeControl | void
    afterHandleEvent?: (
      args: SharedAgentRuntimeHookArgs
    ) => Promise<SharedAgentRuntimeControl | void> | SharedAgentRuntimeControl | void
  }
}

export interface SharedAgentRuntimeResult {
  reason: SharedAgentRuntimeReason
  iterations: number
  toolCallCount: number
  toolCalls: ToolCallState[]
  usage: TokenUsage
  aggregatedText: string
  finalOutput: string
  /** Full conversation transcript at the moment the loop terminated.
   *  Populated via AgentLoopConfig.captureFinalMessages — callers can
   *  feed it back into a follow-up run (e.g. to synthesize a report). */
  finalMessages: UnifiedMessage[]
  error?: string
}

function runCleanup(cleanup: (() => void) | null): void {
  cleanup?.()
}

export async function runSharedAgentRuntime(
  options: SharedAgentRuntimeOptions
): Promise<SharedAgentRuntimeResult> {
  const {
    runId,
    initialMessages,
    loopConfig,
    toolContext,
    isReadOnlyTool,
    onApprovalNeeded,
    hooks
  } = options

  const state: SharedAgentRuntimeState = {
    iteration: 0,
    toolCallCount: 0,
    toolCalls: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    aggregatedText: '',
    currentAssistantText: '',
    lastAssistantText: '',
    finalLoopReason: null
  }

  let stopReason: SharedAgentRuntimeReason | null = null
  let errorMessage: string | undefined
  let capturedFinalMessages: UnifiedMessage[] = []
  let activeRunId = ''
  let unregisterApprovalHandler: (() => void) | null = null
  let messagePumpTimer: ReturnType<typeof setInterval> | null = null

  const buildHookArgs = (event: AgentEvent): SharedAgentRuntimeHookArgs => ({
    event,
    state,
    buildToolResultMessage
  })

  const applyControl = (control?: SharedAgentRuntimeControl | void): boolean => {
    if (!control?.stop) return false
    stopReason = control.reason ?? stopReason ?? 'completed'
    return true
  }

  const commitAssistantText = (): void => {
    const trimmed = state.currentAssistantText.trim()
    if (trimmed) {
      state.lastAssistantText = trimmed
    }
    state.currentAssistantText = ''
  }

  try {
    let messagePumpActive = false
    const pendingInjectedMessages: UnifiedMessage[] = []

    const flushQueuedMessages = async (): Promise<void> => {
      if (!activeRunId || pendingInjectedMessages.length === 0 || messagePumpActive) return
      messagePumpActive = true
      const batch = pendingInjectedMessages.splice(0, pendingInjectedMessages.length)
      try {
        await agentBridge.appendAgentMessages(activeRunId, batch)
      } catch (error) {
        pendingInjectedMessages.unshift(...batch)
        if (!toolContext.signal.aborted) {
          console.error('[SharedAgentRuntime] Failed to append runtime messages:', error)
        }
      } finally {
        messagePumpActive = false
      }
    }

    const startMessagePump = (): void => {
      if (!loopConfig.messageQueue) return

      messagePumpTimer = setInterval(() => {
        const injected = loopConfig.messageQueue?.drain() ?? []
        if (injected.length > 0) {
          pendingInjectedMessages.push(...injected)
        }
        void flushQueuedMessages()
      }, MAIN_RUNTIME_MESSAGE_POLL_MS)
    }

    const useRendererCompressionLoop = shouldUseRendererLoopForCompression({
      messages: initialMessages,
      provider: loopConfig.provider,
      tools: loopConfig.tools,
      compression: loopConfig.contextCompression?.config ?? null
    })
    const handleApproval = async (toolCall: ToolCallState): Promise<boolean> => {
      if (isReadOnlyTool?.(toolCall.name)) return true
      if (onApprovalNeeded) return await onApprovalNeeded(toolCall)
      return false
    }

    const previousCaptureFinalMessages = loopConfig.captureFinalMessages
    const loop: AsyncIterable<AgentEvent> = useRendererCompressionLoop
      ? runAgentLoop(
          initialMessages,
          {
            ...loopConfig,
            captureFinalMessages: (messages) => {
              capturedFinalMessages = messages
              previousCaptureFinalMessages?.(messages)
            }
          },
          toolContext,
          handleApproval
        )
      : (() => {
          const sidecarRequest = buildSidecarAgentRunRequest({
            messages: initialMessages,
            provider: loopConfig.provider,
            tools: loopConfig.tools,
            ...(runId ? { runId } : {}),
            sessionId: toolContext.sessionId,
            workingFolder: toolContext.workingFolder ?? loopConfig.workingFolder,
            maxIterations: loopConfig.maxIterations,
            forceApproval: loopConfig.forceApproval === true,
            maxParallelTools: loopConfig.maxParallelTools,
            compression: null,
            pluginId: toolContext.pluginId,
            pluginChatId: toolContext.pluginChatId,
            pluginChatType: toolContext.pluginChatType,
            pluginSenderId: toolContext.pluginSenderId,
            pluginSenderName: toolContext.pluginSenderName,
            sshConnectionId: toolContext.sshConnectionId,
            captureFinalMessages: true
          })
          if (!sidecarRequest) {
            throw new Error('Failed to build main-process agent request')
          }

          const sidecarLoop = runAgentViaSidecar(sidecarRequest, {
            signal: toolContext.signal,
            onRunIdAssigned: (assignedRunId) => {
              activeRunId = assignedRunId
              unregisterApprovalHandler = registerSidecarApprovalHandler(
                activeRunId,
                async (request) => {
                  try {
                    if (isReadOnlyTool?.(request.toolCall.name)) {
                      return { approved: true }
                    }

                    if (onApprovalNeeded) {
                      const approved = await onApprovalNeeded(request.toolCall)
                      return {
                        approved,
                        ...(approved
                          ? {}
                          : { reason: 'Runtime approval callback denied permission' })
                      }
                    }

                    return {
                      approved: false,
                      reason: 'No runtime approval handler registered for this agent run'
                    }
                  } catch (error) {
                    return {
                      approved: false,
                      reason: error instanceof Error ? error.message : String(error)
                    }
                  }
                }
              )
              void flushQueuedMessages()
            }
          })

          startMessagePump()
          return sidecarLoop
        })()

    for await (const event of loop) {
      if (toolContext.signal.aborted) {
        stopReason = 'aborted'
        break
      }

      if (applyControl(await hooks?.beforeHandleEvent?.(buildHookArgs(event)))) {
        break
      }

      switch (event.type) {
        case 'iteration_start':
          commitAssistantText()
          state.iteration = event.iteration
          break

        case 'text_delta':
          if (state.aggregatedText.length < MAX_AGGREGATED_TEXT_CHARS) {
            state.aggregatedText += event.text
          }
          state.currentAssistantText += event.text
          break

        case 'tool_call_start':
        case 'tool_call_result': {
          if (event.type === 'tool_call_result') {
            state.toolCallCount += 1
          }
          const idx = state.toolCalls.findIndex((toolCall) => toolCall.id === event.toolCall.id)
          if (idx >= 0) {
            state.toolCalls[idx] = event.toolCall
          } else {
            state.toolCalls.push(event.toolCall)
          }
          break
        }

        case 'message_end':
          if (event.usage) {
            mergeTokenUsage(state.usage, event.usage)
          }
          break

        case 'iteration_end':
          commitAssistantText()
          break

        case 'loop_end':
          commitAssistantText()
          state.finalLoopReason = event.reason
          if (event.messages) {
            capturedFinalMessages = event.messages
          }
          break

        case 'error':
          errorMessage = event.error.message
          stopReason = 'error'
          break
      }

      if (applyControl(await hooks?.afterHandleEvent?.(buildHookArgs(event)))) {
        break
      }

      if (event.type === 'error') {
        break
      }
    }
  } catch (error) {
    stopReason = 'error'
    errorMessage = error instanceof Error ? error.message : String(error)
  } finally {
    if (activeRunId && !state.finalLoopReason && !toolContext.signal.aborted) {
      try {
        await agentBridge.cancelAgent(activeRunId)
      } catch {
        // Ignore teardown races when the run already completed.
      }
    }
    if (messagePumpTimer) {
      clearInterval(messagePumpTimer)
      messagePumpTimer = null
    }
    runCleanup(unregisterApprovalHandler)
    unregisterApprovalHandler = null
    commitAssistantText()
  }

  const reason =
    stopReason ?? (toolContext.signal.aborted ? 'aborted' : (state.finalLoopReason ?? 'completed'))

  return {
    reason,
    iterations: state.iteration,
    toolCallCount: state.toolCallCount,
    toolCalls: [...state.toolCalls],
    usage: { ...state.usage },
    aggregatedText: state.aggregatedText,
    finalOutput:
      state.lastAssistantText || state.currentAssistantText.trim() || state.aggregatedText.trim(),
    finalMessages: capturedFinalMessages,
    ...(errorMessage ? { error: errorMessage } : {})
  }
}

/**
 * Default report-request prompt used by {@link requestFallbackReport}.
 * Exported so callers can override it with domain-specific wording if needed.
 */
export const DEFAULT_FALLBACK_REPORT_PROMPT =
  'Your previous turn ended without producing any visible text. Your caller has no way to see what you did. ' +
  'Now, based on everything you executed in this conversation (tool calls, findings, analysis, attempts, and ' +
  'failures), write a detailed work report. The report MUST include:\n' +
  '1. What you were asked to do and your interpretation of the task.\n' +
  '2. The concrete steps you took, in order, with the key evidence you gathered from each tool call.\n' +
  '3. Your findings, conclusions, or the artifacts you produced (paste or quote the important parts directly).\n' +
  '4. Anything you could NOT finish, and the reason (blocker, missing info, unclear scope, etc.).\n' +
  '5. Concrete next steps or recommendations for the caller.\n\n' +
  'Respond in the same language the task was given in. Output the report body only — do NOT call any tools, ' +
  'do NOT ask clarifying questions, do NOT add preamble like "Here is the report". Just the report.'

/**
 * Re-runs the agent with the captured transcript plus an injected user message
 * asking the model to summarize its work. Tools are disabled so the model is
 * forced to respond with text. Used as a fallback when the primary loop ended
 * with an empty {@link SharedAgentRuntimeResult.finalOutput}.
 *
 * Returns the generated report text, or null if the retry also produced nothing
 * (or if there are no captured messages to replay).
 */
export async function requestFallbackReport(options: {
  capturedMessages: UnifiedMessage[]
  loopConfig: AgentLoopConfig
  toolContext: ToolContext
  reportPrompt?: string
}): Promise<string | null> {
  const { capturedMessages, loopConfig, toolContext, reportPrompt } = options
  if (capturedMessages.length === 0) return null
  if (toolContext.signal.aborted) return null

  const reportRequestMessage: UnifiedMessage = {
    id: nanoid(),
    role: 'user',
    content: reportPrompt ?? DEFAULT_FALLBACK_REPORT_PROMPT,
    createdAt: Date.now()
  }

  const followUpConfig: AgentLoopConfig = {
    ...loopConfig,
    // Strip tools so the model cannot defer work into another tool call —
    // it has no choice but to emit the report as text.
    tools: [],
    // Single iteration is enough; we only want a text response.
    maxIterations: 1,
    // Do not recurse fallback capture.
    captureFinalMessages: undefined,
    // Skip context compression on the follow-up; the transcript is already final.
    contextCompression: undefined,
    // Drop any pending message queue so teammate messages do not pollute the report.
    messageQueue: undefined
  }

  try {
    const retryRuntime = await runSharedAgentRuntime({
      initialMessages: [...capturedMessages, reportRequestMessage],
      loopConfig: followUpConfig,
      toolContext,
      isReadOnlyTool: () => true
    })
    const text = retryRuntime.finalOutput.trim()
    return text ? text : null
  } catch (err) {
    console.error('[SharedAgentRuntime] fallback report synthesis failed:', err)
    return null
  }
}

export function mergeTokenUsage(target: TokenUsage, usage: TokenUsage): void {
  target.inputTokens += usage.inputTokens
  target.outputTokens += usage.outputTokens
  if (usage.billableInputTokens != null) {
    target.billableInputTokens = (target.billableInputTokens ?? 0) + usage.billableInputTokens
  }
  if (usage.cacheCreationTokens) {
    target.cacheCreationTokens = (target.cacheCreationTokens ?? 0) + usage.cacheCreationTokens
  }
  if (usage.cacheCreation5mTokens) {
    target.cacheCreation5mTokens = (target.cacheCreation5mTokens ?? 0) + usage.cacheCreation5mTokens
  }
  if (usage.cacheCreation1hTokens) {
    target.cacheCreation1hTokens = (target.cacheCreation1hTokens ?? 0) + usage.cacheCreation1hTokens
  }
  if (usage.cacheReadTokens) {
    target.cacheReadTokens = (target.cacheReadTokens ?? 0) + usage.cacheReadTokens
  }
  if (usage.reasoningTokens) {
    target.reasoningTokens = (target.reasoningTokens ?? 0) + usage.reasoningTokens
  }
  if (usage.contextLength) {
    target.contextLength = usage.contextLength
  }
}

export function buildToolResultMessage(
  toolResults: {
    toolUseId: string
    toolName?: string
    content: ToolResultContent
    isError?: boolean
  }[]
): UnifiedMessage {
  const content: ContentBlock[] = toolResults.map((result) => {
    const toolName = result.toolName ?? `unknown:${result.toolUseId.slice(0, 8)}`
    const compacted = compactToolResultForContext({
      toolName,
      content: result.content,
      isError: result.isError
    })

    return {
      type: 'tool_result',
      toolUseId: result.toolUseId,
      content: compacted.content,
      ...(result.isError ? { isError: true } : {})
    }
  })

  return {
    id: nanoid(),
    role: 'user',
    content,
    createdAt: Date.now()
  }
}
