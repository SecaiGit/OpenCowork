import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => 'C:/tmp/opencowork-test'),
    isPackaged: false
  }
}))

vi.mock('../context-compression-runtime', () => ({
  maybeCompactMainRuntimeContext: vi.fn(async ({ messages }) => ({
    messages,
    compressed: false,
    blocked: true,
    reason: 'hard_context_limit_exceeded',
    events: [
      {
        type: 'context_compression_blocked',
        reason: 'hard_context_limit_exceeded',
        inputTokens: 2_000,
        contextLength: 1_000,
        reservedOutputTokens: 200
      }
    ]
  }))
}))

import { runInteractiveAgentLoop } from '../cron-agent-background'

describe('main interactive agent loop compression preflight', () => {
  it('stops before a provider request when shared compression preflight blocks', async () => {
    const abortController = new AbortController()
    const events: Array<{ type?: string; errorType?: string }> = []
    const messages: Parameters<typeof runInteractiveAgentLoop>[0] = [
      {
        id: 'm-1',
        role: 'user',
        content: 'continue the task',
        createdAt: 1
      }
    ]

    for await (const event of runInteractiveAgentLoop(
      messages,
      {
        maxIterations: 1,
        provider: {
          type: 'openai-chat',
          apiKey: 'test-key',
          model: 'test-model',
          baseUrl: 'http://127.0.0.1:1'
        },
        tools: [],
        signal: abortController.signal,
        contextCompression: {
          config: {
            enabled: true,
            contextLength: 1_000,
            threshold: 0.8,
            strategyId: 'claude-code-compact-v1',
            reservedOutputBudget: 200
          }
        }
      },
      {
        sessionId: 'session-1',
        workingFolder: 'C:/projects/OpenCowork',
        signal: abortController.signal
      }
    )) {
      events.push(event)
      if (event.type === 'iteration_start') {
        abortController.abort()
        break
      }
    }

    expect(events.some((event) => event.type === 'iteration_start')).toBe(false)
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'error',
          errorType: 'hard_context_limit_exceeded'
        }),
        expect.objectContaining({ type: 'loop_end', reason: 'error' })
      ])
    )
  })
})
