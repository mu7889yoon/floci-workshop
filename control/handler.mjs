import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const COOKIE_NAME = 'workshop_sid'
const MAX_BODY_BYTES = 256 * 1024
const MAX_CODE_CHARS = 24_000
const MAX_SHELL_COMMAND_CHARS = 4_000
const TERMINAL_PORT = 8081

function header(event, name) {
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(event.headers || {})) {
    if (key.toLowerCase() === wanted) return String(value)
  }
  return ''
}

function sessionId(event) {
  const cookies = event.cookies || []
  const fromCookieList = cookies.map(cookie => cookie.split(';', 1)[0])
  const allCookies = [...fromCookieList, header(event, 'cookie')]
  for (const source of allCookies) {
    for (const item of source.split(';')) {
      const [name, ...rest] = item.trim().split('=')
      if (name === COOKIE_NAME) return rest.join('=')
    }
  }
  return ''
}

function respond(statusCode, body, cookies = []) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, private',
      'pragma': 'no-cache',
    },
    ...(cookies.length ? { cookies } : {}),
    body: JSON.stringify(body),
  }
}

function cookie(value, maxAge) {
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`
}

function parseBody(event) {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : event.body || ''
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) throw Object.assign(new Error('Request too large'), { statusCode: 413 })
  try { return JSON.parse(raw || '{}') } catch {
    throw Object.assign(new Error('Invalid JSON'), { statusCode: 400 })
  }
}

function equalSecret(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false
  const a = Buffer.from(candidate)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function normalizeEndpoint(endpoint) {
  return endpoint.startsWith('https://') ? endpoint : `https://${endpoint}`
}

function alreadyTerminated(error) {
  return ['ResourceNotFoundException', 'NotFoundException'].includes(error?.name)
}

export function createHandler({ store, microvms, config, fetchImpl = fetch }) {
  const sessionTTLSeconds = config.sessionTTLSeconds || 60 * 60
  const validOrigin = event => {
    const supplied = header(event, 'x-workshop-origin')
    const expected = config.originVerifyToken
    return Boolean(expected && supplied && equalSecret(supplied, expected))
  }

  async function vmRequest(session, path, body) {
    const tokenResponse = await microvms.createAuthToken({
      microvmIdentifier: session.microvmId,
      expirationInMinutes: 1,
      allowedPorts: [{ port: 8080 }],
    })
    const token = tokenResponse.authToken?.['X-aws-proxy-auth']
    if (!token) throw new Error('MicroVM auth token was not returned')
    const response = await fetchImpl(`${normalizeEndpoint(session.endpoint)}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'content-type': 'application/json',
        'X-aws-proxy-auth': token,
        'X-aws-proxy-port': '8080',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(18_000),
    })
    const text = await response.text()
    let payload
    try { payload = JSON.parse(text) } catch { payload = { error: `MicroVM returned HTTP ${response.status}` } }
    return { status: response.status, payload }
  }

  async function updateSessionReadiness(session) {
    if (!session.microvmId || !session.endpoint) return { status: 'starting' }
    try {
      const current = await microvms.get({ microvmIdentifier: session.microvmId })
      if (['TERMINATING', 'TERMINATED'].includes(current.state)) {
        await store.releaseSession(session)
        return { status: 'expired', joined: false }
      }
      if (current.state === 'SUSPENDED') {
        const waking = await vmRequest(session, '/api/health')
        if (waking.status !== 200 || waking.payload.ok !== true) return { status: 'starting' }
        await store.updateSession(session.pk, { status: 'READY' })
        return { status: 'ready' }
      }
      if (current.state !== 'RUNNING') return { status: 'starting' }
      const health = await vmRequest(session, '/api/health')
      if (health.status !== 200 || health.payload.ok !== true) return { status: 'starting' }
      if (session.status !== 'READY') await store.updateSession(session.pk, { status: 'READY' })
      return { status: 'ready' }
    } catch (error) {
      if (alreadyTerminated(error)) {
        await store.releaseSession(session).catch(() => {})
        return { status: 'expired', joined: false }
      }
      console.warn('MicroVM readiness check failed:', error.name || 'Error', error.message || '')
      return { status: 'starting' }
    }
  }

  async function cleanFailedLaunch(session, vm) {
    if (!vm?.microvmId) {
      await store.releaseSession(session).catch(() => {})
      return
    }
    try {
      await microvms.terminate({ microvmIdentifier: vm.microvmId })
      await store.releaseSession(session)
    } catch (error) {
      if (alreadyTerminated(error)) {
        await store.releaseSession(session).catch(() => {})
        return
      }
      await store.updateSession(session.pk, {
        status: 'TERMINATING',
        microvmId: vm.microvmId,
        ...(vm.endpoint ? { endpoint: normalizeEndpoint(vm.endpoint) } : {}),
      }).catch(() => {})
      console.warn('Failed launch cleanup deferred to reaper:', error.name || 'Error')
    }
  }

  return async function handler(event) {
    const method = event.requestContext?.http?.method || event.httpMethod || 'GET'
    const path = event.rawPath || event.path || '/'

    if (method === 'GET' && path === '/api/health') return respond(200, { ok: true })
    if (method === 'OPTIONS') return respond(204, {})
    if (method === 'POST' && !validOrigin(event)) return respond(403, { error: 'Origin check failed' })

    if (method === 'GET' && path === '/api/me') {
      const sid = sessionId(event)
      if (!sid) return respond(200, { joined: false })
      const session = await store.getSession(sid)
      if (!session || session.expiresAt <= Math.floor(Date.now() / 1000)) return respond(200, { joined: false })
      const state = await updateSessionReadiness(session)
      if (state.joined === false) return respond(200, { joined: false, status: state.status })
      return respond(200, { joined: true, status: state.status })
    }

    if (method === 'POST' && path === '/api/join') {
      let input
      try { input = parseBody(event) } catch (error) { return respond(error.statusCode || 400, { error: error.message }) }
      if (typeof input.requestId !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.requestId)) {
        return respond(400, { error: '参加リクエストを再読み込みしてください。' })
      }

      const currentSid = sessionId(event)
      if (currentSid) {
        const current = await store.getSession(currentSid)
        if (current && current.expiresAt > Math.floor(Date.now() / 1000)) {
          return respond(200, { joined: true, status: current.status }, [cookie(currentSid, Math.max(1, current.expiresAt - Math.floor(Date.now() / 1000)))])
        }
      }

      const joinKey = createHash('sha256').update(input.requestId).digest('hex')
      const previous = await store.getJoin(joinKey)
      if (previous) {
        const existing = await store.getSession(previous.sid)
        if (existing) {
          if (!existing.microvmId && existing.status === 'LAUNCHING') {
            let vm
            try {
              vm = await microvms.run({
                imageIdentifier: config.imageArn,
                clientToken: existing.sid,
                ingressNetworkConnectors: [config.ingressConnectorArn],
                egressNetworkConnectors: [],
                idlePolicy: { autoResumeEnabled: true, maxIdleDurationSeconds: 600, suspendedDurationSeconds: 1200 },
                maximumDurationInSeconds: sessionTTLSeconds,
              })
              if (!vm.microvmId || !vm.endpoint) throw new Error('RunMicrovm returned no endpoint')
              await store.updateSession(existing.pk, {
                status: 'STARTING',
                microvmId: vm.microvmId,
                endpoint: normalizeEndpoint(vm.endpoint),
              })
              Object.assign(existing, { status: 'STARTING', microvmId: vm.microvmId, endpoint: normalizeEndpoint(vm.endpoint) })
            } catch (error) {
              await cleanFailedLaunch(existing, vm)
              console.error('MicroVM launch recovery failed:', error.name || 'Error')
              return respond(502, { error: '演習環境を起動できませんでした。もう一度お試しください。' })
            }
          }
          return respond(202, { joined: true, status: existing.status }, [cookie(previous.sid, Math.max(1, existing.expiresAt - Math.floor(Date.now() / 1000)))])
        }
        await store.deleteJoin(joinKey)
      }

      const sid = randomBytes(32).toString('hex')
      const now = Math.floor(Date.now() / 1000)
      const session = {
        pk: `SESSION#${sid}`,
        sid,
        joinKey,
        status: 'LAUNCHING',
        createdAt: now,
        expiresAt: now + sessionTTLSeconds,
      }
      const reserved = await store.reserveSession(session, config.maxSessions)
      if (!reserved) {
        const duplicate = await store.getJoin(joinKey)
        if (duplicate) {
          const existing = await store.getSession(duplicate.sid)
          if (existing) return respond(202, { joined: true, status: existing.status }, [cookie(duplicate.sid, Math.max(1, existing.expiresAt - now))])
        }
        return respond(429, { error: '演習環境が満員です。スタッフへお知らせください。' })
      }

      let vm
      try {
        vm = await microvms.run({
          imageIdentifier: config.imageArn,
          clientToken: sid,
          ingressNetworkConnectors: [config.ingressConnectorArn],
          egressNetworkConnectors: [],
          idlePolicy: { autoResumeEnabled: true, maxIdleDurationSeconds: 600, suspendedDurationSeconds: 1200 },
          maximumDurationInSeconds: sessionTTLSeconds,
        })
        if (!vm.microvmId || !vm.endpoint) throw new Error('RunMicrovm returned no endpoint')
        await store.updateSession(session.pk, {
          status: 'STARTING',
          microvmId: vm.microvmId,
          endpoint: normalizeEndpoint(vm.endpoint),
        })
        return respond(202, { joined: true, status: 'starting' }, [cookie(sid, sessionTTLSeconds)])
      } catch (error) {
        await cleanFailedLaunch(session, vm)
        console.error('MicroVM launch failed:', error.name || 'Error', error.message || '')
        return respond(502, { error: '演習環境を起動できませんでした。もう一度お試しください。' })
      }
    }

    const sid = sessionId(event)
    const session = sid ? await store.getSession(sid) : null
    if (!session || session.expiresAt <= Math.floor(Date.now() / 1000)) {
      return respond(401, { error: '先に参加してください。' })
    }

    if (method === 'POST' && path === '/api/run') {
      let input
      try { input = parseBody(event) } catch (error) { return respond(error.statusCode || 400, { error: error.message }) }
      if (!['basic', 'advanced'].includes(input.stage) || typeof input.code !== 'string') {
        return respond(400, { error: '演習ファイルとコードを指定してください。' })
      }
      if (input.code.length > MAX_CODE_CHARS) return respond(413, { error: 'コードが大きすぎます。' })
      const state = await updateSessionReadiness(session)
      if (state.status !== 'ready') return respond(409, { error: '演習環境を準備中です。少し待ってから再実行してください。' })
      try {
        const result = await vmRequest(session, '/api/run', input)
        return respond(result.status, result.payload)
      } catch (error) {
        console.error('MicroVM compatibility test request failed:', error.name || 'Error')
        return respond(502, { error: 'MicroVMとの通信に失敗しました。再実行してください。' })
      }
    }

    if (method === 'POST' && path === '/api/sync') {
      let input
      try { input = parseBody(event) } catch (error) { return respond(error.statusCode || 400, { error: error.message }) }
      if (!input.files || typeof input.files !== 'object' || Array.isArray(input.files)) {
        return respond(400, { error: 'エディタの内容がありません。' })
      }
      for (const stage of ['basic', 'advanced']) {
        if (typeof input.files[stage] !== 'string') return respond(400, { error: 'エディタの内容が不正です。' })
        if (input.files[stage].length > MAX_CODE_CHARS) return respond(413, { error: 'コードが大きすぎます。' })
      }
      const state = await updateSessionReadiness(session)
      if (state.status !== 'ready') return respond(409, { error: '演習環境を準備中です。少し待ってから再実行してください。' })
      try {
        const result = await vmRequest(session, '/api/sync', { files: input.files })
        return respond(result.status, result.payload)
      } catch (error) {
        console.error('MicroVM editor sync failed:', error.name || 'Error')
        return respond(502, { error: 'MicroVMとの通信に失敗しました。' })
      }
    }

    if (method === 'POST' && path === '/api/terminal-token') {
      const state = await updateSessionReadiness(session)
      if (state.status !== 'ready') return respond(409, { error: '演習環境を準備中です。少し待ってから再接続してください。' })
      try {
        const tokenResponse = await microvms.createAuthToken({
          microvmIdentifier: session.microvmId,
          expirationInMinutes: 5,
          allowedPorts: [{ port: TERMINAL_PORT }],
        })
        const token = tokenResponse.authToken?.['X-aws-proxy-auth']
        if (!token) throw new Error('MicroVM auth token was not returned')
        return respond(200, {
          endpoint: normalizeEndpoint(session.endpoint),
          token,
          port: TERMINAL_PORT,
        })
      } catch (error) {
        console.error('MicroVM terminal token request failed:', error.name || 'Error')
        return respond(502, { error: 'Bashへの接続情報を取得できませんでした。' })
      }
    }

    if (method === 'POST' && path === '/api/shell') {
      let input
      try { input = parseBody(event) } catch (error) { return respond(error.statusCode || 400, { error: error.message }) }
      if (typeof input.command !== 'string' || !input.command.trim() || input.command.length > MAX_SHELL_COMMAND_CHARS) {
        return respond(400, { error: `シェルコマンドは1〜${MAX_SHELL_COMMAND_CHARS}文字で入力してください。` })
      }
      if (!input.files || typeof input.files !== 'object' || Array.isArray(input.files)) {
        return respond(400, { error: 'エディタの内容がありません。' })
      }
      for (const stage of ['basic', 'advanced']) {
        if (typeof input.files[stage] !== 'string') return respond(400, { error: 'エディタの内容が不正です。' })
        if (input.files[stage].length > MAX_CODE_CHARS) return respond(413, { error: 'コードが大きすぎます。' })
      }
      const state = await updateSessionReadiness(session)
      if (state.status !== 'ready') return respond(409, { error: '演習環境を準備中です。少し待ってから再実行してください。' })
      try {
        const result = await vmRequest(session, '/api/shell', {
          command: input.command,
          files: { basic: input.files.basic, advanced: input.files.advanced },
        })
        return respond(result.status, result.payload)
      } catch (error) {
        console.error('MicroVM shell request failed:', error.name || 'Error')
        return respond(502, { error: 'MicroVMシェルとの通信に失敗しました。再実行してください。' })
      }
    }

    if (method === 'POST' && path === '/api/reset') {
      try {
        const result = await vmRequest(session, '/api/reset', {})
        return respond(result.status, result.payload)
      } catch {
        return respond(502, { error: '演習環境を初期化できませんでした。' })
      }
    }

    if (method === 'POST' && path === '/api/leave') {
      let terminated = false
      try {
        if (session.microvmId) await microvms.terminate({ microvmIdentifier: session.microvmId })
        terminated = true
      } catch (error) {
        if (alreadyTerminated(error)) terminated = true
        else {
          console.warn('MicroVM termination deferred to reaper:', error.name || 'Error')
          await store.updateSession(session.pk, { status: 'TERMINATING' }).catch(() => {})
        }
      }
      if (terminated) await store.releaseSession(session)
      return respond(200, { ok: true, cleanupPending: !terminated }, [cookie('', 0)])
    }

    return respond(404, { error: 'Not found' })
  }
}
