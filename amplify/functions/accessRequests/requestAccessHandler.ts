import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { notifyAccessEvent } from "../notifications/notify";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const TABLE_NAME = process.env.ACCESS_REQUEST_TABLE_NAME!;
const SETTINGS_TABLE_NAME = process.env.APP_SETTINGS_TABLE_NAME!;
const STATE_MACHINE_ARN = process.env.ACCESS_REQUEST_STATE_MACHINE_ARN!;
const NOTIFICATIONS_TOPIC_ARN = process.env.NOTIFICATIONS_TOPIC_ARN;

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const sfn = new SFNClient({ region: REGION });

/**
 * Best-effort notification that a new access request was created. Reads the
 * per-channel toggles from AppSettings and dispatches to Slack/SNS. Never throws
 * — a notification failure must not fail the request mutation.
 */
async function notifyRequested(request: AccessRequest): Promise<void> {
  try {
    const settingsResult = await dynamo.send(
      new GetCommand({ TableName: SETTINGS_TABLE_NAME, Key: { settingKey: "global" } })
    );
    await notifyAccessEvent({
      kind: "REQUESTED",
      request,
      settings: settingsResult.Item ?? {},
      topicArn: NOTIFICATIONS_TOPIC_ARN,
    });
  } catch (err) {
    console.error(
      "Access-request notification failed",
      JSON.stringify(err, Object.getOwnPropertyNames(err))
    );
  }
}

type RequestAccessInput = {
  idcUserId: string;
  idcUserEmail?: string | null;
  idcUserDisplayName?: string | null;
  accountId: string;
  accountName?: string | null;
  permissionSetArn: string;
  permissionSetName: string;
  durationMinutes: number;
  requiresApproval?: boolean | null;
  justification: string;
  startTime?: string | null;
};

type AppSyncIdentity = { username: string };
type AppSyncEvent = { arguments: RequestAccessInput; identity: AppSyncIdentity };

export type AccessRequest = {
  id: string;
  requesterCognitoSub: string;
  idcUserId: string;
  idcUserEmail: string | null;
  idcUserDisplayName: string | null;
  accountId: string;
  accountName: string | null;
  permissionSetArn: string;
  permissionSetName: string;
  durationMinutes: number;
  requiresApproval: boolean;
  justification: string;
  startTime: string | null;
  status: "PENDING" | "PENDING_APPROVAL" | "SCHEDULED" | "ACTIVE" | "EXPIRED" | "FAILED" | "REJECTED";
  taskToken: string | null;
  approvedBy: string | null;
  approverComment: string | null;
  stepFunctionExecutionArn: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * AppSync resolver: persists an AccessRequest record and starts the Step
 * Function execution. If the matching PrivilegedPolicy requires approval the
 * initial status is PENDING_APPROVAL and the state machine will pause at the
 * WaitForApproval state; otherwise it is PENDING and proceeds immediately.
 */
export const handler = async (event: AppSyncEvent): Promise<AccessRequest> => {
  const args = event.arguments;
  const requesterCognitoSub = event.identity.username;

  if (args.durationMinutes <= 0) {
    throw new Error(
      `Expected durationMinutes to be a positive number, got: ${JSON.stringify(args.durationMinutes)}`
    );
  }

  // requiresApproval is determined by the frontend via evaluateMyAccess and
  // passed through the mutation. The AVP check already enforces who can request
  // what; approval is a workflow gate on top of that authorization.
  const requiresApproval = args.requiresApproval === true;
  const startTime = args.startTime ?? null;

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const initialStatus = requiresApproval
    ? "PENDING_APPROVAL"
    : startTime
    ? "SCHEDULED"
    : "PENDING";

  const item: AccessRequest = {
    id,
    requesterCognitoSub,
    idcUserId: args.idcUserId,
    idcUserEmail: args.idcUserEmail ?? null,
    idcUserDisplayName: args.idcUserDisplayName ?? null,
    accountId: args.accountId,
    accountName: args.accountName ?? null,
    permissionSetArn: args.permissionSetArn,
    permissionSetName: args.permissionSetName,
    durationMinutes: args.durationMinutes,
    requiresApproval,
    justification: args.justification,
    startTime,
    status: initialStatus,
    taskToken: null,
    approvedBy: null,
    approverComment: null,
    stepFunctionExecutionArn: null,
    createdAt: now,
    updatedAt: now,
  };

  await dynamo.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));

  const execution = await sfn.send(
    new StartExecutionCommand({
      stateMachineArn: STATE_MACHINE_ARN,
      name: id,
      input: JSON.stringify({
        requestId: id,
        idcUserId: args.idcUserId,
        accountId: args.accountId,
        permissionSetArn: args.permissionSetArn,
        durationSeconds: args.durationMinutes * 60,
        requiresApproval,
        startTime,
      }),
    })
  );

  const updatedItem: AccessRequest = {
    ...item,
    stepFunctionExecutionArn: execution.executionArn ?? null,
    updatedAt: new Date().toISOString(),
  };

  await dynamo.send(new PutCommand({ TableName: TABLE_NAME, Item: updatedItem }));

  await notifyRequested(updatedItem);

  return updatedItem;
};

