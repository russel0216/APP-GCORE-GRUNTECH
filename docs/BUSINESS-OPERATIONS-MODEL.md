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
   Invoice, Expense, Cash Advance, Job Order, Clearance, Evaluation and Training
   Certification all route through the same workflow engine.
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
  invoices, payments, service contracts, service reports, documents. Every
  customer carries an **industry** (a reference row: HI, BI, UI, GI, SI, and any
  an administrator adds), which is how sales are reported by market. A lead's
  industry is its customer's; there is no second copy on the lead.
- **JOB** — the unifying object. `type = PROJECT | SERVICE_CONTRACT`. Owns the
  budget, the schedule of values, the cost ledger, the billing schedule and the
  document set. Both kinds require a linked approved **Costing** to be created.
- **COSTING** — where the contract amount comes from. Not a calculator; the
  structural origin of both budget *and* billing (see §5).
- **EMPLOYEE** — one record used by HR (attendance, leave, OT, plantilla
  position, evaluations, training, clearance), by Jobs (assignment, labor cost)
  and by Auth (user account). §4.7 follows it from hire to separation.
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
  scope, lead reference. Nothing is retyped. A lead with no customer on file is
  refused until it is linked to one — a quotation without a counterparty cannot
  be priced, printed or won.
- **Start costing** from a lead links the costing to it and moves the lead to
  Costing — forwards only. A lead already in Negotiation that gets re-costed
  stays in Negotiation; re-linking a costing later is a correction and moves
  nothing.
- A costing can be **duplicated**: the copy takes the header, lines and scope,
  starts as a draft owned by whoever copied it, carries no lead, quotation or
  job, and recomputes its totals from its own lines. That is how a service
  contract is renewed at last year's prices and then repriced.
- Quotation is **revision-controlled** (`0012609001 R0/R1/R2` — see §7). Revisions
  are preserved. Only the **approved** revision may convert to a Job, and a
  project is built on a FINAL costing only.
- Quotation is editable **only by its author**; Super Admin may edit any.
- Quotation actions: Edit · Open Costing · Generate PDF · Submit for Approval ·
  Duplicate · Send · Convert to Job.

**Pipeline view** — opportunities by stage with a salesperson-entered probability to
award; groupable by salesperson; weighted value = amount × probability.

The board is a **view over Lead and Quotation, never a third record**. Its columns
are the two status lists themselves — New, Contacted, Qualified, Site visit,
Costing (lead stages) · Quotation drafted, Submitted, Negotiation (quotation
stages) · Won, Lost · On hold (leads only) — plus a read-only "this month
forecast" column.

- **A lead with any quotation is never a card; its quotation is.** From the
  moment a quotation exists the lead's status is written back from the
  quotation's outcome, so showing both counted the same deal twice.
- **One value rule.** A quotation is worth its APPROVED revision's total, else
  its highest-numbered revision's total, else nothing. The board, Sales
  Analytics, Customer 360 and job orders all read the same function, and the
  board's open, quoted and weighted totals reconcile to Sales Analytics to the
  centavo. Weighted sums are rounded once, at the end. A lead's own estimate is
  never added to quoted value.
- **Won and Lost are bounded** to the last 90 days by default (30–730), by the
  date the quotation was decided or the lead was lost. Totals are smaller than
  an unbounded board's — the unbounded ones were inflated, not these wrong.
- **Forecast** = open cards whose expected closing falls in the current Manila
  month, weighted by probability. The quotation takes its expected closing from
  the lead and it can be corrected on the quotation. The tile says how many of
  its cards have no probability yet.
- **One set of move rules**, enforced on the lead and quotation records
  themselves, so the board, the lead page and the quotation page refuse the
  same things in the same words: Won needs an approved revision; Lost needs a
  reason; a lead is won by its quotation, never by hand; a quotation cannot be
  dropped back onto a lead stage; a Won quotation a job already references
  cannot leave Won. A move is an ordinary edit under the ordinary edit rights —
  the board has no write path and no permission of its own — and a manager who
  moves someone else's card tells the owner. A drop never rewrites the
  salesperson's probability.

**Sales calendar** — a week or a month of what every salesperson is doing: site
visits, follow-ups, quotation deadlines. The view and the position live in the
link, so a notification or a colleague's link opens the calendar on the right
week, and Back undoes a view switch. Every calendar in the system — sales,
service schedule, meetings, training — is drawn by one component, so they read
and behave alike, keyboard included. Extended (see §8) to surface service visits
from the Service Schedule, so one calendar answers "what is happening this week".

**Partners** — the principals whose equipment Gruntech sells and services. A
partner **is a supplier** flagged as a partner, not a second company record: its
purchase orders, bills and payments already point at the supplier. A partner
carries resources (catalogues, price lists, sizing tools — a file, a link, or
both) and a price list: the items whose preferred supplier it is, at their
**list price**. A list price is a price a salesperson may see; item cost stays
behind G-CHAIN's permissions and never appears on the partner page.

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
the Schedule of Values. Never keyed independently (see §5.3). A billing names the
invoice raised from it, and an approved billing with no invoice offers to raise
one — so nobody has to go looking for work that has been earned and not billed.

**A job's customer is its costing's customer.** The project form shows it rather
than asking for it, and the API refuses a different one, because a job costed
for one company and delivered to another cannot be reconciled afterwards.

**Turnover registers the equipment first, then closes the job.** Handing over a
project writes its installed equipment into the installed base (§4.5) and only
then marks the job turned over. If the second step fails the equipment is still
registered and the job stays completed — never a turned-over job with nothing
installed behind it. A job with nothing to register can still be turned over.

**Pickers offer open work.** The job picker leaves out completed and turned-over
jobs unless the screen asks for them. A screen that legitimately works on closed
jobs — registering equipment after turnover, entering a late supplier bill — must
ask; a lookup that silently offered everything would bury the live jobs.

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
stock, reorder level, warehouse, location, serial number, batch number. Stock
value is computed by one function everywhere it is printed — the G-CHAIN
dashboard, the inventory summary and Insights — so the three cannot disagree.

**Editing an order.** A purchase order is edited only while it is a draft, and
only by its author or someone holding edit-all; every edit is audited. A
direct-to-job order line must name its cost category, the same rule the request
line has always had — without it the approved order commits nothing to the
job's budget for that line. An order placed from an awarded canvass keeps the
awarded supplier: changing it would quietly undo the canvass. A rejected order
goes back to draft and says who returned it and why.

**Supplier bills on a PO or a receiving** are shown only to people who can open
payables. A link to a bill the reader cannot open is a refusal waiting to
happen, and payables are finance's register.

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

**Who may open a single leave or overtime record** — someone with view-all, the
person it belongs to, or an approver of that document (anyone who has acted on
it, or is eligible for its current step). The approver door exists because a
supervisor who can see only their own records must still be able to open what
they are asked to decide; approving from a notification's subject line is
approving blind. Anyone else is refused, and an overtime record — which carries
hours and a burdened rate — is no longer readable by id by a colleague.

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

**Service Schedule** — every visit, of every kind, on one calendar (a month by
default, a list beside it). It is the old PM schedule widened: contract visits,
call-outs and job-order visits alike. A scheduled visit past its date reads
*overdue* — computed on read, never stored — until the configured number of days
has passed, when it is swept to *missed*. Moving a contractual date happens on
the visit itself, which asks; there is no drag-to-reschedule. Cancelling a visit
needs a written reason. Regenerating a contract's schedule touches only the
visits the schedule generated; a hand-booked call-out or a job order's visit
under the same contract survives it.

A report written from a visit takes the visit's facts — customer, site, machine,
contract, kind, and the job that carries the cost — and a visit takes exactly
one report. A **returned** report is corrected and sent again, rather than
frozen; freezing it left its visit unable ever to complete.

**Job Orders** — the authorisation document for service work that is not already
scheduled by a contract: a breakdown call, a warranty repair, a chargeable
repair. It is usually raised by sales, accepted by the service manager, and only
then dispatched.

```
Job order (DRAFT) → Approval (service manager) → one Service Visit
    → Service Report → approved → job order COMPLETED → invoice (if chargeable)
```

- **Approval schedules exactly one visit**, in the same transaction as the
  approval; a settlement that arrives twice schedules nothing twice.
- **Cover is decided from facts on the requested date.** An active contract that
  lists the machine and covers the date makes it CONTRACT work (cost to the
  contract's job); else a running warranty makes it WARRANTY work (cost to the
  installing project); else it is CHARGEABLE. The decision can be overridden;
  the warranty fact is kept either way. Claiming contract cover with no covering
  contract is refused.
- **A job order posts no cost itself.** Labour, parts and out-of-pocket reach
  its job through overtime, purchase requests, stock issues and expense claims
  that quote it. Warranty work therefore lands on a turned-over project's
  budget — that is the truth, and project managers should expect it.
- **The agreed amount taken from a quotation is its subtotal**, because the
  invoice adds VAT itself; taking the total would tax the work twice.
- **A chargeable job order is billed once, through the one invoice path**, and
  only after its report is approved. One order → one visit → one report → at
  most one invoice.
- Cancelling is allowed as a draft, when returned, or once approved (its
  scheduled visit is cancelled with it and the engineer is told) — always with a
  reason. A pending order is not withdrawn by its requester; the approver
  returns it.

**Renewal** duplicates the old contract's costing (last year's prices, flagged as
such), and once that costing is final creates the new contract as a job in one
transaction. The new term starts the day after the old one ends; a term of whole
months renews as whole months, so a leap year never shifts the chain by a day.
The old contract is left as it is until the renewal is activated — marking it
renewed on a draft that may never be signed would be premature.

### 4.6 Record-to-Report (G-FIN)

Finance **consumes** operational transactions. It does not re-key them.

```
Progress Billing → Invoice → A/R → Payment → Collection
Purchase Order → Receiving → Supplier Invoice → A/P → Payment
Expense claim → Approval → Reimbursement
Cash advance → Approval → Release → Liquidation (an expense claim) → Refund or top-up
All of the above → General Ledger → Financial Statements
```

**Cash advances and liquidation.** A cash advance is money handed to a person
before it is spent — site petty cash, a trip, a purchase that cannot wait for a
PO. It is requested, approved (supervisor, then finance), **released in one
voucher**, and **liquidated** by an ordinary expense claim that names the
advance. There is no separate liquidation document; only the printed title says
"Liquidation Report".

- **Nothing reaches a project on approval or on release.** The approved
  liquidation posts INCURRED at what was actually spent, the same way any
  expense claim does. An advance is a promise of cash, not a cost.
- **Spent less than released** → the claim is settled and the advance waits for
  the unspent cash to come back (a receipt allocated to the advance). **Spent
  more** → the excess is reimbursed like any claim. A liquidation is always
  measured against the excess over the advance, never its total — measured
  against the total, the person would be owed their advance twice.
- **The liquidation clock starts on the release date**, cleared or not — the
  person holds the cash from then. The deadline (30 days by default) is fixed at
  release, so changing the setting never moves a deadline already given.
  Overdue is derived on read, never stored.
- **One advance at a time** by default: a person holding released cash cannot be
  given more until they liquidate. Both rules are Finance Settings.
- An advance that names a project must name a budget line, because its
  liquidation charges exactly that line. One live liquidation per advance; only
  the person who received the cash files it.
- **A refund is cash in, never a collection.** Every "collected" figure counts
  customer receipts only.
- Cancelling: before release, freely; once released, it is liquidated instead,
  and the release cannot be reversed while a liquidation stands on it.

**The working position** is one definition, used by G-FIN's dashboard and by
Insights alike: receivable − payable − owed to staff − approved advances not yet
released. An approved advance is cash already promised, so it counts before the
voucher exists.

**Job orders are invoiced through the same invoice path** as progress billings —
once, only when chargeable and only after the report is approved (§4.5).

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

### 4.7 Hire-to-Separate (G-HR — the person, not just the time clock)

```
Plantilla position → Hire (probationary / trainee) → Evaluations at milestones
    → Regularise · Extend · Absorb · End → Training & readiness (Academy)
    → Resignation / end of contract → Clearance → Separation → Turnover figures
```

§4.4 follows an employee's hours. This stream follows the employee: the post they
fill, whether they are confirmed in it, whether they are trained for it, and how
they leave. Still **no payroll** (§4.6).

**Plantilla** — the positions the company has authorised, each with a headcount.
**Filled and vacant are counted, never stored**: every read groups the active
employees by position, so there is no column that can drift from the people
actually in post. Holding more people than authorised is shown ("1 over"), not
refused — refusing would block a real hire while HR catches the plantilla up. An
employee's position title is a mirror of the position they hold, with one
writer; renaming a position renames it on every holder. A position anyone has
ever held is deactivated, never deleted.

**Probation and evaluation** — a probationary or trainee employee is evaluated
at milestones (every N months from hire, then at the end of the period; all
three numbers are HR Settings). Which evaluations are **due is derived**, never
stored — from the hire date, the settings and the period end — so changing the
settings or extending a period moves what is due without anyone editing a
schedule. HR is told when a milestone is due the first time anyone opens the
due list; G-Core has no scheduler, and a reminder that depends on a cron job is
worse than one that happens on read.

- **Regularisation is an approved document, not a field edit.** The evaluation
  recommends — regularise, extend, absorb a trainee as probationary, or end — and
  only when every step (HR, then executive) has approved does the employee
  record change. Ending changes nothing on the record; HR is told to process
  the separation through a clearance.
- **The person evaluated reads it only once it is approved.** Before that they
  are not told it exists, and they can never approve their own evaluation,
  whatever role they hold.
- **Ratings never reach the audit log.** The audit trail is read by
  administrators, who are not the people a rating is between; it records that a
  form was rated, not how.
- **Criteria are settings, snapshotted onto each form** when it is opened, so
  renaming or reweighting a criterion never rewrites a form already written.
  The score is the weighted mean of the lines actually rated; an unrated line is
  left out, not counted as zero.

**Clearance and separation** — a leaver is cleared by area: supervisor,
warehouse, finance, HR, admin. Every accountability that points at a record
**derives its status from that record**: an unreturned borrow slip, an unpaid
claim, an unliquidated cash advance, pending leave, projects they manage, people
who still report to them, approvals waiting on them. It clears itself when the
record does. Such an item cannot be ticked off by hand, only waived with a
written reason. The leaver never clears their own items.

- **Approval records the separation, and nothing else does.** When every step
  (supervisor, finance, HR) has approved, the separation date is set and — once
  that day has passed — the employee and their login are deactivated. A future
  last day is picked up on read. A login is closed automatically only behind an
  approved clearance; a separation date typed by hand makes the system ask an
  administrator to close the login rather than close it on one keystroke.
- **Turnover is arithmetic over employee dates — no table.** Headcount on a day,
  hires, separations and the rate per month come from hire and separation dates;
  the reason comes from the leaver's approved clearance ("no clearance on file"
  otherwise). A company with under five people on average is flagged too small
  to judge.

**Academy — training and readiness.** Courses, which departments and positions
must hold each one, training sessions on a company-wide calendar, and a
**training passport** per person.

- **The passport is derived, never kept.** What a person must hold comes from
  the requirements; whether they hold it comes from their verified training
  records; current / expiring / expired comes from the expiry date against
  today — the same rule warranties use. No column says "compliant". Readiness
  counts only people with at least one requirement.
- **Two doors write a training record, and only two.** A trainer completing a
  session writes a verified record for everyone who passed — the trainer's
  completion is the verification. An external certificate is filed by the
  employee and verified by HR through the approval engine. HR never records
  their own.
- **Changing a course's validity never rewrites an expiry already given**; a
  certificate expires on the date it was issued with (the VAT-snapshot
  principle).
- Expiry notices are sent once per certificate, on read.

**Meetings** sit in G-HR because they are about people's time, not money: a
meeting is a time slot with invitees, numbered, with no approval, no PDF and no
cost. G-Core holds no Google credentials: the organiser creates the event in
their own Google account from a pre-filled link and pastes the Meet link back.
Invitations go out when the organiser sends them, not on save; a time change
tells only the people already told; a meeting people were invited to is
cancelled with a reason, never deleted, and a re-downloaded calendar file
withdraws it from their calendars.

---

## 5. The money model

### 5.1 Cost side — four states, per job, per cost category

Cost categories (fixed set, extensible in Settings):
**Materials · Equipment · Labor · Subcontractor · Indirect Cost**

| State | Created by | Meaning |
|---|---|---|
| **Budgeted** | Approved Costing (budget requests raised it before 2026-10-07; since then they are project cash, §5.2) | What we are allowed to spend |
| **Committed** | Approved PR (soft) → issued PO (firm) | What we have promised to spend |
| **Incurred** | Receiving (direct), OT/timesheet posting, supplier bill with no receiving (subcontractor certificate, service call), approved expense claim or liquidation | What we now owe |
| **Consumed** | Stock issuance to the job, installed or used | What is actually in the work |

```
Available = Budgeted − Committed − Incurred
```

Every one of these is a row in a single **job cost ledger** carrying a source
document reference. There is no other way cost enters a job. Budget Monitoring is a
view over this ledger, not a separate set of numbers.

A **cash advance** is not a state. Approving or releasing one moves nothing on
the job; the approved liquidation is what posts INCURRED, at what was spent
(§4.6). Someone who can monitor the budget sees the advances against a job on
its Finance tab, so money in a person's hands is visible before it becomes cost.

### 5.2 Budget Request vs Purchase Request — they are not the same thing

- A **Budget Request** is *project cash* (2026-10-07, the owner's definition:
  "it is not about changing the total budget allocated for the project; it is
  about requesting cash so that the project team can purchase something
  without the need for the purchase requisition"). The team asks for a sum
  against a job and a budget line; the job's **project manager** allows it,
  then **finance** approves and releases it in one voucher; the team spends
  it and accounts for it with receipts — a liquidation filed in Expenses that
  names the request. Approval and release move nothing on the job; the
  approved liquidation posts INCURRED at what was actually spent, and unspent
  cash comes back. It does **not** change the budget. It is not a cash
  advance either — that is the company's term for a personal loan to a
  person, with its own rules and its own liquidation days.
- A **Purchase Request** *spends the budget* through procurement. Approving it
  raises Committed.

A PR that would push Available below zero is blocked, or needs the budget
reopened on the costing — configurable per job in Settings. This is the
control that makes budget monitoring mean something. (Before 2026-10-07 a
budget request raised Budgeted; those already approved keep the ledger rows
they wrote and are closed.)

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
Order, Invoice, Expense, Cash Advance (supervisor → finance), Job Order (service
manager), Employee Clearance (supervisor → finance → HR), Evaluation (HR →
executive), Training Certification (HR) and Service Report sign-off. Meetings
deliberately route through nothing: a meeting is a time slot, not a decision.

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
Warehouse, Finance, Accounting, HR, Supervisor, Employee, Trainer (schedules and
completes training sessions; completing one is what verifies the attendees'
training).

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
GT-LEAD-2026-0001   GT-POS-2026-0001   GT-PRJ-2026-0001   GT-COST-2026-0001
GT-BR-2026-0001     GT-PR-2026-0001    GT-RFQ-2026-0001   GT-PO-2026-0001
GT-RR-2026-0001     GT-SI-2026-0001    GT-BS-2026-0001    GT-INV-2026-0001
GT-SC-2026-0001     GT-CR-2026-0001    GT-PM-2026-0001    GT-SR-2026-0001
GT-CA-2026-0001     GT-JO-2026-0001    GT-SV-2026-0001    GT-CLR-2026-0001
GT-EVAL-2026-0001   GT-MTG-2026-0001   GT-TS-2026-0001    GT-TC-2026-0001
0012609001          (quotation — the sales house scheme, below)
```

A counter has a **period** (yearly, monthly, or never) and a **scope**
(company-wide, or per employee). The pattern tokens are `{PREFIX}` `{TYPE}`
`{YYYY}` `{YY}` `{MM}` `{EMP}` `{SEQ}`; `{EMP}` is the author's employee number
reduced to its last run of digits and padded to three (`GT-EMP-2026-0007` →
`007`), `000` for a login with no employee record. The quotation follows the
house scheme `{EMP}{YY}{MM}{SEQ}`, padding 3, monthly, per employee — so
`0012609001` is employee 001's first quotation of September 2026 and employee
002's first that month is `0022609001`. Any document type may use `{EMP}` and a
monthly or per-employee counter.

Three rules are enforced when a pattern is saved, because each would otherwise
issue the same number twice: a per-employee counter needs `{EMP}`, a monthly one
needs the month and a year, a yearly one needs a year. Changing a counter's
period or scope starts a fresh run and keeps the old counters, which are the
record of what was issued under them. An existing database keeps whatever
pattern an administrator configured; the seed only fills in a type that has
none.

**Attachments** — one attachment service for every module: file, type, size,
uploader, timestamp, linked record. Photos in reports keep their capture timestamp.
A service report's photos are filed per section of its template. Today the
service checks that the caller is signed in, not that they may see the record
the file belongs to — see §14.

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

What fills it: **Awaiting my approval** (with who raised each one); **Assigned to
me** — leads I am working, jobs I manage, visits booked on me, open tasks,
approved job orders assigned to me, and planned sales activities that slipped
past their day (always overdue); **Today** — my sales activities, meetings and
training sessions for today, with a Join link where there is one; **My drafts** —
quotations, purchase requests, claims, cash advances, leave and job orders I
started and have not sent. A draft is invisible to everyone else, which is
exactly why it needs a place on its owner's screen: nobody else will chase it.
Overtime has no draft — filing it submits it. **Renewals due** appear only for
people who can see service contracts. A planned activity lives in exactly one
place per day: today's under Today, earlier unfinished ones under Assigned as
overdue; the calendar is where you plan, My Work is what is due.

**Four navigation improvements over the reference:**

1. **Record workspaces instead of menu hopping.** Opening a Job does not send you
   back to the menu to find its purchase requests. A job opens one workspace with
   tabs: *Overview · Budget · Scope · Plans · Procurement · Progress · Billing ·
   Finance · Service · Tasks · Documents · Activity*. Same pattern for Customer,
   Quotation and Service Contract. The tab lives in the link, so an approval
   notification for a budget request lands on the request's own page, one
   click from the project's Budget Requests tab. A card from another module is **hidden, not empty**,
   for someone without that module's view right: an empty "Purchase orders" card
   reads as "nothing was bought", which is a different claim from "you may not
   see this". Customer 360 and Supplier 360 follow the same rule — a window onto
   the modules, never a way around them.

2. **The lifecycle breadcrumb.** Every record shows its chain and lets you walk it in
   both directions:
   `Lead GT-LEAD-2026-0014 › Quotation 0012609022 R1 › Project GT-PRJ-2026-0009 › Billing #3`

3. **Global command palette (Ctrl+K).** One search across customer, contact, job,
   quotation, PO, PR, invoice, employee, supplier, item, service contract and
   document — plus actions ("new purchase request"). It also finds partners and
   their resources, canvasses, receivings, stock issues, borrow slips, installed
   assets, visits, service reports, job orders, cash advances, leave and overtime
   filings, meetings, courses and training sessions. Someone who holds only
   view-own finds only their own. Evaluations are deliberately not searchable: a
   rating is not something a search box should surface.

4. **One list pattern everywhere.** Every list screen has one toolbar in two
   weights, after SCORO's list of quotes: *Add New · Search · Mine / All ·
   Filters* on the left — the requirement's **View category switch** and the
   things somebody came for — and one *⋯* menu on the right holding *Columns ·
   Export · Print · Save view · Refresh*. Filters open in a panel, and every
   filter that is on shows as a chip that can be removed on its own. A list may
   carry a strip of tabs over one filter, each with its count (the quotation
   list's pipeline stages), and a totals line for the whole filtered set.
   Saved views keep a person's own search, scope and filters in their browser.
   Rows can be ticked for mass actions — export or print the selection, and on
   quotations change the status of many at once through the same rules as
   one; never a bulk delete.
   Learn it once, use it in every module. A list's search, scope, page and
   declared filters live in the link, so a dashboard figure can open the list
   filtered to exactly what it counted, and Back returns to the same view.

**Unified calendar** — sales activities, project milestones and PM due dates on one
calendar, filterable by person, team or job. Every calendar — sales, the Service
Schedule, meetings, the training calendar — is drawn by the same month/week
component, and the sales calendar can show the service visits from the Service
Schedule's feed.

**Notification centre** — approval required, quotation awaiting approval, job behind
schedule, PO received, invoice overdue, leave/OT awaiting approval, PM due, borrow
slip overdue. Added with the hire-to-separate and service work:

- a sales card moved by a manager (to its owner) and an activity scheduled for
  you;
- a job order's call assigned on approval, or cancelled (to the engineer); a
  visit assigned;
- a cash advance released, with the date it must be liquidated by (to the
  holder);
- an evaluation due (to HR, once per milestone) or assigned to an evaluator, and
  its acknowledgement by the person evaluated;
- a clearance raised (to the leaver and their supervisor) and an item cleared
  (to HR); a login to close after a separation typed by hand (to admins);
- a meeting invitation, a time change (only to those already told), a
  cancellation, and a decline (to the organiser — an accept is what they
  assumed);
- enrolled on, assigned to train, rescheduled or cancelled training; a result;
  a certificate about to expire (once per certificate).

Every notification **deep-links to the actual record**, not to a list.

---

## 9. Menu structure

```
G-CORE
├── HOME  (division cards + My Work + notifications + Ctrl+K)
├── G-OPS
│   ├── Dashboard ................ customizable widgets; sales + project overview
│   ├── Customer & Sales
│   │   ├── Leads ................ assignable; → Quotation
│   │   ├── Customers ........... global master, industry, multi-contact, Customer 360
│   │   ├── Calendar ............ week / month, per salesperson, service visits
│   │   ├── Quotations .......... author-edit, revisions, PDF
│   │   ├── Sales Pipeline ...... board over leads + quotations, forecast, CSV
│   │   └── Partners ............ principals: catalogue, price list, sizing apps
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
│       ├── Installed Base ...... what was installed, where, warranty
│       ├── Service Contracts ... requires linked costing; renew
│       ├── Job Orders .......... call-outs and repairs; approval schedules the visit
│       ├── Service Schedule .... every visit on one calendar (month / list)
│       ├── Renewals ............ contracts ending, warranties lapsing
│       ├── Commissioning Reports  templated, duplicable
│       ├── Preventive Maintenance templated, duplicable, scheduled
│       ├── Service Inspections .. templated, duplicable
│       └── Service Costing ...... same 5 categories
├── G-HR
│   ├── Clock In/Out ............ face recognition, biometric fallback
│   ├── Dashboard ............... present/late/on-leave/absent/pending, people, CSV
│   ├── Leave ................... overview, file, approve, balances
│   ├── Overtime ................ prior approval, actual filing, job posting
│   ├── Meetings ................ invitees, Meet link pasted, .ics, month view
│   ├── Employees
│   ├── Plantilla ............... positions, authorised vs filled vs vacant
│   ├── Evaluations ............. probation and trainee milestones → regularise
│   ├── Turnover & Clearance .... clearance by area, separation, turnover rate
│   ├── Academy
│   │   ├── Courses ............. course master, who must hold each
│   │   ├── Training Calendar ... every session, company-wide
│   │   ├── Training Sessions ... schedule, enrol, results, complete
│   │   ├── My Training Passport  what I hold, what I need; file a certificate
│   │   └── Training Passports .. everyone's; verify certificates; readiness
│   ├── Reports ................. overtime, leave, turnover
│   └── Settings ................ leave allotments, CSV columns, probation,
│                                 clearance checklist, evaluation criteria, Academy
├── G-FIN
│   ├── Executive Dashboard ..... revenue, opex, net margin, cash runway
│   ├── Accounts Receivable ..... invoices, aging, collections
│   ├── Accounts Payable ........ supplier bills, disbursement queue
│   ├── Expenses ................ claims, receipts, corporate cards
│   ├── Cash Advances ........... request, release, liquidate, refund
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
├── INSIGHTS  (Phase 9 — read-only, no tables of its own)
│   ├── Company Overview ........ the company at a glance (one line per division) + every division on one screen + 12-month trend
│   ├── Project Profitability ... expected vs running margin, watchlist
│   ├── Sales Analytics ......... funnel, win rates, weighted pipeline, by industry
│   ├── Cash Forecast ........... including work earned but not yet invoiced
│   ├── Inventory Analytics ..... slow movers by value, reorder, throughput
│   └── Performance ............. output by person, and the approval bottleneck
└── ADMIN / SETTINGS
    ├── Users · Roles & Permissions · Approval Workflows
    ├── Company Settings ........ name, logo, address, TIN — drives every PDF
    ├── Document Templates ...... service report form templates (PDF layouts are code)
    ├── Numbering ............... pattern, period, per-employee counters, samples
    ├── Categories .............. cost, item and industry categories
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

**Masters** — Customer, CustomerContact, CustomerSite, Industry, Supplier *(a
partner is a Supplier flagged `isPartner`)*, SupplierContact, PartnerResource,
Employee, Department, Position *(the plantilla)*, Item *(carries a list price
beside its cost)*, ItemCategory, CostCategory, Warehouse, Location

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
LeaveRequest, OvertimeRequest *(prior + actual)*, FaceEnrollment,
EmployeeClearance, ClearanceItem, Meeting, MeetingInvitee, EmployeeEvaluation,
EmployeeEvaluationLine *(criteria snapshotted per form)*, Course,
CourseRequirement, TrainingSession, TrainingAttendee, TrainingRecord *(the
passport is derived from these, never stored)*

**Finance** — Invoice, InvoiceLine, Payment, PaymentAllocation, SupplierInvoice,
Disbursement, Expense, ExpenseLine *(a liquidation is an Expense naming its
advance)*, CashAdvance, CashFlowForecast
*(later: Account/COA, JournalEntry, JournalLine, FixedAsset, PayrollRun)*

**Aftermarket** — ServiceContract *(a Job)*, InstalledAsset, PMSchedule,
ServiceVisit, ServiceReport, ServiceReportTemplate, ServiceReportSection,
WarrantyClaim, JobOrder *(one order → one visit → one report → at most one
invoice)*

Checklists and criteria that HR edits — the clearance checklist, the evaluation
criteria, the probation and Academy rules — are **Settings, not tables**: they
are lists an administrator maintains, and every document that uses one takes a
copy of what it said at the time.

### Invariants the schema must enforce

- `Job` requires a non-null approved `Costing`.
- `PurchaseOrder` requires an approved `PurchaseRequest`.
- `ProgressBilling` requires a `ProgressReport`.
- `Invoice` requires a `ProgressBilling` (project) or a completed, chargeable
  `JobOrder` (service call). Each is unique on the invoice, so neither can be
  invoiced twice.
- Every `JobCostLedger` row carries a source document type + id.
- Only one `QuotationRevision` per quotation may be `APPROVED`.
- An `OvertimeRequest` posts to the ledger only when supervisor **and** HR approvals
  both exist.
- A `CashAdvance` has at most one live liquidation, and its released, spent and
  refunded figures are re-derived from payments and the liquidation, never
  incremented.
- `Position` has no filled or vacant column; a `TrainingRecord` is written only by
  a completed session or a verified certificate; a `ClearanceItem` pointing at a
  record takes its status from that record.

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
| **10 · Depth** | Industry and partners, the house quotation number, pipeline board, week/month calendars, costing handoffs and duplication, the job workspace's links down to its children, procurement editing, Service Schedule and job orders, cash advances and liquidation, hire-to-separate (plantilla, evaluations, clearance and turnover, meetings, Academy), My Work filled from every module, the company-at-a-glance brief | Every screen links to the record behind it, and a person can be followed from hire to separation |

**Not in scope:** general ledger, chart of accounts, bank reconciliation, fixed
assets, payroll, tax filing (§4.6). Also deferred: downpayment recoupment and
retention (§5.4) — schema shape reserved, behaviour not built.

**Phases 1 and 2 are not optional and cannot be deferred.** Every defect in the
current gasiontech implementation traces back to their absence.

**All nine phases were built** as of 19 September 2026. **Phase 10** — depth
across every division rather than a new one — was built by 27 September 2026,
and the suite now stands at 1,577 assertions across twenty verification
scripts. What remains is not further phases: it is deployment under the
constraints in §12, assigning the seeded roles to real people so approvals have
somewhere to route (including the new `trainer` role), entering real master
data, and the open questions in §14. From here, treat changes as changes to a
live system.

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
/deploy     preflight, install, rebuild, backup, tunnel and compose
            for the shared server (see deploy/README.md)
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
| 7 | **A supplier bill matched to a receiving posts no job cost.** Receiving already incurred it when the goods arrived (§5.1); posting again would charge the project twice for the same peso. A bill with nothing received behind it — a subcontractor's certificate, a service call, a utility — is the first time that cost appears, so that one does post, at the subtotal because input VAT is recoverable. | 2026-09-19 |
| 8 | **A/R and A/P balances are measured against net collectible and net payable**, never against the invoice or bill total. Withheld tax is reported in its own column and chased as a certificate; it is not a debt. A payment is checked against what is still owed before it is written, and settled totals are re-derived from the allocation rows rather than incremented, so reversing a payment cannot leave a stale balance. | 2026-09-19 |
| 9 | **A service contract is a Job of type SERVICE_CONTRACT, not a new commercial record.** Its costing, budget, schedule of values and progress billing are the existing machinery. `ServiceContract` is a one-to-one extension carrying only the coverage terms — what equipment, how often, until when — because those are the questions a job cannot answer. Service Costing is the costing list narrowed to service jobs, for the same reason. | 2026-09-19 |
| 10 | **A report template that has been used is immutable.** Editing publishes a new version under the same key; reports keep pointing at the exact version they were filled in on, so a report signed two years ago still renders the way it was signed. A visit is complete only when its report has been APPROVED — marking it done when the engineer left site would count a visit nobody has checked. | 2026-09-19 |
| 11 | **Insights adds no tables.** Phase 9 is a read layer: every figure is computed from documents the other eight phases record, and the module refuses any non-GET request. A report that keeps its own copy of a number gains the ability to disagree with the document behind it, which is the one failure a management report cannot survive. Where a report and a module screen disagree, the report is wrong. | 2026-09-19 |
| 12 | **A number that is not yet meaningful says so.** Running margin on a job that has spent 2% of its budget is ~100% — arithmetically true, completely misleading. Every screen leads with EXPECTED margin, from the budget, and flags a job as too early to judge rather than reporting the useless figure silently. | 2026-09-19 |
| 13 | **Clearance approval records the separation; filled/vacant and turnover are derived.** The employee and the login are deactivated because an approved clearance says so, not because someone typed a date. Filled and vacant positions are counted from the people in post on every read, and turnover is arithmetic over hire and separation dates; none of the three has a column that could drift from the people it describes. | 2026-09-27 |
| 14 | **Regularisation is an approved document, not a field edit.** An employee becomes regular (or has their probation extended, or a trainee is absorbed) only when an evaluation has been approved by HR and then the executive. The person evaluated can never approve it and does not see it until it is approved; ratings never reach the audit log. | 2026-09-27 |
| 15 | **Meetings hold no Google credentials; the Meet link is pasted.** The organiser creates the event in their own Google account from a pre-filled link and pastes the Meet link back. Holding a Google login for the company would put one credential in front of every employee's calendar; the paste costs ten seconds. A Calendar integration stays possible (a column is reserved) but must be decided deliberately. | 2026-09-27 |
| 16 | **Training expiry is derived; session completion writes the passport.** Whether a person is current on a course comes from their verified records and today's date, never a stored flag. A trainer completing a session is the verification for everyone who passed; an external certificate is verified by HR through the approval engine, and HR never verifies their own. | 2026-09-27 |
| 17 | **A cash advance is liquidated by an expense claim, and nothing reaches a project until it is.** Approval and release move no cost; the approved liquidation posts what was actually spent. An advance is released in one voucher, and a liquidation is measured against the excess over the advance — never its total, or the person would be owed their advance twice. A refund of unspent cash is cash in, never a collection. | 2026-09-27 |
| 18 | **A job order is the authorisation for service work outside a contract's schedule.** Approval schedules exactly one visit; the approved report completes the order; a chargeable order is invoiced once, through the same invoice path as progress billing, at its subtotal. Cover (contract, warranty, chargeable) is decided from the facts on the requested date. | 2026-09-27 |
| 19 | **A partner is a supplier; an industry is a reference row.** A principal is flagged on the supplier record it already is, so its orders and bills need no second counterparty. A customer's industry is required, can be corrected but never removed, is not part of the customer code, and is inherited by the customer's leads rather than copied onto them. | 2026-09-27 |
| 20 | **The quotation number is the sales house scheme** `{EMP}{YY}{MM}{SEQ}` — per employee, per month (`0012609001`). Any document type may use the same tokens. An existing database keeps the pattern its administrator configured. | 2026-09-27 |
| 21 | **The pipeline board is a view, with one value rule and one set of move rules.** No third record, no board-only write path, no permission of its own. A quotation is worth its approved revision, else its latest; a lead with a quotation is never a card. | 2026-09-27 |

**Changelog**

- *2026-09-27* — **Insights' working position now uses G-FIN's definition**:
  receivable − payable − owed to staff − approved advances not yet released, from
  the one function the finance dashboard reads. It used to print receivable −
  payable, so the tile drops by the approved, unpaid claims and the approved,
  unreleased advances. "Collected" now counts customer receipts only.
- *2026-09-27* — **An Insights date range ends at 23:59:59.999 of its last day.**
  It used to end at midnight, which silently dropped the last day for anything
  dated by a timestamp — "this month, to today" left out a quotation won this
  morning. Range figures may move by one day's documents.
- *2026-09-27* — **The pipeline board's totals moved.** A lead with a quotation
  no longer appears beside it, and Won / Lost are bounded to the last 90 days,
  so column totals are smaller. The old ones counted deals twice and forever.
- *2026-09-27* — A returned service report can be corrected and resubmitted (it
  was frozen, and its visit could never complete); cancelling a visit needs a
  reason; a single overtime record is no longer readable by a colleague who
  holds only view-own.

## 14. Still open

None of these blocks the build. The first one is the only one getting worse
with time.

1. **Retention / downpayment** — still unanswered, and Phases 4 and 7 have now
   both shipped without it (§5.4). This is the one item on this list that is
   getting more expensive, so it is worth a direct question to whoever handles
   Gruntech's collections: *do customers withhold a percentage of each progress
   billing until final acceptance, and does Gruntech bill a mobilisation
   downpayment that is then recouped?*

   It is not yet a migration. The nullable columns are reserved on `Job` and
   `ProgressBilling`, and `Invoice` carries the billing's figures rather than
   recomputing them, so switching either on means a calculation, two template
   lines and a recoupment schedule — perhaps two days. It becomes expensive once
   real billings exist that *should* have withheld retention and did not,
   because each of those has to be corrected by hand against what the customer
   actually paid.
2. **Attendance hardware** — which biometric device is the fallback when face
   recognition fails, and does it push to the app or does the app poll it? Phase 6
   ships with `BIOMETRIC` as a recorded clock method and a written reason, so an
   entry made at a door device can be attributed today; wiring an actual device to
   the API is a small addition once the model is known.
3. **Supplier withholding rates** — G-FIN ships with 1% on goods and 2% on
   services as *suggestions* on the bill screen, and zero as the default, because
   withholding when you should not have underpays a supplier and is awkward to
   unwind. Whether Gruntech is classified as a Top Withholding Agent — which is
   what makes withholding on purchases compulsory rather than optional — is a
   question for its accountant, not a decision this system should make.
4. **The face-match threshold** — shipped at 0.6, the library's own default, and
   editable in G-HR › Settings. On the sample photographs the same person lands at
   0.13–0.28 and two different people at 0.69–0.73, so 0.6 sits in a wide gap. That
   gap will narrow with real site conditions — poor light, hard hats, dust — and
   the number is worth revisiting after a month of use rather than guessing now.
5. **Phase 10 left these for a deliberate decision.** Each was noticed while
   building and left alone because changing it changes who can see or do what.
   - **Attachments have no per-record guard.** The attachment service checks that
     the caller is signed in, not that they may open the record a file belongs
     to. Anyone signed in who has a file's id can download it — a partner's
     dealer price list, a meeting's minutes, an evaluation's supporting papers.
     Ids are long and random, so this is not guessable, but it is not a rule
     either. The fix is a per-record-type permission check in one place.
   - **An inactive supervisor still receives approvals.** Routing to "the
     supervisor" does not check whether that login is still active. Until that
     is decided, a clearance refuses to submit while anyone still reports to the
     leaver — so their reports must be moved to a new supervisor first.
   - **An employee can raise their own resignation clearance but not submit it.**
     The employee role can create and view their own clearance, not edit it, so
     HR submits it for them. If leavers should submit their own, grant
     `ghr.clearances.edit_own` to the employee role.
   - **Own-scope on a few detail screens.** Someone who may see only their own
     jobs, purchase requests, canvasses or purchase orders is narrowed on the
     lists but can still open any single one by its link. Tightening that could
     lock out an engineer or approver following a link they were sent, so it was
     left as it was.
   - **Meeting invitees see a draft meeting before the invitations go out.** They
     are not notified until the organiser sends the invitations, but the meeting
     already appears in their own list and they can respond. Hiding drafts from
     invitees is a one-line change if preferred.
   - **Sales and Aftermarket each carry seven screens**, one over the "roughly
     six" a menu section is meant to hold. Splitting either is a label change
     with no effect on permissions.
   - **A trainee's period end is not required.** The evaluation schedule needs it
     to know when a trainee's final evaluation falls; the employee form accepts a
     trainee without one today.
   - **Finance staff's own cash advances stall while only one person holds the
     finance role**, because nobody approves their own document. The same is
     true of clearance, evaluation and training-certification steps routed to HR
     while one person holds HR; `audit-workflows.ts` reports each case.
   - **An item two partners both price can sit under only one** (its preferred
     supplier). A per-supplier price table would fix it, at the cost of a second
     place an item's price lives; not built until it matters.

---

*Companion: `GAP-ANALYSIS.md` — what each source document got right, missed, or got
wrong, and what was added here.*
