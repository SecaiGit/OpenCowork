# Assistant Finalize and Single Input Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a single oversized assistant text response or a single oversized user input from entering the next model request unchanged, without truncating tool call structures.

**Architecture:** Add shared deterministic text guard helpers under `src/shared/claude-context-compression/`, then wire renderer agent-loop checkpoints before provider request and after assistant message finalization. The shared helpers only compact plain text payloads and fail closed for structured tool-use content that cannot be safely changed.

**Tech Stack:** TypeScript, Electron renderer agent loop, shared `UnifiedMessage` / `ClaudeCompactMessage`-compatible content shapes, Vitest, existing Phase 3 `classifyClaudeContextGate`, existing context estimation helpers, and existing renderer long-task context tests.

---

## Scope Check

This phase covers two narrow missing guards from `docs/superpowers/specs/2026-05-15-context-compression-missing-implementation.md`:

- assistant output finalize checkpoint for non-tool assistant text output;
- single user input oversized guard before the next provider request.

This phase does not implement full file externalization, partial compact, streaming continuation, session memory, hooks, prompt cache baseline, relink metadata, or a UI diagnostics panel. Full file externalization and map-reduce chunk summary remain follow-up work; this phase uses deterministic inline compaction to prevent request overflow.

## File Structure

### Shared compact core

- Create: `src/shared/claude-context-compression/text-guards.ts`
  - Owns deterministic plain-text compaction for oversized assistant text and user input.
  - Never edits `tool_use` blocks.
  - Returns explicit metadata for changed payloads and unsafe structured content.
- Modify: `src/shared/claude-context-compression/types.ts`
  - Adds skip reasons `assistant_output_too_large` and `unsafe_tool_boundary` for diagnostics.
- Modify: `src/shared/claude-context-compression/index.ts`
  - Exports `text-guards.ts`.
- Modify: `src/shared/__tests__/claude-context-compression-core.test.ts`
  - Adds tests for assistant text compaction, user input compaction, and refusal to compact tool-use assistant messages.

### Renderer runtime

- Modify: `src/renderer/src/lib/agent/types.ts`
  - Adds `context_payload_guarded` event for deterministic assistant/user text guards.
- Modify: `src/renderer/src/lib/agent/agent-loop.ts`
  - Runs single-input guard before the provider preflight gate.
  - Runs assistant finalize guard after assistant message construction and before appending it to `conversationMessages`.
  - Emits guard events for changed text payloads.
  - Leaves `tool_use` assistant messages unchanged and relies on the existing hard gate if the next request is still too large.
- Modify: `src/renderer/src/lib/agent/__tests__/long-task-context.test.ts`
  - Adds renderer tests for single user input guarding and assistant finalize guarding.

---

## Task 1: Add shared deterministic text guard helpers

**Files:**
- Create: `src/shared/claude-context-compression/text-guards.ts`
- Modify: `src/shared/claude-context-compression/types.ts`
- Modify: `src/shared/claude-context-compression/index.ts`
- Modify: `src/shared/__tests__/claude-context-compression-core.test.ts`

- [ ] **Step 1: Write failing shared text guard tests**

Append this block to `src/shared/__tests__/claude-context-compression-core.test.ts` inside the top-level `describe('shared Claude compact core', ...)` block:

```ts
describe('shared Claude text guards', () => {
  const guardConfig = {
    enabled: true,
    contextLength: 2_000,
    threshold: 0.8,
    strategyId: 'claude-code-compact-v1' as const,
    reservedOutputBudget: 200
  }

  it('compacts oversized assistant text without touching tool-use structures', () => {
    nextMessageId = 0
    const assistant = message('assistant', 'A'.repeat(10_000))

    const result = guardClaudeAssistantFinalizePayload(assistant, { config: guardConfig })

    expect(result.changed).toBe(true)
    expect(result.reason).toBe('assistant_output_too_large')
    expect(JSON.stringify(result.message)).toContain('[Assistant response compacted for context budget]')
    expect(JSON.stringify(result.message).length).toBeLessThan(JSON.stringify(assistant).length)
  })

  it('does not compact assistant tool-use messages', () => {
    nextMessageId = 0
    const assistant = message('assistant', [toolUse('call-1', 'Read')])

    const result = guardClaudeAssistantFinalizePayload(assistant, { config: guardConfig })

    expect(result.changed).toBe(false)
    expect(result.reason).toBe('unsafe_tool_boundary')
    expect(result.message).toBe(assistant)
  })

  it('compacts a single oversized user input while keeping the user role', () => {
    nextMessageId = 0
    const user = message('user', `BEGIN\n${'secret-free line\n'.repeat(5_000)}END`)

    const result = guardClaudeSingleInputPayload(user, { config: guardConfig })

    expect(result.changed).toBe(true)
    expect(result.reason).toBe('single_input_too_large')
    expect(result.message.role).toBe('user')
    expect(JSON.stringify(result.message)).toContain('[User input compacted for context budget]')
    expect(JSON.stringify(result.message).length).toBeLessThan(JSON.stringify(user).length)
  })
})
```

Add these imports to the existing import from `../claude-context-compression`:

```ts
guardClaudeAssistantFinalizePayload,
guardClaudeSingleInputPayload,
```

- [ ] **Step 2: Run the shared test and verify failure**

Run:

```bash
npm --prefix .worktrees/phase3-hard-gate-payload-fallback exec vitest -- --root .worktrees/phase3-hard-gate-payload-fallback run src/shared/__tests__/claude-context-compression-core.test.ts
```

Expected: FAIL because `guardClaudeAssistantFinalizePayload` and `guardClaudeSingleInputPayload` are not exported.

- [ ] **Step 3: Extend shared skip reasons**

In `src/shared/claude-context-compression/types.ts`, extend `ClaudeCompactSkipReason` with the two new diagnostic reasons immediately after `single_input_too_large`:

```ts
  | 'assistant_output_too_large'
  | 'unsafe_tool_boundary'
```

Expected resulting segment:

```ts
export type ClaudeCompactSkipReason =
  | 'insufficient_messages'
  | 'insufficient_compressible_messages'
  | 'recent_payload_too_large'
  | 'single_input_too_large'
  | 'assistant_output_too_large'
  | 'unsafe_tool_boundary'
  | 'hard_context_limit_exceeded'
  | 'reserved_output_budget_exceeded'
  | 'summarizer_prompt_too_long'
  | 'summarizer_failed'
  | 'circuit_breaker_open'
  | 'unsafe_boundary'
  | 'unsafe_summary_output'
  | 'cancelled'
  | 'unknown'
```

- [ ] **Step 4: Create shared text guard implementation**

Create `src/shared/claude-context-compression/text-guards.ts`:

```ts
import { getClaudeCompactBudget } from './budget'
import type {
  ClaudeCompactConfig,
  ClaudeCompactContentBlock,
  ClaudeCompactMessage,
  ClaudeCompactSkipReason
} from './types'

const ASSISTANT_MARKER = '[Assistant response compacted for context budget]'
const USER_MARKER = '[User input compacted for context budget]'
const DEFAULT_MAX_TEXT_CHARS = 12_000

export interface ClaudeTextGuardOptions {
  config?: Pick<ClaudeCompactConfig, 'contextLength' | 'reservedOutputBudget'> | null
  maxTextChars?: number
}

export interface ClaudeTextGuardResult {
  message: ClaudeCompactMessage
  changed: boolean
  reason?: ClaudeCompactSkipReason
  originalChars: number
  keptChars: number
}

function resolveMaxTextChars(options: ClaudeTextGuardOptions): number {
  if (Number.isFinite(options.maxTextChars) && (options.maxTextChars ?? 0) > 0) {
    return Math.max(1_000, Math.floor(options.maxTextChars!))
  }

  if (!options.config) return DEFAULT_MAX_TEXT_CHARS
  const budget = getClaudeCompactBudget(options.config)
  return Math.max(1_000, Math.min(DEFAULT_MAX_TEXT_CHARS, Math.floor(budget.effectiveContextWindow * 2)))
}

function compactText(value: string, marker: string, maxChars: number): { text: string; changed: boolean } {
  if (value.length <= maxChars) return { text: value, changed: false }

  const headChars = Math.max(300, Math.floor(maxChars * 0.45))
  const tailChars = Math.max(200, Math.floor(maxChars * 0.25))
  const head = value.slice(0, headChars).trimEnd()
  const tail = value.slice(-tailChars).trimStart()
  const text = [
    marker,
    `Original chars: ${value.length}`,
    `Retained head/tail chars: ${head.length + tail.length}`,
    `Omitted middle chars: ${Math.max(0, value.length - head.length - tail.length)}`,
    '',
    '## Head',
    head,
    '## Tail',
    tail
  ].join('\n')

  if (text.length <= maxChars) return { text, changed: true }
  return { text: `${marker}\n${text.slice(0, Math.max(0, maxChars - marker.length - 1))}`, changed: true }
}

function messageHasToolUse(message: ClaudeCompactMessage): boolean {
  return Array.isArray(message.content) && message.content.some((block) => block.type === 'tool_use')
}

function compactTextBlocks(
  blocks: ClaudeCompactContentBlock[],
  marker: string,
  maxChars: number
): { blocks: ClaudeCompactContentBlock[]; changed: boolean; originalChars: number; keptChars: number } {
  let changed = false
  let originalChars = 0
  let keptChars = 0

  const nextBlocks = blocks.map((block): ClaudeCompactContentBlock => {
    if (block.type !== 'text') return block
    originalChars += block.text.length
    const compacted = compactText(block.text, marker, maxChars)
    keptChars += compacted.text.length
    if (!compacted.changed) return block
    changed = true
    return { ...block, text: compacted.text }
  })

  return { blocks: changed ? nextBlocks : blocks, changed, originalChars, keptChars }
}

export function guardClaudeAssistantFinalizePayload(
  message: ClaudeCompactMessage,
  options: ClaudeTextGuardOptions = {}
): ClaudeTextGuardResult {
  if (message.role !== 'assistant') {
    return { message, changed: false, originalChars: 0, keptChars: 0 }
  }

  if (messageHasToolUse(message)) {
    return { message, changed: false, reason: 'unsafe_tool_boundary', originalChars: 0, keptChars: 0 }
  }

  const maxChars = resolveMaxTextChars(options)
  if (typeof message.content === 'string') {
    const compacted = compactText(message.content, ASSISTANT_MARKER, maxChars)
    return {
      message: compacted.changed ? { ...message, content: compacted.text } : message,
      changed: compacted.changed,
      reason: compacted.changed ? 'assistant_output_too_large' : undefined,
      originalChars: message.content.length,
      keptChars: compacted.text.length
    }
  }

  const compacted = compactTextBlocks(message.content, ASSISTANT_MARKER, maxChars)
  return {
    message: compacted.changed ? { ...message, content: compacted.blocks } : message,
    changed: compacted.changed,
    reason: compacted.changed ? 'assistant_output_too_large' : undefined,
    originalChars: compacted.originalChars,
    keptChars: compacted.keptChars
  }
}

export function guardClaudeSingleInputPayload(
  message: ClaudeCompactMessage,
  options: ClaudeTextGuardOptions = {}
): ClaudeTextGuardResult {
  if (message.role !== 'user') {
    return { message, changed: false, originalChars: 0, keptChars: 0 }
  }

  const maxChars = resolveMaxTextChars(options)
  if (typeof message.content === 'string') {
    const compacted = compactText(message.content, USER_MARKER, maxChars)
    return {
      message: compacted.changed ? { ...message, content: compacted.text } : message,
      changed: compacted.changed,
      reason: compacted.changed ? 'single_input_too_large' : undefined,
      originalChars: message.content.length,
      keptChars: compacted.text.length
    }
  }

  const compacted = compactTextBlocks(message.content, USER_MARKER, maxChars)
  return {
    message: compacted.changed ? { ...message, content: compacted.blocks } : message,
    changed: compacted.changed,
    reason: compacted.changed ? 'single_input_too_large' : undefined,
    originalChars: compacted.originalChars,
    keptChars: compacted.keptChars
  }
}
```

- [ ] **Step 5: Export shared text guards**

Add this export to `src/shared/claude-context-compression/index.ts`:

```ts
export * from './text-guards'
```

- [ ] **Step 6: Run shared tests and typecheck**

Run:

```bash
npm --prefix .worktrees/phase3-hard-gate-payload-fallback exec vitest -- --root .worktrees/phase3-hard-gate-payload-fallback run src/shared/__tests__/claude-context-compression-core.test.ts
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run typecheck:node
```

Expected: both PASS.

- [ ] **Step 7: Commit shared text guards**

Run:

```bash
git -C .worktrees/phase3-hard-gate-payload-fallback add src/shared/claude-context-compression/text-guards.ts src/shared/claude-context-compression/types.ts src/shared/claude-context-compression/index.ts src/shared/__tests__/claude-context-compression-core.test.ts
git -C .worktrees/phase3-hard-gate-payload-fallback commit -m "feat(context): add assistant and input text guards"
```

## Task 2: Wire single user input guard into renderer preflight

**Files:**
- Modify: `src/renderer/src/lib/agent/types.ts`
- Modify: `src/renderer/src/lib/agent/agent-loop.ts`
- Modify: `src/renderer/src/lib/agent/__tests__/long-task-context.test.ts`

- [ ] **Step 1: Add renderer event type for guarded payloads**

In `src/renderer/src/lib/agent/types.ts`, add this union member before `context_compression_deferred`:

```ts
  | {
      type: 'context_payload_guarded'
      checkpoint: 'before_model_request' | 'assistant_finalize'
      reason: CompressionSkipReason
      originalChars: number
      keptChars: number
      messageId: string
    }
```

- [ ] **Step 2: Write failing renderer single input guard test**

Append this test to `describe('runAgentLoop context gate', ...)` in `src/renderer/src/lib/agent/__tests__/long-task-context.test.ts`:

```ts
  it('guards a single oversized user input before sending the provider request', async () => {
    const events: AgentEvent[] = []
    const abortController = new AbortController()
    let sentMessages: UnifiedMessage[] = []
    const providerSend = vi.fn(async function* (messages: UnifiedMessage[]) {
      sentMessages = messages
      yield { type: 'text_delta', text: 'ok' }
      yield { type: 'message_end' }
    })

    vi.mocked(createProvider).mockReturnValue({ sendMessage: providerSend } as never)

    const messages: UnifiedMessage[] = [
      {
        id: 'm-user-large',
        role: 'user',
        content: 'large-user-input\n'.repeat(10_000),
        createdAt: 1
      }
    ]

    for await (const event of runAgentLoop(
      messages,
      {
        maxIterations: 1,
        provider: providerConfig,
        tools: [],
        systemPrompt: 'system',
        signal: abortController.signal,
        contextCompression: {
          config: {
            enabled: true,
            contextLength: 20_000,
            threshold: 0.8,
            strategyId: 'claude-code-compact-v1',
            reservedOutputBudget: 2_000
          },
          compressFn: async (input) => input
        }
      },
      {
        sessionId: 'session-1',
        workingFolder: 'C:/projects/OpenCowork',
        signal: abortController.signal,
        ipc: { invoke: vi.fn(), send: vi.fn(), on: vi.fn(() => () => {}) }
      },
      undefined
    )) {
      events.push(event)
    }

    expect(providerSend).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(sentMessages)).toContain('[User input compacted for context budget]')
    expect(JSON.stringify(sentMessages)).not.toContain('large-user-input\nlarge-user-input\nlarge-user-input\nlarge-user-input')
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'context_payload_guarded',
          checkpoint: 'before_model_request',
          reason: 'single_input_too_large',
          messageId: 'm-user-large'
        })
      ])
    )
  })
```

- [ ] **Step 3: Import shared input guard in `agent-loop.ts`**

Update the shared import in `src/renderer/src/lib/agent/agent-loop.ts`:

```ts
import {
  classifyClaudeContextGate,
  guardClaudeSingleInputPayload
} from '../../../../shared/claude-context-compression'
```

- [ ] **Step 4: Add helper to guard recent user inputs**

Add this helper near `normalizeCompressionResult`:

```ts
function guardUserInputsForContext(messages: UnifiedMessage[], config: AgentLoopConfig['contextCompression']['config']): {
  messages: UnifiedMessage[]
  events: Array<Extract<AgentEvent, { type: 'context_payload_guarded' }>>
} {
  let changed = false
  const events: Array<Extract<AgentEvent, { type: 'context_payload_guarded' }>> = []
  const nextMessages = messages.map((message) => {
    const guarded = guardClaudeSingleInputPayload(message, { config })
    if (!guarded.changed || !guarded.reason) return message
    changed = true
    events.push({
      type: 'context_payload_guarded',
      checkpoint: 'before_model_request',
      reason: guarded.reason,
      originalChars: guarded.originalChars,
      keptChars: guarded.keptChars,
      messageId: message.id
    })
    return guarded.message as UnifiedMessage
  })

  return { messages: changed ? nextMessages : messages, events }
}
```

- [ ] **Step 5: Call input guard before budget snapshot**

Inside the existing `if (config.contextCompression) {` block in `runAgentLoop`, immediately after `const cc = config.contextCompression`, add:

```ts
        const guardedInputs = guardUserInputsForContext(conversationMessages, cc.config)
        if (guardedInputs.events.length > 0) {
          conversationMessages = [...guardedInputs.messages]
          for (const event of guardedInputs.events) {
            yield event
          }
        }
```

- [ ] **Step 6: Run renderer test and typecheck**

Run:

```bash
npm --prefix .worktrees/phase3-hard-gate-payload-fallback exec vitest -- --root .worktrees/phase3-hard-gate-payload-fallback run src/renderer/src/lib/agent/__tests__/long-task-context.test.ts
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run typecheck:web
```

Expected: both PASS.

- [ ] **Step 7: Commit renderer input guard**

Run:

```bash
git -C .worktrees/phase3-hard-gate-payload-fallback add src/renderer/src/lib/agent/types.ts src/renderer/src/lib/agent/agent-loop.ts src/renderer/src/lib/agent/__tests__/long-task-context.test.ts
git -C .worktrees/phase3-hard-gate-payload-fallback commit -m "feat(agent): guard oversized user inputs before requests"
```

## Task 3: Wire assistant finalize guard into renderer loop

**Files:**
- Modify: `src/renderer/src/lib/agent/agent-loop.ts`
- Modify: `src/renderer/src/lib/agent/__tests__/long-task-context.test.ts`

- [ ] **Step 1: Write failing assistant finalize guard test**

Append this test to `describe('runAgentLoop context gate', ...)` in `src/renderer/src/lib/agent/__tests__/long-task-context.test.ts`:

```ts
  it('guards oversized assistant text at finalize before appending it to final messages', async () => {
    const events: AgentEvent[] = []
    const finalMessages: UnifiedMessage[][] = []
    const abortController = new AbortController()
    const providerSend = vi.fn(async function* () {
      yield { type: 'text_delta', text: 'assistant-output\n'.repeat(10_000) }
      yield { type: 'message_end' }
    })

    vi.mocked(createProvider).mockReturnValue({ sendMessage: providerSend } as never)

    for await (const event of runAgentLoop(
      [message('user', 'write a long answer')],
      {
        maxIterations: 1,
        provider: providerConfig,
        tools: [],
        systemPrompt: 'system',
        signal: abortController.signal,
        captureFinalMessages: (messages) => finalMessages.push(messages),
        contextCompression: {
          config: {
            enabled: true,
            contextLength: 20_000,
            threshold: 0.8,
            strategyId: 'claude-code-compact-v1',
            reservedOutputBudget: 2_000
          },
          compressFn: async (input) => input
        }
      },
      {
        sessionId: 'session-1',
        workingFolder: 'C:/projects/OpenCowork',
        signal: abortController.signal,
        ipc: { invoke: vi.fn(), send: vi.fn(), on: vi.fn(() => () => {}) }
      },
      undefined
    )) {
      events.push(event)
    }

    const finalSerialized = JSON.stringify(finalMessages.at(-1))
    expect(finalSerialized).toContain('[Assistant response compacted for context budget]')
    expect(finalSerialized).not.toContain('assistant-output\nassistant-output\nassistant-output\nassistant-output')
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'context_payload_guarded',
          checkpoint: 'assistant_finalize',
          reason: 'assistant_output_too_large'
        })
      ])
    )
    expect(events.at(-1)).toMatchObject({ type: 'loop_end', reason: 'completed' })
  })
```

- [ ] **Step 2: Import assistant finalize guard**

Update the shared import in `src/renderer/src/lib/agent/agent-loop.ts`:

```ts
import {
  classifyClaudeContextGate,
  guardClaudeAssistantFinalizePayload,
  guardClaudeSingleInputPayload
} from '../../../../shared/claude-context-compression'
```

- [ ] **Step 3: Guard assistant message after construction**

Replace this block in `agent-loop.ts`:

```ts
      const assistantMsg: UnifiedMessage = {
        id: nanoid(),
        role: 'assistant',
        content: assistantContentBlocks.length > 0 ? assistantContentBlocks : '',
        createdAt: Date.now(),
        ...(assistantUsage ? { usage: assistantUsage } : {}),
        ...(providerResponseId ? { providerResponseId } : {})
      }
      conversationMessages.push(assistantMsg)
```

with:

```ts
      const assistantMsg: UnifiedMessage = {
        id: nanoid(),
        role: 'assistant',
        content: assistantContentBlocks.length > 0 ? assistantContentBlocks : '',
        createdAt: Date.now(),
        ...(assistantUsage ? { usage: assistantUsage } : {}),
        ...(providerResponseId ? { providerResponseId } : {})
      }
      const finalizedAssistant = config.contextCompression
        ? guardClaudeAssistantFinalizePayload(assistantMsg, { config: config.contextCompression.config })
        : { message: assistantMsg, changed: false, originalChars: 0, keptChars: 0 }
      if (finalizedAssistant.changed && finalizedAssistant.reason) {
        yield {
          type: 'context_payload_guarded',
          checkpoint: 'assistant_finalize',
          reason: finalizedAssistant.reason,
          originalChars: finalizedAssistant.originalChars,
          keptChars: finalizedAssistant.keptChars,
          messageId: assistantMsg.id
        }
      }
      conversationMessages.push(finalizedAssistant.message as UnifiedMessage)
```

- [ ] **Step 4: Run renderer test and typecheck**

Run:

```bash
npm --prefix .worktrees/phase3-hard-gate-payload-fallback exec vitest -- --root .worktrees/phase3-hard-gate-payload-fallback run src/renderer/src/lib/agent/__tests__/long-task-context.test.ts
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run typecheck:web
```

Expected: both PASS.

- [ ] **Step 5: Commit renderer assistant finalize guard**

Run:

```bash
git -C .worktrees/phase3-hard-gate-payload-fallback add src/renderer/src/lib/agent/agent-loop.ts src/renderer/src/lib/agent/__tests__/long-task-context.test.ts
git -C .worktrees/phase3-hard-gate-payload-fallback commit -m "feat(agent): guard oversized assistant finalization"
```

## Task 4: Aggregate verification and review

**Files:**
- No implementation files are expected to change unless tests expose stale expectations.

- [ ] **Step 1: Run focused test matrix**

Run:

```bash
npm --prefix .worktrees/phase3-hard-gate-payload-fallback exec vitest -- --root .worktrees/phase3-hard-gate-payload-fallback run src/shared/__tests__/claude-context-compression-core.test.ts
npm --prefix .worktrees/phase3-hard-gate-payload-fallback exec vitest -- --root .worktrees/phase3-hard-gate-payload-fallback run src/renderer/src/lib/agent/__tests__/long-task-context.test.ts
```

Expected: both PASS.

- [ ] **Step 2: Run aggregate context tests and diagnostics**

Run:

```bash
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run test:agent-context
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run diagnose:context-regressions
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run diagnose:long-task-compression
```

Expected: all PASS. If diagnostics need new expected event names, update only diagnostics or tests directly related to `context_payload_guarded`.

- [ ] **Step 3: Run lint and typecheck**

Run:

```bash
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run lint
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run typecheck
```

Expected: `typecheck` PASS. `lint` exits 0; existing worktree CRLF warnings may remain but no errors should be introduced.

- [ ] **Step 4: Request code review**

Use `requesting-code-review` and ask the reviewer to check:

- assistant finalize guard never truncates `tool_use` structures;
- single user input guard preserves `role: 'user'` and message id;
- guarded messages still pass existing hard gate before provider requests;
- no secret-like content is introduced by the guard markers;
- renderer events expose enough metadata without breaking existing consumers.

- [ ] **Step 5: Fix review feedback before starting another phase**

Fix Critical and Important review feedback in separate commits before planning partial compact.

---

## Verification Checklist

Before considering this phase complete, run:

```bash
npm --prefix .worktrees/phase3-hard-gate-payload-fallback exec vitest -- --root .worktrees/phase3-hard-gate-payload-fallback run src/shared/__tests__/claude-context-compression-core.test.ts
npm --prefix .worktrees/phase3-hard-gate-payload-fallback exec vitest -- --root .worktrees/phase3-hard-gate-payload-fallback run src/renderer/src/lib/agent/__tests__/long-task-context.test.ts
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run test:agent-context
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run diagnose:context-regressions
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run diagnose:long-task-compression
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run lint
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run typecheck
```

Expected final state:

- a single oversized user input is compacted before provider request construction;
- a non-tool assistant long text output is compacted before being appended to final conversation state;
- assistant messages containing `tool_use` are not compacted by this guard;
- the existing request hard gate still blocks if deterministic text guards cannot make the next request safe;
- existing Phase 3 and Phase 4 payload fallback / deferred checkpoint behavior remains green.

## Follow-up Plans After This Phase

After this phase passes review, create separate plans for:

1. partial compact / from-up-to compact inside a long current task round;
2. streaming output continuation with stop/checkpoint/resume;
3. full file externalization and chunk map-reduce for oversized user inputs;
4. UI reason taxonomy and diagnostics panel;
5. session memory, hooks, prompt cache baseline, and relink metadata.
