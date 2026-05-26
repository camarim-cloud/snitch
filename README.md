# Snitch

Snitch is a **Just-in-Time (JIT) privileged access management** tool for AWS. Administrators define Cedar policies that authorize IAM Identity Center (IDC) users or groups to assume specific Permission Sets on AWS accounts. End-users then request temporary access through a self-service UI; access is granted automatically and revoked when the requested duration expires.

## Tech Stack

- **Frontend**: React 19, Vite, TypeScript, [Cloudscape Design System](https://cloudscape.design/)
- **Backend**: AWS Amplify Gen 2 — AppSync (GraphQL), DynamoDB, Cognito, Lambda
- **Authorization**: AWS Verified Permissions (Cedar policy language)
- **Access orchestration**: AWS Step Functions + AWS SSO Admin API
- **Testing**: Vitest, React Testing Library

---

## Features

### 1. Authentication & Authorization

#### Authentication (AuthN)

Users authenticate via **IAM Identity Center (IDC)** acting as the SAML 2.0 identity provider. Amazon Cognito acts as the service provider and issues tokens consumed by the app and AppSync.

**Sign-in flow:**
1. App calls `signInWithRedirect()` → Cognito managed login page loads.
2. User clicks **"Sign in with IDC"** → Cognito redirects to the IDC SAML endpoint.
3. User authenticates in IDC → IDC issues a SAML assertion → Cognito validates it.
4. Cognito runs a **pre-token generation Lambda** that:
   - Looks up the IDC user by email in IdentityStore.
   - Fetches the user's IDC group memberships.
   - Injects group names (and `Admins` if the user belongs to `ADMIN_GROUP_NAME`) into the `cognito:groups` claim.
5. Cognito issues tokens → the app receives a `Hub signedIn` event and the session is established.

**Sign-out** calls `amplifySignOut()` → Cognito clears its session cookie → the managed login page is shown again.

All configuration (SAML metadata URL, Identity Store ID, domain prefix, admin group name) is stored in a single AWS Secrets Manager secret at `snitch/auth-config`. CDK reads the secret at synth time; the values are embedded as plain strings in the CloudFormation template.

#### Authorization (AuthZ)

Authorization is split between two layers:

| Layer | Mechanism | What it gates |
|---|---|---|
| **Admin pages** | `Admins` Cognito group (injected at token issuance by the pre-token Lambda based on IDC group membership) | Privileged Policies, Approval Policies, Elevated Access, Settings pages — guarded by `AdminGuard` in the UI and `allow.groups(["Admins"])` in the AppSync schema |
| **Access decisions** | AWS Verified Permissions (Cedar policies, `Snitch` namespace) | Whether an IDC user may `assume` a permission set on an account; whether a Cognito user may `approve` a request for a given account and permission set |

AppSync forwards the Cognito **access token** (not the ID token) to Lambda resolvers. The access token contains `sub`, `cognito:groups`, and standard OIDC fields — `email` is absent. For IDC-federated users, the Cognito username is formatted as `idc_<email>` (e.g., `idc_alice@example.com`); handlers that need the email strip the `idc_` prefix from `event.identity.username`.

### 2. Privileged Policies (Admin)

Admins manage Cedar policies stored in **AWS Verified Permissions** (AVP) via the Privileged Policies page.

Each policy grants a principal (IDC user or IDC group) the ability to `assume` one or more Permission Sets on a set of AWS accounts and/or Organizational Units (OUs).

| Operation | API | Details |
|---|---|---|
| Create | `createPrivilegedPolicyWithAVP` | Writes Cedar policy to AVP first; if DynamoDB write fails, rolls back the AVP policy |
| Update | `updatePrivilegedPolicyWithAVP` | Replaces the Cedar statement and updates the DynamoDB record |
| Delete | `deletePrivilegedPolicyWithAVP` | Removes both the AVP policy and the DynamoDB record |
| List | `PrivilegedPolicy.list` (AppSync model) | Reads directly from DynamoDB; restricted to Admins |

#### Cedar schema (`Snitch` namespace)

```
Principal:  Snitch::User  (memberOf Group)
            Snitch::Group
Resource:   Snitch::Account  (memberOf OU)
            Snitch::OU       (memberOf OU)
Action:     Snitch::Action::"assume"
Context:    { permissionSetArn: String }
```

The `buildCedarPolicy` helper ([amplify/functions/verifiedPermissions/cedarPolicyBuilder.ts](amplify/functions/verifiedPermissions/cedarPolicyBuilder.ts)) generates Cedar `permit` statements with `when` conditions that scope access to specific accounts/OUs and permission set ARNs.

### 3. Access Evaluation

The `evaluateMyAccess` GraphQL query lets any authenticated user check what they are allowed to access:

1. Resolves the caller's IDC user ID via `getMyIDCUser` (matches the Cognito email to an IDC identity).
2. Fetches all IDC group memberships for that user.
3. Scans every `PrivilegedPolicy` record to build a candidate set of `(accountId, permissionSetArn)` pairs.
4. Calls AVP `IsAuthorized` in parallel for each candidate, passing group memberships as entity parents so group-scoped policies resolve correctly.
5. Returns only the pairs where AVP returns `ALLOW`.

The result drives the **Request Access** form: only permitted accounts and permission sets are offered to the user.

### 4. Access Request Workflow

Any authenticated user can request temporary, time-boxed access to an AWS account.

**Flow:**

```
requestAccess mutation
  └─ Persist AccessRequest (status: PENDING) in DynamoDB
  └─ Start Step Functions execution
        ├─ AssignPermissionSet  →  SSO CreateAccountAssignment  →  update status: ACTIVE
        ├─ WaitForDuration      →  Step Functions Wait state (durationSeconds)
        └─ RemovePermissionSet  →  SSO DeleteAccountAssignment  →  update status: EXPIRED
              (on error at any step → SetStatusFailed → update status: FAILED)
```

**Retry policy** (all three Lambda task states): exponential back-off starting at 2 s, factor 2, up to 3 retries, full jitter — covers `Lambda.ServiceException`, `Lambda.AWSLambdaException`, `Lambda.SdkClientException`, and `Lambda.TooManyRequestsException`.

**Access request statuses:**

| Status | Meaning |
|---|---|
| `PENDING` | No approval required; waiting for Step Functions to assign the permission set |
| `PENDING_APPROVAL` | Waiting for an approver to act; Step Function paused at `WaitForApproval` |
| `SCHEDULED` | Approved but waiting for a future start time |
| `ACTIVE` | Permission set assigned; Step Function paused at `WaitForEarlyRevocation` |
| `EXPIRED` | Duration elapsed naturally (access revoked) or 24-hour approval timeout fired |
| `REVOKED` | Admin revoked the request early via the Elevated Access page |
| `REJECTED` | An approver rejected the request |
| `FAILED` | An unrecoverable error occurred in the workflow |

The `listMyAccessRequests` query retrieves all requests for the calling user, sorted newest-first via a DynamoDB GSI on `idcUserId`.

### 5. AWS Resource Discovery

A set of Lambda-backed GraphQL queries let admins browse live AWS infrastructure when building policies. All require the `Admins` group except `getMyIDCUser` and `evaluateMyAccess`.

| Query | Data source |
|---|---|
| `getMyIDCUser` | IDC IdentityStore (matched by Cognito email) |
| `listIDCUsers` | IDC IdentityStore |
| `listIDCGroups` | IDC IdentityStore |
| `listAWSAccounts` | AWS Organizations |
| `listOUs` | AWS Organizations |
| `listPermissionSets` | AWS SSO Admin |

---

## Project Structure

```
amplify/
├── auth/resource.ts                          # Cognito — SAML federation + pre-token generation trigger
├── authConfig.ts                             # Reads auth config from snitch/auth-config secret at synth time
├── data/resource.ts                          # AppSync schema + resolvers
├── backend.ts                                # CDK wiring: SAML/OAuth, managed login branding,
│                                             # AVP policy store, AppSettingsTable, IAM grants
├── accessRequestWorkflow.ts                  # Step Functions state machine + AccessRequestTable
└── functions/
    ├── auth/                                 # Pre-token generation Lambda
    │   └── preTokenGenerationHandler.ts      # Injects IDC group memberships into cognito:groups
    ├── awsResources/                         # IDC, Organizations, SSO Admin resolvers
    │   ├── getMyIDCUserHandler.ts
    │   ├── listAWSAccountsHandler.ts
    │   ├── listIDCGroupsHandler.ts
    │   ├── listIDCUsersHandler.ts
    │   ├── listOUsHandler.ts
    │   ├── listPermissionSetsHandler.ts
    │   └── helpers.ts
    ├── verifiedPermissions/                  # Cedar policy CRUD + access evaluation
    │   ├── cedarPolicyBuilder.ts
    │   ├── buildApprovalCedarPolicy.ts
    │   ├── createPrivilegedPolicyHandler.ts
    │   ├── updatePrivilegedPolicyHandler.ts
    │   ├── deletePrivilegedPolicyHandler.ts
    │   ├── createApprovalPolicyHandler.ts
    │   ├── deleteApprovalPolicyHandler.ts
    │   └── evaluateAccessHandler.ts
    ├── settings/                             # App-level settings (CloudTrail log group)
    │   ├── getSettingsHandler.ts
    │   └── updateSettingsHandler.ts
    └── accessRequests/                       # JIT workflow + approval Lambdas
        ├── requestAccessHandler.ts
        ├── assignPermissionSetHandler.ts
        ├── removePermissionSetHandler.ts
        ├── setStatusFailedHandler.ts
        ├── listAccessRequestsHandler.ts
        ├── listAllAccessRequestsHandler.ts
        ├── storeApprovalTokenHandler.ts
        ├── storeActiveTokenHandler.ts
        ├── approveRequestHandler.ts
        ├── rejectRequestHandler.ts
        ├── listPendingApprovalsHandler.ts
        ├── revokeAccessHandler.ts
        └── getCloudTrailLogsHandler.ts
src/
├── pages/
│   ├── PrivilegedPoliciesPage.tsx            # Admin CRUD for privileged policies
│   ├── ApprovalPolicyPage.tsx                # Admin: configure per-account approvers
│   ├── RequestAccessPage.tsx                 # End-user JIT access requests + history
│   ├── ApproveRequestsPage.tsx               # Any approver: review pending requests
│   ├── ElevatedAccessPage.tsx                # Admin: view all requests, revoke, CloudTrail
│   └── SettingsPage.tsx                      # Admin: configure app-level settings
├── components/
│   └── AdminGuard.tsx                        # Hides admin routes from non-Admins
├── utils/
│   ├── duration.ts                           # formatDuration, todayDateStr, minutesToMaxDuration
│   └── accessRequestStatus.ts               # accessRequestStatusType — status → Cloudscape indicator
├── App.tsx
└── main.tsx                                  # Entry point: Amplify config + signInWithRedirect flow
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

Authentication is federated through IAM Identity Center via SAML 2.0. Before running `npm run sandbox` you must:

1. Register a SAML 2.0 application in IAM Identity Center (get the metadata URL).
2. Note your Identity Store ID (`d-xxxxxxxxxxxx`).
3. Create an AWS Secrets Manager secret at `snitch/auth-config`:

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

This provisions Cognito (with SAML IdP + managed login), AppSync, DynamoDB, Lambda, Step Functions, and the AVP policy store in an isolated personal environment and writes `amplify_outputs.json`.

After the first deploy, update the **Application SAML audience** in the IDC console to `urn:amazon:cognito:sp:<USER_POOL_ID>` — until this is done, SAML login will fail with an audience mismatch.

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
| Authentication | Amazon Cognito + IAM Identity Center | SAML 2.0 federation (IDC = IdP, Cognito = SP); managed login page; pre-token Lambda injects IDC group memberships into `cognito:groups`; `Admins` group gates admin routes |
| API | AWS AppSync | GraphQL API (Cognito user pool auth) |
| Privileged policy store | AWS Verified Permissions | Cedar policy evaluation |
| Privileged policy metadata | Amazon DynamoDB (`PrivilegedPolicy` table) | Stores policy metadata alongside AVP IDs |
| Access request records | Amazon DynamoDB (`AccessRequestTable`) | Tracks JIT request lifecycle |
| Access workflow | AWS Step Functions | Orchestrates assign → wait → revoke |
| Resource discovery | AWS Lambda | Queries IDC, Organizations, SSO Admin |
