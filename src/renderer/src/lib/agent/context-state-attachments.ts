import i18n from '@renderer/locales'
import { usePlanStore } from '@renderer/stores/plan-store'
import { useTaskStore } from '@renderer/stores/task-store'
import { useMcpStore } from '@renderer/stores/mcp-store'
import { useTeamStore } from '@renderer/stores/team-store'
import { getRegisteredSkills } from '../tools/skill-tool'
import { getLayeredMemorySnapshot } from './memory-files'
import {
  formatPostCompactStateContext,
  type PostCompactAsyncAgentSnapshot,
  type PostCompactMcpServerSnapshot,
  type PostCompactMemoryCacheSnapshot,
  type PostCompactReadFileSnapshot,
  type PostCompactSkillSnapshot,
  type PostCompactTaskSnapshot
} from './context-state-format'

export interface BuildPostCompactStateContextArgs {
  sessionId?: string
  workingFolder?: string
  readFileHistory?: Map<string, number>
  maxReadFiles?: number
  maxTasks?: number
  maxSkills?: number
  maxAsyncAgents?: number
  maxMcpServers?: number
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
      ...(Array.isArray(task.blockedBy) && task.blockedBy.length > 0
        ? { blockedBy: task.blockedBy }
        : {})
    }))
}

function collectLoadedSkills(maxSkills = 12): PostCompactSkillSnapshot[] {
  return getRegisteredSkills()
    .slice(0, maxSkills)
    .map((skill) => ({ name: skill.name }))
}

function collectAsyncAgents(
  sessionId: string | undefined,
  maxAsyncAgents = 8
): PostCompactAsyncAgentSnapshot[] {
  const activeTeam = useTeamStore.getState().activeTeam
  if (!activeTeam) return []
  if (sessionId && activeTeam.sessionId && activeTeam.sessionId !== sessionId) return []

  const taskSubjectById = new Map(activeTeam.tasks.map((task) => [task.id, task.subject]))
  return activeTeam.members.slice(0, maxAsyncAgents).map((member) => {
    const currentTask = member.currentTaskId
      ? taskSubjectById.get(member.currentTaskId) ?? member.currentTaskId
      : undefined
    return {
      name: member.name,
      status: member.status,
      ...(currentTask ? { currentTask } : {})
    }
  })
}

function collectMcpServers(maxMcpServers = 8): PostCompactMcpServerSnapshot[] {
  const mcpStore = useMcpStore.getState()
  return mcpStore
    .getActiveMcps()
    .slice(0, maxMcpServers)
    .map((server) => ({
      name: server.name,
      status: mcpStore.serverStatuses[server.id] ?? 'disconnected',
      toolCount: mcpStore.serverTools[server.id]?.length ?? 0
    }))
}

function collectMemoryCache(): PostCompactMemoryCacheSnapshot | undefined {
  const snapshot = getLayeredMemorySnapshot()
  const sources = [
    snapshot.agents?.path,
    snapshot.globalMemory?.path,
    snapshot.projectMemory?.path,
    ...snapshot.globalDailyMemory.map((entry) => entry.path),
    ...snapshot.projectDailyMemory.map((entry) => entry.path)
  ].filter((path): path is string => !!path?.trim())

  if (snapshot.version === 0 && sources.length === 0 && typeof snapshot.updatedAt !== 'number') {
    return undefined
  }

  return {
    version: snapshot.version,
    ...(typeof snapshot.updatedAt === 'number' ? { updatedAt: snapshot.updatedAt } : {}),
    ...(sources.length > 0 ? { sources } : {})
  }
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
    recentlyReadFiles: collectReadFiles(args.readFileHistory, args.maxReadFiles),
    loadedSkills: collectLoadedSkills(args.maxSkills),
    asyncAgents: collectAsyncAgents(args.sessionId, args.maxAsyncAgents),
    mcpServers: collectMcpServers(args.maxMcpServers),
    memoryCache: collectMemoryCache(),
    promptCacheBaseline: {
      status: 'reset_after_compact',
      reason: 'compact boundary changed replay baseline'
    },
    safetyConstraints: [
      'Use TDD for behavior changes when the user requested TDD.',
      'Do not store secrets, raw credentials, private keys, cookies, or session tokens in compact summaries.',
      'Continue the original task from the summary and preserved messages unless a real user decision is required.'
    ]
  })
}
