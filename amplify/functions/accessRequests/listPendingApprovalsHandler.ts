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
 * calling user is authorized to approve or reject.
 *
 * Authorization is determined by AVP: the caller must have a Cedar `approve`
 * policy for the request's account (via Snitch::Approver or Snitch::ApproverGroup
 * membership) where context.permissionSetArn matches the `when` clause.
 */
export const handler = async (event: AppSyncEvent) => {
  const callerUsername = event.identity.username;
  const callerGroups = (event.identity.claims["cognito:groups"] as string[]) ?? [];

  // attribute_type(taskToken, :str) excludes items where taskToken was cleared to NULL
  // by approveRequestHandler before the Step Function updates the status to ACTIVE.
  const requestScan = await dynamo.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: "#s = :s AND attribute_type(taskToken, :str)",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":s": "PENDING_APPROVAL", ":str": "S" },
    })
  );

  // Filter out requests submitted by the caller — a user must not approve their own request,
  // even if they are a member of a group configured as an approver.
  const callerEmail = (event.identity.claims["email"] as string | undefined)?.toLowerCase();
  const requests = (requestScan.Items ?? []).filter(
    (r) => !callerEmail || !r.idcUserEmail || (r.idcUserEmail as string).toLowerCase() !== callerEmail
  );
  if (requests.length === 0) return [];

  // De-duplicate (accountId, permissionSetArn) pairs to minimize AVP calls
  const uniquePairs = [
    ...new Map(
      requests.map((r) => [`${r.accountId}|${r.permissionSetArn}`, { accountId: r.accountId as string, permissionSetArn: r.permissionSetArn as string }])
    ).values(),
  ];

  const authResults = await Promise.all(
    uniquePairs.map(({ accountId, permissionSetArn }) =>
      checkApproveAuthorization(callerUsername, callerGroups, accountId, permissionSetArn)
    )
  );

  const allowedPairKeys = new Set(
    uniquePairs.filter((_, i) => authResults[i]).map(({ accountId, permissionSetArn }) => `${accountId}|${permissionSetArn}`)
  );

  return requests.filter((r) => allowedPairKeys.has(`${r.accountId}|${r.permissionSetArn}`));
};

async function checkApproveAuthorization(
  callerUsername: string,
  callerGroups: string[],
  accountId: string,
  permissionSetArn: string
): Promise<boolean> {
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
  return result.decision === "ALLOW";
}
