import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { watch } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { spawn as spawnPty } from 'node-pty'
import https from 'node:https'
import { WebSocket, WebSocketServer } from 'ws'
import { AWS_EMULATOR_HOME, getAwsEndpointConfig, getTestEnvironment } from './lib/aws-runtime.mjs'

const ROOT = import.meta.dirname
const HOST = '0.0.0.0'
const PORT = 8080
const TERMINAL_PORT = 8081
const MAX_BODY_BYTES = 256 * 1024
const MAX_CODE_CHARS = 24_000
const MAX_OUTPUT_CHARS = 16_000
const TEST_TIMEOUT_MS = 60_000
const FILES = {
  basic: 'tests/idempotency.spec.ts',
  advanced: 'tests/advanced.spec.ts',
}
const snapshots = Object.fromEntries(await Promise.all(
  Object.entries(FILES).map(async ([stage, relativePath]) => [
    stage,
    await readFile(resolve(ROOT, relativePath), 'utf8'),
  ]),
))

let flociProcess
let awsEmulatorProcess
let awsEmulatorOutput = ''
let activeBackend = 'floci'
let backendTransition = Promise.resolve()
let basicPassed = false
let executionBusy = false
let shellPty
let shellSocket
let shellOutput = ''
let fileSyncTimer
const shellEnv = {
  PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  HOME: '/tmp', TMPDIR: '/tmp', NODE_ENV: 'test',
  FLOCI_URL: 'http://127.0.0.1:4566',
  AWS_ACCESS_KEY_ID: 'local-test', AWS_SECRET_ACCESS_KEY: 'local-test-only',
  AWS_REGION: 'ap-northeast-1', AWS_EC2_METADATA_DISABLED: 'true', LANG: 'C.UTF-8',
  TERM: 'xterm-256color', COLORTERM: 'truecolor',
  USER: 'floci', LOGNAME: 'floci',
  PS1: 'floci@\\h:\\w\\$ ',
}

const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
function respond(res, statusCode, body) {
  res.writeHead(statusCode, headers)
  res.end(JSON.stringify(body))
}

async function isFlociHealthy() {
  try {
    const response = await fetch('http://127.0.0.1:4566/_floci/health', {
      signal: AbortSignal.timeout(500),
    })
    return response.ok
  } catch {
    return false
  }
}

async function isAwsEmulatorHealthy() {
  try {
    const ca = await readFile(`${AWS_EMULATOR_HOME}/ca.pem`)
    return await new Promise(resolveHealth => {
      const request = https.get({
        hostname: '127.0.0.1',
        port: 9297,
        path: '/__admin/health',
        ca,
        timeout: 500,
      }, response => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', chunk => { body += chunk })
        response.on('end', () => resolveHealth(response.statusCode === 200 && body === 'ok'))
      })
      request.on('error', () => resolveHealth(false))
      request.on('timeout', () => request.destroy(new Error('AWS Emulator health check timed out')))
    })
  } catch {
    return false
  }
}

async function waitForHealth(check, description, child, getOutput = () => '') {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child && child.exitCode !== null) {
      const detail = getOutput().trim()
      throw new Error(`${description} exited before becoming healthy (code ${child.exitCode})${detail ? `: ${detail}` : ''}`)
    }
    if (await check()) return
    await new Promise(resolveDelay => setTimeout(resolveDelay, 300))
  }
  const detail = getOutput().trim()
  throw new Error(`${description} did not become healthy within 90 seconds${detail ? `: ${detail}` : ''}`)
}

async function waitForProcessExit(child, timeoutMs) {
  if (child.exitCode !== null) return true
  return new Promise(resolveExit => {
    const onExit = () => {
      clearTimeout(timer)
      resolveExit(true)
    }
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolveExit(false)
    }, timeoutMs)
    child.once('exit', onExit)
  })
}

async function stopProcess(child, description) {
  if (!child || child.exitCode !== null) return
  console.log(`[${description}] stopping`)
  child.kill('SIGTERM')
  if (await waitForProcessExit(child, 3000)) return
  child.kill('SIGKILL')
  if (!await waitForProcessExit(child, 1000)) {
    throw new Error(`Could not stop ${description}; refusing to start another backend`)
  }
}

async function stopFloci() {
  const child = flociProcess
  await stopProcess(child, 'floci')
  if (flociProcess === child) flociProcess = undefined
}

async function stopAwsEmulator() {
  const child = awsEmulatorProcess
  await stopProcess(child, 'aws-emulator')
  if (awsEmulatorProcess === child) awsEmulatorProcess = undefined
}

async function startFloci() {
  if (await isFlociHealthy()) return
  if (!flociProcess || flociProcess.exitCode !== null) {
    const child = spawn(process.env.FLOCI_BIN || '/app/application', [
      '-Dquarkus.http.host=127.0.0.1',
      '-Dfloci.security.allow-unsafe-network-exposure=false',
    ], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        FLOCI_STORAGE_MODE: 'memory',
        QUARKUS_HTTP_HOST: '127.0.0.1',
        QUARKUS_HTTP_PORT: '4566',
      },
    })
    flociProcess = child
    child.stderr.on('data', chunk => process.stderr.write(`[floci] ${String(chunk).slice(0, 300)}`))
    child.on('exit', code => {
      console.error(`[floci] exited with code ${code}`)
      if (flociProcess === child) flociProcess = undefined
    })
  }
  await waitForHealth(isFlociHealthy, 'Floci', flociProcess)
  console.log('[floci] ready at 127.0.0.1:4566')
}

async function startAwsEmulator() {
  if (await isAwsEmulatorHealthy()) return
  if (!awsEmulatorProcess || awsEmulatorProcess.exitCode !== null) {
    awsEmulatorOutput = ''
    const child = spawn('aws-emulator', ['--telemetry', 'off'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        HOME: '/tmp',
        TMPDIR: '/tmp',
        EMULATOR_TELEMETRY: 'off',
      },
    })
    awsEmulatorProcess = child
    const captureAwsEmulatorOutput = chunk => {
      const output = String(chunk)
      awsEmulatorOutput = `${awsEmulatorOutput}${output}`.slice(-4000)
      process.stderr.write(`[aws-emulator] ${output.slice(0, 1000)}`)
    }
    child.stdout.on('data', captureAwsEmulatorOutput)
    child.stderr.on('data', captureAwsEmulatorOutput)
    child.on('error', error => captureAwsEmulatorOutput(error.message))
    child.on('exit', code => {
      console.error(`[aws-emulator] exited with code ${code}`)
      if (awsEmulatorProcess === child) awsEmulatorProcess = undefined
    })
  }
  await waitForHealth(isAwsEmulatorHealthy, 'AWS Emulator', awsEmulatorProcess, () => awsEmulatorOutput)
  console.log('[aws-emulator] ready at https://127.0.0.1:9297')
}

async function ensureBackend() {
  const transition = backendTransition.then(async () => {
    const target = getAwsEndpointConfig()
    if (target.provider !== activeBackend) {
      if (target.provider === 'aws-emulator') await stopFloci()
      else await stopAwsEmulator()
      activeBackend = target.provider
      console.log(`[microvm] switching backend to ${target.provider}`)
    }
    if (target.provider === 'aws-emulator') await startAwsEmulator()
    else await startFloci()
    return target
  })
  backendTransition = transition.catch(() => {})
  return transition
}

async function readJSON(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request is too large'), { statusCode: 413 })
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { statusCode: 400 })
  }
}

function runVitest(stage) {
  const testFile = {
    basic: 'tests/idempotency.spec.ts',
    advanced: 'tests/advanced.spec.ts',
    smoke: 'tests/floci-smoke.spec.ts',
  }[stage]
  if (!testFile) throw new Error(`Unknown fixed test stage: ${stage}`)
  const child = spawn(process.execPath, [
    resolve(ROOT, 'node_modules/vitest/vitest.mjs'),
    'run', testFile,
    '--reporter=verbose', '--maxWorkers=1', '--no-file-parallelism',
  ], {
    cwd: ROOT,
    env: getTestEnvironment(process.env),
    ...(process.getuid?.() === 0 ? { uid: 1001, gid: 0 } : {}),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  return new Promise(resolveResult => {
    let output = ''
    let timedOut = false
    const append = chunk => {
      output = `${output}${chunk.toString()}`.slice(-MAX_OUTPUT_CHARS)
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    const timer = setTimeout(() => {
      timedOut = true
      try { process.kill(-child.pid, 'SIGKILL') } catch {}
    }, TEST_TIMEOUT_MS)
    child.on('error', error => {
      clearTimeout(timer)
      resolveResult({ exitCode: 127, output: `${output}\n${error.message}`, timedOut: false })
    })
    child.on('close', exitCode => {
      clearTimeout(timer)
      resolveResult({ exitCode, output, timedOut })
    })
  })
}

async function reset() {
  basicPassed = false
  shellPty?.kill()
  shellPty = undefined
  shellOutput = ''
  shellSocket?.close(4000, 'workshop reset')
  shellSocket = undefined
  await Promise.all(Object.entries(FILES).map(([stage, relativePath]) =>
    writeFile(resolve(ROOT, relativePath), snapshots[stage], { mode: 0o644 }),
  ))
}

async function saveEditorFiles(files) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    throw Object.assign(new Error('Editor files are required'), { statusCode: 400 })
  }
  for (const stage of ['basic', 'advanced']) {
    if (typeof files[stage] !== 'string') throw Object.assign(new Error('Editor file content is invalid'), { statusCode: 400 })
    if (files[stage].length > MAX_CODE_CHARS) throw Object.assign(new Error('Editor file is too large'), { statusCode: 413 })
  }
  await Promise.all(Object.entries(FILES).map(([stage, relativePath]) =>
    writeFile(resolve(ROOT, relativePath), files[stage], { mode: 0o644 }),
  ))
}

function sendTerminalFrame(ws, frame) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame))
}

function startTerminalPty() {
  if (shellPty) return
  shellOutput = ''
  shellPty = spawnPty('/bin/bash', ['-i'], {
    name: 'xterm-256color',
    cols: 100,
    rows: 28,
    cwd: ROOT,
    env: shellEnv,
  })
  shellPty.onData(data => {
    shellOutput = `${shellOutput}${data}`.slice(-65_536)
    sendTerminalFrame(shellSocket, { type: 'output', data })
  })
  shellPty.onExit(({ exitCode, signal }) => {
    sendTerminalFrame(shellSocket, { type: 'exit', exitCode, signal })
    shellPty = undefined
    if (shellSocket?.readyState === WebSocket.OPEN) shellSocket.close(1000, 'shell exited')
  })
}

const terminalHttpServer = createServer((_req, res) => {
  res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found')
})
const terminalWebSockets = new WebSocketServer({
  noServer: true,
  maxPayload: 65_536,
  handleProtocols(protocols) {
    return protocols.has('floci-terminal') ? 'floci-terminal' : false
  },
})
terminalHttpServer.on('upgrade', (req, socket, head) => {
  if (new URL(req.url || '/', 'http://localhost').pathname !== '/terminal') {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  terminalWebSockets.handleUpgrade(req, socket, head, ws => terminalWebSockets.emit('connection', ws, req))
})
terminalWebSockets.on('connection', ws => {
  if (shellSocket && shellSocket !== ws && shellSocket.readyState === WebSocket.OPEN) {
    shellSocket.close(4001, 'terminal already connected')
  }
  shellSocket = ws
  startTerminalPty()
  if (shellOutput) sendTerminalFrame(ws, { type: 'replay', data: shellOutput })
  ws.on('message', raw => {
    let message
    try { message = JSON.parse(String(raw)) } catch { return }
    if (message.type === 'clear') {
      shellOutput = ''
      return
    }
    if (message.type === 'input' && typeof message.data === 'string') shellPty?.write(message.data)
    if (message.type === 'resize' && Number.isInteger(message.cols) && Number.isInteger(message.rows)) {
      shellPty?.resize(Math.max(20, Math.min(240, message.cols)), Math.max(6, Math.min(100, message.rows)))
    }
  })
  ws.on('close', () => {
    if (shellSocket === ws) shellSocket = undefined
  })
})

function sendEditorFiles() {
  clearTimeout(fileSyncTimer)
  fileSyncTimer = setTimeout(async () => {
    if (shellSocket?.readyState !== WebSocket.OPEN) return
    const files = Object.fromEntries(await Promise.all(Object.entries(FILES).map(async ([stage, path]) => [
      stage,
      await readFile(resolve(ROOT, path), 'utf8').catch(() => ''),
    ])))
    sendTerminalFrame(shellSocket, { type: 'files', files })
  }, 80)
}

for (const relativePath of Object.values(FILES)) {
  watch(resolve(ROOT, dirname(relativePath)), (_event, filename) => {
    if (filename?.toString() === basename(relativePath)) sendEditorFiles()
  })
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url || '/', 'http://localhost').pathname

  if (req.method === 'GET' && path === '/api/health') {
    try {
      const target = await ensureBackend()
      return respond(res, 200, { ok: true, provider: target.provider, endpoint: target.endpoint })
    } catch (error) {
      return respond(res, 503, { ok: false, provider: activeBackend, error: error.message })
    }
  }

  const hook = path.match(/^\/aws\/lambda-microvms\/runtime\/v1\/(ready|validate|run|resume)$/)?.[1]
  if (req.method === 'POST' && hook) {
    let target
    try { target = await ensureBackend() } catch (error) {
      return respond(res, 503, { ok: false, hook, error: error.message })
    }
    if (hook === 'validate') {
      if (executionBusy) return respond(res, 503, { ok: false, hook, error: 'Validation is busy' })
      executionBusy = true
      try {
        console.log(`[validate] running S3/SQS/DynamoDB/SNS smoke tests against ${target.provider}`)
        const smoke = await runVitest('smoke')
        const ok = smoke.exitCode === 0 && !smoke.timedOut
        console.log(`[validate] exit=${smoke.exitCode} timeout=${smoke.timedOut}\n${smoke.output}`)
        return respond(res, ok ? 200 : 500, {
          ok,
          hook,
          output: smoke.output,
          ...(smoke.timedOut ? { error: 'Image validation timed out' } : {}),
        })
      } finally {
        executionBusy = false
      }
    }
    return respond(res, 200, { ok: true, hook })
  }

  if (req.method === 'POST' && path === '/api/reset') {
    if (executionBusy) return respond(res, 409, { error: 'A test is already running' })
    await reset()
    return respond(res, 200, { ok: true })
  }

  if (req.method === 'POST' && path === '/api/sync') {
    let input
    try { input = await readJSON(req) } catch (error) {
      return respond(res, error.statusCode || 400, { error: error.message })
    }
    try {
      await saveEditorFiles(input.files)
      return respond(res, 200, { ok: true })
    } catch (error) {
      return respond(res, error.statusCode || 400, { error: error.message })
    }
  }

  if (req.method === 'POST' && path === '/api/run') {
    if (executionBusy) return respond(res, 409, { error: 'A test is already running' })
    let input
    try { input = await readJSON(req) } catch (error) {
      return respond(res, error.statusCode || 400, { error: error.message })
    }
    try { await ensureBackend() } catch (error) {
      return respond(res, 503, { error: error.message })
    }
    if (!['basic', 'advanced'].includes(input.stage) || typeof input.code !== 'string') {
      return respond(res, 400, { error: 'Exercise stage and code are required' })
    }
    if (input.code.length > MAX_CODE_CHARS) return respond(res, 413, { error: 'Code is too large' })
    if (input.stage === 'advanced' && !basicPassed) {
      return respond(res, 409, { error: 'Run the basic exercise successfully first' })
    }
    executionBusy = true
    try {
      await writeFile(resolve(ROOT, FILES[input.stage]), input.code, { mode: 0o644 })
      const result = await runVitest(input.stage)
      const passed = result.exitCode === 0 && !result.timedOut
      if (input.stage === 'basic' && passed) basicPassed = true
      return respond(res, 200, {
        passed,
        output: result.timedOut ? `${result.output}\nTIMEOUT: test execution exceeded 60 seconds.` : result.output,
      })
    } finally {
      executionBusy = false
    }
  }

  return respond(res, 404, { error: 'Not found' })
})

server.listen(PORT, HOST, () => console.log(`[microvm] listening on ${HOST}:${PORT}`))
terminalHttpServer.listen(TERMINAL_PORT, HOST, () => console.log(`[terminal] interactive Bash listening on ${HOST}:${TERMINAL_PORT}`))
void ensureBackend().catch(error => {
  console.error('[microvm] backend startup failed:', error)
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close()
    terminalHttpServer.close()
    shellPty?.kill()
    if (flociProcess && flociProcess.exitCode === null) flociProcess.kill('SIGTERM')
    if (awsEmulatorProcess && awsEmulatorProcess.exitCode === null) awsEmulatorProcess.kill('SIGTERM')
    process.exitCode = 0
  })
}
