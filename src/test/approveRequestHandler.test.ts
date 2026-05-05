import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDynamoSend, mockSfnSend, mockAvpSend } = vi.hoisted(() => ({
  mockDynamoSend: vi.fn(),
  mockSfnSend: vi.fn(),
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
    constructor(public input: unknown) {}
  },
  UpdateCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock("@aws-sdk/client-sfn", () => ({
  SFNClient: class {
    send = mockSfnSend;
  },
  SendTaskSuccessCommand: class {
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

const { handler } = await import(
  "../../amplify/functions/accessRequests/approveRequestHandler"
);

const PENDING_REQUEST = {
  id: "req-1",
  requesterCognitoSub: "requester-sub-111",
  idcUserId: "idc-user-1",
  idcUserEmail: "requester@example.com",
  accountId: "111111111111",
  permissionSetArn: "arn:aws:sso:::permissionSet/ssoins-1/ps-read",
  permissionSetName: "ReadOnly",
  durationMinutes: 60,
  status: "PENDING_APPROVAL",
  taskToken: "token-xyz",
  startTime: null,
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

const APPROVER_EVENT = {
  arguments: { requestId: "req-1" },
  identity: {
    username: "approver-sub-222",
    claims: { "cognito:groups": ["Admins"] },
  },
};

describe("approveRequestHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ACCESS_REQUEST_TABLE_NAME = "AccessRequestTable";
    process.env.AVP_POLICY_STORE_ID = "ps-abc123";
    mockAvpSend.mockResolvedValue({ decision: "ALLOW", determiningPolicies: [], errors: [] });
    mockSfnSend.mockResolvedValue({});
  });

  describe("validation", () => {
    it("throws when the request does not exist", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Item: undefined });
      await expect(handler(APPROVER_EVENT)).rejects.toThrow("Access request not found: req-1");
    });

    it("throws when status is not PENDING_APPROVAL", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: { ...PENDING_REQUEST, status: "ACTIVE" },
      });
      await expect(handler(APPROVER_EVENT)).rejects.toThrow(
        'Expected status PENDING_APPROVAL, got: "ACTIVE"'
      );
    });

    it("throws when taskToken is missing", async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Item: { ...PENDING_REQUEST, taskToken: null },
      });
      await expect(handler(APPROVER_EVENT)).rejects.toThrow(
        "Expected a taskToken on request req-1"
      );
    });
  });

  describe("self-approval guard", () => {
    it("throws when the approver is the requester", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Item: PENDING_REQUEST });
      const selfEvent = {
        ...APPROVER_EVENT,
        identity: { ...APPROVER_EVENT.identity, username: "requester-sub-111" },
      };
      await expect(handler(selfEvent)).rejects.toThrow(
        "You cannot approve your own access request"
      );
    });

    it("allows approval when requesterCognitoSub is absent (backward compatibility)", async () => {
      const legacyRequest = { ...PENDING_REQUEST, requesterCognitoSub: undefined };
      mockDynamoSend
        .mockResolvedValueOnce({ Item: legacyRequest })
        .mockResolvedValueOnce({});
      await expect(handler(APPROVER_EVENT)).resolves.toBeDefined();
    });

    it("allows approval when a different user approves", async () => {
      mockDynamoSend
        .mockResolvedValueOnce({ Item: PENDING_REQUEST })
        .mockResolvedValueOnce({});
      await expect(handler(APPROVER_EVENT)).resolves.toBeDefined();
    });
  });

  describe("AVP authorization", () => {
    it("throws when AVP denies the caller", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Item: PENDING_REQUEST });
      mockAvpSend.mockResolvedValueOnce({ decision: "DENY", determiningPolicies: [], errors: [] });
      await expect(handler(APPROVER_EVENT)).rejects.toThrow(
        "You are not authorized to approve this request"
      );
    });

    it("passes the caller's Cognito groups as ApproverGroup parents", async () => {
      mockDynamoSend
        .mockResolvedValueOnce({ Item: PENDING_REQUEST })
        .mockResolvedValueOnce({});

      await handler(APPROVER_EVENT);

      const avpCmd = mockAvpSend.mock.calls[0][0];
      const entity = avpCmd.input.entities.entityList[0];
      expect(entity.parents).toEqual([
        { entityType: "Snitch::ApproverGroup", entityId: "Admins" },
      ]);
    });
  });

  describe("successful approval", () => {
    beforeEach(() => {
      mockDynamoSend
        .mockResolvedValueOnce({ Item: PENDING_REQUEST }) // GetCommand
        .mockResolvedValueOnce({});                        // UpdateCommand
    });

    it("updates DynamoDB with approvedBy and clears taskToken", async () => {
      await handler(APPROVER_EVENT);

      const updateCmd = mockDynamoSend.mock.calls[1][0];
      expect(updateCmd.input.ExpressionAttributeValues[":by"]).toBe("approver-sub-222");
      expect(updateCmd.input.ExpressionAttributeValues[":null"]).toBeNull();
    });

    it("sends SendTaskSuccess with the correct Step Function output", async () => {
      await handler(APPROVER_EVENT);

      expect(mockSfnSend).toHaveBeenCalledOnce();
      const sfnCmd = mockSfnSend.mock.calls[0][0];
      expect(sfnCmd.input.taskToken).toBe(PENDING_REQUEST.taskToken);

      const output = JSON.parse(sfnCmd.input.output);
      expect(output.requestId).toBe("req-1");
      expect(output.idcUserId).toBe(PENDING_REQUEST.idcUserId);
      expect(output.accountId).toBe(PENDING_REQUEST.accountId);
      expect(output.permissionSetArn).toBe(PENDING_REQUEST.permissionSetArn);
      expect(output.durationSeconds).toBe(PENDING_REQUEST.durationMinutes * 60);
    });

    it("returns the record with approvedBy and null taskToken", async () => {
      const result = await handler(APPROVER_EVENT);

      expect(result.approvedBy).toBe("approver-sub-222");
      expect(result.taskToken).toBeNull();
    });

    it("stores approverComment when provided", async () => {
      const event = {
        ...APPROVER_EVENT,
        arguments: { requestId: "req-1", approverComment: "LGTM" },
      };
      const result = await handler(event);
      expect(result.approverComment).toBe("LGTM");

      const updateCmd = mockDynamoSend.mock.calls[1][0];
      expect(updateCmd.input.ExpressionAttributeValues[":comment"]).toBe("LGTM");
    });
  });

  it("propagates DynamoDB errors on GetCommand", async () => {
    mockDynamoSend.mockRejectedValue(new Error("DynamoDB unavailable"));
    await expect(handler(APPROVER_EVENT)).rejects.toThrow("DynamoDB unavailable");
  });

  it("propagates SFN errors", async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: PENDING_REQUEST })
      .mockResolvedValueOnce({});
    mockSfnSend.mockRejectedValue(new Error("Step Functions unavailable"));
    await expect(handler(APPROVER_EVENT)).rejects.toThrow("Step Functions unavailable");
  });
});
