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

{: .note }
Snitch authenticates every user through IAM Identity Center via SAML 2.0. Amazon Cognito sits behind IDC and issues the tokens the app uses — you never manage passwords in Snitch.

---

## Step 1 — Register the IAM Identity Center Application

Snitch needs a SAML 2.0 application in IAM Identity Center so your workforce can sign in. Do this once; the same application works for both production and sandbox.

### 1a. Choose a Cognito domain prefix

Pick a globally unique prefix for the Cognito sign-in domain (for example, `snitch-auth`). It forms the sign-in URL and the SAML **Assertion Consumer Service (ACS) URL** you register in IDC:

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
   | **Application ACS URL** | `https://<COGNITO_DOMAIN_PREFIX>.auth.<REGION>.amazoncognito.com/saml2/idpresponse` |
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
3. When prompted for **Environment variables**, add the values you collected in Step 1:

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

### 3a. Update the SAML audience URI

The Cognito **User Pool ID** only exists after the first deploy. Update the IDC application so its audience matches:

1. Open the IDC application from Step 1.
2. Edit **Application metadata → Application SAML audience** and set it to:

   ```
   urn:amazon:cognito:sp:<USER_POOL_ID>
   ```

   (Find the User Pool ID in the Amplify/Cognito console, format `<REGION>_XXXXXXXXX`.)
3. Save.

{: .important }
Until the audience matches, sign-in fails with a SAML audience mismatch. This is required after any deployment that creates a fresh User Pool.

### 3b. Grant admin access

Admin pages are gated by membership in the IDC group whose GroupId equals `ADMIN_GROUP_ID`. Add users to that IDC group to make them Snitch admins — no Cognito console changes needed. Users sign out and back in to pick up the new access.

### 3c. Grant auditor access (optional)

The read-only auditor pages (**Approval History** and **Session Activity**) are gated the same way, by the group whose GroupId equals `AUDITOR_GROUP_ID`. Admin and auditor membership are independent — a user can hold either, both, or neither.

### 3d. Configure the CloudTrail log group (optional)

To enable the CloudTrail audit trail, an admin opens **Settings** and enters the CloudWatch log group where CloudTrail delivers events. Everything else — IDC users, groups, accounts, OUs, and permission sets — is discovered live from AWS, with no manual configuration.

---

## Deploying a Local Sandbox

Before (or instead of) deploying to production with Amplify Hosting, you can run the entire stack **locally** against your own AWS account. This is ideal for evaluating Snitch or developing changes: `npx ampx sandbox` provisions a personal, hot-reloaded backend and `npm run dev` serves the frontend at [http://localhost:5173](http://localhost:5173).

A sandbox reuses the same IAM Identity Center application from Step 1 — you only need to provide the environment variables in your shell instead of the Amplify console.

See the **[Sandbox Deployment]({% link pages/idc-saml-setup.md %})** guide for the full local workflow, including the environment-variable helper script and troubleshooting.
