import { createProvider } from '../api/provider'
import type { ProviderConfig, ToolDefinition, UnifiedMessage } from '../api/types'
import { estimateTokens } from '../format-tokens'
import { shouldCompress, shouldPreCompress, type CompressionConfig } from './context-compression'

function readContextUsage(usage?: UnifiedMessage['usage']): number {
  return usage?.contextTokens ?? 0
}

export function findRecentContextUsage(messages: UnifiedMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const tokens = readContextUsage(messages[index]?.usage)
    if (tokens > 0) return tokens
  }
  return 0
}

function estimateRequestContextTokens(args: {
  messages: UnifiedMessage[]
  provider: ProviderConfig
  tools: ToolDefinition[]
}): number {
  if (args.messages.length === 0) return 0

  try {
    const provider = createProvider(args.provider)
    const payload = {
      systemPrompt: args.provider.systemPrompt ?? '',
      messages: provider.formatMessages(args.messages),
      ...(args.tools.length > 0 ? { tools: provider.formatTools(args.tools) } : {})
    }
    return estimateTokens(JSON.stringify(payload))
  } catch (error) {
    console.warn('[Context Compression] Failed to estimate sidecar routing tokens', error)
    return 0
  }
}

export function shouldUseRendererLoopForCompression(args: {
  messages: UnifiedMessage[]
  provider: ProviderConfig
  tools: ToolDefinition[]
  compression?: CompressionConfig | null
}): boolean {
  const config = args.compression
  if (!config?.enabled) return false

  const recentTokens = findRecentContextUsage(args.messages)
  const estimatedTokens = estimateRequestContextTokens({
    messages: args.messages,
    provider: args.provider,
    tools: args.tools
  })
  const tokens = Math.max(recentTokens, estimatedTokens)

  return tokens > 0 && (shouldCompress(tokens, config) || shouldPreCompress(tokens, config))
}
