---
title: Privileged Policies
layout: default
nav_order: 4
---

# Privileged Policies
{: .no_toc }

## Table of Contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Overview

A **Privileged Policy** grants an IAM Identity Center (IDC) principal — either a user or a group — the ability to request temporary access to one or more AWS accounts and/or Organizational Units (OUs) using a specific Permission Set.

Each policy is stored in two places:
- **DynamoDB** (`PrivilegedPolicy` table) — application metadata
- **AWS Verified Permissions** — the Cedar `permit` statement (authoritative for access decisions)

---

## Policy Fields

| Field | Type | Description |
|---|---|---|
| `id` | string | UUID (auto-generated) |
| `principalType` | `USER` \| `GROUP` | IDC user or IDC group |
| `principalId` | string | IDC user/group ID |
| `principalDisplayName` | string | Human-readable label (denormalized) |
| `permissionSetArn` | string | The Permission Set ARN to assign |
| `permissionSetName` | string | Display name (denormalized) |
| `accountIds` | string[] | Allowed AWS account IDs |
| `ouIds` | string[] | Allowed Organizational Unit IDs |
| `maxDurationMinutes` | number | Maximum request duration in minutes |
| `requiresApproval` | boolean | Whether access requests require an approver |
| `avpPolicyId` | string | Foreign key to the Cedar policy in AVP |

---

## Conflict Enforcement

Only one policy is allowed per `(principal, resource)` combination. `policyConflictChecker.ts` is called at the top of both `createPrivilegedPolicyHandler` and `updatePrivilegedPolicyHandler` — before any AVP or DDB writes — and scans for existing policies with the same `principalId` and overlapping `accountIds`/`ouIds`.

The frontend (`PrivilegedPoliciesPage.tsx → validate()`) performs the same check against locally loaded state for immediate UX feedback, but the backend check is authoritative.

---

## Cedar Policy Shape

`buildCedarPolicy` in `amplify/functions/verifiedPermissions/cedarPolicyBuilder.ts` generates the Cedar `permit` statement:

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

For group-scoped policies, `principal == Snitch::User::"..."` is replaced with `principal in Snitch::Group::"..."`.

---

## CRUD Operations

All mutations are AppSync custom resolvers backed by Lambda handlers in `amplify/functions/verifiedPermissions/`.

| Operation | Handler | Write Order |
|---|---|---|
| Create | `createPrivilegedPolicyHandler.ts` | AVP first → DynamoDB |
| Update | `updatePrivilegedPolicyHandler.ts` | DynamoDB first → AVP |
| Delete | `deletePrivilegedPolicyHandler.ts` | DynamoDB first → AVP |

The compensating-transaction ordering ensures that on partial failure, the rollback target is always reachable.

---

## Max Duration

`maxDurationMinutes` stores the total duration as a plain integer (minutes). The UI uses a `DatePicker` + `TimeInput` pair where the selected date/time represents the future expiry point. The helpers in `src/utils/duration.ts` convert between the two representations:

- `maxDurationToMinutes(date, time)` → total minutes (used on save)
- `minutesToMaxDuration(minutes)` → `{ date, time }` relative to today (used to populate the edit form)
- `formatDuration(minutes)` → human-readable label: `45min`, `8h 30min`, `2d 8h`

---

## Requires Approval

Setting `requiresApproval: true` on a policy activates the approval gate for all access requests targeting that policy's `(accountId, permissionSetArn)` pair:

1. `evaluateMyAccess` returns `requiresApproval: true` for the pair.
2. The Request Access form shows an info alert.
3. On submission, the request is created with `status: "PENDING_APPROVAL"` and the Step Function pauses at the `WaitForApproval` state.

**Who can approve** is configured separately in the [Approval Workflow]({% link pages/approval-workflow.md %}) section.

---

## Access Control

The `PrivilegedPolicy` model is restricted to the **`Admins`** Cognito group. Non-admin users cannot list, create, update, or delete policies.
