#!/usr/bin/env bash
#
# set-sandbox-env.sh — populate the synth-time environment variables required to
# deploy the Snitch Amplify Gen 2 sandbox (`npm run sandbox` → `npx ampx sandbox`).
#
# These five variables are read at CDK synthesis time in amplify/backend.ts and
# amplify/cognitoAuth.ts. Without them the sandbox deploy throws:
#   "Environment variable <NAME> is required for synth-time Cognito config."
#
# The SAML metadata URL is NOT set here — it is read from AWS Secrets Manager
# (`snitch/auth-config`, jsonField IDC_SAML_METADATA_URL) at synth time.
#
# Usage:
#   1. Edit the values below to match your AWS environment.
#   2. Source this script so the exports land in your current shell:
#        source scripts/set-sandbox-env.sh
#   3. Deploy:
#        npm run sandbox
#
# Sourcing (not executing) is required — a subshell's exports would not persist.

# --- Required: edit these for your environment -------------------------------

# Globally-unique prefix for the Cognito managed-login domain
# (becomes "<prefix>.auth.<region>.amazoncognito.com").
export COGNITO_DOMAIN_PREFIX="${COGNITO_DOMAIN_PREFIX:-snitch-auth}"

# IAM Identity Center identity store id (format: d-xxxxxxxxxx).
# Find it: AWS Console → IAM Identity Center → Settings, or
#   aws sso-admin list-instances --query 'Instances[0].IdentityStoreId' --output text
export IDC_IDENTITY_STORE_ID="${IDC_IDENTITY_STORE_ID:-d-90676116fd}"

# Display name of the IDC group whose members receive the Cognito "Admins" claim
# (gates admin-only pages).
export ADMIN_GROUP_NAME="${ADMIN_GROUP_NAME:-AWSTeamAdmins}"

# Display name of the IDC group whose members receive the Cognito "Auditors" claim
# (gates the read-only Auditor pages: Approval History + Session Activity).
export AUDITOR_GROUP_NAME="${AUDITOR_GROUP_NAME:-AWSTeamAuditors}"

# --- Optional: has a sensible default ----------------------------------------

# OAuth callback/logout URL registered on the user pool client.
# Defaults to the local Vite dev server; override for a hosted deployment.
export APP_CALLBACK_URL="${APP_CALLBACK_URL:-http://localhost:5173}"

# --- Validation --------------------------------------------------------------

_snitch_missing=()
[ -z "${COGNITO_DOMAIN_PREFIX}" ] && _snitch_missing+=("COGNITO_DOMAIN_PREFIX")
[ -z "${IDC_IDENTITY_STORE_ID}" ] && _snitch_missing+=("IDC_IDENTITY_STORE_ID")
[ -z "${ADMIN_GROUP_NAME}" ] && _snitch_missing+=("ADMIN_GROUP_NAME")
[ -z "${AUDITOR_GROUP_NAME}" ] && _snitch_missing+=("AUDITOR_GROUP_NAME")
[ -z "${APP_CALLBACK_URL}" ] && _snitch_missing+=("APP_CALLBACK_URL")

if [ "${#_snitch_missing[@]}" -ne 0 ]; then
  echo "ERROR: missing required env var(s): ${_snitch_missing[*]}" >&2
  unset _snitch_missing
  return 1 2>/dev/null || exit 1
fi
unset _snitch_missing

# Warn if the placeholder identity store id is still in place.
if [ "${IDC_IDENTITY_STORE_ID}" = "d-0000000000" ]; then
  echo "WARNING: IDC_IDENTITY_STORE_ID is still the placeholder 'd-0000000000' — edit it before deploying." >&2
fi

echo "Snitch sandbox env vars set:"
echo "  COGNITO_DOMAIN_PREFIX = ${COGNITO_DOMAIN_PREFIX}"
echo "  IDC_IDENTITY_STORE_ID = ${IDC_IDENTITY_STORE_ID}"
echo "  ADMIN_GROUP_NAME      = ${ADMIN_GROUP_NAME}"
echo "  AUDITOR_GROUP_NAME    = ${AUDITOR_GROUP_NAME}"
echo "  APP_CALLBACK_URL      = ${APP_CALLBACK_URL}"
echo
echo "Next: npm run sandbox"
