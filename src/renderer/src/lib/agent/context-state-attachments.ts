import i18n from '@renderer/locales'
import { usePlanStore } from '@renderer/stores/plan-store'
import { useTaskStore } from '@renderer/stores/task-store'
import {
  formatPostCompactStateContext,
  type PostCompactReadFileSnapshot,
  type PostCompactTaskSnapshot
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

function collectActiveTasks(sessionId: string | undefined, maxTasks = 12): PostCompactTaskSnapshot[] {
  if (!sessionId) return []
  return useTaskStore
    .getState()
    .getTasksBySession(sessionId)
    .filter((task) => task.status !== 'completed')
    .slice(0, maxTasks)
    .map((task) => ({
      id: task.id,
      subject: task.subject,
      status: task.status,
      ...(task.activeForm ? { activeForm: task.activeForm } : {}),
      ...(task.owner ? { owner: task.owner } : {}),
      ...(task.blockedBy.length > 0 ? { blockedBy: task.blockedBy } : {})
    }))
}

export function buildPostCompactStateContext(args: BuildPostCompactStateContextArgs): string {
  const plan = args.sessionId ? usePlanStore.getState().getPlanBySession(args.sessionId) : null

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
    activeTasks: collectActiveTasks(args.sessionId, args.maxTasks),
    recentlyReadFiles: collectReadFiles(args.readFileHistory, args.maxReadFiles)
  })
}
