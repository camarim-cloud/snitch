import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockDynamoSend,
  mockSsoSend,
  mockGetIDCInstance,
  mockNotifyAccessEvent,
} = vi.hoisted(() => ({
  mockDynamoSend: vi.fn(),
  mockSsoSend: vi.fn(),
  mockGetIDCInstance: vi.fn(),
  mockNotifyAccessEvent: vi.fn(),
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {},
}));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: vi.fn(() => ({ send: mockDynamoSend })),
  },
  UpdateCommand: class {
    readonly cmd = "Update";
    constructor(public input: unknown) {}
  },
  GetCommand: class {
    readonly cmd = "Get";
    constructor(public input: { TableName: string; Key: Record<string, string> }) {}
  },
}));

vi.mock("@aws-sdk/client-sso-admin", () => ({
  SSOAdminClient: class {
    send = mockSsoSend;
  },
  DeleteAccountAssignmentCommand: class {
    constructor(public input: unknown) {}
  },
  StatusValues: { FAILED: "FAILED", IN_PROGRESS: "IN_PROGRESS", SUCCEEDED: "SUCCEEDED" },
}));

vi.mock("../../amplify/functions/awsResources/helpers", () => ({
  getIDCInstancePublic: mockGetIDCInstance,
}));

vi.mock("../../amplify/functions/notifications/notify", () => ({
  notifyAccessEvent: mockNotifyAccessEvent,
}));

const { handler } = await import(
  "../../amplify/functions/accessRequests/removePermissionSetHandler"
);

const BASE_INPUT = {
  requestId: "req-1",
  idcUserId: "user-abc",
  accountId: "111111111111",
  permissionSetArn: "arn:aws:sso:::permissionSet/ssoins-1/ps-read",
  durationSeconds: 3600,
};

const REQUEST_RECORD = {
  id: "req-1",
  idcUserEmail: "alice@example.com",
  idcUserDisplayName: "Alice",
  accountId: "111111111111",
  accountName: "Prod",
  permissionSetArn: "arn:aws:sso:::permissionSet/ssoins-1/ps-read",
  permissionSetName: "ReadOnly",
  durationMinutes: 60,
};

// Update → {}; Get on the request → the record; Get on settings → toggles.
function wireDynamo(requestItem: Record<string, unknown> | undefined) {
  mockDynamoSend.mockImplementation((command: { cmd: string; input: { Key?: Record<string, string> } }) => {
    if (command.cmd === "Get" && command.input.Key?.id) {
      return Promise.resolve({ Item: requestItem });
    }
    if (command.cmd === "Get") {
      return Promise.resolve({ Item: { snsNotificationsEnabled: true } });
    }
    return Promise.resolve({});
  });
}

function updateCommand() {
  return mockDynamoSend.mock.calls
    .map((c) => c[0])
    .find((c: { cmd: string }) => c.cmd === "Update") as { input: { Key: Record<string, string>; ExpressionAttributeValues: Record<string, string> } };
}

describe("removePermissionSetHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ACCESS_REQUEST_TABLE_NAME = "AccessRequestTable";
    process.env.APP_SETTINGS_TABLE_NAME = "AppSettingsTable";
    mockGetIDCInstance.mockResolvedValue({ instanceArn: "arn:aws:sso:::instance/ssoins-1" });
    wireDynamo(REQUEST_RECORD);
  });

  it("calls DeleteAccountAssignment with correct parameters", async () => {
    mockSsoSend.mockResolvedValue({
      AccountAssignmentDeletionStatus: { Status: "SUCCEEDED" },
    });

    await handler(BASE_INPUT);

    expect(mockSsoSend).toHaveBeenCalledOnce();
    const cmd = mockSsoSend.mock.calls[0][0];
    expect(cmd.input).toMatchObject({
      InstanceArn: "arn:aws:sso:::instance/ssoins-1",
      TargetId: BASE_INPUT.accountId,
      TargetType: "AWS_ACCOUNT",
      PermissionSetArn: BASE_INPUT.permissionSetArn,
      PrincipalType: "USER",
      PrincipalId: BASE_INPUT.idcUserId,
    });
  });

  it("updates DynamoDB status to EXPIRED on natural expiry", async () => {
    mockSsoSend.mockResolvedValue({
      AccountAssignmentDeletionStatus: { Status: "SUCCEEDED" },
    });

    await handler(BASE_INPUT);

    const cmd = updateCommand();
    expect(cmd.input.Key).toEqual({ id: BASE_INPUT.requestId });
    expect(cmd.input.ExpressionAttributeValues[":s"]).toBe("EXPIRED");
  });

  it("updates DynamoDB status to REVOKED when revokedByAdmin is true", async () => {
    mockSsoSend.mockResolvedValue({
      AccountAssignmentDeletionStatus: { Status: "SUCCEEDED" },
    });

    await handler({ ...BASE_INPUT, revokedByAdmin: true });

    expect(updateCommand().input.ExpressionAttributeValues[":s"]).toBe("REVOKED");
  });

  it("updates DynamoDB status to EXPIRED when revokedByAdmin is false", async () => {
    mockSsoSend.mockResolvedValue({
      AccountAssignmentDeletionStatus: { Status: "SUCCEEDED" },
    });

    await handler({ ...BASE_INPUT, revokedByAdmin: false });

    expect(updateCommand().input.ExpressionAttributeValues[":s"]).toBe("EXPIRED");
  });

  it("sends a FINISHED notification with the final EXPIRED status and request context", async () => {
    mockSsoSend.mockResolvedValue({
      AccountAssignmentDeletionStatus: { Status: "SUCCEEDED" },
    });

    await handler(BASE_INPUT);

    expect(mockNotifyAccessEvent).toHaveBeenCalledOnce();
    const arg = mockNotifyAccessEvent.mock.calls[0][0];
    expect(arg.kind).toBe("FINISHED");
    expect(arg.request.status).toBe("EXPIRED");
    expect(arg.request.permissionSetName).toBe("ReadOnly");
    expect(arg.settings).toEqual({ snsNotificationsEnabled: true });
  });

  it("passes REVOKED as the final status to the notification on admin revoke", async () => {
    mockSsoSend.mockResolvedValue({
      AccountAssignmentDeletionStatus: { Status: "SUCCEEDED" },
    });

    await handler({ ...BASE_INPUT, revokedByAdmin: true });

    expect(mockNotifyAccessEvent.mock.calls[0][0].request.status).toBe("REVOKED");
  });

  it("does not send a notification when the request record is missing", async () => {
    wireDynamo(undefined);
    mockSsoSend.mockResolvedValue({
      AccountAssignmentDeletionStatus: { Status: "SUCCEEDED" },
    });

    await handler(BASE_INPUT);

    expect(mockNotifyAccessEvent).not.toHaveBeenCalled();
  });

  it("still succeeds when notification dispatch throws", async () => {
    mockSsoSend.mockResolvedValue({
      AccountAssignmentDeletionStatus: { Status: "SUCCEEDED" },
    });
    mockNotifyAccessEvent.mockRejectedValue(new Error("notify boom"));

    await expect(handler(BASE_INPUT)).resolves.toBeUndefined();
  });

  it("throws when DeleteAccountAssignment returns FAILED status", async () => {
    mockSsoSend.mockResolvedValue({
      AccountAssignmentDeletionStatus: {
        Status: "FAILED",
        FailureReason: "Assignment not found",
      },
    });

    await expect(handler(BASE_INPUT)).rejects.toThrow(
      "DeleteAccountAssignment failed for request req-1: Assignment not found"
    );
    expect(mockDynamoSend).not.toHaveBeenCalled();
  });

  it("propagates SSO Admin errors", async () => {
    mockSsoSend.mockRejectedValue(new Error("SSO unavailable"));
    await expect(handler(BASE_INPUT)).rejects.toThrow("SSO unavailable");
  });
});
