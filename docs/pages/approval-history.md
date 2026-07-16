---
title: Approval History
layout: default
parent: Auditor Features
nav_order: 1
---

# Approval History
{: .no_toc }

---

## What It Does

**Approval History** is a read-only record of every access request that required approval, together with how it was decided. It lets auditors answer "who approved what, and when" without any ability to change access.

For each approval-required request, the page shows:

- The requester, account, and permission set.
- The **decision** — approved, rejected, or expired (timed out).
- The **approver** who acted and any **comment** they left.
- When the request was made and when it was decided.

Selecting a request opens its full details. Because an approval decision happens before any session starts, this view focuses on the request and its decision rather than session activity — for what a user actually did during a granted session, see [Session Activity]({% link pages/session-activity.md %}).

Timestamps are shown in your browser's local time.
