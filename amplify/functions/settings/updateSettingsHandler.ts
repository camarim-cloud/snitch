import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const TABLE_NAME = process.env.APP_SETTINGS_TABLE_NAME!;

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const SETTINGS_KEY = "global";

type SettingsArgs = {
  cloudTrailLogGroupName?: string | null;
  slackBotToken?: string | null;
  slackChannelId?: string | null;
  slackSigningSecret?: string | null;
  slackNotificationsEnabled?: boolean | null;
  snsNotificationsEnabled?: boolean | null;
  snsApprovalNotificationsEnabled?: boolean | null;
};

type AppSyncEvent = {
  arguments: SettingsArgs;
  identity: unknown;
};

export const handler = async (event: AppSyncEvent): Promise<SettingsArgs> => {
  const {
    cloudTrailLogGroupName,
    slackBotToken,
    slackChannelId,
    slackSigningSecret,
    slackNotificationsEnabled,
    snsNotificationsEnabled,
    snsApprovalNotificationsEnabled,
  } = event.arguments;

  const fields: Array<[string, string | boolean | null | undefined]> = [
    ["cloudTrailLogGroupName", cloudTrailLogGroupName],
    ["slackBotToken", slackBotToken],
    ["slackChannelId", slackChannelId],
    ["slackSigningSecret", slackSigningSecret],
    ["slackNotificationsEnabled", slackNotificationsEnabled],
    ["snsNotificationsEnabled", snsNotificationsEnabled],
    ["snsApprovalNotificationsEnabled", snsApprovalNotificationsEnabled],
  ];

  // AppSync forwards null for optional arguments that were not provided by
  // the caller, so exclude both undefined and null to avoid overwriting
  // unrelated DynamoDB fields. An explicit empty string "" is still accepted
  // (means the admin intentionally cleared the value).
  const provided = fields.filter(([, v]) => v != null);

  if (provided.length === 0) {
    return {};
  }

  const setExprs = provided.map(([, ], i) => `#f${i} = :v${i}`);
  const names = Object.fromEntries(provided.map(([k], i) => [`#f${i}`, k]));
  const values = Object.fromEntries(provided.map(([, v], i) => [`:v${i}`, v ?? null]));

  await dynamo.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { settingKey: SETTINGS_KEY },
      UpdateExpression: `SET ${setExprs.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    })
  );

  return Object.fromEntries(provided.map(([k, v]) => [k, v ?? null]));
};
