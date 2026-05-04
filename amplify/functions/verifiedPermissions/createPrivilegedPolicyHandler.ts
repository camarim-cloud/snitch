import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  VerifiedPermissionsClient,
  CreatePolicyCommand,
  DeletePolicyCommand,
} from "@aws-sdk/client-verifiedpermissions";
import { buildCedarPolicy } from "./cedarPolicyBuilder";
import { assertNoDuplicatePrincipalResource } from "./policyConflictChecker";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const TABLE_NAME = process.env.PRIVILEGED_POLICY_TABLE_NAME!;
const POLICY_STORE_ID = process.env.AVP_POLICY_STORE_ID!;

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const avp = new VerifiedPermissionsClient({ region: REGION });

type CreateInput = {
  name: string;
  description?: string | null;
  principalType: "USER" | "GROUP";
  principalId: string;
  principalDisplayName?: string | null;
  accountIds?: string[] | null;
  ouIds?: string[] | null;
  permissionSetArns?: string[] | null;
  permissionSetNames?: string[] | null;
  maxDurationMinutes?: number | null;
  requiresApproval?: boolean | null;
};

type AppSyncEvent = { arguments: CreateInput };

export const handler = async (event: AppSyncEvent) => {
  const args = event.arguments;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const accountIds = args.accountIds ?? [];
  const ouIds = args.ouIds ?? [];
  const permissionSetArns = args.permissionSetArns ?? [];

  await assertNoDuplicatePrincipalResource(dynamo, TABLE_NAME, {
    principalId: args.principalId,
    accountIds,
    ouIds,
  });

  // Step 1: Create Cedar policy in AVP first so rollback is a simple delete
  const statement = buildCedarPolicy({
    principalType: args.principalType,
    principalId: args.principalId,
    accountIds,
    ouIds,
    permissionSetArns,
  });

  const avpResult = await avp.send(
    new CreatePolicyCommand({
      policyStoreId: POLICY_STORE_ID,
      definition: {
        static: {
          description: args.name,
          statement,
        },
      },
    })
  );
  const avpPolicyId = avpResult.policyId!;

  // Step 2: Write to DynamoDB. Rollback AVP policy if this fails.
  const item = {
    id,
    name: args.name,
    description: args.description ?? null,
    principalType: args.principalType,
    principalId: args.principalId,
    principalDisplayName: args.principalDisplayName ?? null,
    accountIds,
    ouIds,
    permissionSetArns,
    permissionSetNames: args.permissionSetNames ?? [],
    maxDurationMinutes: args.maxDurationMinutes ?? null,
    requiresApproval: args.requiresApproval ?? false,
    avpPolicyId,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await dynamo.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  } catch (err) {
    await avp.send(
      new DeletePolicyCommand({ policyStoreId: POLICY_STORE_ID, policyId: avpPolicyId })
    );
    throw err;
  }

  return item;
};
