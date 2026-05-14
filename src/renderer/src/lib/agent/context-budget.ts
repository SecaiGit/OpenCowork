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

export function groupMessagesByApiRound(messages: UnifiedMessage[]): ApiRoundGroup[] {
  const groups: ApiRoundGroup[] = []
  let start = 0
  let current: UnifiedMessage[] = []
  let currentToolUseIds = new Set<string>()
  let pendingToolUseIds = new Set<string>()
  let answeredToolUseIds = new Set<string>()
  let currentHasAssistant = false
  let currentHasToolUse = false
  let currentToolRoundInvalid = false

  const flush = (end: number): void => {
    if (current.length === 0) return

    groups.push({ start, end, messages: current })
    start = end
    current = []
    currentToolUseIds = new Set<string>()
    pendingToolUseIds = new Set<string>()
    answeredToolUseIds = new Set<string>()
    currentHasAssistant = false
    currentHasToolUse = false
    currentToolRoundInvalid = false
  }

  messages.forEach((message, index) => {
    current.push(message)

    const toolUseIds = collectToolUseIds(message)
    const toolResultIds = collectToolResultIds(message)

    if (message.role === 'assistant') {
      currentHasAssistant = true
      if (toolUseIds.length > 0) currentHasToolUse = true
      for (const id of toolUseIds) {
        currentToolUseIds.add(id)
        pendingToolUseIds.add(id)
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

    const assistantWithoutToolsClosedRound =
      message.role === 'assistant' && toolUseIds.length === 0 && pendingToolUseIds.size === 0
    const answeredToolUseBatchClosedRound =
      message.role === 'user' && toolResultIds.length > 0 && canCloseAnsweredToolUseBatch

    if (assistantWithoutToolsClosedRound || answeredToolUseBatchClosedRound) {
      flush(index + 1)
    }
  })

  flush(messages.length)
  return groups
}
