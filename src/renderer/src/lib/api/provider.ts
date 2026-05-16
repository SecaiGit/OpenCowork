import type { APIProvider, ProviderConfig, ProviderType } from './types'

const providers = new Map<ProviderType, () => APIProvider>()
const promptCacheKeyPrefix = 'opencowork'
let globalPromptCacheKey = createPromptCacheKey()
const promptCacheKeysBySession = new Map<string, string>()

function normalizePromptCacheSeed(seed?: string): string {
  return (seed ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
}

function hashPromptCacheSeed(seed: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

function createPromptCacheSessionKey(seed?: string): string {
  const normalizedSeed = normalizePromptCacheSeed(seed)
  return normalizedSeed ? `s-${hashPromptCacheSeed(normalizedSeed)}` : ''
}

function createPromptCacheKey(sessionKey?: string, rotate = false): string {
  const suffix =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  if (sessionKey) {
    return rotate ? `${promptCacheKeyPrefix}-${sessionKey}-${suffix}` : `${promptCacheKeyPrefix}-${sessionKey}`
  }
  return `${promptCacheKeyPrefix}-${suffix}`
}

export function registerProvider(type: ProviderType, factory: () => APIProvider): void {
  providers.set(type, factory)
}

export function createProvider(config: ProviderConfig): APIProvider {
  const factory = providers.get(config.type)
  if (!factory) {
    throw new Error(`Unknown provider type: ${config.type}`)
  }
  return factory()
}

export function getAvailableProviders(): ProviderType[] {
  return Array.from(providers.keys())
}

export function getGlobalPromptCacheKey(config?: Pick<ProviderConfig, 'sessionId'>): string {
  const sessionKey = createPromptCacheSessionKey(config?.sessionId)
  if (!sessionKey) {
    return globalPromptCacheKey
  }

  const existing = promptCacheKeysBySession.get(sessionKey)
  if (existing) return existing

  const created = createPromptCacheKey(sessionKey)
  promptCacheKeysBySession.set(sessionKey, created)
  return created
}

export function resetGlobalPromptCacheKey(config?: Pick<ProviderConfig, 'sessionId'>): string {
  const sessionKey = createPromptCacheSessionKey(config?.sessionId)
  const created = createPromptCacheKey(sessionKey, true)
  if (!sessionKey) {
    globalPromptCacheKey = created
    return created
  }

  promptCacheKeysBySession.set(sessionKey, created)
  return created
}
