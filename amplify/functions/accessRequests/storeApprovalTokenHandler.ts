import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  formatDurationMinutes,
  notifyPendingApproval,
  type NotifiableRequest,
} from "../notifications/notify";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const TABLE_NAME = process.env.ACCESS_REQUEST_TABLE_NAME!;
const SETTINGS_TABLE_NAME = process.env.APP_SETTINGS_TABLE_NAME!;
const NOTIFICATIONS_TOPIC_ARN = process.env.NOTIFICATIONS_TOPIC_ARN;
const APP_CALLBACK_URL = process.env.APP_CALLBACK_URL;

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

type StoreTokenInput = {
  requestId: string;
  idcUserId: string;
  accountId: string;
  permissionSetArn: string;
  durationSeconds: number;
  taskToken: string;
  startTime?: string | null;
};

async function sendSlackNotification(
  requestId: string,
  request: Record<string, unknown>,
  slackBotToken: string,
  slackChannelId: string
): Promise<void> {
  const requesterName = (request.idcUserDisplayName as string | null) ?? "Unknown";
  const requesterEmail = (request.idcUserEmail as string | null) ?? "";
  const accountId = request.accountId as string;
  const accountName = (request.accountName as string | null) ?? null;
  const accountLabel = accountName ? `${accountName} (${accountId})` : accountId;
  const permissionSetName =
    (request.permissionSetName as string | null) ?? (request.permissionSetArn as string);
  const durationMinutes = request.durationMinutes as number;
  const justification = (request.justification as string | null) ?? "(none)";

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: "Access Request Requires Approval" },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Requester:*\n${requesterName} (${requesterEmail})` },
        { type: "mrkdwn", text: `*Account:*\n${accountLabel}` },
        { type: "mrkdwn", text: `*Permission Set:*\n${permissionSetName}` },
        { type: "mrkdwn", text: `*Duration:*\n${formatDurationMinutes(durationMinutes)}` },
        { type: "mrkdwn", text: `*Justification:*\n${justification}` },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve" },
          style: "primary",
          action_id: "approve",
          value: requestId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Reject" },
          style: "danger",
          action_id: "reject",
          value: requestId,
        },
      ],
    },
  ];

  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${slackBotToken}`,
    },
    body: JSON.stringify({ channel: slackChannelId, blocks }),
  });

  const body = (await response.json()) as { ok: boolean; error?: string };
  if (!body.ok) {
    throw new Error(`Slack API error: ${body.error}`);
  }
}

/**
 * Invoked by the WaitForApproval Step Functions state via the waitForTaskToken
 * integration pattern. Stores the task token in DynamoDB, sets the request
 * status to PENDING_APPROVAL, then sends a Slack notification if configured.
 *
 * The state machine remains paused until SendTaskSuccess or SendTaskFailure
 * is called by approveRequestHandler or rejectRequestHandler.
 */
export const handler = async (input: StoreTokenInput): Promise<void> => {
  await dynamo.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { id: input.requestId },
      UpdateExpression: "SET #s = :s, taskToken = :token, updatedAt = :now",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":s": "PENDING_APPROVAL",
        ":token": input.taskToken,
        ":now": new Date().toISOString(),
      },
    })
  );

  try {
    const [requestResult, settingsResult] = await Promise.all([
      dynamo.send(new GetCommand({ TableName: TABLE_NAME, Key: { id: input.requestId } })),
      dynamo.send(
        new GetCommand({ TableName: SETTINGS_TABLE_NAME, Key: { settingKey: "global" } })
      ),
    ]);

    const request = requestResult.Item;
    const settings = settingsResult.Item ?? {};
    const slackBotToken = settings.slackBotToken as string | undefined;
    const slackChannelId = settings.slackChannelId as string | undefined;

    // SNS approval notification (link-to-app). Sent first and internally
    // best-effort so a Slack failure below can't skip it. Independent toggle.
    if (request) {
      await notifyPendingApproval({
        request: request as NotifiableRequest,
        settings,
        topicArn: NOTIFICATIONS_TOPIC_ARN,
        appUrl: APP_CALLBACK_URL,
      });
    }

    if (request && slackBotToken && slackChannelId) {
      await sendSlackNotification(input.requestId, request, slackBotToken, slackChannelId);
    }
  } catch (err) {
    // Slack errors must not fail the Step Functions state — the approval workflow
    // continues regardless of notification delivery.
    console.error("Slack notification failed", JSON.stringify(err, Object.getOwnPropertyNames(err)));
  }
};
