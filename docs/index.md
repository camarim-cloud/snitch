---
title: Home
layout: home
nav_order: 1
---

# Snitch — Privileged Access Management
{: .fs-9 }

Just-in-Time (JIT) privileged access management for AWS accounts, built on AWS Amplify, Cedar policies, and Step Functions.
{: .fs-6 .fw-300 }

[Get Started]({% link _docs/getting-started.md %}){: .btn .btn-primary .fs-5 .mb-4 .mb-md-0 .mr-2 }
[View on GitHub](https://github.com/your-org/snitch){: .btn .fs-5 .mb-4 .mb-md-0 }

---

## What is Snitch?

Snitch is a fullstack application for managing privileged access to AWS accounts. Admins define Cedar policies that authorize IAM Identity Center (IDC) users or groups to assume specific Permission Sets on AWS accounts and Organizational Units (OUs). End-users request temporary, time-boxed access through a self-service UI; access is granted automatically by a Step Functions workflow and revoked when the requested duration expires.

## Core Features

| Feature | Description |
|---|---|
| **Privileged Policies** | Admins create Cedar policies that map IDC principals to AWS accounts and permission sets |
| **JIT Access Requests** | Users request temporary access; a Step Functions workflow assigns and revokes the permission set |
| **Approval Gate** | Policies can require approval before access is granted; approvers are configured per account |
| **Elevated Access** | Admins view all active requests, revoke access early, and inspect the CloudTrail audit trail |
| **AVP Authorization** | All access decisions are evaluated by AWS Verified Permissions (Cedar), not application logic |
| **CloudTrail Audit** | Every activated session is queryable through CloudWatch Logs via a configurable log group |

## Technology Stack

- **Frontend**: React 19 + TypeScript, Vite, Cloudscape Design System, React Router v7
- **Backend**: AWS Amplify Gen 2 (AppSync GraphQL + DynamoDB + Cognito)
- **Authorization**: AWS Verified Permissions (Cedar policies, STRICT schema validation)
- **Workflow**: AWS Step Functions + AWS SSO Admin API
- **Testing**: Vitest + React Testing Library
