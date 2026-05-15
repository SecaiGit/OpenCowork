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

export function classifyClaudeContextGate(args: {
  inputTokens: number
  config: Pick<ClaudeCompactConfig, 'enabled' | 'contextLength' | 'reservedOutputBudget'>
  /** Token gap from autoCompactThreshold; does not read config.preCompressThreshold. */
  preCompressGapTokens?: number
}): ClaudeContextGateResult {
  const inputTokens = normalizeNonNegativeInteger(args.inputTokens)
  const budget = getClaudeCompactBudget(args.config)
  const preCompressGapTokens = normalizePositiveInteger(args.preCompressGapTokens ?? 8_000, 8_000)
  const preCompressThreshold = Math.max(1, budget.autoCompactThreshold - preCompressGapTokens)

  const base = {
    inputTokens,
    contextLength: budget.contextLength,
    reservedOutputTokens: budget.reservedOutputTokens,
    effectiveContextWindow: budget.effectiveContextWindow,
    autoCompactThreshold: budget.autoCompactThreshold,
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

  if (inputTokens >= budget.autoCompactThreshold) {
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
