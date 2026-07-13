---
title: Getting Started
layout: default
nav_order: 2
---

# Getting Started
{: .no_toc }

## Table of Contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Prerequisites

Before deploying Snitch, ensure you have the following:

- **Node.js** v18.16.0 or later
- An **AWS account** with:
  - IAM Identity Center (IDC) enabled
  - AWS Organizations configured (for account/OU discovery)
  - Appropriate IAM permissions for the Amplify sandbox role

---

## Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/camarim-cloud/snitch.git
cd snitch
npm install
```

---

## Before Deploying — IAM Identity Center Setup

Authentication is federated through IAM Identity Center via SAML 2.0. Before running `npm run sandbox`, you must:

1. Register a SAML 2.0 application in IAM Identity Center.
2. Get your Identity Store ID.
3. Create an AWS Secrets Manager secret at `snitch/auth-config`.

See the **[IAM Identity Center Setup]({% link pages/idc-saml-setup.md %})** guide for step-by-step instructions.

---

## Deploy the Backend Sandbox

Amplify Gen 2 provisions all backend resources (Cognito, AppSync, DynamoDB, Lambda, Step Functions, AVP) in an isolated personal sandbox environment:

```bash
npm run sandbox
# or
npx ampx sandbox
```

This command:
1. Synthesizes CDK stacks defined under `amplify/`
2. Deploys them to your AWS account
3. Writes `amplify_outputs.json` with all endpoint URLs and resource IDs

{: .note }
The sandbox is hot-reloaded — changes to `amplify/` files are deployed automatically while `npm run sandbox` is running.

---

## Start the Frontend

```bash
npm run dev
```

The app starts at [http://localhost:5173](http://localhost:5173).

---

## First-Time Setup

### 1. Update the SAML Audience URI

After the first deploy, Cognito's User Pool ID is known. Update the **Application SAML audience** in the IDC console to:

```
urn:amazon:cognito:sp:<USER_POOL_ID>
```

See [Step 5 of the IAM Identity Center Setup guide]({% link pages/idc-saml-setup.md %}#step-5--deploy-and-update-the-audience-uri) for details.

### 2. Grant Admin Access

Admin pages are gated by membership in the IDC group whose display name matches `ADMIN_GROUP_NAME` in the `snitch/auth-config` secret. Add users to that IDC group to grant them admin access — no Cognito console changes are needed.

### 3. Grant Auditor Access

The read-only Auditor pages (**Approval History** and **Session Activity**) are gated the same way, by membership in the IDC group whose display name matches `AUDITOR_GROUP_NAME` (defaults to `AWSTeamAuditors`). Add users to that IDC group to let them review approval decisions and CloudTrail session activity without any ability to change access. Admin and Auditor membership are independent — a user can hold either, both, or neither. Users must sign out and back in after being added, so the new group claim is minted at token generation.

### 4. Configure CloudTrail Log Group (Optional)

IDC Users, Groups, AWS Accounts, Organizational Units, and Permission Sets are all fetched live from AWS APIs — no manual configuration is needed.

To enable the CloudTrail audit trail on the Elevated Access page, navigate to **Settings** (admin only) and enter the CloudWatch log group name where CloudTrail delivers events.

---

## Running Tests

```bash
npm run test            # single run
npm run test:watch      # watch mode
npm run test:coverage   # with coverage report
```

Run a single test file:

```bash
npx vitest run src/test/cedarPolicyBuilder.test.ts
```

Run tests matching a name pattern:

```bash
npx vitest run --reporter=verbose -t "approval"
```

---

## Build for Production

```bash
npm run build
```

Output is placed in `dist/`. This command runs TypeScript compilation (`tsc -b`) followed by the Vite production build.
