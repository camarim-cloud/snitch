---
title: Session Activity
layout: default
parent: Auditor Features
nav_order: 2
---

# Session Activity
{: .no_toc }

---

## What It Does

**Session Activity** is a read-only record of every real elevated-access session — every request that actually granted access — together with what happened during it. It gives auditors the full picture of privileged activity without any ability to change access.

For each session, the page shows the requester, account, permission set, and the actual start and end times of the granted access. Selecting a session opens its details and the **CloudTrail event log** for that access window: the AWS API activity the user performed while their elevated access was active.

The audit trail relies on a CloudTrail log group being configured on the [Settings]({% link pages/settings.md %}#cloudtrail-audit-logs) page. Without it, session records still appear but their CloudTrail log is empty.

Timestamps are shown in your browser's local time.

{: .note }
Admins see the same audit trail (plus the ability to revoke sessions) on the [Elevated Access]({% link pages/elevated-access.md %}) page. Session Activity is the read-only, auditor-facing equivalent.
