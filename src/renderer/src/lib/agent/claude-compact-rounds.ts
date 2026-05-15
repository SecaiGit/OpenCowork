import type { UnifiedMessage } from '../api/types'
import {
  dropOldestClaudeCompactRounds as dropOldestSharedClaudeCompactRounds,
  selectClaudeCompactRanges as selectSharedClaudeCompactRanges,
  type ClaudeCompactRangeSelection as SharedClaudeCompactRangeSelection,
  type SelectClaudeCompactRangesOptions
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

export type { SelectClaudeCompactRangesOptions }

function toRendererSelection(selection: SharedClaudeCompactRangeSelection): ClaudeCompactRangeSelection {
  return selection as unknown as ClaudeCompactRangeSelection
}

export function dropOldestClaudeCompactRounds(
  messages: UnifiedMessage[],
  count: number
): UnifiedMessage[] | null {
  return dropOldestSharedClaudeCompactRounds(
    messages as unknown as ClaudeCompactMessage[],
    count
  ) as unknown as UnifiedMessage[] | null
}

export function selectClaudeCompactRanges(
  messages: UnifiedMessage[],
  options: SelectClaudeCompactRangesOptions = {}
): ClaudeCompactRangeSelection {
  return toRendererSelection(
    selectSharedClaudeCompactRanges(messages as unknown as ClaudeCompactMessage[], options)
  )
}
