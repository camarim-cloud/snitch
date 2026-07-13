import { describe, it, expect, vi, beforeEach } from "vitest";

// Fake Identity Store client: send() branches on a _type tag stamped by each fake
// command so a single mock can serve ListUsers / ListGroupMemberships / DescribeGroup.
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
  DescribeGroupCommand: class {
    _type = "DescribeGroup";
    constructor(public input: { GroupId: string }) {}
  },
}));

// Env must be set BEFORE the handler module is imported — it captures ADMIN_GROUP_NAME
// and AUDITOR_GROUP_NAME into module-level constants at load time.
process.env.IDC_IDENTITY_STORE_ID = "d-1234567890";
process.env.ADMIN_GROUP_NAME = "AdminsIDC";
process.env.AUDITOR_GROUP_NAME = "AuditorsIDC";

const { handler } = await import(
  "../../amplify/functions/auth/preTokenGenerationHandler"
);

// Configure the fake store so the signing-in user belongs to `displayNames`.
function setupMembership(displayNames: string[]) {
  const groupIds = displayNames.map((_, i) => `g${i}`);
  mockSend.mockImplementation((cmd: { _type: string; input?: { GroupId?: string } }) => {
    switch (cmd._type) {
      case "ListUsers":
        return Promise.resolve({ Users: [{ UserId: "idc-user-1" }] });
      case "ListGroupMemberships":
        return Promise.resolve({
          GroupMemberships: groupIds.map((GroupId) => ({ GroupId })),
        });
      case "DescribeGroup": {
        const idx = groupIds.indexOf(cmd.input!.GroupId!);
        return Promise.resolve({ DisplayName: displayNames[idx] });
      }
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

async function resolvedGroups(displayNames: string[]): Promise<string[]> {
  setupMembership(displayNames);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await handler(makeEvent("user@example.com") as any, {} as any, () => {});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (result as any).response.claimsAndScopeOverrideDetails.groupOverrideDetails
    .groupsToOverride;
}

describe("preTokenGenerationHandler — group aliasing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("appends the Auditors claim when the user is in the auditor IDC group", async () => {
    const groups = await resolvedGroups(["AuditorsIDC"]);
    expect(groups).toContain("Auditors");
    expect(groups).not.toContain("Admins");
    // The raw IDC display name still flows through.
    expect(groups).toContain("AuditorsIDC");
  });

  it("appends the Admins claim when the user is in the admin IDC group", async () => {
    const groups = await resolvedGroups(["AdminsIDC"]);
    expect(groups).toContain("Admins");
    expect(groups).not.toContain("Auditors");
  });

  it("appends both claims when the user is in both IDC groups", async () => {
    const groups = await resolvedGroups(["AdminsIDC", "AuditorsIDC", "Engineering"]);
    expect(groups).toContain("Admins");
    expect(groups).toContain("Auditors");
    expect(groups).toContain("Engineering");
  });

  it("appends neither alias for a user in unrelated groups only", async () => {
    const groups = await resolvedGroups(["Engineering"]);
    expect(groups).not.toContain("Admins");
    expect(groups).not.toContain("Auditors");
    expect(groups).toEqual(["Engineering"]);
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
