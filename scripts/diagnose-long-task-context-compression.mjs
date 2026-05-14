import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(scriptDir, '..')
const failures = []
const passes = []

function read(relativePath) {
  const absolutePath = path.join(root, relativePath)
  try {
    return fs.readFileSync(absolutePath, 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    fail(`missing diagnostic input: ${relativePath}`, [
      `Expected file: ${absolutePath}`,
      `Script root: ${root}`,
      `Current working directory: ${process.cwd()}`,
      message
    ])
    return ''
  }
}

function fail(message, details = []) {
  failures.push({ message, details })
}

function pass(message) {
  passes.push(message)
}

function check(condition, passMessage, failMessage, details = []) {
  if (condition) {
    pass(passMessage)
  } else {
    fail(failMessage, details)
  }
}

function hasAll(source, tokens) {
  return tokens.every((token) => source.includes(token))
}

function hasCompressionEnabledNullHistoryRegression(source) {
  const compactSource = source.replace(/\s+/g, ' ')
  return (
    /requestContextMaxMessages\s*=\s*settings\.contextCompressionEnabled\s*&&\s*compressionContextLength\s*>\s*0\s*\?\s*null\s*:\s*undefined/.test(
      source
    ) ||
    /contextCompressionEnabled[^;{}]{0,240}\?\s*null\s*:\s*undefined/.test(compactSource)
  )
}

const agentLoop = read('src/renderer/src/lib/agent/agent-loop.ts')
const compression = read('src/renderer/src/lib/agent/context-compression.ts')
const contextBudget = read('src/renderer/src/lib/agent/context-budget.ts')
const payload = read('src/renderer/src/lib/agent/context-payload-compaction.ts')
const sharedRuntime = read('src/renderer/src/lib/agent/shared-runtime.ts')
const stateFormat = read('src/renderer/src/lib/agent/context-state-format.ts')
const stateAttachments = read('src/renderer/src/lib/agent/context-state-attachments.ts')
const chatActions = read('src/renderer/src/hooks/use-chat-actions.ts')

check(
  /compactToolResultForContext\s*\(/.test(agentLoop),
  'agent loop compacts oversized tool results before replay',
  'agent loop does not compact tool results before replay',
  ['src/renderer/src/lib/agent/agent-loop.ts must call compactToolResultForContext before appending tool results to replay']
)

check(
  hasAll(agentLoop, ['toolDisplayResults', 'toolContextResults']) &&
    /content:\s*toolContextResults\.filter/.test(agentLoop) &&
    /toolResults:\s*toolDisplayResults/.test(agentLoop),
  'agent loop separates UI-visible tool output from replay payloads',
  'agent loop does not separate UI tool output from replay tool output',
  ['agent-loop.ts must keep toolDisplayResults for iteration_end/UI and toolContextResults for conversation replay']
)

check(
  hasAll(agentLoop, ['lastObservedContextTokens', 'estimatedReplayTokens']) &&
    !agentLoop.includes('lastInputTokens'),
  'agent loop separates observed provider tokens from estimated replay tokens',
  'agent loop token budget state is ambiguous',
  [
    'agent-loop.ts must use lastObservedContextTokens for provider usage and estimatedReplayTokens for local estimates',
    'do not reintroduce lastInputTokens'
  ]
)

check(
  hasAll(agentLoop, ['compactRecentToolPayloads', 'buildContextBudgetSnapshot']),
  'agent loop has preflight context budget management',
  'agent loop is missing preflight context budget management',
  ['agent-loop.ts must run compactRecentToolPayloads and buildContextBudgetSnapshot before provider requests']
)

check(
  contextBudget.includes('pendingToolUseIds') && !contextBudget.includes('hasUnansweredToolUse'),
  'API round grouping tracks pending tool_use/tool_result pairs',
  'API round grouping does not explicitly track pending tool_use ids',
  ['context-budget.ts groupMessagesByApiRound must track pendingToolUseIds and must not regress to hasUnansweredToolUse']
)

check(
  compression.includes('export type CompressionSkipReason') &&
    /reason\?:\s*CompressionSkipReason/.test(compression),
  'compression results expose skip reasons',
  'compression results do not expose skip reasons',
  ['context-compression.ts must export CompressionSkipReason and include reason on CompressionResult']
)

check(
  hasAll(compression, ['truncateHeadForPromptTooLongRetry', 'isPromptTooLongError']),
  'compaction has prompt-too-long retry handling',
  'compaction prompt-too-long retry is missing',
  ['context-compression.ts must retry PTL by dropping older API-round groups']
)

check(
  payload.includes('Tool result compacted for context budget'),
  'payload compaction marker is present',
  'payload compaction marker is missing',
  ['context-payload-compaction.ts must mark compacted tool results for model transparency']
)

check(
  payload.includes('export type ToolPayloadCompactionReason') && /reasons\?:/.test(payload),
  'payload compaction exposes precise reason list',
  'payload compaction does not expose precise reasons',
  [
    'context-payload-compaction.ts must distinguish tool_result_too_large from image_payload_omitted',
    'use reasons[] for mixed content'
  ]
)

check(
  /toolName\?:\s*string/.test(sharedRuntime) && !/toolName:\s*['"]injected['"]/.test(sharedRuntime),
  'shared runtime replay tool results preserve or derive tool names',
  'shared runtime replay tool results do not preserve tool names',
  ['shared-runtime.ts buildToolResultMessage must accept toolName? and avoid fixed toolName: injected']
)

check(
  hasAll(compression, ['postCompactState', 'dedupedMessagesToPreserve']),
  'post-compact state messages are deduplicated',
  'post-compact state messages are not deduplicated during compression',
  ['context-compression.ts must filter old meta.postCompactState preserved messages before adding the new state message']
)

check(
  hasAll(stateFormat, ['formatPostCompactStateContext', 'Recently read files', 'Continuity note']),
  'post-compact state formatter includes working state',
  'post-compact state formatter is missing read-file context',
  ['context-state-format.ts must include recently read files and continuity note']
)

check(
  !/usePlanStore|useTaskStore|@renderer\/locales/.test(stateFormat),
  'post-compact state formatter is renderer-independent',
  'post-compact state formatter depends on renderer runtime',
  ['context-state-format.ts must stay pure; collect renderer state in context-state-attachments.ts instead']
)

check(
  hasAll(stateAttachments, ['buildPostCompactStateContext', 'formatPostCompactStateContext']),
  'post-compact state renderer adapter calls the pure formatter',
  'post-compact state renderer adapter is not wired to the pure formatter',
  ['context-state-attachments.ts must collect renderer state and call formatPostCompactStateContext']
)

check(
  !hasCompressionEnabledNullHistoryRegression(chatActions),
  'chat action does not full-load history solely for compression',
  'chat action still full-loads history when compression is enabled',
  ['use-chat-actions.ts must not set requestContextMaxMessages=null just because compression is enabled']
)

for (const message of passes) {
  console.log(`[PASS] ${message}`)
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`[FAIL] ${failure.message}`)
    for (const detail of failure.details) {
      console.error(`  - ${detail}`)
    }
  }
  console.error(`[FAIL] long-task context compression diagnostics failed: ${failures.length} failure(s)`)
  process.exit(1)
}

console.log(`[PASS] long-task context compression diagnostics passed (${passes.length} checks)`)
