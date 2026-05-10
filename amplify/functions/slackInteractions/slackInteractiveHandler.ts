import { createHmac, timingSafeEqual } from "crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  AdminListGroupsForUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  VerifiedPermissionsClient,
  IsAuthorizedCommand,
} from "@aws-sdk/client-verifiedpermissions";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const SETTINGS_TABLE = process.env.APP_SETTINGS_TABLE_NAME!;
const ACCESS_REQUEST_TABLE = process.env.ACCESS_REQUEST_TABLE_NAME!;
const USER_POOL_ID = process.env.AUTH_USER_POOL_ID!;
const POLICY_STORE_ID = process.env.AVP_POLICY_STORE_ID!;
const APPROVE_FUNCTION_ARN = process.env.APPROVE_REQUEST_FUNCTION_ARN!;
const REJECT_FUNCTION_ARN = process.env.REJECT_REQUEST_FUNCTION_ARN!;

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const cognito = new CognitoIdentityProviderClient({ region: REGION });
const avp = new VerifiedPermissionsClient({ region: REGION });
const lambda = new LambdaClient({ region: REGION });

// Minimal Lambda Function URL event type
type FunctionUrlEvent = {
  headers: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
};

type FunctionUrlResult = {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
};

type SlackPayload = {
  type: string;
  user: { id: string; username: string };
  actions: Array<{ action_id: string; value: string }>;
  response_url: string;
};

type AppSettings = {
  slackBotToken?: string;
  slackSigningSecret?: string;
  slackChannelId?: string;
};

async function getAppSettings(): Promise<AppSettings> {
  const result = await dynamo.send(
    new GetCommand({ TableName: SETTINGS_TABLE, Key: { settingKey: "global" } })
  );
  return {
    slackBotToken: result.Item?.slackBotToken,
    slackSigningSecret: result.Item?.slackSigningSecret,
    slackChannelId: result.Item?.slackChannelId,
  };
}

function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  rawBody: string,
  slackSignature: string
): boolean {
  const sigBase = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${createHmac("sha256", signingSecret).update(sigBase).digest("hex")}`;
  const expectedBuf = Buffer.from(expected);
  const receivedBuf = Buffer.from(slackSignature);
  if (expectedBuf.length !== receivedBuf.length) return false;
  return timingSafeEqual(expectedBuf, receivedBuf);
}

async function getSlackUserEmail(userId: string, botToken: string): Promise<string> {
  const res = await fetch(`https://slack.com/api/users.info?user=${userId}`, {
    headers: { Authorization: `Bearer ${botToken}` },
  });
  const body = (await res.json()) as { ok: boolean; user?: { profile?: { email?: string } } };
  if (!body.ok || !body.user?.profile?.email) {
    throw new Error(`Could not retrieve email for Slack user ${userId}`);
  }
  return body.user.profile.email;
}

async function getCognitoUserByEmail(
  email: string
): Promise<{ username: string; groups: string[] } | null> {
  const listResult = await cognito.send(
    new ListUsersCommand({
      UserPoolId: USER_POOL_ID,
      Filter: `email = "${email}"`,
      Limit: 1,
    })
  );
  const user = listResult.Users?.[0];
  if (!user?.Username) return null;

  const groupsResult = await cognito.send(
    new AdminListGroupsForUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: user.Username,
    })
  );
  const groups = (groupsResult.Groups ?? []).map((g) => g.GroupName ?? "").filter(Boolean);
  return { username: user.Username, groups };
}

async function assertAvpAuthorized(
  cognitoUsername: string,
  cognitoGroups: string[],
  accountId: string,
  permissionSetArn: string
): Promise<void> {
  const result = await avp.send(
    new IsAuthorizedCommand({
      policyStoreId: POLICY_STORE_ID,
      principal: { entityType: "Snitch::Approver", entityId: cognitoUsername },
      action: { actionType: "Snitch::Action", actionId: "approve" },
      resource: { entityType: "Snitch::Account", entityId: accountId },
      context: { contextMap: { permissionSetArn: { string: permissionSetArn } } },
      entities: {
        entityList: [
          {
            identifier: { entityType: "Snitch::Approver", entityId: cognitoUsername },
            attributes: {},
            parents: cognitoGroups.map((g) => ({
              entityType: "Snitch::ApproverGroup",
              entityId: g,
            })),
          },
        ],
      },
    })
  );
  if (result.decision !== "ALLOW") {
    throw new Error("You are not authorized to approve this request");
  }
}

async function invokeLambdaAsApprover(
  functionArn: string,
  requestId: string,
  cognitoUsername: string,
  cognitoGroups: string[],
  approverComment: string
): Promise<void> {
  const payload = JSON.stringify({
    arguments: { requestId, approverComment },
    identity: {
      username: cognitoUsername,
      claims: { "cognito:groups": cognitoGroups },
    },
  });

  const result = await lambda.send(
    new InvokeCommand({
      FunctionName: functionArn,
      InvocationType: "RequestResponse",
      Payload: Buffer.from(payload),
    })
  );

  if (result.FunctionError) {
    const body = result.Payload ? Buffer.from(result.Payload).toString() : "{}";
    throw new Error(`Handler error: ${body}`);
  }
}

async function updateSlackMessage(responseUrl: string, text: string): Promise<void> {
  await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ replace_original: true, text }),
  });
}

/**
 * Lambda Function URL handler for Slack interactive component callbacks.
 * Verifies the Slack signature, maps the Slack user's email to a Cognito
 * identity, checks authorization via AVP, then delegates to the existing
 * approveRequestFunction or rejectRequestFunction Lambda.
 */
export const handler = async (event: FunctionUrlEvent): Promise<FunctionUrlResult> => {
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : (event.body ?? "");

  const timestamp = event.headers["x-slack-request-timestamp"] ?? "";
  const slackSignature = event.headers["x-slack-signature"] ?? "";

  const settings = await getAppSettings();

  if (!settings.slackSigningSecret) {
    return { statusCode: 403, body: "Slack not configured" };
  }

  if (!verifySlackSignature(settings.slackSigningSecret, timestamp, rawBody, slackSignature)) {
    return { statusCode: 403, body: "Invalid signature" };
  }

  const payloadStr = new URLSearchParams(rawBody).get("payload");
  if (!payloadStr) {
    return { statusCode: 400, body: "Missing payload" };
  }

  let payload: SlackPayload;
  try {
    payload = JSON.parse(payloadStr) as SlackPayload;
  } catch {
    return { statusCode: 400, body: "Invalid payload JSON" };
  }

  const action = payload.actions?.[0];
  if (!action || (action.action_id !== "approve" && action.action_id !== "reject")) {
    return { statusCode: 400, body: "Unknown action" };
  }

  const requestId = action.value;
  const responseUrl = payload.response_url;

  if (!settings.slackBotToken) {
    await updateSlackMessage(responseUrl, "Slack bot token not configured.");
    return { statusCode: 200 };
  }

  let slackUserEmail: string;
  try {
    slackUserEmail = await getSlackUserEmail(payload.user.id, settings.slackBotToken);
  } catch (err) {
    await updateSlackMessage(responseUrl, "Could not retrieve your Slack email address.");
    return { statusCode: 200 };
  }

  const requestResult = await dynamo.send(
    new GetCommand({ TableName: ACCESS_REQUEST_TABLE, Key: { id: requestId } })
  );
  const request = requestResult.Item;

  if (!request) {
    await updateSlackMessage(responseUrl, `Request ${requestId} not found.`);
    return { statusCode: 200 };
  }
  if (request.status !== "PENDING_APPROVAL") {
    await updateSlackMessage(responseUrl, `This request is no longer pending approval (status: ${request.status}).`);
    return { statusCode: 200 };
  }

  // Self-approval guard: compare by email since we don't have Cognito session
  if (request.idcUserEmail && request.idcUserEmail === slackUserEmail) {
    await updateSlackMessage(responseUrl, "You cannot approve or reject your own access request.");
    return { statusCode: 200 };
  }

  const cognitoUser = await getCognitoUserByEmail(slackUserEmail);
  if (!cognitoUser) {
    await updateSlackMessage(
      responseUrl,
      "Your Slack email does not match any user in this system."
    );
    return { statusCode: 200 };
  }

  try {
    await assertAvpAuthorized(
      cognitoUser.username,
      cognitoUser.groups,
      request.accountId as string,
      request.permissionSetArn as string
    );
  } catch {
    await updateSlackMessage(
      responseUrl,
      "You are not authorized to approve this request."
    );
    return { statusCode: 200 };
  }

  const functionArn = action.action_id === "approve" ? APPROVE_FUNCTION_ARN : REJECT_FUNCTION_ARN;
  const approverComment =
    action.action_id === "approve" ? "Approved via Slack" : "Rejected via Slack";

  try {
    await invokeLambdaAsApprover(
      functionArn,
      requestId,
      cognitoUser.username,
      cognitoUser.groups,
      approverComment
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateSlackMessage(responseUrl, `Action failed: ${message}`);
    return { statusCode: 200 };
  }

  const resultText =
    action.action_id === "approve"
      ? `✅ Approved by ${slackUserEmail}`
      : `❌ Rejected by ${slackUserEmail}`;
  await updateSlackMessage(responseUrl, resultText);

  return { statusCode: 200 };
};
