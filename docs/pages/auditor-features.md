---
title: Auditor Features
layout: default
nav_order: 8
has_children: true
---

# Auditor Features
{: .no_toc }

Auditor pages give compliance and security reviewers **read-only** insight into access activity — everything they need to review, nothing they can change. Auditors cannot create, approve, or revoke anything.

Auditor access is granted by membership in the IDC group configured as `AUDITOR_GROUP_ID` (see [Getting Started]({% link pages/getting-started.md %}#3c-grant-auditor-access-optional)). It is independent of admin access — a user can be an auditor, an admin, both, or neither.

There are two auditor pages:

- **[Approval History]({% link pages/approval-history.md %})** — every approval-required request and how it was decided.
- **[Session Activity]({% link pages/session-activity.md %})** — every real elevated-access session and its CloudTrail event log.
