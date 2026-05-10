import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const TABLE_NAME = process.env.ACCESS_REQUEST_TABLE_NAME!;
const SETTINGS_TABLE_NAME = process.env.APP_SETTINGS_TABLE_NAME!;

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

function formatDurationMinutes(minutes: number): string {
  const days = Math.floor(minutes / (60 * 24));
  const hours = Math.floor((minutes % (60 * 24)) / 60);
  const mins = minutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0) parts.push(`${mins}min`);
  return parts.join(" ") || "0min";
}

async function sendSlackNotification(
  requestId: string,
  request: Record<string, unknown>,
  slackBotToken: string,
  slackChannelId: string
): Promise<void> {
  const requesterName = (request.idcUserDisplayName as string | null) ?? "Unknown";
  const requesterEmail = (request.idcUserEmail as string | null) ?? "";
  const accountId = request.accountId as string;
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
        { type: "mrkdwn", text: `*Account:*\n${accountId}` },
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
    const slackBotToken = settingsResult.Item?.slackBotToken as string | undefined;
    const slackChannelId = settingsResult.Item?.slackChannelId as string | undefined;

    if (request && slackBotToken && slackChannelId) {
      await sendSlackNotification(input.requestId, request, slackBotToken, slackChannelId);
    }
  } catch (err) {
    // Slack errors must not fail the Step Functions state — the approval workflow
    // continues regardless of notification delivery.
    console.error("Slack notification failed", JSON.stringify(err, Object.getOwnPropertyNames(err)));
  }
};
