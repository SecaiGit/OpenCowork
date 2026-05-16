import type { UnifiedMessage } from '../api/types'
import {
  dropOldestClaudeCompactRounds as dropOldestSharedClaudeCompactRounds,
  selectClaudeCompactRanges as selectSharedClaudeCompactRanges,
  selectClaudePartialCompactRanges as selectSharedClaudePartialCompactRanges,
  type ClaudeCompactRangeSelection as SharedClaudeCompactRangeSelection,
  type ClaudePartialCompactRangeSelectionResult as SharedClaudePartialCompactRangeSelectionResult,
  type SelectClaudeCompactRangesOptions,
  type SelectClaudePartialCompactRangesOptions
} from '../../../../shared/claude-context-compression/rounds'
import type { ClaudeCompactMessage } from '../../../../shared/claude-context-compression/types'

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

export interface ClaudePartialCompactRangeSelection extends ClaudeCompactRangeSelection {
  ok: true
  mode: 'partial'
  anchorMessage: UnifiedMessage
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

export type { SelectClaudeCompactRangesOptions, SelectClaudePartialCompactRangesOptions }

function toSharedMessages(messages: UnifiedMessage[]): ClaudeCompactMessage[] {
  return messages
}

function createRendererMessageResolver(
  messages: UnifiedMessage[]
): (message: ClaudeCompactMessage) => UnifiedMessage {
  const messagesById = new Map(messages.map((message) => [message.id, message]))
  return (message) => {
    const rendererMessage = messagesById.get(message.id)
    if (!rendererMessage) {
      throw new Error(`Shared compact selector returned an unknown message id: ${message.id}`)
    }
    return rendererMessage
  }
}

function toRendererSelection(
  selection: SharedClaudeCompactRangeSelection,
  resolveMessage: (message: ClaudeCompactMessage) => UnifiedMessage
): ClaudeCompactRangeSelection {
  return {
    ok: selection.ok,
    reason: selection.reason,
    compressibleMessages: selection.compressibleMessages.map(resolveMessage),
    preservedMessages: selection.preservedMessages.map(resolveMessage),
    compressedRange: selection.compressedRange,
    preservedRange: selection.preservedRange
  }
}

function toRendererPartialSelection(
  selection: SharedClaudePartialCompactRangeSelectionResult,
  resolveMessage: (message: ClaudeCompactMessage) => UnifiedMessage
): ClaudePartialCompactRangeSelectionResult {
  if (selection.ok) {
    return {
      ...toRendererSelection(selection, resolveMessage),
      ok: true,
      mode: 'partial',
      anchorMessage: resolveMessage(selection.anchorMessage),
      partialRange: selection.partialRange
    }
  }

  return {
    ...toRendererSelection(selection, resolveMessage),
    ok: false,
    mode: 'partial'
  }
}

export function dropOldestClaudeCompactRounds(
  messages: UnifiedMessage[],
  count: number
): UnifiedMessage[] | null {
  const droppedMessages = dropOldestSharedClaudeCompactRounds(toSharedMessages(messages), count)
  if (!droppedMessages) return null

  const resolveMessage = createRendererMessageResolver(messages)
  return droppedMessages.map(resolveMessage)
}

export function selectClaudeCompactRanges(
  messages: UnifiedMessage[],
  options: SelectClaudeCompactRangesOptions = {}
): ClaudeCompactRangeSelection {
  const resolveMessage = createRendererMessageResolver(messages)
  return toRendererSelection(
    selectSharedClaudeCompactRanges(toSharedMessages(messages), options),
    resolveMessage
  )
}

export function selectClaudePartialCompactRanges(
  messages: UnifiedMessage[],
  options: SelectClaudePartialCompactRangesOptions = {}
): ClaudePartialCompactRangeSelectionResult {
  const resolveMessage = createRendererMessageResolver(messages)
  return toRendererPartialSelection(
    selectSharedClaudePartialCompactRanges(toSharedMessages(messages), options),
    resolveMessage
  )
}
