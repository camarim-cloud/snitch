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
  PutCommand: class {
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

  it("writes a PutItem with settingKey: 'global' and the provided log group name", async () => {
    await handler({
      arguments: { cloudTrailLogGroupName: "/aws/cloudtrail/my-trail" },
      identity: {},
    });

    const cmd = mockDynamoSend.mock.calls[0][0];
    expect(cmd.input.TableName).toBe("AppSettingsTable");
    expect(cmd.input.Item).toEqual({
      settingKey: "global",
      cloudTrailLogGroupName: "/aws/cloudtrail/my-trail",
    });
  });

  it("returns the saved cloudTrailLogGroupName", async () => {
    const result = await handler({
      arguments: { cloudTrailLogGroupName: "/aws/cloudtrail/prod" },
      identity: {},
    });
    expect(result).toEqual({ cloudTrailLogGroupName: "/aws/cloudtrail/prod" });
  });

  it("overwrites any previously stored value (idempotent put)", async () => {
    await handler({
      arguments: { cloudTrailLogGroupName: "/aws/cloudtrail/first" },
      identity: {},
    });
    await handler({
      arguments: { cloudTrailLogGroupName: "/aws/cloudtrail/second" },
      identity: {},
    });

    const secondCmd = mockDynamoSend.mock.calls[1][0];
    expect(secondCmd.input.Item.cloudTrailLogGroupName).toBe("/aws/cloudtrail/second");
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
