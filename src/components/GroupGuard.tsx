import { useEffect, useState } from "react";
import { fetchAuthSession } from "aws-amplify/auth";

import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Spinner from "@cloudscape-design/components/spinner";

type Props = { group: string; children: React.ReactNode };

/**
 * Route guard that renders its children only when the signed-in user's
 * cognito:groups claim contains `group`. Otherwise shows an access-denied alert.
 * The claim is minted by the pre-token-generation Lambda from IDC group membership.
 *
 * @example
 *   <GroupGuard group="Auditors"><ApprovalHistoryPage /></GroupGuard>
 */
export function GroupGuard({ group, children }: Props) {
  const [status, setStatus] = useState<"loading" | "allowed" | "denied">("loading");

  useEffect(() => {
    fetchAuthSession().then((session) => {
      const groups =
        (session.tokens?.idToken?.payload["cognito:groups"] as string[]) ?? [];
      setStatus(groups.includes(group) ? "allowed" : "denied");
    });
  }, [group]);

  if (status === "loading") {
    return (
      <Box padding="l" textAlign="center">
        <Spinner size="large" />
      </Box>
    );
  }

  if (status === "denied") {
    return (
      <Alert type="error" header="Access denied">
        Only users in the <strong>{group}</strong> Cognito group can access this
        page.
      </Alert>
    );
  }

  return <>{children}</>;
}
