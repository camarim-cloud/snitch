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

- Sign-up / sign-in backed by **Amazon Cognito** (email + password).
- An **`Admins` Cognito group** gates all privileged-policy management operations. Regular users can only see their own access requests and evaluate what they are permitted to access.

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
| `PENDING` | Record created; Step Function not yet started (or starting) |
| `ACTIVE` | Permission set assigned; timer running |
| `EXPIRED` | Duration elapsed; permission set removed |
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
├── auth/resource.ts                          # Cognito config
├── data/resource.ts                          # AppSync schema + resolvers
├── backend.ts                                # Backend entrypoint, IAM policies, AVP store
├── accessRequestWorkflow.ts                  # Step Functions + DynamoDB for JIT access
└── functions/
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
    │   ├── createPrivilegedPolicyHandler.ts
    │   ├── updatePrivilegedPolicyHandler.ts
    │   ├── deletePrivilegedPolicyHandler.ts
    │   └── evaluateAccessHandler.ts
    └── accessRequests/                       # JIT workflow Lambdas
        ├── requestAccessHandler.ts
        ├── assignPermissionSetHandler.ts
        ├── removePermissionSetHandler.ts
        ├── setStatusFailedHandler.ts
        └── listAccessRequestsHandler.ts
src/
├── pages/
│   ├── PrivilegedPoliciesPage.tsx            # Admin CRUD for policies
│   └── RequestAccessPage.tsx                 # End-user JIT access requests
├── components/
│   └── AdminGuard.tsx                        # Hides admin routes from non-Admins
├── App.tsx
└── main.tsx
```

---

## Getting Started

### Prerequisites

- Node.js v18.16.0+
- AWS account with:
  - IAM Identity Center enabled
  - AWS Organizations (for account/OU listing)
  - Appropriate IAM permissions for the sandbox role

### Install

```bash
npm install
```

### Deploy backend sandbox

```bash
npx ampx sandbox
```

This provisions Cognito, AppSync, DynamoDB, Lambda, Step Functions, and the AVP policy store in an isolated personal environment and writes `amplify_outputs.json`.

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
| Authentication | Amazon Cognito | Email/password sign-in; `Admins` group |
| API | AWS AppSync | GraphQL API (Cognito user pool auth) |
| Privileged policy store | AWS Verified Permissions | Cedar policy evaluation |
| Privileged policy metadata | Amazon DynamoDB (`PrivilegedPolicy` table) | Stores policy metadata alongside AVP IDs |
| Access request records | Amazon DynamoDB (`AccessRequestTable`) | Tracks JIT request lifecycle |
| Access workflow | AWS Step Functions | Orchestrates assign → wait → revoke |
| Resource discovery | AWS Lambda | Queries IDC, Organizations, SSO Admin |
