export interface ClaudeContextMessageLike {
  role: string
  content: unknown
  source?: string | null
  meta?: Record<string, unknown> | null
}

const LEGACY_COMPACT_SUMMARY_PREFIXES = [
  '[Context Memory Compressed Summary]',
  '[\u4e0a\u4e0b\u6587\u8bb0\u5fc6\u538b\u7f29\u6458\u8981]',
  '[Context Memory Compressed Summary'
]

export function isLegacyClaudeCompactSummaryContent(content: unknown): boolean {
  if (typeof content !== 'string') return false
  const trimmed = content.trim()
  return LEGACY_COMPACT_SUMMARY_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
}

export function isGeneratedClaudeContextMessageMeta(
  meta?: Record<string, unknown> | null
): boolean {
  if (!meta) return false
  return (
    meta.contextEmergencyShrink === true ||
    meta.postCompactState === true ||
    !!meta.compactSummary ||
    !!meta.sessionMemoryCompact ||
    (meta.streamingContinuation != null && typeof meta.streamingContinuation === 'object')
  )
}

export function isGeneratedClaudeContextUserMessage(
  message: ClaudeContextMessageLike
): boolean {
  return (
    message.role === 'user' &&
    (isGeneratedClaudeContextMessageMeta(message.meta) ||
      isLegacyClaudeCompactSummaryContent(message.content))
  )
}

function hasNonToolResultContent(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length > 0
  if (!Array.isArray(content)) return false
  return content.some((block) => {
    if (!block || typeof block !== 'object') return true
    return (block as { type?: unknown }).type !== 'tool_result'
  })
}

export function hasUserAuthoredClaudeMessageContent(
  message: ClaudeContextMessageLike
): boolean {
  return (
    message.role === 'user' &&
    message.source !== 'team' &&
    !isGeneratedClaudeContextUserMessage(message) &&
    hasNonToolResultContent(message.content)
  )
}
