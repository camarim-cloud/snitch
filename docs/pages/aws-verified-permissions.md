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

Controls whether a principal can approve a JIT access request for an AWS account.

| Element | Type |
|---|---|
| Principal | `Snitch::Approver` (memberOf `Snitch::ApproverGroup`) \| `Snitch::ApproverGroup` |
| Resource | `Snitch::Account` |
| Action | `Snitch::Action::"approve"` |
| Context | `{ permissionSetArn: String (required) }` |

**Groups always come from IAM Identity Center.** Snitch does not use Cognito user-pool groups anywhere. The pre-token-generation trigger populates the `cognito:groups` claim with the user's immutable **IDC GroupIds**, so both `Snitch::Group` (for `assume`) and `Snitch::ApproverGroup` (for `approve`) key on the same IDC GroupIds — a group grant works identically for requesting and approving.

The `assume` and `approve` actions keep **separate Cedar entity types** only because they identify an *individual* user differently: `assume` by the user's **IDC user ID**, `approve` by the caller's **Cognito sign-in username** (`idc_<email>` for SAML-federated users). Group identity is IDC in both cases.

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
  entities:  // caller's IDC GroupIds (from the cognito:groups claim) as Snitch::Approver → parents Snitch::ApproverGroup
}
```

The **Slack approval path** (`slackInteractiveHandler`) builds the same check. It resolves the approver's Cognito username for the `Snitch::Approver` principal, then resolves the approver's **IDC GroupIds** by email from IAM Identity Center — exactly like `preTokenGenerationHandler` does for the web path — and passes them as `Snitch::ApproverGroup` parents. It reads no Cognito user-pool groups, so a GROUP approval policy authorizes the same approver identically over Slack and the web.

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

// GROUP approver — the principal id is the immutable IDC GroupId
permit (
  principal in Snitch::ApproverGroup::"a1b2c3d4-e5f6-7890-abcd-ef1234567890",
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
