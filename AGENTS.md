# 仓库指南

## 项目结构与模块组织

- `src/main/` 是 Electron 主进程，负责应用生命周期、窗口、IPC、SQLite、定时任务、插件、MCP、SSH、更新与崩溃处理。
- `src/preload/` 只通过 `contextBridge` 暴露安全 API，不放业务逻辑。
- `src/renderer/src/` 是 React 19 渲染端，包含 `components/`、`stores/`、`hooks/`、`lib/`、`locales/` 与 `assets/`。
- `src/shared/` 存放跨进程 TypeScript 类型与常量。
- Agent 运行时代码位于 `src/main/ipc/` 与 `src/main/cron/`；运行时资源位于 `resources/agents`、`resources/skills`、`resources/prompts`、`resources/commands`。
- `docs/` 存放文档站点。不要编辑 `dist/`、`out/`、`build/` 或 `node_modules/`。

## 构建、测试与开发命令

- `npm install` 安装依赖并执行 postinstall。
- `npm run dev` 本地启动 Electron 与 Vite。
- `npm run start` 预览已打包输出。
- `npm run lint` 使用 ESLint 缓存检查代码。
- `npm run typecheck` 校验 Node 与渲染端 TypeScript 项目。
- `npm run format` 使用 Prettier 格式化代码。
- `npm run build` 先类型检查，再构建主进程与渲染端产物。
- `npm run build:unpack` 校验本地解包包；平台包使用 `build:win`、`build:mac` 或 `build:linux`。

## 编码风格与命名约定

使用 UTF-8（无 BOM）、LF、2 空格缩进、单引号、无分号、无尾随逗号，行宽 100。TypeScript 开启严格模式。React 组件使用 PascalCase，例如 `Layout.tsx`；非组件模块使用 kebab-case，例如 `settings-store.ts`。渲染端导入可使用 `@renderer/*`。注释只解释意图、约束、边界或非显而易见的异步/状态行为，避免复述代码。

## 文档规范

所有仓库文档默认使用中文。新增或修改文档时保持既定格式、标题层级、章节顺序和列表风格；确需调整格式时，先说明原因并取得确认。

## 测试指南

当前没有独立自动化测试套件。代码变更后运行 `npm run lint` 与 `npm run typecheck`。涉及 IPC、主进程、定时任务、插件或渲染端交互时，还需运行 `npm run dev` 做冒烟验证。打包相关变更在发布前运行对应 `build:*` 命令。

## 提交与拉取请求规范

提交历史同时包含 Conventional Commit（如 `fix(app): load nested skills`）与简洁中文摘要。优先使用 `type(scope): summary`，例如 `feat(main): add cron validation`；版本变更使用 `chore` 或 `release`。PR 需包含范围、验证步骤、已运行命令、关联 issue，UI 变更需附截图或录屏。

## 安全与配置提示

不要提交密钥、私钥、`.env`、本地运行数据或下载缓存。敏感值通过配置或参数传递。发布前检查打包配置与运行时资源是否完整。
