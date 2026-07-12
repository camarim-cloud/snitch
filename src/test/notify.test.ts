import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSnsSend } = vi.hoisted(() => ({ mockSnsSend: vi.fn() }));

vi.mock("@aws-sdk/client-sns", () => ({
  SNSClient: class {
    send = mockSnsSend;
  },
  PublishCommand: class {
    constructor(public input: { TopicArn: string; Subject: string; Message: string }) {}
  },
}));

const { notifyAccessEvent, notifyPendingApproval, formatDurationMinutes } = await import(
  "../../amplify/functions/notifications/notify"
);

const REQUEST = {
  idcUserDisplayName: "Alice",
  idcUserEmail: "alice@example.com",
  accountId: "111111111111",
  accountName: "Prod",
  permissionSetArn: "arn:aws:sso:::permissionSet/ssoins-1/ps-read",
  permissionSetName: "ReadOnly",
  durationMinutes: 90,
  justification: "deploy hotfix",
};

const BOTH_ENABLED = {
  slackNotificationsEnabled: true,
  slackBotToken: "xoxb-token",
  slackChannelId: "C0123",
  snsNotificationsEnabled: true,
};

const TOPIC = "arn:aws:sns:us-east-1:123:AccessNotifications";

function mockFetchOk() {
  const fetchMock = vi.fn().mockResolvedValue({ json: async () => ({ ok: true }) });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function slackBody(fetchMock: ReturnType<typeof vi.fn>) {
  return JSON.parse(fetchMock.mock.calls[0][1].body as string);
}

describe("formatDurationMinutes", () => {
  it.each([
    [45, "45min"],
    [90, "1h 30min"],
    [60, "1h"],
    [1440, "1d"],
    [3360, "2d 8h"],
    [0, "0min"],
  ])("formats %i minutes as %s", (minutes, expected) => {
    expect(formatDurationMinutes(minutes)).toBe(expected);
  });
});

describe("notifyAccessEvent — channel selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSnsSend.mockResolvedValue({});
  });

  it("sends to both Slack and SNS when both are enabled and configured", async () => {
    const fetchMock = mockFetchOk();
    await notifyAccessEvent({ kind: "REQUESTED", request: REQUEST, settings: BOTH_ENABLED, topicArn: TOPIC });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("https://slack.com/api/chat.postMessage");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer xoxb-token");
    expect(slackBody(fetchMock).channel).toBe("C0123");

    expect(mockSnsSend).toHaveBeenCalledOnce();
    expect(mockSnsSend.mock.calls[0][0].input.TopicArn).toBe(TOPIC);
  });

  it("skips Slack when slackNotificationsEnabled is false", async () => {
    const fetchMock = mockFetchOk();
    await notifyAccessEvent({
      kind: "REQUESTED",
      request: REQUEST,
      settings: { ...BOTH_ENABLED, slackNotificationsEnabled: false },
      topicArn: TOPIC,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockSnsSend).toHaveBeenCalledOnce();
  });

  it("skips Slack when the bot token or channel is missing even if enabled", async () => {
    const fetchMock = mockFetchOk();
    await notifyAccessEvent({
      kind: "REQUESTED",
      request: REQUEST,
      settings: { slackNotificationsEnabled: true, snsNotificationsEnabled: false },
      topicArn: TOPIC,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips SNS when snsNotificationsEnabled is false", async () => {
    mockFetchOk();
    await notifyAccessEvent({
      kind: "REQUESTED",
      request: REQUEST,
      settings: { ...BOTH_ENABLED, snsNotificationsEnabled: false },
      topicArn: TOPIC,
    });
    expect(mockSnsSend).not.toHaveBeenCalled();
  });

  it("skips SNS when no topic ARN is provided even if enabled", async () => {
    mockFetchOk();
    await notifyAccessEvent({ kind: "REQUESTED", request: REQUEST, settings: BOTH_ENABLED, topicArn: null });
    expect(mockSnsSend).not.toHaveBeenCalled();
  });
});

describe("notifyAccessEvent — best-effort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSnsSend.mockResolvedValue({});
  });

  it("does not throw and still publishes to SNS when Slack fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ json: async () => ({ ok: false, error: "channel_not_found" }) });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      notifyAccessEvent({ kind: "REQUESTED", request: REQUEST, settings: BOTH_ENABLED, topicArn: TOPIC })
    ).resolves.toBeUndefined();
    expect(mockSnsSend).toHaveBeenCalledOnce();
  });

  it("does not throw when SNS publish fails", async () => {
    mockFetchOk();
    mockSnsSend.mockRejectedValue(new Error("sns down"));

    await expect(
      notifyAccessEvent({ kind: "REQUESTED", request: REQUEST, settings: BOTH_ENABLED, topicArn: TOPIC })
    ).resolves.toBeUndefined();
  });
});

describe("notifyAccessEvent — message content", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSnsSend.mockResolvedValue({});
    mockFetchOk();
  });

  it("titles a REQUESTED event and includes justification + status", async () => {
    await notifyAccessEvent({
      kind: "REQUESTED",
      request: { ...REQUEST, status: "PENDING_APPROVAL" },
      settings: BOTH_ENABLED,
      topicArn: TOPIC,
    });
    const msg = mockSnsSend.mock.calls[0][0].input;
    expect(msg.Subject).toBe("AWS access session started - Prod (111111111111)");
    expect(msg.Message).toContain("Requester: Alice (alice@example.com)");
    expect(msg.Message).toContain("Account: Prod (111111111111)");
    expect(msg.Message).toContain("Duration: 1h 30min");
    expect(msg.Message).toContain("Justification: deploy hotfix");
    expect(msg.Message).toContain("Status: PENDING_APPROVAL");
  });

  it("titles a FINISHED event and includes the revoke reason for REVOKED", async () => {
    await notifyAccessEvent({
      kind: "FINISHED",
      request: { ...REQUEST, status: "REVOKED", revokeComment: "policy violation" },
      settings: BOTH_ENABLED,
      topicArn: TOPIC,
    });
    const msg = mockSnsSend.mock.calls[0][0].input;
    expect(msg.Subject).toBe("AWS access session finished - Prod (111111111111)");
    expect(msg.Message).toContain("Status: REVOKED");
    expect(msg.Message).toContain("Revoke reason: policy violation");
  });

  it("omits the revoke reason for a natural EXPIRED finish", async () => {
    await notifyAccessEvent({
      kind: "FINISHED",
      request: { ...REQUEST, status: "EXPIRED" },
      settings: BOTH_ENABLED,
      topicArn: TOPIC,
    });
    const msg = mockSnsSend.mock.calls[0][0].input;
    expect(msg.Message).toContain("Status: EXPIRED");
    expect(msg.Message).not.toContain("Revoke reason");
  });
});

describe("notifyPendingApproval", () => {
  const APP_URL = "https://snitch.example.com/";
  const APPROVAL_ON = { snsApprovalNotificationsEnabled: true };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSnsSend.mockResolvedValue({});
  });

  it("publishes an approval notification with the app link when enabled", async () => {
    await notifyPendingApproval({
      request: REQUEST,
      settings: APPROVAL_ON,
      topicArn: TOPIC,
      appUrl: APP_URL,
    });

    expect(mockSnsSend).toHaveBeenCalledOnce();
    const msg = mockSnsSend.mock.calls[0][0].input;
    expect(msg.TopicArn).toBe(TOPIC);
    expect(msg.Subject).toBe("AWS access approval required - Prod (111111111111)");
    expect(msg.Message).toContain("Requester: Alice (alice@example.com)");
    expect(msg.Message).toContain("Justification: deploy hotfix");
    expect(msg.Message).toContain("https://snitch.example.com/#/approve-requests");
  });

  it("does not publish when the approval toggle is off", async () => {
    await notifyPendingApproval({
      request: REQUEST,
      settings: { snsApprovalNotificationsEnabled: false },
      topicArn: TOPIC,
      appUrl: APP_URL,
    });
    expect(mockSnsSend).not.toHaveBeenCalled();
  });

  it("does not publish when there is no topic ARN", async () => {
    await notifyPendingApproval({
      request: REQUEST,
      settings: APPROVAL_ON,
      topicArn: null,
      appUrl: APP_URL,
    });
    expect(mockSnsSend).not.toHaveBeenCalled();
  });

  it("is gated independently of the requested/finished SNS toggle", async () => {
    // snsNotificationsEnabled true but the approval toggle absent → no approval email.
    await notifyPendingApproval({
      request: REQUEST,
      settings: { snsNotificationsEnabled: true },
      topicArn: TOPIC,
      appUrl: APP_URL,
    });
    expect(mockSnsSend).not.toHaveBeenCalled();
  });

  it("does not throw when SNS publish fails", async () => {
    mockSnsSend.mockRejectedValue(new Error("sns down"));
    await expect(
      notifyPendingApproval({ request: REQUEST, settings: APPROVAL_ON, topicArn: TOPIC, appUrl: APP_URL })
    ).resolves.toBeUndefined();
  });
});
