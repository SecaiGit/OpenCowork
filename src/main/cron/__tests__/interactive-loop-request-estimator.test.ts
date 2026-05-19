import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => 'C:/tmp/opencowork-test'),
    isPackaged: false
  }
}))

import { runInteractiveAgentLoop } from '../cron-agent-background'

function baseMessages(): Parameters<typeof runInteractiveAgentLoop>[0] {
  return [
    {
      id: 'm-1',
      role: 'user',
      content: 'continue the task',
      createdAt: 1
    }
  ]
}

function compressionConfig(): NonNullable<
  Parameters<typeof runInteractiveAgentLoop>[1]['contextCompression']
> {
  return {
    config: {
      enabled: true,
      contextLength: 1_000,
      threshold: 0.8,
      strategyId: 'claude-code-compact-v1',
      reservedOutputBudget: 200
    }
  }
}

describe('main interactive agent loop request estimator', () => {
  it('counts OpenAI Chat requestOverrides.body when gating the next provider request', async () => {
    const abortController = new AbortController()
    const events: Array<{ type?: string; errorType?: string; reason?: string; error?: Error }> = []

    for await (const event of runInteractiveAgentLoop(
      baseMessages(),
      {
        maxIterations: 1,
        provider: {
          type: 'openai-chat',
          apiKey: 'test-key',
          model: 'test-model',
          baseUrl: 'http://127.0.0.1:1',
          requestOverrides: {
            body: {
              extra_context: 'large override body\n'.repeat(1_000)
            }
          }
        },
        tools: [],
        signal: abortController.signal,
        contextCompression: compressionConfig()
      },
      {
        sessionId: 'session-1',
        workingFolder: 'C:/projects/OpenCowork',
        signal: abortController.signal
      }
    )) {
      events.push(event)
      if (event.type === 'iteration_start') break
    }

    expect(events.some((event) => event.type === 'iteration_start')).toBe(false)
    const errorEvent = events.find((event) => event.type === 'error')
    expect(errorEvent).toMatchObject({
      type: 'error',
      errorType: 'hard_context_limit_exceeded',
      error: expect.objectContaining({
        message: expect.stringContaining('Context gate blocked model request')
      })
    })
    expect(errorEvent?.error?.message ?? '').toEqual(expect.stringContaining('input='))
    expect(errorEvent?.error?.message ?? '').toEqual(expect.stringContaining('context='))
    expect(errorEvent?.error?.message ?? '').toEqual(expect.stringContaining('reservedOutput='))
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

  it('counts OpenAI Responses thinking body params when gating the next provider request', async () => {
    const abortController = new AbortController()
    const events: Array<{ type?: string; errorType?: string; reason?: string }> = []

    for await (const event of runInteractiveAgentLoop(
      baseMessages(),
      {
        maxIterations: 1,
        provider: {
          type: 'openai-responses',
          apiKey: 'test-key',
          model: 'test-model',
          baseUrl: 'http://127.0.0.1:1',
          thinkingEnabled: true,
          thinkingConfig: {
            bodyParams: {
              reasoning: {
                detail: 'large reasoning body\n'.repeat(1_000)
              }
            },
            reasoningEffortLevels: ['medium'],
            defaultReasoningEffort: 'medium'
          },
          reasoningEffort: 'medium'
        },
        tools: [],
        signal: abortController.signal,
        contextCompression: compressionConfig()
      },
      {
        sessionId: 'session-1',
        workingFolder: 'C:/projects/OpenCowork',
        signal: abortController.signal
      }
    )) {
      events.push(event)
      if (event.type === 'iteration_start') break
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
