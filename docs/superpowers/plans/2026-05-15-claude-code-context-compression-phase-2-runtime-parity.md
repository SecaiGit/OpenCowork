# Claude Code Context Compression Phase 2 Runtime Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make renderer, sidecar, and main-process JS agent runtimes use the same Claude Code style context compaction core for automatic context compression.

**Architecture:** Extract Phase 1 Claude compact behavior into a process-neutral shared core, keep renderer-specific and main-specific provider calls as thin adapters, and route sidecar runs with compression enabled once the main runtime can compact safely. The shared core owns budget, API-round selection, sanitization, prompt construction, summary validation, Prompt Too Long retry, and compact message assembly.

**Tech Stack:** TypeScript, Electron main/renderer, Vitest, existing OpenCowork agent loop protocol, existing `CompressionConfig`, existing Claude compact Phase 1 modules.

---

## Scope Check

This plan implements Phase 2 runtime parity only:

- Shared Claude compact core used by renderer and main runtime.
- Sidecar request path forwards compression configuration instead of forcing renderer fallback.
- Main-process JS runtime performs the same auto compact preflight and emits the same compression events.
- Existing manual `/compact` stays initiated by renderer, but uses the shared core through the renderer adapter.

This plan does not implement partial compact `from/up_to`, hooks, prompt-cache sharing, or richer relink metadata. Those remain required by the full goal and must be planned after runtime parity passes verification.

## File Structure

### Shared core files

- Create: `src/shared/claude-context-compression/types.ts`
  - Process-neutral message, config, result, metadata, and summarizer interfaces.
- Create: `src/shared/claude-context-compression/budget.ts`
  - Claude Code style effective window and auto threshold.
- Create: `src/shared/claude-context-compression/rounds.ts`
  - API round grouping, safe boundary selection, Prompt Too Long round dropping.
- Create: `src/shared/claude-context-compression/sanitizer.ts`
  - Input sanitization and summary output safety validation.
- Create: `src/shared/claude-context-compression/prompt.ts`
  - Compact system/user prompt and `<summary>` extraction.
- Create: `src/shared/claude-context-compression/engine.ts`
  - Shared compact orchestration with injectable summarizer, id generator, clock, post-compact context, and retry handling.
- Create: `src/shared/claude-context-compression/index.ts`
  - Barrel export used by renderer and main.
- Create: `src/shared/__tests__/claude-context-compression-core.test.ts`
  - Unit tests for shared budget, rounds, sanitizer, prompt, and engine.

### Renderer adapter files

- Modify: `src/renderer/src/lib/agent/claude-compact-budget.ts`
  - Re-export shared budget API for existing renderer imports.
- Modify: `src/renderer/src/lib/agent/claude-compact-rounds.ts`
  - Re-export shared round API for existing renderer imports.
- Modify: `src/renderer/src/lib/agent/claude-compact-sanitizer.ts`
  - Re-export shared sanitizer API for existing renderer imports.
- Modify: `src/renderer/src/lib/agent/claude-compact-prompt.ts`
  - Re-export shared prompt API for existing renderer imports.
- Modify: `src/renderer/src/lib/agent/claude-compact-engine.ts`
  - Replace renderer-owned compact orchestration with a thin adapter around the shared engine and `runSidecarTextRequest`.
- Modify: `src/renderer/src/lib/agent/shared-runtime.ts`
  - Pass compression config to sidecar requests after main support is in place.
- Create: `src/renderer/src/lib/agent/__tests__/shared-runtime-sidecar-compression.test.ts`
  - Integration test ensuring sidecar path receives `claude-code-compact-v1` config.

### Main runtime files

- Modify: `src/shared/agent-loop-types.ts`
  - Add `meta?: Record<string, unknown>` to `AgentLoopMessage` so compact boundary/summary metadata survives main loop capture.
- Create: `src/main/cron/context-compression-runtime.ts`
  - Main-runtime preflight helper: token usage, pre-compression, full compression, event payload construction.
- Modify: `src/main/cron/cron-agent-background.ts`
  - Add compression types to `AgentLoopConfig`, create main compact summarizer adapter, call preflight between iterations, emit `context_compression_start` and `context_compressed` events, preserve metadata in final messages.
- Modify: `src/main/ipc/js-agent-runtime.ts`
  - Accept `compression` in `JsAgentRunRequest`, build main compression function, and pass it to `runInteractiveAgentLoop`.
- Create: `src/main/cron/__tests__/context-compression-runtime.test.ts`
  - Unit tests for main preflight helper with fake summarizer/compressor.
- Create: `src/main/ipc/__tests__/js-agent-runtime-compression.test.ts`
  - Unit test that `JsAgentRuntimeManager` forwards sidecar compression into main loop config.

### Protocol and scripts

- Modify: `src/renderer/src/lib/ipc/sidecar-protocol.ts`
  - Keep `compression?: CompressionConfig`; no shape change expected unless shared config type needs a non-renderer alias.
- Modify: `src/renderer/src/lib/agent/stream-event-adapter.ts`
  - Confirm `context_compressed.messages` metadata passes through unchanged.
- Modify: `package.json`
  - Extend `test:agent-context` to include shared/main runtime parity tests.

---

## Task 1: Add red tests for sidecar compression routing and main request forwarding

**Files:**
- Create: `src/renderer/src/lib/agent/__tests__/shared-runtime-sidecar-compression.test.ts`
- Create: `src/main/ipc/__tests__/js-agent-runtime-compression.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing renderer-side sidecar routing test**

Create `src/renderer/src/lib/agent/__tests__/shared-runtime-sidecar-compression.test.ts` with this content:

```ts
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
        signal: config.signal
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
```

- [ ] **Step 2: Write the failing main-runtime forwarding test**

Create `src/main/ipc/__tests__/js-agent-runtime-compression.test.ts` with this content:

```ts
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
```

- [ ] **Step 3: Add new tests to the test script**

Modify `package.json` script `test:agent-context` to exactly this value:

```json
"test:agent-context": "vitest run src/shared/__tests__/claude-context-compression-core.test.ts src/main/cron/__tests__/context-compression-runtime.test.ts src/main/ipc/__tests__/js-agent-runtime-compression.test.ts src/renderer/src/lib/agent/__tests__/long-task-context.test.ts src/renderer/src/lib/agent/__tests__/claude-context-compression.test.ts src/renderer/src/lib/agent/__tests__/shared-runtime-sidecar-compression.test.ts"
```

- [ ] **Step 4: Run tests and verify they fail for the intended missing behavior**

Run:

```bash
npx vitest run src/renderer/src/lib/agent/__tests__/shared-runtime-sidecar-compression.test.ts src/main/ipc/__tests__/js-agent-runtime-compression.test.ts
```

Expected:

```text
FAIL src/renderer/src/lib/agent/__tests__/shared-runtime-sidecar-compression.test.ts
Expected received object to match compression: { strategyId: 'claude-code-compact-v1' }

FAIL src/main/ipc/__tests__/js-agent-runtime-compression.test.ts
Expected received object to match contextCompression: { config: { strategyId: 'claude-code-compact-v1' } }
```

- [ ] **Step 5: Commit red tests**

```bash
git add package.json src/renderer/src/lib/agent/__tests__/shared-runtime-sidecar-compression.test.ts src/main/ipc/__tests__/js-agent-runtime-compression.test.ts
git commit -m "test(context): cover sidecar compression forwarding"
```

---

## Task 2: Introduce shared Claude compact core and preserve renderer compatibility imports

**Files:**
- Create: `src/shared/claude-context-compression/types.ts`
- Create: `src/shared/claude-context-compression/budget.ts`
- Create: `src/shared/claude-context-compression/rounds.ts`
- Create: `src/shared/claude-context-compression/sanitizer.ts`
- Create: `src/shared/claude-context-compression/prompt.ts`
- Create: `src/shared/claude-context-compression/engine.ts`
- Create: `src/shared/claude-context-compression/index.ts`
- Create: `src/shared/__tests__/claude-context-compression-core.test.ts`
- Modify: `src/renderer/src/lib/agent/claude-compact-budget.ts`
- Modify: `src/renderer/src/lib/agent/claude-compact-rounds.ts`
- Modify: `src/renderer/src/lib/agent/claude-compact-sanitizer.ts`
- Modify: `src/renderer/src/lib/agent/claude-compact-prompt.ts`

- [ ] **Step 1: Write shared-core tests before moving code**

Create `src/shared/__tests__/claude-context-compression-core.test.ts` with this content:

```ts
import { describe, expect, it, vi } from 'vitest'
import {
  assertClaudeCompactSummarySafe,
  buildClaudeCompactSystemPrompt,
  buildClaudeCompactUserPrompt,
  extractClaudeCompactSummary,
  getClaudeCompactBudget,
  runClaudeCompact,
  sanitizeMessagesForClaudeCompact,
  selectClaudeCompactRanges,
  type ClaudeCompactContentBlock,
  type ClaudeCompactMessage
} from '../claude-context-compression'

let nextMessageId = 0

function message(
  role: ClaudeCompactMessage['role'],
  content: ClaudeCompactMessage['content']
): ClaudeCompactMessage {
  nextMessageId += 1
  return {
    id: `m-${nextMessageId}`,
    role,
    content,
    createdAt: nextMessageId
  }
}

function toolUse(id: string): ClaudeCompactContentBlock {
  return { type: 'tool_use', id, name: 'Read', input: {} }
}

function toolResult(id: string, content = 'ok'): ClaudeCompactContentBlock {
  return { type: 'tool_result', toolUseId: id, content }
}

describe('shared Claude compact core', () => {
  it('computes Claude Code style budget without renderer imports', () => {
    expect(
      getClaudeCompactBudget({ contextLength: 200_000, reservedOutputBudget: 32_000 })
    ).toEqual({
      contextLength: 200_000,
      reservedOutputTokens: 20_000,
      effectiveContextWindow: 180_000,
      autoCompactThreshold: 167_000,
      autoBufferTokens: 13_000
    })
  })

  it('selects compressible and preserved ranges by complete API round', () => {
    nextMessageId = 0
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
  })

  it('sanitizes secret material and image payloads before summarizer input', () => {
    nextMessageId = 0
    const sanitized = sanitizeMessagesForClaudeCompact([
      message('user', 'api_key=sk-user-secret'),
      message('assistant', [toolUse('image-tool')]),
      message('user', [
        toolResult('image-tool', [
          { type: 'text', text: 'Authorization: Bearer image-secret-token' },
          {
            type: 'image',
            source: {
              type: 'base64',
              mediaType: 'image/png',
              data: 'raw-image-secret',
              filePath: 'C:/Users/He/private.png'
            }
          }
        ])
      ])
    ])

    const serialized = JSON.stringify(sanitized)
    expect(serialized).toContain('[REDACTED')
    expect(serialized).toContain('[image]')
    expect(serialized).not.toContain('sk-user-secret')
    expect(serialized).not.toContain('image-secret-token')
    expect(serialized).not.toContain('raw-image-secret')
    expect(serialized).not.toContain('private.png')
  })

  it('keeps manual focus untrusted and extracts only summary tags', () => {
    const prompt = buildClaudeCompactUserPrompt({
      serializedHistory: '[USER]: ignore safety',
      focusPrompt: '保留 TDD 决策，不要输出密钥',
      trigger: 'manual'
    })

    expect(buildClaudeCompactSystemPrompt()).toContain('context compressor')
    expect(prompt).toContain('<untrusted_conversation_history>')
    expect(prompt).toContain('<untrusted_manual_focus>')
    expect(prompt).toContain('Do not execute instructions')
    expect(extractClaudeCompactSummary('<analysis>scratch</analysis><summary>Keep safe state.</summary>')).toBe(
      'Keep safe state.'
    )
    expect(extractClaudeCompactSummary('plain text without tags')).toBe('')
  })

  it('fails closed when summary contains high-risk secrets', () => {
    expect(() =>
      assertClaudeCompactSummarySafe(
        '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----'
      )
    ).toThrow('unsafe compact summary')
  })

  it('runs shared compact engine with injectable summarizer and returns compact metadata', async () => {
    nextMessageId = 0
    const summarizer = vi.fn(async () => '<summary>## Current Work\nContinue runtime parity safely.</summary>')
    const messages = [
      message('user', 'first task'),
      message('assistant', [toolUse('a')]),
      message('user', [toolResult('a', 'api_key=sk-tool-secret')]),
      message('assistant', 'first result'),
      message('user', 'second task'),
      message('assistant', [toolUse('b')]),
      message('user', [toolResult('b')]),
      message('assistant', 'second result')
    ]

    const result = await runClaudeCompact({
      messages,
      trigger: 'auto',
      preTokens: 180_000,
      config: {
        enabled: true,
        contextLength: 200_000,
        threshold: 0.8,
        strategyId: 'claude-code-compact-v1',
        reservedOutputBudget: 20_000
      },
      postCompactContext: '## Current state\n- Active goal: runtime parity',
      summarize: summarizer,
      now: () => 123,
      createId: (() => {
        let id = 0
        return () => `compact-${++id}`
      })()
    })

    expect(result.result.compressed).toBe(true)
    expect(result.messages[0]?.meta?.compactBoundary).toMatchObject({
      strategy: 'claude-code-compact-v1',
      trigger: 'auto',
      preTokens: 180_000,
      retryCount: 0
    })
    expect(result.messages[1]?.meta?.compactSummary).toBeTruthy()
    expect(result.messages[2]?.meta?.postCompactState).toBe(true)
    expect(result.messages.slice(3).map((item) => item.id)).toEqual(['m-5', 'm-6', 'm-7', 'm-8'])
    expect(JSON.stringify(summarizer.mock.calls[0])).not.toContain('sk-tool-secret')
  })
})
```

- [ ] **Step 2: Run the shared-core test and verify it fails because shared files do not exist**

Run:

```bash
npx vitest run src/shared/__tests__/claude-context-compression-core.test.ts
```

Expected:

```text
FAIL src/shared/__tests__/claude-context-compression-core.test.ts
Cannot find module '../claude-context-compression'
```

- [ ] **Step 3: Create shared type definitions**

Create `src/shared/claude-context-compression/types.ts` with these exports:

```ts
export type ClaudeCompactTrigger = 'auto' | 'manual'

export interface ClaudeCompactConfig {
  enabled: boolean
  contextLength: number
  threshold: number
  strategyId?: 'partial-summary-v1' | 'claude-code-compact-v1'
  preCompressThreshold?: number
  reservedOutputBudget?: number
}

export interface ClaudeCompactTextBlock {
  type: 'text'
  text: string
}

export interface ClaudeCompactImageBlock {
  type: 'image'
  source: {
    type: 'base64' | 'url'
    mediaType?: string
    data?: string
    url?: string
    filePath?: string
  }
}

export interface ClaudeCompactThinkingBlock {
  type: 'thinking'
  thinking: string
  encryptedContent?: string
  encryptedContentProvider?: 'anthropic' | 'openai-responses' | 'google'
}

export interface ClaudeCompactToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
  extraContent?: Record<string, unknown>
}

export interface ClaudeCompactToolResultBlock {
  type: 'tool_result'
  toolUseId: string
  content: string | Array<ClaudeCompactTextBlock | ClaudeCompactImageBlock>
  isError?: boolean
}

export interface ClaudeCompactAgentErrorBlock {
  type: 'agent_error'
  code: 'runtime_error' | 'tool_error' | 'unknown'
  message: string
  errorType?: string
  details?: string
  stackTrace?: string
}

export type ClaudeCompactContentBlock =
  | ClaudeCompactTextBlock
  | ClaudeCompactImageBlock
  | ClaudeCompactThinkingBlock
  | ClaudeCompactToolUseBlock
  | ClaudeCompactToolResultBlock
  | ClaudeCompactAgentErrorBlock

export interface ClaudeCompactBoundaryMeta {
  strategy: 'claude-code-compact-v1'
  trigger: ClaudeCompactTrigger
  preTokens: number
  postTokens: number
  messagesSummarized: number
  compactedAt: number
  retryCount: number
  compressedRange?: { start: number; end: number }
  preservedRange?: { start: number; end: number }
  safetyFlags?: string[]
  preservedSegment?: {
    headId: string
    anchorId: string
    tailId: string
  }
}

export interface ClaudeCompactSummaryMeta {
  messagesSummarized: number
  recentMessagesPreserved: boolean
}

export interface ClaudeCompactMessageMeta {
  compactBoundary?: ClaudeCompactBoundaryMeta
  compactSummary?: ClaudeCompactSummaryMeta
  postCompactState?: boolean
  [key: string]: unknown
}

export interface ClaudeCompactTokenUsage {
  inputTokens?: number
  outputTokens?: number
  contextTokens?: number
}

export interface ClaudeCompactMessage {
  id: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ClaudeCompactContentBlock[]
  createdAt: number
  usage?: ClaudeCompactTokenUsage
  providerResponseId?: string
  source?: string | null
  meta?: ClaudeCompactMessageMeta
}

export type ClaudeCompactSkipReason =
  | 'insufficient_messages'
  | 'insufficient_compressible_messages'
  | 'summarizer_prompt_too_long'
  | 'summarizer_failed'
  | 'circuit_breaker_open'
  | 'unsafe_boundary'
  | 'unsafe_summary_output'
  | 'cancelled'
  | 'unknown'

export interface ClaudeCompactResult {
  compressed: boolean
  originalCount: number
  newCount: number
  messagesSummarized?: number
  reason?: ClaudeCompactSkipReason
}

export interface RunClaudeCompactArgs {
  messages: ClaudeCompactMessage[]
  trigger: ClaudeCompactTrigger
  preTokens: number
  config?: ClaudeCompactConfig | null
  focusPrompt?: string
  postCompactContext?: string
  signal?: AbortSignal
  summarize: (args: {
    systemPrompt: string
    userPrompt: string
    signal?: AbortSignal
  }) => Promise<string>
  now?: () => number
  createId?: () => string
}

export interface RunClaudeCompactResult {
  messages: ClaudeCompactMessage[]
  result: ClaudeCompactResult
}
```

- [ ] **Step 4: Move pure Phase 1 logic into shared modules**

Copy the behavior from the existing renderer files into shared files while replacing renderer-specific imports with shared types:

```text
src/renderer/src/lib/agent/claude-compact-budget.ts      -> src/shared/claude-context-compression/budget.ts
src/renderer/src/lib/agent/claude-compact-rounds.ts      -> src/shared/claude-context-compression/rounds.ts
src/renderer/src/lib/agent/claude-compact-sanitizer.ts   -> src/shared/claude-context-compression/sanitizer.ts
src/renderer/src/lib/agent/claude-compact-prompt.ts      -> src/shared/claude-context-compression/prompt.ts
```

The shared files must import only from:

```ts
import type {
  ClaudeCompactConfig,
  ClaudeCompactContentBlock,
  ClaudeCompactMessage
} from './types'
```

The shared files must not import from `@renderer/*`, `src/renderer/*`, `src/main/*`, Electron, IPC, stores, or i18n.

- [ ] **Step 5: Create the shared engine**

Create `src/shared/claude-context-compression/engine.ts` with the exported orchestration:

```ts
import type {
  ClaudeCompactBoundaryMeta,
  ClaudeCompactMessage,
  RunClaudeCompactArgs,
  RunClaudeCompactResult
} from './types'
import { buildClaudeCompactSystemPrompt, buildClaudeCompactUserPrompt, extractClaudeCompactSummary } from './prompt'
import { assertClaudeCompactSummarySafe, sanitizeMessagesForClaudeCompact } from './sanitizer'
import { dropOldestClaudeCompactRounds, selectClaudeCompactRanges } from './rounds'

export const MAX_CLAUDE_COMPACT_RETRIES = 3

function serializeCompactMessages(messages: ClaudeCompactMessage[]): string {
  return messages
    .map((message) => {
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
      return `[${message.role.toUpperCase()}]: ${content}`
    })
    .join('\n\n')
}

function isPromptTooLongError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /prompt.?too.?long|context.?length|maximum context|too many tokens|413/i.test(message)
}

function isUnsafeSummaryOutputError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /unsafe compact summary/i.test(message)
}

function estimateSharedTokens(messages: ClaudeCompactMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4)
}

function createBoundaryMessage(args: {
  createId: () => string
  now: () => number
  trigger: ClaudeCompactBoundaryMeta['trigger']
  preTokens: number
  postTokens: number
  messagesSummarized: number
  retryCount: number
  compressedRange?: { start: number; end: number }
  preservedRange?: { start: number; end: number }
  preservedMessages: ClaudeCompactMessage[]
}): ClaudeCompactMessage {
  const preservedSegment = args.preservedMessages.length
    ? {
        headId: args.preservedMessages[0]!.id,
        anchorId: '',
        tailId: args.preservedMessages[args.preservedMessages.length - 1]!.id
      }
    : undefined

  return {
    id: args.createId(),
    role: 'system',
    content: 'Conversation compacted',
    createdAt: args.now(),
    meta: {
      compactBoundary: {
        strategy: 'claude-code-compact-v1',
        trigger: args.trigger,
        preTokens: args.preTokens,
        postTokens: args.postTokens,
        messagesSummarized: args.messagesSummarized,
        compactedAt: args.now(),
        retryCount: args.retryCount,
        ...(args.compressedRange ? { compressedRange: args.compressedRange } : {}),
        ...(args.preservedRange ? { preservedRange: args.preservedRange } : {}),
        safetyFlags: ['untrusted-history', 'sanitized-input', 'validated-summary'],
        ...(preservedSegment ? { preservedSegment } : {})
      }
    }
  }
}

function createSummaryMessage(args: {
  createId: () => string
  now: () => number
  summary: string
  messagesSummarized: number
}): ClaudeCompactMessage {
  return {
    id: args.createId(),
    role: 'user',
    content: args.summary,
    createdAt: args.now(),
    meta: {
      compactSummary: {
        messagesSummarized: args.messagesSummarized,
        recentMessagesPreserved: true
      }
    }
  }
}

function createPostCompactStateMessage(args: {
  createId: () => string
  now: () => number
  postCompactContext?: string
}): ClaudeCompactMessage | null {
  const content = args.postCompactContext?.trim()
  if (!content) return null
  return {
    id: args.createId(),
    role: 'user',
    content,
    createdAt: args.now(),
    meta: { postCompactState: true }
  }
}

export async function runClaudeCompact(args: RunClaudeCompactArgs): Promise<RunClaudeCompactResult> {
  const now = args.now ?? Date.now
  const createId = args.createId ?? (() => `compact-${Math.random().toString(36).slice(2)}`)
  const selection = selectClaudeCompactRanges(args.messages)
  if (!selection.ok) {
    return {
      messages: args.messages,
      result: {
        compressed: false,
        originalCount: args.messages.length,
        newCount: args.messages.length,
        reason:
          selection.reason === 'unsafe_boundary'
            ? 'unsafe_boundary'
            : selection.reason === 'insufficient_messages'
              ? 'insufficient_messages'
              : 'insufficient_compressible_messages'
      }
    }
  }

  let lastError: unknown = null
  let compressibleMessages = selection.compressibleMessages

  for (let attempt = 0; attempt <= MAX_CLAUDE_COMPACT_RETRIES; attempt += 1) {
    try {
      const sanitizedMessages = sanitizeMessagesForClaudeCompact(compressibleMessages, args.config)
      const rawSummary = await args.summarize({
        systemPrompt: buildClaudeCompactSystemPrompt(),
        userPrompt: buildClaudeCompactUserPrompt({
          serializedHistory: serializeCompactMessages(sanitizedMessages),
          focusPrompt: args.focusPrompt,
          trigger: args.trigger
        }),
        signal: args.signal
      })
      const extracted = extractClaudeCompactSummary(rawSummary)
      if (!extracted) throw new Error('empty compact summary')
      const summary = assertClaudeCompactSummarySafe(extracted)

      const summaryMessage = createSummaryMessage({
        createId,
        now,
        summary,
        messagesSummarized: selection.compressibleMessages.length
      })
      const postCompactStateMessage = createPostCompactStateMessage({
        createId,
        now,
        postCompactContext: args.postCompactContext
      })
      const compressedMessages = [
        createBoundaryMessage({
          createId,
          now,
          trigger: args.trigger,
          preTokens: args.preTokens,
          postTokens: 0,
          messagesSummarized: selection.compressibleMessages.length,
          retryCount: attempt,
          compressedRange: selection.compressedRange,
          preservedRange: selection.preservedRange,
          preservedMessages: selection.preservedMessages
        }),
        summaryMessage,
        ...(postCompactStateMessage ? [postCompactStateMessage] : []),
        ...selection.preservedMessages
      ]

      const boundary = compressedMessages[0]
      if (boundary.meta?.compactBoundary?.preservedSegment) {
        boundary.meta.compactBoundary.preservedSegment.anchorId = summaryMessage.id
      }
      if (boundary.meta?.compactBoundary) {
        boundary.meta.compactBoundary.postTokens = estimateSharedTokens(compressedMessages)
      }

      return {
        messages: compressedMessages,
        result: {
          compressed: true,
          originalCount: args.messages.length,
          newCount: compressedMessages.length,
          messagesSummarized: selection.compressibleMessages.length
        }
      }
    } catch (error) {
      lastError = error
      if (!isPromptTooLongError(error) || attempt >= MAX_CLAUDE_COMPACT_RETRIES) break
      const retryMessages =
        dropOldestClaudeCompactRounds(compressibleMessages, attempt + 1) ??
        dropOldestClaudeCompactRounds(args.messages, attempt + 1)
      if (!retryMessages) break
      compressibleMessages = retryMessages
    }
  }

  return {
    messages: args.messages,
    result: {
      compressed: false,
      originalCount: args.messages.length,
      newCount: args.messages.length,
      reason: isPromptTooLongError(lastError)
        ? 'summarizer_prompt_too_long'
        : isUnsafeSummaryOutputError(lastError)
          ? 'unsafe_summary_output'
          : 'summarizer_failed'
    }
  }
}
```

- [ ] **Step 6: Create shared barrel export**

Create `src/shared/claude-context-compression/index.ts` with:

```ts
export * from './types'
export * from './budget'
export * from './rounds'
export * from './sanitizer'
export * from './prompt'
export * from './engine'
```

- [ ] **Step 7: Turn renderer pure modules into compatibility re-exports**

Replace each renderer pure module with these exact imports/exports:

`src/renderer/src/lib/agent/claude-compact-budget.ts`:

```ts
export * from '../../../../shared/claude-context-compression/budget'
```

`src/renderer/src/lib/agent/claude-compact-rounds.ts`:

```ts
export * from '../../../../shared/claude-context-compression/rounds'
```

`src/renderer/src/lib/agent/claude-compact-sanitizer.ts`:

```ts
export * from '../../../../shared/claude-context-compression/sanitizer'
```

`src/renderer/src/lib/agent/claude-compact-prompt.ts`:

```ts
export * from '../../../../shared/claude-context-compression/prompt'
```

- [ ] **Step 8: Run shared and existing renderer tests**

Run:

```bash
npx vitest run src/shared/__tests__/claude-context-compression-core.test.ts src/renderer/src/lib/agent/__tests__/claude-context-compression.test.ts
```

Expected:

```text
PASS src/shared/__tests__/claude-context-compression-core.test.ts
PASS src/renderer/src/lib/agent/__tests__/claude-context-compression.test.ts
```

- [ ] **Step 9: Commit shared core extraction**

```bash
git add src/shared/claude-context-compression src/shared/__tests__/claude-context-compression-core.test.ts src/renderer/src/lib/agent/claude-compact-budget.ts src/renderer/src/lib/agent/claude-compact-rounds.ts src/renderer/src/lib/agent/claude-compact-sanitizer.ts src/renderer/src/lib/agent/claude-compact-prompt.ts
git commit -m "refactor(context): share Claude compact core"
```

---

## Task 3: Convert renderer Claude strategy to shared engine adapter

**Files:**
- Modify: `src/renderer/src/lib/agent/claude-compact-engine.ts`
- Modify: `src/renderer/src/lib/agent/__tests__/claude-context-compression.test.ts`

- [ ] **Step 1: Add a renderer adapter assertion to the existing engine test**

In `src/renderer/src/lib/agent/__tests__/claude-context-compression.test.ts`, extend the test named `compresses older API rounds into boundary, summary, post-compact state, and preserved tail` by adding these assertions after the existing `runSidecarTextRequest` secret assertion:

```ts
expect(vi.mocked(runSidecarTextRequest).mock.calls[0]?.[0]).toMatchObject({
  maxIterations: 1,
  responsesSessionScope: false,
  provider: {
    model: 'test-model',
    thinkingEnabled: false
  }
})
expect(String(vi.mocked(runSidecarTextRequest).mock.calls[0]?.[0].provider.systemPrompt)).toContain(
  'context compressor'
)
```

- [ ] **Step 2: Run the renderer compact test and verify current behavior before refactor**

Run:

```bash
npx vitest run src/renderer/src/lib/agent/__tests__/claude-context-compression.test.ts -t "compresses older API rounds"
```

Expected:

```text
PASS src/renderer/src/lib/agent/__tests__/claude-context-compression.test.ts
```

- [ ] **Step 3: Replace renderer engine orchestration with shared engine call**

Modify `src/renderer/src/lib/agent/claude-compact-engine.ts` so the file imports shared orchestration and keeps renderer-specific provider calling:

```ts
import { nanoid } from 'nanoid'
import { runSidecarTextRequest } from '@renderer/lib/ipc/agent-bridge'
import { RESPONSES_SESSION_SCOPE_CONTEXT_COMPRESSION } from '@renderer/lib/api/responses-session-policy'
import type { CompactBoundaryMeta, ProviderConfig, UnifiedMessage } from '../api/types'
import type {
  CompressionConfig,
  CompressionResult,
  ContextCompressionStrategy
} from './context-compression'
import {
  getClaudeCompactBudget,
  runClaudeCompact,
  sanitizeMessagesForClaudeCompact
} from '../../../../shared/claude-context-compression'

const MAX_CLAUDE_COMPACT_FAILURES = 3
let claudeCompactFailures = 0

async function callClaudeCompactSummarizer(args: {
  providerConfig: ProviderConfig
  systemPrompt: string
  userPrompt: string
  signal?: AbortSignal
}): Promise<string> {
  return runSidecarTextRequest({
    provider: {
      ...args.providerConfig,
      systemPrompt: args.systemPrompt,
      thinkingEnabled: false
    },
    messages: [
      {
        id: 'claude-compact-request',
        role: 'user',
        content: args.userPrompt,
        createdAt: Date.now()
      }
    ],
    signal: args.signal,
    maxIterations: 1,
    responsesSessionScope: RESPONSES_SESSION_SCOPE_CONTEXT_COMPRESSION
  })
}

function shouldClaudeCompress(inputTokens: number, config: CompressionConfig): boolean {
  if (!config.enabled || config.contextLength <= 0) return false
  if (claudeCompactFailures >= MAX_CLAUDE_COMPACT_FAILURES) return false
  return inputTokens >= getClaudeCompactBudget(config).autoCompactThreshold
}

function shouldClaudePreCompress(inputTokens: number, config: CompressionConfig): boolean {
  if (!config.enabled || config.contextLength <= 0) return false
  const budget = getClaudeCompactBudget(config)
  const threshold = Math.max(1, budget.autoCompactThreshold - 8_000)
  return inputTokens >= threshold && inputTokens < budget.autoCompactThreshold
}

async function claudeCompressMessages(
  messages: UnifiedMessage[],
  providerConfig: ProviderConfig,
  signal?: AbortSignal,
  _preserveCount?: number,
  focusPrompt?: string,
  _pinnedContext?: string,
  trigger: CompactBoundaryMeta['trigger'] = 'manual',
  preTokens = 0,
  config?: CompressionConfig | null,
  postCompactContext?: string
): Promise<{ messages: UnifiedMessage[]; result: CompressionResult }> {
  if (claudeCompactFailures >= MAX_CLAUDE_COMPACT_FAILURES) {
    return {
      messages,
      result: {
        compressed: false,
        originalCount: messages.length,
        newCount: messages.length,
        reason: 'circuit_breaker_open'
      }
    }
  }

  const compacted = await runClaudeCompact({
    messages,
    trigger,
    preTokens,
    config,
    focusPrompt,
    postCompactContext,
    signal,
    summarize: async ({ systemPrompt, userPrompt, signal: summarizeSignal }) =>
      callClaudeCompactSummarizer({
        providerConfig,
        systemPrompt,
        userPrompt,
        signal: summarizeSignal
      }),
    createId: nanoid,
    now: Date.now
  })

  if (compacted.result.compressed) {
    claudeCompactFailures = 0
  } else if (
    compacted.result.reason === 'summarizer_failed' ||
    compacted.result.reason === 'summarizer_prompt_too_long' ||
    compacted.result.reason === 'unsafe_summary_output'
  ) {
    claudeCompactFailures += 1
  }

  return compacted as { messages: UnifiedMessage[]; result: CompressionResult }
}

export function createClaudeCodeCompactStrategy(): ContextCompressionStrategy {
  return {
    id: 'claude-code-compact-v1',
    shouldCompress: shouldClaudeCompress,
    shouldPreCompress: shouldClaudePreCompress,
    preCompressMessages: (messages) => sanitizeMessagesForClaudeCompact(messages) as UnifiedMessage[],
    compressMessages: claudeCompressMessages
  }
}
```

Keep the cast only at the adapter boundary shown above. The shared engine must preserve `id`, `role`, `content`, `createdAt`, `usage`, `providerResponseId`, `source`, and `meta` without cloning away metadata.

- [ ] **Step 4: Run renderer compact tests**

Run:

```bash
npx vitest run src/renderer/src/lib/agent/__tests__/claude-context-compression.test.ts
```

Expected:

```text
PASS src/renderer/src/lib/agent/__tests__/claude-context-compression.test.ts
```

- [ ] **Step 5: Run typecheck for renderer/main import compatibility**

Run:

```bash
npm run typecheck
```

Expected:

```text
> open-cowork@0.9.92 typecheck
> npm run typecheck:node && npm run typecheck:web
```

Both subcommands exit with code 0.

- [ ] **Step 6: Commit renderer adapter refactor**

```bash
git add src/renderer/src/lib/agent/claude-compact-engine.ts src/renderer/src/lib/agent/__tests__/claude-context-compression.test.ts
git commit -m "refactor(renderer): adapt Claude compact strategy to shared engine"
```

---

## Task 4: Add main-runtime compression preflight helper

**Files:**
- Create: `src/main/cron/context-compression-runtime.ts`
- Create: `src/main/cron/__tests__/context-compression-runtime.test.ts`

- [ ] **Step 1: Write failing tests for main preflight helper**

Create `src/main/cron/__tests__/context-compression-runtime.test.ts` with this content:

```ts
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
```

- [ ] **Step 2: Run the test and verify helper does not exist**

Run:

```bash
npx vitest run src/main/cron/__tests__/context-compression-runtime.test.ts
```

Expected:

```text
FAIL src/main/cron/__tests__/context-compression-runtime.test.ts
Cannot find module '../context-compression-runtime'
```

- [ ] **Step 3: Implement main preflight helper using shared core**

Create `src/main/cron/context-compression-runtime.ts` with these exports and behavior:

```ts
import {
  getClaudeCompactBudget,
  runClaudeCompact,
  type ClaudeCompactConfig,
  type ClaudeCompactContentBlock,
  type ClaudeCompactMessage,
  type ClaudeCompactTrigger
} from '../../shared/claude-context-compression'
import { compactShellOutputPayload, compactShellText } from '../../shared/shell-output-compactor'

export type MainRuntimeCompressionConfig = ClaudeCompactConfig
export type MainRuntimeContentBlock = ClaudeCompactContentBlock
export type MainRuntimeMessage = ClaudeCompactMessage
export type MainRuntimeCompressionEvent =
  | { type: 'context_compression_start' }
  | {
      type: 'context_compressed'
      originalCount: number
      newCount: number
      messages: MainRuntimeMessage[]
    }

export interface MainRuntimeCompressionPreflightResult {
  messages: MainRuntimeMessage[]
  compressed: boolean
  events: MainRuntimeCompressionEvent[]
}

function readContextUsage(usage?: MainRuntimeMessage['usage']): number {
  return usage?.contextTokens ?? usage?.inputTokens ?? 0
}

export function findRecentMainRuntimeContextUsage(messages: MainRuntimeMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const tokens = readContextUsage(messages[i]?.usage)
    if (tokens > 0) return tokens
  }
  return 0
}

function estimateMainRuntimeMessagesTokens(messages: MainRuntimeMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4)
}

function shouldMainRuntimeCompact(tokens: number, config: MainRuntimeCompressionConfig): boolean {
  if (!config.enabled || config.contextLength <= 0) return false
  return tokens >= getClaudeCompactBudget(config).autoCompactThreshold
}

function compactTextContent(text: string, config: MainRuntimeCompressionConfig): { text: string; compacted: boolean } {
  const maxChars = Math.max(1_000, Math.floor(config.contextLength / 10))
  if (text.length <= maxChars) return { text, compacted: false }
  const preview = compactShellText(text, {
    stdoutMaxChars: maxChars,
    streamMaxLines: 160,
    importantLineLimit: 80
  })
  return { text: preview.text, compacted: preview.truncated || preview.text !== text }
}

export function preCompressMainRuntimeMessages(
  messages: MainRuntimeMessage[],
  config: MainRuntimeCompressionConfig
): { messages: MainRuntimeMessage[]; compactedCount: number } {
  let compactedCount = 0
  const next = messages.map((message) => {
    if (!Array.isArray(message.content)) return message
    let changed = false
    const content = message.content.map((block) => {
      if (block.type !== 'tool_result') return block
      if (typeof block.content === 'string') {
        const compacted = compactTextContent(block.content, config)
        if (!compacted.compacted) return block
        compactedCount += 1
        changed = true
        return { ...block, content: `[Tool result compacted for context budget]\n${compacted.text}` }
      }
      const compactedPayload = compactShellOutputPayload({ output: JSON.stringify(block.content) }, {
        stdoutMaxChars: 2_000,
        stderrMaxChars: 2_000,
        streamMaxLines: 80,
        importantLineLimit: 60
      })
      compactedCount += 1
      changed = true
      return { ...block, content: JSON.stringify(compactedPayload) }
    })
    return changed ? { ...message, content } : message
  })
  return { messages: next, compactedCount }
}

export async function maybeCompactMainRuntimeContext(args: {
  messages: MainRuntimeMessage[]
  config: MainRuntimeCompressionConfig
  trigger: ClaudeCompactTrigger
  postCompactContext?: string
  focusPrompt?: string
  signal?: AbortSignal
  summarize: (args: { systemPrompt: string; userPrompt: string; signal?: AbortSignal }) => Promise<string>
  now?: () => number
  createId?: () => string
}): Promise<MainRuntimeCompressionPreflightResult> {
  const preCompressed = preCompressMainRuntimeMessages(args.messages, args.config)
  const candidateMessages = preCompressed.messages
  const recentUsage = findRecentMainRuntimeContextUsage(candidateMessages)
  const estimatedTokens = estimateMainRuntimeMessagesTokens(candidateMessages)
  const conservativeTokens = Math.max(recentUsage, estimatedTokens)

  if (!shouldMainRuntimeCompact(conservativeTokens, args.config)) {
    return { messages: candidateMessages, compressed: false, events: [] }
  }

  const compacted = await runClaudeCompact({
    messages: candidateMessages,
    trigger: args.trigger,
    preTokens: conservativeTokens,
    config: args.config,
    postCompactContext: args.postCompactContext,
    focusPrompt: args.focusPrompt,
    signal: args.signal,
    summarize: args.summarize,
    now: args.now,
    createId: args.createId
  })

  if (!compacted.result.compressed) {
    return { messages: candidateMessages, compressed: false, events: [] }
  }

  return {
    messages: compacted.messages,
    compressed: true,
    events: [
      { type: 'context_compression_start' },
      {
        type: 'context_compressed',
        originalCount: args.messages.length,
        newCount: compacted.messages.length,
        messages: compacted.messages
      }
    ]
  }
}
```

- [ ] **Step 4: Run main preflight tests**

Run:

```bash
npx vitest run src/main/cron/__tests__/context-compression-runtime.test.ts
```

Expected:

```text
PASS src/main/cron/__tests__/context-compression-runtime.test.ts
```

- [ ] **Step 5: Commit main preflight helper**

```bash
git add src/main/cron/context-compression-runtime.ts src/main/cron/__tests__/context-compression-runtime.test.ts
git commit -m "feat(main): add Claude compact preflight helper"
```

---

## Task 5: Wire main JS agent loop to the shared compact preflight

**Files:**
- Modify: `src/shared/agent-loop-types.ts`
- Modify: `src/main/cron/cron-agent-background.ts`
- Modify: `src/main/ipc/js-agent-runtime.ts`
- Modify: `src/main/ipc/__tests__/js-agent-runtime-compression.test.ts`

- [ ] **Step 1: Preserve compact metadata in shared loop messages**

Modify `src/shared/agent-loop-types.ts` `AgentLoopMessage` interface to include metadata:

```ts
export interface AgentLoopMessage {
  id: string
  role: 'system' | 'user' | 'assistant'
  content: string | AgentLoopContentBlock[]
  createdAt: number
  usage?: AgentTokenUsage
  providerResponseId?: string
  source?: string | null
  meta?: Record<string, unknown>
}
```

- [ ] **Step 2: Add main loop config compression shape**

Modify `src/main/cron/cron-agent-background.ts` `AgentLoopConfig` interface to include:

```ts
  contextCompression?: {
    config: MainRuntimeCompressionConfig
    buildPostCompactContext?: () => string
  }
```

Add imports near the existing shared imports:

```ts
import {
  maybeCompactMainRuntimeContext,
  type MainRuntimeCompressionConfig
} from './context-compression-runtime'
```

- [ ] **Step 3: Add main compact summarizer adapter**

In `src/main/cron/cron-agent-background.ts`, after `sendProviderMessage` and before `ProviderRequestError`, add:

```ts
async function runMainCompactTextRequest(args: {
  provider: ProviderConfig
  systemPrompt: string
  userPrompt: string
  signal?: AbortSignal
}): Promise<string> {
  const compactProvider: ProviderConfig = {
    ...args.provider,
    systemPrompt: args.systemPrompt,
    thinkingEnabled: false
  }
  let text = ''
  for await (const event of sendProviderMessage(
    [
      {
        id: 'main-claude-compact-request',
        role: 'user',
        content: args.userPrompt,
        createdAt: Date.now()
      }
    ],
    [],
    compactProvider,
    args.signal
  )) {
    if (event.type === 'text_delta') {
      text += event.text ?? ''
    }
    if (event.type === 'error') {
      throw new Error(event.error?.message ?? 'Main compact summarizer failed')
    }
  }
  return text
}
```

- [ ] **Step 4: Integrate preflight into main run loop**

In `src/main/cron/cron-agent-background.ts` inside `runAgentLoop`, directly after draining `config.messageQueue` and before `iteration += 1`, insert:

```ts
    if (config.contextCompression) {
      const contextState = await maybeCompactMainRuntimeContext({
        messages: conversationMessages,
        config: config.contextCompression.config,
        trigger: 'auto',
        postCompactContext: config.contextCompression.buildPostCompactContext?.(),
        signal: config.signal,
        summarize: async ({ systemPrompt, userPrompt, signal }) =>
          runMainCompactTextRequest({
            provider: config.provider,
            systemPrompt,
            userPrompt,
            signal
          }),
        createId: nanoid,
        now: Date.now
      })
      if (contextState.compressed) {
        for (const event of contextState.events) {
          yield event as InteractiveAgentEvent
        }
      }
      conversationMessages = contextState.messages as UnifiedMessage[]
    }
```

Keep the existing `config.signal.aborted` check immediately after this block.

- [ ] **Step 5: Pass compression config from JS runtime**

Modify `src/main/ipc/js-agent-runtime.ts`:

Add an import:

```ts
import type { MainRuntimeCompressionConfig } from '../cron/context-compression-runtime'
```

Extend `JsAgentRunRequest`:

```ts
  compression?: MainRuntimeCompressionConfig | null
```

Add `contextCompression` to `loopConfig` construction:

```ts
      ...(params.compression?.enabled
        ? {
            contextCompression: {
              config: params.compression
            }
          }
        : {}),
```

- [ ] **Step 6: Run forwarding and preflight tests**

Run:

```bash
npx vitest run src/main/ipc/__tests__/js-agent-runtime-compression.test.ts src/main/cron/__tests__/context-compression-runtime.test.ts
```

Expected:

```text
PASS src/main/ipc/__tests__/js-agent-runtime-compression.test.ts
PASS src/main/cron/__tests__/context-compression-runtime.test.ts
```

- [ ] **Step 7: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected:

```text
npm run typecheck:node exits 0
npm run typecheck:web exits 0
```

- [ ] **Step 8: Commit main loop wiring**

```bash
git add src/shared/agent-loop-types.ts src/main/cron/cron-agent-background.ts src/main/ipc/js-agent-runtime.ts src/main/ipc/__tests__/js-agent-runtime-compression.test.ts
git commit -m "feat(main): wire Claude compact into JS runtime"
```

---

## Task 6: Enable sidecar compression path from shared runtime

**Files:**
- Modify: `src/renderer/src/lib/agent/shared-runtime.ts`
- Modify: `src/renderer/src/lib/agent/__tests__/shared-runtime-sidecar-compression.test.ts`
- Modify: `src/renderer/src/lib/ipc/sidecar-protocol.ts`

- [ ] **Step 1: Strengthen sidecar test to ensure renderer fallback is not used for low-token context**

In `src/renderer/src/lib/agent/__tests__/shared-runtime-sidecar-compression.test.ts`, add this mock before importing `runSharedAgentRuntime`:

```ts
vi.mock('../agent-loop', () => ({
  runAgentLoop: vi.fn(async function* () {
    throw new Error('renderer loop should not run for low-token sidecar compression forwarding')
  })
}))
```

The existing test uses `contextTokens: 10`, below the Claude auto threshold. It must still call sidecar and include compression config.

- [ ] **Step 2: Run the sidecar test and verify it fails before routing change**

Run:

```bash
npx vitest run src/renderer/src/lib/agent/__tests__/shared-runtime-sidecar-compression.test.ts
```

Expected:

```text
FAIL src/renderer/src/lib/agent/__tests__/shared-runtime-sidecar-compression.test.ts
Expected sidecar request compression to match claude-code-compact-v1 config
```

- [ ] **Step 3: Forward compression config to sidecar request**

In `src/renderer/src/lib/agent/shared-runtime.ts`, replace this field in `buildSidecarAgentRunRequest`:

```ts
            compression: null,
```

with:

```ts
            compression: loopConfig.contextCompression?.config ?? null,
```

Do not change `shouldUseRendererLoopForCompression` in this task. That function still protects near-threshold renderer compaction for providers or runs that must compact before the sidecar request starts. Low-token sidecar runs now carry compression config so the main runtime can compact later as usage grows.

- [ ] **Step 4: Confirm sidecar protocol preserves compression shape**

In `src/renderer/src/lib/ipc/sidecar-protocol.ts`, keep the existing fields:

```ts
  compression?: CompressionConfig
```

and:

```ts
    ...(args.compression ? { compression: args.compression } : {}),
```

Keep the existing renderer-side `CompressionConfig` import unless Task 2 replaced renderer config exports with a shared alias. The request object must continue to serialize `enabled`, `contextLength`, `threshold`, `strategyId`, `preCompressThreshold`, and `reservedOutputBudget` unchanged.

- [ ] **Step 5: Run sidecar routing tests**

Run:

```bash
npx vitest run src/renderer/src/lib/agent/__tests__/shared-runtime-sidecar-compression.test.ts
```

Expected:

```text
PASS src/renderer/src/lib/agent/__tests__/shared-runtime-sidecar-compression.test.ts
```

- [ ] **Step 6: Commit sidecar routing change**

```bash
git add src/renderer/src/lib/agent/shared-runtime.ts src/renderer/src/lib/agent/__tests__/shared-runtime-sidecar-compression.test.ts src/renderer/src/lib/ipc/sidecar-protocol.ts
git commit -m "feat(sidecar): forward Claude compact config"
```

---

## Task 7: Verify compression events, final messages, and metadata across protocol adapters

**Files:**
- Modify: `src/main/cron/__tests__/context-compression-runtime.test.ts`
- Modify: `src/renderer/src/lib/agent/__tests__/shared-runtime-sidecar-compression.test.ts`
- Modify: `src/renderer/src/lib/agent/stream-event-adapter.ts`

- [ ] **Step 1: Add metadata preservation assertion to main preflight test**

In `src/main/cron/__tests__/context-compression-runtime.test.ts`, add this assertion inside `compacts above Claude auto threshold and returns compression events` after the `context_compressed` event assertion:

```ts
const compressedEvent = result.events.find((event) => event.type === 'context_compressed')
expect(compressedEvent && 'messages' in compressedEvent ? compressedEvent.messages[0]?.meta : null).toMatchObject({
  compactBoundary: {
    strategy: 'claude-code-compact-v1',
    trigger: 'auto'
  }
})
```

- [ ] **Step 2: Add renderer adapter assertion for context_compressed metadata**

In `src/renderer/src/lib/agent/__tests__/shared-runtime-sidecar-compression.test.ts`, add this import:

```ts
import { toAgentEvent } from '../stream-event-adapter'
```

Then add this test:

```ts
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
```

- [ ] **Step 3: Confirm stream event adapter does not strip context_compressed messages**

Open `src/renderer/src/lib/agent/stream-event-adapter.ts`. The `context_compressed` case must stay in the passthrough group:

```ts
    case 'context_compressed':
      return e as unknown as AgentEvent
```

If the case is missing, add it to the group that already contains `message_end`, `tool_use_generated`, `iteration_end`, and `request_debug`.

- [ ] **Step 4: Run protocol parity tests**

Run:

```bash
npx vitest run src/main/cron/__tests__/context-compression-runtime.test.ts src/renderer/src/lib/agent/__tests__/shared-runtime-sidecar-compression.test.ts
```

Expected:

```text
PASS src/main/cron/__tests__/context-compression-runtime.test.ts
PASS src/renderer/src/lib/agent/__tests__/shared-runtime-sidecar-compression.test.ts
```

- [ ] **Step 5: Commit protocol metadata verification**

```bash
git add src/main/cron/__tests__/context-compression-runtime.test.ts src/renderer/src/lib/agent/__tests__/shared-runtime-sidecar-compression.test.ts src/renderer/src/lib/agent/stream-event-adapter.ts
git commit -m "test(context): verify compact metadata across runtimes"
```

---

## Task 8: Run full context compression verification and commit final Phase 2 state

**Files:**
- Modify only files required by failing verification from Tasks 1-7.

- [ ] **Step 1: Run context test suite**

Run:

```bash
npm run test:agent-context
```

Expected:

```text
PASS src/shared/__tests__/claude-context-compression-core.test.ts
PASS src/main/cron/__tests__/context-compression-runtime.test.ts
PASS src/main/ipc/__tests__/js-agent-runtime-compression.test.ts
PASS src/renderer/src/lib/agent/__tests__/long-task-context.test.ts
PASS src/renderer/src/lib/agent/__tests__/claude-context-compression.test.ts
PASS src/renderer/src/lib/agent/__tests__/shared-runtime-sidecar-compression.test.ts
```

- [ ] **Step 2: Run long-task compression diagnostic**

Run:

```bash
npm run diagnose:long-task-compression
```

Expected:

```text
Long-task compression diagnostics completed successfully
```

If the script prints a different success line, record the exact line in the commit message body.

- [ ] **Step 3: Run context regression diagnostic**

Run:

```bash
npm run diagnose:context-regressions
```

Expected:

```text
Context regression diagnostics completed successfully
```

If the script prints a different success line, record the exact line in the commit message body.

- [ ] **Step 4: Run lint**

Run:

```bash
npm run lint
```

Expected:

```text
eslint exits with code 0
```

- [ ] **Step 5: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected:

```text
npm run typecheck:node exits 0
npm run typecheck:web exits 0
```

- [ ] **Step 6: Inspect worktree status**

Run:

```bash
git status --short
```

Expected: only intentional Phase 2 files are modified or untracked.

- [ ] **Step 7: Commit final verification fixes if any verification command required code changes**

If verification required fixes after Task 7, commit them:

```bash
git add src package.json
git commit -m "fix(context): stabilize runtime compact parity"
```

If no files changed after verification, do not create an empty commit.

- [ ] **Step 8: Record Phase 2 completion in task tracker**

Update the active task title to:

```text
Phase 2 计划执行：renderer/main/sidecar Claude Code Context 压缩 runtime parity 已完成；test/diagnostics/lint/typecheck 均通过
```

Do not mark the full session goal complete at this point because partial compact, hooks, prompt cache sharing, and relink metadata are still outstanding requirements from the full objective.
