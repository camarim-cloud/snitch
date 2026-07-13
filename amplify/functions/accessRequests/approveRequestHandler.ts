import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SFNClient, SendTaskSuccessCommand } from "@aws-sdk/client-sfn";
import {
  VerifiedPermissionsClient,
  IsAuthorizedCommand,
} from "@aws-sdk/client-verifiedpermissions";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const TABLE_NAME = process.env.ACCESS_REQUEST_TABLE_NAME!;
const POLICY_STORE_ID = process.env.AVP_POLICY_STORE_ID!;

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const sfn = new SFNClient({ region: REGION });
const avp = new VerifiedPermissionsClient({ region: REGION });

type ApproveInput = { requestId: string; approverComment?: string | null };

type AppSyncIdentity = {
  username: string;
  claims: Record<string, unknown>;
};

type AppSyncEvent = { arguments: ApproveInput; identity: AppSyncIdentity };

/**
 * AppSync mutation resolver for approving an access request.
 * Validates the caller is a configured approver for the matching policy,
 * updates DynamoDB, and resumes the Step Function via SendTaskSuccess.
 *
 * The SendTaskSuccess output contains the fields AssignPermissionSet expects.
 */
export const handler = async (event: AppSyncEvent) => {
  const { requestId, approverComment } = event.arguments;
  const approverUsername = event.identity.username;
  const callerGroups = (event.identity.claims["cognito:groups"] as string[]) ?? [];

  const getResult = await dynamo.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { id: requestId } })
  );
  if (!getResult.Item) {
    throw new Error(`Access request not found: ${requestId}`);
  }
  const request = getResult.Item;

  if (request.status !== "PENDING_APPROVAL") {
    throw new Error(
      `Expected status PENDING_APPROVAL, got: ${JSON.stringify(request.status)}`
    );
  }
  if (!request.taskToken) {
    throw new Error(
      `Expected a taskToken on request ${requestId}, but none was found`
    );
  }

  // requesterCognitoSub is stored at request-creation time; both sides are
  // Cognito subs from the access token, so no email claim is needed.
  if (request.requesterCognitoSub && approverUsername === request.requesterCognitoSub) {
    throw new Error("You cannot approve your own access request");
  }

  await assertIsAuthorizedApprover(request.accountId, request.permissionSetArn, approverUsername, callerGroups);

  const now = new Date().toISOString();
  await dynamo.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { id: requestId },
      UpdateExpression:
        "SET approvedBy = :by, approverComment = :comment, taskToken = :null, updatedAt = :now, decidedAt = :now",
      ExpressionAttributeValues: {
        ":by": approverUsername,
        ":comment": approverComment ?? null,
        ":null": null,
        ":now": now,
      },
    })
  );

  // Resume the Step Function — output flows into CheckStartTime as its payload
  await sfn.send(
    new SendTaskSuccessCommand({
      taskToken: request.taskToken,
      output: JSON.stringify({
        requestId,
        idcUserId: request.idcUserId,
        accountId: request.accountId,
        permissionSetArn: request.permissionSetArn,
        durationSeconds: (request.durationMinutes as number) * 60,
        startTime: request.startTime ?? null,
      }),
    })
  );

  return {
    ...request,
    approvedBy: approverUsername,
    approverComment: approverComment ?? null,
    taskToken: null,
    updatedAt: now,
    decidedAt: now,
  };
};

async function assertIsAuthorizedApprover(
  accountId: string,
  permissionSetArn: string,
  callerUsername: string,
  callerGroups: string[]
): Promise<void> {
  const result = await avp.send(
    new IsAuthorizedCommand({
      policyStoreId: POLICY_STORE_ID,
      principal: { entityType: "Snitch::Approver", entityId: callerUsername },
      action: { actionType: "Snitch::Action", actionId: "approve" },
      resource: { entityType: "Snitch::Account", entityId: accountId },
      context: {
        contextMap: { permissionSetArn: { string: permissionSetArn } },
      },
      entities: {
        entityList: [
          {
            identifier: { entityType: "Snitch::Approver", entityId: callerUsername },
            attributes: {},
            parents: callerGroups.map((g) => ({
              entityType: "Snitch::ApproverGroup",
              entityId: g,
            })),
          },
        ],
      },
    })
  );

  if (result.decision !== "ALLOW") {
    throw new Error(`You are not authorized to approve this request`);
  }
}
