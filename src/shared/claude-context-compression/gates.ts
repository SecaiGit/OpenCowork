import { getClaudeCompactBudget } from './budget'
import type { ClaudeCompactConfig } from './types'

export type ClaudeContextGateKind =
  | 'ok'
  | 'pre_compress'
  | 'auto_compact'
  | 'reserved_output_exceeded'
  | 'hard_limit_exceeded'

export type ClaudeContextGateReason =
  | 'compression_disabled'
  | 'invalid_context_length'
  | 'below_pre_compress_threshold'
  | 'near_auto_compact_threshold'
  | 'auto_compact_threshold_reached'
  | 'reserved_output_budget_exceeded'
  | 'hard_context_limit_exceeded'

export interface ClaudeContextGateResult {
  kind: ClaudeContextGateKind
  reason: ClaudeContextGateReason
  /** Whether to block the next model request from being sent. */
  blocking: boolean
  inputTokens: number
  contextLength: number
  reservedOutputTokens: number
  effectiveContextWindow: number
  autoCompactThreshold: number
  preCompressThreshold: number
}

function normalizeNonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }

  return Math.max(0, Math.floor(value))
}

function normalizePositiveInteger(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback
  }

  return Math.max(1, Math.floor(value))
}

function normalizeRatio(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }

  return Math.min(0.9, Math.max(0.3, value))
}

export function classifyClaudeContextGate(args: {
  inputTokens: number
  config: Pick<
    ClaudeCompactConfig,
    'enabled' | 'contextLength' | 'threshold' | 'preCompressThreshold' | 'reservedOutputBudget'
  >
  preCompressGapTokens?: number
}): ClaudeContextGateResult {
  const inputTokens = normalizeNonNegativeInteger(args.inputTokens)
  const budget = getClaudeCompactBudget(args.config)
  const preCompressGapTokens = normalizePositiveInteger(args.preCompressGapTokens ?? 8_000, 8_000)
  const autoRatioThreshold = Math.floor(
    budget.effectiveContextWindow * normalizeRatio(args.config.threshold, 0.8)
  )
  const autoCompactThreshold = Math.max(
    1,
    Math.min(autoRatioThreshold, budget.autoCompactThreshold)
  )
  const preRatioThreshold = Math.floor(
    budget.effectiveContextWindow * normalizeRatio(args.config.preCompressThreshold, 0.65)
  )
  const preThresholdCandidates = [preRatioThreshold]
  const preBufferThreshold = budget.effectiveContextWindow - 20_000
  if (preBufferThreshold > 0) preThresholdCandidates.push(preBufferThreshold)
  const gapThreshold = autoCompactThreshold - preCompressGapTokens
  if (gapThreshold > 0) preThresholdCandidates.push(gapThreshold)
  const preCompressThreshold = Math.max(
    1,
    Math.min(...preThresholdCandidates, Math.max(1, autoCompactThreshold - 1))
  )

  const base = {
    inputTokens,
    contextLength: budget.contextLength,
    reservedOutputTokens: budget.reservedOutputTokens,
    effectiveContextWindow: budget.effectiveContextWindow,
    autoCompactThreshold,
    preCompressThreshold
  }

  if (!args.config.enabled) {
    return { ...base, kind: 'ok', reason: 'compression_disabled', blocking: false }
  }

  if (budget.contextLength <= 0) {
    return { ...base, kind: 'ok', reason: 'invalid_context_length', blocking: false }
  }

  if (inputTokens > budget.contextLength) {
    return {
      ...base,
      kind: 'hard_limit_exceeded',
      reason: 'hard_context_limit_exceeded',
      blocking: true
    }
  }

  if (inputTokens + budget.reservedOutputTokens > budget.contextLength) {
    return {
      ...base,
      kind: 'reserved_output_exceeded',
      reason: 'reserved_output_budget_exceeded',
      blocking: true
    }
  }

  if (inputTokens >= autoCompactThreshold) {
    return {
      ...base,
      kind: 'auto_compact',
      reason: 'auto_compact_threshold_reached',
      blocking: false
    }
  }

  if (inputTokens >= preCompressThreshold) {
    return {
      ...base,
      kind: 'pre_compress',
      reason: 'near_auto_compact_threshold',
      blocking: false
    }
  }

  return { ...base, kind: 'ok', reason: 'below_pre_compress_threshold', blocking: false }
}
