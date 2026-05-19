import type {
  APIProvider,
  ImageErrorCode,
  ProviderConfig,
  StreamEvent,
  ToolDefinition,
  UnifiedMessage,
  ContentBlock,
  ImageBlock
} from './types'
import {
  generateImagesFromText,
  editImageWithPrompt,
  OpenAIImagesRequestError,
  type Base64ImageInput,
  type GeneratedImage
} from './openai-images'
import { registerProvider } from './provider'
import { ipcClient } from '../ipc/ipc-client'
import { IPC } from '../ipc/channels'
import { isUserAuthoredMessage } from '../agent/context-message-classification'

function normalizeImageProviderError(error: unknown): { code: ImageErrorCode; message: string } {
  if (error instanceof OpenAIImagesRequestError) {
    return {
      code: error.code,
      message: error.message
    }
  }

  if (error instanceof TypeError) {
    return {
      code: 'network',
      message: `Network request failed while generating image. ${error.message}`
    }
  }

  return {
    code: 'unknown',
    message: error instanceof Error ? error.message : String(error)
  }
}

async function persistGeneratedImage(image: GeneratedImage): Promise<ImageBlock> {
  const fallback: ImageBlock = {
    type: 'image',
    source:
      image.sourceType === 'base64'
        ? { type: 'base64', mediaType: image.mediaType, data: image.data }
        : { type: 'url', url: image.data }
  }

  try {
    const result = (await ipcClient.invoke(IPC.IMAGE_PERSIST_GENERATED, {
      ...(image.sourceType === 'base64'
        ? { data: image.data, mediaType: image.mediaType }
        : { url: image.data })
    })) as {
      filePath?: string
      mediaType?: string
      data?: string
      error?: string
    }

    if (result?.error || !result?.data) {
      if (result?.error) {
        console.warn('[OpenAI Images Provider] Failed to persist generated image:', result.error)
      }
      return fallback
    }

    return {
      type: 'image',
      source: {
        type: 'base64',
        mediaType: result.mediaType || image.mediaType || 'image/png',
        data: result.data,
        filePath: result.filePath
      }
    }
  } catch (error) {
    console.warn('[OpenAI Images Provider] Failed to persist generated image:', error)
    return fallback
  }
}

export function findOpenAIImagesPromptMessage(
  messages: UnifiedMessage[]
): UnifiedMessage | undefined {
  return [...messages].reverse().find((message) => isUserAuthoredMessage(message))
}

class OpenAIImagesProvider implements APIProvider {
  readonly name = 'OpenAI Images'
  readonly type = 'openai-images' as const

  async *sendMessage(
    messages: UnifiedMessage[],
    _tools: ToolDefinition[],
    config: ProviderConfig,
    signal?: AbortSignal
  ): AsyncIterable<StreamEvent> {
    const requestStartedAt = Date.now()

    console.log('[OpenAI Images Provider] sendMessage called with config:', {
      type: config.type,
      model: config.model,
      baseUrl: config.baseUrl
    })

    try {
      yield { type: 'message_start' }

      // Extract the latest user-authored message, ignoring generated compression context.
      const lastUserMessage = findOpenAIImagesPromptMessage(messages)
      if (!lastUserMessage) {
        throw new Error('No user message found')
      }

      // Extract text prompt and check for images
      let textPrompt = ''
      let imageInput: Base64ImageInput | null = null

      if (typeof lastUserMessage.content === 'string') {
        textPrompt = lastUserMessage.content
      } else {
        const contentBlocks = lastUserMessage.content as ContentBlock[]
        for (const block of contentBlocks) {
          if (block.type === 'text') {
            textPrompt += block.text
          } else if (block.type === 'image' && !imageInput) {
            // Use the first image for editing
            const imgBlock = block as ImageBlock
            if (imgBlock.source.type === 'base64') {
              imageInput = {
                dataUrl: `data:${imgBlock.source.mediaType || 'image/png'};base64,${imgBlock.source.data}`,
                mediaType: imgBlock.source.mediaType
              }
            } else if (imgBlock.source.type === 'url' && imgBlock.source.url) {
              // For URL images, we'd need to fetch and convert to base64
              // For now, skip URL images
              continue
            }
          }
        }
      }

      if (!textPrompt.trim()) {
        textPrompt = 'Edit this image'
      }

      // Call appropriate API based on whether we have an image
      let results
      if (imageInput) {
        // Image editing - no text delta, just generate
        results = await editImageWithPrompt({
          config,
          prompt: textPrompt,
          image: imageInput,
          signal
        })
      } else {
        // Text-to-image generation - no text delta, just generate
        results = await generateImagesFromText({
          config,
          prompt: textPrompt,
          signal
        })
      }

      // Yield each generated image as an image_generated event
      for (const img of results) {
        const imageBlock = await persistGeneratedImage(img)
        yield { type: 'image_generated', imageBlock }
      }

      // Yield completion event with image results
      const requestCompletedAt = Date.now()
      yield {
        type: 'message_end',
        stopReason: 'stop',
        timing: {
          totalMs: requestCompletedAt - requestStartedAt,
          ttftMs: requestCompletedAt - requestStartedAt
        }
      }
    } catch (error) {
      const normalizedError = normalizeImageProviderError(error)
      console.error('[OpenAI Images Provider] Error:', normalizedError.message, error)

      // Yield a structured image error so UI can render a friendly card
      yield {
        type: 'image_error',
        imageError: {
          code: normalizedError.code,
          message: normalizedError.message
        }
      }

      const requestCompletedAt = Date.now()
      yield {
        type: 'message_end',
        stopReason: 'error',
        timing: {
          totalMs: requestCompletedAt - requestStartedAt,
          ttftMs: requestCompletedAt - requestStartedAt
        }
      }

      return
    }
  }

  formatMessages(messages: UnifiedMessage[]): unknown {
    void messages
    return []
  }

  formatTools(tools: ToolDefinition[]): unknown {
    void tools
    return []
  }
}

export function registerOpenAIImagesProvider(): void {
  registerProvider('openai-images', () => new OpenAIImagesProvider())
}
