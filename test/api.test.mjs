import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { createHandler } from '../control/handler.mjs'

const ORIGIN_TOKEN = 'test-origin-token'

function fixture() {
  const sessions = new Map()
  const joins = new Map()
  let active = 0
  let launched = 0
  let terminated = 0
  let vmRequests = 0
  let shellRequest
  let authTokenRequest
  let vmState = 'RUNNING'

  const store = {
    async getSession(sid) { return sessions.get(sid) },
    async getJoin(key) { return joins.get(key) },
    async deleteJoin(key) { joins.delete(key) },
    async reserveSession(session, max) {
      if (active >= max || joins.has(session.joinKey)) return false
      sessions.set(session.sid, { ...session, counted: true })
      joins.set(session.joinKey, { pk: `JOIN#${session.joinKey}`, sid: session.sid })
      active++
      return true
    },
    async updateSession(pk, changes) {
      const session = [...sessions.values()].find(item => item.pk === pk)
      if (session) Object.assign(session, changes)
    },
    async releaseSession(session) {
      if (!sessions.has(session.sid)) return false
      sessions.delete(session.sid)
      joins.delete(session.joinKey)
      active--
      return true
    },
  }
  const microvms = {
    async run(input) {
      assert.deepEqual(input.egressNetworkConnectors, [])
      launched++
      return { microvmId: `microvm-${launched}`, endpoint: `microvm-${launched}.example.test` }
    },
    async get() { return { state: vmState } },
    async createAuthToken(input) {
      authTokenRequest = input
      return { authToken: { 'X-aws-proxy-auth': 'test-jwe' } }
    },
    async terminate() { terminated++ },
  }
  const fetchImpl = async (url, init) => {
    vmRequests++
    assert.equal(init.headers['X-aws-proxy-auth'], 'test-jwe')
    assert.equal(init.headers['X-aws-proxy-port'], '8080')
    const payload = url.endsWith('/api/health')
      ? { ok: true }
      : url.endsWith('/api/shell')
        ? (shellRequest = JSON.parse(init.body), { exitCode: 0, output: 'shell output', cwd: '/app', files: shellRequest.files })
        : url.endsWith('/api/sync')
          ? { ok: true }
        : { passed: true, output: 'PASS' }
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const handler = createHandler({
    store,
    microvms,
    config: {
      imageArn: 'arn:aws:lambda:ap-northeast-1:123456789012:microvm-image:workshop',
      ingressConnectorArn: 'arn:aws:lambda:ap-northeast-1:aws:network-connector:aws-network-connector:ALL_INGRESS',
      maxSessions: 2,
      sessionTTLSeconds: 3600,
      originVerifyToken: ORIGIN_TOKEN,
    },
    fetchImpl,
  })

  function event(method, path, { body, sid, origin = true } = {}) {
    return {
      requestContext: { http: { method } },
      rawPath: path,
      headers: {
        ...(origin ? { 'x-workshop-origin': ORIGIN_TOKEN } : {}),
        ...(sid ? { cookie: `workshop_sid=${sid}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }
  }
  const join = async (requestId = randomUUID()) => handler(event('POST', '/api/join', { body: { requestId } }))
  const sidFrom = response => response.cookies?.[0]?.split(';', 1)[0]?.split('=', 2)[1]

  return {
    event, join, sidFrom, handler, store, sessions,
    get launched() { return launched },
    get terminated() { return terminated },
    get vmRequests() { return vmRequests },
    get shellRequest() { return shellRequest },
    get authTokenRequest() { return authTokenRequest },
    get active() { return active },
    set vmState(value) { vmState = value },
  }
}

test('rejects a join request that did not arrive through CloudFront', async () => {
  const app = fixture()
  const response = await app.handler(app.event('POST', '/api/join', {
    body: { requestId: randomUUID() }, origin: false,
  }))
  assert.equal(response.statusCode, 403)
  assert.equal(app.launched, 0)
})

test('issues one attendee VM and makes a retry idempotent', async () => {
  const app = fixture()
  const requestId = randomUUID()
  const first = await app.join(requestId)
  const sid = app.sidFrom(first)
  assert.equal(first.statusCode, 202)
  assert.ok(sid)

  const retry = await app.join(requestId)
  assert.equal(retry.statusCode, 202)
  assert.equal(app.sidFrom(retry), sid)
  assert.equal(app.launched, 1)
  assert.equal(app.active, 1)
})

test('checks the VM before marking a session ready and proxies editor files and commands to its API port', async () => {
  const app = fixture()
  const joined = await app.join()
  const sid = app.sidFrom(joined)

  const me = await app.handler(app.event('GET', '/api/me', { sid }))
  assert.deepEqual(JSON.parse(me.body), { joined: true, status: 'ready' })
  assert.equal(app.vmRequests, 1)

  const shell = await app.handler(app.event('POST', '/api/shell', {
    sid, body: {
      command: 'npm run test:basic',
      files: { basic: 'edited worker source', advanced: 'edited advanced test' },
    },
  }))
  assert.equal(shell.statusCode, 200)
  assert.deepEqual(app.shellRequest, {
    command: 'npm run test:basic',
    files: { basic: 'edited worker source', advanced: 'edited advanced test' },
  })
  assert.deepEqual(JSON.parse(shell.body), {
    exitCode: 0,
    output: 'shell output',
    cwd: '/app',
    files: { basic: 'edited worker source', advanced: 'edited advanced test' },
  })
  assert.equal(app.vmRequests, 3)
})

test('syncs editor files and issues a five-minute token scoped to the Bash WebSocket port', async () => {
  const app = fixture()
  const sid = app.sidFrom(await app.join())

  const sync = await app.handler(app.event('POST', '/api/sync', {
    sid, body: { files: { basic: 'basic test source', advanced: 'advanced test source' } },
  }))
  assert.equal(sync.statusCode, 200)
  assert.deepEqual(JSON.parse(sync.body), { ok: true })

  const response = await app.handler(app.event('POST', '/api/terminal-token', { sid, body: {} }))
  assert.equal(response.statusCode, 200)
  assert.deepEqual(JSON.parse(response.body), {
    endpoint: 'https://microvm-1.example.test',
    token: 'test-jwe',
    port: 8081,
  })
  assert.deepEqual(app.authTokenRequest, {
    microvmIdentifier: 'microvm-1',
    expirationInMinutes: 5,
    allowedPorts: [{ port: 8081 }],
  })
})

test('wakes a suspended attendee VM when the session is checked', async () => {
  const app = fixture()
  const sid = app.sidFrom(await app.join())
  app.vmState = 'SUSPENDED'
  const me = await app.handler(app.event('GET', '/api/me', { sid }))
  assert.deepEqual(JSON.parse(me.body), { joined: true, status: 'ready' })
  assert.equal(app.vmRequests, 1)
})

test('clears an attendee session after its VM has already terminated', async () => {
  const app = fixture()
  const sid = app.sidFrom(await app.join())
  app.vmState = 'TERMINATED'
  const me = await app.handler(app.event('GET', '/api/me', { sid }))
  assert.deepEqual(JSON.parse(me.body), { joined: false, status: 'expired' })
  assert.equal(app.active, 0)
})

test('releases the VM and session slot when an attendee leaves', async () => {
  const app = fixture()
  const sid = app.sidFrom(await app.join())
  const response = await app.handler(app.event('POST', '/api/leave', { sid, body: {} }))
  assert.equal(response.statusCode, 200)
  assert.deepEqual(JSON.parse(response.body), { ok: true, cleanupPending: false })
  assert.equal(app.terminated, 1)
  assert.equal(app.active, 0)
  assert.equal(await app.store.getSession(sid), undefined)
})
