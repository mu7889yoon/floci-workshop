import { it, expect } from 'vitest'
import { createHarness } from './support'
import { handleImportBatch } from '../src/worker'

it('validates S3 notifications, SQS batching, DynamoDB writes, and SNS summaries', async () => {
  const h = await createHarness()
  try {
    await h.putCsv('smoke/batch.csv', [
      'invoiceId,customerId,amountCents,dueDate',
      'SMOKE-001,Floci,1200,2026-12-31',
    ].join('\n'))
    const result = await handleImportBatch()
    expect(result.failed).toBe(0)
    expect(await h.getInvoice('SMOKE-001')).toMatchObject({ amountCents: 1200 })
    expect(await h.receiveSummaries()).toContainEqual(expect.objectContaining({
      importedRows: 1,
      rejectedRows: 0,
      sourceKey: 'smoke/batch.csv',
    }))
  } finally {
    await h.dispose()
  }
})

it('moves a repeatedly failing CSV import into the configured dead-letter queue', async () => {
  const h = await createHarness()
  try {
    await h.putCsv('smoke/bad-header.csv', [
      'wrong,columns',
      'not,an,invoice',
    ].join('\n'))
    for (let attempt = 0; attempt < 4; attempt++) {
      const result = await handleImportBatch()
      if (attempt < 3) expect(result.failed).toBeGreaterThan(0)
      await new Promise(resolve => setTimeout(resolve, 1100))
    }
    expect(await h.receiveDeadLetters()).toHaveLength(1)
  } finally {
    await h.dispose()
  }
}, 10000)
