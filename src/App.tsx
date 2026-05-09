import { useAuthenticator } from "@aws-amplify/ui-react";
import { Route, Routes, useNavigate, useLocation } from "react-router";

import AppLayout from "@cloudscape-design/components/app-layout";
import SideNavigation, { SideNavigationProps } from "@cloudscape-design/components/side-navigation";
import TopNavigation from "@cloudscape-design/components/top-navigation";

import { AdminGuard } from "./components/AdminGuard";
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
  // With HashRouter, the routed path lives in `pathname`, not in `hash`
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

  return (
    <>
      <TopNavigation
        identity={{ href: "#", title: "Snitch" }}
        utilities={[
          {
            type: "button",
            text: user?.signInDetails?.loginId ?? "User",
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
        toolsHide
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
    </>
  );
}

export default App;
