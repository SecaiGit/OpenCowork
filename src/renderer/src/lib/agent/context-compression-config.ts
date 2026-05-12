export const DEFAULT_CONTEXT_COMPRESSION_CONTEXT_LENGTH = 200_000
export const DEFAULT_CONTEXT_COMPRESSION_THRESHOLD = 0.8
export const MIN_CONTEXT_COMPRESSION_THRESHOLD = 0.3
export const MAX_CONTEXT_COMPRESSION_THRESHOLD = 0.9
export const CONTEXT_COMPRESSION_STRATEGY_IDS = ['partial-summary-v1'] as const

export type ContextCompressionStrategyId = (typeof CONTEXT_COMPRESSION_STRATEGY_IDS)[number]

export function isContextCompressionStrategyId(
  value: unknown
): value is ContextCompressionStrategyId {
  return (
    typeof value === 'string' &&
    (CONTEXT_COMPRESSION_STRATEGY_IDS as readonly string[]).includes(value)
  )
}

export function clampCompressionContextLength(value?: number | null): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_CONTEXT_COMPRESSION_CONTEXT_LENGTH
  }
  return Math.floor(value)
}

export function clampCompressionThreshold(value?: number | null): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_CONTEXT_COMPRESSION_THRESHOLD
  }
  return Math.min(
    MAX_CONTEXT_COMPRESSION_THRESHOLD,
    Math.max(MIN_CONTEXT_COMPRESSION_THRESHOLD, value)
  )
}

export function resolveCompressionStrategyId(value?: unknown): ContextCompressionStrategyId {
  return isContextCompressionStrategyId(value) ? value : CONTEXT_COMPRESSION_STRATEGY_IDS[0]
}
