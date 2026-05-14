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

export interface FormatPostCompactStateContextArgs {
  title: string
  workingFolder?: string
  currentPlan?: PostCompactPlanSnapshot | null
  activeTasks?: PostCompactTaskSnapshot[]
  recentlyReadFiles?: PostCompactReadFileSnapshot[]
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp)
  return Number.isFinite(timestamp) && !Number.isNaN(date.getTime())
    ? date.toISOString()
    : 'invalid-timestamp'
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
      if (task.owner) lines.push(`  - Owner: ${task.owner}`)
      if (task.blockedBy && task.blockedBy.length > 0) {
        lines.push(`  - Blocked by: ${task.blockedBy.join(', ')}`)
      }
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
