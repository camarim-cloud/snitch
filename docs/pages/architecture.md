---
title: Architecture
layout: default
nav_order: 3
---

# Architecture
{: .no_toc }

## Table of Contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Overview

Snitch is a fullstack AWS application built on Amplify Gen 2. The system relies on two complementary data stores — DynamoDB for application metadata and AWS Verified Permissions (AVP) for Cedar policy evaluation — and delegates access orchestration to Step Functions.

```
┌─────────────────────────────────────────────────────────┐
│                        Browser                          │
│            React 19 + Cloudscape Design System          │
└────────────────────────┬────────────────────────────────┘
                         │ GraphQL (AppSync)
┌────────────────────────▼────────────────────────────────┐
│                     AWS AppSync                         │
│              GraphQL API (Cognito auth)                 │
└──┬──────────────┬────────────────────────────────┬──────┘
   │              │                                │
   ▼              ▼                                ▼
DynamoDB      Lambda Resolvers              Step Functions
(policy +     (CRUD, evaluation,            (JIT workflow)
 request       approval, audit)
 tables)
   │
   ▼
AWS Verified Permissions
(Cedar policy store — authoritative for all access decisions)
```

---

## CDK Stack Layout

All infrastructure is defined in `amplify/` as CDK code and deployed via Amplify Gen 2.

| Stack | File | Owns |
|---|---|---|
| `data` | `amplify/data/resource.ts` + `amplify/backend.ts` | AppSync schema, Lambda resolvers, IAM grants, AVP policy store, `AppSettingsTable` |
| `AccessRequestWorkflow` | `amplify/accessRequestWorkflow.ts` | `AccessRequestTable`, Step Functions state machine, workflow Lambdas |

### Why Two Stacks?

AppSync resolvers reference Lambda ARNs. If approval/revocation Lambdas lived inside `AccessRequestWorkflow`, a circular dependency would form:

- `data` → `AccessRequestWorkflow` (AppSync references Lambda ARNs)
- `AccessRequestWorkflow` → `data` (needs `PrivilegedPolicyTable` ARN for IAM)

The split breaks the cycle: `AccessRequestWorkflow` exposes `{ accessRequestTableArn, accessRequestTableName }` and `data` (`backend.ts`) imports them — a single direction CloudFormation can resolve.

---

## Two Data Stores, One Source of Truth

Every `PrivilegedPolicy` and `ApprovalPolicy` record exists in:

1. **DynamoDB** — application metadata (policy details, foreign key `avpPolicyId`)
2. **AWS Verified Permissions** — the Cedar policy (authoritative for access decisions)

DynamoDB stores the `avpPolicyId` returned by AVP, which is the handle used for subsequent deletes. AVP is never queried for metadata — only for authorization decisions via `IsAuthorized`.

### Compensating Transactions

| Mutation | Write Order | Rollback Target |
|---|---|---|
| Create (policy or approval) | AVP first → DynamoDB | Delete AVP policy |
| Update (privileged policy only) | DynamoDB first → AVP | Restore DynamoDB snapshot |
| Delete (both types) | DynamoDB first → AVP | Restore DynamoDB snapshot |

This ordering ensures that on partial failure, the rollback target is always reachable.

---

## IAM Permission Wiring

All IAM `PolicyStatement` additions live in `amplify/backend.ts`. Lambda functions carry no inline IAM config. When a `is not authorized to perform` error surfaces, `backend.ts` is always the first file to inspect.

---

## Request Handler Placement: `data` vs `AccessRequestWorkflow`

| Rule | Location |
|---|---|
| Handler called directly by AppSync (query/mutation) | `resourceGroupName: "data"` |
| Handler called by the Step Functions state machine | `resourceGroupName: "AccessRequestWorkflow"` |

### Current Split

| `data` stack | `AccessRequestWorkflow` stack |
|---|---|
| `requestAccess`, `listAccessRequests` | `storeApprovalToken`, `storeActiveToken` |
| `approveRequest`, `rejectRequest`, `listPendingApprovals` | `assignPermissionSet`, `removePermissionSet`, `setStatusFailed` |
| `listAllAccessRequests`, `revokeAccess` | |
| `createApprovalPolicy`, `deleteApprovalPolicy` | |
| `getSettings`, `updateSettings`, `getCloudTrailLogs` | |

---

## AppSync Identity Model

AppSync forwards the Cognito **access token** to Lambda resolvers — not the ID token. The access token only contains `sub`, `cognito:groups`, and standard OIDC fields. Custom attributes such as `email` are absent.

**Consequence:** identity comparisons in Lambda handlers must use `event.identity.username` (the Cognito sub/UUID), never email claims.

---

## Project Structure

```
snitch/
├── amplify/
│   ├── auth/resource.ts              # Cognito — defines the "Admins" user pool group
│   ├── data/resource.ts              # AppSync schema: models + custom resolvers
│   ├── backend.ts                    # CDK wiring: AVP policy store, IAM grants, env vars
│   ├── accessRequestWorkflow.ts      # Step Functions state machine + AccessRequestTable
│   └── functions/
│       ├── awsResources/             # Lambda resolvers: IDC, Organizations, SSO Admin
│       ├── settings/                 # getSettings / updateSettings handlers
│       ├── verifiedPermissions/      # Cedar policy CRUD + access evaluation
│       └── accessRequests/           # JIT workflow Lambdas + approval handlers
├── src/
│   ├── components/                   # Reusable UI components
│   ├── hooks/                        # Custom React hooks
│   ├── utils/
│   │   ├── duration.ts               # formatDuration, todayDateStr, minutesToMaxDuration
│   │   └── accessRequestStatus.ts    # accessRequestStatusType — status → Cloudscape indicator
│   ├── types/                        # Shared TypeScript types
│   └── pages/                        # Page-level components (one per route)
├── amplify_outputs.json              # Generated backend outputs (gitignored in prod)
└── vite.config.ts
```
