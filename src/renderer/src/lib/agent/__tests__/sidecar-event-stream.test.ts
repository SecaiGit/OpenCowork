import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStreamEvent } from '../../../../../shared/agent-stream-protocol'
import type { AgentEvent } from '../types'
import { createSidecarEventStream } from '../sidecar-event-stream'

let sidecarStreamEvents: Array<AgentStreamEvent | { delayMs: number; event: AgentStreamEvent }> = []

vi.mock('@renderer/lib/ipc/agent-bridge', () => ({
  agentBridge: {
    cancelAgent: vi.fn(async () => ({ cancelled: true })),
    runAgent: vi.fn(async () => ({ started: true, runId: 'sidecar-run-1' }))
  }
}))

vi.mock('@renderer/lib/ipc/agent-stream-receiver', () => ({
  agentStream: {
    subscribeAll: vi.fn(
      (handler: (runId: string, sessionId: string, event: AgentStreamEvent) => void) => {
        queueMicrotask(() => {
          for (const item of sidecarStreamEvents) {
            if ('event' in item) {
              setTimeout(() => handler('sidecar-run-1', 'session-1', item.event), item.delayMs)
            } else {
              handler('sidecar-run-1', 'session-1', item)
            }
          }
        })
        return vi.fn()
      }
    )
  }
}))

vi.mock('@renderer/lib/agent/sub-agents/events', () => ({
  subAgentEvents: { emit: vi.fn() }
}))

describe('createSidecarEventStream', () => {
  beforeEach(() => {
    sidecarStreamEvents = []
    vi.clearAllMocks()
  })

  it('captures delayed loop_end messages after error before finishing', async () => {
    vi.useFakeTimers()
    try {
      const events: AgentEvent[] = []
      sidecarStreamEvents = [
        {
          type: 'error',
          message: 'context gate blocked model request',
          errorType: 'hard_context_limit_exceeded'
        },
        {
          delayMs: 50,
          event: {
            type: 'loop_end',
            reason: 'error',
            messages: [
              {
                id: 'm-final',
                role: 'user',
                content: 'final transcript',
                createdAt: 1
              }
            ]
          }
        }
      ]

      const streamPromise = (async () => {
        for await (const event of createSidecarEventStream({
          sessionId: 'session-1',
          sidecarRequest: {},
          firstProgressTimeoutMs: 1_000,
          errorLoopEndTimeoutMs: 5_000
        })) {
          events.push(event)
        }
      })()

      await vi.advanceTimersByTimeAsync(50)
      await streamPromise

      expect(events.map((event) => event.type)).toEqual(['error', 'loop_end'])
      expect(events.at(-1)).toMatchObject({
        type: 'loop_end',
        reason: 'error',
        messages: [expect.objectContaining({ id: 'm-final' })]
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
