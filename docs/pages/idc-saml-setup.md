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

- **At synth time** (`amplify/backend.ts` and `amplify/cognitoAuth.ts`): `COGNITO_DOMAIN_PREFIX`, `APP_CALLBACK_URL`, `IDC_IDENTITY_STORE_ID`, and `ADMIN_GROUP_NAME` are required environment variables and must be defined before running `npm run sandbox`.
- **At deploy time via CloudFormation dynamic reference**: `IDC_SAML_METADATA_URL` is referenced as `{{resolve:secretsmanager:snitch/auth-config:SecretString:IDC_SAML_METADATA_URL}}` in the SAML identity provider resource property, where CloudFormation supports this expansion.

### Managed Login Page

Cognito's managed login page (`managedLoginVersion: 2`) serves as both the sign-in page and the post-logout landing page. CDK provisions it with `CfnManagedLoginBranding` using `useCognitoProvidedValues: true`, which applies Cognito's built-in default style without requiring custom assets. The frontend uses `signInWithRedirect()` without a provider argument so that Amplify stores PKCE state before the redirect — this is required for the OAuth code exchange to succeed when Cognito redirects back with `?code=`.

---

## Step 1 — Choose a Cognito Domain Prefix

Pick a globally unique prefix for the Cognito Hosted UI domain. This value will be stored in the secret as `COGNITO_DOMAIN_PREFIX`.

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
   This goes into the secret as `IDC_SAML_METADATA_URL`.

8. **Assign users or groups** to the application so they can authenticate.

---

## Step 3 — Get the Identity Store ID

1. In the **IAM Identity Center** console, navigate to **Settings**.
2. Under **Identity source**, copy the **Identity Store ID** (format: `d-xxxxxxxxxxxx`).

This goes into the secret as `IDC_IDENTITY_STORE_ID`.

---

## Step 4 — Create the Secrets Manager Secret

Create a secret at path **`snitch/auth-config`** in the same AWS account and region where you will deploy Snitch.

The secret must contain at least the following JSON field:

```json
{
  "IDC_SAML_METADATA_URL": "https://<idc-instance>.awsapps.com/start/saml/metadata/<app-id>"
}
```

The synth-time values below must be provided through environment variables before running `npm run sandbox`.

```json
{
  "IDC_SAML_METADATA_URL": "https://<idc-instance>.awsapps.com/start/saml/metadata/<app-id>"
}
```

And set these environment variables in your shell:

```bash
export COGNITO_DOMAIN_PREFIX="snitch-auth"
export APP_CALLBACK_URL="http://localhost:5173"
export IDC_IDENTITY_STORE_ID="d-xxxxxxxxxxxx"
export ADMIN_GROUP_NAME="SnitchAdmins"
```

| Field | Description |
|---|---|
| `IDC_SAML_METADATA_URL` | SAML metadata URL copied from the IDC application in Step 2 |
| `IDC_IDENTITY_STORE_ID` | Identity Store ID copied in Step 3 |
| `ADMIN_GROUP_NAME` | Display name of the IDC group whose members should receive the Cognito `Admins` group claim |
| `COGNITO_DOMAIN_PREFIX` | The unique prefix chosen in Step 1. Can be supplied as the `COGNITO_DOMAIN_PREFIX` environment variable instead of in the secret. |
| `APP_CALLBACK_URL` | The production URL of the deployed frontend (e.g. `https://myapp.example.com`). Use `http://localhost:5173` for local sandbox. Can be supplied as the `APP_CALLBACK_URL` environment variable instead of in the secret. |

{: .warning }
The secret path `snitch/auth-config` is hard-coded in the CDK. If `COGNITO_DOMAIN_PREFIX`, `APP_CALLBACK_URL`, `IDC_IDENTITY_STORE_ID`, or `ADMIN_GROUP_NAME` are not supplied via environment variables, they must exist in this secret before running `npm run sandbox`.

### Creating the secret via AWS CLI

```bash
aws secretsmanager create-secret \
  --name snitch/auth-config \
  --region <REGION> \
  --secret-string '{
    "IDC_SAML_METADATA_URL": "https://...",
    "IDC_IDENTITY_STORE_ID": "d-xxxxxxxxxxxx",
    "ADMIN_GROUP_NAME": "SnitchAdmins",
    "COGNITO_DOMAIN_PREFIX": "snitch-auth",
    "APP_CALLBACK_URL": "http://localhost:5173"
  }'
```

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
5. For a user that belongs to the `ADMIN_GROUP_NAME` IDC group: navigate to **Privileged Policies** — the page loads.
6. For a user that does NOT belong to `ADMIN_GROUP_NAME`: the same route shows **Access denied**.

---

## Updating the Configuration

To change any value (e.g., a new admin group name or callback URL), update the secret in Secrets Manager and redeploy:

```bash
aws secretsmanager update-secret \
  --secret-id snitch/auth-config \
  --region <REGION> \
  --secret-string '{ ... updated values ... }'

npm run sandbox
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| CloudFormation fails with `Secrets Manager secret not found` | Secret doesn't exist or is in the wrong region | Create `snitch/auth-config` in the correct region (Step 4) |
| SAML login fails with `Audience URI mismatch` | Placeholder Audience URI still set | Update IDC app Audience URI to `urn:amazon:cognito:sp:<USER_POOL_ID>` (Step 5) |
| Login redirects to IDC but fails with `User not assigned` | IDC user or group not assigned to the application | Assign the user or their group to the IDC SAML application (Step 2, step 8) |
| Admin pages show **Access denied** for an IDC admin | `ADMIN_GROUP_NAME` in the secret doesn't match the IDC group's display name | Verify the exact group display name in IDC and update the secret |
| `getMyIDCUser` returns `null` after login | IDC `UserName` attribute doesn't match the user's email | Verify the IDC attribute mapping in Step 2 maps `email` to `${user:email}` |
| `PreTokenGeneration failed: not authorized to perform secretsmanager:GetSecretValue` | Pre-token Lambda was deployed before the IAM policy or env vars were applied | Run `npm run sandbox` to redeploy — `IDC_IDENTITY_STORE_ID` and `ADMIN_GROUP_NAME` are now embedded at synth time, no IAM permission needed |
| Admin pages show **Access denied** after login even for admin users | Pre-token generation Lambda didn't inject IDC groups (e.g., `IDC_IDENTITY_STORE_ID` env var was empty on first deploy) | Run `npm run sandbox` to redeploy the Lambda with the correct env vars, then sign out and back in to get a fresh token |
| Managed login page shows **"Login pages unavailable"** | `CfnManagedLoginBranding` resource not yet deployed, or `managedLoginVersion: 2` not set on the domain | Run `npm run sandbox` — CDK provisions both the domain and the branding resource automatically |
| App stays on spinner forever after Cognito redirects back with `?code=` | PKCE state was not stored (e.g., previous code used `window.location.href` directly to Cognito, bypassing Amplify) | Ensure `signInWithRedirect()` is always called to initiate the flow — never redirect to the Cognito login URL directly |
| After sign-out, the app immediately re-authenticates instead of showing the login page | `amplifySignOut()` was not called (e.g., a raw `window.location.href` sign-out that skipped Cognito's logout endpoint) | The sign-out button must call `amplifySignOut()` so Cognito's session cookie is cleared before Cognito redirects back |
