import type { ContentBlock, UnifiedMessage } from '../api/types'
import type { Session } from '../../stores/chat-store'
import { getBillableInputTokens, getBillableTotalTokens } from '../format-tokens'
import { parseSystemCommandTag } from '../commands/system-command'
import {
  isCompactSummaryContextMessage,
  isGeneratedContextUserMessage
} from '../agent/context-message-classification'

function formatTextContent(text: string): string {
  const parsed = parseSystemCommandTag(text)
  if (!parsed) return text

  const parts = [`**System Command: \`/${parsed.command.name}\`**`]
  if (parsed.command.content) {
    parts.push(parsed.command.content)
  }
  if (parsed.remainingText) {
    parts.push(parsed.remainingText)
  }
  return parts.join('\n\n')
}

function contentToMarkdown(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return formatTextContent(content)

  return content
    .map((block) => {
      switch (block.type) {
        case 'text':
          return formatTextContent(block.text)
        case 'tool_use': {
          if (block.name === 'Task') {
            const inp = block.input as Record<string, unknown>
            const subType = String(inp.subagent_type ?? '?')
            const desc = String(inp.description ?? inp.prompt ?? '')
            return `**🧠 Task: \`${subType}\`** — ${desc}`
          }
          return `**Tool Call: \`${block.name}\`**\n\`\`\`json\n${JSON.stringify(block.input, null, 2)}\n\`\`\``
        }
        case 'tool_result': {
          let contentStr: string
          if (Array.isArray(block.content)) {
            const parts = block.content.map((cb) =>
              cb.type === 'text'
                ? cb.text
                : cb.type === 'image'
                  ? `[Image: ${cb.source.mediaType}]`
                  : ''
            )
            contentStr = parts.join('\n') || '[Image]'
          } else {
            contentStr = block.content
          }
          return `**Tool Result** (${block.isError ? 'error' : 'success'}):\n\`\`\`\n${contentStr}\n\`\`\``
        }
        default:
          return ''
      }
    })
    .filter(Boolean)
    .join('\n\n')
}

function isExportableMessage(message: UnifiedMessage): boolean {
  if (message.role === 'system') return false
  return !isGeneratedContextUserMessage(message) || isCompactSummaryContextMessage(message)
}

function getExportLabel(message: UnifiedMessage): string {
  if (isCompactSummaryContextMessage(message)) return '## Context Compression'
  return message.role === 'user' ? '## User' : '## Assistant'
}

export function sessionToMarkdown(session: Session): string {
  const lines: string[] = []
  const exportableMessages = session.messages.filter(isExportableMessage)
  lines.push(`# ${session.title}`)
  lines.push('')
  lines.push(`- **Mode**: ${session.mode}`)
  lines.push(`- **Messages**: ${exportableMessages.length}`)
  lines.push(`- **Created**: ${new Date(session.createdAt).toLocaleString()}`)
  lines.push(`- **Updated**: ${new Date(session.updatedAt).toLocaleString()}`)
  if (session.workingFolder) {
    lines.push(`- **Working Folder**: \`${session.workingFolder}\``)
  }
  if (session.pinned) {
    lines.push(`- **Pinned**: Yes`)
  }
  lines.push('')
  lines.push('---')
  lines.push('')

  for (const msg of exportableMessages) {
    const label = getExportLabel(msg)
    const time = new Date(msg.createdAt).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    })
    lines.push(`${label} <sub>${time}</sub>`)
    lines.push('')
    lines.push(contentToMarkdown(msg.content))
    if (msg.usage) {
      lines.push('')
      const extras: string[] = []
      if (msg.usage.cacheReadTokens) extras.push(`${msg.usage.cacheReadTokens} cached`)
      if (msg.usage.reasoningTokens) extras.push(`${msg.usage.reasoningTokens} reasoning`)
      lines.push(
        `<sub>Tokens: ${getBillableInputTokens(msg.usage)} in / ${msg.usage.outputTokens} out${extras.length > 0 ? ` / ${extras.join(' / ')}` : ''}</sub>`
      )
    }
    lines.push('')
  }

  // Total token usage summary
  const totals = session.messages.reduce(
    (acc, m) => {
      if (m.usage) {
        acc.input += getBillableInputTokens(m.usage)
        acc.output += m.usage.outputTokens
        if (m.usage.cacheReadTokens) acc.cacheRead += m.usage.cacheReadTokens
        if (m.usage.cacheCreationTokens) acc.cacheCreation += m.usage.cacheCreationTokens
        if (m.usage.reasoningTokens) acc.reasoning += m.usage.reasoningTokens
      }
      return acc
    },
    { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, reasoning: 0 }
  )
  if (totals.input + totals.output > 0) {
    lines.push('---')
    lines.push('')
    const totalExtras: string[] = []
    if (totals.cacheRead > 0) totalExtras.push(`${totals.cacheRead} cache read`)
    if (totals.cacheCreation > 0) totalExtras.push(`${totals.cacheCreation} cache write`)
    if (totals.reasoning > 0) totalExtras.push(`${totals.reasoning} reasoning`)
    lines.push(
      `**Total tokens**: ${getBillableTotalTokens({ inputTokens: totals.input, outputTokens: totals.output, billableInputTokens: totals.input })} (${totals.input} input + ${totals.output} output${totalExtras.length > 0 ? ` | ${totalExtras.join(', ')}` : ''})`
    )
    lines.push('')
  }

  return lines.join('\n')
}
