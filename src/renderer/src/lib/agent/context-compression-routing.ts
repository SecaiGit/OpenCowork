import type { ProviderConfig, ToolDefinition, UnifiedMessage } from '../api/types'
import type { CompressionConfig } from './context-compression'

export function shouldUseRendererLoopForCompression(args: {
  messages: UnifiedMessage[]
  provider: ProviderConfig
  tools: ToolDefinition[]
  compression?: CompressionConfig | null
}): boolean {
  const config = args.compression
  if (!config?.enabled) return false
  return true
}
