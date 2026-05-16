import {
  classifyClaudeContextGate,
  runClaudeCompact,
  type ClaudeCompactConfig,
  type ClaudeCompactContentBlock,
  type ClaudeCompactMessage,
  type ClaudeCompactSkipReason,
  type ClaudeCompactTrigger,
  type ClaudeContextGateReason
} from '../../shared/claude-context-compression'
import { compactShellOutputPayload, compactShellText } from '../../shared/shell-output-compactor'

export type MainRuntimeCompressionConfig = ClaudeCompactConfig
export type MainRuntimeContentBlock = ClaudeCompactContentBlock
export type MainRuntimeMessage = ClaudeCompactMessage
export type MainRuntimeCompressionEvent =
  | { type: 'context_compression_start' }
  | {
      type: 'context_compressed'
      originalCount: number
      newCount: number
      messages: MainRuntimeMessage[]
    }
  | {
      type: 'context_compression_deferred'
      checkpoint: 'before_model_request'
      reason: ClaudeCompactSkipReason
      inputTokens: number
      contextLength: number
      reservedOutputTokens: number
      blockingNextRequest: boolean
      messagesChanged: boolean
    }
  | {
      type: 'context_compression_blocked'
      reason: ClaudeContextGateReason
      inputTokens: number
      contextLength: number
      reservedOutputTokens: number
    }

export interface MainRuntimeCompressionPreflightResult {
  messages: MainRuntimeMessage[]
  compressed: boolean
  blocked?: boolean
  reason?: ClaudeContextGateReason
  events: MainRuntimeCompressionEvent[]
}

function readContextUsage(usage?: MainRuntimeMessage['usage']): number {
  return usage?.contextTokens ?? usage?.inputTokens ?? 0
}

export function findRecentMainRuntimeContextUsage(messages: MainRuntimeMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const tokens = readContextUsage(messages[i]?.usage)
    if (tokens > 0) return tokens
  }
  return 0
}

function estimateMainRuntimeMessagesTokens(messages: MainRuntimeMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4)
}

function compactTextContent(
  text: string,
  config: MainRuntimeCompressionConfig
): { text: string; compacted: boolean } {
  const maxChars = Math.max(1_000, Math.floor(config.contextLength / 10))
  if (text.length <= maxChars) return { text, compacted: false }
  const preview = compactShellText(text, {
    stdoutMaxChars: maxChars,
    streamMaxLines: 160,
    importantLineLimit: 80
  })
  return { text: preview.text, compacted: preview.truncated || preview.text !== text }
}

export function preCompressMainRuntimeMessages(
  messages: MainRuntimeMessage[],
  config: MainRuntimeCompressionConfig
): { messages: MainRuntimeMessage[]; compactedCount: number } {
  let compactedCount = 0
  let changedAny = false
  const next = messages.map((message) => {
    if (!Array.isArray(message.content)) return message
    let changed = false
    const content = message.content.map((block) => {
      if (block.type !== 'tool_result') return block
      if (typeof block.content === 'string') {
        const compacted = compactTextContent(block.content, config)
        if (!compacted.compacted) return block
        compactedCount += 1
        changed = true
        changedAny = true
        return { ...block, content: `[Tool result compacted for context budget]\n${compacted.text}` }
      }
      const compactedPayload = compactShellOutputPayload(
        { output: JSON.stringify(block.content) },
        {
          stdoutMaxChars: 2_000,
          stderrMaxChars: 2_000,
          streamMaxLines: 80,
          importantLineLimit: 60
        }
      )
      compactedCount += 1
      changed = true
      changedAny = true
      return { ...block, content: JSON.stringify(compactedPayload) }
    })
    return changed ? { ...message, content } : message
  })
  return { messages: changedAny ? next : messages, compactedCount }
}

export async function maybeCompactMainRuntimeContext(args: {
  messages: MainRuntimeMessage[]
  config: MainRuntimeCompressionConfig
  trigger: ClaudeCompactTrigger
  postCompactContext?: string
  focusPrompt?: string
  signal?: AbortSignal
  summarize: (args: { systemPrompt: string; userPrompt: string; signal?: AbortSignal }) => Promise<string>
  now?: () => number
  createId?: () => string
}): Promise<MainRuntimeCompressionPreflightResult> {
  const preCompressed = preCompressMainRuntimeMessages(args.messages, args.config)
  const candidateMessages = preCompressed.messages
  const recentUsage = findRecentMainRuntimeContextUsage(candidateMessages)
  const estimatedTokens = estimateMainRuntimeMessagesTokens(candidateMessages)
  const conservativeTokens = Math.max(recentUsage, estimatedTokens)
  const initialGate = classifyClaudeContextGate({ inputTokens: conservativeTokens, config: args.config })

  if (initialGate.kind === 'ok' || initialGate.kind === 'pre_compress') {
    return { messages: candidateMessages, compressed: false, events: [] }
  }

  const compacted = await runClaudeCompact({
    messages: candidateMessages,
    trigger: args.trigger,
    preTokens: conservativeTokens,
    config: args.config,
    postCompactContext: args.postCompactContext,
    focusPrompt: args.focusPrompt,
    sourceRuntime: 'main',
    signal: args.signal,
    summarize: args.summarize,
    now: args.now,
    createId: args.createId
  })

  const finalMessages = compacted.result.compressed ? compacted.messages : candidateMessages
  const finalTokens = Math.max(
    findRecentMainRuntimeContextUsage(finalMessages),
    estimateMainRuntimeMessagesTokens(finalMessages)
  )
  const finalGate = classifyClaudeContextGate({ inputTokens: finalTokens, config: args.config })

  if (finalGate.blocking) {
    return {
      messages: finalMessages,
      compressed: compacted.result.compressed,
      blocked: true,
      reason: finalGate.reason,
      events: [
        {
          type: 'context_compression_blocked',
          reason: finalGate.reason,
          inputTokens: finalGate.inputTokens,
          contextLength: finalGate.contextLength,
          reservedOutputTokens: finalGate.reservedOutputTokens
        }
      ]
    }
  }

  if (!compacted.result.compressed) {
    return {
      messages: finalMessages,
      compressed: false,
      events: [
        {
          type: 'context_compression_deferred',
          checkpoint: 'before_model_request',
          reason: compacted.result.reason ?? 'unknown',
          inputTokens: finalGate.inputTokens,
          contextLength: finalGate.contextLength,
          reservedOutputTokens: finalGate.reservedOutputTokens,
          blockingNextRequest: finalGate.blocking,
          messagesChanged: finalMessages !== candidateMessages
        }
      ]
    }
  }

  return {
    messages: compacted.messages,
    compressed: true,
    events: [
      { type: 'context_compression_start' },
      {
        type: 'context_compressed',
        originalCount: args.messages.length,
        newCount: compacted.messages.length,
        messages: compacted.messages
      }
    ]
  }
}
