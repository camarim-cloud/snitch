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
- Elevated Access page (admin-only): view all requests across all users and revoke any ACTIVE request early
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
│   ├── auth/resource.ts        # Cognito config; defines the "Admins" user pool group
│   ├── data/resource.ts        # AppSync schema: PrivilegedPolicy model + AVP-backed mutations
│   ├── backend.ts              # CDK wiring: AVP policy store, IAM grants, env vars
│   └── functions/
│       ├── awsResources/       # Lambda resolvers: list IDC users/groups, accounts, OUs, permission sets
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
│   │   └── duration.ts         # Shared: todayDateStr, minutesToMaxDuration, maxDurationToMinutes, formatDuration
│   ├── types/                  # Shared TypeScript types
│   ├── pages/
│   │   ├── PrivilegedPoliciesPage.tsx  # Admin CRUD for privileged policies (requiresApproval toggle only)
│   │   ├── ApprovalPolicyPage.tsx      # Admin: configure per-account approvers with permission set conditions
│   │   ├── RequestAccessPage.tsx       # End-user JIT access request form + request history
│   │   ├── ApproveRequestsPage.tsx     # Any authenticated approver: review, approve, or reject pending requests
│   │   └── ElevatedAccessPage.tsx      # Admin page: view all requests, revoke ACTIVE ones early
│   ├── test/
│   │   └── setup.ts            # Vitest setup (jest-dom matchers)
│   ├── App.tsx
│   └── main.tsx                # Entry point with Amplify config
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
| `assignPermissionSetHandler.ts` | AccessRequestWorkflow | Creates SSO account assignment, sets `ACTIVE` |
| `removePermissionSetHandler.ts` | AccessRequestWorkflow | Deletes SSO account assignment; sets `REVOKED` if `revokedByAdmin: true`, otherwise `EXPIRED` |
| `setStatusFailedHandler.ts` | AccessRequestWorkflow | Sets `FAILED` on unrecoverable workflow errors |
| `requestAccessHandler.ts` | AccessRequestWorkflow | Persists the request (including `requesterCognitoSub`) and starts the state machine |
| `listAccessRequestsHandler.ts` | AccessRequestWorkflow | Returns all requests for a given IDC user (newest first, via GSI) |
| `approveRequestHandler.ts` | data | Guards self-approval via `requesterCognitoSub`; checks AVP `IsAuthorized` (approve/Account + permissionSetArn context); calls `SendTaskSuccess` to resume state machine |
| `rejectRequestHandler.ts` | data | Guards self-rejection via `requesterCognitoSub`; checks AVP `IsAuthorized` (approve/Account + permissionSetArn context); sets `REJECTED` atomically, calls `SendTaskFailure` |
| `listPendingApprovalsHandler.ts` | data | Scans `PENDING_APPROVAL` requests; filters by AVP `IsAuthorized` per unique `(accountId, permissionSetArn)` pair |
| `listAllAccessRequestsHandler.ts` | data | Returns all requests across all users (admin-only, newest first) |
| `revokeAccessHandler.ts` | data | Signals `WaitForEarlyRevocation` via `SendTaskSuccess`; persists optional `revokeComment` for audit |

`approveRequest`, `rejectRequest`, `listPendingApprovals`, `listAllAccessRequests`, `revokeAccess` are in the `data` stack (`resourceGroupName: "data"`) — see `CLAUDE.md` for why.

`createApprovalPolicyHandler.ts` and `deleteApprovalPolicyHandler.ts` are also in the `data` stack (AppSync-backed). They keep the `ApprovalPolicy` DynamoDB table and AVP Cedar policies in sync (create: AVP first → DDB; delete: DDB first → AVP).

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
| `AVP_POLICY_STORE_ID` | All AVP-touching handlers (create/update/delete policies, evaluate access, approve/reject/listPending) |
| `PRIVILEGED_POLICY_TABLE_NAME` | Privileged policy CRUD handlers + evaluateAccess |
| `APPROVAL_POLICY_TABLE_NAME` | `createApprovalPolicyHandler`, `deleteApprovalPolicyHandler` |
| `ACCESS_REQUEST_TABLE_NAME` | All access-request handlers |

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

## State Management
- Use React hooks (`useState`, `useReducer`) for local state.
- Use context for global state when needed.
- Keep state as close to usage as possible.
- Use `useCallback` for memoized functions passed to child components.

## Logging
- Structured JSON for debugging and observability (e.g., CloudWatch logs).
- Plain text only for user-facing CLI output.
