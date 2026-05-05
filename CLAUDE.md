# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

If you don't know how to do something, don't guess — ask me to guide you.

---

## Commands

```bash
npm run dev              # Vite dev server → http://localhost:5173
npm run build            # tsc -b && vite build
npm run test             # Vitest single run (all tests)
npm run test:watch       # Vitest watch mode
npm run test:coverage    # With coverage report
npm run sandbox          # Deploy / hot-reload Amplify Gen 2 sandbox
```

**Run a single test file:**
```bash
npx vitest run src/test/cedarPolicyBuilder.test.ts
```

**Run tests matching a name pattern:**
```bash
npx vitest run --reporter=verbose -t "conflict"
```

---

## Architecture: how the pieces connect

### IAM permission wiring lives entirely in `amplify/backend.ts`

Every Lambda's IAM role is assembled here. If a handler needs a new AWS action (DynamoDB, AVP, SSO, etc.) the `PolicyStatement` must be added here — the handler itself has no inline IAM config. This is the first place to check when seeing `is not authorized to perform` errors.

### Two data stores, one source of truth

`PrivilegedPolicy` records and `ApprovalPolicy` records both exist in **DynamoDB** (application metadata) and **AWS Verified Permissions** (Cedar policies). AVP is the authoritative source for access decisions. DynamoDB stores the `avpPolicyId` foreign key used for deletes. The compensating-transaction order in each handler (create: AVP first → DDB; update/delete: DDB first → AVP) means a partial failure always leaves the rollback target reachable.

### Conflict enforcement: one policy per (principal, resource)

`amplify/functions/verifiedPermissions/policyConflictChecker.ts` is called at the top of both `createPrivilegedPolicyHandler` and `updatePrivilegedPolicyHandler` — before any AVP or DDB writes. It scans for existing policies with the same `principalId` and overlapping `accountIds`/`ouIds`. The `excludeId` parameter lets updates skip their own record.

The frontend (`PrivilegedPoliciesPage.tsx → validate()`) performs the same check against the locally loaded `policies` state for immediate UX feedback, but the backend check is authoritative.

### Access evaluation path (`evaluateMyAccess`)

`evaluateAccessHandler.ts` ties together four AWS services in a single Lambda invocation:
1. IDC IdentityStore — resolve group memberships for the calling user
2. DynamoDB Scan — collect every `(accountId, permissionSetArn)` candidate across all policies
3. AVP `IsAuthorized` (parallel) — filter candidates where Cedar returns ALLOW; group parents are injected so `principal in Snitch::Group` policies resolve
4. Returns only ALLOW pairs → drives the account and permission-set dropdowns in `RequestAccessPage`

### JIT access workflow (`amplify/accessRequestWorkflow.ts`)

A separate CDK construct that owns the `AccessRequestTable` (GSI on `idcUserId`) and the Step Functions state machine. The full state machine flow:

```
CheckApproval → WaitForApproval (waitForTaskToken, 24h heartbeat)
              ↓ approved              ↓ rejected             ↓ timeout
        CheckStartTime         RejectionHandled (Pass)  SetStatusExpired (DDB SDK)
              ↓ (no startTime)
        AssignPermissionSet
              ↓
        WaitForEarlyRevocation (waitForTaskToken, TimeoutSecondsPath: durationSeconds)
              ↓ SendTaskSuccess (admin revoke)   ↓ States.Timeout (natural expiry)
        RemovePermissionSet ← ─────────────────────────────────────────────────────
              ↓ revokedByAdmin=true → REVOKED
              ↓ no flag            → EXPIRED
```

**`WaitForEarlyRevocation`** is a `waitForTaskToken` Task state (replacing the old plain `Wait`). `storeActiveTokenHandler` stores the task token in DDB when this state is entered. Admins call the `revokeAccess` mutation, which sends `SendTaskSuccess` with `revokedByAdmin: true` in the output — the execution immediately transitions to `RemovePermissionSet`. Natural expiry fires `States.Timeout` after `durationSeconds` via `TimeoutSecondsPath`, which is also caught to `RemovePermissionSet` (without the flag → sets `EXPIRED`).

`SetStatusExpired` is a Step Functions DynamoDB SDK integration state (no Lambda) — it only needs `$.requestId` from the execution context and writes `EXPIRED` directly.

`setupAccessRequestWorkflow()` returns `{ accessRequestTableArn, accessRequestTableName }` so `backend.ts` can wire up the approval Lambdas (which live in a different stack) without creating a circular dependency.

### AWS CLI — never run directly; always ask first

**Never execute any AWS CLI command (`aws ...`) that mutates cloud state.** This includes but is not limited to:

- Creating, updating, or deleting any resource (`aws dynamodb`, `aws iam`, `aws sso-admin`, `aws verifiedpermissions`, `aws stepfunctions`, `aws cloudformation`, etc.)
- Deploying or deleting stacks (`aws cloudformation deploy/delete-stack`)
- Modifying IAM roles, policies, or trust relationships
- Any `aws amplify` or `aws s3` mutating operations

**Why:** Any change made directly through the AWS CLI bypasses CloudFormation/CDK and causes **drift** — the infrastructure state diverges from what CDK believes is deployed. Drift breaks future `cdk deploy` / `npm run sandbox` runs in unpredictable ways and can silently corrupt stack state.

**Rule:** If an AWS CLI action appears necessary (e.g., to investigate a bug or unblock a deploy), stop and ask the user to confirm and run it manually. Read-only/diagnostic commands (`aws ... describe-*`, `aws ... list-*`, `aws ... get-*`) are fine to suggest but still require user approval before execution. All infrastructure changes must go through CDK code and be deployed via `npm run sandbox` or the CI pipeline.

### CDK / DynamoDB change constraints

**DynamoDB only allows one GSI creation or deletion per CloudFormation update.** Renaming a GSI or adding/removing a sort key counts as a delete + create — two operations — and CloudFormation will reject it with `Cannot perform more than one GSI creation or deletion in a single update`.

Safe procedure for any GSI rename or sort-key change:
1. **Deploy 1** — add the new GSI with the desired name/keys, and update handlers to use the new `IndexName`.
2. **Deploy 2** — delete the old GSI (remove the `addGlobalSecondaryIndex` call).

Never combine a GSI deletion and a GSI creation in the same CDK deploy. This applies to the `AccessRequestTable` in `amplify/accessRequestWorkflow.ts` and any other DynamoDB table managed by CDK in this project.

### `data` stack vs `AccessRequestWorkflow` stack — which stack for a new handler?

AppSync resolvers must be in the `data` stack (`resourceGroupName: "data"`) so AppSync can reference their Lambda ARNs. If they were in `AccessRequestWorkflow`, the dependency graph would be circular:

- `data` → `AccessRequestWorkflow` (AppSync references Lambda ARNs) **AND**
- `AccessRequestWorkflow` → `data` (needs `PrivilegedPolicyTable` ARN for IAM)

**Rule:** Any handler called directly by AppSync (queries/mutations) → `resourceGroupName: "data"`. Any handler called by the Step Functions state machine → `resourceGroupName: "AccessRequestWorkflow"`.

Current split:

| `data` stack | `AccessRequestWorkflow` stack |
|---|---|
| `approveRequest`, `rejectRequest`, `listPendingApprovals` | `storeApprovalToken`, `storeActiveToken` |
| `listAllAccessRequests`, `revokeAccess` | `assignPermissionSet`, `removePermissionSet`, `setStatusFailed` |
| `requestAccess`, `listAccessRequests` | |
| `createApprovalPolicy`, `deleteApprovalPolicy` | |

IAM grants and env vars for `data`-stack functions are set in `backend.ts` using the table values returned by `setupAccessRequestWorkflow()`, creating a one-directional dependency (`data` → `AccessRequestWorkflow`) that CloudFormation can resolve.

### Approval authorization — AVP-gated, not Cognito-group-gated

`listPendingApprovals`, `approveRequest`, and `rejectRequest` are authorized with `allow.authenticated()` (any logged-in user can call them). The Lambda handler is the enforcement point: it calls AVP `IsAuthorized` with the caller's Cognito username as a `Snitch::Approver` principal, the request's `accountId` as a `Snitch::Account` resource, and the request's `permissionSetArn` in context — injecting the caller's Cognito groups as `Snitch::ApproverGroup` parents so group-based approval policies resolve.

This means: non-admin users who are configured as approvers (via an `ApprovalPolicy` record) can access the `ApproveRequestsPage` and act on requests for the accounts and permission sets they're authorized for. Admins with no `ApprovalPolicy` entries will see an empty list.

The `ApproveRequestsPage` route has **no `AdminGuard`** — it is accessible to all authenticated users.

**AppSync identity — access token, not ID token.** AppSync forwards the Cognito **access token** to Lambda resolvers, not the ID token. The access token's claims only include `sub`, `cognito:groups`, and standard OIDC fields — custom attributes like `email` are absent. Any identity comparison in a Lambda handler must use `event.identity.username` (the Cognito sub/UUID) rather than email claims.

### `amplify/data/resource.ts` is the GraphQL contract

All AppSync queries/mutations and their Lambda resolvers are declared here. Adding a new Lambda-backed operation requires: (1) a function resource in a `resource.ts` file, (2) an entry in this schema, (3) import + registration in `backend.ts`, and (4) the IAM grants in `backend.ts`.

### `requesterCognitoSub` — self-approval guard on `AccessRequestItem`

`requestAccessHandler` captures `event.identity.username` (the requester's Cognito sub) at request-creation time and stores it as `requesterCognitoSub` on the DDB record. `approveRequestHandler` and `rejectRequestHandler` compare this value against `event.identity.username` of the approver and throw if they match — preventing a user from approving or rejecting their own request.

Email-based comparison does not work here: AppSync forwards access tokens, which never contain the `email` claim (see above). Using the Cognito sub from `identity.username` on both sides guarantees a reliable comparison with no extra API calls.

Old records written before this field was introduced will have `requesterCognitoSub` as `undefined`; both handlers guard the check with `if (request.requesterCognitoSub && ...)` so old items are not affected.

### `revokeComment` — admin audit field on `AccessRequestItem`

When an admin revokes an ACTIVE request via the Elevated Access page, an optional `revokeComment` is written to the DDB record in the same atomic `UpdateCommand` that clears the task token. It surfaces as a "Revoke reason" column in the Elevated Access table. The `revokeAccess` mutation accepts `revokeComment` as an optional argument; `revokeAccessHandler.ts` persists it and returns it in the response.

### Max Duration — stored as total minutes, entered as date + time

`PrivilegedPolicy.maxDurationMinutes` stores a total-minute integer. The form UI uses a `DatePicker` + `TimeInput` pair where the date defaults to today and can be up to 1 year in the future. The helpers in `src/utils/duration.ts` convert between the two representations:

- `maxDurationToMinutes(date, time)` — DatePicker `YYYY-MM-DD` + TimeInput `hh:mm` → minutes (used on save)
- `minutesToMaxDuration(minutes)` → `{ date, time }` relative to today (used to populate the edit form)
- `todayDateStr()` — returns today as `YYYY-MM-DD` (the format Cloudscape `DatePicker` uses internally; displayed as `YYYY/MM/DD` in the UI)

`formatDuration(minutes)` in the same file renders stored minutes as a human-readable label (`45min`, `8h 30min`, `2d 8h`) and is used in every table that shows a duration column.
