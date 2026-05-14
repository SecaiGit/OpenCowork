import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContentBlock, ProviderConfig, ToolResultContent, UnifiedMessage } from '../../api/types'

vi.mock('@renderer/locales', () => ({
  default: {
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'contextCompression.summaryMessage') return String(options?.summary ?? '')
      if (key === 'contextCompression.clearedToolResult') return '[cleared tool result]'
      if (key === 'contextCompression.clearedThinking') return '[cleared thinking]'
      if (key === 'contextCompression.imageAttachment') return '[Image attachment]'
      if (key === 'contextCompression.emptyResultError') return 'empty summary'
      if (key === 'contextCompression.postCompactStateTitle') return 'Current working state after compaction'
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

import {
  CONTEXT_COMPRESSION_STRATEGY_IDS,
  isContextCompressionStrategyId,
  resolveCompressionStrategyId
} from '../context-compression-config'
import {
  CLAUDE_COMPACT_AUTO_BUFFER_TOKENS,
  CLAUDE_COMPACT_RESERVED_OUTPUT_CAP,
  getClaudeCompactBudget
} from '../claude-compact-budget'
import { selectClaudeCompactRanges } from '../claude-compact-rounds'
import { validateToolUseResultProtocol } from '../context-budget'

let nextMessageId = 0

beforeEach(() => {
  nextMessageId = 0
  vi.clearAllMocks()
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

const providerConfig: ProviderConfig = {
  type: 'openai-chat',
  apiKey: 'test-key',
  model: 'test-model'
}

void message
void toolUse
void toolResult
void providerConfig

describe('claude-code-compact-v1 registration', () => {
  it('accepts the Claude Code style strategy id', () => {
    expect(CONTEXT_COMPRESSION_STRATEGY_IDS).toContain('claude-code-compact-v1')
    expect(isContextCompressionStrategyId('claude-code-compact-v1')).toBe(true)
    expect(resolveCompressionStrategyId('claude-code-compact-v1')).toBe('claude-code-compact-v1')
  })
})

describe('getClaudeCompactBudget', () => {
  it('uses model context minus min(reserved output budget, 20000), then subtracts the 13000 auto buffer', () => {
    expect(
      getClaudeCompactBudget({
        contextLength: 200_000,
        reservedOutputBudget: 32_000
      })
    ).toEqual({
      contextLength: 200_000,
      reservedOutputTokens: CLAUDE_COMPACT_RESERVED_OUTPUT_CAP,
      effectiveContextWindow: 180_000,
      autoCompactThreshold: 167_000,
      autoBufferTokens: CLAUDE_COMPACT_AUTO_BUFFER_TOKENS
    })
  })

  it('uses smaller reserved output budget when below 20000', () => {
    expect(
      getClaudeCompactBudget({
        contextLength: 64_000,
        reservedOutputBudget: 8_192
      })
    ).toMatchObject({
      reservedOutputTokens: 8_192,
      effectiveContextWindow: 55_808,
      autoCompactThreshold: 42_808
    })
  })

  it('never returns negative thresholds for small test models', () => {
    expect(
      getClaudeCompactBudget({
        contextLength: 4_096,
        reservedOutputBudget: 8_192
      })
    ).toMatchObject({
      effectiveContextWindow: 1,
      autoCompactThreshold: 1
    })
  })
})

describe('selectClaudeCompactRanges', () => {
  it('preserves the most recent complete API round and compresses only older complete rounds', () => {
    const messages = [
      message('user', 'first task'),
      message('assistant', [toolUse('a')]),
      message('user', [toolResult('a')]),
      message('assistant', 'first result'),
      message('user', 'second task'),
      message('assistant', [toolUse('b')]),
      message('user', [toolResult('b')]),
      message('assistant', 'second result')
    ]

    const selection = selectClaudeCompactRanges(messages, { minMessages: 4, preservedRoundCount: 1 })

    expect(selection.ok).toBe(true)
    expect(selection.compressibleMessages.map((item) => item.id)).toEqual(['m-1', 'm-2', 'm-3', 'm-4'])
    expect(selection.preservedMessages.map((item) => item.id)).toEqual(['m-5', 'm-6', 'm-7', 'm-8'])
    expect(selection.compressedRange).toEqual({ start: 0, end: 4 })
    expect(selection.preservedRange).toEqual({ start: 4, end: 8 })
    expect(validateToolUseResultProtocol(selection.preservedMessages).valid).toBe(true)
  })

  it('refuses to compact when the preserved tail would start with an orphaned tool result', () => {
    const messages = [
      message('user', 'first task'),
      message('assistant', 'first result'),
      message('user', [toolResult('orphan')]),
      message('assistant', 'tail')
    ]

    const selection = selectClaudeCompactRanges(messages, { minMessages: 4, preservedRoundCount: 1 })

    expect(selection.ok).toBe(false)
    expect(selection.reason).toBe('unsafe_boundary')
    expect(selection.compressibleMessages).toEqual([])
    expect(selection.preservedMessages).toEqual(messages)
  })

  it('keeps an unanswered tool_use inside the preserved tail instead of splitting it into the summary span', () => {
    const messages = [
      message('user', 'first task'),
      message('assistant', 'first result'),
      message('user', 'inspect file'),
      message('assistant', [toolUse('pending')])
    ]

    const selection = selectClaudeCompactRanges(messages, { minMessages: 4, preservedRoundCount: 1 })

    expect(selection.ok).toBe(true)
    expect(selection.compressibleMessages.map((item) => item.id)).toEqual(['m-1', 'm-2'])
    expect(selection.preservedMessages.map((item) => item.id)).toEqual(['m-3', 'm-4'])
    expect(validateToolUseResultProtocol(selection.preservedMessages).issues.map((issue) => issue.kind)).toEqual([
      'unanswered_tool_use'
    ])
  })
})
