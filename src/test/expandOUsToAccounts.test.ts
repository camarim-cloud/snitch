import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockOrgSend } = vi.hoisted(() => ({ mockOrgSend: vi.fn() }));

// Only the Organizations client is exercised by expandOUsToAccounts. The other
// clients constructed at module load are left real (they make no network calls).
vi.mock("@aws-sdk/client-organizations", () => ({
  OrganizationsClient: class {
    send = mockOrgSend;
  },
  ListAccountsCommand: class {
    constructor(public input: unknown) {}
  },
  ListAccountsForParentCommand: class {
    readonly kind = "accounts";
    constructor(public input: { ParentId: string }) {}
  },
  ListRootsCommand: class {
    constructor(public input: unknown) {}
  },
  ListOrganizationalUnitsForParentCommand: class {
    readonly kind = "ous";
    constructor(public input: { ParentId: string }) {}
  },
}));

const { expandOUsToAccounts } = await import(
  "../../amplify/functions/awsResources/helpers"
);

const OU_PARENT = "ou-parent";
const OU_CHILD = "ou-child";
const ACCOUNT_DIRECT = "111111111111";
const ACCOUNT_NESTED = "222222222222";

// Tree: OU_PARENT holds ACCOUNT_DIRECT and child OU_CHILD; OU_CHILD holds ACCOUNT_NESTED.
function wireOrgTree() {
  mockOrgSend.mockImplementation((cmd: { kind: string; input: { ParentId: string } }) => {
    if (cmd.kind === "accounts") {
      if (cmd.input.ParentId === OU_PARENT) return Promise.resolve({ Accounts: [{ Id: ACCOUNT_DIRECT }] });
      if (cmd.input.ParentId === OU_CHILD) return Promise.resolve({ Accounts: [{ Id: ACCOUNT_NESTED }] });
      return Promise.resolve({ Accounts: [] });
    }
    if (cmd.kind === "ous") {
      if (cmd.input.ParentId === OU_PARENT) return Promise.resolve({ OrganizationalUnits: [{ Id: OU_CHILD }] });
      return Promise.resolve({ OrganizationalUnits: [] });
    }
    return Promise.resolve({});
  });
}

describe("expandOUsToAccounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty maps for no referenced OUs and makes no API calls", async () => {
    const { ouToAccounts, accountToAncestorOUs } = await expandOUsToAccounts([]);
    expect(ouToAccounts.size).toBe(0);
    expect(accountToAncestorOUs.size).toBe(0);
    expect(mockOrgSend).not.toHaveBeenCalled();
  });

  it("collects accounts directly under a referenced OU", async () => {
    wireOrgTree();
    const { ouToAccounts } = await expandOUsToAccounts([OU_CHILD]);
    expect([...(ouToAccounts.get(OU_CHILD) ?? [])]).toEqual([ACCOUNT_NESTED]);
  });

  it("descends into nested OUs and records flattened ancestry", async () => {
    wireOrgTree();
    const { ouToAccounts, accountToAncestorOUs } = await expandOUsToAccounts([OU_PARENT]);

    // The parent OU transitively contains both the direct and nested accounts.
    expect([...(ouToAccounts.get(OU_PARENT) ?? [])].sort()).toEqual(
      [ACCOUNT_DIRECT, ACCOUNT_NESTED].sort()
    );
    // The nested OU only contains the nested account.
    expect([...(ouToAccounts.get(OU_CHILD) ?? [])]).toEqual([ACCOUNT_NESTED]);

    // The nested account lists BOTH ancestor OUs so a policy on either resolves.
    expect([...(accountToAncestorOUs.get(ACCOUNT_NESTED) ?? [])].sort()).toEqual(
      [OU_CHILD, OU_PARENT].sort()
    );
    expect([...(accountToAncestorOUs.get(ACCOUNT_DIRECT) ?? [])]).toEqual([OU_PARENT]);
  });

  it("deduplicates repeated referenced OU ids", async () => {
    wireOrgTree();
    await expandOUsToAccounts([OU_CHILD, OU_CHILD]);
    // ou-child: one ListAccounts + one ListOUs = 2 calls (not 4).
    expect(mockOrgSend).toHaveBeenCalledTimes(2);
  });
});
