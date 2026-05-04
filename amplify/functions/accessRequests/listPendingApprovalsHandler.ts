import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import {
  VerifiedPermissionsClient,
  IsAuthorizedCommand,
} from "@aws-sdk/client-verifiedpermissions";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const TABLE_NAME = process.env.ACCESS_REQUEST_TABLE_NAME!;
const POLICY_STORE_ID = process.env.AVP_POLICY_STORE_ID!;

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const avp = new VerifiedPermissionsClient({ region: REGION });

type AppSyncIdentity = {
  username: string;
  claims: Record<string, unknown>;
};

type AppSyncEvent = { arguments: Record<string, never>; identity: AppSyncIdentity };

/**
 * AppSync query resolver that returns PENDING_APPROVAL access requests the
 * calling admin is authorized to approve or reject.
 *
 * Authorization is determined by AVP: the caller must have a Cedar `approve`
 * policy for the request's permission set ARN (via Snitch::Approver or
 * Snitch::ApproverGroup membership).
 */
export const handler = async (event: AppSyncEvent) => {
  const callerUsername = event.identity.username;
  const callerGroups = (event.identity.claims["cognito:groups"] as string[]) ?? [];

  const requestScan = await dynamo.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: "#s = :s",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":s": "PENDING_APPROVAL" },
    })
  );

  const requests = requestScan.Items ?? [];
  if (requests.length === 0) return [];

  // De-duplicate permission set ARNs to minimize AVP calls
  const uniqueArns = [...new Set(requests.map((r) => r.permissionSetArn as string))];

  const authResults = await Promise.all(
    uniqueArns.map((arn) => checkApproveAuthorization(callerUsername, callerGroups, arn))
  );

  const allowedArns = new Set(uniqueArns.filter((_, i) => authResults[i]));

  return requests.filter((r) => allowedArns.has(r.permissionSetArn));
};

async function checkApproveAuthorization(
  callerUsername: string,
  callerGroups: string[],
  permissionSetArn: string
): Promise<boolean> {
  const result = await avp.send(
    new IsAuthorizedCommand({
      policyStoreId: POLICY_STORE_ID,
      principal: { entityType: "Snitch::Approver", entityId: callerUsername },
      action: { actionType: "Snitch::Action", actionId: "approve" },
      resource: { entityType: "Snitch::PermissionSet", entityId: permissionSetArn },
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
  return result.decision === "ALLOW";
}
