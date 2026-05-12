type ReplayContentBlock = {
  type?: unknown
  id?: unknown
  toolUseId?: unknown
}

type ReplayMessage<TBlock extends ReplayContentBlock> = {
  id: string
  role: string
  content: string | TBlock[]
}

type ToolUseLikeBlock<TBlock extends ReplayContentBlock> = TBlock & {
  type: 'tool_use'
  id: string
}

type ToolResultLikeBlock<TBlock extends ReplayContentBlock> = TBlock & {
  type: 'tool_result'
  toolUseId: string
}

function isToolUseBlock<TBlock extends ReplayContentBlock>(
  block: TBlock
): block is ToolUseLikeBlock<TBlock> {
  return block.type === 'tool_use' && typeof block.id === 'string' && block.id.length > 0
}

function isToolResultBlock<TBlock extends ReplayContentBlock>(
  block: TBlock
): block is ToolResultLikeBlock<TBlock> {
  return (
    block.type === 'tool_result' &&
    typeof block.toolUseId === 'string' &&
    block.toolUseId.length > 0
  )
}

function isReplayCarrierRole(role: string): boolean {
  return role === 'user' || role === 'tool'
}

function withContent<TBlock extends ReplayContentBlock, TMessage extends ReplayMessage<TBlock>>(
  message: TMessage,
  content: string | TBlock[],
  overrides?: Partial<ReplayMessage<TBlock>>
): TMessage {
  return { ...message, ...overrides, content } as TMessage
}

function hasArrayContent<TBlock extends ReplayContentBlock>(
  content: string | TBlock[]
): content is TBlock[] {
  return Array.isArray(content)
}

function hasReplayableContent<TBlock extends ReplayContentBlock>(
  content: string | TBlock[]
): boolean {
  return typeof content === 'string' ? content.length > 0 : content.length > 0
}

function buildSyntheticId(baseId: string, counter: number): string {
  return `${baseId}::anthropic-replay-${counter}`
}

/**
 * Anthropic requires every assistant tool_use block to be followed by a user
 * message that contains the matching tool_result blocks. This normalizer repairs
 * split or malformed replay history right before send.
 */
export function normalizeMessagesForAnthropicToolReplay<
  TBlock extends ReplayContentBlock,
  TMessage extends ReplayMessage<TBlock>
>(messages: TMessage[]): TMessage[] {
  const normalized: TMessage[] = []
  let changed = false
  let syntheticIdCounter = 0

  for (let index = 0; index < messages.length; ) {
    const message = messages[index]

    if (
      message.role !== 'assistant' ||
      !hasArrayContent<TBlock>(message.content) ||
      message.content.length === 0
    ) {
      if (!hasArrayContent<TBlock>(message.content)) {
        normalized.push(message)
        index += 1
        continue
      }

      const residualBlocks = message.content.filter((block) => {
        if (message.role !== 'assistant' && isToolUseBlock(block)) {
          changed = true
          return false
        }
        if (isToolResultBlock(block)) {
          changed = true
          return false
        }
        return true
      })

      if (residualBlocks.length === message.content.length) {
        normalized.push(message)
      } else if (residualBlocks.length > 0) {
        normalized.push(withContent(message, residualBlocks))
      }

      index += 1
      continue
    }

    const toolUses = message.content.filter((block) => isToolUseBlock(block))
    if (toolUses.length === 0) {
      const assistantBlocks = message.content.filter((block) => {
        if (isToolResultBlock(block)) {
          changed = true
          return false
        }
        return true
      })

      if (assistantBlocks.length === message.content.length) {
        normalized.push(message)
      } else if (assistantBlocks.length > 0) {
        normalized.push(withContent(message, assistantBlocks))
      }

      index += 1
      continue
    }

    const toolUseIds = new Set(toolUses.map((block) => block.id))
    const pairedToolResults = new Map<string, ToolResultLikeBlock<TBlock>>()
    const replayWindow: Array<{
      message: TMessage
      residualContent: string | TBlock[] | null
    }> = []

    let cursor = index + 1
    while (cursor < messages.length && isReplayCarrierRole(messages[cursor].role)) {
      const candidate = messages[cursor]
      if (!hasArrayContent<TBlock>(candidate.content)) {
        replayWindow.push({ message: candidate, residualContent: candidate.content })
        cursor += 1
        continue
      }

      const residualBlocks: TBlock[] = []
      for (const block of candidate.content) {
        if (isToolResultBlock(block)) {
          if (toolUseIds.has(block.toolUseId) && !pairedToolResults.has(block.toolUseId)) {
            pairedToolResults.set(block.toolUseId, block)
          } else {
            changed = true
          }
          continue
        }

        if (isToolUseBlock(block)) {
          changed = true
          continue
        }

        residualBlocks.push(block)
      }

      if (residualBlocks.length !== candidate.content.length) changed = true
      replayWindow.push({
        message: candidate,
        residualContent: residualBlocks.length > 0 ? residualBlocks : null
      })
      cursor += 1
    }

    const keptToolUseIds = new Set(
      toolUses.map((block) => block.id).filter((toolUseId) => pairedToolResults.has(toolUseId))
    )
    const assistantBlocks = message.content.filter((block) => {
      if (isToolUseBlock(block)) {
        const keep = keptToolUseIds.has(block.id)
        if (!keep) changed = true
        return keep
      }
      if (isToolResultBlock(block)) {
        changed = true
        return false
      }
      return true
    })

    if (assistantBlocks.length > 0) {
      if (
        assistantBlocks.length === message.content.length &&
        keptToolUseIds.size === toolUses.length
      ) {
        normalized.push(message)
      } else {
        normalized.push(withContent(message, assistantBlocks))
      }
    }

    if (keptToolUseIds.size > 0 && replayWindow.length > 0) {
      const firstReplayMessage = replayWindow[0].message
      const orderedToolResults = toolUses
        .map((block) => pairedToolResults.get(block.id))
        .filter((block): block is ToolResultLikeBlock<TBlock> => Boolean(block))

      normalized.push(
        withContent(firstReplayMessage, orderedToolResults as TBlock[], {
          role: 'user' as TMessage['role']
        })
      )
    }

    replayWindow.forEach((entry, replayIndex) => {
      const { message: replayMessage, residualContent } = entry
      if (!residualContent || !hasReplayableContent(residualContent)) return

      if (replayIndex === 0 && keptToolUseIds.size > 0) {
        syntheticIdCounter += 1
        normalized.push(
          withContent(replayMessage, residualContent, {
            id: buildSyntheticId(replayMessage.id, syntheticIdCounter) as TMessage['id']
          })
        )
        changed = true
        return
      }

      if (residualContent === replayMessage.content) {
        normalized.push(replayMessage)
      } else {
        normalized.push(withContent(replayMessage, residualContent))
      }
    })

    index = cursor
  }

  return changed ? normalized : messages
}
