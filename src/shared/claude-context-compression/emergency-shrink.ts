import { getClaudeCompactBudget } from './budget'
import { dehydrateClaudeCompactPayloads } from './payload'
import { dropOldestClaudeCompactRounds, validateToolUseResultProtocol } from './rounds'
import { guardClaudeAssistantFinalizePayload, guardClaudeSingleInputPayload } from './text-guards'
import type { ClaudeCompactConfig, ClaudeCompactContentBlock, ClaudeCompactMessage } from './types'

const EMERGENCY_CONTEXT_OMITTED_TEXT =
  '[Earlier local context omitted for context budget. Continue from the remaining recent messages.]'

export interface ClaudeEmergencyContextShrinkResult {
  messages: ClaudeCompactMessage[]
  changed: boolean
  droppedMessages: number
  payloadsCompacted: number
  guardedMessages: number
  strippedUsageMessages: number
}

function estimateMessagesTokens(messages: ClaudeCompactMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4)
}

type EmergencyShrinkTokenEstimator = (messages: ClaudeCompactMessage[]) => number | Promise<number>

function stripUsage(message: ClaudeCompactMessage): {
  message: ClaudeCompactMessage
  changed: boolean
} {
  if (!message.usage) return { message, changed: false }
  const { usage: _usage, ...rest } = message
  return { message: rest, changed: true }
}

function guardTextPayloads(
  messages: ClaudeCompactMessage[],
  config: ClaudeCompactConfig
): { messages: ClaudeCompactMessage[]; changed: boolean; guardedMessages: number } {
  let changed = false
  let guardedMessages = 0

  const nextMessages = messages.map((message) => {
    const guarded =
      message.role === 'user'
        ? guardClaudeSingleInputPayload(message, { config })
        : guardClaudeAssistantFinalizePayload(message, { config })

    if (!guarded.changed) return message
    changed = true
    guardedMessages += 1
    return guarded.message
  })

  return { messages: changed ? nextMessages : messages, changed, guardedMessages }
}

function stripStaleUsage(messages: ClaudeCompactMessage[]): {
  messages: ClaudeCompactMessage[]
  changed: boolean
  strippedUsageMessages: number
} {
  let changed = false
  let strippedUsageMessages = 0

  const nextMessages = messages.map((message) => {
    const stripped = stripUsage(message)
    if (!stripped.changed) return message
    changed = true
    strippedUsageMessages += 1
    return stripped.message
  })

  return { messages: changed ? nextMessages : messages, changed, strippedUsageMessages }
}

function applySafeEmergencyPreprocessing(
  messages: ClaudeCompactMessage[],
  config: ClaudeCompactConfig
): {
  messages: ClaudeCompactMessage[]
  changed: boolean
  payloadsCompacted: number
  guardedMessages: number
  strippedUsageMessages: number
} {
  let changed = false

  const dehydrated = dehydrateClaudeCompactPayloads(messages, { config })
  let nextMessages = dehydrated.messages
  changed ||= dehydrated.changed

  const guarded = guardTextPayloads(nextMessages, config)
  nextMessages = guarded.messages
  changed ||= guarded.changed

  const stripped = stripStaleUsage(nextMessages)
  nextMessages = stripped.messages
  changed ||= stripped.changed

  return {
    messages: nextMessages,
    changed,
    payloadsCompacted: dehydrated.payloadsCompacted,
    guardedMessages: guarded.guardedMessages,
    strippedUsageMessages: stripped.strippedUsageMessages
  }
}

function createOmittedContextMessage(
  anchor: ClaudeCompactMessage | undefined
): ClaudeCompactMessage {
  return {
    id: `${anchor?.id ?? 'message'}-context-emergency-omitted`,
    role: 'user',
    content: EMERGENCY_CONTEXT_OMITTED_TEXT,
    createdAt: anchor?.createdAt ?? Date.now(),
    meta: { contextEmergencyShrink: true }
  }
}

function withoutPreviousEmergencyNotice(messages: ClaudeCompactMessage[]): ClaudeCompactMessage[] {
  return messages.filter((message) => message.meta?.contextEmergencyShrink !== true)
}

function isSyntheticUserContextMessage(message: ClaudeCompactMessage): boolean {
  return (
    message.meta?.contextEmergencyShrink === true ||
    message.meta?.postCompactState === true ||
    !!message.meta?.compactSummary ||
    !!message.meta?.sessionMemoryCompact ||
    typeof message.meta?.streamingContinuation === 'object'
  )
}

function hasRealNonToolResultUserContent(message: ClaudeCompactMessage): boolean {
  if (message.role !== 'user') return false
  if (isSyntheticUserContextMessage(message)) return false
  if (typeof message.content === 'string') return message.content.trim().length > 0
  return message.content.some((block) => block.type !== 'tool_result')
}

function hasRealContinuityAnchor(messages: ClaudeCompactMessage[]): boolean {
  return messages.some(hasRealNonToolResultUserContent)
}

function findLatestRealContinuityAnchorIndex(messages: ClaudeCompactMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (hasRealNonToolResultUserContent(messages[index]!)) return index
  }
  return -1
}

function isSafeEmergencyShrinkCandidate(
  messages: ClaudeCompactMessage[],
  requireRealAnchor: boolean
): boolean {
  if (requireRealAnchor && !hasRealContinuityAnchor(messages)) return false
  return validateToolUseResultProtocol(messages).valid
}

function isToolUseBlock(
  block: ClaudeCompactContentBlock
): block is Extract<ClaudeCompactContentBlock, { type: 'tool_use' }> {
  return block.type === 'tool_use'
}

function isToolResultBlock(
  block: ClaudeCompactContentBlock
): block is Extract<ClaudeCompactContentBlock, { type: 'tool_result' }> {
  return block.type === 'tool_result'
}

function dropOldestClosedToolExchange(
  messages: ClaudeCompactMessage[],
  requireRealAnchor: boolean
): ClaudeCompactMessage[] | null {
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
      isSafeEmergencyShrinkCandidate(candidate, requireRealAnchor)
    ) {
      return candidate
    }
  }

  return null
}

function dropOldestNonAnchorMessage(
  messages: ClaudeCompactMessage[],
  requireRealAnchor: boolean
): ClaudeCompactMessage[] | null {
  for (let index = 0; index < messages.length; index += 1) {
    if (hasRealNonToolResultUserContent(messages[index]!)) continue

    const candidate = [...messages.slice(0, index), ...messages.slice(index + 1)]
    if (
      candidate.length > 0 &&
      candidate.length < messages.length &&
      isSafeEmergencyShrinkCandidate(candidate, requireRealAnchor)
    ) {
      return candidate
    }
  }

  return null
}

function dropOldestMessagePreservingLatestAnchor(
  messages: ClaudeCompactMessage[],
  requireRealAnchor: boolean
): ClaudeCompactMessage[] | null {
  const latestAnchorIndex = findLatestRealContinuityAnchorIndex(messages)
  if (latestAnchorIndex < 0) return null

  for (let index = 0; index < messages.length; index += 1) {
    if (index === latestAnchorIndex) continue

    const candidate = [...messages.slice(0, index), ...messages.slice(index + 1)]
    if (
      candidate.length > 0 &&
      candidate.length < messages.length &&
      isSafeEmergencyShrinkCandidate(candidate, requireRealAnchor)
    ) {
      return candidate
    }
  }

  return null
}

export async function emergencyShrinkClaudeContextMessages(args: {
  messages: ClaudeCompactMessage[]
  config: ClaudeCompactConfig
  estimateTokens?: EmergencyShrinkTokenEstimator
  forceDrop?: boolean
}): Promise<ClaudeEmergencyContextShrinkResult> {
  const estimateTokens = args.estimateTokens ?? estimateMessagesTokens
  const budget = getClaudeCompactBudget(args.config)
  const targetTokens = Math.max(1, budget.effectiveContextWindow)
  const sourceMessages = withoutPreviousEmergencyNotice(args.messages)

  let changed = sourceMessages.length !== args.messages.length
  let droppedMessages = 0

  const prepared = applySafeEmergencyPreprocessing(sourceMessages, args.config)
  let messages = prepared.messages
  changed ||= prepared.changed

  const requireRealAnchor = hasRealContinuityAnchor(messages)
  if (!requireRealAnchor) {
    const retainedNoticePrepared =
      sourceMessages.length === args.messages.length
        ? prepared
        : applySafeEmergencyPreprocessing(args.messages, args.config)

    return {
      messages: retainedNoticePrepared.changed ? retainedNoticePrepared.messages : args.messages,
      changed: retainedNoticePrepared.changed,
      droppedMessages: 0,
      payloadsCompacted: retainedNoticePrepared.payloadsCompacted,
      guardedMessages: retainedNoticePrepared.guardedMessages,
      strippedUsageMessages: retainedNoticePrepared.strippedUsageMessages
    }
  }

  let forceDropRemaining = args.forceDrop === true

  while (
    ((await estimateTokens(messages)) > targetTokens || forceDropRemaining) &&
    messages.length > 1
  ) {
    if (forceDropRemaining) {
      const nextToolExchangeMessages = dropOldestClosedToolExchange(messages, requireRealAnchor)
      if (nextToolExchangeMessages && nextToolExchangeMessages.length < messages.length) {
        droppedMessages += messages.length - nextToolExchangeMessages.length
        messages = nextToolExchangeMessages
        changed = true
        forceDropRemaining = false
        continue
      }
    }

    const nextMessages = dropOldestClaudeCompactRounds(messages, 1)
    if (
      nextMessages &&
      nextMessages.length < messages.length &&
      isSafeEmergencyShrinkCandidate(nextMessages, requireRealAnchor)
    ) {
      droppedMessages += messages.length - nextMessages.length
      messages = nextMessages
      changed = true
      forceDropRemaining = false
      continue
    }

    const nextToolExchangeMessages = dropOldestClosedToolExchange(messages, requireRealAnchor)
    if (nextToolExchangeMessages && nextToolExchangeMessages.length < messages.length) {
      droppedMessages += messages.length - nextToolExchangeMessages.length
      messages = nextToolExchangeMessages
      changed = true
      forceDropRemaining = false
      continue
    }

    const nextNonAnchorMessages = dropOldestNonAnchorMessage(messages, requireRealAnchor)
    if (nextNonAnchorMessages && nextNonAnchorMessages.length < messages.length) {
      droppedMessages += messages.length - nextNonAnchorMessages.length
      messages = nextNonAnchorMessages
      changed = true
      forceDropRemaining = false
      continue
    }

    const nextPreservedAnchorMessages = dropOldestMessagePreservingLatestAnchor(
      messages,
      requireRealAnchor
    )
    if (!nextPreservedAnchorMessages || nextPreservedAnchorMessages.length >= messages.length) {
      break
    }
    droppedMessages += messages.length - nextPreservedAnchorMessages.length
    messages = nextPreservedAnchorMessages
    changed = true
    forceDropRemaining = false
  }

  if (droppedMessages > 0) {
    const withNotice = [createOmittedContextMessage(messages[0]), ...messages]
    messages = (await estimateTokens(withNotice)) <= targetTokens ? withNotice : messages
    changed = true
  }

  return {
    messages: changed ? messages : args.messages,
    changed,
    droppedMessages,
    payloadsCompacted: prepared.payloadsCompacted,
    guardedMessages: prepared.guardedMessages,
    strippedUsageMessages: prepared.strippedUsageMessages
  }
}
