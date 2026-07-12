import {
  SSOAdminClient,
  ListInstancesCommand,
  ListPermissionSetsCommand,
  DescribePermissionSetCommand,
} from "@aws-sdk/client-sso-admin";
import {
  IdentitystoreClient,
  ListUsersCommand,
  ListGroupsCommand,
  ListGroupMembershipsForMemberCommand,
} from "@aws-sdk/client-identitystore";
import {
  OrganizationsClient,
  ListAccountsCommand,
  ListAccountsForParentCommand,
  ListRootsCommand,
  ListOrganizationalUnitsForParentCommand,
} from "@aws-sdk/client-organizations";

const REGION = process.env.AWS_REGION ?? "us-east-2";

const ssoAdmin = new SSOAdminClient({ region: REGION });
// Organizations is a global service; its API endpoint lives in us-east-1
const organizations = new OrganizationsClient({ region: "us-east-1" });

async function getIDCInstance() {
  const result = await ssoAdmin.send(new ListInstancesCommand({}));
  const instance = result.Instances?.[0];
  if (!instance?.InstanceArn || !instance?.IdentityStoreId) {
    throw new Error("No IAM Identity Center instance found");
  }
  return {
    instanceArn: instance.InstanceArn,
    identityStoreId: instance.IdentityStoreId,
  };
}

export async function listIDCUsers() {
  const { identityStoreId } = await getIDCInstance();
  const identityStore = new IdentitystoreClient({ region: REGION });

  const users: Array<{
    id: string;
    userName: string;
    displayName: string;
    email: string | null;
  }> = [];
  let nextToken: string | undefined;

  do {
    const result = await identityStore.send(
      new ListUsersCommand({ IdentityStoreId: identityStoreId, NextToken: nextToken })
    );
    for (const user of result.Users ?? []) {
      users.push({
        id: user.UserId ?? "",
        userName: user.UserName ?? "",
        displayName: user.DisplayName ?? user.UserName ?? "",
        email: user.Emails?.[0]?.Value ?? null,
      });
    }
    nextToken = result.NextToken;
  } while (nextToken);

  return users;
}

export async function listIDCGroups() {
  const { identityStoreId } = await getIDCInstance();
  const identityStore = new IdentitystoreClient({ region: REGION });

  const groups: Array<{
    id: string;
    displayName: string;
    description: string | null;
  }> = [];
  let nextToken: string | undefined;

  do {
    const result = await identityStore.send(
      new ListGroupsCommand({ IdentityStoreId: identityStoreId, NextToken: nextToken })
    );
    for (const group of result.Groups ?? []) {
      groups.push({
        id: group.GroupId ?? "",
        displayName: group.DisplayName ?? "",
        description: group.Description ?? null,
      });
    }
    nextToken = result.NextToken;
  } while (nextToken);

  return groups;
}

export async function listAWSAccounts() {
  const accounts: Array<{
    id: string;
    name: string;
    email: string | null;
    status: string | null;
  }> = [];
  let nextToken: string | undefined;

  do {
    const result = await organizations.send(
      new ListAccountsCommand({ NextToken: nextToken })
    );
    for (const account of result.Accounts ?? []) {
      accounts.push({
        id: account.Id ?? "",
        name: account.Name ?? "",
        email: account.Email ?? null,
        status: account.Status ?? null,
      });
    }
    nextToken = result.NextToken;
  } while (nextToken);

  return accounts;
}

export async function listOUs() {
  const ous: Array<{ id: string; name: string; arn: string | null }> = [];

  const rootsResult = await organizations.send(new ListRootsCommand({}));

  async function collectOUs(parentId: string): Promise<void> {
    let nextToken: string | undefined;
    do {
      const result = await organizations.send(
        new ListOrganizationalUnitsForParentCommand({
          ParentId: parentId,
          NextToken: nextToken,
        })
      );
      for (const ou of result.OrganizationalUnits ?? []) {
        ous.push({ id: ou.Id ?? "", name: ou.Name ?? "", arn: ou.Arn ?? null });
        if (ou.Id) await collectOUs(ou.Id);
      }
      nextToken = result.NextToken;
    } while (nextToken);
  }

  for (const root of rootsResult.Roots ?? []) {
    if (root.Id) await collectOUs(root.Id);
  }

  return ous;
}

/**
 * Finds the single IDC user whose primary email matches the given address.
 * Returns null when no match is found rather than throwing, so callers can
 * surface a friendly "not found" message instead of a 500.
 *
 * Example: getMyIDCUser("alice@example.com")
 */
export async function getMyIDCUser(email: string) {
  const users = await listIDCUsers();
  return users.find((u) => u.email === email) ?? null;
}

/**
 * Returns the IDC group IDs that the given user belongs to.
 * Used to build the entity list for AVP IsAuthorized so group-based
 * Cedar policies are evaluated correctly.
 *
 * Example: listGroupMembershipsForUser("identityStoreId", "userId")
 */
export async function listGroupMembershipsForUser(
  identityStoreId: string,
  userId: string
): Promise<string[]> {
  const identityStore = new IdentitystoreClient({ region: REGION });
  const groupIds: string[] = [];
  let nextToken: string | undefined;

  do {
    const result = await identityStore.send(
      new ListGroupMembershipsForMemberCommand({
        IdentityStoreId: identityStoreId,
        MemberId: { UserId: userId },
        NextToken: nextToken,
      })
    );
    for (const membership of result.GroupMemberships ?? []) {
      if (membership.GroupId) groupIds.push(membership.GroupId);
    }
    nextToken = result.NextToken;
  } while (nextToken);

  return groupIds;
}

/**
 * Returns the IDC instance ARN and identity store ID.
 * Re-exported so Lambda handlers outside this module can reuse it.
 *
 * Example: const { identityStoreId } = await getIDCInstancePublic()
 */
export { getIDCInstance as getIDCInstancePublic };

async function listAccountIdsForParent(parentId: string): Promise<string[]> {
  const ids: string[] = [];
  let nextToken: string | undefined;
  do {
    const result = await organizations.send(
      new ListAccountsForParentCommand({ ParentId: parentId, NextToken: nextToken })
    );
    for (const account of result.Accounts ?? []) if (account.Id) ids.push(account.Id);
    nextToken = result.NextToken;
  } while (nextToken);
  return ids;
}

async function listChildOUIds(parentId: string): Promise<string[]> {
  const ids: string[] = [];
  let nextToken: string | undefined;
  do {
    const result = await organizations.send(
      new ListOrganizationalUnitsForParentCommand({ ParentId: parentId, NextToken: nextToken })
    );
    for (const ou of result.OrganizationalUnits ?? []) if (ou.Id) ids.push(ou.Id);
    nextToken = result.NextToken;
  } while (nextToken);
  return ids;
}

export type OUExpansion = {
  // Referenced (and intermediate) OU id → every account id transitively inside it
  ouToAccounts: Map<string, Set<string>>;
  // Account id → the OU ids it descends from (flattened ancestry within referenced subtrees)
  accountToAncestorOUs: Map<string, Set<string>>;
};

/**
 * Expands each referenced OU to the AWS accounts within it (recursively descending
 * into nested OUs) and records each account's OU ancestry. Privileged policies can
 * grant access by OU, so evaluateMyAccess needs both: the account list to build
 * candidates, and the ancestry to inject as AVP entity parents so a Cedar
 * `resource in Snitch::OU::"…"` clause resolves for the concrete account.
 *
 * Ancestry is flattened (each account lists every ancestor OU as a direct parent),
 * which is sufficient for AVP transitive-membership checks without declaring
 * intermediate OU→OU links.
 *
 * Example: expandOUsToAccounts(["ou-root-abc"]) →
 *   { ouToAccounts: {"ou-root-abc" → {"111…","222…"}}, accountToAncestorOUs: {"111…" → {"ou-root-abc"}} }
 */
export async function expandOUsToAccounts(referencedOuIds: string[]): Promise<OUExpansion> {
  const ouToAccounts = new Map<string, Set<string>>();
  const accountToAncestorOUs = new Map<string, Set<string>>();

  const addTo = (map: Map<string, Set<string>>, key: string, values: string[]) => {
    const set = map.get(key) ?? new Set<string>();
    for (const v of values) set.add(v);
    map.set(key, set);
  };

  async function walk(ouId: string, ancestry: string[]): Promise<void> {
    const chain = [...ancestry, ouId];
    for (const accountId of await listAccountIdsForParent(ouId)) {
      for (const ancestorOu of chain) addTo(ouToAccounts, ancestorOu, [accountId]);
      addTo(accountToAncestorOUs, accountId, chain);
    }
    for (const childOuId of await listChildOUIds(ouId)) await walk(childOuId, chain);
  }

  for (const ouId of new Set(referencedOuIds)) await walk(ouId, []);
  return { ouToAccounts, accountToAncestorOUs };
}

export async function listPermissionSets() {
  const { instanceArn } = await getIDCInstance();

  const arns: string[] = [];
  let nextToken: string | undefined;

  do {
    const result = await ssoAdmin.send(
      new ListPermissionSetsCommand({ InstanceArn: instanceArn, NextToken: nextToken })
    );
    arns.push(...(result.PermissionSets ?? []));
    nextToken = result.NextToken;
  } while (nextToken);

  return Promise.all(
    arns.map(async (arn) => {
      const detail = await ssoAdmin.send(
        new DescribePermissionSetCommand({ InstanceArn: instanceArn, PermissionSetArn: arn })
      );
      return {
        arn: detail.PermissionSet?.PermissionSetArn ?? arn,
        name: detail.PermissionSet?.Name ?? "",
        description: detail.PermissionSet?.Description ?? null,
      };
    })
  );
}
