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
