/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { rebuild } from '@electron/rebuild'

/**
 * @param {string} projectDir
 * @returns {Promise<string>}
 */
async function readInstalledElectronVersion(projectDir) {
  const electronPackagePath = path.join(projectDir, 'node_modules', 'electron', 'package.json')
  const packageJson = JSON.parse(await readFile(electronPackagePath, 'utf8'))
  return packageJson.version
}

/**
 * @returns {Promise<void>}
 */
async function main() {
  const projectDir = process.cwd()
  const electronVersion = await readInstalledElectronVersion(projectDir)
  const ignoreModules = []

  console.log(`> Rebuilding native dependencies for Electron ${electronVersion}`)

  if (ignoreModules.length > 0) {
    console.log(`> Skipping rebuild for: ${ignoreModules.join(', ')}`)
  }

  const rebuildResult = rebuild({
    buildPath: projectDir,
    electronVersion,
    arch: process.arch,
    platform: process.platform,
    projectRootPath: projectDir,
    types: ['prod', 'dev', 'optional'],
    force: true,
    mode: 'sequential',
    disablePreGypCopy: true,
    ignoreModules
  })

  rebuildResult.lifecycle.on('module-found', (moduleName) => {
    console.log(`  - preparing ${moduleName}`)
  })

  rebuildResult.lifecycle.on('module-done', (moduleName) => {
    console.log(`  - finished ${moduleName}`)
  })

  rebuildResult.lifecycle.on('module-skip', (moduleName) => {
    console.log(`  - skipped ${moduleName}`)
  })

  await rebuildResult
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
