/**
 * Provisions the single table on DynamoDB Local (docker compose up -d).
 * Mirrors the schema in template.yaml exactly.
 */
import {
  CreateTableCommand,
  DynamoDBClient,
  ResourceInUseException,
  UpdateTimeToLiveCommand,
} from '@aws-sdk/client-dynamodb';
import { config } from '../src/core/config';

const client = new DynamoDBClient({
  region: config.awsRegion,
  endpoint: config.dynamoEndpoint ?? 'http://localhost:8000',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});

try {
  await client.send(
    new CreateTableCommand({
      TableName: config.dynamoTable,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
        { AttributeName: 'GSI1PK', AttributeType: 'S' },
        { AttributeName: 'GSI1SK', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GSI1',
          KeySchema: [
            { AttributeName: 'GSI1PK', KeyType: 'HASH' },
            { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    }),
  );
  await client.send(
    new UpdateTimeToLiveCommand({
      TableName: config.dynamoTable,
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    }),
  );
  console.log(`Created table "${config.dynamoTable}" with GSI1 + TTL`);
} catch (err) {
  if (err instanceof ResourceInUseException) {
    console.log(`Table "${config.dynamoTable}" already exists - nothing to do`);
  } else {
    throw err;
  }
}
