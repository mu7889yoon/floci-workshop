// EXERCISE:basic
import { persistInvoices } from '../lib/aws'
import { processImportBatch } from './importer'

export async function handleImportBatch() {
  return processImportBatch(async invoices => {
    let importedRows = 0
    importedRows = await persistInvoices(invoices)
    return importedRows
  })
}
