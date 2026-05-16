# Checkpoint Auto Compact Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add checkpoint-aware compression metadata so unsafe or insufficiently compressible tool chains over the auto threshold are diagnosed as deferred work instead of being reported as successful compression, while preserving hard-gate blocking before provider requests.

**Architecture:** Reuse Phase 3 shared hard-gate and payload fallback. Extend renderer compression callbacks to return compression metadata, emit a deferred checkpoint event when auto compact is attempted but cannot safely shrink the current tool chain, and mirror the deferred event shape in the main runtime preflight. This phase does not implement partial compact or split an unsafe tool chain.

**Tech Stack:** TypeScript, Electron renderer agent loop, Electron main cron runtime, Vitest, existing `CompressionResult`, `ClaudeCompactResult`, `runClaudeCompact`, `classifyClaudeContextGate`, and Phase 3 payload fallback.

---

## Scope Check

This phase covers the next narrow slice from `docs/superpowers/specs/2026-05-15-context-compression-missing-implementation.md`:

- checkpoint observability when context pressure crosses the Claude auto compact threshold;
- no false `context_compressed` event when the compact engine returns `compressed: false`;
- renderer loop compatibility with metadata-aware `compressFn` results;
- main runtime `context_compression_deferred` event for non-blocking auto compact skips;
- tests for the case where the current tool chain cannot be safely summarized but the next request is still below hard/reserved blocking limits.

This phase does not implement partial compact, assistant output truncation, session memory, hooks, prompt cache baseline management, relink metadata, or a UI diagnostics panel. Those remain separate follow-up plans.

## File Structure

### Renderer runtime

- Modify: `src/renderer/src/lib/agent/types.ts`
  - Adds `AgentLoopCompressionResult` so `compressFn` can return either the legacy message array or `{ messages, result }` metadata.
  - Adds `context_compression_deferred` event to distinguish non-blocking auto compact skips from successful compression.
- Modify: `src/renderer/src/lib/agent/context-compression-runtime.ts`
  - Returns full `compressMessages(...)` output instead of discarding `CompressionResult` metadata.
- Modify: `src/renderer/src/hooks/use-chat-actions.ts`
  - Returns full `compressMessages(...)` output for chat-driven agent loops.
- Modify: `src/renderer/src/lib/agent/agent-loop.ts`
  - Normalizes legacy and metadata-aware compression callback results.
  - Emits `context_compressed` only when `result.compressed !== false`.
  - Emits `context_compression_deferred` when auto compact runs at checkpoint but returns `compressed: false` and the final hard gate is not blocking.
- Modify: `src/renderer/src/lib/agent/__tests__/long-task-context.test.ts`
  - Adds renderer agent-loop tests for deferred non-blocking auto compact and no false compressed event.

### Main runtime

- Modify: `src/main/cron/context-compression-runtime.ts`
  - Adds `context_compression_deferred` event when `runClaudeCompact` returns `compressed: false` after auto-threshold preflight but final gate is not blocking.
- Modify: `src/main/cron/__tests__/context-compression-runtime.test.ts`
  - Adds a main-runtime test for non-blocking deferred compact when a current tool round has no compressible historical range.

---

## Task 1: Add metadata-aware renderer compression callback types

**Files:**
- Modify: `src/renderer/src/lib/agent/types.ts`
- Modify: `src/renderer/src/lib/agent/context-compression-runtime.ts`
- Modify: `src/renderer/src/hooks/use-chat-actions.ts`

- [ ] **Step 1: Extend renderer agent-loop compression types**

In `src/renderer/src/lib/agent/types.ts`, replace the compression import:

```ts
import type { CompressionConfig } from './context-compression'
```

with:

```ts
import type { CompressionConfig, CompressionResult, CompressionSkipReason } from './context-compression'
```

Add this type before `export interface AgentLoopConfig`:

```ts
export type AgentLoopCompressionResult =
  | UnifiedMessage[]
  | {
      messages: UnifiedMessage[]
      result: CompressionResult
    }
```

Replace the `contextCompression.compressFn` return type block with:

```ts
  /** Context compression configuration */
  contextCompression?: {
    config: CompressionConfig
    /** Compress messages using the main model and return metadata when the strategy can report it. */
    compressFn: (
      messages: UnifiedMessage[],
      trigger?: 'auto' | 'manual',
      preTokens?: number
    ) => Promise<AgentLoopCompressionResult>
  }
```

Add this `AgentEvent` union member immediately before `{ type: 'context_compression_start' }`:

```ts
  | {
      type: 'context_compression_deferred'
      checkpoint: 'before_model_request'
      reason: CompressionSkipReason
      inputTokens: number
      contextLength: number
      reservedOutputTokens: number
      blockingNextRequest: boolean
    }
```

- [ ] **Step 2: Return compression metadata from the runtime adapter**

In `src/renderer/src/lib/agent/context-compression-runtime.ts`, replace the `compressFn` body:

```ts
    compressFn: async (messages: UnifiedMessage[]) => {
      const { messages: compressed } = await compressMessages(
        messages,
        providerConfig,
        signal,
        undefined,
        undefined,
        undefined,
        'manual',
        0,
        config
      )
      return compressed
    }
```

with:

```ts
    compressFn: async (messages: UnifiedMessage[]) =>
      compressMessages(messages, providerConfig, signal, undefined, undefined, undefined, 'manual', 0, config)
```

- [ ] **Step 3: Return compression metadata from chat agent wiring**

In `src/renderer/src/hooks/use-chat-actions.ts`, replace this block inside the `compressFn` callback:

```ts
                          const { messages: compressed } = await compressMessages(
                            msgs,
                            agentProviderConfig,
                            abortController.signal,
                            undefined,
                            undefined,
                            undefined,
                            trigger,
                            preTokens,
                            compressionConfig,
                            postCompactContext
                          )
                          return compressed
```

with:

```ts
                          return compressMessages(
                            msgs,
                            agentProviderConfig,
                            abortController.signal,
                            undefined,
                            undefined,
                            undefined,
                            trigger,
                            preTokens,
                            compressionConfig,
                            postCompactContext
                          )
```

- [ ] **Step 4: Run renderer typecheck for expected failures**

Run:

```bash
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run typecheck:web
```

Expected: FAIL until `agent-loop.ts` normalizes `AgentLoopCompressionResult` in Task 2.

- [ ] **Step 5: Do not commit yet**

Keep this task uncommitted until Task 2 compiles and tests pass, because Task 1 only changes types and adapters.

## Task 2: Emit renderer deferred checkpoint events and avoid false compression events

**Files:**
- Modify: `src/renderer/src/lib/agent/agent-loop.ts`
- Modify: `src/renderer/src/lib/agent/__tests__/long-task-context.test.ts`
- Commit with Task 1 files.

- [ ] **Step 1: Write the failing renderer deferred checkpoint test**

Append this test to `describe('runAgentLoop context gate', ...)` in `src/renderer/src/lib/agent/__tests__/long-task-context.test.ts`:

```ts
  it('emits a deferred checkpoint event instead of a false compressed event when auto compact cannot shrink a safe request', async () => {
    const events: AgentEvent[] = []
    const abortController = new AbortController()
    const providerSend = vi.fn(async function* () {
      yield { type: 'text_delta', text: 'continued safely' }
      yield { type: 'message_end' }
    })
    const compressFn = vi.fn(async (input: UnifiedMessage[]) => ({
      messages: input,
      result: {
        compressed: false,
        originalCount: input.length,
        newCount: input.length,
        reason: 'insufficient_compressible_messages' as const
      }
    }))

    vi.mocked(createProvider).mockReturnValue({ sendMessage: providerSend } as never)

    const messages: UnifiedMessage[] = [
      {
        id: 'm-soft-pressure',
        role: 'user',
        content: 'current task is large but still request-safe',
        createdAt: 1,
        usage: { inputTokens: 0, outputTokens: 0, contextTokens: 170_000 }
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
            contextLength: 200_000,
            threshold: 0.8,
            strategyId: 'claude-code-compact-v1',
            reservedOutputBudget: 20_000
          },
          compressFn
        }
      },
      {
        sessionId: 'session-1',
        workingFolder: 'C:/projects/OpenCowork',
        signal: abortController.signal,
        ipc: {
          invoke: vi.fn(),
          send: vi.fn(),
          on: vi.fn(() => () => {})
        }
      },
      undefined
    )) {
      events.push(event)
    }

    expect(compressFn).toHaveBeenCalledTimes(1)
    expect(providerSend).toHaveBeenCalledTimes(1)
    expect(events.some((event) => event.type === 'context_compressed')).toBe(false)
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'context_compression_deferred',
          checkpoint: 'before_model_request',
          reason: 'insufficient_compressible_messages',
          blockingNextRequest: false,
          inputTokens: 170_000,
          contextLength: 200_000,
          reservedOutputTokens: 20_000
        })
      ])
    )
    expect(events.at(-1)).toMatchObject({ type: 'loop_end', reason: 'completed' })
  })
```

- [ ] **Step 2: Run the renderer long-task test and verify failure**

Run:

```bash
npm --prefix .worktrees/phase3-hard-gate-payload-fallback exec vitest -- --root .worktrees/phase3-hard-gate-payload-fallback run src/renderer/src/lib/agent/__tests__/long-task-context.test.ts
```

Expected: FAIL because `context_compression_deferred` is not emitted and `agent-loop.ts` still treats every `compressFn` result as a message array.

- [ ] **Step 3: Normalize compression callback results in `agent-loop.ts`**

In `src/renderer/src/lib/agent/agent-loop.ts`, update the imports from `./types`:

```ts
import type { AgentEvent, AgentLoopCompressionResult, AgentLoopConfig, ToolCallState } from './types'
```

Add this helper near `createContextGateError`:

```ts
function normalizeCompressionResult(value: AgentLoopCompressionResult): {
  messages: UnifiedMessage[]
  result?: Extract<AgentLoopCompressionResult, { messages: UnifiedMessage[] }>['result']
} {
  return Array.isArray(value) ? { messages: value } : value
}
```

- [ ] **Step 4: Emit deferred instead of false compressed event**

In `agent-loop.ts`, replace the current compression call block:

```ts
            const originalCount = conversationMessages.length
            const compressedMessages = await cc.compressFn(
              conversationMessages,
              'auto',
              conservativeContextTokens
            )
            // Keep loop-local history mutable even if external stores freeze shared arrays.
            conversationMessages = [...compressedMessages]
            estimatedReplayTokens = estimateMessagesTokens(conversationMessages)
            lastObservedContextTokens = 0
            fullCompressionApplied = true
            yield {
              type: 'context_compressed',
              originalCount,
              newCount: conversationMessages.length,
              messages: [...conversationMessages]
            }
```

with:

```ts
            const originalCount = conversationMessages.length
            const compression = normalizeCompressionResult(
              await cc.compressFn(conversationMessages, 'auto', conservativeContextTokens)
            )
            // Keep loop-local history mutable even if external stores freeze shared arrays.
            conversationMessages = [...compression.messages]
            estimatedReplayTokens = estimateMessagesTokens(conversationMessages)
            const compressed = compression.result?.compressed ?? true
            const skipReason = compression.result?.reason ?? 'unknown'
            if (compressed) {
              lastObservedContextTokens = 0
              fullCompressionApplied = true
              yield {
                type: 'context_compressed',
                originalCount,
                newCount: conversationMessages.length,
                messages: [...conversationMessages]
              }
            } else {
              yield {
                type: 'context_compression_deferred',
                checkpoint: 'before_model_request',
                reason: skipReason,
                inputTokens: conservativeContextTokens,
                contextLength: cc.config.contextLength,
                reservedOutputTokens: cc.config.reservedOutputBudget ?? 20_000,
                blockingNextRequest: false
              }
            }
```

- [ ] **Step 5: Run renderer tests and typecheck**

Run:

```bash
npm --prefix .worktrees/phase3-hard-gate-payload-fallback exec vitest -- --root .worktrees/phase3-hard-gate-payload-fallback run src/renderer/src/lib/agent/__tests__/long-task-context.test.ts
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run typecheck:web
```

Expected: both PASS.

- [ ] **Step 6: Commit renderer checkpoint metadata changes**

Run:

```bash
git -C .worktrees/phase3-hard-gate-payload-fallback add src/renderer/src/lib/agent/types.ts src/renderer/src/lib/agent/context-compression-runtime.ts src/renderer/src/hooks/use-chat-actions.ts src/renderer/src/lib/agent/agent-loop.ts src/renderer/src/lib/agent/__tests__/long-task-context.test.ts
git -C .worktrees/phase3-hard-gate-payload-fallback commit -m "feat(agent): report deferred context checkpoints"
```

## Task 3: Add main runtime deferred checkpoint events

**Files:**
- Modify: `src/main/cron/context-compression-runtime.ts`
- Modify: `src/main/cron/__tests__/context-compression-runtime.test.ts`

- [ ] **Step 1: Write the failing main runtime deferred test**

Append this test to `describe('main runtime context compression preflight', ...)` in `src/main/cron/__tests__/context-compression-runtime.test.ts`:

```ts
  it('reports a deferred checkpoint when auto compact cannot shrink a non-blocking current tool round', async () => {
    nextMessageId = 0
    const summarize = vi.fn()
    const messages = [
      message('assistant', [toolUse('current')]),
      message('user', [toolResult('current', 'ok')]),
      message('assistant', 'continue current task'),
      message('assistant', 'still in current task'),
      message('assistant', 'prepare next step'),
      {
        ...message('assistant', 'awaiting next step'),
        usage: { inputTokens: 0, outputTokens: 0, contextTokens: 170_000 }
      }
    ]

    const result = await maybeCompactMainRuntimeContext({
      messages,
      config,
      trigger: 'auto',
      summarize
    })

    expect(result.compressed).toBe(false)
    expect(result.blocked).toBeUndefined()
    expect(result.messages).toBe(messages)
    expect(summarize).not.toHaveBeenCalled()
    expect(result.events).toEqual([
      expect.objectContaining({
        type: 'context_compression_deferred',
        reason: 'insufficient_compressible_messages',
        inputTokens: 170_000,
        contextLength: 200_000,
        reservedOutputTokens: 20_000,
        blockingNextRequest: false
      })
    ])
  })
```

- [ ] **Step 2: Run the main runtime test and verify failure**

Run:

```bash
npm --prefix .worktrees/phase3-hard-gate-payload-fallback exec vitest -- --root .worktrees/phase3-hard-gate-payload-fallback run src/main/cron/__tests__/context-compression-runtime.test.ts
```

Expected: FAIL because `context_compression_deferred` is not part of `MainRuntimeCompressionEvent` and no event is returned when `runClaudeCompact` returns `compressed: false`.

- [ ] **Step 3: Extend main runtime event types**

In `src/main/cron/context-compression-runtime.ts`, add `type ClaudeCompactSkipReason` to the import list from `../../shared/claude-context-compression`.

Add this event member to `MainRuntimeCompressionEvent` before `context_compression_blocked`:

```ts
  | {
      type: 'context_compression_deferred'
      reason: ClaudeCompactSkipReason
      inputTokens: number
      contextLength: number
      reservedOutputTokens: number
      blockingNextRequest: boolean
    }
```

- [ ] **Step 4: Return a deferred event for non-blocking compact skips**

In `maybeCompactMainRuntimeContext`, replace:

```ts
  if (!compacted.result.compressed) {
    return { messages: candidateMessages, compressed: false, events: [] }
  }
```

with:

```ts
  if (!compacted.result.compressed) {
    return {
      messages: candidateMessages,
      compressed: false,
      events: [
        {
          type: 'context_compression_deferred',
          reason: compacted.result.reason ?? 'unknown',
          inputTokens: finalGate.inputTokens,
          contextLength: finalGate.contextLength,
          reservedOutputTokens: finalGate.reservedOutputTokens,
          blockingNextRequest: false
        }
      ]
    }
  }
```

- [ ] **Step 5: Run main runtime tests and typecheck**

Run:

```bash
npm --prefix .worktrees/phase3-hard-gate-payload-fallback exec vitest -- --root .worktrees/phase3-hard-gate-payload-fallback run src/main/cron/__tests__/context-compression-runtime.test.ts
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run typecheck:node
```

Expected: both PASS.

- [ ] **Step 6: Commit main runtime deferred checkpoint events**

Run:

```bash
git -C .worktrees/phase3-hard-gate-payload-fallback add src/main/cron/context-compression-runtime.ts src/main/cron/__tests__/context-compression-runtime.test.ts
git -C .worktrees/phase3-hard-gate-payload-fallback commit -m "feat(main): report deferred context checkpoints"
```

## Task 4: Run aggregate verification and request review

**Files:**
- No source file changes unless a test expectation fails due the new deferred event.

- [ ] **Step 1: Run aggregate context tests**

Run:

```bash
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run test:agent-context
```

Expected: PASS.

- [ ] **Step 2: Run diagnostic scripts**

Run:

```bash
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run diagnose:context-regressions
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run diagnose:long-task-compression
```

Expected: both scripts PASS.

- [ ] **Step 3: Run lint and typecheck**

Run:

```bash
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run lint
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run typecheck
```

Expected: both commands exit 0. The existing Windows worktree CRLF Prettier warnings may remain in lint output, but lint must report 0 errors.

- [ ] **Step 4: Commit verification expectation updates**

When Step 1 or Step 2 changes only expectations for `context_compression_deferred`, commit them with:

```bash
git -C .worktrees/phase3-hard-gate-payload-fallback add src/main/ipc/__tests__/js-agent-runtime-compression.test.ts src/renderer/src/lib/agent/__tests__/shared-runtime-sidecar-compression.test.ts scripts/diagnose-context-regressions.mjs scripts/diagnose-long-task-context-compression.mjs
git -C .worktrees/phase3-hard-gate-payload-fallback commit -m "test(context): cover deferred checkpoint diagnostics"
```

When Step 1 and Step 2 do not change files, skip this commit and record the clean status in the final report.

- [ ] **Step 5: Request final implementation review**

Dispatch a code-reviewer subagent with this scope:

```text
Review Phase 4 checkpoint metadata implementation. Confirm renderer and main runtimes report deferred checkpoint events when auto compact cannot safely shrink the current tool chain, do not emit false context_compressed events for compressed=false results, preserve hard-gate blocking behavior from Phase 3, and do not implement partial compact or unsafe tool-chain splitting.
```

Expected: reviewer returns `APPROVED` or lists Critical/Important feedback. Fix Critical/Important feedback before starting partial compact.

---

## Verification Checklist

Run these commands before considering this phase complete:

```bash
npm --prefix .worktrees/phase3-hard-gate-payload-fallback exec vitest -- --root .worktrees/phase3-hard-gate-payload-fallback run src/renderer/src/lib/agent/__tests__/long-task-context.test.ts
npm --prefix .worktrees/phase3-hard-gate-payload-fallback exec vitest -- --root .worktrees/phase3-hard-gate-payload-fallback run src/main/cron/__tests__/context-compression-runtime.test.ts
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run test:agent-context
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run diagnose:context-regressions
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run diagnose:long-task-compression
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run lint
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run typecheck
```

Expected final state:

- auto-threshold pressure over 80% can be reported as `context_compression_deferred` when no safe compact range exists;
- `compressed: false` no longer produces a false `context_compressed` event in the renderer agent loop;
- renderer and main hard gates from Phase 3 still block `hard_context_limit_exceeded` and `reserved_output_budget_exceeded` before provider requests;
- unsafe tool chains are not split in this phase;
- partial compact remains unimplemented until its own plan.

## Follow-up Plans After This Phase

After this phase passes review, create separate plans for:

1. assistant output finalize checkpoint and continuation state;
2. partial compact / from-up-to compact inside a long current task;
3.超长用户输入文件化与分块摘要;
4. UI reason taxonomy and diagnostics panel;
5. session memory, hooks, prompt cache baseline, and relink metadata.
