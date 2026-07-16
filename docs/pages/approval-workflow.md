---
title: Approval Workflow
layout: default
nav_order: 6
---

# Approval Workflow
{: .no_toc }

## Table of Contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## What It Does

Some access is sensitive enough that it should not be granted automatically. When a [Privileged Policy]({% link pages/privileged-policies.md %}) has **Requires approval** turned on, every request against it pauses until an authorized approver signs off — or it times out after 24 hours and expires on its own.

This adds a human checkpoint without slowing down the rest of the flow: unapproved requests never grant access, and approved ones continue straight through to activation.

---

## Configuring Who Can Approve

*Whether* approval is needed lives on the Privileged Policy. *Who* may approve is configured separately by an admin on the **Approval Policy** page.

Each approval policy grants one approver — an individual user or a group — the ability to approve requests for a specific **AWS account**, limited to one or more chosen **permission sets**. An admin can add as many approvers per account as needed. Approval policies are created and removed on the Approval Policy page (to change one, delete it and create a new one).

---

## Approving a Request

Anyone configured as an approver can open the **Approve Requests** page — it is not limited to admins. The page lists the requests they are authorized to act on, and each can be **approved** or **rejected** (optionally with a comment).

- Approving resumes the request, which then proceeds to activation.
- Rejecting ends the request as *Rejected* — no access is granted.
- A request nobody acts on within 24 hours expires automatically.

{: .note }
Approvers cannot approve or reject their **own** requests — a request always needs a second person to sign off.

---

## Approval Notifications

When a request is waiting for approval, Snitch can alert approvers so they don't have to watch the page:

- **Slack** — an interactive message with **Approve** / **Reject** buttons is posted to the configured channel, so approvers can act without leaving Slack.
- **Email (Amazon SNS)** — a notification links back to the in-app Approve Requests page, where the approver signs in and acts.

Both channels are configured on the [Settings]({% link pages/settings.md %}) page. See [Notifications]({% link pages/settings.md %}#notifications) for the full delivery model.
