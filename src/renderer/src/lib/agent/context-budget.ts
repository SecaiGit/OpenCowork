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
const REDACTED_TOKEN = '[REDACTED TOKEN]'
const REDACTED_AUTHORIZATION = '[REDACTED AUTHORIZATION]'
const REDACTED_COOKIE = '[REDACTED COOKIE]'
const REDACTED_PRIVATE_KEY = '[REDACTED PRIVATE KEY]'
const SENSITIVE_KEY_PATTERN =
  '(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|id[_-]?token|token|password|passwd|pwd|secret|client[_-]?secret|session(?:id)?|session[_-]?token)'

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
  | 'duplicate_tool_use'
  | 'tool_use_invalid_role'
  | 'unknown_tool_result'
  | 'duplicate_tool_result'
  | 'tool_result_invalid_role'
  | 'orphaned_tool_result'
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

export interface ToolUseResultProtocolRepair {
  messages: UnifiedMessage[]
  changed: boolean
  issues: ToolUseResultProtocolIssue[]
}

const TOOL_PROTOCOL_RECOVERY_RESULT =
  '[Tool execution interrupted before a result was recorded during context recovery.]'

export function redactTextForModelContext(text: string): string {
  if (!text) return text

  let result = text
  result = result.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    REDACTED_PRIVATE_KEY
  )
  result = result.replace(/\b((?:set-)?cookie\s*:\s*)[^\r\n]+/gi, `$1${REDACTED_COOKIE}`)
  result = result.replace(
    /\b(authorization\s*:\s*)(?:bearer|basic)\s+[^\r\n]+/gi,
    `$1${REDACTED_AUTHORIZATION}`
  )
  result = result.replace(/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED_TOKEN}`)
  result = result.replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, REDACTED_TOKEN)
  result = result.replace(
    new RegExp(`(["'])(${SENSITIVE_KEY_PATTERN})(\\1\\s*:\\s*)(["'])([\\s\\S]{1,512}?)(\\4)`, 'gi'),
    (_match, keyQuote: string, key: string, separator: string, valueQuote: string) =>
      `${keyQuote}${key}${separator}${valueQuote}${REDACTED_VALUE}${valueQuote}`
  )
  result = result.replace(
    new RegExp(`\\b(${SENSITIVE_KEY_PATTERN})(\\s*[:=]\\s*)(["'])([\\s\\S]{1,512}?)(\\3)`, 'gi'),
    (_match, key: string, separator: string, quote: string) =>
      `${key}${separator}${quote}${REDACTED_VALUE}${quote}`
  )
  result = result.replace(
    new RegExp(`\\b(${SENSITIVE_KEY_PATTERN})(\\s*[:=]\\s*)([^"'\\s,;&]{3,})`, 'gi'),
    (_match, key: string, separator: string) => `${key}${separator}${REDACTED_VALUE}`
  )
  result = result.replace(
    new RegExp(`([?&]${SENSITIVE_KEY_PATTERN}=)([^&#\\s]+)`, 'gi'),
    `$1${REDACTED_VALUE}`
  )

  return result
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
  const seenToolUseIds = new Set<string>()
  const pendingToolUseIds = new Set<string>()
  const answeredToolUseIds = new Set<string>()

  messages.forEach((message, messageIndex) => {
    const toolUseIds = collectToolUseIds(message)
    const toolResultIds = collectToolResultIds(message)

    if (toolUseIds.length > 0 && message.role !== 'assistant') {
      for (const toolUseId of toolUseIds) {
        issues.push({ kind: 'tool_use_invalid_role', messageIndex, toolUseId })
      }
    }

    if (toolResultIds.length > 0 && message.role !== 'user') {
      for (const toolUseId of toolResultIds) {
        issues.push({ kind: 'tool_result_invalid_role', messageIndex, toolUseId })
      }
    }

    if (message.role === 'assistant') {
      if (pendingToolUseIds.size > 0 && toolUseIds.length > 0) {
        for (const toolUseId of toolUseIds) {
          issues.push({
            kind: 'assistant_tool_use_after_user_text',
            messageIndex,
            toolUseId
          })
        }
      }

      for (const toolUseId of toolUseIds) {
        if (seenToolUseIds.has(toolUseId)) {
          issues.push({ kind: 'duplicate_tool_use', messageIndex, toolUseId })
          continue
        }

        seenToolUseIds.add(toolUseId)
        pendingToolUseIds.add(toolUseId)
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
    const seenResultIdsInMessage = new Set<string>()

    for (const block of message.content) {
      if (block.type !== 'tool_result') {
        sawNonToolResultContent = true
        continue
      }

      const toolUseId = block.toolUseId

      if (seenResultIdsInMessage.has(toolUseId) || answeredToolUseIds.has(toolUseId)) {
        issues.push({ kind: 'duplicate_tool_result', messageIndex, toolUseId })
        continue
      }

      seenResultIdsInMessage.add(toolUseId)

      if (!pendingToolUseIds.has(toolUseId)) {
        issues.push({ kind: 'unknown_tool_result', messageIndex, toolUseId })
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

function createRecoveredToolResultMessage(
  pendingToolUseIds: Iterable<string>,
  anchor: UnifiedMessage | undefined,
  repairIndex: number
): UnifiedMessage {
  return {
    id: `${anchor?.id ?? 'message'}-tool-repair-${repairIndex}`,
    role: 'user',
    content: [...pendingToolUseIds].map(
      (toolUseId): ContentBlock => ({
        type: 'tool_result',
        toolUseId,
        content: TOOL_PROTOCOL_RECOVERY_RESULT,
        isError: true
      })
    ),
    createdAt: anchor?.createdAt ?? Date.now(),
    meta: { toolProtocolRecovery: true }
  }
}

function textifyInvalidToolBlock(block: ContentBlock, reason: string): ContentBlock {
  if (block.type === 'tool_use') {
    return {
      type: 'text',
      text: `[Recovered invalid tool call ${block.id} (${reason})] ${block.name}: ${redactTextForModelContext(
        JSON.stringify(block.input)
      )}`
    }
  }

  if (block.type === 'tool_result') {
    return {
      type: 'text',
      text: `[Recovered invalid tool result ${block.toolUseId} (${reason})] ${redactTextForModelContext(
        serializeToolResultContent(block.content)
      )}`
    }
  }

  return block
}

export function repairToolUseResultProtocolForReplay(
  messages: UnifiedMessage[]
): ToolUseResultProtocolRepair {
  const issues = validateToolUseResultProtocol(messages).issues
  if (issues.length === 0) return { messages, changed: false, issues }

  const repaired: UnifiedMessage[] = []
  const seenToolUseIds = new Set<string>()
  const pendingToolUseIds = new Set<string>()
  const answeredToolUseIds = new Set<string>()
  let changed = false
  let repairIndex = 0

  const appendRecoveredResults = (anchor?: UnifiedMessage): void => {
    if (pendingToolUseIds.size === 0) return

    repairIndex += 1
    repaired.push(createRecoveredToolResultMessage(pendingToolUseIds, anchor, repairIndex))
    for (const toolUseId of pendingToolUseIds) {
      answeredToolUseIds.add(toolUseId)
    }
    pendingToolUseIds.clear()
    changed = true
  }

  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      if (
        pendingToolUseIds.size > 0 &&
        (message.role !== 'user' || message.content.trim().length > 0)
      ) {
        appendRecoveredResults(message)
      }
      repaired.push(message)
      continue
    }

    if (message.role === 'user') {
      const toolResultBlocks: ContentBlock[] = []
      const otherBlocks: ContentBlock[] = []
      const seenResultIdsInMessage = new Set<string>()

      for (const block of message.content) {
        if (block.type === 'tool_use') {
          otherBlocks.push(textifyInvalidToolBlock(block, 'tool_use_invalid_role'))
          changed = true
          continue
        }

        if (block.type !== 'tool_result') {
          otherBlocks.push(block)
          continue
        }

        const toolUseId = block.toolUseId
        if (
          !pendingToolUseIds.has(toolUseId) ||
          seenResultIdsInMessage.has(toolUseId) ||
          answeredToolUseIds.has(toolUseId)
        ) {
          otherBlocks.push(textifyInvalidToolBlock(block, 'unknown_or_duplicate_tool_result'))
          changed = true
          continue
        }

        seenResultIdsInMessage.add(toolUseId)
        pendingToolUseIds.delete(toolUseId)
        answeredToolUseIds.add(toolUseId)
        toolResultBlocks.push(block)
      }

      if (toolResultBlocks.length > 0) {
        repaired.push(
          toolResultBlocks.length === message.content.length
            ? message
            : { ...message, content: toolResultBlocks }
        )
        if (toolResultBlocks.length !== message.content.length) changed = true
      }

      if (pendingToolUseIds.size > 0 && otherBlocks.length > 0) {
        appendRecoveredResults(message)
      }

      if (otherBlocks.length > 0) {
        repaired.push(
          toolResultBlocks.length > 0
            ? { ...message, id: `${message.id}-tool-repair-tail-${++repairIndex}`, content: otherBlocks }
            : otherBlocks.length === message.content.length
              ? message
              : { ...message, content: otherBlocks }
        )
        if (toolResultBlocks.length > 0 || otherBlocks.length !== message.content.length) {
          changed = true
        }
      } else if (toolResultBlocks.length === 0 && message.content.length === 0) {
        repaired.push(message)
      }

      continue
    }

    if (pendingToolUseIds.size > 0) {
      appendRecoveredResults(message)
    }

    const nextBlocks: ContentBlock[] = []
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        nextBlocks.push(textifyInvalidToolBlock(block, 'tool_result_invalid_role'))
        changed = true
        continue
      }

      if (block.type !== 'tool_use') {
        nextBlocks.push(block)
        continue
      }

      if (message.role !== 'assistant') {
        nextBlocks.push(textifyInvalidToolBlock(block, 'tool_use_invalid_role'))
        changed = true
        continue
      }

      if (seenToolUseIds.has(block.id)) {
        nextBlocks.push(textifyInvalidToolBlock(block, 'duplicate_tool_use'))
        changed = true
        continue
      }

      seenToolUseIds.add(block.id)
      pendingToolUseIds.add(block.id)
      nextBlocks.push(block)
    }

    repaired.push(nextBlocks.length === message.content.length ? message : { ...message, content: nextBlocks })
  }

  appendRecoveredResults(messages[messages.length - 1])

  return {
    messages: changed ? repaired : messages,
    changed,
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
