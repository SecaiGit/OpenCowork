import type { ContentBlock, UnifiedMessage } from '../api/types'
import { compactToolResultForContext } from './context-payload-compaction'
import { redactTextForModelContext } from './context-budget'
import type { CompressionConfig } from './context-compression'

const HIGH_RISK_COMPACT_SUMMARY_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|\b(?:set-cookie|cookie)\s*:|\bauthorization\s*:\s*(?:bearer|basic)\b/i

type ClaudeCompactSanitizerConfig = CompressionConfig | null | undefined

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

function normalizeInputKey(key: string): string {
  return key.trim().toLowerCase()
}

function sanitizeToolUseValue(value: unknown, key?: string): unknown {
  const normalizedKey = key ? normalizeInputKey(key) : null

  if (normalizedKey && SECRET_INPUT_KEYS.has(normalizedKey)) {
    return '[REDACTED]'
  }

  if (normalizedKey && PAYLOAD_INPUT_KEYS.has(normalizedKey)) {
    return '[REDACTED]'
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

  return '[REDACTED]'
}

function sanitizeToolUseInput(input: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizeToolUseValue(input)
  return sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)
    ? (sanitized as Record<string, unknown>)
    : { redactedInput: '[REDACTED]' }
}

function sanitizeContentBlock(
  block: ContentBlock,
  config?: ClaudeCompactSanitizerConfig
): ContentBlock | null {
  switch (block.type) {
    case 'text':
      return { ...block, text: redactTextForModelContext(block.text) }
    case 'thinking':
      return null
    case 'tool_use':
      return { ...block, input: sanitizeToolUseInput(block.input) }
    case 'tool_result': {
      const sanitizedContent = typeof block.content === 'string'
        ? redactTextForModelContext(block.content)
        : block.content.map((item) => {
            if (item.type === 'text') {
              return { ...item, text: redactTextForModelContext(item.text) }
            }

            return { type: 'text', text: '[image]' } as const
          })

      const compacted = compactToolResultForContext({
        toolName: 'unknown',
        content: sanitizedContent,
        isError: block.isError,
        config
      })

      return { ...block, content: compacted.content }
    }
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
  messages: UnifiedMessage[],
  config?: ClaudeCompactSanitizerConfig
): UnifiedMessage[] {
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
        .filter((block): block is ContentBlock => block !== null)

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
