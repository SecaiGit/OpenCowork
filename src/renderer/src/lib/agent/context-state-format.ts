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
  owner?: string | null
  blockedBy?: string[]
}

export interface PostCompactReadFileSnapshot {
  filePath: string
  timestamp: number
}

export interface PostCompactSkillSnapshot {
  name: string
}

export interface PostCompactAsyncAgentSnapshot {
  name: string
  status: string
  currentTask?: string
}

export interface PostCompactMcpServerSnapshot {
  name: string
  status: string
  toolCount?: number
}

export interface PostCompactMemoryCacheSnapshot {
  version?: number
  updatedAt?: number
  sources?: string[]
}

export interface PostCompactPromptCacheBaselineSnapshot {
  status: string
  reason?: string
}

export interface FormatPostCompactStateContextArgs {
  title: string
  workingFolder?: string
  currentPlan?: PostCompactPlanSnapshot | null
  activeTasks?: PostCompactTaskSnapshot[]
  recentlyReadFiles?: PostCompactReadFileSnapshot[]
  loadedSkills?: PostCompactSkillSnapshot[]
  asyncAgents?: PostCompactAsyncAgentSnapshot[]
  mcpServers?: PostCompactMcpServerSnapshot[]
  memoryCache?: PostCompactMemoryCacheSnapshot
  promptCacheBaseline?: PostCompactPromptCacheBaselineSnapshot
  safetyConstraints?: string[]
  verifiedCommands?: string[]
  failedCommands?: string[]
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp)
  return Number.isFinite(timestamp) && !Number.isNaN(date.getTime())
    ? date.toISOString()
    : 'invalid-timestamp'
}

function sanitizePostCompactText(value: string): string {
  return value
    .replace(/-----BEGIN[\s\S]*?-----END [A-Z ]+-----/g, '[REDACTED_SECRET]')
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[REDACTED_SECRET]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_SECRET]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED_SECRET]')
    .replace(
      /\b(authorization|x-api-key|api[_-]?key|access[_-]?token|id[_-]?token|session[_-]?token|auth[_-]?token|client[_-]?secret|password|cookie|set-cookie)\s*[:=]\s*[^\s;,)]+/gi,
      '$1=[REDACTED_SECRET]'
    )
    .replace(/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s;]+/g, '[USER_HOME]')
    .replace(/\/Users\/[^/\s;]+/g, '[USER_HOME]')
    .replace(/\/home\/[^/\s;]+/g, '[USER_HOME]')
}

function safeText(value: string): string {
  return sanitizePostCompactText(value)
}

function hasRuntimeReinjectionState(args: FormatPostCompactStateContextArgs): boolean {
  return Boolean(
    args.loadedSkills?.length ||
      args.asyncAgents?.length ||
      args.mcpServers?.length ||
      args.memoryCache ||
      args.promptCacheBaseline
  )
}

export function formatPostCompactStateContext(args: FormatPostCompactStateContextArgs): string {
  const lines: string[] = []
  lines.push(`## ${safeText(args.title)}`)

  if (args.workingFolder) {
    lines.push('', `Working folder: ${safeText(args.workingFolder)}`)
  }

  if (args.currentPlan) {
    lines.push('', '### Current plan')
    lines.push(`- Title: ${safeText(args.currentPlan.title)}`)
    lines.push(`- Status: ${safeText(args.currentPlan.status)}`)
    if (args.currentPlan.filePath) lines.push(`- File: ${safeText(args.currentPlan.filePath)}`)
  }

  if (args.activeTasks && args.activeTasks.length > 0) {
    lines.push('', '### Active tasks')
    for (const task of args.activeTasks) {
      lines.push(`- ${safeText(task.id)}: ${safeText(task.subject)} [${safeText(task.status)}]`)
      if (task.activeForm) lines.push(`  - Active: ${safeText(task.activeForm)}`)
      if (task.owner) lines.push(`  - Owner: ${safeText(task.owner)}`)
      if (task.blockedBy && task.blockedBy.length > 0) {
        lines.push(`  - Blocked by: ${task.blockedBy.map(safeText).join(', ')}`)
      }
    }
  }

  if (args.recentlyReadFiles && args.recentlyReadFiles.length > 0) {
    lines.push('', '### Recently read files')
    for (const file of args.recentlyReadFiles) {
      lines.push(`- ${safeText(file.filePath)} (${formatTimestamp(file.timestamp)})`)
    }
    lines.push('- Re-read specific files if exact content is needed after compaction.')
  }

  if (hasRuntimeReinjectionState(args)) {
    lines.push('', '### Runtime re-injection state')
    if (args.loadedSkills && args.loadedSkills.length > 0) {
      lines.push(`- Skills: ${args.loadedSkills.map((skill) => safeText(skill.name)).join(', ')}`)
    }
    if (args.asyncAgents && args.asyncAgents.length > 0) {
      lines.push(
        `- Async agents: ${args.asyncAgents
          .map((agent) =>
            agent.currentTask
              ? `${safeText(agent.name)} [${safeText(agent.status)}] - ${safeText(agent.currentTask)}`
              : `${safeText(agent.name)} [${safeText(agent.status)}]`
          )
          .join('; ')}`
      )
    }
    if (args.mcpServers && args.mcpServers.length > 0) {
      lines.push(
        `- MCP servers: ${args.mcpServers
          .map((server) => {
            const toolSuffix =
              typeof server.toolCount === 'number' ? `, tools: ${server.toolCount}` : ''
            return `${safeText(server.name)} [${safeText(server.status)}${toolSuffix}]`
          })
          .join('; ')}`
      )
    }
    if (args.memoryCache) {
      const version = args.memoryCache.version ?? 'unknown'
      const updatedAt =
        typeof args.memoryCache.updatedAt === 'number'
          ? formatTimestamp(args.memoryCache.updatedAt)
          : 'unknown'
      lines.push(`- Memory cache: version ${version}, updated ${updatedAt}`)
      if (args.memoryCache.sources && args.memoryCache.sources.length > 0) {
        lines.push(`- Memory sources: ${args.memoryCache.sources.map(safeText).join('; ')}`)
      }
    }
    if (args.promptCacheBaseline) {
      lines.push(
        `- Prompt cache baseline: ${safeText(args.promptCacheBaseline.status)}${
          args.promptCacheBaseline.reason ? ` - ${safeText(args.promptCacheBaseline.reason)}` : ''
        }`
      )
    }
  }

  if (args.safetyConstraints && args.safetyConstraints.length > 0) {
    lines.push('', '### Safety and continuity constraints')
    for (const constraint of args.safetyConstraints) {
      lines.push(`- ${safeText(constraint)}`)
    }
  }

  if (
    (args.verifiedCommands && args.verifiedCommands.length > 0) ||
    (args.failedCommands && args.failedCommands.length > 0)
  ) {
    lines.push('', '### Verification state')
    for (const command of args.verifiedCommands ?? []) {
      lines.push(`- Passed: ${safeText(command)}`)
    }
    for (const command of args.failedCommands ?? []) {
      lines.push(`- Failed then addressed: ${safeText(command)}`)
    }
  }

  lines.push('', '### Continuity note')
  lines.push('- Earlier tool payloads may have been dehydrated or summarized to protect context budget.')
  lines.push(
    '- UI-visible tool outputs are preserved separately where possible; model replay may contain compacted tool payloads.'
  )
  lines.push('- Use file paths, task IDs, and plan status above to continue work safely.')

  return lines.join('\n')
}
