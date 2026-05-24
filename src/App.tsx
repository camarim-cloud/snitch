import { useState, useCallback, useEffect } from "react";
import { useAuthenticator } from "@aws-amplify/ui-react";
import { Route, Routes, useNavigate, useLocation } from "react-router";

import AppLayout from "@cloudscape-design/components/app-layout";
import SideNavigation, { SideNavigationProps } from "@cloudscape-design/components/side-navigation";
import TopNavigation from "@cloudscape-design/components/top-navigation";

import { AdminGuard } from "./components/AdminGuard";
import { HelpPanelContext } from "./components/HelpPanelContext";
import { ApprovalPolicyPage } from "./pages/ApprovalPolicyPage";
import { ApproveRequestsPage } from "./pages/ApproveRequestsPage";
import { ElevatedAccessPage } from "./pages/ElevatedAccessPage";
import { PrivilegedPoliciesPage } from "./pages/PrivilegedPoliciesPage";
import { RequestAccessPage } from "./pages/RequestAccessPage";
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

function App() {
  const { user, signOut } = useAuthenticator();
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
            text: user?.username ?? "User",
            iconName: "user-profile",
          },
          {
            type: "button",
            text: "Sign out",
            onClick: signOut,
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
          </Routes>
        }
      />
    </HelpPanelContext.Provider>
  );
}

export default App;
