import {
  classifyClaudeContextGate,
  dropOldestClaudeCompactRounds,
  emergencyShrinkClaudeContextMessages,
  hasUserAuthoredClaudeMessageContent,
  runClaudeCompact,
  validateToolUseResultProtocol,
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

function isToolUseBlock(
  block: MainRuntimeContentBlock
): block is Extract<MainRuntimeContentBlock, { type: 'tool_use' }> {
  return block.type === 'tool_use'
}

function isToolResultBlock(
  block: MainRuntimeContentBlock
): block is Extract<MainRuntimeContentBlock, { type: 'tool_result' }> {
  return block.type === 'tool_result'
}

function isProtocolValid(messages: MainRuntimeMessage[]): boolean {
  return validateToolUseResultProtocol(messages).valid
}

function hasNonToolResultUserContent(message: MainRuntimeMessage): boolean {
  return hasUserAuthoredClaudeMessageContent(message)
}

function hasContinuityAnchor(messages: MainRuntimeMessage[]): boolean {
  return messages.some(hasNonToolResultUserContent)
}

function hasSafeMainRuntimeContext(messages: MainRuntimeMessage[]): boolean {
  return hasContinuityAnchor(messages) && isProtocolValid(messages)
}

function removeOldestClosedToolExchange(
  messages: MainRuntimeMessage[]
): MainRuntimeMessage[] | null {
  for (let start = 0; start < messages.length; start += 1) {
    const message = messages[start]
    if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) continue

    const pendingToolUseIds = new Set(
      message.content.filter(isToolUseBlock).map((block) => block.id)
    )
    if (pendingToolUseIds.size === 0) continue

    let end = start + 1
    let canRemove = false

    while (end < messages.length && pendingToolUseIds.size > 0) {
      const resultMessage = messages[end]
      if (
        !resultMessage ||
        resultMessage.role !== 'user' ||
        !Array.isArray(resultMessage.content) ||
        resultMessage.content.some((block) => !isToolResultBlock(block))
      ) {
        canRemove = false
        break
      }

      for (const block of resultMessage.content.filter(isToolResultBlock)) {
        pendingToolUseIds.delete(block.toolUseId)
      }

      canRemove = pendingToolUseIds.size === 0
      end += 1
    }

    if (!canRemove) continue

    const candidate = [...messages.slice(0, start), ...messages.slice(end)]
    if (
      candidate.length > 0 &&
      candidate.length < messages.length &&
      hasSafeMainRuntimeContext(candidate)
    ) {
      return candidate
    }
  }

  return null
}

function removeOldestNonAnchorMessage(messages: MainRuntimeMessage[]): MainRuntimeMessage[] | null {
  for (let index = 0; index < messages.length; index += 1) {
    if (hasNonToolResultUserContent(messages[index]!)) continue

    const candidate = [...messages.slice(0, index), ...messages.slice(index + 1)]
    if (
      candidate.length > 0 &&
      candidate.length < messages.length &&
      hasSafeMainRuntimeContext(candidate)
    ) {
      return candidate
    }
  }

  return null
}

function dropOldestProtocolSafeMainRuntimeContext(
  messages: MainRuntimeMessage[]
): MainRuntimeMessage[] | null {
  const roundDropped = dropOldestClaudeCompactRounds(messages, 1)
  if (
    roundDropped &&
    roundDropped.length < messages.length &&
    hasSafeMainRuntimeContext(roundDropped)
  ) {
    return roundDropped
  }

  const toolExchangeRemoved = removeOldestClosedToolExchange(messages)
  if (toolExchangeRemoved) return toolExchangeRemoved

  const nonAnchorRemoved = removeOldestNonAnchorMessage(messages)
  if (nonAnchorRemoved) return nonAnchorRemoved

  for (let dropCount = 1; dropCount < messages.length; dropCount += 1) {
    const candidate = messages.slice(dropCount)
    if (
      candidate.length > 0 &&
      candidate.length < messages.length &&
      hasSafeMainRuntimeContext(candidate)
    ) {
      return candidate
    }
  }

  return null
}

type MainRuntimeRequestTokenEstimator = (messages: MainRuntimeMessage[]) => number | Promise<number>

async function estimateMainRuntimeRequestTokens(
  messages: MainRuntimeMessage[],
  estimateTokens?: MainRuntimeRequestTokenEstimator
): Promise<number> {
  try {
    return (await estimateTokens?.(messages)) ?? 0
  } catch {
    return 0
  }
}

async function estimateMainRuntimeShrinkTokens(
  messages: MainRuntimeMessage[],
  estimateTokens?: MainRuntimeRequestTokenEstimator
): Promise<number> {
  return Math.max(
    estimateMainRuntimeMessagesTokens(messages),
    await estimateMainRuntimeRequestTokens(messages, estimateTokens)
  )
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
        return {
          ...block,
          content: `[Tool result compacted for context budget]\n${compacted.text}`
        }
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
  estimateTokens?: MainRuntimeRequestTokenEstimator
  postCompactContext?: string
  focusPrompt?: string
  signal?: AbortSignal
  summarize: (args: {
    systemPrompt: string
    userPrompt: string
    signal?: AbortSignal
  }) => Promise<string>
  now?: () => number
  createId?: () => string
}): Promise<MainRuntimeCompressionPreflightResult> {
  const preCompressed = preCompressMainRuntimeMessages(args.messages, args.config)
  const candidateMessages = preCompressed.messages
  const recentUsage = findRecentMainRuntimeContextUsage(candidateMessages)
  const estimatedRequestTokens = await estimateMainRuntimeRequestTokens(
    candidateMessages,
    args.estimateTokens
  )
  const estimatedTokens = Math.max(
    estimateMainRuntimeMessagesTokens(candidateMessages),
    estimatedRequestTokens
  )
  const conservativeTokens = Math.max(recentUsage, estimatedTokens)
  const initialGate = classifyClaudeContextGate({
    inputTokens: conservativeTokens,
    config: args.config
  })

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

  let finalMessages = compacted.result.compressed ? compacted.messages : candidateMessages
  let finalRequestTokens = await estimateMainRuntimeRequestTokens(
    finalMessages,
    args.estimateTokens
  )
  let finalTokens = Math.max(
    findRecentMainRuntimeContextUsage(finalMessages),
    estimateMainRuntimeMessagesTokens(finalMessages),
    finalRequestTokens
  )
  let finalGate = classifyClaudeContextGate({ inputTokens: finalTokens, config: args.config })
  let emergencyDeferredReason: ClaudeCompactSkipReason | null = null
  let finalMessagesWereShrunk = false

  if (finalGate.blocking) {
    emergencyDeferredReason =
      finalGate.reason === 'hard_context_limit_exceeded' ||
      finalGate.reason === 'reserved_output_budget_exceeded'
        ? finalGate.reason
        : null
    const emergencyShrink = await emergencyShrinkClaudeContextMessages({
      messages: finalMessages,
      config: args.config,
      estimateTokens: (candidateMessages) =>
        estimateMainRuntimeShrinkTokens(candidateMessages, args.estimateTokens)
    })

    if (emergencyShrink.changed) {
      finalMessages = emergencyShrink.messages
      finalMessagesWereShrunk = true
      finalRequestTokens = await estimateMainRuntimeRequestTokens(
        finalMessages,
        args.estimateTokens
      )
      finalTokens = Math.max(
        findRecentMainRuntimeContextUsage(finalMessages),
        estimateMainRuntimeMessagesTokens(finalMessages),
        finalRequestTokens
      )
      finalGate = classifyClaudeContextGate({ inputTokens: finalTokens, config: args.config })
    }

    while (
      (finalGate.blocking ||
        (finalMessagesWereShrunk && !hasSafeMainRuntimeContext(finalMessages))) &&
      finalMessages.length > 1
    ) {
      const nextMessages = dropOldestProtocolSafeMainRuntimeContext(finalMessages)
      if (!nextMessages || nextMessages.length >= finalMessages.length) break
      finalMessages = nextMessages
      finalMessagesWereShrunk = true
      finalRequestTokens = await estimateMainRuntimeRequestTokens(
        finalMessages,
        args.estimateTokens
      )
      finalTokens = Math.max(
        findRecentMainRuntimeContextUsage(finalMessages),
        estimateMainRuntimeMessagesTokens(finalMessages),
        finalRequestTokens
      )
      finalGate = classifyClaudeContextGate({ inputTokens: finalTokens, config: args.config })
    }
  }

  if (
    finalGate.blocking ||
    (finalMessagesWereShrunk && !hasSafeMainRuntimeContext(finalMessages))
  ) {
    const blockedReason = finalGate.blocking ? finalGate.reason : 'hard_context_limit_exceeded'
    return {
      messages: finalMessages,
      compressed: compacted.result.compressed,
      blocked: true,
      reason: blockedReason,
      events: [
        {
          type: 'context_compression_blocked',
          reason: blockedReason,
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
          reason: emergencyDeferredReason ?? compacted.result.reason ?? 'unknown',
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
    messages: finalMessages,
    compressed: true,
    events: [
      { type: 'context_compression_start' },
      {
        type: 'context_compressed',
        originalCount: args.messages.length,
        newCount: finalMessages.length,
        messages: finalMessages
      }
    ]
  }
}
