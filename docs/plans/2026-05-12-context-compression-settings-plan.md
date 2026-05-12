# 上下文压缩设置 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在设置中支持配置默认上下文长度、默认压缩阈值和压缩策略，同时保留模型级上下文长度与压缩阈值覆盖能力。

**Architecture:** 将上下文压缩的“设置解析”和“压缩策略执行”分层。全局设置提供未知模型的默认值，模型配置作为最高优先级覆盖；当前压缩实现包装为 `partial-summary-v1` 默认策略，并为后续新增策略保留注册边界。

**Tech Stack:** Electron、React 19、Zustand persist、TypeScript strict、i18next、现有 Agent Loop 与 IPC sidecar bridge。

---

## 当前决策

- 全局设置新增：
  - 默认上下文长度，默认 `200000`
  - 默认压缩阈值，默认 `80%`，范围 `30% - 90%`
  - 压缩策略，默认 `partial-summary-v1`
- 模型级覆盖保留：
  - `AIModelConfig.contextLength`
  - `AIModelConfig.contextCompressionThreshold`
- 第一版不做模型级策略覆盖，避免模型设置过重。
- 第一版策略下拉只启用 `partial-summary-v1`。后续可加 `microcompact-first-v1`、`working-memory-v1`。
- `DEFAULT_CONTEXT_COMPRESSION_LIMIT = 200_000` 语义改为未知模型 fallback，不再描述成统一上限。
- 必须修正设置文案中写死的 `90%`。
- 必须处理 sidecar 路径：当前 `src/main/cron/cron-agent-background.ts` 的 `AgentLoopConfig` 没有 context compression 钩子，`src/main/ipc/js-agent-runtime.ts` 也未接入 `compression`。第一版推荐在 compression 启用时走 renderer node loop，避免 sidecar 吞掉配置；如要保持 sidecar，需把压缩逻辑移植到 main loop，范围更大。

## 解析优先级

上下文长度：

```text
模型 contextLength
  -> 最近 usage.contextLength（仅 interactive chat 可用）
  -> 全局 contextCompressionDefaultContextLength
  -> 200000
```

压缩阈值：

```text
模型 contextCompressionThreshold
  -> 全局 contextCompressionDefaultThreshold
  -> 0.8
```

压缩策略：

```text
全局 contextCompressionStrategy
  -> partial-summary-v1
```

---

### Task 1: 新增纯配置模块

**Files:**
- Create: `src/renderer/src/lib/agent/context-compression-config.ts`
- Modify: `src/renderer/src/lib/agent/context-compression.ts`

**Step 1: 创建配置模块**

新增纯 TypeScript 模块，不依赖 i18n、store、IPC，避免 `settings-store` 引入重运行时依赖。

```ts
export const DEFAULT_CONTEXT_COMPRESSION_CONTEXT_LENGTH = 200_000
export const DEFAULT_CONTEXT_COMPRESSION_THRESHOLD = 0.8
export const MIN_CONTEXT_COMPRESSION_THRESHOLD = 0.3
export const MAX_CONTEXT_COMPRESSION_THRESHOLD = 0.9

export const CONTEXT_COMPRESSION_STRATEGY_IDS = ['partial-summary-v1'] as const

export type ContextCompressionStrategyId = (typeof CONTEXT_COMPRESSION_STRATEGY_IDS)[number]

export function isContextCompressionStrategyId(
  value: unknown
): value is ContextCompressionStrategyId {
  return value === 'partial-summary-v1'
}

export function clampCompressionContextLength(value?: number | null): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_CONTEXT_COMPRESSION_CONTEXT_LENGTH
  }
  return Math.max(1, Math.floor(value))
}

export function clampCompressionThreshold(value?: number | null): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_CONTEXT_COMPRESSION_THRESHOLD
  }
  return Math.min(
    MAX_CONTEXT_COMPRESSION_THRESHOLD,
    Math.max(MIN_CONTEXT_COMPRESSION_THRESHOLD, value)
  )
}

export function resolveCompressionStrategyId(
  value?: unknown
): ContextCompressionStrategyId {
  return isContextCompressionStrategyId(value) ? value : 'partial-summary-v1'
}
```

**Step 2: 迁移现有常量**

将 `context-compression.ts` 中的阈值相关常量从新模块导入，并保留兼容导出：

```ts
export {
  DEFAULT_CONTEXT_COMPRESSION_CONTEXT_LENGTH,
  DEFAULT_CONTEXT_COMPRESSION_THRESHOLD,
  MIN_CONTEXT_COMPRESSION_THRESHOLD,
  MAX_CONTEXT_COMPRESSION_THRESHOLD,
  clampCompressionThreshold
} from './context-compression-config'

export const DEFAULT_CONTEXT_COMPRESSION_LIMIT = DEFAULT_CONTEXT_COMPRESSION_CONTEXT_LENGTH
```

**Step 3: 运行类型检查**

Run:

```bash
npm run typecheck
```

Expected: 不能有由导出迁移引入的 TypeScript 错误。

---

### Task 2: 扩展设置 store

**Files:**
- Modify: `src/renderer/src/stores/settings-store.ts`

**Step 1: 添加字段**

在 `SettingsStore` 中新增：

```ts
contextCompressionDefaultContextLength: number
contextCompressionDefaultThreshold: number
contextCompressionStrategy: ContextCompressionStrategyId
```

需要从 `context-compression-config.ts` 导入：

```ts
import {
  DEFAULT_CONTEXT_COMPRESSION_CONTEXT_LENGTH,
  DEFAULT_CONTEXT_COMPRESSION_THRESHOLD,
  clampCompressionContextLength,
  clampCompressionThreshold,
  resolveCompressionStrategyId,
  type ContextCompressionStrategyId
} from '@renderer/lib/agent/context-compression-config'
```

**Step 2: 设置默认值**

在 store 初始值中加入：

```ts
contextCompressionDefaultContextLength: DEFAULT_CONTEXT_COMPRESSION_CONTEXT_LENGTH,
contextCompressionDefaultThreshold: DEFAULT_CONTEXT_COMPRESSION_THRESHOLD,
contextCompressionStrategy: 'partial-summary-v1',
```

**Step 3: 迁移持久化版本**

将 persist `version` 从 `19` 升到 `20`。在 `migrate` 中补默认值：

```ts
if (
  state.contextCompressionDefaultContextLength === undefined ||
  typeof state.contextCompressionDefaultContextLength !== 'number'
) {
  state.contextCompressionDefaultContextLength = DEFAULT_CONTEXT_COMPRESSION_CONTEXT_LENGTH
} else {
  state.contextCompressionDefaultContextLength = clampCompressionContextLength(
    state.contextCompressionDefaultContextLength
  )
}

if (
  state.contextCompressionDefaultThreshold === undefined ||
  typeof state.contextCompressionDefaultThreshold !== 'number'
) {
  state.contextCompressionDefaultThreshold = DEFAULT_CONTEXT_COMPRESSION_THRESHOLD
} else {
  state.contextCompressionDefaultThreshold = clampCompressionThreshold(
    state.contextCompressionDefaultThreshold
  )
}

state.contextCompressionStrategy = resolveCompressionStrategyId(
  state.contextCompressionStrategy
)
```

**Step 4: 更新 updateSettings 和 partialize**

在 `updateSettings` 中 clamp 新字段：

```ts
...(patch.contextCompressionDefaultContextLength === undefined
  ? {}
  : {
      contextCompressionDefaultContextLength: clampCompressionContextLength(
        patch.contextCompressionDefaultContextLength
      )
    }),
...(patch.contextCompressionDefaultThreshold === undefined
  ? {}
  : {
      contextCompressionDefaultThreshold: clampCompressionThreshold(
        patch.contextCompressionDefaultThreshold
      )
    }),
...(patch.contextCompressionStrategy === undefined
  ? {}
  : { contextCompressionStrategy: resolveCompressionStrategyId(patch.contextCompressionStrategy) })
```

把三个字段加入 `partialize`。

**Step 5: 运行类型检查**

Run:

```bash
npm run typecheck
```

Expected: store 类型和 persist migration 通过。

---

### Task 3: 更新压缩配置解析

**Files:**
- Modify: `src/renderer/src/lib/agent/context-compression.ts`
- Modify: `src/renderer/src/lib/agent/context-compression-runtime.ts`
- Modify: `src/renderer/src/hooks/use-chat-actions.ts`
- Modify: `src/renderer/src/components/chat/InputArea.tsx`
- Modify: `src/renderer/src/components/cowork/ContextPanel.tsx`

**Step 1: 扩展 `CompressionConfig`**

```ts
export interface CompressionConfig {
  enabled: boolean
  contextLength: number
  threshold: number
  strategyId: ContextCompressionStrategyId
  preCompressThreshold?: number
  reservedOutputBudget?: number
}
```

**Step 2: 增加解析入参**

```ts
export interface CompressionDefaults {
  defaultContextLength?: number
  defaultThreshold?: number
  strategyId?: ContextCompressionStrategyId
}
```

更新：

```ts
export function resolveCompressionThreshold(
  modelConfig?: Pick<AIModelConfig, 'contextCompressionThreshold'> | null,
  defaults?: Pick<CompressionDefaults, 'defaultThreshold'>
): number
```

规则：模型阈值优先，否则全局默认，否则 `0.8`。

更新：

```ts
export function resolveCompressionContextLength(
  modelConfig?: Pick<AIModelConfig, 'contextLength' | 'enableExtendedContextCompression'> | null,
  defaults?: Pick<CompressionDefaults, 'defaultContextLength'>
): number
```

规则：模型上下文优先，否则全局默认，否则 `200000`。保留 `enableExtendedContextCompression === false` 时将超过 `200000` 的模型值限制到 fallback 的行为，但不要限制全局默认值。

**Step 3: 更新 runtime config 构建**

在 `buildRuntimeCompressionConfig()` 中读取：

```ts
const defaults = {
  defaultContextLength: settings.contextCompressionDefaultContextLength,
  defaultThreshold: settings.contextCompressionDefaultThreshold,
  strategyId: settings.contextCompressionStrategy
}
```

返回：

```ts
return {
  enabled: true,
  contextLength,
  threshold: resolveCompressionThreshold(modelConfig, defaults),
  strategyId: resolveCompressionStrategyId(defaults.strategyId),
  preCompressThreshold: 0.65,
  reservedOutputBudget: resolveCompressionReservedOutputBudget(modelConfig)
}
```

**Step 4: 更新 UI 预算计算处**

`InputArea.tsx`、`ContextPanel.tsx` 使用相同 defaults，避免显示的预算和实际执行不同。

**Step 5: 更新 `use-chat-actions.ts`**

构造 `compressionConfig` 时使用全局默认上下文长度和阈值。注意 interactive chat 可继续保留 `findPersistedContextLength(messagesToSend)` 作为模型缺省时的次级来源。

**Step 6: 运行类型检查**

Run:

```bash
npm run typecheck
```

Expected: 所有调用点都传入或兼容新字段。

---

### Task 4: 添加策略注册边界

**Files:**
- Modify: `src/renderer/src/lib/agent/context-compression.ts`
- Modify: `src/renderer/src/lib/agent/agent-loop.ts`

**Step 1: 定义策略接口**

```ts
export interface ContextCompressionStrategy {
  id: ContextCompressionStrategyId
  shouldCompress: (inputTokens: number, config: CompressionConfig) => boolean
  shouldPreCompress: (inputTokens: number, config: CompressionConfig) => boolean
  preCompressMessages: (messages: UnifiedMessage[]) => UnifiedMessage[]
  compressMessages: (
    messages: UnifiedMessage[],
    providerConfig: ProviderConfig,
    signal?: AbortSignal,
    preserveCount?: number,
    focusPrompt?: string,
    pinnedContext?: string,
    trigger?: CompactBoundaryMeta['trigger'],
    preTokens?: number
  ) => Promise<{ messages: UnifiedMessage[]; result: CompressionResult }>
}
```

**Step 2: 将当前实现包装为默认策略**

```ts
const partialSummaryStrategy: ContextCompressionStrategy = {
  id: 'partial-summary-v1',
  shouldCompress: shouldCompressCurrent,
  shouldPreCompress: shouldPreCompressCurrent,
  preCompressMessages: preCompressMessagesCurrent,
  compressMessages: compressMessagesCurrent
}
```

为了减少改动，可以保留现有导出函数名作为 facade：

```ts
export function getCompressionStrategy(config: CompressionConfig): ContextCompressionStrategy {
  switch (resolveCompressionStrategyId(config.strategyId)) {
    case 'partial-summary-v1':
    default:
      return partialSummaryStrategy
  }
}

export function shouldCompress(inputTokens: number, config: CompressionConfig): boolean {
  return getCompressionStrategy(config).shouldCompress(inputTokens, config)
}
```

**Step 3: 更新 agent loop**

`agent-loop.ts` 可以继续调用 facade 函数。可选改为：

```ts
const strategy = getCompressionStrategy(cc.config)
if (strategy.shouldCompress(lastInputTokens, cc.config)) ...
```

第一版推荐保持 facade，降低 diff。

**Step 4: 运行类型检查**

Run:

```bash
npm run typecheck
```

Expected: 现有行为不变，策略字段存在。

---

### Task 5: 设置页 UI 与文案

**Files:**
- Modify: `src/renderer/src/components/settings/SettingsPage.tsx`
- Modify: `src/renderer/src/locales/zh/settings.json`
- Modify: `src/renderer/src/locales/en/settings.json`
- Optional Modify: `src/renderer/src/components/settings/ProviderPanel.tsx`
- Optional Modify: `src/renderer/src/components/chat/ModelSwitcher.tsx`

**Step 1: 修正文案**

替换写死 `90%` 的文案。

中文建议：

```json
"contextCompressionEnabled": "已启用：达到配置阈值后会自动压缩历史消息；实际触发会预留输出空间和安全缓冲"
```

英文建议：

```json
"contextCompressionEnabled": "Enabled: history will be compressed when the configured threshold is reached; output headroom and safety buffers are reserved"
```

**Step 2: 在通用设置页增加控件**

在 Context Compression section 中新增：

- 默认上下文长度：number input
- 默认压缩阈值：range 或 number input，显示百分比
- 压缩策略：select

中文 label 建议：

```json
"contextCompressionDefaultContextLength": "默认上下文长度",
"contextCompressionDefaultContextLengthDesc": "用于未配置上下文长度的模型",
"contextCompressionDefaultThreshold": "默认压缩阈值",
"contextCompressionDefaultThresholdDesc": "模型未单独配置时使用，范围 {{min}}% - {{max}}%",
"contextCompressionStrategy": "压缩策略",
"contextCompressionStrategyDesc": "决定如何压缩历史上下文",
"contextCompressionStrategyPartialSummary": "标准摘要压缩"
```

英文同名 key 补齐。

**Step 3: 调整模型级阈值说明**

`ProviderPanel.tsx` 中模型阈值文案加一句“留空或默认值将使用全局默认”会更清楚。但当前 input 初始化总是填默认值，第一版可以只保留现状，后续再改成可清空继承。

**Step 4: 模型切换器文案**

`ModelSwitcher.tsx` 里阈值滑条当前直接改模型级阈值。保留行为，但在 tooltip 或 label 中注明这是“当前模型覆盖值”。没有 tooltip 系统时可暂不改。

**Step 5: 运行 lint**

Run:

```bash
npm run lint
```

Expected: UI 和 locale 改动无 lint 错误。

---

### Task 6: 处理 sidecar 路径

**Files:**
- Modify: `src/renderer/src/hooks/use-chat-actions.ts`
- Optional Modify: `src/main/ipc/js-agent-runtime.ts`
- Optional Modify: `src/main/cron/cron-agent-background.ts`

**Step 1: 选择第一版策略**

推荐第一版不要把压缩逻辑移植到 main loop，而是在 compression 启用且有 `compressionConfig` 时不走 sidecar：

```ts
if (args.compression?.enabled) return false
```

位置：`canUseSidecarForAgentRun()` 中构造 sidecarRequest 之后、capability checks 之前。

原因：当前 main loop 的 `AgentLoopConfig` 没有 `contextCompression`，仅给 `JsAgentRunRequest` 加字段不会生效。

**Step 2: 增加注释说明**

注释需说明：

- renderer `runAgentLoop` 当前支持压缩
- main `runInteractiveAgentLoop` 尚未支持压缩
- 启用 compression 时走 renderer node path，保证设置实际生效

**Step 3: 可选长期方案**

如果后续要恢复 sidecar + compression，需要：

- 在 `src/main/cron/cron-agent-background.ts` 的 `AgentLoopConfig` 增加 context compression 钩子
- 移植 `shouldCompress`、`shouldPreCompress`、`preCompressMessages`
- 提供 main process 可用的 summarizer 请求
- 确保 `context_compression_start` / `context_compressed` 事件与 renderer 兼容

**Step 4: 运行 typecheck**

Run:

```bash
npm run typecheck
```

Expected: sidecar gating 改动通过类型检查。

---

### Task 7: 更新文档

**Files:**
- Modify: `docs/docs/core-concepts/context-compression.mdx`
- Modify: `docs/docs/core-concepts/agent-loop.mdx`

**Step 1: 更新上下文压缩文档**

替换过时示例：

```ts
const COMPRESS_THRESHOLD = 100_000
const PRE_COMPRESS_THRESHOLD = 80_000
```

改为描述真实计算：

```text
effectiveWindow = contextLength - reservedOutputBudget
autoTrigger = min(effectiveWindow * threshold, effectiveWindow - autoBuffer)
preTrigger = min(effectiveWindow * preThreshold, effectiveWindow - preBuffer, autoTrigger - gap)
```

**Step 2: 增加配置说明**

补充：

- 默认上下文长度用于未知模型
- 模型上下文长度优先
- 模型压缩阈值优先于全局默认阈值
- 第一版策略为标准摘要压缩

**Step 3: 运行 docs 检查**

仓库没有专门 docs lint。至少运行：

```bash
npm run typecheck
```

Expected: 主项目类型检查通过。

---

### Task 8: 最终验证

**Files:**
- No edits.

**Step 1: 运行 lint**

Run:

```bash
npm run lint
```

Expected: ESLint 通过。

**Step 2: 运行 typecheck**

Run:

```bash
npm run typecheck
```

Expected: Node 与 renderer TypeScript 项目通过。

**Step 3: 冒烟验证**

Run:

```bash
npm run dev
```

Manual checks:

- 设置页能看到默认上下文长度、默认压缩阈值、压缩策略。
- 修改默认上下文长度后，输入区和 ContextPanel 的预算显示同步变化。
- 修改默认压缩阈值后，自动压缩阈值显示同步变化。
- 模型级阈值存在时，模型级值覆盖全局默认值。
- 未配置 `contextLength` 的模型使用全局默认上下文长度。
- 文案不再出现固定 `90%`。
- 启用 compression 后 agent 执行路径不会走不支持压缩的 main sidecar loop，或已明确实现 main loop compression。

---

## 后续策略预留

未来新增策略时，只需：

1. 在 `CONTEXT_COMPRESSION_STRATEGY_IDS` 增加 id。
2. 在 `getCompressionStrategy()` 注册实现。
3. 在 settings locale 中增加展示名称。
4. 在 SettingsPage select 中启用该选项。

建议预留但暂不启用：

- `microcompact-first-v1`：优先压缩工具输出，仍不够时再做全局摘要。
- `working-memory-v1`：持续维护任务工作记忆，压缩时注入工作记忆和近期原文。

