---
title: Privileged Policies
layout: default
nav_order: 4
---

# Privileged Policies
{: .no_toc }

## Table of Contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## What It Does

A **Privileged Policy** is the rule that says *who* may request *what* access. Each policy grants an IAM Identity Center (IDC) user or group the ability to request temporary access to one or more AWS accounts and/or Organizational Units (OUs) using a specific **Permission Set**.

Privileged Policies never grant standing access on their own — they define the boundaries of what a person is *allowed to request*. Actual access is always time-boxed and granted through an [Access Request]({% link pages/access-requests.md %}).

Managing Privileged Policies is an **admin-only** capability.

---

## Creating a Policy

When an admin creates a policy, they choose:

- **Principal** — the IDC user or group the policy applies to.
- **Permission Set** — the AWS permission set the principal may assume.
- **Accounts and/or OUs** — where the access applies. Selecting an OU covers the accounts within it.
- **Maximum duration** — the longest a request against this policy may last. Requests may ask for less, never more.
- **Requires approval** — whether an approver must sign off before access is granted (see the [Approval Workflow]({% link pages/approval-workflow.md %})).

---

## One Policy per Principal and Resource

Snitch allows only **one** policy for a given principal on a given account or OU. If you try to create a second policy that overlaps an existing one for the same user or group, Snitch blocks it and tells you which policy already covers that resource. This keeps each principal's access to any account unambiguous.

---

## Maximum Duration

Each policy sets a maximum access duration. In the form you pick a future date and time, and Snitch stores the resulting length. When a user requests access, their chosen duration is checked against this maximum before the request is accepted. Durations are shown throughout the app in a readable form such as `45min`, `8h 30min`, or `2d 8h`.

---

## Requires Approval

Turning on **Requires approval** for a policy means any request against it pauses for sign-off before access is granted:

1. The Request Access form warns the user that approval is required.
2. On submission the request waits in a *Pending approval* state.
3. An authorized approver approves or rejects it (or it times out after 24 hours).

*Who* can approve is configured separately — see the [Approval Workflow]({% link pages/approval-workflow.md %}).
