import { nanoid } from 'nanoid'
import { runSidecarTextRequest } from '@renderer/lib/ipc/agent-bridge'
import { RESPONSES_SESSION_SCOPE_CONTEXT_COMPRESSION } from '@renderer/lib/api/responses-session-policy'
import type { CompactBoundaryMeta, ProviderConfig, UnifiedMessage } from '../api/types'
import { estimateMessagesTokens } from './context-budget'
import type {
  CompressionConfig,
  CompressionResult,
  ContextCompressionStrategy
} from './context-compression'
import { getClaudeCompactBudget } from './claude-compact-budget'
import {
  buildClaudeCompactSystemPrompt,
  buildClaudeCompactUserPrompt,
  extractClaudeCompactSummary
} from './claude-compact-prompt'
import {
  assertClaudeCompactSummarySafe,
  sanitizeMessagesForClaudeCompact
} from './claude-compact-sanitizer'
import {
  dropOldestClaudeCompactRounds,
  selectClaudeCompactRanges
} from './claude-compact-rounds'

const MAX_CLAUDE_COMPACT_RETRIES = 3
const MAX_CLAUDE_COMPACT_FAILURES = 3

let claudeCompactFailures = 0

function serializeCompactMessages(messages: UnifiedMessage[]): string {
  return messages
    .map((message) => {
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
      return `[${message.role.toUpperCase()}]: ${content}`
    })
    .join('\n\n')
}

function isPromptTooLongError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /prompt.?too.?long|context.?length|maximum context|too many tokens|413/i.test(message)
}

function isUnsafeSummaryOutputError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /unsafe compact summary/i.test(message)
}

function createBoundaryMessage(args: {
  trigger: CompactBoundaryMeta['trigger']
  preTokens: number
  postTokens: number
  messagesSummarized: number
  retryCount: number
  compressedRange?: { start: number; end: number }
  preservedRange?: { start: number; end: number }
  preservedMessages: UnifiedMessage[]
}): UnifiedMessage {
  const preservedSegment = args.preservedMessages.length
    ? {
        headId: args.preservedMessages[0]!.id,
        anchorId: '',
        tailId: args.preservedMessages[args.preservedMessages.length - 1]!.id
      }
    : undefined

  return {
    id: nanoid(),
    role: 'system',
    content: 'Conversation compacted',
    createdAt: Date.now(),
    meta: {
      compactBoundary: {
        strategy: 'claude-code-compact-v1',
        trigger: args.trigger,
        preTokens: args.preTokens,
        postTokens: args.postTokens,
        messagesSummarized: args.messagesSummarized,
        compactedAt: Date.now(),
        retryCount: args.retryCount,
        ...(args.compressedRange ? { compressedRange: args.compressedRange } : {}),
        ...(args.preservedRange ? { preservedRange: args.preservedRange } : {}),
        safetyFlags: ['untrusted-history', 'sanitized-input', 'validated-summary'],
        ...(preservedSegment ? { preservedSegment } : {})
      }
    }
  }
}

function createSummaryMessage(summary: string, messagesSummarized: number): UnifiedMessage {
  return {
    id: nanoid(),
    role: 'user',
    content: summary,
    createdAt: Date.now(),
    meta: {
      compactSummary: {
        messagesSummarized,
        recentMessagesPreserved: true
      }
    }
  }
}

function createPostCompactStateMessage(postCompactContext?: string): UnifiedMessage | null {
  const content = postCompactContext?.trim()
  if (!content) return null

  return {
    id: nanoid(),
    role: 'user',
    content,
    createdAt: Date.now(),
    meta: { postCompactState: true }
  }
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

  const selection = selectClaudeCompactRanges(messages)
  if (!selection.ok) {
    return {
      messages,
      result: {
        compressed: false,
        originalCount: messages.length,
        newCount: messages.length,
        reason:
          selection.reason === 'unsafe_boundary'
            ? 'unsafe_boundary'
            : selection.reason === 'insufficient_messages'
              ? 'insufficient_messages'
              : 'insufficient_compressible_messages'
      }
    }
  }

  let lastError: unknown = null
  let compressibleMessages = selection.compressibleMessages

  for (let attempt = 0; attempt <= MAX_CLAUDE_COMPACT_RETRIES; attempt += 1) {
    try {
      const sanitizedMessages = sanitizeMessagesForClaudeCompact(compressibleMessages, config)
      const rawSummary = await callClaudeCompactSummarizer({
        providerConfig,
        systemPrompt: buildClaudeCompactSystemPrompt(),
        userPrompt: buildClaudeCompactUserPrompt({
          serializedHistory: serializeCompactMessages(sanitizedMessages),
          focusPrompt,
          trigger
        }),
        signal
      })
      const extracted = extractClaudeCompactSummary(rawSummary)
      if (!extracted) throw new Error('empty compact summary')

      const summary = assertClaudeCompactSummarySafe(extracted)
      const postCompactStateMessage = createPostCompactStateMessage(postCompactContext)
      const summaryMessage = createSummaryMessage(summary, selection.compressibleMessages.length)
      const compressedMessages = [
        createBoundaryMessage({
          trigger,
          preTokens,
          postTokens: 0,
          messagesSummarized: selection.compressibleMessages.length,
          retryCount: attempt,
          compressedRange: selection.compressedRange,
          preservedRange: selection.preservedRange,
          preservedMessages: selection.preservedMessages
        }),
        summaryMessage,
        ...(postCompactStateMessage ? [postCompactStateMessage] : []),
        ...selection.preservedMessages
      ]
      const boundary = compressedMessages[0]
      if (boundary.meta?.compactBoundary?.preservedSegment) {
        boundary.meta.compactBoundary.preservedSegment.anchorId = summaryMessage.id
      }
      const postTokens = estimateMessagesTokens(compressedMessages)
      if (boundary.meta?.compactBoundary) {
        boundary.meta.compactBoundary.postTokens = postTokens
      }

      claudeCompactFailures = 0
      return {
        messages: compressedMessages,
        result: {
          compressed: true,
          originalCount: messages.length,
          newCount: compressedMessages.length,
          messagesSummarized: selection.compressibleMessages.length
        }
      }
    } catch (error) {
      lastError = error
      if (!isPromptTooLongError(error) || attempt >= MAX_CLAUDE_COMPACT_RETRIES) break

      const retryMessages =
        dropOldestClaudeCompactRounds(compressibleMessages, attempt + 1) ??
        dropOldestClaudeCompactRounds(messages, attempt + 1)
      if (!retryMessages) break
      compressibleMessages = retryMessages
    }
  }

  claudeCompactFailures += 1
  const reason = isPromptTooLongError(lastError)
    ? 'summarizer_prompt_too_long'
    : isUnsafeSummaryOutputError(lastError)
      ? 'unsafe_summary_output'
      : 'summarizer_failed'

  return {
    messages,
    result: {
      compressed: false,
      originalCount: messages.length,
      newCount: messages.length,
      reason
    }
  }
}

export function createClaudeCodeCompactStrategy(): ContextCompressionStrategy {
  return {
    id: 'claude-code-compact-v1',
    shouldCompress: shouldClaudeCompress,
    shouldPreCompress: shouldClaudePreCompress,
    preCompressMessages: (messages) => sanitizeMessagesForClaudeCompact(messages),
    compressMessages: claudeCompressMessages
  }
}
