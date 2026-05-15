import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContentBlock, ToolResultContent, UnifiedMessage } from '../../api/types'

vi.mock('@renderer/locales', () => ({
  default: {
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'contextCompression.summaryMessage') return String(options?.summary ?? '')
      if (key === 'contextCompression.clearedToolResult') return '[cleared tool result]'
      if (key === 'contextCompression.clearedThinking') return '[cleared thinking]'
      if (key === 'contextCompression.systemPrompt') return 'Summarize context'
      if (key === 'contextCompression.emptyResultError') return 'empty summary'
      return key
    }
  }
}))

vi.mock('@renderer/lib/ipc/agent-bridge', () => ({
  runSidecarTextRequest: vi.fn()
}))

vi.mock('@renderer/lib/api/responses-session-policy', () => ({
  RESPONSES_SESSION_SCOPE_CONTEXT_COMPRESSION: false
}))

import { groupMessagesByApiRound } from '../context-budget'
import {
  mergeCompressedMessagesIntoConversation,
  truncateHeadForPromptTooLongRetry
} from '../context-compression'
import { compactToolResultForContext } from '../context-payload-compaction'
import { formatPostCompactStateContext } from '../context-state-format'

let nextMessageId = 0

beforeEach(() => {
  nextMessageId = 0
})

function message(role: UnifiedMessage['role'], content: UnifiedMessage['content']): UnifiedMessage {
  nextMessageId += 1
  return {
    id: `m-${nextMessageId}`,
    role,
    content,
    createdAt: nextMessageId
  }
}

function toolUse(id: string, name = 'Read'): ContentBlock {
  return { type: 'tool_use', id, name, input: {} }
}

function toolResult(id: string, content: ToolResultContent = 'ok'): ContentBlock {
  return { type: 'tool_result', toolUseId: id, content }
}

function serializeToolResultContent(content: ToolResultContent): string {
  return typeof content === 'string' ? content : JSON.stringify(content)
}

describe('groupMessagesByApiRound', () => {
  it('keeps assistant tool_use and matching user tool_result in one round', () => {
    const messages = [
      message('user', 'inspect files'),
      message('assistant', [toolUse('a')]),
      message('user', [toolResult('a')]),
      message('assistant', [toolUse('b')]),
      message('user', [toolResult('b')]),
      message('assistant', 'done')
    ]

    const groups = groupMessagesByApiRound(messages)

    expect(groups.map((group) => group.messages.map((item) => item.id))).toEqual([
      ['m-1', 'm-2', 'm-3'],
      ['m-4', 'm-5'],
      ['m-6']
    ])
  })

  it('does not close a tool round on ordinary user text before tool_result', () => {
    const messages = [
      message('user', 'inspect files'),
      message('assistant', [toolUse('a')]),
      message('user', 'queued note before result'),
      message('user', [toolResult('a')])
    ]

    const groups = groupMessagesByApiRound(messages)

    expect(groups).toHaveLength(1)
    expect(groups[0]?.messages.map((item) => item.id)).toEqual(['m-1', 'm-2', 'm-3', 'm-4'])
  })
})

describe('compactToolResultForContext', () => {
  it('reports both text truncation and image omission for mixed tool content', () => {
    const result = compactToolResultForContext({
      toolName: 'Read',
      maxChars: 1_200,
      content: [
        { type: 'text', text: `error line\n${'x'.repeat(5_000)}` },
        { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }
      ]
    })

    expect(result.info.compacted).toBe(true)
    expect(result.info.reasons).toEqual(['tool_result_too_large', 'image_payload_omitted'])
    expect(serializeToolResultContent(result.content)).toContain(
      'Tool result compacted for context budget'
    )
    expect(serializeToolResultContent(result.content)).toContain('image omitted')
  })

  it('redacts sensitive tool result text even when the payload is below the size limit', () => {
    const result = compactToolResultForContext({
      toolName: 'Read',
      maxChars: 2_000,
      content: 'Authorization: Bearer replay-secret-token\napi_key=sk-replay-secret'
    })

    const serialized = serializeToolResultContent(result.content)

    expect(result.info.compacted).toBe(true)
    expect(result.info.reasons).toEqual(['sensitive_payload_redacted'])
    expect(serialized).toContain('[REDACTED')
    expect(serialized).not.toContain('replay-secret-token')
    expect(serialized).not.toContain('sk-replay-secret')
  })
})

describe('formatPostCompactStateContext', () => {
  it('formats working state without renderer store dependencies', () => {
    const text = formatPostCompactStateContext({
      title: 'Current state',
      workingFolder: 'C:/projects/OpenCowork',
      currentPlan: { title: 'Compression plan', status: 'in_progress' },
      activeTasks: [
        { id: 'task-1', subject: 'Implement compaction', status: 'in_progress' }
      ],
      recentlyReadFiles: [
        { filePath: 'src/renderer/src/lib/agent/agent-loop.ts', timestamp: 0 }
      ]
    })

    expect(text).toContain('## Current state')
    expect(text).toContain('Working folder: C:/projects/OpenCowork')
    expect(text).toContain('task-1: Implement compaction [in_progress]')
    expect(text).toContain('agent-loop.ts')
  })

  it('does not throw when read-file timestamps are invalid', () => {
    const text = formatPostCompactStateContext({
      title: 'Current state',
      recentlyReadFiles: [{ filePath: 'broken.ts', timestamp: Number.NaN }]
    })

    expect(text).toContain('broken.ts (invalid-timestamp)')
  })
})

describe('truncateHeadForPromptTooLongRetry', () => {
  it('drops whole API-round groups and prepends a marker before assistant-leading kept text', () => {
    const messages = [
      message('assistant', [toolUse('a')]),
      message('user', [toolResult('a')]),
      message('assistant', [toolUse('b')]),
      message('user', [toolResult('b')]),
      message('assistant', 'final answer')
    ]

    const retried = truncateHeadForPromptTooLongRetry(messages, 1)

    expect(retried).not.toBeNull()
    expect(retried?.[0]?.role).toBe('user')
    expect(String(retried?.[0]?.content)).toContain('Earlier messages were dropped')
    expect(retried?.[1]?.role).toBe('assistant')
    expect(retried?.some((item) => item.id === 'm-1')).toBe(false)
    expect(retried?.some((item) => item.id === 'm-2')).toBe(false)
  })
})

describe('mergeCompressedMessagesIntoConversation', () => {
  it('skips post-compact state when deriving a fallback preserved head', () => {
    const currentMessages: UnifiedMessage[] = [
      { id: 'old', role: 'user', content: 'old message', createdAt: 1 },
      { id: 'preserved', role: 'user', content: 'current tail', createdAt: 2 },
      { id: 'live', role: 'assistant', content: 'live response', createdAt: 3 }
    ]
    const compressedMessages: UnifiedMessage[] = [
      {
        id: 'boundary',
        role: 'system',
        content: 'Conversation compacted',
        createdAt: 4,
        meta: {
          compactBoundary: {
            trigger: 'auto',
            preTokens: 10,
            messagesSummarized: 2
          }
        }
      },
      {
        id: 'summary',
        role: 'user',
        content: 'summary',
        createdAt: 5,
        meta: { compactSummary: { messagesSummarized: 2, recentMessagesPreserved: true } }
      },
      {
        id: 'state',
        role: 'user',
        content: 'post compact state',
        createdAt: 6,
        meta: { postCompactState: true }
      },
      { id: 'preserved', role: 'user', content: 'current tail', createdAt: 2 }
    ]

    const merged = mergeCompressedMessagesIntoConversation(currentMessages, compressedMessages)

    expect(merged?.map((item) => item.id)).toEqual([
      'boundary',
      'summary',
      'state',
      'preserved',
      'live'
    ])
  })
})
