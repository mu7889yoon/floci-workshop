import { randomUUID } from 'node:crypto'
import {
  CreateTableCommand,
  DescribeTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  GetItemCommand,
} from '@aws-sdk/client-dynamodb'
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutBucketNotificationConfigurationCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import {
  CreateTopicCommand,
  DeleteTopicCommand,
  SNSClient,
  SubscribeCommand,
} from '@aws-sdk/client-sns'
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SetQueueAttributesCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs'
import { unmarshall } from '@aws-sdk/util-dynamodb'
import { getAwsClientConfig } from '../lib/aws-runtime.mjs'

const config = getAwsClientConfig()
const db = new DynamoDBClient(config)
const s3 = new S3Client({ ...config, forcePathStyle: true })
const sns = new SNSClient(config)
const sqs = new SQSClient(config)

async function waitForTableActive(tableName: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const result = await db.send(new DescribeTableCommand({ TableName: tableName }))
      if (result.Table?.TableStatus === 'ACTIVE') return
    } catch (error) {
      if ((error as { name?: string }).name !== 'ResourceNotFoundException') throw error
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`DynamoDB table did not become ACTIVE: ${tableName}`)
}

function isExpectedObjectCreatedEvent(body: string | undefined, expectedKey: string) {
  if (!body) return false
  try {
    const envelope = JSON.parse(body)
    return (envelope.Records ?? []).some((record: {
      eventName?: string
      s3?: { object?: { key?: string } }
    }) => {
      if (!String(record.eventName ?? '').startsWith('ObjectCreated:')) return false
      const encodedKey = record.s3?.object?.key ?? ''
      return decodeURIComponent(encodedKey.replaceAll('+', ' ')) === expectedKey
    })
  } catch {
    return false
  }
}

async function queueInfo(queueUrl: string) {
  const result = await sqs.send(new GetQueueAttributesCommand({
    QueueUrl: queueUrl,
    AttributeNames: ['QueueArn'],
  }))
  const arn = result.Attributes?.QueueArn
  if (!arn) throw new Error(`Queue ARN was not returned for ${queueUrl}`)
  return arn
}

export async function createHarness() {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 14)
  const tableName = `invoices-${suffix}`
  const bucketName = `invoice-import-${suffix}`
  const queueName = `invoice-jobs-${suffix}`
  const dlqName = `invoice-jobs-dlq-${suffix}`
  const summaryQueueName = `invoice-summary-${suffix}`
  const table = await db.send(new CreateTableCommand({
    TableName: tableName,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [{ AttributeName: 'invoiceId', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'invoiceId', KeyType: 'HASH' }],
  }))
  await waitForTableActive(tableName)
  const dlq = await sqs.send(new CreateQueueCommand({ QueueName: dlqName }))
  const queue = await sqs.send(new CreateQueueCommand({ QueueName: queueName }))
  const summaryQueue = await sqs.send(new CreateQueueCommand({ QueueName: summaryQueueName }))
  const topic = await sns.send(new CreateTopicCommand({ Name: `invoice-import-complete-${suffix}` }))
  await s3.send(new CreateBucketCommand({ Bucket: bucketName }))
  if (!table.TableDescription || !dlq.QueueUrl || !queue.QueueUrl || !summaryQueue.QueueUrl || !topic.TopicArn) {
    throw new Error('Floci resources were not created')
  }

  const queueArn = await queueInfo(queue.QueueUrl)
  const dlqArn = await queueInfo(dlq.QueueUrl)
  const summaryQueueArn = await queueInfo(summaryQueue.QueueUrl)
  const bucketArn = `arn:aws:s3:::${bucketName}`
  await sqs.send(new SetQueueAttributesCommand({
    QueueUrl: queue.QueueUrl,
    Attributes: {
      VisibilityTimeout: '1',
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: '3' }),
      Policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Principal: { Service: 's3.amazonaws.com' },
          Action: 'sqs:SendMessage',
          Resource: queueArn,
          Condition: { ArnLike: { 'aws:SourceArn': bucketArn } },
        }],
      }),
    },
  }))
  await sqs.send(new SetQueueAttributesCommand({
    QueueUrl: summaryQueue.QueueUrl,
    Attributes: {
      Policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Principal: { Service: 'sns.amazonaws.com' },
          Action: 'sqs:SendMessage',
          Resource: summaryQueueArn,
          Condition: { ArnEquals: { 'aws:SourceArn': topic.TopicArn } },
        }],
      }),
    },
  }))
  await sns.send(new SubscribeCommand({
    TopicArn: topic.TopicArn,
    Protocol: 'sqs',
    Endpoint: summaryQueueArn,
  }))
  await s3.send(new PutBucketNotificationConfigurationCommand({
    Bucket: bucketName,
    NotificationConfiguration: {
      QueueConfigurations: [{
        QueueArn: queueArn,
        Events: ['s3:ObjectCreated:*'],
      }],
    },
  }))

  process.env.TABLE_NAME = tableName
  process.env.QUEUE_URL = queue.QueueUrl
  process.env.DLQ_URL = dlq.QueueUrl
  process.env.SNS_TOPIC_ARN = topic.TopicArn

  return {
    async putCsv(key: string, csv: string) {
      await s3.send(new PutObjectCommand({ Bucket: bucketName, Key: key, Body: csv }))
    },
    async duplicateNextImportEvent(expectedKey: string) {
      let original
      for (let attempt = 0; attempt < 6 && !original; attempt++) {
        const result = await sqs.send(new ReceiveMessageCommand({
          QueueUrl: queue.QueueUrl!,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
        }))
        for (const message of result.Messages ?? []) {
          if (!original && isExpectedObjectCreatedEvent(message.Body, expectedKey)
            && message.Body && message.ReceiptHandle) {
            original = message
          } else if (message.ReceiptHandle) {
            // S3 can send a test notification when the queue is configured.
            // Remove unrelated events so only the target CSV is processed.
            await sqs.send(new DeleteMessageCommand({
              QueueUrl: queue.QueueUrl!,
              ReceiptHandle: message.ReceiptHandle,
            }))
          }
        }
      }
      if (!original?.Body || !original.ReceiptHandle) throw new Error('The S3 import event was not queued')
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queue.QueueUrl!, ReceiptHandle: original.ReceiptHandle }))
      await Promise.all([1, 2].map(() => sqs.send(new SendMessageCommand({
        QueueUrl: queue.QueueUrl!,
        MessageBody: original!.Body!,
      }))))
    },
    async getInvoice(invoiceId: string) {
      const item = await db.send(new GetItemCommand({
        TableName: tableName,
        Key: { invoiceId: { S: invoiceId } },
        ConsistentRead: true,
      }))
      return item.Item ? unmarshall(item.Item) as {
        invoiceId: string
        customerId: string
        amountCents: number
        dueDate: string
      } : null
    },
    async receiveSummaries() {
      const result = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: summaryQueue.QueueUrl!,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
      }))
      return (result.Messages ?? []).flatMap(message => {
        try {
          const envelope = JSON.parse(message.Body ?? '{}')
          return envelope.Message ? [JSON.parse(envelope.Message)] : []
        } catch {
          return []
        }
      })
    },
    async receiveDeadLetters() {
      const result = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: dlq.QueueUrl!,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
      }))
      return result.Messages ?? []
    },
    async dispose() {
      await s3.send(new PutBucketNotificationConfigurationCommand({
        Bucket: bucketName,
        NotificationConfiguration: {},
      })).catch(() => {})
      const objects = await s3.send(new ListObjectsV2Command({ Bucket: bucketName })).catch(() => undefined)
      if (objects?.Contents?.length) {
        await s3.send(new DeleteObjectsCommand({
          Bucket: bucketName,
          Delete: { Objects: objects.Contents.flatMap(object => object.Key ? [{ Key: object.Key }] : []) },
        })).catch(() => {})
      }
      await s3.send(new DeleteBucketCommand({ Bucket: bucketName })).catch(() => {})
      await sns.send(new DeleteTopicCommand({ TopicArn: topic.TopicArn! })).catch(() => {})
      await sqs.send(new DeleteQueueCommand({ QueueUrl: summaryQueue.QueueUrl! })).catch(() => {})
      await sqs.send(new DeleteQueueCommand({ QueueUrl: queue.QueueUrl! })).catch(() => {})
      await sqs.send(new DeleteQueueCommand({ QueueUrl: dlq.QueueUrl! })).catch(() => {})
      await db.send(new DeleteTableCommand({ TableName: tableName })).catch(() => {})
    },
  }
}

export async function withHarness<T>(work: (h: Awaited<ReturnType<typeof createHarness>>) => Promise<T>) {
  const h = await createHarness()
  try {
    return await work(h)
  } finally {
    await h.dispose()
  }
}
