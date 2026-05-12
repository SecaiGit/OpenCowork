import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  FileCode,
  Loader2,
  RefreshCw,
  RotateCcw,
  X,
  XCircle
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { MONO_FONT } from '@renderer/lib/constants'
import { cn } from '@renderer/lib/utils'
import { useAgentStore, type AgentRunFileChange } from '@renderer/stores/agent-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'
import type { ToolUseBlock, UnifiedMessage } from '@renderer/lib/api/types'
import { decodeStructuredToolResult } from '@renderer/lib/tools/tool-result-format'
import { CodeDiffViewer } from '@renderer/components/chat/CodeDiffViewer'
import {
  type LoadedChangeContent,
  type DiffSummaryStats,
  isLoadedChangeContent,
  loadAggregatedChangeContent,
  useAggregatedChangeSummaries
} from '@renderer/components/chat/change-summary-utils'
import {
  actionableSourceChanges,
  aggregateDisplayableRunFileChanges,
  buildDiffCopyText,
  canRenderInlineSnapshot,
  computeDiff,
  detectLang,
  fileName,
  foldContext,
  lineCount,
  matchesAggregatedChangeId,
  snapshotText,
  type AggregatedFileChange
} from '@renderer/components/chat/file-change-utils'

interface SessionChangeReviewPanelProps {
  initialChangeId?: string | null
}

const EMPTY_SESSION_MESSAGES: UnifiedMessage[] = []
const SYNTHETIC_CHANGE_PREFIX = 'message-tool-change:'

function getMessageToolUseIds(message: UnifiedMessage): string[] {
  if (!Array.isArray(message.content)) return []
  return message.content
    .filter((block): block is Extract<(typeof message.content)[number], { type: 'tool_use' }> => {
      return !!block && typeof block === 'object' && block.type === 'tool_use'
    })
    .map((block) => block.id)
    .filter(Boolean)
}

function getMessageToolResultMap(
  messages: UnifiedMessage[]
): Map<string, { isError?: boolean; content?: unknown }> {
  const results = new Map<string, { isError?: boolean; content?: unknown }>()
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (!block || typeof block !== 'object' || block.type !== 'tool_result') continue
      results.set(block.toolUseId, {
        isError: block.isError,
        content: block.content
      })
    }
  }
  return results
}

function getToolFilePath(block: ToolUseBlock): string {
  const value = block.input.file_path ?? block.input.path
  return typeof value === 'string' ? value.trim() : ''
}

function parseToolResult(content: unknown): Record<string, unknown> | null {
  if (typeof content !== 'string') return null
  const parsed = decodeStructuredToolResult(content)
  return parsed && !Array.isArray(parsed) ? parsed : null
}

function buildSnapshot(text: string, exists = true): AgentRunFileChange['after'] {
  const size = new TextEncoder().encode(text).length
  return {
    exists,
    text,
    hash: null,
    size,
    lineCount: lineCount(text)
  }
}

function buildSyntheticMessageToolChanges(
  messages: UnifiedMessage[],
  sessionId: string
): AgentRunFileChange[] {
  const resultsByToolUseId = getMessageToolResultMap(messages)
  const changes: AgentRunFileChange[] = []

  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue

    for (const block of message.content) {
      if (!block || typeof block !== 'object' || block.type !== 'tool_use') continue
      if (block.name !== 'Edit' && block.name !== 'Write') continue

      const filePath = getToolFilePath(block)
      if (!filePath) continue

      const result = resultsByToolUseId.get(block.id)
      const parsedResult = parseToolResult(result?.content)
      if (result?.isError || typeof parsedResult?.error === 'string') continue

      const createdAt = message.createdAt ?? Date.now()
      const id = `${SYNTHETIC_CHANGE_PREFIX}${message.id}:${block.id}`
      const baseChange = {
        id,
        runId: id,
        sessionId,
        toolUseId: block.id,
        toolName: block.name,
        filePath,
        transport: 'local' as const,
        status: 'accepted' as const,
        createdAt
      }

      if (block.name === 'Edit') {
        const beforeText =
          typeof block.input.old_string === 'string'
            ? block.input.old_string
            : typeof block.input.old_string_preview === 'string'
              ? block.input.old_string_preview
              : ''
        const afterText =
          typeof block.input.new_string === 'string'
            ? block.input.new_string
            : typeof block.input.new_string_preview === 'string'
              ? block.input.new_string_preview
              : ''

        if (!beforeText && !afterText) continue

        changes.push({
          ...baseChange,
          op: 'modify',
          before: buildSnapshot(beforeText),
          after: buildSnapshot(afterText)
        })
        continue
      }

      const afterText =
        typeof block.input.content === 'string'
          ? block.input.content
          : typeof block.input.content_preview === 'string'
            ? block.input.content_preview
            : ''
      const op = parsedResult?.op === 'modify' ? 'modify' : 'create'
      changes.push({
        ...baseChange,
        op,
        before: buildSnapshot('', op === 'modify'),
        after: buildSnapshot(afterText)
      })
    }
  }

  return changes
}

function changeGroupKey(
  change: Pick<AggregatedFileChange, 'filePath' | 'transport' | 'connectionId'>
): string {
  return [change.transport, change.connectionId ?? '', change.filePath].join('\u0000')
}

function isSyntheticChange(change: AggregatedFileChange): boolean {
  return change.sourceChanges.every((entry) => entry.id.startsWith(SYNTHETIC_CHANGE_PREFIX))
}

function isErrorResult(value: unknown): value is { error: string } {
  return !!value && typeof value === 'object' && 'error' in value && typeof value.error === 'string'
}

function statusLabelKey(
  change: AggregatedFileChange
):
  | 'fileChange.status.accepted'
  | 'fileChange.status.reverted'
  | 'fileChange.status.conflict'
  | 'fileChange.status.pending' {
  if (change.status === 'accepted') return 'fileChange.status.accepted'
  if (change.status === 'reverted') return 'fileChange.status.reverted'
  if (change.status === 'conflicted') return 'fileChange.status.conflict'
  return 'fileChange.status.pending'
}

function statusTone(change: AggregatedFileChange): string {
  if (change.status === 'accepted') return 'text-emerald-600 dark:text-emerald-300'
  if (change.status === 'reverted') return 'text-muted-foreground dark:text-zinc-300'
  if (change.status === 'conflicted') return 'text-amber-600 dark:text-amber-300'
  return 'text-sky-600 dark:text-sky-300'
}

function actionLabel(change: AggregatedFileChange): string {
  return change.op === 'create' ? 'fileChange.new' : 'fileChange.edited'
}

function CopyIconButton({ text }: { text: string }): React.JSX.Element {
  const { t } = useTranslation('common')
  const [copied, setCopied] = React.useState(false)

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
      onClick={() => {
        void navigator.clipboard.writeText(text)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      }}
      title={t('action.copy')}
      aria-label={t('action.copy')}
    >
      {copied ? <Check className="size-3 text-emerald-400" /> : <Copy className="size-3" />}
    </Button>
  )
}

function ReviewEmptyState(): React.JSX.Element {
  const { t } = useTranslation('layout')
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <div className="grid size-16 place-items-center rounded-2xl border border-border/60 bg-muted/20">
        <FileCode className="size-7 text-muted-foreground/50" />
      </div>
      <div>
        <p className="text-sm font-medium text-foreground">
          {t('rightPanel.reviewEmptyTitle', { defaultValue: 'No file changes yet' })}
        </p>
        <p className="mt-1 max-w-[280px] text-xs leading-5 text-muted-foreground">
          {t('rightPanel.reviewEmptyDesc', {
            defaultValue:
              'Latest diffs are unavailable. File changes for this session will appear here.'
          })}
        </p>
      </div>
    </div>
  )
}

function ChangeDetail({ change }: { change: AggregatedFileChange }): React.JSX.Element {
  const { t } = useTranslation('chat')
  const [loadedContent, setLoadedContent] = React.useState<LoadedChangeContent | null>(null)
  const [isLoading, setIsLoading] = React.useState(false)
  const [loadError, setLoadError] = React.useState<string | null>(null)

  const shouldLoadFullContent =
    change.op === 'create'
      ? !canRenderInlineSnapshot(change.after)
      : !canRenderInlineSnapshot(change.before) || !canRenderInlineSnapshot(change.after)

  React.useEffect(() => {
    if (!shouldLoadFullContent) {
      setLoadedContent(null)
      setLoadError(null)
      setIsLoading(false)
      return
    }

    let cancelled = false
    const load = async (): Promise<void> => {
      setIsLoading(true)
      setLoadError(null)
      try {
        const result = await loadAggregatedChangeContent(change)
        if (cancelled) return

        if (isLoadedChangeContent(result)) {
          setLoadedContent(result)
          return
        }

        setLoadError(
          isErrorResult(result)
            ? result.error
            : t('fileChange.loadDiffFailed', { defaultValue: 'Failed to load the full diff' })
        )
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error))
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [change, shouldLoadFullContent, t])

  const beforeText =
    loadedContent?.beforeText ?? (change.op === 'modify' ? snapshotText(change.before) : '')
  const afterText = loadedContent?.afterText ?? snapshotText(change.after)
  const diffLines = React.useMemo(() => computeDiff(beforeText, afterText), [afterText, beforeText])
  const diffChunks = React.useMemo(() => foldContext(diffLines), [diffLines])
  const diffCopyText = React.useMemo(() => buildDiffCopyText(diffLines), [diffLines])

  if (isLoading && !loadedContent && shouldLoadFullContent) {
    return (
      <div className="flex h-48 items-center justify-center rounded-lg border border-border/60 bg-muted/15 text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin text-emerald-400" />
        {t('thinking.thinkingEllipsis')}
      </div>
    )
  }

  if (loadError && !loadedContent && shouldLoadFullContent) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-4 text-sm text-destructive">
        {loadError}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span className="text-emerald-600 dark:text-emerald-300">
          {detectLang(change.filePath)}
        </span>
        <span>{t('fileChange.lineCount', { count: lineCount(afterText) })}</span>
        {diffCopyText ? <CopyIconButton text={diffCopyText} /> : null}
      </div>
      <CodeDiffViewer chunks={diffChunks} defaultMode="inline" showModeToggle toolbarEnd={null} />
    </div>
  )
}

function ChangeRow({
  change,
  summary,
  expanded,
  onToggle
}: {
  change: AggregatedFileChange
  summary: DiffSummaryStats
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  const { t } = useTranslation(['chat', 'common'])
  const acceptFileChange = useAgentStore((state) => state.acceptFileChange)
  const rollbackFileChange = useAgentStore((state) => state.rollbackFileChange)
  const [isAccepting, setIsAccepting] = React.useState(false)
  const [isRollingBack, setIsRollingBack] = React.useState(false)
  const actionableChanges = React.useMemo(() => actionableSourceChanges(change), [change])
  const actionable = actionableChanges.length > 0
  const previewOnly = isSyntheticChange(change)

  const handleAccept = async (): Promise<void> => {
    if (!actionable) return
    setIsAccepting(true)
    try {
      for (const entry of actionableChanges) {
        await acceptFileChange(entry.runId, entry.id)
      }
    } finally {
      setIsAccepting(false)
    }
  }

  const handleRollback = async (): Promise<void> => {
    if (!actionable) return
    setIsRollingBack(true)
    try {
      for (const entry of [...actionableChanges].sort((a, b) => b.createdAt - a.createdAt)) {
        await rollbackFileChange(entry.runId, entry.id)
      }
    } finally {
      setIsRollingBack(false)
    }
  }

  return (
    <div
      className={cn(
        'overflow-hidden border-b border-border/50 transition-colors last:border-b-0',
        expanded ? 'bg-muted/30' : 'hover:bg-muted/20'
      )}
    >
      <div className="flex items-start gap-1.5 px-3 py-2.5">
        <button
          type="button"
          className="min-w-0 flex flex-1 items-start gap-2.5 text-left"
          onClick={onToggle}
          title={change.filePath}
          aria-expanded={expanded}
        >
          <ChevronDown
            className={cn(
              'mt-0.5 size-3.5 shrink-0 transition-transform duration-200',
              expanded ? 'rotate-180 text-foreground' : 'text-muted-foreground'
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
              <span className="text-[10px] font-medium text-muted-foreground">
                {t(actionLabel(change))}
              </span>
              <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">
                {fileName(change.filePath)}
              </span>
              <span className="shrink-0 text-[10px] font-semibold text-emerald-600 dark:text-emerald-300">
                +{summary.added}
              </span>
              <span className="shrink-0 text-[10px] font-semibold text-red-600 dark:text-red-300">
                -{summary.deleted}
              </span>
            </div>
            <div
              className="mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap text-[10px] text-muted-foreground"
              style={{ fontFamily: MONO_FONT }}
            >
              {change.filePath}
            </div>
          </div>
        </button>

        {actionable ? (
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => void handleRollback()}
              disabled={isAccepting || isRollingBack}
              title={t('action.undo', { ns: 'common' })}
              aria-label={t('action.undo', { ns: 'common' })}
            >
              {isRollingBack ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <X className="size-3" />
              )}
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="rounded-full text-emerald-600 hover:bg-muted hover:text-emerald-700 dark:text-emerald-300"
              onClick={() => void handleAccept()}
              disabled={isAccepting || isRollingBack}
              title={t('action.allow', { ns: 'common' })}
              aria-label={t('action.allow', { ns: 'common' })}
            >
              {isAccepting ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Check className="size-3" />
              )}
            </Button>
          </div>
        ) : previewOnly ? (
          <FileCode className="mt-1 size-4 shrink-0 text-muted-foreground" />
        ) : change.status === 'accepted' ? (
          <CheckCircle2 className="mt-1 size-4 shrink-0 text-emerald-400" />
        ) : change.status === 'reverted' ? (
          <RotateCcw className="mt-1 size-4 shrink-0 text-muted-foreground" />
        ) : (
          <XCircle className="mt-1 size-4 shrink-0 text-amber-400" />
        )}
      </div>

      {expanded ? (
        <div className="border-t border-border/50 px-4 pb-4 pt-3">
          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px]">
            <span className={cn(previewOnly ? 'text-muted-foreground' : statusTone(change))}>
              {previewOnly
                ? t('rightPanel.reviewPreviewOnly', {
                    ns: 'layout',
                    defaultValue: 'Preview only'
                  })
                : t(statusLabelKey(change))}
            </span>
            <span className="text-muted-foreground">
              {t(`fileChange.transport.${change.transport}`)}
            </span>
          </div>
          <ChangeDetail change={change} />
        </div>
      ) : null}
    </div>
  )
}

export function SessionChangeReviewPanel({
  initialChangeId = null
}: SessionChangeReviewPanelProps): React.JSX.Element {
  const { t } = useTranslation(['layout', 'chat', 'common'])
  const activeScopedSessionId = useUIStore((state) => state.activeScopedSessionId)
  const chatActiveSessionId = useChatStore((state) => state.activeSessionId)
  const activeSessionId = activeScopedSessionId ?? chatActiveSessionId
  const sessionMessages = useChatStore((state) => {
    if (!activeSessionId) return EMPTY_SESSION_MESSAGES
    return (
      state.sessions.find((session) => session.id === activeSessionId)?.messages ??
      EMPTY_SESSION_MESSAGES
    )
  })
  const runChangesByRunId = useAgentStore((state) => state.runChangesByRunId)
  const refreshSessionRunChanges = useAgentStore((state) => state.refreshSessionRunChanges)
  const refreshRunChanges = useAgentStore((state) => state.refreshRunChanges)
  const acceptFileChange = useAgentStore((state) => state.acceptFileChange)
  const rollbackFileChange = useAgentStore((state) => state.rollbackFileChange)
  const [selectedChangeId, setSelectedChangeId] = React.useState<string | null>(null)
  const [isRefreshing, setIsRefreshing] = React.useState(false)
  const [isAcceptingAll, setIsAcceptingAll] = React.useState(false)
  const [isRollingBackAll, setIsRollingBackAll] = React.useState(false)
  const requestedRefreshKeyRef = React.useRef<string | null>(null)
  const lastInitialChangeIdRef = React.useRef<string | null>(null)

  const assistantChangeTargets = React.useMemo(
    () =>
      sessionMessages
        .filter((message) => message.role === 'assistant')
        .map((message) => ({
          messageId: message.id,
          toolUseIds: getMessageToolUseIds(message)
        })),
    [sessionMessages]
  )
  const assistantMessageIdList = React.useMemo(
    () => assistantChangeTargets.map((target) => target.messageId),
    [assistantChangeTargets]
  )
  const assistantToolUseIds = React.useMemo(
    () => Array.from(new Set(assistantChangeTargets.flatMap((target) => target.toolUseIds))),
    [assistantChangeTargets]
  )
  const assistantChangeTargetSig = React.useMemo(
    () => `${assistantMessageIdList.join(',')}|${assistantToolUseIds.join(',')}`,
    [assistantMessageIdList, assistantToolUseIds]
  )

  React.useEffect(() => {
    if (!activeSessionId) return
    const refreshKey = `${activeSessionId}:${assistantChangeTargetSig}`
    if (requestedRefreshKeyRef.current === refreshKey) return
    requestedRefreshKeyRef.current = refreshKey
    setIsRefreshing(true)
    void (async () => {
      await refreshSessionRunChanges(activeSessionId, {
        assistantMessageIds: assistantMessageIdList,
        toolUseIds: assistantToolUseIds
      })
      await Promise.all(
        assistantChangeTargets.map((target) =>
          refreshRunChanges(target.messageId, {
            sessionId: activeSessionId,
            ...(target.toolUseIds.length > 0 ? { toolUseIds: target.toolUseIds } : {})
          })
        )
      )
    })().finally(() => setIsRefreshing(false))
  }, [
    activeSessionId,
    assistantChangeTargets,
    assistantChangeTargetSig,
    assistantMessageIdList,
    assistantToolUseIds,
    refreshRunChanges,
    refreshSessionRunChanges
  ])

  const assistantMessageIds = React.useMemo(
    () => new Set(assistantMessageIdList),
    [assistantMessageIdList]
  )
  const assistantToolUseIdSet = React.useMemo(
    () => new Set(assistantToolUseIds),
    [assistantToolUseIds]
  )

  const sessionChangeSets = React.useMemo(() => {
    const seen = new Set<string>()
    return Object.values(runChangesByRunId)
      .filter((changeSet) => {
        if (!activeSessionId) return false
        if (changeSet.sessionId === activeSessionId) return true
        if (changeSet.changes.some((change) => change.sessionId === activeSessionId)) return true
        if (
          assistantMessageIds.has(changeSet.assistantMessageId) ||
          assistantMessageIds.has(changeSet.runId)
        ) {
          return true
        }
        return changeSet.changes.some(
          (change) => change.toolUseId && assistantToolUseIdSet.has(change.toolUseId)
        )
      })
      .filter((changeSet) => {
        if (seen.has(changeSet.runId)) return false
        seen.add(changeSet.runId)
        return true
      })
      .sort((left, right) => left.createdAt - right.createdAt)
  }, [activeSessionId, assistantMessageIds, assistantToolUseIdSet, runChangesByRunId])

  const aggregatedChanges = React.useMemo(() => {
    const trackedChanges = aggregateDisplayableRunFileChanges(
      sessionChangeSets.flatMap((changeSet) => changeSet.changes)
    )
    const trackedKeys = new Set(trackedChanges.map(changeGroupKey))
    const messageToolChanges = aggregateDisplayableRunFileChanges(
      buildSyntheticMessageToolChanges(sessionMessages, activeSessionId ?? '')
    ).filter((change) => !trackedKeys.has(changeGroupKey(change)))

    return [...trackedChanges, ...messageToolChanges].sort(
      (left, right) => left.createdAt - right.createdAt
    )
  }, [activeSessionId, sessionChangeSets, sessionMessages])
  const summariesByChangeId = useAggregatedChangeSummaries(aggregatedChanges)

  React.useEffect(() => {
    const nextInitialChangeId = initialChangeId ?? null
    setSelectedChangeId((current) => {
      const preferredId =
        nextInitialChangeId && (lastInitialChangeIdRef.current !== nextInitialChangeId || !current)
          ? nextInitialChangeId
          : current
      if (!preferredId) return null
      const matched = aggregatedChanges.find((change) =>
        matchesAggregatedChangeId(change, preferredId)
      )
      return matched?.id ?? null
    })
    lastInitialChangeIdRef.current = nextInitialChangeId
  }, [aggregatedChanges, initialChangeId])

  const summary = React.useMemo(
    () =>
      aggregatedChanges.reduce(
        (acc, change) => {
          const next = summariesByChangeId[change.id]
          if (!next) return acc
          acc.added += next.added
          acc.deleted += next.deleted
          return acc
        },
        { added: 0, deleted: 0 }
      ),
    [aggregatedChanges, summariesByChangeId]
  )

  const actionableChanges = React.useMemo(
    () => aggregatedChanges.flatMap((change) => actionableSourceChanges(change)),
    [aggregatedChanges]
  )
  const actionable = actionableChanges.length > 0

  const handleRefresh = async (): Promise<void> => {
    if (!activeSessionId) return
    setIsRefreshing(true)
    try {
      await refreshSessionRunChanges(activeSessionId, {
        assistantMessageIds: assistantMessageIdList,
        toolUseIds: assistantToolUseIds
      })
      await Promise.all(
        assistantChangeTargets.map((target) =>
          refreshRunChanges(target.messageId, {
            sessionId: activeSessionId,
            ...(target.toolUseIds.length > 0 ? { toolUseIds: target.toolUseIds } : {})
          })
        )
      )
    } finally {
      setIsRefreshing(false)
    }
  }

  const handleAcceptAll = async (): Promise<void> => {
    setIsAcceptingAll(true)
    try {
      for (const change of actionableChanges) {
        await acceptFileChange(change.runId, change.id)
      }
    } finally {
      setIsAcceptingAll(false)
    }
  }

  const handleRollbackAll = async (): Promise<void> => {
    setIsRollingBackAll(true)
    try {
      for (const change of [...actionableChanges].sort((a, b) => b.createdAt - a.createdAt)) {
        await rollbackFileChange(change.runId, change.id)
      }
    } finally {
      setIsRollingBackAll(false)
    }
  }

  if (isRefreshing && aggregatedChanges.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin text-emerald-400" />
        {t('thinking.thinkingEllipsis', { ns: 'chat' })}
      </div>
    )
  }

  if (aggregatedChanges.length === 0) {
    return <ReviewEmptyState />
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border/50 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-muted-foreground">
                {t('fileChange.filesChanged', {
                  ns: 'chat',
                  count: aggregatedChanges.length
                })}
              </span>
              <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-300">
                +{summary.added}
              </span>
              <span className="text-xs font-semibold text-red-600 dark:text-red-300">
                -{summary.deleted}
              </span>
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {t('rightPanel.reviewSessionDesc', {
                defaultValue:
                  'Review all file changes captured in the current session. Expand a file to inspect the aggregated diff.'
              })}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => void handleRefresh()}
              disabled={isRefreshing || isAcceptingAll || isRollingBackAll}
              title={t('action.refresh', { ns: 'common', defaultValue: 'Refresh' })}
            >
              <RefreshCw className={cn('size-3.5', isRefreshing && 'animate-spin')} />
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => void handleRollbackAll()}
              disabled={!actionable || isRefreshing || isAcceptingAll || isRollingBackAll}
            >
              {isRollingBackAll ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <RotateCcw className="size-3" />
              )}
              {t('action.undo', { ns: 'common' })}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => void handleAcceptAll()}
              disabled={!actionable || isRefreshing || isAcceptingAll || isRollingBackAll}
            >
              {isAcceptingAll ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Check className="size-3" />
              )}
              {t('action.allow', { ns: 'common' })}
            </Button>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {aggregatedChanges.map((change) => (
          <ChangeRow
            key={change.id}
            change={change}
            summary={summariesByChangeId[change.id] ?? { added: 0, deleted: 0 }}
            expanded={change.id === selectedChangeId}
            onToggle={() =>
              setSelectedChangeId((current) => (current === change.id ? null : change.id))
            }
          />
        ))}
      </div>
    </div>
  )
}
