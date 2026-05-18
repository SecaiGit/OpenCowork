import { createProvider } from '../api/provider'
import type { ProviderConfig, ToolDefinition, UnifiedMessage } from '../api/types'
import { estimateTokens } from '../format-tokens'
import { shouldCompress, shouldPreCompress, type CompressionConfig } from './context-compression'

function readContextUsage(usage?: UnifiedMessage['usage']): number {
  return usage?.contextTokens ?? usage?.inputTokens ?? 0
}

export function findRecentContextUsage(messages: UnifiedMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const tokens = readContextUsage(messages[i]?.usage)
    if (tokens > 0) return tokens
  }
  return 0
}

export function estimateRequestContextTokens(args: {
  messages: UnifiedMessage[]
  provider: ProviderConfig
  tools: ToolDefinition[]
  systemPrompt?: string
}): number {
  if (args.messages.length === 0) return 0

  try {
    const provider = createProvider(args.provider)
    const systemPrompt = args.systemPrompt ?? args.provider.systemPrompt ?? ''
    const payload = {
      systemPrompt,
      messages: provider.formatMessages(args.messages),
      ...(args.tools.length > 0 ? { tools: provider.formatTools(args.tools) } : {})
    }
    return estimateTokens(JSON.stringify(payload))
  } catch {
    try {
      return estimateTokens(
        JSON.stringify({
          systemPrompt: args.systemPrompt ?? args.provider.systemPrompt ?? '',
          messages: args.messages,
          tools: args.tools
        })
      )
    } catch {
      return 0
    }
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

  const tokens = findRecentContextUsage(args.messages) || estimateRequestContextTokens(args)
  if (tokens <= 0) return false

  return shouldCompress(tokens, config) || shouldPreCompress(tokens, config)
}
