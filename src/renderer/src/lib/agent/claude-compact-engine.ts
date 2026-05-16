import { nanoid } from 'nanoid'
import { runSidecarTextRequest } from '@renderer/lib/ipc/agent-bridge'
import { RESPONSES_SESSION_SCOPE_CONTEXT_COMPRESSION } from '@renderer/lib/api/responses-session-policy'
import type { CompactBoundaryMeta, ProviderConfig, UnifiedMessage } from '../api/types'
import type {
  CompressionConfig,
  CompressionResult,
  ContextCompressionStrategy
} from './context-compression'
import {
  getClaudeCompactBudget,
  runClaudeCompact,
  sanitizeMessagesForClaudeCompact,
  type ClaudeCompactMessage
} from '../../../../shared/claude-context-compression'

const MAX_CLAUDE_COMPACT_FAILURES = 3
let claudeCompactFailures = 0

async function callClaudeCompactSummarizer(args: {
  providerConfig: ProviderConfig
  systemPrompt: string
  userPrompt: string
  signal?: AbortSignal
}): Promise<string> {
  return runSidecarTextRequest({
    provider: {
      ...args.providerConfig,
      systemPrompt: args.systemPrompt,
      thinkingEnabled: false
    },
    messages: [
      {
        id: 'claude-compact-request',
        role: 'user',
        content: args.userPrompt,
        createdAt: Date.now()
      }
    ],
    signal: args.signal,
    maxIterations: 1,
    responsesSessionScope: RESPONSES_SESSION_SCOPE_CONTEXT_COMPRESSION
  })
}

function shouldClaudeCompress(inputTokens: number, config: CompressionConfig): boolean {
  if (!config.enabled || config.contextLength <= 0) return false
  if (claudeCompactFailures >= MAX_CLAUDE_COMPACT_FAILURES) return false
  return inputTokens >= getClaudeCompactBudget(config).autoCompactThreshold
}

function shouldClaudePreCompress(inputTokens: number, config: CompressionConfig): boolean {
  if (!config.enabled || config.contextLength <= 0) return false
  const budget = getClaudeCompactBudget(config)
  const threshold = Math.max(1, budget.autoCompactThreshold - 8_000)
  return inputTokens >= threshold && inputTokens < budget.autoCompactThreshold
}

async function claudeCompressMessages(
  messages: UnifiedMessage[],
  providerConfig: ProviderConfig,
  signal?: AbortSignal,
  _preserveCount?: number,
  focusPrompt?: string,
  _pinnedContext?: string,
  trigger: CompactBoundaryMeta['trigger'] = 'manual',
  preTokens = 0,
  config?: CompressionConfig | null,
  postCompactContext?: string
): Promise<{ messages: UnifiedMessage[]; result: CompressionResult }> {
  if (claudeCompactFailures >= MAX_CLAUDE_COMPACT_FAILURES) {
    return {
      messages,
      result: {
        compressed: false,
        originalCount: messages.length,
        newCount: messages.length,
        reason: 'circuit_breaker_open'
      }
    }
  }

  const compacted = await runClaudeCompact({
    messages: messages as unknown as ClaudeCompactMessage[],
    trigger,
    preTokens,
    config,
    focusPrompt,
    postCompactContext,
    sourceRuntime: 'renderer',
    signal,
    summarize: async ({ systemPrompt, userPrompt, signal: summarizeSignal }) =>
      callClaudeCompactSummarizer({
        providerConfig,
        systemPrompt,
        userPrompt,
        signal: summarizeSignal
      }),
    createId: nanoid,
    now: Date.now
  })

  if (compacted.result.compressed) {
    claudeCompactFailures = 0
  } else if (
    compacted.result.reason === 'summarizer_failed' ||
    compacted.result.reason === 'summarizer_prompt_too_long' ||
    compacted.result.reason === 'unsafe_summary_output'
  ) {
    claudeCompactFailures += 1
  }

  return compacted as unknown as { messages: UnifiedMessage[]; result: CompressionResult }
}

export function createClaudeCodeCompactStrategy(): ContextCompressionStrategy {
  return {
    id: 'claude-code-compact-v1',
    shouldCompress: shouldClaudeCompress,
    shouldPreCompress: shouldClaudePreCompress,
    preCompressMessages: (messages) =>
      sanitizeMessagesForClaudeCompact(messages as unknown as ClaudeCompactMessage[]) as unknown as UnifiedMessage[],
    compressMessages: claudeCompressMessages
  }
}
