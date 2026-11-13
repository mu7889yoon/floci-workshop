// EXERCISE:basic
import { persistInvoices } from '../lib/aws'
import { processImportBatch } from './importer'

export async function handleImportBatch(queueUrl?: string) {
  return processImportBatch(async invoices => {
    let importedRows = 0
    importedRows = await persistInvoices(invoices)
    return importedRows
  }, queueUrl)
}
