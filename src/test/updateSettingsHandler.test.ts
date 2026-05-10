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
  UpdateCommand: class {
    constructor(public input: unknown) {}
  },
}));

// Set before import so the module-level TABLE_NAME constant captures the value.
process.env.APP_SETTINGS_TABLE_NAME = "AppSettingsTable";

const { handler } = await import(
  "../../amplify/functions/settings/updateSettingsHandler"
);

describe("updateSettingsHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.APP_SETTINGS_TABLE_NAME = "AppSettingsTable";
    mockDynamoSend.mockResolvedValue({});
  });

  it("issues an UpdateItem for cloudTrailLogGroupName only", async () => {
    await handler({
      arguments: { cloudTrailLogGroupName: "/aws/cloudtrail/my-trail" },
      identity: {},
    });

    const cmd = mockDynamoSend.mock.calls[0][0];
    expect(cmd.input.TableName).toBe("AppSettingsTable");
    expect(cmd.input.Key).toEqual({ settingKey: "global" });
    // UpdateExpression must reference exactly the one provided field
    expect(cmd.input.UpdateExpression).toMatch(/^SET /);
    const exprNames = Object.values(cmd.input.ExpressionAttributeNames as Record<string, string>);
    expect(exprNames).toContain("cloudTrailLogGroupName");
    expect(exprNames).not.toContain("slackBotToken");
  });

  it("issues an UpdateItem for Slack fields only, not touching cloudTrailLogGroupName", async () => {
    await handler({
      arguments: { slackBotToken: "xoxb-token", slackChannelId: "C123", slackSigningSecret: "sec" },
      identity: {},
    });

    const cmd = mockDynamoSend.mock.calls[0][0];
    const exprNames = Object.values(cmd.input.ExpressionAttributeNames as Record<string, string>);
    expect(exprNames).toContain("slackBotToken");
    expect(exprNames).toContain("slackChannelId");
    expect(exprNames).toContain("slackSigningSecret");
    expect(exprNames).not.toContain("cloudTrailLogGroupName");
  });

  it("returns only the fields that were provided", async () => {
    const result = await handler({
      arguments: { cloudTrailLogGroupName: "/aws/cloudtrail/prod" },
      identity: {},
    });
    expect(result).toEqual({ cloudTrailLogGroupName: "/aws/cloudtrail/prod" });
  });

  it("returns all Slack fields when all three are provided", async () => {
    const result = await handler({
      arguments: {
        slackBotToken: "xoxb-token",
        slackChannelId: "C123",
        slackSigningSecret: "sec",
      },
      identity: {},
    });
    expect(result).toEqual({
      slackBotToken: "xoxb-token",
      slackChannelId: "C123",
      slackSigningSecret: "sec",
    });
  });

  it("returns empty object and skips DynamoDB call when no fields are provided", async () => {
    const result = await handler({ arguments: {}, identity: {} });
    expect(result).toEqual({});
    expect(mockDynamoSend).not.toHaveBeenCalled();
  });

  it("treats null arguments as not-provided (AppSync forwards null for omitted optional args)", async () => {
    // Simulates saving only cloudTrailLogGroupName while AppSync sends null for the rest
    await handler({
      arguments: {
        cloudTrailLogGroupName: "/aws/cloudtrail/my-trail",
        slackBotToken: null,
        slackChannelId: null,
        slackSigningSecret: null,
      },
      identity: {},
    });

    const cmd = mockDynamoSend.mock.calls[0][0];
    const exprNames = Object.values(cmd.input.ExpressionAttributeNames as Record<string, string>);
    expect(exprNames).toContain("cloudTrailLogGroupName");
    expect(exprNames).not.toContain("slackBotToken");
    expect(exprNames).not.toContain("slackChannelId");
    expect(exprNames).not.toContain("slackSigningSecret");
  });

  it("propagates DynamoDB errors", async () => {
    mockDynamoSend.mockRejectedValue(new Error("Provisioned throughput exceeded"));
    await expect(
      handler({
        arguments: { cloudTrailLogGroupName: "/aws/cloudtrail/my-trail" },
        identity: {},
      })
    ).rejects.toThrow("Provisioned throughput exceeded");
  });
});
