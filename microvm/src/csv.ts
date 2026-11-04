import type { Invoice } from '../lib/aws'

const HEADERS = ['invoiceId', 'customerId', 'amountCents', 'dueDate']

function parseCsvRows(csv: string) {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < csv.length; i++) {
    const char = csv[i]
    if (char === '"') {
      if (quoted && csv[i + 1] === '"') {
        field += '"'
        i++
      } else {
        quoted = !quoted
      }
    } else if (char === ',' && !quoted) {
      row.push(field)
      field = ''
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && csv[i + 1] === '\n') i++
      row.push(field)
      if (row.some(value => value.length > 0)) rows.push(row)
      row = []
      field = ''
    } else {
      field += char
    }
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted field')
  row.push(field)
  if (row.some(value => value.length > 0)) rows.push(row)
  return rows
}

export function parseInvoiceCsv(csv: string, sourceKey: string) {
  const rows = parseCsvRows(csv)
  const headers = rows.shift()?.map(value => value.trim()) ?? []
  if (HEADERS.some((header, index) => headers[index] !== header) || headers.length !== HEADERS.length) {
    throw new Error(`CSV header must be: ${HEADERS.join(',')}`)
  }

  const invoices: Invoice[] = []
  const rejected: Array<{ rowNumber: number; reason: string }> = []
  rows.forEach((values, index) => {
    const rowNumber = index + 2
    const [invoiceId, customerId, amountText, dueDate] = values.map(value => value.trim())
    const amountCents = Number(amountText)
    const reason = !invoiceId ? 'invoiceId is required'
      : !customerId ? 'customerId is required'
        : !Number.isSafeInteger(amountCents) || amountCents <= 0 ? 'amountCents must be a positive integer'
          : !/^\d{4}-\d{2}-\d{2}$/.test(dueDate) ? 'dueDate must use YYYY-MM-DD'
            : null
    if (reason) {
      rejected.push({ rowNumber, reason })
      return
    }
    invoices.push({
      invoiceId,
      customerId,
      amountCents,
      dueDate,
      sourceKey,
      importedAt: '',
    })
  })

  return { receivedRows: invoices.length + rejected.length, invoices, rejected }
}
