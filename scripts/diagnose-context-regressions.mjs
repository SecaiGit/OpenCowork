/* eslint-disable @typescript-eslint/explicit-function-return-type */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function fail(message, details = []) {
  failures.push({ message, details })
}

function pass(message) {
  passes.push(message)
}

function extractSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  if (start === -1) return ''
  const end = source.indexOf(endMarker, start)
  if (end === -1) return source.slice(start)
  return source.slice(start, end)
}

const failures = []
const passes = []

const routingSource = read('src/renderer/src/lib/agent/context-compression-routing.ts')
const chatActionsSource = read('src/renderer/src/hooks/use-chat-actions.ts')
const sharedRuntimeSource = read('src/renderer/src/lib/agent/shared-runtime.ts')
const jsRuntimeSource = read('src/main/ipc/js-agent-runtime.ts')
const mainIndexSource = read('src/main/index.ts')
const appDataPathsSource = read('src/main/app-data-paths.ts')

const mainRuntimeSupportsCompression =
  /contextCompression\s*:/.test(jsRuntimeSource) ||
  /params\.compression/.test(jsRuntimeSource) ||
  /compression\?\s*:/.test(jsRuntimeSource)
const routingBlocksAllEnabledCompression = /if \(!config\?\.enabled\) return false\s+return true/.test(
  routingSource
)

if (!mainRuntimeSupportsCompression && !routingBlocksAllEnabledCompression) {
  fail('compression enabled runs can still enter sidecar while main runtime lacks compression support', [
    'src/main/ipc/js-agent-runtime.ts has no contextCompression handling',
    'src/renderer/src/lib/agent/context-compression-routing.ts does not return true for all enabled compression configs'
  ])
} else {
  pass('compression enabled runs are not routed to unsupported sidecar compression path')
}

const chatSidecarNullCount = (chatActionsSource.match(/compression:\s*null/g) ?? []).length
const sharedSidecarNullCount = (sharedRuntimeSource.match(/compression:\s*null/g) ?? []).length
if (!mainRuntimeSupportsCompression && !routingBlocksAllEnabledCompression) {
  if (chatSidecarNullCount > 0 || sharedSidecarNullCount > 0) {
    fail('sidecar requests drop compression config on a path that can still be selected', [
      `src/renderer/src/hooks/use-chat-actions.ts compression:null count=${chatSidecarNullCount}`,
      `src/renderer/src/lib/agent/shared-runtime.ts compression:null count=${sharedSidecarNullCount}`
    ])
  }
} else {
  pass('sidecar compression config drop is unreachable for enabled compression, or main runtime supports it')
}

const subAgentBuffer = extractSection(
  chatActionsSource,
  'function createSubAgentEventBuffer',
  'export type ManualCompressionResult'
)
if (!subAgentBuffer) {
  fail('could not locate createSubAgentEventBuffer for sub-agent event routing diagnosis')
} else if (/isSessionForeground\(sessionId\)[\s\S]*handleSubAgentEvent/.test(subAgentBuffer)) {
  fail('sub-agent events are gated by foreground session before reaching agent-store', [
    'background session events can be dropped before sessionSubAgentLiveCache/runningSubAgentSessionIdsSig update',
    'src/renderer/src/hooks/use-chat-actions.ts createSubAgentEventBuffer still checks isSessionForeground(sessionId) around handleSubAgentEvent'
  ])
} else {
  pass('sub-agent events reach agent-store regardless of foreground session')
}

if (!/getAppDataDir/.test(appDataPathsSource) || !/OPEN_COWORK_DATA_DIR/.test(appDataPathsSource)) {
  fail('app data directory resolver or OPEN_COWORK_DATA_DIR override is missing')
} else if (!/app\.isPackaged \? '\.open-cowork' : '\.open-cowork-dev'/.test(appDataPathsSource)) {
  fail('development app data directory is not isolated from packaged app data directory')
} else {
  pass('development app data directory is isolated from packaged app data by default')
}

if (!/configureAppIdentityAndDataPaths\(\)\s*\nconfigureChromiumCachePaths\(\)/.test(mainIndexSource)) {
  fail('Electron userData identity is not configured before Chromium cache paths')
} else {
  pass('Electron userData identity is configured before Chromium cache paths')
}

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
  process.exit(1)
}

console.log('[PASS] context regression diagnostics passed')
