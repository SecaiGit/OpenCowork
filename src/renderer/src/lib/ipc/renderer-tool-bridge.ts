import { toolRegistry } from '@renderer/lib/agent/tool-registry'
import type { ToolContext } from '@renderer/lib/tools/tool-types'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { getInlineToolHandler } from '@renderer/lib/ipc/inline-tool-handler-registry'
import {
  SUBMIT_REPORT_TOOL_NAME,
  submitReportForRun
} from '@renderer/lib/agent/sub-agents/submit-report-tool'

// Stage 1: the sidecar now dynamically bridges any unknown tool to the
// renderer via ToolRegistry.Execute's fallback. The authoritative list of
// bridgeable tools is whatever `toolRegistry` knows about — MCP tools,
// plugin/channel tools, WebFetch/WebSearch, etc. all participate without a
// static whitelist.

const RENDERER_TOOL_REQUEST_CHANNEL = 'sidecar:renderer-tool-request'
const APPROVAL_PROBE_SUFFIX = '#requiresApproval'

type RendererToolBridgeWindow = Window & {
  __openCoworkRendererToolBridgeCleanup?: () => void
}

function getBridgeWindow(): RendererToolBridgeWindow {
  return window as RendererToolBridgeWindow
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function toToolContext(record: Record<string, unknown>): ToolContext {
  const pluginChatTypeRaw =
    typeof record.pluginChatType === 'string' ? record.pluginChatType : undefined
  const pluginChatType =
    pluginChatTypeRaw === 'p2p' || pluginChatTypeRaw === 'group' ? pluginChatTypeRaw : undefined
  const agentRunId =
    typeof record.agentRunId === 'string'
      ? record.agentRunId
      : typeof record.runId === 'string'
        ? record.runId
        : undefined
  return {
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : undefined,
    workingFolder: typeof record.workingFolder === 'string' ? record.workingFolder : undefined,
    currentToolUseId:
      typeof record.currentToolUseId === 'string' ? record.currentToolUseId : undefined,
    agentRunId,
    pluginId: typeof record.pluginId === 'string' ? record.pluginId : undefined,
    pluginChatId: typeof record.pluginChatId === 'string' ? record.pluginChatId : undefined,
    pluginChatType,
    pluginSenderId: typeof record.pluginSenderId === 'string' ? record.pluginSenderId : undefined,
    pluginSenderName:
      typeof record.pluginSenderName === 'string' ? record.pluginSenderName : undefined,
    sshConnectionId:
      typeof record.sshConnectionId === 'string' ? record.sshConnectionId : undefined,
    signal: new AbortController().signal,
    ipc: ipcClient
  }
}

function normalizeResultContent(content: unknown): unknown {
  return content === undefined ? '' : content
}

function parseToolName(value: unknown): { toolName: string; isApprovalProbe: boolean } {
  const raw = String(value ?? '').trim()
  const isApprovalProbe = raw.endsWith(APPROVAL_PROBE_SUFFIX)
  const toolName = (isApprovalProbe ? raw.slice(0, -APPROVAL_PROBE_SUFFIX.length) : raw).trim()
  return { toolName, isApprovalProbe }
}

export function attachRendererToolBridge(): void {
  const bridgeWindow = getBridgeWindow()
  bridgeWindow.__openCoworkRendererToolBridgeCleanup?.()
  bridgeWindow.__openCoworkRendererToolBridgeCleanup = undefined
  window.electron.ipcRenderer.removeAllListeners(RENDERER_TOOL_REQUEST_CHANNEL)

  bridgeWindow.__openCoworkRendererToolBridgeCleanup = window.electron.ipcRenderer.on(
    RENDERER_TOOL_REQUEST_CHANNEL,
    async (_event: unknown, payload: { requestId: string; method: string; params: unknown }) => {
      if (payload?.method !== 'renderer/tool-request' || !payload.requestId) return

      try {
        const params = normalizeRecord(payload.params)
        const { toolName, isApprovalProbe } = parseToolName(params.toolName)

        const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined
        const agentRunId = typeof params.agentRunId === 'string' ? params.agentRunId : undefined
        const runId = typeof params.runId === 'string' ? params.runId : undefined
        const input = normalizeRecord(params.input)

        if (toolName === SUBMIT_REPORT_TOOL_NAME) {
          if (isApprovalProbe) {
            await window.electron.ipcRenderer.invoke('sidecar:renderer-tool-response', {
              requestId: payload.requestId,
              result: { requiresApproval: false }
            })
            return
          }

          const result = submitReportForRun(agentRunId ?? runId ?? sessionId, input)
          await window.electron.ipcRenderer.invoke('sidecar:renderer-tool-response', {
            requestId: payload.requestId,
            result: {
              content: result.success
                ? 'Report submitted. This sub-agent session will now terminate.'
                : (result.error ?? 'SubmitReport rejected: invalid report payload.'),
              isError: !result.success,
              ...(result.success
                ? {}
                : { error: result.error ?? 'SubmitReport rejected: invalid report payload.' })
            }
          })
          return
        }

        const handler =
          getInlineToolHandler(agentRunId, toolName) ??
          getInlineToolHandler(runId, toolName) ??
          getInlineToolHandler(sessionId, toolName) ??
          toolRegistry.get(toolName)
        if (!handler) {
          await window.electron.ipcRenderer.invoke('sidecar:renderer-tool-response', {
            requestId: payload.requestId,
            ...(isApprovalProbe
              ? { result: { requiresApproval: false } }
              : { error: `Tool handler not registered: ${toolName}` })
          })
          return
        }

        const ctx = toToolContext(params)

        if (isApprovalProbe) {
          const requiresApproval = handler.requiresApproval?.(input, ctx) ?? false
          await window.electron.ipcRenderer.invoke('sidecar:renderer-tool-response', {
            requestId: payload.requestId,
            result: { requiresApproval }
          })
          return
        }

        const result = await handler.execute(input, ctx)
        const structuredResult =
          typeof result === 'string' || Array.isArray(result)
            ? { content: normalizeResultContent(result), isError: false }
            : normalizeRecord(result)
        await window.electron.ipcRenderer.invoke('sidecar:renderer-tool-response', {
          requestId: payload.requestId,
          result: {
            content: normalizeResultContent(structuredResult.content),
            isError: structuredResult.isError === true,
            ...(typeof structuredResult.error === 'string' ? { error: structuredResult.error } : {})
          }
        })
      } catch (error) {
        await window.electron.ipcRenderer.invoke('sidecar:renderer-tool-response', {
          requestId: payload.requestId,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  )
}
