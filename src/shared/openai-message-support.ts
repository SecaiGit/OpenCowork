export type OpenAIProtocol = 'chat-completions' | 'responses'

export type OpenAIMessageRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool'

export function supportsOpenAIImageParts(
  protocol: OpenAIProtocol,
  role: OpenAIMessageRole
): boolean {
  switch (protocol) {
    case 'chat-completions':
    case 'responses':
      return role === 'user'
  }
}

export function summarizeOpenAITextAndImages(textParts: string[], imageCount: number): string {
  const text = textParts
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n')
  const imageSummary =
    imageCount === 1
      ? '[1 image omitted because this OpenAI-compatible message role does not support image parts.]'
      : `[${imageCount} images omitted because this OpenAI-compatible message role does not support image parts.]`

  return text ? `${text}\n\n${imageSummary}` : imageSummary
}

export function assertOpenAIImagePartsSupported(
  protocol: OpenAIProtocol,
  role: OpenAIMessageRole,
  context: string
): void {
  if (supportsOpenAIImageParts(protocol, role)) return

  const endpoint = protocol === 'chat-completions' ? '/v1/chat/completions' : '/v1/responses'
  throw new Error(
    `Cannot serialize image content for ${context} with role "${role}" via ${endpoint}. ` +
      'This protocol only supports image parts in user messages.'
  )
}
