---
title: Getting Started
layout: default
nav_order: 2
---

# Getting Started
{: .no_toc }

## Table of Contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Prerequisites

Before deploying Snitch, ensure you have the following:

- **Node.js** v18.16.0 or later
- An **AWS account** with:
  - IAM Identity Center (IDC) enabled
  - AWS Organizations configured (for account/OU discovery)
  - Appropriate IAM permissions for the Amplify sandbox role

---

## Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/camarim-cloud/snitch.git
cd snitch
npm install
```

---

## Deploy the Backend Sandbox

Amplify Gen 2 provisions all backend resources (Cognito, AppSync, DynamoDB, Lambda, Step Functions, AVP) in an isolated personal sandbox environment:

```bash
npm run sandbox
# or
npx ampx sandbox
```

This command:
1. Synthesizes CDK stacks defined under `amplify/`
2. Deploys them to your AWS account
3. Writes `amplify_outputs.json` with all endpoint URLs and resource IDs

{: .note }
The sandbox is hot-reloaded — changes to `amplify/` files are deployed automatically while `npm run sandbox` is running.

---

## Start the Frontend

```bash
npm run dev
```

The app starts at [http://localhost:5173](http://localhost:5173).

---

## First-Time Setup

### 1. Create an Admin User

1. Open the app and sign up with an email and password.
2. In the **AWS Console → Cognito → User Pools**, find the pool created by Amplify.
3. Add the new user to the **`Admins`** group to grant admin access.

### 2. Configure CloudTrail Log Group (Optional)

Admin pages include a **Settings** page where you can configure the CloudWatch log group that receives CloudTrail events. This enables the audit trail feature on the Elevated Access page.

Navigate to **Settings** (admin only) and enter the log group name.

### 3. Configure IDC Resources

Snitch requires IAM Identity Center to be set up in your AWS account. The following resources are discovered at runtime via the AWS APIs:

- IDC Users and Groups
- AWS Accounts (via Organizations)
- Organizational Units
- Permission Sets

No manual configuration is needed — these are fetched live when admins build policies.

---

## Running Tests

```bash
npm run test            # single run
npm run test:watch      # watch mode
npm run test:coverage   # with coverage report
```

Run a single test file:

```bash
npx vitest run src/test/cedarPolicyBuilder.test.ts
```

Run tests matching a name pattern:

```bash
npx vitest run --reporter=verbose -t "approval"
```

---

## Build for Production

```bash
npm run build
```

Output is placed in `dist/`. This command runs TypeScript compilation (`tsc -b`) followed by the Vite production build.
