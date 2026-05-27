# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Snitch — Privileged Access Management

## Product Overview

A fullstack application for managing privileged access to AWS accounts. Admins define policies that grant IAM Identity Center (IDC) users or groups access to specific AWS accounts and OUs using chosen Permission Sets. Each policy is stored in DynamoDB and mirrored as a Cedar policy in AWS Verified Permissions, which is the authoritative source for access evaluation.

**Core features:**
- User authentication with Amazon Cognito (Admins group gates admin-only pages)
- Privileged policy management (create, read, update, delete) with conflict enforcement (one policy per principal + resource)
- Cedar policy authoring via `buildCedarPolicy` — policies are stored in AVP and evaluated at request time
- AWS resource discovery: IDC users/groups, Cognito users/groups, AWS accounts, OUs, Permission Sets
- JIT access requests with a Step Functions workflow: assign permission set → interruptible wait → revoke
- Optional approval gate on policies: requests pause at `PENDING_APPROVAL` until a configured approver acts (or the 24-hour timeout fires)
- Approval Policy management: configure which Cognito users/groups can approve requests per account (with optional permission set conditions); persisted as Cedar `approve` policies in AVP
- Elevated Access page (admin-only): view all requests across all users, revoke any ACTIVE request early, and inspect the full CloudTrail audit trail for each request window
- Settings page (admin-only): configure application-level settings such as the CloudWatch log group where CloudTrail delivers audit events
- Responsive UI built with Cloudscape Design System

## Technology Stack

- **Frontend**: React 19 + TypeScript, Vite, Cloudscape Design System, React Router v7
- **Backend**: AWS Amplify Gen 2 (AppSync GraphQL + DynamoDB + Cognito)
- **Authorization**: AWS Verified Permissions (Cedar policies, STRICT schema validation)
- **Testing**: Vitest + React Testing Library (jsdom environment)

### Common Commands

```bash
npm run dev              # Start Vite dev server (http://localhost:5173)
npm run build            # Build for production (tsc -b && vite build)
npm run test             # Run tests once
npm run test:watch       # Run tests in watch mode
npm run test:coverage    # Run tests with coverage report
npm run sandbox          # Deploy Amplify sandbox
```

## Project Structure

```
snitch/
├── amplify/
│   ├── auth/resource.ts        # Cognito config; email login + pre-token generation trigger
│   ├── authConfig.ts           # REMOVED — synth-time Cognito values now come from environment variables
│   ├── data/resource.ts        # AppSync schema: PrivilegedPolicy model + AVP-backed mutations
│   ├── backend.ts              # CDK wiring: SAML/OAuth CDK escape hatch, AVP policy store,
│   │                           # AppSettingsTable, IAM grants, env vars
│   └── functions/
│       ├── auth/
│       │   ├── resource.ts                    # pre-token-generation function (resourceGroupName: "auth")
│       │   └── preTokenGenerationHandler.ts   # Injects IDC groups into cognito:groups at token issue time
│       ├── awsResources/       # Lambda resolvers: list IDC users/groups, accounts, OUs, permission sets
│       ├── settings/
│       │   ├── resource.ts               # Function definitions for getSettings and updateSettings
│       │   ├── getSettingsHandler.ts     # Reads global settings record from AppSettingsTable
│       │   └── updateSettingsHandler.ts  # Writes/overwrites global settings record
│       └── verifiedPermissions/
│           ├── cedarPolicyBuilder.ts              # Pure function: builds Cedar PERMIT statement (assume)
│           ├── buildApprovalCedarPolicy.ts        # Pure function: builds Cedar PERMIT statement (approve)
│           ├── createPrivilegedPolicyHandler.ts
│           ├── updatePrivilegedPolicyHandler.ts
│           ├── deletePrivilegedPolicyHandler.ts
│           ├── createApprovalPolicyHandler.ts     # Creates ApprovalPolicy record + AVP approve policy
│           └── deleteApprovalPolicyHandler.ts     # Deletes ApprovalPolicy record + AVP approve policy
├── src/
│   ├── components/             # Reusable UI components
│   ├── hooks/                  # Custom React hooks
│   ├── utils/
│   │   ├── duration.ts              # Shared: todayDateStr, minutesToMaxDuration, maxDurationToMinutes, formatDuration
│   │   └── accessRequestStatus.ts   # Shared: accessRequestStatusType — maps request status string → Cloudscape StatusIndicator type
│   ├── types/                  # Shared TypeScript types
│   ├── pages/
│   │   ├── PrivilegedPoliciesPage.tsx  # Admin CRUD for privileged policies (requiresApproval toggle only)
│   │   ├── ApprovalPolicyPage.tsx      # Admin: configure per-account approvers with permission set conditions
│   │   ├── RequestAccessPage.tsx       # End-user JIT access request form + request history
│   │   ├── ApproveRequestsPage.tsx     # Any authenticated approver: review, approve, or reject pending requests
│   │   ├── ElevatedAccessPage.tsx      # Admin page: view all requests, revoke ACTIVE ones early, view CloudTrail audit logs
│   │   └── SettingsPage.tsx            # Admin page: configure app-level settings (CloudTrail log group)
│   ├── test/
│   │   └── setup.ts            # Vitest setup (jest-dom matchers)
│   ├── App.tsx
│   └── main.tsx                # Entry point: Amplify config + AuthRedirect (signInWithRedirect flow)
├── amplify_outputs.json        # Generated backend outputs
├── vite.config.ts
└── tsconfig.json
```

## Privileged Policy — Approval Configuration

Each `PrivilegedPolicy` can optionally require approval before access is granted. The `requiresApproval` boolean field on the policy record enables this gate.

**Who can approve** is configured separately in the `ApprovalPolicy` model (not on `PrivilegedPolicy`). Each `ApprovalPolicy` record defines a single approver (Cognito user or group) for a specific AWS **account**, with one or more permission set ARNs enforced as a Cedar `when` condition. It is backed by a Cedar `approve` policy in AVP.

When `requiresApproval` is `true` on a `PrivilegedPolicy`:
1. `evaluateMyAccess` returns `requiresApproval: true` for the matching `(accountId, permissionSetArn)` pair.
2. The Request Access form shows an info alert warning the user that approval is required.
3. On submission, `requestAccess` creates the record with `status: "PENDING_APPROVAL"` and the Step Function pauses at `WaitForApproval`.
4. The `Approve Requests` page lists requests pending the current user's review. Available to **any authenticated user** — access is gated by AVP `IsAuthorized` per request's `(accountId, permissionSetArn)` pair, not by Cognito group.
5. `approveRequest` / `rejectRequest` mutations resume or terminate the Step Function execution.

### Approval Policy model

`ApprovalPolicy` records live in their own DynamoDB table (auto-generated by Amplify). Each record maps one approver to one AWS account, with required permission set conditions:

| Field | Type | Purpose |
|---|---|---|
| `accountId` | string | The AWS account the approver can act on (composite PK hash key) |
| `principalKey` | string | Composite sort key: `"${principalType}#${principalId}"` |
| `accountName` | string | Display name for the account (denormalized) |
| `principalType` | `USER` \| `GROUP` | Cognito user or Cognito group |
| `principalId` | string | Cognito username (USER) or Cognito group name (GROUP) |
| `principalDisplayName` | string | Human-readable label |
| `permissionSetArns` | string[] | Permission set ARNs used in the Cedar `when` clause (≥1 required) |
| `permissionSetNames` | string[] | Display names (denormalized, parallel array) |
| `avpPolicyId` | string | Foreign key to the Cedar `approve` policy in AVP |

Composite primary key: `[accountId, principalKey]` — enables O(1) GetItem duplicate checks with no GSI or scan.

Managed via `createApprovalPolicyWithAVP` / `deleteApprovalPolicyWithAVP` mutations (no update — delete + recreate). The `ApprovalPolicyPage` in the UI provides the admin interface.

### Access Request Statuses

| Status | Meaning |
|---|---|
| `PENDING` | No approval required; waiting for Step Functions to assign the permission set |
| `PENDING_APPROVAL` | Waiting for an approver to act; Step Function is paused at `WaitForApproval` |
| `SCHEDULED` | Approved but waiting for a future start time |
| `ACTIVE` | Permission set assigned; Step Function paused at `WaitForEarlyRevocation` |
| `EXPIRED` | Duration elapsed naturally (access revoked) or 24-hour approval timeout fired |
| `REVOKED` | Admin revoked the request early via the Elevated Access page |
| `REJECTED` | An approver rejected the request |
| `FAILED` | Unrecoverable error in the workflow |

### Approval Workflow — Step Functions States

```
CheckApproval (Choice)
  requiresApproval = true  →  WaitForApproval (waitForTaskToken, HeartbeatSeconds: 86400)
  default                  →  CheckStartTime

WaitForApproval
  on SendTaskSuccess        →  CheckStartTime
  on "RequestRejected"      →  RejectionHandled (Pass — DDB already set to REJECTED)
  on States.HeartbeatTimeout→  SetStatusExpired (DynamoDB SDK integration, no Lambda)
  on States.ALL             →  SetStatusFailed

CheckStartTime (Choice)
  startTime present         →  SetStatusScheduled → WaitUntilStartTime → AssignPermissionSet
  default                   →  AssignPermissionSet

AssignPermissionSet → WaitForEarlyRevocation → RemovePermissionSet
```

**`WaitForEarlyRevocation`** replaces the old plain `Wait` state. It uses `waitForTaskToken` with `TimeoutSecondsPath: "$.durationSeconds"` so it can be interrupted:

- `States.Timeout` (natural expiry after `durationSeconds`) → `RemovePermissionSet` with no flag → sets status `EXPIRED`
- `SendTaskSuccess` from `revokeAccessHandler` → `RemovePermissionSet` with `revokedByAdmin: true` → sets status `REVOKED`

`storeActiveTokenHandler` is invoked when the state starts; it stores the task token in DDB so `revokeAccessHandler` can call `SendTaskSuccess` later.

`SetStatusExpired` uses `arn:aws:states:::aws-sdk:dynamodb:updateItem` directly — no Lambda cold start needed since only `$.requestId` from state context is required.

### Lambda Handlers (`amplify/functions/accessRequests/`)

| Handler | Stack | Purpose |
|---|---|---|
| `storeApprovalTokenHandler.ts` | AccessRequestWorkflow | Called by `WaitForApproval`; stores task token, sets `PENDING_APPROVAL` |
| `storeActiveTokenHandler.ts` | AccessRequestWorkflow | Called by `WaitForEarlyRevocation`; stores task token while request is `ACTIVE` |
| `assignPermissionSetHandler.ts` | AccessRequestWorkflow | Creates SSO account assignment, sets `ACTIVE`, writes `activatedAt` timestamp |
| `removePermissionSetHandler.ts` | AccessRequestWorkflow | Deletes SSO account assignment; sets `REVOKED` if `revokedByAdmin: true`, otherwise `EXPIRED`; writes `deactivatedAt` timestamp |
| `setStatusFailedHandler.ts` | AccessRequestWorkflow | Sets `FAILED` on unrecoverable workflow errors |
| `requestAccessHandler.ts` | AccessRequestWorkflow | Persists the request (including `requesterCognitoSub`) and starts the state machine |
| `listAccessRequestsHandler.ts` | AccessRequestWorkflow | Returns all requests for a given IDC user (newest first, via GSI) |
| `approveRequestHandler.ts` | data | Guards self-approval via `requesterCognitoSub`; checks AVP `IsAuthorized` (approve/Account + permissionSetArn context); calls `SendTaskSuccess` to resume state machine |
| `rejectRequestHandler.ts` | data | Guards self-rejection via `requesterCognitoSub`; checks AVP `IsAuthorized` (approve/Account + permissionSetArn context); sets `REJECTED` atomically, calls `SendTaskFailure` |
| `listPendingApprovalsHandler.ts` | data | Scans `PENDING_APPROVAL` requests; filters by AVP `IsAuthorized` per unique `(accountId, permissionSetArn)` pair |
| `listAllAccessRequestsHandler.ts` | data | Returns all requests across all users (admin-only, newest first) |
| `revokeAccessHandler.ts` | data | Signals `WaitForEarlyRevocation` via `SendTaskSuccess`; persists optional `revokeComment` for audit |
| `getCloudTrailLogsHandler.ts` | data | Reads configured log group from AppSettingsTable; calls CloudWatch Logs `FilterLogEvents` with email-based filter; returns parsed CloudTrail events |

`approveRequest`, `rejectRequest`, `listPendingApprovals`, `listAllAccessRequests`, `revokeAccess` are in the `data` stack (`resourceGroupName: "data"`) — see the Architecture section below for why.

`createApprovalPolicyHandler.ts` and `deleteApprovalPolicyHandler.ts` are also in the `data` stack (AppSync-backed). They keep the `ApprovalPolicy` DynamoDB table and AVP Cedar policies in sync (create: AVP first → DDB; delete: DDB first → AVP).

### Lambda Handlers (`amplify/functions/settings/`)

| Handler | Stack | Purpose |
|---|---|---|
| `getSettingsHandler.ts` | data | Reads the single `settingKey: "global"` record from `AppSettingsTable`; returns `{ cloudTrailLogGroupName }` |
| `updateSettingsHandler.ts` | data | Puts/overwrites the `settingKey: "global"` record; returns the saved settings |

## AWS Verified Permissions Integration

### Overview

Every `PrivilegedPolicy` record has a corresponding Cedar policy in AVP. The policy store uses **STRICT** schema validation against the `Snitch` Cedar namespace. AVP is the authoritative store for access decisions — DynamoDB is the application record.

### Cedar Schema (`Snitch` namespace)

```
── assume action ──────────────────────────────────────────────────────────────
Principal: Snitch::User (IDC user ID, memberOf Group) | Snitch::Group (IDC group ID)
Resource:  Snitch::Account (memberOf OU) | Snitch::OU (memberOf OU)
Action:    Snitch::Action::"assume"
Context:   { permissionSetArn: String (required) }

── approve action ─────────────────────────────────────────────────────────────
Principal: Snitch::Approver (Cognito username, memberOf ApproverGroup) | Snitch::ApproverGroup (Cognito group name)
Resource:  Snitch::Account (AWS account ID)
Action:    Snitch::Action::"approve"
Context:   { permissionSetArn: String (required) }
```

The `assume` and `approve` actions use **different principal namespaces** — IDC IDs for `assume`, Cognito identifiers for `approve`. This avoids conflating the two identity systems in the same entity type.

The `approve` action reuses the `Snitch::Account` entity type (also used by `assume`) as its resource. The permission set ARN is not the resource — it is a `when`-clause condition that filters which requests an approver is authorized for on that account.

### Policy Lifecycle

**Privileged policies** (`createPrivilegedPolicyWithAVP`, `updatePrivilegedPolicyWithAVP`, `deletePrivilegedPolicyWithAVP`) and **approval policies** (`createApprovalPolicyWithAVP`, `deleteApprovalPolicyWithAVP`) are all AppSync custom resolvers backed by Lambda. Each keeps its DynamoDB table and AVP in sync with compensating transactions:

| Mutation | Order | Rollback on failure |
|---|---|---|
| Create (both types) | AVP first → DynamoDB | Delete AVP policy |
| Update (privileged only) | DynamoDB first → AVP | Restore DynamoDB snapshot |
| Delete (both types) | DynamoDB first → AVP | Restore DynamoDB snapshot |

The `avpPolicyId` returned by AVP is stored on the DynamoDB item and used for subsequent deletes.

### Cedar Policy Shapes

**`buildCedarPolicy`** (`cedarPolicyBuilder.ts`) — produces the `assume` PERMIT statement. The `when` clause encodes resources (Account/OU, OR-joined) and the allowed permission set ARN:

```cedar
permit (
  principal == Snitch::User::"abc-123",
  action == Snitch::Action::"assume",
  resource
) when {
  (
    resource in Snitch::Account::"111111111111" ||
    resource in Snitch::OU::"ou-root-xxxx"
  ) &&
  ["arn:aws:sso:::permissionSet/ps-1"].contains(context.permissionSetArn)
};
```

Groups use `principal in Snitch::Group::"<id>"` instead of `==`.

**`buildApprovalCedarPolicy`** (`buildApprovalCedarPolicy.ts`) — produces the `approve` PERMIT statement. Resource is the AWS account ID; permission set ARNs are enforced in the `when` clause (at least one always required):

```cedar
// USER approver:
permit (
  principal == Snitch::Approver::"alice",
  action == Snitch::Action::"approve",
  resource == Snitch::Account::"111111111111"
) when {
  ["arn:aws:sso:::permissionSet/ps-1", "arn:aws:sso:::permissionSet/ps-2"].contains(context.permissionSetArn)
};

// GROUP approver:
permit (
  principal in Snitch::ApproverGroup::"Approvers",
  action == Snitch::Action::"approve",
  resource == Snitch::Account::"111111111111"
) when {
  ["arn:aws:sso:::permissionSet/ps-1"].contains(context.permissionSetArn)
};
```

### Environment Variables (Lambda)

| Variable | Used by |
|---|---|
| `IDC_IDENTITY_STORE_ID` | `preTokenGenerationHandler` — plain string set at CDK synth time from `snitch/auth-config` |
| `ADMIN_GROUP_NAME` | `preTokenGenerationHandler` — plain string set at CDK synth time from `snitch/auth-config` |
| `AVP_POLICY_STORE_ID` | All AVP-touching handlers (create/update/delete policies, evaluate access, approve/reject/listPending) |
| `PRIVILEGED_POLICY_TABLE_NAME` | Privileged policy CRUD handlers + evaluateAccess |
| `APPROVAL_POLICY_TABLE_NAME` | `createApprovalPolicyHandler`, `deleteApprovalPolicyHandler` |
| `ACCESS_REQUEST_TABLE_NAME` | All access-request handlers |
| `APP_SETTINGS_TABLE_NAME` | `getSettingsHandler`, `updateSettingsHandler`, `getCloudTrailLogsHandler` |

### IAM Permissions

**Privileged policy handlers** (`create`, `update`, `delete`):
- `verifiedpermissions:CreatePolicy`, `UpdatePolicy`, `DeletePolicy` — scoped to policy store ARN
- `dynamodb:GetItem`, `PutItem`, `UpdateItem`, `DeleteItem`, `Scan` — scoped to `PrivilegedPolicy` table

**Approval policy handlers** (`createApprovalPolicy`, `deleteApprovalPolicy`):
- `verifiedpermissions:CreatePolicy`, `DeletePolicy` — scoped to policy store ARN
- `dynamodb:PutItem`, `DeleteItem`, `GetItem` — scoped to `ApprovalPolicy` table

**Approve/reject/listPending handlers**:
- `verifiedpermissions:IsAuthorized` — scoped to policy store ARN
- `dynamodb:GetItem`, `UpdateItem`, `Scan` — scoped to `AccessRequestTable`

**Settings handlers** (`getSettings`, `updateSettings`):
- `dynamodb:GetItem`, `PutItem` — scoped to `AppSettingsTable`

**CloudTrail logs handler** (`getCloudTrailLogs`):
- `dynamodb:GetItem` — scoped to `AppSettingsTable` (reads configured log group at runtime)
- `logs:FilterLogEvents` — scoped to `*` (log group is dynamic; determined at runtime from settings)

### Adding Access Evaluation

**`assume` check** (is IDC user allowed to access an account?):
- `principal`: `{ entityType: "Snitch::User", entityId: "<idc-user-id>" }`
- `action`: `{ actionType: "Snitch::Action", actionId: "assume" }`
- `resource`: `{ entityType: "Snitch::Account", entityId: "<account-id>" }`
- `context`: `{ contextMap: { permissionSetArn: { string: "<arn>" } } }`
- `entities`: IDC group memberships as `Snitch::User` → parents `Snitch::Group`

**`approve` check** (can a Cognito user approve a request for a given account + permission set?):
- `principal`: `{ entityType: "Snitch::Approver", entityId: "<cognito-username>" }`
- `action`: `{ actionType: "Snitch::Action", actionId: "approve" }`
- `resource`: `{ entityType: "Snitch::Account", entityId: "<account-id>" }`
- `context`: `{ contextMap: { permissionSetArn: { string: "<arn>" } } }`
- `entities`: Cognito group memberships as `Snitch::Approver` → parents `Snitch::ApproverGroup`

Both checks return `decision: "ALLOW"` or `"DENY"`. Always inject entity parents so group-based policies resolve correctly.

## Import Patterns

```typescript
// Amplify data client
import { generateClient } from "aws-amplify/data";
import type { Schema } from "../amplify/data/resource";

// Cloudscape — import per-component, not from index
import AppLayout from "@cloudscape-design/components/app-layout";
import Table from "@cloudscape-design/components/table";
import Pagination from "@cloudscape-design/components/pagination";
import TextFilter from "@cloudscape-design/components/text-filter";
import Textarea from "@cloudscape-design/components/textarea";

// Collection hooks — filtering, pagination, selection for client-side tables
import { useCollection } from "@cloudscape-design/collection-hooks";

// Routing — package is "react-router" (v7); react-router-dom no longer exists
import { Route, Routes, useNavigate, useLocation } from "react-router";
import { HashRouter } from "react-router";

// Amplify auth
import { useAuthenticator } from "@aws-amplify/ui-react";

// Src imports use the @/* alias
import App from "@/App";
import { formatDuration, todayDateStr, minutesToMaxDuration, maxDurationToMinutes } from "@/utils/duration";
import { accessRequestStatusType } from "@/utils/accessRequestStatus";
```

## UI Conventions

### Tables — `useCollection` pattern

All tables use `useCollection` from `@cloudscape-design/collection-hooks` for client-side filtering, pagination, and selection. The hook wires up three components at once and resets pagination automatically when items change.

```typescript
import { useCollection } from "@cloudscape-design/collection-hooks";
import TextFilter from "@cloudscape-design/components/text-filter";

const PAGE_SIZE = 10;

const { items, filterProps, paginationProps, collectionProps, actions, filteredItemsCount } =
  useCollection(allItems, {
    filtering: {
      filteringFunction: (item, text) => item.name.toLowerCase().includes(text.toLowerCase()),
      empty: <Box>No items found</Box>,
      noMatch: <Box>No matches</Box>,
    },
    pagination: { pageSize: PAGE_SIZE },
    selection: { trackBy: "id" },
  });

// In JSX:
// <Table {...collectionProps} items={items} selectionType="single" filter={<TextFilter {...filterProps} />} pagination={<Pagination {...paginationProps} />} />
```

- `collectionProps` — spread onto `<Table>`: handles selection, empty state, ref
- `filterProps` — spread onto `<TextFilter>`: manages `filteringText` and `onChange`
- `paginationProps` — spread onto `<Pagination>`: manages page index, count, onChange
- `actions.setSelectedItems([])` — clears selection (use after mutations instead of `setSelectedItems`)
- `actions.setCurrentPage(1)` — resets page (use after fetching fresh data)

**Duration display:** always use `formatDuration(minutes)` from `@/utils/duration` — never raw minutes. Displays as `45min`, `8h 30min`, or `2d 8h`.

## Code Style

### Functions & Files
- Functions: 4–20 lines. Split if longer.
- Files: under 500 lines. Split by responsibility.
- One responsibility per module; early returns over nested ifs; max 2 levels of indentation.

### Naming
- Names must be specific and unique. Avoid `data`, `handler`, `Manager`.
- Prefer names that return fewer than 5 grep hits in the codebase.
- Components: PascalCase (`TodoList.tsx`). Utilities: camelCase (`formatDate.ts`). Tests: `ComponentName.test.tsx`.

### Types
- Explicit types everywhere. No `any`, no untyped functions.
- TypeScript strict mode is enabled — honor it.

### Duplication
- No code duplication. Extract shared logic into a named function or module.

### Error Messages
```typescript
throw new Error(`Expected PrivilegedPolicy id to be a non-empty string, got: ${JSON.stringify(id)}`);
```

### Formatting
- Use Prettier for all formatting.

## Comments
- Write WHY, not WHAT.
- Docstrings on public functions: intent + one usage example.
- Reference issue numbers or commit SHAs when a line exists because of a specific bug or upstream constraint.

## Dependencies & Architecture
- Inject dependencies through constructor/parameter, not globals or module-level imports.
- Wrap third-party libraries (Amplify client, Cloudscape, AVP SDK) behind a thin interface when reuse or testing requires it.

## Testing Rules
- Every new function gets a test. Bug fixes get a regression test.
- Mock external I/O (Amplify API, DynamoDB, AVP SDK) with named fake classes, not inline stubs.
- Tests must be F.I.R.S.T: fast, independent, repeatable, self-validating, timely.
- `buildCedarPolicy` must be tested with unit tests covering: USER vs GROUP principal, accounts-only, OUs-only, mixed, empty resource lists.
- `buildApprovalCedarPolicy` must be tested with unit tests covering: USER vs GROUP principal, single ARN, multiple ARNs, different accounts, different ARN lists.
- Setup file: `src/test/setup.ts`. Test files: `.test.tsx` suffix.
- When a Lambda handler reads `process.env.X` at the module level (`const TABLE_NAME = process.env.X!`), set the env var **before** the `await import(...)` statement in the test file so the module-level constant captures the correct value. Tests that check `cmd.input.TableName` or similar will silently receive `undefined` otherwise.
- When testing components that render multiple Cloudscape modals (e.g. `ElevatedAccessPage` shows both a details modal and a revoke modal), use `screen.getByRole("dialog", { name: /title/i })` rather than `screen.getByRole("dialog")` to avoid ambiguous queries — Cloudscape keeps hidden modals in the DOM.

## State Management
- Use React hooks (`useState`, `useReducer`) for local state.
- Use context for global state when needed.
- Keep state as close to usage as possible.
- Use `useCallback` for memoized functions passed to child components.

## Logging
- Structured JSON for debugging and observability (e.g., CloudWatch logs).
- Plain text only for user-facing CLI output.

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
| `getSettings`, `updateSettings` | |
| `getCloudTrailLogs` | |

IAM grants and env vars for `data`-stack functions are set in `backend.ts` using the table values returned by `setupAccessRequestWorkflow()`, creating a one-directional dependency (`data` → `AccessRequestWorkflow`) that CloudFormation can resolve.

### Approval authorization — AVP-gated, not Cognito-group-gated

`listPendingApprovals`, `approveRequest`, and `rejectRequest` are authorized with `allow.authenticated()` (any logged-in user can call them). The Lambda handler is the enforcement point: it calls AVP `IsAuthorized` with the caller's Cognito username as a `Snitch::Approver` principal, the request's `accountId` as a `Snitch::Account` resource, and the request's `permissionSetArn` in context — injecting the caller's Cognito groups as `Snitch::ApproverGroup` parents so group-based approval policies resolve.

This means: non-admin users who are configured as approvers (via an `ApprovalPolicy` record) can access the `ApproveRequestsPage` and act on requests for the accounts and permission sets they're authorized for. Admins with no `ApprovalPolicy` entries will see an empty list.

The `ApproveRequestsPage` route has **no `AdminGuard`** — it is accessible to all authenticated users.

**AppSync identity — access token, not ID token.** AppSync forwards the Cognito **access token** to Lambda resolvers, not the ID token. The access token's claims only include `sub`, `cognito:groups`, and standard OIDC fields — custom attributes like `email` are absent.

For SAML-federated users (IDC), `event.identity.username` is the Cognito federated username in the format `idc_<samlNameId>`, where the NameID is the user's email. To recover the email, strip the `idc_` prefix:

```typescript
const IDC_USERNAME_PREFIX = "idc_";
const email = username.startsWith(IDC_USERNAME_PREFIX)
  ? username.slice(IDC_USERNAME_PREFIX.length)
  : undefined;
```

This pattern is used in `getMyIDCUserHandler.ts`. Never read `event.identity.claims["email"]` — it is absent from access tokens.

### `amplify/data/resource.ts` is the GraphQL contract

All AppSync queries/mutations and their Lambda resolvers are declared here. Adding a new Lambda-backed operation requires: (1) a function resource in a `resource.ts` file, (2) an entry in this schema, (3) import + registration in `backend.ts`, and (4) the IAM grants in `backend.ts`.

### `requesterCognitoSub` — self-approval guard on `AccessRequestItem`

`requestAccessHandler` captures `event.identity.username` (the requester's Cognito sub) at request-creation time and stores it as `requesterCognitoSub` on the DDB record. `approveRequestHandler` and `rejectRequestHandler` compare this value against `event.identity.username` of the approver and throw if they match — preventing a user from approving or rejecting their own request.

Email-based comparison does not work here: AppSync forwards access tokens, which never contain the `email` claim (see above). Using the Cognito sub from `identity.username` on both sides guarantees a reliable comparison with no extra API calls.

Old records written before this field was introduced will have `requesterCognitoSub` as `undefined`; both handlers guard the check with `if (request.requesterCognitoSub && ...)` so old items are not affected.

### App Settings — single-record DynamoDB table

Application-level configuration (e.g. the CloudTrail log group) is stored in `AppSettingsTable`, a CDK-managed DynamoDB table created directly in `backend.ts` via `backend.createStack("AppSettingsStack")`. The table uses `settingKey: STRING` as the partition key and a single record (`settingKey: "global"`) holds all settings fields.

`getAppSettings` / `updateAppSettings` are custom AppSync query/mutation backed by `getSettingsHandler` and `updateSettingsHandler` (both in `amplify/functions/settings/`). They always read/write the `settingKey: "global"` item — there is no pagination or list operation.

### CloudTrail audit trail in Elevated Access

`getCloudTrailLogsHandler` (in `amplify/functions/accessRequests/`) surfaces CloudTrail events for a specific request window:

1. Reads `cloudTrailLogGroupName` from `AppSettingsTable`. Returns `[]` if not configured.
2. Calls CloudWatch Logs `FilterLogEvents` with:
   - `startTime` / `endTime` sourced from `activatedAt` / `deactivatedAt` on the `AccessRequestItem` — the actual timestamps written by `assignPermissionSetHandler` and `removePermissionSetHandler`. Falls back to `startTime → createdAt` for start and `durationMinutes`-computed end for older records that pre-date these fields.
   - `filterPattern: ?"<idcUserEmail>"` — text search that matches any CloudTrail event whose JSON message contains the requester's email. This catches `AssumedRole` sessions from SSO where `userIdentity.arn` takes the form `arn:aws:sts::ACCOUNT:assumed-role/AWSReservedSSO_PermissionSet_HASH/<email>` — equivalent to CloudTrail Insights `WHERE userIdentity.arn LIKE '%<email>%'`.
3. Parses each `event.message` as a CloudTrail event (bare JSON or `{Records:[...]}` wrapper), extracts standard fields, and returns up to 1000 events.

The Lambda is granted `logs:FilterLogEvents` on `*` because the log group name is runtime-dynamic (admin-configured). The `ElevatedAccessPage → RequestDetailsModal` opens when an admin clicks "View Details" on a selected request and loads logs using `idcUserEmail` from the `AccessRequestItem`.

### `revokeComment` — admin audit field on `AccessRequestItem`

When an admin revokes an ACTIVE request via the Elevated Access page, an optional `revokeComment` is written to the DDB record in the same atomic `UpdateCommand` that clears the task token. It surfaces as a "Revoke reason" column in the Elevated Access table. The `revokeAccess` mutation accepts `revokeComment` as an optional argument; `revokeAccessHandler.ts` persists it and returns it in the response.

### Max Duration — stored as total minutes, entered as date + time

`PrivilegedPolicy.maxDurationMinutes` stores a total-minute integer. The form UI uses a `DatePicker` + `TimeInput` pair where the date defaults to today and can be up to 1 year in the future. The helpers in `src/utils/duration.ts` convert between the two representations:

- `maxDurationToMinutes(date, time)` — DatePicker `YYYY-MM-DD` + TimeInput `hh:mm` → minutes (used on save)
- `minutesToMaxDuration(minutes)` → `{ date, time }` relative to today (used to populate the edit form)
- `todayDateStr()` — returns today as `YYYY-MM-DD` (the format Cloudscape `DatePicker` uses internally; displayed as `YYYY/MM/DD` in the UI)

`formatDuration(minutes)` in the same file renders stored minutes as a human-readable label (`45min`, `8h 30min`, `2d 8h`) and is used in every table that shows a duration column.

### Request Duration — date + time picker, computed from now

`RequestAccessPage` uses the same `DatePicker` + `TimeInput` pattern for the **Duration** field. The date defaults to today; the user selects a date and time that represents **when their access should end**. `durationMinutes` is computed as `Math.round((selectedDateTime - Date.now()) / 60000)` — minutes from now to that point — before being submitted to `requestAccess`. This allows durations beyond 24 hours without a separate day input.

The computed minutes are validated against `permittedEntry.maxDurationMinutes` from `evaluateMyAccess` before submission.

### `activatedAt` / `deactivatedAt` — actual assignment timestamps on `AccessRequestItem`

Two audit fields track the real wall-clock times of permission set assignment and removal:

| Field | Written by | Value |
|---|---|---|
| `activatedAt` | `assignPermissionSetHandler` | ISO timestamp when `CreateAccountAssignment` succeeds |
| `deactivatedAt` | `removePermissionSetHandler` | ISO timestamp when `DeleteAccountAssignment` succeeds |

These are distinct from `startTime` (the user-requested scheduled start) and `durationMinutes` (the originally requested duration). The `ElevatedAccessPage → RequestDetailsModal` uses them as the authoritative CloudTrail query window. Older records without these fields fall back to the `startTime → createdAt` + `durationMinutes` computation.

### `listAWSAccounts` — open to all authenticated users

`listAWSAccounts` is authorized with `allow.authenticated()` so non-admin users can resolve account names in the `RequestAccessPage` account dropdown. The query returns all accounts in the AWS Organization, but account names only appear in the dropdown for accounts that `evaluateMyAccess` already permitted — so there is no functional access expansion. The trade-off is that any authenticated user can enumerate all org account names by calling the query directly.

### `accessRequestStatusType` — shared status → indicator type mapping

`src/utils/accessRequestStatus.ts` exports `accessRequestStatusType(status)` which maps an `AccessRequestItem` status string to a Cloudscape `StatusIndicatorProps.Type`. Both `RequestAccessPage` and `ElevatedAccessPage` import this instead of defining their own switch.
