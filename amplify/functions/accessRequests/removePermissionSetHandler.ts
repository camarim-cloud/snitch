import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  SSOAdminClient,
  DeleteAccountAssignmentCommand,
  StatusValues,
} from "@aws-sdk/client-sso-admin";
import { getIDCInstancePublic } from "../awsResources/helpers";
import { notifyAccessEvent, type NotifiableRequest } from "../notifications/notify";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const TABLE_NAME = process.env.ACCESS_REQUEST_TABLE_NAME!;
const SETTINGS_TABLE_NAME = process.env.APP_SETTINGS_TABLE_NAME!;
const NOTIFICATIONS_TOPIC_ARN = process.env.NOTIFICATIONS_TOPIC_ARN;

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const ssoAdmin = new SSOAdminClient({ region: REGION });

type RemoveInput = {
  requestId: string;
  idcUserId: string;
  accountId: string;
  permissionSetArn: string;
  durationSeconds: number;
  revokedByAdmin?: boolean;
};

/**
 * Best-effort notification that a granted access has ended. Loads the full
 * request record (the Step Function input lacks email/names/duration) plus the
 * AppSettings toggles, then dispatches to Slack/SNS. Never throws.
 */
async function notifyFinished(requestId: string, finalStatus: string): Promise<void> {
  try {
    const [requestResult, settingsResult] = await Promise.all([
      dynamo.send(new GetCommand({ TableName: TABLE_NAME, Key: { id: requestId } })),
      dynamo.send(new GetCommand({ TableName: SETTINGS_TABLE_NAME, Key: { settingKey: "global" } })),
    ]);
    if (!requestResult.Item) return;
    await notifyAccessEvent({
      kind: "FINISHED",
      request: { ...(requestResult.Item as NotifiableRequest), status: finalStatus },
      settings: settingsResult.Item ?? {},
      topicArn: NOTIFICATIONS_TOPIC_ARN,
    });
  } catch (err) {
    console.error(
      "Access-finished notification failed",
      JSON.stringify(err, Object.getOwnPropertyNames(err))
    );
  }
}

/**
 * Step Function task: calls DeleteAccountAssignment to revoke the IDC user's
 * access, then marks the AccessRequest as EXPIRED in DynamoDB.
 *
 * Throws on failure so the Step Function execution is marked as failed and
 * can be investigated via CloudWatch / Step Functions console.
 */
export const handler = async (input: RemoveInput): Promise<void> => {
  const { instanceArn } = await getIDCInstancePublic();

  const result = await ssoAdmin.send(
    new DeleteAccountAssignmentCommand({
      InstanceArn: instanceArn,
      TargetId: input.accountId,
      TargetType: "AWS_ACCOUNT",
      PermissionSetArn: input.permissionSetArn,
      PrincipalType: "USER",
      PrincipalId: input.idcUserId,
    })
  );

  const status = result.AccountAssignmentDeletionStatus?.Status;
  if (status === StatusValues.FAILED) {
    const reason = result.AccountAssignmentDeletionStatus?.FailureReason ?? "unknown";
    throw new Error(
      `DeleteAccountAssignment failed for request ${input.requestId}: ${reason}`
    );
  }

  const finalStatus = input.revokedByAdmin === true ? "REVOKED" : "EXPIRED";

  await dynamo.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { id: input.requestId },
      UpdateExpression: "SET #s = :s, updatedAt = :now, deactivatedAt = :now",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":s": finalStatus,
        ":now": new Date().toISOString(),
      },
    })
  );

  await notifyFinished(input.requestId, finalStatus);
};
