---
title: Elevated Access
layout: default
nav_order: 8
---

# Elevated Access (Admin)
{: .no_toc }

## Table of Contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Overview

The **Elevated Access** page is an admin-only view that gives administrators complete visibility into all JIT access requests across all users, with the ability to revoke active sessions early and inspect the associated CloudTrail audit trail.

Access to this page requires membership in the **`Admins`** Cognito group.

---

## Features

### View All Requests

`listAllAccessRequests` returns every `AccessRequestItem` across all users, sorted newest-first. Admins can filter and search by any field.

### Revoke Active Sessions

Admins can select any `ACTIVE` request and revoke it before its natural expiry. The revocation flow:

1. Admin submits a revoke action with an optional comment via the `revokeAccess` mutation.
2. `revokeAccessHandler` calls `SendTaskSuccess` on the Step Functions task token stored during `WaitForEarlyRevocation`, passing `revokedByAdmin: true`.
3. The state machine immediately transitions to `RemovePermissionSet`.
4. `removePermissionSetHandler` deletes the SSO account assignment, writes `deactivatedAt`, and sets the status to `REVOKED`.

The optional `revokeComment` is stored atomically on the `AccessRequestItem` and surfaced as a "Revoke reason" column in the table.

### CloudTrail Audit Trail

Admins can open a details panel for any selected request to view the associated CloudTrail events.

The `getCloudTrailLogs` mutation:

1. Reads `cloudTrailLogGroupName` from `AppSettingsTable`. Returns `[]` if not configured.
2. Calls CloudWatch Logs `FilterLogEvents` with:
   - `startTime` / `endTime` from `activatedAt` / `deactivatedAt` (falls back to `createdAt` + `durationMinutes` for older records)
   - `filterPattern: ?"<idcUserEmail>"` — matches any CloudTrail event whose JSON contains the requester's email address
3. Parses each `event.message` as a CloudTrail event (bare JSON or `{Records:[...]}` wrapper) and returns up to 1,000 events.

The filter pattern catches `AssumedRole` sessions from SSO, where `userIdentity.arn` takes the form:

```
arn:aws:sts::ACCOUNT:assumed-role/AWSReservedSSO_PermissionSet_HASH/<email>
```

---

## `revokeAccess` Mutation

```graphql
revokeAccess(requestId: String!, revokeComment: String): AccessRequestItem
```

The `revokeComment` argument is optional and written atomically alongside the task token clearance.

---

## Lambda Handlers

| Handler | Purpose |
|---|---|
| `listAllAccessRequestsHandler.ts` | Returns all requests across all users (admin-only, newest first) |
| `revokeAccessHandler.ts` | Signals `WaitForEarlyRevocation` via `SendTaskSuccess`; persists optional `revokeComment` |
| `getCloudTrailLogsHandler.ts` | Reads configured log group; calls CloudWatch Logs `FilterLogEvents`; returns parsed events |

---

## IAM Permissions

| Handler | Required permissions |
|---|---|
| `listAllAccessRequests` | `dynamodb:Scan` on `AccessRequestTable` |
| `revokeAccess` | `dynamodb:GetItem`, `UpdateItem` on `AccessRequestTable`; `states:SendTaskSuccess` |
| `getCloudTrailLogs` | `dynamodb:GetItem` on `AppSettingsTable`; `logs:FilterLogEvents` on `*` |

`logs:FilterLogEvents` is scoped to `*` because the log group name is runtime-dynamic (configured by the admin in Settings).

---

## Prerequisites

The CloudTrail audit trail requires:

1. CloudTrail enabled for the AWS account, delivering events to a CloudWatch log group.
2. The log group name configured in the [Settings]({% link pages/settings.md %}) page.

Without a configured log group, `getCloudTrailLogs` returns an empty array.
