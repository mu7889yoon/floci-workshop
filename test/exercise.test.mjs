import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const read = path => readFile(new URL(path, root), 'utf8')

test('the persistent Slidev editor sources match the files used by shell commands', async () => {
  const basic = await read('slides/exercises/basic.ts')
  const advancedCode = await read('slides/exercises/advanced.ts')
  const idempotency = await read('microvm/tests/idempotency.spec.ts')
  const advanced = await read('microvm/tests/advanced.spec.ts')
  assert.equal(basic.trimEnd(), idempotency.trimEnd())
  assert.equal(advancedCode.trimEnd(), advanced.trimEnd())
})

test('the duplicate-delivery exercise retries the same SQS event body', async () => {
  const source = await read('microvm/tests/idempotency.spec.ts')
  const helper = await read('microvm/tests/support.ts')
  assert.match(source, /duplicateNextImportEvent\(objectKey\)/)
  assert.match(source, /toBeGreaterThanOrEqual\(2\)/)
  assert.match(source, /TODO: assert that the duplicated event produces one summary/)
  assert.match(helper, /isExpectedObjectCreatedEvent\(message\.Body, expectedKey\)/)
  assert.match(helper, /SendMessageCommand/)
  assert.match(helper, /DeleteMessageCommand/)
})
