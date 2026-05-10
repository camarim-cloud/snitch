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
  GetCommand: class {
    constructor(public input: unknown) {}
  },
}));

// Set before import so the module-level TABLE_NAME constant captures the value.
process.env.APP_SETTINGS_TABLE_NAME = "AppSettingsTable";

const { handler } = await import(
  "../../amplify/functions/settings/getSettingsHandler"
);

const APPSYNC_EVENT = { arguments: {}, identity: {} };

describe("getSettingsHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.APP_SETTINGS_TABLE_NAME = "AppSettingsTable";
  });

  it("returns null for all fields when no settings record exists", async () => {
    mockDynamoSend.mockResolvedValue({ Item: undefined });
    const result = await handler(APPSYNC_EVENT);
    expect(result).toEqual({
      cloudTrailLogGroupName: null,
      slackBotToken: null,
      slackChannelId: null,
      slackSigningSecret: null,
    });
  });

  it("returns all configured settings when the record exists", async () => {
    mockDynamoSend.mockResolvedValue({
      Item: {
        settingKey: "global",
        cloudTrailLogGroupName: "/aws/cloudtrail/my-trail",
        slackBotToken: "xoxb-token",
        slackChannelId: "C12345",
        slackSigningSecret: "secret",
      },
    });
    const result = await handler(APPSYNC_EVENT);
    expect(result).toEqual({
      cloudTrailLogGroupName: "/aws/cloudtrail/my-trail",
      slackBotToken: "xoxb-token",
      slackChannelId: "C12345",
      slackSigningSecret: "secret",
    });
  });

  it("returns null for unset Slack fields when only cloudTrailLogGroupName is stored", async () => {
    mockDynamoSend.mockResolvedValue({
      Item: { settingKey: "global", cloudTrailLogGroupName: "/aws/cloudtrail/my-trail" },
    });
    const result = await handler(APPSYNC_EVENT);
    expect(result).toEqual({
      cloudTrailLogGroupName: "/aws/cloudtrail/my-trail",
      slackBotToken: null,
      slackChannelId: null,
      slackSigningSecret: null,
    });
  });

  it("issues a GetItem call with settingKey: 'global'", async () => {
    mockDynamoSend.mockResolvedValue({ Item: undefined });
    await handler(APPSYNC_EVENT);

    const cmd = mockDynamoSend.mock.calls[0][0];
    expect(cmd.input.TableName).toBe("AppSettingsTable");
    expect(cmd.input.Key).toEqual({ settingKey: "global" });
  });

  it("propagates DynamoDB errors", async () => {
    mockDynamoSend.mockRejectedValue(new Error("DynamoDB unavailable"));
    await expect(handler(APPSYNC_EVENT)).rejects.toThrow("DynamoDB unavailable");
  });
});
