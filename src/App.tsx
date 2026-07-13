import { useState, useCallback, useEffect } from "react";
import { useAuthenticator } from "@aws-amplify/ui-react";
import { signOut as amplifySignOut } from "aws-amplify/auth";
import { Route, Routes, useNavigate, useLocation } from "react-router";

import AppLayout from "@cloudscape-design/components/app-layout";
import SideNavigation, { SideNavigationProps } from "@cloudscape-design/components/side-navigation";
import TopNavigation from "@cloudscape-design/components/top-navigation";

import { AdminGuard } from "./components/AdminGuard";
import { GroupGuard } from "./components/GroupGuard";
import { HelpPanelContext } from "./components/HelpPanelContext";
import { ApprovalHistoryPage } from "./pages/ApprovalHistoryPage";
import { ApprovalPolicyPage } from "./pages/ApprovalPolicyPage";
import { ApproveRequestsPage } from "./pages/ApproveRequestsPage";
import { ElevatedAccessPage } from "./pages/ElevatedAccessPage";
import { PrivilegedPoliciesPage } from "./pages/PrivilegedPoliciesPage";
import { RequestAccessPage } from "./pages/RequestAccessPage";
import { SessionActivityPage } from "./pages/SessionActivityPage";
import { SettingsPage } from "./pages/SettingsPage";

const NAV_ITEMS: SideNavigationProps.Item[] = [
  { type: "link", text: "Request Access", href: "#/" },
  { type: "link", text: "Approve Requests", href: "#/approve-requests" },
  {
    type: "section",
    text: "Administration",
    defaultExpanded: true,
    items: [
      { type: "link", text: "Privileged Policies", href: "#/privileged-policies" },
      { type: "link", text: "Approval Policies", href: "#/approval-policies" },
      { type: "link", text: "Elevated Access", href: "#/elevated-access" },
      { type: "link", text: "Settings", href: "#/settings" },
    ],
  },
  {
    type: "section",
    text: "Auditor",
    defaultExpanded: true,
    items: [
      { type: "link", text: "Approval History", href: "#/approval-history" },
      { type: "link", text: "Session Activity", href: "#/session-activity" },
    ],
  },
];

function AppNav() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const activeHref = `#${pathname}`;

  return (
    <SideNavigation
      activeHref={activeHref}
      header={{ text: "Snitch", href: "#/" }}
      items={NAV_ITEMS}
      onFollow={(e) => {
        e.preventDefault();
        navigate(e.detail.href.replace(/^#/, ""));
      }}
    />
  );
}

function displayName(username: string | undefined): string {
  if (!username) return "User";
  // Cognito formats federated SAML usernames as "<provider>_<externalId>".
  // Strip the "idc_" prefix so users see their email, not the internal format.
  const idx = username.indexOf("_");
  return idx !== -1 ? username.slice(idx + 1) : username;
}

function App() {
  const { user } = useAuthenticator();
  const { pathname } = useLocation();
  const [toolsContent, setToolsContent] = useState<React.ReactNode>(null);
  const [toolsOpen, setToolsOpen] = useState(false);

  // Clear the help panel whenever the user navigates to a different page so the
  // tools toggle icon doesn't persist across routes.
  useEffect(() => {
    setToolsContent(null);
    setToolsOpen(false);
  }, [pathname]);

  const openHelpPanel = useCallback((content: React.ReactNode) => {
    setToolsContent(content);
    setToolsOpen(true);
  }, []);

  const closeHelpPanel = useCallback(() => {
    setToolsOpen(false);
  }, []);

  return (
    <HelpPanelContext.Provider value={{ openHelpPanel, closeHelpPanel }}>
      <TopNavigation
        identity={{ href: "#", title: "Snitch" }}
        utilities={[
          {
            type: "button",
            text: displayName(user?.username),
            iconName: "user-profile",
          },
          {
            type: "button",
            text: "Sign out",
            onClick: () => amplifySignOut(),
          },
        ]}
      />
      <AppLayout
        navigation={<AppNav />}
        tools={toolsContent ?? <></>}
        toolsOpen={toolsOpen}
        toolsHide={toolsContent === null}
        onToolsChange={({ detail }) => setToolsOpen(detail.open)}
        content={
          <Routes>
            <Route path="/" element={<RequestAccessPage />} />
            <Route path="/approve-requests" element={<ApproveRequestsPage />} />
            <Route
              path="/privileged-policies"
              element={
                <AdminGuard>
                  <PrivilegedPoliciesPage />
                </AdminGuard>
              }
            />
            <Route
              path="/approval-policies"
              element={
                <AdminGuard>
                  <ApprovalPolicyPage />
                </AdminGuard>
              }
            />
            <Route
              path="/elevated-access"
              element={
                <AdminGuard>
                  <ElevatedAccessPage />
                </AdminGuard>
              }
            />
            <Route
              path="/settings"
              element={
                <AdminGuard>
                  <SettingsPage />
                </AdminGuard>
              }
            />
            <Route
              path="/approval-history"
              element={
                <GroupGuard group="Auditors">
                  <ApprovalHistoryPage />
                </GroupGuard>
              }
            />
            <Route
              path="/session-activity"
              element={
                <GroupGuard group="Auditors">
                  <SessionActivityPage />
                </GroupGuard>
              }
            />
          </Routes>
        }
      />
    </HelpPanelContext.Provider>
  );
}

export default App;
