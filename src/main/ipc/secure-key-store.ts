import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { getAppDataDir } from '../app-data-paths'

const DATA_DIR = getAppDataDir()
const CONFIG_FILE = 'config.json'

function getConfigPath(): string {
  return path.join(DATA_DIR, CONFIG_FILE)
}

export function readConfig(): Record<string, unknown> {
  try {
    const filePath = getConfigPath()
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    }
  } catch {
    // Return empty on any error
  }
  return {}
}

function writeConfig(config: Record<string, unknown>): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true })
    }
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), 'utf-8')
  } catch (err) {
    console.error('[ConfigStore] Write error:', err)
  }
}

export function registerConfigHandlers(): void {
  ipcMain.handle('config:get', async (_event, key?: string) => {
    const config = readConfig()
    if (key) return config[key]
    return config
  })

  ipcMain.handle('config:set', async (_event, args: { key: string; value: unknown }) => {
    const config = readConfig()
    config[args.key] = args.value
    writeConfig(config)
    return { success: true }
  })
}
