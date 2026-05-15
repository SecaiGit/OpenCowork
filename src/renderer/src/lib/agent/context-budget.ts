import type { ContentBlock, ToolResultContent, UnifiedMessage } from '../api/types'
import {
  CONTEXT_COMPRESSION_AUTO_BUFFER_TOKENS,
  DEFAULT_CONTEXT_COMPRESSION_RESERVED_OUTPUT_TOKENS,
  getCompressionTriggerTokens,
  getEffectiveContextWindow,
  type CompressionConfig
} from './context-compression'

const APPROX_CHARS_PER_TOKEN = 4
const IMAGE_APPROX_TOKENS = 2_000
const FALLBACK_CONTEXT_LENGTH = 200_000
const REDACTED_VALUE = '[REDACTED]'
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

function assertNever(value: never): never {
  throw new Error(`Unhandled content block variant: ${JSON.stringify(value)}`)
}

export interface ContextBudgetSnapshot {
  estimatedTokens: number
  effectiveWindow: number
  compressionTriggerTokens: number
  autoBufferTokens: number
  oversizedToolResults: number
  largestToolResultChars: number
}

export interface ApiRoundGroup {
  start: number
  end: number
  messages: UnifiedMessage[]
}

export type ToolUseResultProtocolIssueKind =
  | 'orphaned_tool_result'
  | 'duplicate_tool_result'
  | 'interleaved_user_text_before_tool_result'
  | 'assistant_tool_use_after_user_text'
  | 'unanswered_tool_use'

export interface ToolUseResultProtocolIssue {
  kind: ToolUseResultProtocolIssueKind
  messageIndex: number
  toolUseId?: string
}

export interface ToolUseResultProtocolValidation {
  valid: boolean
  issues: ToolUseResultProtocolIssue[]
}

export function redactTextForModelContext(value: string): string {
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

export function estimateTextTokens(value: string): number {
  if (!value) return 0
  return Math.ceil(value.length / APPROX_CHARS_PER_TOKEN)
}

export function serializeToolResultContent(content: ToolResultContent): string {
  if (typeof content === 'string') return content

  return content
    .map((block) => {
      switch (block.type) {
        case 'text':
          return block.text
        case 'image':
          return '[image]'
        default:
          return assertNever(block)
      }
    })
    .join('\n')
}

export function estimateToolResultChars(content: ToolResultContent): number {
  if (typeof content === 'string') return content.length

  return content.reduce((total, block) => {
    switch (block.type) {
      case 'text':
        return total + block.text.length
      case 'image':
        return total + IMAGE_APPROX_TOKENS * APPROX_CHARS_PER_TOKEN
      default:
        return total + assertNever(block)
    }
  }, 0)
}

export function estimateContentBlockTokens(block: ContentBlock): number {
  switch (block.type) {
    case 'text':
      return estimateTextTokens(block.text)
    case 'thinking':
      return estimateTextTokens(block.thinking) + estimateTextTokens(block.encryptedContent ?? '')
    case 'tool_use':
      return estimateTextTokens(block.name) + estimateTextTokens(JSON.stringify(block.input))
    case 'tool_result':
      return Math.ceil(estimateToolResultChars(block.content) / APPROX_CHARS_PER_TOKEN)
    case 'image':
      return IMAGE_APPROX_TOKENS
    case 'image_error':
    case 'agent_error':
      return estimateTextTokens(block.message)
    default:
      return assertNever(block)
  }
}

export function estimateMessageTokens(message: UnifiedMessage): number {
  if (typeof message.content === 'string') {
    return estimateTextTokens(message.content)
  }

  return message.content.reduce((sum, block) => sum + estimateContentBlockTokens(block), 0)
}

export function estimateMessagesTokens(messages: UnifiedMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
}

export function buildContextBudgetSnapshot(
  messages: UnifiedMessage[],
  config: CompressionConfig
): ContextBudgetSnapshot {
  let oversizedToolResults = 0
  let largestToolResultChars = 0

  for (const message of messages) {
    if (!Array.isArray(message.content)) continue

    for (const block of message.content) {
      if (block.type !== 'tool_result') continue

      const chars = estimateToolResultChars(block.content)
      largestToolResultChars = Math.max(largestToolResultChars, chars)
      if (chars > getLargeToolResultCharLimit(config)) {
        oversizedToolResults += 1
      }
    }
  }

  return {
    estimatedTokens: estimateMessagesTokens(messages),
    effectiveWindow: getEffectiveContextWindow(config),
    compressionTriggerTokens: getCompressionTriggerTokens(config),
    autoBufferTokens: CONTEXT_COMPRESSION_AUTO_BUFFER_TOKENS,
    oversizedToolResults,
    largestToolResultChars
  }
}

export function getLargeToolResultCharLimit(config?: CompressionConfig | null): number {
  const reserved = Math.max(
    0,
    config?.reservedOutputBudget ?? DEFAULT_CONTEXT_COMPRESSION_RESERVED_OUTPUT_TOKENS
  )
  const effectiveWindow = config
    ? getEffectiveContextWindow(config)
    : Math.max(1, FALLBACK_CONTEXT_LENGTH - reserved)
  const tokenBudget = Math.max(2_000, Math.min(12_000, Math.floor(effectiveWindow * 0.06)))
  return tokenBudget * APPROX_CHARS_PER_TOKEN
}

function collectToolUseIds(message: UnifiedMessage): string[] {
  if (!Array.isArray(message.content)) return []

  return message.content
    .filter((block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use')
    .map((block) => block.id)
}

function collectToolResultIds(message: UnifiedMessage): string[] {
  if (!Array.isArray(message.content)) return []

  return message.content
    .filter(
      (block): block is Extract<ContentBlock, { type: 'tool_result' }> => block.type === 'tool_result'
    )
    .map((block) => block.toolUseId)
}

export function validateToolUseResultProtocol(
  messages: UnifiedMessage[]
): ToolUseResultProtocolValidation {
  const issues: ToolUseResultProtocolIssue[] = []
  const pendingToolUseIds = new Set<string>()
  const answeredToolUseIds = new Set<string>()

  messages.forEach((message, messageIndex) => {
    if (message.role === 'assistant') {
      const toolUseIds = collectToolUseIds(message)

      if (pendingToolUseIds.size > 0 && toolUseIds.length > 0) {
        for (const id of toolUseIds) {
          issues.push({
            kind: 'assistant_tool_use_after_user_text',
            messageIndex,
            toolUseId: id
          })
        }
      }

      for (const id of toolUseIds) {
        pendingToolUseIds.add(id)
      }

      return
    }

    if (message.role !== 'user') return

    if (typeof message.content === 'string') {
      if (pendingToolUseIds.size > 0 && message.content.trim().length > 0) {
        issues.push({
          kind: 'interleaved_user_text_before_tool_result',
          messageIndex
        })
      }
      return
    }

    let sawNonToolResultContent = false

    for (const block of message.content) {
      if (block.type !== 'tool_result') {
        sawNonToolResultContent = true
        continue
      }

      const toolUseId = block.toolUseId

      if (!pendingToolUseIds.has(toolUseId)) {
        issues.push({
          kind: answeredToolUseIds.has(toolUseId) ? 'duplicate_tool_result' : 'orphaned_tool_result',
          messageIndex,
          toolUseId
        })
        continue
      }

      pendingToolUseIds.delete(toolUseId)
      answeredToolUseIds.add(toolUseId)
    }

    if (pendingToolUseIds.size > 0 && sawNonToolResultContent) {
      issues.push({
        kind: 'interleaved_user_text_before_tool_result',
        messageIndex
      })
    }
  })

  for (const toolUseId of pendingToolUseIds) {
    issues.push({
      kind: 'unanswered_tool_use',
      messageIndex: messages.length - 1,
      toolUseId
    })
  }

  return {
    valid: issues.length === 0,
    issues
  }
}

export function groupMessagesByApiRound(messages: UnifiedMessage[]): ApiRoundGroup[] {
  const groups: ApiRoundGroup[] = []
  let start = 0
  let current: UnifiedMessage[] = []
  let currentToolUseIds = new Set<string>()
  let pendingToolUseIds = new Set<string>()
  let answeredToolUseIds = new Set<string>()
  let currentHasAssistant = false
  let currentHasToolUse = false
  let currentHasUserText = false
  let currentHasToolResult = false
  let currentToolRoundInvalid = false
  let previousGroupClosedWithAnsweredToolUseBatch = false

  const flush = (end: number, closedWithAnsweredToolUseBatch = false): void => {
    if (current.length === 0) return

    groups.push({ start, end, messages: current })
    start = end
    current = []
    currentToolUseIds = new Set<string>()
    pendingToolUseIds = new Set<string>()
    answeredToolUseIds = new Set<string>()
    currentHasAssistant = false
    currentHasToolUse = false
    currentHasUserText = false
    currentHasToolResult = false
    currentToolRoundInvalid = false
    previousGroupClosedWithAnsweredToolUseBatch = closedWithAnsweredToolUseBatch
  }

  messages.forEach((message, index) => {
    current.push(message)

    const toolUseIds = collectToolUseIds(message)
    const toolResultIds = collectToolResultIds(message)
    const nextMessage = messages[index + 1]
    const nextMessageToolUseIds = nextMessage ? collectToolUseIds(nextMessage) : []

    if (message.role === 'assistant') {
      currentHasAssistant = true
      if (toolUseIds.length > 0) currentHasToolUse = true
      for (const id of toolUseIds) {
        currentToolUseIds.add(id)
        pendingToolUseIds.add(id)
      }
    }

    if (message.role === 'user') {
      if (toolResultIds.length > 0) {
        currentHasToolResult = true
      }

      if (typeof message.content === 'string') {
        currentHasUserText = currentHasUserText || message.content.trim().length > 0
      } else if (message.content.some((block) => block.type !== 'tool_result')) {
        currentHasUserText = true
      }
    }

    let canCloseAnsweredToolUseBatch = false

    if (message.role === 'user' && toolResultIds.length > 0) {
      let hasUnknownToolUseId = false
      let hasDuplicateToolResult = false
      const seenInMessage = new Set<string>()

      for (const id of toolResultIds) {
        if (!currentToolUseIds.has(id)) {
          hasUnknownToolUseId = true
          continue
        }

        if (seenInMessage.has(id) || answeredToolUseIds.has(id)) {
          hasDuplicateToolResult = true
          continue
        }

        seenInMessage.add(id)
        answeredToolUseIds.add(id)
        pendingToolUseIds.delete(id)
      }

      if (hasUnknownToolUseId || hasDuplicateToolResult) {
        currentToolRoundInvalid = true
      }

      canCloseAnsweredToolUseBatch =
        !currentToolRoundInvalid && currentHasAssistant && currentHasToolUse && pendingToolUseIds.size === 0
    }

    const nextAssistantContinuesPlainAssistantSegment =
      nextMessage?.role === 'assistant' && nextMessageToolUseIds.length === 0

    const assistantWithoutToolsClosedRound =
      message.role === 'assistant' &&
      toolUseIds.length === 0 &&
      pendingToolUseIds.size === 0 &&
      !nextAssistantContinuesPlainAssistantSegment &&
      (currentHasUserText || currentHasToolResult || previousGroupClosedWithAnsweredToolUseBatch)
    const answeredToolUseBatchClosedRound =
      message.role === 'user' && toolResultIds.length > 0 && canCloseAnsweredToolUseBatch

    if (assistantWithoutToolsClosedRound) {
      flush(index + 1)
      return
    }

    if (answeredToolUseBatchClosedRound) {
      flush(index + 1, true)
    }
  })

  flush(messages.length)
  return groups
}
