import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "crypto";

const { mockDynamoSend, mockCognitoSend, mockIdcSend, mockAvpSend, mockLambdaSend, mockFetch } =
  vi.hoisted(() => ({
    mockDynamoSend: vi.fn(),
    mockCognitoSend: vi.fn(),
    mockIdcSend: vi.fn(),
    mockAvpSend: vi.fn(),
    mockLambdaSend: vi.fn(),
    mockFetch: vi.fn(),
  }));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: vi.fn(() => ({ send: mockDynamoSend })) },
  GetCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock("@aws-sdk/client-cognito-identity-provider", () => ({
  CognitoIdentityProviderClient: class {
    send = mockCognitoSend;
  },
  ListUsersCommand: class {
    constructor(public input: unknown) {}
  },
}));

// Approver GROUP membership now comes from IAM Identity Center (IDC GroupIds), mirroring
// preTokenGenerationHandler — the app defines no Cognito user-pool groups. Commands are tagged
// with _type so the shared send spy can dispatch deterministically regardless of call order.
vi.mock("@aws-sdk/client-identitystore", () => ({
  IdentitystoreClient: class {
    send = mockIdcSend;
  },
  ListUsersCommand: class {
    _type = "IdcListUsers";
    constructor(public input: unknown) {}
  },
  ListGroupMembershipsForMemberCommand: class {
    _type = "IdcListGroupMemberships";
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

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    send = mockLambdaSend;
  },
  InvokeCommand: class {
    constructor(public input: unknown) {}
  },
}));

// Set before import so module-level constants capture the correct values.
process.env.APP_SETTINGS_TABLE_NAME = "AppSettingsTable";
process.env.ACCESS_REQUEST_TABLE_NAME = "AccessRequestTable";
process.env.AUTH_USER_POOL_ID = "us-east-1_TestPool";
process.env.IDC_IDENTITY_STORE_ID = "d-1234567890";
process.env.AVP_POLICY_STORE_ID = "testPolicyStoreId";
process.env.APPROVE_REQUEST_FUNCTION_ARN = "arn:aws:lambda:us-east-1:123:function:approveRequest";
process.env.REJECT_REQUEST_FUNCTION_ARN = "arn:aws:lambda:us-east-1:123:function:rejectRequest";

const { handler } = await import(
  "../../amplify/functions/slackInteractions/slackInteractiveHandler"
);

// ─── Test constants ────────────────────────────────────────────────────────────

const SIGNING_SECRET = "test-signing-secret";
const BOT_TOKEN = "xoxb-test-token";
const REQUEST_ID = "req-abc-123";
const SLACK_USER_ID = "U01234";
const APPROVER_EMAIL = "approver@example.com";
const COGNITO_USERNAME = "approver-cognito-sub";
const IDC_GROUP_ID = "11111111-2222-3333-4444-555555555555";
const RESPONSE_URL = "https://hooks.slack.com/actions/test";

function slackSignature(timestamp: string, rawBody: string): string {
  const sigBase = `v0:${timestamp}:${rawBody}`;
  return `v0=${createHmac("sha256", SIGNING_SECRET).update(sigBase).digest("hex")}`;
}

function makeBody(actionId: "approve" | "reject", requestId = REQUEST_ID): string {
  const payload = {
    type: "block_actions",
    user: { id: SLACK_USER_ID, username: "approver" },
    actions: [{ action_id: actionId, value: requestId }],
    response_url: RESPONSE_URL,
  };
  return `payload=${encodeURIComponent(JSON.stringify(payload))}`;
}

function makeEvent(
  rawBody: string,
  overrides: { signature?: string; timestamp?: string } = {}
): Parameters<typeof handler>[0] {
  const timestamp = "1700000000";
  return {
    body: rawBody,
    headers: {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": overrides.signature ?? slackSignature(timestamp, rawBody),
    },
  };
}

const SETTINGS_ITEM = { slackBotToken: BOT_TOKEN, slackSigningSecret: SIGNING_SECRET };
const REQUEST_ITEM = {
  id: REQUEST_ID,
  status: "PENDING_APPROVAL",
  taskToken: "sfn-token",
  idcUserEmail: "requester@example.com",
  accountId: "111111111111",
  accountName: "Production Account",
  permissionSetArn: "arn:aws:sso:::permissionSet/ssoins-1/ps-read",
  durationMinutes: 60,
  idcUserId: "idc-user",
};

// Dispatch the two IdentityStore calls (resolve IDC user by email → its group memberships).
// idcUserId=null models an email with no matching IDC user (empty group list).
function setupIdcGroups(groupIds: string[], idcUserId: string | null = "idc-user-1") {
  mockIdcSend.mockImplementation((cmd: { _type?: string }) => {
    if (cmd._type === "IdcListUsers") {
      return Promise.resolve({ Users: idcUserId ? [{ UserId: idcUserId }] : [] });
    }
    if (cmd._type === "IdcListGroupMemberships") {
      return Promise.resolve({ GroupMemberships: groupIds.map((GroupId) => ({ GroupId })) });
    }
    return Promise.resolve({});
  });
}

function setupHappyPath() {
  // DynamoDB: settings → request
  mockDynamoSend
    .mockResolvedValueOnce({ Item: SETTINGS_ITEM })
    .mockResolvedValueOnce({ Item: REQUEST_ITEM });
  // Slack users.info
  mockFetch.mockResolvedValueOnce({
    json: async () => ({ ok: true, user: { profile: { email: APPROVER_EMAIL } } }),
  });
  // Cognito: ListUsers (username only — no Cognito group lookup anymore)
  mockCognitoSend.mockResolvedValueOnce({ Users: [{ Username: COGNITO_USERNAME }] });
  // IDC: resolve the approver's group memberships (immutable GroupIds)
  setupIdcGroups([IDC_GROUP_ID]);
  // AVP: ALLOW
  mockAvpSend.mockResolvedValue({ decision: "ALLOW" });
  // Lambda invocation: success
  mockLambdaSend.mockResolvedValue({ FunctionError: undefined, Payload: undefined });
  // response_url update
  mockFetch.mockResolvedValueOnce({ json: async () => ({}) });
}

describe("slackInteractiveHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mockFetch);
  });

  // ─── Signature verification ────────────────────────────────────────────────

  it("returns 403 when Slack signing secret is not configured", async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: { slackBotToken: BOT_TOKEN } }); // no signingSecret
    const body = makeBody("approve");
    const result = await handler(makeEvent(body));
    expect(result.statusCode).toBe(403);
  });

  it("returns 403 when the Slack signature is invalid", async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: SETTINGS_ITEM });
    const body = makeBody("approve");
    const result = await handler(
      makeEvent(body, { signature: "v0=badhash000000000000000000000000000000000000000000000000000000000" })
    );
    expect(result.statusCode).toBe(403);
  });

  it("accepts a correctly signed request", async () => {
    setupHappyPath();
    const body = makeBody("approve");
    const result = await handler(makeEvent(body));
    expect(result.statusCode).toBe(200);
  });

  it("decodes a base64-encoded body before verifying the signature", async () => {
    setupHappyPath();
    const rawBody = makeBody("approve");
    const timestamp = "1700000000";
    const sig = slackSignature(timestamp, rawBody);
    const event = {
      body: Buffer.from(rawBody).toString("base64"),
      isBase64Encoded: true,
      headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": sig },
    };
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
  });

  // ─── Payload parsing ──────────────────────────────────────────────────────

  it("returns 400 when payload parameter is missing from body", async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: SETTINGS_ITEM });
    const rawBody = "no_payload_here=true";
    const result = await handler(makeEvent(rawBody));
    expect(result.statusCode).toBe(400);
  });

  it("returns 400 when the payload JSON is malformed", async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: SETTINGS_ITEM });
    const rawBody = `payload=${encodeURIComponent("{not:json")}`;
    const result = await handler(makeEvent(rawBody));
    expect(result.statusCode).toBe(400);
  });

  it("returns 400 when action_id is not approve or reject", async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: SETTINGS_ITEM });
    const payload = JSON.stringify({
      type: "block_actions",
      user: { id: SLACK_USER_ID, username: "user" },
      actions: [{ action_id: "unknown_action", value: REQUEST_ID }],
      response_url: RESPONSE_URL,
    });
    const rawBody = `payload=${encodeURIComponent(payload)}`;
    const result = await handler(makeEvent(rawBody));
    expect(result.statusCode).toBe(400);
  });

  // ─── Missing bot token ────────────────────────────────────────────────────

  it("calls response_url and returns 200 when slackBotToken is not configured", async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: { slackSigningSecret: SIGNING_SECRET } });
    mockFetch.mockResolvedValue({ json: async () => ({}) }); // response_url
    const body = makeBody("approve");
    const result = await handler(makeEvent(body));
    expect(result.statusCode).toBe(200);
    const [responseUrl] = mockFetch.mock.calls[0];
    expect(responseUrl).toBe(RESPONSE_URL);
  });

  // ─── Slack users.info failure ─────────────────────────────────────────────

  it("calls response_url with an error when Slack returns ok: false for users.info", async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: SETTINGS_ITEM });
    mockFetch
      .mockResolvedValueOnce({ json: async () => ({ ok: false }) }) // users.info failure
      .mockResolvedValueOnce({ json: async () => ({}) }); // response_url
    const body = makeBody("approve");
    const result = await handler(makeEvent(body));
    expect(result.statusCode).toBe(200);
    const responseBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(responseBody.text).toMatch(/email/i);
  });

  // ─── Request validation ───────────────────────────────────────────────────

  it("calls response_url with not-found message when request does not exist", async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: SETTINGS_ITEM })
      .mockResolvedValueOnce({ Item: undefined });
    mockFetch
      .mockResolvedValueOnce({ json: async () => ({ ok: true, user: { profile: { email: APPROVER_EMAIL } } }) })
      .mockResolvedValueOnce({ json: async () => ({}) });
    const body = makeBody("approve");
    const result = await handler(makeEvent(body));
    expect(result.statusCode).toBe(200);
    const responseBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(responseBody.text).toMatch(/not found/i);
  });

  it("calls response_url when request is not in PENDING_APPROVAL state", async () => {
    const activeRequest = { ...REQUEST_ITEM, status: "ACTIVE" };
    mockDynamoSend
      .mockResolvedValueOnce({ Item: SETTINGS_ITEM })
      .mockResolvedValueOnce({ Item: activeRequest });
    mockFetch
      .mockResolvedValueOnce({ json: async () => ({ ok: true, user: { profile: { email: APPROVER_EMAIL } } }) })
      .mockResolvedValueOnce({ json: async () => ({}) });
    const body = makeBody("approve");
    const result = await handler(makeEvent(body));
    expect(result.statusCode).toBe(200);
    const responseBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(responseBody.text).toContain("ACTIVE");
  });

  // ─── Self-approval guard ──────────────────────────────────────────────────

  it("blocks self-approval when Slack user email matches the requester's idcUserEmail", async () => {
    const selfRequest = { ...REQUEST_ITEM, idcUserEmail: APPROVER_EMAIL };
    mockDynamoSend
      .mockResolvedValueOnce({ Item: SETTINGS_ITEM })
      .mockResolvedValueOnce({ Item: selfRequest });
    mockFetch
      .mockResolvedValueOnce({ json: async () => ({ ok: true, user: { profile: { email: APPROVER_EMAIL } } }) })
      .mockResolvedValueOnce({ json: async () => ({}) });
    const body = makeBody("approve");
    const result = await handler(makeEvent(body));
    expect(result.statusCode).toBe(200);
    const responseBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(responseBody.text).toMatch(/cannot approve.*own/i);
  });

  // ─── Cognito email lookup ──────────────────────────────────────────────────

  it("calls response_url when Slack email has no matching Cognito user", async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: SETTINGS_ITEM })
      .mockResolvedValueOnce({ Item: REQUEST_ITEM });
    mockFetch
      .mockResolvedValueOnce({ json: async () => ({ ok: true, user: { profile: { email: APPROVER_EMAIL } } }) })
      .mockResolvedValueOnce({ json: async () => ({}) });
    mockCognitoSend.mockResolvedValueOnce({ Users: [] }); // no match
    const body = makeBody("approve");
    const result = await handler(makeEvent(body));
    expect(result.statusCode).toBe(200);
    const responseBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(responseBody.text).toMatch(/does not match/i);
  });

  it("passes the approver's IDC GroupIds (not Cognito groups) as ApproverGroup parents in the AVP call", async () => {
    setupHappyPath();
    const body = makeBody("approve");
    await handler(makeEvent(body));

    const avpCall = mockAvpSend.mock.calls[0][0];
    const parents = avpCall.input.entities.entityList[0].parents;
    expect(parents).toEqual([{ entityType: "Snitch::ApproverGroup", entityId: IDC_GROUP_ID }]);
    // Cognito is used only to resolve the username — never for group membership.
    expect(mockCognitoSend).toHaveBeenCalledTimes(1);
    const idcCommandTypes = mockIdcSend.mock.calls.map((c) => c[0]._type);
    expect(idcCommandTypes).toEqual(["IdcListUsers", "IdcListGroupMemberships"]);
  });

  it("falls back to an empty group list when the Slack email has no matching IDC user", async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: SETTINGS_ITEM })
      .mockResolvedValueOnce({ Item: REQUEST_ITEM });
    mockFetch
      .mockResolvedValueOnce({ json: async () => ({ ok: true, user: { profile: { email: APPROVER_EMAIL } } }) })
      .mockResolvedValueOnce({ json: async () => ({}) });
    mockCognitoSend.mockResolvedValueOnce({ Users: [{ Username: COGNITO_USERNAME }] });
    setupIdcGroups([], null); // no IDC user found → no group memberships
    mockAvpSend.mockResolvedValue({ decision: "ALLOW" }); // USER-approver policy still resolves
    mockLambdaSend.mockResolvedValue({ FunctionError: undefined });

    const result = await handler(makeEvent(makeBody("approve")));
    expect(result.statusCode).toBe(200);
    const avpCall = mockAvpSend.mock.calls[0][0];
    expect(avpCall.input.entities.entityList[0].parents).toEqual([]);
    const payload = JSON.parse(Buffer.from(mockLambdaSend.mock.calls[0][0].input.Payload).toString());
    expect(payload.identity.claims["cognito:groups"]).toEqual([]);
  });

  // ─── AVP authorization ─────────────────────────────────────────────────────

  it("calls response_url with unauthorized message when AVP returns DENY", async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: SETTINGS_ITEM })
      .mockResolvedValueOnce({ Item: REQUEST_ITEM });
    mockFetch
      .mockResolvedValueOnce({ json: async () => ({ ok: true, user: { profile: { email: APPROVER_EMAIL } } }) })
      .mockResolvedValueOnce({ json: async () => ({}) });
    mockCognitoSend.mockResolvedValueOnce({ Users: [{ Username: COGNITO_USERNAME }] });
    setupIdcGroups([]);
    mockAvpSend.mockResolvedValue({ decision: "DENY" });
    const body = makeBody("approve");
    const result = await handler(makeEvent(body));
    expect(result.statusCode).toBe(200);
    const responseBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(responseBody.text).toMatch(/not authorized/i);
  });

  it("calls AVP with Snitch::Approver principal and the request's accountId and permissionSetArn", async () => {
    setupHappyPath();
    await handler(makeEvent(makeBody("approve")));

    const avpCall = mockAvpSend.mock.calls[0][0];
    expect(avpCall.input.principal).toEqual({ entityType: "Snitch::Approver", entityId: COGNITO_USERNAME });
    expect(avpCall.input.resource).toEqual({ entityType: "Snitch::Account", entityId: REQUEST_ITEM.accountId });
    expect(avpCall.input.context.contextMap.permissionSetArn.string).toBe(REQUEST_ITEM.permissionSetArn);
  });

  // ─── Lambda delegation ─────────────────────────────────────────────────────

  it("invokes approveRequestFunction with the Cognito identity when action is approve", async () => {
    setupHappyPath();
    await handler(makeEvent(makeBody("approve")));

    const lambdaCall = mockLambdaSend.mock.calls[0][0];
    expect(lambdaCall.input.FunctionName).toBe(process.env.APPROVE_REQUEST_FUNCTION_ARN);
    const payload = JSON.parse(Buffer.from(lambdaCall.input.Payload).toString());
    expect(payload.arguments.requestId).toBe(REQUEST_ID);
    expect(payload.identity.username).toBe(COGNITO_USERNAME);
    expect(payload.identity.claims["cognito:groups"]).toEqual([IDC_GROUP_ID]);
  });

  it("invokes rejectRequestFunction when action is reject", async () => {
    setupHappyPath();
    // Override first Lambda mock response for reject action
    mockLambdaSend.mockResolvedValue({ FunctionError: undefined });
    await handler(makeEvent(makeBody("reject")));

    const lambdaCall = mockLambdaSend.mock.calls[0][0];
    expect(lambdaCall.input.FunctionName).toBe(process.env.REJECT_REQUEST_FUNCTION_ARN);
  });

  it("updates the Slack message to show approved result after successful approve", async () => {
    setupHappyPath();
    await handler(makeEvent(makeBody("approve")));

    const responseUrlCall = mockFetch.mock.calls[1]; // 2nd fetch call = response_url
    expect(responseUrlCall[0]).toBe(RESPONSE_URL);
    const responseBody = JSON.parse(responseUrlCall[1].body);
    expect(responseBody.replace_original).toBe(true);
    expect(responseBody.text).toContain(APPROVER_EMAIL);
  });

  it("updates the Slack message to show rejected result after successful reject", async () => {
    setupHappyPath();
    await handler(makeEvent(makeBody("reject")));

    const responseBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(responseBody.text).toMatch(/rejected/i);
  });

  it("calls response_url with an error message when the Lambda invocation fails", async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: SETTINGS_ITEM })
      .mockResolvedValueOnce({ Item: REQUEST_ITEM });
    mockFetch
      .mockResolvedValueOnce({ json: async () => ({ ok: true, user: { profile: { email: APPROVER_EMAIL } } }) })
      .mockResolvedValueOnce({ json: async () => ({}) });
    mockCognitoSend.mockResolvedValueOnce({ Users: [{ Username: COGNITO_USERNAME }] });
    setupIdcGroups([]);
    mockAvpSend.mockResolvedValue({ decision: "ALLOW" });
    mockLambdaSend.mockResolvedValue({
      FunctionError: "Unhandled",
      Payload: Buffer.from(JSON.stringify({ errorMessage: "cannot approve own request" })),
    });
    const body = makeBody("approve");
    const result = await handler(makeEvent(body));
    expect(result.statusCode).toBe(200);
    const responseBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(responseBody.text).toMatch(/failed/i);
  });
});
