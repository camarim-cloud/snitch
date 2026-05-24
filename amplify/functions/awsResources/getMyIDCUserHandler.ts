import { getMyIDCUser } from "./helpers";

type AppSyncIdentity = {
  username: string;
  claims: Record<string, unknown>;
};

type AppSyncEvent = {
  identity: AppSyncIdentity;
};

// AppSync forwards the access token, not the ID token. The access token never
// contains the email claim. For SAML-federated users Cognito formats the
// username as "<providerName>_<samlNameId>", where our provider is "IDC" and
// the NameID is the user's email — so we strip the "idc_" prefix to recover it.
const IDC_USERNAME_PREFIX = "idc_";

function emailFromIdentity(event: AppSyncEvent): string | undefined {
  const emailClaim = event.identity.claims["email"] as string | undefined;
  if (emailClaim) return emailClaim;
  const { username } = event.identity;
  return username.startsWith(IDC_USERNAME_PREFIX)
    ? username.slice(IDC_USERNAME_PREFIX.length)
    : undefined;
}

/**
 * AppSync resolver: finds the caller's IDC user record by their email.
 *
 * Example AppSync call: query { getMyIDCUser { id userName displayName email } }
 */
export const handler = async (event: AppSyncEvent) => {
  const email = emailFromIdentity(event);

  if (!email) {
    throw new Error(
      `Could not resolve email from identity. username=${event.identity.username}`
    );
  }

  const match = await getMyIDCUser(email);

  console.log(JSON.stringify({
    msg: "getMyIDCUser result",
    email,
    matched: match !== null,
    matchedId: match?.id ?? null,
  }));

  return match;
};
