# G-CORE — Gruntechnology Corp

Integrated business operations platform for `gruntech.gcore.tech`.

One codebase, one database, one API. Not four apps behind a launcher — that is
the architecture this replaces.

- **[docs/BUSINESS-OPERATIONS-MODEL.md](docs/BUSINESS-OPERATIONS-MODEL.md)** — the
  operating model. Read this first; it is the specification.
- **[docs/GAP-ANALYSIS.md](docs/GAP-ANALYSIS.md)** — what the source documents got
  right, missed, or got wrong.

## What is built

**Phase 1 — Foundation.** Everything else depends on it, and every defect in the
previous implementation traces back to its absence.

| Capability | Where |
|---|---|
| Authentication (JWT) | `api/src/auth`, `web/src/pages/Login.tsx` |
| Users, supervisors, departments | `/admin/users` |
| Roles + granular permissions + per-person overrides | `/admin/roles` |
| Company settings (drives every PDF) | `/admin/company` |
| Document numbering, 26 document types | `/admin/numbering` |
| Approval engine, one for every document type | `/admin/workflows` |
| Audit log | `/admin/audit` |
| Notification centre with deep links | bell in the top bar |
| Global search / command palette | Ctrl+K |
| Shared list pattern | `web/src/components/DataList.tsx` |
| PDF document engine | `api/src/shared/pdf.ts`, specimen at `/admin/company` |
| Attachments | `api/src/shared/attachments.ts` |
| My Work | `/` and `/my-work` |

**Phase 2 — Master data.** Enter once, reuse everywhere.

| Capability | Where |
|---|---|
| Customers, multiple contacts, multiple sites | `/g-ops/customers` |
| **Customer 360** — one workspace per customer | `/g-ops/customers/:id` |
| Suppliers and their contacts | `/g-chain/suppliers` |
| Employees, with pay behind its own permission | `/g-hr/employees` |
| Item master, typed and costed | `/g-chain/items` |
| Cost categories (the five buckets) + item categories | `/admin/categories` |
| Warehouses and locations | `/g-chain/warehouses` |
| **CSV import** for all four masters | Import button on each list |

**Phase 3 — Sales.** Lead → costing → quotation → approved.

| Capability | Where |
|---|---|
| Leads, assignable, with status and weighted value | `/g-ops/leads` |
| **Costing** — five cost buckets, markup, contract amount | `/g-ops/costing` |
| **Schedule of values** — scope of work that billing is measured against | Costing → Scope of work |
| Quotations with preserved revisions | `/g-ops/quotations` |
| Quotation approval through the shared engine | Submit for approval |
| Quotation and costing PDFs | Print on either screen |
| Sales calendar, a week per screen | `/g-ops/calendar` |
| Pipeline with weighted value | `/g-ops/pipeline` |

**Phase 4 — Delivery.** Job → budget → progress → billing.

| Capability | Where |
|---|---|
| Projects created from a costing | `/g-ops/projects` |
| **Project workspace** — one page, eight tabs | `/g-ops/projects/:id` |
| **Four-state cost ledger** — budgeted / committed / incurred / consumed | Project → Budget |
| Budget requests, approved through the shared engine | `/g-ops/budget-requests` |
| Schedule of values, snapshotted from the costing | Project → Scope |
| Progress reports, chained, with period percentages | `/g-ops/progress` |
| **S-curve** — planned vs actual vs billed | Project → Overview |
| Progress billing with VAT and EWT | Project → Billing |
| Approved plans register, job tasks | Project → Plans / Tasks |
| Budget monitoring across all projects | `/g-ops/budget-monitoring` |

**Phase 5 — G-CHAIN.** Request → canvass → order → receive → stock → issue.

| Capability | Where |
|---|---|
| Purchase requests, in two kinds | `/g-chain/purchase-requests` |
| Canvass / RFQ with side-by-side quote comparison | `/g-chain/canvass` |
| Purchase orders, approved and issued | `/g-chain/purchase-orders` |
| Receiving against an order | `/g-chain/receiving` |
| **Inventory at moving average cost**, with stock cards | `/g-chain/inventory` |
| Stock issuance — charges a project at average cost | `/g-chain/stock-issuance` |
| Borrow slips with overdue tracking | `/g-chain/borrow-slips` |
| Stock valuation and reorder report | `/g-chain/reports` |

Screens from Phases 6–9 appear in the menu marked with their phase. Their
**access and numbering are already configurable**, so the surrounding
configuration is in place before the screen arrives.

### The costing → billing backbone

This is the part worth understanding before using it.

A costing holds two things that must agree. **Cost lines** in the five buckets
give the total cost; markup and discount turn that into the **contract amount**.
Separately, the **scope of work** breaks that contract amount into sections —
typically main work, testing & commissioning, turnover — each with a duration
and a value.

Those scope sections *are* the Schedule of Values. In Phase 4 they become what
progress is reported against, what progress billing bills, and what the S-curve
is measured on. So their total has to equal the contract value: the costing
screen says so plainly, and **Spread contract value** reconciles them to the
centavo (the rounding remainder lands on the last section).

From a quotation, **Fill from costing** turns those same sections into the
quotation's lines. Quote what you scoped, and the numbers carry through to
billing without anyone retyping them.

### The two kinds of purchase request

This is the distinction that keeps project costs honest, and it is worth
knowing before anyone raises a request.

**Direct to job** — bought for one project. Approving the request *commits* its
budget at estimated prices; issuing the order replaces that with the price
actually agreed; receiving the goods turns it into *incurred* cost. The material
does **not** enter stock, because it has already been charged.

**Stock replenishment** — bought for the warehouse. No project is touched.
Receiving adds to inventory at cost; issuing to a job charges that job at the
moving average.

Material therefore reaches a project's cost exactly once, whichever route it
took. Each handover releases what came before, so a request and its order are
never both counted.

### About the CSV import

Gruntech starts with clean data, so this is not a migration tool — it is the
escape hatch for the day a clean supplier list turns up in a spreadsheet.

Upload once and it reports what it *would* do, row by row, with Excel row
numbers. Nothing is written until you upload again and confirm, and **a single
bad row blocks the whole file**. That is deliberate: a half-applied import of
master data is worse than a rejected one, because afterwards nobody can tell
which rows landed. Re-importing the same file updates rather than duplicates.

## Running it locally

Needs Node 22+ and Docker Desktop.

```bash
docker compose up -d
```

```bash
cd api && cp .env.example .env && npm install && npm run setup && npm run dev
```

```bash
cd web && npm install && npm run dev
```

Then open http://localhost:5173.

| | |
|---|---|
| Web (dev) | http://localhost:5173 |
| API | http://localhost:5100 |
| Health | http://localhost:5100/api/health |
| Postgres | localhost:**5433** (5433, not 5432, so it cannot collide with an existing local Postgres) |

First sign-in: `admin@gruntech.com` / `ChangeMe!2026` — **change it immediately**
under Account. Override the defaults with `SEED_ADMIN_EMAIL` and
`SEED_ADMIN_PASSWORD` before running the seed if you prefer.

### Verifying the foundation

Phase 1 ships services rather than screens — the approval engine, numbering,
permission resolution, the PDF engine. Those are exercised by *modules*, which
do not exist yet, so there is no click-path that proves they work. This script
drives them the way a Phase 3 module will:

```bash
cd api && npx tsx scripts/verify-foundation.ts
```

40 assertions: role inheritance and per-person overrides, record ownership,
menu derivation, numbering under concurrency, approval routing and notification,
segregation of duties, the overtime two-step rule, amount bands, the audit trail
and PDF pagination.

```bash
cd api && npx tsx scripts/verify-masters.ts
```

40 assertions for Phase 2: CSV parsing (quoted commas, embedded newlines,
doubled quotes, Excel's BOM), the import contract (dry run writes nothing, one
bad row blocks the file, re-import updates rather than duplicates), the
permission gate on employee pay, master numbering under concurrency, and that
global search never returns a record kind the user cannot open.

```bash
cd api && npx tsx scripts/verify-sales.ts
```

28 assertions for Phase 3, concentrated on the money: how the contract amount
is reached, that margin is profit over contract and not over cost, that the
schedule of values reconciles to the centavo on an awkward figure, VAT computed
both inclusive and exclusive, record ownership, that an author cannot approve
their own quotation, and that a superseded revision keeps its own totals.

```bash
cd api && npx tsx scripts/verify-delivery.ts
```

39 assertions for Phase 4: that the schedule of values is snapshotted and does
not move when the costing is later edited, the four-state budget arithmetic
(including that consumed is not subtracted twice), that a budget request only
moves the budget after every approval, that earned value is weighted by scope
value rather than averaged, that EWT is withheld on the gross and not the VAT,
that a second billing covers only the increment, and that the S-curve's three
lines share a time basis.

```bash
cd api && npx tsx scripts/verify-chain.ts
```

35 assertions for Phase 5, mostly about not counting money twice: the moving
average (a receipt moves it, an issue does not), that a warehouse cannot issue
or lend what it does not have, that issuing an order releases the request's
commitment, that receiving releases the order's, that a direct-to-job receipt is
charged to the job and NOT added to stock, and that consumed is never subtracted
on top of incurred.

All five create their own records and clean up after themselves. Run them after
touching anything in `api/src/shared/` or `api/src/permissions/`.

### Checking your approval routing

```bash
cd api && npx tsx scripts/audit-workflows.ts
```

Read-only. Reports any workflow step that routes to a role nobody holds, or to
the role that normally *raises* that document — both of which leave documents
stuck with no error anywhere. Run it after assigning roles, and any time
approvals seem not to be arriving.

> The verification scripts consume real numbering sequences, so after a few runs your quotation
> numbers will be well past 0001. That only affects this laptop — the server
> starts from a fresh seed.

### Useful commands

```bash
cd api && npm run seed
```

```bash
cd api && npx prisma studio
```

```bash
cd api && npx prisma db push
```

## Layout

```
api/
  prisma/schema.prisma      one schema for the whole business
  prisma/seed.ts            permissions, roles, workflows, numbering, admin
  src/permissions/          the registry — source of truth for access AND the menu
  src/shared/               approvals, numbering, audit, notifications,
                            attachments, search, pdf  ← reused by every module
  src/routes/
web/
  src/components/DataList.tsx   the one list pattern every screen uses
  src/components/Shell.tsx      top bar, sidebar, notifications, Ctrl+K
  src/pages/
docs/
```

### The two files to understand first

**`api/src/permissions/registry.ts`** declares every module, screen and action in
G-Core. It generates the `Permission` rows *and* the navigation menu, so a screen
cannot appear without the access to open it, or vanish while the access still
exists. Adding a screen in a later phase means adding an entry here.

**`api/src/shared/approvals.ts`** routes every document type — leave, overtime,
purchase requests, budget requests, quotations, POs, invoices, expenses. A module
calls `submitForApproval(...)` and subscribes with `onApprovalSettled(...)`. It
never implements routing, notification or history itself.

## Security notes

- A requester can never approve their own document — enforced in the engine, for
  super admins too.
- Permission checks are server-side. The front end only decides what to render.
- A per-person `DENY` beats any grant from a role.
- Password hashes and cost rates are stripped before anything reaches the audit
  log or an API response (`api/src/shared/audit.ts`).

`npm audit` reports a high-severity advisory in `deepmerge-ts`, reached through
the Prisma **CLI**'s config loader. It is a dev-time toolchain dependency that
only ever parses our own schema; it is not in the server's runtime path. Prisma 7
drops it but pulls in an unused `mysql2` advisory instead, so the tree is pinned
to Prisma 6.19.3 for now.

## Deploying — read before writing any script

The production server is **shared with a safety-critical system**
(`gasion-vision`, live hospital oxygen-plant monitoring). Careless restarts have
taken it down three times. See
[docs/BUSINESS-OPERATIONS-MODEL.md §12](docs/BUSINESS-OPERATIONS-MODEL.md).

- **Never** kill Node by image name (`taskkill /F /IM node.exe`,
  `Get-Process node | Stop-Process`). Restart by PID, by port, or via this app's
  own service entry.
- **Never** stop or reconfigure the `Cloudflared` Windows service — it belongs to
  the other system.
- **Never** run `pm2 kill` / `pm2 delete all` / `pm2 startup` on that host.
- G-Core gets its own port, own tunnel and own process entry.

In production the API also serves `web/dist`, so there is one origin and one
tunnel: build the web app, then start the API.
