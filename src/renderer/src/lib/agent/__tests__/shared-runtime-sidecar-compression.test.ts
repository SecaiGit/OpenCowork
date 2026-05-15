import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UnifiedMessage, ProviderConfig, ToolDefinition } from '../../api/types'
import { MessageQueue, type AgentLoopConfig } from '../types'
import { runSharedAgentRuntime } from '../shared-runtime'

const capturedSidecarRequests: unknown[] = []

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
      queueMicrotask(() => handler('sidecar-run-1', 'session-1', { type: 'loop_end', reason: 'completed' }))
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
})
