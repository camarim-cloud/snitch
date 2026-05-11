import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDynamoSend, mockFetch } = vi.hoisted(() => ({
  mockDynamoSend: vi.fn(),
  mockFetch: vi.fn(),
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {},
}));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: vi.fn(() => ({ send: mockDynamoSend })),
  },
  UpdateCommand: class {
    constructor(public input: unknown) {}
  },
  GetCommand: class {
    constructor(public input: unknown) {}
  },
}));

// Set before import so module-level constants capture the correct values.
process.env.ACCESS_REQUEST_TABLE_NAME = "AccessRequestTable";
process.env.APP_SETTINGS_TABLE_NAME = "AppSettingsTable";

const { handler } = await import(
  "../../amplify/functions/accessRequests/storeApprovalTokenHandler"
);

const BASE_INPUT = {
  requestId: "req-1",
  idcUserId: "user-abc",
  accountId: "111111111111",
  permissionSetArn: "arn:aws:sso:::permissionSet/ssoins-1/ps-read",
  durationSeconds: 3600,
  taskToken: "token-xyz",
};

const REQUEST_ITEM = {
  id: "req-1",
  idcUserDisplayName: "Alice Smith",
  idcUserEmail: "alice@example.com",
  accountId: "111111111111",
  accountName: "Production Account",
  permissionSetArn: "arn:aws:sso:::permissionSet/ssoins-1/ps-read",
  permissionSetName: "ReadOnly",
  durationMinutes: 60,
  justification: "Need access for incident investigation",
};

const SLACK_SETTINGS = {
  slackBotToken: "xoxb-test-token",
  slackChannelId: "C01234ABCDE",
};

function successFetch() {
  return { json: async () => ({ ok: true }) };
}

describe("storeApprovalTokenHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValue(successFetch());
  });

  // ─── Core DynamoDB write ───────────────────────────────────────────────────

  it("stores the task token and sets status PENDING_APPROVAL", async () => {
    mockDynamoSend.mockResolvedValue({});

    await handler(BASE_INPUT);

    const updateCmd = mockDynamoSend.mock.calls[0][0];
    expect(updateCmd.input.TableName).toBe("AccessRequestTable");
    expect(updateCmd.input.Key).toEqual({ id: BASE_INPUT.requestId });
    expect(updateCmd.input.ExpressionAttributeValues[":s"]).toBe("PENDING_APPROVAL");
    expect(updateCmd.input.ExpressionAttributeValues[":token"]).toBe(BASE_INPUT.taskToken);
  });

  it("sets updatedAt on the record", async () => {
    mockDynamoSend.mockResolvedValue({});
    const before = new Date().toISOString();

    await handler(BASE_INPUT);

    const after = new Date().toISOString();
    const updatedAt = mockDynamoSend.mock.calls[0][0].input.ExpressionAttributeValues[":now"];
    expect(updatedAt >= before).toBe(true);
    expect(updatedAt <= after).toBe(true);
  });

  it("propagates DynamoDB errors from the UpdateCommand", async () => {
    mockDynamoSend.mockRejectedValue(new Error("DynamoDB unavailable"));

    await expect(handler(BASE_INPUT)).rejects.toThrow("DynamoDB unavailable");
  });

  // ─── Slack notification – happy path ──────────────────────────────────────

  it("calls Slack chat.postMessage when Slack is configured", async () => {
    mockDynamoSend
      .mockResolvedValueOnce({})                              // UpdateCommand
      .mockResolvedValueOnce({ Item: REQUEST_ITEM })          // GetCommand – request
      .mockResolvedValueOnce({ Item: SLACK_SETTINGS });       // GetCommand – settings

    await handler(BASE_INPUT);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect(options.headers.Authorization).toBe(`Bearer ${SLACK_SETTINGS.slackBotToken}`);
  });

  it("sends the Slack message to the configured channel", async () => {
    mockDynamoSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: REQUEST_ITEM })
      .mockResolvedValueOnce({ Item: SLACK_SETTINGS });

    await handler(BASE_INPUT);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.channel).toBe(SLACK_SETTINGS.slackChannelId);
  });

  it("includes requester name, account, permission set, duration, and justification in the blocks", async () => {
    mockDynamoSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: REQUEST_ITEM })
      .mockResolvedValueOnce({ Item: SLACK_SETTINGS });

    await handler(BASE_INPUT);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const blockText = JSON.stringify(body.blocks);
    expect(blockText).toContain("Alice Smith");
    expect(blockText).toContain("alice@example.com");
    expect(blockText).toContain("111111111111");
    expect(blockText).toContain("Production Account");
    expect(blockText).toContain("ReadOnly");
    expect(blockText).toContain("Need access for incident investigation");
  });

  it("shows accountName (accountId) when accountName is stored on the request", async () => {
    mockDynamoSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: REQUEST_ITEM })
      .mockResolvedValueOnce({ Item: SLACK_SETTINGS });

    await handler(BASE_INPUT);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const accountField = JSON.stringify(body.blocks[1].fields[1]);
    expect(accountField).toContain("Production Account (111111111111)");
  });

  it("shows only accountId when accountName is not stored on the request", async () => {
    const itemWithoutName = { ...REQUEST_ITEM, accountName: null };
    mockDynamoSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: itemWithoutName })
      .mockResolvedValueOnce({ Item: SLACK_SETTINGS });

    await handler(BASE_INPUT);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const accountField = JSON.stringify(body.blocks[1].fields[1]);
    expect(accountField).toContain("111111111111");
    expect(accountField).not.toContain("(111111111111)");
  });

  it("includes Approve and Reject buttons that carry the requestId as value", async () => {
    mockDynamoSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: REQUEST_ITEM })
      .mockResolvedValueOnce({ Item: SLACK_SETTINGS });

    await handler(BASE_INPUT);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const actionsBlock = body.blocks.find((b: { type: string }) => b.type === "actions");
    const actionIds = actionsBlock.elements.map((e: { action_id: string }) => e.action_id);
    const values = actionsBlock.elements.map((e: { value: string }) => e.value);
    expect(actionIds).toContain("approve");
    expect(actionIds).toContain("reject");
    expect(values).toEqual([BASE_INPUT.requestId, BASE_INPUT.requestId]);
  });

  // ─── Duration formatting ───────────────────────────────────────────────────

  it("formats duration as minutes when under one hour", async () => {
    const item = { ...REQUEST_ITEM, durationMinutes: 45 };
    mockDynamoSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: item })
      .mockResolvedValueOnce({ Item: SLACK_SETTINGS });

    await handler(BASE_INPUT);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(JSON.stringify(body.blocks)).toContain("45min");
  });

  it("formats duration as hours and minutes", async () => {
    const item = { ...REQUEST_ITEM, durationMinutes: 90 };
    mockDynamoSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: item })
      .mockResolvedValueOnce({ Item: SLACK_SETTINGS });

    await handler(BASE_INPUT);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(JSON.stringify(body.blocks)).toContain("1h 30min");
  });

  it("formats duration with days", async () => {
    const item = { ...REQUEST_ITEM, durationMinutes: 1500 }; // 1d 1h
    mockDynamoSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: item })
      .mockResolvedValueOnce({ Item: SLACK_SETTINGS });

    await handler(BASE_INPUT);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(JSON.stringify(body.blocks)).toContain("1d");
  });

  // ─── Slack notification – skipped when not configured ─────────────────────

  it("skips Slack notification when slackBotToken is absent", async () => {
    mockDynamoSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: REQUEST_ITEM })
      .mockResolvedValueOnce({ Item: { slackChannelId: "C01234" } }); // no token

    await handler(BASE_INPUT);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("skips Slack notification when slackChannelId is absent", async () => {
    mockDynamoSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: REQUEST_ITEM })
      .mockResolvedValueOnce({ Item: { slackBotToken: "xoxb-token" } }); // no channel

    await handler(BASE_INPUT);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("skips Slack notification when the request item is not found", async () => {
    mockDynamoSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: undefined })
      .mockResolvedValueOnce({ Item: SLACK_SETTINGS });

    await handler(BASE_INPUT);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ─── Slack errors are swallowed ────────────────────────────────────────────

  it("resolves successfully even when the Slack API returns an error", async () => {
    mockDynamoSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: REQUEST_ITEM })
      .mockResolvedValueOnce({ Item: SLACK_SETTINGS });
    mockFetch.mockResolvedValue({ json: async () => ({ ok: false, error: "channel_not_found" }) });

    await expect(handler(BASE_INPUT)).resolves.toBeUndefined();
  });

  it("resolves successfully even when fetch itself throws", async () => {
    mockDynamoSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: REQUEST_ITEM })
      .mockResolvedValueOnce({ Item: SLACK_SETTINGS });
    mockFetch.mockRejectedValue(new Error("Network error"));

    await expect(handler(BASE_INPUT)).resolves.toBeUndefined();
  });

  it("resolves successfully even when the DynamoDB GetItem for notification fails", async () => {
    mockDynamoSend
      .mockResolvedValueOnce({})  // UpdateCommand succeeds
      .mockRejectedValue(new Error("GetItem throttled"));  // both GetCommands fail

    await expect(handler(BASE_INPUT)).resolves.toBeUndefined();
  });
});
