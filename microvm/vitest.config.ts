import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    testTimeout: 8_000,
    hookTimeout: 8_000,
    maxWorkers: 1,
    fileParallelism: false,
  },
})
