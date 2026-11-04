import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import { LambdaMicrovmsClient, RunMicrovmCommand, GetMicrovmCommand, CreateMicrovmAuthTokenCommand, TerminateMicrovmCommand } from '@aws-sdk/client-lambda-microvms'
import { createHandler } from './handler.mjs'

const region = process.env.AWS_REGION || 'ap-northeast-1'
const tableName = process.env.SESSION_TABLE
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
  marshallOptions: { removeUndefinedValues: true },
})
const vmClient = new LambdaMicrovmsClient({ region, maxAttempts: 8 })

const store = {
  async getSession(sid) {
    const result = await ddb.send(new GetCommand({
      TableName: tableName,
      Key: { pk: `SESSION#${sid}` },
      ConsistentRead: true,
    }))
    return result.Item
  },

  async getJoin(joinKey) {
    const result = await ddb.send(new GetCommand({
      TableName: tableName,
      Key: { pk: `JOIN#${joinKey}` },
      ConsistentRead: true,
    }))
    return result.Item
  },

  async deleteJoin(joinKey) {
    await ddb.send(new DeleteCommand({ TableName: tableName, Key: { pk: `JOIN#${joinKey}` } }))
  },

  async reserveSession(session, maxSessions) {
    const now = Math.floor(Date.now() / 1000)
    try {
      await ddb.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: { ...session, counted: true },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: {
                pk: `JOIN#${session.joinKey}`,
                sid: session.sid,
                expiresAt: session.expiresAt,
                createdAt: now,
              },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          {
            Update: {
              TableName: tableName,
              Key: { pk: 'CONTROL#ACTIVE' },
              UpdateExpression: 'SET activeSessions = if_not_exists(activeSessions, :zero) + :one',
              ConditionExpression: 'attribute_not_exists(activeSessions) OR activeSessions < :max',
              ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':max': maxSessions },
            },
          },
        ],
      }))
      return true
    } catch (error) {
      if (error.name === 'TransactionCanceledException') return false
      throw error
    }
  },

  async updateSession(pk, changes) {
    const pairs = Object.entries(changes).filter(([, value]) => value !== undefined)
    if (!pairs.length) return
    const names = {}
    const values = {}
    const assignments = pairs.map(([key, value], index) => {
      names[`#n${index}`] = key
      values[`:v${index}`] = value
      return `#n${index} = :v${index}`
    })
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { pk },
      UpdateExpression: `SET ${assignments.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: 'attribute_exists(pk)',
    }))
  },

  async releaseSession(session) {
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
    const items = [
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
      items.push({ Delete: { TableName: tableName, Key: { pk: `JOIN#${current.Item.joinKey}` } } })
    }
    try {
      await ddb.send(new TransactWriteCommand({ TransactItems: items }))
      return true
    } catch (error) {
      if (error.name === 'TransactionCanceledException') return false
      throw error
    }
  },

}

const microvms = {
  async run(input) { return vmClient.send(new RunMicrovmCommand(input)) },
  async get(input) { return vmClient.send(new GetMicrovmCommand(input)) },
  async createAuthToken(input) { return vmClient.send(new CreateMicrovmAuthTokenCommand(input)) },
  async terminate(input) { return vmClient.send(new TerminateMicrovmCommand(input)) },
}

const handler = createHandler({
  store,
  microvms,
  config: {
    imageArn: process.env.MICROVM_IMAGE_ARN,
    maxSessions: Number(process.env.MAX_SESSIONS || 30),
    sessionTTLSeconds: Number(process.env.SESSION_TTL_SECONDS || 3600),
    originVerifyToken: process.env.ORIGIN_VERIFY_TOKEN,
    ingressConnectorArn: `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:ALL_INGRESS`,
  },
})

export { handler }
