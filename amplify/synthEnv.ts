// Single source of truth for synth-time environment resolution. Both backend.ts and
// cognitoAuth.ts import from here so the Cognito domain prefix / callback URL used in the
// amplify_outputs custom block can never diverge from the values applied to the actual
// CfnUserPoolDomain / user pool client (a divergence would break the OAuth exact-match).
//
// Pure leaf module — it imports nothing (no aws-cdk-lib), so Vitest can import it with zero
// cost and no side effects, and every resolver is a deterministic function of its env arg.

/** Read-only view of the environment; satisfied by process.env and plain test records. */
export type SynthEnv = Record<string, string | undefined>;

const COGNITO_DOMAIN_MAX_LENGTH = 63;

/**
 * Read a required synth-time env var, with an optional fallback. Throws a descriptive error
 * when neither is available so a misconfigured deploy fails loudly at synth instead of
 * producing a broken stack.
 *
 * @example requireSynthEnv(process.env, "ADMIN_GROUP_ID")
 */
export function requireSynthEnv(env: SynthEnv, name: string, fallback?: string): string {
  const value = env[name] ?? fallback;
  if (!value) {
    throw new Error(`Environment variable ${name} is required for synth-time Cognito config.`);
  }
  return value;
}

/**
 * Force any candidate into a valid Cognito prefix domain: lowercase [a-z0-9-], no reserved
 * words (aws|amazon|cognito), no leading/trailing hyphen, max 63 chars. See the
 * CreateUserPoolDomain "Domain" pattern + the "Reserved terms" rule. Callers always prefix
 * "snitch-", so the result never collapses to empty.
 *
 * @example sanitizeDomainPrefix("snitch-Dawsxyz") // "snitch-dxyz"
 */
export function sanitizeDomainPrefix(raw: string): string {
  let s = raw.toLowerCase().replace(/[^a-z0-9-]/g, "");
  // Removal can expose a fresh reserved word across the seam (e.g. "aawss" -> "as"), so
  // repeat until stable. .replace (unlike .test) is stateless, so this loop is safe.
  let previous: string;
  do {
    previous = s;
    s = s.replace(/aws|amazon|cognito/g, "");
  } while (s !== previous);
  return s
    .replace(/^-+/, "")
    .slice(0, COGNITO_DOMAIN_MAX_LENGTH)
    .replace(/-+$/, "");
}

/**
 * Resolve the Cognito managed-login domain prefix. Precedence:
 *   1. explicit COGNITO_DOMAIN_PREFIX (operator always wins)
 *   2. snitch-<branch>-<app-id> (sanitized) — stable per Amplify app+branch, so redeploys
 *      never replace CfnUserPoolDomain; app-id is globally unique so the prefix is too
 *   3. throw — outside Amplify Hosting there is no AWS_APP_ID to derive from, so the operator
 *      must set COGNITO_DOMAIN_PREFIX (the sandbox script provides "snitch-auth" by default)
 *
 * @example resolveCognitoDomainPrefix(process.env) // "snitch-main-d1mt6ip3ppwmko"
 */
export function resolveCognitoDomainPrefix(env: SynthEnv): string {
  const explicit = env.COGNITO_DOMAIN_PREFIX?.trim();
  if (explicit) return explicit;
  const appId = env.AWS_APP_ID?.trim();
  const branch = env.AWS_BRANCH?.trim();
  if (appId && branch) return sanitizeDomainPrefix(`snitch-${branch}-${appId}`);
  if (appId) return sanitizeDomainPrefix(`snitch-${appId}`);
  throw new Error(
    "COGNITO_DOMAIN_PREFIX is required outside Amplify Hosting (no AWS_APP_ID to derive a " +
      "stable Cognito domain prefix). Set it (e.g. via scripts/set-sandbox-env.sh) before deploying."
  );
}

/**
 * Resolve the OAuth callback / SNS-link base URL. Precedence:
 *   1. explicit APP_CALLBACK_URL (operator wins)
 *   2. https://<branch>.<app-id>.amplifyapp.com (the Amplify default hosting domain that
 *      serves the CI-built frontend)
 *   3. http://localhost:5173 (local sandbox — the Vite dev server)
 *
 * No trailing slash, matching the previous localhost default; notify.ts appends
 * "#/approve-requests" directly.
 *
 * @example resolveAppCallbackUrl(process.env) // "https://main.d1mt6ip3ppwmko.amplifyapp.com"
 */
export function resolveAppCallbackUrl(env: SynthEnv): string {
  const explicit = env.APP_CALLBACK_URL?.trim();
  if (explicit) return explicit;
  const appId = env.AWS_APP_ID?.trim();
  const branch = env.AWS_BRANCH?.trim();
  if (appId && branch) return `https://${branch}.${appId}.amplifyapp.com`;
  return "http://localhost:5173";
}
