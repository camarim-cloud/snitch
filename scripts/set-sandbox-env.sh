#!/usr/bin/env bash
#
# set-sandbox-env.sh — populate the synth-time environment variables required to
# deploy the Snitch Amplify Gen 2 sandbox (`npm run sandbox` → `npx ampx sandbox`).
#
# These variables are read at CDK synthesis time in amplify/backend.ts and
# amplify/cognitoAuth.ts (via amplify/synthEnv.ts). Without the required ones the
# sandbox deploy throws:
#   "Environment variable <NAME> is required for synth-time Cognito config."
#
# The SAML metadata URL is now a plain env var (IDC_SAML_METADATA_URL) set here — it
# is no longer read from AWS Secrets Manager.
#
# In an Amplify Hosting build, COGNITO_DOMAIN_PREFIX and APP_CALLBACK_URL are optional:
# they auto-derive from the reserved AWS_APP_ID / AWS_BRANCH build vars. A local sandbox
# has neither, so COGNITO_DOMAIN_PREFIX is required here (without it the Cognito login
# domain — and thus the OAuth callback — has no value); APP_CALLBACK_URL defaults to the
# local Vite dev server.
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

# Public SAML metadata URL of your IAM Identity Center application (see Step 2 of
# docs/pages/idc-saml-setup.md). Format:
#   https://<idc-instance>.awsapps.com/start/saml/metadata/<app-id>
# Previously stored in AWS Secrets Manager (snitch/auth-config); now a plain env var.
export IDC_SAML_METADATA_URL="${IDC_SAML_METADATA_URL:-https://REPLACE_ME.awsapps.com/start/saml/metadata/REPLACE_ME}"

# GroupId of the IDC group whose members receive the Cognito "Admins" claim (gates admin-only
# pages). Use the immutable GroupId (a UUID), not the display name, so renaming the group can't
# break access. Find it with (read-only):
#   aws identitystore list-groups --identity-store-id "${IDC_IDENTITY_STORE_ID}" \
#     --query "Groups[?DisplayName=='AWSTeamAdmins'].GroupId" --output text
export ADMIN_GROUP_ID="${ADMIN_GROUP_ID:-b498f4d8-3051-70cc-e756-b7be3df59b6c}"

# GroupId of the IDC group whose members receive the Cognito "Auditors" claim (gates the read-only
# Auditor pages: Approval History + Session Activity). Optional — leave empty to grant Auditors to
# no one. Find it the same way as ADMIN_GROUP_ID (filter on your auditor group's DisplayName).
export AUDITOR_GROUP_ID="${AUDITOR_GROUP_ID:-e428d498-f0c1-70a7-7071-b6daba334db3}"

# --- Optional: has a sensible default ----------------------------------------

# OAuth callback/logout URL registered on the user pool client, and the base URL for
# the SNS approval link. Defaults to the local Vite dev server. In an Amplify Hosting
# build it auto-derives as https://<AWS_BRANCH>.<AWS_APP_ID>.amplifyapp.com when unset;
# override here only for a custom hosted domain.
export APP_CALLBACK_URL="${APP_CALLBACK_URL:-http://localhost:5173}"

# --- Validation --------------------------------------------------------------

_snitch_missing=()
[ -z "${COGNITO_DOMAIN_PREFIX}" ] && _snitch_missing+=("COGNITO_DOMAIN_PREFIX")
[ -z "${IDC_IDENTITY_STORE_ID}" ] && _snitch_missing+=("IDC_IDENTITY_STORE_ID")
[ -z "${IDC_SAML_METADATA_URL}" ] && _snitch_missing+=("IDC_SAML_METADATA_URL")
# AUDITOR_GROUP_ID is intentionally optional (empty = no Auditors), so it is not validated here.
[ -z "${ADMIN_GROUP_ID}" ] && _snitch_missing+=("ADMIN_GROUP_ID")
# APP_CALLBACK_URL is optional (defaults to the local Vite dev server), so it is not validated here.

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

# Warn if the placeholder admin GroupId is still in place.
if [ "${ADMIN_GROUP_ID}" = "g-xxxxxxxxxx" ]; then
  echo "WARNING: ADMIN_GROUP_ID is still the placeholder 'g-xxxxxxxxxx' — set it to your IDC admin group's GroupId before deploying." >&2
fi

# Warn if the placeholder SAML metadata URL is still in place.
if [[ "${IDC_SAML_METADATA_URL}" == *REPLACE_ME* ]]; then
  echo "WARNING: IDC_SAML_METADATA_URL still contains 'REPLACE_ME' — set it to your IDC application's SAML metadata URL before deploying." >&2
fi

echo "Snitch sandbox env vars set:"
echo "  COGNITO_DOMAIN_PREFIX = ${COGNITO_DOMAIN_PREFIX}"
echo "  IDC_IDENTITY_STORE_ID = ${IDC_IDENTITY_STORE_ID}"
echo "  IDC_SAML_METADATA_URL = ${IDC_SAML_METADATA_URL}"
echo "  ADMIN_GROUP_ID        = ${ADMIN_GROUP_ID}"
echo "  AUDITOR_GROUP_ID      = ${AUDITOR_GROUP_ID:-(unset — no Auditors)}"
echo "  APP_CALLBACK_URL      = ${APP_CALLBACK_URL}"
echo
echo "Next: npm run sandbox"
