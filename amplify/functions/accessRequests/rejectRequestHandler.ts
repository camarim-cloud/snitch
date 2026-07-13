import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SFNClient, SendTaskFailureCommand } from "@aws-sdk/client-sfn";
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

type RejectInput = { requestId: string; approverComment?: string | null };

type AppSyncIdentity = {
  username: string;
  claims: Record<string, unknown>;
};

type AppSyncEvent = { arguments: RejectInput; identity: AppSyncIdentity };

/**
 * AppSync mutation resolver for rejecting an access request.
 * Updates DynamoDB to REJECTED atomically (including approvedBy, approverComment,
 * and taskToken=null) BEFORE calling SendTaskFailure. This ensures the record is
 * in a consistent terminal state even if SendTaskFailure fails transiently.
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

  if (request.requesterCognitoSub && approverUsername === request.requesterCognitoSub) {
    throw new Error("You cannot reject your own access request");
  }

  await assertIsAuthorizedApprover(request.accountId, request.permissionSetArn, approverUsername, callerGroups);

  const now = new Date().toISOString();

  // Write REJECTED + all approval fields atomically before SendTaskFailure,
  // so the record is in a final consistent state regardless of SFN outcome.
  await dynamo.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { id: requestId },
      UpdateExpression:
        "SET #s = :s, approvedBy = :by, approverComment = :comment, taskToken = :null, updatedAt = :now, decidedAt = :now",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":s": "REJECTED",
        ":by": approverUsername,
        ":comment": approverComment ?? null,
        ":null": null,
        ":now": now,
      },
    })
  );

  // Notify the Step Function to stop waiting — triggers the RejectionHandled Pass state
  await sfn.send(
    new SendTaskFailureCommand({
      taskToken: request.taskToken,
      error: "RequestRejected",
      cause: approverComment ?? "Request rejected by approver",
    })
  );

  return {
    ...request,
    status: "REJECTED",
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
    throw new Error(`You are not authorized to reject this request`);
  }
}
