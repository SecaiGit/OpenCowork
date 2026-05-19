import { nanoid } from 'nanoid'
import { runSidecarTextRequest } from '@renderer/lib/ipc/agent-bridge'
import { RESPONSES_SESSION_SCOPE_CONTEXT_COMPRESSION } from '@renderer/lib/api/responses-session-policy'
import { getGlobalPromptCacheKey, resetGlobalPromptCacheKey } from '../api/provider'
import type { CompactBoundaryMeta, ProviderConfig, UnifiedMessage } from '../api/types'
import type {
  CompressionConfig,
  CompressionResult,
  ContextCompressionStrategy
} from './context-compression'
import {
  getClaudeCompactBudget,
  guardClaudeSingleInputPayload,
  runClaudeCompact,
  sanitizeMessagesForClaudeCompact,
  type ClaudeCompactMessage,
  type ClaudeCompactPromptCacheConfig
} from '../../../../shared/claude-context-compression'

const MAX_CLAUDE_COMPACT_FAILURES = 3
let claudeCompactFailures = 0

function providerSupportsPromptCache(providerConfig: ProviderConfig): boolean {
  return (
    providerConfig.type === 'anthropic' ||
    providerConfig.type === 'openai-chat' ||
    providerConfig.type === 'openai-responses'
  )
}

function providerUsesGlobalPromptCacheKey(providerConfig: ProviderConfig): boolean {
  return providerConfig.type === 'openai-chat' || providerConfig.type === 'openai-responses'
}

function isProviderPromptCacheEnabled(providerConfig: ProviderConfig): boolean {
  if (!providerSupportsPromptCache(providerConfig)) return false
  if (providerConfig.type === 'anthropic') {
    return providerConfig.enablePromptCache !== false || providerConfig.enableSystemPromptCache !== false
  }
  return providerConfig.enablePromptCache !== false
}

function buildClaudePromptCacheConfig(providerConfig: ProviderConfig): ClaudeCompactPromptCacheConfig {
  const providerSupportsCache = providerSupportsPromptCache(providerConfig)
  const enabled = isProviderPromptCacheEnabled(providerConfig)
  return {
    enabled,
    providerSupportsCache,
    ...(enabled && providerSupportsCache && providerUsesGlobalPromptCacheKey(providerConfig)
      ? { previousBaselineId: getGlobalPromptCacheKey(providerConfig) }
      : {})
  }
}

function resetRendererPromptCacheBaseline(
  messages: UnifiedMessage[],
  providerConfig: ProviderConfig
): void {
  if (!isProviderPromptCacheEnabled(providerConfig)) return
  if (!providerUsesGlobalPromptCacheKey(providerConfig)) return
  const promptCache = messages[0]?.meta?.compactBoundary?.promptCache
  if (!promptCache || promptCache.status !== 'reset') return
  promptCache.baselineId = resetGlobalPromptCacheKey(providerConfig)
  promptCache.baselineKind = 'provider_key'
  promptCache.providerKeyRotated = true
}

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

function guardUserInputPayloadsForCompact(
  messages: UnifiedMessage[],
  config?: CompressionConfig | null
): { messages: UnifiedMessage[]; changed: boolean; guardedCount: number } {
  if (!config) return { messages, changed: false, guardedCount: 0 }

  let changed = false
  let guardedCount = 0
  const nextMessages = messages.map((message) => {
    const guarded = guardClaudeSingleInputPayload(message as unknown as ClaudeCompactMessage, { config })
    if (!guarded.changed || guarded.reason !== 'single_input_too_large') return message

    changed = true
    guardedCount += 1
    return { ...message, content: guarded.message.content as UnifiedMessage['content'] }
  })

  return { messages: changed ? nextMessages : messages, changed, guardedCount }
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

  const guardedInput = guardUserInputPayloadsForCompact(messages, config)
  const compacted = await runClaudeCompact({
    messages: guardedInput.messages as unknown as ClaudeCompactMessage[],
    trigger,
    preTokens,
    config,
    focusPrompt,
    postCompactContext,
    sourceRuntime: 'renderer',
    compactHooks: undefined,
    promptCache: buildClaudePromptCacheConfig(providerConfig),
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

  if (guardedInput.changed) {
    compacted.result = {
      ...compacted.result,
      originalCount: messages.length,
      payloadsCompacted: (compacted.result.payloadsCompacted ?? 0) + guardedInput.guardedCount,
      messagesChanged: true
    }
  }

  if (compacted.result.compressed) {
    resetRendererPromptCacheBaseline(compacted.messages as unknown as UnifiedMessage[], providerConfig)
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
