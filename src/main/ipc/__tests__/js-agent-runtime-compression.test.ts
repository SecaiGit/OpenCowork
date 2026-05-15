import { beforeEach, describe, expect, it, vi } from 'vitest'
import { JsAgentRuntimeManager } from '../js-agent-runtime'

const capturedLoopConfigs: unknown[] = []

vi.mock('../adaptive-event-batcher', () => ({
  AdaptiveEventBatcher: class {
    setHandler(): void {}
    setSessionVisibility(): void {}
    push(): void {}
    flush(): void {}
    cleanupRun(): void {}
    stop(): void {}
  }
}))

vi.mock('../../cron/cron-agent-background', () => ({
  runInteractiveAgentLoop: vi.fn(async function* (_messages: unknown[], config: unknown) {
    capturedLoopConfigs.push(config)
    yield { type: 'loop_start' }
    yield { type: 'loop_end', reason: 'completed' }
  })
}))

describe('JsAgentRuntimeManager compression forwarding', () => {
  beforeEach(() => {
    capturedLoopConfigs.length = 0
    vi.clearAllMocks()
  })

  it('passes sidecar compression config into the main interactive agent loop', async () => {
    const manager = new JsAgentRuntimeManager()
    manager.setEventHandler(vi.fn())

    await manager.request('agent/run', {
      runId: 'run-1',
      sessionId: 'session-1',
      messages: [{ id: 'm-1', role: 'user', content: 'hello', createdAt: 1 }],
      provider: { type: 'openai-chat', apiKey: 'test-key', model: 'test-model' },
      tools: [],
      maxIterations: 1,
      forceApproval: false,
      compression: {
        enabled: true,
        contextLength: 200_000,
        threshold: 0.8,
        strategyId: 'claude-code-compact-v1',
        reservedOutputBudget: 20_000
      },
      captureFinalMessages: true
    })

    await vi.waitFor(() => expect(capturedLoopConfigs).toHaveLength(1))
    expect(capturedLoopConfigs[0]).toMatchObject({
      contextCompression: {
        config: {
          enabled: true,
          contextLength: 200_000,
          threshold: 0.8,
          strategyId: 'claude-code-compact-v1',
          reservedOutputBudget: 20_000
        }
      }
    })
  })
})
