import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDynamoSend, mockAvpSend } = vi.hoisted(() => ({
  mockDynamoSend: vi.fn(),
  mockAvpSend: vi.fn(),
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {},
}));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: vi.fn(() => ({ send: mockDynamoSend })),
  },
  GetCommand: class {
    readonly _type = "Get";
    constructor(public input: unknown) {}
  },
  PutCommand: class {
    readonly _type = "Put";
    constructor(public input: unknown) {}
  },
  UpdateCommand: class {
    readonly _type = "Update";
    constructor(public input: unknown) {}
  },
  ScanCommand: class {
    readonly _type = "Scan";
    constructor(public input: unknown) {}
  },
}));

vi.mock("@aws-sdk/client-verifiedpermissions", () => ({
  VerifiedPermissionsClient: class {
    send = mockAvpSend;
  },
  CreatePolicyCommand: class {
    readonly _type = "Create";
    constructor(public input: unknown) {}
  },
  UpdatePolicyCommand: class {
    readonly _type = "Update";
    constructor(public input: unknown) {}
  },
}));

// Module-level constants capture these at import time — set before importing.
process.env.PRIVILEGED_POLICY_TABLE_NAME = "PrivilegedPolicyTable";
process.env.AVP_POLICY_STORE_ID = "ps-abc123";

const { handler } = await import(
  "../../amplify/functions/verifiedPermissions/updatePrivilegedPolicyHandler"
);

const GROUP_SNAPSHOT = {
  id: "policy-1",
  name: "Teste Acesso Simples",
  description: null,
  principalType: "GROUP",
  principalId: "group-teamleads",
  principalDisplayName: "TeamLeads",
  accountIds: [],
  ouIds: ["ou-k3jy-l9m1oni3"],
  permissionSetArns: ["arn:aws:sso:::permissionSet/ssoins-1/ps-admin"],
  permissionSetNames: ["AWSAdministratorAccess"],
  maxDurationMinutes: null,
  requiresApproval: false,
  avpPolicyId: "avp-old-id",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

// Baseline edit event: identity (principal + resource) matches the snapshot;
// only editable fields differ.
const EDITABLE_FIELDS_EVENT = {
  arguments: {
    id: "policy-1",
    name: "Renamed policy",
    description: "now with a description",
    principalType: "GROUP" as const,
    principalId: "group-teamleads",
    principalDisplayName: "TeamLeads",
    accountIds: [],
    ouIds: ["ou-k3jy-l9m1oni3"],
    permissionSetArns: ["arn:aws:sso:::permissionSet/ssoins-1/ps-admin"],
    permissionSetNames: ["AWSAdministratorAccess"],
    maxDurationMinutes: 120,
    requiresApproval: true,
  },
};

function eventWith(overrides: Record<string, unknown>) {
  return { arguments: { ...EDITABLE_FIELDS_EVENT.arguments, ...overrides } };
}

function cmdsOfType(mock: typeof mockAvpSend, type: string): unknown[] {
  return mock.mock.calls
    .map((c) => c[0])
    .filter((c: { _type?: string }) => c._type === type);
}

describe("updatePrivilegedPolicyHandler — immutable identity guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a principal-type change (GROUP → USER) before any write", async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: GROUP_SNAPSHOT }); // GetCommand only

    await expect(
      handler(eventWith({ principalType: "USER", principalId: "user-alice" }))
    ).rejects.toThrow(/Cannot change principal type, principal/);

    // No update/scan/AVP writes were attempted.
    expect(cmdsOfType(mockDynamoSend, "Update")).toHaveLength(0);
    expect(cmdsOfType(mockDynamoSend, "Scan")).toHaveLength(0);
    expect(mockAvpSend).not.toHaveBeenCalled();
  });

  it("rejects a resource change (accounts/OUs) before any write", async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: GROUP_SNAPSHOT });

    await expect(handler(eventWith({ ouIds: ["ou-different"] }))).rejects.toThrow(/Cannot change OUs/);
    expect(cmdsOfType(mockDynamoSend, "Update")).toHaveLength(0);
    expect(mockAvpSend).not.toHaveBeenCalled();
  });

  it("updates the AVP policy in place when only editable fields change", async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: GROUP_SNAPSHOT }) // GetCommand
      .mockResolvedValueOnce({ Items: [] }) // ScanCommand (conflict check)
      .mockResolvedValueOnce({}); // UpdateCommand (main record)
    mockAvpSend.mockResolvedValueOnce({}); // UpdatePolicy

    const result = await handler(EDITABLE_FIELDS_EVENT);

    // In-place update — no create/delete of the Cedar policy.
    const updates = cmdsOfType(mockAvpSend, "Update") as { input: { policyId: string } }[];
    expect(updates).toHaveLength(1);
    expect(updates[0].input.policyId).toBe("avp-old-id");
    expect(cmdsOfType(mockAvpSend, "Create")).toHaveLength(0);

    expect(result.name).toBe("Renamed policy");
    expect(result.requiresApproval).toBe(true);
    expect(result.maxDurationMinutes).toBe(120);
  });

  it("ignores account/OU ordering when comparing identity", async () => {
    const multiResourceSnapshot = {
      ...GROUP_SNAPSHOT,
      accountIds: ["111111111111", "222222222222"],
      ouIds: [],
    };
    mockDynamoSend
      .mockResolvedValueOnce({ Item: multiResourceSnapshot })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({});
    mockAvpSend.mockResolvedValueOnce({});

    // Same accounts, reversed order — must not be treated as a change.
    await expect(
      handler(eventWith({ accountIds: ["222222222222", "111111111111"], ouIds: [] }))
    ).resolves.toBeDefined();
    expect(cmdsOfType(mockAvpSend, "Update")).toHaveLength(1);
  });

  it("creates the AVP policy when a legacy record has no avpPolicyId (identity unchanged)", async () => {
    const legacySnapshot = { ...GROUP_SNAPSHOT, avpPolicyId: undefined };
    mockDynamoSend
      .mockResolvedValueOnce({ Item: legacySnapshot }) // GetCommand
      .mockResolvedValueOnce({ Items: [] }) // ScanCommand
      .mockResolvedValueOnce({}) // UpdateCommand (main record)
      .mockResolvedValueOnce({}); // UpdateCommand (persist new avpPolicyId)
    mockAvpSend.mockResolvedValueOnce({ policyId: "avp-new-id" }); // CreatePolicy

    const result = await handler(EDITABLE_FIELDS_EVENT);

    expect(cmdsOfType(mockAvpSend, "Create")).toHaveLength(1);
    expect(cmdsOfType(mockAvpSend, "Update")).toHaveLength(0);
    expect(result.avpPolicyId).toBe("avp-new-id");
  });
});
