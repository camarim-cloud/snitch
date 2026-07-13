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
  SendTaskFailureCommand: class {
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
  "../../amplify/functions/accessRequests/rejectRequestHandler"
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

// resetAllMocks (not clearAllMocks) so mockImplementation calls don't leak across tests.
describe("rejectRequestHandler", () => {
  beforeEach(() => {
    vi.resetAllMocks();
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
        Item: { ...PENDING_REQUEST, status: "REJECTED" },
      });
      await expect(handler(APPROVER_EVENT)).rejects.toThrow(
        'Expected status PENDING_APPROVAL, got: "REJECTED"'
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

  describe("self-rejection guard", () => {
    it("throws when the rejecter is the requester", async () => {
      mockDynamoSend.mockResolvedValueOnce({ Item: PENDING_REQUEST });
      const selfEvent = {
        ...APPROVER_EVENT,
        identity: { ...APPROVER_EVENT.identity, username: "requester-sub-111" },
      };
      await expect(handler(selfEvent)).rejects.toThrow(
        "You cannot reject your own access request"
      );
    });

    it("allows rejection when requesterCognitoSub is absent (backward compatibility)", async () => {
      const legacyRequest = { ...PENDING_REQUEST, requesterCognitoSub: undefined };
      mockDynamoSend
        .mockResolvedValueOnce({ Item: legacyRequest })
        .mockResolvedValueOnce({});
      await expect(handler(APPROVER_EVENT)).resolves.toBeDefined();
    });

    it("allows rejection when a different user rejects", async () => {
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
        "You are not authorized to reject this request"
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

  describe("successful rejection", () => {
    it("writes REJECTED to DynamoDB before calling SendTaskFailure", async () => {
      // DDB UpdateCommand must complete before SFN SendTaskFailure is called,
      // so the record is in a terminal state even if SFN fails transiently.
      let dynamoUpdateCalled = false;

      mockDynamoSend
        .mockResolvedValueOnce({ Item: PENDING_REQUEST })
        .mockImplementationOnce(() => {
          dynamoUpdateCalled = true;
          return Promise.resolve({});
        });
      mockSfnSend.mockImplementation(() => {
        expect(dynamoUpdateCalled).toBe(true);
        return Promise.resolve({});
      });

      await handler(APPROVER_EVENT);
      expect(dynamoUpdateCalled).toBe(true);
    });

    it("sets status to REJECTED in the DynamoDB update", async () => {
      mockDynamoSend
        .mockResolvedValueOnce({ Item: PENDING_REQUEST })
        .mockResolvedValueOnce({});

      await handler(APPROVER_EVENT);

      const updateCmd = mockDynamoSend.mock.calls[1][0];
      expect(updateCmd.input.ExpressionAttributeValues[":s"]).toBe("REJECTED");
    });

    it("clears the taskToken in DynamoDB", async () => {
      mockDynamoSend
        .mockResolvedValueOnce({ Item: PENDING_REQUEST })
        .mockResolvedValueOnce({});

      await handler(APPROVER_EVENT);

      const updateCmd = mockDynamoSend.mock.calls[1][0];
      expect(updateCmd.input.ExpressionAttributeValues[":null"]).toBeNull();
    });

    it("writes an immutable decidedAt timestamp alongside REJECTED", async () => {
      mockDynamoSend
        .mockResolvedValueOnce({ Item: PENDING_REQUEST })
        .mockResolvedValueOnce({});

      const result = await handler(APPROVER_EVENT);

      const updateCmd = mockDynamoSend.mock.calls[1][0];
      expect(updateCmd.input.UpdateExpression).toContain("decidedAt = :now");
      expect(result.status).toBe("REJECTED");
      expect(typeof result.decidedAt).toBe("string");
      expect(result.decidedAt).toBe(result.updatedAt);
    });

    it("sends SendTaskFailure with error RequestRejected", async () => {
      mockDynamoSend
        .mockResolvedValueOnce({ Item: PENDING_REQUEST })
        .mockResolvedValueOnce({});

      await handler(APPROVER_EVENT);

      expect(mockSfnSend).toHaveBeenCalledOnce();
      const sfnCmd = mockSfnSend.mock.calls[0][0];
      expect(sfnCmd.input.taskToken).toBe(PENDING_REQUEST.taskToken);
      expect(sfnCmd.input.error).toBe("RequestRejected");
    });

    it("uses approverComment as the SendTaskFailure cause when provided", async () => {
      mockDynamoSend
        .mockResolvedValueOnce({ Item: PENDING_REQUEST })
        .mockResolvedValueOnce({});
      const event = {
        ...APPROVER_EVENT,
        arguments: { requestId: "req-1", approverComment: "Policy violation" },
      };

      await handler(event);

      const sfnCmd = mockSfnSend.mock.calls[0][0];
      expect(sfnCmd.input.cause).toBe("Policy violation");
    });

    it("returns the record with REJECTED status and null taskToken", async () => {
      mockDynamoSend
        .mockResolvedValueOnce({ Item: PENDING_REQUEST })
        .mockResolvedValueOnce({});

      const result = await handler(APPROVER_EVENT);

      expect(result.status).toBe("REJECTED");
      expect(result.taskToken).toBeNull();
      expect(result.approvedBy).toBe("approver-sub-222");
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
