import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { getAppDataDir } from '../app-data-paths'
import { McpManager } from '../mcp/mcp-manager'
import type { McpServerConfig } from '../mcp/mcp-types'

const DATA_DIR = getAppDataDir()
const MCP_FILE = path.join(DATA_DIR, 'mcp-servers.json')

// ── Persistence helpers ──

function readServers(): McpServerConfig[] {
  try {
    if (fs.existsSync(MCP_FILE)) {
      return JSON.parse(fs.readFileSync(MCP_FILE, 'utf-8'))
    }
  } catch {
    // Return empty on any error
  }
  return []
}

function writeServers(servers: McpServerConfig[]): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true })
    }
    fs.writeFileSync(MCP_FILE, JSON.stringify(servers, null, 2), 'utf-8')
  } catch (err) {
    console.error('[MCP] Write error:', err)
  }
}

export async function autoConnectMcpServers(mcpManager: McpManager): Promise<void> {
  const servers = readServers().filter((server) => server.enabled)

  await Promise.allSettled(
    servers.map(async (server) => {
      try {
        await mcpManager.connectServer(server)
      } catch (err) {
        console.error(`[MCP] Auto-connect failed for ${server.name} (${server.id}):`, err)
      }
    })
  )
}

// ── Register IPC handlers ──

export function registerMcpHandlers(mcpManager: McpManager): void {
  // List all configured MCP servers
  ipcMain.handle('mcp:list', () => {
    return readServers()
  })

  // Add a new MCP server config
  ipcMain.handle('mcp:add', (_event, config: McpServerConfig) => {
    const servers = readServers()
    servers.push(config)
    writeServers(servers)
    return { success: true }
  })

  // Update an MCP server config
  ipcMain.handle(
    'mcp:update',
    (_event, { id, patch }: { id: string; patch: Partial<McpServerConfig> }) => {
      const servers = readServers()
      const idx = servers.findIndex((s) => s.id === id)
      if (idx === -1) return { success: false, error: 'Server not found' }
      servers[idx] = { ...servers[idx], ...patch }
      writeServers(servers)
      return { success: true }
    }
  )

  // Remove an MCP server config
  ipcMain.handle('mcp:remove', async (_event, id: string) => {
    await mcpManager.disconnectServer(id)
    const servers = readServers().filter((s) => s.id !== id)
    writeServers(servers)
    return { success: true }
  })

  // Connect to an MCP server
  ipcMain.handle('mcp:connect', async (_event, id: string) => {
    const servers = readServers()
    const config = servers.find((s) => s.id === id)
    if (!config) return { success: false, error: 'Server not found' }

    try {
      await mcpManager.connectServer(config)
      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, error: msg }
    }
  })

  // Disconnect from an MCP server
  ipcMain.handle('mcp:disconnect', async (_event, id: string) => {
    await mcpManager.disconnectServer(id)
    return { success: true }
  })

  // Get server status
  ipcMain.handle('mcp:status', (_event, id: string) => {
    return mcpManager.getStatus(id)
  })

  // Get full server info (status + capabilities)
  ipcMain.handle('mcp:server-info', (_event, id: string) => {
    return mcpManager.getServerInfo(id)
  })

  // Get all servers info (config + runtime status + capabilities)
  ipcMain.handle('mcp:all-servers-info', () => {
    const servers = readServers()
    return servers.map((config) => {
      const info = mcpManager.getServerInfo(config.id)
      return {
        config,
        status: info?.status ?? 'disconnected',
        tools: info?.tools ?? [],
        resources: info?.resources ?? [],
        prompts: info?.prompts ?? [],
        error: info?.error
      }
    })
  })

  // List tools for a specific server
  ipcMain.handle('mcp:list-tools', (_event, id: string) => {
    return mcpManager.getTools(id)
  })

  // Call a tool on an MCP server
  ipcMain.handle(
    'mcp:call-tool',
    async (
      _event,
      {
        serverId,
        toolName,
        args
      }: { serverId: string; toolName: string; args: Record<string, unknown> }
    ) => {
      try {
        const result = await mcpManager.callTool(serverId, toolName, args)
        return { success: true, result }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { success: false, error: msg }
      }
    }
  )

  // Read a resource from an MCP server
  ipcMain.handle(
    'mcp:read-resource',
    async (_event, { serverId, uri }: { serverId: string; uri: string }) => {
      try {
        const result = await mcpManager.readResource(serverId, uri)
        return { success: true, result }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { success: false, error: msg }
      }
    }
  )

  // List resources for a server
  ipcMain.handle('mcp:list-resources', (_event, id: string) => {
    return mcpManager.getResources(id)
  })

  // Get a prompt from an MCP server
  ipcMain.handle(
    'mcp:get-prompt',
    async (
      _event,
      {
        serverId,
        promptName,
        args
      }: { serverId: string; promptName: string; args?: Record<string, string> }
    ) => {
      try {
        const result = await mcpManager.getPrompt(serverId, promptName, args)
        return { success: true, result }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { success: false, error: msg }
      }
    }
  )

  // List prompts for a server
  ipcMain.handle('mcp:list-prompts', (_event, id: string) => {
    return mcpManager.getPrompts(id)
  })

  // Refresh capabilities for a server
  ipcMain.handle('mcp:refresh-capabilities', async (_event, id: string) => {
    try {
      await mcpManager.refreshCapabilities(id)
      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, error: msg }
    }
  })
}
