import type {
  ClaudeCompactBoundaryMeta,
  ClaudeCompactMessage,
  RunClaudeCompactArgs,
  RunClaudeCompactResult
} from './types'
import { buildClaudeCompactSystemPrompt, buildClaudeCompactUserPrompt, extractClaudeCompactSummary } from './prompt'
import { assertClaudeCompactSummarySafe, sanitizeMessagesForClaudeCompact } from './sanitizer'
import { dropOldestClaudeCompactRounds, selectClaudeCompactRanges } from './rounds'

export const MAX_CLAUDE_COMPACT_RETRIES = 3

function serializeCompactMessages(messages: ClaudeCompactMessage[]): string {
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

function estimateSharedTokens(messages: ClaudeCompactMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4)
}

function createBoundaryMessage(args: {
  createId: () => string
  now: () => number
  trigger: ClaudeCompactBoundaryMeta['trigger']
  preTokens: number
  postTokens: number
  messagesSummarized: number
  retryCount: number
  compressedRange?: { start: number; end: number }
  preservedRange?: { start: number; end: number }
  preservedMessages: ClaudeCompactMessage[]
}): ClaudeCompactMessage {
  const preservedSegment = args.preservedMessages.length
    ? {
        headId: args.preservedMessages[0]!.id,
        anchorId: '',
        tailId: args.preservedMessages[args.preservedMessages.length - 1]!.id
      }
    : undefined

  return {
    id: args.createId(),
    role: 'system',
    content: 'Conversation compacted',
    createdAt: args.now(),
    meta: {
      compactBoundary: {
        strategy: 'claude-code-compact-v1',
        trigger: args.trigger,
        preTokens: args.preTokens,
        postTokens: args.postTokens,
        messagesSummarized: args.messagesSummarized,
        compactedAt: args.now(),
        retryCount: args.retryCount,
        ...(args.compressedRange ? { compressedRange: args.compressedRange } : {}),
        ...(args.preservedRange ? { preservedRange: args.preservedRange } : {}),
        safetyFlags: ['untrusted-history', 'sanitized-input', 'validated-summary'],
        ...(preservedSegment ? { preservedSegment } : {})
      }
    }
  }
}

function createSummaryMessage(args: {
  createId: () => string
  now: () => number
  summary: string
  messagesSummarized: number
}): ClaudeCompactMessage {
  return {
    id: args.createId(),
    role: 'user',
    content: args.summary,
    createdAt: args.now(),
    meta: {
      compactSummary: {
        messagesSummarized: args.messagesSummarized,
        recentMessagesPreserved: true
      }
    }
  }
}

function createPostCompactStateMessage(args: {
  createId: () => string
  now: () => number
  postCompactContext?: string
}): ClaudeCompactMessage | null {
  const content = args.postCompactContext?.trim()
  if (!content) return null
  return {
    id: args.createId(),
    role: 'user',
    content,
    createdAt: args.now(),
    meta: { postCompactState: true }
  }
}

export async function runClaudeCompact(args: RunClaudeCompactArgs): Promise<RunClaudeCompactResult> {
  const now = args.now ?? Date.now
  const createId = args.createId ?? (() => `compact-${Math.random().toString(36).slice(2)}`)
  const selection = selectClaudeCompactRanges(args.messages)
  if (!selection.ok) {
    return {
      messages: args.messages,
      result: {
        compressed: false,
        originalCount: args.messages.length,
        newCount: args.messages.length,
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
      const sanitizedMessages = sanitizeMessagesForClaudeCompact(compressibleMessages, args.config)
      const rawSummary = await args.summarize({
        systemPrompt: buildClaudeCompactSystemPrompt(),
        userPrompt: buildClaudeCompactUserPrompt({
          serializedHistory: serializeCompactMessages(sanitizedMessages),
          focusPrompt: args.focusPrompt,
          trigger: args.trigger
        }),
        signal: args.signal
      })
      const extracted = extractClaudeCompactSummary(rawSummary)
      if (!extracted) throw new Error('empty compact summary')
      const summary = assertClaudeCompactSummarySafe(extracted)

      const summaryMessage = createSummaryMessage({
        createId,
        now,
        summary,
        messagesSummarized: selection.compressibleMessages.length
      })
      const postCompactStateMessage = createPostCompactStateMessage({
        createId,
        now,
        postCompactContext: args.postCompactContext
      })
      const compressedMessages = [
        createBoundaryMessage({
          createId,
          now,
          trigger: args.trigger,
          preTokens: args.preTokens,
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
      if (boundary.meta?.compactBoundary) {
        boundary.meta.compactBoundary.postTokens = estimateSharedTokens(compressedMessages)
      }

      return {
        messages: compressedMessages,
        result: {
          compressed: true,
          originalCount: args.messages.length,
          newCount: compressedMessages.length,
          messagesSummarized: selection.compressibleMessages.length
        }
      }
    } catch (error) {
      lastError = error
      if (!isPromptTooLongError(error) || attempt >= MAX_CLAUDE_COMPACT_RETRIES) break
      const retryMessages =
        dropOldestClaudeCompactRounds(compressibleMessages, attempt + 1) ??
        dropOldestClaudeCompactRounds(args.messages, attempt + 1)
      if (!retryMessages) break
      compressibleMessages = retryMessages
    }
  }

  return {
    messages: args.messages,
    result: {
      compressed: false,
      originalCount: args.messages.length,
      newCount: args.messages.length,
      reason: isPromptTooLongError(lastError)
        ? 'summarizer_prompt_too_long'
        : isUnsafeSummaryOutputError(lastError)
          ? 'unsafe_summary_output'
          : 'summarizer_failed'
    }
  }
}
