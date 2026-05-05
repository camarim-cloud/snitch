import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDynamoSend, mockSfnSend } = vi.hoisted(() => ({
  mockDynamoSend: vi.fn(),
  mockSfnSend: vi.fn(),
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {},
}));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: vi.fn(() => ({ send: mockDynamoSend })),
  },
  PutCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock("@aws-sdk/client-sfn", () => ({
  SFNClient: class {
    send = mockSfnSend;
  },
  StartExecutionCommand: class {
    constructor(public input: unknown) {}
  },
}));

const { handler } = await import(
  "../../amplify/functions/accessRequests/requestAccessHandler"
);

const BASE_ARGS = {
  idcUserId: "idc-user-1",
  idcUserEmail: "requester@example.com",
  idcUserDisplayName: "Test User",
  accountId: "111111111111",
  permissionSetArn: "arn:aws:sso:::permissionSet/ssoins-1/ps-read",
  permissionSetName: "ReadOnly",
  durationMinutes: 60,
  requiresApproval: false,
  justification: "Need access for deployment",
};

const BASE_EVENT = {
  arguments: BASE_ARGS,
  identity: { username: "user-sub-111" },
};

describe("requestAccessHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ACCESS_REQUEST_TABLE_NAME = "AccessRequestTable";
    process.env.ACCESS_REQUEST_STATE_MACHINE_ARN = "arn:aws:states:us-east-1:123:stateMachine:sm";
    mockDynamoSend.mockResolvedValue({});
    mockSfnSend.mockResolvedValue({ executionArn: "arn:aws:states:us-east-1:123:execution:sm:exec-1" });
  });

  describe("validation", () => {
    it("throws when durationMinutes is zero", async () => {
      const event = { ...BASE_EVENT, arguments: { ...BASE_ARGS, durationMinutes: 0 } };
      await expect(handler(event)).rejects.toThrow(
        "Expected durationMinutes to be a positive number, got: 0"
      );
    });

    it("throws when durationMinutes is negative", async () => {
      const event = { ...BASE_EVENT, arguments: { ...BASE_ARGS, durationMinutes: -5 } };
      await expect(handler(event)).rejects.toThrow(
        "Expected durationMinutes to be a positive number, got: -5"
      );
    });
  });

  describe("requesterCognitoSub", () => {
    it("stores requesterCognitoSub from identity.username", async () => {
      await handler(BASE_EVENT);

      const firstPut = mockDynamoSend.mock.calls[0][0];
      expect(firstPut.input.Item.requesterCognitoSub).toBe("user-sub-111");
    });
  });

  describe("initial status", () => {
    it("sets PENDING when requiresApproval is false and no startTime", async () => {
      await handler(BASE_EVENT);

      const firstPut = mockDynamoSend.mock.calls[0][0];
      expect(firstPut.input.Item.status).toBe("PENDING");
    });

    it("sets PENDING_APPROVAL when requiresApproval is true", async () => {
      const event = { ...BASE_EVENT, arguments: { ...BASE_ARGS, requiresApproval: true } };
      await handler(event);

      const firstPut = mockDynamoSend.mock.calls[0][0];
      expect(firstPut.input.Item.status).toBe("PENDING_APPROVAL");
    });

    it("sets SCHEDULED when requiresApproval is false and startTime is provided", async () => {
      const event = {
        ...BASE_EVENT,
        arguments: { ...BASE_ARGS, startTime: "2099-01-01T10:00:00Z" },
      };
      await handler(event);

      const firstPut = mockDynamoSend.mock.calls[0][0];
      expect(firstPut.input.Item.status).toBe("SCHEDULED");
    });

    it("sets PENDING_APPROVAL (not SCHEDULED) when requiresApproval is true and startTime is set", async () => {
      const event = {
        ...BASE_EVENT,
        arguments: { ...BASE_ARGS, requiresApproval: true, startTime: "2099-01-01T10:00:00Z" },
      };
      await handler(event);

      const firstPut = mockDynamoSend.mock.calls[0][0];
      expect(firstPut.input.Item.status).toBe("PENDING_APPROVAL");
    });
  });

  describe("Step Functions execution", () => {
    it("starts the state machine with correct payload", async () => {
      await handler(BASE_EVENT);

      expect(mockSfnSend).toHaveBeenCalledOnce();
      const sfnCmd = mockSfnSend.mock.calls[0][0];
      const input = JSON.parse(sfnCmd.input.input);

      expect(input.idcUserId).toBe(BASE_ARGS.idcUserId);
      expect(input.accountId).toBe(BASE_ARGS.accountId);
      expect(input.permissionSetArn).toBe(BASE_ARGS.permissionSetArn);
      expect(input.durationSeconds).toBe(BASE_ARGS.durationMinutes * 60);
      expect(input.requiresApproval).toBe(false);
    });

    it("issues two DynamoDB PutCommands — before and after SFN", async () => {
      await handler(BASE_EVENT);

      expect(mockDynamoSend).toHaveBeenCalledTimes(2);
    });

    it("second PutCommand includes the executionArn", async () => {
      await handler(BASE_EVENT);

      const secondPut = mockDynamoSend.mock.calls[1][0];
      expect(secondPut.input.Item.stepFunctionExecutionArn).toBe(
        "arn:aws:states:us-east-1:123:execution:sm:exec-1"
      );
    });
  });

  describe("return value", () => {
    it("returns the record with stepFunctionExecutionArn", async () => {
      const result = await handler(BASE_EVENT);

      expect(result.stepFunctionExecutionArn).toBe(
        "arn:aws:states:us-east-1:123:execution:sm:exec-1"
      );
      expect(result.requesterCognitoSub).toBe("user-sub-111");
      expect(result.status).toBe("PENDING");
    });
  });

  it("propagates DynamoDB errors", async () => {
    mockDynamoSend.mockRejectedValue(new Error("DynamoDB unavailable"));
    await expect(handler(BASE_EVENT)).rejects.toThrow("DynamoDB unavailable");
  });

  it("propagates SFN errors", async () => {
    mockSfnSend.mockRejectedValue(new Error("Step Functions unavailable"));
    await expect(handler(BASE_EVENT)).rejects.toThrow("Step Functions unavailable");
  });
});
