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

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((v) => setB.has(v));
}

type PolicyIdentity = {
  principalType: "USER" | "GROUP";
  principalId: string;
  accountIds: string[];
  ouIds: string[];
};

/**
 * Rejects any edit that changes a policy's principal or resource (accounts/OUs).
 * These define the policy's identity and its AVP static-policy scope, which
 * UpdatePolicy cannot modify — the only way to change them is delete + recreate.
 *
 * Example: editing a policy's name or permission sets is allowed; switching its
 * principal from GROUP "TeamLeads" to USER "alice" throws.
 */
function assertPrincipalAndResourceUnchanged(
  snapshot: Record<string, unknown>,
  next: PolicyIdentity
): void {
  const changed: string[] = [];
  if (snapshot.principalType !== next.principalType) changed.push("principal type");
  if (snapshot.principalId !== next.principalId) changed.push("principal");
  if (!sameStringSet((snapshot.accountIds as string[]) ?? [], next.accountIds))
    changed.push("accounts");
  if (!sameStringSet((snapshot.ouIds as string[]) ?? [], next.ouIds)) changed.push("OUs");

  if (changed.length > 0) {
    throw new Error(
      `Cannot change ${changed.join(", ")} on an existing policy. ` +
        `Delete this policy and create a new one instead.`
    );
  }
}

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

  // A policy's identity is (principal + resource). AVP forbids changing the
  // principal or resource scope of a static policy via UpdatePolicy, so these
  // fields are immutable once created — to change them, delete and recreate the
  // policy. The edit form locks them; this guard rejects any direct-API bypass.
  assertPrincipalAndResourceUnchanged(snapshot, {
    principalType: args.principalType,
    principalId: args.principalId,
    accountIds,
    ouIds,
  });

  await assertNoDuplicatePrincipalResource(dynamo, TABLE_NAME, {
    principalId: args.principalId,
    accountIds,
    ouIds,
    permissionSetArns,
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
      // Principal and resource scope are unchanged (enforced above), so an
      // in-place UpdatePolicy is always valid here.
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
