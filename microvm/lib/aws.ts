import {
  BatchWriteItemCommand,
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns'
import {
  DeleteMessageBatchCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs'
import { marshall } from '@aws-sdk/util-dynamodb'
import { getAwsClientConfig } from './aws-runtime.mjs'

const config = getAwsClientConfig()
const sqs = new SQSClient(config)
const dynamodb = new DynamoDBClient(config)
const s3 = new S3Client({ ...config, forcePathStyle: true })
const sns = new SNSClient(config)

export type Invoice = {
  invoiceId: string
  customerId: string
  amountCents: number
  dueDate: string
  sourceKey: string
  importedAt: string
}

export async function receiveImportEvents(queueUrl = process.env.QUEUE_URL!) {
  const result = await sqs.send(new ReceiveMessageCommand({
    QueueUrl: queueUrl,
    MaxNumberOfMessages: 10,
    WaitTimeSeconds: 1,
  }))
  return result.Messages ?? []
}

export async function downloadImportFile(bucket: string, key: string) {
  const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  if (!result.Body) throw new Error(`S3 object has no body: s3://${bucket}/${key}`)
  return result.Body.transformToString()
}

export async function persistInvoices(invoices: Invoice[]) {
  const tableName = process.env.TABLE_NAME!
  const now = new Date().toISOString()
  const requests = invoices.map(invoice => ({
    PutRequest: {
      Item: marshall({ ...invoice, importedAt: now }),
    },
  }))

  let persisted = 0
  for (let offset = 0; offset < requests.length; offset += 25) {
    let pending = requests.slice(offset, offset + 25)
    for (let attempt = 0; pending.length > 0 && attempt < 5; attempt++) {
      const result = await dynamodb.send(new BatchWriteItemCommand({
        RequestItems: { [tableName]: pending },
      }))
      const unprocessed = result.UnprocessedItems?.[tableName] ?? []
      persisted += pending.length - unprocessed.length
      pending = unprocessed
      if (pending.length > 0) await new Promise(resolve => setTimeout(resolve, 20 * (2 ** attempt)))
    }
    if (pending.length > 0) throw new Error(`DynamoDB left ${pending.length} invoice writes unprocessed`)
  }
  return persisted
}

export async function publishImportSummary(summary: {
  jobId: string
  sourceKey: string
  receivedRows: number
  importedRows: number
  rejectedRows: number
  rejected: Array<{ rowNumber: number; reason: string }>
}) {
  await sns.send(new PublishCommand({
    TopicArn: process.env.SNS_TOPIC_ARN!,
    Subject: `Invoice import ${summary.jobId}`.slice(0, 100),
    Message: JSON.stringify(summary),
  }))
}

export async function ackMessages(
  messages: Array<{ Id: string; ReceiptHandle: string }>,
  queueUrl = process.env.QUEUE_URL!,
) {
  for (let offset = 0; offset < messages.length; offset += 10) {
    const result = await sqs.send(new DeleteMessageBatchCommand({
      QueueUrl: queueUrl,
      Entries: messages.slice(offset, offset + 10),
    }))
    if (result.Failed?.length) {
      throw new Error(`SQS did not acknowledge ${result.Failed.length} import message(s)`)
    }
  }
}
