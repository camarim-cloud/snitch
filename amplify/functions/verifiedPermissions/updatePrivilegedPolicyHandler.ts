import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  VerifiedPermissionsClient,
  CreatePolicyCommand,
  UpdatePolicyCommand,
} from "@aws-sdk/client-verifiedpermissions";
import { buildCedarPolicy } from "./cedarPolicyBuilder";
import { assertNoDuplicatePrincipalResource } from "./policyConflictChecker";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const TABLE_NAME = process.env.PRIVILEGED_POLICY_TABLE_NAME!;
const POLICY_STORE_ID = process.env.AVP_POLICY_STORE_ID!;

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const avp = new VerifiedPermissionsClient({ region: REGION });

type UpdateInput = {
  id: string;
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

type AppSyncEvent = { arguments: UpdateInput };

export const handler = async (event: AppSyncEvent) => {
  const args = event.arguments;

  // Step 1: Read current item to get avpPolicyId and snapshot for rollback
  const existing = await dynamo.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { id: args.id } })
  );
  if (!existing.Item) throw new Error(`PrivilegedPolicy not found: ${args.id}`);
  const snapshot = existing.Item;

  const accountIds = args.accountIds ?? [];
  const ouIds = args.ouIds ?? [];
  const permissionSetArns = args.permissionSetArns ?? [];
  const updatedAt = new Date().toISOString();

  await assertNoDuplicatePrincipalResource(dynamo, TABLE_NAME, {
    principalId: args.principalId,
    accountIds,
    ouIds,
    excludeId: args.id,
  });

  // Step 2: Update DynamoDB first
  await dynamo.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { id: args.id },
      UpdateExpression: [
        "SET #name = :name",
        "description = :description",
        "principalType = :principalType",
        "principalId = :principalId",
        "principalDisplayName = :principalDisplayName",
        "accountIds = :accountIds",
        "ouIds = :ouIds",
        "permissionSetArns = :permissionSetArns",
        "permissionSetNames = :permissionSetNames",
        "maxDurationMinutes = :maxDurationMinutes",
        "requiresApproval = :requiresApproval",
        "updatedAt = :updatedAt",
      ].join(", "),
      ExpressionAttributeNames: { "#name": "name" },
      ExpressionAttributeValues: {
        ":name": args.name,
        ":description": args.description ?? null,
        ":principalType": args.principalType,
        ":principalId": args.principalId,
        ":principalDisplayName": args.principalDisplayName ?? null,
        ":accountIds": accountIds,
        ":ouIds": ouIds,
        ":permissionSetArns": permissionSetArns,
        ":permissionSetNames": args.permissionSetNames ?? [],
        ":maxDurationMinutes": args.maxDurationMinutes ?? null,
        ":requiresApproval": args.requiresApproval ?? false,
        ":updatedAt": updatedAt,
      },
    })
  );

  // Step 3: Sync Cedar policy in AVP. Rollback DynamoDB to snapshot on failure.
  const statement = buildCedarPolicy({
    principalType: args.principalType,
    principalId: args.principalId,
    accountIds,
    ouIds,
    permissionSetArns,
  });

  let avpPolicyId: string = snapshot.avpPolicyId ?? null;

  try {
    if (avpPolicyId) {
      await avp.send(
        new UpdatePolicyCommand({
          policyStoreId: POLICY_STORE_ID,
          policyId: avpPolicyId,
          definition: {
            static: {
              description: args.name,
              statement,
            },
          },
        })
      );
    } else {
      // Policy was created before AVP integration; create it now and persist the ID
      const created = await avp.send(
        new CreatePolicyCommand({
          policyStoreId: POLICY_STORE_ID,
          definition: { static: { description: args.name, statement } },
        })
      );
      avpPolicyId = created.policyId!;
      await dynamo.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { id: args.id },
          UpdateExpression: "SET avpPolicyId = :avpPolicyId",
          ExpressionAttributeValues: { ":avpPolicyId": avpPolicyId },
        })
      );
    }
  } catch (err) {
    // Rollback: restore DynamoDB to the pre-update snapshot
    await dynamo.send(new PutCommand({ TableName: TABLE_NAME, Item: snapshot }));
    throw err;
  }

  return {
    ...snapshot,
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
    updatedAt,
  };
};
