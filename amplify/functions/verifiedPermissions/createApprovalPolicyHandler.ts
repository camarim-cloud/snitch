import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  VerifiedPermissionsClient,
  CreatePolicyCommand,
  DeletePolicyCommand,
} from "@aws-sdk/client-verifiedpermissions";
import { buildApprovalCedarPolicy } from "./buildApprovalCedarPolicy";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const POLICY_STORE_ID = process.env.AVP_POLICY_STORE_ID!;
const TABLE_NAME = process.env.APPROVAL_POLICY_TABLE_NAME!;

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const avp = new VerifiedPermissionsClient({ region: REGION });

type CreateInput = {
  permissionSetArn: string;
  permissionSetName?: string | null;
  principalType?: "USER" | "GROUP" | null;
  principalId: string;
  principalDisplayName?: string | null;
};

type AppSyncEvent = { arguments: CreateInput };

/**
 * AppSync mutation resolver that creates an ApprovalPolicy record.
 * Uses GetItem on the composite primary key (permissionSetArn + principalKey)
 * for an O(1) duplicate check before touching AVP.
 * Writes AVP first, then DDB. Rolls back the AVP policy if the DDB write fails.
 */
export const handler = async (event: AppSyncEvent) => {
  const {
    permissionSetArn,
    permissionSetName,
    principalType,
    principalId,
    principalDisplayName,
  } = event.arguments;

  const resolvedPrincipalType = principalType ?? "USER";
  const principalKey = `${resolvedPrincipalType}#${principalId}`;

  const existing = await dynamo.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { permissionSetArn, principalKey } })
  );
  if (existing.Item) {
    throw new Error(
      `An approval policy already exists for this approver on permission set ${permissionSetArn}`
    );
  }

  const cedarPolicy = buildApprovalCedarPolicy({
    principalType: resolvedPrincipalType,
    principalId,
    permissionSetArn,
  });

  const createPolicyResult = await avp.send(
    new CreatePolicyCommand({
      policyStoreId: POLICY_STORE_ID,
      definition: {
        static: {
          statement: cedarPolicy,
          description: `approve: ${resolvedPrincipalType}/${principalId} → ${permissionSetArn}`,
        },
      },
    })
  );

  const avpPolicyId = createPolicyResult.policyId!;
  const now = new Date().toISOString();

  const item = {
    permissionSetArn,
    principalKey,
    permissionSetName: permissionSetName ?? null,
    principalType: resolvedPrincipalType,
    principalId,
    principalDisplayName: principalDisplayName ?? null,
    avpPolicyId,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await dynamo.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  } catch (err) {
    await avp.send(new DeletePolicyCommand({ policyStoreId: POLICY_STORE_ID, policyId: avpPolicyId }));
    throw err;
  }

  return item;
};
