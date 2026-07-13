import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockListAllAccessRequests, mockGetCloudTrailLogs } = vi.hoisted(() => ({
  mockListAllAccessRequests: vi.fn(),
  mockGetCloudTrailLogs: vi.fn(),
}));

vi.mock("aws-amplify/data", () => ({
  generateClient: () => ({
    queries: {
      listAllAccessRequests: mockListAllAccessRequests,
      getCloudTrailLogs: mockGetCloudTrailLogs,
    },
  }),
}));

vi.mock("../../amplify_outputs.json", () => ({ default: {} }));

import { SessionActivityPage } from "../pages/SessionActivityPage";

const SESSION = {
  id: "req-1",
  idcUserDisplayName: "Alice",
  idcUserEmail: "alice@example.com",
  idcUserId: "u1",
  accountId: "111111111111",
  permissionSetName: "ReadOnly",
  permissionSetArn: "arn:aws:sso:::permissionSet/ps-read",
  status: "EXPIRED",
  requiresApproval: false,
  durationMinutes: 60,
  createdAt: "2024-01-02T09:55:00Z",
  updatedAt: "2024-01-02T11:30:00Z",
  decidedAt: "",
  approvedBy: "",
  approverComment: "",
  activatedAt: "2024-01-02T10:30:00Z",
  deactivatedAt: "2024-01-02T11:30:00Z",
  startTime: "",
  justification: "incident",
  revokeComment: "",
};

// Never activated (still pending approval) → excluded from Session Activity.
const NO_SESSION = {
  ...SESSION,
  id: "req-2",
  idcUserDisplayName: "Bob",
  status: "PENDING_APPROVAL",
  requiresApproval: true,
  activatedAt: "",
  deactivatedAt: "",
};

const CLOUDTRAIL_EVENT = {
  eventId: "evt-1",
  timestamp: "2024-01-02T10:35:00Z",
  eventTime: "2024-01-02T10:35:00Z",
  eventName: "GetObject",
  eventSource: "s3.amazonaws.com",
  userIdentityType: "AssumedRole",
  userIdentityArn:
    "arn:aws:sts::111111111111:assumed-role/AWSReservedSSO_ReadOnly_abc/alice@example.com",
  sourceIPAddress: "203.0.113.1",
  awsRegion: "us-east-1",
  errorCode: "",
  errorMessage: "",
  readOnly: true,
};

describe("SessionActivityPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCloudTrailLogs.mockResolvedValue({ data: [], errors: undefined });
  });

  it("lists only requests that started a real session (activatedAt present)", async () => {
    mockListAllAccessRequests.mockResolvedValue({
      data: [SESSION, NO_SESSION],
      errors: undefined,
    });
    render(<SessionActivityPage />);

    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    expect(screen.queryByText("Bob")).not.toBeInTheDocument();
  });

  it("opens the session logs modal and queries CloudTrail for the session window", async () => {
    mockListAllAccessRequests.mockResolvedValue({
      data: [SESSION],
      errors: undefined,
    });
    render(<SessionActivityPage />);
    await waitFor(() => screen.getByText("Alice"));

    await userEvent.click(screen.getAllByRole("radio")[0]);
    await userEvent.click(screen.getByRole("button", { name: /view session logs/i }));

    await waitFor(() =>
      expect(mockGetCloudTrailLogs).toHaveBeenCalledWith(
        expect.objectContaining({
          idcUserEmail: "alice@example.com",
          startTime: "2024-01-02T10:30:00Z",
          endTime: "2024-01-02T11:30:00Z",
        })
      )
    );
  });

  it("renders CloudTrail events in the session logs table", async () => {
    mockListAllAccessRequests.mockResolvedValue({
      data: [SESSION],
      errors: undefined,
    });
    mockGetCloudTrailLogs.mockResolvedValue({
      data: [CLOUDTRAIL_EVENT],
      errors: undefined,
    });
    render(<SessionActivityPage />);
    await waitFor(() => screen.getByText("Alice"));

    await userEvent.click(screen.getAllByRole("radio")[0]);
    await userEvent.click(screen.getByRole("button", { name: /view session logs/i }));

    await waitFor(() => expect(screen.getByText("GetObject")).toBeInTheDocument());
    expect(screen.getByText("s3.amazonaws.com")).toBeInTheDocument();
  });
});
