import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router";
import { Amplify } from "aws-amplify";
import { getCurrentUser, signInWithRedirect } from "aws-amplify/auth";
import { Hub } from "aws-amplify/utils";
import { Authenticator } from "@aws-amplify/ui-react";
import Spinner from "@cloudscape-design/components/spinner";
import Box from "@cloudscape-design/components/box";
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

  useEffect(() => {
    // Register the Hub listener synchronously first so we cannot miss the
    // signedIn event that fires when Amplify completes the OAuth code exchange.
    const unsubscribe = Hub.listen("auth", ({ payload }) => {
      if (payload.event === "signedIn") setReady(true);
    });

    const params = new URLSearchParams(window.location.search);
    if (!params.has("code")) {
      // No OAuth callback in progress — check for an existing session or start login.
      // signInWithRedirect() without a provider goes to Cognito's hosted UI (which
      // shows the "Sign in with IDC" button). Amplify stores PKCE state so the
      // code exchange works when Cognito redirects back with ?code=.
      getCurrentUser()
        .then(() => setReady(true))
        .catch(() => signInWithRedirect());
    }
    // If ?code= is present Amplify is already exchanging it; Hub signedIn will fire.

    return unsubscribe;
  }, []);

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
