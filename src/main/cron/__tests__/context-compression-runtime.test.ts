import { describe, expect, it, vi } from 'vitest'
import {
  maybeCompactMainRuntimeContext,
  preCompressMainRuntimeMessages,
  type MainRuntimeCompressionConfig,
  type MainRuntimeContentBlock,
  type MainRuntimeMessage
} from '../context-compression-runtime'

let nextMessageId = 0

function message(role: MainRuntimeMessage['role'], content: MainRuntimeMessage['content']): MainRuntimeMessage {
  nextMessageId += 1
  return { id: `m-${nextMessageId}`, role, content, createdAt: nextMessageId }
}

function toolUse(id: string): MainRuntimeContentBlock {
  return { type: 'tool_use', id, name: 'Read', input: {} }
}

function toolResult(id: string, content = 'ok'): MainRuntimeContentBlock {
  return { type: 'tool_result', toolUseId: id, content }
}

const config: MainRuntimeCompressionConfig = {
  enabled: true,
  contextLength: 200_000,
  threshold: 0.8,
  strategyId: 'claude-code-compact-v1',
  reservedOutputBudget: 20_000
}

describe('main runtime context compression preflight', () => {
  it('does not compact below Claude auto threshold', async () => {
    const messages = [
      { ...message('user', 'small task'), usage: { inputTokens: 1_000, outputTokens: 0, contextTokens: 1_000 } }
    ]

    const result = await maybeCompactMainRuntimeContext({
      messages,
      config,
      trigger: 'auto',
      postCompactContext: 'state',
      summarize: vi.fn()
    })

    expect(result.compressed).toBe(false)
    expect(result.messages).toBe(messages)
    expect(result.events).toEqual([])
  })

  it('compacts above Claude auto threshold and returns compression events', async () => {
    nextMessageId = 0
    const summarize = vi.fn(async () => '<summary>Continue main runtime work.</summary>')
    const messages = [
      message('user', 'first task'),
      message('assistant', [toolUse('a')]),
      message('user', [toolResult('a', 'api_key=sk-secret')]),
      message('assistant', 'first result'),
      { ...message('user', 'second task'), usage: { inputTokens: 180_000, outputTokens: 0, contextTokens: 180_000 } },
      message('assistant', [toolUse('b')]),
      message('user', [toolResult('b')]),
      message('assistant', 'second result')
    ]

    const result = await maybeCompactMainRuntimeContext({
      messages,
      config,
      trigger: 'auto',
      postCompactContext: '## Current state\n- Main runtime parity',
      summarize,
      now: () => 123,
      createId: (() => {
        let id = 0
        return () => `main-compact-${++id}`
      })()
    })

    expect(result.compressed).toBe(true)
    expect(result.messages[0]?.meta?.compactBoundary).toMatchObject({
      strategy: 'claude-code-compact-v1',
      trigger: 'auto',
      preTokens: 180_000
    })
    expect(result.events).toEqual([
      { type: 'context_compression_start' },
      {
        type: 'context_compressed',
        originalCount: 8,
        newCount: result.messages.length,
        messages: result.messages
      }
    ])
    const compressedEvent = result.events.find((event) => event.type === 'context_compressed')
    expect(compressedEvent && 'messages' in compressedEvent ? compressedEvent.messages[0]?.meta : null).toMatchObject({
      compactBoundary: {
        strategy: 'claude-code-compact-v1',
        trigger: 'auto'
      }
    })
    expect(JSON.stringify(summarize.mock.calls[0])).not.toContain('sk-secret')
  })

  it('pre-compresses recent large tool result payloads without calling the model', () => {
    const large = 'x'.repeat(50_000)
    const messages = [message('assistant', [toolUse('large')]), message('user', [toolResult('large', large)])]

    const result = preCompressMainRuntimeMessages(messages, config)

    expect(JSON.stringify(result.messages)).toContain('[Tool result compacted for context budget]')
    expect(JSON.stringify(result.messages).length).toBeLessThan(JSON.stringify(messages).length)
    expect(result.compactedCount).toBe(1)
  })
})
