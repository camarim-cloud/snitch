---
title: Development Guide
layout: default
nav_order: 10
---

# Development Guide
{: .no_toc }

## Table of Contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Commands

```bash
npm run dev              # Vite dev server → http://localhost:5173
npm run build            # tsc -b && vite build
npm run test             # Vitest single run (all tests)
npm run test:watch       # Vitest watch mode
npm run test:coverage    # With coverage report
npm run sandbox          # Deploy / hot-reload Amplify Gen 2 sandbox
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

## Adding a New Lambda-Backed GraphQL Operation

Adding a new mutation or query requires changes in four places:

1. **Function resource** — create `amplify/functions/<name>/resource.ts` and the handler file.
2. **Schema** — declare the operation in `amplify/data/resource.ts` with the appropriate `.handler(...)` and `.authorization(...)`.
3. **Backend registration** — import the function in `amplify/backend.ts` and add it to the backend definition.
4. **IAM grants** — add the required `PolicyStatement` in `amplify/backend.ts` for the function's execution role.

For the stack placement rule, see the [Architecture]({% link pages/architecture.md %}) page.

---

## Import Aliases

The project uses a `@/*` alias for `src/` imports:

```typescript
import { formatDuration } from "@/utils/duration";
import { accessRequestStatusType } from "@/utils/accessRequestStatus";
```

Cloudscape components are imported per-component (not from an index) to avoid pulling the entire library into the bundle:

```typescript
import AppLayout from "@cloudscape-design/components/app-layout";
import Table from "@cloudscape-design/components/table";
```

Routing uses `react-router` (v7); `react-router-dom` no longer exists:

```typescript
import { Route, Routes, useNavigate } from "react-router";
import { HashRouter } from "react-router";
```

---

## Tables — `useCollection` Pattern

All tables use `useCollection` from `@cloudscape-design/collection-hooks` for client-side filtering, pagination, and selection:

```typescript
import { useCollection } from "@cloudscape-design/collection-hooks";

const PAGE_SIZE = 10;

const { items, filterProps, paginationProps, collectionProps } =
  useCollection(allItems, {
    filtering: {
      filteringFunction: (item, text) =>
        item.name.toLowerCase().includes(text.toLowerCase()),
    },
    pagination: { pageSize: PAGE_SIZE },
    selection: { trackBy: "id" },
  });
```

- `collectionProps` — spread onto `<Table>`
- `filterProps` — spread onto `<TextFilter>`
- `paginationProps` — spread onto `<Pagination>`

---

## Testing Rules

- Every new function gets a test. Bug fixes get a regression test.
- Mock external I/O (Amplify API, DynamoDB, AVP SDK) with named fake classes, not inline stubs.
- Tests must be F.I.R.S.T: fast, independent, repeatable, self-validating, timely.
- Setup file: `src/test/setup.ts`. Test files use the `.test.tsx` suffix.

### Environment Variables in Tests

When a Lambda handler reads `process.env.X` at the module level (`const TABLE_NAME = process.env.X!`), set the env var **before** the `await import(...)` statement in the test file so the module-level constant captures the correct value:

```typescript
process.env.ACCESS_REQUEST_TABLE_NAME = "test-table";
const { handler } = await import("../myHandler");
```

### Multiple Modals

When testing components that render multiple Cloudscape modals, use `screen.getByRole("dialog", { name: /title/i })` rather than `screen.getByRole("dialog")` to avoid ambiguous queries — Cloudscape keeps hidden modals in the DOM.

---

## DynamoDB GSI Change Constraints

DynamoDB only allows **one GSI creation or deletion per CloudFormation update**. Renaming a GSI or adding/removing a sort key counts as delete + create — two operations — and CloudFormation will reject it.

Safe procedure for any GSI rename or sort-key change:

1. **Deploy 1** — add the new GSI and update handlers to use the new `IndexName`.
2. **Deploy 2** — delete the old GSI.

Never combine a GSI deletion and creation in the same CDK deploy.

---

## AWS CLI Policy

**Never execute any AWS CLI command that mutates cloud state.** All infrastructure changes must go through CDK code and be deployed via `npm run sandbox` or the CI pipeline. Direct CLI mutations cause drift — the infrastructure state diverges from what CDK believes is deployed, which breaks future deploys unpredictably.

Read-only diagnostic commands (`describe-*`, `list-*`, `get-*`) are fine to suggest but still require user confirmation before execution.

---

## Code Style

- Functions: 4–20 lines. Split if longer.
- Files: under 500 lines. Split by responsibility.
- Explicit types everywhere — no `any`, no untyped functions.
- TypeScript strict mode is enabled — honor it.
- No code duplication. Extract shared logic into a named function or module.
- Names must be specific and unique. Prefer names that return fewer than 5 grep hits.
- Use Prettier for all formatting.

### Error Messages

```typescript
throw new Error(
  `Expected PrivilegedPolicy id to be a non-empty string, got: ${JSON.stringify(id)}`
);
```

### Comments

Write **why**, not what. Only add a comment when the reason is non-obvious: a hidden constraint, a subtle invariant, a bug workaround. If removing the comment wouldn't confuse a future reader, don't write it.

---

## Environment Variables

| Variable | Used by | Source |
|---|---|---|
| `IDC_IDENTITY_STORE_ID` | `preTokenGenerationHandler` | Read from `snitch/auth-config` secret at CDK synth time via `authConfig.ts` |
| `ADMIN_GROUP_NAME` | `preTokenGenerationHandler` | Read from `snitch/auth-config` secret at CDK synth time via `authConfig.ts` |
| `AVP_POLICY_STORE_ID` | All AVP-touching handlers | CDK token resolved at deploy time |
| `PRIVILEGED_POLICY_TABLE_NAME` | Privileged policy CRUD + evaluateAccess | CDK token resolved at deploy time |
| `APPROVAL_POLICY_TABLE_NAME` | `createApprovalPolicyHandler`, `deleteApprovalPolicyHandler` | CDK token resolved at deploy time |
| `ACCESS_REQUEST_TABLE_NAME` | All access-request handlers | CDK token resolved at deploy time |
| `APP_SETTINGS_TABLE_NAME` | `getSettingsHandler`, `updateSettingsHandler`, `getCloudTrailLogsHandler` | CDK token resolved at deploy time |

All are set in `amplify/backend.ts` via `addEnvironment(...)` on each function resource.

{: .note }
`IDC_IDENTITY_STORE_ID` and `ADMIN_GROUP_NAME` are plain string values embedded at CDK synthesis time — they are **not** CloudFormation dynamic references (`{{resolve:secretsmanager:...}}`). This is intentional: Lambda environment variables in Amplify Gen 2's nested stacks cannot resolve dynamic references because CDK generates environment-agnostic stacks with pseudo-parameter ARNs that CloudFormation cannot expand inside `{{resolve:...}}` strings.
