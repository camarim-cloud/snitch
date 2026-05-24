import { defineAuth } from "@aws-amplify/backend";
import { preTokenGenerationFunction } from "../functions/auth/resource";

export const auth = defineAuth({
  loginWith: {
    // email login is technically enabled in Cognito but never exposed in the UI;
    // all authentication is routed through SAML federation via signInWithRedirect
    email: true,
  },
  triggers: {
    preTokenGeneration: preTokenGenerationFunction,
  },
});
