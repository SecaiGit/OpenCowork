import type {
  APIProvider,
  ProviderConfig,
  StreamEvent,
  ToolDefinition,
  UnifiedMessage,
  ContentBlock,
  TokenUsage
} from './types'
import { ipcStreamRequest, maskHeaders } from '../ipc/api-stream'
import { registerProvider } from './provider'
import { normalizeMessagesForAnthropicToolReplay } from '../../../../shared/anthropic-tool-replay'
import { sanitizeMessagesForToolReplay } from '../tools/tool-input-sanitizer'

function buildAnthropicCacheControl(): { type: 'ephemeral' } {
  return { type: 'ephemeral' }
}

const MAX_ANTHROPIC_CACHE_CONTROL_BLOCKS = 4

interface AnthropicCacheControlBudget {
  readonly remaining: number
  use(): { type: 'ephemeral' } | undefined
}

function createAnthropicCacheControlBudget(enabled: boolean): AnthropicCacheControlBudget {
  let remaining = enabled ? MAX_ANTHROPIC_CACHE_CONTROL_BLOCKS : 0

  return {
    get remaining() {
      return remaining
    },
    use() {
      if (remaining <= 0) return undefined
      remaining -= 1
      return buildAnthropicCacheControl()
    }
  }
}

function consumeAnthropicCacheControl(
  budget: AnthropicCacheControlBudget
): { cache_control: { type: 'ephemeral' } } | Record<string, never> {
  const cacheControl = budget.use()
  return cacheControl ? { cache_control: cacheControl } : {}
}

function isAnthropicCacheableContentBlock(block: ContentBlock): boolean {
  switch (block.type) {
    case 'text':
      return Boolean(block.text.trim())
    case 'tool_result':
    case 'image':
      return true
    default:
      return false
  }
}

function collectAnthropicMessageCacheTargets(
  messages: UnifiedMessage[],
  budget: AnthropicCacheControlBudget
): Set<string> {
  const targets = new Set<string>()
  let remaining = budget.remaining
  if (remaining <= 0) return targets

  for (
    let messageIndex = messages.length - 1;
    messageIndex >= 0 && remaining > 0;
    messageIndex -= 1
  ) {
    const content = messages[messageIndex].content
    if (typeof content === 'string') {
      if (content.trim()) {
        targets.add(`message:${messageIndex}`)
        remaining -= 1
      }
      continue
    }

    for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex -= 1) {
      if (!isAnthropicCacheableContentBlock(content[blockIndex])) continue
      targets.add(`block:${messageIndex}:${blockIndex}`)
      remaining -= 1
      break
    }
  }

  return targets
}

const MIN_ANTHROPIC_THINKING_BUDGET = 1024

function normalizeAnthropicThinkingBodyParams(
  bodyParams?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!bodyParams) return undefined

  const nextBodyParams: Record<string, unknown> = { ...bodyParams }
  const rawEnableThinking = nextBodyParams.enable_thinking
  delete nextBodyParams.enable_thinking

  if (!('thinking' in nextBodyParams) && typeof rawEnableThinking === 'boolean') {
    nextBodyParams.thinking = rawEnableThinking
      ? { type: 'enabled', budget_tokens: MIN_ANTHROPIC_THINKING_BUDGET }
      : { type: 'disabled' }
  }

  const thinking = nextBodyParams.thinking
  if (thinking && typeof thinking === 'object' && !Array.isArray(thinking)) {
    const normalizedThinking = { ...(thinking as Record<string, unknown>) }
    if (normalizedThinking.type === 'enabled' && normalizedThinking.budget_tokens === undefined) {
      normalizedThinking.budget_tokens = MIN_ANTHROPIC_THINKING_BUDGET
    }
    nextBodyParams.thinking = normalizedThinking
  }

  return nextBodyParams
}

function resolveAnthropicEffort(
  config: ProviderConfig
): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
  const levels = config.thinkingConfig?.reasoningEffortLevels
  if (!levels || levels.length === 0) return undefined

  const selected =
    config.reasoningEffort && levels.includes(config.reasoningEffort)
      ? config.reasoningEffort
      : (config.thinkingConfig?.defaultReasoningEffort ?? levels[0])

  switch (selected) {
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
      return selected
    default:
      return undefined
  }
}

function readNonNegativeNumber(value: unknown): number | undefined {
  const numericValue =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : undefined
  return numericValue != null && Number.isFinite(numericValue) && numericValue > 0
    ? Math.floor(numericValue)
    : undefined
}

function readTokenCount(value: unknown): number | undefined {
  const numericValue =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : undefined
  return numericValue != null && Number.isFinite(numericValue) && numericValue >= 0
    ? Math.floor(numericValue)
    : undefined
}

function readAnthropicThinkingBudgetFromBodyParams(
  bodyParams?: Record<string, unknown>
): number | undefined {
  const normalizedBodyParams = normalizeAnthropicThinkingBodyParams(bodyParams)
  const thinking = normalizedBodyParams?.thinking
  if (!thinking || typeof thinking !== 'object' || Array.isArray(thinking)) return undefined

  const budgetValue = (thinking as Record<string, unknown>).budget_tokens
  const budgetTokens =
    typeof budgetValue === 'number'
      ? budgetValue
      : typeof budgetValue === 'string'
        ? Number(budgetValue)
        : undefined

  return Number.isFinite(budgetTokens) && budgetTokens != null && budgetTokens > 0
    ? Math.floor(budgetTokens)
    : undefined
}

function readAnthropicThinkingBudget(config: ProviderConfig): number | undefined {
  if (!config.thinkingEnabled) return undefined

  return readAnthropicThinkingBudgetFromBodyParams(config.thinkingConfig?.bodyParams)
}

function resolveAnthropicMaxTokens(config: ProviderConfig): number {
  const configuredMaxTokens = Math.max(1, Math.floor(config.maxTokens ?? 32000))
  const thinkingBudget = readAnthropicThinkingBudget(config)
  return thinkingBudget != null
    ? Math.max(configuredMaxTokens, thinkingBudget + 1)
    : configuredMaxTokens
}

function buildAnthropicThinkingBodyParams(
  config: ProviderConfig
): Record<string, unknown> | undefined {
  const bodyParams = config.thinkingConfig?.bodyParams
  if (!config.thinkingEnabled || !bodyParams) return undefined

  return normalizeAnthropicThinkingBodyParams(bodyParams)
}

function buildAnthropicDisabledThinkingBodyParams(
  config: ProviderConfig
): Record<string, unknown> | undefined {
  const bodyParams = config.thinkingConfig?.disabledBodyParams
  if (config.thinkingEnabled || !bodyParams) return undefined
  return normalizeAnthropicThinkingBodyParams(bodyParams)
}

function normalizeAnthropicThinkingRequestBody(body: Record<string, unknown>): void {
  const normalized = normalizeAnthropicThinkingBodyParams(body)
  if (!normalized) return

  for (const key of Object.keys(body)) {
    delete body[key]
  }
  Object.assign(body, normalized)
}

function extractAnthropicCacheCreationUsage(
  usage: Record<string, unknown> | undefined
): Partial<TokenUsage> {
  if (!usage) return {}

  let cacheCreation: Record<string, unknown> | undefined
  if (usage.cache_creation && typeof usage.cache_creation === 'object') {
    cacheCreation = usage.cache_creation as Record<string, unknown>
  } else if (usage.cacheCreation && typeof usage.cacheCreation === 'object') {
    cacheCreation = usage.cacheCreation as Record<string, unknown>
  }

  const cacheCreation5mTokens = readNonNegativeNumber(
    cacheCreation?.ephemeral_5m_input_tokens ??
      cacheCreation?.ephemeral5mInputTokens ??
      usage.cache_creation_5m_input_tokens ??
      usage.cacheCreation5mTokens
  )
  const cacheCreation1hTokens = readNonNegativeNumber(
    cacheCreation?.ephemeral_1h_input_tokens ??
      cacheCreation?.ephemeral1hInputTokens ??
      usage.cache_creation_1h_input_tokens ??
      usage.cacheCreation1hTokens
  )

  if (cacheCreation5mTokens != null || cacheCreation1hTokens != null) {
    const total = (cacheCreation5mTokens ?? 0) + (cacheCreation1hTokens ?? 0)
    return {
      ...(total > 0 ? { cacheCreationTokens: total } : {}),
      ...(cacheCreation5mTokens != null ? { cacheCreation5mTokens } : {}),
      ...(cacheCreation1hTokens != null ? { cacheCreation1hTokens } : {})
    }
  }

  const cacheCreationTokens = readNonNegativeNumber(
    usage.cache_creation_input_tokens ?? usage.cache_creation_tokens ?? usage.cacheCreationTokens
  )
  return cacheCreationTokens != null
    ? {
        cacheCreationTokens,
        cacheCreation5mTokens: cacheCreationTokens
      }
    : {}
}

function mergeAnthropicUsage(target: TokenUsage, usage: Record<string, unknown> | undefined): void {
  if (!usage) return

  const outputTokens = readTokenCount(
    usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens
  )
  if (outputTokens !== undefined) {
    target.outputTokens = outputTokens
  }

  const cacheCreationUsage = extractAnthropicCacheCreationUsage(usage)
  Object.assign(target, cacheCreationUsage)

  const inputTokenDetails =
    usage.input_tokens_details && typeof usage.input_tokens_details === 'object'
      ? (usage.input_tokens_details as Record<string, unknown>)
      : undefined
  const outputTokenDetails =
    usage.output_tokens_details && typeof usage.output_tokens_details === 'object'
      ? (usage.output_tokens_details as Record<string, unknown>)
      : undefined

  const cacheReadTokens = readTokenCount(
    usage.cache_read_input_tokens ??
      usage.cache_read_tokens ??
      usage.cacheReadTokens ??
      inputTokenDetails?.cached_tokens
  )
  if (cacheReadTokens !== undefined && cacheReadTokens > 0) {
    target.cacheReadTokens = cacheReadTokens
  }

  const uncachedInputTokens = readTokenCount(
    usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens
  )
  const cacheCreationTokens =
    cacheCreationUsage.cacheCreationTokens ??
    (cacheCreationUsage.cacheCreation5mTokens ?? 0) +
      (cacheCreationUsage.cacheCreation1hTokens ?? 0)
  const cachedInputTokens = (cacheCreationTokens ?? 0) + (cacheReadTokens ?? 0)
  if (uncachedInputTokens !== undefined || cachedInputTokens > 0) {
    const totalInputTokens = (uncachedInputTokens ?? 0) + cachedInputTokens
    target.inputTokens = totalInputTokens
    target.contextTokens = totalInputTokens
    if (cachedInputTokens > 0) {
      target.billableInputTokens = uncachedInputTokens ?? 0
    }
  }

  const reasoningTokens = readTokenCount(
    usage.reasoning_tokens ?? usage.reasoningTokens ?? outputTokenDetails?.reasoning_tokens
  )
  if (reasoningTokens !== undefined && reasoningTokens > 0) {
    target.reasoningTokens = reasoningTokens
  }
}

class AnthropicProvider implements APIProvider {
  readonly name = 'Anthropic Messages'
  readonly type = 'anthropic' as const

  async *sendMessage(
    messages: UnifiedMessage[],
    tools: ToolDefinition[],
    config: ProviderConfig,
    signal?: AbortSignal
  ): AsyncIterable<StreamEvent> {
    const requestStartedAt = Date.now()
    let firstTokenAt: number | null = null
    let outputTokens = 0
    const promptCacheEnabled = config.enablePromptCache !== false
    const systemPromptCacheEnabled = config.enableSystemPromptCache !== false
    const thinkingBodyParams = buildAnthropicThinkingBodyParams(config)
    const disabledThinkingBodyParams = buildAnthropicDisabledThinkingBodyParams(config)
    const cacheBudget = createAnthropicCacheControlBudget(
      promptCacheEnabled || systemPromptCacheEnabled
    )
    const system = config.systemPrompt
      ? [
          {
            type: 'text',
            text: config.systemPrompt,
            ...(systemPromptCacheEnabled && config.systemPrompt.trim()
              ? consumeAnthropicCacheControl(cacheBudget)
              : {})
          }
        ]
      : undefined
    const formattedTools =
      tools.length > 0 ? this.formatTools(tools, promptCacheEnabled, cacheBudget) : undefined
    const body: Record<string, unknown> = {
      model: config.model,
      max_tokens: resolveAnthropicMaxTokens(config),
      ...(system ? { system } : {}),
      messages: this.formatMessages(
        this.normalizeMessagesForAnthropic(sanitizeMessagesForToolReplay(messages)),
        promptCacheEnabled,
        cacheBudget
      ),
      ...(tools.length > 0 ? { tools: formattedTools, tool_choice: { type: 'auto' } } : {}),
      stream: true
    }

    if (config.thinkingEnabled && config.thinkingConfig) {
      if (thinkingBodyParams) Object.assign(body, thinkingBodyParams)
      if (config.thinkingConfig.forceTemperature !== undefined) {
        body.temperature = config.thinkingConfig.forceTemperature
      }
    } else if (disabledThinkingBodyParams) {
      Object.assign(body, disabledThinkingBodyParams)
    }

    const effort = resolveAnthropicEffort(config)
    if (effort) {
      body.output_config = {
        ...(typeof body.output_config === 'object' && body.output_config !== null
          ? (body.output_config as Record<string, unknown>)
          : {}),
        effort
      }
    }

    normalizeAnthropicThinkingRequestBody(body)
    body.max_tokens = resolveAnthropicMaxTokens(config)

    const baseUrl = (config.baseUrl || 'https://api.anthropic.com').trim().replace(/\/+$/, '')
    const url = `${baseUrl}/v1/messages`

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31,interleaved-thinking-2025-05-14'
    }
    if (config.userAgent) headers['User-Agent'] = config.userAgent
    const bodyStr = JSON.stringify(body)

    yield {
      type: 'request_debug',
      debugInfo: {
        url,
        method: 'POST',
        headers: maskHeaders(headers),
        body: bodyStr,
        timestamp: Date.now()
      }
    }

    const toolBuffersByBlockIndex = new Map<number, string[]>()
    const toolCallsByBlockIndex = new Map<number, { id: string; name: string }>()
    const emittedThinkingEncrypted = new Set<string>()

    const tryBuildThinkingEncryptedEvent = (encryptedContent: unknown): StreamEvent | null => {
      if (typeof encryptedContent !== 'string') return null
      const trimmed = encryptedContent.trim()
      if (!trimmed || emittedThinkingEncrypted.has(trimmed)) return null
      emittedThinkingEncrypted.add(trimmed)
      return {
        type: 'thinking_encrypted',
        thinkingEncryptedContent: trimmed,
        thinkingEncryptedProvider: 'anthropic'
      }
    }

    const pendingUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
    let pendingStopReason: string | undefined
    let messageEndEmitted = false
    let sawMessageEvent = false

    const flushToolCalls = function* (): Iterable<StreamEvent> {
      if (toolCallsByBlockIndex.size === 0) return

      for (const [blockIndex, toolCall] of toolCallsByBlockIndex) {
        const raw = (toolBuffersByBlockIndex.get(blockIndex)?.join('') ?? '').trim()
        let parsed: Record<string, unknown> = {}
        if (raw) {
          try {
            parsed = JSON.parse(raw) as Record<string, unknown>
          } catch {
            parsed = {}
          }
        }
        yield {
          type: 'tool_call_end',
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          toolCallInput: parsed
        }
      }
      toolCallsByBlockIndex.clear()
      toolBuffersByBlockIndex.clear()
    }

    const buildMessageEndEvent = (): StreamEvent => {
      const requestCompletedAt = Date.now()
      outputTokens = pendingUsage.outputTokens
      messageEndEmitted = true
      return {
        type: 'message_end',
        stopReason: pendingStopReason,
        usage: { ...pendingUsage },
        timing: {
          totalMs: requestCompletedAt - requestStartedAt,
          ttftMs: firstTokenAt ? firstTokenAt - requestStartedAt : undefined,
          tps: computeTps(outputTokens, firstTokenAt, requestCompletedAt)
        }
      }
    }

    for await (const sse of ipcStreamRequest({
      url,
      method: 'POST',
      headers,
      body: bodyStr,
      signal,
      allowInsecureTls: config.allowInsecureTls ?? true,
      providerId: config.providerId,
      providerBuiltinId: config.providerBuiltinId,
      accountId: config.accountId
    })) {
      if (!sse.data || sse.data === '[DONE]') continue
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let data: any
      try {
        data = JSON.parse(sse.data)
      } catch {
        continue
      }

      const hasUsagePayload = Boolean(data.message?.usage || data.usage)
      if (hasUsagePayload) {
        mergeAnthropicUsage(pendingUsage, data.message?.usage)
        mergeAnthropicUsage(pendingUsage, data.usage)
        outputTokens = pendingUsage.outputTokens
        sawMessageEvent = true
      }

      const eventType = sse.event ?? data.type
      switch (eventType) {
        case 'message_start': {
          sawMessageEvent = true
          yield { type: 'message_start' }
          break
        }

        case 'content_block_start': {
          sawMessageEvent = true
          const blockIndex = Number.isFinite(data.index) ? Number(data.index) : -1
          if (data.content_block.type === 'tool_use' && blockIndex >= 0) {
            toolBuffersByBlockIndex.set(blockIndex, [])
            toolCallsByBlockIndex.set(blockIndex, {
              id: data.content_block.id,
              name: data.content_block.name
            })
            yield {
              type: 'tool_call_start',
              toolCallId: data.content_block.id,
              toolName: data.content_block.name
            }
          } else if (data.content_block.type === 'thinking') {
            const thinkingEncryptedEvent = tryBuildThinkingEncryptedEvent(
              data.content_block.signature ?? data.content_block.encrypted_content
            )
            if (thinkingEncryptedEvent) {
              yield thinkingEncryptedEvent
            }
          }
          break
        }

        case 'content_block_delta': {
          sawMessageEvent = true
          const blockIndex = Number.isFinite(data.index) ? Number(data.index) : -1
          if (firstTokenAt === null) firstTokenAt = Date.now()
          if (data.delta.type === 'text_delta') {
            yield { type: 'text_delta', text: data.delta.text }
          } else if (data.delta.type === 'thinking_delta') {
            yield { type: 'thinking_delta', thinking: data.delta.thinking }
          } else if (data.delta.type === 'signature_delta') {
            const thinkingEncryptedEvent = tryBuildThinkingEncryptedEvent(
              data.delta.signature ?? data.delta.encrypted_content
            )
            if (thinkingEncryptedEvent) {
              yield thinkingEncryptedEvent
            }
          } else if (data.delta.type === 'input_json_delta' && blockIndex >= 0) {
            let chunks = toolBuffersByBlockIndex.get(blockIndex)
            if (!chunks) {
              chunks = []
              toolBuffersByBlockIndex.set(blockIndex, chunks)
            }
            chunks.push(data.delta.partial_json)
            const toolCall = toolCallsByBlockIndex.get(blockIndex)
            yield {
              type: 'tool_call_delta',
              toolCallId: toolCall?.id,
              argumentsDelta: data.delta.partial_json
            }
          }
          break
        }

        case 'content_block_stop': {
          sawMessageEvent = true
          const blockIndex = Number.isFinite(data.index) ? Number(data.index) : -1
          const toolCall = blockIndex >= 0 ? toolCallsByBlockIndex.get(blockIndex) : undefined
          if (toolCall) {
            const raw = (toolBuffersByBlockIndex.get(blockIndex)?.join('') ?? '').trim()
            if (raw) {
              try {
                yield {
                  type: 'tool_call_end',
                  toolCallId: toolCall.id,
                  toolName: toolCall.name,
                  toolCallInput: JSON.parse(raw)
                }
              } catch {
                yield {
                  type: 'tool_call_end',
                  toolCallId: toolCall.id,
                  toolName: toolCall.name,
                  toolCallInput: {}
                }
              }
            } else {
              yield {
                type: 'tool_call_end',
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                toolCallInput: {}
              }
            }
            toolBuffersByBlockIndex.delete(blockIndex)
            toolCallsByBlockIndex.delete(blockIndex)
          }
          break
        }

        case 'message_delta': {
          sawMessageEvent = true
          for (const event of flushToolCalls()) {
            yield event
          }
          pendingStopReason = data.delta?.stop_reason ?? pendingStopReason
          break
        }

        case 'message_stop': {
          sawMessageEvent = true
          for (const event of flushToolCalls()) {
            yield event
          }
          pendingStopReason = data.stop_reason ?? data.delta?.stop_reason ?? pendingStopReason
          break
        }

        case 'error':
          messageEndEmitted = true
          yield { type: 'error', error: data.error }
          break
      }
    }

    if (!messageEndEmitted && sawMessageEvent) {
      for (const event of flushToolCalls()) {
        yield event
      }
      yield buildMessageEndEvent()
    }
  }

  formatMessages(
    messages: UnifiedMessage[],
    promptCacheEnabled = false,
    cacheBudget = createAnthropicCacheControlBudget(false)
  ): unknown[] {
    const filteredMessages = messages.filter((m) => m.role !== 'system')
    const cacheTargets = promptCacheEnabled
      ? collectAnthropicMessageCacheTargets(filteredMessages, cacheBudget)
      : new Set<string>()

    return filteredMessages.map((m, messageIndex) => {
      if (typeof m.content === 'string') {
        if (!cacheTargets.has(`message:${messageIndex}`)) {
          return { role: m.role, content: m.content }
        }

        return {
          role: m.role,
          content: [
            {
              type: 'text',
              text: m.content,
              ...consumeAnthropicCacheControl(cacheBudget)
            }
          ]
        }
      }

      const blocks = m.content as ContentBlock[]
      return {
        role: m.role === 'tool' ? 'user' : m.role,
        content: blocks.map((b, blockIndex) => {
          const shouldCache = cacheTargets.has(`block:${messageIndex}:${blockIndex}`)
          switch (b.type) {
            case 'thinking':
              return {
                type: 'thinking',
                thinking: b.thinking,
                ...(b.encryptedContent &&
                (b.encryptedContentProvider === 'anthropic' || !b.encryptedContentProvider)
                  ? { signature: b.encryptedContent }
                  : {})
              }
            case 'text':
              return {
                type: 'text',
                text: b.text,
                ...(shouldCache ? consumeAnthropicCacheControl(cacheBudget) : {})
              }
            case 'tool_use':
              return { type: 'tool_use', id: b.id, name: b.name, input: b.input }
            case 'tool_result': {
              let formattedContent: unknown = b.content
              if (Array.isArray(b.content)) {
                formattedContent = b.content.map((cb) => {
                  if (cb.type === 'image') {
                    return {
                      type: 'image',
                      source: {
                        type: cb.source.type,
                        media_type: cb.source.mediaType,
                        data: cb.source.data
                      }
                    }
                  }
                  return cb
                })
              }
              return {
                type: 'tool_result',
                tool_use_id: b.toolUseId,
                content: formattedContent,
                ...(b.isError ? { is_error: true } : {}),
                ...(shouldCache ? consumeAnthropicCacheControl(cacheBudget) : {})
              }
            }
            case 'image':
              return {
                type: 'image',
                source: {
                  type: b.source.type,
                  media_type: b.source.mediaType,
                  data: b.source.data,
                  ...(b.source.url ? { url: b.source.url } : {})
                },
                ...(shouldCache ? consumeAnthropicCacheControl(cacheBudget) : {})
              }
            default:
              return { type: 'text', text: '[unsupported block]' }
          }
        })
      }
    })
  }

  private normalizeMessagesForAnthropic(messages: UnifiedMessage[]): UnifiedMessage[] {
    return normalizeMessagesForAnthropicToolReplay(messages)
  }

  formatTools(
    tools: ToolDefinition[],
    promptCacheEnabled = false,
    cacheBudget = createAnthropicCacheControlBudget(false)
  ): unknown[] {
    return tools.map((t, index) => ({
      name: t.name,
      description: t.description,
      input_schema: this.normalizeToolSchema(t.inputSchema),
      ...(promptCacheEnabled && index === tools.length - 1
        ? consumeAnthropicCacheControl(cacheBudget)
        : {})
    }))
  }

  private normalizeToolSchema(schema: ToolDefinition['inputSchema']): Record<string, unknown> {
    if ('properties' in schema) return schema

    const mergedProperties: Record<string, unknown> = {}
    let requiredIntersection: string[] | null = null

    for (const variant of schema.oneOf) {
      for (const [key, value] of Object.entries(variant.properties ?? {})) {
        if (!(key in mergedProperties)) mergedProperties[key] = value
      }

      const required = variant.required ?? []
      if (requiredIntersection === null) {
        requiredIntersection = [...required]
      } else {
        requiredIntersection = requiredIntersection.filter((key) => required.includes(key))
      }
    }

    const normalized: Record<string, unknown> = {
      type: 'object',
      properties: mergedProperties,
      additionalProperties: false
    }

    if (requiredIntersection && requiredIntersection.length > 0) {
      normalized.required = requiredIntersection
    }

    return normalized
  }
}

export function registerAnthropicProvider(): void {
  registerProvider('anthropic', () => new AnthropicProvider())
}

function computeTps(
  outputTokens: number,
  firstTokenAt: number | null,
  completedAt: number
): number | undefined {
  if (!firstTokenAt || outputTokens <= 0) return undefined
  const durationMs = completedAt - firstTokenAt
  if (durationMs <= 0) return undefined
  return outputTokens / (durationMs / 1000)
}
