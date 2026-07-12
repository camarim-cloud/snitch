import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockDynamoSend,
  mockAvpSend,
  mockGetIDCInstance,
  mockListGroupMemberships,
  mockExpandOUsToAccounts,
} = vi.hoisted(() => ({
  mockDynamoSend: vi.fn(),
  mockAvpSend: vi.fn(),
  mockGetIDCInstance: vi.fn(),
  mockListGroupMemberships: vi.fn(),
  mockExpandOUsToAccounts: vi.fn(),
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  // Plain class so `new DynamoDBClient()` works in the handler
  DynamoDBClient: class {},
}));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: vi.fn(() => ({ send: mockDynamoSend })),
  },
  ScanCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock("@aws-sdk/client-verifiedpermissions", () => ({
  VerifiedPermissionsClient: class {
    send = mockAvpSend;
  },
  IsAuthorizedCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock("../../amplify/functions/awsResources/helpers", () => ({
  getIDCInstancePublic: mockGetIDCInstance,
  listGroupMembershipsForUser: mockListGroupMemberships,
  expandOUsToAccounts: mockExpandOUsToAccounts,
}));

const { handler } = await import(
  "../../amplify/functions/verifiedPermissions/evaluateAccessHandler"
);

const IDC_USER_ID = "idc-user-abc";
const ACCOUNT_1 = "111111111111";
const ACCOUNT_2 = "222222222222";
const PS_ARN_1 = "arn:aws:sso:::permissionSet/ssoins-1/ps-read";
const PS_ARN_2 = "arn:aws:sso:::permissionSet/ssoins-1/ps-admin";

function makeEvent(idcUserId: string) {
  return { arguments: { idcUserId } };
}

describe("evaluateAccessHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PRIVILEGED_POLICY_TABLE_NAME = "PrivilegedPolicyTable";
    process.env.AVP_POLICY_STORE_ID = "ps-store-123";

    mockGetIDCInstance.mockResolvedValue({ identityStoreId: "d-1234567890" });
    mockListGroupMemberships.mockResolvedValue([]);
    // Default: no OU expansion (account-based policies only)
    mockExpandOUsToAccounts.mockResolvedValue({
      ouToAccounts: new Map(),
      accountToAncestorOUs: new Map(),
    });
  });

  it("returns empty array when no policies exist in the table", async () => {
    mockDynamoSend.mockResolvedValue({ Items: [] });
    const result = await handler(makeEvent(IDC_USER_ID));
    expect(result).toEqual([]);
    expect(mockAvpSend).not.toHaveBeenCalled();
  });

  it("returns permitted pairs when AVP returns ALLOW", async () => {
    mockDynamoSend.mockResolvedValue({
      Items: [
        {
          accountIds: [ACCOUNT_1],
          permissionSetArns: [PS_ARN_1],
          permissionSetNames: ["ReadOnly"],
        },
      ],
    });
    mockAvpSend.mockResolvedValue({ decision: "ALLOW" });

    const result = await handler(makeEvent(IDC_USER_ID));

    expect(result).toEqual([
      { accountId: ACCOUNT_1, permissionSetArn: PS_ARN_1, permissionSetName: "ReadOnly", maxDurationMinutes: null, requiresApproval: false },
    ]);
  });

  it("filters out pairs where AVP returns DENY", async () => {
    mockDynamoSend.mockResolvedValue({
      Items: [
        {
          accountIds: [ACCOUNT_1],
          permissionSetArns: [PS_ARN_1],
          permissionSetNames: ["ReadOnly"],
        },
      ],
    });
    mockAvpSend.mockResolvedValue({ decision: "DENY" });

    const result = await handler(makeEvent(IDC_USER_ID));
    expect(result).toEqual([]);
  });

  it("evaluates multiple accounts × permission sets independently", async () => {
    mockDynamoSend.mockResolvedValue({
      Items: [
        {
          accountIds: [ACCOUNT_1, ACCOUNT_2],
          permissionSetArns: [PS_ARN_1, PS_ARN_2],
          permissionSetNames: ["ReadOnly", "Admin"],
        },
      ],
    });

    // Allow only ACCOUNT_1+PS_ARN_1 and ACCOUNT_2+PS_ARN_2
    mockAvpSend.mockImplementation(
      (cmd: {
        input: {
          resource: { entityId: string };
          context: { contextMap: { permissionSetArn: { string: string } } };
        };
      }) => {
        const accountId = cmd.input.resource.entityId;
        const psArn = cmd.input.context.contextMap.permissionSetArn.string;
        const allowed =
          (accountId === ACCOUNT_1 && psArn === PS_ARN_1) ||
          (accountId === ACCOUNT_2 && psArn === PS_ARN_2);
        return Promise.resolve({ decision: allowed ? "ALLOW" : "DENY" });
      }
    );

    const result = await handler(makeEvent(IDC_USER_ID));

    expect(result).toHaveLength(2);
    expect(result).toContainEqual({
      accountId: ACCOUNT_1,
      permissionSetArn: PS_ARN_1,
      permissionSetName: "ReadOnly",
      maxDurationMinutes: null,
      requiresApproval: false,
    });
    expect(result).toContainEqual({
      accountId: ACCOUNT_2,
      permissionSetArn: PS_ARN_2,
      permissionSetName: "Admin",
      maxDurationMinutes: null,
      requiresApproval: false,
    });
  });

  it("deduplicates identical (account, permissionSet) pairs across policies", async () => {
    // Two policies with the same account+permissionSet — AVP should only be called once
    mockDynamoSend.mockResolvedValue({
      Items: [
        {
          accountIds: [ACCOUNT_1],
          permissionSetArns: [PS_ARN_1],
          permissionSetNames: ["ReadOnly"],
        },
        {
          accountIds: [ACCOUNT_1],
          permissionSetArns: [PS_ARN_1],
          permissionSetNames: ["ReadOnly"],
        },
      ],
    });
    mockAvpSend.mockResolvedValue({ decision: "ALLOW" });

    const result = await handler(makeEvent(IDC_USER_ID));

    expect(mockAvpSend).toHaveBeenCalledOnce();
    expect(result).toHaveLength(1);
  });

  it("includes group memberships in the AVP entity list", async () => {
    const GROUP_ID = "group-devs";
    mockListGroupMemberships.mockResolvedValue([GROUP_ID]);
    mockDynamoSend.mockResolvedValue({
      Items: [
        {
          accountIds: [ACCOUNT_1],
          permissionSetArns: [PS_ARN_1],
          permissionSetNames: ["ReadOnly"],
        },
      ],
    });
    mockAvpSend.mockResolvedValue({ decision: "ALLOW" });

    await handler(makeEvent(IDC_USER_ID));

    const callArg = mockAvpSend.mock.calls[0][0];
    const entityList = callArg.input.entities.entityList;
    const userEntity = entityList.find(
      (e: { identifier: { entityType: string } }) =>
        e.identifier.entityType === "Snitch::User"
    );
    expect(userEntity.parents).toContainEqual({
      entityType: "Snitch::Group",
      entityId: GROUP_ID,
    });
  });

  it("uses permissionSetArn as fallback name when permissionSetNames is missing", async () => {
    mockDynamoSend.mockResolvedValue({
      Items: [
        {
          accountIds: [ACCOUNT_1],
          permissionSetArns: [PS_ARN_1],
          // no permissionSetNames field
        },
      ],
    });
    mockAvpSend.mockResolvedValue({ decision: "ALLOW" });

    const result = await handler(makeEvent(IDC_USER_ID));
    expect(result[0].permissionSetName).toBe(PS_ARN_1);
  });

  it("propagates AVP errors", async () => {
    mockDynamoSend.mockResolvedValue({
      Items: [
        {
          accountIds: [ACCOUNT_1],
          permissionSetArns: [PS_ARN_1],
          permissionSetNames: ["ReadOnly"],
        },
      ],
    });
    mockAvpSend.mockRejectedValue(new Error("AVP unavailable"));

    await expect(handler(makeEvent(IDC_USER_ID))).rejects.toThrow("AVP unavailable");
  });

  describe("OU-based policies", () => {
    const OU_ID = "ou-k3jy-l9m1oni3";

    it("evaluates accounts inside an OU-only policy (empty accountIds)", async () => {
      mockDynamoSend.mockResolvedValue({
        Items: [
          {
            accountIds: [],
            ouIds: [OU_ID],
            permissionSetArns: [PS_ARN_1],
            permissionSetNames: ["ReadOnly"],
          },
        ],
      });
      // The OU contains two accounts.
      mockExpandOUsToAccounts.mockResolvedValue({
        ouToAccounts: new Map([[OU_ID, new Set([ACCOUNT_1, ACCOUNT_2])]]),
        accountToAncestorOUs: new Map([
          [ACCOUNT_1, new Set([OU_ID])],
          [ACCOUNT_2, new Set([OU_ID])],
        ]),
      });
      mockAvpSend.mockResolvedValue({ decision: "ALLOW" });

      const result = await handler(makeEvent(IDC_USER_ID));

      // Before this fix, an OU-only policy produced zero candidates → no access.
      expect(mockExpandOUsToAccounts).toHaveBeenCalledWith([OU_ID]);
      expect(result).toHaveLength(2);
      expect(result.map((r) => r.accountId).sort()).toEqual([ACCOUNT_1, ACCOUNT_2]);
    });

    it("injects the account's OU ancestry as AVP entity parents", async () => {
      mockDynamoSend.mockResolvedValue({
        Items: [
          {
            accountIds: [],
            ouIds: [OU_ID],
            permissionSetArns: [PS_ARN_1],
            permissionSetNames: ["ReadOnly"],
          },
        ],
      });
      mockExpandOUsToAccounts.mockResolvedValue({
        ouToAccounts: new Map([[OU_ID, new Set([ACCOUNT_1])]]),
        accountToAncestorOUs: new Map([[ACCOUNT_1, new Set([OU_ID])]]),
      });
      mockAvpSend.mockResolvedValue({ decision: "ALLOW" });

      await handler(makeEvent(IDC_USER_ID));

      const entityList = mockAvpSend.mock.calls[0][0].input.entities.entityList;
      const accountEntity = entityList.find(
        (e: { identifier: { entityType: string } }) =>
          e.identifier.entityType === "Snitch::Account"
      );
      expect(accountEntity.identifier.entityId).toBe(ACCOUNT_1);
      expect(accountEntity.parents).toContainEqual({
        entityType: "Snitch::OU",
        entityId: OU_ID,
      });
    });

    it("deduplicates an account covered by both an explicit accountId and an OU", async () => {
      mockDynamoSend.mockResolvedValue({
        Items: [
          {
            accountIds: [ACCOUNT_1],
            ouIds: [OU_ID],
            permissionSetArns: [PS_ARN_1],
            permissionSetNames: ["ReadOnly"],
          },
        ],
      });
      // The OU also contains ACCOUNT_1 (plus ACCOUNT_2).
      mockExpandOUsToAccounts.mockResolvedValue({
        ouToAccounts: new Map([[OU_ID, new Set([ACCOUNT_1, ACCOUNT_2])]]),
        accountToAncestorOUs: new Map([
          [ACCOUNT_1, new Set([OU_ID])],
          [ACCOUNT_2, new Set([OU_ID])],
        ]),
      });
      mockAvpSend.mockResolvedValue({ decision: "ALLOW" });

      const result = await handler(makeEvent(IDC_USER_ID));

      // ACCOUNT_1 + PS_ARN_1 must be evaluated once, not twice.
      expect(mockAvpSend).toHaveBeenCalledTimes(2);
      expect(result).toHaveLength(2);
    });
  });
});
