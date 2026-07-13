---
title: Notifications
layout: default
nav_order: 10
---

# Notifications
{: .no_toc }

## Table of Contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Overview

Snitch can notify a team channel or mailing list about the access-request lifecycle through two independent delivery channels — **Slack** and **Amazon SNS** — configured on the [Settings]({% link pages/settings.md %}) page (admin-only). Every notification is **best-effort**: a delivery failure is logged and swallowed, and never fails the underlying access-request workflow.

Three events can produce a notification:

| Event | When it fires | Channels |
|---|---|---|
| **Access requested** | A user submits a request (status becomes `PENDING`, `PENDING_APPROVAL`, or `SCHEDULED`) | Slack, SNS |
| **Access finished** | A granted session ends — `EXPIRED` (natural expiry) or `REVOKED` (admin revoke) | Slack, SNS |
| **Approval required** | A request enters `PENDING_APPROVAL` | Slack (interactive), SNS (link-to-app) |

Each channel is gated by its own toggle in Settings, so an admin can enable, for example, SNS for finished sessions and Slack for approvals independently.

---

## Delivery channels

### Slack

- **Access requested / finished** — an informational Block Kit message is posted to the configured Slack channel when `slackNotificationsEnabled` is on and a Slack Bot Token + Channel ID are configured.
- **Approval required** — a Block Kit message with **Approve** / **Reject** buttons is always posted (independent of the notification toggles) so Slack-based approvers can act directly from the message. See the [Approval Workflow]({% link pages/approval-workflow.md %}) for how the button click is authenticated and authorized.

The `slackNotificationsEnabled` toggle controls **only** the requested/finished messages — it never disables the interactive approval message.

### Amazon SNS

SNS uses a single **app-managed topic** (`AccessNotificationsTopic`) created by CDK. Admins subscribe email or SMS endpoints to it **manually** in the AWS console; the topic ARN is shown read-only on the Settings page so it can be copied.

- **Access requested / finished** — published when `snsNotificationsEnabled` is on.
- **Approval required** — published when `snsApprovalNotificationsEnabled` is on. Because an SNS email cannot identify or authorize the recipient who clicks a link, the message does **not** carry one-click approve/reject actions. Instead it links to the in-app **Approve Requests** page (`<APP_CALLBACK_URL>#/approve-requests`), where the approver signs in and acts with full AWS Verified Permissions authorization.

#### Subscribing an endpoint

1. Deploy the backend (`npm run sandbox`) so the topic exists.
2. In **Settings → Access-Request Notifications**, copy the **SNS Topic ARN**.
3. In the AWS console: **SNS → Topics → \<topic\> → Create subscription** → protocol `Email` (or `SMS`) → your endpoint.
4. Confirm the subscription from the confirmation email.
5. Enable the relevant SNS toggle(s) in Settings.

#### Email subject lines

SNS email subjects are dynamic and include the account label (`name (id)`), capped at SNS's 100-character limit:

| Event | Subject |
|---|---|
| Access requested | `AWS access session started - <accountName> (<accountId>)` |
| Access finished | `AWS access session finished - <accountName> (<accountId>)` |
| Approval required | `AWS access approval required - <accountName> (<accountId>)` |

---

## Settings

The toggles and Slack fields live on the [Settings]({% link pages/settings.md %}) page. The relevant fields on the `settingKey: "global"` record:

| Field | Type | Controls |
|---|---|---|
| `slackBotToken` / `slackChannelId` / `slackSigningSecret` | string | Slack app credentials (shared by notifications and interactive approvals) |
| `slackNotificationsEnabled` | boolean | Slack requested/finished messages |
| `snsNotificationsEnabled` | boolean | SNS requested/finished emails |
| `snsApprovalNotificationsEnabled` | boolean | SNS approval-required emails |
| `snsTopicArn` | string (read-only) | Sourced from the `NOTIFICATIONS_TOPIC_ARN` env var, not DynamoDB — display only |

---

## Implementation

### Shared sender — `amplify/functions/notifications/notify.ts`

A single best-effort module used by every hook:

- `notifyAccessEvent({ kind, request, settings, topicArn })` — dispatches the **requested** (`kind: "REQUESTED"`) and **finished** (`kind: "FINISHED"`) events to Slack and/or SNS based on the toggles. Each channel is wrapped in its own `try/catch`.
- `notifyPendingApproval({ request, settings, topicArn, appUrl })` — SNS-only approval email with the link-to-app URL; gated by `snsApprovalNotificationsEnabled`.
- `formatDurationMinutes(minutes)` — shared human-readable duration formatter.

### Hook points

| Event | Hook | Notes |
|---|---|---|
| Requested | `requestAccessHandler.ts` | After the record is persisted; the full request is already in scope |
| Finished | `removePermissionSetHandler.ts` | After the status is set to `EXPIRED`/`REVOKED`; re-reads the request for context |
| Approval required | `storeApprovalTokenHandler.ts` | Alongside the existing Slack approval message, using the already-fetched request + settings |

### CDK wiring

- `amplify/accessRequestWorkflow.ts` creates `AccessNotificationsTopic` and grants `sns:Publish` + injects `NOTIFICATIONS_TOPIC_ARN` to the three publisher Lambdas (`requestAccess`, `removePermissionSet`, `storeApprovalToken`).
- `amplify/appSettings.ts` grants those Lambdas `dynamodb:GetItem` on `AppSettingsTable` (to read the toggles) and gives `getSettings` the topic ARN for read-only display.
- `amplify/backend.ts` injects `APP_CALLBACK_URL` on `storeApprovalToken` for the approval link.

---

## Security note

SNS approval emails deliberately **do not** support one-click approve/reject. An SNS delivery is anonymous — the app cannot verify who clicked a link, and the `approveRequest`/`rejectRequest` handlers require a Cognito identity that a Cedar `approve` policy authorizes. The link-to-app design preserves full authorization: the approver signs in and the normal AVP-gated mutation runs. Slack approvals remain interactive because the Slack callback is HMAC-verified and the clicking user's identity is resolved and authorized before acting.
