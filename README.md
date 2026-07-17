# Snitch

Snitch is a **Just-in-Time (JIT) privileged access management** tool for AWS accounts. Administrators define policies that grant IAM Identity Center users or groups access to specific AWS accounts with a chosen Permission Set. Users request temporary, time-boxed access through a self-service UI; access is granted automatically and revoked when the duration expires.

## Tech Stack

- **Frontend**: React 19, Vite, TypeScript, [Cloudscape Design System](https://cloudscape.design/)
- **Backend**: AWS Amplify Gen 2 — AppSync (GraphQL), DynamoDB, Cognito, Lambda
- **Authorization**: AWS Verified Permissions (Cedar policy language)
- **Access orchestration**: AWS Step Functions + AWS SSO Admin API
- **Testing**: Vitest, React Testing Library

---

## Features

### 1. Authentication & Authorization

Users sign in with their **IAM Identity Center (IDC)** credentials — no separate password needed. IDC is the identity provider; Cognito issues the session tokens. Admin pages (policy management, elevated access, settings) are visible only to users who belong to the designated admin group in IDC. Access decisions (which accounts a user may request) are evaluated against Cedar policies, not hardcoded rules.

### 2. Privileged Policies

Admins define who can access what. Each policy maps an IDC user or group to one or more AWS accounts (or entire OUs) and a specific Permission Set. Policies can be created, updated, and deleted from the UI; changes take effect immediately for the next access request.

### 3. Just-in-Time Access Requests

Users see only the accounts and permission sets they are actually permitted to request. They pick a destination, choose how long they need access, and submit. Access is granted automatically and revoked as soon as the requested duration expires — no manual cleanup required.

Policies can optionally require approval before access is granted. When approval is required, the request waits for a designated approver to act; if no one responds within 24 hours, the request expires automatically.

### 4. Approval Workflow

Admins configure which users or groups can approve requests for each AWS account. Approvers see only the pending requests they are authorized to act on, and can approve or reject each one from a dedicated page. Users cannot approve their own requests.

### 5. Elevated Access (Admin)

Admins can view all active and historical requests across every user, revoke live access early with an optional comment, and inspect the full CloudTrail audit trail for each access window.

### 6. AWS Resource Discovery

When building policies, admins can browse live data from the connected AWS organization — IDC users, IDC groups, AWS accounts, Organizational Units, and Permission Sets — without leaving the app.

### 7. Notifications

Snitch can announce the access-request lifecycle over **Slack** and **Amazon SNS**, with per-channel toggles in Settings. Notifications fire when access is **requested**, when a session **finishes** (expires or is revoked), and when a request **needs approval**. Slack approval messages are interactive (Approve/Reject buttons); the SNS approval email links back to the in-app Approve Requests page so approvals stay fully authorized. See [docs/pages/notifications.md](docs/pages/notifications.md).

---

## Project Structure

```
amplify/          # Backend infrastructure (CDK) and Lambda functions
├── auth/         # Authentication config and sign-in trigger
├── data/         # GraphQL API schema and resolvers
├── functions/    # Lambda handlers grouped by domain
│   ├── auth/             # Sign-in customization
│   ├── awsResources/     # AWS resource discovery (accounts, OUs, IDC users/groups, permission sets)
│   ├── verifiedPermissions/  # Policy management and access evaluation
│   ├── settings/         # App-level settings
│   ├── notifications/    # Shared Slack + SNS notification sender
│   └── accessRequests/   # Access request lifecycle and approval workflow
src/              # Frontend (React)
├── pages/        # One file per route
├── components/   # Shared UI components
└── utils/        # Shared helpers
```

---

## Getting Started

This is a condensed overview. For the full step-by-step walkthrough, see [docs/pages/getting-started.md](docs/pages/getting-started.md) (production) and [docs/pages/idc-saml-setup.md](docs/pages/idc-saml-setup.md) (local sandbox).

### Prerequisites

- Node.js v18.16.0+
- An AWS account with:
  - IAM Identity Center (IDC) enabled
  - AWS Organizations configured (for account/OU discovery)
  - Permissions to create IDC applications and Amplify apps
- A GitHub account with access to this repository (Amplify Hosting deploys directly from GitHub)

> **Deploy in the same account and Region as IDC.** Snitch calls the IDC Identity Store and SSO APIs directly, so it must run in the same AWS account and Region that hosts your IAM Identity Center instance. If IDC administration has been **delegated to a member account**, deploy Snitch into that delegated administrator account — not the Organizations management account. Delegating IDC to a dedicated account (rather than running it in the management account) is the recommended practice.

> **CloudTrail → CloudWatch for session audit.** The Session Activity and Elevated Access audit trails read events from CloudWatch Logs. For those pages to show anything, CloudTrail must be configured to deliver its logs to a CloudWatch Logs log group (an S3-only trail is not enough). You supply that log group name later on the in-app **Settings** page.

### Install

```bash
npm install
```

### IAM Identity Center setup

Snitch uses IAM Identity Center for sign-in. Before deploying, register a **SAML 2.0 application** in IDC and collect:

1. The application's **SAML metadata URL** (public information).
2. Your **Identity Store ID** (`d-xxxxxxxxxxxx`).
3. The immutable **GroupId** (a UUID) of the IDC group whose members should be admins — and, optionally, an auditor group's GroupId.

> Register a **separate** IDC application for each environment. Do not reuse the production application for a sandbox: each environment has its own Cognito domain, User Pool, ACS URL, and SAML audience, and sharing one application leads to sign-in mismatches.

These values are supplied as synth-time **environment variables**.

Required:

- `IDC_SAML_METADATA_URL` (the SAML metadata URL from the IDC application)
- `IDC_IDENTITY_STORE_ID` (your Identity Store ID)
- `ADMIN_GROUP_ID` (the immutable IDC GroupId whose members receive the `Admins` claim)

Optional:

- `AUDITOR_GROUP_ID` (the IDC GroupId whose members receive the read-only `Auditors` claim; unset ⇒ no auditors)
- `COGNITO_DOMAIN_PREFIX` — auto-derived as `snitch-<branch>-<app-id>` in an Amplify Hosting build; **required for a local sandbox** (no Amplify app id to derive from). Must be **globally unique** — a value already in use fails the deploy.
- `APP_CALLBACK_URL` — auto-derived as `https://<branch>.<app-id>.amplifyapp.com` in Amplify Hosting, or `http://localhost:5173` for a local sandbox

### Deploy to production (Amplify Hosting)

1. In the **AWS Amplify** console, choose **Create new app** and connect this GitHub repository and branch.
2. Add the environment variables above. The Amplify console hides this field: set it under **Advanced settings** on the create-app **Review** step, or afterward under **Hosting → Environment variables → Manage variables**. (If you skip them, the first build fails — add the variables and redeploy.)
3. **Save and deploy.** Amplify provisions all backend resources and hosts the frontend at `https://<branch>.<app-id>.amplifyapp.com`.
4. After the first deploy, finalize the IDC application's **ACS URL** and **SAML audience** to match the newly created Cognito domain and User Pool ID.

See [docs/pages/getting-started.md](docs/pages/getting-started.md) for the complete production flow.

### Deploy a local sandbox

Register a dedicated sandbox IDC application (per the note above), then set the same environment variables in your shell before `npx ampx sandbox`. Copy the tracked template `scripts/set-sandbox-env.example.sh` to `scripts/set-sandbox-env.sh` (git-ignored — it holds your real values), edit it, then **source** it (do not execute it, or the exports won't persist):

```bash
cp scripts/set-sandbox-env.example.sh scripts/set-sandbox-env.sh
# edit scripts/set-sandbox-env.sh with your real values, then:
source scripts/set-sandbox-env.sh
npx ampx sandbox
```

`npx ampx sandbox` deploys all backend infrastructure and writes `amplify_outputs.json` with the resource endpoints.

After the first deploy, update the **Application SAML audience** in the IDC console to match the newly created User Pool ID. See [Update the SAML Audience URI](docs/pages/idc-saml-setup.md#update-the-saml-audience-uri) for details.

### Run frontend

```bash
npm run dev
```

App starts at [http://localhost:5173](http://localhost:5173).

### Run tests

```bash
npm run test            # single run
npm run test:watch      # watch mode
npm run test:coverage   # with coverage
```

---

## Backend Resources

| Resource | Service | Purpose |
|---|---|---|
| Authentication | Amazon Cognito + IAM Identity Center | Sign-in via IDC; admin group membership controls access to admin pages |
| API | AWS AppSync | GraphQL API consumed by the frontend |
| Access policy store | AWS Verified Permissions | Evaluates who is allowed to access what |
| Policy metadata | Amazon DynamoDB | Stores policy records and request history |
| Access workflow | AWS Step Functions | Assigns and revokes permission sets automatically |
| Notifications | Amazon SNS + Slack API | Announces requested / finished / approval events to a topic and channel |
| Resource discovery | AWS Lambda | Fetches live data from IAM Identity Center, AWS Organizations, and SSO |
