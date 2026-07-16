---
title: Admin Features
layout: default
nav_order: 7
has_children: true
---

# Admin Features
{: .no_toc }

Admin-only capabilities give administrators oversight and control over the whole access lifecycle. Admin access is granted by membership in the IDC group configured as `ADMIN_GROUP_ID` (see [Getting Started]({% link pages/getting-started.md %}#3b-grant-admin-access)).

Beyond authoring [Privileged Policies]({% link pages/privileged-policies.md %}) and configuring the [Approval Workflow]({% link pages/approval-workflow.md %}), admins have two dedicated pages:

- **[Elevated Access]({% link pages/elevated-access.md %})** — see every access request across all users, revoke active sessions early, and inspect the CloudTrail audit trail for any session.
- **[Settings]({% link pages/settings.md %})** — configure the CloudTrail log group and the Slack + email notification channels.
