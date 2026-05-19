import type { MessageMeta, UnifiedMessage } from '../api/types'

const LEGACY_COMPACT_SUMMARY_PREFIXES = [
  '[Context Memory Compressed Summary]',
  '[\u4e0a\u4e0b\u6587\u8bb0\u5fc6\u538b\u7f29\u6458\u8981]',
  '[Context Memory Compressed Summary'
]

export function isGeneratedContextMessageMeta(meta?: MessageMeta | null): boolean {
  if (!meta) return false
  return (
    meta.contextEmergencyShrink === true ||
    meta.postCompactState === true ||
    !!meta.compactSummary ||
    !!meta.sessionMemoryCompact ||
    (meta.streamingContinuation != null && typeof meta.streamingContinuation === 'object')
  )
}

export function isLegacyCompactSummaryContent(content: UnifiedMessage['content']): boolean {
  if (typeof content !== 'string') return false
  const trimmed = content.trim()
  return LEGACY_COMPACT_SUMMARY_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
}

export function isCompactSummaryContextMessage(
  message: Pick<UnifiedMessage, 'role' | 'content' | 'meta'>
): boolean {
  return (
    message.role === 'user' &&
    (!!message.meta?.compactSummary || isLegacyCompactSummaryContent(message.content))
  )
}

export function isGeneratedContextUserMessage(
  message: Pick<UnifiedMessage, 'role' | 'content' | 'meta'>
): boolean {
  return (
    message.role === 'user' &&
    (isGeneratedContextMessageMeta(message.meta) || isLegacyCompactSummaryContent(message.content))
  )
}

function hasUserAuthoredContent(content: UnifiedMessage['content']): boolean {
  if (typeof content === 'string') return content.trim().length > 0
  return content.some((block) => block.type !== 'tool_result')
}

export function isUserAuthoredMessage(
  message: Pick<UnifiedMessage, 'role' | 'content' | 'meta' | 'source'>
): boolean {
  return (
    message.role === 'user' &&
    message.source !== 'team' &&
    !isGeneratedContextUserMessage(message) &&
    hasUserAuthoredContent(message.content)
  )
}
