import {
  ackMessages,
  downloadImportFile,
  publishImportSummary,
  receiveImportEvents,
  type Invoice,
} from '../lib/aws'
import { parseInvoiceCsv } from './csv'

function decodeS3Key(key: string) {
  return decodeURIComponent(key.replaceAll('+', ' '))
}

export async function processImportBatch(persist: (invoices: Invoice[]) => Promise<number>) {
  const messages = await receiveImportEvents()
  const completed: Array<{ Id: string; ReceiptHandle: string }> = []
  let failed = 0

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    try {
      const envelope = JSON.parse(message.Body ?? '{}')
      for (const record of envelope.Records ?? []) {
        if (!String(record.eventName ?? '').startsWith('ObjectCreated:')) continue
        const bucket = record.s3?.bucket?.name
        const key = decodeS3Key(record.s3?.object?.key ?? '')
        if (!bucket || !key) throw new Error('S3 event is missing its bucket or object key')

        const parsed = parseInvoiceCsv(await downloadImportFile(bucket, key), key)
        const importedRows = await persist(parsed.invoices)
        await publishImportSummary({
          jobId: `${bucket}/${key}`,
          sourceKey: key,
          receivedRows: parsed.receivedRows,
          importedRows,
          rejectedRows: parsed.rejected.length,
          rejected: parsed.rejected.slice(0, 20),
        })
      }
      if (message.ReceiptHandle) completed.push({
        Id: `message-${index}`,
        ReceiptHandle: message.ReceiptHandle,
      })
    } catch (error) {
      failed++
      console.error(`[import] message ${message.MessageId ?? index} will be retried: ${String(error)}`)
    }
  }

  if (completed.length) await ackMessages(completed)
  return { received: messages.length, processed: completed.length, failed }
}
