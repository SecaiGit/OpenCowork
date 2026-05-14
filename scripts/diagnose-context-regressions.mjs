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

const failures = []
const passes = []

const routingSource = read('src/renderer/src/lib/agent/context-compression-routing.ts')
const chatActionsSource = read('src/renderer/src/hooks/use-chat-actions.ts')
const jsRuntimeSource = read('src/main/ipc/js-agent-runtime.ts')
const mainIndexSource = read('src/main/index.ts')
const appDataPathsSource = read('src/main/app-data-paths.ts')
const debugStoreSource = read('src/renderer/src/lib/debug-store.ts')
const assistantMessageSource = read('src/renderer/src/components/chat/AssistantMessage.tsx')
const agentStoreSource = read('src/renderer/src/stores/agent-store.ts')

const mainRuntimeSupportsCompression =
  /contextCompression\s*:/.test(jsRuntimeSource) ||
  /params\.compression/.test(jsRuntimeSource) ||
  /compression\?\s*:/.test(jsRuntimeSource)
const routingBlocksAllEnabledCompression = /if \(!config\?\.enabled\) return false\s+return true/.test(
  routingSource
)
const routingUsesThresholdDecision =
  /shouldCompress\(/.test(routingSource) &&
  /shouldPreCompress\(/.test(routingSource) &&
  /estimateRequestContextTokens/.test(routingSource)

if (routingBlocksAllEnabledCompression) {
  fail('compression routing forces every enabled compression run onto the renderer loop', [
    'src/renderer/src/lib/agent/context-compression-routing.ts has unconditional enabled => true routing',
    'restore token/threshold routing so sidecar stays enabled below compression thresholds'
  ])
} else if (!mainRuntimeSupportsCompression && !routingUsesThresholdDecision) {
  fail('compression routing lacks threshold checks while main runtime still lacks compression support', [
    'src/main/ipc/js-agent-runtime.ts has no contextCompression handling',
    'src/renderer/src/lib/agent/context-compression-routing.ts should use request token estimates plus shouldCompress/shouldPreCompress'
  ])
} else {
  pass('compression routing only falls back to renderer loop near compression thresholds')
}

const legacyCompressionEnabledNullHistoryPattern =
  /requestContextMaxMessages\s*=\s*settings\.contextCompressionEnabled[\s\S]*?\?\s*null\s*:\s*undefined/
const unguardedCompressionEnabledNullHistoryPattern =
  /contextCompressionEnabled[\s\S]{0,200}requestContextMaxMessages\s*[:=][\s\S]{0,80}null/
const thresholdRoutedRendererCompressionPattern =
  /shouldUseRendererLoopForCompression[\s\S]{0,240}requestContextMaxMessages\s*[:=][\s\S]{0,80}null/

if (
  legacyCompressionEnabledNullHistoryPattern.test(chatActionsSource) ||
  (unguardedCompressionEnabledNullHistoryPattern.test(chatActionsSource) &&
    !thresholdRoutedRendererCompressionPattern.test(chatActionsSource))
) {
  fail('compression-enabled requests force full history loading', [
    'src/renderer/src/hooks/use-chat-actions.ts still contains a compression-enabled requestContextMaxMessages=null path',
    'compression-enabled requests should not force full-history loading before threshold routing decides it is necessary'
  ])
} else {
  pass('compression enabled requests do not force full history loading')
}

function hasRuntimeDebugInfoWrite(source) {
  let index = source.indexOf('updateRuntimeMessage(')
  while (index !== -1) {
    const callPrefix = source.slice(index, index + 1_000)
    const callEnd = callPrefix.indexOf('})')
    const call = callEnd === -1 ? callPrefix : callPrefix.slice(0, callEnd)
    if (/debugInfo\s*:|\{\s*debugInfo[\s,}]/.test(call)) return true
    index = source.indexOf('updateRuntimeMessage(', index + 1)
  }
  return false
}

if (hasRuntimeDebugInfoWrite(chatActionsSource)) {
  fail('request_debug writes debug payloads into chat Zustand message state', [
    'src/renderer/src/hooks/use-chat-actions.ts should keep request bodies in the bounded debug store only',
    'avoid updateRuntimeMessage(..., { debugInfo }) for request_debug events'
  ])
} else {
  pass('request_debug does not write debug payloads into chat message state')
}

if (!/contextWindowBody/.test(debugStoreSource) || !/truncateRequestDebugPayloads/.test(debugStoreSource)) {
  fail('debug payload truncation does not cover contextWindowBody', [
    'src/renderer/src/lib/debug-store.ts must truncate both body and contextWindowBody before display/persistence'
  ])
} else {
  pass('debug payload truncation covers contextWindowBody')
}

if (/const bodyFormatted = \(\(\) =>/.test(assistantMessageSource)) {
  fail('debug request body is formatted during render even when the dialog is closed', [
    'src/renderer/src/components/chat/AssistantMessage.tsx should parse/format only after show === true',
    'large request bodies must also be capped before JSON.parse/JSON.stringify'
  ])
} else {
  pass('debug request body formatting is lazy')
}

if (/last\.thinking \+= thinking/.test(agentStoreSource) || /last\.text \+= text/.test(agentStoreSource)) {
  fail('sub-agent transcript text/thinking blocks can grow without a character cap', [
    'src/renderer/src/stores/agent-store.ts appendThinkingToSubAgent/appendTextToSubAgent should truncate block text'
  ])
} else {
  pass('sub-agent transcript text/thinking blocks are bounded')
}

if (/memory-pressure-off/.test(mainIndexSource) || /--max-old-space-size=\$\{systemMemMb\}/.test(mainIndexSource)) {
  fail('Electron renderer memory pressure protections are disabled or old-space is set to physical memory', [
    'src/main/index.ts should not append memory-pressure-off',
    'src/main/index.ts should not set renderer --max-old-space-size to total system memory'
  ])
} else {
  pass('Electron renderer memory pressure protections remain enabled')
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
