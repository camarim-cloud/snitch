import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  SSOAdminClient,
  CreateAccountAssignmentCommand,
  StatusValues,
} from "@aws-sdk/client-sso-admin";
import { getIDCInstancePublic } from "../awsResources/helpers";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const TABLE_NAME = process.env.ACCESS_REQUEST_TABLE_NAME!;

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const ssoAdmin = new SSOAdminClient({ region: REGION });

type AssignInput = {
  requestId: string;
  idcUserId: string;
  accountId: string;
  permissionSetArn: string;
  durationSeconds: number;
};

/**
 * Step Function task: calls CreateAccountAssignment to grant the IDC user
 * access to the account with the specified permission set, then marks the
 * AccessRequest as ACTIVE in DynamoDB.
 *
 * Throws on failure so the Step Function can catch and route to error handling.
 */
export const handler = async (input: AssignInput): Promise<AssignInput> => {
  const { instanceArn } = await getIDCInstancePublic();

  const result = await ssoAdmin.send(
    new CreateAccountAssignmentCommand({
      InstanceArn: instanceArn,
      TargetId: input.accountId,
      TargetType: "AWS_ACCOUNT",
      PermissionSetArn: input.permissionSetArn,
      PrincipalType: "USER",
      PrincipalId: input.idcUserId,
    })
  );

  const status = result.AccountAssignmentCreationStatus?.Status;
  if (status === StatusValues.FAILED) {
    const reason = result.AccountAssignmentCreationStatus?.FailureReason ?? "unknown";
    throw new Error(
      `CreateAccountAssignment failed for request ${input.requestId}: ${reason}`
    );
  }

  await dynamo.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { id: input.requestId },
      UpdateExpression: "SET #s = :s, updatedAt = :now, activatedAt = :now",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":s": "ACTIVE",
        ":now": new Date().toISOString(),
      },
    })
  );

  // Pass the full input through so subsequent states have all fields
  return input;
};
