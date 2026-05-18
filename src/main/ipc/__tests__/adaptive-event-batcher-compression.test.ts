import { describe, expect, it } from 'vitest'
import type { AgentStreamEnvelope } from '../../../shared/agent-stream-protocol'
import { AdaptiveEventBatcher } from '../adaptive-event-batcher'

describe('AdaptiveEventBatcher compression events', () => {
  it('forwards deferred compression checkpoints through the sidecar stream protocol', () => {
    const envelopes: AgentStreamEnvelope[] = []
    const batcher = new AdaptiveEventBatcher()
    batcher.setHandler((envelope) => envelopes.push(envelope))

    batcher.push('run-1', 'session-1', {
      type: 'context_compression_deferred',
      checkpoint: 'before_model_request',
      reason: 'unsafe_boundary',
      inputTokens: 180_000,
      contextLength: 200_000,
      reservedOutputTokens: 20_000,
      blockingNextRequest: false,
      messagesChanged: false
    })

    expect(envelopes).toHaveLength(1)
    expect(envelopes[0]?.events).toEqual([
      {
        type: 'context_compression_deferred',
        checkpoint: 'before_model_request',
        reason: 'unsafe_boundary',
        inputTokens: 180_000,
        contextLength: 200_000,
        reservedOutputTokens: 20_000,
        blockingNextRequest: false,
        messagesChanged: false
      }
    ])
  })
})
