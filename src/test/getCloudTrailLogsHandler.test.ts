import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDynamoSend, mockLogsSend } = vi.hoisted(() => ({
  mockDynamoSend: vi.fn(),
  mockLogsSend: vi.fn(),
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

vi.mock("@aws-sdk/client-cloudwatch-logs", () => ({
  CloudWatchLogsClient: class {
    send = mockLogsSend;
  },
  FilterLogEventsCommand: class {
    constructor(public input: unknown) {}
  },
}));

const { handler } = await import(
  "../../amplify/functions/accessRequests/getCloudTrailLogsHandler"
);

const LOG_GROUP = "/aws/cloudtrail/my-trail";

const SETTINGS_ITEM = { settingKey: "global", cloudTrailLogGroupName: LOG_GROUP };

const BARE_CT_EVENT = {
  eventVersion: "1.08",
  eventTime: "2024-01-02T10:05:00Z",
  eventSource: "s3.amazonaws.com",
  eventName: "GetObject",
  awsRegion: "us-east-1",
  sourceIPAddress: "203.0.113.1",
  eventID: "evt-abc",
  readOnly: true,
  userIdentity: {
    type: "AssumedRole",
    arn: "arn:aws:sts::111111111111:assumed-role/AWSReservedSSO_ReadOnly_abc/alice@example.com",
  },
};

function makeRawEvent(overrides: Partial<{ message: string; timestamp: number; eventId: string }> = {}) {
  return {
    eventId: overrides.eventId ?? "cw-evt-1",
    timestamp: overrides.timestamp ?? 1704153900000,
    message: overrides.message ?? JSON.stringify(BARE_CT_EVENT),
  };
}

const APPSYNC_EVENT = {
  arguments: {
    startTime: "2024-01-02T10:00:00Z",
    endTime: "2024-01-02T11:00:00Z",
    idcUserEmail: "alice@example.com",
  },
  identity: {},
};

describe("getCloudTrailLogsHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.APP_SETTINGS_TABLE_NAME = "AppSettingsTable";
    process.env.AWS_REGION = "us-east-1";
  });

  describe("when log group is not configured", () => {
    it("returns [] when settings record does not exist", async () => {
      mockDynamoSend.mockResolvedValue({ Item: undefined });
      const result = await handler(APPSYNC_EVENT);
      expect(result).toEqual([]);
      expect(mockLogsSend).not.toHaveBeenCalled();
    });

    it("returns [] when cloudTrailLogGroupName is absent from the settings item", async () => {
      mockDynamoSend.mockResolvedValue({ Item: { settingKey: "global" } });
      const result = await handler(APPSYNC_EVENT);
      expect(result).toEqual([]);
      expect(mockLogsSend).not.toHaveBeenCalled();
    });
  });

  describe("CloudWatch Logs query", () => {
    beforeEach(() => {
      mockDynamoSend.mockResolvedValue({ Item: SETTINGS_ITEM });
      mockLogsSend.mockResolvedValue({ events: [], nextToken: undefined });
    });

    it("uses the configured log group name", async () => {
      await handler(APPSYNC_EVENT);
      const cmd = mockLogsSend.mock.calls[0][0];
      expect(cmd.input.logGroupName).toBe(LOG_GROUP);
    });

    it("converts ISO start/end times to milliseconds", async () => {
      await handler(APPSYNC_EVENT);
      const cmd = mockLogsSend.mock.calls[0][0];
      expect(cmd.input.startTime).toBe(new Date("2024-01-02T10:00:00Z").getTime());
      expect(cmd.input.endTime).toBe(new Date("2024-01-02T11:00:00Z").getTime());
    });

    it("sets filterPattern to ?\"{email}\" to match userIdentity.arn in AssumedRole sessions", async () => {
      await handler(APPSYNC_EVENT);
      const cmd = mockLogsSend.mock.calls[0][0];
      expect(cmd.input.filterPattern).toBe(`?"alice@example.com"`);
    });

    it("returns [] when no events match", async () => {
      const result = await handler(APPSYNC_EVENT);
      expect(result).toEqual([]);
    });
  });

  describe("event parsing — bare CloudTrail format", () => {
    beforeEach(() => {
      mockDynamoSend.mockResolvedValue({ Item: SETTINGS_ITEM });
    });

    it("extracts core fields from a bare CloudTrail event message", async () => {
      mockLogsSend.mockResolvedValue({
        events: [makeRawEvent()],
        nextToken: undefined,
      });

      const [result] = await handler(APPSYNC_EVENT);

      expect(result.eventName).toBe("GetObject");
      expect(result.eventSource).toBe("s3.amazonaws.com");
      expect(result.awsRegion).toBe("us-east-1");
      expect(result.sourceIPAddress).toBe("203.0.113.1");
      expect(result.eventTime).toBe("2024-01-02T10:05:00Z");
      expect(result.userIdentityType).toBe("AssumedRole");
      expect(result.userIdentityArn).toBe(
        "arn:aws:sts::111111111111:assumed-role/AWSReservedSSO_ReadOnly_abc/alice@example.com"
      );
      expect(result.readOnly).toBe(true);
    });

    it("maps the CloudWatch event timestamp to an ISO string", async () => {
      const ts = 1704153900000;
      mockLogsSend.mockResolvedValue({
        events: [makeRawEvent({ timestamp: ts })],
        nextToken: undefined,
      });

      const [result] = await handler(APPSYNC_EVENT);
      expect(result.timestamp).toBe(new Date(ts).toISOString());
    });
  });

  describe("event parsing — Records-wrapped CloudTrail format", () => {
    it("extracts the first record from a {Records:[...]} wrapper", async () => {
      mockDynamoSend.mockResolvedValue({ Item: SETTINGS_ITEM });
      mockLogsSend.mockResolvedValue({
        events: [
          makeRawEvent({
            message: JSON.stringify({ Records: [BARE_CT_EVENT] }),
          }),
        ],
        nextToken: undefined,
      });

      const [result] = await handler(APPSYNC_EVENT);
      expect(result.eventName).toBe("GetObject");
    });
  });

  describe("event parsing — error fields", () => {
    it("captures errorCode and errorMessage when present", async () => {
      mockDynamoSend.mockResolvedValue({ Item: SETTINGS_ITEM });
      const errorEvent = {
        ...BARE_CT_EVENT,
        errorCode: "AccessDenied",
        errorMessage: "User is not authorized",
      };
      mockLogsSend.mockResolvedValue({
        events: [makeRawEvent({ message: JSON.stringify(errorEvent) })],
        nextToken: undefined,
      });

      const [result] = await handler(APPSYNC_EVENT);
      expect(result.errorCode).toBe("AccessDenied");
      expect(result.errorMessage).toBe("User is not authorized");
    });
  });

  describe("resilience", () => {
    it("skips events whose message cannot be parsed as JSON", async () => {
      mockDynamoSend.mockResolvedValue({ Item: SETTINGS_ITEM });
      mockLogsSend.mockResolvedValue({
        events: [
          makeRawEvent({ message: "not json {{", eventId: "bad" }),
          makeRawEvent({ eventId: "good" }),
        ],
        nextToken: undefined,
      });

      const result = await handler(APPSYNC_EVENT);
      expect(result).toHaveLength(1);
      expect(result[0].eventId).toBe("good");
    });

    it("skips events with no message field", async () => {
      mockDynamoSend.mockResolvedValue({ Item: SETTINGS_ITEM });
      mockLogsSend.mockResolvedValue({
        events: [{ eventId: "no-msg", timestamp: 1234567890 }],
        nextToken: undefined,
      });

      const result = await handler(APPSYNC_EVENT);
      expect(result).toHaveLength(0);
    });
  });

  describe("pagination", () => {
    it("fetches multiple pages until nextToken is exhausted", async () => {
      mockDynamoSend.mockResolvedValue({ Item: SETTINGS_ITEM });
      mockLogsSend
        .mockResolvedValueOnce({ events: [makeRawEvent({ eventId: "p1" })], nextToken: "tok-1" })
        .mockResolvedValueOnce({ events: [makeRawEvent({ eventId: "p2" })], nextToken: undefined });

      const result = await handler(APPSYNC_EVENT);

      expect(mockLogsSend).toHaveBeenCalledTimes(2);
      expect(result.map((r) => r.eventId)).toEqual(["p1", "p2"]);
    });
  });

  describe("error propagation", () => {
    it("propagates DynamoDB errors when reading settings", async () => {
      mockDynamoSend.mockRejectedValue(new Error("DynamoDB unavailable"));
      await expect(handler(APPSYNC_EVENT)).rejects.toThrow("DynamoDB unavailable");
    });

    it("propagates CloudWatch Logs errors", async () => {
      mockDynamoSend.mockResolvedValue({ Item: SETTINGS_ITEM });
      mockLogsSend.mockRejectedValue(new Error("CloudWatch Logs throttled"));
      await expect(handler(APPSYNC_EVENT)).rejects.toThrow("CloudWatch Logs throttled");
    });
  });
});
