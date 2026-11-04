import assert from 'node:assert/strict'
import test from 'node:test'
import { createReaper } from '../control/reaper-core.mjs'

test('terminates expired VMs and releases their slots', async () => {
  const terminated = []
  const released = []
  const reaper = createReaper({
    expiredSessions: async now => [{ sid: 'one', microvmId: 'vm-one', expiresAt: now - 1 }],
    releaseSession: async session => released.push(session.sid),
    microvms: {
      async get() { return { state: 'RUNNING' } },
      async terminate({ microvmIdentifier }) { terminated.push(microvmIdentifier) },
    },
    now: () => 100,
  })
  const result = await reaper()
  assert.deepEqual(result, { found: 1, terminated: 1, deferred: 0 })
  assert.deepEqual(terminated, ['vm-one'])
  assert.deepEqual(released, ['one'])
})

test('releases expired reservations that never received a VM ID', async () => {
  let released = false
  const reaper = createReaper({
    expiredSessions: async () => [{ sid: 'reserved', expiresAt: 0 }],
    releaseSession: async () => { released = true },
    microvms: {},
    now: () => 1,
  })
  const result = await reaper()
  assert.equal(released, true)
  assert.deepEqual(result, { found: 1, terminated: 0, deferred: 0 })
})

test('keeps the slot reserved when termination fails', async () => {
  let released = false
  const reaper = createReaper({
    expiredSessions: async () => [{ sid: 'one', microvmId: 'vm-one', expiresAt: 0 }],
    releaseSession: async () => { released = true },
    microvms: {
      async get() { return { state: 'RUNNING' } },
      async terminate() { throw new Error('temporarily unavailable') },
    },
    now: () => 1,
  })
  const originalWarn = console.warn
  console.warn = () => {}
  let result
  try { result = await reaper() } finally { console.warn = originalWarn }
  assert.equal(released, false)
  assert.deepEqual(result, { found: 1, terminated: 0, deferred: 1 })
})

test('releases the slot if the VM was already removed from the service', async () => {
  let released = false
  const reaper = createReaper({
    expiredSessions: async () => [{ sid: 'missing', microvmId: 'gone', expiresAt: 0 }],
    releaseSession: async () => { released = true },
    microvms: {
      async get() { const error = new Error('gone'); error.name = 'ResourceNotFoundException'; throw error },
      async terminate() {},
    },
    now: () => 1,
  })
  const result = await reaper()
  assert.equal(released, true)
  assert.deepEqual(result, { found: 1, terminated: 0, deferred: 0 })
})
