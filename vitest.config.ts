import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  test: {
    environment: 'node',
    include: [
      'src/renderer/src/lib/agent/__tests__/*.test.ts',
      'src/main/**/__tests__/*.test.ts',
      'src/shared/__tests__/*.test.ts'
    ]
  }
})
