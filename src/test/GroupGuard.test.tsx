import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { mockFetchAuthSession } = vi.hoisted(() => ({
  mockFetchAuthSession: vi.fn(),
}));

vi.mock("aws-amplify/auth", () => ({
  fetchAuthSession: mockFetchAuthSession,
}));

import { GroupGuard } from "../components/GroupGuard";

function sessionWithGroups(groups: string[]) {
  return { tokens: { idToken: { payload: { "cognito:groups": groups } } } };
}

describe("GroupGuard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders children when the cognito:groups claim includes the group", async () => {
    mockFetchAuthSession.mockResolvedValue(sessionWithGroups(["Auditors"]));
    render(
      <GroupGuard group="Auditors">
        <div>auditor-content</div>
      </GroupGuard>
    );
    await waitFor(() =>
      expect(screen.getByText("auditor-content")).toBeInTheDocument()
    );
  });

  it("shows Access denied when the claim lacks the group", async () => {
    mockFetchAuthSession.mockResolvedValue(sessionWithGroups(["Engineering"]));
    render(
      <GroupGuard group="Auditors">
        <div>auditor-content</div>
      </GroupGuard>
    );
    await waitFor(() =>
      expect(screen.getByText(/access denied/i)).toBeInTheDocument()
    );
    expect(screen.queryByText("auditor-content")).not.toBeInTheDocument();
  });

  it("gates the Admins group the same way (AdminGuard delegates here)", async () => {
    mockFetchAuthSession.mockResolvedValue(sessionWithGroups(["Admins"]));
    render(
      <GroupGuard group="Admins">
        <div>admin-content</div>
      </GroupGuard>
    );
    await waitFor(() =>
      expect(screen.getByText("admin-content")).toBeInTheDocument()
    );
  });

  it("denies when there are no groups on the token", async () => {
    mockFetchAuthSession.mockResolvedValue({
      tokens: { idToken: { payload: {} } },
    });
    render(
      <GroupGuard group="Auditors">
        <div>auditor-content</div>
      </GroupGuard>
    );
    await waitFor(() =>
      expect(screen.getByText(/access denied/i)).toBeInTheDocument()
    );
  });

  it("shows neither content nor denial while the session is loading", () => {
    mockFetchAuthSession.mockReturnValue(new Promise(() => {}));
    render(
      <GroupGuard group="Auditors">
        <div>auditor-content</div>
      </GroupGuard>
    );
    expect(screen.queryByText("auditor-content")).not.toBeInTheDocument();
    expect(screen.queryByText(/access denied/i)).not.toBeInTheDocument();
  });
});
