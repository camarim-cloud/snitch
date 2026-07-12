import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const TABLE_NAME = process.env.APP_SETTINGS_TABLE_NAME!;

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const SETTINGS_KEY = "global";

type AppSyncEvent = { arguments: Record<string, never>; identity: unknown };

export const handler = async (_event: AppSyncEvent) => {
  const result = await dynamo.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { settingKey: SETTINGS_KEY } })
  );
  return {
    cloudTrailLogGroupName: result.Item?.cloudTrailLogGroupName ?? null,
    slackBotToken: result.Item?.slackBotToken ?? null,
    slackChannelId: result.Item?.slackChannelId ?? null,
    slackSigningSecret: result.Item?.slackSigningSecret ?? null,
    slackNotificationsEnabled: result.Item?.slackNotificationsEnabled ?? false,
    snsNotificationsEnabled: result.Item?.snsNotificationsEnabled ?? false,
    snsApprovalNotificationsEnabled: result.Item?.snsApprovalNotificationsEnabled ?? false,
    // Read-only: the CDK-managed topic ARN comes from the environment, not DynamoDB.
    snsTopicArn: process.env.NOTIFICATIONS_TOPIC_ARN ?? null,
  };
};
