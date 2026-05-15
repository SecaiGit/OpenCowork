import type { UnifiedMessage } from '../api/types'
import {
  assertClaudeCompactSummarySafe,
  sanitizeMessagesForClaudeCompact as sanitizeSharedMessagesForClaudeCompact
} from '../../../../shared/claude-context-compression/sanitizer'
import type {
  ClaudeCompactConfig,
  ClaudeCompactMessage
} from '../../../../shared/claude-context-compression/types'

export { assertClaudeCompactSummarySafe }

export function sanitizeMessagesForClaudeCompact(
  messages: UnifiedMessage[],
  config?: ClaudeCompactConfig | null
): UnifiedMessage[] {
  return sanitizeSharedMessagesForClaudeCompact(
    messages as unknown as ClaudeCompactMessage[],
    config
  ) as unknown as UnifiedMessage[]
}
