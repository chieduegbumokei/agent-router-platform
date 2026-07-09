import {
  DynamoDBClient,
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { config } from '../core/config';
import { AppError } from '../core/errors';
import { sortableNow } from '../core/ids';
import type { Message } from '../core/types';
import type {
  ConversationRecord,
  McpServerRecord,
  MemoryRecord,
  ProjectRecord,
  RefreshTokenRecord,
  Store,
  UserRecord,
  UserSettingsRecord,
} from './types';

/**
 * Single-table design (see docs/LLD.md §5). All access patterns are Query/Get -
 * never Scan. All values travel as DocumentClient expression parameters
 * (no string-built queries → no injection surface).
 *
 *   User          PK=USER#<id>   SK=PROFILE        GSI1PK=EMAIL#<email> GSI1SK=USER
 *   RefreshToken  PK=USER#<id>   SK=RT#<tokenId>   (TTL: expiresAt)
 *   Conversation  PK=USER#<id>   SK=CONV#<convId>
 *   Message       PK=CONV#<id>   SK=MSG#<ts>#<msgId>
 *   Settings      PK=USER#<id>   SK=SETTINGS
 *   Memory        PK=USER#<id>   SK=MEM#<memId>
 *   McpServer     PK=USER#<id>   SK=MCP#<serverId>
 *   Project       PK=USER#<id>   SK=PROJ#<projectId>
 */
export function createDynamoStore(): Store {
  const client = new DynamoDBClient({
    region: config.awsRegion,
    ...(config.dynamoEndpoint
      ? {
          endpoint: config.dynamoEndpoint,
          credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
        }
      : {}),
  });
  const doc = DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
  const TableName = config.dynamoTable;

  return {
    async createUser(user) {
      // GSI keys are eventually consistent, so uniqueness is enforced with a
      // dedicated EMAIL item. Written transactionally with the profile so a
      // partial failure can't strand the email lock without an account.
      try {
        await doc.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName,
                  Item: { PK: `EMAILLOCK#${user.email}`, SK: 'LOCK', userId: user.userId },
                  ConditionExpression: 'attribute_not_exists(PK)',
                },
              },
              {
                Put: {
                  TableName,
                  Item: {
                    PK: `USER#${user.userId}`,
                    SK: 'PROFILE',
                    GSI1PK: `EMAIL#${user.email}`,
                    GSI1SK: 'USER',
                    ...user,
                  },
                },
              },
            ],
          }),
        );
      } catch (err) {
        if (
          err instanceof TransactionCanceledException &&
          err.CancellationReasons?.some((r) => r.Code === 'ConditionalCheckFailed')
        ) {
          throw new AppError('CONFLICT', 409, 'Email already registered');
        }
        throw err;
      }
    },
    async getUserByEmail(email) {
      const res = await doc.send(
        new QueryCommand({
          TableName,
          IndexName: 'GSI1',
          KeyConditionExpression: 'GSI1PK = :pk AND GSI1SK = :sk',
          ExpressionAttributeValues: { ':pk': `EMAIL#${email}`, ':sk': 'USER' },
          Limit: 1,
        }),
      );
      return (res.Items?.[0] as UserRecord | undefined) ?? null;
    },
    async getUserById(userId) {
      const res = await doc.send(
        new GetCommand({ TableName, Key: { PK: `USER#${userId}`, SK: 'PROFILE' } }),
      );
      return (res.Item as UserRecord | undefined) ?? null;
    },

    async putRefreshToken(rec) {
      await doc.send(
        new PutCommand({
          TableName,
          Item: { PK: `USER#${rec.userId}`, SK: `RT#${rec.tokenId}`, ...rec },
        }),
      );
    },
    async getRefreshToken(userId, tokenId) {
      const res = await doc.send(
        new GetCommand({ TableName, Key: { PK: `USER#${userId}`, SK: `RT#${tokenId}` } }),
      );
      return (res.Item as RefreshTokenRecord | undefined) ?? null;
    },
    async markRotated(userId, tokenId, rotatedTo) {
      try {
        await doc.send(
          new UpdateCommand({
            TableName,
            Key: { PK: `USER#${userId}`, SK: `RT#${tokenId}` },
            UpdateExpression: 'SET rotatedTo = :r',
            ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(rotatedTo)',
            ExpressionAttributeValues: { ':r': rotatedTo },
          }),
        );
        return true;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return false;
        throw err;
      }
    },
    async revokeFamily(userId, familyId) {
      const res = await doc.send(
        new QueryCommand({
          TableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
          ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':sk': 'RT#' },
        }),
      );
      const family = (res.Items ?? []).filter((i) => i.familyId === familyId);
      await Promise.all(
        family.map((i) =>
          doc.send(
            new UpdateCommand({
              TableName,
              Key: { PK: i.PK, SK: i.SK },
              UpdateExpression: 'SET revoked = :t',
              ExpressionAttributeValues: { ':t': true },
            }),
          ),
        ),
      );
    },

    async createConversation(conv) {
      await doc.send(
        new PutCommand({
          TableName,
          Item: { PK: `USER#${conv.userId}`, SK: `CONV#${conv.convId}`, ...conv },
        }),
      );
    },
    async getConversation(userId, convId) {
      const res = await doc.send(
        new GetCommand({ TableName, Key: { PK: `USER#${userId}`, SK: `CONV#${convId}` } }),
      );
      return (res.Item as ConversationRecord | undefined) ?? null;
    },
    async listConversations(userId) {
      const res = await doc.send(
        new QueryCommand({
          TableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
          ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':sk': 'CONV#' },
        }),
      );
      return ((res.Items ?? []) as ConversationRecord[]).sort((a, b) =>
        b.lastMessageAt.localeCompare(a.lastMessageAt),
      );
    },
    async touchConversation(userId, convId, patch) {
      await doc.send(
        new UpdateCommand({
          TableName,
          Key: { PK: `USER#${userId}`, SK: `CONV#${convId}` },
          UpdateExpression: patch.lastAgentId
            ? 'SET lastMessageAt = :t, lastAgentId = :a'
            : 'SET lastMessageAt = :t',
          ExpressionAttributeValues: patch.lastAgentId
            ? { ':t': patch.lastMessageAt, ':a': patch.lastAgentId }
            : { ':t': patch.lastMessageAt },
        }),
      );
    },

    async renameConversation(userId, convId, title) {
      await doc.send(
        new UpdateCommand({
          TableName,
          Key: { PK: `USER#${userId}`, SK: `CONV#${convId}` },
          UpdateExpression: 'SET title = :t',
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeValues: { ':t': title },
        }),
      ).catch((err) => {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
      });
    },
    async setConversationProject(userId, convId, projectId) {
      await doc.send(
        new UpdateCommand({
          TableName,
          Key: { PK: `USER#${userId}`, SK: `CONV#${convId}` },
          ConditionExpression: 'attribute_exists(PK)',
          ...(projectId === null
            ? { UpdateExpression: 'REMOVE projectId' }
            : {
                UpdateExpression: 'SET projectId = :p',
                ExpressionAttributeValues: { ':p': projectId },
              }),
        }),
      ).catch((err) => {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
      });
    },
    async setConversationStarred(userId, convId, starred) {
      await doc.send(
        new UpdateCommand({
          TableName,
          Key: { PK: `USER#${userId}`, SK: `CONV#${convId}` },
          ConditionExpression: 'attribute_exists(PK)',
          ...(starred
            ? {
                UpdateExpression: 'SET starred = :s',
                ExpressionAttributeValues: { ':s': true },
              }
            : { UpdateExpression: 'REMOVE starred' }),
        }),
      ).catch((err) => {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
      });
    },
    async deleteConversation(userId, convId) {
      await doc.send(
        new DeleteCommand({ TableName, Key: { PK: `USER#${userId}`, SK: `CONV#${convId}` } }),
      );
      // Message partition cleanup in BatchWrite pages (max 25 per request).
      for (;;) {
        const res = await doc.send(
          new QueryCommand({
            TableName,
            KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
            ExpressionAttributeValues: { ':pk': `CONV#${convId}`, ':sk': 'MSG#' },
            ProjectionExpression: 'PK, SK',
            Limit: 25,
          }),
        );
        const items = res.Items ?? [];
        if (items.length === 0) break;
        await doc.send(
          new BatchWriteCommand({
            RequestItems: {
              [TableName]: items.map((i) => ({
                DeleteRequest: { Key: { PK: i.PK, SK: i.SK } },
              })),
            },
          }),
        );
        if (items.length < 25) break;
      }
    },

    async addMessage(msg) {
      await doc.send(
        new PutCommand({
          TableName,
          Item: { PK: `CONV#${msg.convId}`, SK: `MSG#${sortableNow()}#${msg.msgId}`, ...msg },
        }),
      );
    },
    async listMessages(convId, limit) {
      // newest N via reverse scan, then flip to chronological order
      const res = await doc.send(
        new QueryCommand({
          TableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
          ExpressionAttributeValues: { ':pk': `CONV#${convId}`, ':sk': 'MSG#' },
          ScanIndexForward: false,
          Limit: limit,
        }),
      );
      return ((res.Items ?? []) as Message[]).reverse();
    },
    async updateMessageFeedback(convId, msgId, patch) {
      // The message SK embeds its write timestamp, so locate it by msgId first
      // (single bounded partition query - never a table scan).
      const res = await doc.send(
        new QueryCommand({
          TableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
          FilterExpression: 'msgId = :m',
          ExpressionAttributeValues: { ':pk': `CONV#${convId}`, ':sk': 'MSG#', ':m': msgId },
          ProjectionExpression: 'PK, SK',
        }),
      );
      const item = res.Items?.[0];
      if (!item) return;
      await doc.send(
        new UpdateCommand({
          TableName,
          Key: { PK: item.PK, SK: item.SK },
          ...(patch.feedback === null
            ? { UpdateExpression: 'REMOVE feedback, feedbackComment' }
            : {
                UpdateExpression: 'SET feedback = :f, feedbackComment = :c',
                ExpressionAttributeValues: {
                  ':f': patch.feedback,
                  ':c': patch.feedbackComment ?? '',
                },
              }),
        }),
      );
    },

    async getUserSettings(userId) {
      const res = await doc.send(
        new GetCommand({ TableName, Key: { PK: `USER#${userId}`, SK: 'SETTINGS' } }),
      );
      return (res.Item as UserSettingsRecord | undefined) ?? null;
    },
    async putUserSettings(settings) {
      await doc.send(
        new PutCommand({
          TableName,
          Item: { PK: `USER#${settings.userId}`, SK: 'SETTINGS', ...settings },
        }),
      );
    },

    async putMemory(mem) {
      await doc.send(
        new PutCommand({
          TableName,
          Item: { PK: `USER#${mem.userId}`, SK: `MEM#${mem.memId}`, ...mem },
        }),
      );
    },
    async listMemories(userId) {
      const res = await doc.send(
        new QueryCommand({
          TableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
          ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':sk': 'MEM#' },
        }),
      );
      return ((res.Items ?? []) as MemoryRecord[]).sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      );
    },
    async deleteMemory(userId, memId) {
      await doc.send(
        new DeleteCommand({ TableName, Key: { PK: `USER#${userId}`, SK: `MEM#${memId}` } }),
      );
    },
    async deleteAllMemories(userId) {
      const res = await doc.send(
        new QueryCommand({
          TableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
          ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':sk': 'MEM#' },
          ProjectionExpression: 'PK, SK',
        }),
      );
      const items = res.Items ?? [];
      for (let i = 0; i < items.length; i += 25) {
        await doc.send(
          new BatchWriteCommand({
            RequestItems: {
              [TableName]: items.slice(i, i + 25).map((it) => ({
                DeleteRequest: { Key: { PK: it.PK, SK: it.SK } },
              })),
            },
          }),
        );
      }
    },

    async putProject(project) {
      await doc.send(
        new PutCommand({
          TableName,
          Item: { PK: `USER#${project.userId}`, SK: `PROJ#${project.projectId}`, ...project },
        }),
      );
    },
    async getProject(userId, projectId) {
      const res = await doc.send(
        new GetCommand({ TableName, Key: { PK: `USER#${userId}`, SK: `PROJ#${projectId}` } }),
      );
      return (res.Item as ProjectRecord | undefined) ?? null;
    },
    async listProjects(userId) {
      const res = await doc.send(
        new QueryCommand({
          TableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
          ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':sk': 'PROJ#' },
        }),
      );
      return ((res.Items ?? []) as ProjectRecord[]).sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      );
    },
    async deleteProject(userId, projectId) {
      await doc.send(
        new DeleteCommand({ TableName, Key: { PK: `USER#${userId}`, SK: `PROJ#${projectId}` } }),
      );
      // Detach conversations: bounded partition query, never a table scan.
      const res = await doc.send(
        new QueryCommand({
          TableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
          FilterExpression: 'projectId = :p',
          ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':sk': 'CONV#', ':p': projectId },
          ProjectionExpression: 'PK, SK',
        }),
      );
      await Promise.all(
        (res.Items ?? []).map((i) =>
          doc.send(
            new UpdateCommand({
              TableName,
              Key: { PK: i.PK, SK: i.SK },
              UpdateExpression: 'REMOVE projectId',
            }),
          ),
        ),
      );
    },

    async putMcpServer(rec) {
      await doc.send(
        new PutCommand({
          TableName,
          Item: { PK: `USER#${rec.userId}`, SK: `MCP#${rec.serverId}`, ...rec },
        }),
      );
    },
    async getMcpServer(userId, serverId) {
      const res = await doc.send(
        new GetCommand({ TableName, Key: { PK: `USER#${userId}`, SK: `MCP#${serverId}` } }),
      );
      return (res.Item as McpServerRecord | undefined) ?? null;
    },
    async listMcpServers(userId) {
      const res = await doc.send(
        new QueryCommand({
          TableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
          ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':sk': 'MCP#' },
        }),
      );
      return ((res.Items ?? []) as McpServerRecord[]).sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      );
    },
    async deleteMcpServer(userId, serverId) {
      await doc.send(
        new DeleteCommand({ TableName, Key: { PK: `USER#${userId}`, SK: `MCP#${serverId}` } }),
      );
    },
  };
}
