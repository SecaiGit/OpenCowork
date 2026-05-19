import type { ClaudeCompactContentBlock, ClaudeCompactMessage } from './types'
import { hasUserAuthoredClaudeMessageContent } from './synthetic-context'

export interface ApiRoundGroup {
  start: number
  end: number
  messages: ClaudeCompactMessage[]
}

export type ToolUseResultProtocolIssueKind =
  | 'orphaned_tool_result'
  | 'duplicate_tool_use'
  | 'duplicate_tool_result'
  | 'tool_use_invalid_role'
  | 'tool_result_invalid_role'
  | 'interleaved_user_text_before_tool_result'
  | 'assistant_tool_use_after_user_text'
  | 'unanswered_tool_use'

export interface ToolUseResultProtocolIssue {
  kind: ToolUseResultProtocolIssueKind
  messageIndex: number
  toolUseId?: string
}

export interface ToolUseResultProtocolValidation {
  valid: boolean
  issues: ToolUseResultProtocolIssue[]
}

export type ClaudeCompactRangeSkipReason =
  | 'insufficient_messages'
  | 'insufficient_compressible_messages'
  | 'unsafe_boundary'

export interface ClaudeCompactRangeSelection {
  ok: boolean
  reason?: ClaudeCompactRangeSkipReason
  compressibleMessages: ClaudeCompactMessage[]
  preservedMessages: ClaudeCompactMessage[]
  compressedRange?: { start: number; end: number }
  preservedRange?: { start: number; end: number }
}

export interface SelectClaudeCompactRangesOptions {
  minMessages?: number
  preservedRoundCount?: number
}

export interface ClaudePartialCompactRangeSelection extends ClaudeCompactRangeSelection {
  ok: true
  mode: 'partial'
  anchorMessage: ClaudeCompactMessage
  partialRange: { from: number; upTo: number; anchor: number; tailStart: number }
}

export interface ClaudePartialCompactRangeFailure extends ClaudeCompactRangeSelection {
  ok: false
  mode: 'partial'
  anchorMessage?: undefined
  partialRange?: undefined
}

export type ClaudePartialCompactRangeSelectionResult =
  | ClaudePartialCompactRangeSelection
  | ClaudePartialCompactRangeFailure

export interface SelectClaudePartialCompactRangesOptions {
  minCompressibleMessages?: number
  preservedTailMessages?: number
}

function collectToolUseIds(message: ClaudeCompactMessage): string[] {
  if (!Array.isArray(message.content)) return []

  return message.content
    .filter(
      (block): block is Extract<ClaudeCompactContentBlock, { type: 'tool_use' }> =>
        block.type === 'tool_use'
    )
    .map((block) => block.id)
}

function collectToolResultIds(message: ClaudeCompactMessage): string[] {
  if (!Array.isArray(message.content)) return []

  return message.content
    .filter(
      (block): block is Extract<ClaudeCompactContentBlock, { type: 'tool_result' }> =>
        block.type === 'tool_result'
    )
    .map((block) => block.toolUseId)
}

export function validateToolUseResultProtocol(
  messages: ClaudeCompactMessage[]
): ToolUseResultProtocolValidation {
  const issues: ToolUseResultProtocolIssue[] = []
  const pendingToolUseIds = new Set<string>()
  const seenToolUseIds = new Set<string>()
  const answeredToolUseIds = new Set<string>()

  messages.forEach((message, messageIndex) => {
    const toolUseIds = collectToolUseIds(message)
    const toolResultIds = collectToolResultIds(message)

    if (message.role !== 'assistant') {
      for (const id of toolUseIds) {
        issues.push({
          kind: 'tool_use_invalid_role',
          messageIndex,
          toolUseId: id
        })
      }
    }

    if (message.role !== 'user') {
      for (const id of toolResultIds) {
        issues.push({
          kind: 'tool_result_invalid_role',
          messageIndex,
          toolUseId: id
        })
      }
    }

    if (message.role === 'assistant') {
      if (pendingToolUseIds.size > 0 && toolUseIds.length > 0) {
        for (const id of toolUseIds) {
          issues.push({
            kind: 'assistant_tool_use_after_user_text',
            messageIndex,
            toolUseId: id
          })
        }
      }

      for (const id of toolUseIds) {
        if (seenToolUseIds.has(id)) {
          issues.push({
            kind: 'duplicate_tool_use',
            messageIndex,
            toolUseId: id
          })
          continue
        }
        seenToolUseIds.add(id)
        pendingToolUseIds.add(id)
      }

      return
    }

    if (message.role !== 'user') return

    if (typeof message.content === 'string') {
      if (pendingToolUseIds.size > 0 && message.content.trim().length > 0) {
        issues.push({
          kind: 'interleaved_user_text_before_tool_result',
          messageIndex
        })
      }
      return
    }

    let sawNonToolResultContent = false
    const seenToolResultIdsInMessage = new Set<string>()

    for (const block of message.content) {
      if (block.type !== 'tool_result') {
        sawNonToolResultContent = true
        continue
      }

      const toolUseId = block.toolUseId
      if (seenToolResultIdsInMessage.has(toolUseId)) {
        issues.push({
          kind: 'duplicate_tool_result',
          messageIndex,
          toolUseId
        })
        continue
      }
      seenToolResultIdsInMessage.add(toolUseId)

      if (!pendingToolUseIds.has(toolUseId)) {
        issues.push({
          kind: answeredToolUseIds.has(toolUseId)
            ? 'duplicate_tool_result'
            : 'orphaned_tool_result',
          messageIndex,
          toolUseId
        })
        continue
      }

      pendingToolUseIds.delete(toolUseId)
      answeredToolUseIds.add(toolUseId)
    }

    if (pendingToolUseIds.size > 0 && sawNonToolResultContent) {
      issues.push({
        kind: 'interleaved_user_text_before_tool_result',
        messageIndex
      })
    }
  })

  for (const toolUseId of pendingToolUseIds) {
    issues.push({
      kind: 'unanswered_tool_use',
      messageIndex: messages.length - 1,
      toolUseId
    })
  }

  return {
    valid: issues.length === 0,
    issues
  }
}

export function groupMessagesByApiRound(messages: ClaudeCompactMessage[]): ApiRoundGroup[] {
  const groups: ApiRoundGroup[] = []
  let start = 0
  let current: ClaudeCompactMessage[] = []
  let currentToolUseIds = new Set<string>()
  let pendingToolUseIds = new Set<string>()
  let answeredToolUseIds = new Set<string>()
  let currentHasAssistant = false
  let currentHasToolUse = false
  let currentHasUserText = false
  let currentHasToolResult = false
  let currentToolRoundInvalid = false
  let previousGroupClosedWithAnsweredToolUseBatch = false

  const flush = (end: number, closedWithAnsweredToolUseBatch = false): void => {
    if (current.length === 0) return

    groups.push({ start, end, messages: current })
    start = end
    current = []
    currentToolUseIds = new Set<string>()
    pendingToolUseIds = new Set<string>()
    answeredToolUseIds = new Set<string>()
    currentHasAssistant = false
    currentHasToolUse = false
    currentHasUserText = false
    currentHasToolResult = false
    currentToolRoundInvalid = false
    previousGroupClosedWithAnsweredToolUseBatch = closedWithAnsweredToolUseBatch
  }

  messages.forEach((message, index) => {
    current.push(message)

    const toolUseIds = collectToolUseIds(message)
    const toolResultIds = collectToolResultIds(message)
    const nextMessage = messages[index + 1]
    const nextMessageToolUseIds = nextMessage ? collectToolUseIds(nextMessage) : []

    if (message.role === 'assistant') {
      currentHasAssistant = true
      if (toolUseIds.length > 0) currentHasToolUse = true
      for (const id of toolUseIds) {
        currentToolUseIds.add(id)
        pendingToolUseIds.add(id)
      }
    }

    if (message.role === 'user') {
      if (toolResultIds.length > 0) {
        currentHasToolResult = true
      }

      if (typeof message.content === 'string') {
        currentHasUserText = currentHasUserText || message.content.trim().length > 0
      } else if (message.content.some((block) => block.type !== 'tool_result')) {
        currentHasUserText = true
      }
    }

    let canCloseAnsweredToolUseBatch = false

    if (message.role === 'user' && toolResultIds.length > 0) {
      let hasUnknownToolUseId = false
      let hasDuplicateToolResult = false
      const seenInMessage = new Set<string>()

      for (const id of toolResultIds) {
        if (!currentToolUseIds.has(id)) {
          hasUnknownToolUseId = true
          continue
        }

        if (seenInMessage.has(id) || answeredToolUseIds.has(id)) {
          hasDuplicateToolResult = true
          continue
        }

        seenInMessage.add(id)
        answeredToolUseIds.add(id)
        pendingToolUseIds.delete(id)
      }

      if (hasUnknownToolUseId || hasDuplicateToolResult) {
        currentToolRoundInvalid = true
      }

      canCloseAnsweredToolUseBatch =
        !currentToolRoundInvalid &&
        currentHasAssistant &&
        currentHasToolUse &&
        pendingToolUseIds.size === 0
    }

    const nextAssistantContinuesPlainAssistantSegment =
      nextMessage?.role === 'assistant' && nextMessageToolUseIds.length === 0

    const assistantWithoutToolsClosedRound =
      message.role === 'assistant' &&
      toolUseIds.length === 0 &&
      pendingToolUseIds.size === 0 &&
      !nextAssistantContinuesPlainAssistantSegment &&
      (currentHasUserText || currentHasToolResult || previousGroupClosedWithAnsweredToolUseBatch)
    const answeredToolUseBatchClosedRound =
      message.role === 'user' && toolResultIds.length > 0 && canCloseAnsweredToolUseBatch

    if (assistantWithoutToolsClosedRound) {
      flush(index + 1)
      return
    }

    if (answeredToolUseBatchClosedRound) {
      flush(index + 1, true)
    }
  })

  flush(messages.length)
  return groups
}

function hasFatalProtocolIssue(issues: ToolUseResultProtocolIssue[]): boolean {
  return issues.some((issue) => issue.kind !== 'unanswered_tool_use')
}

function hasNonToolResultUserContent(message: ClaudeCompactMessage): boolean {
  return hasUserAuthoredClaudeMessageContent(message)
}

function findCurrentTaskAnchorIndex(messages: ClaudeCompactMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (hasNonToolResultUserContent(messages[index]!)) return index
  }
  return -1
}

function hasValidClosedToolProtocol(messages: ClaudeCompactMessage[]): boolean {
  return validateToolUseResultProtocol(messages).valid
}

function hasSafePreservedProtocol(messages: ClaudeCompactMessage[]): boolean {
  return !hasFatalProtocolIssue(validateToolUseResultProtocol(messages).issues)
}

function messageHasToolUse(message: ClaudeCompactMessage): boolean {
  return (
    Array.isArray(message.content) && message.content.some((block) => block.type === 'tool_use')
  )
}

function isAssistantOnlyTextGroup(group: ApiRoundGroup): boolean {
  return group.messages.every(
    (message) =>
      message.role === 'assistant' &&
      (typeof message.content === 'string' ||
        !message.content.some((block) => block.type === 'tool_use'))
  )
}

function buildClaudeCompactRounds(messages: ClaudeCompactMessage[]): ApiRoundGroup[] {
  const rawGroups = groupMessagesByApiRound(messages)
  const merged: ApiRoundGroup[] = []

  for (const group of rawGroups) {
    const previous = merged[merged.length - 1]
    if (
      previous &&
      previous.end === group.start &&
      previous.messages.some(messageHasToolUse) &&
      isAssistantOnlyTextGroup(group)
    ) {
      merged[merged.length - 1] = {
        start: previous.start,
        end: group.end,
        messages: [...previous.messages, ...group.messages]
      }
      continue
    }

    merged.push(group)
  }

  return merged
}

export function dropOldestClaudeCompactRounds(
  messages: ClaudeCompactMessage[],
  count: number
): ClaudeCompactMessage[] | null {
  const groups = buildClaudeCompactRounds(messages)
  if (groups.length <= 1) {
    return null
  }

  const dropCount = Math.min(Math.max(1, Math.floor(count)), groups.length - 1)
  const remainingMessages = groups.slice(dropCount).flatMap((group) => group.messages)
  return remainingMessages.length >= 2 ? remainingMessages : null
}

export function selectClaudePartialCompactRanges(
  messages: ClaudeCompactMessage[],
  options: SelectClaudePartialCompactRangesOptions = {}
): ClaudePartialCompactRangeSelectionResult {
  const minCompressibleMessages = Math.max(2, Math.floor(options.minCompressibleMessages ?? 2))
  const preservedTailMessages = Math.max(0, Math.floor(options.preservedTailMessages ?? 3))

  if (messages.length < 2) {
    return {
      ok: false,
      mode: 'partial',
      reason: 'insufficient_messages',
      compressibleMessages: [],
      preservedMessages: messages
    }
  }

  const fullValidation = validateToolUseResultProtocol(messages)
  if (hasFatalProtocolIssue(fullValidation.issues)) {
    return {
      ok: false,
      mode: 'partial',
      reason: 'unsafe_boundary',
      compressibleMessages: [],
      preservedMessages: messages
    }
  }

  const anchorIndex = findCurrentTaskAnchorIndex(messages)
  if (anchorIndex < 0 || anchorIndex >= messages.length - minCompressibleMessages) {
    return {
      ok: false,
      mode: 'partial',
      reason: 'insufficient_compressible_messages',
      compressibleMessages: [],
      preservedMessages: messages
    }
  }

  const latestAllowedTailStart = Math.max(
    anchorIndex + minCompressibleMessages + 1,
    messages.length - preservedTailMessages
  )

  for (
    let tailStart = Math.min(latestAllowedTailStart, messages.length);
    tailStart > anchorIndex + 1;
    tailStart -= 1
  ) {
    const compressibleMessages = messages.slice(anchorIndex + 1, tailStart)
    if (compressibleMessages.length < minCompressibleMessages) continue
    if (!hasValidClosedToolProtocol(compressibleMessages)) continue

    const preservedMessages = [messages[anchorIndex]!, ...messages.slice(tailStart)].filter(
      (message) => message.meta?.postCompactState !== true
    )
    if (!hasSafePreservedProtocol(preservedMessages)) continue

    return {
      ok: true,
      mode: 'partial',
      anchorMessage: messages[anchorIndex]!,
      compressibleMessages,
      preservedMessages,
      compressedRange: { start: anchorIndex + 1, end: tailStart },
      partialRange: {
        from: anchorIndex + 1,
        upTo: tailStart,
        anchor: anchorIndex,
        tailStart
      }
    }
  }

  return {
    ok: false,
    mode: 'partial',
    reason: 'insufficient_compressible_messages',
    compressibleMessages: [],
    preservedMessages: messages
  }
}

export function selectClaudeCompactRanges(
  messages: ClaudeCompactMessage[],
  options: SelectClaudeCompactRangesOptions = {}
): ClaudeCompactRangeSelection {
  const minMessages = options.minMessages ?? 6
  const preservedRoundCount = Math.max(1, Math.floor(options.preservedRoundCount ?? 1))

  if (messages.length < minMessages) {
    return {
      ok: false,
      reason: 'insufficient_messages',
      compressibleMessages: [],
      preservedMessages: messages
    }
  }

  const fullValidation = validateToolUseResultProtocol(messages)
  if (hasFatalProtocolIssue(fullValidation.issues)) {
    return {
      ok: false,
      reason: 'unsafe_boundary',
      compressibleMessages: [],
      preservedMessages: messages
    }
  }

  const groups = buildClaudeCompactRounds(messages)
  if (groups.length <= preservedRoundCount) {
    return {
      ok: false,
      reason: 'insufficient_compressible_messages',
      compressibleMessages: [],
      preservedMessages: messages
    }
  }

  const preservedGroups = groups.slice(-preservedRoundCount)
  const preservedStart = preservedGroups[0]!.start
  const compressibleMessages = messages.slice(0, preservedStart)
  const preservedMessages = messages
    .slice(preservedStart)
    .filter((message) => message.meta?.postCompactState !== true)

  if (compressibleMessages.length < 2) {
    return {
      ok: false,
      reason: 'insufficient_compressible_messages',
      compressibleMessages: [],
      preservedMessages: messages
    }
  }

  const preservedValidation = validateToolUseResultProtocol(preservedMessages)
  if (hasFatalProtocolIssue(preservedValidation.issues)) {
    return {
      ok: false,
      reason: 'unsafe_boundary',
      compressibleMessages: [],
      preservedMessages: messages
    }
  }

  return {
    ok: true,
    compressibleMessages,
    preservedMessages,
    compressedRange: { start: 0, end: preservedStart },
    preservedRange: { start: preservedStart, end: messages.length }
  }
}
