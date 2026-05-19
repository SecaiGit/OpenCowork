# 长任务上下文压缩 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 扩展现有上下文压缩机制，使一次用户输入触发的长任务在单轮内产生大量工具结果时，也能在下一次模型请求前自动脱水、摘要或降级，避免 90% token 占用却无法压缩、以及 renderer 长会话白屏。

**Architecture:** 采用 clean-room 方式参考 Claude Code 的上下文管理思路：有效上下文窗口、保护 tool_use/tool_result 配对的 API round 分组、microcompact、Prompt Too Long 剥离重试、post-compact 状态重注入。第一阶段不把压缩迁移到主进程 sidecar，因为当前 `src/main/ipc/js-agent-runtime.ts` 和 `src/main/cron/cron-agent-background.ts` 还没有 compression 钩子；本计划先在 renderer agent loop 内控制发给模型的 replay transcript，并停止“启用压缩即全量加载历史”的高风险路径。UI/持久化展示与模型上下文 replay 分离：用户可见工具结果尽量保持完整，只有下一轮模型请求和 final replay transcript 使用脱水后的 payload。

**Tech Stack:** Electron、React 19、TypeScript strict、Zustand、i18next、现有 renderer `runAgentLoop`、`context-compression.ts`、SQLite message window、现有 `scripts/diagnose-context-regressions.mjs`。

---

## 参考依据与边界

参考资料：

- `https://github.com/liuup/claude-code-analysis/blob/main/analysis/04f-context-management.md`
- `https://github.com/chauncygu/collection-claude-code-source-code`

从参考实现吸收的机制：

- effective context window = context window - reserved output tokens。
- auto compact threshold = effective window - buffer tokens。
- Prompt Too Long 时按 API round 从头剥离并重试。
- microcompact 优先清理旧工具结果，而不是只做全历史摘要。
- compact 后重注入工作状态：计划、任务、已读文件、工具连续性说明。
- 失败熔断，避免同一会话无限压缩失败。

本计划不直接复制参考仓库源码，只移植设计思想，并使用 OpenCowork 现有类型、消息结构和 i18n。

## 当前关键约束

- 当前 `context-compression-routing.ts` 在压缩启用时强制 renderer loop，是为了避免 sidecar 丢弃 compression 配置。
- `scripts/diagnose-context-regressions.mjs` 明确检查：如果主进程 runtime 不支持 compression，则不能让 compression-enabled run 进入 sidecar。
- 因此本计划第一版不恢复 sidecar 路由；否则会重新引入“压缩配置被 sidecar 吞掉”的回归。
- 白屏的主要缓解点改为：不再启用压缩就全量取历史；工具结果进入模型 replay 上下文前先预算化脱水；下一轮模型请求前做 preflight compaction。
- 脱水只作用于模型上下文 replay 与压缩输入，不应覆盖 `tool_call_result` 事件里的用户可见输出；如果某处必须持久化脱水结果，必须保留原始结果的 UI 可见路径或明确可展开来源。
- API round 的不可拆单元是“assistant 产生的 tool_use 与后续 user tool_result 批次”。PTL retry 可以丢弃旧 round，但不能保留孤立 tool_result，也不能把未响应的 tool_use 单独发给 summarizer。
- provider 回包 usage 与本地估算 token 必须分开命名：`lastObservedContextTokens` 表示 provider 观测值，`estimatedReplayTokens` 表示本地 replay transcript 估算值，压缩决策使用二者最大值。
- 每次 post-compact state 注入前都要去掉旧的 `meta.postCompactState` preserved message，避免多次压缩后重复堆叠状态消息。
- `IMAGE_APPROX_TOKENS` 只用于触发阈值的保守估算，不用于展示真实用量、计费或替代 provider usage。

---

## 文件结构

- Create: `src/renderer/src/lib/agent/context-budget.ts`
  - 纯函数模块：估算消息 token、计算窗口阈值、识别过大工具结果、保护 tool_use/tool_result 配对的 API round 分组。
- Create: `src/renderer/src/lib/agent/context-payload-compaction.ts`
  - 纯函数模块：为模型上下文 replay 做工具结果脱水、文本头尾保留、错误行保留、图片替换、最近 payload 清理；不直接决定 UI 展示内容。
- Create: `src/renderer/src/lib/agent/context-state-format.ts`
  - 纯函数模块：接收 plain snapshot，格式化 post-compact working state 文本；不依赖 store、i18n 或 renderer runtime。
- Create: `src/renderer/src/lib/agent/context-state-attachments.ts`
  - renderer adapter：从 `readFileHistory`、plan store、task store、i18n 收集 plain snapshot，再调用 `context-state-format.ts`。
- Modify: `src/renderer/src/lib/agent/context-compression.ts`
  - 增加 skip reason、PTL retry、post-compact attachment message、最近 payload 脱水入口。
- Modify: `src/renderer/src/lib/api/types.ts`
  - 给 `MessageMeta` 增加 `postCompactState` 标记，区分压缩后状态注入消息与用户手写输入。
- Modify: `src/renderer/src/lib/agent/types.ts`
  - 扩展 `AgentLoopConfig.contextCompression`，允许传入 post-compact context builder。
- Modify: `src/renderer/src/lib/agent/agent-loop.ts`
  - 工具结果写入模型 replay conversation 前脱水，并保留 UI/display 输出；下一次 provider 请求前做 preflight；压缩事件携带 reason。
- Modify: `src/renderer/src/lib/agent/shared-runtime.ts`
  - 让共享 runtime 构造外部注入的 tool_result message 时也复用脱水逻辑。
- Modify: `src/renderer/src/hooks/use-chat-actions.ts`
  - 不再启用压缩就 `requestContextMaxMessages = null`；接入 post-compact state builder；手动压缩 toast 按 reason 展示。
- Modify: `src/renderer/src/locales/zh/agent.json`
  - 增加压缩 reason、payload compact、post-compact state 文案。
- Modify: `src/renderer/src/locales/en/agent.json`
  - 增加对应英文文案。
- Create: `vitest.config.ts`
  - 为 renderer 纯函数测试提供 `@renderer` alias 与 node test environment。
- Create: `src/renderer/src/lib/agent/__tests__/long-task-context.test.ts`
  - 可执行 fixture：验证 API round 分组、payload reason、post-compact formatter、PTL retry。
- Modify: `package.json`
  - 增加 `vitest` devDependency、`test:agent-context` 与 `diagnose:long-task-compression` 脚本。
- Modify: `package-lock.json`
  - 由 `npm install -D vitest` 更新；不要手写 lockfile。
- Create: `scripts/diagnose-long-task-context-compression.mjs`
  - 静态回归诊断，确保长任务压缩保护点没有被移除。

---

## 推荐执行顺序

为先切断白屏最大风险，执行时按下面顺序推进，而不是按文档中出现顺序机械执行：

1. 先执行 Task 8，停止压缩启用时全量加载历史，并跑 `diagnose:context-regressions`。
2. 执行 Task 1 和 Task 2，补齐 budget 与 payload 脱水纯函数。
3. 执行 Task 4 和 Task 5，让长工具结果只在模型 replay transcript 中脱水，并在下一轮 provider 请求前 preflight。
4. 执行 Task 3 和 Task 6，补 skip reason 与 Prompt Too Long retry。
5. 执行 Task 7，注入 post-compact 当前工作状态。
6. 执行 Task 9，补纯函数 fixture 测试。
7. 执行 Task 10 和 Task 11，完成静态诊断、lint、typecheck 与手动回归。

---

### Task 1: 新增 context budget 纯函数模块

**Files:**

- Create: `src/renderer/src/lib/agent/context-budget.ts`

- [ ] **Step 1: 创建 token/char 估算与阈值函数**

新增文件，保持无 store、无 i18n、无 IPC 依赖。

```ts
import type { ContentBlock, ToolResultContent, UnifiedMessage } from '../api/types'
import {
  CONTEXT_COMPRESSION_AUTO_BUFFER_TOKENS,
  DEFAULT_CONTEXT_COMPRESSION_RESERVED_OUTPUT_TOKENS,
  getCompressionTriggerTokens,
  getEffectiveContextWindow,
  type CompressionConfig
} from './context-compression'

const APPROX_CHARS_PER_TOKEN = 4
const IMAGE_APPROX_TOKENS = 2_000 // trigger-only conservative estimate, not billable usage

export interface ContextBudgetSnapshot {
  estimatedTokens: number
  effectiveWindow: number
  compressionTriggerTokens: number
  autoBufferTokens: number
  oversizedToolResults: number
  largestToolResultChars: number
}

export interface ApiRoundGroup {
  start: number
  end: number
  messages: UnifiedMessage[]
}

export function estimateTextTokens(value: string): number {
  if (!value) return 0
  return Math.ceil(value.length / APPROX_CHARS_PER_TOKEN)
}

export function serializeToolResultContent(content: ToolResultContent): string {
  if (typeof content === 'string') return content
  return content
    .map((block) => {
      if (block.type === 'text') return block.text
      if (block.type === 'image') return '[image]'
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

export function estimateToolResultChars(content: ToolResultContent): number {
  if (typeof content === 'string') return content.length
  return content.reduce((total, block) => {
    if (block.type === 'text') return total + block.text.length
    if (block.type === 'image') return total + IMAGE_APPROX_TOKENS * APPROX_CHARS_PER_TOKEN
    return total
  }, 0)
}

export function estimateContentBlockTokens(block: ContentBlock): number {
  switch (block.type) {
    case 'text':
      return estimateTextTokens(block.text)
    case 'thinking':
      return estimateTextTokens(block.thinking) + estimateTextTokens(block.encryptedContent ?? '')
    case 'tool_use':
      return estimateTextTokens(block.name) + estimateTextTokens(JSON.stringify(block.input))
    case 'tool_result':
      return Math.ceil(estimateToolResultChars(block.content) / APPROX_CHARS_PER_TOKEN)
    case 'image':
      return IMAGE_APPROX_TOKENS
    case 'image_error':
    case 'agent_error':
      return estimateTextTokens(block.message)
    default:
      return 0
  }
}

export function estimateMessageTokens(message: UnifiedMessage): number {
  if (typeof message.content === 'string') {
    return estimateTextTokens(message.content)
  }
  return message.content.reduce((sum, block) => sum + estimateContentBlockTokens(block), 0)
}

export function estimateMessagesTokens(messages: UnifiedMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
}

export function buildContextBudgetSnapshot(
  messages: UnifiedMessage[],
  config: CompressionConfig
): ContextBudgetSnapshot {
  let oversizedToolResults = 0
  let largestToolResultChars = 0

  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block.type !== 'tool_result') continue
      const chars = estimateToolResultChars(block.content)
      largestToolResultChars = Math.max(largestToolResultChars, chars)
      if (chars > getLargeToolResultCharLimit(config)) {
        oversizedToolResults += 1
      }
    }
  }

  return {
    estimatedTokens: estimateMessagesTokens(messages),
    effectiveWindow: getEffectiveContextWindow(config),
    compressionTriggerTokens: getCompressionTriggerTokens(config),
    autoBufferTokens: CONTEXT_COMPRESSION_AUTO_BUFFER_TOKENS,
    oversizedToolResults,
    largestToolResultChars
  }
}

export function getLargeToolResultCharLimit(config?: CompressionConfig | null): number {
  const reserved = config?.reservedOutputBudget ?? DEFAULT_CONTEXT_COMPRESSION_RESERVED_OUTPUT_TOKENS
  const effectiveWindow = config ? getEffectiveContextWindow(config) : 200_000 - reserved
  const tokenBudget = Math.max(2_000, Math.min(12_000, Math.floor(effectiveWindow * 0.06)))
  return tokenBudget * APPROX_CHARS_PER_TOKEN
}

function collectToolUseIds(message: UnifiedMessage): string[] {
  if (!Array.isArray(message.content)) return []
  return message.content
    .filter((block) => block.type === 'tool_use')
    .map((block) => block.id)
}

function collectToolResultIds(message: UnifiedMessage): string[] {
  if (!Array.isArray(message.content)) return []
  return message.content
    .filter((block) => block.type === 'tool_result')
    .map((block) => block.toolUseId)
}

/**
 * Groups replay transcript into safe drop units for Prompt Too Long retry.
 *
 * A group ends after either:
 * - a plain assistant response with no tool_use; or
 * - an assistant tool_use response plus the following user tool_result batch that answers all ids.
 *
 * This protects provider protocol invariants: dropping old groups must not leave a kept tool_result
 * without its matching tool_use, and must not leave an unanswered tool_use at the end of a group.
 */
export function groupMessagesByApiRound(messages: UnifiedMessage[]): ApiRoundGroup[] {
  const groups: ApiRoundGroup[] = []
  let start = 0
  let current: UnifiedMessage[] = []
  let pendingToolUseIds = new Set<string>()
  let currentHasAssistant = false
  let currentHasToolUse = false

  const flush = (end: number): void => {
    if (current.length === 0) return
    groups.push({ start, end, messages: current })
    start = end
    current = []
    pendingToolUseIds = new Set<string>()
    currentHasAssistant = false
    currentHasToolUse = false
  }

  messages.forEach((message, index) => {
    current.push(message)

    const toolUseIds = collectToolUseIds(message)
    const toolResultIds = collectToolResultIds(message)

    if (message.role === 'assistant') {
      currentHasAssistant = true
      if (toolUseIds.length > 0) currentHasToolUse = true
      for (const id of toolUseIds) pendingToolUseIds.add(id)
    }

    for (const id of toolResultIds) pendingToolUseIds.delete(id)

    const assistantWithoutToolsClosedRound =
      message.role === 'assistant' && toolUseIds.length === 0 && pendingToolUseIds.size === 0
    const currentMessageHasToolResult = toolResultIds.length > 0
    const answeredToolUseBatchClosedRound =
      currentHasAssistant &&
      currentHasToolUse &&
      pendingToolUseIds.size === 0 &&
      message.role === 'user' &&
      currentMessageHasToolResult

    if (assistantWithoutToolsClosedRound || answeredToolUseBatchClosedRound) {
      flush(index + 1)
    }
  })

  flush(messages.length)
  return groups
}
```

`groupMessagesByApiRound()` 必须满足这些 fixture：

- `[user, assistant(text)]` 产生 1 组。
- `[user, assistant(tool_use A), user(tool_result A)]` 产生 1 组。
- `[user, assistant(tool_use A), user(tool_result A), assistant(tool_use B), user(tool_result B), assistant(text)]` 产生 3 组：`[user..result A]`、`[assistant tool_use B..result B]`、`[assistant text]`。
- `[user, assistant(tool_use A), user(text), user(tool_result A)]` 产生 1 组；普通 user 文本不能提前闭合 tool round。
- 对任意 group 执行从头丢弃后，保留下来的第一条消息如果是 assistant，由 `truncateHeadForPromptTooLongRetry()` 前置 synthetic user marker；保留下来的内容不得出现被拆开的 tool_use/tool_result 配对。

- [ ] **Step 2: 运行类型检查确认新增模块可被 TS 解析**

Run:

```bash
npm run typecheck:web
```

Expected:

```text
> open-cowork@... typecheck:web
> tsc --noEmit -p tsconfig.web.json --composite false
```

命令应退出码为 `0`。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/lib/agent/context-budget.ts
git commit -m "feat(agent): add context budget helpers"
```

---

### Task 2: 新增工具结果 payload 脱水模块

**Files:**

- Create: `src/renderer/src/lib/agent/context-payload-compaction.ts`
- Modify: `src/renderer/src/locales/zh/agent.json`
- Modify: `src/renderer/src/locales/en/agent.json`

- [ ] **Step 1: 创建工具结果脱水纯函数**

新增文件：

```ts
import type { ContentBlock, ToolResultContent, UnifiedMessage } from '../api/types'
import type { CompressionConfig } from './context-compression'
import { estimateToolResultChars, getLargeToolResultCharLimit } from './context-budget'

const MIN_HEAD_CHARS = 2_000
const MIN_TAIL_CHARS = 1_000
const IMPORTANT_LINE_LIMIT = 80
const IMPORTANT_LINE_PATTERN =
  /\b(error|failed|failure|exception|traceback|panic|fatal|denied|timeout|warning|warn)\b/i

export type ToolPayloadCompactionReason = 'tool_result_too_large' | 'image_payload_omitted'

export interface ToolPayloadCompactionInfo {
  compacted: boolean
  originalChars: number
  keptChars: number
  reasons?: ToolPayloadCompactionReason[]
}

export interface CompactToolResultArgs {
  toolName: string
  content: ToolResultContent
  isError?: boolean
  config?: CompressionConfig | null
  maxChars?: number
}

export interface CompactToolResultResult {
  content: ToolResultContent
  info: ToolPayloadCompactionInfo
}

function collectImportantLines(text: string): string[] {
  const result: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!IMPORTANT_LINE_PATTERN.test(line)) continue
    result.push(line)
    if (result.length >= IMPORTANT_LINE_LIMIT) break
  }
  return result
}

export function compactLongTextForContext(
  text: string,
  args: { toolName: string; maxChars: number; isError?: boolean }
): { text: string; compacted: boolean; keptChars: number } {
  if (text.length <= args.maxChars) {
    return { text, compacted: false, keptChars: text.length }
  }

  const markerBudget = 900
  const bodyBudget = Math.max(MIN_HEAD_CHARS + MIN_TAIL_CHARS, args.maxChars - markerBudget)
  const headChars = Math.max(MIN_HEAD_CHARS, Math.floor(bodyBudget * 0.65))
  const tailChars = Math.max(MIN_TAIL_CHARS, bodyBudget - headChars)
  const head = text.slice(0, headChars).trimEnd()
  const tail = text.slice(-tailChars).trimStart()
  const importantLines = collectImportantLines(text)
  const importantSection = importantLines.length
    ? `\n\n## Important lines preserved\n${importantLines.join('\n')}`
    : ''
  const omittedChars = Math.max(0, text.length - head.length - tail.length)
  const compacted = [
    `[Tool result compacted for context budget]`,
    `Tool: ${args.toolName}`,
    `Original chars: ${text.length}`,
    `Kept chars: ${head.length + tail.length}`,
    `Omitted middle chars: ${omittedChars}`,
    args.isError ? `Result status: error` : `Result status: success`,
    '',
    '## Head',
    head,
    importantSection,
    '',
    '## Tail',
    tail
  ]
    .filter((part) => part.length > 0)
    .join('\n')

  return { text: compacted, compacted: true, keptChars: compacted.length }
}

export function compactToolResultForContext(args: CompactToolResultArgs): CompactToolResultResult {
  const maxChars = args.maxChars ?? getLargeToolResultCharLimit(args.config)
  const originalChars = estimateToolResultChars(args.content)

  if (typeof args.content === 'string') {
    const compacted = compactLongTextForContext(args.content, {
      toolName: args.toolName,
      maxChars,
      isError: args.isError
    })
    return {
      content: compacted.text,
      info: {
        compacted: compacted.compacted,
        originalChars,
        keptChars: compacted.keptChars,
        ...(compacted.compacted ? { reasons: ['tool_result_too_large'] } : {})
      }
    }
  }

  let changed = false
  let keptChars = 0
  const reasons = new Set<ToolPayloadCompactionReason>()
  const blocks = args.content.map((block) => {
    if (block.type === 'image') {
      changed = true
      reasons.add('image_payload_omitted')
      const text = '[image omitted from long-task context payload]'
      keptChars += text.length
      return { type: 'text' as const, text }
    }

    const compacted = compactLongTextForContext(block.text, {
      toolName: args.toolName,
      maxChars: Math.max(1_000, Math.floor(maxChars / args.content.length)),
      isError: args.isError
    })
    if (compacted.compacted) {
      changed = true
      reasons.add('tool_result_too_large')
    }
    keptChars += compacted.keptChars
    return { ...block, text: compacted.text }
  })

  return {
    content: blocks,
    info: {
      compacted: changed,
      originalChars,
      keptChars: changed ? keptChars : originalChars,
      ...(changed ? { reasons: [...reasons] } : {})
    }
  }
}

function buildToolNameByResultId(messages: UnifiedMessage[]): Map<string, string> {
  const result = new Map<string, string>()
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        result.set(block.id, block.name)
      }
    }
  }
  return result
}

export function compactRecentToolPayloads(
  messages: UnifiedMessage[],
  config?: CompressionConfig | null
): { messages: UnifiedMessage[]; compactedCount: number } {
  let compactedCount = 0
  const toolNameByResultId = buildToolNameByResultId(messages)
  const next = messages.map((message) => {
    if (!Array.isArray(message.content)) return message

    let changed = false
    const content: ContentBlock[] = message.content.map((block) => {
      if (block.type !== 'tool_result') return block
      const compacted = compactToolResultForContext({
        toolName: toolNameByResultId.get(block.toolUseId) ?? 'unknown',
        content: block.content,
        isError: block.isError,
        config
      })
      if (!compacted.info.compacted) return block
      changed = true
      compactedCount += 1
      return { ...block, content: compacted.content }
    })

    return changed ? { ...message, content } : message
  })

  return { messages: next, compactedCount }
}
```

- [ ] **Step 2: 增加 i18n 文案**

在 `src/renderer/src/locales/zh/agent.json` 的 `contextCompression` 对象内追加：

```json
"manualSkippedInsufficientMessages": "当前消息数量不足以进行有效压缩",
"manualSkippedInsufficientCompressibleMessages": "当前上下文较高，但近期任务消息必须保留，暂无足够历史消息可摘要压缩",
"manualSkippedRecentPayloadTooLarge": "当前上下文主要来自最近一次长任务输出，已优先对工具结果做脱水处理",
"manualSkippedCircuitBreaker": "上下文压缩连续失败，已暂时停止自动重试",
"manualSkippedSummarizerFailed": "摘要器未能生成有效压缩结果",
"manualSkippedPromptTooLong": "压缩请求本身超过模型限制，已尝试剥离旧消息后仍失败",
"postCompactStateTitle": "压缩后的当前工作状态"
```

在 `src/renderer/src/locales/en/agent.json` 的 `contextCompression` 对象内追加同名英文键：

```json
"manualSkippedInsufficientMessages": "There are not enough messages to compact effectively.",
"manualSkippedInsufficientCompressibleMessages": "Context usage is high, but recent task messages must be preserved and there is not enough older history to summarize.",
"manualSkippedRecentPayloadTooLarge": "Most context usage comes from the latest long-running task output. Tool results are dehydrated first.",
"manualSkippedCircuitBreaker": "Context compression failed repeatedly and automatic retries are temporarily stopped.",
"manualSkippedSummarizerFailed": "The summarizer did not produce a valid compacted result.",
"manualSkippedPromptTooLong": "The compaction request exceeded the model limit even after dropping older messages.",
"postCompactStateTitle": "Current working state after compaction"
```

- [ ] **Step 3: 运行格式检查**

Run:

```bash
npm run typecheck:web
```

Expected: exit code `0`。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/lib/agent/context-payload-compaction.ts src/renderer/src/locales/zh/agent.json src/renderer/src/locales/en/agent.json
git commit -m "feat(agent): compact oversized tool payloads"
```

---

### Task 3: 扩展压缩结果 reason 与手动压缩提示

**Files:**

- Modify: `src/renderer/src/lib/agent/context-compression.ts`
- Modify: `src/renderer/src/hooks/use-chat-actions.ts`

- [ ] **Step 1: 扩展 CompressionResult 类型**

修改 `context-compression.ts` 中的接口：

```ts
export type CompressionSkipReason =
  | 'insufficient_messages'
  | 'insufficient_compressible_messages'
  | 'recent_segment_too_large'
  | 'single_tool_result_too_large'
  | 'summarizer_prompt_too_long'
  | 'summarizer_failed'
  | 'circuit_breaker_open'

export interface CompressionResult {
  compressed: boolean
  originalCount: number
  newCount: number
  messagesSummarized?: number
  reason?: CompressionSkipReason
}
```

- [ ] **Step 2: 给所有 `compressed: false` 返回 reason**

在 `partialSummaryShouldCompress` 或 `partialSummaryCompressMessages` 开始处处理熔断：

```ts
if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
  return {
    messages,
    result: {
      compressed: false,
      originalCount,
      newCount: originalCount,
      reason: 'circuit_breaker_open'
    }
  }
}
```

将消息数不足返回改成：

```ts
result: {
  compressed: false,
  originalCount,
  newCount: originalCount,
  reason: 'insufficient_messages'
}
```

将可压缩段不足返回改成：

```ts
result: {
  compressed: false,
  originalCount,
  newCount: originalCount,
  reason: 'insufficient_compressible_messages'
}
```

最终所有重试失败返回改成：

```ts
result: {
  compressed: false,
  originalCount,
  newCount: originalCount,
  reason: isPromptTooLongError(lastError) ? 'summarizer_prompt_too_long' : 'summarizer_failed'
}
```

- [ ] **Step 3: 手动压缩 toast 按 reason 显示**

在 `use-chat-actions.ts` 中新增局部函数，放在 `manualCompressContext` 附近：

```ts
function getManualCompressionSkipDescription(reason?: CompressionResult['reason']): string {
  switch (reason) {
    case 'insufficient_messages':
      return i18n.t('contextCompression.manualSkippedInsufficientMessages', { ns: 'agent' })
    case 'insufficient_compressible_messages':
      return i18n.t('contextCompression.manualSkippedInsufficientCompressibleMessages', { ns: 'agent' })
    case 'recent_segment_too_large':
    case 'single_tool_result_too_large':
      return i18n.t('contextCompression.manualSkippedRecentPayloadTooLarge', { ns: 'agent' })
    case 'circuit_breaker_open':
      return i18n.t('contextCompression.manualSkippedCircuitBreaker', { ns: 'agent' })
    case 'summarizer_prompt_too_long':
      return i18n.t('contextCompression.manualSkippedPromptTooLong', { ns: 'agent' })
    case 'summarizer_failed':
    default:
      return i18n.t('contextCompression.manualSkippedSummarizerFailed', { ns: 'agent' })
  }
}
```

将原逻辑：

```ts
toast.warning('无需压缩', { description: '当前消息数量不足以进行有效压缩' })
```

替换为：

```ts
toast.warning('无需压缩', {
  description: getManualCompressionSkipDescription(result.reason)
})
```

- [ ] **Step 4: 运行类型检查**

Run:

```bash
npm run typecheck:web
```

Expected: exit code `0`。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/agent/context-compression.ts src/renderer/src/hooks/use-chat-actions.ts
git commit -m "fix(agent): explain context compression skip reasons"
```

---

### Task 4: 接入工具结果入上下文前脱水

**Files:**

- Modify: `src/renderer/src/lib/agent/types.ts`
- Modify: `src/renderer/src/lib/agent/agent-loop.ts`
- Modify: `src/renderer/src/lib/agent/shared-runtime.ts`

- [ ] **Step 1: 在 agent-loop 中拆分 UI 输出和模型 replay 输出**

先在 `types.ts` 的 `iteration_end.toolResults` 中增加可选工具名，给外部 replay 构造器提供真实来源：

```ts
toolResults?: {
  toolUseId: string
  toolName?: string
  content: ToolResultContent
  isError?: boolean
}[]
```

在 `agent-loop.ts` 添加 import：

```ts
import { compactToolResultForContext } from './context-payload-compaction'
```

将工具结果数组从一份改为两份：

```ts
const toolContextResults: Array<ContentBlock | undefined> = new Array(toolCalls.length)
const toolDisplayResults: Array<ContentBlock | undefined> = new Array(toolCalls.length)
```

在 `buildToolCallResult` 中，将当前：

```ts
const output =
  tc.name === 'Bash' ? compactBashToolResultContent(params.output) : params.output
const sanitizedInput = summarizeToolInputForHistory(tc.name, tc.input)
const resultError = toolError ?? extractStructuredToolError(output)
```

替换为：

```ts
const displayOutput =
  tc.name === 'Bash' ? compactBashToolResultContent(params.output) : params.output
const sanitizedInput = summarizeToolInputForHistory(tc.name, tc.input)
const resultError = toolError ?? extractStructuredToolError(displayOutput)
const shouldStopForReview = isAwaitingUserReviewToolResult(displayOutput)
const compactedOutput = compactToolResultForContext({
  toolName: tc.name,
  content: displayOutput,
  isError: !!resultError,
  config: config.contextCompression?.config ?? null
})
const contextOutput = compactedOutput.content
```

将 `resultEvent.output` 保持为用户可见输出：

```ts
const resultEvent: ToolCallState = {
  ...tc,
  input: sanitizedInput,
  status: resultError ? 'error' : 'completed',
  output: displayOutput,
  ...(resultError ? { error: resultError } : {}),
  startedAt,
  completedAt
}
```

将原来的单个 `resultBlock` 拆成 UI/display block 与模型 replay/context block：

```ts
const displayBlock: ContentBlock = {
  type: 'tool_result',
  toolUseId: tc.id,
  content: displayOutput,
  ...(resultError ? { isError: true } : {})
}

const contextBlock: ContentBlock = {
  type: 'tool_result',
  toolUseId: tc.id,
  content: contextOutput,
  ...(resultError ? { isError: true } : {})
}

toolDisplayResults[index] = displayBlock
toolContextResults[index] = contextBlock
shouldStopForUserReview ||= shouldStopForReview
return { resultEvent, contextResultBlock: contextBlock }
```

如果保留 `buildToolCallResult` 的返回对象，返回类型同步改为 `contextResultBlock: ContentBlock`；不要继续使用旧名 `resultBlock`，避免误以为它是 UI/display block。

构造下一轮模型 replay transcript 时使用 `toolContextResults`：

```ts
const toolResultMsg: UnifiedMessage = {
  id: nanoid(),
  role: 'user',
  content: toolContextResults.filter((block): block is ContentBlock => Boolean(block)),
  createdAt: Date.now()
}
```

`iteration_end.toolResults` 继续使用 `toolDisplayResults`，保证 UI 与持久化展示不被脱水内容覆盖；同时把 `toolName` 带给 sub-agent replay 与 shared runtime：

```ts
const toolNameByResultId = new Map(toolCalls.map((toolCall) => [toolCall.id, toolCall.name]))

toolResults: toolDisplayResults
  .filter(
    (block): block is Extract<ContentBlock, { type: 'tool_result' }> =>
      block !== undefined && block.type === 'tool_result'
  )
  .map((block) => ({
    toolUseId: block.toolUseId,
    toolName: toolNameByResultId.get(block.toolUseId),
    content: block.content,
    isError: block.isError
  }))
```

- [ ] **Step 2: 在 shared-runtime 的外部 replay tool_result 构造也脱水**

该步骤只处理 renderer shared runtime hook 通过 `buildToolResultMessage` 构造的外部 replay message，不表示 sidecar/main runtime compression 已实现；sidecar 路径仍保持 `compression: null`，后续独立计划再处理。

在 `shared-runtime.ts` 添加 import：

```ts
import { compactToolResultForContext } from './context-payload-compaction'
```

将 `buildToolResultMessage` 参数类型扩展为接收可选 `toolName`：

```ts
export function buildToolResultMessage(
  toolResults: {
    toolUseId: string
    toolName?: string
    content: ToolResultContent
    isError?: boolean
  }[]
): UnifiedMessage {
```

将 `buildToolResultMessage` 中的 map 替换为：

```ts
const content: ContentBlock[] = toolResults.map((result) => {
  const toolName = result.toolName ?? `unknown:${result.toolUseId.slice(0, 8)}`
  const compacted = compactToolResultForContext({
    toolName,
    content: result.content,
    isError: result.isError
  })
  return {
    type: 'tool_result',
    toolUseId: result.toolUseId,
    content: compacted.content,
    ...(result.isError ? { isError: true } : {})
  }
})
```

真实工具名优先来自 `iteration_end.toolResults[].toolName`；如果调用方没有提供，marker 使用 `unknown:<toolUseId-prefix>`，不要再显示固定的 `Tool: injected`。

- [ ] **Step 3: 运行类型检查**

Run:

```bash
npm run typecheck:web
```

Expected: exit code `0`。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/lib/agent/types.ts src/renderer/src/lib/agent/agent-loop.ts src/renderer/src/lib/agent/shared-runtime.ts
git commit -m "fix(agent): dehydrate long tool results before replay"
```

---

### Task 5: 下一轮模型请求前 preflight context 管理

**Files:**

- Modify: `src/renderer/src/lib/agent/types.ts`
- Modify: `src/renderer/src/lib/agent/agent-loop.ts`
- Modify: `src/renderer/src/lib/agent/context-compression.ts`

- [ ] **Step 1: 扩展 AgentLoopConfig.contextCompression**

在 `types.ts` 中把 `contextCompression` 改为：

```ts
contextCompression?: {
  config: CompressionConfig
  compressFn: (
    messages: UnifiedMessage[],
    trigger?: 'auto' | 'manual',
    preTokens?: number
  ) => Promise<UnifiedMessage[]>
}
```

- [ ] **Step 2: 在 agent-loop 中拆分 observed 与 estimated token 状态**

在 `agent-loop.ts` 添加 imports：

```ts
import { buildContextBudgetSnapshot, estimateMessagesTokens } from './context-budget'
import { compactRecentToolPayloads } from './context-payload-compaction'
```

把 `runAgentLoop` 初始化处的单一 token 变量：

```ts
let lastInputTokens = config.contextCompression ? findRecentContextUsage(messages) : 0
```

替换为两个语义明确的变量：

```ts
let lastObservedContextTokens = config.contextCompression ? findRecentContextUsage(messages) : 0
let estimatedReplayTokens = config.contextCompression ? estimateMessagesTokens(conversationMessages) : 0
```

在 provider `message_end` 分支中，将：

```ts
lastInputTokens = readContextUsage(event.usage)
```

替换为：

```ts
lastObservedContextTokens = readContextUsage(event.usage)
```

`lastObservedContextTokens` 只保存 provider usage 回包里的上下文 token；`estimatedReplayTokens` 只保存本地 replay transcript 估算值。压缩决策使用 `Math.max(lastObservedContextTokens, estimatedReplayTokens)`，但不要把估算值写回 observed 变量。

- [ ] **Step 3: 替换现有 context management 块**

把 `agent-loop.ts:127-161` 的 context management 逻辑替换为下面结构：

```ts
// --- Context management preflight (between iterations) ---
if (config.contextCompression) {
  const cc = config.contextCompression
  const compactedPayloads = compactRecentToolPayloads(conversationMessages, cc.config)
  if (compactedPayloads.compactedCount > 0) {
    conversationMessages = compactedPayloads.messages
  }

  const budget = buildContextBudgetSnapshot(conversationMessages, cc.config)
  estimatedReplayTokens = budget.estimatedTokens
  const tokensForCompressionDecision = Math.max(lastObservedContextTokens, estimatedReplayTokens)

  if (tokensForCompressionDecision > 0 && shouldCompress(tokensForCompressionDecision, cc.config)) {
    if (config.signal.aborted) {
      yield buildLoopEndEvent('aborted')
      return
    }
    yield { type: 'context_compression_start' }
    try {
      const originalCount = conversationMessages.length
      conversationMessages = await cc.compressFn(
        conversationMessages,
        'auto',
        tokensForCompressionDecision
      )
      fullCompressionApplied = true
      yield {
        type: 'context_compressed',
        originalCount,
        newCount: conversationMessages.length,
        messages: [...conversationMessages]
      }
      estimatedReplayTokens = estimateMessagesTokens(conversationMessages)
      lastObservedContextTokens = 0
    } catch (compErr) {
      console.error('[Agent Loop] Context compression failed:', compErr)
    }
  } else if (
    tokensForCompressionDecision > 0 &&
    shouldPreCompress(tokensForCompressionDecision, cc.config)
  ) {
    conversationMessages = [...preCompressMessages(conversationMessages, cc.config)]
    estimatedReplayTokens = estimateMessagesTokens(conversationMessages)
  }
}
```

- [ ] **Step 4: 工具结果 append 后立即更新估算 token**

在 `conversationMessages.push(toolResultMsg)` 之后追加，只更新本地 replay 估算值：

```ts
if (config.contextCompression) {
  estimatedReplayTokens = estimateMessagesTokens(conversationMessages)
}
```

- [ ] **Step 5: 运行类型检查**

Run:

```bash
npm run typecheck:web
```

Expected: exit code `0`。

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/lib/agent/types.ts src/renderer/src/lib/agent/agent-loop.ts src/renderer/src/lib/agent/context-compression.ts
git commit -m "feat(agent): preflight long-task context budget"
```

---

### Task 6: Prompt Too Long 剥离重试与 API round 分组

**Files:**

- Modify: `src/renderer/src/lib/agent/context-compression.ts`

- [ ] **Step 1: 引入 API round grouping 与 PTL 判断**

在 `context-compression.ts` 添加 import：

```ts
import { groupMessagesByApiRound } from './context-budget'
```

新增函数：

```ts
export function isPromptTooLongError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /prompt.?too.?long|context.?length|maximum context|too many tokens|413/i.test(message)
}

export function truncateHeadForPromptTooLongRetry(
  messages: UnifiedMessage[],
  attempt: number
): UnifiedMessage[] | null {
  const groups = groupMessagesByApiRound(messages)
  if (groups.length < 2) return null

  const dropRatio = Math.min(0.6, Math.max(0.2, attempt * 0.2))
  const dropCount = Math.min(
    Math.max(1, Math.floor(groups.length * dropRatio)),
    groups.length - 1
  )
  const kept = groups.slice(dropCount).flatMap((group) => group.messages)
  if (kept.length < 2) return null

  if (kept[0]?.role === 'assistant') {
    return [
      {
        id: nanoid(),
        role: 'user',
        content:
          '[Earlier messages were dropped from this compaction attempt because the summarizer prompt was too long.]',
        createdAt: Date.now()
      },
      ...kept
    ]
  }

  return kept
}
```

- [ ] **Step 2: 修改压缩 retry 逻辑**

将当前 retry 逻辑：

```ts
const inputMessages =
  attempt === 0 ? messagesToCompress : truncateOldestMessages(messagesToCompress, attempt)
```

替换为：

```ts
const baseMessages = messagesToCompress
const inputMessages =
  attempt === 0
    ? baseMessages
    : lastError && isPromptTooLongError(lastError)
      ? (truncateHeadForPromptTooLongRetry(baseMessages, attempt) ??
        truncateOldestMessages(baseMessages, attempt))
      : truncateOldestMessages(baseMessages, attempt)
```

这里每次重试都以 `baseMessages` 为基准重新计算剥离结果，避免误把上一次已截断的输入再次叠加截断。

保留现有指数退避，但当 `isPromptTooLongError(error)` 为 true 时不要等待完整退避，直接进入下一次剥离重试：

```ts
if (attempt < MAX_COMPRESS_RETRIES && !isPromptTooLongError(error)) {
  await new Promise((resolve) =>
    setTimeout(resolve, BASE_RETRY_DELAY_MS * Math.pow(2, attempt))
  )
}
```

- [ ] **Step 3: 删除或保留旧 truncateOldestMessages**

保留 `truncateOldestMessages` 作为非 PTL 失败的 fallback。不要删除，避免普通摘要失败时没有降级路径。

- [ ] **Step 4: 运行类型检查**

Run:

```bash
npm run typecheck:web
```

Expected: exit code `0`。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/agent/context-compression.ts
git commit -m "fix(agent): retry compaction after prompt-too-long"
```

---

### Task 7: Post-compact 当前工作状态重注入

**Files:**

- Create: `src/renderer/src/lib/agent/context-state-format.ts`
- Create: `src/renderer/src/lib/agent/context-state-attachments.ts`
- Modify: `src/renderer/src/lib/api/types.ts`
- Modify: `src/renderer/src/lib/agent/context-compression.ts`
- Modify: `src/renderer/src/lib/agent/types.ts`
- Modify: `src/renderer/src/hooks/use-chat-actions.ts`

- [ ] **Step 1: 创建纯格式化模块**

新增 `context-state-format.ts`，该文件只接收 plain data，不导入 store、i18n、Electron 或 renderer runtime。该文本是模型上下文连续性提示，不是 UI 文案；内部 section label 采用稳定英文，adapter 只本地化标题：

```ts
export interface PostCompactPlanSnapshot {
  title: string
  status: string
  filePath?: string
}

export interface PostCompactTaskSnapshot {
  id: string
  subject: string
  status: string
  activeForm?: string
}

export interface PostCompactReadFileSnapshot {
  filePath: string
  timestamp: number
}

export interface FormatPostCompactStateContextArgs {
  title: string
  workingFolder?: string
  currentPlan?: PostCompactPlanSnapshot | null
  activeTasks?: PostCompactTaskSnapshot[]
  recentlyReadFiles?: PostCompactReadFileSnapshot[]
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString()
}

export function formatPostCompactStateContext(args: FormatPostCompactStateContextArgs): string {
  const lines: string[] = []
  lines.push(`## ${args.title}`)

  if (args.workingFolder) {
    lines.push('', `Working folder: ${args.workingFolder}`)
  }

  if (args.currentPlan) {
    lines.push('', '### Current plan')
    lines.push(`- Title: ${args.currentPlan.title}`)
    lines.push(`- Status: ${args.currentPlan.status}`)
    if (args.currentPlan.filePath) lines.push(`- File: ${args.currentPlan.filePath}`)
  }

  if (args.activeTasks && args.activeTasks.length > 0) {
    lines.push('', '### Active tasks')
    for (const task of args.activeTasks) {
      lines.push(`- ${task.id}: ${task.subject} [${task.status}]`)
      if (task.activeForm) lines.push(`  - Active: ${task.activeForm}`)
    }
  }

  if (args.recentlyReadFiles && args.recentlyReadFiles.length > 0) {
    lines.push('', '### Recently read files')
    for (const file of args.recentlyReadFiles) {
      lines.push(`- ${file.filePath} (${formatTimestamp(file.timestamp)})`)
    }
    lines.push('- Re-read specific files if exact content is needed after compaction.')
  }

  lines.push('', '### Continuity note')
  lines.push('- Earlier tool payloads may have been dehydrated or summarized to protect context budget.')
  lines.push(
    '- UI-visible tool outputs are preserved separately where possible; model replay may contain compacted tool payloads.'
  )
  lines.push('- Use file paths, task IDs, and plan status above to continue work safely.')

  return lines.join('\n')
}
```

- [ ] **Step 2: 创建 renderer adapter 收集状态**

新增 `context-state-attachments.ts`，该文件是唯一允许读取 renderer store 和 i18n 的 adapter：

```ts
import i18n from '@renderer/locales'
import { usePlanStore } from '@renderer/stores/plan-store'
import { useTaskStore } from '@renderer/stores/task-store'
import {
  formatPostCompactStateContext,
  type PostCompactReadFileSnapshot
} from './context-state-format'

export interface BuildPostCompactStateContextArgs {
  sessionId?: string
  workingFolder?: string
  readFileHistory?: Map<string, number>
  maxReadFiles?: number
  maxTasks?: number
}

function collectReadFiles(
  readFileHistory?: Map<string, number>,
  maxReadFiles = 12
): PostCompactReadFileSnapshot[] {
  if (!readFileHistory || readFileHistory.size === 0) return []
  return [...readFileHistory.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxReadFiles)
    .map(([filePath, timestamp]) => ({ filePath, timestamp }))
}

export function buildPostCompactStateContext(args: BuildPostCompactStateContextArgs): string {
  const plan = args.sessionId
    ? usePlanStore.getState().getPlanBySession(args.sessionId)
    : null
  const activeTasks = args.sessionId
    ? useTaskStore
        .getState()
        .getTasksBySession(args.sessionId)
        .filter((task) => task.status !== 'completed')
        .slice(0, args.maxTasks ?? 12)
        .map((task) => ({
          id: task.id,
          subject: task.subject,
          status: task.status,
          ...(task.activeForm ? { activeForm: task.activeForm } : {})
        }))
    : []

  return formatPostCompactStateContext({
    title: i18n.t('contextCompression.postCompactStateTitle', { ns: 'agent' }),
    workingFolder: args.workingFolder,
    currentPlan: plan
      ? {
          title: plan.title,
          status: plan.status,
          ...(plan.filePath ? { filePath: plan.filePath } : {})
        }
      : null,
    activeTasks,
    recentlyReadFiles: collectReadFiles(args.readFileHistory, args.maxReadFiles)
  })
}
```

- [ ] **Step 3: 让压缩结果包含 post-compact state message**

在 `src/renderer/src/lib/api/types.ts` 的 `MessageMeta` 中增加标记，便于后续识别这不是用户手写输入：

```ts
export interface MessageMeta {
  compactBoundary?: CompactBoundaryMeta
  compactSummary?: CompactSummaryMeta
  postCompactState?: true
}
```

在 `context-compression.ts` 的 `compressMessages` 与 strategy 函数签名增加参数：

```ts
postCompactContext?: string
```

`postCompactContextMessage` 使用 `role: 'user'` 是有意设计：它是给下一轮模型看的连续性说明，不应成为高优先级 system 指令；通过 `meta.postCompactState` 标识其不是用户手写输入。

保持 merge 不变量：`postCompactContextMessage` 必须插在 `summaryMessage` 与真实 preserved 消息之间；`boundary.meta.compactBoundary.preservedSegment.headId` 必须始终指向真实 preserved head，而不是 post-compact state message。这样 `mergeCompressedMessagesIntoConversation()` 能继续用 preserved head 作为锚点合并 UI 消息。

在 `partialSummaryCompressMessages` 中，创建 `boundaryMessage` 前先去掉旧的 preserved post-compact state，避免多次压缩后重复堆叠状态消息：

```ts
const dedupedMessagesToPreserve = messagesToPreserve.filter(
  (message) => message.meta?.postCompactState !== true
)
```

创建 `boundaryMessage` 时使用 `dedupedMessagesToPreserve`，确保 `compactBoundary.preservedSegment.headId` 指向真实 preserved message，而不是旧状态注入消息：

```ts
const boundaryMessage = createCompactBoundaryMessage({
  trigger,
  preTokens,
  messagesSummarized: messagesToCompress.length,
  preservedMessages: dedupedMessagesToPreserve
})
```

创建 `summaryMessage` 时，把 `recentMessagesPreserved` 改为 `dedupedMessagesToPreserve.length > 0`。

在创建 `summaryMessage` 后新增：

```ts
const postCompactContextMessage =
  postCompactContext?.trim() && dedupedMessagesToPreserve.length > 0
    ? ({
        id: nanoid(),
        role: 'user' as const,
        content: postCompactContext.trim(),
        createdAt: Date.now(),
        meta: { postCompactState: true }
      } satisfies UnifiedMessage)
    : null
```

将：

```ts
const compressedMessages = [boundaryMessage, summaryMessage, ...messagesToPreserve]
```

改为：

```ts
const compressedMessages = [
  boundaryMessage,
  summaryMessage,
  ...(postCompactContextMessage ? [postCompactContextMessage] : []),
  ...dedupedMessagesToPreserve
]
```

- [ ] **Step 4: use-chat-actions 传入 post-compact state**

在 `use-chat-actions.ts` 添加 import：

```ts
import { buildPostCompactStateContext } from '@renderer/lib/agent/context-state-attachments'
```

将 `toolCtx` 定义移动到 `loopConfig` 之前，保证 `compressFn` 可以闭包访问 `toolCtx.readFileHistory`。

把 `compressFn` 改成：

```ts
compressFn: async (
  msgs: UnifiedMessage[],
  trigger: 'auto' | 'manual' = 'auto',
  preTokens = 0
) => {
  const postCompactContext = buildPostCompactStateContext({
    sessionId,
    workingFolder: sessionWorkingFolder,
    readFileHistory: toolCtx.readFileHistory
  })
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
}
```

手动压缩路径也传入基础 state：

```ts
const postCompactContext = buildPostCompactStateContext({ sessionId })
```

并传给 `compressMessages` 最后一个参数。

- [ ] **Step 5: 运行类型检查**

Run:

```bash
npm run typecheck:web
```

Expected: exit code `0`。

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/lib/agent/context-state-format.ts src/renderer/src/lib/agent/context-state-attachments.ts src/renderer/src/lib/api/types.ts src/renderer/src/lib/agent/context-compression.ts src/renderer/src/lib/agent/types.ts src/renderer/src/hooks/use-chat-actions.ts
git commit -m "feat(agent): reinject state after context compaction"
```

---

### Task 8: 停止压缩启用时全量加载历史

**Files:**

- Modify: `src/renderer/src/hooks/use-chat-actions.ts`
- Modify: `scripts/diagnose-context-regressions.mjs`

- [ ] **Step 1: 修改请求上下文加载策略**

在 `use-chat-actions.ts` 中将：

```ts
const requestContextMaxMessages =
  settings.contextCompressionEnabled && compressionContextLength > 0 ? null : undefined
```

替换为：

```ts
const requestContextMaxMessages = undefined
```

解释：`undefined` 会走 `REQUEST_CONTEXT_MAX_MESSAGES = 160` 的安全窗口，并保留 `chat-store.ts` 中的 tool_use/tool_result 安全边界扫描。长任务压缩通过 payload 脱水和 preflight compact 解决，不再依赖每次请求全量取历史。

- [ ] **Step 2: 更新诊断脚本，防止该回归再次出现**

在 `scripts/diagnose-context-regressions.mjs` 中新增检查：

```js
if (/contextCompressionEnabled[\s\S]{0,120}\?\s*null\s*:\s*undefined/.test(chatActionsSource)) {
  fail('compression enabled requests still force full history loading', [
    'src/renderer/src/hooks/use-chat-actions.ts should not set requestContextMaxMessages=null just because compression is enabled',
    'long-task compression must use payload dehydration and preflight compaction instead of full-history renderer loading'
  ])
} else {
  pass('compression enabled requests do not force full history loading')
}
```

- [ ] **Step 3: 运行现有诊断**

Run:

```bash
npm run diagnose:context-regressions
```

Expected:

```text
[PASS] compression enabled runs are not routed to unsupported sidecar compression path
[PASS] sidecar compression config drop is unreachable for enabled compression, or main runtime supports it
[PASS] compression enabled requests do not force full history loading
[PASS] context regression diagnostics passed
```

- [ ] **Step 4: 运行类型检查**

Run:

```bash
npm run typecheck:web
```

Expected: exit code `0`。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/hooks/use-chat-actions.ts scripts/diagnose-context-regressions.mjs
git commit -m "fix(agent): avoid full history load for compressed context"
```

---

### Task 9: 增加长任务上下文纯函数 fixture 测试

**Files:**

- Create: `vitest.config.ts`
- Create: `src/renderer/src/lib/agent/__tests__/long-task-context.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: 安装 Vitest 并更新 lockfile**

Run:

```bash
npm install -D vitest
```

Expected:

```text
added ... packages, and audited ... packages
```

`package-lock.json` 应由 npm 自动更新；不要手写 lockfile。

- [ ] **Step 2: 增加 Vitest 配置**

创建 `vitest.config.ts`：

```ts
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  test: {
    environment: 'node',
    include: ['src/renderer/src/lib/agent/__tests__/*.test.ts']
  }
})
```

- [ ] **Step 3: 增加纯函数 fixture 测试**

创建 `src/renderer/src/lib/agent/__tests__/long-task-context.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContentBlock, ToolResultContent, UnifiedMessage } from '../../api/types'

vi.mock('@renderer/locales', () => ({
  default: {
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'contextCompression.summaryMessage') return String(options?.summary ?? '')
      if (key === 'contextCompression.clearedToolResult') return '[cleared tool result]'
      if (key === 'contextCompression.clearedThinking') return '[cleared thinking]'
      if (key === 'contextCompression.systemPrompt') return 'Summarize context'
      if (key === 'contextCompression.emptyResultError') return 'empty summary'
      return key
    }
  }
}))

vi.mock('@renderer/lib/ipc/agent-bridge', () => ({
  runSidecarTextRequest: vi.fn()
}))

vi.mock('@renderer/lib/api/responses-session-policy', () => ({
  RESPONSES_SESSION_SCOPE_CONTEXT_COMPRESSION: false
}))

import { groupMessagesByApiRound } from '../context-budget'
import { compactToolResultForContext } from '../context-payload-compaction'
import { formatPostCompactStateContext } from '../context-state-format'
import { truncateHeadForPromptTooLongRetry } from '../context-compression'

let nextMessageId = 0

beforeEach(() => {
  nextMessageId = 0
})

function message(role: UnifiedMessage['role'], content: UnifiedMessage['content']): UnifiedMessage {
  nextMessageId += 1
  return {
    id: `m-${nextMessageId}`,
    role,
    content,
    createdAt: nextMessageId
  }
}

function toolUse(id: string, name = 'Read'): ContentBlock {
  return { type: 'tool_use', id, name, input: {} }
}

function toolResult(id: string, content: ToolResultContent = 'ok'): ContentBlock {
  return { type: 'tool_result', toolUseId: id, content }
}

describe('groupMessagesByApiRound', () => {
  it('keeps assistant tool_use and matching user tool_result in one round', () => {
    const messages = [
      message('user', 'inspect files'),
      message('assistant', [toolUse('a')]),
      message('user', [toolResult('a')]),
      message('assistant', [toolUse('b')]),
      message('user', [toolResult('b')]),
      message('assistant', 'done')
    ]

    const groups = groupMessagesByApiRound(messages)

    expect(groups.map((group) => group.messages.map((item) => item.id))).toEqual([
      ['m-1', 'm-2', 'm-3'],
      ['m-4', 'm-5'],
      ['m-6']
    ])
  })

  it('does not close a tool round on ordinary user text before tool_result', () => {
    const messages = [
      message('user', 'inspect files'),
      message('assistant', [toolUse('a')]),
      message('user', 'queued note before result'),
      message('user', [toolResult('a')])
    ]

    const groups = groupMessagesByApiRound(messages)

    expect(groups).toHaveLength(1)
    expect(groups[0]?.messages.map((item) => item.id)).toEqual(['m-1', 'm-2', 'm-3', 'm-4'])
  })
})

describe('compactToolResultForContext', () => {
  it('reports both text truncation and image omission for mixed tool content', () => {
    const result = compactToolResultForContext({
      toolName: 'Read',
      maxChars: 1_200,
      content: [
        { type: 'text', text: `error line\n${'x'.repeat(5_000)}` },
        { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }
      ]
    })

    expect(result.info.compacted).toBe(true)
    expect(result.info.reasons).toEqual(['tool_result_too_large', 'image_payload_omitted'])
    expect(JSON.stringify(result.content)).toContain('Tool result compacted for context budget')
    expect(JSON.stringify(result.content)).toContain('image omitted')
  })
})

describe('formatPostCompactStateContext', () => {
  it('formats working state without renderer store dependencies', () => {
    const text = formatPostCompactStateContext({
      title: 'Current state',
      workingFolder: 'C:/projects/OpenCowork',
      currentPlan: { title: 'Compression plan', status: 'in_progress' },
      activeTasks: [{ id: 'task-1', subject: 'Implement compaction', status: 'in_progress' }],
      recentlyReadFiles: [{ filePath: 'src/renderer/src/lib/agent/agent-loop.ts', timestamp: 0 }]
    })

    expect(text).toContain('## Current state')
    expect(text).toContain('Working folder: C:/projects/OpenCowork')
    expect(text).toContain('task-1: Implement compaction [in_progress]')
    expect(text).toContain('agent-loop.ts')
  })
})

describe('truncateHeadForPromptTooLongRetry', () => {
  it('drops whole API-round groups and prepends a marker before assistant-leading kept text', () => {
    const messages = [
      message('user', 'round 1'),
      message('assistant', [toolUse('a')]),
      message('user', [toolResult('a')]),
      message('assistant', [toolUse('b')]),
      message('user', [toolResult('b')]),
      message('assistant', 'final answer')
    ]

    const retried = truncateHeadForPromptTooLongRetry(messages, 1)

    expect(retried).not.toBeNull()
    expect(retried?.[0]?.role).toBe('user')
    expect(retried?.[0]?.content).toContain('Earlier messages were dropped')
    expect(retried?.some((item) => item.id === 'm-1')).toBe(false)
    expect(retried?.some((item) => item.id === 'm-2')).toBe(false)
    expect(retried?.some((item) => item.id === 'm-3')).toBe(false)
  })
})
```

- [ ] **Step 4: package.json 增加测试脚本**

在 `scripts` 中增加：

```json
"test:agent-context": "vitest run src/renderer/src/lib/agent/__tests__/long-task-context.test.ts"
```

- [ ] **Step 5: 运行 fixture 测试**

Run:

```bash
npm run test:agent-context
```

Expected:

```text
✓ src/renderer/src/lib/agent/__tests__/long-task-context.test.ts
Test Files  1 passed
Tests  5 passed
```

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.ts src/renderer/src/lib/agent/__tests__/long-task-context.test.ts
git commit -m "test(agent): add long-task context fixtures"
```

---

### Task 10: 新增长任务压缩静态诊断脚本

**Files:**

- Create: `scripts/diagnose-long-task-context-compression.mjs`
- Modify: `package.json`

- [ ] **Step 1: 新增诊断脚本**

创建 `scripts/diagnose-long-task-context-compression.mjs`：

```js
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const failures = []
const passes = []

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function fail(message, details = []) {
  failures.push({ message, details })
}

function pass(message) {
  passes.push(message)
}

const agentLoop = read('src/renderer/src/lib/agent/agent-loop.ts')
const compression = read('src/renderer/src/lib/agent/context-compression.ts')
const contextBudget = read('src/renderer/src/lib/agent/context-budget.ts')
const payload = read('src/renderer/src/lib/agent/context-payload-compaction.ts')
const sharedRuntime = read('src/renderer/src/lib/agent/shared-runtime.ts')
const stateFormat = read('src/renderer/src/lib/agent/context-state-format.ts')
const stateAttachments = read('src/renderer/src/lib/agent/context-state-attachments.ts')
const chatActions = read('src/renderer/src/hooks/use-chat-actions.ts')

if (!/compactToolResultForContext/.test(agentLoop)) {
  fail('agent loop does not compact tool results before replay', [
    'src/renderer/src/lib/agent/agent-loop.ts must call compactToolResultForContext in buildToolCallResult'
  ])
} else {
  pass('agent loop compacts oversized tool results before replay')
}

if (!/toolDisplayResults/.test(agentLoop) || !/toolContextResults/.test(agentLoop)) {
  fail('agent loop does not separate UI tool output from replay tool output', [
    'agent-loop.ts must keep toolDisplayResults for iteration_end/UI and toolContextResults for conversation replay'
  ])
} else {
  pass('agent loop separates UI-visible tool output from replay payloads')
}

if (
  !/lastObservedContextTokens/.test(agentLoop) ||
  !/estimatedReplayTokens/.test(agentLoop) ||
  /lastInputTokens/.test(agentLoop)
) {
  fail('agent loop token budget state is ambiguous', [
    'agent-loop.ts must use lastObservedContextTokens for provider usage and estimatedReplayTokens for local estimates',
    'do not reintroduce lastInputTokens'
  ])
} else {
  pass('agent loop separates observed provider tokens from estimated replay tokens')
}

if (!/compactRecentToolPayloads/.test(agentLoop) || !/buildContextBudgetSnapshot/.test(agentLoop)) {
  fail('agent loop is missing preflight context budget management', [
    'agent-loop.ts must run compactRecentToolPayloads and buildContextBudgetSnapshot before provider requests'
  ])
} else {
  pass('agent loop has preflight context budget management')
}

if (!/pendingToolUseIds/.test(contextBudget) || /hasUnansweredToolUse/.test(contextBudget)) {
  fail('API round grouping does not explicitly track pending tool_use ids', [
    'context-budget.ts groupMessagesByApiRound must close groups after assistant tool_use ids are answered by matching user tool_result messages'
  ])
} else {
  pass('API round grouping tracks pending tool_use/tool_result pairs')
}

if (!/CompressionSkipReason/.test(compression) || !/reason\?/.test(compression)) {
  fail('compression results do not expose skip reasons', [
    'context-compression.ts must export CompressionSkipReason and include reason on CompressionResult'
  ])
} else {
  pass('compression results expose skip reasons')
}

if (!/truncateHeadForPromptTooLongRetry/.test(compression) || !/isPromptTooLongError/.test(compression)) {
  fail('compaction prompt-too-long retry is missing', [
    'context-compression.ts must retry PTL by dropping older API-round groups'
  ])
} else {
  pass('compaction has prompt-too-long retry handling')
}

if (!/Tool result compacted for context budget/.test(payload)) {
  fail('payload compaction marker is missing', [
    'context-payload-compaction.ts must mark compacted tool results for model transparency'
  ])
} else {
  pass('payload compaction marker is present')
}

if (!/ToolPayloadCompactionReason/.test(payload) || !/reasons\?/.test(payload)) {
  fail('payload compaction does not expose precise reasons', [
    'context-payload-compaction.ts must distinguish tool_result_too_large from image_payload_omitted',
    'use reasons[] for mixed content'
  ])
} else {
  pass('payload compaction exposes precise reason list')
}

if (/toolName:\s*'injected'/.test(sharedRuntime) || !/toolName\?: string/.test(sharedRuntime)) {
  fail('shared runtime replay tool results do not preserve tool names', [
    'shared-runtime.ts buildToolResultMessage must accept toolName? and use unknown:<toolUseId-prefix> only as fallback'
  ])
} else {
  pass('shared runtime replay tool results preserve or derive tool names')
}

if (!/postCompactState/.test(compression) || !/dedupedMessagesToPreserve/.test(compression)) {
  fail('post-compact state messages are not deduplicated during compression', [
    'context-compression.ts must filter old meta.postCompactState preserved messages before adding the new state message'
  ])
} else {
  pass('post-compact state messages are deduplicated')
}

if (!/formatPostCompactStateContext/.test(stateFormat) || !/Recently read files/.test(stateFormat)) {
  fail('post-compact state formatter is missing read-file context', [
    'context-state-format.ts must include recently read files and continuity note'
  ])
} else {
  pass('post-compact state formatter includes working state')
}

if (/usePlanStore|useTaskStore|@renderer\/locales/.test(stateFormat)) {
  fail('post-compact state formatter depends on renderer runtime', [
    'context-state-format.ts must stay pure; collect renderer state in context-state-attachments.ts instead'
  ])
} else {
  pass('post-compact state formatter is renderer-independent')
}

if (
  !/buildPostCompactStateContext/.test(stateAttachments) ||
  !/formatPostCompactStateContext/.test(stateAttachments)
) {
  fail('post-compact state renderer adapter is not wired to the pure formatter', [
    'context-state-attachments.ts must collect renderer state and call formatPostCompactStateContext'
  ])
} else {
  pass('post-compact state renderer adapter calls the pure formatter')
}

if (/requestContextMaxMessages\s*=\s*[\s\S]{0,120}\?\s*null\s*:\s*undefined/.test(chatActions)) {
  fail('chat action still full-loads history when compression is enabled', [
    'use-chat-actions.ts must not set requestContextMaxMessages=null just because compression is enabled'
  ])
} else {
  pass('chat action does not full-load history solely for compression')
}

for (const message of passes) {
  console.log(`[PASS] ${message}`)
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`[FAIL] ${failure.message}`)
    for (const detail of failure.details) {
      console.error(`  - ${detail}`)
    }
  }
  process.exit(1)
}

console.log('[PASS] long-task context compression diagnostics passed')
```

- [ ] **Step 2: package.json 增加脚本**

在 `scripts` 中增加：

```json
"diagnose:long-task-compression": "node ./scripts/diagnose-long-task-context-compression.mjs"
```

- [ ] **Step 3: 运行新诊断**

Run:

```bash
npm run diagnose:long-task-compression
```

Expected:

```text
[PASS] agent loop compacts oversized tool results before replay
[PASS] agent loop separates UI-visible tool output from replay payloads
[PASS] agent loop separates observed provider tokens from estimated replay tokens
[PASS] agent loop has preflight context budget management
[PASS] API round grouping tracks pending tool_use/tool_result pairs
[PASS] compression results expose skip reasons
[PASS] compaction has prompt-too-long retry handling
[PASS] payload compaction marker is present
[PASS] payload compaction exposes precise reason list
[PASS] shared runtime replay tool results preserve or derive tool names
[PASS] post-compact state messages are deduplicated
[PASS] post-compact state formatter includes working state
[PASS] post-compact state formatter is renderer-independent
[PASS] post-compact state renderer adapter calls the pure formatter
[PASS] chat action does not full-load history solely for compression
[PASS] long-task context compression diagnostics passed
```

- [ ] **Step 4: Commit**

```bash
git add scripts/diagnose-long-task-context-compression.mjs package.json
git commit -m "test(agent): add long-task compression diagnostics"
```

---

### Task 11: 全量验证与手动回归

**Files:**

- No source changes expected.

- [ ] **Step 1: 运行 lint**

Run:

```bash
npm run lint
```

Expected: exit code `0`。

- [ ] **Step 2: 运行 typecheck**

Run:

```bash
npm run typecheck
```

Expected: exit code `0`。

- [ ] **Step 3: 运行长任务上下文 fixture 测试**

Run:

```bash
npm run test:agent-context
```

Expected: exit code `0`，并包含：

```text
Test Files  1 passed
Tests  5 passed
```

- [ ] **Step 4: 运行 context 回归诊断**

Run:

```bash
npm run diagnose:context-regressions
```

Expected: exit code `0`，并包含：

```text
[PASS] context regression diagnostics passed
```

- [ ] **Step 5: 运行长任务压缩诊断**

Run:

```bash
npm run diagnose:long-task-compression
```

Expected: exit code `0`，并包含：

```text
[PASS] long-task context compression diagnostics passed
```

- [ ] **Step 6: 本地冒烟验证**

Run:

```bash
npm run dev
```

手动验证步骤：

1. 打开一个新会话，确认 Context Compression 开启。
2. 发送一个会触发长工具输出的任务，例如读取或搜索大量内容。
3. 观察工具结果卡片：用户可见输出应保持完整或可展开，不应只剩 `Tool result compacted for context budget`；该标记只应出现在模型 replay transcript、request debug 或压缩输入视图中。
4. 继续让 agent 进入下一轮工具调用或总结。
5. 确认没有白屏，Context 面板仍可打开。
6. 双击压缩 Context：如果不能摘要压缩，toast 应说明具体 reason，不再固定显示“当前消息数量不足”。
7. 在已有长会话中继续发送消息，确认不会因为开启压缩而一次性加载全量历史导致明显卡死。
8. 构造或复用一段包含 assistant `tool_use` 与紧随 user `tool_result` 的长会话，继续追问并检查 request debug：窗口截断和 PTL retry 不应产生孤立 `tool_use` 或孤立 `tool_result`。
9. 连续触发两次手动压缩，检查压缩后的 transcript 中 `meta.postCompactState` 消息最多保留 1 条新的状态注入消息，不应把旧状态消息重复 preserved。
10. 触发一次自动压缩后检查 UI 聊天列表：`mergeCompressedMessagesIntoConversation()` 应能使用 `compactBoundary.preservedSegment.headId` 找到真实 preserved message；压缩摘要、post-compact state 和后续原始消息顺序应为 `[boundary, summary, postCompactState?, ...currentTail]`，不应丢失当前尾部消息。
11. 对纯函数 fixture 做代码走查或临时断点验证：`groupMessagesByApiRound` 三个 fixture 与计划 Task 1 一致；`compactToolResultForContext` 对纯文本、图片和混合内容分别返回正确 `reasons[]`；`formatPostCompactStateContext` 不导入 store/i18n；`truncateHeadForPromptTooLongRetry` 每次基于 `baseMessages` 重新计算。

- [ ] **Step 7: 处理验证发现的问题**

如果 Step 1-6 发现遗漏修复，返回对应实现任务补齐，并使用该任务列出的精确 `git add` 命令提交；不要在 Task 11 创建泛化提交。

如果没有额外改动，不创建空提交。

---

## 后续独立计划：sidecar/main runtime compression

本计划刻意不把 compression 迁移到 `src/main/cron/cron-agent-background.ts`，因为那会触及主进程 provider、tool loop、stream event protocol、renderer fallback tool executor 与压缩摘要调用链。完成本计划后，如果仍希望长任务默认走 sidecar，应另起计划：

- 在 shared 类型中定义 main runtime compression config wire schema。
- 将 budget/payload compaction 的纯函数下沉到 `src/shared` 或复制为 main-safe 模块。
- 在 `runInteractiveAgentLoop` 中实现 preflight、payload dehydration、PTL retry。
- 让 sidecar `agent/run` 接收 compression 配置，不再传 `compression: null`。
- 更新 `scripts/diagnose-context-regressions.mjs`，允许“main runtime supports compression”的分支通过。

---

## Self-review

- Spec coverage: 覆盖了长任务单轮工具结果爆 token、UI 输出与模型 replay 脱水分离、手动压缩误导提示、Prompt Too Long retry、post-compact state、全量历史加载白屏风险。
- 占位项扫描：无未定项或待补充占位任务；每个实现任务给出目标文件、代码片段、命令和期望结果。
- Type consistency: 使用现有 `UnifiedMessage`、`ContentBlock`、`ToolResultContent`、`CompressionConfig`、`AgentLoopConfig`，新增 `CompressionSkipReason`、`postCompactState` meta、state formatter/adapter 与后续调用保持一致。
- Architecture review fixes: 已纳入子代理 review 的关键修正：纯 formatter 与 renderer adapter 分离、API round 保护 tool_use/tool_result 配对、PTL retry 基于 `baseMessages` 重新计算、长会话续聊验证覆盖窗口截断风险。
- Scope check: sidecar/main runtime compression 被明确拆为后续独立计划，避免本次修复范围失控。

---

## 2026-05-19 调研记录：Context 超限恢复需求

### 需求结论

除“最新请求本体、系统提示、工具 schema 或 provider 固定包装本身已经超过模型窗口”这类物理上限外，普通历史消息、本地加载内容、工具输出、旧 usage 统计、摘要失败，都不应导致会话无法继续。

需求上可以接受少量本地加载信息、旧工具输出或旧历史上下文丢失；不接受因为 context 无法压缩而阻断继续对话。

### 已落地的约束

- 手动压缩失败时，不写回为压缩临时 externalize 的用户输入。
- Renderer Claude strategy 使用 shared context gate，阈值与 main/shared 逻辑一致。
- 发送前 hard limit / reserved output gate 阻塞前，先执行 deterministic emergency shrink。
- Emergency shrink 会压缩工具 payload、外置化超大文本、清理 stale usage，并在必要时丢弃最旧 API round。
- 工具修复逻辑保留 tool_use/tool_result 协议结构，不再把相邻工具输出拆成可渲染的用户输入气泡。

### 仍需跟进

- Provider 已返回 `context length`、`prompt too long`、`too many tokens`、`413` 等超限错误时，当前仍缺少“识别错误 -> emergency shrink/compact -> 自动重试一次”的闭环。
- 最新活跃工具回合的协议结构不能破坏，但其 payload 必须强制有界；后续应把“当前 tool_result replay 永不无界”作为显式不变量。
- 固定开销超限需要单独诊断：当 system prompt、tool schema、provider 包装开销本身超过可用窗口时，应返回明确错误，而不是归因到历史 context 压缩失败。

### 后续实现建议

1. 在 renderer `runAgentLoop` provider send catch 中识别 provider context overflow，且仅在尚未产生流式内容时触发自动恢复。
2. 恢复路径优先运行 emergency shrink；若仍超限，再按可压缩历史执行一次 compact 或旧 round 丢弃。
3. 增加单元测试：provider 第一次返回 context overflow，第二次使用 shrink 后消息成功继续。
4. 增加固定开销测试：当工具 schema 或请求包装估算本身超过窗口时，返回专用错误类型。
