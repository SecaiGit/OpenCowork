import { parseSlashCommandInput } from '@renderer/lib/commands/system-command'

export interface ManualCompactCommand {
  focusPrompt?: string
}

export function parseManualCompactCommand(text: string): ManualCompactCommand | null {
  const parsed = parseSlashCommandInput(text)
  if (!parsed) return null
  if (parsed.commandName.trim().toLowerCase() !== 'compact') return null

  const focusPrompt = parsed.userText.trim()
  return focusPrompt ? { focusPrompt } : { focusPrompt: undefined }
}
