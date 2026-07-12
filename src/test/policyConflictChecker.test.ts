import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDynamoSend } = vi.hoisted(() => ({
  mockDynamoSend: vi.fn(),
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({
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

const { assertNoDuplicatePrincipalResource } = await import(
  "../../amplify/functions/verifiedPermissions/policyConflictChecker"
);

const TABLE = "PrivilegedPolicyTable";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dynamo = { send: mockDynamoSend } as any;

const POLICY_A = {
  id: "policy-a",
  name: "Prod Access",
  principalId: "user-1",
  accountIds: ["111111111111"],
  ouIds: [],
  permissionSetArns: ["arn:aws:sso:::permissionSet/ps-1"],
};

describe("assertNoDuplicatePrincipalResource", () => {
  beforeEach(() => vi.clearAllMocks());

  it("skips the DynamoDB scan when accountIds and ouIds are both empty", async () => {
    await assertNoDuplicatePrincipalResource(dynamo, TABLE, {
      principalId: "user-1",
      accountIds: [],
      ouIds: [],
      permissionSetArns: ["arn:aws:sso:::permissionSet/ps-1"],
    });
    expect(mockDynamoSend).not.toHaveBeenCalled();
  });

  it("skips the DynamoDB scan when permissionSetArns is empty", async () => {
    await assertNoDuplicatePrincipalResource(dynamo, TABLE, {
      principalId: "user-1",
      accountIds: ["111111111111"],
      ouIds: [],
      permissionSetArns: [],
    });
    expect(mockDynamoSend).not.toHaveBeenCalled();
  });

  it("resolves without error when the table is empty", async () => {
    mockDynamoSend.mockResolvedValue({ Items: [] });
    await expect(
      assertNoDuplicatePrincipalResource(dynamo, TABLE, {
        principalId: "user-1",
        accountIds: ["111111111111"],
        ouIds: [],
        permissionSetArns: ["arn:aws:sso:::permissionSet/ps-1"],
      })
    ).resolves.toBeUndefined();
  });

  it("resolves when existing policy covers a different account for the same principal", async () => {
    mockDynamoSend.mockResolvedValue({
      Items: [{ ...POLICY_A, accountIds: ["222222222222"] }],
    });
    await expect(
      assertNoDuplicatePrincipalResource(dynamo, TABLE, {
        principalId: "user-1",
        accountIds: ["111111111111"],
        ouIds: [],
        permissionSetArns: ["arn:aws:sso:::permissionSet/ps-1"],
      })
    ).resolves.toBeUndefined();
  });

  it("resolves when same account but different permission set", async () => {
    mockDynamoSend.mockResolvedValue({
      Items: [POLICY_A], // has ps-1
    });
    await expect(
      assertNoDuplicatePrincipalResource(dynamo, TABLE, {
        principalId: "user-1",
        accountIds: ["111111111111"],
        ouIds: [],
        permissionSetArns: ["arn:aws:sso:::permissionSet/ps-2"], // different permission set
      })
    ).resolves.toBeUndefined();
  });

  it("resolves without error when the scan returns undefined Items", async () => {
    // DynamoDB Scan can return an object without an Items key on an empty table
    mockDynamoSend.mockResolvedValue({});
    await expect(
      assertNoDuplicatePrincipalResource(dynamo, TABLE, {
        principalId: "user-1",
        accountIds: ["111111111111"],
        ouIds: [],
        permissionSetArns: ["arn:aws:sso:::permissionSet/ps-1"],
      })
    ).resolves.toBeUndefined();
  });

  it("throws when same principalId, accountId, and permissionSetArn all match", async () => {
    mockDynamoSend.mockResolvedValue({ Items: [POLICY_A] });
    await expect(
      assertNoDuplicatePrincipalResource(dynamo, TABLE, {
        principalId: "user-1",
        accountIds: ["111111111111"],
        ouIds: [],
        permissionSetArns: ["arn:aws:sso:::permissionSet/ps-1"],
      })
    ).rejects.toThrow(
      `Policy "Prod Access" already grants this principal access to 111111111111 with permission sets: arn:aws:sso:::permissionSet/ps-1`
    );
  });

  it("throws when same principalId, ouId, and permissionSetArn all match", async () => {
    mockDynamoSend.mockResolvedValue({
      Items: [
        {
          id: "policy-a",
          name: "Prod Access",
          principalId: "user-1",
          accountIds: [],
          ouIds: ["ou-root-abc"],
          permissionSetArns: ["arn:aws:sso:::permissionSet/ps-1"],
        },
      ],
    });
    await expect(
      assertNoDuplicatePrincipalResource(dynamo, TABLE, {
        principalId: "user-1",
        accountIds: [],
        ouIds: ["ou-root-abc"],
        permissionSetArns: ["arn:aws:sso:::permissionSet/ps-1"],
      })
    ).rejects.toThrow(
      `Policy "Prod Access" already grants this principal access to ou-root-abc with permission sets: arn:aws:sso:::permissionSet/ps-1`
    );
  });

  it("throws and lists all conflicting resources and permission sets in the error message", async () => {
    mockDynamoSend.mockResolvedValue({
      Items: [
        {
          id: "policy-a",
          name: "Multi Access",
          principalId: "user-1",
          accountIds: ["111111111111", "999999999999"],
          ouIds: [],
          permissionSetArns: ["arn:aws:sso:::permissionSet/ps-1", "arn:aws:sso:::permissionSet/ps-2"],
        },
      ],
    });
    await expect(
      assertNoDuplicatePrincipalResource(dynamo, TABLE, {
        principalId: "user-1",
        accountIds: ["111111111111", "999999999999"],
        ouIds: [],
        permissionSetArns: ["arn:aws:sso:::permissionSet/ps-1", "arn:aws:sso:::permissionSet/ps-2"],
      })
    ).rejects.toThrow("111111111111, 999999999999");
  });

  it("resolves when the only conflicting policy is the one being updated (excludeId)", async () => {
    mockDynamoSend.mockResolvedValue({ Items: [POLICY_A] });
    await expect(
      assertNoDuplicatePrincipalResource(dynamo, TABLE, {
        principalId: "user-1",
        accountIds: ["111111111111"],
        ouIds: [],
        permissionSetArns: ["arn:aws:sso:::permissionSet/ps-1"],
        excludeId: "policy-a",
      })
    ).resolves.toBeUndefined();
  });

  it("throws when a second policy conflicts even though the first is excluded", async () => {
    mockDynamoSend.mockResolvedValue({
      Items: [
        POLICY_A,
        {
          id: "policy-b",
          name: "Conflicting Access",
          principalId: "user-1",
          accountIds: ["111111111111"],
          ouIds: [],
          permissionSetArns: ["arn:aws:sso:::permissionSet/ps-1"],
        },
      ],
    });
    await expect(
      assertNoDuplicatePrincipalResource(dynamo, TABLE, {
        principalId: "user-1",
        accountIds: ["111111111111"],
        ouIds: [],
        permissionSetArns: ["arn:aws:sso:::permissionSet/ps-1"],
        excludeId: "policy-a",
      })
    ).rejects.toThrow(`Policy "Conflicting Access"`);
  });

  it("scans using FilterExpression on principalId", async () => {
    mockDynamoSend.mockResolvedValue({ Items: [] });
    await assertNoDuplicatePrincipalResource(dynamo, TABLE, {
      principalId: "user-1",
      accountIds: ["111111111111"],
      ouIds: [],
      permissionSetArns: ["arn:aws:sso:::permissionSet/ps-1"],
    });
    const callInput = mockDynamoSend.mock.calls[0][0].input as {
      FilterExpression: string;
      ExpressionAttributeValues: Record<string, unknown>;
    };
    expect(callInput.FilterExpression).toContain("principalId");
    expect(callInput.ExpressionAttributeValues[":pid"]).toBe("user-1");
  });
});
