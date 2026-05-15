# Claude Code Context Compression Phase 3 Hard Gate and Payload Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent single-turn oversized payloads and hard context-limit pressure from overflowing the next model request, while adding a deterministic fallback for `insufficient_compressible_messages`.

**Architecture:** Add shared, process-neutral gate classification and payload dehydration utilities under `src/shared/claude-context-compression/`. Wire the shared engine to use deterministic recent-payload fallback when ordinary summary compaction has no safe historical range, then make renderer and main runtimes fail closed at request preflight when the context still exceeds the model window.

**Tech Stack:** TypeScript, Electron main/renderer, Vitest, existing `UnifiedMessage` / `ClaudeCompactMessage` models, existing `claude-code-compact-v1` shared compact core, existing renderer `context-payload-compaction` behavior as the reference for payload dehydration.

---

## Scope Check

This plan implements only the next smallest stable slice from `docs/superpowers/specs/2026-05-15-context-compression-missing-implementation.md`:

- shared request pressure classification;
- shared recent payload dehydration;
- `insufficient_compressible_messages` fallback that keeps recent message structure but shrinks oversized payloads;
- renderer hard gate before the next provider request;
- main runtime hard gate before the next provider request;
- tests and diagnostics for the above.

This plan does not implement partial compact, assistant output continuation, hook APIs, prompt-cache baseline management, session memory compaction, relink metadata expansion, or UI diagnostic panels. Those remain separate follow-up plans.

## File Structure

### Shared compact core

- Create: `src/shared/claude-context-compression/gates.ts`
  - Owns Claude-style pressure classification: `ok`, `pre_compress`, `auto_compact`, `reserved_output_exceeded`, and `hard_limit_exceeded`.
- Create: `src/shared/claude-context-compression/payload.ts`
  - Owns deterministic payload dehydration for `ClaudeCompactMessage[]`, including large tool result strings, tool result text arrays, image payload replacement, and secret redaction.
- Modify: `src/shared/claude-context-compression/types.ts`
  - Adds result fields for deterministic payload fallback and new skip reasons used by hard-gate diagnostics.
- Modify: `src/shared/claude-context-compression/engine.ts`
  - Runs recent payload fallback when range selection returns `insufficient_compressible_messages`.
- Modify: `src/shared/claude-context-compression/index.ts`
  - Exports `gates.ts` and `payload.ts` APIs.
- Modify: `src/shared/__tests__/claude-context-compression-core.test.ts`
  - Adds tests for gate classification, deterministic payload dehydration, and recent payload fallback without calling the summarizer.

### Renderer runtime

- Modify: `src/renderer/src/lib/agent/context-compression.ts`
  - Extends `CompressionResult` with payload fallback metadata and maps shared fallback results without losing existing `partial-summary-v1` behavior.
- Modify: `src/renderer/src/lib/agent/claude-compact-engine.ts`
  - Re-exports the shared fallback result through the renderer strategy adapter.
- Modify: `src/renderer/src/lib/agent/agent-loop.ts`
  - Uses shared gate classification at the pre-request checkpoint. If compact/dehydrate cannot bring the context under the hard limit, emits an error and stops instead of sending an over-limit request.
- Modify: `src/renderer/src/lib/agent/__tests__/claude-context-compression.test.ts`
  - Adds renderer adapter tests for recent payload fallback metadata.
- Modify: `src/renderer/src/lib/agent/__tests__/long-task-context.test.ts`
  - Adds agent-loop tests for hard-gate blocking after failed compaction.

### Main runtime

- Modify: `src/main/cron/context-compression-runtime.ts`
  - Uses shared gate classification after pre-compress and after full compact; returns a blocked result when the next request would still exceed the model limit.
- Modify: `src/main/cron/__tests__/context-compression-runtime.test.ts`
  - Adds main preflight tests for hard-limit blocking and reserved-output pressure.

### Protocol and scripts

- Modify: `package.json`
  - No script shape change is expected; run the existing `npm run test:agent-context` after task completion.
- Optional modify: `src/renderer/src/locales/zh/agent.json`
  - Only if implementation adds a visible manual skip description for a new reason. Keep this out of the first pass unless tests show user-facing copy needs it.

---

## Task 1: Add shared Claude context gate classification

**Files:**
- Create: `src/shared/claude-context-compression/gates.ts`
- Modify: `src/shared/claude-context-compression/index.ts`
- Modify: `src/shared/__tests__/claude-context-compression-core.test.ts`

- [ ] **Step 1: Write failing gate classification tests**

Append this block to `src/shared/__tests__/claude-context-compression-core.test.ts`:

```ts
import { classifyClaudeContextGate } from '../claude-context-compression'

describe('shared Claude context gate classification', () => {
  const gateConfig = {
    enabled: true,
    contextLength: 200_000,
    threshold: 0.8,
    strategyId: 'claude-code-compact-v1' as const,
    reservedOutputBudget: 20_000
  }

  it('classifies ordinary, pre-compress, and auto-compact pressure', () => {
    expect(classifyClaudeContextGate({ inputTokens: 100_000, config: gateConfig })).toMatchObject({
      kind: 'ok',
      blocking: false
    })
    expect(classifyClaudeContextGate({ inputTokens: 160_000, config: gateConfig })).toMatchObject({
      kind: 'pre_compress',
      blocking: false,
      reason: 'near_auto_compact_threshold'
    })
    expect(classifyClaudeContextGate({ inputTokens: 167_000, config: gateConfig })).toMatchObject({
      kind: 'auto_compact',
      blocking: false,
      reason: 'auto_compact_threshold_reached'
    })
  })

  it('classifies reserved output pressure before hard input overflow', () => {
    expect(classifyClaudeContextGate({ inputTokens: 185_000, config: gateConfig })).toMatchObject({
      kind: 'reserved_output_exceeded',
      blocking: true,
      reason: 'reserved_output_budget_exceeded',
      inputTokens: 185_000,
      contextLength: 200_000,
      reservedOutputTokens: 20_000
    })
  })

  it('classifies hard input overflow as blocking', () => {
    expect(classifyClaudeContextGate({ inputTokens: 201_000, config: gateConfig })).toMatchObject({
      kind: 'hard_limit_exceeded',
      blocking: true,
      reason: 'hard_context_limit_exceeded',
      inputTokens: 201_000,
      contextLength: 200_000
    })
  })
})
```

- [ ] **Step 2: Run the focused shared test and verify failure**

Run:

```bash
npm exec vitest -- run src/shared/__tests__/claude-context-compression-core.test.ts
```

Expected: FAIL because `classifyClaudeContextGate` is not exported.

- [ ] **Step 3: Create the gate classifier implementation**

Create `src/shared/claude-context-compression/gates.ts`:

```ts
import { getClaudeCompactBudget } from './budget'
import type { ClaudeCompactConfig } from './types'

export type ClaudeContextGateKind =
  | 'ok'
  | 'pre_compress'
  | 'auto_compact'
  | 'reserved_output_exceeded'
  | 'hard_limit_exceeded'

export type ClaudeContextGateReason =
  | 'compression_disabled'
  | 'invalid_context_length'
  | 'below_pre_compress_threshold'
  | 'near_auto_compact_threshold'
  | 'auto_compact_threshold_reached'
  | 'reserved_output_budget_exceeded'
  | 'hard_context_limit_exceeded'

export interface ClaudeContextGateResult {
  kind: ClaudeContextGateKind
  reason: ClaudeContextGateReason
  blocking: boolean
  inputTokens: number
  contextLength: number
  reservedOutputTokens: number
  effectiveContextWindow: number
  autoCompactThreshold: number
  preCompressThreshold: number
}

export function classifyClaudeContextGate(args: {
  inputTokens: number
  config: Pick<ClaudeCompactConfig, 'enabled' | 'contextLength' | 'reservedOutputBudget'>
  preCompressGapTokens?: number
}): ClaudeContextGateResult {
  const inputTokens = Math.max(0, Math.floor(args.inputTokens))
  const budget = getClaudeCompactBudget(args.config)
  const preCompressGapTokens = Math.max(1, Math.floor(args.preCompressGapTokens ?? 8_000))
  const preCompressThreshold = Math.max(1, budget.autoCompactThreshold - preCompressGapTokens)

  const base = {
    inputTokens,
    contextLength: budget.contextLength,
    reservedOutputTokens: budget.reservedOutputTokens,
    effectiveContextWindow: budget.effectiveContextWindow,
    autoCompactThreshold: budget.autoCompactThreshold,
    preCompressThreshold
  }

  if (!args.config.enabled) {
    return { ...base, kind: 'ok', reason: 'compression_disabled', blocking: false }
  }

  if (budget.contextLength <= 0) {
    return { ...base, kind: 'ok', reason: 'invalid_context_length', blocking: false }
  }

  if (inputTokens > budget.contextLength) {
    return {
      ...base,
      kind: 'hard_limit_exceeded',
      reason: 'hard_context_limit_exceeded',
      blocking: true
    }
  }

  if (inputTokens + budget.reservedOutputTokens > budget.contextLength) {
    return {
      ...base,
      kind: 'reserved_output_exceeded',
      reason: 'reserved_output_budget_exceeded',
      blocking: true
    }
  }

  if (inputTokens >= budget.autoCompactThreshold) {
    return {
      ...base,
      kind: 'auto_compact',
      reason: 'auto_compact_threshold_reached',
      blocking: false
    }
  }

  if (inputTokens >= preCompressThreshold) {
    return {
      ...base,
      kind: 'pre_compress',
      reason: 'near_auto_compact_threshold',
      blocking: false
    }
  }

  return { ...base, kind: 'ok', reason: 'below_pre_compress_threshold', blocking: false }
}
```

- [ ] **Step 4: Export the gate classifier**

Add this export to `src/shared/claude-context-compression/index.ts`:

```ts
export * from './gates'
```

- [ ] **Step 5: Run the shared test**

Run:

```bash
npm exec vitest -- run src/shared/__tests__/claude-context-compression-core.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/claude-context-compression/gates.ts src/shared/claude-context-compression/index.ts src/shared/__tests__/claude-context-compression-core.test.ts
git commit -m "feat(context): add Claude context gate classifier"
```

## Task 2: Add shared deterministic payload dehydration

**Files:**
- Create: `src/shared/claude-context-compression/payload.ts`
- Modify: `src/shared/claude-context-compression/index.ts`
- Modify: `src/shared/__tests__/claude-context-compression-core.test.ts`

- [ ] **Step 1: Write failing payload dehydration tests**

Append this block to `src/shared/__tests__/claude-context-compression-core.test.ts`:

```ts
import { dehydrateClaudeCompactPayloads } from '../claude-context-compression'

describe('shared Claude payload dehydration', () => {
  it('dehydrates a large recent tool result without breaking tool result identity', () => {
    nextMessageId = 0
    const large = `${'head\n'.repeat(2_000)}Authorization: Bearer secret-token\n${'tail\n'.repeat(2_000)}`
    const messages = [message('assistant', [toolUse('large')]), message('user', [toolResult('large', large)])]

    const result = dehydrateClaudeCompactPayloads(messages, {
      maxToolResultChars: 4_000,
      toolNameByResultId: new Map([['large', 'Bash']])
    })

    const serialized = JSON.stringify(result.messages)
    expect(result.changed).toBe(true)
    expect(result.payloadsCompacted).toBe(1)
    expect(serialized).toContain('[Tool result compacted for context budget]')
    expect(serialized).toContain('Tool: Bash')
    expect(serialized).toContain('Original chars:')
    expect(serialized).not.toContain('secret-token')
    expect(result.messages[1]?.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'tool_result', toolUseId: 'large' })])
    )
    expect(serialized.length).toBeLessThan(JSON.stringify(messages).length)
  })

  it('replaces image payloads inside oversized tool results', () => {
    nextMessageId = 0
    const messages = [
      message('assistant', [toolUse('image')]),
      message('user', [
        toolResult('image', [
          { type: 'text', text: 'x'.repeat(8_000) },
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
    ]

    const result = dehydrateClaudeCompactPayloads(messages, { maxToolResultChars: 2_000 })
    const serialized = JSON.stringify(result.messages)

    expect(result.changed).toBe(true)
    expect(serialized).toContain('[image omitted from long-task context payload]')
    expect(serialized).not.toContain('raw-image-secret')
    expect(serialized).not.toContain('private.png')
  })
})
```

- [ ] **Step 2: Run the focused shared test and verify failure**

Run:

```bash
npm exec vitest -- run src/shared/__tests__/claude-context-compression-core.test.ts
```

Expected: FAIL because `dehydrateClaudeCompactPayloads` is not exported.

- [ ] **Step 3: Create shared payload dehydration implementation**

Create `src/shared/claude-context-compression/payload.ts`:

```ts
import type {
  ClaudeCompactConfig,
  ClaudeCompactContentBlock,
  ClaudeCompactMessage,
  ClaudeCompactTextBlock,
  ClaudeCompactToolResultBlock
} from './types'

const REDACTED_VALUE = '[REDACTED]'
const TOOL_RESULT_COMPACTED_MARKER = '[Tool result compacted for context budget]'
const IMAGE_OMITTED_TEXT = '[image omitted from long-task context payload]'
const DEFAULT_MAX_TOOL_RESULT_CHARS = 12_000
const IMPORTANT_LINE_PATTERN =
  /\b(error|failed|failure|exception|traceback|panic|fatal|denied|timeout|warning|warn)\b/i

export interface ClaudePayloadDehydrationOptions {
  config?: Pick<ClaudeCompactConfig, 'contextLength' | 'reservedOutputBudget'> | null
  maxToolResultChars?: number
  toolNameByResultId?: Map<string, string>
}

export interface ClaudePayloadDehydrationResult {
  messages: ClaudeCompactMessage[]
  changed: boolean
  payloadsCompacted: number
  originalChars: number
  keptChars: number
}

function redactText(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi, REDACTED_VALUE)
    .replace(/\b((?:set-)?cookie\s*:\s*)[^\r\n]+/gi, `$1${REDACTED_VALUE}`)
    .replace(/\b(authorization\s*:\s*)(?:bearer|basic)\s+[^\r\n]+/gi, `$1${REDACTED_VALUE}`)
    .replace(/\b(api[_-]?key|token|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd)(\s*[:=]\s*)([^\s,;"'{}\]]+)/gi, (_match, key: string, separator: string) => `${key}${separator}${REDACTED_VALUE}`)
}

function resolveMaxToolResultChars(options?: ClaudePayloadDehydrationOptions): number {
  if (options?.maxToolResultChars && options.maxToolResultChars > 0) {
    return Math.floor(options.maxToolResultChars)
  }

  const contextLength = options?.config?.contextLength
  if (!contextLength || contextLength <= 0) return DEFAULT_MAX_TOOL_RESULT_CHARS
  return Math.max(2_000, Math.min(DEFAULT_MAX_TOOL_RESULT_CHARS, Math.floor(contextLength * 0.06)))
}

function collectImportantLines(text: string, limit = 40): string[] {
  const result: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!IMPORTANT_LINE_PATTERN.test(line)) continue
    result.push(line)
    if (result.length >= limit) break
  }
  return result
}

function compactLongText(text: string, args: { toolName: string; maxChars: number; isError?: boolean }): { text: string; compacted: boolean } {
  const redacted = redactText(text)
  if (redacted.length <= args.maxChars) {
    return { text: redacted, compacted: redacted !== text }
  }

  const headChars = Math.max(200, Math.floor(args.maxChars * 0.28))
  const tailChars = Math.max(120, Math.floor(args.maxChars * 0.14))
  const head = redacted.slice(0, headChars).trimEnd()
  const tail = redacted.slice(-tailChars).trimStart()
  const importantLines = collectImportantLines(redacted, 20)
  const body = [
    TOOL_RESULT_COMPACTED_MARKER,
    `Tool: ${args.toolName}`,
    `Original chars: ${text.length}`,
    `Kept chars: ${head.length + tail.length}`,
    `Omitted middle chars: ${Math.max(0, text.length - head.length - tail.length)}`,
    args.isError ? 'Result status: error' : 'Result status: success',
    '',
    '## Head',
    head,
    importantLines.length ? `## Important lines preserved\n${importantLines.join('\n')}` : '',
    '## Tail',
    tail
  ]
    .filter(Boolean)
    .join('\n')

  if (body.length <= args.maxChars) return { text: body, compacted: true }
  return { text: `${TOOL_RESULT_COMPACTED_MARKER}\n${body.slice(0, Math.max(0, args.maxChars - TOOL_RESULT_COMPACTED_MARKER.length - 1))}`, compacted: true }
}

function estimateToolResultChars(content: ClaudeCompactToolResultBlock['content']): number {
  if (typeof content === 'string') return content.length
  return content.reduce((sum, block) => {
    if (block.type === 'text') return sum + block.text.length
    return sum + IMAGE_OMITTED_TEXT.length
  }, 0)
}

function dehydrateToolResultBlock(
  block: ClaudeCompactToolResultBlock,
  options: Required<Pick<ClaudePayloadDehydrationOptions, 'toolNameByResultId'>> & { maxChars: number }
): { block: ClaudeCompactToolResultBlock; changed: boolean; originalChars: number; keptChars: number } {
  const originalChars = estimateToolResultChars(block.content)
  const toolName = options.toolNameByResultId.get(block.toolUseId) ?? 'unknown'

  if (typeof block.content === 'string') {
    const compacted = compactLongText(block.content, {
      toolName,
      maxChars: options.maxChars,
      isError: block.isError
    })
    return {
      block: compacted.compacted ? { ...block, content: compacted.text } : block,
      changed: compacted.compacted,
      originalChars,
      keptChars: compacted.text.length
    }
  }

  let changed = false
  const textBudget = Math.max(200, options.maxChars)
  const content = block.content.map((item): ClaudeCompactTextBlock => {
    if (item.type === 'image') {
      changed = true
      return { type: 'text', text: IMAGE_OMITTED_TEXT }
    }

    const compacted = compactLongText(item.text, {
      toolName,
      maxChars: textBudget,
      isError: block.isError
    })
    changed ||= compacted.compacted
    return { type: 'text', text: compacted.text }
  })

  const keptChars = estimateToolResultChars(content)
  return {
    block: changed ? { ...block, content } : block,
    changed,
    originalChars,
    keptChars
  }
}

function buildToolNameByResultId(messages: ClaudeCompactMessage[]): Map<string, string> {
  const result = new Map<string, string>()
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block.type === 'tool_use') result.set(block.id, block.name)
    }
  }
  return result
}

export function dehydrateClaudeCompactPayloads(
  messages: ClaudeCompactMessage[],
  options: ClaudePayloadDehydrationOptions = {}
): ClaudePayloadDehydrationResult {
  const maxChars = resolveMaxToolResultChars(options)
  const toolNameByResultId = options.toolNameByResultId ?? buildToolNameByResultId(messages)
  let changed = false
  let payloadsCompacted = 0
  let originalChars = 0
  let keptChars = 0

  const nextMessages = messages.map((message) => {
    if (!Array.isArray(message.content)) return message

    let messageChanged = false
    const content = message.content.map((block): ClaudeCompactContentBlock => {
      if (block.type !== 'tool_result') return block
      const dehydrated = dehydrateToolResultBlock(block, { maxChars, toolNameByResultId })
      originalChars += dehydrated.originalChars
      keptChars += dehydrated.keptChars
      if (!dehydrated.changed) return block
      changed = true
      messageChanged = true
      payloadsCompacted += 1
      return dehydrated.block
    })

    return messageChanged ? { ...message, content } : message
  })

  return {
    messages: changed ? nextMessages : messages,
    changed,
    payloadsCompacted,
    originalChars,
    keptChars
  }
}
```

- [ ] **Step 4: Export shared payload dehydration**

Add this export to `src/shared/claude-context-compression/index.ts`:

```ts
export * from './payload'
```

- [ ] **Step 5: Run the shared test**

Run:

```bash
npm exec vitest -- run src/shared/__tests__/claude-context-compression-core.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/claude-context-compression/payload.ts src/shared/claude-context-compression/index.ts src/shared/__tests__/claude-context-compression-core.test.ts
git commit -m "feat(context): add shared payload dehydration"
```

## Task 3: Add recent payload fallback to the shared Claude compact engine

**Files:**
- Modify: `src/shared/claude-context-compression/types.ts`
- Modify: `src/shared/claude-context-compression/engine.ts`
- Modify: `src/shared/__tests__/claude-context-compression-core.test.ts`

- [ ] **Step 1: Write the failing fallback test**

Append this block to `src/shared/__tests__/claude-context-compression-core.test.ts`:

```ts
describe('shared Claude recent payload fallback', () => {
  it('dehydrates recent payloads when no historical API round can be summarized', async () => {
    nextMessageId = 0
    const summarize = vi.fn(async () => '<summary>should not be called</summary>')
    const messages = [
      message('user', 'inspect current task'),
      message('assistant', [toolUse('huge')]),
      message('user', [toolResult('huge', 'error line\n'.repeat(12_000))]),
      message('assistant', 'continue current task')
    ]

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
      summarize,
      now: () => 123,
      createId: (() => {
        let id = 0
        return () => `fallback-${++id}`
      })()
    })

    const serialized = JSON.stringify(result.messages)
    expect(result.result.compressed).toBe(true)
    expect(result.result.messagesSummarized).toBe(0)
    expect(result.result.payloadsCompacted).toBe(1)
    expect(result.result.reason).toBeUndefined()
    expect(summarize).not.toHaveBeenCalled()
    expect(serialized).toContain('[Tool result compacted for context budget]')
    expect(serialized.length).toBeLessThan(JSON.stringify(messages).length)
  })

  it('keeps the existing skip reason when there is no payload to dehydrate', async () => {
    nextMessageId = 0
    const messages = [
      message('user', 'inspect current task'),
      message('assistant', [toolUse('small')]),
      message('user', [toolResult('small', 'ok')]),
      message('assistant', 'done')
    ]

    const result = await runClaudeCompact({
      messages,
      trigger: 'manual',
      preTokens: 1_000,
      config: {
        enabled: true,
        contextLength: 200_000,
        threshold: 0.8,
        strategyId: 'claude-code-compact-v1',
        reservedOutputBudget: 20_000
      },
      summarize: vi.fn()
    })

    expect(result.result.compressed).toBe(false)
    expect(result.result.reason).toBe('insufficient_compressible_messages')
    expect(result.messages).toBe(messages)
  })
})
```

- [ ] **Step 2: Run the focused shared test and verify failure**

Run:

```bash
npm exec vitest -- run src/shared/__tests__/claude-context-compression-core.test.ts
```

Expected: FAIL because `payloadsCompacted` is not defined and `runClaudeCompact` still returns `insufficient_compressible_messages`.

- [ ] **Step 3: Extend shared result metadata**

In `src/shared/claude-context-compression/types.ts`, extend `ClaudeCompactSkipReason` and `ClaudeCompactResult`:

```ts
export type ClaudeCompactSkipReason =
  | 'insufficient_messages'
  | 'insufficient_compressible_messages'
  | 'recent_payload_too_large'
  | 'single_input_too_large'
  | 'hard_context_limit_exceeded'
  | 'reserved_output_budget_exceeded'
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
  payloadsCompacted?: number
  reason?: ClaudeCompactSkipReason
}
```

- [ ] **Step 4: Wire fallback into `runClaudeCompact` before returning the skip result**

In `src/shared/claude-context-compression/engine.ts`, import the payload helper:

```ts
import { dehydrateClaudeCompactPayloads } from './payload'
```

Then replace the early `if (!selection.ok)` return block with this logic:

```ts
  if (!selection.ok) {
    if (selection.reason === 'insufficient_compressible_messages') {
      const dehydrated = dehydrateClaudeCompactPayloads(args.messages, { config: args.config })
      if (dehydrated.changed) {
        return {
          messages: dehydrated.messages,
          result: {
            compressed: true,
            originalCount: args.messages.length,
            newCount: dehydrated.messages.length,
            messagesSummarized: 0,
            payloadsCompacted: dehydrated.payloadsCompacted
          }
        }
      }
    }

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
```

- [ ] **Step 5: Run the shared test**

Run:

```bash
npm exec vitest -- run src/shared/__tests__/claude-context-compression-core.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/claude-context-compression/types.ts src/shared/claude-context-compression/engine.ts src/shared/__tests__/claude-context-compression-core.test.ts
git commit -m "feat(context): add recent payload fallback"
```

## Task 4: Surface payload fallback through the renderer compression adapter

**Files:**
- Modify: `src/renderer/src/lib/agent/context-compression.ts`
- Modify: `src/renderer/src/lib/agent/__tests__/claude-context-compression.test.ts`

- [ ] **Step 1: Write a renderer adapter fallback test**

Append this test to the `describe('claude-code-compact-v1 engine', ...)` block in `src/renderer/src/lib/agent/__tests__/claude-context-compression.test.ts`:

```ts
  it('returns compressed renderer messages when shared recent payload fallback dehydrates tool results', async () => {
    const messages = [
      message('user', 'single current task'),
      message('assistant', [toolUse('recent-large', 'Bash')]),
      message('user', [toolResult('recent-large', 'warning line\n'.repeat(12_000))]),
      message('assistant', 'continue')
    ]

    const result = await compressMessages(
      messages,
      providerConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      'manual',
      190_000,
      {
        enabled: true,
        contextLength: 200_000,
        threshold: 0.8,
        strategyId: 'claude-code-compact-v1',
        reservedOutputBudget: 20_000
      }
    )

    expect(result.result.compressed).toBe(true)
    expect(result.result.messagesSummarized).toBe(0)
    expect(result.result.payloadsCompacted).toBe(1)
    expect(JSON.stringify(result.messages)).toContain('[Tool result compacted for context budget]')
    expect(runSidecarTextRequest).not.toHaveBeenCalled()
  })
```

- [ ] **Step 2: Run the renderer test and verify failure**

Run:

```bash
npm exec vitest -- run src/renderer/src/lib/agent/__tests__/claude-context-compression.test.ts
```

Expected: FAIL because renderer `CompressionResult` does not expose `payloadsCompacted` yet.

- [ ] **Step 3: Extend renderer compression result type**

In `src/renderer/src/lib/agent/context-compression.ts`, extend `CompressionSkipReason` and `CompressionResult`:

```ts
export type CompressionSkipReason =
  | 'insufficient_messages'
  | 'insufficient_compressible_messages'
  | 'recent_payload_too_large'
  | 'single_tool_result_too_large'
  | 'single_input_too_large'
  | 'hard_context_limit_exceeded'
  | 'reserved_output_budget_exceeded'
  | 'summarizer_prompt_too_long'
  | 'summarizer_failed'
  | 'circuit_breaker_open'
  | 'unsafe_boundary'
  | 'unsafe_summary_output'
  | 'cancelled'
  | 'unknown'

export interface CompressionResult {
  compressed: boolean
  originalCount: number
  newCount: number
  messagesSummarized?: number
  payloadsCompacted?: number
  reason?: CompressionSkipReason
}
```

No adapter code should be needed if the shared result is already cast through `claude-compact-engine.ts`; this type update makes the metadata explicit and type-safe for callers.

- [ ] **Step 4: Run the renderer test**

Run:

```bash
npm exec vitest -- run src/renderer/src/lib/agent/__tests__/claude-context-compression.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/agent/context-compression.ts src/renderer/src/lib/agent/__tests__/claude-context-compression.test.ts
git commit -m "feat(context): expose renderer payload fallback result"
```

## Task 5: Add renderer request hard gate before provider calls

**Files:**
- Modify: `src/renderer/src/lib/agent/agent-loop.ts`
- Modify: `src/renderer/src/lib/agent/__tests__/long-task-context.test.ts`

- [ ] **Step 1: Write the failing renderer hard-gate test**

Add a test to `src/renderer/src/lib/agent/__tests__/long-task-context.test.ts` that creates a context compression config with a tiny context window and a `compressFn` that cannot reduce messages:

```ts
it('blocks the next provider request when context still exceeds the hard limit after compaction', async () => {
  const events: AgentEvent[] = []
  const abortController = new AbortController()
  const providerSend = vi.fn(async function* () {
    yield { type: 'text_delta', text: 'should not be called' }
    yield { type: 'message_end' }
  })

  vi.mocked(createProvider).mockReturnValue({ sendMessage: providerSend } as never)

  const messages: UnifiedMessage[] = [
    {
      id: 'm-hard',
      role: 'user',
      content: 'x'.repeat(20_000),
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
          contextLength: 1_000,
          threshold: 0.8,
          strategyId: 'claude-code-compact-v1',
          reservedOutputBudget: 200
        },
        compressFn: async (input) => input
      }
    },
    { sessionId: 'session-1', signal: abortController.signal }
  )) {
    events.push(event)
  }

  expect(providerSend).not.toHaveBeenCalled()
  expect(events.some((event) => event.type === 'error' && /hard context limit/i.test(event.error.message))).toBe(true)
  expect(events.at(-1)).toMatchObject({ type: 'loop_end', reason: 'error' })
})
```

If the existing test file uses different local helpers or mocks, keep the same assertion shape: provider must not be called, an error event must be emitted, and the loop must end with `reason: 'error'`.

- [ ] **Step 2: Run the renderer long-task test and verify failure**

Run:

```bash
npm exec vitest -- run src/renderer/src/lib/agent/__tests__/long-task-context.test.ts
```

Expected: FAIL because the provider is still called after unsuccessful compression.

- [ ] **Step 3: Import the shared gate classifier**

In `src/renderer/src/lib/agent/agent-loop.ts`, add the import:

```ts
import { classifyClaudeContextGate } from '../../../../shared/claude-context-compression'
```

- [ ] **Step 4: Add a small hard-gate error helper**

Near the existing helper functions in `src/renderer/src/lib/agent/agent-loop.ts`, add:

```ts
function createContextGateError(gate: ReturnType<typeof classifyClaudeContextGate>): Error {
  return new Error(
    `Hard context limit reached before model request: ${gate.reason}; input=${gate.inputTokens}; context=${gate.contextLength}; reservedOutput=${gate.reservedOutputTokens}`
  )
}
```

- [ ] **Step 5: Block after compression if hard pressure remains**

Inside the existing context management block before `iteration++`, after any full compression or pre-compression has run, add a final gate check:

```ts
        const finalTokens = Math.max(lastObservedContextTokens, estimateMessagesTokens(conversationMessages))
        const finalGate = classifyClaudeContextGate({ inputTokens: finalTokens, config: cc.config })
        if (finalGate.blocking) {
          yield { type: 'error', error: createContextGateError(finalGate), errorType: finalGate.reason }
          yield buildLoopEndEvent('error')
          return
        }
```

Place this check inside `if (config.contextCompression) { ... }`, after the existing `shouldCompress` / `shouldPreCompress` branches. This ensures the next `provider.sendMessage(...)` cannot be reached while `hard_limit_exceeded` or `reserved_output_exceeded` is still true.

- [ ] **Step 6: Run the renderer long-task test**

Run:

```bash
npm exec vitest -- run src/renderer/src/lib/agent/__tests__/long-task-context.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/lib/agent/agent-loop.ts src/renderer/src/lib/agent/__tests__/long-task-context.test.ts
git commit -m "fix(agent): block renderer requests over hard context limit"
```

## Task 6: Add main runtime hard-gate preflight

**Files:**
- Modify: `src/main/cron/context-compression-runtime.ts`
- Modify: `src/main/cron/__tests__/context-compression-runtime.test.ts`

- [ ] **Step 1: Write failing main runtime hard-gate tests**

Append these tests to `src/main/cron/__tests__/context-compression-runtime.test.ts`:

```ts
  it('blocks when the preflight context remains above the hard context limit after compaction', async () => {
    const hugeConfig: MainRuntimeCompressionConfig = {
      enabled: true,
      contextLength: 1_000,
      threshold: 0.8,
      strategyId: 'claude-code-compact-v1',
      reservedOutputBudget: 200
    }
    const messages = [message('user', 'x'.repeat(20_000))]

    const result = await maybeCompactMainRuntimeContext({
      messages,
      config: hugeConfig,
      trigger: 'auto',
      summarize: vi.fn()
    })

    expect(result.blocked).toBe(true)
    expect(result.reason).toBe('hard_context_limit_exceeded')
    expect(result.compressed).toBe(false)
    expect(result.events).toEqual([
      expect.objectContaining({ type: 'context_compression_blocked', reason: 'hard_context_limit_exceeded' })
    ])
  })

  it('blocks when reserved output budget would overflow the next request', async () => {
    const tightConfig: MainRuntimeCompressionConfig = {
      enabled: true,
      contextLength: 1_000,
      threshold: 0.8,
      strategyId: 'claude-code-compact-v1',
      reservedOutputBudget: 300
    }
    const messages = [message('user', 'x'.repeat(3_000))]

    const result = await maybeCompactMainRuntimeContext({
      messages,
      config: tightConfig,
      trigger: 'auto',
      summarize: vi.fn()
    })

    expect(result.blocked).toBe(true)
    expect(result.reason).toBe('reserved_output_budget_exceeded')
  })
```

- [ ] **Step 2: Run the main runtime test and verify failure**

Run:

```bash
npm exec vitest -- run src/main/cron/__tests__/context-compression-runtime.test.ts
```

Expected: FAIL because `blocked`, `reason`, and `context_compression_blocked` do not exist yet.

- [ ] **Step 3: Extend main runtime preflight types**

In `src/main/cron/context-compression-runtime.ts`, import gate types and extend the event/result types:

```ts
import {
  classifyClaudeContextGate,
  getClaudeCompactBudget,
  runClaudeCompact,
  type ClaudeCompactConfig,
  type ClaudeCompactContentBlock,
  type ClaudeCompactMessage,
  type ClaudeCompactTrigger,
  type ClaudeContextGateReason
} from '../../shared/claude-context-compression'
```

Then update types:

```ts
export type MainRuntimeCompressionEvent =
  | { type: 'context_compression_start' }
  | {
      type: 'context_compressed'
      originalCount: number
      newCount: number
      messages: MainRuntimeMessage[]
    }
  | {
      type: 'context_compression_blocked'
      reason: ClaudeContextGateReason
      inputTokens: number
      contextLength: number
      reservedOutputTokens: number
    }

export interface MainRuntimeCompressionPreflightResult {
  messages: MainRuntimeMessage[]
  compressed: boolean
  blocked?: boolean
  reason?: ClaudeContextGateReason
  events: MainRuntimeCompressionEvent[]
}
```

- [ ] **Step 4: Use shared gate classification in main preflight**

In `maybeCompactMainRuntimeContext`, after `conservativeTokens` is computed, classify pressure:

```ts
  const initialGate = classifyClaudeContextGate({ inputTokens: conservativeTokens, config: args.config })
```

Keep the existing no-compact return when `initialGate.kind === 'ok'` or `initialGate.kind === 'pre_compress'` after pre-compression. For blocking states, run full compact once when possible, then re-check:

```ts
  if (initialGate.kind === 'ok' || initialGate.kind === 'pre_compress') {
    return { messages: candidateMessages, compressed: false, events: [] }
  }
```

After the existing `runClaudeCompact(...)` call, compute the final gate over either `compacted.messages` or `candidateMessages`:

```ts
  const finalMessages = compacted.result.compressed ? compacted.messages : candidateMessages
  const finalTokens = Math.max(findRecentMainRuntimeContextUsage(finalMessages), estimateMainRuntimeMessagesTokens(finalMessages))
  const finalGate = classifyClaudeContextGate({ inputTokens: finalTokens, config: args.config })

  if (finalGate.blocking) {
    return {
      messages: finalMessages,
      compressed: compacted.result.compressed,
      blocked: true,
      reason: finalGate.reason,
      events: [
        {
          type: 'context_compression_blocked',
          reason: finalGate.reason,
          inputTokens: finalGate.inputTokens,
          contextLength: finalGate.contextLength,
          reservedOutputTokens: finalGate.reservedOutputTokens
        }
      ]
    }
  }
```

Preserve the existing `context_compression_start` and `context_compressed` event behavior when compact succeeds and the final gate is not blocking.

- [ ] **Step 5: Run the main runtime test**

Run:

```bash
npm exec vitest -- run src/main/cron/__tests__/context-compression-runtime.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/cron/context-compression-runtime.ts src/main/cron/__tests__/context-compression-runtime.test.ts
git commit -m "fix(main): block requests over hard context limit"
```

## Task 7: Run aggregate context tests and update diagnostics if needed

**Files:**
- Modify only if tests fail due stale expectations:
  - `src/main/ipc/__tests__/js-agent-runtime-compression.test.ts`
  - `src/renderer/src/lib/agent/__tests__/shared-runtime-sidecar-compression.test.ts`
  - `scripts/diagnose-context-regressions.mjs`
  - `scripts/diagnose-long-task-context-compression.mjs`

- [ ] **Step 1: Run aggregate context tests**

Run:

```bash
npm run test:agent-context
```

Expected: PASS.

- [ ] **Step 2: Run diagnostic scripts**

Run:

```bash
npm run diagnose:context-regressions
npm run diagnose:long-task-compression
```

Expected: both scripts complete successfully. If a script reports an expected reason mismatch, update only the reason mapping or expected event shape related to the new hard-gate behavior.

- [ ] **Step 3: Run lint and typecheck**

Run:

```bash
npm run lint
npm run typecheck
```

Expected: both commands PASS.

- [ ] **Step 4: Commit verification-related fixes if any**

If Step 2 or Step 3 required test or diagnostic expectation updates, commit them:

```bash
git add src/main/ipc/__tests__/js-agent-runtime-compression.test.ts src/renderer/src/lib/agent/__tests__/shared-runtime-sidecar-compression.test.ts scripts/diagnose-context-regressions.mjs scripts/diagnose-long-task-context-compression.mjs
git commit -m "test(context): update hard gate diagnostics"
```

If no files changed, skip this commit.

## Task 8: Request implementation review

**Files:**
- No implementation files changed in this task.

- [ ] **Step 1: Capture the implementation range**

Run:

```bash
git log --oneline -8
```

Expected: shows commits from Tasks 1 through 7.

- [ ] **Step 2: Request code review**

Use the `requesting-code-review` skill and ask the reviewer to check:

- hard gate cannot send an over-limit model request;
- recent payload fallback does not break `tool_use/tool_result` pairing;
- shared/renderer/main behavior remains consistent;
- `partial-summary-v1` behavior is unchanged;
- deterministic dehydration does not leak secrets;
- no new infinite compact loop is introduced.

- [ ] **Step 3: Address review feedback before starting another phase**

Fix Critical and Important feedback before planning partial compact or checkpoint scheduler work.

---

## Verification Checklist

Run these commands before considering this phase complete:

```bash
npm exec vitest -- run src/shared/__tests__/claude-context-compression-core.test.ts
npm exec vitest -- run src/renderer/src/lib/agent/__tests__/claude-context-compression.test.ts
npm exec vitest -- run src/renderer/src/lib/agent/__tests__/long-task-context.test.ts
npm exec vitest -- run src/main/cron/__tests__/context-compression-runtime.test.ts
npm run test:agent-context
npm run diagnose:context-regressions
npm run diagnose:long-task-compression
npm run lint
npm run typecheck
```

Expected final state:

- a recent oversized tool payload can be dehydrated without a summarizer call when ordinary compact has no safe historical range;
- renderer and main runtimes do not send a provider request when `inputTokens > contextWindow` remains true;
- renderer and main runtimes do not send a provider request when `inputTokens + reservedOutputTokens > contextWindow` remains true;
- ordinary auto compact and manual `/compact` keep working;
- existing Prompt Too Long retry behavior remains unchanged;
- no secrets appear in dehydrated payloads or compact summaries.

## Follow-up Plans After This Phase

After this phase passes review, create separate plans for:

1. checkpoint-based auto compact at tool/result and step boundaries;
2. assistant output finalize checkpoint;
3. partial compact / from-up-to compact;
4. UI reason taxonomy and diagnostics panel;
5. session memory, hooks, prompt cache baseline, and relink metadata.
