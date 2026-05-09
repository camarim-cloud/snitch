---
title: Approval Workflow
layout: default
nav_order: 6
---

# Approval Workflow
{: .no_toc }

## Table of Contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Overview

Each `PrivilegedPolicy` can optionally require approval before access is granted via the `requiresApproval` boolean field. **Who can approve** is configured separately in the `ApprovalPolicy` model, which maps a Cognito user or group to a specific AWS account with required Permission Set conditions.

---

## Approval Policy

An `ApprovalPolicy` record defines a single approver for a specific AWS account. It is backed by a Cedar `approve` policy in AVP and lives in its own DynamoDB table.

### Fields

| Field | Type | Purpose |
|---|---|---|
| `accountId` | string | The AWS account the approver can act on (PK hash key) |
| `principalKey` | string | Composite sort key: `"${principalType}#${principalId}"` |
| `accountName` | string | Display name (denormalized) |
| `principalType` | `USER` \| `GROUP` | Cognito user or Cognito group |
| `principalId` | string | Cognito username (USER) or Cognito group name (GROUP) |
| `principalDisplayName` | string | Human-readable label |
| `permissionSetArns` | string[] | Permission set ARNs in the Cedar `when` clause (≥1 required) |
| `permissionSetNames` | string[] | Display names (parallel array, denormalized) |
| `avpPolicyId` | string | Foreign key to the Cedar `approve` policy in AVP |

The composite primary key `[accountId, principalKey]` enables O(1) duplicate checks with no GSI or scan.

---

## Cedar Policy Shape

`buildApprovalCedarPolicy` in `amplify/functions/verifiedPermissions/buildApprovalCedarPolicy.ts` generates the Cedar `permit` statement.

**USER approver:**

```cedar
permit (
  principal == Snitch::Approver::"alice",
  action == Snitch::Action::"approve",
  resource == Snitch::Account::"111111111111"
) when {
  ["arn:aws:sso:::permissionSet/ps-1", "arn:aws:sso:::permissionSet/ps-2"].contains(context.permissionSetArn)
};
```

**GROUP approver:**

```cedar
permit (
  principal in Snitch::ApproverGroup::"Approvers",
  action == Snitch::Action::"approve",
  resource == Snitch::Account::"111111111111"
) when {
  ["arn:aws:sso:::permissionSet/ps-1"].contains(context.permissionSetArn)
};
```

---

## Workflow: Step Functions States

```
CheckApproval (Choice)
  requiresApproval = true  →  WaitForApproval (waitForTaskToken, HeartbeatSeconds: 86400)
  default                  →  CheckStartTime

WaitForApproval
  SendTaskSuccess           →  CheckStartTime (approved)
  "RequestRejected"         →  RejectionHandled (Pass — DDB already REJECTED)
  States.HeartbeatTimeout   →  SetStatusExpired (DDB SDK state, no Lambda)
  States.ALL                →  SetStatusFailed
```

The 24-hour heartbeat (`HeartbeatSeconds: 86400`) acts as a timeout — if no approver acts within 24 hours, the request expires automatically.

---

## Approve Requests Page

Any authenticated user can access the `ApproveRequestsPage`. Access is controlled by AVP `IsAuthorized`, not by Cognito group membership. This means:

- Non-admin users configured as approvers can view and act on pending requests for their authorized accounts.
- Admins with no `ApprovalPolicy` entries will see an empty list.

The route has **no `AdminGuard`**.

### Authorization Check

`listPendingApprovals`, `approveRequest`, and `rejectRequest` all call AVP `IsAuthorized` with:

- **Principal:** `Snitch::Approver::"<cognito-username>"`
- **Action:** `Snitch::Action::"approve"`
- **Resource:** `Snitch::Account::"<accountId>"`
- **Context:** `{ permissionSetArn: "<arn>" }`
- **Entities:** caller's Cognito groups injected as `Snitch::ApproverGroup` parents

---

## Lambda Handlers

| Handler | Stack | Purpose |
|---|---|---|
| `storeApprovalTokenHandler.ts` | AccessRequestWorkflow | Called by `WaitForApproval`; stores task token, sets `PENDING_APPROVAL` |
| `approveRequestHandler.ts` | data | Guards self-approval; checks AVP `IsAuthorized`; calls `SendTaskSuccess` |
| `rejectRequestHandler.ts` | data | Guards self-rejection; checks AVP `IsAuthorized`; sets `REJECTED`, calls `SendTaskFailure` |
| `listPendingApprovalsHandler.ts` | data | Scans `PENDING_APPROVAL` requests; filters by AVP per `(accountId, permissionSetArn)` |
| `createApprovalPolicyHandler.ts` | data | Creates `ApprovalPolicy` DDB record + AVP `approve` policy (AVP first) |
| `deleteApprovalPolicyHandler.ts` | data | Deletes `ApprovalPolicy` DDB record + AVP `approve` policy (DDB first) |

---

## Managing Approval Policies

Approval policies are managed via the **Approval Policy** page (admin-only). Operations are delete-and-recreate — there is no update mutation. The UI provides:

- A list of configured approvers per account
- A form to add a new approver with permission set conditions
- A delete action that removes the DDB record and AVP policy atomically
