import type { UnifiedMessage } from '../api/types'
import {
  groupMessagesByApiRound,
  validateToolUseResultProtocol,
  type ApiRoundGroup,
  type ToolUseResultProtocolIssue
} from './context-budget'

export type ClaudeCompactRangeSkipReason =
  | 'insufficient_messages'
  | 'insufficient_compressible_messages'
  | 'unsafe_boundary'

export interface ClaudeCompactRangeSelection {
  ok: boolean
  reason?: ClaudeCompactRangeSkipReason
  compressibleMessages: UnifiedMessage[]
  preservedMessages: UnifiedMessage[]
  compressedRange?: { start: number; end: number }
  preservedRange?: { start: number; end: number }
}

export interface SelectClaudeCompactRangesOptions {
  minMessages?: number
  preservedRoundCount?: number
}

function hasFatalProtocolIssue(issues: ToolUseResultProtocolIssue[]): boolean {
  return issues.some((issue) => issue.kind !== 'unanswered_tool_use')
}

function messageHasToolUse(message: UnifiedMessage): boolean {
  return Array.isArray(message.content) && message.content.some((block) => block.type === 'tool_use')
}

function isAssistantOnlyTextGroup(group: ApiRoundGroup): boolean {
  return group.messages.every(
    (message) =>
      message.role === 'assistant' &&
      (typeof message.content === 'string' || !message.content.some((block) => block.type === 'tool_use'))
  )
}

function buildClaudeCompactRounds(messages: UnifiedMessage[]): ApiRoundGroup[] {
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
  messages: UnifiedMessage[],
  count: number
): UnifiedMessage[] | null {
  const groups = buildClaudeCompactRounds(messages)
  if (groups.length <= 1) {
    return null
  }

  const dropCount = Math.min(Math.max(1, Math.floor(count)), groups.length - 1)
  const remainingMessages = groups.slice(dropCount).flatMap((group) => group.messages)
  return remainingMessages.length >= 2 ? remainingMessages : null
}

export function selectClaudeCompactRanges(
  messages: UnifiedMessage[],
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
