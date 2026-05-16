import type {
  ClaudeCompactBoundaryMeta,
  ClaudeCompactMessage,
  RunClaudeCompactArgs,
  RunClaudeCompactResult
} from './types'
import { buildClaudeCompactSystemPrompt, buildClaudeCompactUserPrompt, extractClaudeCompactSummary } from './prompt'
import { dehydrateClaudeCompactPayloads } from './payload'
import { assertClaudeCompactSummarySafe, sanitizeMessagesForClaudeCompact } from './sanitizer'
import {
  dropOldestClaudeCompactRounds,
  selectClaudeCompactRanges,
  selectClaudePartialCompactRanges,
  type ClaudeCompactRangeSelection,
  type ClaudePartialCompactRangeSelection
} from './rounds'

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
  partialRange?: ClaudePartialCompactRangeSelection['partialRange']
  partialAnchorId?: string
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
        ...(args.partialRange && args.partialAnchorId
          ? {
              partialRange: {
                mode: 'from_up_to' as const,
                anchorId: args.partialAnchorId,
                from: args.partialRange.from,
                upTo: args.partialRange.upTo,
                tailStart: args.partialRange.tailStart
              }
            }
          : {}),
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

type EffectiveClaudeCompactSelection = ClaudeCompactRangeSelection | ClaudePartialCompactRangeSelection

function hasNonToolResultUserContent(message: ClaudeCompactMessage): boolean {
  if (message.role !== 'user') return false
  if (typeof message.content === 'string') return message.content.trim().length > 0
  return message.content.some((block) => block.type !== 'tool_result')
}

function shouldPreferPartialSelection(
  messages: ClaudeCompactMessage[],
  selection: ClaudeCompactRangeSelection
): boolean {
  if (!selection.ok) return false
  const userAnchors = messages.filter(hasNonToolResultUserContent)
  if (userAnchors.length !== 1) return false
  return selection.compressibleMessages.some((message) => message.id === userAnchors[0]!.id)
}

function resolveEffectiveCompactSelection(
  messages: ClaudeCompactMessage[]
): EffectiveClaudeCompactSelection {
  const fullSelection = selectClaudeCompactRanges(messages)
  if (fullSelection.ok && !shouldPreferPartialSelection(messages, fullSelection)) {
    return fullSelection
  }

  if (
    !fullSelection.ok &&
    fullSelection.reason !== 'insufficient_messages' &&
    fullSelection.reason !== 'insufficient_compressible_messages'
  ) {
    return fullSelection
  }

  const partialSelection = selectClaudePartialCompactRanges(messages)
  return partialSelection.ok ? partialSelection : fullSelection
}

function isPartialCompactSelection(
  selection: EffectiveClaudeCompactSelection
): selection is ClaudePartialCompactRangeSelection {
  return selection.ok && 'partialRange' in selection
}

export async function runClaudeCompact(args: RunClaudeCompactArgs): Promise<RunClaudeCompactResult> {
  const now = args.now ?? Date.now
  const createId = args.createId ?? (() => `compact-${Math.random().toString(36).slice(2)}`)
  const selection = resolveEffectiveCompactSelection(args.messages)
  if (!selection.ok) {
    if (
      selection.reason === 'insufficient_messages' ||
      selection.reason === 'insufficient_compressible_messages'
    ) {
      const dehydrated = dehydrateClaudeCompactPayloads(args.messages, { config: args.config })
      if (dehydrated.changed) {
        return {
          messages: dehydrated.messages,
          result: {
            compressed: true,
            originalCount: args.messages.length,
            newCount: dehydrated.messages.length,
            messagesSummarized: 0,
            payloadsCompacted: dehydrated.payloadsCompacted
          }
        }
      }
    }

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
  let rangeMetadataValid = true

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

      const messagesSummarized = compressibleMessages.length
      const summaryMessage = createSummaryMessage({
        createId,
        now,
        summary,
        messagesSummarized
      })
      const postCompactStateMessage = createPostCompactStateMessage({
        createId,
        now,
        postCompactContext: args.postCompactContext
      })
      const partialSelection =
        rangeMetadataValid && isPartialCompactSelection(selection) ? selection : null
      const compressedMessages = [
        createBoundaryMessage({
          createId,
          now,
          trigger: args.trigger,
          preTokens: args.preTokens,
          postTokens: 0,
          messagesSummarized,
          retryCount: attempt,
          compressedRange: rangeMetadataValid ? selection.compressedRange : undefined,
          preservedRange: rangeMetadataValid ? selection.preservedRange : undefined,
          partialRange: partialSelection?.partialRange,
          partialAnchorId: partialSelection?.anchorMessage.id,
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
          messagesSummarized,
          ...(partialSelection ? { partialCompact: true } : {})
        }
      }
    } catch (error) {
      lastError = error
      if (!isPromptTooLongError(error) || attempt >= MAX_CLAUDE_COMPACT_RETRIES) break
      const retryMessages =
        dropOldestClaudeCompactRounds(compressibleMessages, attempt + 1) ??
        (isPartialCompactSelection(selection)
          ? null
          : dropOldestClaudeCompactRounds(args.messages, attempt + 1))
      if (!retryMessages) break
      compressibleMessages = retryMessages
      rangeMetadataValid = false
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
