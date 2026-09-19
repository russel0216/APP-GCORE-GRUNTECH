# AI_APPLICATION_CONTEXT.md

Context for an AI reviewer who has not worked on this codebase before.

Everything below was read out of the source at commit `ff764f8`. Where a thing
the reader might expect does **not** exist, this document says so explicitly
rather than leaving a gap that could be mistaken for an oversight — those
sections are marked **Does not exist**.

This document describes. It does not propose an architecture and it does not
recommend changes beyond naming areas worth inspecting (§14).

---

## 1. Application overview

**G-CORE** is the integrated business operations platform for **Gruntechnology
Corp**, a Philippine contractor that designs, installs and maintains industrial
gas systems — principally oxygen generation plants for hospitals, plus
compressed air and related plant.

It replaces four separate applications that each kept their own database and
their own copy of "customer". The entire point of the rebuild is **one
codebase, one database, one schema**, so a customer, a job and a peso of cost
exist once and are referred to everywhere else.

**Who uses it.** Roughly 12–40 internal staff across sales, project delivery,
procurement, warehouse, service engineering, finance and HR — plus management.
There is no customer-facing portal and no public surface; every user is an
employee with a login.

**Main business purpose.** Carry a piece of work from first enquiry through to
cash collected, and then through the service life of what was installed, with
the approvals and the cost ledger attached to it the whole way.

**Single tenant.** Gruntech only. A sister company (Gas Ion) runs its own
separate deployment of a predecessor system. Company name, logo, address, TIN
and tax rates are configurable because they print on documents — that is
branding, not multi-tenancy. Do not introduce tenant scoping.

**Size.** ~21,900 lines of API TypeScript, ~30,800 lines of web TypeScript, a
2,889-line Prisma schema with **83 models and 43 enums**, and a 2,527-line
stylesheet.

---

## 2. Technology stack

| Layer | Choice |
|---|---|
| Frontend | **React 18** + **React Router 6** + **TypeScript**, built by **Vite 6** |
| Backend | **Node 24** + **Express** + **TypeScript** |
| ORM | **Prisma 6.19.3** (pinned — see §11) |
| Database | **PostgreSQL 17** |
| Auth | **JWT** bearer tokens (`jsonwebtoken`), passwords hashed with **bcryptjs** |
| UI library | **None** |
| CSS | **One hand-written stylesheet**, `web/src/styles.css`, with CSS custom properties |
| State management | **None** — React `useState`/`useEffect` plus two contexts (`AuthProvider`, `ToastProvider`) |
| API | **REST / JSON** under `/api`, ~57 mounted route groups |

**The frontend has exactly three runtime dependencies**: `react`, `react-dom`,
`react-router-dom`. No Tailwind, no MUI, no Redux, no React Query, no charting
library, no icon package. This is deliberate and long-standing. An AI reviewing
this app should not assume a component library is available.

**API dependencies of note:** `pdfkit` (document engine), `multer` + `sharp`
(attachments and photos), `zod` (request validation), `@vladmandic/face-api` +
`@tensorflow/tfjs` (server-side face matching for time clock), `helmet`,
`compression`, `cors`, `morgan`.

---

## 3. Application structure

```
/
├── api/
│   ├── prisma/
│   │   ├── schema.prisma          83 models, 43 enums — the whole data model
│   │   └── seed.ts                14 roles, their permissions, approval workflows
│   ├── scripts/
│   │   ├── verify-<phase>.ts      9 scripts, 495 assertions (see §11)
│   │   ├── audit-workflows.ts     read-only check for unroutable approvals
│   │   ├── sandbox.ts             creates 12 demo users and a worked example
│   │   └── reset-password.ts      console recovery for a locked account
│   └── src/
│       ├── auth/                  JWT middleware, require_/requireAny guards
│       ├── http/kit.ts            listQuery, listResult, orderBy, error helpers
│       ├── permissions/
│       │   ├── registry.ts        THE SOURCE OF THE MENU AND THE PERMISSIONS
│       │   └── resolve.ts         resolveUser, can, canEditRecord, menuFor
│       ├── routes/                18 route files, one per business area
│       ├── shared/                14 cross-cutting services (see below)
│       └── index.ts               mounts every route group
│
├── web/
│   └── src/
│       ├── components/            6 shared components (see §9)
│       ├── lib/api.ts             fetch wrapper, ApiError, ListResult, SHIPPED_PHASE
│       ├── lib/auth.tsx           AuthProvider, useAuth → { me, can, canView, signOut }
│       ├── pages/                 ~45 page files in 8 folders
│       ├── App.tsx                every route, each wrapped in Guard/GuardAny
│       └── styles.css             the entire design system
│
├── docs/
│   ├── BUSINESS-OPERATIONS-MODEL.md   the specification (treated as normative)
│   ├── GAP-ANALYSIS.md
│   └── UI-IMPROVEMENT-PLAN.md
├── deploy/                        PowerShell/bash deployment scripts
└── CLAUDE.md                      15 standing rules for anyone editing this repo
```

**`api/src/shared/` — the cross-cutting services.** These matter more than the
route files, because the rules of the business live in them:

| File | What it owns |
|---|---|
| `approvals.ts` | The **single** approval engine. Every document type routes through it |
| `numbering.ts` | `nextNumber(type, tx)` — 30 document types, concurrency-safe |
| `pdf.ts` | `renderDocument(...)` — every printable document in the app |
| `audit.ts` | `audit(...)` and `redact()` |
| `notifications.ts`, `attachments.ts`, `search.ts`, `csv.ts` | as named |
| `inventory.ts` | moving weighted average, stock movement |
| `finance.ts` | `settleable()`, `refreshSettlement()` — what "outstanding" means |
| `hr.ts` | leave balances, overtime cost arithmetic |
| `face.ts` | `describeFace()` — server-side descriptor for the time clock |
| `aftermarket.ts` | PM schedule generation, `sweepOverdue()` |
| `insights.ts` | the reporting aggregations |

**`web/src/pages/` folder names do not match module names.** This trips people
up:

| Folder | Contains |
|---|---|
| `sales/` | Leads, Costings, Quotations, Calendar & Pipeline |
| `delivery/` | Projects, Project Workspace, Progress & Billing, S-Curve |
| `chain/` | Purchase Requests, Orders, Warehouse (receiving/issuance/inventory) |
| `service/` | Aftermarket — installed base, contracts, report templates, reports |
| `masters/` | Customers, Suppliers, Employees, Items, Reference data |
| `finance/`, `hr/`, `insights/`, `admin/` | as named |

---

## 4. Modules

Six modules exist, defined in `api/src/permissions/registry.ts`. That file is
the single source for both the `Permission` rows and the navigation — there is
no separate menu definition anywhere.

### G-OPS — Operations (23 screens)
Sales, project delivery and aftermarket under one roof, because in this
business they are one continuous process. Covers leads, customers, costings,
quotations, projects, budgets, progress reporting, progress billing, the
installed base, service contracts, preventive-maintenance scheduling and
service reports.

### G-HR — Human Resources (9 screens)
Time clock (with face recognition), attendance, leave, overtime, the employee
register and pay-rate data. **No payroll** — see §11.

### G-FIN — Finance (9 screens)
Accounts receivable, accounts payable, expense claims, payments, cash flow,
budget vs actual, reports, and finance's own settings. **Operations-driven
only: no general ledger, no chart of accounts, no fixed assets, no tax
filing.** This is a stated, settled decision.

### G-CHAIN — Supply Chain (12 screens)
Purchase requests, canvass/RFQ, purchase orders, receiving, stock issuance,
borrow slips, inventory, and the item/supplier/warehouse masters.

### Insights — Management reporting (6 screens)
Company overview, project profitability, sales analytics, cash forecast,
inventory analytics, performance. **Adds no tables.** Every figure is read off
documents the other modules record. The router ends with middleware that
refuses any non-GET request, and there is a test for it.

### Admin — Configuration (9 screens)
Users, roles & permissions, approval workflows, numbering, categories, company
settings, system settings, audit logs, document templates.

### Modules that do NOT exist

- **Logistics / delivery / dispatch as a module.** There is no `Delivery`,
  `Shipment` or `DispatchNote` model. Goods movement is covered by *Receiving*
  (supplier → us), *Stock Issuance* (warehouse → job) and *Borrow Slips* (tools
  out and back). There is no vehicle, route, driver or shipment tracking.
- **Payroll.** Explicitly out of scope.
- **HR performance appraisal.** Insights' "Performance" screen reports
  operational output (approval bottlenecks, throughput), not staff appraisal.
  This is deliberate: aggregating attendance into a management league table
  would turn a payroll record into a surveillance tool.

---

## 5. Navigation structure

The menu is **two levels**. The sidebar lists a module's *sections*; the
section you are in opens its screens on a second line across the top of the
page. Both come from the `group` field on each registry entry. A module that
declares no groups (Insights) renders flat with no second line.

```
G-CORE launcher  (/)  — four division cards + My Work summary
│
├── G-OPS  (/g-ops)
│   ├── Overview
│   │   └── Dashboard                   /g-ops
│   ├── Sales
│   │   ├── Leads                       /g-ops/leads
│   │   ├── Customers                   /g-ops/customers
│   │   ├── Calendar                    /g-ops/calendar
│   │   ├── Quotations                  /g-ops/quotations
│   │   ├── Sales Pipeline              /g-ops/pipeline
│   │   └── Costing                     /g-ops/costing
│   ├── Delivery
│   │   ├── Projects                    /g-ops/projects
│   │   ├── Approved Plans              /g-ops/plans
│   │   ├── Budget Monitoring           /g-ops/budget-monitoring
│   │   ├── Purchase Requests           /g-ops/purchase-requests
│   │   ├── Budget Requests             /g-ops/budget-requests
│   │   └── Progress & Billing          /g-ops/progress
│   ├── Aftermarket
│   │   ├── Aftermarket                 /g-ops/aftermarket
│   │   ├── Installed Base              /g-ops/installed-base
│   │   ├── Service Contracts           /g-ops/service-contracts
│   │   ├── PM Schedule                 /g-ops/visits
│   │   ├── Renewals                    /g-ops/renewals
│   │   └── Service Costing             /g-ops/service-costing
│   └── Service reports
│       ├── Report Templates            /g-ops/report-templates
│       ├── Commissioning Reports       /g-ops/commissioning
│       ├── Preventive Maintenance      /g-ops/pm
│       └── Service Inspections         /g-ops/inspections
│
├── G-HR  (/g-hr)
│   ├── Overview   └── Dashboard        /g-hr
│   ├── My day
│   │   ├── Clock In/Out                /g-hr/clock
│   │   ├── Leave                       /g-hr/leave
│   │   └── Overtime                    /g-hr/overtime
│   ├── Records
│   │   ├── Attendance                  /g-hr/attendance
│   │   ├── Employees                   /g-hr/employees
│   │   └── Employee Pay Rates          /g-hr/employees   (same screen, gates pay data)
│   └── Administration
│       ├── HR Reports                  /g-hr/reports
│       └── HR Settings                 /g-hr/settings
│
├── G-FIN  (/g-fin)
│   ├── Overview   └── Executive Dashboard   /g-fin
│   ├── Money in
│   │   ├── Accounts Receivable         /g-fin/ar
│   │   └── Payments                    /g-fin/payments
│   ├── Money out
│   │   ├── Accounts Payable            /g-fin/ap
│   │   └── Expenses                    /g-fin/expenses
│   ├── Analysis
│   │   ├── Cash Flow                   /g-fin/cash-flow
│   │   ├── Budget vs Actual            /g-fin/budget-vs-actual
│   │   └── Reports                     /g-fin/reports
│   └── Administration
│       └── Finance Settings            /g-fin/settings
│
├── G-CHAIN  (/g-chain)
│   ├── Overview   └── Dashboard        /g-chain
│   ├── Procurement
│   │   ├── Purchase Requests           /g-chain/purchase-requests
│   │   ├── Canvass / RFQ               /g-chain/canvass
│   │   └── Purchase Orders             /g-chain/purchase-orders
│   ├── Warehouse
│   │   ├── Receiving                   /g-chain/receiving
│   │   ├── Stock Issuance              /g-chain/stock-issuance
│   │   ├── Borrow Slips                /g-chain/borrow-slips
│   │   └── Inventory                   /g-chain/inventory
│   ├── Master data
│   │   ├── Item Master                 /g-chain/items
│   │   ├── Suppliers                   /g-chain/suppliers
│   │   └── Warehouses                  /g-chain/warehouses
│   └── Analysis
│       └── Reports                     /g-chain/reports
│
├── Insights  (/insights)   — top bar, not the launcher grid
│   ├── Company Overview                /insights
│   ├── Project Profitability           /insights/profitability
│   ├── Sales Analytics                 /insights/pipeline
│   ├── Cash Forecast                   /insights/cash-forecast
│   ├── Inventory Analytics             /insights/inventory
│   └── Performance                     /insights/performance
│
└── Admin  (/admin)         — top bar, not the launcher grid
    ├── People         ├── Users                /admin/users
    │                  └── Roles & Permissions  /admin/roles
    ├── Process        ├── Approval Workflows   /admin/workflows
    │                  ├── Numbering            /admin/numbering
    │                  └── Document Templates   /admin/templates   ← NOT BUILT
    ├── Configuration  ├── Company Settings     /admin/company
    │                  ├── Categories           /admin/categories
    │                  └── System Settings      /admin/settings
    └── Records        └── Audit Logs           /admin/audit
```

**Screens outside the module menus:** `/` (launcher), `/my-work`, `/account`,
`/login`.

**Notes for a reviewer:**
- Some screens are reached only from inside a record, not from the menu — the
  **Project Workspace** (`/g-ops/projects/:id`, eight tabs including Tasks),
  **Customer 360** (`/g-ops/customers/:id`), quotation/costing/billing detail
  pages, and the **S-Curve**.
- **Purchase Requests appears in two modules** (`/g-ops/purchase-requests` and
  `/g-chain/purchase-requests`). Same screen, two paths, two permission sets —
  deliberate: a project manager raises one, procurement works it.
- **`/admin/templates` is the only menu entry with no screen.** It renders a
  "Not built yet" placeholder. PDF layouts are code inside `renderDocument()`,
  not configurable data.

---

## 6. Business workflows

These are the chains that actually exist in the code.

### 6.1 Sales → cash

```
Lead ──► Costing ──► Quotation ──► QuotationRevision ──► [approval] ──► Job
                                                                         │
      ┌──────────────────────────────────────────────────────────────────┘
      ▼
   ProgressReport ──► [approval] ──► ProgressBilling ──► [approval] ──► Invoice
                                                                         │
                                                              Payment ◄──┘
                                                          (+ PaymentAllocation)
```

- A **Lead** is the opportunity. **There is no `Opportunity` entity** — the
  pipeline is a view over leads plus quotations.
- A **Costing** carries `ScopeSection` rows which are *simultaneously* the
  scope of work and the **Schedule of Values**. One record, deliberately. The
  SOV must total the contract value exactly.
- A **Quotation** owns `QuotationRevision` rows. **There is no `Proposal`
  entity** — a revision is the proposal. A revision leaves DRAFT and never
  returns; only one revision may be APPROVED, and approving supersedes any
  earlier one inside a transaction.
- A **Job** is created from an approved costing (`costingId` is required) and
  optionally records the `quotationRevisionId` it came from.
- `JobScopeItem` is a **snapshot** of the costing's `ScopeSection`, not a
  reference — so reopening a costing cannot shift percentages that reports
  already recorded.
- Progress reports form a **chain**: only one open at a time, each carrying the
  previous to-date percentages forward.
- A billing covers **only the increment** — it compares to-date against the
  highest already billed per scope line.
- An **Invoice** is raised from a billing and copies its figures (both tax
  rates, both amounts, the line breakdown). `progressBillingId` is `@unique`,
  which is what makes double-invoicing impossible rather than discouraged.

### 6.2 Procurement → inventory → job cost

```
PurchaseRequest ──► [approval] ──► Canvass/RFQ ──► PurchaseOrder ──► [approval]
                                                                        │
                                                                     issued
                                                                        ▼
                                                                   Receiving
                                                                        │
                        ┌───────────────────────────────────────────────┤
                        ▼ (DIRECT_TO_JOB)                               ▼ (STOCK)
                  charged to job                                InventoryBalance
                                                                        │
                                                                  StockIssue ──► job
```

- The two purchase kinds **must stay disjoint**. `DIRECT_TO_JOB` charges the
  job at receiving and builds no stock. `STOCK_REPLENISHMENT` builds stock and
  charges a job only at issuance. Adding a direct-to-job receipt to inventory
  would let the same material be charged twice.
- **Every handover releases what came before**: PR approval commits at
  estimate → PO issue releases that and commits the agreed price → receiving
  releases that and incurs. `releaseCommitment()` posts a negative row rather
  than deleting, so the ledger stays a history.
- Inventory uses **moving weighted average**: a receipt recomputes it, an issue
  takes it as given.
- **Borrow slips** move stock out of *available* while leaving it owned — they
  do not charge job cost.

### 6.3 The cost ledger

Every peso reaching a job goes through **`JobCostEntry`**, never by editing a
stored total. Each row has a `state`, a `sourceType`/`sourceId` and a cost
category.

```
Available = BUDGETED − COMMITTED − INCURRED
```

**CONSUMED is reported but never subtracted** — stock issued to a job was
already counted as incurred when it was received, and subtracting both charges
the same peso twice.

### 6.4 HR

```
Employee ──1:1 optional──► User (the login)

Clock in/out ──► Attendance   (photo stored on every entry; face match server-side)
LeaveRequest ──► [approval] ──► balance spent on APPROVAL, not on filing
OvertimeRequest ──► [prior approval]  →  PRIOR_APPROVED   (moves NO money)
                ──► [supervisor → HR] →  posts INCURRED at ACTUAL hours
```

- The **reporting line lives on `User`, not `Employee`**, because the approval
  engine routes by user.
- Pay data (`dailyRate`, `burdenMultiplier`, statutory numbers) is **stripped
  server-side** unless the caller holds `ghr.employee_rates.view_all`.
- Projects are charged the **burdened** rate, never the wage:
  `dailyRate × burden ÷ hoursPerDay × premium`.
- **Absence is derived, never stored** — inferred from active employees with no
  attendance row and no approved leave.
- **Chain ends at overtime.** There is no payroll run, no payslip, no statutory
  remittance.

### 6.5 Aftermarket

```
Job (installation) ──► InstalledAsset ──► ServiceContract (IS a Job, type SERVICE_CONTRACT)
                                                  │
                                          ServiceVisit (PM schedule)
                                                  │
                          ReportTemplate ──► ServiceReport ──► [approval] ──► visit COMPLETED
                                                  │
                                            Renewals pipeline
```

- A **service contract IS a job** of type `SERVICE_CONTRACT`. `ServiceContract`
  is a 1:1 extension carrying only what a job cannot: what is covered, how
  often, and until when. Its costing, budget, SOV and billing are the same
  Phase 3/4 machinery.
- A **template that has been used is immutable** — editing publishes a new
  version and old reports keep pointing at the version they were signed on.
- A visit completes when its **report is approved**, not when the engineer
  leaves site.
- The renewal pipeline has **two sources**: contracts ending, and warranties
  lapsing on equipment with no active contract.

### 6.6 Approvals (the spine)

Every document type routes through **one engine** (`shared/approvals.ts`).

- `submitForApproval(...)` raises a request; `onApprovalSettled(...)`
  subscribes to the outcome.
- **A requester can never approve their own document** — enforced in `act()`,
  before the eligibility check, and for super admins too.
- **Cost posts only when every step has approved.** Overtime is the live
  example: supervisor *and* HR.
- Workflows are selected by document type **and amount band**.
- Seeded workflows: leave, overtime (prior + actual), purchase request (two
  amount bands), budget request, quotation, purchase order, supplier bill (two
  bands), expense, commissioning report, PM report, inspection report.

---

## 7. Database / data relationships

83 models. The ones that carry the business:

**Identity & access:** `User` (login, `supervisorId` self-relation), `Role`,
`Permission`, `RolePermission`, `UserRole`, `UserPermissionOverride` (ALLOW or
DENY per person), `Department`.

**Cross-cutting:** `Company` (single row, id `"company"`), `Setting` (keyed
config), `NumberSequence`, `ApprovalWorkflow` → `ApprovalStep` →
`ApprovalRequest` → `ApprovalAction`, `Notification`, `Attachment`, `AuditLog`,
`SavedFilter`.

**Masters:** `Customer` → `CustomerContact`, `CustomerSite`; `Supplier` →
`SupplierContact`; `Employee`; `Item` + `ItemCategory`; `CostCategory` (five
system rows, undeletable); `Warehouse` → `Location`.

**Sales:** `Lead`, `Costing` → `CostingLine` / `ScopeSection` → `ScopeTask`,
`Quotation` → `QuotationRevision` → `QuotationItem`, `SalesActivity`.

**Delivery:** `Job` (→ customer, site, contact, costing, quotationRevision,
projectManager), `JobScopeItem`, **`JobCostEntry`**, `BudgetRequest`,
`ProgressReport` → `ProgressReportLine`, `ProgressBilling` →
`ProgressBillingLine`, `ApprovedPlan`, `JobTask`.

**Supply chain:** `PurchaseRequest` → `PurchaseRequestItem`, `Canvass` →
`CanvassSupplier` / `CanvassQuote`, `PurchaseOrder` → `PurchaseOrderItem`,
`Receiving` → `ReceivingItem`, `StockIssue` → `StockIssueItem`, `BorrowSlip` →
`BorrowSlipItem`, `InventoryBalance`, `InventoryTransaction`.

**HR:** `FaceEnrollment`, `Attendance`, `LeaveType`, `LeaveBalance`,
`LeaveRequest`, `OvertimeRequest`.

**Finance:** `Invoice` → `InvoiceLine`, `SupplierBill` → `SupplierBillLine`,
`ExpenseClaim` → `ExpenseClaimLine`, `Payment` → `PaymentAllocation`.

**Aftermarket:** `InstalledAsset`, `ServiceContract` → `ServiceContractAsset`,
`ServiceVisit`, `ReportTemplate`, `ServiceReport`.

### Relationships worth knowing before touching anything

- **`Job` is the hub.** Sales, cost, procurement, progress, billing and service
  all hang off it.
- **`JobCostEntry` is the single ledger.** `sourceType`/`sourceId` says which
  document caused each row. Budget Monitoring is a view over this table.
- **`Invoice.progressBillingId` is `@unique`** — one invoice per billing.
- **A service contract's `jobId`** is how aftermarket reuses all the delivery
  machinery.
- **`Employee` ↔ `User` is 1:1 and optional** — a labourer may have no login.
- **Money is Prisma `Decimal`**, converted with `Number()` only at the API
  boundary.

### Philippine tax, which shapes several tables

VAT **12%** on top; EWT **2%** withheld **on the gross, not on the VAT**.

```
Net collectible = gross + VAT − EWT
```

**Invoiced ≠ collectible.** A/R measures outstanding against *net collectible*,
never the invoice total — measuring against the total would leave every
customer permanently short by the withheld EWT and make them all look late.
`vatRate` and `ewtRate` are **snapshotted** onto each revision, billing and
invoice so an old document still prints the tax it was issued under.

---

## 8. User roles and permissions

### How permission works

A permission key is `module.submodule.action`, e.g. `gops.quotations.edit_own`.
**299 permissions** are generated from the registry — they are never written by
hand.

Eight actions: `view_own`, `view_all`, `create`, `edit_own`, `edit_all`,
`delete`, `approve`, `export`.

Resolution order (`permissions/resolve.ts`):

1. Permissions granted by the user's roles, **union**
2. A per-user `UserPermissionOverride` of `ALLOW` adds one
3. A per-user override of `DENY` **beats everything**, including the role grant
4. `isSuperAdmin` bypasses the lot — *except* the rule that nobody approves
   their own document

**`menuFor(user)` derives the navigation from the same permissions**, so the
menu can never show a screen the user cannot open.

**Record ownership is real:** `canEditRecord(user, module, sub, ownerId)` —
"only the author can edit the quotation; super admin can edit all".

### The 14 seeded roles

| Key | Name | Broadly |
|---|---|---|
| `executive` | Executive / Management | Everything readable, approves at the top band, the only role seeing all of Insights |
| `sales` | Sales | Own leads, costings, quotations |
| `sales_manager` | Sales Manager | All of sales, approves quotations |
| `project_manager` | Project Manager | Projects, budgets, progress, approves PRs and POs |
| `project_engineer` | Project Engineer | Assigned projects, raises PRs and progress |
| `service_engineer` | Service Engineer | Installed base, visits, writes service reports |
| `service_manager` | Service Manager | All aftermarket, approves service reports |
| `procurement` | Procurement | PRs, canvass, POs, suppliers, items |
| `warehouse` | Warehouse | Receiving, issuance, borrow slips, inventory |
| `finance` | Finance | AR, AP, payments, expenses, finance settings |
| `accounting` | Accounting | Finance, read-weighted |
| `hr` | HR | Employees, attendance, leave, overtime, pay rates, HR settings |
| `supervisor` | Supervisor | Approves own reports' leave and overtime |
| `employee` | Employee | Clocks in, files leave and overtime, sees only their own |

Seeded super admin: `admin@gruntech.com`.

**The seed's grant rule** (worth knowing before changing it): a role/permission
pair the seed has **never offered** is granted; a pair it **has** offered before
is left alone, because its absence now means an administrator revoked it
deliberately. The record lives in the `seed.offeredRolePermissions` setting.

---

## 9. Important components

Six shared components. A reviewer should read these first — between them they
determine what most of the app looks like.

### `components/Shell.tsx` (~300 lines)
The application frame: top bar, module strip, sidebar, `<Outlet/>`. Owns the
two-level menu derivation, the longest-path active-item match, the notification
drawer, the Ctrl+K palette trigger and the skip link.

### `components/DataList.tsx` (~400 lines) — **the most important file in the web app**
**Every list screen in G-Core renders through this.** ~30 screens use it. One
column definition gets you: Add · Search (debounced) · Mine/All scope switch ·
Filters · Columns (persisted per viewer in `localStorage`) · CSV export ·
Refresh · server-side sorting with `aria-sort` · pagination · an active-filter
summary with Clear · keyboard-operable rows and headers · empty states that
fall back to the toolbar's own primary action.

### `components/ui.tsx` (~330 lines)
`ToastProvider` / `useToast`, `ErrorBox`, `Loading`, `Empty`, `Modal` (focus
trap, focus restore, `aria-labelledby`, body scroll lock), `Field` (label
wired to control via `useId`, plus `required` and `error`), `Checkbox`,
**`StatusBadge` / `statusTone()` / `humanise()`**, and the formatters
`formatDateTime`, `formatDate`, `formatMoney`, `relativeTime`, `initials`.

### `components/charts.tsx` (~320 lines)
`Stat`, `BarList`, `Funnel`, `Donut`, `Meter`, `MiniBar`, `Panel`. Hand-rolled
SVG and CSS. Two rules they hold to: every series carries its own number so the
chart is readable without colour, and an empty series says "nothing yet" rather
than drawing a frame that looks like a failed load.

### `components/CommandPalette.tsx`
Ctrl+K global search across entities the user may see, grouped by kind.

### `components/ImportModal.tsx`
The shared CSV import flow used by each master.

### On the API side
`renderDocument(...)` in `shared/pdf.ts` is the equivalent single point — every
printable document in the app goes through it, so branding, the sign-off block,
the footer and page numbering are identical by construction.

---

## 10. Current UI/UX

### Layout
Top bar (54px, sticky) → optional section strip → two columns: sidebar (196px
when sectioned, 232px flat, sticky, capped to viewport height) and the page.
Sidebar and the second-line nav both start at `top: 54px` and stay level while
scrolling.

### Visual identity
Dark, deliberately: black background, **neon green `#39ff9d`** and **magenta
`#c026d3`** as the two accents, **Orbitron** for display type and **Inter** for
anything data-dense. The launcher carries four animated GIF division marks.

**The launcher page (`pages/Home.tsx`) and its assets are explicitly off-limits
to redesign** — see §12.

### Design tokens (`styles.css`)
```
Spacing   --s-1 … --s-8        4 8 12 16 20 24 32 40
Type      --fs-xs … --fs-2xl   11 12 13 14 16 20 24
Colour    --neon --magenta --text --muted --faint --danger --warn --ok --info
          --bg --surface --surface-2 --surface-3 --line --line-soft
Shadow    --shadow-sm/md/lg
Focus     --focus-ring         (neon, offset)
Radius    --radius-sm/--radius/--radius-lg
```

Text contrast is **measured, not eyeballed**: `--text` 16.0:1, `--muted` 7.2:1,
`--faint` 4.6:1 against the card surface. `--faint` is the dimmest readable
colour in the system — nothing should go below it.

### The pieces

| Piece | State |
|---|---|
| **Tables** | One implementation (`table.data` via DataList). Sticky headers, zebra striping, `aria-sort`, keyboard-operable sortable headers, tabular figures, horizontal scroll |
| **Forms** | `Field` wires label→control; supports `required` and per-field `error`. Labels are neon-dim uppercase 11px |
| **Modals** | One `Modal`. Focus trapped and restored, Escape closes, body scroll locked, click-outside closes |
| **Tabs** | `.scope-switch` reused as tabs (Project Workspace, Progress & Billing) |
| **Filters** | Select dropdowns in the DataList toolbar, plus an active-filter count with "Clear all" |
| **Search** | Per-list debounced search (280ms) + global Ctrl+K palette |
| **Pagination** | 25/50/100 per page, Previous/Next, "1–25 of 400" |
| **Notifications** | Bell + drawer, polled every 60s; toasts for ok/error/warn/info with dismiss and `aria-live` |
| **Status** | One `StatusBadge`, one `statusTone()` with an `extra` override map |
| **Buttons** | `.btn` + `-primary`/`-ok`/`-danger`/`-ghost`/`-sm`/`-block`/`-icon` |
| **Icons** | **No icon library.** Unicode glyphs (⌕ 🔔 ✕ ↑↓↕) |
| **Empty states** | `Empty` with title, hint and an action slot; DataList distinguishes "nothing yet" from "no matches" |
| **Loading** | `Loading` spinner; DataList dims the table and runs a bar during re-fetch |
| **Errors** | `ErrorBox` renders the message plus the API's field-level `details[]` |

### Responsive
Breakpoints at **860px** (sidebar → horizontal section strip), **720px** (list
tools wrap to their own line), **640px** (page header wraps), **520px** (top bar
sheds the module badge and Sign out — Sign out also lives on the Account page).
Plus `@media (pointer: coarse)` for 44px touch targets and
`@media (prefers-reduced-motion: reduce)`.

Verified at 1440 / 1280 / 1100 / 768 / 375px with **no horizontal overflow**.

### Accessibility
Global `:focus-visible` ring; skip-to-content link; `aria-current` on the active
nav item; `aria-sort` on sortable headers; `aria-live` on toasts; labels wired
to controls; keyboard-operable rows, headers and cards.

---

## 11. Known limitations

**Functional gaps (by decision, not oversight)** — no general ledger or chart of
accounts; no payroll; no fixed-asset register; no tax filing; no logistics,
dispatch or shipment tracking; no customer portal; no e-mail sending (no SMTP
anywhere — password recovery is a console script by design); no scheduler/cron
(the aftermarket sweeps overdue records *on read* instead).

**Deferred with columns reserved:** downpayment recoupment and retention.
Nullable columns exist on `Job` and `ProgressBilling` so either can be switched
on without migrating history. **This is the open question with the highest
carrying cost** — it gets more expensive the longer real billing data
accumulates.

**Not built:** `/admin/templates` renders a placeholder.

**Technical:**

- **`status` query params are cast straight into Prisma enum filters without
  validation — 18 sites across 7 route files.** A typo in a URL returns **500**
  rather than 400 or an ignored filter. This is a known, unfixed robustness bug.
- The web bundle is a single ~730 kB chunk (~172 kB gzipped). No code splitting.
- No automated front-end tests. Verification is 495 API-level assertions across
  nine `verify-*.ts` scripts, plus manual browser checks.
- `npm audit` flags `deepmerge-ts` (high) reached through the **Prisma CLI's**
  config loader — a dev-time dependency not in the server's runtime path.
  Prisma 7 drops it but adds an unused `mysql2` advisory, so the tree is pinned
  to **6.19.3**.
- Face recognition loads TensorFlow WASM in the API process; first call is slow.
- Four looping GIFs totalling **6.7 MB** load on the launcher.

---

## 12. Important design constraints — do NOT change these

A UI redesign must leave all of the following intact.

### Hard product constraints
1. **The launcher page is off-limits.** `web/src/pages/Home.tsx`, the `.home-*`
   and `.module-*` styles and `web/public/modules/*.gif` were explicitly
   retained by the owner. Do not restyle, re-lay-out or replace them.
2. **Single tenant.** Do not add tenant scoping.
3. **No new dependencies** without a stated reason — no UI library, no CSS
   framework, no charting library, no icon package.
4. **Dark neon identity stays.** Black, neon green, magenta, Orbitron for
   display, Inter for data.

### Architectural rules (from `CLAUDE.md`, all load-bearing)
5. **The permission registry drives the menu.** Never hard-code a menu item;
   never check a permission string the registry does not define.
6. **One approval engine.** Never invent a second approval path.
7. **A requester can never approve their own document.**
8. **Cost posts only when every step has approved.**
9. **Numbers come from `nextNumber(type, tx)`** — never format one by hand.
10. **Every printable document goes through `renderDocument(...)`.**
11. **Record ownership via `canEditRecord(...)`.**
12. **Audit through `audit(...)`, with `redact()` in front of password hashes
    and cost rates.**
13. **Every list screen uses `DataList`; every chart uses `charts.tsx`.**
14. **Money is `Decimal`**, `Number()` only at the API boundary.
15. **Spacing, type and colour come from tokens.** `--faint` is the dimmest
    readable colour.
16. **Everything interactive is keyboard-reachable.** A `<div onClick>` that
    opens a record is a bug.
17. **Insights adds no tables, ever**, and its router refuses non-GET.

### Business arithmetic that must not be "simplified"
18. `Available = Budgeted − Committed − Incurred`; **CONSUMED is never
    subtracted**.
19. **EWT is withheld on the gross, not the VAT**; A/R measures against net
    collectible.
20. `JobScopeItem` is a **snapshot**, not a reference.
21. The two purchase kinds stay **disjoint**.
22. A **leave balance is spent on approval, not on filing**.
23. Face descriptors are computed **server-side**; a photo with more than one
    face is refused.
24. Tax rates are **snapshotted** onto documents.

### Deployment constraint (operational safety)
The production server is **shared with `gasion-vision`, a live hospital
oxygen-plant monitoring system**. Careless restarts have taken it down three
times. Never kill Node by image name, never touch the `Cloudflared` Windows
service, never run `pm2 kill`. Restart only by PID, by port, or via G-Core's own
scheduled task. Full rules in `CLAUDE.md` and `deploy/README.md`.

---

## 13. Cross-module relationships

```
                    ┌──────────── CUSTOMER (one record, used everywhere) ────────────┐
                    ▼                                                                 │
   SALES ──────► Lead ─► Costing ─► Quotation ─► approved revision                   │
                                                       │                              │
                                                       ▼                              │
   DELIVERY ────────────────────────────────────► JOB ◄──────── the hub ──────────────┘
                                                   │
        ┌──────────────────────┬───────────────────┼────────────────────┬─────────────┐
        ▼                      ▼                   ▼                    ▼             ▼
   BudgetRequest        PurchaseRequest       ProgressReport      ServiceContract   JobTask
        │                      │                   │                    │
        │              PROCUREMENT                 ▼                    ▼
        │              Canvass ─► PO ─► Receiving  ProgressBilling   ServiceVisit
        │                      │            │            │                │
        │                      │            ▼            ▼                ▼
        │                      │       WAREHOUSE      FINANCE       ServiceReport
        │                      │       StockIssue     Invoice              │
        │                      │            │            │                 │
        └──────────────────────┴────────────┴────────────┘         (approval completes
                               │                                     the visit)
                               ▼
                    ►►► JobCostEntry ◄◄◄     ONE LEDGER
              BUDGETED · COMMITTED · INCURRED · CONSUMED
                               │
                               ▼
                     Budget Monitoring, Project Profitability

   HR ──► Employee ──1:1──► User ──► approval routing (supervisorId)
              │                          │
              └──► Attendance            └──► every approval in the system
                   Leave
                   Overtime ──► posts INCURRED to JobCostEntry (burdened rate)

   INSIGHTS ──► reads everything above. Writes nothing. Owns no table.
```

**How each pair actually touches:**

- **Sales → Delivery:** a `Job` requires a `costingId` and records its
  `quotationRevisionId`. Scope is copied as a snapshot, not referenced.
- **Delivery → Procurement:** a purchase request names a job and a cost
  category; PR approval commits budget against it. The **budget guard** blocks a
  direct-to-job PR exceeding a category's available budget unless
  `procurement.blockOverBudget` is turned off in Settings.
- **Procurement → Warehouse:** receiving either charges the job (direct) or
  builds stock (replenishment) — never both.
- **Warehouse → Delivery:** stock issuance posts CONSUMED against the job.
- **HR → Delivery:** approved overtime posts INCURRED at the **burdened** rate.
- **Delivery → Finance:** an approved progress billing becomes an invoice,
  carrying both tax rates.
- **Procurement → Finance:** a supplier bill matched to a receiving posts **no**
  job cost — the receiving already incurred it. A bill with nothing received
  behind it (subcontract, service call, utility) *does* post, at the subtotal,
  because input VAT is recoverable.
- **Delivery → Aftermarket:** a finished installation becomes an
  `InstalledAsset`; a service contract is itself a `Job`.
- **Everything → Approvals, Numbering, PDF, Audit, Notifications:** one
  implementation each.
- **Everything → Insights:** read-only, reconciled against the source documents.

---

## 14. Recommended areas for future UI/UX review

Areas worth another reviewer's attention. **No redesign is proposed here** —
these are places to look.

**Workflow visibility**
1. Whether a user can see *where a document is* in its approval chain without
   opening it. `My Work` shows what is waiting on you; the reverse question —
   "who is sitting on mine, and for how long" — may be harder to answer.
2. The hand-off points between modules (PR → PO → receiving → bill). Each is a
   different screen in a different module; how much manual navigation that costs
   is worth measuring.
3. Whether the Project Workspace's eight tabs are the right cut, and whether
   anything in them is hard to find.

**Navigation**
4. G-OPS carries 23 screens under five sections. Worth checking the section
   names read the way the business speaks.
5. Screens reachable only from inside a record (S-Curve, Customer 360, detail
   pages) — whether users can find them.

**Density and data entry**
6. Form length on the costing and quotation screens.
7. Whether tables need bulk actions — there are none anywhere today.
8. Whether the 25-row default page size suits the real data volumes.

**Dashboards**
9. The four module dashboards were built at different times and only G-OPS has
   been through a graphics pass. G-HR, G-FIN and G-CHAIN are still
   counts-in-a-grid.
10. Whether each dashboard answers a decision or just reports numbers.

**Consistency**
11. Detail/record pages did not go through the shared-component pass that list
    screens did — worth auditing for divergent layouts.
12. Terminology: "Job" vs "Project" vs "Contract" all refer to the `Job` model
    in different places.

**Robustness**
13. The unvalidated enum filter bug in §11 (18 sites, returns 500).
14. No front-end tests; no code splitting.

**Known open business questions** (owner decisions, not UI):
15. Retention and downpayment recoupment — deferred, columns reserved.
16. Whether Gruntech withholds tax from its own suppliers.

---

## Quick orientation for a new reviewer

Read in this order:

1. **`CLAUDE.md`** — the 15 standing rules. Non-negotiable.
2. **`docs/BUSINESS-OPERATIONS-MODEL.md`** — the specification.
3. **`api/src/permissions/registry.ts`** — the menu and every permission.
4. **`api/prisma/schema.prisma`** — the data model.
5. **`api/src/shared/approvals.ts`** — the spine everything hangs off.
6. **`web/src/components/DataList.tsx`** — what ~30 screens look like.
7. **`web/src/styles.css`** — the whole design system.

Run it:

```bash
docker compose up -d          # Postgres on host port 5433, not 5432
cd api && npm run dev         # API on 5100
cd web && npm run dev         # web on 5173
```

Seeded admin: `admin@gruntech.com`. `api/scripts/sandbox.ts` creates twelve
demo users (password `Sandbox!2026`) and a worked example job.

Verify nothing is broken:

```bash
cd api && for s in foundation masters sales delivery chain hr finance aftermarket insights; do npx tsx scripts/verify-$s.ts; done
```

495 assertions. `verify-hr`, `verify-finance`, `verify-aftermarket` and
`verify-insights` need the API running — they check route guards over HTTP and
say so loudly rather than skipping if it is down.
