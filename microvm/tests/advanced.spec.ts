// EXERCISE:advanced
import { it, expect } from 'vitest'
import { handleImportBatch } from '../src/worker'
import { withHarness } from './support'

const invoiceCsv = (amount: number) => `invoiceId,customerId,amountCents,dueDate\nINV-SAME,Acme,${amount},2026-12-31`

it('does not overwrite an invoice when a later import repeats its ID', async () => withHarness(async h => {
    await h.putCsv('daily/first.csv', invoiceCsv(1200))
    await h.putCsv('daily/retry.csv', invoiceCsv(9999))
    await handleImportBatch()
    const saved = await h.getInvoice('INV-SAME')

    // TODO: add the expected assertion here.
    throw new Error('TODO: complete the missing assertion')
  }))

it('keeps a successful import processed when another message in the batch fails', async () => withHarness(async h => {
  await h.putCsv('daily/good.csv', 'invoiceId,customerId,amountCents,dueDate\nINV-GOOD,Acme,1200,2026-12-31')
  await h.putCsv('daily/bad.csv', 'wrong,columns\nnot,an,invoice')

  const firstAttempt = await handleImportBatch()
  expect(firstAttempt.failed).toBe(1)
  expect(await h.getInvoice('INV-GOOD')).toMatchObject({ amountCents: 1200 })
  expect(await h.receiveSummaries()).toContainEqual(expect.objectContaining({
    sourceKey: 'daily/good.csv',
    importedRows: 1,
  }))

  await new Promise(resolve => setTimeout(resolve, 1100))
  const retry = await handleImportBatch()
  expect(retry.failed).toBe(1)
  expect(await h.receiveSummaries()).toHaveLength(0)
}), 15_000)
