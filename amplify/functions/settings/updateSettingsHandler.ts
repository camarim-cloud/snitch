import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const TABLE_NAME = process.env.APP_SETTINGS_TABLE_NAME!;

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const SETTINGS_KEY = "global";

type AppSyncEvent = {
  arguments: { cloudTrailLogGroupName: string };
  identity: unknown;
};

export const handler = async (event: AppSyncEvent) => {
  const { cloudTrailLogGroupName } = event.arguments;
  await dynamo.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { settingKey: SETTINGS_KEY, cloudTrailLogGroupName },
    })
  );
  return { cloudTrailLogGroupName };
};
