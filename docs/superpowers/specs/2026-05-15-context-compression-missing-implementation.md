# Context 压缩机制缺少的实现项

## 背景

OpenCowork 已完成 `claude-code-compact-v1` 的核心压缩策略、renderer/main/sidecar runtime parity、API round 安全边界、Prompt Too Long retry、summary fail-closed、敏感信息脱敏和 post-compact continuity state。

当前仍存在两个主要问题：

1. 当上下文较高但近期任务消息必须保留时，普通历史摘要可能返回 `insufficient_compressible_messages`，导致无法压缩。
2. 当一次工具返回、文件处理、日志输出或用户输入特别大时，payload 可能在进入消息历史或下一次模型请求前就把 context 撑爆，普通 compact 没有足够机会介入。

本文记录后续还缺少的实现项、优先级、建议方案和验收标准。

## 已实现与未实现边界

当前已经实现的压缩基础能力包括：

- Claude-style 预算计算：`contextWindow - min(maxOutputTokens, 20_000) - 13_000`；
- compact summarizer 请求自身的 Prompt Too Long retry：最多 3 次，并按完整 API round 丢弃最旧可压缩 round；
- `/compact` 与 `/compact <focus>` 手动压缩路径；
- renderer/main/sidecar runtime parity 的基础压缩路径；
- API round 安全边界、summary fail-closed、敏感信息脱敏和基础 compact boundary metadata。

其中 runtime parity 指基础 compact core 接入和基础压缩路径一致，不代表 warning gate、pre-compress gate、hard gate、checkpoint 调度、append/finalize guard 与诊断 taxonomy 已完全一致。

现有 sanitizer 主要覆盖 compact summarizer 输入清洗，不等同于消息 append 前的 ingestion guard。也就是说，它能避免脏 payload 进入 compact 摘要请求，但不能保证超大 payload 在进入消息历史前已被脱水。

本文所列缺口不是否定上述能力，而是记录还没有完整覆盖的执行路径，尤其是：

- 请求发出前基于 hard context limit 的强制阻断、降级和 emergency deterministic compaction；
- warning gate、pre-compress gate 与 hard gate 在 renderer/main/sidecar 三端的一致性；
- 单次超大 payload 在进入消息历史前的处理；
- 近期任务必须保留时对近期 payload 的 fallback 压缩；
- partial compact、hooks、session memory、prompt cache、relink 等更完整的 Claude Code 机制。

## 保证边界

后续实现不应承诺“任何超大返回都能被一次摘要压缩后继续”。正确保证是：

- 超大 payload 不再原样进入模型上下文；
- 可脱水的 payload 会先脱水再写入消息历史；
- 可摘要的历史会在安全边界触发 compact；
- 如果仍然超过模型窗口，会阻断下一次模型请求，而不是继续发送超限请求；
- 对必须逐字处理的超长输入，改用文件化、分块处理或更大上下文模型。

## 缺口总览

| 优先级 | 缺少实现 | 影响 runtime | 当前影响 | 推荐处理 |
| --- | --- | --- | --- | --- |
| P0 | 单次超大 payload 入库前脱水 | renderer/main/sidecar | 工具结果或文件内容可能一次性撑爆 context | 在 append 前执行 ingestion guard |
| P0 | 请求前 hard gate | renderer/main/sidecar | `inputTokens > contextWindow` 时仍可能进入下一次请求路径 | 请求前执行 emergency deterministic compaction，失败则阻断 |
| P0 | `insufficient_compressible_messages` fallback | renderer/main/sidecar | 历史不足但近期 payload 很大时无法压缩 | 对 preserved recent payload 做脱水 |
| P1 | checkpoint-based auto compact | renderer/main/sidecar | compact 主要发生在请求前或手动触发，安全中断点覆盖不足 | 在 tool result、assistant response、step boundary 后调度 compact |
| P1 | warning / pre-compress gate parity | renderer/main/sidecar | 三端 warning、pre-compress、hard gate 的触发时机和 reason 可能不一致 | 统一预算门禁、错误分类和 telemetry |
| P1 | assistant output finalize checkpoint | renderer/main/sidecar | 非流式 assistant 单次输出过大时，append 后可能挤爆后续上下文 | response finalize / append 前做预算检查、截断或分段入库 |
| P1 | partial compact / from-up-to compact | renderer/main/sidecar | 单个长任务内早期已完成步骤被整段保留 | 在同一任务 round 内压缩较早闭合子步骤 |
| P1 | 超长用户输入处理 | renderer 为主，main/sidecar 需协议兼容 | 用户一次粘贴超长文本无法靠历史 compact 解决 | 自动文件化或要求用户上传文件，支持 chunk summary |
| P2 | session memory compaction | renderer/main/sidecar | 长期有效状态与会话摘要混在一起 | 抽取 session memory 层并与 traditional compact 分层 |
| P2 | PreCompact / PostCompact hooks | renderer/main/sidecar/plugin/MCP | 插件、MCP、运行时状态无法在 compact 前后参与 | 增加 hook 协议、超时、失败和取消处理 |
| P2 | prompt cache sharing / cache baseline | provider/runtime 层 | compact 前后缓存策略不完整，成本和性能不稳定 | 增加 cache breakpoint、baseline reset 和 provider cache-control |
| P2 | 更完整 post-compact re-injection | renderer/main/sidecar | 只覆盖核心连续性，未完整恢复所有运行时状态 | 注入 read file state、plan、skills、async agents、MCP 等 |
| P2 | relink / anchor metadata | renderer UI + shared compact core | 已有基础 metadata，但不够支撑 partial compact、恢复和重复压缩判断 | 增加 generation chain、source tracing 和 UI relink 信息 |
| P2 | streaming output continuation | renderer/main/sidecar | 模型自身单次长输出中途无法 compact | 支持流式预算监控、stop、checkpoint 和 continuation |
| P2 | UI 诊断细分 | renderer UI 为主，main/sidecar 需 reason parity | 当前提示容易把不同原因归为“历史不足” | 区分历史不足、近期 payload 过大、硬超限、协议未闭合等 |

## P0：单次超大 payload 入库前脱水

### 问题

如果工具一次返回大量文本，当前 compact 往往只能在消息已经进入历史后处理。若 payload 过大，可能直接导致下一次模型请求超限，甚至 compact 请求自身也无法构造。

典型来源：

- Bash 长日志；
- 大 JSON / HTML / XML；
- 大 diff；
- 大文件读取结果；
- 搜索或抓取返回的长文本；
- 图片、文档、base64、二进制内容；
- 带敏感信息的长输出。

### 建议实现

新增 ingestion guard，在 tool result 或大文本 append 前执行：

```text
incoming payload
  ↓
estimate size and risk
  ↓
if oversized:
  dehydrate / externalize / redact
  ↓
append compacted payload
```

不同 payload 的处理策略：

- 日志：保留错误段、最后 N 行、退出码、命令、统计信息；
- JSON：保留 schema、关键字段、数组长度、少量样本；
- HTML/XML：保留标题、结构摘要、关键文本；
- diff：保留文件列表、hunk 摘要、关键变更；
- 文件读取：保留路径、hash、行数、关键片段；
- base64/二进制：替换为占位；
- 敏感信息：先脱敏，再进入上下文。

### 验收标准

- 超大 tool result 不会原样出现在下一次模型请求中；
- `tool_use/tool_result` 协议仍完整；
- 脱水后的结果保留工具名、状态、长度、退出码、摘要和必要定位信息；
- 敏感信息不会进入脱水结果；
- renderer/main/sidecar runtime 行为一致。

## P0：请求前 hard gate 与 emergency deterministic compaction

### 问题

当 `inputTokens > contextWindow` 时，普通模型请求和 summarizer 请求都无法安全发送。此时不能再依赖 LLM compact，必须先做不依赖 LLM 的确定性瘦身。

### 建议实现

每次模型请求前执行：

```text
if inputTokens > contextWindow:
  emergency deterministic compaction
  if still too large:
    block next model request

if inputTokens + reservedOutputTokens > contextWindow:
  compact or reduce output budget
  if still too large:
    block next model request
```

确定性瘦身顺序：

1. 脱水大 payload；
2. 替换图片、文档、base64；
3. 折叠可重新注入附件；
4. 压缩 post-compact state；
5. 按完整 API round 丢弃最旧可丢弃历史；
6. 仍失败则阻断。

### 验收标准

- 超限时不会继续发模型请求；
- 阻断提示明确说明是输入超限、输出预算不足还是无法构造 compact 请求；
- 如果只是输出预算不足，可以先降低 `maxOutputTokens` 或触发 compact；
- 如果输入本身超过窗口，必须先确定性瘦身或阻断。

## P0：`insufficient_compressible_messages` 的 recent payload fallback

### 问题

当前普通 compact 需要可安全摘要的旧历史。如果当前上下文主要由最近一个任务 round 或近期工具结果撑大，压缩范围选择会失败，并提示近期任务消息必须保留。

### 建议实现

当普通 compact 返回 `insufficient_compressible_messages` 且 token pressure 较高时，不直接失败，而是尝试：

```text
preserved recent messages
  ↓
find oversized payloads
  ↓
dehydrate payloads while keeping message structure
  ↓
if token reduced enough:
  return compacted messages
else:
  keep original messages and return explicit failure reason
```

### 验收标准

- 近期用户任务、assistant 工具调用和 tool result 配对不被破坏；
- 近期大 payload 被脱水；
- 如果 token 明显下降，手动 compact 不再提示“暂无足够历史消息”；
- 如果近期消息本身不可脱水，返回更精确的 skip reason。

## P1：checkpoint-based auto compact

### 问题

单次工具返回或长任务执行中，等待下一次用户输入才 compact 太晚。compact 应在 agent loop 的安全中断点调度。

### 建议 checkpoint

- tool result append 前；
- tool result append 后；
- assistant response 完成后；
- 下一轮 model request 前；
- main/sidecar 每个 agent step 结束后；
- streaming response 完成后。

### 建议状态

```text
pendingCompact:
  reason
  tokenPressure
  lastSafeCheckpoint
  blockingNextRequest
```

### 触发守卫

checkpoint 调度必须遵守以下守卫：

- compact 正在执行时不递归触发 compact；
- compact request 自身不触发 compact；
- auto compact 熔断打开时不触发新的 auto compact；
- 没有安全边界时只返回诊断 reason，不强行压缩；
- 工具协议未闭合时等待下一个安全 checkpoint。

### 验收标准

- 工具闭合后如果超过阈值，会在下一次模型请求前处理；
- compact 自身不会递归触发 compact；
- 失败时进入熔断或明确阻断，不会无限循环。

## P1：warning / pre-compress gate parity

### 问题

当前已实现 Claude-style 预算计算，但 warning gate、pre-compress gate、hard gate 的触发路径需要在 renderer/main/sidecar 三端继续对齐。否则同一段消息可能在 renderer 中提示可压缩，在 sidecar/main 中继续执行，或返回不同 skip reason。

### 建议实现

统一门禁分类：

```text
warning gate:
  context pressure 接近阈值，提示但不阻断

pre-compress gate:
  下一次请求前应先尝试 compact 或 payload fallback

hard gate:
  不允许继续发送模型请求，必须 emergency compaction 或阻断
```

三端应共享：

- token 预算计算；
- reserved output 计算；
- skip reason 枚举；
- telemetry / diagnostic metadata；
- fallback 顺序。

### 验收标准

- 同一组消息在 renderer/main/sidecar 中得到一致 gate 分类；
- warning、pre-compress、hard gate 都有可诊断 reason；
- hard gate 永远不会退化为继续发送超限模型请求；
- 诊断脚本覆盖三端门禁一致性。

## P1：assistant output finalize checkpoint

### 问题

如果非流式 assistant response 一次生成大量文本，运行时可能在 response 完成后才发现上下文压力过高。此时虽然不能在该次模型输出中途 compact，但仍应在写入历史前或写入后下一个 checkpoint 处理，避免它撑爆后续请求。

### 建议实现

在 assistant response finalize / append 前后增加预算检查：

```text
assistant output finalized
  ↓
estimate output size and next-context pressure
  ↓
if oversized:
  truncate / segment / externalize / mark continuation
  ↓
append safe assistant message
  ↓
schedule checkpoint compact before next model request
```

约束：

- 不截断 tool_use JSON 或结构化工具调用；
- 普通文本可以分段或外部化；
- 分段后需要记录 continuation state；
- 如果无法安全截断，阻断下一步并给出明确 reason。

### 验收标准

- 单次 assistant 文本输出过大时不会原样撑爆下一轮请求；
- 工具调用结构不会被截断破坏；
- continuation state 可诊断；
- renderer/main/sidecar 行为一致。

## P1：partial compact / from-up-to compact

### 问题

一个用户任务可能执行很多工具调用。若它们被归为一个近期 API round，普通策略会整体保留，导致没有足够历史可摘要。

### 建议实现

支持同一任务 round 内的安全子边界：

```text
current user task anchor
  early completed tool substeps -> summarize
  middle payloads -> dehydrate
  latest unresolved or high-relevance tail -> preserve
```

约束：

- 不拆未闭合 `tool_use/tool_result`；
- 不保留孤立 `tool_result`；
- 不摘要正在等待结果的工具调用；
- 保留当前用户目标和最新未完成状态。

### 验收标准

- 单个长任务内早期已完成工具链可被摘要；
- 最新 tail 仍原样保留；
- partial compact 后 agent 能继续当前任务；
- metadata 记录 `from/up_to`、anchor、preserved range 和 compressed range。

## P1：超长用户输入处理

### 问题

用户一次粘贴超过模型窗口的大文本时，历史 compact 无法解决，因为单条输入本身已经超限。

### 建议实现

- 超长用户输入进入 agent loop 前检测；
- 自动写入临时文件或要求用户上传文件；
- 上下文只保留路径、大小、hash、摘要和处理计划；
- 支持 chunk summary / map-reduce summary；
- 明确提示不能逐字塞入上下文。

### 验收标准

- 单条用户输入超过阈值时不会直接进入消息历史；
- 用户可以选择文件化、分块摘要或取消；
- chunk 处理过程中敏感信息继续脱敏。

## P2：Session memory compaction

### 问题

当前会话摘要承担了过多职责。长期有效事实、工作记忆和短期执行上下文应分层。

### 建议实现

- 增加 session memory compact 层；
- 把稳定目标、用户偏好、项目约束、长期决策抽离；
- traditional compact 只处理短期对话历史；
- 自动 compact 优先尝试 session memory，再回退 traditional compact。

session memory 与 post-compact re-injection 的职责应分开：session memory 负责沉淀长期稳定事实，post-compact re-injection 只恢复本轮或近期执行连续性，不承担长期记忆沉淀。

### 验收标准

- 长期状态不会每次都重复进入 summary；
- session memory 更新有安全审查和去敏；
- 压缩失败不会污染 memory。

## P2：PreCompact / PostCompact hooks

### 问题

插件、MCP、运行时状态无法在 compact 前后参与，导致部分状态只能硬编码到 post-compact state。

### 建议实现

- `PreCompact`：允许模块声明需要保留或剥离的状态；
- `PostCompact`：允许模块重新注入恢复信息；
- hook 支持超时、取消、失败分类；
- hook 输出必须经过去敏和长度限制。

### 验收标准

- hook 失败不破坏原上下文；
- hook 输出不会泄露密钥；
- compact metadata 记录 hook 状态。

## P2：Prompt cache sharing 与 cache baseline

### 问题

当前压缩后没有完整的 prompt cache baseline 管理，可能影响成本、延迟和缓存命中。

### 建议实现

- compact 请求共享可复用 cache segment；
- compact 后重置或重建 cache baseline；
- 标记 cache breakpoints；
- 根据 provider 能力启用 cache-control。

### 验收标准

- compact 前后缓存状态可诊断；
- 不因 stale cache 导致旧上下文复现；
- provider 不支持 cache 时行为退化正常。

## P2：更完整的 post-compact re-injection

### 问题

当前 post-compact state 只覆盖核心连续性，还未完整复刻 Claude Code 的状态重注入。

### 待补类别

- read file state；
- active plan / plan mode；
- loaded skills；
- async agent 状态；
- deferred tools；
- MCP instructions；
- agent listing；
- loaded memory cache 清理；
- prompt-cache baseline 清理。

### 验收标准

- 压缩后 agent 不丢当前执行状态；
- 重注入内容有长度限制和去敏；
- 可诊断每类状态是否被注入或跳过。

## P2：Relink / anchor metadata

### 问题

当前已有基础 compact boundary metadata，例如 compressed range、preserved range、retry count，以及 preserved segment 的 head / anchor / tail 信息。但这些信息还不足以支撑完整 partial compact、历史恢复、UI relink、source tracing 和重复压缩判断。

### 建议实现

为压缩段和保留段补全：

- partial compact generation chain；
- source message ids；
- source token estimate；
- source runtime；
- source summary id；
- relink target ids；
- duplicate-compaction detection key；
- safety flags；
- compact trigger；
- compact generation id。

### 验收标准

- UI 能展示哪些内容被压缩、哪些被保留；
- partial compact 能基于 metadata 避免重复压缩同一段；
- resume/relink 可以定位源消息和生成链；
- 历史恢复可以区分 legacy compact、Claude compact 和 partial compact。

## P2：Streaming output continuation

### 问题

如果模型自身单次输出非常长，运行时通常只能在该次 response 完成后处理。要做到更细粒度，需要支持 continuation 机制。

### 建议实现

- streaming token budget 监控；
- 接近输出预算时主动 stop；
- 写入 partial assistant output；
- 在安全 checkpoint 执行 compact；
- 发 continuation request 继续输出。

### 验收标准

- 不会因模型自身长输出挤爆后续上下文；
- partial output 可恢复；
- continuation 不重复执行已完成工具调用。

## P2：UI 诊断细分

### 问题

“近期任务消息必须保留，暂无足够历史消息可摘要压缩”容易让用户误解为没有解决办法。

### 当前 reason 与目标 reason

当前共享核心已有基础 reason：

- `insufficient_messages`：消息太少；
- `insufficient_compressible_messages`：没有足够可摘要历史；
- `unsafe_boundary`：安全边界不满足；
- `summarizer_prompt_too_long`：compact 请求自身过长；
- `unsafe_summary_output`：summary 输出不安全；
- `summarizer_failed`：summary 模型调用失败。

后续 UI 与 runtime 诊断应扩展为更可操作的 reason：

- `insufficient_history`：确实没有旧历史；
- `recent_payload_too_large`：近期 payload 过大，需要脱水；
- `single_input_too_large`：单条用户输入过大；
- `hard_context_limit_exceeded`：输入已超过模型窗口；
- `reserved_output_budget_exceeded`：预留输出预算不足；
- `unsafe_tool_boundary`：工具协议未闭合；
- `compact_request_too_large`：compact 请求本身过大。

### 验收标准

- 手动 compact、自动 compact、sidecar/main runtime 返回一致的诊断 reason；
- UI 文案能提示可操作下一步；
- 诊断脚本覆盖各类 skip reason。

## Claude Code 其他可借鉴机制

以下机制不全属于 context compression，但与长任务稳定性、Agent loop 生命周期和本地执行安全强相关，后续可以作为独立设计或压缩二期之后的扩展方向。

### P0：优先借鉴

- 请求生命周期门禁：每次模型请求前统一检查 context、输出预算、工具协议闭合、pending compact、熔断状态和 runtime 是否允许继续发请求。
- 工具结果脱水与外部化：长日志、大 JSON、diff、大文件、二进制和附件不原样进入上下文，而是保留摘要、定位信息和可按需恢复的外部引用。
- Todo / Plan 状态显式化：把当前目标、步骤、已完成项、阻塞项、下一步和验证记录结构化保存，并在 compact 后重注入。
- Checkpoint / Resume / Rewind：在工具执行前后、compact 前后和安全 step boundary 保存 checkpoint，支持恢复、重试和会话 fork。
- Permission / Trust 机制：按命令、目录、网络、写文件、Git 操作等风险分级，危险操作必须确认，并保留审计记录。

### P1：体验和可扩展性增强

- Hook 系统：覆盖 PreToolUse、PostToolUse、PreCompact、PostCompact、PreEdit、PostEdit、PreRequest、PostRequest、OnError、OnSessionResume 等扩展点。
- Slash Command 体系：把 `/compact`、`/resume`、`/checkpoint`、`/review`、`/plan`、`/tasks`、`/memory`、`/model`、`/permissions`、`/diagnostics` 等常用流程产品化。
- 结构化诊断面板：展示 context 使用率、角色占比、超大 payload 来源、pending compact、压缩失败 reason、输出预算和 prompt cache 状态。
- 多级错误恢复：区分普通失败、Prompt Too Long、工具失败、协议失败和连续失败，分别执行重试、压缩、脱水、降级、熔断或阻断。
- Prompt cache / baseline 管理：稳定 system prompt、memory、tools、MCP 指令和 compact 后 baseline，降低成本并避免 stale cache。

### P2：长期增强

- Session memory 分层：区分 workspace protocol、user preference、project memory、current task state、transient observations 和 compressed summary。
- 文件状态 re-injection：compact 后恢复已读文件、最近编辑文件、dirty files、git diff、工作目录、命令记录、测试结果和 active plan。
- Subagent / sidecar 状态隔离：子代理独立 context，结果摘要回主会话，失败独立诊断，避免污染主上下文。
- 工具输出 streaming 控制：边显示边检测大小，超阈值停止收集全文，完整输出写入文件，聊天中只保留摘要和引用。
- Edit safety / patch ledger：记录文件修改范围、原因、是否读过、是否验证、是否格式化、是否有冲突和是否需要确认。
- 模型路由：简单分类/摘要用轻模型，代码实现和复杂推理用强模型，压缩 summarizer 使用稳定模型，超大上下文切长窗口模型。
- Agent loop 熔断：对重复工具失败、重复 Prompt Too Long、重复无效编辑、重复命令和子代理超时做循环检测和阻断。
- MCP / tool 指令压缩：按任务筛选 MCP server 和工具 schema，inactive tools 不注入，工具定义按需加载并稳定排序。

### 与当前压缩缺口的关系

这些机制中，最应与 context compression 同步推进的是：请求生命周期门禁、工具结果脱水、checkpoint/resume、结构化诊断、多级错误恢复、prompt cache baseline、状态 re-injection 和 Agent loop 熔断。它们共同决定长任务是否能在高 context 压力下稳定继续。

## 推荐实施顺序

1. `single-turn oversized payload guard`：先解决一次工具返回过大。
2. `request hard gate`：禁止超限模型请求继续发出。
3. `recent payload fallback`：解决近期消息必须保留但 payload 过大的情况。
4. `warning / pre-compress gate parity`：统一三端门禁、reason 和诊断。
5. `checkpoint scheduler`：在工具闭合和 step boundary 自动触发处理。
6. `assistant output finalize checkpoint`：避免非流式单次长回复撑爆后续请求。
7. `partial compact`：解决单个长任务内早期子步骤无法压缩。
8. 继续补 session memory、hooks、prompt cache、relink metadata、streaming continuation。

## 测试要求

每个实现项都必须按 TDD 执行：

1. 先写失败测试；
2. 确认失败原因对应目标缺口；
3. 最小实现；
4. 跑定向测试；
5. 跑 `npm run test:agent-context`；
6. 涉及 runtime 时跑两个诊断脚本；
7. 完成阶段跑 `npm run lint`、`npm run typecheck`、必要时跑 `npm run build` 和 `npm run dev` 冒烟。

建议新增测试覆盖：

- 单个 tool result 超过 single payload limit；
- tool result append 前被脱水；
- inputTokens 已超过 contextWindow 时阻断；
- inputTokens + reservedOutputTokens 超过 contextWindow 时先 compact 或降低输出预算；
- `insufficient_compressible_messages` 触发 recent payload fallback；
- warning、pre-compress、hard gate 在 renderer/main/sidecar 三端分类一致；
- 非流式 assistant 长输出在 finalize / append checkpoint 被截断、分段或阻断；
- 同一长任务内 partial compact 不破坏 tool 协议；
- 超长用户输入被文件化或分块处理；
- main/sidecar/renderer 三个 runtime 行为一致。

## 当前结论

下一步最值得优先实现的是：

```text
single-turn oversized payload guard
+ request hard gate
+ recent payload fallback
```

这三项可以直接覆盖当前暴露的问题：一次返回值过大、context 达到硬限制、近期任务必须保留导致普通 compact 无法摘要。