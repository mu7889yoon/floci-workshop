import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { getAwsEndpointConfig, getTestEnvironment } from '../lib/aws-runtime.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const stage = process.argv[2]
const testFiles = {
  idempotency: 'tests/idempotency.spec.ts',
  advanced: 'tests/advanced.spec.ts',
}
const testFile = testFiles[stage]

if (!testFile) {
  console.error('Usage: npm run test:idempotency | npm run test:advanced')
  process.exit(2)
}

const target = getAwsEndpointConfig()
try {
  const health = await fetch('http://127.0.0.1:8080/api/health', {
    signal: AbortSignal.timeout(95_000),
  })
  if (!health.ok) {
    const result = await health.json().catch(() => ({}))
    throw new Error(result.error || `MicroVM backend is not ready (HTTP ${health.status})`)
  }
} catch (error) {
  console.error(`Could not prepare ${target.provider}: ${error.message}`)
  process.exit(1)
}

console.log(`Running ${testFile} against ${target.provider} (${target.endpoint})`)
const child = spawn(process.execPath, [
  resolve(ROOT, 'node_modules/vitest/vitest.mjs'),
  'run', testFile,
  '--reporter=verbose', '--maxWorkers=1', '--no-file-parallelism',
], {
  cwd: ROOT,
  env: getTestEnvironment(process.env),
  stdio: 'inherit',
})

let failedToSpawn = false
child.on('error', error => {
  console.error(error.message)
  failedToSpawn = true
})
child.on('close', exitCode => {
  process.exitCode = failedToSpawn ? 127 : (exitCode ?? 1)
})
