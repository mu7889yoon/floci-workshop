import { it, expect } from 'vitest'
import { createHarness } from './support'
import { handleImportBatch } from '../src/worker'

it('imports valid invoice rows from an S3 file and reports rejected rows', async () => {
  const h = await createHarness()
  try {
    const invoices = Array.from({ length: 26 }, (_, index) =>
      index === 0
        ? 'INV-001,"Acme, Inc.",125000,2026-12-31'
        : `INV-${String(index + 1).padStart(3, '0')},Customer-${index + 1},${80000 + index},2026-12-31`,
    )
    await h.putCsv('daily/2026-11-03.csv', [
      'invoiceId,customerId,amountCents,dueDate',
      ...invoices,
      'INV-REJECTED,Initech,not-an-amount,2026-12-31',
    ].join('\n'))
    const result = await handleImportBatch()

    expect(result.failed).toBe(0)
    expect(await h.getInvoice('INV-001')).toMatchObject({
      customerId: 'Acme, Inc.',
      amountCents: 125000,
    })
    expect(await h.getInvoice('INV-002')).toMatchObject({ amountCents: 80001 })
    expect(await h.getInvoice('INV-026')).toMatchObject({ amountCents: 80025 })
    const summary = (await h.receiveSummaries()).find(item => item.sourceKey === 'daily/2026-11-03.csv')
    expect(summary).toMatchObject({ receivedRows: 27, importedRows: 26, rejectedRows: 1 })
  } finally {
    await h.dispose()
  }
})
