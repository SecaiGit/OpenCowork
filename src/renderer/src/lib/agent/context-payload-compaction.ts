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

function collectImportantLines(text: string): string[] {
  const result: string[] = []

  for (const line of text.split(/\r?\n/)) {
    if (!IMPORTANT_LINE_PATTERN.test(line)) continue
    result.push(line)
    if (result.length >= IMPORTANT_LINE_LIMIT) break
  }

  return result
}

export function compactLongTextForContext(
  text: string,
  args: { toolName: string; maxChars: number; isError?: boolean }
): { text: string; compacted: boolean; keptChars: number } {
  if (text.length <= args.maxChars) {
    return { text, compacted: false, keptChars: text.length }
  }

  const markerBudget = 900
  const bodyBudget = Math.max(MIN_HEAD_CHARS + MIN_TAIL_CHARS, args.maxChars - markerBudget)
  const headChars = Math.max(MIN_HEAD_CHARS, Math.floor(bodyBudget * 0.65))
  const tailChars = Math.max(MIN_TAIL_CHARS, bodyBudget - headChars)
  const head = text.slice(0, headChars).trimEnd()
  const tail = text.slice(-tailChars).trimStart()
  const importantLines = collectImportantLines(text)
  const importantSection = importantLines.length
    ? `\n\n## Important lines preserved\n${importantLines.join('\n')}`
    : ''
  const omittedChars = Math.max(0, text.length - head.length - tail.length)
  const compacted = [
    TOOL_RESULT_COMPACTED_MARKER,
    `Tool: ${args.toolName}`,
    `Original chars: ${text.length}`,
    `Kept chars: ${head.length + tail.length}`,
    `Omitted middle chars: ${omittedChars}`,
    args.isError ? 'Result status: error' : 'Result status: success',
    '',
    '## Head',
    head,
    importantSection,
    '',
    '## Tail',
    tail
  ]
    .filter((part) => part.length > 0)
    .join('\n')

  return { text: compacted, compacted: true, keptChars: compacted.length }
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
        ...(compacted.compacted ? { reasons: ['tool_result_too_large' as const] } : {})
      }
    }
  }

  let changed = false
  let keptChars = 0
  const reasons = new Set<ToolPayloadCompactionReason>()
  const perTextBlockMaxChars = Math.max(1_000, Math.floor(maxChars / Math.max(1, args.content.length)))

  const blocks: Array<Extract<ContentBlock, { type: 'text' | 'image' }>> = args.content.map((block) => {
    if (block.type === 'image') {
      changed = true
      reasons.add('image_payload_omitted')
      keptChars += IMAGE_OMITTED_TEXT.length
      return { type: 'text', text: IMAGE_OMITTED_TEXT }
    }

    const compacted = compactLongTextForContext(block.text, {
      toolName: args.toolName,
      maxChars: perTextBlockMaxChars,
      isError: args.isError
    })

    if (compacted.compacted) {
      changed = true
      reasons.add('tool_result_too_large')
    }

    keptChars += compacted.keptChars
    return { ...block, text: compacted.text }
  })

  return {
    content: blocks,
    info: {
      compacted: changed,
      originalChars,
      keptChars: changed ? keptChars : originalChars,
      ...(changed ? { reasons: [...reasons] } : {})
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
