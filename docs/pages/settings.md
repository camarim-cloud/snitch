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

The **Settings** page (admin-only) lets administrators configure application-level settings. Currently, the only configurable setting is the CloudWatch log group name where CloudTrail delivers audit events.

---

## Storage Model

Settings are stored in `AppSettingsTable`, a CDK-managed DynamoDB table with `settingKey: STRING` as the partition key. A single record with `settingKey: "global"` holds all settings fields.

There is no pagination or list operation — `getAppSettings` always reads the `settingKey: "global"` item, and `updateAppSettings` always overwrites it.

---

## Settings Fields

| Field | Type | Description |
|---|---|---|
| `cloudTrailLogGroupName` | string (optional) | The CloudWatch log group where CloudTrail events are delivered |

---

## GraphQL Operations

```graphql
getAppSettings: AppSettings
updateAppSettings(cloudTrailLogGroupName: String): AppSettings
```

Both are custom AppSync resolvers backed by Lambda.

---

## Lambda Handlers

| Handler | File | Purpose |
|---|---|---|
| `getSettingsHandler` | `amplify/functions/settings/getSettingsHandler.ts` | Reads `settingKey: "global"` from `AppSettingsTable`; returns `{ cloudTrailLogGroupName }` |
| `updateSettingsHandler` | `amplify/functions/settings/updateSettingsHandler.ts` | Puts/overwrites the `settingKey: "global"` record; returns the saved settings |

---

## IAM Permissions

| Handler | Required permissions |
|---|---|
| `getSettings` | `dynamodb:GetItem` on `AppSettingsTable` |
| `updateSettings` | `dynamodb:PutItem` on `AppSettingsTable` |

---

## CloudTrail Log Group Configuration

To enable the audit trail on the [Elevated Access]({% link pages/elevated-access.md %}) page:

1. Ensure CloudTrail is enabled in your AWS account and is configured to deliver events to a CloudWatch Logs log group.
2. Navigate to **Settings** in the Snitch UI (admin-only).
3. Enter the log group name (e.g., `/aws/cloudtrail/my-trail`).
4. Save the settings.

Once configured, the `getCloudTrailLogs` handler reads the log group name at runtime and queries it for events matching the requester's email address.
