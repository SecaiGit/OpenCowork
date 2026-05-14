import type { ContentBlock, ToolResultContent, UnifiedMessage } from '../api/types'
import type { CompressionConfig } from './context-compression'
import { estimateToolResultChars, getLargeToolResultCharLimit } from './context-budget'

const MIN_HEAD_CHARS = 2_000
const MIN_TAIL_CHARS = 1_000
const IMPORTANT_LINE_LIMIT = 80
const IMPORTANT_LINE_PATTERN =
  /\b(error|failed|failure|exception|traceback|panic|fatal|denied|timeout|warning|warn)\b/i
const TOOL_RESULT_COMPACTED_MARKER = '[Tool result compacted for context budget]'
const IMAGE_OMITTED_TEXT = '[image omitted from long-task context payload]'

export type ToolPayloadCompactionReason = 'tool_result_too_large' | 'image_payload_omitted'

export interface ToolPayloadCompactionInfo {
  compacted: boolean
  originalChars: number
  keptChars: number
  reasons?: ToolPayloadCompactionReason[]
}

export interface CompactToolResultArgs {
  toolName: string
  content: ToolResultContent
  isError?: boolean
  config?: CompressionConfig | null
  maxChars?: number
}

export interface CompactToolResultResult {
  content: ToolResultContent
  info: ToolPayloadCompactionInfo
}

function collectImportantLines(text: string, limit = IMPORTANT_LINE_LIMIT): string[] {
  const result: string[] = []

  for (const line of text.split(/\r?\n/)) {
    if (!IMPORTANT_LINE_PATTERN.test(line)) continue
    result.push(line)
    if (result.length >= limit) break
  }

  return result
}

function getOrderedReasons(flags: {
  toolResultTooLarge?: boolean
  imagePayloadOmitted?: boolean
}): ToolPayloadCompactionReason[] | undefined {
  const reasons: ToolPayloadCompactionReason[] = []

  if (flags.toolResultTooLarge) reasons.push('tool_result_too_large')
  if (flags.imagePayloadOmitted) reasons.push('image_payload_omitted')

  return reasons.length > 0 ? reasons : undefined
}

function buildCompactedText(args: {
  toolName: string
  originalLength: number
  isError?: boolean
  head: string
  tail: string
  importantLines: string[]
}): string {
  const keptBodyChars = args.head.length + args.tail.length
  const omittedChars = Math.max(0, args.originalLength - keptBodyChars)
  const importantSection = args.importantLines.length
    ? `## Important lines preserved\n${args.importantLines.join('\n')}`
    : ''

  return [
    TOOL_RESULT_COMPACTED_MARKER,
    `Tool: ${args.toolName}`,
    `Original chars: ${args.originalLength}`,
    `Kept chars: ${keptBodyChars}`,
    `Omitted middle chars: ${omittedChars}`,
    args.isError ? 'Result status: error' : 'Result status: success',
    '',
    '## Head',
    args.head,
    importantSection,
    '## Tail',
    args.tail
  ]
    .filter((part) => part.length > 0)
    .join('\n')
}

function hardTrimCompactedText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text

  const markerWithNewline = `${TOOL_RESULT_COMPACTED_MARKER}\n`
  if (maxChars <= TOOL_RESULT_COMPACTED_MARKER.length) {
    return TOOL_RESULT_COMPACTED_MARKER.slice(0, maxChars)
  }

  const restBudget = Math.max(0, maxChars - markerWithNewline.length)
  return `${markerWithNewline}${text.slice(markerWithNewline.length, markerWithNewline.length + restBudget)}`
}

export function compactLongTextForContext(
  text: string,
  args: { toolName: string; maxChars: number; isError?: boolean }
): { text: string; compacted: boolean; keptChars: number } {
  if (text.length <= args.maxChars) {
    return { text, compacted: false, keptChars: text.length }
  }

  const safeMaxChars = Math.max(args.maxChars, TOOL_RESULT_COMPACTED_MARKER.length)
  const preferredHeadChars = Math.max(MIN_HEAD_CHARS, Math.floor(safeMaxChars * 0.35))
  const preferredTailChars = Math.max(MIN_TAIL_CHARS, Math.floor(safeMaxChars * 0.2))
  const preferredImportantLines = IMPORTANT_LINE_LIMIT

  const attemptConfigs = [
    {
      headChars: preferredHeadChars,
      tailChars: preferredTailChars,
      importantLineLimit: preferredImportantLines
    },
    {
      headChars: Math.max(600, Math.floor(safeMaxChars * 0.18)),
      tailChars: Math.max(300, Math.floor(safeMaxChars * 0.1)),
      importantLineLimit: Math.min(20, preferredImportantLines)
    },
    {
      headChars: Math.max(200, Math.floor(safeMaxChars * 0.1)),
      tailChars: Math.max(120, Math.floor(safeMaxChars * 0.06)),
      importantLineLimit: Math.min(8, preferredImportantLines)
    },
    {
      headChars: Math.max(80, Math.floor(safeMaxChars * 0.05)),
      tailChars: Math.max(40, Math.floor(safeMaxChars * 0.03)),
      importantLineLimit: Math.min(3, preferredImportantLines)
    },
    {
      headChars: Math.max(24, Math.floor(safeMaxChars * 0.02)),
      tailChars: Math.max(12, Math.floor(safeMaxChars * 0.01)),
      importantLineLimit: 0
    }
  ]

  for (const attempt of attemptConfigs) {
    const head = text.slice(0, Math.min(text.length, attempt.headChars)).trimEnd()
    const tail = text.slice(-Math.min(text.length, attempt.tailChars)).trimStart()
    const importantLines = collectImportantLines(text, attempt.importantLineLimit)
    const compacted = buildCompactedText({
      toolName: args.toolName,
      originalLength: text.length,
      isError: args.isError,
      head,
      tail,
      importantLines
    })

    if (compacted.length <= args.maxChars) {
      return { text: compacted, compacted: true, keptChars: compacted.length }
    }
  }

  const minimalCompacted = buildCompactedText({
    toolName: args.toolName,
    originalLength: text.length,
    isError: args.isError,
    head: text.slice(0, Math.min(text.length, 24)).trimEnd(),
    tail: text.slice(-Math.min(text.length, 12)).trimStart(),
    importantLines: []
  })
  const hardTrimmed = hardTrimCompactedText(minimalCompacted, args.maxChars)

  return { text: hardTrimmed, compacted: true, keptChars: hardTrimmed.length }
}

export function compactToolResultForContext(args: CompactToolResultArgs): CompactToolResultResult {
  const maxChars = args.maxChars ?? getLargeToolResultCharLimit(args.config)
  const originalChars = estimateToolResultChars(args.content)

  if (typeof args.content === 'string') {
    const compacted = compactLongTextForContext(args.content, {
      toolName: args.toolName,
      maxChars,
      isError: args.isError
    })

    return {
      content: compacted.text,
      info: {
        compacted: compacted.compacted,
        originalChars,
        keptChars: compacted.keptChars,
        ...(compacted.compacted
          ? { reasons: getOrderedReasons({ toolResultTooLarge: true }) }
          : {})
      }
    }
  }

  if (originalChars <= maxChars) {
    return {
      content: args.content,
      info: {
        compacted: false,
        originalChars,
        keptChars: originalChars
      }
    }
  }

  const imageCount = args.content.filter((block) => block.type === 'image').length
  const textBlocks = args.content.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
  const textOriginalChars = textBlocks.reduce((sum, block) => sum + block.text.length, 0)
  const imagePlaceholderChars = imageCount * IMAGE_OMITTED_TEXT.length
  const remainingTextBudget = Math.max(0, maxChars - imagePlaceholderChars)

  let changed = imageCount > 0
  let keptChars = 0
  let toolResultTooLarge = false
  let imagePayloadOmitted = imageCount > 0

  const oversizedTextBlocks = textBlocks.filter((block) => block.text.length > remainingTextBudget)
  const textBudgetDenominator = oversizedTextBlocks.length > 0
    ? oversizedTextBlocks.reduce((sum, block) => sum + block.text.length, 0)
    : Math.max(1, textOriginalChars)
  let textBudgetRemaining = remainingTextBudget
  let oversizedTextRemaining = oversizedTextBlocks.length > 0
    ? oversizedTextBlocks.reduce((sum, block) => sum + block.text.length, 0)
    : 0

  const blocks: Array<Extract<ContentBlock, { type: 'text' | 'image' }>> = args.content.map((block) => {
    if (block.type === 'image') {
      keptChars += IMAGE_OMITTED_TEXT.length
      return { type: 'text', text: IMAGE_OMITTED_TEXT }
    }

    const shouldProportionByOversized = oversizedTextBlocks.length > 0 && block.text.length > remainingTextBudget
    const proportionalBase = shouldProportionByOversized
      ? Math.max(1, oversizedTextRemaining)
      : Math.max(1, textBudgetDenominator)
    const requestedBudget = shouldProportionByOversized
      ? Math.floor((textBudgetRemaining * block.text.length) / proportionalBase)
      : Math.floor((remainingTextBudget * block.text.length) / proportionalBase)
    const blockBudget = Math.max(1, Math.min(textBudgetRemaining, requestedBudget || block.text.length))
    const compacted = compactLongTextForContext(block.text, {
      toolName: args.toolName,
      maxChars: blockBudget,
      isError: args.isError
    })

    if (compacted.compacted) {
      changed = true
      toolResultTooLarge = true
    }

    keptChars += compacted.keptChars
    textBudgetRemaining = Math.max(0, textBudgetRemaining - compacted.keptChars)
    if (shouldProportionByOversized) {
      oversizedTextRemaining = Math.max(0, oversizedTextRemaining - block.text.length)
    }

    return { ...block, text: compacted.text }
  })

  return {
    content: blocks,
    info: {
      compacted: changed,
      originalChars,
      keptChars: changed ? keptChars : originalChars,
      ...(changed
        ? {
            reasons: getOrderedReasons({
              toolResultTooLarge,
              imagePayloadOmitted
            })
          }
        : {})
    }
  }
}

function buildToolNameByResultId(messages: UnifiedMessage[]): Map<string, string> {
  const result = new Map<string, string>()

  for (const message of messages) {
    if (!Array.isArray(message.content)) continue

    for (const block of message.content) {
      if (block.type === 'tool_use') {
        result.set(block.id, block.name)
      }
    }
  }

  return result
}

export function compactRecentToolPayloads(
  messages: UnifiedMessage[],
  config?: CompressionConfig | null
): { messages: UnifiedMessage[]; compactedCount: number } {
  let compactedCount = 0
  const toolNameByResultId = buildToolNameByResultId(messages)

  const next = messages.map((message) => {
    if (!Array.isArray(message.content)) return message

    let changed = false
    const content: ContentBlock[] = message.content.map((block) => {
      if (block.type !== 'tool_result') return block

      const compacted = compactToolResultForContext({
        toolName: toolNameByResultId.get(block.toolUseId) ?? 'unknown',
        content: block.content,
        isError: block.isError,
        config
      })

      if (!compacted.info.compacted) return block

      changed = true
      compactedCount += 1
      return { ...block, content: compacted.content }
    })

    return changed ? { ...message, content } : message
  })

  return { messages: next, compactedCount }
}
