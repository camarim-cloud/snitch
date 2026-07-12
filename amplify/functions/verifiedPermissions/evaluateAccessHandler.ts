import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import {
  VerifiedPermissionsClient,
  IsAuthorizedCommand,
} from "@aws-sdk/client-verifiedpermissions";
import {
  getIDCInstancePublic,
  listGroupMembershipsForUser,
  expandOUsToAccounts,
} from "../awsResources/helpers";

const REGION = process.env.AWS_REGION ?? "us-east-2";
const TABLE_NAME = process.env.PRIVILEGED_POLICY_TABLE_NAME!;
const POLICY_STORE_ID = process.env.AVP_POLICY_STORE_ID!;

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const avp = new VerifiedPermissionsClient({ region: REGION });

type EvaluateInput = { idcUserId: string };
type AppSyncEvent = { arguments: EvaluateInput };

export type PermittedAccess = {
  accountId: string;
  permissionSetArn: string;
  permissionSetName: string;
  maxDurationMinutes: number | null;
  requiresApproval: boolean;
};

/**
 * For the given IDC user, evaluates every (account, permissionSet) combination
 * found across all PrivilegedPolicy records against AVP IsAuthorized.
 *
 * Group memberships are fetched and included as entities so Cedar policies
 * with `principal in Snitch::Group::` are evaluated correctly.
 *
 * Returns only the (account, permissionSet) pairs where AVP returns ALLOW.
 *
 * Example: mutation { evaluateMyAccess(idcUserId: "abc-123") { accountId permissionSetArn } }
 */
export const handler = async (event: AppSyncEvent): Promise<PermittedAccess[]> => {
  const { idcUserId } = event.arguments;

  // Fetch group memberships so group-based Cedar policies resolve correctly
  const { identityStoreId } = await getIDCInstancePublic();
  const groupIds = await listGroupMembershipsForUser(identityStoreId, idcUserId);

  // Build the entity list: the user entity with group memberships
  const userEntity = {
    identifier: { entityType: "Snitch::User", entityId: idcUserId },
    attributes: {},
    parents: groupIds.map((gid) => ({
      entityType: "Snitch::Group",
      entityId: gid,
    })),
  };

  // Scan all policies to collect every unique (accountId, permissionSetArn) pair
  // across the whole table. We evaluate each combination once against AVP.
  const scanResult = await dynamo.send(new ScanCommand({ TableName: TABLE_NAME }));
  const policies = scanResult.Items ?? [];

  // OU-based policies grant access to every account inside the OU subtree. Expand
  // the OUs referenced by any policy to their member accounts, and keep each
  // account's OU ancestry so the AVP `resource in Snitch::OU` check resolves.
  const referencedOuIds = policies.flatMap((p) => (p.ouIds as string[] | undefined) ?? []);
  const { ouToAccounts, accountToAncestorOUs } = await expandOUsToAccounts(referencedOuIds);

  type Candidate = {
    accountId: string;
    permissionSetArn: string;
    permissionSetName: string;
    maxDurationMinutes: number | null;
    requiresApproval: boolean;
  };
  const seen = new Map<string, Candidate>();
  const candidates: Candidate[] = [];

  const upsertCandidate = (
    accountId: string,
    arn: string,
    name: string,
    policyMax: number | null,
    policyRequiresApproval: boolean
  ) => {
    const key = `${accountId}::${arn}`;
    const existing = seen.get(key);
    if (!existing) {
      const candidate: Candidate = {
        accountId,
        permissionSetArn: arn,
        permissionSetName: name,
        maxDurationMinutes: policyMax,
        requiresApproval: policyRequiresApproval,
      };
      seen.set(key, candidate);
      candidates.push(candidate);
      return;
    }
    // Use the most restrictive (minimum) max duration across policies
    if (policyMax !== null) {
      existing.maxDurationMinutes =
        existing.maxDurationMinutes === null
          ? policyMax
          : Math.min(existing.maxDurationMinutes, policyMax);
    }
    // If any policy requires approval for this pair, the pair requires approval
    if (policyRequiresApproval) existing.requiresApproval = true;
  };

  for (const policy of policies) {
    const permissionSetArns: string[] = policy.permissionSetArns ?? [];
    const permissionSetNames: string[] = policy.permissionSetNames ?? [];
    const policyMax: number | null = policy.maxDurationMinutes ?? null;
    const policyRequiresApproval: boolean = policy.requiresApproval ?? false;

    // A policy targets its explicit accounts plus every account inside its OUs.
    const targetAccountIds = new Set<string>(policy.accountIds ?? []);
    for (const ouId of (policy.ouIds as string[] | undefined) ?? []) {
      for (const accountId of ouToAccounts.get(ouId) ?? []) targetAccountIds.add(accountId);
    }

    for (const accountId of targetAccountIds) {
      for (let i = 0; i < permissionSetArns.length; i++) {
        const arn = permissionSetArns[i];
        upsertCandidate(accountId, arn, permissionSetNames[i] ?? arn, policyMax, policyRequiresApproval);
      }
    }
  }

  // Evaluate each candidate in parallel against AVP. The resource account carries
  // its OU ancestry as parents so `principal in Snitch::OU` policies resolve.
  const results = await Promise.all(
    candidates.map(async (candidate) => {
      const ancestorOUs = accountToAncestorOUs.get(candidate.accountId) ?? new Set<string>();
      const accountEntity = {
        identifier: { entityType: "Snitch::Account", entityId: candidate.accountId },
        attributes: {},
        parents: [...ancestorOUs].map((ouId) => ({
          entityType: "Snitch::OU",
          entityId: ouId,
        })),
      };

      const response = await avp.send(
        new IsAuthorizedCommand({
          policyStoreId: POLICY_STORE_ID,
          principal: { entityType: "Snitch::User", entityId: idcUserId },
          action: { actionType: "Snitch::Action", actionId: "assume" },
          resource: { entityType: "Snitch::Account", entityId: candidate.accountId },
          context: {
            contextMap: {
              permissionSetArn: { string: candidate.permissionSetArn },
            },
          },
          entities: {
            entityList: [userEntity, accountEntity],
          },
        })
      );

      return response.decision === "ALLOW" ? candidate : null;
    })
  );

  return results.filter((r): r is Candidate => r !== null);
};
