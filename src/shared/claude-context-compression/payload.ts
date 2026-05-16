import type {
  ClaudeCompactConfig,
  ClaudeCompactContentBlock,
  ClaudeCompactMessage,
  ClaudeCompactTextBlock,
  ClaudeCompactToolResultBlock
} from './types'

const REDACTED_VALUE = '[REDACTED]'
const TOOL_RESULT_COMPACTED_MARKER = '[Tool result compacted for context budget]'
const IMAGE_OMITTED_TEXT = '[image omitted from long-task context payload]'
const DEFAULT_MAX_TOOL_RESULT_CHARS = 12_000
const IMPORTANT_LINE_PATTERN =
  /\b(error|failed|failure|exception|traceback|panic|fatal|denied|timeout|warning|warn)\b/i
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
  'passwd',
  'base64',
  'imageBase64',
  'image_base64',
  'image-base64'
] as const
const SECRET_KEY_PATTERN = SECRET_KEY_NAMES.map((key) =>
  key.replace(/[\\^$.*+?()[\]{}|]/g, (char) => `\\${char}`)
).join('|')
const FILE_PATH_KEY_NAMES = ['filePath', 'file_path', 'file-path'] as const
const FILE_PATH_KEY_PATTERN = FILE_PATH_KEY_NAMES.map((key) =>
  key.replace(/[\\^$.*+?()[\]{}|]/g, (char) => `\\${char}`)
).join('|')
const PRIVATE_KEY_BLOCK_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi
const BASE64_DATA_URI_PATTERN = /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi
const JSON_FILE_PATH_PATTERN = new RegExp(
  `(["'])((${FILE_PATH_KEY_PATTERN}))\\1\\s*:\\s*(["'])([\\s\\S]*?)\\4`,
  'gi'
)
const KEY_VALUE_FILE_PATH_PREFIX_PATTERN = '(^|[\\r\\n])([ \\t]*)'
const QUOTED_KEY_VALUE_FILE_PATH_PATTERN = new RegExp(
  `${KEY_VALUE_FILE_PATH_PREFIX_PATTERN}(${FILE_PATH_KEY_PATTERN})\\b\\s*([:=])\\s*(["'])([^\\r\\n]*?)\\5`,
  'gi'
)
const KEY_VALUE_FILE_PATH_PATTERN = new RegExp(
  `${KEY_VALUE_FILE_PATH_PREFIX_PATTERN}(${FILE_PATH_KEY_PATTERN})\\b\\s*([:=])\\s*([^\\s,;"'{}\\]]+)`,
  'gi'
)
const JSON_SECRET_PATTERN = new RegExp(
  `(["'])((${SECRET_KEY_PATTERN})|authorization|cookie|set-cookie)\\1\\s*:\\s*(["'])([\\s\\S]*?)\\4`,
  'gi'
)
const KEY_VALUE_SECRET_PATTERN = new RegExp(
  `\\b(${SECRET_KEY_PATTERN}|authorization|cookie|set-cookie)\\b\\s*([:=])\\s*(["']?)([^\\s,;"'{}\\]]+)\\3`,
  'gi'
)
const AUTHORIZATION_HEADER_PATTERN = /\b(authorization\s*:\s*)[^\r\n]+/gi
const COOKIE_HEADER_PATTERN = /\b((?:set-)?cookie\s*:\s*)[^\r\n]+/gi
const API_KEY_HEADER_PATTERN = /\b(x-api-key\s*:\s*)[^\r\n]+/gi

function formatFilePathForContext(value: string): string {
  const normalized = value.trim().replace(/\\/g, '/')
  const basename = normalized.replace(/\/+$/g, '').split('/').pop()?.trim() ?? ''
  const safeName = basename.replace(/[^a-zA-Z0-9._ -]+/g, '_').slice(0, 120).trim()
  return safeName ? `[PATH:${safeName}]` : '[PATH:omitted]'
}

export interface ClaudePayloadDehydrationOptions {
  config?: Pick<ClaudeCompactConfig, 'contextLength' | 'reservedOutputBudget'> | null
  maxToolResultChars?: number
  toolNameByResultId?: Map<string, string>
}

export interface ClaudePayloadDehydrationResult {
  messages: ClaudeCompactMessage[]
  changed: boolean
  payloadsCompacted: number
  originalChars: number
  keptChars: number
}

export function redactClaudeCompactText(value: string): string {
  if (!value) return value

  return value
    .replace(PRIVATE_KEY_BLOCK_PATTERN, REDACTED_VALUE)
    .replace(BASE64_DATA_URI_PATTERN, REDACTED_VALUE)
    .replace(
      JSON_FILE_PATH_PATTERN,
      (_match, keyQuote: string, key: string, _pathKey: string, valueQuote: string, pathValue: string) => {
        return `${keyQuote}${key}${keyQuote}:${valueQuote}${formatFilePathForContext(pathValue)}${valueQuote}`
      }
    )
    .replace(
      QUOTED_KEY_VALUE_FILE_PATH_PATTERN,
      (
        _match,
        linePrefix: string,
        indent: string,
        key: string,
        separator: string,
        quote: string,
        pathValue: string
      ) =>
        `${linePrefix}${indent}${key}${separator}${quote}${formatFilePathForContext(pathValue)}${quote}`
    )
    .replace(
      KEY_VALUE_FILE_PATH_PATTERN,
      (_match, linePrefix: string, indent: string, key: string, separator: string, pathValue: string) =>
        `${linePrefix}${indent}${key}${separator}${formatFilePathForContext(pathValue)}`
    )
    .replace(JSON_SECRET_PATTERN, (_match, keyQuote: string, key: string, _secretKey: string, valueQuote: string) => {
      return `${keyQuote}${key}${keyQuote}:${valueQuote}${REDACTED_VALUE}${valueQuote}`
    })
    .replace(
      KEY_VALUE_SECRET_PATTERN,
      (_match, key: string, separator: string, quote: string) => `${key}${separator}${quote}${REDACTED_VALUE}${quote}`
    )
    .replace(AUTHORIZATION_HEADER_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED_VALUE}`)
    .replace(COOKIE_HEADER_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED_VALUE}`)
    .replace(API_KEY_HEADER_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED_VALUE}`)
}

function resolveMaxToolResultChars(options?: ClaudePayloadDehydrationOptions): number {
  if (options?.maxToolResultChars && options.maxToolResultChars > 0) {
    return Math.floor(options.maxToolResultChars)
  }

  const contextLength = options?.config?.contextLength
  if (!contextLength || contextLength <= 0) return DEFAULT_MAX_TOOL_RESULT_CHARS
  return Math.max(2_000, Math.min(DEFAULT_MAX_TOOL_RESULT_CHARS, Math.floor(contextLength * 0.06)))
}

function collectImportantLines(text: string, limit = 40): string[] {
  const result: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!IMPORTANT_LINE_PATTERN.test(line)) continue
    result.push(line)
    if (result.length >= limit) break
  }
  return result
}

function compactLongText(
  text: string,
  args: { toolName: string; maxChars: number; isError?: boolean }
): { text: string; compacted: boolean } {
  const redacted = redactClaudeCompactText(text)
  if (redacted.length <= args.maxChars) {
    return { text: redacted, compacted: redacted !== text }
  }

  const headChars = Math.max(200, Math.floor(args.maxChars * 0.28))
  const tailChars = Math.max(120, Math.floor(args.maxChars * 0.14))
  const head = redacted.slice(0, headChars).trimEnd()
  const tail = redacted.slice(-tailChars).trimStart()
  const importantLines = collectImportantLines(redacted, 20)
  const body = [
    TOOL_RESULT_COMPACTED_MARKER,
    `Tool: ${args.toolName}`,
    `Original chars: ${text.length}`,
    `Retained head/tail chars: ${head.length + tail.length}`,
    `Omitted middle chars: ${Math.max(0, text.length - head.length - tail.length)}`,
    args.isError ? 'Result status: error' : 'Result status: success',
    '',
    '## Head',
    head,
    importantLines.length ? `## Important lines preserved\n${importantLines.join('\n')}` : '',
    '## Tail',
    tail
  ]
    .filter(Boolean)
    .join('\n')

  if (body.length <= args.maxChars) return { text: body, compacted: true }
  return {
    text: `${TOOL_RESULT_COMPACTED_MARKER}\n${body.slice(0, Math.max(0, args.maxChars - TOOL_RESULT_COMPACTED_MARKER.length - 1))}`,
    compacted: true
  }
}

function estimateToolResultChars(content: ClaudeCompactToolResultBlock['content']): number {
  if (typeof content === 'string') return content.length
  return content.reduce((sum, block) => {
    if (block.type === 'text') return sum + block.text.length
    return sum + IMAGE_OMITTED_TEXT.length
  }, 0)
}

function serializeToolResultArrayContent(content: Exclude<ClaudeCompactToolResultBlock['content'], string>): string {
  const imageCount = content.filter((item) => item.type === 'image').length
  const sections: string[] = []

  if (imageCount > 0) {
    sections.push(IMAGE_OMITTED_TEXT, `Omitted image blocks: ${imageCount}`)
  }

  const textBlocks = content
    .map((item, index) => {
      if (item.type !== 'text') return null
      const label = `## Block ${index + 1}`
      return `${label}\n${item.text}`
    })
    .filter((item): item is string => item !== null)

  if (textBlocks.length > 0) {
    sections.push(textBlocks.join('\n\n'))
  }

  return sections.join('\n\n')
}

function dehydrateToolResultBlock(
  block: ClaudeCompactToolResultBlock,
  options: Required<Pick<ClaudePayloadDehydrationOptions, 'toolNameByResultId'>> & { maxChars: number }
): { block: ClaudeCompactToolResultBlock; changed: boolean; originalChars: number; keptChars: number } {
  const originalChars = estimateToolResultChars(block.content)
  const toolName = options.toolNameByResultId.get(block.toolUseId) ?? 'unknown'

  if (typeof block.content === 'string') {
    const compacted = compactLongText(block.content, {
      toolName,
      maxChars: options.maxChars,
      isError: block.isError
    })
    return {
      block: compacted.compacted ? { ...block, content: compacted.text } : block,
      changed: compacted.compacted,
      originalChars,
      keptChars: compacted.text.length
    }
  }

  const serializedContent = serializeToolResultArrayContent(block.content)
  const compacted = compactLongText(serializedContent, {
    toolName,
    maxChars: options.maxChars,
    isError: block.isError
  })
  const changed = compacted.compacted || block.content.some((item) => item.type === 'image')
  const content: ClaudeCompactTextBlock[] = [{ type: 'text', text: compacted.text }]
  const keptChars = compacted.text.length

  return {
    block: changed ? { ...block, content } : block,
    changed,
    originalChars,
    keptChars
  }
}

function buildToolNameByResultId(messages: ClaudeCompactMessage[]): Map<string, string> {
  const result = new Map<string, string>()
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block.type === 'tool_use') result.set(block.id, block.name)
    }
  }
  return result
}

export function dehydrateClaudeCompactPayloads(
  messages: ClaudeCompactMessage[],
  options: ClaudePayloadDehydrationOptions = {}
): ClaudePayloadDehydrationResult {
  const maxChars = resolveMaxToolResultChars(options)
  const toolNameByResultId = options.toolNameByResultId ?? buildToolNameByResultId(messages)
  let changed = false
  let payloadsCompacted = 0
  let originalChars = 0
  let keptChars = 0

  const nextMessages = messages.map((message) => {
    if (!Array.isArray(message.content)) return message

    let messageChanged = false
    const content = message.content.map((block): ClaudeCompactContentBlock => {
      if (block.type !== 'tool_result') return block
      const dehydrated = dehydrateToolResultBlock(block, { maxChars, toolNameByResultId })
      originalChars += dehydrated.originalChars
      keptChars += dehydrated.keptChars
      if (!dehydrated.changed) return block
      changed = true
      messageChanged = true
      payloadsCompacted += 1
      return dehydrated.block
    })

    return messageChanged ? { ...message, content } : message
  })

  return {
    messages: changed ? nextMessages : messages,
    changed,
    payloadsCompacted,
    originalChars,
    keptChars
  }
}
