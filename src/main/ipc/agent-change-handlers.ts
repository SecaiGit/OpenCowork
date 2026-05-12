import { createHash } from 'crypto'
import * as fs from 'fs'
import { ipcMain } from 'electron'

export type RunChangeStatus =
  | 'open'
  | 'partial'
  | 'accepted'
  | 'reverting'
  | 'reverted'
  | 'conflicted'
export type FileChangeStatus = 'open' | 'accepted' | 'reverted' | 'conflicted'
type ChangeOp = 'create' | 'modify'
type ChangeTransport = 'local' | 'ssh'

interface ChangeMeta {
  runId?: string
  sessionId?: string
  toolUseId?: string
  toolName?: string
}

interface ListRunChangesArgs {
  runId: string
  sessionId?: string
  toolUseIds?: string[]
}

interface ListSessionRunChangesArgs {
  sessionId: string
  assistantMessageIds?: string[]
  toolUseIds?: string[]
}

export interface FileSnapshot {
  exists: boolean
  text?: string
  fullText?: string
  previewText?: string
  tailPreviewText?: string
  textOmitted?: boolean
  hash: string | null
  size: number
  lineCount?: number
}

interface TrackedFileChange {
  id: string
  runId: string
  sessionId?: string
  toolUseId?: string
  toolName?: string
  filePath: string
  transport: ChangeTransport
  connectionId?: string
  op: ChangeOp
  status: FileChangeStatus
  before: FileSnapshot
  after: FileSnapshot
  createdAt: number
  acceptedAt?: number
  revertedAt?: number
  conflict?: string
}

interface RunChangeSet {
  runId: string
  sessionId?: string
  assistantMessageId: string
  status: RunChangeStatus
  changes: TrackedFileChange[]
  createdAt: number
  updatedAt: number
}

interface SshChangeAdapter {
  readSnapshot: (connectionId: string, filePath: string) => Promise<FileSnapshot>
  writeText: (connectionId: string, filePath: string, content: string) => Promise<void>
  deleteFile: (connectionId: string, filePath: string) => Promise<void>
}

const runChanges = new Map<string, RunChangeSet>()
let sshChangeAdapter: SshChangeAdapter | null = null

const INLINE_TEXT_SNAPSHOT_LIMIT_BYTES = 64 * 1024
const SNAPSHOT_PREVIEW_HEAD_CHARS = 1200
const SNAPSHOT_PREVIEW_TAIL_CHARS = 400
const RUN_CHANGES_MAX_AGE_MS = 30 * 60 * 1000

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function buildFileSnapshot(exists: boolean, text?: string): FileSnapshot {
  if (!exists) {
    return {
      exists: false,
      hash: null,
      size: 0
    }
  }

  const normalizedText = text ?? ''
  const size = Buffer.byteLength(normalizedText, 'utf-8')
  const lineCount =
    normalizedText.length === 0 ? 0 : normalizedText.replace(/\r\n/g, '\n').split('\n').length
  if (size <= INLINE_TEXT_SNAPSHOT_LIMIT_BYTES) {
    return {
      exists: true,
      text: normalizedText,
      fullText: normalizedText,
      hash: hashText(normalizedText),
      size,
      lineCount
    }
  }

  return {
    exists: true,
    fullText: normalizedText,
    previewText: normalizedText.slice(0, SNAPSHOT_PREVIEW_HEAD_CHARS),
    ...(normalizedText.length > SNAPSHOT_PREVIEW_TAIL_CHARS
      ? { tailPreviewText: normalizedText.slice(-SNAPSHOT_PREVIEW_TAIL_CHARS) }
      : {}),
    textOmitted: true,
    hash: hashText(normalizedText),
    size,
    lineCount
  }
}

function buildLightSnapshot(text: string): FileSnapshot {
  const size = Buffer.byteLength(text, 'utf-8')
  const lineCount = text.length === 0 ? 0 : text.replace(/\r\n/g, '\n').split('\n').length
  if (size <= INLINE_TEXT_SNAPSHOT_LIMIT_BYTES) {
    return {
      exists: true,
      text,
      fullText: text,
      hash: hashText(text),
      size,
      lineCount
    }
  }

  return {
    exists: true,
    previewText: text.slice(0, SNAPSHOT_PREVIEW_HEAD_CHARS),
    ...(text.length > SNAPSHOT_PREVIEW_TAIL_CHARS
      ? { tailPreviewText: text.slice(-SNAPSHOT_PREVIEW_TAIL_CHARS) }
      : {}),
    textOmitted: true,
    hash: hashText(text),
    size,
    lineCount
  }
}

export function buildOpaqueExistingSnapshot(): FileSnapshot {
  return {
    exists: true,
    hash: null,
    size: 0
  }
}

function readLocalSnapshot(filePath: string): FileSnapshot {
  if (!fs.existsSync(filePath)) {
    return buildFileSnapshot(false)
  }

  const stats = fs.statSync(filePath)
  if (!stats.isFile()) {
    return buildOpaqueExistingSnapshot()
  }

  const text = fs.readFileSync(filePath, 'utf-8')
  return buildFileSnapshot(true, text)
}

function cloneSnapshot(snapshot: FileSnapshot): FileSnapshot {
  return {
    exists: snapshot.exists,
    text:
      snapshot.text ??
      (snapshot.size <= INLINE_TEXT_SNAPSHOT_LIMIT_BYTES ? snapshot.fullText : undefined),
    previewText: snapshot.previewText,
    tailPreviewText: snapshot.tailPreviewText,
    textOmitted: snapshot.textOmitted,
    hash: snapshot.hash,
    size: snapshot.size,
    lineCount: snapshot.lineCount
  }
}

function hydrateLocalAfterSnapshot(
  change: TrackedFileChange,
  snapshot: FileSnapshot
): FileSnapshot {
  const cloned = cloneSnapshot(snapshot)
  if (cloned.text !== undefined) return cloned
  if (change.transport !== 'local' || snapshot.size > INLINE_TEXT_SNAPSHOT_LIMIT_BYTES) {
    return cloned
  }
  if (!snapshot.hash || !fs.existsSync(change.filePath)) return cloned

  const stats = fs.statSync(change.filePath)
  if (!stats.isFile() || stats.size > INLINE_TEXT_SNAPSHOT_LIMIT_BYTES) return cloned

  const text = fs.readFileSync(change.filePath, 'utf-8')
  if (hashText(text) !== snapshot.hash) return cloned

  return {
    ...cloned,
    text
  }
}

function cloneChange(change: TrackedFileChange): TrackedFileChange {
  return {
    ...change,
    before: cloneSnapshot(change.before),
    after: hydrateLocalAfterSnapshot(change, change.after)
  }
}

function cloneRunChangeSet(changeSet: RunChangeSet): RunChangeSet {
  return {
    ...changeSet,
    changes: changeSet.changes.map(cloneChange)
  }
}

function summarizeRunStatus(changeSet: RunChangeSet): RunChangeStatus {
  if (changeSet.changes.length === 0) return 'open'

  const statuses = new Set(changeSet.changes.map((change) => change.status))
  if (statuses.size === 1) {
    const only = changeSet.changes[0]?.status
    if (only === 'open') return 'open'
    if (only === 'accepted') return 'accepted'
    if (only === 'reverted') return 'reverted'
    if (only === 'conflicted') return 'conflicted'
  }

  if (statuses.has('open')) return 'partial'
  if (statuses.has('conflicted')) return 'conflicted'
  return 'partial'
}

function touchRunChangeSet(changeSet: RunChangeSet): void {
  changeSet.updatedAt = Date.now()
  if (changeSet.status !== 'reverting') {
    changeSet.status = summarizeRunStatus(changeSet)
  }
}

function pruneStaleRunChanges(): void {
  const now = Date.now()
  for (const [runId, changeSet] of runChanges) {
    if (now - changeSet.updatedAt < RUN_CHANGES_MAX_AGE_MS) continue
    const status = changeSet.status
    if (status === 'accepted' || status === 'reverted') {
      runChanges.delete(runId)
    }
  }
}

function getOrCreateRunChangeSet(
  meta: Required<Pick<ChangeMeta, 'runId'>> & ChangeMeta
): RunChangeSet {
  pruneStaleRunChanges()
  const existing = runChanges.get(meta.runId)
  if (existing) {
    if (!existing.sessionId && meta.sessionId) {
      existing.sessionId = meta.sessionId
    }
    touchRunChangeSet(existing)
    return existing
  }

  const createdAt = Date.now()
  const created: RunChangeSet = {
    runId: meta.runId,
    sessionId: meta.sessionId,
    assistantMessageId: meta.runId,
    status: 'open',
    changes: [],
    createdAt,
    updatedAt: createdAt
  }
  runChanges.set(meta.runId, created)
  return created
}

function recordTextWriteChange(args: {
  meta?: ChangeMeta
  filePath: string
  before: FileSnapshot
  afterText: string
  transport: ChangeTransport
  connectionId?: string
}): void {
  const runId = args.meta?.runId?.trim()
  if (!runId) return

  const after = buildLightSnapshot(args.afterText)
  if (args.before.exists === after.exists && args.before.hash === after.hash) {
    return
  }

  const changeSet = getOrCreateRunChangeSet({ ...args.meta, runId })
  changeSet.changes.push({
    id: `${runId}:${changeSet.changes.length + 1}`,
    runId,
    sessionId: args.meta?.sessionId,
    toolUseId: args.meta?.toolUseId,
    toolName: args.meta?.toolName,
    filePath: args.filePath,
    transport: args.transport,
    connectionId: args.connectionId,
    op: args.before.exists ? 'modify' : 'create',
    status: 'open',
    before: args.before,
    after,
    createdAt: Date.now()
  })
  touchRunChangeSet(changeSet)
}

export function recordLocalTextWriteChange(args: {
  meta?: ChangeMeta
  filePath: string
  beforeExists: boolean
  beforeText?: string
  afterText: string
}): void {
  recordTextWriteChange({
    meta: args.meta,
    filePath: args.filePath,
    before: buildFileSnapshot(args.beforeExists, args.beforeText),
    afterText: args.afterText,
    transport: 'local'
  })
}

export function recordSshTextWriteChange(args: {
  meta?: ChangeMeta
  connectionId: string
  filePath: string
  before: FileSnapshot
  afterText: string
}): void {
  recordTextWriteChange({
    meta: args.meta,
    filePath: args.filePath,
    before: args.before,
    afterText: args.afterText,
    transport: 'ssh',
    connectionId: args.connectionId
  })
}

export function registerSshChangeAdapter(adapter: SshChangeAdapter): void {
  sshChangeAdapter = adapter
}

function getRunChangeSet(runId: string): RunChangeSet | null {
  const changeSet = runChanges.get(runId)
  if (!changeSet) return null
  touchRunChangeSet(changeSet)
  return cloneRunChangeSet(changeSet)
}

function toStringSet(values: unknown): Set<string> {
  if (!Array.isArray(values)) return new Set()
  return new Set(
    values
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean)
  )
}

function runChangeSetHasSession(changeSet: RunChangeSet, sessionId: string): boolean {
  return (
    changeSet.sessionId === sessionId ||
    changeSet.changes.some((change) => change.sessionId === sessionId)
  )
}

function countMatchingToolUseIds(changeSet: RunChangeSet, toolUseIds: Set<string>): number {
  if (toolUseIds.size === 0) return 0
  let count = 0
  for (const change of changeSet.changes) {
    if (change.toolUseId && toolUseIds.has(change.toolUseId)) {
      count += 1
    }
  }
  return count
}

function getRunChangeSetByQuery(args: ListRunChangesArgs): RunChangeSet | null {
  const runId = args.runId?.trim()
  if (runId) {
    const exact = getRunChangeSet(runId)
    if (exact) return exact
  }

  pruneStaleRunChanges()

  const sessionId = args.sessionId?.trim()
  const toolUseIds = toStringSet(args.toolUseIds)
  if (toolUseIds.size === 0 && !runId) return null

  let bestMatch: { changeSet: RunChangeSet; score: number } | null = null

  for (const changeSet of runChanges.values()) {
    const assistantMessageMatch = Boolean(runId && changeSet.assistantMessageId === runId)
    const toolMatchCount = countMatchingToolUseIds(changeSet, toolUseIds)
    const targetedMatch = assistantMessageMatch || toolMatchCount > 0
    if (sessionId && !runChangeSetHasSession(changeSet, sessionId) && !targetedMatch) {
      continue
    }

    if (!assistantMessageMatch && toolMatchCount === 0) continue

    const score = (assistantMessageMatch ? 1000 : 0) + toolMatchCount
    if (
      !bestMatch ||
      score > bestMatch.score ||
      (score === bestMatch.score && changeSet.updatedAt > bestMatch.changeSet.updatedAt)
    ) {
      bestMatch = { changeSet, score }
    }
  }

  if (!bestMatch) return null
  touchRunChangeSet(bestMatch.changeSet)
  return cloneRunChangeSet(bestMatch.changeSet)
}

function getRunChangeSetsBySession(args: ListSessionRunChangesArgs): RunChangeSet[] {
  const sessionId = args.sessionId?.trim()
  if (!sessionId) return []

  pruneStaleRunChanges()

  const assistantMessageIds = toStringSet(args.assistantMessageIds)
  const toolUseIds = toStringSet(args.toolUseIds)

  const matches = Array.from(runChanges.values())
    .filter((changeSet) => {
      if (runChangeSetHasSession(changeSet, sessionId)) return true
      if (
        assistantMessageIds.has(changeSet.assistantMessageId) ||
        assistantMessageIds.has(changeSet.runId)
      ) {
        return true
      }
      return countMatchingToolUseIds(changeSet, toolUseIds) > 0
    })
    .sort((left, right) => left.createdAt - right.createdAt)

  for (const changeSet of matches) {
    touchRunChangeSet(changeSet)
  }

  return matches.map(cloneRunChangeSet)
}

function findChange(
  runId: string,
  changeId: string
): { changeSet: RunChangeSet; change: TrackedFileChange } | null {
  const changeSet = runChanges.get(runId)
  if (!changeSet) return null
  const change = changeSet.changes.find((entry) => entry.id === changeId)
  if (!change) return null
  return { changeSet, change }
}

function resolveSnapshotFullText(snapshot: FileSnapshot): string | null {
  if (!snapshot.exists) return ''
  return snapshot.fullText ?? snapshot.text ?? null
}

async function getChangeDiffContent(
  runId: string,
  changeId: string
): Promise<{ beforeText: string; afterText: string } | { error: string } | null> {
  const found = findChange(runId, changeId)
  if (!found) return null

  const beforeText = resolveSnapshotFullText(found.change.before)
  let afterText = resolveSnapshotFullText(found.change.after)

  if (afterText === null && found.change.status === 'open') {
    if (found.change.transport === 'local') {
      try {
        const currentText = fs.readFileSync(found.change.filePath, 'utf-8')
        if (hashText(currentText) === found.change.after.hash) {
          afterText = currentText
        }
      } catch {
        // file may have been deleted or changed
      }
    } else if (found.change.connectionId && sshChangeAdapter) {
      try {
        const snap = await sshChangeAdapter.readSnapshot(
          found.change.connectionId,
          found.change.filePath
        )
        const snapText = resolveSnapshotFullText(snap)
        if (snapText !== null && hashText(snapText) === found.change.after.hash) {
          afterText = snapText
        }
      } catch {
        // SSH connection may be unavailable
      }
    }
  }

  if (beforeText === null || afterText === null) {
    return { error: 'Full diff is unavailable for this change' }
  }

  return { beforeText, afterText }
}

async function getSnapshotContent(
  runId: string,
  changeId: string,
  side: 'before' | 'after'
): Promise<{ text: string } | { error: string } | null> {
  const found = findChange(runId, changeId)
  if (!found) return null

  const snapshot = side === 'before' ? found.change.before : found.change.after
  let text = resolveSnapshotFullText(snapshot)

  if (text === null && side === 'after' && found.change.status === 'open') {
    if (found.change.transport === 'local') {
      try {
        const currentText = fs.readFileSync(found.change.filePath, 'utf-8')
        if (hashText(currentText) === found.change.after.hash) {
          text = currentText
        }
      } catch {
        // file may have been deleted or changed
      }
    } else if (found.change.connectionId && sshChangeAdapter) {
      try {
        const snap = await sshChangeAdapter.readSnapshot(
          found.change.connectionId,
          found.change.filePath
        )
        const snapText = resolveSnapshotFullText(snap)
        if (snapText !== null && hashText(snapText) === found.change.after.hash) {
          text = snapText
        }
      } catch {
        // SSH connection may be unavailable
      }
    }
  }

  if (text === null) {
    return { error: `Full ${side} snapshot is unavailable for this change` }
  }

  return { text }
}

function acceptOneChange(change: TrackedFileChange): void {
  if (change.status !== 'open' && change.status !== 'conflicted') return
  change.status = 'accepted'
  change.acceptedAt = Date.now()
  change.conflict = undefined
}

function acceptRunChangeSet(runId: string): RunChangeSet | null {
  const changeSet = runChanges.get(runId)
  if (!changeSet) return null
  for (const change of changeSet.changes) {
    acceptOneChange(change)
  }
  touchRunChangeSet(changeSet)
  return cloneRunChangeSet(changeSet)
}

function acceptFileChange(runId: string, changeId: string): RunChangeSet | null {
  const found = findChange(runId, changeId)
  if (!found) return null
  acceptOneChange(found.change)
  touchRunChangeSet(found.changeSet)
  return cloneRunChangeSet(found.changeSet)
}

function canAttemptRollback(change: TrackedFileChange): boolean {
  return change.status === 'open' || change.status === 'conflicted'
}

async function readTransportSnapshot(change: TrackedFileChange): Promise<FileSnapshot> {
  if (change.transport === 'local') {
    return readLocalSnapshot(change.filePath)
  }
  if (!change.connectionId || !sshChangeAdapter) {
    throw new Error('SSH change adapter is unavailable')
  }
  return sshChangeAdapter.readSnapshot(change.connectionId, change.filePath)
}

async function applyRollback(
  change: TrackedFileChange
): Promise<{ reverted: boolean; conflict?: string }> {
  const current = await readTransportSnapshot(change)

  if (change.op === 'create') {
    if (!current.exists) {
      change.status = 'reverted'
      change.revertedAt = Date.now()
      change.conflict = undefined
      return { reverted: true }
    }
    if (current.hash !== change.after.hash) {
      const reason = 'File changed since this agent run completed'
      change.status = 'conflicted'
      change.conflict = reason
      return { reverted: false, conflict: reason }
    }

    if (change.transport === 'local') {
      fs.rmSync(change.filePath, { force: true })
    } else {
      if (!change.connectionId || !sshChangeAdapter) {
        throw new Error('SSH change adapter is unavailable')
      }
      await sshChangeAdapter.deleteFile(change.connectionId, change.filePath)
    }

    change.status = 'reverted'
    change.revertedAt = Date.now()
    change.conflict = undefined
    return { reverted: true }
  }

  if (!current.exists) {
    const reason = 'File is missing and cannot be restored safely'
    change.status = 'conflicted'
    change.conflict = reason
    return { reverted: false, conflict: reason }
  }

  if (current.hash !== change.after.hash) {
    const reason = 'File changed since this agent run completed'
    change.status = 'conflicted'
    change.conflict = reason
    return { reverted: false, conflict: reason }
  }

  if (change.before.exists && change.before.text === undefined) {
    const reason = 'Rollback is unavailable for large file snapshots captured in summary mode'
    change.status = 'conflicted'
    change.conflict = reason
    return { reverted: false, conflict: reason }
  }

  if (change.transport === 'local') {
    fs.writeFileSync(change.filePath, change.before.text ?? '', 'utf-8')
  } else {
    if (!change.connectionId || !sshChangeAdapter) {
      throw new Error('SSH change adapter is unavailable')
    }
    await sshChangeAdapter.writeText(change.connectionId, change.filePath, change.before.text ?? '')
  }

  change.status = 'reverted'
  change.revertedAt = Date.now()
  change.conflict = undefined
  return { reverted: true }
}

async function rollbackRunChangeSet(runId: string): Promise<{
  success: boolean
  revertedCount: number
  conflictCount: number
  conflicts: Array<{ changeId: string; filePath: string; reason: string }>
  changeset: RunChangeSet | null
}> {
  const changeSet = runChanges.get(runId)
  if (!changeSet) {
    return {
      success: false,
      revertedCount: 0,
      conflictCount: 0,
      conflicts: [],
      changeset: null
    }
  }

  changeSet.status = 'reverting'
  changeSet.updatedAt = Date.now()

  let revertedCount = 0
  let conflictCount = 0
  const conflicts: Array<{ changeId: string; filePath: string; reason: string }> = []

  for (const change of [...changeSet.changes].reverse()) {
    if (!canAttemptRollback(change)) continue
    const result = await applyRollback(change)
    if (result.reverted) {
      revertedCount += 1
    } else if (result.conflict) {
      conflictCount += 1
      conflicts.push({ changeId: change.id, filePath: change.filePath, reason: result.conflict })
    }
  }

  touchRunChangeSet(changeSet)
  return {
    success: conflictCount === 0,
    revertedCount,
    conflictCount,
    conflicts,
    changeset: cloneRunChangeSet(changeSet)
  }
}

async function rollbackFileChange(
  runId: string,
  changeId: string
): Promise<{
  success: boolean
  conflict?: string
  changeset: RunChangeSet | null
}> {
  const found = findChange(runId, changeId)
  if (!found) {
    return { success: false, conflict: 'Change not found', changeset: null }
  }

  if (!canAttemptRollback(found.change)) {
    touchRunChangeSet(found.changeSet)
    return { success: true, changeset: cloneRunChangeSet(found.changeSet) }
  }

  const result = await applyRollback(found.change)
  touchRunChangeSet(found.changeSet)
  return {
    success: result.reverted,
    conflict: result.conflict,
    changeset: cloneRunChangeSet(found.changeSet)
  }
}

export function registerAgentChangeHandlers(): void {
  ipcMain.handle('agent:changes:list', async (_event, args: ListRunChangesArgs) => {
    try {
      if (!args?.runId) return null
      return getRunChangeSetByQuery(args)
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.handle('agent:changes:list-session', async (_event, args: ListSessionRunChangesArgs) => {
    try {
      if (!args?.sessionId) return []
      return getRunChangeSetsBySession(args)
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.handle(
    'agent:changes:diff-content',
    async (_event, args: { runId: string; changeId: string }) => {
      try {
        if (!args?.runId || !args?.changeId) return { error: 'runId and changeId are required' }
        return await getChangeDiffContent(args.runId, args.changeId)
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  ipcMain.handle(
    'agent:changes:snapshot-content',
    async (_event, args: { runId: string; changeId: string; side: 'before' | 'after' }) => {
      try {
        if (!args?.runId || !args?.changeId || !args?.side) {
          return { error: 'runId, changeId, and side are required' }
        }
        return await getSnapshotContent(args.runId, args.changeId, args.side)
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  ipcMain.handle('agent:changes:accept', async (_event, args: { runId: string }) => {
    try {
      if (!args?.runId) return { error: 'runId is required' }
      return {
        success: true,
        changeset: acceptRunChangeSet(args.runId)
      }
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.handle(
    'agent:changes:accept-file',
    async (_event, args: { runId: string; changeId: string }) => {
      try {
        if (!args?.runId || !args?.changeId) return { error: 'runId and changeId are required' }
        return {
          success: true,
          changeset: acceptFileChange(args.runId, args.changeId)
        }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  ipcMain.handle('agent:changes:rollback', async (_event, args: { runId: string }) => {
    try {
      if (!args?.runId) return { error: 'runId is required' }
      return await rollbackRunChangeSet(args.runId)
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.handle(
    'agent:changes:rollback-file',
    async (_event, args: { runId: string; changeId: string }) => {
      try {
        if (!args?.runId || !args?.changeId) return { error: 'runId and changeId are required' }
        return await rollbackFileChange(args.runId, args.changeId)
      } catch (err) {
        return { error: String(err) }
      }
    }
  )
}
