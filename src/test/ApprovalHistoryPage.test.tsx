import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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

import { ApprovalHistoryPage } from "../pages/ApprovalHistoryPage";
import { formatDateTime } from "@/utils/formatDateTime";

const APPROVED = {
  id: "req-1",
  idcUserDisplayName: "Alice",
  idcUserEmail: "alice@example.com",
  idcUserId: "u1",
  accountId: "111111111111",
  permissionSetName: "ReadOnly",
  permissionSetArn: "arn:aws:sso:::permissionSet/ps-read",
  status: "ACTIVE",
  requiresApproval: true,
  durationMinutes: 60,
  createdAt: "2024-01-02T10:00:00Z",
  updatedAt: "2024-01-03T00:00:00Z",
  decidedAt: "2024-01-02T11:00:00Z",
  approvedBy: "approver@example.com",
  approverComment: "looks good",
  activatedAt: "2024-01-02T10:30:00Z",
  deactivatedAt: "",
  startTime: "",
  justification: "need for incident",
  revokeComment: "",
};

// Rejected + no decidedAt → the "Decided at" column must fall back to updatedAt.
const REJECTED_LEGACY = {
  ...APPROVED,
  id: "req-2",
  idcUserDisplayName: "Bob",
  idcUserEmail: "bob@example.com",
  status: "REJECTED",
  decidedAt: "",
  updatedAt: "2024-01-04T09:00:00Z",
};

const NO_APPROVAL = {
  ...APPROVED,
  id: "req-3",
  idcUserDisplayName: "Carol",
  idcUserEmail: "carol@example.com",
  requiresApproval: false,
};

describe("ApprovalHistoryPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCloudTrailLogs.mockResolvedValue({ data: [], errors: undefined });
  });

  it("lists only requests that required approval", async () => {
    mockListAllAccessRequests.mockResolvedValue({
      data: [APPROVED, REJECTED_LEGACY, NO_APPROVAL],
      errors: undefined,
    });
    render(<ApprovalHistoryPage />);

    await waitFor(() =>
      expect(screen.getByText("alice@example.com")).toBeInTheDocument()
    );
    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
    expect(screen.queryByText("carol@example.com")).not.toBeInTheDocument();
  });

  it("shows decidedAt, falling back to updatedAt for legacy records", async () => {
    mockListAllAccessRequests.mockResolvedValue({
      data: [APPROVED, REJECTED_LEGACY],
      errors: undefined,
    });
    render(<ApprovalHistoryPage />);

    await waitFor(() =>
      expect(screen.getByText("alice@example.com")).toBeInTheDocument()
    );
    // Alice: durable decidedAt is shown (rendered in local time).
    expect(
      screen.getByText(formatDateTime("2024-01-02T11:00:00Z"))
    ).toBeInTheDocument();
    // Bob: no decidedAt → falls back to updatedAt.
    expect(
      screen.getByText(formatDateTime("2024-01-04T09:00:00Z"))
    ).toBeInTheDocument();
  });

  it("shows an error alert when the query fails", async () => {
    mockListAllAccessRequests.mockResolvedValue({
      data: null,
      errors: [{ message: "Unauthorized" }],
    });
    render(<ApprovalHistoryPage />);
    await waitFor(() =>
      expect(screen.getByText("Unauthorized")).toBeInTheDocument()
    );
  });

  it("opens a read-only details modal with NO CloudTrail section", async () => {
    mockListAllAccessRequests.mockResolvedValue({
      data: [APPROVED],
      errors: undefined,
    });
    render(<ApprovalHistoryPage />);
    await waitFor(() => screen.getByText("alice@example.com"));

    await userEvent.click(screen.getAllByRole("radio")[0]);
    await userEvent.click(screen.getByRole("button", { name: /view details/i }));

    const dialog = await screen.findByRole("dialog", { name: /request details/i });
    expect(within(dialog).getByText("need for incident")).toBeInTheDocument();
    expect(within(dialog).getByText("looks good")).toBeInTheDocument();
    // Approval History must not run or render the session CloudTrail log view.
    expect(within(dialog).queryByText(/cloudtrail events/i)).not.toBeInTheDocument();
    expect(mockGetCloudTrailLogs).not.toHaveBeenCalled();
  });
});
