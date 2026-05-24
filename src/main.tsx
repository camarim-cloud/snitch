import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router";
import { Amplify } from "aws-amplify";
import { getCurrentUser, signInWithRedirect } from "aws-amplify/auth";
import { Hub } from "aws-amplify/utils";
import { Authenticator } from "@aws-amplify/ui-react";
import Spinner from "@cloudscape-design/components/spinner";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import "@cloudscape-design/global-styles/index.css";
import App from "./App";
import outputs from "../amplify_outputs.json";

type ExtendedOutputs = typeof outputs & { custom?: Record<string, string> };
const extended = outputs as ExtendedOutputs;
const oauthDomain = extended.custom?.cognitoOAuthDomain ?? "";
const callbackUrl = extended.custom?.cognitoCallbackUrl ?? "http://localhost:5173";

Amplify.configure({
  ...outputs,
  auth: {
    ...outputs.auth,
    oauth: {
      domain: oauthDomain,
      scopes: ["openid", "email", "profile"],
      redirect_sign_in_uri: [callbackUrl, "http://localhost:5173"],
      redirect_sign_out_uri: [callbackUrl, "http://localhost:5173"],
      response_type: "code",
      identity_providers: ["SAML"],
    },
  },
} as Parameters<typeof Amplify.configure>[0]);

function AuthRedirect({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    // When Cognito redirects back with ?code=&state=, Amplify is already processing
    // the token exchange. Calling getCurrentUser() here would fail (exchange not done
    // yet) and the catch would trigger another signInWithRedirect, causing an infinite
    // loop. Skip the check and let the Hub signedIn event resolve it instead.
    const params = new URLSearchParams(window.location.search);
    if (!params.has("code")) {
      getCurrentUser()
        .then(() => setReady(true))
        .catch(() => signInWithRedirect({ provider: { custom: "IDC" } }));
    }

    const unsubscribe = Hub.listen("auth", ({ payload }) => {
      if (payload.event === "signedIn") {
        setReady(true);
      } else if (payload.event === "signInWithRedirect_failure") {
        // Strip the stale ?code=&state= from the URL so a manual refresh doesn't
        // re-attempt the dead exchange.
        window.history.replaceState({}, document.title, window.location.pathname);
        const error = (payload.data as { error?: Error } | undefined)?.error;
        const msg = error?.message ?? "Unknown OAuth error";
        // Log with full detail so the Network-tab 400 response can be correlated.
        console.error("[auth] signInWithRedirect_failure:", msg, error);
        setAuthError(msg);
      }
    });
    return unsubscribe;
  }, []);

  if (authError) {
    return (
      <Box padding="xl" textAlign="center">
        <Box variant="p" color="text-status-error" margin={{ bottom: "s" }}>
          Authentication failed: {authError}
        </Box>
        <Box variant="p" color="text-body-secondary" margin={{ bottom: "m" }}>
          Open DevTools → Network and look for the POST to{" "}
          <code>/oauth2/token</code> to see Cognito&apos;s error response.
        </Box>
        <Button
          variant="primary"
          onClick={() => {
            setAuthError(null);
            signInWithRedirect({ provider: { custom: "IDC" } });
          }}
        >
          Try again
        </Button>
      </Box>
    );
  }

  if (!ready) {
    return (
      <Box padding="l" textAlign="center">
        <Spinner size="large" />
      </Box>
    );
  }

  return <>{children}</>;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <HashRouter>
      <Authenticator.Provider>
        <AuthRedirect>
          <App />
        </AuthRedirect>
      </Authenticator.Provider>
    </HashRouter>
  </React.StrictMode>
);
