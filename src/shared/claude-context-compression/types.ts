export type ClaudeCompactTrigger = 'auto' | 'manual'
export type ClaudeCompactSourceRuntime = 'shared' | 'renderer' | 'main' | 'sidecar'

export interface ClaudeCompactConfig {
  enabled: boolean
  contextLength: number
  threshold: number
  strategyId?: 'partial-summary-v1' | 'claude-code-compact-v1'
  preCompressThreshold?: number
  reservedOutputBudget?: number
}

export interface ClaudeCompactTextBlock {
  type: 'text'
  text: string
}

export interface ClaudeCompactImageBlock {
  type: 'image'
  source: {
    type: 'base64' | 'url'
    mediaType?: string
    data?: string
    url?: string
    filePath?: string
  }
}

export interface ClaudeCompactImageErrorBlock {
  type: 'image_error'
  code?: 'timeout' | 'network' | 'request_aborted' | 'api_error' | 'unknown'
  message: string
}

export interface ClaudeCompactThinkingBlock {
  type: 'thinking'
  thinking: string
  encryptedContent?: string
  encryptedContentProvider?: 'anthropic' | 'openai-responses' | 'google'
  startedAt?: number
  completedAt?: number
}

export interface ClaudeCompactToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
  extraContent?: unknown
}

export interface ClaudeCompactToolResultBlock {
  type: 'tool_result'
  toolUseId: string
  content: string | Array<ClaudeCompactTextBlock | ClaudeCompactImageBlock>
  isError?: boolean
}

export interface ClaudeCompactAgentErrorBlock {
  type: 'agent_error'
  code: 'runtime_error' | 'tool_error' | 'unknown'
  message: string
  errorType?: string
  details?: string
  stackTrace?: string
}

export type ClaudeCompactContentBlock =
  | ClaudeCompactTextBlock
  | ClaudeCompactImageBlock
  | ClaudeCompactImageErrorBlock
  | ClaudeCompactThinkingBlock
  | ClaudeCompactToolUseBlock
  | ClaudeCompactToolResultBlock
  | ClaudeCompactAgentErrorBlock

export interface ClaudeCompactPartialRangeMeta {
  mode: 'from_up_to'
  anchorId: string
  from: number
  upTo: number
  tailStart: number
}

export interface ClaudeCompactBoundaryMeta {
  strategy?: string
  trigger: ClaudeCompactTrigger
  preTokens: number
  postTokens?: number
  messagesSummarized: number
  compactedAt?: number
  retryCount?: number
  compressedRange?: { start: number; end: number }
  preservedRange?: { start: number; end: number }
  partialRange?: ClaudeCompactPartialRangeMeta
  sourceMessageIds?: string[]
  sourceTokenEstimate?: number
  sourceRuntime?: ClaudeCompactSourceRuntime
  sourceSummaryId?: string
  relinkTargetIds?: string[]
  duplicateCompactionKey?: string
  compactGenerationId?: string
  safetyFlags?: string[]
  preservedSegment?: {
    headId: string
    anchorId: string
    tailId: string
  }
}

export interface ClaudeCompactSummaryMeta {
  messagesSummarized: number
  recentMessagesPreserved: boolean
}

export interface ClaudeCompactMessageMeta {
  compactBoundary?: ClaudeCompactBoundaryMeta
  compactSummary?: ClaudeCompactSummaryMeta
  postCompactState?: boolean
  [key: string]: unknown
}

export interface ClaudeCompactTokenUsage {
  inputTokens?: number
  outputTokens?: number
  contextTokens?: number
}

export interface ClaudeCompactMessage {
  id: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ClaudeCompactContentBlock[]
  createdAt: number
  usage?: ClaudeCompactTokenUsage
  providerResponseId?: string
  source?: string | null
  meta?: ClaudeCompactMessageMeta
}

export type ClaudeCompactSkipReason =
  | 'insufficient_messages'
  | 'insufficient_compressible_messages'
  | 'recent_payload_too_large'
  | 'single_input_too_large'
  | 'assistant_output_too_large'
  | 'unsafe_tool_boundary'
  | 'hard_context_limit_exceeded'
  | 'reserved_output_budget_exceeded'
  | 'summarizer_prompt_too_long'
  | 'summarizer_failed'
  | 'circuit_breaker_open'
  | 'unsafe_boundary'
  | 'unsafe_summary_output'
  | 'cancelled'
  | 'unknown'

export interface ClaudeCompactResult {
  compressed: boolean
  originalCount: number
  newCount: number
  messagesSummarized?: number
  payloadsCompacted?: number
  partialCompact?: boolean
  reason?: ClaudeCompactSkipReason
}

export interface RunClaudeCompactArgs {
  messages: ClaudeCompactMessage[]
  trigger: ClaudeCompactTrigger
  preTokens: number
  config?: ClaudeCompactConfig | null
  focusPrompt?: string
  postCompactContext?: string
  sourceRuntime?: ClaudeCompactSourceRuntime
  signal?: AbortSignal
  summarize: (args: {
    systemPrompt: string
    userPrompt: string
    signal?: AbortSignal
  }) => Promise<string>
  now?: () => number
  createId?: () => string
}

export interface RunClaudeCompactResult {
  messages: ClaudeCompactMessage[]
  result: ClaudeCompactResult
}
