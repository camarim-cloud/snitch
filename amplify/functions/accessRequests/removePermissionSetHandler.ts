import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  SSOAdminClient,
  DeleteAccountAssignmentCommand,
  StatusValues,
} from "@aws-sdk/client-sso-admin";
import { getIDCInstancePublic } from "../awsResources/helpers";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const TABLE_NAME = process.env.ACCESS_REQUEST_TABLE_NAME!;

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

  await dynamo.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { id: input.requestId },
      UpdateExpression: "SET #s = :s, updatedAt = :now, deactivatedAt = :now",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":s": input.revokedByAdmin === true ? "REVOKED" : "EXPIRED",
        ":now": new Date().toISOString(),
      },
    })
  );
};
