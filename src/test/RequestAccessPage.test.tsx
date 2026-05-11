import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import createWrapper from "@cloudscape-design/components/test-utils/dom";

// vi.hoisted ensures mock functions exist before vi.mock factories execute
const { mockGetMyIDCUser, mockEvaluateMyAccess, mockListMyAccessRequests, mockListAWSAccounts, mockRequestAccess } =
  vi.hoisted(() => ({
    mockGetMyIDCUser: vi.fn(),
    mockEvaluateMyAccess: vi.fn(),
    // Default: returns an empty list so the requests table renders without errors
    mockListMyAccessRequests: vi.fn().mockResolvedValue({ data: [], errors: undefined }),
    mockListAWSAccounts: vi.fn().mockResolvedValue({ data: [], errors: undefined }),
    mockRequestAccess: vi.fn().mockResolvedValue({ data: { id: "req-1" }, errors: undefined }),
  }));

vi.mock("aws-amplify/data", () => ({
  generateClient: () => ({
    queries: {
      getMyIDCUser: mockGetMyIDCUser,
      evaluateMyAccess: mockEvaluateMyAccess,
      listMyAccessRequests: mockListMyAccessRequests,
      listAWSAccounts: mockListAWSAccounts,
    },
    mutations: {
      requestAccess: mockRequestAccess,
    },
    subscriptions: {
      onAccessRequestCreated: () => ({ subscribe: () => ({ unsubscribe: vi.fn() }) }),
      onAccessRequestApproved: () => ({ subscribe: () => ({ unsubscribe: vi.fn() }) }),
      onAccessRequestRejected: () => ({ subscribe: () => ({ unsubscribe: vi.fn() }) }),
    },
  }),
}));

// Stub amplify_outputs.json so Amplify.configure() doesn't fail in jsdom
vi.mock("../../amplify_outputs.json", () => ({ default: {} }));

import { RequestAccessPage } from "../pages/RequestAccessPage";

const IDC_USER = {
  id: "idc-user-1",
  userName: "alice",
  displayName: "Alice",
  email: "alice@example.com",
};

const ACCOUNT_1 = {
  accountId: "111111111111",
  permissionSetArn: "arn:aws:sso:::permissionSet/ps-read",
  permissionSetName: "ReadOnly",
};

const ACCOUNT_2 = {
  accountId: "222222222222",
  permissionSetArn: "arn:aws:sso:::permissionSet/ps-admin",
  permissionSetName: "Admin",
};

function successfulLoad(permitted = [ACCOUNT_1]) {
  mockGetMyIDCUser.mockResolvedValue({ data: IDC_USER, errors: undefined });
  mockEvaluateMyAccess.mockResolvedValue({ data: permitted, errors: undefined });
}

describe("RequestAccessPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore the default resolved values after clearAllMocks resets them
    mockListMyAccessRequests.mockResolvedValue({ data: [], errors: undefined });
    mockListAWSAccounts.mockResolvedValue({ data: [], errors: undefined });
    mockRequestAccess.mockResolvedValue({ data: { id: "req-1" }, errors: undefined });
  });

  describe("loading state", () => {
    it("disables the New request button while resolving access", () => {
      mockGetMyIDCUser.mockReturnValue(new Promise(() => {})); // never resolves
      render(<RequestAccessPage />);
      expect(screen.getByRole("button", { name: /new request/i })).toBeDisabled();
    });
  });

  describe("error states", () => {
    it("shows an error alert when getMyIDCUser returns no data", async () => {
      mockGetMyIDCUser.mockResolvedValue({ data: null, errors: undefined });
      render(<RequestAccessPage />);
      await waitFor(() =>
        expect(
          screen.getByText(/no iam identity center user found/i)
        ).toBeInTheDocument()
      );
    });

    it("shows an error alert when getMyIDCUser returns GraphQL errors", async () => {
      mockGetMyIDCUser.mockResolvedValue({
        data: null,
        errors: [{ message: "Unauthorized" }],
      });
      render(<RequestAccessPage />);
      await waitFor(() =>
        expect(screen.getByText(/unauthorized/i)).toBeInTheDocument()
      );
    });

    it("shows an error alert when evaluateMyAccess returns GraphQL errors", async () => {
      mockGetMyIDCUser.mockResolvedValue({ data: IDC_USER, errors: undefined });
      mockEvaluateMyAccess.mockResolvedValue({
        data: null,
        errors: [{ message: "AVP error" }],
      });
      render(<RequestAccessPage />);
      await waitFor(() =>
        expect(screen.getByText(/avp error/i)).toBeInTheDocument()
      );
    });

    it("shows a Retry button that re-triggers the load", async () => {
      // First call fails, second succeeds
      mockGetMyIDCUser
        .mockResolvedValueOnce({ data: null, errors: undefined })
        .mockResolvedValue({ data: IDC_USER, errors: undefined });
      mockEvaluateMyAccess.mockResolvedValue({ data: [ACCOUNT_1], errors: undefined });

      render(<RequestAccessPage />);
      await waitFor(() => screen.getByRole("button", { name: /retry/i }));

      await userEvent.click(screen.getByRole("button", { name: /retry/i }));
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: /new request/i })
        ).not.toBeDisabled()
      );
    });
  });

  describe("successful load", () => {
    it("enables the New request button after load completes", async () => {
      successfulLoad();
      render(<RequestAccessPage />);
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: /new request/i })
        ).not.toBeDisabled()
      );
    });

    it("opens the modal when New request is clicked", async () => {
      successfulLoad();
      render(<RequestAccessPage />);
      await waitFor(() => screen.getByRole("button", { name: /new request/i }));

      await userEvent.click(screen.getByRole("button", { name: /new request/i }));
      expect(
        screen.getByRole("dialog", { name: /new access request/i })
      ).toBeInTheDocument();
    });
  });

  describe("modal — no permitted access", () => {
    it("shows an info alert when the user has no permitted access", async () => {
      successfulLoad([]);
      render(<RequestAccessPage />);
      await waitFor(() => screen.getByRole("button", { name: /new request/i }));

      await userEvent.click(screen.getByRole("button", { name: /new request/i }));
      expect(
        screen.getByText(/no policies that grant you access/i)
      ).toBeInTheDocument();
    });
  });

  describe("modal — form", () => {
    async function openModal(permitted = [ACCOUNT_1, ACCOUNT_2]) {
      successfulLoad(permitted);
      render(<RequestAccessPage />);
      await waitFor(() => screen.getByRole("button", { name: /new request/i }));
      await userEvent.click(screen.getByRole("button", { name: /new request/i }));
    }

    it("renders the Account, Permission Set, Duration, and Justification fields", async () => {
      await openModal();
      expect(screen.getByText("AWS Account")).toBeInTheDocument();
      // Use getAllByText because the table column header also says "Permission Set"
      expect(screen.getAllByText("Permission Set").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Duration").length).toBeGreaterThan(0);
      expect(screen.getByText("Justification")).toBeInTheDocument();
    });

    it("renders the justification textarea with placeholder text", async () => {
      await openModal();
      expect(
        screen.getByPlaceholderText(/describe the business reason/i)
      ).toBeInTheDocument();
    });

    it("shows validation errors when submitting an empty form", async () => {
      await openModal();
      await userEvent.click(screen.getByRole("button", { name: /submit request/i }));
      expect(screen.getByText("Select an account.")).toBeInTheDocument();
      expect(screen.getByText("Select a permission set.")).toBeInTheDocument();
      expect(
        screen.getByText(/enter a valid duration greater than zero/i)
      ).toBeInTheDocument();
      expect(
        screen.getByText(/explain why you need this access/i)
      ).toBeInTheDocument();
    });

    it("shows a justification validation error when only that field is empty", async () => {
      await openModal([ACCOUNT_1]);

      // Fill the justification textarea — leave other fields empty to focus on justification error
      const textarea = screen.getByPlaceholderText(/describe the business reason/i);
      await userEvent.clear(textarea);

      await userEvent.click(screen.getByRole("button", { name: /submit request/i }));

      expect(
        screen.getByText(/explain why you need this access/i)
      ).toBeInTheDocument();
    });

    it("accepts text input in the justification textarea", async () => {
      await openModal([ACCOUNT_1]);
      const textarea = screen.getByPlaceholderText(/describe the business reason/i);
      await userEvent.type(textarea, "Investigating a production incident.");
      expect(textarea).toHaveValue("Investigating a production incident.");
    });

    it("keeps the modal open after a failed validation", async () => {
      await openModal();
      await userEvent.click(screen.getByRole("button", { name: /submit request/i }));
      expect(
        screen.getByRole("dialog", { name: /new access request/i })
      ).toBeInTheDocument();
    });

    it("closes the modal when Cancel is clicked", async () => {
      await openModal();
      // Verify the modal is open: Submit request button is present
      expect(
        screen.getByRole("button", { name: /submit request/i })
      ).toBeInTheDocument();

      const dialog = screen.getByRole("dialog", { name: /new access request/i });
      const cancelBtn = within(dialog).getByRole("button", { name: "Cancel" });
      await userEvent.click(cancelBtn);

      // Cloudscape keeps modal content mounted but adds awsui_hidden CSS class.
      // jsdom doesn't process CSS so we verify the React state changed by
      // checking the modal root has the hidden class applied.
      await waitFor(() =>
        expect(dialog.className).toMatch(/hidden/)
      );
    });

    it("resets validation errors when the modal is reopened", async () => {
      successfulLoad([ACCOUNT_1]);
      render(<RequestAccessPage />);
      await waitFor(() => screen.getByRole("button", { name: /new request/i }));

      // Open → submit (triggers errors) → cancel → reopen
      await userEvent.click(screen.getByRole("button", { name: /new request/i }));
      await userEvent.click(screen.getByRole("button", { name: /submit request/i }));
      const dialog = screen.getByRole("dialog", { name: /new access request/i });
      await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await userEvent.click(screen.getByRole("button", { name: /new request/i }));

      expect(screen.queryByText("Select an account.")).not.toBeInTheDocument();
      expect(
        screen.queryByText(/explain why you need this access/i)
      ).not.toBeInTheDocument();
    });

    it("clears the justification textarea when the modal is reopened", async () => {
      successfulLoad([ACCOUNT_1]);
      render(<RequestAccessPage />);
      await waitFor(() => screen.getByRole("button", { name: /new request/i }));

      // Open → type justification → cancel → reopen → field is empty
      await userEvent.click(screen.getByRole("button", { name: /new request/i }));
      const textarea = screen.getByPlaceholderText(/describe the business reason/i);
      await userEvent.type(textarea, "Some justification");

      const dialog = screen.getByRole("dialog", { name: /new access request/i });
      await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await userEvent.click(screen.getByRole("button", { name: /new request/i }));

      expect(
        screen.getByPlaceholderText(/describe the business reason/i)
      ).toHaveValue("");
    });
  });

  describe("modal — start time field", () => {
    async function openModal(permitted = [ACCOUNT_1]) {
      successfulLoad(permitted);
      render(<RequestAccessPage />);
      await waitFor(() => screen.getByRole("button", { name: /new request/i }));
      await userEvent.click(screen.getByRole("button", { name: /new request/i }));
    }

    it("renders the 'Start time (optional)' label in the modal", async () => {
      await openModal();
      expect(screen.getByText("Start time (optional)")).toBeInTheDocument();
    });

    it("a time value entered without a date does not trigger start time validation", async () => {
      await openModal();
      // Cloudscape TimeInput disabled state is CSS-only in jsdom; set value programmatically
      createWrapper().findTimeInput()!.setInputValue("23:59");
      await userEvent.click(screen.getByRole("button", { name: /submit request/i }));
      // Validation skips startTime when startTimeDate is empty
      expect(
        screen.queryByText(/start time must be in the future/i)
      ).not.toBeInTheDocument();
    });

    it("a time entered alongside a past date triggers the start time error", async () => {
      await openModal();
      createWrapper().findAllDatePickers()[0].setInputValue("2020/01/01");
      createWrapper().findAllTimeInputs()[0].setInputValue("10:00");
      await userEvent.click(screen.getByRole("button", { name: /submit request/i }));
      expect(
        screen.getByText("Start time must be in the future.")
      ).toBeInTheDocument();
    });

    it("shows 'Start time must be in the future.' when the date is in the past", async () => {
      await openModal();
      createWrapper().findAllDatePickers()[0].setInputValue("2020/01/01");
      await userEvent.click(screen.getByRole("button", { name: /submit request/i }));
      expect(
        screen.getByText("Start time must be in the future.")
      ).toBeInTheDocument();
    });

    it("does not show a start time error when the field is left empty", async () => {
      await openModal();
      await userEvent.click(screen.getByRole("button", { name: /submit request/i }));
      expect(
        screen.queryByText(/start time must be in the future/i)
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(/enter a valid date and time/i)
      ).not.toBeInTheDocument();
    });

    it("does not show a start time error when a valid future date is provided", async () => {
      await openModal();
      createWrapper().findDatePicker()!.setInputValue("2027/01/01");
      await userEvent.click(screen.getByRole("button", { name: /submit request/i }));
      expect(
        screen.queryByText(/start time must be in the future/i)
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(/enter a valid date and time/i)
      ).not.toBeInTheDocument();
    });

    it("clears the start time error when the modal is closed and reopened", async () => {
      successfulLoad([ACCOUNT_1]);
      render(<RequestAccessPage />);
      await waitFor(() => screen.getByRole("button", { name: /new request/i }));

      // Open → set a past date → submit → error appears
      await userEvent.click(screen.getByRole("button", { name: /new request/i }));
      createWrapper().findAllDatePickers()[0].setInputValue("2020/01/01");
      await userEvent.click(screen.getByRole("button", { name: /submit request/i }));
      expect(
        screen.getByText("Start time must be in the future.")
      ).toBeInTheDocument();

      // Cancel → reopen → error is gone
      const dialog = screen.getByRole("dialog", { name: /new access request/i });
      await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await userEvent.click(screen.getByRole("button", { name: /new request/i }));
      expect(
        screen.queryByText(/start time must be in the future/i)
      ).not.toBeInTheDocument();
    });

    it("clears the date input when the modal is closed and reopened", async () => {
      successfulLoad([ACCOUNT_1]);
      render(<RequestAccessPage />);
      await waitFor(() => screen.getByRole("button", { name: /new request/i }));

      await userEvent.click(screen.getByRole("button", { name: /new request/i }));
      createWrapper().findAllDatePickers()[0].setInputValue("2027/01/01");
      expect(createWrapper().findAllDatePickers()[0].getInputValue()).toBe("2027/01/01");

      const dialog = screen.getByRole("dialog", { name: /new access request/i });
      await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await userEvent.click(screen.getByRole("button", { name: /new request/i }));

      expect(createWrapper().findAllDatePickers()[0].getInputValue()).toBe("");
    });
  });
});
