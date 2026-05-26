# Snitch

Snitch is a **Just-in-Time (JIT) privileged access management** tool for AWS. Administrators define policies that grant IAM Identity Center users or groups access to specific AWS accounts with a chosen Permission Set. Users request temporary, time-boxed access through a self-service UI; access is granted automatically and revoked when the duration expires.

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
│   └── accessRequests/   # Access request lifecycle and approval workflow
src/              # Frontend (React)
├── pages/        # One file per route
├── components/   # Shared UI components
└── utils/        # Shared helpers
```

---

## Getting Started

### Prerequisites

- Node.js v18.16.0+
- AWS account with:
  - IAM Identity Center enabled
  - AWS Organizations configured (for account/OU discovery)
  - Appropriate IAM permissions for the sandbox role

### Install

```bash
npm install
```

### Before deploying — IAM Identity Center setup

Snitch uses IAM Identity Center for sign-in. Before running `npm run sandbox` you must:

1. Register a custom application in IAM Identity Center and note the metadata URL.
2. Note your Identity Store ID.
3. Create an AWS Secrets Manager secret at `snitch/auth-config` with the following fields:

```json
{
  "IDC_SAML_METADATA_URL": "https://<idc-instance>.awsapps.com/start/saml/metadata/<app-id>",
  "IDC_IDENTITY_STORE_ID": "d-xxxxxxxxxxxx",
  "ADMIN_GROUP_NAME": "SnitchAdmins",
  "COGNITO_DOMAIN_PREFIX": "snitch-auth",
  "APP_CALLBACK_URL": "http://localhost:5173"
}
```

See the full step-by-step guide in [docs/pages/idc-saml-setup.md](docs/pages/idc-saml-setup.md).

### Deploy backend sandbox

```bash
npx ampx sandbox
```

Deploys all backend infrastructure and writes `amplify_outputs.json` with the resource endpoints.

After the first deploy, update the **Application SAML audience** in the IDC console to match the newly created User Pool ID. See [Step 5 of the setup guide](docs/pages/idc-saml-setup.md#step-5--deploy-and-update-the-audience-uri) for details.

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
| Resource discovery | AWS Lambda | Fetches live data from IAM Identity Center, AWS Organizations, and SSO |
