import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb'
import { LambdaMicrovmsClient, GetMicrovmCommand, TerminateMicrovmCommand } from '@aws-sdk/client-lambda-microvms'
import { createReaper } from './reaper-core.mjs'

const region = process.env.AWS_REGION || 'ap-northeast-1'
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
  marshallOptions: { removeUndefinedValues: true },
})
const vmClient = new LambdaMicrovmsClient({ region })
const tableName = process.env.SESSION_TABLE

async function expiredSessions(now) {
  const sessions = []
  let ExclusiveStartKey
  do {
    const result = await ddb.send(new ScanCommand({
      TableName: tableName,
      ExclusiveStartKey,
      FilterExpression: 'begins_with(pk, :prefix) AND (expiresAt <= :now OR #status = :terminating)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':prefix': 'SESSION#', ':now': now, ':terminating': 'TERMINATING' },
    }))
    sessions.push(...(result.Items || []))
    ExclusiveStartKey = result.LastEvaluatedKey
  } while (ExclusiveStartKey)
  return sessions
}

async function releaseSession(session) {
  const current = await ddb.send(new GetCommand({
    TableName: tableName,
    Key: { pk: session.pk },
    ConsistentRead: true,
  }))
  if (!current.Item) return false
  if (!current.Item.counted) {
    await ddb.send(new DeleteCommand({ TableName: tableName, Key: { pk: session.pk } }))
    return false
  }
  const TransactItems = [
    {
      Delete: {
        TableName: tableName,
        Key: { pk: session.pk },
        ConditionExpression: 'counted = :true',
        ExpressionAttributeValues: { ':true': true },
      },
    },
    {
      Update: {
        TableName: tableName,
        Key: { pk: 'CONTROL#ACTIVE' },
        UpdateExpression: 'ADD activeSessions :minusOne',
        ConditionExpression: 'activeSessions >= :one',
        ExpressionAttributeValues: { ':minusOne': -1, ':one': 1 },
      },
    },
  ]
  if (current.Item.joinKey) {
    TransactItems.push({ Delete: { TableName: tableName, Key: { pk: `JOIN#${current.Item.joinKey}` } } })
  }
  try {
    await ddb.send(new TransactWriteCommand({ TransactItems }))
    return true
  } catch (error) {
    if (error.name === 'TransactionCanceledException') return false
    throw error
  }
}

const microvms = {
  async get(input) { return vmClient.send(new GetMicrovmCommand(input)) },
  async terminate(input) { return vmClient.send(new TerminateMicrovmCommand(input)) },
}

export const handler = createReaper({ expiredSessions, releaseSession, microvms })
