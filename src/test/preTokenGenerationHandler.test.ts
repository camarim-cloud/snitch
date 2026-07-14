import { describe, it, expect, vi, beforeEach } from "vitest";

// Fake Identity Store client: send() branches on a _type tag stamped by each fake
// command. The handler now keys everything on the immutable GroupId, so it only needs
// ListUsers + ListGroupMemberships — no per-group DescribeGroup lookup.
const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock("@aws-sdk/client-identitystore", () => ({
  IdentitystoreClient: class {
    send = mockSend;
  },
  ListUsersCommand: class {
    _type = "ListUsers";
    constructor(public input: unknown) {}
  },
  ListGroupMembershipsForMemberCommand: class {
    _type = "ListGroupMemberships";
    constructor(public input: unknown) {}
  },
}));

// Env must be set BEFORE the handler module is imported — it captures ADMIN_GROUP_ID
// and AUDITOR_GROUP_ID into module-level constants at load time. These are IDC GroupIds.
process.env.IDC_IDENTITY_STORE_ID = "d-1234567890";
process.env.ADMIN_GROUP_ID = "g-admin";
process.env.AUDITOR_GROUP_ID = "g-auditor";

const { handler } = await import(
  "../../amplify/functions/auth/preTokenGenerationHandler"
);

// Configure the fake store so the signing-in user belongs to `groupIds`.
function setupMembership(groupIds: string[]) {
  mockSend.mockImplementation((cmd: { _type: string }) => {
    switch (cmd._type) {
      case "ListUsers":
        return Promise.resolve({ Users: [{ UserId: "idc-user-1" }] });
      case "ListGroupMemberships":
        return Promise.resolve({
          GroupMemberships: groupIds.map((GroupId) => ({ GroupId })),
        });
      default:
        return Promise.resolve({});
    }
  });
}

function makeEvent(email: string | undefined, userName = "idc_user@example.com") {
  return {
    userName,
    request: { userAttributes: email ? { email } : {} },
    response: undefined,
  };
}

async function resolvedGroups(groupIds: string[]): Promise<string[]> {
  setupMembership(groupIds);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await handler(makeEvent("user@example.com") as any, {} as any, () => {});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (result as any).response.claimsAndScopeOverrideDetails.groupOverrideDetails
    .groupsToOverride;
}

describe("preTokenGenerationHandler — GroupId claim + role aliasing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("appends the Auditors claim when the user is in the auditor IDC group", async () => {
    const groups = await resolvedGroups(["g-auditor"]);
    expect(groups).toContain("Auditors");
    expect(groups).not.toContain("Admins");
    // The raw IDC GroupId flows through — approval policies key on this same id.
    expect(groups).toContain("g-auditor");
  });

  it("appends the Admins claim when the user is in the admin IDC group", async () => {
    const groups = await resolvedGroups(["g-admin"]);
    expect(groups).toContain("Admins");
    expect(groups).not.toContain("Auditors");
    expect(groups).toContain("g-admin");
  });

  it("appends both claims when the user is in both IDC groups", async () => {
    const groups = await resolvedGroups(["g-admin", "g-auditor", "g-eng"]);
    expect(groups).toContain("Admins");
    expect(groups).toContain("Auditors");
    expect(groups).toContain("g-eng");
  });

  it("puts only GroupIds (no aliases) in the claim for a user in unrelated groups", async () => {
    const groups = await resolvedGroups(["g-eng"]);
    expect(groups).not.toContain("Admins");
    expect(groups).not.toContain("Auditors");
    expect(groups).toEqual(["g-eng"]);
  });

  it("resolves groups without any DescribeGroup call (GroupId comes from the membership)", async () => {
    await resolvedGroups(["g-admin", "g-auditor", "g-eng"]);
    const sentTypes = mockSend.mock.calls.map((c) => (c[0] as { _type: string })._type);
    // Exactly ListUsers + ListGroupMemberships — no per-group fan-out, regardless of group count.
    expect(sentTypes).toEqual(["ListUsers", "ListGroupMemberships"]);
    expect(sentTypes).not.toContain("DescribeGroup");
  });

  it("returns the event unchanged when no email can be resolved", async () => {
    setupMembership([]);
    // No email attribute and a non-idc_ username → email is undefined → early return.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await handler(makeEvent(undefined, "plainuser") as any, {} as any, () => {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).response).toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
