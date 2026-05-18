import type { AgentStreamEvent } from '../../../../shared/agent-stream-protocol'
import type { AgentEvent } from './types'
import { agentBridge } from '@renderer/lib/ipc/agent-bridge'
import { agentStream } from '@renderer/lib/ipc/agent-stream-receiver'
import { toAgentEvent, toSubAgentEvent } from './stream-event-adapter'
import { subAgentEvents } from '@renderer/lib/agent/sub-agents/events'

export const SIDECAR_FIRST_PROGRESS_TIMEOUT_MS = 45_000
export const SIDECAR_ERROR_LOOP_END_TIMEOUT_MS = 5_000

export interface CreateSidecarEventStreamOptions {
  sessionId: string
  sidecarRequest: unknown
  signal?: AbortSignal
  logLabel?: 'chat' | 'agent'
  firstProgressTimeoutMs?: number
  errorLoopEndTimeoutMs?: number
  onRunStarted?: (runId: string) => void
  onRunFinished?: (runId: string) => void
}

function isProgressAgentEvent(event: AgentEvent): boolean {
  return event.type !== 'request_debug'
}

export function createSidecarEventStream(
  options: CreateSidecarEventStreamOptions
): AsyncIterable<AgentEvent> {
  const {
    sessionId,
    sidecarRequest,
    signal,
    logLabel,
    firstProgressTimeoutMs = SIDECAR_FIRST_PROGRESS_TIMEOUT_MS,
    errorLoopEndTimeoutMs = SIDECAR_ERROR_LOOP_END_TIMEOUT_MS,
    onRunStarted,
    onRunFinished
  } = options

  return {
    async *[Symbol.asyncIterator]() {
      const queue: AgentEvent[] = []
      const pendingEvents: Array<{ runId: string; event: AgentStreamEvent }> = []
      let finished = false
      let runFinishedNotified = false
      let pendingFailure: Error | null = null
      let notify: (() => void) | null = null
      let runId = ''
      let sawProgressEvent = false
      let firstProgressTimer: ReturnType<typeof setTimeout> | null = null
      let errorFinishTimer: ReturnType<typeof setTimeout> | null = null

      const wake = (): void => {
        if (!notify) return
        const resolver = notify
        notify = null
        resolver()
      }

      const clearFirstProgressTimer = (): void => {
        if (!firstProgressTimer) return
        clearTimeout(firstProgressTimer)
        firstProgressTimer = null
      }

      const clearErrorFinishTimer = (): void => {
        if (!errorFinishTimer) return
        clearTimeout(errorFinishTimer)
        errorFinishTimer = null
      }

      const notifyRunFinished = (): void => {
        if (!runId || runFinishedNotified) return
        runFinishedNotified = true
        onRunFinished?.(runId)
      }

      const finish = (): void => {
        if (finished) return
        finished = true
        clearErrorFinishTimer()
        notifyRunFinished()
        wake()
      }

      const fail = (error: Error): void => {
        pendingFailure = error
        finish()
      }

      const markProgress = (): void => {
        if (sawProgressEvent) return
        sawProgressEvent = true
        clearFirstProgressTimer()
      }

      const startFirstProgressTimer = (): void => {
        clearFirstProgressTimer()
        firstProgressTimer = setTimeout(() => {
          const error = new Error(
            `Sidecar run started but produced no progress within ${Math.round(
              firstProgressTimeoutMs / 1000
            )}s`
          )
          console.warn('[ChatActions] Sidecar run stalled before first progress event', {
            sessionId,
            runId,
            logLabel
          })
          if (runId) {
            void agentBridge.cancelAgent(runId).catch(() => {})
          }
          fail(error)
        }, firstProgressTimeoutMs)
      }

      const waitForLoopEndAfterError = (): void => {
        clearErrorFinishTimer()
        errorFinishTimer = setTimeout(() => {
          errorFinishTimer = null
          finish()
        }, errorLoopEndTimeoutMs)
      }

      const pushEvent = (normalized: AgentEvent): void => {
        if (finished || pendingFailure) return
        if (isProgressAgentEvent(normalized)) {
          markProgress()
        }
        queue.push(normalized)
        if (normalized.type === 'loop_end') {
          finish()
        } else if (normalized.type === 'error') {
          waitForLoopEndAfterError()
        }
        wake()
      }

      const dispatchStreamEvent = (event: AgentStreamEvent): void => {
        if (finished || pendingFailure) return
        const subEvent = toSubAgentEvent(event)
        if (subEvent) {
          markProgress()
          subAgentEvents.emit(sessionId ?? null, subEvent)
          return
        }

        const agentEvent = toAgentEvent(event)
        if (agentEvent) {
          pushEvent(agentEvent)
        }
      }

      const onAbort = (): void => {
        clearFirstProgressTimer()
        finish()
      }

      signal?.addEventListener('abort', onAbort, { once: true })

      const unsub = agentStream.subscribeAll((eventRunId, _sessionId, event) => {
        if (finished || pendingFailure) return

        if (!runId) {
          pendingEvents.push({ runId: eventRunId, event })
          return
        }

        if (eventRunId && eventRunId !== runId) return
        dispatchStreamEvent(event)
      })

      try {
        const result = await agentBridge.runAgent(sidecarRequest)
        runId = result.runId
        onRunStarted?.(runId)
        if (logLabel) {
          console.log(`[ChatActions] sidecar ${logLabel} stream started`, { sessionId, runId })
        }

        if (signal?.aborted) {
          void agentBridge.cancelAgent(runId).catch(() => {})
          finish()
        } else {
          startFirstProgressTimer()
        }

        const pendingSnapshot = pendingEvents.splice(0, pendingEvents.length)
        for (const pending of pendingSnapshot) {
          if (pending.runId && pending.runId !== runId) continue
          dispatchStreamEvent(pending.event)
        }

        while (!finished || queue.length > 0) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              notify = resolve
              if (finished || queue.length > 0) {
                wake()
              }
            })
            continue
          }
          const next = queue.shift()
          if (next) yield next
        }

        if (pendingFailure) {
          throw pendingFailure
        }
      } finally {
        clearFirstProgressTimer()
        clearErrorFinishTimer()
        signal?.removeEventListener('abort', onAbort)
        unsub()
        notifyRunFinished()
      }
    }
  }
}
