---
title: IAM Identity Center Setup
layout: default
nav_order: 3
---

# IAM Identity Center Setup
{: .no_toc }

Snitch authenticates users through **IAM Identity Center (IDC)** via SAML 2.0 federation. IDC acts as the identity provider (IdP); Amazon Cognito acts as the service provider (SP) and continues to issue tokens consumed by AppSync and the frontend. This page walks through all AWS console and CLI steps required before the first `npm run sandbox` deployment.

## Table of Contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Architecture Overview

```
User → App (unauthenticated)
     → signInWithRedirect() [Amplify, no provider] → Cognito Managed Login page
     → User clicks "Sign in with IDC"
     → Cognito redirects to IDC SAML endpoint
     → User authenticates in IDC
     → IDC issues SAML assertion → Cognito validates
     → Cognito runs pre-token generation Lambda:
         1. Looks up the IDC user by email in IdentityStore
         2. Fetches the user's IDC group memberships
         3. Injects group names + "Admins" (if admin group matches) into cognito:groups
     → Cognito issues tokens → App authenticated (Hub signedIn event fires)

User → clicks "Sign out" in the app
     → amplifySignOut() → Cognito logout endpoint
     → Cognito clears session → redirects back to app
     → App calls signInWithRedirect() → Cognito Managed Login page shown again
```

CDK reads synth-time values from environment variables only.

- **At synth time** (`amplify/backend.ts` and `amplify/cognitoAuth.ts`, via `amplify/synthEnv.ts`): `IDC_SAML_METADATA_URL`, `IDC_IDENTITY_STORE_ID`, and `ADMIN_GROUP_ID` are required environment variables; `AUDITOR_GROUP_ID` is optional (unset ⇒ no user receives the `Auditors` claim). `COGNITO_DOMAIN_PREFIX` and `APP_CALLBACK_URL` are optional in an Amplify Hosting build — they auto-derive from the reserved `AWS_APP_ID` / `AWS_BRANCH` build variables (`snitch-<branch>-<app-id>` and `https://<branch>.<app-id>.amplifyapp.com`). A local sandbox has no `AWS_APP_ID`, so `COGNITO_DOMAIN_PREFIX` is required there (without a domain prefix the Cognito login endpoint has no value); `APP_CALLBACK_URL` falls back to `http://localhost:5173`. Define them directly in Amplify Hosting under Build settings → Environment variables for hosted deployments, or export them in your shell before running `npm run sandbox` for local sandbox work.
- `IDC_SAML_METADATA_URL` is a plain synth-time environment variable — the IDC SAML metadata URL is public information, not a secret. (It was previously read from AWS Secrets Manager `snitch/auth-config`; that secret is no longer used.)

### Managed Login Page

Cognito's managed login page (`managedLoginVersion: 2`) serves as both the sign-in page and the post-logout landing page. CDK provisions it with `CfnManagedLoginBranding` using `useCognitoProvidedValues: true`, which applies Cognito's built-in default style without requiring custom assets. The frontend uses `signInWithRedirect()` without a provider argument so that Amplify stores PKCE state before the redirect — this is required for the OAuth code exchange to succeed when Cognito redirects back with `?code=`.

---

## Step 1 — Choose a Cognito Domain Prefix

Pick a globally unique prefix for the Cognito Hosted UI domain. This value is the `COGNITO_DOMAIN_PREFIX` environment variable — optional in an Amplify Hosting build (it auto-derives as `snitch-<branch>-<app-id>`), and required for a local sandbox.

```
https://<COGNITO_DOMAIN_PREFIX>.auth.<REGION>.amazoncognito.com
```

The SAML **Assertion Consumer Service (ACS) URL** — needed when registering the IDC application — is derived from this prefix:

```
https://<COGNITO_DOMAIN_PREFIX>.auth.<REGION>.amazoncognito.com/saml2/idpresponse
```

Example with prefix `snitch-auth` in `us-east-1`:

```
https://snitch-auth.auth.us-east-1.amazoncognito.com/saml2/idpresponse
```

{: .note }
The User Pool ID is not known before the first deploy, so use a placeholder Audience URI in Step 2. You will update it in [Step 5](#step-5--update-the-audience-uri-post-deploy).

---

## Step 2 — Register a SAML 2.0 Application in IAM Identity Center

1. Open the **IAM Identity Center** console and navigate to **Applications → Add application → I have an application I want to set up**.
2. Select **SAML 2.0** as the application type.
3. Give the application a name (e.g., `Snitch`).
4. Under **Application metadata**, configure:

   | Field | Value |
   |---|---|
   | **Application ACS URL** | `https://<COGNITO_DOMAIN_PREFIX>.auth.<REGION>.amazoncognito.com/saml2/idpresponse` |
   | **Application SAML audience** | `urn:amazon:cognito:sp:placeholder` (update after first deploy — see Step 5) |

5. Under **Attribute mappings**, add the following mapping so Cognito receives the user's email:

   | User attribute in the application | Maps to this string value or user attribute in IAM Identity Center |
   |---|---|
   | `email` | `${user:email}` |

   {: .important }
   The `email` attribute mapping is required. The pre-token generation Lambda uses the email to look up the user in IdentityStore and resolve group memberships.

6. Save the application.
7. On the application detail page, copy the **SAML metadata URL** — it has the form:
   ```
   https://<idc-instance>.awsapps.com/start/saml/metadata/<app-id>
   ```
   Set this as the `IDC_SAML_METADATA_URL` environment variable.

8. **Assign users or groups** to the application so they can authenticate.

---

## Step 3 — Get the Identity Store ID

1. In the **IAM Identity Center** console, navigate to **Settings**.
2. Under **Identity source**, copy the **Identity Store ID** (format: `d-xxxxxxxxxxxx`).

Set this as the `IDC_IDENTITY_STORE_ID` environment variable.

---

## Step 4 — Set the Environment Variables

Snitch reads all of its configuration from plain environment variables at CDK synth time — **no AWS Secrets Manager secret is required**. The IDC SAML metadata URL is public information, so it is just another environment variable.

For hosted deployments, define these under **Amplify Hosting → App settings → Environment variables**. For local sandbox runs, export them in your shell — the `scripts/set-sandbox-env.sh` convenience script does this (edit its values, then **source** it):

```bash
export IDC_SAML_METADATA_URL="https://<idc-instance>.awsapps.com/start/saml/metadata/<app-id>"
export IDC_IDENTITY_STORE_ID="d-xxxxxxxxxxxx"
export ADMIN_GROUP_ID="<idc-admin-group-id>"        # immutable IDC GroupId (a UUID)
export AUDITOR_GROUP_ID="<idc-auditor-group-id>"    # optional
export COGNITO_DOMAIN_PREFIX="snitch-auth"          # required for a local sandbox; optional in Amplify Hosting
export APP_CALLBACK_URL="http://localhost:5173"     # optional; auto-derives in Amplify Hosting
```

| Variable | Required | Description |
|---|---|---|
| `IDC_SAML_METADATA_URL` | Yes | SAML metadata URL copied from the IDC application in Step 2 (public, not a secret) |
| `IDC_IDENTITY_STORE_ID` | Yes | Identity Store ID copied in Step 3 |
| `ADMIN_GROUP_ID` | Yes | Immutable IDC **GroupId** (a UUID) whose members receive the Cognito `Admins` claim. Find it with: `aws identitystore list-groups --identity-store-id <d-xxxx> --query "Groups[?DisplayName=='<name>'].GroupId" --output text` |
| `AUDITOR_GROUP_ID` | No | IDC GroupId whose members receive the read-only `Auditors` claim (Approval History + Session Activity). Unset ⇒ no user receives it. |
| `COGNITO_DOMAIN_PREFIX` | Sandbox only | The unique Cognito domain prefix from Step 1. In an Amplify Hosting build it auto-derives as `snitch-<branch>-<app-id>`; required for a local sandbox. |
| `APP_CALLBACK_URL` | No | The deployed frontend URL. In an Amplify Hosting build it auto-derives as `https://<branch>.<app-id>.amplifyapp.com`; defaults to `http://localhost:5173` for a local sandbox. |

{: .note }
`ADMIN_GROUP_ID` / `AUDITOR_GROUP_ID` are the immutable IDC **GroupIds**, not display names — so renaming an IDC group never breaks admin or auditor access. The pre-token generation Lambda injects the matching `Admins` / `Auditors` claim into `cognito:groups` at token issue time.

---

## Step 5 — Deploy and Update the Audience URI

Run the sandbox deployment:

```bash
npm run sandbox
```

After deployment succeeds, `amplify_outputs.json` is updated with all resource IDs.

Find the **Cognito User Pool ID** from the outputs (format: `<REGION>_XXXXXXXXX`). Then update the SAML application in IDC:

1. Open the IDC application registered in Step 2.
2. Edit **Application metadata**.
3. Update the **Application SAML audience** from `urn:amazon:cognito:sp:placeholder` to:
   ```
   urn:amazon:cognito:sp:<USER_POOL_ID>
   ```
   Example: `urn:amazon:cognito:sp:us-east-1_Ab1Cd2Ef3`
4. Save.

{: .important }
Until this is updated, authentication will fail with a SAML audience mismatch error. This step is required after every deployment to a new environment (sandbox, staging, production) where a fresh User Pool is created.

---

## Verification

After updating the Audience URI:

1. Open the app — it should redirect to the Cognito managed login page showing a **"Sign in with IDC"** button.
2. Click **"Sign in with IDC"** and authenticate with an IDC user assigned to the application.
3. After successful login, the top navigation should display the user's email (without the `idc_` prefix).
4. Click **"Sign out"** — the browser should return to the Cognito managed login page, not re-authenticate automatically.
5. For a user in the IDC group identified by `ADMIN_GROUP_ID`: navigate to **Privileged Policies** — the page loads.
6. For a user NOT in that group: the same route shows **Access denied**.
7. For a user in the IDC group identified by `AUDITOR_GROUP_ID`: navigate to **Approval History** / **Session Activity** — the pages load.
8. For a user NOT in that group: the same routes show **Access denied**.

---

## Updating the Configuration

To change any value (e.g., a different admin group or callback URL), update the environment variable — in your shell / `scripts/set-sandbox-env.sh` for a sandbox, or in Amplify Hosting → App settings → Environment variables for a hosted deployment — and redeploy:

```bash
export ADMIN_GROUP_ID="<new-idc-group-id>"
source scripts/set-sandbox-env.sh
npm run sandbox
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Synthesis fails with `Environment variable ... is required for synth-time Cognito config.` | A required synth-time env var is unset | Set `IDC_SAML_METADATA_URL`, `IDC_IDENTITY_STORE_ID`, `ADMIN_GROUP_ID` (and `COGNITO_DOMAIN_PREFIX` for a local sandbox) before deploying (Step 4) |
| SAML login fails with `Audience URI mismatch` | Placeholder Audience URI still set | Update IDC app Audience URI to `urn:amazon:cognito:sp:<USER_POOL_ID>` (Step 5) |
| Login redirects to IDC but fails with `User not assigned` | IDC user or group not assigned to the application | Assign the user or their group to the IDC SAML application (Step 2, step 8) |
| Admin pages show **Access denied** for an IDC admin | `ADMIN_GROUP_ID` doesn't match the user's IDC group GroupId | Verify the group's GroupId in IDC and set `ADMIN_GROUP_ID` to match, then redeploy |
| Auditor pages show **Access denied** for an IDC auditor | `AUDITOR_GROUP_ID` doesn't match the group's GroupId, or the user hasn't re-authenticated since being added | Verify the group's GroupId in IDC (set `AUDITOR_GROUP_ID` to match), then sign out and back in to mint a fresh token |
| `getMyIDCUser` returns `null` after login | IDC `UserName` attribute doesn't match the user's email | Verify the IDC attribute mapping in Step 2 maps `email` to `${user:email}` |
| Admin/Auditor claim missing right after adding a user to the IDC group | The user's token predates the group change | Sign out and back in — `preTokenGenerationHandler` mints the `Admins`/`Auditors` claim from `ADMIN_GROUP_ID`/`AUDITOR_GROUP_ID` at token issue time |
| Admin pages show **Access denied** after login even for admin users | Pre-token generation Lambda didn't inject IDC groups (e.g., `IDC_IDENTITY_STORE_ID` env var was empty on first deploy) | Run `npm run sandbox` to redeploy the Lambda with the correct env vars, then sign out and back in to get a fresh token |
| Managed login page shows **"Login pages unavailable"** | `CfnManagedLoginBranding` resource not yet deployed, or `managedLoginVersion: 2` not set on the domain | Run `npm run sandbox` — CDK provisions both the domain and the branding resource automatically |
| App stays on spinner forever after Cognito redirects back with `?code=` | PKCE state was not stored (e.g., previous code used `window.location.href` directly to Cognito, bypassing Amplify) | Ensure `signInWithRedirect()` is always called to initiate the flow — never redirect to the Cognito login URL directly |
| After sign-out, the app immediately re-authenticates instead of showing the login page | `amplifySignOut()` was not called (e.g., a raw `window.location.href` sign-out that skipped Cognito's logout endpoint) | The sign-out button must call `amplifySignOut()` so Cognito's session cookie is cleared before Cognito redirects back |
