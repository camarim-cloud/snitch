---
title: Settings
layout: default
nav_order: 9
---

# Settings (Admin)
{: .no_toc }

## Table of Contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Overview

The **Settings** page (admin-only) lets administrators configure application-level settings, grouped into three cards:

- **CloudTrail Audit Logs** — the CloudWatch log group where CloudTrail delivers audit events (drives the [Elevated Access]({% link pages/elevated-access.md %}) audit trail).
- **Slack Integration** — the Slack app credentials used for approval messages and notifications.
- **Access-Request Notifications** — per-channel toggles for [notifications]({% link pages/notifications.md %}) and the read-only SNS topic ARN.

---

## Storage Model

Settings are stored in `AppSettingsTable`, a CDK-managed DynamoDB table with `settingKey: STRING` as the partition key. A single record with `settingKey: "global"` holds all settings fields.

There is no pagination or list operation — `getAppSettings` always reads the `settingKey: "global"` item, and `updateAppSettings` always **partially** overwrites it (only the arguments actually provided are written; an explicit empty string clears a value).

---

## Settings Fields

| Field | Type | Description |
|---|---|---|
| `cloudTrailLogGroupName` | string | The CloudWatch log group where CloudTrail events are delivered |
| `slackBotToken` | string | Slack app OAuth bot token (`xoxb-…`) |
| `slackChannelId` | string | Slack channel ID for approval/notification messages |
| `slackSigningSecret` | string | Slack signing secret used to verify interactive callbacks |
| `slackNotificationsEnabled` | boolean | Send requested/finished notifications to Slack |
| `snsNotificationsEnabled` | boolean | Send requested/finished notifications to Amazon SNS |
| `snsApprovalNotificationsEnabled` | boolean | Send approval-required notifications to Amazon SNS |
| `snsTopicArn` | string (read-only) | The app-managed SNS topic ARN — sourced from the `NOTIFICATIONS_TOPIC_ARN` env var, not DynamoDB |

All fields are optional; booleans default to `false` on read.

---

## GraphQL Operations

```graphql
getAppSettings: AppSettings
updateAppSettings(
  cloudTrailLogGroupName: String
  slackBotToken: String
  slackChannelId: String
  slackSigningSecret: String
  slackNotificationsEnabled: Boolean
  snsNotificationsEnabled: Boolean
  snsApprovalNotificationsEnabled: Boolean
): AppSettings
```

Both are custom AppSync resolvers backed by Lambda, gated to the `Admins` Cognito group. `snsTopicArn` is returned by `getAppSettings` (from the environment) but is **not** a mutation argument.

---

## Lambda Handlers

| Handler | File | Purpose |
|---|---|---|
| `getSettingsHandler` | `amplify/functions/settings/getSettingsHandler.ts` | Reads `settingKey: "global"` from `AppSettingsTable`; merges the DynamoDB fields with the read-only `snsTopicArn` from the environment |
| `updateSettingsHandler` | `amplify/functions/settings/updateSettingsHandler.ts` | Partially updates the `settingKey: "global"` record with the provided fields; returns the saved values |

---

## IAM Permissions

| Handler | Required permissions |
|---|---|
| `getSettings` | `dynamodb:GetItem` on `AppSettingsTable` |
| `updateSettings` | `dynamodb:UpdateItem` on `AppSettingsTable` |

---

## Notification Settings

The **Access-Request Notifications** card exposes three checkboxes and the SNS topic ARN. See the [Notifications]({% link pages/notifications.md %}) page for what each event delivers, how to subscribe an SNS endpoint, and the email subject formats.

- **Send access-request notifications to Amazon SNS** → `snsNotificationsEnabled`
- **Send approval requests to Amazon SNS** → `snsApprovalNotificationsEnabled`
- **Send access-request notifications to Slack** → `slackNotificationsEnabled` (requires the Slack Bot Token + Channel ID above)

The SNS topic is app-managed; copy the read-only **SNS Topic ARN** and subscribe email/SMS endpoints to it in the AWS console.

---

## CloudTrail Log Group Configuration

To enable the audit trail on the [Elevated Access]({% link pages/elevated-access.md %}) page:

1. Ensure CloudTrail is enabled in your AWS account and is configured to deliver events to a CloudWatch Logs log group.
2. Navigate to **Settings** in the Snitch UI (admin-only).
3. Enter the log group name (e.g., `/aws/cloudtrail/my-trail`).
4. Save the settings.

Once configured, the `getCloudTrailLogs` handler reads the log group name at runtime and queries it for events matching the requester's email address.
