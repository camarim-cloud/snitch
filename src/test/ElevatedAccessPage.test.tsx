import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockListAllAccessRequests, mockRevokeAccess, mockGetCloudTrailLogs } = vi.hoisted(
  () => ({
    mockListAllAccessRequests: vi.fn(),
    mockRevokeAccess: vi.fn(),
    mockGetCloudTrailLogs: vi.fn(),
  })
);

vi.mock("aws-amplify/data", () => ({
  generateClient: () => ({
    queries: {
      listAllAccessRequests: mockListAllAccessRequests,
      getCloudTrailLogs: mockGetCloudTrailLogs,
    },
    mutations: { revokeAccess: mockRevokeAccess },
    subscriptions: {
      onAccessRequestCreated: () => ({ subscribe: () => ({ unsubscribe: vi.fn() }) }),
      onAccessRequestApproved: () => ({ subscribe: () => ({ unsubscribe: vi.fn() }) }),
      onAccessRequestRejected: () => ({ subscribe: () => ({ unsubscribe: vi.fn() }) }),
      onAccessRequestRevoked: () => ({ subscribe: () => ({ unsubscribe: vi.fn() }) }),
    },
  }),
}));

vi.mock("../../amplify_outputs.json", () => ({ default: {} }));

import { ElevatedAccessPage } from "../pages/ElevatedAccessPage";

const ACTIVE_REQUEST = {
  id: "req-1",
  idcUserDisplayName: "Alice",
  idcUserEmail: "alice@example.com",
  idcUserId: "user-1",
  accountId: "111111111111",
  permissionSetName: "ReadOnly",
  permissionSetArn: "arn:aws:sso:::permissionSet/ps-read",
  status: "ACTIVE",
  durationMinutes: 60,
  createdAt: "2024-01-02T10:00:00Z",
  updatedAt: "2024-01-02T10:00:00Z",
  startTime: "",
  justification: "Need access for incident",
  approvedBy: "",
  approverComment: "",
  revokeComment: "",
};

const EXPIRED_REQUEST = {
  ...ACTIVE_REQUEST,
  id: "req-2",
  idcUserDisplayName: "Bob",
  idcUserEmail: "bob@example.com",
  status: "EXPIRED",
  createdAt: "2024-01-01T10:00:00Z",
};

const CLOUDTRAIL_EVENT = {
  eventId: "evt-1",
  timestamp: "2024-01-02T10:05:00Z",
  eventTime: "2024-01-02T10:05:00Z",
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

describe("ElevatedAccessPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRevokeAccess.mockResolvedValue({
      data: { ...ACTIVE_REQUEST, status: "REVOKED" },
      errors: undefined,
    });
    mockGetCloudTrailLogs.mockResolvedValue({ data: [], errors: undefined });
  });

  describe("loading and rendering", () => {
    it("shows a loading indicator while fetching", () => {
      mockListAllAccessRequests.mockReturnValue(new Promise(() => {}));
      render(<ElevatedAccessPage />);
      expect(screen.getByText(/loading access requests/i)).toBeInTheDocument();
    });

    it("renders all requests in the table after load", async () => {
      mockListAllAccessRequests.mockResolvedValue({
        data: [ACTIVE_REQUEST, EXPIRED_REQUEST],
        errors: undefined,
      });
      render(<ElevatedAccessPage />);

      await waitFor(() =>
        expect(screen.getByText("alice@example.com")).toBeInTheDocument()
      );
      expect(screen.getByText("bob@example.com")).toBeInTheDocument();
    });

    it("shows an error alert when the query fails", async () => {
      mockListAllAccessRequests.mockResolvedValue({
        data: null,
        errors: [{ message: "Unauthorized" }],
      });
      render(<ElevatedAccessPage />);

      await waitFor(() =>
        expect(screen.getByText("Unauthorized")).toBeInTheDocument()
      );
    });
  });

  describe("View Details button", () => {
    beforeEach(() => {
      mockListAllAccessRequests.mockResolvedValue({
        data: [ACTIVE_REQUEST, EXPIRED_REQUEST],
        errors: undefined,
      });
    });

    it("is disabled when no row is selected", async () => {
      render(<ElevatedAccessPage />);
      await waitFor(() => screen.getByText("alice@example.com"));
      expect(screen.getByRole("button", { name: /view details/i })).toBeDisabled();
    });

    it("is enabled when any row is selected (regardless of status)", async () => {
      render(<ElevatedAccessPage />);
      await waitFor(() => screen.getByText("bob@example.com"));

      // Select the EXPIRED row
      await userEvent.click(screen.getAllByRole("radio")[1]);
      expect(screen.getByRole("button", { name: /view details/i })).toBeEnabled();
    });

    it("opens the details modal when clicked", async () => {
      render(<ElevatedAccessPage />);
      await waitFor(() => screen.getByText("alice@example.com"));

      await userEvent.click(screen.getAllByRole("radio")[0]);
      await userEvent.click(screen.getByRole("button", { name: /view details/i }));

      await waitFor(() =>
        expect(screen.getByText(/request details/i)).toBeInTheDocument()
      );
    });
  });

  describe("Request Details modal", () => {
    beforeEach(() => {
      mockListAllAccessRequests.mockResolvedValue({
        data: [ACTIVE_REQUEST],
        errors: undefined,
      });
    });

    async function openDetailsModal() {
      render(<ElevatedAccessPage />);
      await waitFor(() => screen.getByText("alice@example.com"));
      await userEvent.click(screen.getAllByRole("radio")[0]);
      await userEvent.click(screen.getByRole("button", { name: /view details/i }));
      await waitFor(() => screen.getByText(/request details/i));
    }

    it("displays request metadata in the modal", async () => {
      await openDetailsModal();
      // Use the accessible name to distinguish the details dialog from the
      // (hidden but still mounted) revoke modal.
      const dialog = screen.getByRole("dialog", { name: /request details/i });
      expect(within(dialog).getByText("111111111111")).toBeInTheDocument();
      expect(within(dialog).getByText("ReadOnly")).toBeInTheDocument();
      expect(within(dialog).getByText("Need access for incident")).toBeInTheDocument();
    });

    it("calls getCloudTrailLogs with the correct time range and email", async () => {
      await openDetailsModal();

      await waitFor(() =>
        expect(mockGetCloudTrailLogs).toHaveBeenCalledWith(
          expect.objectContaining({
            idcUserEmail: "alice@example.com",
            startTime: "2024-01-02T10:00:00Z",
          })
        )
      );
    });

    it("renders CloudTrail events in the logs table", async () => {
      mockGetCloudTrailLogs.mockResolvedValue({
        data: [CLOUDTRAIL_EVENT],
        errors: undefined,
      });

      await openDetailsModal();

      await waitFor(() =>
        expect(screen.getByText("GetObject")).toBeInTheDocument()
      );
      expect(screen.getByText("s3.amazonaws.com")).toBeInTheDocument();
    });

    it("shows an error alert when getCloudTrailLogs fails", async () => {
      mockGetCloudTrailLogs.mockResolvedValue({
        data: null,
        errors: [{ message: "Log group not found" }],
      });

      await openDetailsModal();

      await waitFor(() =>
        expect(screen.getByText("Log group not found")).toBeInTheDocument()
      );
    });

    it("shows a warning when the requester has no email", async () => {
      mockListAllAccessRequests.mockResolvedValue({
        data: [{ ...ACTIVE_REQUEST, idcUserEmail: null }],
        errors: undefined,
      });

      render(<ElevatedAccessPage />);
      // idcUserEmail is null here, so the User column falls back to the display name.
      await waitFor(() => screen.getByText("Alice"));
      await userEvent.click(screen.getAllByRole("radio")[0]);
      await userEvent.click(screen.getByRole("button", { name: /view details/i }));

      await waitFor(() =>
        expect(
          screen.getByText(/no email address on record/i)
        ).toBeInTheDocument()
      );
    });
  });

  describe("Revoke Access button", () => {
    beforeEach(() => {
      mockListAllAccessRequests.mockResolvedValue({
        data: [ACTIVE_REQUEST, EXPIRED_REQUEST],
        errors: undefined,
      });
    });

    it("is disabled when no row is selected", async () => {
      render(<ElevatedAccessPage />);
      await waitFor(() => screen.getByText("alice@example.com"));
      expect(screen.getByRole("button", { name: /revoke access/i })).toBeDisabled();
    });

    it("is disabled when the selected row is not ACTIVE", async () => {
      render(<ElevatedAccessPage />);
      await waitFor(() => screen.getByText("bob@example.com"));

      await userEvent.click(screen.getAllByRole("radio")[1]);
      expect(screen.getByRole("button", { name: /revoke access/i })).toBeDisabled();
    });

    it("is enabled when the selected row is ACTIVE", async () => {
      render(<ElevatedAccessPage />);
      await waitFor(() => screen.getByText("alice@example.com"));

      await userEvent.click(screen.getAllByRole("radio")[0]);
      expect(screen.getByRole("button", { name: /revoke access/i })).toBeEnabled();
    });
  });

  describe("revocation flow", () => {
    beforeEach(() => {
      mockListAllAccessRequests.mockResolvedValue({
        data: [ACTIVE_REQUEST],
        errors: undefined,
      });
    });

    it("opens a confirmation modal when Revoke Access is clicked", async () => {
      render(<ElevatedAccessPage />);
      await waitFor(() => screen.getByText("alice@example.com"));

      await userEvent.click(screen.getAllByRole("radio")[0]);
      await userEvent.click(screen.getByRole("button", { name: /revoke access/i }));

      expect(screen.getByText(/this action cannot be undone/i)).toBeInTheDocument();
    });

    it("calls revokeAccess mutation and updates the row to REVOKED on confirm", async () => {
      render(<ElevatedAccessPage />);
      await waitFor(() => screen.getByText("alice@example.com"));

      await userEvent.click(screen.getAllByRole("radio")[0]);
      await userEvent.click(screen.getByRole("button", { name: /revoke access/i }));
      await userEvent.click(screen.getByRole("button", { name: /confirm revocation/i }));

      await waitFor(() =>
        expect(mockRevokeAccess).toHaveBeenCalledWith({ requestId: "req-1" })
      );
      await waitFor(() => expect(screen.getByText("REVOKED")).toBeInTheDocument());
    });

    it("shows an error in the modal when the mutation fails", async () => {
      mockRevokeAccess.mockResolvedValue({
        data: null,
        errors: [{ message: "Request is no longer active" }],
      });

      render(<ElevatedAccessPage />);
      await waitFor(() => screen.getByText("alice@example.com"));

      await userEvent.click(screen.getAllByRole("radio")[0]);
      await userEvent.click(screen.getByRole("button", { name: /revoke access/i }));
      await userEvent.click(screen.getByRole("button", { name: /confirm revocation/i }));

      await waitFor(() =>
        expect(
          screen.getByText("Request is no longer active")
        ).toBeInTheDocument()
      );
    });
  });

  describe("status filter", () => {
    it("shows all requests when filter is All statuses", async () => {
      mockListAllAccessRequests.mockResolvedValue({
        data: [ACTIVE_REQUEST, EXPIRED_REQUEST],
        errors: undefined,
      });
      render(<ElevatedAccessPage />);
      await waitFor(() => screen.getByText("alice@example.com"));

      expect(screen.getByText("bob@example.com")).toBeInTheDocument();
    });
  });
});
