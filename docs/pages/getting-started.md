---
title: Getting Started
layout: default
nav_order: 2
---

# Getting Started
{: .no_toc }

This guide walks you through deploying Snitch to **production** with AWS Amplify Hosting, then shows how to spin up a **local sandbox** for evaluation or development.

## Table of Contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Prerequisites

Before deploying Snitch, make sure you have:

- An **AWS account** with:
  - **IAM Identity Center (IDC)** enabled
  - **AWS Organizations** configured (so Snitch can discover your accounts and OUs)
  - Permissions to create IDC applications and Amplify apps
- A **GitHub account** with access to the Snitch repository (Amplify Hosting deploys directly from GitHub)

{: .important }
Snitch must be deployed in the **same AWS account and the same AWS Region** where IAM Identity Center is running — it talks to the IDC Identity Store and SSO APIs directly, and these are only reachable from the account/Region that hosts the IDC instance. If IDC has been **delegated to a member account** (that is, administration was moved out of the Organizations management account), deploy Snitch into that **delegated administrator account**, not the management account.

{: .note }
As a best practice, delegate IDC administration to a dedicated member account rather than managing it in the Organizations management account. Keeping IDC (and Snitch) out of the management account limits the blast radius and follows the AWS multi-account guidance for separating workloads from the management account. See [Delegated administration for IAM Identity Center](https://docs.aws.amazon.com/singlesignon/latest/userguide/delegated-admin.html).

{: .note }
Snitch authenticates every user through IAM Identity Center via SAML 2.0. Amazon Cognito sits behind IDC and issues the tokens the app uses — you never manage passwords in Snitch.

{: .note }
The **Session Activity** and **Elevated Access** CloudTrail audit trails read session events from CloudWatch Logs. For those pages to show any events, CloudTrail must be configured to **deliver its logs to a CloudWatch Logs log group** — an S3-only trail is not enough. You supply that log group name later on the **Settings** page (see Step 3d).

---

## Step 1 — Register the IAM Identity Center Application

Snitch needs a SAML 2.0 application in IAM Identity Center so your workforce can sign in. This step registers the application for your **production** deployment. (For a local sandbox, register a **separate** IDC application — see [Deploying a Local Sandbox](#deploying-a-local-sandbox) below.)

### 1a. Choose a Cognito domain prefix

Pick a prefix for the Cognito sign-in domain. It must be **globally unique across all AWS accounts** in the Region, so choose something specific to your organization — a value that is already taken will cause the deploy to fail. It forms the sign-in URL and the SAML **Assertion Consumer Service (ACS) URL** you register in IDC:

```
https://<COGNITO_DOMAIN_PREFIX>.auth.<REGION>.amazoncognito.com/saml2/idpresponse
```

{: .note }
In an Amplify Hosting deployment this prefix is generated automatically as `snitch-<branch>-<app-id>`, so use that form for the ACS URL once you know your Amplify app id (or register a placeholder and update it after the first deploy).

### 1b. Register the SAML 2.0 application

1. Open the **IAM Identity Center** console → **Applications → Add application → I have an application I want to set up**.
2. Choose **SAML 2.0** and give it a name (e.g., `Snitch`).
3. Under **Application metadata**, set:

   | Field | Value |
   |---|---|
   | **Application ACS URL** | `https://<COGNITO_DOMAIN_PREFIX>.auth.<REGION>.amazoncognito.com/saml2/idpresponse` (you'll finalize this after the first deploy in Step 3, once the real domain exists) |
   | **Application SAML audience** | `urn:amazon:cognito:sp:placeholder` (you'll update this after the first deploy in Step 3) |

4. Under **Attribute mappings**, add the email mapping so Cognito receives each user's address:

   | User attribute in the application | Maps to |
   |---|---|
   | `email` | `${user:email}` |

   {: .important }
   The `email` mapping is required — Snitch uses it to look up each user in IDC and resolve their group memberships.

5. **Save**, then copy the **SAML metadata URL** shown on the application page (form: `https://<idc-instance>.awsapps.com/start/saml/metadata/<app-id>`).
6. **Assign** the users or groups who should be able to sign in.

### 1c. Collect the identifiers you'll need

Gather these values — you'll enter them as environment variables in Step 2:

| Value | Where to find it |
|---|---|
| **SAML metadata URL** | Copied in step 1b |
| **Identity Store ID** (`d-xxxxxxxxxxxx`) | IDC console → **Settings → Identity source** |
| **Admin group ID** | The immutable **GroupId** (a UUID) of the IDC group whose members should be Snitch admins |
| **Auditor group ID** (optional) | The GroupId of the IDC group whose members get read-only auditor access |

{: .note }
Snitch keys admin and auditor access on the immutable **GroupId**, not the group name — renaming a group in IDC never breaks access.

---

## Step 2 — Deploy with AWS Amplify Hosting

Production Snitch runs on **AWS Amplify Hosting**, which builds and serves the app straight from your GitHub repository.

1. Open the **AWS Amplify** console → **Create new app**.
2. Choose **GitHub** as the source, authorize Amplify, and select the **Snitch repository** and the branch you want to deploy.
3. Add the environment variables you collected in Step 1. The Amplify console does **not** prompt for these on the main create-app screen — the field is tucked away, so you set them in one of two places:

   - **During app creation:** on the final **Review** step, expand the **Advanced settings** section — the **Environment variables** editor is inside it. Add each key/value there before you deploy.
   - **After app creation (or to edit them later):** in the Amplify console choose **Hosting → Environment variables** (only visible once the app is connected to the git repo), then choose **Manage variables → add variable** and **Save**. By default Amplify applies variables to all branches, so you don't re-enter them per branch.

   {: .important }
   If you skip the env vars during creation, the first build will fail. That's expected — add the variables under **Hosting → Environment variables** and then **redeploy** the branch.

   Add these values:

   | Variable | Required | Value |
   |---|---|---|
   | `IDC_SAML_METADATA_URL` | Yes | The SAML metadata URL from Step 1b |
   | `IDC_IDENTITY_STORE_ID` | Yes | Your Identity Store ID (`d-xxxxxxxxxxxx`) |
   | `ADMIN_GROUP_ID` | Yes | GroupId of the IDC admin group |
   | `AUDITOR_GROUP_ID` | No | GroupId of the IDC auditor group (omit if you don't use auditors) |

   {: .note }
   `COGNITO_DOMAIN_PREFIX` and `APP_CALLBACK_URL` are optional in Amplify Hosting — they are derived automatically from your Amplify app id and branch (`snitch-<branch>-<app-id>` and `https://<branch>.<app-id>.amplifyapp.com`).

4. **Save and deploy.** Amplify provisions all backend resources (Cognito, AppSync, DynamoDB, Lambda, Step Functions, AWS Verified Permissions) and hosts the frontend.

When the build finishes, Amplify gives you the app URL (`https://<branch>.<app-id>.amplifyapp.com`).

---

## Step 3 — Finalize the Setup

A few one-time steps after the first successful deploy.

### 3a. Finalize the ACS URL and SAML audience URI

The Cognito **domain prefix** and **User Pool ID** only exist after the first deploy (in Amplify Hosting the prefix is auto-generated as `snitch-<branch>-<app-id>`). Update the IDC application so both values match:

1. Open the IDC application from Step 1.
2. Edit **Application metadata → Application ACS URL** and set it to the real Cognito domain:

   ```
   https://<COGNITO_DOMAIN_PREFIX>.auth.<REGION>.amazoncognito.com/saml2/idpresponse
   ```

   (In Amplify Hosting the prefix is `snitch-<branch>-<app-id>`.)
3. Edit **Application metadata → Application SAML audience** and set it to:

   ```
   urn:amazon:cognito:sp:<USER_POOL_ID>
   ```

   (Find the User Pool ID in the Amplify/Cognito console, format `<REGION>_XXXXXXXXX`.)
4. Save.

{: .important }
Until the ACS URL and audience match, sign-in fails with a SAML mismatch. This is required after any deployment that creates a fresh User Pool.

### 3b. Grant admin access

Admin pages are gated by membership in the IDC group whose GroupId equals `ADMIN_GROUP_ID`. Add users to that IDC group to make them Snitch admins — no Cognito console changes needed. Users sign out and back in to pick up the new access.

### 3c. Grant auditor access (optional)

The read-only auditor pages (**Approval History** and **Session Activity**) are gated the same way, by the group whose GroupId equals `AUDITOR_GROUP_ID`. Admin and auditor membership are independent — a user can hold either, both, or neither.

### 3d. Configure the CloudTrail log group (optional)

To enable the CloudTrail audit trail, an admin opens **Settings** and enters the CloudWatch log group where CloudTrail delivers events. Everything else — IDC users, groups, accounts, OUs, and permission sets — is discovered live from AWS, with no manual configuration.

---

## Deploying a Local Sandbox

Before (or instead of) deploying to production with Amplify Hosting, you can run the entire stack **locally** against your own AWS account. This is ideal for evaluating Snitch or developing changes: `npx ampx sandbox` provisions a personal, hot-reloaded backend and `npm run dev` serves the frontend at [http://localhost:5173](http://localhost:5173).

{: .important }
Register a **separate** IAM Identity Center application for the sandbox — do **not** reuse the production application from Step 1. Each environment has its own Cognito domain, User Pool, and therefore its own ACS URL and SAML audience; pointing one IDC application at both leads to audience/ACS mismatches and sign-in failures. Repeat Step 1 to create a second application (e.g., `Snitch (sandbox)`) dedicated to your sandbox.

For the sandbox you provide the environment variables in your shell instead of the Amplify console.

See the **[Sandbox Deployment]({% link pages/idc-saml-setup.md %})** guide for the full local workflow, including the environment-variable helper script and troubleshooting.
