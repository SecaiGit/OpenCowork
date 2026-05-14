import { nanoid } from 'nanoid'
import type {
  AIModelConfig,
  CompactBoundaryMeta,
  CompactSummaryMeta,
  ContentBlock,
  ProviderConfig,
  UnifiedMessage
} from '../api/types'
import { runSidecarTextRequest } from '@renderer/lib/ipc/agent-bridge'
import { RESPONSES_SESSION_SCOPE_CONTEXT_COMPRESSION } from '@renderer/lib/api/responses-session-policy'
import i18n from '@renderer/locales'
import {
  DEFAULT_CONTEXT_COMPRESSION_CONTEXT_LENGTH,
  clampCompressionContextLength,
  clampCompressionThreshold,
  resolveCompressionStrategyId,
  type ContextCompressionStrategyId
} from './context-compression-config'
import {
  CLAUDE_COMPACT_AUTO_BUFFER_TOKENS,
  CLAUDE_COMPACT_RESERVED_OUTPUT_CAP
} from './claude-compact-budget'
import { groupMessagesByApiRound } from './context-budget'

export {
  DEFAULT_CONTEXT_COMPRESSION_CONTEXT_LENGTH,
  DEFAULT_CONTEXT_COMPRESSION_THRESHOLD,
  MAX_CONTEXT_COMPRESSION_THRESHOLD,
  MIN_CONTEXT_COMPRESSION_THRESHOLD,
  clampCompressionContextLength,
  clampCompressionThreshold,
  resolveCompressionStrategyId,
  type ContextCompressionStrategyId
} from './context-compression-config'

export interface CompressionConfig {
  enabled: boolean
  /** Model's max context token count. */
  contextLength: number
  /** Full compression trigger threshold, clamped to 0.3 ~ 0.9. */
  threshold: number
  /** Compression strategy. Omitted legacy configs resolve to the default strategy. */
  strategyId?: ContextCompressionStrategyId
  /** Optional pre-compression trigger threshold before buffer adjustments. */
  preCompressThreshold?: number
  /** Tokens reserved for summary/output headroom before trigger calculations. */
  reservedOutputBudget?: number
}

export interface CompressionDefaults {
  defaultContextLength?: number | null
  defaultThreshold?: number | null
  strategyId?: ContextCompressionStrategyId | null
}

export type CompressionSkipReason =
  | 'insufficient_messages'
  | 'insufficient_compressible_messages'
  | 'recent_segment_too_large'
  | 'single_tool_result_too_large'
  | 'summarizer_prompt_too_long'
  | 'summarizer_failed'
  | 'circuit_breaker_open'

export interface CompressionResult {
  compressed: boolean
  originalCount: number
  newCount: number
  messagesSummarized?: number
  reason?: CompressionSkipReason
}

export interface ContextCompressionStrategy {
  id: ContextCompressionStrategyId
  shouldCompress: (inputTokens: number, config: CompressionConfig) => boolean
  shouldPreCompress: (inputTokens: number, config: CompressionConfig) => boolean
  preCompressMessages: (messages: UnifiedMessage[]) => UnifiedMessage[]
  compressMessages: (
    messages: UnifiedMessage[],
    providerConfig: ProviderConfig,
    signal?: AbortSignal,
    preserveCount?: number,
    focusPrompt?: string,
    pinnedContext?: string,
    trigger?: CompactBoundaryMeta['trigger'],
    preTokens?: number,
    postCompactContext?: string
  ) => Promise<{ messages: UnifiedMessage[]; result: CompressionResult }>
}

export const DEFAULT_CONTEXT_COMPRESSION_LIMIT = DEFAULT_CONTEXT_COMPRESSION_CONTEXT_LENGTH
export const DEFAULT_CONTEXT_COMPRESSION_RESERVED_OUTPUT_TOKENS = CLAUDE_COMPACT_RESERVED_OUTPUT_CAP
export const CONTEXT_COMPRESSION_AUTO_BUFFER_TOKENS = CLAUDE_COMPACT_AUTO_BUFFER_TOKENS
export const CONTEXT_COMPRESSION_PRE_BUFFER_TOKENS = 20_000
export const CONTEXT_COMPRESSION_PRE_GAP_TOKENS = 8_000

const DEFAULT_PRECOMPRESS_THRESHOLD = 0.65
const PRESERVE_RECENT_COUNT = 4
const TOOL_RESULT_KEEP_RECENT = 6
const MAX_COMPRESS_RETRIES = 2
const MAX_CONSECUTIVE_FAILURES = 3
const SAFE_BOUNDARY_SCAN_LIMIT = 10
const TOOL_RESULT_CLEAR_CHAR_THRESHOLD = 200
const SERIALIZED_TOOL_USE_INPUT_LIMIT = 500
const SERIALIZED_TOOL_RESULT_LIMIT = 800
const BASE_RETRY_DELAY_MS = 1_500
const LEGACY_SUMMARY_PREFIXES = [
  '[Context Memory Compressed Summary]',
  '[上下文记忆压缩摘要]',
  '[上下文记忆压缩摘要'
]

const CLEARED_TOOL_RESULT_PLACEHOLDER = i18n.t('contextCompression.clearedToolResult', {
  ns: 'agent'
})
const CLEARED_THINKING_PLACEHOLDER = i18n.t('contextCompression.clearedThinking', { ns: 'agent' })
const COMPRESSION_SYSTEM_PROMPT = i18n.t('contextCompression.systemPrompt', { ns: 'agent' })

let consecutiveFailures = 0

export function resetCompressionFailures(): void {
  consecutiveFailures = 0
}

export function resolveCompressionThreshold(
  modelConfig?: Pick<AIModelConfig, 'contextCompressionThreshold'> | null,
  defaults?: CompressionDefaults
): number {
  if (typeof modelConfig?.contextCompressionThreshold === 'number') {
    return clampCompressionThreshold(modelConfig.contextCompressionThreshold)
  }
  return clampCompressionThreshold(defaults?.defaultThreshold)
}

export function resolveCompressionContextLength(
  modelConfig?: Pick<AIModelConfig, 'contextLength' | 'enableExtendedContextCompression'> | null,
  defaults?: CompressionDefaults
): number {
  const hasModelContextLength =
    typeof modelConfig?.contextLength === 'number' && modelConfig.contextLength > 0
  const configuredContextLength = hasModelContextLength
    ? clampCompressionContextLength(modelConfig.contextLength)
    : clampCompressionContextLength(defaults?.defaultContextLength)

  if (configuredContextLength <= DEFAULT_CONTEXT_COMPRESSION_LIMIT) {
    return configuredContextLength
  }

  if (hasModelContextLength && modelConfig?.enableExtendedContextCompression === false) {
    return DEFAULT_CONTEXT_COMPRESSION_LIMIT
  }

  return configuredContextLength
}

export function resolveCompressionReservedOutputBudget(
  modelConfig?: Pick<AIModelConfig, 'maxOutputTokens'> | null
): number {
  const maxOutputTokens =
    typeof modelConfig?.maxOutputTokens === 'number' && modelConfig.maxOutputTokens > 0
      ? Math.floor(modelConfig.maxOutputTokens)
      : DEFAULT_CONTEXT_COMPRESSION_RESERVED_OUTPUT_TOKENS
  return Math.min(DEFAULT_CONTEXT_COMPRESSION_RESERVED_OUTPUT_TOKENS, maxOutputTokens)
}

export function getEffectiveContextWindow(config: CompressionConfig): number {
  if (config.contextLength <= 0) return 0
  const reserved = Math.max(
    0,
    config.reservedOutputBudget ?? DEFAULT_CONTEXT_COMPRESSION_RESERVED_OUTPUT_TOKENS
  )
  return Math.max(1, config.contextLength - reserved)
}

export function getCompressionTriggerTokens(config: CompressionConfig): number {
  const effectiveWindow = getEffectiveContextWindow(config)
  if (effectiveWindow <= 0) return 0
  const ratioThreshold = Math.floor(effectiveWindow * config.threshold)
  const bufferedThreshold = effectiveWindow - CONTEXT_COMPRESSION_AUTO_BUFFER_TOKENS
  return Math.max(
    1,
    Math.min(ratioThreshold, bufferedThreshold > 0 ? bufferedThreshold : ratioThreshold)
  )
}

export function getPreCompressionTriggerTokens(config: CompressionConfig): number {
  const effectiveWindow = getEffectiveContextWindow(config)
  if (effectiveWindow <= 0) return 0

  const preThreshold = config.preCompressThreshold ?? DEFAULT_PRECOMPRESS_THRESHOLD
  const ratioThreshold = Math.floor(effectiveWindow * preThreshold)
  const fullThreshold = getCompressionTriggerTokens(config)
  const candidates = [ratioThreshold]
  const bufferedThreshold = effectiveWindow - CONTEXT_COMPRESSION_PRE_BUFFER_TOKENS
  if (bufferedThreshold > 0) candidates.push(bufferedThreshold)
  const gapThreshold = fullThreshold - CONTEXT_COMPRESSION_PRE_GAP_TOKENS
  if (gapThreshold > 0) candidates.push(gapThreshold)
  const threshold = Math.min(...candidates)
  return Math.max(1, Math.min(threshold, Math.max(1, fullThreshold - 1)))
}

function partialSummaryShouldCompress(inputTokens: number, config: CompressionConfig): boolean {
  if (!config.enabled || config.contextLength <= 0) return false
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return false
  return inputTokens >= getCompressionTriggerTokens(config)
}

function partialSummaryShouldPreCompress(inputTokens: number, config: CompressionConfig): boolean {
  if (!config.enabled || config.contextLength <= 0) return false
  const preThreshold = getPreCompressionTriggerTokens(config)
  const fullThreshold = getCompressionTriggerTokens(config)
  return inputTokens >= preThreshold && inputTokens < fullThreshold
}

const PARTIAL_SUMMARY_STRATEGY: ContextCompressionStrategy = {
  id: 'partial-summary-v1',
  shouldCompress: partialSummaryShouldCompress,
  shouldPreCompress: partialSummaryShouldPreCompress,
  preCompressMessages: partialSummaryPreCompressMessages,
  compressMessages: partialSummaryCompressMessages
}

const COMPRESSION_STRATEGIES: Partial<Record<ContextCompressionStrategyId, ContextCompressionStrategy>> = {
  'partial-summary-v1': PARTIAL_SUMMARY_STRATEGY
}

export function getCompressionStrategy(
  config?: Pick<CompressionConfig, 'strategyId'> | null
): ContextCompressionStrategy {
  return COMPRESSION_STRATEGIES[resolveCompressionStrategyId(config?.strategyId)] ?? PARTIAL_SUMMARY_STRATEGY
}

export function shouldCompress(inputTokens: number, config: CompressionConfig): boolean {
  return getCompressionStrategy(config).shouldCompress(inputTokens, config)
}

export function shouldPreCompress(inputTokens: number, config: CompressionConfig): boolean {
  return getCompressionStrategy(config).shouldPreCompress(inputTokens, config)
}

export function isCompactBoundaryMessage(message: UnifiedMessage): boolean {
  return message.role === 'system' && !!message.meta?.compactBoundary
}

export function isCompactSummaryMessage(message: UnifiedMessage): boolean {
  return message.role === 'user' && !!message.meta?.compactSummary
}

export function isLegacyCompactSummaryMessage(message: UnifiedMessage): boolean {
  if (message.role !== 'user' || typeof message.content !== 'string') return false
  const content = message.content.trim()
  return LEGACY_SUMMARY_PREFIXES.some((prefix) => content.startsWith(prefix))
}

export function isCompactSummaryLikeMessage(message: UnifiedMessage): boolean {
  return isCompactSummaryMessage(message) || isLegacyCompactSummaryMessage(message)
}

export function extractUnifiedMessageText(message?: UnifiedMessage | null): string {
  if (!message) return ''
  if (typeof message.content === 'string') return message.content.trim()
  if (!Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
    .trim()
}

function splitCompactSummaryBlocks(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n+/)
    .map((block) => block.trim())
    .filter(Boolean)
}

function isCompactSummaryTitleBlock(block: string): boolean {
  const trimmed = block.trim()
  if (!trimmed) return false
  if (LEGACY_SUMMARY_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    return true
  }
  if (!/^\[[^\]\n]+]$/.test(trimmed)) {
    return false
  }
  return (
    /summary|compressed|compacted|memory/i.test(trimmed) ||
    /[\u4e0a\u4e0b\u6587\u6458\u8981\u538b\u7f29]/u.test(trimmed)
  )
}

function isCompactSummaryIntroBlock(block: string): boolean {
  const normalized = block.replace(/\s+/g, ' ').trim()
  if (!normalized || normalized.length > 320) {
    return false
  }
  return [
    /this session is being continued/i,
    /continued from a previous conversation/i,
    /the following summary covers/i,
    /recent messages are preserved/i,
    /\u672c\u6b21\u4f1a\u8bdd.*\u7ee7\u7eed/u,
    /\u4ee5\u4e0b\u6458\u8981.*\u6d88\u606f/u,
    /\u8fd1\u671f\u6d88\u606f.*\u4fdd\u7559/u
  ].some((pattern) => pattern.test(normalized))
}

export function getCompactSummaryDisplayText(message: UnifiedMessage): string {
  const text = extractUnifiedMessageText(message)
  if (!text || !isCompactSummaryLikeMessage(message)) {
    return text
  }

  const blocks = splitCompactSummaryBlocks(text)
  if (blocks.length === 0) {
    return text
  }

  let startIndex = 0
  if (isCompactSummaryTitleBlock(blocks[startIndex]!)) {
    startIndex += 1
  }
  if (startIndex < blocks.length - 1 && isCompactSummaryIntroBlock(blocks[startIndex]!)) {
    startIndex += 1
  }

  return blocks.slice(startIndex).join('\n\n').trim() || text
}

function findFallbackPreservedHeadId(
  compressedMessages: UnifiedMessage[],
  summaryIndex: number
): string | null {
  for (let index = summaryIndex + 1; index < compressedMessages.length; index += 1) {
    const message = compressedMessages[index]
    if (message?.meta?.postCompactState === true) {
      continue
    }
    return message?.id ?? null
  }

  return null
}

export function mergeCompressedMessagesIntoConversation(
  currentMessages: UnifiedMessage[],
  compressedMessages?: UnifiedMessage[] | null
): UnifiedMessage[] | null {
  if (!compressedMessages || compressedMessages.length === 0) {
    return null
  }

  const summaryIndex = compressedMessages.findIndex((message) =>
    isCompactSummaryLikeMessage(message)
  )
  if (summaryIndex < 0) {
    return null
  }

  const boundaryMessage = compressedMessages.find((message) => isCompactBoundaryMessage(message))
  const preservedHeadId =
    boundaryMessage?.meta?.compactBoundary?.preservedSegment?.headId ??
    findFallbackPreservedHeadId(compressedMessages, summaryIndex) ??
    null

  const compressedIndexById = new Map(
    compressedMessages.map((message, index) => [message.id, index])
  )
  const currentIndexById = new Map(currentMessages.map((message, index) => [message.id, index]))

  const anchorId =
    (preservedHeadId &&
    compressedIndexById.has(preservedHeadId) &&
    currentIndexById.has(preservedHeadId)
      ? preservedHeadId
      : null) ??
    [...currentMessages].reverse().find((message) => compressedIndexById.has(message.id))?.id ??
    null

  if (!anchorId) {
    return null
  }

  const compressedTailIndex = compressedIndexById.get(anchorId) ?? -1
  const currentTailIndex = currentIndexById.get(anchorId) ?? -1

  if (compressedTailIndex < 0 || currentTailIndex < 0) {
    return null
  }

  return [
    ...compressedMessages.slice(0, compressedTailIndex),
    ...currentMessages.slice(currentTailIndex)
  ]
}

export function createCompactBoundaryMessage(args: {
  trigger: CompactBoundaryMeta['trigger']
  preTokens: number
  messagesSummarized: number
  preservedMessages?: UnifiedMessage[]
}): UnifiedMessage {
  const preservedMessages = args.preservedMessages ?? []
  const meta: CompactBoundaryMeta = {
    trigger: args.trigger,
    preTokens: args.preTokens,
    messagesSummarized: args.messagesSummarized,
    ...(preservedMessages.length > 0
      ? {
          preservedSegment: {
            headId: preservedMessages[0]!.id,
            anchorId: '',
            tailId: preservedMessages[preservedMessages.length - 1]!.id
          }
        }
      : {})
  }

  return {
    id: nanoid(),
    role: 'system',
    content: 'Conversation compacted',
    createdAt: Date.now(),
    meta: { compactBoundary: meta }
  }
}

export function createCompactSummaryMessage(args: {
  summary: string
  messagesSummarized: number
  recentMessagesPreserved: boolean
}): UnifiedMessage {
  const summaryMeta: CompactSummaryMeta = {
    messagesSummarized: args.messagesSummarized,
    recentMessagesPreserved: args.recentMessagesPreserved
  }

  return {
    id: nanoid(),
    role: 'user',
    content: i18n.t('contextCompression.summaryMessage', {
      ns: 'agent',
      count: args.messagesSummarized,
      summary: args.summary
    }),
    createdAt: Date.now(),
    meta: { compactSummary: summaryMeta }
  }
}

function partialSummaryPreCompressMessages(messages: UnifiedMessage[]): UnifiedMessage[] {
  if (messages.length <= TOOL_RESULT_KEEP_RECENT) return messages

  const cutoff = messages.length - TOOL_RESULT_KEEP_RECENT
  return messages.map((message, index) => {
    if (index >= cutoff) return message
    if (typeof message.content === 'string') return message

    let changed = false
    const newBlocks = message.content.map((block) => {
      if (block.type === 'tool_result') {
        const content =
          typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
        if (content.length > TOOL_RESULT_CLEAR_CHAR_THRESHOLD) {
          changed = true
          return { ...block, content: CLEARED_TOOL_RESULT_PLACEHOLDER }
        }
      }

      if (block.type === 'thinking') {
        changed = true
        return { ...block, thinking: CLEARED_THINKING_PLACEHOLDER }
      }

      if (block.type === 'image') {
        changed = true
        return { type: 'text', text: '[image]' } as ContentBlock
      }

      return block
    })

    return changed ? { ...message, content: newBlocks } : message
  })
}

export function isPromptTooLongError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /prompt.?too.?long|context.?length|maximum context|too many tokens|413/i.test(message)
}

export function truncateHeadForPromptTooLongRetry(
  messages: UnifiedMessage[],
  attempt: number
): UnifiedMessage[] | null {
  const groups = groupMessagesByApiRound(messages)
  if (groups.length < 2) return null

  const dropRatio = Math.min(0.6, Math.max(0.2, attempt * 0.2))
  const dropCount = Math.min(Math.max(1, Math.floor(groups.length * dropRatio)), groups.length - 1)
  const kept = groups.slice(dropCount).flatMap((group) => group.messages)
  if (kept.length < 2) return null

  if (kept[0]?.role === 'assistant') {
    return [
      {
        id: nanoid(),
        role: 'user',
        content:
          '[Earlier messages were dropped from this compaction attempt because the summarizer prompt was too long.]',
        createdAt: Date.now()
      },
      ...kept
    ]
  }

  return kept
}

async function partialSummaryCompressMessages(
  messages: UnifiedMessage[],
  providerConfig: ProviderConfig,
  signal?: AbortSignal,
  preserveCount = PRESERVE_RECENT_COUNT,
  focusPrompt?: string,
  pinnedContext?: string,
  trigger: CompactBoundaryMeta['trigger'] = 'manual',
  preTokens = 0,
  postCompactContext?: string
): Promise<{ messages: UnifiedMessage[]; result: CompressionResult }> {
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
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
  const originalCount = messages.length
  if (originalCount < preserveCount + 2) {
    return {
      messages,
      result: {
        compressed: false,
        originalCount,
        newCount: originalCount,
        reason: 'insufficient_messages'
      }
    }
  }

  const boundaryIndex = findSafeCompactBoundary(messages, messages.length - preserveCount)
  const messagesToCompress = messages.slice(0, boundaryIndex)
  const messagesToPreserve = messages.slice(boundaryIndex)
  const dedupedMessagesToPreserve = messagesToPreserve.filter(
    (message) => message.meta?.postCompactState !== true
  )

  if (messagesToCompress.length < 2) {
    return {
      messages,
      result: {
        compressed: false,
        originalCount,
        newCount: originalCount,
        reason: 'insufficient_compressible_messages'
      }
    }
  }

  const baseMessages = messagesToCompress
  let lastError: Error | null = null
  for (let attempt = 0; attempt <= MAX_COMPRESS_RETRIES; attempt += 1) {
    try {
      const inputMessages =
        attempt === 0
          ? baseMessages
          : lastError && isPromptTooLongError(lastError)
            ? (truncateHeadForPromptTooLongRetry(baseMessages, attempt) ??
              truncateOldestMessages(baseMessages, attempt))
            : truncateOldestMessages(baseMessages, attempt)
      const originalTaskMessage = findOriginalTaskMessage(inputMessages)
      const serialized = serializeCompressionInput(
        inputMessages,
        originalTaskMessage?.content,
        pinnedContext
      )
      const rawSummary = await callSummarizer(serialized, providerConfig, signal, focusPrompt)
      const formattedSummary = formatCompactSummary(rawSummary)
      if (!formattedSummary.trim()) {
        throw new Error(i18n.t('contextCompression.emptyResultError', { ns: 'agent' }))
      }

      const boundaryMessage = createCompactBoundaryMessage({
        trigger,
        preTokens,
        messagesSummarized: messagesToCompress.length,
        preservedMessages: dedupedMessagesToPreserve
      })
      const summaryMessage = createCompactSummaryMessage({
        summary: formattedSummary,
        messagesSummarized: messagesToCompress.length,
        recentMessagesPreserved: dedupedMessagesToPreserve.length > 0
      })

      if (boundaryMessage.meta?.compactBoundary?.preservedSegment) {
        boundaryMessage.meta.compactBoundary.preservedSegment.anchorId = summaryMessage.id
      }

      consecutiveFailures = 0

      const trimmedPostCompactContext = postCompactContext?.trim() ?? ''
      const postCompactContextMessage = trimmedPostCompactContext
        ? ({
            id: nanoid(),
            role: 'user' as const,
            content: trimmedPostCompactContext,
            createdAt: Date.now(),
            meta: { postCompactState: true }
          } satisfies UnifiedMessage)
        : null
      const compressedMessages = [
        boundaryMessage,
        summaryMessage,
        ...(postCompactContextMessage ? [postCompactContextMessage] : []),
        ...dedupedMessagesToPreserve
      ]
      return {
        messages: compressedMessages,
        result: {
          compressed: true,
          originalCount,
          newCount: compressedMessages.length,
          messagesSummarized: messagesToCompress.length
        }
      }
    } catch (error) {
      lastError = error as Error
      console.error(`[Context Compression] Attempt ${attempt + 1} failed:`, error)
      if (attempt < MAX_COMPRESS_RETRIES && !isPromptTooLongError(error)) {
        await new Promise((resolve) =>
          setTimeout(resolve, BASE_RETRY_DELAY_MS * Math.pow(2, attempt))
        )
      }
    }
  }

  consecutiveFailures += 1
  console.error(
    `[Context Compression] All retries failed (consecutive: ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`,
    lastError
  )

  return {
    messages,
    result: {
      compressed: false,
      originalCount,
      newCount: originalCount,
      reason: isPromptTooLongError(lastError) ? 'summarizer_prompt_too_long' : 'summarizer_failed'
    }
  }
}

export function preCompressMessages(
  messages: UnifiedMessage[],
  config?: Pick<CompressionConfig, 'strategyId'> | null
): UnifiedMessage[] {
  return getCompressionStrategy(config).preCompressMessages(messages)
}

export async function compressMessages(
  messages: UnifiedMessage[],
  providerConfig: ProviderConfig,
  signal?: AbortSignal,
  preserveCount = PRESERVE_RECENT_COUNT,
  focusPrompt?: string,
  pinnedContext?: string,
  trigger: CompactBoundaryMeta['trigger'] = 'manual',
  preTokens = 0,
  config?: Pick<CompressionConfig, 'strategyId'> | null,
  postCompactContext?: string
): Promise<{ messages: UnifiedMessage[]; result: CompressionResult }> {
  return getCompressionStrategy(config).compressMessages(
    messages,
    providerConfig,
    signal,
    preserveCount,
    focusPrompt,
    pinnedContext,
    trigger,
    preTokens,
    postCompactContext
  )
}

function findSafeCompactBoundary(messages: UnifiedMessage[], initialBoundary: number): number {
  let boundary = Math.max(1, Math.min(initialBoundary, messages.length - 1))

  for (let attempts = 0; attempts < SAFE_BOUNDARY_SCAN_LIMIT; attempts += 1) {
    const compressedToolUseIds = new Set<string>()
    for (let index = 0; index < boundary; index += 1) {
      const message = messages[index]
      if (typeof message.content === 'string') continue
      for (const block of message.content) {
        if (block.type === 'tool_use' && block.id) {
          compressedToolUseIds.add(block.id)
        }
      }
    }

    let hasSplit = false
    for (let index = boundary; index < messages.length && !hasSplit; index += 1) {
      const message = messages[index]
      if (typeof message.content === 'string') continue
      for (const block of message.content) {
        if (
          block.type === 'tool_result' &&
          block.toolUseId &&
          compressedToolUseIds.has(block.toolUseId)
        ) {
          hasSplit = true
          break
        }
      }
    }

    if (!hasSplit) return boundary
    boundary = Math.max(1, boundary - 1)
  }

  return boundary
}

function truncateOldestMessages(messages: UnifiedMessage[], attempt: number): UnifiedMessage[] {
  const dropCount = Math.ceil(messages.length * 0.25 * attempt)
  const result: UnifiedMessage[] = []
  let dropped = 0
  let keptFirstUser = false

  for (const message of messages) {
    if (message.role === 'system') {
      result.push(message)
      continue
    }

    if (!keptFirstUser && message.role === 'user') {
      result.push(message)
      keptFirstUser = true
      continue
    }

    if (dropped < dropCount) {
      dropped += 1
      continue
    }

    result.push(message)
  }

  return result.length >= 2 ? result : messages
}

function formatCompactSummary(rawSummary: string): string {
  let result = rawSummary
  result = result.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '')
  const summaryMatch = result.match(/<summary>([\s\S]*?)<\/summary>/i)
  if (summaryMatch) {
    result = summaryMatch[1] ?? ''
  }
  return result.replace(/\n\n+/g, '\n\n').trim()
}

function serializeCompressionInput(
  messages: UnifiedMessage[],
  originalTaskContent?: UnifiedMessage['content'],
  pinnedContext?: string
): string {
  const parts: string[] = []

  if (originalTaskContent) {
    parts.push('## Original Task')
    parts.push(
      typeof originalTaskContent === 'string'
        ? originalTaskContent
        : serializeMessageContent(originalTaskContent)
    )
  }

  if (pinnedContext?.trim()) {
    parts.push('## Pinned Plan Context')
    parts.push(pinnedContext.trim())
  }

  parts.push('## Full Conversation History')
  parts.push(serializeMessages(messages))

  return parts.join('\n\n')
}

function serializeMessageContent(content: ContentBlock[]): string {
  return content
    .map((block) => {
      switch (block.type) {
        case 'text':
          return block.text
        case 'thinking':
          return ''
        case 'tool_use':
          return i18n.t('contextCompression.toolCallLog', {
            ns: 'agent',
            name: block.name,
            input: JSON.stringify(block.input).slice(0, SERIALIZED_TOOL_USE_INPUT_LIMIT)
          })
        case 'tool_result': {
          const result =
            typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
          const preview =
            result.length > SERIALIZED_TOOL_RESULT_LIMIT
              ? `${result.slice(0, SERIALIZED_TOOL_RESULT_LIMIT)}\n... [truncated, ${result.length} chars total]`
              : result
          return i18n.t('contextCompression.toolResultLog', {
            ns: 'agent',
            error: block.isError,
            content: preview
          })
        }
        case 'image':
          return i18n.t('contextCompression.imageAttachment', { ns: 'agent' })
        case 'image_error':
          return `[Image error: ${block.message}]`
        case 'agent_error':
          return `[Agent error: ${block.message}]`
        default:
          return ''
      }
    })
    .filter(Boolean)
    .join('\n')
}

function findOriginalTaskMessage(messages: UnifiedMessage[]): UnifiedMessage | null {
  for (const message of messages) {
    if (message.role !== 'user') continue
    if (message.source === 'team') continue
    if (isCompactSummaryLikeMessage(message)) continue

    if (Array.isArray(message.content)) {
      const hasHumanContent = message.content.some(
        (block) => block.type === 'text' || block.type === 'image'
      )
      if (!hasHumanContent) continue
    }

    return message
  }

  return null
}

function serializeMessages(messages: UnifiedMessage[]): string {
  const parts: string[] = []

  for (const message of messages) {
    const role = message.role.toUpperCase()

    if (typeof message.content === 'string') {
      if (message.content.trim()) {
        parts.push(`[${role}]: ${message.content}`)
      }
      continue
    }

    const blockText = serializeMessageContent(message.content)
    if (blockText.trim()) {
      parts.push(`[${role}]: ${blockText}`)
    }
  }

  return parts.join('\n\n')
}

async function callSummarizer(
  serializedMessages: string,
  providerConfig: ProviderConfig,
  signal?: AbortSignal,
  focusPrompt?: string
): Promise<string> {
  const config: ProviderConfig = {
    ...providerConfig,
    systemPrompt: COMPRESSION_SYSTEM_PROMPT,
    thinkingEnabled: false
  }

  const focusInstruction = focusPrompt
    ? i18n.t('contextCompression.specialFocus', { ns: 'agent', focusPrompt })
    : ''

  const messages: UnifiedMessage[] = [
    {
      id: 'compress-req',
      role: 'user',
      content: i18n.t('contextCompression.compressRequest', {
        ns: 'agent',
        focusInstruction,
        content: serializedMessages
      }),
      createdAt: Date.now()
    }
  ]

  const abortController = new AbortController()
  const timeout = setTimeout(() => abortController.abort(), 120_000)

  if (signal) {
    if (signal.aborted) {
      clearTimeout(timeout)
      abortController.abort()
    } else {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timeout)
          abortController.abort()
        },
        { once: true }
      )
    }
  }

  let result = ''
  try {
    result = await runSidecarTextRequest({
      provider: config,
      messages,
      signal: abortController.signal,
      maxIterations: 1,
      responsesSessionScope: RESPONSES_SESSION_SCOPE_CONTEXT_COMPRESSION
    })
  } finally {
    clearTimeout(timeout)
  }

  result = result.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  if (!result) {
    throw new Error(i18n.t('contextCompression.emptyResultError', { ns: 'agent' }))
  }

  const stripped = result.replace(/<\/?(?:analysis|summary)>/gi, '').trim()
  if (!stripped) {
    throw new Error(i18n.t('contextCompression.emptyResultError', { ns: 'agent' }))
  }

  return result
}
