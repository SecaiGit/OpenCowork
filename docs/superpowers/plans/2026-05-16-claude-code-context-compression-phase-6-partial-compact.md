# Partial Compact / From-Up-To Compact Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在单个长任务 round 内安全压缩早期已闭合子步骤，同时保留当前用户任务 anchor、最新 tail、未闭合 tool_use/tool_result 协议和可诊断 metadata。

**Architecture:** 在 shared `claude-context-compression` core 中新增 partial range selector，普通 compact 因 `insufficient_compressible_messages` 无法选择旧历史时，尝试从当前任务内部选择 `from/up_to` 安全子范围。renderer 与 main runtime 已复用 shared `runClaudeCompact`，因此只需补充 wrapper/types、renderer/main 覆盖测试和诊断脚本，避免三端重复实现。

**Tech Stack:** TypeScript, shared Claude compact core, renderer `compressMessages`, main cron `maybeCompactMainRuntimeContext`, Vitest, existing context diagnostics.

---

## Scope Check

本阶段只覆盖 `docs/superpowers/specs/2026-05-15-context-compression-missing-implementation.md` 中的 P1 `partial compact / from-up-to compact`：

- 在同一用户任务内部压缩早期已完成工具链；
- 最新 tail 原样保留；
- 不拆未闭合 `tool_use/tool_result`；
- metadata 记录 `from/up_to`、anchor、preserved range 和 compressed range；
- renderer/main 通过 shared core 获得一致行为。

本阶段不实现 streaming continuation、session memory、hooks、prompt cache、完整 relink UI 或超长用户输入文件化。这些继续作为后续独立计划。

## File Structure

### Shared compact core

- Modify: `src/shared/claude-context-compression/types.ts`
  - 增加 partial compact metadata：`partialRange`。
  - 在 `ClaudeCompactResult` 上暴露 `partialCompact?: boolean`。
- Modify: `src/shared/claude-context-compression/rounds.ts`
  - 新增 `selectClaudePartialCompactRanges`。
  - 只选择完整闭合的早期子范围；保留 anchor 与 tail。
- Modify: `src/shared/claude-context-compression/engine.ts`
  - 普通 `selectClaudeCompactRanges` 返回 `insufficient_compressible_messages` 时，尝试 partial selector。
  - summary 与 boundary metadata 标记 partial compact。
- Modify: `src/shared/__tests__/claude-context-compression-core.test.ts`
  - 增加 partial selector 与 shared engine tests。

### Renderer runtime

- Modify: `src/renderer/src/lib/agent/claude-compact-rounds.ts`
  - 重新导出 shared partial selector/types，保持 renderer tests 可直接覆盖。
- Modify: `src/renderer/src/lib/agent/__tests__/claude-context-compression.test.ts`
  - 增加 renderer `compressMessages` partial compact 集成测试。

### Main runtime

- Modify: `src/main/cron/__tests__/context-compression-runtime.test.ts`
  - 增加 main runtime partial compact preflight 测试，确保 `context_compressed` event 携带 partial metadata。

### Diagnostics

- Modify: `scripts/diagnose-long-task-context-compression.mjs`
  - 增加 source-level regression checks，确保 partial selector、partial metadata 与 engine fallback 不被移除。

---

## Task 1: Add shared partial compact selector tests

**Files:**
- Modify: `src/shared/__tests__/claude-context-compression-core.test.ts`
- Modify: `src/shared/claude-context-compression/rounds.ts` only if the failing import needs a temporary exported symbol during RED; otherwise leave production untouched until Task 2.

- [ ] **Step 1: Add failing imports for partial selector**

Update the import from `../claude-context-compression` in `src/shared/__tests__/claude-context-compression-core.test.ts` to include:

```ts
selectClaudePartialCompactRanges,
```

Expected import segment:

```ts
import {
  assertClaudeCompactSummarySafe,
  buildClaudeCompactSystemPrompt,
  buildClaudeCompactUserPrompt,
  extractClaudeCompactSummary,
  getClaudeCompactBudget,
  runClaudeCompact,
  sanitizeMessagesForClaudeCompact,
  selectClaudeCompactRanges,
  selectClaudePartialCompactRanges,
  type ClaudeCompactContentBlock,
  type ClaudeCompactMessage,
  classifyClaudeContextGate,
  dehydrateClaudeCompactPayloads,
  guardClaudeAssistantFinalizePayload,
  guardClaudeSingleInputPayload
} from '../claude-context-compression'
```

- [ ] **Step 2: Write failing selector tests**

Append this block inside `describe('shared Claude compact core', ...)`, immediately after the existing `describe('shared Claude text guards', ...)` block and before `describe('shared Claude context gate classification', ...)`:

```ts
describe('shared Claude partial compact ranges', () => {
  it('selects early closed current-task tool substeps while preserving anchor and latest tail', () => {
    nextMessageId = 0
    const messages = [
      message('user', 'implement the feature and keep going'),
      message('assistant', [toolUse('read-old')]),
      message('user', [toolResult('read-old', 'old file snapshot')]),
      message('assistant', 'old read finished'),
      message('assistant', [toolUse('edit-latest')]),
      message('user', [toolResult('edit-latest', 'latest edit result')]),
      message('assistant', 'continue with tests')
    ]

    const selection = selectClaudePartialCompactRanges(messages, {
      minCompressibleMessages: 2,
      preservedTailMessages: 3
    })

    expect(selection.ok).toBe(true)
    expect(selection.mode).toBe('partial')
    expect(selection.anchorMessage?.id).toBe('m-1')
    expect(selection.compressibleMessages.map((item) => item.id)).toEqual(['m-2', 'm-3', 'm-4'])
    expect(selection.preservedMessages.map((item) => item.id)).toEqual(['m-1', 'm-5', 'm-6', 'm-7'])
    expect(selection.compressedRange).toEqual({ start: 1, end: 4 })
    expect(selection.partialRange).toEqual({ from: 1, upTo: 4, anchor: 0, tailStart: 4 })
  })

  it('refuses to compact when there is no closed current-task substep', () => {
    nextMessageId = 0
    const messages = [
      message('user', 'continue safely'),
      message('assistant', [toolUse('pending')]),
      message('assistant', 'waiting for pending result')
    ]

    const selection = selectClaudePartialCompactRanges(messages, {
      minCompressibleMessages: 2,
      preservedTailMessages: 0
    })

    expect(selection.ok).toBe(false)
    expect(selection.reason).toBe('insufficient_compressible_messages')
    expect(selection.compressibleMessages).toEqual([])
    expect(selection.preservedMessages).toBe(messages)
  })

  it('moves the boundary earlier instead of preserving an orphaned tool_result tail', () => {
    nextMessageId = 0
    const messages = [
      message('user', 'continue safely'),
      message('assistant', [toolUse('a')]),
      message('user', [toolResult('a', 'a result')]),
      message('assistant', [toolUse('b')]),
      message('user', [toolResult('b', 'b result')]),
      message('assistant', 'latest explanation')
    ]

    const selection = selectClaudePartialCompactRanges(messages, {
      minCompressibleMessages: 2,
      preservedTailMessages: 2
    })

    expect(selection.ok).toBe(true)
    expect(selection.compressibleMessages.map((item) => item.id)).toEqual(['m-2', 'm-3'])
    expect(selection.preservedMessages.map((item) => item.id)).toEqual(['m-1', 'm-4', 'm-5', 'm-6'])
    expect(selection.partialRange).toEqual({ from: 1, upTo: 3, anchor: 0, tailStart: 3 })
  })
})
```

- [ ] **Step 3: Run shared core test and verify RED**

Run:

```bash
npm --prefix .worktrees/phase3-hard-gate-payload-fallback exec vitest -- --root .worktrees/phase3-hard-gate-payload-fallback run src/shared/__tests__/claude-context-compression-core.test.ts
```

Expected: FAIL because `selectClaudePartialCompactRanges` is not exported or not implemented.

---

## Task 2: Implement partial range selector and metadata types

**Files:**
- Modify: `src/shared/claude-context-compression/types.ts`
- Modify: `src/shared/claude-context-compression/rounds.ts`
- Modify: `src/renderer/src/lib/agent/claude-compact-rounds.ts`
- Modify: `src/shared/__tests__/claude-context-compression-core.test.ts`

- [ ] **Step 1: Extend shared compact metadata types**

In `src/shared/claude-context-compression/types.ts`, add this interface after `ClaudeCompactBoundaryMeta` or immediately before it:

```ts
export interface ClaudeCompactPartialRangeMeta {
  mode: 'from_up_to'
  anchorId: string
  from: number
  upTo: number
  tailStart: number
}
```

Then extend `ClaudeCompactBoundaryMeta` with:

```ts
  partialRange?: ClaudeCompactPartialRangeMeta
```

Expected resulting segment:

```ts
export interface ClaudeCompactBoundaryMeta {
  strategy?: string
  trigger: ClaudeCompactTrigger
  preTokens: number
  postTokens?: number
  messagesSummarized: number
  compactedAt?: number
  retryCount?: number
  compressedRange?: { start: number; end: number }
  preservedRange?: { start: number; end: number }
  partialRange?: ClaudeCompactPartialRangeMeta
  safetyFlags?: string[]
  preservedSegment?: {
    headId: string
    anchorId: string
    tailId: string
  }
}
```

Extend `ClaudeCompactResult` with:

```ts
  partialCompact?: boolean
```

Expected resulting segment:

```ts
export interface ClaudeCompactResult {
  compressed: boolean
  originalCount: number
  newCount: number
  messagesSummarized?: number
  payloadsCompacted?: number
  partialCompact?: boolean
  reason?: ClaudeCompactSkipReason
}
```

- [ ] **Step 2: Add partial selector result types**

In `src/shared/claude-context-compression/rounds.ts`, add these types after `ClaudeCompactRangeSelection`:

```ts
export interface ClaudePartialCompactRangeSelection extends ClaudeCompactRangeSelection {
  ok: true
  mode: 'partial'
  anchorMessage: ClaudeCompactMessage
  partialRange: { from: number; upTo: number; anchor: number; tailStart: number }
}

export interface ClaudePartialCompactRangeFailure extends ClaudeCompactRangeSelection {
  ok: false
  mode: 'partial'
  anchorMessage?: undefined
  partialRange?: undefined
}

export type ClaudePartialCompactRangeSelectionResult =
  | ClaudePartialCompactRangeSelection
  | ClaudePartialCompactRangeFailure

export interface SelectClaudePartialCompactRangesOptions {
  minCompressibleMessages?: number
  preservedTailMessages?: number
}
```

- [ ] **Step 3: Add helper functions for partial boundary selection**

In `src/shared/claude-context-compression/rounds.ts`, add these helpers near existing private helpers:

```ts
function hasNonToolResultUserContent(message: ClaudeCompactMessage): boolean {
  if (message.role !== 'user') return false
  if (typeof message.content === 'string') return message.content.trim().length > 0
  return message.content.some((block) => block.type !== 'tool_result')
}

function findCurrentTaskAnchorIndex(messages: ClaudeCompactMessage[]): number {
  for (let index = 0; index < messages.length; index += 1) {
    if (hasNonToolResultUserContent(messages[index]!)) return index
  }
  return -1
}

function hasValidClosedToolProtocol(messages: ClaudeCompactMessage[]): boolean {
  return validateToolUseResultProtocol(messages).valid
}

function hasSafePreservedProtocol(messages: ClaudeCompactMessage[]): boolean {
  return !hasFatalProtocolIssue(validateToolUseResultProtocol(messages).issues)
}
```

- [ ] **Step 4: Implement `selectClaudePartialCompactRanges`**

Append this exported function near `selectClaudeCompactRanges` in `src/shared/claude-context-compression/rounds.ts`:

```ts
export function selectClaudePartialCompactRanges(
  messages: ClaudeCompactMessage[],
  options: SelectClaudePartialCompactRangesOptions = {}
): ClaudePartialCompactRangeSelectionResult {
  const minCompressibleMessages = Math.max(2, Math.floor(options.minCompressibleMessages ?? 2))
  const preservedTailMessages = Math.max(0, Math.floor(options.preservedTailMessages ?? 3))

  if (messages.length < minCompressibleMessages + 2) {
    return {
      ok: false,
      mode: 'partial',
      reason: 'insufficient_messages',
      compressibleMessages: [],
      preservedMessages: messages
    }
  }

  const fullValidation = validateToolUseResultProtocol(messages)
  if (hasFatalProtocolIssue(fullValidation.issues)) {
    return {
      ok: false,
      mode: 'partial',
      reason: 'unsafe_boundary',
      compressibleMessages: [],
      preservedMessages: messages
    }
  }

  const anchorIndex = findCurrentTaskAnchorIndex(messages)
  if (anchorIndex < 0 || anchorIndex >= messages.length - minCompressibleMessages) {
    return {
      ok: false,
      mode: 'partial',
      reason: 'insufficient_compressible_messages',
      compressibleMessages: [],
      preservedMessages: messages
    }
  }

  const latestAllowedTailStart = Math.max(anchorIndex + minCompressibleMessages + 1, messages.length - preservedTailMessages)

  for (let tailStart = Math.min(latestAllowedTailStart, messages.length); tailStart > anchorIndex + 1; tailStart -= 1) {
    const compressibleMessages = messages.slice(anchorIndex + 1, tailStart)
    if (compressibleMessages.length < minCompressibleMessages) continue
    if (!hasValidClosedToolProtocol(compressibleMessages)) continue

    const preservedMessages = [messages[anchorIndex]!, ...messages.slice(tailStart)].filter(
      (message) => message.meta?.postCompactState !== true
    )
    if (!hasSafePreservedProtocol(preservedMessages)) continue

    return {
      ok: true,
      mode: 'partial',
      anchorMessage: messages[anchorIndex]!,
      compressibleMessages,
      preservedMessages,
      compressedRange: { start: anchorIndex + 1, end: tailStart },
      preservedRange: { start: tailStart, end: messages.length },
      partialRange: {
        from: anchorIndex + 1,
        upTo: tailStart,
        anchor: anchorIndex,
        tailStart
      }
    }
  }

  return {
    ok: false,
    mode: 'partial',
    reason: 'insufficient_compressible_messages',
    compressibleMessages: [],
    preservedMessages: messages
  }
}
```

- [ ] **Step 5: Update renderer wrapper exports**

In `src/renderer/src/lib/agent/claude-compact-rounds.ts`, update imports from shared rounds:

```ts
import {
  dropOldestClaudeCompactRounds as dropOldestSharedClaudeCompactRounds,
  selectClaudeCompactRanges as selectSharedClaudeCompactRanges,
  selectClaudePartialCompactRanges as selectSharedClaudePartialCompactRanges,
  type ClaudeCompactRangeSelection as SharedClaudeCompactRangeSelection,
  type ClaudePartialCompactRangeSelectionResult as SharedClaudePartialCompactRangeSelectionResult,
  type SelectClaudeCompactRangesOptions,
  type SelectClaudePartialCompactRangesOptions
} from '../../../../shared/claude-context-compression/rounds'
```

Add renderer aliases after `ClaudeCompactRangeSelection`:

```ts
export type ClaudePartialCompactRangeSelectionResult =
  SharedClaudePartialCompactRangeSelectionResult extends infer Selection
    ? Selection extends { compressibleMessages: unknown; preservedMessages: unknown }
      ? Omit<Selection, 'compressibleMessages' | 'preservedMessages' | 'anchorMessage'> & {
          compressibleMessages: UnifiedMessage[]
          preservedMessages: UnifiedMessage[]
          anchorMessage?: UnifiedMessage
        }
      : never
    : never

export type { SelectClaudePartialCompactRangesOptions }
```

Add wrapper function:

```ts
export function selectClaudePartialCompactRanges(
  messages: UnifiedMessage[],
  options: SelectClaudePartialCompactRangesOptions = {}
): ClaudePartialCompactRangeSelectionResult {
  return selectSharedClaudePartialCompactRanges(
    messages as unknown as ClaudeCompactMessage[],
    options
  ) as unknown as ClaudePartialCompactRangeSelectionResult
}
```

- [ ] **Step 6: Run shared test and renderer typecheck**

Run:

```bash
npm --prefix .worktrees/phase3-hard-gate-payload-fallback exec vitest -- --root .worktrees/phase3-hard-gate-payload-fallback run src/shared/__tests__/claude-context-compression-core.test.ts
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run typecheck:web
```

Expected: shared tests PASS and renderer typecheck PASS.

- [ ] **Step 7: Commit partial selector**

Run:

```bash
git -C .worktrees/phase3-hard-gate-payload-fallback add src/shared/claude-context-compression/types.ts src/shared/claude-context-compression/rounds.ts src/renderer/src/lib/agent/claude-compact-rounds.ts src/shared/__tests__/claude-context-compression-core.test.ts
git -C .worktrees/phase3-hard-gate-payload-fallback commit -m "feat(context): select partial compact ranges"
```

---

## Task 3: Wire partial selection into shared compact engine

**Files:**
- Modify: `src/shared/claude-context-compression/engine.ts`
- Modify: `src/shared/__tests__/claude-context-compression-core.test.ts`

- [ ] **Step 1: Write failing shared engine tests**

Append these tests inside `describe('shared Claude compact core', ...)`, after the partial range selector tests:

```ts
describe('shared Claude partial compact engine', () => {
  it('summarizes early current-task substeps when ordinary range selection has no older rounds', async () => {
    nextMessageId = 0
    const messages = [
      message('user', 'implement the feature and keep going'),
      message('assistant', [toolUse('read-old')]),
      message('user', [toolResult('read-old', 'old file snapshot')]),
      message('assistant', 'old read finished'),
      message('assistant', [toolUse('edit-latest')]),
      message('user', [toolResult('edit-latest', 'latest edit result')]),
      message('assistant', 'continue with tests')
    ]
    const summarize = vi.fn(async ({ userPrompt }: { userPrompt: string }) => {
      expect(userPrompt).toContain('old file snapshot')
      expect(userPrompt).not.toContain('latest edit result')
      return '<summary>Finished the old read step and should continue with tests.</summary>'
    })

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
      summarize,
      createId: (() => {
        let id = 0
        return () => `partial-${++id}`
      })(),
      now: () => 123
    })

    expect(result.result.compressed).toBe(true)
    expect(result.result.partialCompact).toBe(true)
    expect(summarize).toHaveBeenCalledTimes(1)
    expect(result.messages[0]?.meta?.compactBoundary?.partialRange).toEqual({
      mode: 'from_up_to',
      anchorId: 'm-1',
      from: 1,
      upTo: 4,
      tailStart: 4
    })
    expect(result.messages[0]?.meta?.compactBoundary?.compressedRange).toEqual({ start: 1, end: 4 })
    expect(result.messages.slice(-4).map((item) => item.id)).toEqual(['m-1', 'm-5', 'm-6', 'm-7'])
  })

  it('keeps recent payload fallback when no safe partial compact range exists', async () => {
    nextMessageId = 0
    const messages = [
      message('assistant', [toolUse('recent-large')]),
      message('user', [toolResult('recent-large', 'warning line\n'.repeat(12_000))]),
      message('assistant', 'continue')
    ]
    const summarize = vi.fn(async () => '<summary>should not be used</summary>')

    const result = await runClaudeCompact({
      messages,
      trigger: 'manual',
      preTokens: 190_000,
      config: {
        enabled: true,
        contextLength: 200_000,
        threshold: 0.8,
        strategyId: 'claude-code-compact-v1',
        reservedOutputBudget: 20_000
      },
      summarize
    })

    expect(result.result.compressed).toBe(true)
    expect(result.result.messagesSummarized).toBe(0)
    expect(result.result.payloadsCompacted).toBe(1)
    expect(result.result.partialCompact).toBeUndefined()
    expect(summarize).not.toHaveBeenCalled()
    expect(JSON.stringify(result.messages)).toContain('[Tool result compacted for context budget]')
  })
})
```

- [ ] **Step 2: Run shared core test and verify RED**

Run:

```bash
npm --prefix .worktrees/phase3-hard-gate-payload-fallback exec vitest -- --root .worktrees/phase3-hard-gate-payload-fallback run src/shared/__tests__/claude-context-compression-core.test.ts
```

Expected: FAIL because `runClaudeCompact` does not yet call `selectClaudePartialCompactRanges` or emit `partialRange` metadata.

- [ ] **Step 3: Import partial selector in shared engine**

Update the import in `src/shared/claude-context-compression/engine.ts`:

```ts
import {
  dropOldestClaudeCompactRounds,
  selectClaudeCompactRanges,
  selectClaudePartialCompactRanges,
  type ClaudeCompactRangeSelection,
  type ClaudePartialCompactRangeSelection
} from './rounds'
```

- [ ] **Step 4: Extend boundary message creation for partial metadata**

Update `createBoundaryMessage` args in `engine.ts`:

```ts
  partialRange?: ClaudePartialCompactRangeSelection['partialRange']
  partialAnchorId?: string
```

Inside `meta.compactBoundary`, add:

```ts
        ...(args.partialRange && args.partialAnchorId
          ? {
              partialRange: {
                mode: 'from_up_to' as const,
                anchorId: args.partialAnchorId,
                from: args.partialRange.from,
                upTo: args.partialRange.upTo,
                tailStart: args.partialRange.tailStart
              }
            }
          : {}),
```

- [ ] **Step 5: Add a resolver for ordinary-vs-partial selection**

In `engine.ts`, add this helper above `runClaudeCompact`:

```ts
type EffectiveClaudeCompactSelection = ClaudeCompactRangeSelection | ClaudePartialCompactRangeSelection

function resolveEffectiveCompactSelection(messages: ClaudeCompactMessage[]): EffectiveClaudeCompactSelection {
  const fullSelection = selectClaudeCompactRanges(messages)
  if (fullSelection.ok || fullSelection.reason !== 'insufficient_compressible_messages') {
    return fullSelection
  }

  const partialSelection = selectClaudePartialCompactRanges(messages)
  return partialSelection.ok ? partialSelection : fullSelection
}
```

- [ ] **Step 6: Use effective selection in `runClaudeCompact`**

Replace:

```ts
  const selection = selectClaudeCompactRanges(args.messages)
```

with:

```ts
  const selection = resolveEffectiveCompactSelection(args.messages)
```

In the `createBoundaryMessage` call, add:

```ts
          partialRange: selection.ok && 'partialRange' in selection ? selection.partialRange : undefined,
          partialAnchorId:
            selection.ok && 'anchorMessage' in selection ? selection.anchorMessage.id : undefined,
```

In the success `result`, add:

```ts
          ...(selection.ok && 'partialRange' in selection ? { partialCompact: true } : {})
```

Expected resulting success result segment:

```ts
        result: {
          compressed: true,
          originalCount: args.messages.length,
          newCount: compressedMessages.length,
          messagesSummarized: selection.compressibleMessages.length,
          ...(selection.ok && 'partialRange' in selection ? { partialCompact: true } : {})
        }
```

- [ ] **Step 7: Run shared tests and node typecheck**

Run:

```bash
npm --prefix .worktrees/phase3-hard-gate-payload-fallback exec vitest -- --root .worktrees/phase3-hard-gate-payload-fallback run src/shared/__tests__/claude-context-compression-core.test.ts
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run typecheck:node
```

Expected: both PASS.

- [ ] **Step 8: Commit shared engine partial compact**

Run:

```bash
git -C .worktrees/phase3-hard-gate-payload-fallback add src/shared/claude-context-compression/engine.ts src/shared/__tests__/claude-context-compression-core.test.ts
git -C .worktrees/phase3-hard-gate-payload-fallback commit -m "feat(context): run partial compact fallback"
```

---

## Task 4: Add renderer and main runtime coverage

**Files:**
- Modify: `src/renderer/src/lib/agent/__tests__/claude-context-compression.test.ts`
- Modify: `src/main/cron/__tests__/context-compression-runtime.test.ts`

- [ ] **Step 1: Add renderer failing integration test**

Append this test inside `describe('claude-code-compact-v1 engine', ...)` in `src/renderer/src/lib/agent/__tests__/claude-context-compression.test.ts`, after `returns compressed renderer messages when shared recent payload fallback dehydrates tool results`:

```ts
it('uses partial compact metadata when only current-task substeps are safely compressible', async () => {
  nextMessageId = 0
  vi.mocked(runSidecarTextRequest).mockResolvedValue(
    '<summary>Old read step is complete. Continue with latest edit validation.</summary>'
  )
  const messages = [
    message('user', 'implement the feature and keep going'),
    message('assistant', [toolUse('read-old')]),
    message('user', [toolResult('read-old', 'old file snapshot')]),
    message('assistant', 'old read finished'),
    message('assistant', [toolUse('edit-latest')]),
    message('user', [toolResult('edit-latest', 'latest edit result')]),
    message('assistant', 'continue with tests')
  ]

  const result = await compressMessages(
    messages,
    providerConfig,
    undefined,
    undefined,
    undefined,
    undefined,
    'auto',
    180_000,
    {
      enabled: true,
      contextLength: 200_000,
      threshold: 0.8,
      strategyId: 'claude-code-compact-v1',
      reservedOutputBudget: 20_000
    }
  )

  const prompt = String(vi.mocked(runSidecarTextRequest).mock.calls[0]?.[0].messages[0]?.content ?? '')

  expect(result.result.compressed).toBe(true)
  expect(result.result.partialCompact).toBe(true)
  expect(result.messages[0]?.meta?.compactBoundary?.partialRange).toMatchObject({
    mode: 'from_up_to',
    anchorId: 'm-1',
    from: 1,
    upTo: 4,
    tailStart: 4
  })
  expect(result.messages.slice(-4).map((item) => item.id)).toEqual(['m-1', 'm-5', 'm-6', 'm-7'])
  expect(prompt).toContain('old file snapshot')
  expect(prompt).not.toContain('latest edit result')
})
```

- [ ] **Step 2: Add main runtime failing integration test**

Append this test inside `describe('main runtime context compression preflight', ...)` in `src/main/cron/__tests__/context-compression-runtime.test.ts`, after `compacts above Claude auto threshold and returns compression events`:

```ts
it('compacts early current-task substeps through shared partial compact fallback', async () => {
  nextMessageId = 0
  const summarize = vi.fn(async ({ userPrompt }: { userPrompt: string }) => {
    expect(userPrompt).toContain('old file snapshot')
    expect(userPrompt).not.toContain('latest edit result')
    return '<summary>Old read step is complete. Continue with latest edit validation.</summary>'
  })
  const messages = [
    message('user', 'implement the feature and keep going'),
    message('assistant', [toolUse('read-old')]),
    message('user', [toolResult('read-old', 'old file snapshot')]),
    message('assistant', 'old read finished'),
    message('assistant', [toolUse('edit-latest')]),
    message('user', [toolResult('edit-latest', 'latest edit result')]),
    {
      ...message('assistant', 'continue with tests'),
      usage: { inputTokens: 0, outputTokens: 0, contextTokens: 180_000 }
    }
  ]

  const result = await maybeCompactMainRuntimeContext({
    messages,
    config,
    trigger: 'auto',
    summarize,
    now: () => 123,
    createId: (() => {
      let id = 0
      return () => `main-partial-${++id}`
    })()
  })

  expect(result.compressed).toBe(true)
  expect(result.events).toEqual([
    { type: 'context_compression_start' },
    expect.objectContaining({ type: 'context_compressed', originalCount: 7 })
  ])
  expect(result.messages[0]?.meta?.compactBoundary?.partialRange).toMatchObject({
    mode: 'from_up_to',
    anchorId: 'm-1',
    from: 1,
    upTo: 4,
    tailStart: 4
  })
  expect(result.messages.slice(-4).map((item) => item.id)).toEqual(['m-1', 'm-5', 'm-6', 'm-7'])
})
```

- [ ] **Step 3: Run renderer/main tests and verify RED or GREEN based on Task 3 state**

If Task 3 has not been implemented yet, expected result is FAIL. If Task 3 is already implemented, expected result is PASS.

Run:

```bash
npm --prefix .worktrees/phase3-hard-gate-payload-fallback exec vitest -- --root .worktrees/phase3-hard-gate-payload-fallback run src/renderer/src/lib/agent/__tests__/claude-context-compression.test.ts src/main/cron/__tests__/context-compression-runtime.test.ts
```

- [ ] **Step 4: Run renderer/main typechecks**

Run:

```bash
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run typecheck:node
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run typecheck:web
```

Expected: both PASS.

- [ ] **Step 5: Commit runtime coverage**

Run:

```bash
git -C .worktrees/phase3-hard-gate-payload-fallback add src/renderer/src/lib/agent/__tests__/claude-context-compression.test.ts src/main/cron/__tests__/context-compression-runtime.test.ts
git -C .worktrees/phase3-hard-gate-payload-fallback commit -m "test(context): cover partial compact runtime parity"
```

---

## Task 5: Add diagnostic regression checks

**Files:**
- Modify: `scripts/diagnose-long-task-context-compression.mjs`

- [ ] **Step 1: Add source readers for shared partial compact files**

In `scripts/diagnose-long-task-context-compression.mjs`, after existing source reads, add:

```js
const sharedRounds = read('src/shared/claude-context-compression/rounds.ts')
const sharedEngine = read('src/shared/claude-context-compression/engine.ts')
const sharedTypes = read('src/shared/claude-context-compression/types.ts')
```

- [ ] **Step 2: Add diagnostic checks**

Before the final loop that prints passes, add:

```js
check(
  hasAll(sharedRounds, ['selectClaudePartialCompactRanges', 'partialRange', 'anchorMessage']),
  'partial compact range selector is present',
  'partial compact range selector is missing',
  ['rounds.ts must expose selectClaudePartialCompactRanges with anchor and partialRange metadata']
)

check(
  hasAll(sharedEngine, ['selectClaudePartialCompactRanges', 'partialCompact', 'partialRange']),
  'shared compact engine can run partial compact fallback',
  'shared compact engine is missing partial compact fallback',
  ['engine.ts must try partial compact when ordinary selection has insufficient_compressible_messages']
)

check(
  hasAll(sharedTypes, ['ClaudeCompactPartialRangeMeta', 'partialRange?: ClaudeCompactPartialRangeMeta']),
  'partial compact metadata is typed',
  'partial compact metadata is not typed',
  ['types.ts must include ClaudeCompactPartialRangeMeta and expose it on compactBoundary metadata']
)
```

- [ ] **Step 3: Run diagnostic script and verify PASS**

Run:

```bash
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run diagnose:long-task-compression
```

Expected: PASS, with three additional PASS lines for partial compact.

- [ ] **Step 4: Commit diagnostics**

Run:

```bash
git -C .worktrees/phase3-hard-gate-payload-fallback add scripts/diagnose-long-task-context-compression.mjs
git -C .worktrees/phase3-hard-gate-payload-fallback commit -m "test(context): diagnose partial compact fallback"
```

---

## Task 6: Aggregate verification and review

**Files:**
- No implementation files are expected to change unless tests expose stale expectations.

- [ ] **Step 1: Run focused test matrix**

Run:

```bash
npm --prefix .worktrees/phase3-hard-gate-payload-fallback exec vitest -- --root .worktrees/phase3-hard-gate-payload-fallback run src/shared/__tests__/claude-context-compression-core.test.ts
npm --prefix .worktrees/phase3-hard-gate-payload-fallback exec vitest -- --root .worktrees/phase3-hard-gate-payload-fallback run src/renderer/src/lib/agent/__tests__/claude-context-compression.test.ts src/main/cron/__tests__/context-compression-runtime.test.ts
```

Expected: all PASS.

- [ ] **Step 2: Run aggregate context tests and diagnostics**

Run:

```bash
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run test:agent-context
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run diagnose:context-regressions
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run diagnose:long-task-compression
```

Expected: all PASS.

- [ ] **Step 3: Run lint and typecheck**

Run:

```bash
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run lint
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run typecheck
```

Expected: `typecheck` PASS. `lint` exits 0; existing worktree CRLF warnings may remain but no errors should be introduced.

- [ ] **Step 4: Request code review**

Use `requesting-code-review` and ask the reviewer to check:

- partial selector never splits unmatched `tool_use/tool_result` pairs;
- `compressibleMessages` is always a closed protocol segment;
- `preservedMessages` keeps the current user anchor plus latest tail;
- `partialRange` metadata accurately records `from/up_to`, anchor and tail start;
- existing payload fallback still runs when no safe partial range exists;
- renderer/main receive identical shared core behavior without duplicate logic;
- diagnostics are source-level guards, not a substitute for behavior tests.

- [ ] **Step 5: Fix review feedback before starting another phase**

Fix Critical and Important review feedback in separate commits before planning streaming continuation or session memory.

---

## Verification Checklist

Before considering this phase complete, run:

```bash
npm --prefix .worktrees/phase3-hard-gate-payload-fallback exec vitest -- --root .worktrees/phase3-hard-gate-payload-fallback run src/shared/__tests__/claude-context-compression-core.test.ts
npm --prefix .worktrees/phase3-hard-gate-payload-fallback exec vitest -- --root .worktrees/phase3-hard-gate-payload-fallback run src/renderer/src/lib/agent/__tests__/claude-context-compression.test.ts src/main/cron/__tests__/context-compression-runtime.test.ts
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run test:agent-context
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run diagnose:context-regressions
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run diagnose:long-task-compression
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run lint
npm --prefix .worktrees/phase3-hard-gate-payload-fallback run typecheck
```

Expected final state:

- ordinary compact still summarizes older complete API rounds;
- when ordinary compact cannot find older rounds, shared engine tries partial compact before giving up;
- early completed current-task substeps can be summarized;
- current user anchor and latest tail remain in final messages;
- no unmatched `tool_use/tool_result` pair is split;
- `compactBoundary.partialRange` records `mode: 'from_up_to'`, `anchorId`, `from`, `upTo`, and `tailStart`;
- renderer and main runtime tests prove both use the same shared partial compact behavior;
- recent payload fallback still dehydrates oversized payloads when partial compact is not safe.

## Follow-up Plans After This Phase

After this phase passes review, create separate plans for:

1. streaming output continuation with stop/checkpoint/resume;
2. full file externalization and chunk map-reduce for oversized user inputs;
3. UI reason taxonomy and diagnostics panel;
4. session memory, hooks, prompt cache baseline, and relink metadata.
