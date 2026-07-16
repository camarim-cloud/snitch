---
title: AWS Verified Permissions
layout: default
nav_order: 10
---

# AWS Verified Permissions
{: .no_toc }

## Table of Contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Overview

AWS Verified Permissions (AVP) is the authoritative source for all access decisions in Snitch. Every `PrivilegedPolicy` and `ApprovalPolicy` record is mirrored as a Cedar policy in the AVP policy store, which uses **STRICT** schema validation against the `Snitch` Cedar namespace.

DynamoDB is the application record; AVP is the enforcement point.

---

## Cedar Schema (`Snitch` Namespace)

### `assume` action

Controls whether an IDC principal can request access to an AWS account with a specific Permission Set.

| Element | Type |
|---|---|
| Principal | `Snitch::User` (memberOf `Snitch::Group`) \| `Snitch::Group` |
| Resource | `Snitch::Account` (memberOf `Snitch::OU`) \| `Snitch::OU` |
| Action | `Snitch::Action::"assume"` |
| Context | `{ permissionSetArn: String (required) }` |

### `approve` action

Controls whether a Cognito principal can approve a JIT access request for an AWS account.

| Element | Type |
|---|---|
| Principal | `Snitch::Approver` (memberOf `Snitch::ApproverGroup`) \| `Snitch::ApproverGroup` |
| Resource | `Snitch::Account` |
| Action | `Snitch::Action::"approve"` |
| Context | `{ permissionSetArn: String (required) }` |

The `assume` and `approve` actions use **different principal namespaces** — IDC IDs for `assume`, Cognito identifiers for `approve` — to avoid conflating the two identity systems.

---

## Policy Lifecycle

| Mutation | Write Order | Rollback |
|---|---|---|
| Create (privileged or approval) | AVP first → DynamoDB | Delete AVP policy |
| Update (privileged only) | DynamoDB first → AVP | Restore DynamoDB snapshot |
| Delete (both types) | DynamoDB first → AVP | Restore DynamoDB snapshot |

---

## `assume` Authorization Check

Used by `evaluateAccessHandler` to determine which `(accountId, permissionSetArn)` pairs a user is permitted to access.

```typescript
// Input to AVP IsAuthorized
{
  principal: { entityType: "Snitch::User", entityId: "<idc-user-id>" },
  action:    { actionType: "Snitch::Action", actionId: "assume" },
  resource:  { entityType: "Snitch::Account", entityId: "<account-id>" },
  context:   { contextMap: { permissionSetArn: { string: "<arn>" } } },
  entities:  // IDC group memberships as Snitch::User → parents Snitch::Group
}
```

Group parents must be injected so `principal in Snitch::Group::"..."` policies resolve correctly.

---

## `approve` Authorization Check

Used by `approveRequestHandler`, `rejectRequestHandler`, and `listPendingApprovalsHandler`.

```typescript
// Input to AVP IsAuthorized
{
  principal: { entityType: "Snitch::Approver", entityId: "<cognito-username>" },
  action:    { actionType: "Snitch::Action", actionId: "approve" },
  resource:  { entityType: "Snitch::Account", entityId: "<account-id>" },
  context:   { contextMap: { permissionSetArn: { string: "<arn>" } } },
  entities:  // Cognito group memberships as Snitch::Approver → parents Snitch::ApproverGroup
}
```

---

## Cedar Policy Builders

### `buildCedarPolicy` — `assume` statement

Located at `amplify/functions/verifiedPermissions/cedarPolicyBuilder.ts`.

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

Groups use `principal in Snitch::Group::"<id>"`.

### `buildApprovalCedarPolicy` — `approve` statement

Located at `amplify/functions/verifiedPermissions/buildApprovalCedarPolicy.ts`.

```cedar
// USER approver
permit (
  principal == Snitch::Approver::"alice",
  action == Snitch::Action::"approve",
  resource == Snitch::Account::"111111111111"
) when {
  ["arn:aws:sso:::permissionSet/ps-1"].contains(context.permissionSetArn)
};

// GROUP approver
permit (
  principal in Snitch::ApproverGroup::"Approvers",
  action == Snitch::Action::"approve",
  resource == Snitch::Account::"111111111111"
) when {
  ["arn:aws:sso:::permissionSet/ps-1"].contains(context.permissionSetArn)
};
```

---

## Environment Variable

All Lambda handlers that touch AVP read the policy store ID from:

```
AVP_POLICY_STORE_ID
```

This is set as an environment variable in `amplify/backend.ts` for each relevant function.

---

## IAM Permissions

| Handlers | Required AVP actions |
|---|---|
| Create policy | `verifiedpermissions:CreatePolicy` |
| Update policy | `verifiedpermissions:UpdatePolicy` |
| Delete policy | `verifiedpermissions:DeletePolicy` |
| Evaluate access / approve | `verifiedpermissions:IsAuthorized` |

All scoped to the policy store ARN.
