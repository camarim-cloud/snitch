---
title: Sandbox Deployment
layout: default
nav_order: 3
---

# Sandbox Deployment
{: .no_toc }

A **sandbox** runs the full Snitch stack — backend and frontend — locally against your own AWS account. Use it to evaluate Snitch or develop changes before deploying to production with [AWS Amplify Hosting]({% link pages/getting-started.md %}#step-2--deploy-with-aws-amplify-hosting). The backend is personal and hot-reloaded; the frontend runs on your machine.

## Table of Contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Prerequisites

- **Node.js** v18.16.0 or later.
- The **IAM Identity Center application** already registered — see [Getting Started, Step 1]({% link pages/getting-started.md %}#step-1--register-the-iam-identity-center-application). A sandbox reuses that same application; you just supply the values as shell environment variables instead of in the Amplify console.
- The identifiers collected in Getting Started: the SAML metadata URL, Identity Store ID, admin group ID, and (optionally) auditor group ID.

Clone the repository and install dependencies:

```bash
git clone https://github.com/camarim-cloud/snitch.git
cd snitch
npm install
```

---

## How Authentication Works

Snitch federates sign-in through **IAM Identity Center (IDC)** via SAML 2.0. IDC is the identity provider; Amazon Cognito is the service provider that issues the tokens the app and AppSync consume.

```
User → App (unauthenticated)
     → signInWithRedirect() → Cognito managed login page
     → User clicks "Sign in with IDC"
     → Cognito redirects to IDC → user authenticates
     → IDC returns a SAML assertion → Cognito validates it
     → Cognito injects the user's IDC group memberships (plus the
       Admins / Auditors claim when the group matches) into the token
     → Cognito issues tokens → app is authenticated
```

All configuration is supplied through plain environment variables read at build (synth) time. The SAML metadata URL is public information, so it is provided the same way as every other setting.

---

## Set the Environment Variables

The sandbox reads its configuration from your shell. A helper script is provided as a tracked template — copy it to a local, git-ignored file, fill in your values, and **source** it:

```bash
cp scripts/set-sandbox-env.example.sh scripts/set-sandbox-env.sh
# edit scripts/set-sandbox-env.sh with your real values, then:
source scripts/set-sandbox-env.sh
```

{: .warning }
**Source it — do not execute it.** Running `./scripts/set-sandbox-env.sh` starts a subshell whose `export`s vanish when it exits, so the deploy sees none of them. Only `source scripts/set-sandbox-env.sh` (or `. scripts/set-sandbox-env.sh`) sets the variables in the shell you deploy from.

The variables a sandbox needs:

| Variable | Required | Description |
|---|---|---|
| `IDC_SAML_METADATA_URL` | Yes | SAML metadata URL from the IDC application |
| `IDC_IDENTITY_STORE_ID` | Yes | Identity Store ID (`d-xxxxxxxxxxxx`) |
| `ADMIN_GROUP_ID` | Yes | Immutable IDC **GroupId** whose members receive the `Admins` claim |
| `AUDITOR_GROUP_ID` | No | IDC GroupId whose members receive the read-only `Auditors` claim; unset ⇒ no auditors |
| `COGNITO_DOMAIN_PREFIX` | Yes (sandbox) | A globally unique Cognito domain prefix (e.g., `snitch-auth`). Required locally because there is no Amplify app id to derive one from. |
| `APP_CALLBACK_URL` | No | Defaults to `http://localhost:5173` for a sandbox |

{: .note }
Each line in the script uses `export VAR="${VAR:-default}"`, so a value you already exported takes precedence over the in-file default — handy for overriding a single variable without editing the file.

---

## Deploy the Sandbox

```bash
npm run sandbox   # or: npx ampx sandbox
```

This synthesizes the CDK stacks under `amplify/`, deploys them to your AWS account, and writes `amplify_outputs.json` with all endpoint URLs and resource IDs.

{: .note }
The sandbox is hot-reloaded — edits to `amplify/` files redeploy automatically while `npm run sandbox` is running.

If a required variable is missing, synthesis fails with a message such as:

```
[AssemblyError] Environment variable IDC_SAML_METADATA_URL is required for synth-time Cognito config.
```

---

## Run the Frontend

```bash
npm run dev
```

The app starts at [http://localhost:5173](http://localhost:5173).

---

## Update the SAML Audience URI

After the first deploy, take the Cognito **User Pool ID** from `amplify_outputs.json` (format `<REGION>_XXXXXXXXX`) and update the IDC application's **Application SAML audience** to:

```
urn:amazon:cognito:sp:<USER_POOL_ID>
```

{: .important }
Until this matches, sign-in fails with a SAML audience mismatch. This applies to every environment that creates a fresh User Pool (sandbox, staging, production).

To grant admin or auditor access, add users to the corresponding IDC group (the one whose GroupId you set as `ADMIN_GROUP_ID` / `AUDITOR_GROUP_ID`); they sign out and back in to pick up the claim.

---

## Verification

1. Open the app — it redirects to the Cognito managed login page with a **"Sign in with IDC"** button.
2. Sign in as an IDC user assigned to the application; the top navigation shows the user's email.
3. Click **Sign out** — the browser returns to the login page rather than re-authenticating automatically.
4. A user in the `ADMIN_GROUP_ID` group can open **Privileged Policies**; a user outside it sees **Access denied**.
5. A user in the `AUDITOR_GROUP_ID` group can open **Approval History** / **Session Activity**; a user outside it sees **Access denied**.

---

## Updating the Configuration

To change any value, update the environment variable in your shell (or in `scripts/set-sandbox-env.sh`) and redeploy:

```bash
export ADMIN_GROUP_ID="<new-idc-group-id>"
source scripts/set-sandbox-env.sh
npm run sandbox
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Synthesis fails with `Environment variable ... is required for synth-time Cognito config.` | A required variable is unset | Set `IDC_SAML_METADATA_URL`, `IDC_IDENTITY_STORE_ID`, `ADMIN_GROUP_ID`, and `COGNITO_DOMAIN_PREFIX` before deploying |
| SAML login fails with `Audience URI mismatch` | Placeholder audience still set | Update the IDC audience to `urn:amazon:cognito:sp:<USER_POOL_ID>` |
| Login fails with `User not assigned` | IDC user/group not assigned to the application | Assign the user or their group to the IDC SAML application |
| Admin pages show **Access denied** for an admin | `ADMIN_GROUP_ID` doesn't match the user's IDC GroupId, or the user hasn't re-authenticated | Verify the GroupId, then sign out and back in |
| Auditor pages show **Access denied** for an auditor | `AUDITOR_GROUP_ID` doesn't match, or the token predates the group change | Verify the GroupId, then sign out and back in |
| Managed login page shows **"Login pages unavailable"** | Branding not yet deployed | Run `npm run sandbox` — the domain and branding are provisioned automatically |
| App stays on a spinner after Cognito redirects back with `?code=` | Sign-in wasn't initiated through the app | Always start the flow from the app's sign-in button, never by navigating to the Cognito URL directly |
| After sign-out the app re-authenticates immediately | Cognito session cookie not cleared | Use the app's sign-out button so Cognito's logout endpoint runs |
