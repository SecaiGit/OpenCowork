import type { ClaudeCompactConfig } from './types'

export const CLAUDE_COMPACT_RESERVED_OUTPUT_CAP = 20_000
export const CLAUDE_COMPACT_AUTO_BUFFER_TOKENS = 13_000

export interface ClaudeCompactBudget {
  contextLength: number
  reservedOutputTokens: number
  effectiveContextWindow: number
  autoCompactThreshold: number
  autoBufferTokens: number
}

export function getClaudeCompactBudget(
  config: Pick<ClaudeCompactConfig, 'contextLength' | 'reservedOutputBudget'>
): ClaudeCompactBudget {
  const contextLength = Math.max(0, Math.floor(config.contextLength))
  const rawReserved = config.reservedOutputBudget ?? CLAUDE_COMPACT_RESERVED_OUTPUT_CAP
  const reservedOutputTokens = Math.min(
    CLAUDE_COMPACT_RESERVED_OUTPUT_CAP,
    Math.max(0, Math.floor(rawReserved))
  )
  const effectiveContextWindow = Math.max(1, contextLength - reservedOutputTokens)
  const bufferedThreshold = effectiveContextWindow - CLAUDE_COMPACT_AUTO_BUFFER_TOKENS
  const autoCompactThreshold = Math.max(1, bufferedThreshold)

  return {
    contextLength,
    reservedOutputTokens,
    effectiveContextWindow,
    autoCompactThreshold,
    autoBufferTokens: CLAUDE_COMPACT_AUTO_BUFFER_TOKENS
  }
}
