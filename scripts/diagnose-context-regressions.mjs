/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Cross-file regression sentinel for context/compression behavior across renderer/main files.
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

function routingForcesRendererFallbackWhenEnabled(source) {
  const hasReturnTrue = /return\s+true\b/.test(source)
  const mentionsCompressionEnabled = /!config\?\.enabled|config\?\.enabled/.test(source)
  const hasThresholdRoutingSignals =
    /shouldCompress\(/.test(source) ||
    /shouldPreCompress\(/.test(source) ||
    /estimateRequestContextTokens/.test(source)

  return hasReturnTrue && mentionsCompressionEnabled && !hasThresholdRoutingSignals
}

const routingBlocksAllEnabledCompression = routingForcesRendererFallbackWhenEnabled(routingSource)
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

function findBuildSidecarAgentCalls(source) {
  const calls = []
  let searchIndex = 0
  while (searchIndex < source.length) {
    const callIndex = source.indexOf('buildSidecarAgentRunRequest({', searchIndex)
    if (callIndex === -1) return calls
    const openBraceIndex = source.indexOf('{', callIndex)
    const closeBraceIndex = findMatchingBraceIndex(source, openBraceIndex)
    if (closeBraceIndex === -1) return calls
    calls.push(source.slice(callIndex, closeBraceIndex + 2))
    searchIndex = closeBraceIndex + 1
  }
  return calls
}

const agentSidecarCalls = findBuildSidecarAgentCalls(chatActionsSource).filter((call) =>
  /sessionMode\s*:\s*'agent'/.test(call)
)
const sidecarAgentNullCompression = agentSidecarCalls.some((call) =>
  /compression\s*:\s*null/.test(call)
)

if (mainRuntimeSupportsCompression && sidecarAgentNullCompression) {
  fail('agent sidecar requests drop context compression config', [
    'src/renderer/src/hooks/use-chat-actions.ts passes compression: null to agent sidecar requests',
    'forward compressionConfig/args.compression so sidecar runtime can compact during long runs'
  ])
} else {
  pass('agent sidecar requests preserve context compression config')
}

const legacyCompressionEnabledNullHistoryPattern =
  /requestContextMaxMessages\s*=\s*settings\.contextCompressionEnabled[\s\S]*?\?\s*null\s*:\s*undefined/

function findMatchingBraceIndex(source, openBraceIndex) {
  let depth = 0
  for (let index = openBraceIndex; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function findIfBlockContainingIndex(source, targetIndex) {
  let searchIndex = 0
  while (searchIndex < source.length) {
    const ifIndex = source.indexOf('if', searchIndex)
    if (ifIndex === -1) return null

    const openBraceIndex = source.indexOf('{', ifIndex)
    if (openBraceIndex === -1) return null

    const closeBraceIndex = findMatchingBraceIndex(source, openBraceIndex)
    if (closeBraceIndex === -1) return null

    if (targetIndex >= ifIndex && targetIndex <= closeBraceIndex) {
      return source.slice(ifIndex, closeBraceIndex + 1)
    }

    searchIndex = ifIndex + 2
  }

  return null
}

function hasThresholdProtectedNullHistoryRequest(source) {
  const nullHistoryPattern = /requestContextMaxMessages\s*:\s*null/g

  for (const match of source.matchAll(nullHistoryPattern)) {
    const matchIndex = match.index ?? -1
    if (matchIndex < 0) continue
    const ifBlock = findIfBlockContainingIndex(source, matchIndex)
    if (ifBlock && /shouldUseRendererLoopForCompression/.test(ifBlock)) {
      return true
    }
  }

  return false
}

const hasCompressionEnabledNullHistoryRequest =
  /contextCompressionEnabled[\s\S]*requestContextMaxMessages\s*[:=][\s\S]*null/.test(
    chatActionsSource
  )
const hasThresholdProtectedNullHistory = hasThresholdProtectedNullHistoryRequest(chatActionsSource)

if (
  legacyCompressionEnabledNullHistoryPattern.test(chatActionsSource) ||
  (hasCompressionEnabledNullHistoryRequest && !hasThresholdProtectedNullHistory)
) {
  fail('compression-enabled requests force full history loading', [
    'src/renderer/src/hooks/use-chat-actions.ts still contains a compression-enabled requestContextMaxMessages=null path',
    'compression-enabled requests should not force full-history loading before threshold routing decides it is necessary'
  ])
} else {
  pass('compression enabled requests do not force full history loading')
}

function findMatchingParenIndex(source, openParenIndex) {
  let depth = 0
  for (let index = openParenIndex; index < source.length; index += 1) {
    const char = source[index]
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function hasRuntimeDebugInfoWrite(source) {
  let index = source.indexOf('updateRuntimeMessage(')
  while (index !== -1) {
    const openParenIndex = source.indexOf('(', index)
    if (openParenIndex === -1) return false
    const closeParenIndex = findMatchingParenIndex(source, openParenIndex)
    const call = closeParenIndex === -1 ? source.slice(index) : source.slice(index, closeParenIndex + 1)
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
