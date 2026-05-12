import { IPC } from '../ipc/channels'
import { encodeBashToolResult } from './bash-output'
import type { ToolContext } from './tool-types'

export const DEFAULT_COMMAND_TIMEOUT_MS = 600_000

export interface CommandExecutionInput {
  command: string
  timeout?: number
}

export interface CommandExecutionResult {
  output: string
}

export interface CommandExecutor {
  readonly transport: 'local' | 'ssh'
  executeForeground(input: CommandExecutionInput): Promise<CommandExecutionResult>
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function withRemoteWorkingDirectory(command: string, workingFolder?: string): string {
  const folder = workingFolder?.trim()
  return folder ? `cd ${shellEscape(folder)} && ${command}` : command
}

export function createSshCommandExecutor(ctx: ToolContext): CommandExecutor | null {
  const connectionId = ctx.sshConnectionId?.trim()
  if (!connectionId) return null

  return {
    transport: 'ssh',
    executeForeground: async (input) => {
      const result = (await ctx.ipc.invoke(IPC.SSH_EXEC, {
        connectionId,
        command: withRemoteWorkingDirectory(input.command, ctx.workingFolder),
        timeout: input.timeout ?? DEFAULT_COMMAND_TIMEOUT_MS
      })) as { exitCode?: number; stdout?: string; stderr?: string; error?: string }

      if (result.error) {
        return {
          output: encodeBashToolResult({
            exitCode: 1,
            stderr: result.error,
            summary: { executionEngine: 'ssh' }
          })
        }
      }

      return {
        output: encodeBashToolResult({
          ...result,
          summary: {
            ...(typeof result === 'object' && result && 'summary' in result
              ? (result as { summary?: Record<string, unknown> }).summary
              : {}),
            executionEngine: 'ssh'
          }
        })
      }
    }
  }
}

export function selectCommandExecutor(ctx: ToolContext): CommandExecutor | null {
  return createSshCommandExecutor(ctx)
}
