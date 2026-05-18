import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UnifiedMessage, ProviderConfig, ToolDefinition } from '../../api/types'
import { MessageQueue, type AgentLoopConfig } from '../types'
import { toAgentEvent } from '../stream-event-adapter'

vi.mock('../agent-loop', () => ({
  runAgentLoop: vi.fn(async function* () {
    yield { type: 'loop_start' }
    throw new Error('renderer loop should not run for low-token sidecar compression forwarding')
  })
}))

import { runSharedAgentRuntime } from '../shared-runtime'

const capturedSidecarRequests: unknown[] = []
let sidecarStreamEvents: Array<unknown | { delayMs: number; event: unknown }> = []

vi.mock('@renderer/lib/ipc/agent-bridge', () => ({
  agentBridge: {
    appendAgentMessages: vi.fn(async () => ({ appended: true, count: 0 })),
    cancelAgent: vi.fn(async () => ({ cancelled: true })),
    initialize: vi.fn(async () => true),
    runAgent: vi.fn(async (request: unknown) => {
      capturedSidecarRequests.push(request)
      return { started: true, runId: 'sidecar-run-1' }
    })
  }
}))

vi.mock('@renderer/lib/ipc/agent-stream-receiver', () => ({
  agentStream: {
    subscribeAll: vi.fn((handler: (runId: string, sessionId: string, event: unknown) => void) => {
      queueMicrotask(() => {
        for (const item of sidecarStreamEvents) {
          if (item && typeof item === 'object' && 'event' in item && 'delayMs' in item) {
            setTimeout(
              () => handler('sidecar-run-1', 'session-1', item.event),
              Number(item.delayMs)
            )
            continue
          }
          handler('sidecar-run-1', 'session-1', item)
        }
      })
      return vi.fn()
    })
  }
}))

vi.mock('@renderer/lib/ipc/sidecar-approval-registry', () => ({
  registerSidecarApprovalHandler: vi.fn(() => vi.fn())
}))

vi.mock('@renderer/lib/agent/sub-agents/events', () => ({
  subAgentEvents: { emit: vi.fn() }
}))

function message(content: string, usageContextTokens = 1): UnifiedMessage {
  return {
    id: `m-${content}`,
    role: 'user',
    content,
    createdAt: 1,
    usage: { inputTokens: usageContextTokens, outputTokens: 0, contextTokens: usageContextTokens }
  }
}

const provider: ProviderConfig = {
  type: 'openai-chat',
  apiKey: 'test-key',
  model: 'test-model'
}

const tools: ToolDefinition[] = []

describe('runSharedAgentRuntime sidecar compression routing', () => {
  beforeEach(() => {
    capturedSidecarRequests.length = 0
    sidecarStreamEvents = [{ type: 'loop_end', reason: 'completed' }]
    vi.clearAllMocks()
  })

  it('passes claude-code-compact-v1 compression config to sidecar instead of forcing null', async () => {
    const config: AgentLoopConfig = {
      maxIterations: 1,
      provider,
      tools,
      systemPrompt: 'system',
      signal: new AbortController().signal,
      messageQueue: new MessageQueue(),
      contextCompression: {
        config: {
          enabled: true,
          contextLength: 200_000,
          threshold: 0.8,
          strategyId: 'claude-code-compact-v1',
          reservedOutputBudget: 20_000
        },
        compressFn: async (messages) => messages
      }
    }

    const result = await runSharedAgentRuntime({
      initialMessages: [message('small context', 10)],
      loopConfig: config,
      toolContext: {
        sessionId: 'session-1',
        workingFolder: 'C:/projects/OpenCowork',
        signal: config.signal,
        ipc: {
          invoke: vi.fn(async () => null),
          send: vi.fn(),
          on: vi.fn(() => vi.fn())
        }
      }
    })

    expect(result.reason).toBe('completed')
    expect(capturedSidecarRequests).toHaveLength(1)
    expect(capturedSidecarRequests[0]).toMatchObject({
      compression: {
        enabled: true,
        contextLength: 200_000,
        threshold: 0.8,
        strategyId: 'claude-code-compact-v1',
        reservedOutputBudget: 20_000
      }
    })
  })

  it('keeps compact metadata from sidecar context_compressed events', () => {
    const event = toAgentEvent({
      type: 'context_compressed',
      originalCount: 4,
      newCount: 2,
      messages: [
        {
          id: 'compact-boundary',
          role: 'system',
          content: 'Conversation compacted',
          createdAt: 123,
          meta: {
            compactBoundary: {
              strategy: 'claude-code-compact-v1',
              trigger: 'auto',
              preTokens: 180_000,
              postTokens: 1_000,
              messagesSummarized: 2,
              compactedAt: 123,
              retryCount: 0
            }
          }
        }
      ]
    })

    expect(event).toMatchObject({
      type: 'context_compressed',
      messages: [
        {
          meta: {
            compactBoundary: {
              strategy: 'claude-code-compact-v1',
              trigger: 'auto'
            }
          }
        }
      ]
    })
  })

  it('continues consuming sidecar stream long enough to capture loop_end messages after error', async () => {
    const finalMessages: UnifiedMessage[] = [
      {
        id: 'm-final',
        role: 'user',
        content: 'final transcript from sidecar',
        createdAt: 123
      }
    ]
    sidecarStreamEvents = [
      {
        type: 'error',
        message: 'context gate blocked model request',
        errorType: 'hard_context_limit_exceeded'
      },
      { type: 'loop_end', reason: 'error', messages: finalMessages }
    ]

    const config: AgentLoopConfig = {
      maxIterations: 1,
      provider,
      tools,
      systemPrompt: 'system',
      signal: new AbortController().signal,
      messageQueue: new MessageQueue()
    }

    const result = await runSharedAgentRuntime({
      initialMessages: [message('small context', 10)],
      loopConfig: config,
      toolContext: {
        sessionId: 'session-1',
        workingFolder: 'C:/projects/OpenCowork',
        signal: config.signal,
        ipc: {
          invoke: vi.fn(async () => null),
          send: vi.fn(),
          on: vi.fn(() => vi.fn())
        }
      }
    })

    expect(result.reason).toBe('error')
    expect(result.error).toBe('context gate blocked model request')
    expect(result.finalMessages).toEqual(finalMessages)
  })

  it('waits for delayed sidecar loop_end messages after an error event', async () => {
    vi.useFakeTimers()
    try {
      const finalMessages: UnifiedMessage[] = [
        {
          id: 'm-delayed-final',
          role: 'user',
          content: 'delayed final transcript from sidecar',
          createdAt: 456
        }
      ]
      sidecarStreamEvents = [
        {
          type: 'error',
          message: 'context gate blocked model request',
          errorType: 'hard_context_limit_exceeded'
        },
        { delayMs: 50, event: { type: 'loop_end', reason: 'error', messages: finalMessages } }
      ]

      const config: AgentLoopConfig = {
        maxIterations: 1,
        provider,
        tools,
        systemPrompt: 'system',
        signal: new AbortController().signal,
        messageQueue: new MessageQueue()
      }

      const resultPromise = runSharedAgentRuntime({
        initialMessages: [message('small context', 10)],
        loopConfig: config,
        toolContext: {
          sessionId: 'session-1',
          workingFolder: 'C:/projects/OpenCowork',
          signal: config.signal,
          ipc: {
            invoke: vi.fn(async () => null),
            send: vi.fn(),
            on: vi.fn(() => vi.fn())
          }
        }
      })

      await vi.advanceTimersByTimeAsync(50)
      await expect(resultPromise).resolves.toMatchObject({
        reason: 'error',
        finalMessages
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
