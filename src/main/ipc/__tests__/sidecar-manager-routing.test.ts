import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStreamEnvelope } from '../../../shared/agent-stream-protocol'
import { AGENT_STREAM_PROTOCOL_VERSION } from '../../../shared/agent-stream-protocol'

const mocks = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => unknown
  type TestWindow = {
    id: number
    webContents: {
      isDestroyed: () => boolean
      isCrashed: () => boolean
    }
    isDestroyed: () => boolean
  }

  const handlers = new Map<string, Handler>()
  const listeners = new Map<string, Handler>()
  const windows = new Map<number, TestWindow>()
  const sent: Array<{ windowId: number; channel: string; payload: unknown }> = []
  const managerState: {
    eventHandler?: (envelope: AgentStreamEnvelope) => void
  } = {}

  const manager = {
    setEventHandler: vi.fn((handler: (envelope: AgentStreamEnvelope) => void) => {
      managerState.eventHandler = handler
    }),
    setRequestHandler: vi.fn(),
    setSessionVisibility: vi.fn(),
    start: vi.fn(async () => true),
    ensureStarted: vi.fn(async () => true),
    stop: vi.fn(async () => {}),
    request: vi.fn(async (method: string) => {
      if (method === 'agent/run') return { started: true, runId: 'sidecar-run-1' }
      return null
    }),
    notify: vi.fn(),
    isRunning: true
  }

  return {
    handlers,
    listeners,
    windows,
    sent,
    manager,
    managerState,
    ipcMain: {
      handle: vi.fn((channel: string, handler: Handler) => {
        handlers.set(channel, handler)
      }),
      on: vi.fn((channel: string, handler: Handler) => {
        listeners.set(channel, handler)
      })
    },
    BrowserWindow: {
      fromWebContents: vi.fn((webContents: { __windowId?: number }) =>
        typeof webContents?.__windowId === 'number'
          ? (windows.get(webContents.__windowId) ?? null)
          : null
      ),
      fromId: vi.fn((id: number) => windows.get(id) ?? null),
      getFocusedWindow: vi.fn(() => null),
      getAllWindows: vi.fn(() => [])
    },
    safeSendToWindow: vi.fn((window: TestWindow, channel: string, payload: unknown) => {
      sent.push({ windowId: window.id, channel, payload })
      return true
    }),
    makeWindow: (id: number): TestWindow => ({
      id,
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        isCrashed: () => false
      }
    })
  }
})

vi.mock('electron', () => ({
  ipcMain: mocks.ipcMain,
  BrowserWindow: mocks.BrowserWindow
}))

vi.mock('../../window-ipc', () => ({
  safeSendToWindow: mocks.safeSendToWindow
}))

vi.mock('../js-agent-runtime', () => ({
  JsAgentRuntimeManager: vi.fn(() => mocks.manager)
}))

vi.mock('../desktop-control', () => ({
  DESKTOP_INPUT_CLICK: 'desktop:input:click',
  DESKTOP_INPUT_SCROLL: 'desktop:input:scroll',
  DESKTOP_INPUT_TYPE: 'desktop:input:type',
  DESKTOP_SCREENSHOT_CAPTURE: 'desktop:screenshot:capture',
  captureDesktopScreenshot: vi.fn(async () => ({ ok: true })),
  desktopInputClick: vi.fn(),
  desktopInputScroll: vi.fn(),
  desktopInputType: vi.fn(),
  isDesktopInputAvailable: vi.fn(() => true)
}))

vi.mock('../agents-handlers', () => ({
  listAgents: vi.fn(() => [])
}))

vi.mock('../agent-change-handlers', () => ({
  recordLocalTextWriteChange: vi.fn()
}))

vi.mock('../../cron/cron-agent-background', () => ({
  compressMessagesForContext: vi.fn()
}))

function envelope(
  runId: string,
  seq: number,
  events: AgentStreamEnvelope['events'],
  sessionId = ''
): AgentStreamEnvelope {
  return {
    v: AGENT_STREAM_PROTOCOL_VERSION,
    runId,
    sessionId,
    seq,
    events
  }
}

describe('sidecar manager stream routing', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.handlers.clear()
    mocks.listeners.clear()
    mocks.windows.clear()
    mocks.sent.length = 0
    mocks.managerState.eventHandler = undefined
    vi.clearAllMocks()
    mocks.windows.set(1, mocks.makeWindow(1))
  })

  it('keeps the run route after error so a following loop_end without sessionId reaches the original renderer', async () => {
    const { registerSidecarHandlers } = await import('../sidecar-manager')
    registerSidecarHandlers()

    const runHandler = mocks.handlers.get('agent:run')
    expect(runHandler).toBeDefined()
    await runHandler?.({ sender: { __windowId: 1 } }, { runId: 'requested-run-1' })

    expect(mocks.managerState.eventHandler).toBeDefined()
    mocks.managerState.eventHandler?.(
      envelope('sidecar-run-1', 0, [
        {
          type: 'error',
          message: 'context gate blocked model request',
          errorType: 'hard_context_limit_exceeded'
        }
      ])
    )
    mocks.managerState.eventHandler?.(
      envelope('sidecar-run-1', 1, [
        {
          type: 'loop_end',
          reason: 'error',
          messages: [{ id: 'm-final', role: 'user', content: 'final transcript', createdAt: 1 }]
        }
      ])
    )

    expect(mocks.safeSendToWindow).toHaveBeenCalledTimes(2)
    expect(mocks.sent.map((item) => item.payload)).toEqual([
      expect.objectContaining({ seq: 0 }),
      expect.objectContaining({ seq: 1 })
    ])
  })
})
