---
title: Settings
layout: default
parent: Admin Features
nav_order: 2
---

# Settings
{: .no_toc }

## Table of Contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## What It Does

The **Settings** page (admin-only) is where administrators configure application-level options, grouped into three cards:

- **CloudTrail Audit Logs** — the CloudWatch log group that powers the audit trail.
- **Slack Integration** — the Slack app credentials used for approval messages and notifications.
- **Access-Request Notifications** — the per-channel toggles for Slack and email alerts.

---

## CloudTrail Audit Logs

To enable the audit trail on the [Elevated Access]({% link pages/elevated-access.md %}) and [Session Activity]({% link pages/session-activity.md %}) pages:

1. Make sure CloudTrail is enabled in your AWS account and delivering events to a CloudWatch Logs log group.
2. Open **Settings** in Snitch.
3. Enter the log group name (e.g., `/aws/cloudtrail/my-trail`) and save.

Once configured, Snitch queries that log group for each session's activity. If it's left blank, the audit trail is simply empty.

---

## Notifications

Snitch can notify a team channel or mailing list about the access-request lifecycle through two independent channels — **Slack** and **email (Amazon SNS)**. Every notification is best-effort: if delivery fails, it never blocks or breaks the underlying access request.

### What gets notified

| Event | When it fires | Channels |
|---|---|---|
| **Access requested** | A user submits a request | Slack, email |
| **Access finished** | A granted session ends (expired or revoked) | Slack, email |
| **Approval required** | A request is waiting for an approver | Slack (interactive buttons), email (link to the app) |

Each channel is controlled by its own toggle, so you can, for example, send approval alerts by email while sending requested/finished updates to Slack.

### Slack

To use Slack notifications, enter the Slack app credentials (bot token, channel, and signing secret) in the **Slack Integration** card, then enable the Slack notifications toggle.

- **Requested / finished** messages are informational.
- **Approval required** messages include **Approve** / **Reject** buttons so approvers can act directly from Slack. The clicker's identity is verified and authorized before anything happens, so only real approvers can act.

### Email (Amazon SNS)

Email notifications are delivered through an app-managed Amazon SNS topic. To receive them:

1. Deploy the backend so the topic exists.
2. In **Settings**, copy the read-only **SNS Topic ARN**.
3. In the AWS console, create a subscription on that topic (protocol **Email** or **SMS**) for your endpoint, and confirm it from the confirmation message.
4. Enable the relevant SNS toggle(s) in Settings.

Email subject lines include the account label, for example `AWS access approval required - Production (111111111111)`.

{: .note }
Approval **emails** deliberately don't carry one-click approve/reject buttons: an email recipient can't be securely identified, so the message instead links to the in-app Approve Requests page, where the approver signs in and acts with full authorization. Slack approvals stay interactive because the Slack click is verified and authorized.
