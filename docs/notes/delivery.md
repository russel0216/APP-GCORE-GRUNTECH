# Delivery (package DEL) — notes worth carrying forward

Scope: the job workspace's links down to its children, the new-project form's
prefills, billing ↔ invoice, turnover with equipment registration, and the
contract renewal that `POST /jobs` performs. Audit fixes 7 (budget requests),
8 (attachments), 13, 14, 15 (delivery half), 16, 25 (jobs half); FIN's
workspace card.

## Invariants

- **A job's customer is its costing's customer.** `POST /jobs` refuses a
  `customerId` that differs from `costing.customerId` (400, "costed for a
  different customer"). The form locks the field and shows it as text; the API
  is the half that makes it true for any caller.
- **A renewal is one transaction.** `POST /jobs { renewedFromContractId }`
  forces `type = SERVICE_CONTRACT` and writes the DRAFT `ServiceContract` in the
  same transaction as the job, numbered by `nextNumber('service_contract', tx)`.
  A refused renewal leaves no job behind (covered by a test).
  - The new term starts the day after the old one ends. A term that runs whole
    months (1 Oct – 30 Sep) renews as the same number of months, so a leap year
    never shifts the chain by a day; any other term keeps its length in days.
    `renewalTerm()` in `routes/jobs.ts` is exported for the test.
  - Frequency, response time, exclusions, coverage notes and the covered
    equipment are copied; `plannedVisits` comes from `planSchedule()` — the
    first visit one interval after cover starts, so a year of quarterly cover is
    **3** visits, not 4.
  - Refused: a contract already renewed (`renewedTo` exists), a DRAFT or
    CANCELLED contract, another customer's contract, and a caller without
    `gops.service_contracts.create` (403 — a renewal writes coverage terms, which
    project-create alone does not grant).
  - The OLD contract is left untouched. It is only replaced once the renewal is
    activated; marking it RENEWED on a draft that may never be signed would be
    premature. Whoever owns activation (aftermarket) decides when RENEWED is set.
- **The job picker offers open work by default.** `GET /jobs/lookup` excludes
  COMPLETED and TURNED_OVER (and always CANCELLED) and honours `?q=` (number,
  name, customer). A screen that legitimately needs closed jobs passes
  `?includeClosed=true` — the Plans register does; equipment registration and a
  late supplier bill should (see "Edits needed elsewhere").
- **A billing names its invoice.** `GET /billings/:id` includes
  `invoice { id, number, status }` (numbers only — the money is Finance's and
  was copied from the billing anyway). The billing page shows "Invoiced as
  GT-INV-…" or, when APPROVED and the viewer holds `gfin.ar.create`, a
  `Raise invoice` link to `/g-fin/ar?raise=<billingId>`, which Receivables opens.
- **Turnover registers first, then moves the status.** `TurnoverModal` posts
  `POST /installed-assets/from-job/:id` and only then
  `PATCH /jobs/:id { status: 'TURNED_OVER' }`. If the second call fails the
  equipment is still registered, the job stays COMPLETED and the modal says so
  — never a TURNED_OVER job with nothing in the installed base. The warranty
  default comes from `/aftermarket/settings`. A job with nothing to register can
  still be turned over ("Turn over without equipment").
- **The workspace's tab lives in the URL** (`?tab=budget`, `?tab=plans`…). The
  budget-request approval link now points at `?tab=budget`, the Budget Requests
  register opens the same, and the Plans register opens `?tab=plans` — the
  approver lands where the request can actually be found.

## The workspace (model §8.1)

Tab order: Overview · Budget · Scope · Plans · Procurement · Progress · Billing
· Finance · Service · Tasks · Documents · Activity.

- **Cross-module cards are hidden, not empty, without their `view_all`.** An
  empty "Purchase orders" card reads as "nothing was bought", which is a
  different claim from "you may not see this". A tab whose every card would be
  hidden is itself hidden.
- **Procurement / Finance cards read the owning module's list endpoint with
  `?jobId=`** and re-check each row's job on the client (`RelatedCard.belongs`),
  so a register that has not learned the filter shows nothing rather than every
  other project's documents. `+ Purchase request` goes to
  `/g-chain/purchase-requests?new=1&jobId=`.
- **Overtime shows the posted amount only** — and only for a filing at stage
  APPROVED. The rate is never rendered, even though the list endpoint returns it.
- **Cash advances & liquidations** come from FIN's
  `GET /cash-advances/for-job/:id` (`gops.budget_monitoring.view_all`). The
  expense-claims card uses `/expense-claims?jobId=` when the viewer holds
  `gfin.expenses.view_all`, and falls back to the claims that for-job returns
  when they hold only the budget right — one card, never two copies.
- **Service is one read**: `GET /jobs/:id/service` returns `{ assets, contract,
  contractVisible, reports, jobOrders }`, each section `null` without its
  register's `view_all`. Reports are those written against the job, its
  contract, or any asset it installed. Numbers, names, dates and statuses only.
- **Budget tab** = the position table, the job's budget requests (each row's
  approval chain behind an `Approval` disclosure, `DocumentApproval
  documentType="budget_request"`), and the cost ledger (`GET /jobs/:id/ledger`,
  state filter, "Show more" paging). A ledger source links through
  `recordLink(sourceType, sourceId)`; a type with no screen prints as text. The
  alert now says where each column fills from — including supplier bills with
  no receiving and approved expense claims / liquidations.
- **Evidence is attached, not described** (model §2.10): `job` on the Documents
  tab, `approved_plan` behind each plan's `Files` disclosure, `progress_report`
  ("Photos") on the report page — frozen once the report is APPROVED.
- People pickers use `GET /users/lookup` (rows carry `position`), never the
  admin-gated `/users`.

## New-project form (`/g-ops/projects?new=1&…`)

Reads `costingId`, `quotationRevisionId`, `type`, `renewFrom`; removes them from
the URL when it closes. Final costings only in the picker (`/costings/lookup?
status=FINAL`), but a preset costing is shown even if it is a draft so the
renewal flow (duplicate → reprice → create) still lands. With no preset
revision, the costing's single APPROVED revision is chosen; with several, a
picker appears. A costing that already produced a job says so, with links.

## Edits needed elsewhere (not in this package)

- `web/src/pages/service/InstalledBase.tsx:256` (AssetModal) →
  `/jobs/lookup?includeClosed=true` — equipment is registered at and after
  turnover, exactly when the job is closed.
- `web/src/pages/finance/Payables.tsx:359` (NewBillModal) →
  `/jobs/lookup?includeClosed=true` — a late supplier bill against a completed
  job is legitimate.
- `api/src/routes/warehouse.ts` borrow-slips `GET /` → add
  `if (q.filters.jobId) where.jobId = q.filters.jobId;` (the workspace guards on
  the client meanwhile, so today the card can under-report on a busy register).
- `web/src/components/ApprovalStepper.tsx` → the planned `compact?: boolean` on
  `DocumentApproval` does not exist yet; the Budget tab wraps it in
  `.del-approval-compact` instead. Pass `compact` once it lands.

## Known gap, not changed

`GET /jobs/:id` checks only `requireAny(view_all, view_own)` — a `view_own`
holder can open any job by id even though the list narrows to their own. Left
as it was (pre-existing; tightening it could lock out an engineer following a
PR link); worth a decision.
