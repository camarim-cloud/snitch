import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const {
  mockListPolicies,
  mockListIDCUsers,
  mockListIDCGroups,
  mockListAWSAccounts,
  mockListOUs,
  mockListPermissionSets,
  mockListCognitoUsers,
  mockListCognitoGroups,
  mockCreatePolicy,
} = vi.hoisted(() => ({
  mockListPolicies: vi.fn(),
  mockListIDCUsers: vi.fn(),
  mockListIDCGroups: vi.fn(),
  mockListAWSAccounts: vi.fn(),
  mockListOUs: vi.fn(),
  mockListPermissionSets: vi.fn(),
  mockListCognitoUsers: vi.fn(),
  mockListCognitoGroups: vi.fn(),
  mockCreatePolicy: vi.fn(),
}));

vi.mock("aws-amplify/data", () => ({
  generateClient: () => ({
    models: {
      PrivilegedPolicy: { list: mockListPolicies },
    },
    queries: {
      listIDCUsers: mockListIDCUsers,
      listIDCGroups: mockListIDCGroups,
      listAWSAccounts: mockListAWSAccounts,
      listOUs: mockListOUs,
      listPermissionSets: mockListPermissionSets,
      listCognitoUsers: mockListCognitoUsers,
      listCognitoGroups: mockListCognitoGroups,
    },
    mutations: {
      createPrivilegedPolicyWithAVP: mockCreatePolicy,
      updatePrivilegedPolicyWithAVP: vi.fn(),
      deletePrivilegedPolicyWithAVP: vi.fn(),
    },
    subscriptions: {
      onPrivilegedPolicyCreated: () => ({ subscribe: () => ({ unsubscribe: vi.fn() }) }),
      onPrivilegedPolicyUpdated: () => ({ subscribe: () => ({ unsubscribe: vi.fn() }) }),
      onPrivilegedPolicyDeleted: () => ({ subscribe: () => ({ unsubscribe: vi.fn() }) }),
    },
  }),
}));

vi.mock("../../amplify_outputs.json", () => ({ default: {} }));

import { PrivilegedPoliciesPage } from "../pages/PrivilegedPoliciesPage";

const IDC_USERS = [
  { id: "user-1", displayName: "Alice", userName: "alice", email: "alice@example.com" },
];
const ACCOUNTS = [
  { id: "111111111111", name: "Dev Account", email: "dev@example.com", status: "ACTIVE" },
  { id: "222222222222", name: "Prod Account", email: "prod@example.com", status: "ACTIVE" },
];
const PERMISSION_SETS = [
  { arn: "arn:aws:sso:::permissionSet/ps-admin", name: "AdminAccess", description: "" },
];

const EXISTING_POLICY = {
  id: "policy-1",
  name: "Dev Access",
  principalType: "USER" as const,
  principalId: "user-1",
  principalDisplayName: "Alice",
  accountIds: ["111111111111"],
  ouIds: [],
  permissionSetArns: ["arn:aws:sso:::permissionSet/ps-read"],
  permissionSetNames: ["ReadOnly"],
  maxDurationMinutes: 60,
  avpPolicyId: "avp-1",
  description: null,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

function setupResourceMocks() {
  mockListIDCUsers.mockResolvedValue({ data: IDC_USERS, errors: undefined });
  mockListIDCGroups.mockResolvedValue({ data: [], errors: undefined });
  mockListAWSAccounts.mockResolvedValue({ data: ACCOUNTS, errors: undefined });
  mockListOUs.mockResolvedValue({ data: [], errors: undefined });
  mockListPermissionSets.mockResolvedValue({ data: PERMISSION_SETS, errors: undefined });
  mockListCognitoUsers.mockResolvedValue({ data: [], errors: undefined });
  mockListCognitoGroups.mockResolvedValue({ data: [], errors: undefined });
}

async function openCreateModal() {
  await userEvent.click(screen.getByRole("button", { name: /create policy/i }));
  // Wait for the spinner to clear and the form to render
  const dialog = await screen.findByRole("dialog", { name: /create policy/i });
  await waitFor(() => within(dialog).getByText("Max Duration"));
  return dialog;
}

describe("PrivilegedPoliciesPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListPolicies.mockResolvedValue({ data: [] });
    setupResourceMocks();
  });

  describe("max duration — default value", () => {
    it("starts empty in the create form (no limit)", async () => {
      render(<PrivilegedPoliciesPage />);
      const dialog = await openCreateModal();
      // The duration number input should be empty — blank means no limit
      const durationInput = within(dialog).getByPlaceholderText(/leave blank for no limit/i) as HTMLInputElement;
      expect(durationInput.value).toBe("");
    });

    it("starts empty when editing a policy that has no max duration set", async () => {
      mockListPolicies.mockResolvedValue({
        data: [{ ...EXISTING_POLICY, maxDurationMinutes: null }],
      });
      render(<PrivilegedPoliciesPage />);

      await waitFor(() => screen.getByText("Dev Access"));

      // Select the row and click Edit
      await userEvent.click(screen.getByRole("radio"));
      await userEvent.click(screen.getByRole("button", { name: /^edit$/i }));

      const dialog = await screen.findByRole("dialog", { name: /edit policy/i });
      await waitFor(() => within(dialog).getByText("Max Duration"));

      const durationInput = within(dialog).getByPlaceholderText(/leave blank for no limit/i) as HTMLInputElement;
      expect(durationInput.value).toBe("");
    });
  });

  describe("max duration — validation", () => {
    it("shows no duration error when the field is blank (blank = no limit)", async () => {
      render(<PrivilegedPoliciesPage />);
      const dialog = await openCreateModal();

      // Submit with the duration field empty — should not produce a duration error
      await userEvent.click(within(dialog).getByRole("button", { name: /^create$/i }));

      expect(within(dialog).queryByText(/maximum duration/i)).not.toBeInTheDocument();
      expect(within(dialog).queryByText(/enter a valid duration/i)).not.toBeInTheDocument();
    });

    it("does not show a validation error for a valid duration value", async () => {
      render(<PrivilegedPoliciesPage />);
      const dialog = await openCreateModal();

      const durationInput = within(dialog).getByPlaceholderText(/leave blank for no limit/i);
      await userEvent.type(durationInput, "8");

      await userEvent.click(within(dialog).getByRole("button", { name: /^create$/i }));

      // Other required fields will fail, but not the duration
      expect(within(dialog).queryByText(/maximum duration/i)).not.toBeInTheDocument();
      expect(within(dialog).queryByText(/enter a valid duration/i)).not.toBeInTheDocument();
    });
  });

  describe("conflict validation", () => {
    it("shows a conflict error when the same principal and account are already covered", async () => {
      mockListPolicies.mockResolvedValue({ data: [EXISTING_POLICY] });
      render(<PrivilegedPoliciesPage />);

      await waitFor(() => screen.getByText("Dev Access"));
      const dialog = await openCreateModal();

      // Name is required and must pass before the conflict check runs
      await userEvent.type(within(dialog).getByPlaceholderText(/enter policy name/i), "New Policy");

      // Select the same user (Alice — principalId: user-1)
      await userEvent.click(within(dialog).getByText("Select a user"));
      await userEvent.click(await screen.findByRole("option", { name: /alice/i }));

      // Select the same account (111111111111)
      await userEvent.click(within(dialog).getByText("Select accounts"));
      await userEvent.click(
        await screen.findByRole("option", { name: /Dev Account.*111111111111/i })
      );

      // Select a permission set (required)
      await userEvent.click(within(dialog).getByText("Select permission sets"));
      await userEvent.click(await screen.findByRole("option", { name: /AdminAccess/i }));

      await userEvent.click(within(dialog).getByRole("button", { name: /^create$/i }));

      expect(
        within(dialog).getAllByText(/"Dev Access" already grants this principal/i).length
      ).toBeGreaterThan(0);
    });

    it("does not show a conflict error when the same principal uses a different account", async () => {
      mockListPolicies.mockResolvedValue({ data: [EXISTING_POLICY] });
      render(<PrivilegedPoliciesPage />);

      await waitFor(() => screen.getByText("Dev Access"));
      const dialog = await openCreateModal();

      // Same user (Alice)
      await userEvent.click(within(dialog).getByText("Select a user"));
      await userEvent.click(await screen.findByRole("option", { name: /alice/i }));

      // Different account (222222222222)
      await userEvent.click(within(dialog).getByText("Select accounts"));
      await userEvent.click(
        await screen.findByRole("option", { name: /Prod Account.*222222222222/i })
      );

      // Select a permission set
      await userEvent.click(within(dialog).getByText("Select permission sets"));
      await userEvent.click(await screen.findByRole("option", { name: /AdminAccess/i }));

      await userEvent.click(within(dialog).getByRole("button", { name: /^create$/i }));

      expect(
        within(dialog).queryByText(/already grants this principal/i)
      ).not.toBeInTheDocument();
    });
  });
});
