---
title: Access Requests
layout: default
nav_order: 5
---

# Access Requests
{: .no_toc }

## Table of Contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Overview

Any authenticated user can request temporary, time-boxed access to an AWS account. The request triggers a Step Functions workflow that assigns the Permission Set via the SSO Admin API, waits for the requested duration, then revokes it automatically.

---

## Request Lifecycle

```
requestAccess mutation
  └─ Persist AccessRequest (status: PENDING or PENDING_APPROVAL)
  └─ Start Step Functions execution
        ├─ CheckApproval
        │     requiresApproval = true → WaitForApproval (24h heartbeat)
        │     default              → CheckStartTime
        ├─ CheckStartTime
        │     startTime present → SetStatusScheduled → WaitUntilStartTime → AssignPermissionSet
        │     default           → AssignPermissionSet
        ├─ AssignPermissionSet  →  SSO CreateAccountAssignment  →  status: ACTIVE
        ├─ WaitForEarlyRevocation (waitForTaskToken, TimeoutSecondsPath: durationSeconds)
        │     SendTaskSuccess (admin revoke) → RemovePermissionSet (revokedByAdmin: true)
        │     States.Timeout (natural expiry) → RemovePermissionSet
        └─ RemovePermissionSet  →  SSO DeleteAccountAssignment
              revokedByAdmin = true → status: REVOKED
              no flag              → status: EXPIRED
```

---

## Request Statuses

| Status | Meaning |
|---|---|
| `PENDING` | No approval required; waiting for Step Functions to assign the permission set |
| `PENDING_APPROVAL` | Waiting for an approver to act; Step Function paused at `WaitForApproval` |
| `SCHEDULED` | Approved but waiting for a future start time |
| `ACTIVE` | Permission set assigned; Step Function paused at `WaitForEarlyRevocation` |
| `EXPIRED` | Duration elapsed naturally or 24-hour approval timeout fired |
| `REVOKED` | Admin revoked the request early via the Elevated Access page |
| `REJECTED` | An approver rejected the request |
| `FAILED` | Unrecoverable error in the workflow |

---

## Step Functions State Machine

### `WaitForEarlyRevocation`

Replaces the old plain `Wait` state. Uses `waitForTaskToken` with `TimeoutSecondsPath: "$.durationSeconds"` so it can be interrupted:

- **`States.Timeout`** (natural expiry after `durationSeconds`) → `RemovePermissionSet` with no flag → sets status `EXPIRED`
- **`SendTaskSuccess`** from `revokeAccessHandler` → `RemovePermissionSet` with `revokedByAdmin: true` → sets status `REVOKED`

`storeActiveTokenHandler` runs when this state is entered; it stores the task token in DDB so `revokeAccessHandler` can call `SendTaskSuccess` later.

### `SetStatusExpired`

A Step Functions DynamoDB SDK integration state (no Lambda). It only needs `$.requestId` from the execution context and writes `EXPIRED` directly via `arn:aws:states:::aws-sdk:dynamodb:updateItem`.

---

## Lambda Handlers

| Handler | Purpose |
|---|---|
| `requestAccessHandler.ts` | Persists the request (including `requesterCognitoSub`) and starts the state machine |
| `listAccessRequestsHandler.ts` | Returns all requests for a given IDC user (newest first, via GSI) |
| `storeApprovalTokenHandler.ts` | Called by `WaitForApproval`; stores task token, sets `PENDING_APPROVAL` |
| `storeActiveTokenHandler.ts` | Called by `WaitForEarlyRevocation`; stores task token while request is `ACTIVE` |
| `assignPermissionSetHandler.ts` | Creates SSO account assignment, sets `ACTIVE`, writes `activatedAt` timestamp |
| `removePermissionSetHandler.ts` | Deletes SSO account assignment; sets `REVOKED` or `EXPIRED`; writes `deactivatedAt` timestamp |
| `setStatusFailedHandler.ts` | Sets `FAILED` on unrecoverable workflow errors |

---

## Access Evaluation

Before a user can submit a request, the `evaluateMyAccess` GraphQL query determines which `(accountId, permissionSetArn)` pairs the caller is permitted to access:

1. Resolves the caller's IDC user ID via their Cognito email.
2. Fetches all IDC group memberships.
3. Scans every `PrivilegedPolicy` to build candidate pairs.
4. Calls AVP `IsAuthorized` in parallel for each candidate, injecting group parents so group-scoped Cedar policies resolve.
5. Returns only ALLOW pairs — these drive the account and permission-set dropdowns.

---

## Duration Input

The **Duration** field uses a `DatePicker` + `TimeInput` pair. The selected date/time represents **when access should end**. `durationMinutes` is computed as:

```
Math.round((selectedDateTime - Date.now()) / 60000)
```

The computed value is validated against `permittedEntry.maxDurationMinutes` from `evaluateMyAccess` before submission.

---

## `activatedAt` / `deactivatedAt`

Two audit fields track the real wall-clock times of permission set assignment and removal:

| Field | Written by | Value |
|---|---|---|
| `activatedAt` | `assignPermissionSetHandler` | ISO timestamp when `CreateAccountAssignment` succeeds |
| `deactivatedAt` | `removePermissionSetHandler` | ISO timestamp when `DeleteAccountAssignment` succeeds |

These are distinct from `startTime` (user-requested start) and `durationMinutes` (originally requested duration). The Elevated Access page uses them as the authoritative CloudTrail query window.

---

## Self-Approval Guard

`requestAccessHandler` captures `event.identity.username` (Cognito sub) at creation time as `requesterCognitoSub`. `approveRequestHandler` and `rejectRequestHandler` compare this value against the approver's `event.identity.username` and throw if they match — preventing a user from approving or rejecting their own request.

Old records without this field are not affected — both handlers check `if (request.requesterCognitoSub && ...)` before comparing.
