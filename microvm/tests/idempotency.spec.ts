// EXERCISE:basic
import { it, expect } from 'vitest'
import { handleImportBatch } from '../src/worker'
import { withHarness } from './support'

const invoiceCsv = 'invoiceId,customerId,amountCents,dueDate\nINV-RETRY,Acme,1200,2026-12-31'
const objectKey = 'daily/retry.csv'

it('does not publish the same import summary twice when SQS redelivers a message', async () => withHarness(async h => {
  await h.putCsv(objectKey, invoiceCsv)
  await h.duplicateNextImportEvent(objectKey)
  const result = await handleImportBatch()
  expect(result.received).toBeGreaterThanOrEqual(2)
  expect(result.processed).toBe(result.received)
  expect(result.failed).toBe(0)
  const summaries = await h.receiveSummaries()

  // TODO: assert that the duplicated event produces one summary.
  throw new Error('TODO: complete the idempotency assertion')
}))
