import { getClaudeCompactBudget } from './budget'
import type { ClaudeCompactConfig, ClaudeCompactContentBlock, ClaudeCompactMessage, ClaudeCompactSkipReason } from './types'

export interface ClaudeTextGuardOptions {
  config: Pick<ClaudeCompactConfig, 'contextLength' | 'reservedOutputBudget'>
  maxChars?: number
}

export interface ClaudeTextGuardResult {
  changed: boolean
  message: ClaudeCompactMessage
  reason?: ClaudeCompactSkipReason
  originalChars: number
  keptChars: number
}

const DEFAULT_MIN_MAX_CHARS = 1_000
const DEFAULT_MAX_MAX_CHARS = 12_000
const EXPLICIT_MIN_MAX_CHARS = 200
const ASSISTANT_MARKER = '[Assistant response compacted for context budget]'
const USER_MARKER = '[User input externalized for context budget]'

function resolveMaxChars(options: ClaudeTextGuardOptions): number {
  if (typeof options.maxChars === 'number' && Number.isFinite(options.maxChars)) {
    return Math.max(EXPLICIT_MIN_MAX_CHARS, Math.floor(options.maxChars))
  }

  const budget = getClaudeCompactBudget(options.config)
  const candidate = Math.floor(budget.effectiveContextWindow * 2)

  if (!Number.isFinite(candidate)) {
    return DEFAULT_MIN_MAX_CHARS
  }

  return Math.max(DEFAULT_MIN_MAX_CHARS, Math.min(DEFAULT_MAX_MAX_CHARS, candidate))
}

function trimCompactedTextToMax(body: string, marker: string, maxChars: number): string {
  if (body.length <= maxChars) {
    return body
  }

  if (marker.length >= maxChars) {
    return marker.slice(0, maxChars)
  }

  const trimmed = body.slice(0, maxChars)
  if (trimmed.startsWith(marker)) {
    return trimmed
  }

  return `${marker}${body.slice(marker.length, maxChars)}`
}

function buildCompactedText(text: string, marker: string, maxChars: number): string {
  const originalChars = text.length
  const minimalBody = `${marker}\nOriginal chars: ${originalChars}\nOmitted chars: ${originalChars}`

  if (minimalBody.length >= maxChars) {
    return trimCompactedTextToMax(minimalBody, marker, maxChars)
  }

  const metadataLines = [
    marker,
    `Original chars: ${originalChars}`,
    'Retained head/tail chars: 0',
    'Omitted middle chars: 0',
    '',
    '## Head',
    '',
    '## Tail',
    ''
  ]
  const metadataOverhead = metadataLines.join('\n').length
  const remainingBudget = maxChars - metadataOverhead

  if (remainingBudget <= 0) {
    return trimCompactedTextToMax(minimalBody, marker, maxChars)
  }

  const retainedHeadTailChars = Math.min(originalChars, Math.max(1, remainingBudget))
  const headChars = Math.min(originalChars, Math.max(1, Math.floor(retainedHeadTailChars / 2)))
  const tailChars = Math.min(originalChars - headChars, Math.max(0, retainedHeadTailChars - headChars))
  const head = text.slice(0, headChars)
  const tail = tailChars > 0 ? text.slice(-tailChars) : ''
  const omittedMiddleChars = Math.max(0, originalChars - head.length - tail.length)

  const body = [
    marker,
    `Original chars: ${originalChars}`,
    `Retained head/tail chars: ${head.length + tail.length}`,
    `Omitted middle chars: ${omittedMiddleChars}`,
    '',
    '## Head',
    head,
    '',
    '## Tail',
    tail
  ].join('\n')

  return trimCompactedTextToMax(body, marker, maxChars)
}

function compactTextIfNeeded(
  text: string,
  marker: string,
  maxChars: number
): { changed: boolean; text: string; originalChars: number; keptChars: number } {
  const originalChars = text.length

  if (originalChars <= maxChars) {
    return { changed: false, text, originalChars, keptChars: originalChars }
  }

  const compactedText = buildCompactedText(text, marker, maxChars)

  return {
    changed: true,
    text: compactedText,
    originalChars,
    keptChars: compactedText.length
  }
}

function buildExternalizedInputReference(text: string, maxChars: number): string {
  const body = [
    USER_MARKER,
    `Original chars: ${text.length}`,
    'Original content omitted from model context instead of being truncated.',
    'Action required: ask the user to upload the content as a file, provide a local file path, or resend it in smaller chunks.'
  ].join('\n')

  return trimCompactedTextToMax(body, USER_MARKER, maxChars)
}

function externalizeTextIfNeeded(
  text: string,
  maxChars: number
): { changed: boolean; text: string; originalChars: number; keptChars: number } {
  const originalChars = text.length

  if (originalChars <= maxChars) {
    return { changed: false, text, originalChars, keptChars: originalChars }
  }

  const externalizedText = buildExternalizedInputReference(text, maxChars)

  return {
    changed: true,
    text: externalizedText,
    originalChars,
    keptChars: externalizedText.length
  }
}

function isToolUseBlock(block: ClaudeCompactContentBlock): boolean {
  return block.type === 'tool_use'
}

export function guardClaudeAssistantFinalizePayload(
  message: ClaudeCompactMessage,
  options: ClaudeTextGuardOptions
): ClaudeTextGuardResult {
  if (message.role !== 'assistant') {
    return { changed: false, message, originalChars: 0, keptChars: 0 }
  }

  const maxChars = resolveMaxChars(options)

  if (typeof message.content === 'string') {
    const compacted = compactTextIfNeeded(message.content, ASSISTANT_MARKER, maxChars)
    if (!compacted.changed) {
      return {
        changed: false,
        message,
        originalChars: compacted.originalChars,
        keptChars: compacted.keptChars
      }
    }

    return {
      changed: true,
      reason: 'assistant_output_too_large',
      message: { ...message, content: compacted.text },
      originalChars: compacted.originalChars,
      keptChars: compacted.keptChars
    }
  }

  if (message.content.some(isToolUseBlock)) {
    return {
      changed: false,
      reason: 'unsafe_tool_boundary',
      message,
      originalChars: 0,
      keptChars: 0
    }
  }

  let changed = false
  let originalChars = 0
  let keptChars = 0
  const content = message.content.map((block) => {
    if (block.type !== 'text') {
      return block
    }

    const compacted = compactTextIfNeeded(block.text, ASSISTANT_MARKER, maxChars)
    originalChars += compacted.originalChars
    keptChars += compacted.keptChars

    if (!compacted.changed) {
      return block
    }

    changed = true
    return { ...block, text: compacted.text }
  })

  if (!changed) {
    return { changed: false, message, originalChars, keptChars }
  }

  return {
    changed: true,
    reason: 'assistant_output_too_large',
    message: { ...message, content },
    originalChars,
    keptChars
  }
}

export function guardClaudeSingleInputPayload(
  message: ClaudeCompactMessage,
  options: ClaudeTextGuardOptions
): ClaudeTextGuardResult {
  if (message.role !== 'user') {
    return { changed: false, message, originalChars: 0, keptChars: 0 }
  }

  const maxChars = resolveMaxChars(options)

  if (typeof message.content === 'string') {
    const externalized = externalizeTextIfNeeded(message.content, maxChars)
    if (!externalized.changed) {
      return {
        changed: false,
        message,
        originalChars: externalized.originalChars,
        keptChars: externalized.keptChars
      }
    }

    return {
      changed: true,
      reason: 'single_input_too_large',
      message: { ...message, content: externalized.text },
      originalChars: externalized.originalChars,
      keptChars: externalized.keptChars
    }
  }

  let changed = false
  let originalChars = 0
  let keptChars = 0
  const content = message.content.map((block) => {
    if (block.type !== 'text') {
      return block
    }

    const externalized = externalizeTextIfNeeded(block.text, maxChars)
    originalChars += externalized.originalChars
    keptChars += externalized.keptChars

    if (!externalized.changed) {
      return block
    }

    changed = true
    return { ...block, text: externalized.text }
  })

  if (!changed) {
    return { changed: false, message, originalChars, keptChars }
  }

  return {
    changed: true,
    reason: 'single_input_too_large',
    message: { ...message, content },
    originalChars,
    keptChars
  }
}
