# G-CORE — Business Operations Model
**Gruntechnology Corp · `gruntech.gcore.tech`**

Canonical specification. Source documents:
- `gcore gruntech.docx` — the business requirements (what Gruntech actually does)
- `G-Core_Improved_Business_Operations_Reference.pdf` — structural improvement proposal
- Existing reference implementation at `gasiontech.gcore.tech` (4 separate repos)

Where the two documents disagree, this file wins. Where this file is silent, the DOCX wins.

---

## 1. The business being modeled

Gruntech is a **design-build contractor and service organization** for industrial gas
and mechanical systems — oxygen plants, compressor rooms, medical gas piping,
pumps, fabrication, controls, testing & commissioning.

It runs **two revenue engines on one delivery machine**:

| | Project business | Service business (aftermarket) |
|---|---|---|
| Sold as | One-off contract / customer P.O. | Recurring service contract |
| Priced by | Costing → contract amount | Costing → contract budget |
| Delivered as | Scope of work → tasks → turnover | Scheduled visits → reports |
| Billed as | Progress billing against % complete | Milestone / periodic billing |
| Evidence | Progress reports + photos | Commissioning / PM / inspection reports |

Both consume the same resources — people, materials, equipment, subcontractors —
so **both must post to the same cost ledger**. This is the single most important
design decision in the system. A service contract is a *job with a different type*,
not a parallel universe with its own tables.

---

## 2. Design principles

1. **Process-driven, not menu-driven.** A user follows a transaction across
   departments. The menu is a way in, never the only way through.
2. **Enter once, reuse everywhere.** Customer, site, contact, item, employee and
   cost category are global masters. No module owns a private copy.
3. **Every document has a source and a successor.** A Project cannot exist without
   an approved Costing. A PO cannot exist without an approved PR. An Invoice cannot
   exist without a Progress Billing. Traceable backward and forward.
4. **Money moves through four states, never skipped:** Budgeted → Committed →
   Incurred → Consumed. Every peso on a job is in exactly one state.
5. **Commercial records are versioned, never overwritten.** Quotation revisions,
   budget variations and contract amendments are additive history.
6. **Configuration is data.** Approval thresholds, numbering, roles, PDF branding,
   report templates, leave allotments and cost categories live in Settings — not in
   code. This is also what makes a second tenant possible later.
7. **Record ownership is first class.** "Only the author can edit" is a real rule
   from the requirements. Every record carries an owner; permissions are
   `Module → Submodule → Action` where actions split Own / All.
8. **Approvals are one engine.** Leave, OT, PR, Budget Request, Quotation, PO,
   Invoice and Expense all route through the same workflow engine.
9. **Reuse before you create.** Before a new table, page, form or workflow — check
   whether an existing business entity already carries the concept.
10. **Evidence is attached, not described.** Progress, commissioning, PM and
    inspection reports require photos with timestamps.

---

## 3. The object spine

Five objects carry the whole system. Everything else hangs off them.

```
  CUSTOMER ──┬── OPPORTUNITY ── QUOTATION(rev) ──┐
             │                                   │
             └── SITE                            ▼
                                    ┌───────► JOB ◄────────┐
  SUPPLIER ── PURCHASE ORDER ───────┘   (Project | Service │
                                         Contract)         │
  EMPLOYEE ── TIMESHEET / OT ───────────────────────┘      │
                                                           │
  ITEM ── STOCK MOVEMENT ──────────────────────────────────┘
```

- **CUSTOMER** — one record, many contacts, many sites. Reachable from Sales,
  Projects, Finance, Procurement and Service. Backed by a **Customer 360** view:
  company info, contacts, sites, opportunities, quotations, contracts, projects,
  invoices, payments, service contracts, service reports, documents.
- **JOB** — the unifying object. `type = PROJECT | SERVICE_CONTRACT`. Owns the
  budget, the schedule of values, the cost ledger, the billing schedule and the
  document set. Both kinds require a linked approved **Costing** to be created.
- **COSTING** — where the contract amount comes from. Not a calculator; the
  structural origin of both budget *and* billing (see §5).
- **EMPLOYEE** — one record used by HR (attendance, leave, OT), by Jobs
  (assignment, labor cost) and by Auth (user account).
- **ITEM** — one master used by Costing (estimated), Procurement (ordered),
  Inventory (stocked) and Job (consumed).

---

## 4. The value streams

### 4.1 Opportunity-to-Contract (Sales)

```
Lead → Qualified → Site Visit → Costing → Quotation(R0) → Submitted
     → Negotiation (R1, R2…) → Customer approval → Customer P.O. → JOB created
```

**Lead** — number, company, contact, contact details, source, assigned salesperson,
date created, expected closing, estimated value, probability, status, next action,
notes, attachments. A lead is **assignable** to another user, who then works it.

**Statuses** — New, Contacted, Qualified, Site Visit, Costing, Quotation Created,
Quotation Submitted, Negotiation, Won, Lost, On Hold.

**Handoff rules**
- Create Quotation from a Lead carries: customer, contact, site, salesperson,
  scope, lead reference. Nothing is retyped.
- Quotation is **revision-controlled** (`GT-QT-2026-0001 R0/R1/R2`). Revisions are
  preserved. Only the **approved** revision may convert to a Job.
- Quotation is editable **only by its author**; Super Admin may edit any.
- Quotation actions: Edit · Open Costing · Generate PDF · Submit for Approval ·
  Duplicate · Send · Convert to Job.

**Pipeline view** — opportunities by stage with a salesperson-entered probability to
award; groupable by salesperson; weighted value = amount × probability.

**Sales calendar** — day/week view of what every salesperson is doing: site visits,
follow-ups, quotation deadlines. Extended (see §8) to also surface project
milestones and PM due dates, so one calendar answers "what is happening this week".

### 4.2 Contract-to-Cash (Delivery & Billing)

```
JOB → Budget (from Costing) → Approved Plan → Execution
    → Progress Report(n) → % Complete → Progress Billing → Invoice
    → Accounts Receivable → Collection → Turnover → Warranty
```

**Job dashboard** — status, progress %, contract value, budget, committed, actual
cost, gross profit, gross margin %, billed, collected, outstanding, schedule
(planned vs actual S-curve), tasks, open PRs/POs, and the document set.

**Approved Plan** — drawings/plans register with required attachment and timestamp;
can raise a change request. Execution should not start on an unapproved plan.

**Progress Report** — sequential (`PR-001, PR-002…`), each linked to the previous so
the chain reads first→latest. Standard construction-management format: period
covered, accomplishment per SOV line (previous / this period / to date), photos with
captions, manpower and equipment deployed, weather and delays, issues, next period
plan. Signed prepared / checked / approved.

**Progress Billing** — generated from the % complete of the progress report against
the Schedule of Values. Never keyed independently (see §5.3).

### 4.3 Requisition-to-Receipt (Procurement & Inventory — G-CHAIN)

```
Purchase Request → Approval → Canvass / RFQ (3 suppliers) → Supplier Selection
    → Purchase Order → Approval → Receiving (GRN) → Inventory
    → Stock Issuance → JOB cost
```

**Two kinds of PR — this distinction is what prevents double-counting cost:**

| PR type | Commits budget at | Charges job cost at |
|---|---|---|
| **Direct-to-job** (bought for a specific job) | PR approval (soft) → PO (firm) | Receiving |
| **Stock replenishment** (bought for the warehouse) | PR/PO against a stock budget | Stock Issuance to the job |

Every PR / PO / Receiving / Issuance line is linkable to a **Job + Cost Category**.
A direct-to-job line *must* carry both.

**Borrow Slip** — tools and equipment lent out and expected back. A non-consuming
movement with a due date and an overdue flag. **It does not charge job cost** unless
an internal equipment rental rate is configured in Settings — if it is, the rental
amount posts to the job's Equipment category on return or at period close.

**Inventory** — item master, stock balance, stock movement, stock card, minimum
stock, reorder level, warehouse, location, serial number, batch number.

### 4.4 Time-to-Cost (G-HR → job labor cost)

```
Clock In/Out (face recognition, biometric fallback) → Attendance
    → Timesheet allocation to JOB → burdened labor cost → JOB actual cost
Overtime: Prior Approval (estimated hrs) → work → Actual filing
    → Approver + HR approval → posts to a JOB budget category
```

**Clock in/out** — available to anyone who can reach the app. Face recognition
required; biometric fallback when recognition fails. (The existing `G-CORE-HR` app
already ships this — reuse it.)

**Overtime is a two-step control**, and this is deliberate:
1. **Prior approval** — filed *before* the work, with estimated hours. The
   employee's evidence that the OT was authorized.
2. **Actual filing** — the real finish time. If actual ≠ estimated, the variance is
   shown and must be acknowledged by the approver.

Defaults: dinner break 17:00–18:00 (−60 min) pre-checked; unchecking means
continuous work.

**Dual approval to post cost.** OT is approved by (a) the direct supervisor or
manager who directed the work, and (b) HR — a separate, independently configurable
approval step. Only when **both** have approved does the OT amount post to the
selected Job and budget category, reducing available budget in Budget Monitoring.
Supervisors see their own people's filings; if no supervisor is set, HR approves.

**Leave** — overview of Requested / Pending / Approved / Rejected plus remaining
balance per type; filterable by person. Filing carries type, start and end date
*with time* (so half-days account correctly) and reason. Approver is the direct
report line; HR approves when none is set. Settings holds the allotted count per
leave type and the custom table columns used by the CSV export.

**HR dashboard** — daily or date-specific overview; Present / Late / On Leave /
Absent / Pending Approval; CSV extract over a date range.

**Employee cost rate** is sensitive. It lives on the Employee record, visible only
to Finance and HR, and to the Project Manager as a burdened rate rather than a
salary.

### 4.5 Warranty-to-Renewal (Aftermarket)

```
JOB turnover → Installed equipment register → Warranty period
    → Service Contract → PM schedule → Service visit
    → Commissioning / PM / Inspection report → Billing → Renewal
```

A Service Contract is a **Job of type SERVICE_CONTRACT**: it has its own costing,
contract budget across the same five cost categories, scope of work with duration,
main work (e.g. "Plant-wide PMS of water pumps") and tasks per category.

**Report templates are data.** Commissioning, PM and Inspection reports are built
from a **form template** a service engineer can customize, duplicate and save as a
new template. Photos attachable per section. Templates are versioned so an old
report still renders the way it was signed.

**Installed base** — what Gruntech installed, where, serial numbers, warranty end,
linked to the originating project and to every service report since. This is what
turns a finished project into a renewal pipeline.

### 4.6 Record-to-Report (G-FIN)

Finance **consumes** operational transactions. It does not re-key them.

```
Progress Billing → Invoice → A/R → Payment → Collection
Purchase Order → Receiving → Supplier Invoice → A/P → Payment
Expense claim → Approval → Reimbursement
All of the above → General Ledger → Financial Statements
```

**Scope — decided.** G-FIN is **operations-driven finance only**: Accounts
Receivable, Accounts Payable, Expenses, Payments, Cash Flow, Budget vs Actual and the
Executive Dashboard. Every one of these falls straight out of operational
transactions with no re-keying, which is the point.

**Out of scope:** general ledger, chart of accounts, bank reconciliation, payroll,
fixed asset depreciation and tax filing. These stay with existing bookkeeping. The
DOCX lists them; they are a larger build than every other module combined, and none
of them is required for a project to be costed, delivered, billed and collected.

The boundary is drawn so it can move later: G-FIN records **what was invoiced,
what was paid and what is outstanding**, tagged by job, customer, supplier and cost
category. That is exactly the data a general ledger would consume, so adding one
later is an addition, not a rewrite.

---

## 5. The money model

### 5.1 Cost side — four states, per job, per cost category

Cost categories (fixed set, extensible in Settings):
**Materials · Equipment · Labor · Subcontractor · Indirect Cost**

| State | Created by | Meaning |
|---|---|---|
| **Budgeted** | Approved Costing + approved Budget Requests | What we are allowed to spend |
| **Committed** | Approved PR (soft) → issued PO (firm) | What we have promised to spend |
| **Incurred** | Receiving (direct), OT/timesheet posting, subcontractor certificate | What we now owe |
| **Consumed** | Stock issuance to the job, installed or used | What is actually in the work |

```
Available = Budgeted − Committed − Incurred
```

Every one of these is a row in a single **job cost ledger** carrying a source
document reference. There is no other way cost enters a job. Budget Monitoring is a
view over this ledger, not a separate set of numbers.

### 5.2 Budget Request vs Purchase Request — they are not the same thing

- A **Budget Request** *changes the budget*. It adds or reallocates budget on a job
  (a variation, a cost overrun, a scope addition). Approving it raises Budgeted.
- A **Purchase Request** *spends the budget*. Approving it raises Committed.

A PR that would push Available below zero is blocked, or requires a Budget Request
first — configurable per job in Settings. This is the control that makes budget
monitoring mean something.

### 5.3 Revenue side — the Schedule of Values is the backbone

This is the part the improvement reference under-specifies, and it is the crux of
the DOCX requirement: *"Costing includes also how it came up with the contract
amount or P.O. so that it will also reflect on progress billing."*

```
Costing scope of work
  ├─ Main work (e.g. Fabrication & controller assembly)
  ├─ Testing & Commissioning
  └─ Turnover
        │   each with duration and tasks
        ▼
  SCHEDULE OF VALUES  ── one line per scope item, with a contract value
        │
        ├──► Planned S-curve   (value × duration → planned % over time)
        ├──► Progress report   (actual % complete per SOV line)
        └──► Progress billing  (billed % per SOV line)
```

Three curves on one chart: **Planned · Actual · Billed**. The gap between actual and
billed is unbilled work; the gap between planned and actual is schedule slip.

Profitability:
```
Gross Profit  = Contract Value − Actual Cost
Gross Margin% = Gross Profit ÷ Contract Value
```

### 5.4 Billing mechanics

**In scope now — tax treatment.** Every progress billing and invoice computes:

```
Gross billed          = Σ (SOV line value × % billed this period)
Output VAT (12%)      = Gross billed × 0.12
Invoice total         = Gross billed + Output VAT
Less: EWT (2%)        = Gross billed × 0.02        ← withheld by the customer
Net collectible       = Invoice total − EWT
```

The consequence that matters operationally: **invoiced ≠ collectible**. The EWT is
withheld at source and comes back as a creditable tax certificate (BIR Form 2307),
not as cash. So A/R must track three figures per invoice — invoiced, collected, and
withheld — and **A/R aging must not report the withheld EWT as an overdue balance**.
Getting this wrong makes every customer look like a late payer.

VAT and EWT rates are **Settings values**, not constants — rates change, and some
customers (government agencies, PEZA-registered entities) withhold differently.

**Deferred, but structurally accommodated.** Downpayment/mobilization recoupment and
retention are not being built now. They are extremely common in Philippine
contracting, so the billing schema reserves the shape for them from the start:

- `ProgressBilling` carries nullable `downpayment_recouped` and `retention_withheld`
  columns, and the invoice template reserves the lines.
- `Job` carries nullable `downpayment_pct` and `retention_pct`.
- When null, billing behaves exactly as specified above.

This means turning either on later is a Settings change and a template line — not a
migration of historical billings. **If Gruntech's contracts do withhold retention or
bill a downpayment, say so before Phase 4 ships** and it is a day of work; retrofitting
it after real billings exist is considerably worse.

---

## 6. The control layer

### 6.1 One approval engine

A workflow definition is: **document type + condition → levels → approvers →
actions → notifications**. Conditions can test amount, job, department, cost category
and requester. Thresholds are configurable in Settings, never in code.

Used by: Leave, Overtime, Purchase Request, Budget Request, Quotation, Purchase
Order, Invoice, Expense and Service Report sign-off.

### 6.2 Segregation of duties

Enforced, not merely recommended:
- Requester ≠ approver on the same document.
- Procurement issues the PO · Warehouse receives · Finance pays — three roles, three
  records.
- The costing author cannot approve their own quotation.
- OT needs supervisor **and** HR before it touches job cost.

### 6.3 Permissions

`Module → Submodule → Action`, where Action ∈
**View Own · View All · Create · Edit Own · Edit All · Delete · Approve · Export**.

Suggested roles (all customizable): Super Admin, Executive/Management, Sales, Sales
Manager, Project Manager, Project Engineer, Service Engineer, Procurement,
Warehouse, Finance, Accounting, HR, Supervisor, Employee.

Per the home-screen requirement, an account's access is customizable **down to the
individual menu item** within G-OPS, G-HR, G-FIN and G-CHAIN.

### 6.4 Audit

Every major record carries Created By/Date, Modified By/Date, Approved By/Date and a
**status history**. The audit trail reads: Created → Submitted → Approved →
Converted/Executed → Completed.

---

## 7. The document layer

**One PDF engine.** Every printable document in every module renders through the same
pipeline so branding is uniform: company logo and details (from Settings), document
title, document number, revision, date, customer/project reference, content,
prepared/checked/approved signature blocks, page numbering (`Page n of m`).

**Numbering** — a configurable pattern per document type, with a company prefix so a
second tenant never collides:

```
GT-LEAD-2026-0001   GT-QT-2026-0001    GT-PRJ-2026-0001   GT-COST-2026-0001
GT-BR-2026-0001     GT-PR-2026-0001    GT-RFQ-2026-0001   GT-PO-2026-0001
GT-RR-2026-0001     GT-SI-2026-0001    GT-BS-2026-0001    GT-INV-2026-0001
GT-SC-2026-0001     GT-CR-2026-0001    GT-PM-2026-0001    GT-SR-2026-0001
```

**Attachments** — one attachment service for every module: file, type, size,
uploader, timestamp, linked record. Photos in reports keep their capture timestamp.

---

## 8. Navigation model

The requirement is explicit: improve on `gasiontech.gcore.tech`, don't copy it. The
existing shell is a four-card launcher into four disconnected apps. The improvement
is to make navigation **work-centric and record-centric**.

**Home stays as it is** — the G-CORE landing with the division cards, rebranded for
Gruntech. Below the cards it gains a **My Work** panel:

```
MY WORK
  Awaiting my approval (4)     Assigned to me (7)      My drafts (2)
  Overdue (1)                  Today's schedule        Recent records
```

**Four navigation improvements over the reference:**

1. **Record workspaces instead of menu hopping.** Opening a Job does not send you
   back to the menu to find its purchase requests. A job opens one workspace with
   tabs: *Overview · Costing · Budget · Plans · Procurement · Progress · Billing ·
   Documents · Activity*. Same pattern for Customer, Quotation and Service Contract.

2. **The lifecycle breadcrumb.** Every record shows its chain and lets you walk it in
   both directions:
   `Lead GT-LEAD-2026-0014 › Quotation GT-QT-2026-0022 R1 › Project GT-PRJ-2026-0009 › Billing #3`

3. **Global command palette (Ctrl+K).** One search across customer, contact, job,
   quotation, PO, PR, invoice, employee, supplier, item, service contract and
   document — plus actions ("new purchase request").

4. **One list pattern everywhere.** Every list screen: *Add New · Search · Filter ·
   Columns · Export · Refresh*, with sorting, pagination, saved filters, and the
   requirement's **View category switch (Mine / All)** and category-grouped search
   bar. Learn it once, use it in every module.

**Unified calendar** — sales activities, project milestones and PM due dates on one
calendar, filterable by person, team or job.

**Notification centre** — approval required, quotation awaiting approval, job behind
schedule, PO received, invoice overdue, leave/OT awaiting approval, PM due, borrow
slip overdue. Every notification **deep-links to the actual record**, not to a list.

---

## 9. Menu structure

```
G-CORE
├── HOME  (division cards + My Work + notifications + Ctrl+K)
├── G-OPS
│   ├── Dashboard ................ customizable widgets; sales + project overview
│   ├── Customer & Sales
│   │   ├── Leads ................ assignable; → Quotation
│   │   ├── Customers ........... global master, multi-contact, Customer 360
│   │   ├── Calendar ............ per-salesperson day view
│   │   ├── Quotations .......... author-edit, revisions, PDF
│   │   └── Sales Pipeline ...... stage view, probability, by salesperson
│   ├── Projects
│   │   ├── Project List ........ Mine / All, sortable; requires linked costing
│   │   ├── Project Workspace ... overview, progress, budget, cost, tasks
│   │   ├── Approved Plans ...... attachments + timestamps, change requests
│   │   ├── Budget Monitoring ... budgeted / committed / incurred / available
│   │   ├── Purchase Requests ... with approval notification
│   │   ├── Budget Requests ..... with approval notification
│   │   └── Progress & Billing .. sequential reports, photos, S-curve, billing
│   ├── Costing ................. Mine / All; 5 categories, scope, tasks, PDF
│   └── After Market
│       ├── Service Contracts ... requires linked costing
│       ├── Commissioning Reports  templated, duplicable
│       ├── Preventive Maintenance templated, duplicable, scheduled
│       ├── Service Inspections .. templated, duplicable
│       └── Service Costing ...... same 5 categories
├── G-HR
│   ├── Clock In/Out ............ face recognition, biometric fallback
│   ├── Dashboard ............... present/late/on-leave/absent/pending, CSV
│   ├── Leave ................... overview, file, approve, balances
│   ├── Overtime ................ prior approval, actual filing, job posting
│   ├── Employees
│   ├── Reports
│   └── Settings ................ leave allotments, CSV columns
├── G-FIN
│   ├── Executive Dashboard ..... revenue, opex, net margin, cash runway
│   ├── Accounts Receivable ..... invoices, aging, collections
│   ├── Accounts Payable ........ supplier bills, disbursement queue
│   ├── Expenses ................ claims, receipts, corporate cards
│   ├── Cash Flow ............... 30/60/90 projection
│   ├── Budget vs Actual
│   ├── Financial Statements .... (later phase — see §11)
│   └── Reports ................. custom report builder
├── G-CHAIN
│   ├── Dashboard
│   ├── Purchase Requests ....... job-linked or stock replenishment
│   ├── Canvass / RFQ
│   ├── Purchase Orders
│   ├── Receiving
│   ├── Stock Issuance
│   ├── Borrow Slips ............ due dates, overdue flags
│   ├── Inventory ............... item master, stock card, reorder levels
│   └── Reports
└── ADMIN / SETTINGS
    ├── Users · Roles & Permissions · Approval Workflows
    ├── Company Settings ........ name, logo, address, TIN — drives every PDF
    ├── Document Templates ...... PDF layouts + service report form templates
    ├── Numbering · Categories · Cost Categories
    ├── Audit Logs
    └── System Settings
```

---

## 10. Data model

One database. One schema. No per-division databases — that is the defect in the
current gasiontech implementation and the reason data gets re-keyed.

**Identity & config** — User, Role, Permission, RolePermission, Company,
NumberSequence, ApprovalWorkflow, ApprovalStep, Approval, Notification, AuditLog,
Attachment, DocumentTemplate, Setting

**Masters** — Customer, CustomerContact, CustomerSite, Supplier, SupplierContact,
Employee, Department, Item, ItemCategory, CostCategory, Warehouse, Location

**Sales** — Lead, Opportunity, Quotation, QuotationRevision, QuotationItem,
SalesActivity

**Jobs** — Job *(type: PROJECT | SERVICE_CONTRACT)*, Costing, CostingLine,
ScopeOfWork, JobTask, JobBudget, JobBudgetLine, BudgetRequest, JobCostLedger,
ScheduleOfValues, ProgressReport, ProgressReportLine, ProgressPhoto, ApprovedPlan,
ProgressBilling, ProgressBillingLine

**Procurement & inventory** — PurchaseRequest, PurchaseRequestItem, Canvass,
CanvassItem, CanvassSupplierQuote, PurchaseOrder, PurchaseOrderItem, Receiving,
ReceivingItem, StockIssue, StockIssueItem, BorrowSlip, BorrowSlipItem,
InventoryBalance, InventoryTransaction

**HR** — Attendance, TimeEntry, TimesheetAllocation, LeaveType, LeaveBalance,
LeaveRequest, OvertimeRequest *(prior + actual)*, FaceEnrollment

**Finance** — Invoice, InvoiceLine, Payment, PaymentAllocation, SupplierInvoice,
Disbursement, Expense, ExpenseLine, CashFlowForecast
*(later: Account/COA, JournalEntry, JournalLine, FixedAsset, PayrollRun)*

**Aftermarket** — ServiceContract *(a Job)*, InstalledAsset, PMSchedule,
ServiceVisit, ServiceReport, ServiceReportTemplate, ServiceReportSection,
WarrantyClaim

### Invariants the schema must enforce

- `Job` requires a non-null approved `Costing`.
- `PurchaseOrder` requires an approved `PurchaseRequest`.
- `ProgressBilling` requires a `ProgressReport`.
- `Invoice` requires a `ProgressBilling` (project) or a `ServiceVisit`/milestone.
- Every `JobCostLedger` row carries a source document type + id.
- Only one `QuotationRevision` per quotation may be `APPROVED`.
- An `OvertimeRequest` posts to the ledger only when supervisor **and** HR approvals
  both exist.

---

## 11. Build sequence

Each phase is shippable and independently useful.

| Phase | Scope | Done when |
|---|---|---|
| **1 · Foundation** | Auth, users, roles, granular permissions, company settings, numbering, audit log, attachments, notifications, approval engine, global search, list pattern, PDF engine | A user can log in, see only their menus, and any module can raise an approval and print a branded PDF |
| **2 · Masters** | Customers + contacts + sites, suppliers, employees, items, cost categories, warehouses | Customer 360 renders with empty tabs |
| **3 · G-OPS Sales** | Leads, calendar, quotations + revisions, costing, pipeline | A lead becomes an approved quotation with a costing and a PDF |
| **4 · G-OPS Delivery** | Job, budget, SOV, plans, tasks, progress reports, S-curve, progress billing | An approved quotation becomes a project that bills its first progress |
| **5 · G-CHAIN** | PR (both kinds), canvass, PO, receiving, inventory, stock issuance, borrow slips | A project PR flows to a PO, is received, and lands in the job cost ledger |
| **6 · G-HR** | Clock in/out, attendance, leave, overtime (prior + actual + dual approval + job posting), HR dashboard, CSV | Approved OT reduces a project's labor budget |
| **7 · G-FIN** | AR (with VAT/EWT), AP, expenses, payments, budget vs actual, cash flow, executive dashboard | Billing → invoice → collection with no re-keying, and aging that ignores withheld EWT |
| **8 · Aftermarket** | Installed base, service contracts, PM schedule, report templates, commissioning/PM/inspection reports, warranty | A turned-over project generates a PM schedule and a signed PM report |
| **9 · Intelligence** | Executive dashboard, project profitability, pipeline analytics, cash forecast, inventory analytics, performance reports | Management answers questions without exporting to Excel |

**Not in scope:** general ledger, chart of accounts, bank reconciliation, fixed
assets, payroll, tax filing (§4.6). Also deferred: downpayment recoupment and
retention (§5.4) — schema shape reserved, behaviour not built.

**Phases 1 and 2 are not optional and cannot be deferred.** Every defect in the
current gasiontech implementation traces back to their absence.

---

## 12. Architecture & deployment

**One repo, one database, one API, modular by domain.** Not four apps behind a
launcher — that is the architecture being replaced.

```
/api        Node + Express + TypeScript, Prisma → PostgreSQL
            modules/{auth,masters,sales,jobs,procurement,hr,finance,service}
            shared/{approvals,numbering,pdf,attachments,notifications,audit,search}
/web        React + Vite + TypeScript — shell, record workspaces, list pattern
/docs       this file and its companions
/deploy     scripts for the server
```

Rationale: the existing `G-CORE-HR` app is already Node/Express/TypeScript/Prisma/
React/Vite and already implements face recognition, approvals and auth — it is the
strongest reusable asset on the desktop. The inventory app contributes a working
stock/receiving/issuance model. The costing app contributes the costing sheet and
PDF layout. G-Core Gruntech should **absorb these patterns into one codebase**, not
fork four of them.

### Deployment constraints — read before writing any deploy script

The production server is **shared with a safety-critical system** (`gasion-vision`,
live hospital oxygen-plant monitoring). Per `G-CORE-HR/CLAUDE.md`, careless restarts
have taken it down three times. Non-negotiable:

- **Never** kill Node by image name (`taskkill /F /IM node.exe`,
  `Get-Process node | Stop-Process`). Restart by PID, by port, or via this app's own
  service or scheduled task only.
- **Never** stop or reconfigure the `Cloudflared` **Windows service** — it belongs to
  the other system. This app gets its own `cloudflared tunnel run` process.
- **Never** run `pm2 kill` / `pm2 delete all` / `pm2 startup` — PM2 on that host
  belongs to the other system.
- G-Core Gruntech gets its **own port, own tunnel, own process manager entry**, and
  its own rebuild script that touches nothing else.

Development is local on the laptop first, then published, then transferred to the
server — so the deploy scripts must target a clean machine and assume nothing from
the dev box.

---

## 13. Decisions taken

| # | Decision | Date |
|---|---|---|
| 1 | **Single tenant — Gruntech only.** G-Core Gruntech serves `gruntech.gcore.tech`. It does not share a deployment or a database with `gasiontech.gcore.tech`, which continues to run as it does today. Company name, logo, address, TIN and numbering prefix still live in **Settings as data**, because the DOCX requires configurable PDF branding — that is a stated requirement, not tenancy work. | 2026-09-19 |
| 2 | **G-FIN is operations-driven finance only** — AR, AP, Expenses, Payments, Cash Flow, Budget vs Actual, Executive Dashboard. GL, chart of accounts, bank reconciliation, payroll, fixed assets and tax filing are out of scope (§4.6). | 2026-09-19 |
| 3 | **Billing: VAT 12% + EWT 2% only.** Rates configurable in Settings. Downpayment recoupment and retention are deferred, with the schema shape reserved so either can be switched on later without migrating historical billings (§5.4). | 2026-09-19 |
| 4 | **Master data starts clean.** No migration from the gasiontech apps. Customers, suppliers, employees and items are entered as work comes in. Phase 2 still ships a **CSV import** for each master, so a bulk load stays possible without a second project. | 2026-09-19 |
| 5 | **Face descriptors are computed on the server, not in the browser.** The camera posts a photograph; the API decodes it, detects the face and produces the 128 floats. Matching in the page would be faster and would cost the server nothing, but it would mean trusting a number the client chose — and that number is all that stands between somebody and clocking in as a colleague. Weights ship inside `@vladmandic/face-api`, so there is nothing to download at deploy time and no CDN in the path of the time clock. Every clock entry keeps its photo regardless of method, because the photo is the evidence and the match is only the convenience. | 2026-09-19 |
| 6 | **Overtime is two approvals on one record.** A *prior* filing before the work, approved by the supervisor alone — authorisation to stay, and the employee's evidence of it, moving no money. Then an *actual* filing after the work, approved by the supervisor **and** HR, which is what posts INCURRED cost to the project. A variance against the estimate must be explained in writing before it can be submitted. | 2026-09-19 |

## 14. Still open

Neither blocks the start of the build.

1. **Retention / downpayment** — revisit before Phase 4 ships (§5.4). Worth asking
   whoever handles Gruntech's collections whether customers withhold a percentage
   of each progress billing until final acceptance; it is cheap to add now and
   expensive to add later.
2. **Attendance hardware** — which biometric device is the fallback when face
   recognition fails, and does it push to the app or does the app poll it? Phase 6
   ships with `BIOMETRIC` as a recorded clock method and a written reason, so an
   entry made at a door device can be attributed today; wiring an actual device to
   the API is a small addition once the model is known.
3. **The face-match threshold** — shipped at 0.6, the library's own default, and
   editable in G-HR › Settings. On the sample photographs the same person lands at
   0.13–0.28 and two different people at 0.69–0.73, so 0.6 sits in a wide gap. That
   gap will narrow with real site conditions — poor light, hard hats, dust — and
   the number is worth revisiting after a month of use rather than guessing now.

---

*Companion: `GAP-ANALYSIS.md` — what each source document got right, missed, or got
wrong, and what was added here.*
