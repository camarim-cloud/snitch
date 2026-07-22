import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetMyIDCUser } = vi.hoisted(() => ({
  mockGetMyIDCUser: vi.fn(),
}));

vi.mock("../../amplify/functions/awsResources/helpers", () => ({
  getMyIDCUser: mockGetMyIDCUser,
}));

const { handler } = await import(
  "../../amplify/functions/awsResources/getMyIDCUserHandler"
);

const EMAIL = "alice@example.com";

const IDC_USER = {
  id: "idc-user-1",
  userName: "alice",
  displayName: "Alice",
  email: EMAIL,
};

function makeEvent(email?: string, username = "idc_alice@example.com") {
  return {
    identity: {
      username,
      claims: email ? { email } : {},
    },
  };
}

describe("getMyIDCUserHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMyIDCUser.mockResolvedValue(IDC_USER);
  });

  it("reads email from OIDC claims and returns the matching IDC user", async () => {
    const result = await handler(makeEvent(EMAIL));
    expect(mockGetMyIDCUser).toHaveBeenCalledWith(EMAIL);
    expect(result).toEqual(IDC_USER);
  });

  it("extracts email from federated username when no email claim is present", async () => {
    // Cognito formats federated usernames as "idc_<samlNameId>" where NameID = email
    const result = await handler(makeEvent(undefined, `idc_${EMAIL}`));
    expect(mockGetMyIDCUser).toHaveBeenCalledWith(EMAIL);
    expect(result).toEqual(IDC_USER);
  });

  it("throws when neither email claim nor idc_ username prefix is present", async () => {
    await expect(
      handler(makeEvent(undefined, "native-user"))
    ).rejects.toThrow("Could not resolve email from identity");
  });

  it("propagates IDC helper errors", async () => {
    mockGetMyIDCUser.mockRejectedValue(new Error("IdentityStore unavailable"));
    await expect(handler(makeEvent(EMAIL))).rejects.toThrow("IdentityStore unavailable");
  });
});
