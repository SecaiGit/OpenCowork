import { app } from 'electron'
import * as os from 'os'
import * as path from 'path'

const DATA_DIR_ENV = 'OPEN_COWORK_DATA_DIR'
const USER_DATA_DIR_ENV = 'OPEN_COWORK_USER_DATA_DIR'

function resolveEnvPath(name: string): string | null {
  const value = process.env[name]?.trim()
  if (!value) return null
  return path.resolve(value)
}

export function getAppDataDir(): string {
  const override = resolveEnvPath(DATA_DIR_ENV)
  if (override) return override
  return path.join(os.homedir(), app.isPackaged ? '.open-cowork' : '.open-cowork-dev')
}

export function getElectronUserDataDirOverride(): string | null {
  const override = resolveEnvPath(USER_DATA_DIR_ENV)
  if (override) return override

  const dataDirOverride = resolveEnvPath(DATA_DIR_ENV)
  if (dataDirOverride) return path.join(dataDirOverride, 'electron-user-data')

  return null
}
