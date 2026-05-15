import type {
  ClaudeCompactConfig,
  ClaudeCompactContentBlock,
  ClaudeCompactMessage,
  ClaudeCompactTextBlock
} from './types'

const REDACTED_VALUE = '[REDACTED]'
const HIGH_RISK_COMPACT_SUMMARY_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|\b(?:set-cookie|cookie)\s*:|\bauthorization\s*:\s*(?:bearer|basic)\b/i
const SECRET_KEY_NAMES = [
  'apiKey',
  'api_key',
  'api-key',
  'x-api-key',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'session_token',
  'auth_token',
  'client_secret',
  'secret',
  'password',
  'passwd'
] as const
const SECRET_KEY_PATTERN = SECRET_KEY_NAMES.map((key) =>
  key.replace(/[\\^$.*+?()[\]{}|]/g, (char) => `\\${char}`)
).join('|')
const PRIVATE_KEY_BLOCK_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi
const KEY_VALUE_SECRET_PATTERN = new RegExp(
  `\\b(${SECRET_KEY_PATTERN})\\b\\s*([:=])\\s*(["']?)([^\\s,;,"'{}\\]]+)\\3`,
  'gi'
)
const JSON_SECRET_PATTERN = new RegExp(
  `(["'])(${SECRET_KEY_PATTERN}|authorization|cookie|set-cookie)\\1\\s*:\\s*(["'])([\\s\\S]*?)\\3`,
  'gi'
)
const AUTHORIZATION_SECRET_PATTERN = /(authorization\s*:\s*)(bearer|basic)\s+([^\r\n]+)/gi
const COOKIE_SECRET_PATTERN = /\b(set-cookie|cookie)\s*:\s*([^\r\n]+)/gi
const DEFAULT_LARGE_TOOL_RESULT_CHARS = 48_000

const SECRET_INPUT_KEYS = new Set([
  'apikey',
  'api_key',
  'api-key',
  'x-api-key',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'session_token',
  'auth_token',
  'client_secret',
  'secret',
  'password',
  'passwd',
  'authorization',
  'cookie',
  'set-cookie'
])

const PAYLOAD_INPUT_KEYS = new Set([
  'data',
  'base64',
  'image',
  'filepath',
  'file_path',
  'path',
  'url',
  'uri',
  'raw',
  'payload',
  'content',
  'thinking'
])

function redactTextForModelContext(value: string): string {
  if (!value) return value

  return value
    .replace(PRIVATE_KEY_BLOCK_PATTERN, REDACTED_VALUE)
    .replace(
      JSON_SECRET_PATTERN,
      (_match, keyQuote: string, key: string, valueQuote: string) =>
        `${keyQuote}${key}${keyQuote}:${valueQuote}${REDACTED_VALUE}${valueQuote}`
    )
    .replace(
      KEY_VALUE_SECRET_PATTERN,
      (_match, key: string, separator: string, quote: string) =>
        `${key}${separator}${quote}${REDACTED_VALUE}${quote}`
    )
    .replace(
      AUTHORIZATION_SECRET_PATTERN,
      (_match, prefix: string, scheme: string) => `${prefix}${scheme} ${REDACTED_VALUE}`
    )
    .replace(COOKIE_SECRET_PATTERN, (_match, header: string) => `${header}: ${REDACTED_VALUE}`)
}

function normalizeInputKey(key: string): string {
  return key.trim().toLowerCase()
}

function sanitizeToolUseValue(value: unknown, key?: string): unknown {
  const normalizedKey = key ? normalizeInputKey(key) : null

  if (normalizedKey && SECRET_INPUT_KEYS.has(normalizedKey)) {
    return REDACTED_VALUE
  }

  if (normalizedKey && PAYLOAD_INPUT_KEYS.has(normalizedKey)) {
    return REDACTED_VALUE
  }

  if (typeof value === 'string') {
    return redactTextForModelContext(value)
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeToolUseValue(item))
  }

  if (value && typeof value === 'object') {
    const sanitizedEntries = Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
      entryKey,
      sanitizeToolUseValue(entryValue, entryKey)
    ])

    return Object.fromEntries(sanitizedEntries)
  }

  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return value
  }

  return REDACTED_VALUE
}

function sanitizeToolUseInput(input: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizeToolUseValue(input)
  return sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)
    ? (sanitized as Record<string, unknown>)
    : { redactedInput: REDACTED_VALUE }
}

function getLargeToolResultCharLimit(config?: ClaudeCompactConfig | null): number {
  if (!config?.contextLength) return DEFAULT_LARGE_TOOL_RESULT_CHARS
  const effectiveChars = Math.max(8_000, Math.floor(config.contextLength * 0.24))
  return Math.min(DEFAULT_LARGE_TOOL_RESULT_CHARS, effectiveChars)
}

function compactLargeTextForCompactInput(
  text: string,
  config?: ClaudeCompactConfig | null
): string {
  const maxChars = getLargeToolResultCharLimit(config)
  if (text.length <= maxChars) return text

  const headChars = Math.floor(maxChars * 0.6)
  const tailChars = Math.max(1_000, maxChars - headChars)
  return [
    '[Tool result compacted for context budget]',
    text.slice(0, headChars),
    `[... omitted ${text.length - headChars - tailChars} chars ...]`,
    text.slice(-tailChars)
  ].join('\n')
}

function sanitizeToolResultContent(
  content: Extract<ClaudeCompactContentBlock, { type: 'tool_result' }>['content'],
  config?: ClaudeCompactConfig | null
): Extract<ClaudeCompactContentBlock, { type: 'tool_result' }>['content'] {
  if (typeof content === 'string') {
    return compactLargeTextForCompactInput(redactTextForModelContext(content), config)
  }

  return content.map((item): ClaudeCompactTextBlock => {
    if (item.type === 'text') {
      return {
        ...item,
        text: compactLargeTextForCompactInput(redactTextForModelContext(item.text), config)
      }
    }

    return { type: 'text', text: '[image]' }
  })
}

function sanitizeContentBlock(
  block: ClaudeCompactContentBlock,
  config?: ClaudeCompactConfig | null
): ClaudeCompactContentBlock | null {
  switch (block.type) {
    case 'text':
      return { ...block, text: redactTextForModelContext(block.text) }
    case 'thinking':
      return null
    case 'tool_use':
      return { ...block, input: sanitizeToolUseInput(block.input) }
    case 'tool_result':
      return { ...block, content: sanitizeToolResultContent(block.content, config) }
    case 'image':
      return { type: 'text', text: '[image]' }
    case 'image_error':
      return { ...block, message: redactTextForModelContext(block.message) }
    case 'agent_error':
      return {
        ...block,
        message: redactTextForModelContext(block.message),
        ...(block.details ? { details: redactTextForModelContext(block.details) } : {}),
        ...(block.stackTrace ? { stackTrace: redactTextForModelContext(block.stackTrace) } : {})
      }
    default:
      return { type: 'text', text: '[document]' }
  }
}

export function sanitizeMessagesForClaudeCompact(
  messages: ClaudeCompactMessage[],
  config?: ClaudeCompactConfig | null
): ClaudeCompactMessage[] {
  return messages
    .filter((message) => message.meta?.postCompactState !== true)
    .map((message) => {
      if (typeof message.content === 'string') {
        return {
          ...message,
          content: redactTextForModelContext(message.content)
        }
      }

      const content = message.content
        .map((block) => sanitizeContentBlock(block, config))
        .filter((block): block is ClaudeCompactContentBlock => block !== null)

      return {
        ...message,
        content
      }
    })
}

export function assertClaudeCompactSummarySafe(summary: string): string {
  if (HIGH_RISK_COMPACT_SUMMARY_PATTERN.test(summary)) {
    throw new Error('unsafe compact summary: high-risk secret material detected')
  }

  return redactTextForModelContext(summary)
}
