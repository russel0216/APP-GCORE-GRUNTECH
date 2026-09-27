# Cash advances, liquidation and the finance audit fixes — notes worth carrying forward

Package FIN (item 2 of the Finance & Service plan, the `jobOrderId` invoice
extension from item 9, audit fixes 6-finance, 15-receivables, 20-payables and
23, and the `financePosition()` definition). Files:
`api/src/routes/advances.ts`, `api/src/routes/finance.ts`,
`api/src/shared/finance.ts`, `api/scripts/verify-finance.ts`,
`deploy/rebuild.ps1`, `deploy/rebuild.sh`,
`web/src/pages/finance/{CashAdvances,Expenses,Receivables,Payables,Reports}.tsx`,
`web/src/styles/finance.css`.

## The model in one paragraph

A **cash advance** is money handed to a person before it is spent. It is
requested (`CA` number), approved supervisor → finance through the engine,
**released in one voucher** (a DISBURSEMENT allocated to the advance), and
**liquidated** by an ordinary `ExpenseClaim` that carries `advanceId` (an `EXP`
number — there is no LIQ series; only the printed title says "Liquidation
Report"). Nothing reaches a project's ledger on approval or on release: the
approved liquidation posts INCURRED at what was actually spent, with the
existing `sourceType 'expense_claim'`. Spent less than released → the claim is
SETTLED and the advance reads REFUND_DUE until the unspent cash comes back as a
RECEIPT allocated to the advance (then LIQUIDATED). Spent more → the claim stays
APPROVED for the excess and is reimbursed like any claim; the advance is
LIQUIDATED.

## Invariants

- **`refreshAdvance(tx, id)` is the only thing that decides an advance's
  figures and status.** `amountReleased` = Σ DISBURSEMENT allocations,
  `amountRefunded` = Σ RECEIPT allocations, `amountSpent` = the approved
  liquidation's total, all re-derived, never incremented. DRAFT,
  PENDING_APPROVAL, REJECTED and CANCELLED are decisions and are never moved by
  it. `refreshSettlement(tx, 'advance' | 'advance_refund', id)` both delegate to
  it. Deleting a payment therefore rolls an advance back exactly (tested both
  ways).
- **Direction comes from `Payment.kind`, never a second column.** An advance
  allocation on a DISBURSEMENT is the release; on a RECEIPT it is a refund.
  `allocationKind()` in `finance.ts` is the one place that maps an allocation
  row back to its settleable kind.
- **An advance is released in one voucher.** `POST /payments` refuses an
  `advance` allocation that is not exactly `target.outstanding` ("An advance is
  released in one voucher — release PHP x or cancel it"). So `amountReleased ∈
  {0, amount}` and APPROVED → RELEASED is exact.
- **The liquidation clock starts on the payment date**, cleared or not — the
  person holds the cash from then. `liquidationDueDate = releasedAt +
  finance.rules.advanceLiquidationDays`, snapshotted at release, so changing the
  setting never moves a deadline already given.
- **A liquidation is settled against the excess, never its total.**
  `claimPayable(row) = max(0, total − advance.amountReleased)`; for a plain
  claim that is exactly `total`, so nothing that existed before moved. Every
  "what is still owed on a claim" (settleable, refreshSettlement, AP aging, cash
  flow, dashboard, `financePosition`) goes through it. A reimbursement measured
  against a liquidation's total would owe the person their advance twice.
- **SETTLED is terminal.** A liquidation the advance fully covered is SETTLED at
  approval; no payment can move it, and `refreshSettlement('claim')` leaves it
  alone.
- **A liquidation's project and budget line come from the advance.** The route
  overwrites whatever the body sends and refuses a differing `jobId` (400).
  Naming a project on an advance requires naming a budget line (400 otherwise),
  because the liquidation charges exactly that line.
- **One live liquidation per advance** (DRAFT, PENDING_APPROVAL, APPROVED,
  SETTLED, REIMBURSED count as live). A rejected or cancelled one can be
  re-filed. Only the person who received the cash (or a super admin) files it,
  and only while the advance is RELEASED.
- **Both settle handlers are idempotent and exported.** `settleExpense` and
  `settleAdvance` return immediately unless the document is still
  PENDING_APPROVAL, so a repeated settlement posts nothing, notifies nobody and
  audits nothing (tested by calling each twice).
- **A claim can only be cancelled while DRAFT or PENDING_APPROVAL.** Once
  approved it has charged a project, told somebody they are owed money, or
  settled an advance — that is reversed through finance, on the record.
- **An advance can be cancelled** while DRAFT/PENDING (owner or edit_all) or
  APPROVED with nothing released; once released: "Cash has been released —
  liquidate it instead." A release cannot be reversed (`DELETE /payments/:id`)
  while a live liquidation points at the advance.
- **A refund is cash in, never a collection.** Every "collected" aggregate
  filters `customerId: { not: null }`. The payments register finds a person by
  name (`payeeUser` is searched, `payeeUserId` is a filter).
- **`financePosition(today)` in `shared/finance.ts` is the one definition of the
  position.** `workingPosition = receivable − payable − reimbursable −
  advancesToRelease` (an approved advance is cash promised, so it counts before
  the voucher exists). It also returns `withheldAwaitingCertificate`,
  `advancesToRelease` and `advancesInHand`. `GET /finance-reports/dashboard`
  reads it; Insights must too (see "For P1" below).
- **Overdue liquidation is derived on read**, never stored: RELEASED with
  `liquidationDueDate < today`. `?overdue=true` on the list and
  `queue.liquidationsOverdue` on the dashboard both use that test.
- **The blocking rule** (`finance.rules.blockAdvanceWhileUnliquidated`, default
  on) refuses a new advance to somebody holding a RELEASED one. It is enforced in
  `POST /cash-advances` only.
- **An invoice for a job order is billed once, only when chargeable and
  complete.** `POST /invoices { jobOrderId }`: 400 unless `chargeBasis ===
  'CHARGEABLE'` ("…covered by warranty/contract — nothing to bill"), 400 unless
  `status === 'COMPLETED'` ("A job order is billed once its report is
  approved"), 400 if already invoiced; `customerId`, `jobId` and `poReference`
  default from the order. `Invoice.jobOrderId @unique` makes double-billing
  impossible rather than discouraged.
- **The project view of advances is budget-monitoring, not finance.** `GET
  /cash-advances/for-job/:jobId` requires `gops.budget_monitoring.view_all`
  (project access alone is 403, tested) and lives in `advances.ts` so `jobs.ts`
  imports nothing from finance. Route order matters: it sits above `/:id`.
- **`/expense-claims/chargeable`** (either `gfin.expenses.create` or
  `gfin.cash_advances.create`) is what the claim and advance forms load — not
  `/jobs/lookup`, which the filing roles cannot see. TURNED_OVER jobs are kept on
  purpose: a late receipt against a turned-over job is legitimate.

## Decisions taken in this package

- `POST /expense-claims/:id/submit` now routes the approval with
  `requesterId: claim.claimedById` (not whoever pressed the button) and reverts
  the claim to DRAFT if the engine refuses — the same shape as the advance
  submit. A super admin submitting on somebody's behalf could otherwise have
  approved the claim they did not file.
- `invoiceInclude` carries `jobOrder { id, number }`, so the invoice screen links
  back to the job order and the PDF prints "Job order" in place of "Billing no.".
- The sales invoice PDF (`GET /invoices/:id/pdf`, `gfin.ar.view_all`) signs
  "Approved by" with whoever raised it at the time it was issued, because
  invoices have no approval workflow; "Received by" has no `at` and prints
  Pending — the customer signs it.
- The cash-advance PDF signs "Checked by" (supervisor) and "Approved by"
  (finance) from `approvalSignoffs('cash_advance', id)`, the same pair the
  claim PDF uses, and "Received by" is the requester dated with the release
  payment (Pending until then).
- The deploy scripts run `npm run seed` **after** `prisma generate` (step 5),
  not straight after `db push`: the seed runs through the generated client, and
  step 5 is the first point where that client matches the schema. Seeding is
  idempotent by design (see CLAUDE.md "Local development").

## Screens

- **Cash Advances** (`/g-fin/cash-advances`, `/:id`): DataList `cash-advances`,
  scoped, Released/Spent/Liquidate-by optional columns, `ADVANCE_TONES`
  (APPROVED info, RELEASED warn, REFUND_DUE warn, LIQUIDATED ok). Detail
  actions by state: Print, Modify (draft), Send for approval, Release cash
  (APPROVED, `gfin.ap.create`), Liquidate (RELEASED, the holder), Record refund
  (REFUND_DUE, `gfin.ar.create`), Cancel. `DocumentApproval` shows the chain.
- **Expenses**: `StatusBadge` everywhere (the local `tone/label` copies from
  Receivables are gone), `STATUSES` with SETTLED, a Kind filter/column,
  `NewClaimModal` exported with an `advance` prop (locks project and budget
  line, previews excess/refund), detail on `RecordHeader` with a Settlement
  card, Print, `DocumentApproval`, and `Attachments entityType='expense_claim'`
  titled Receipts (editable by the claimant while the claim is open).
- **Receivables / Payments**: `PayTarget.kind` covers `advance` and
  `advance_refund`; the party goes to `customerId` for invoices only,
  `supplierId` for bills, `payeeUserId` for claims and both advance kinds.
  `?raise=<billingId>` opens `RaiseInvoiceModal`; InvoiceDetail has a
  breadcrumb, `RecordHeader`, Print, and customer / billing / job-order links.
  The Payments register opens `PaymentDetailModal` from `?payment=<id>` (row
  click sets it; notifications and report rows link to it), shows one link per
  allocation, and the clear button follows the API: `gfin.ar.edit_all ||
  gfin.ap.edit_all`. `CellLink` stops a link inside a clickable row from also
  opening the row.
- **Payables**: supplier and receiving are links (list, queue, detail),
  BillDetail has a breadcrumb, `RecordHeader` and `DocumentApproval`.
- **Finance Reports**: dashboard gains "Advances to release" and "Cash out with
  staff" stats, an "Advances approved, not yet released" bar, and three queue
  lines (awaiting release, liquidations overdue, refunds awaiting receipt).
  A/P aging shows "advances awaiting liquidation" only when there are any. Cash
  flow notes the advance figures inside the forecast. Uncleared payments link to
  `/g-fin/payments?payment=`. Settings gain the two cash-advance rules.
- No inline pixel values remain in the five finance pages; spacing moved to
  `web/src/styles/finance.css` (tokens only).

## For P1 (insights) — not applied here, apply exactly

`api/src/routes/insights.ts`:
1. Lines ~143 and ~147 (company overview) and ~247 (trend): add
   `customerId: { not: null }` to each `payment` RECEIPT `where`. A refund of
   unspent advance money is cash in but never a collection.
2. Company overview "working position": replace the local sum with
   `financePosition(today)` from `shared/finance.ts` and print its
   `workingPosition` (receivable − payable − reimbursable − advancesToRelease)
   so it cannot disagree with G-FIN's dashboard.
3. `/cash-forecast` (~683): the claims query selects
   `advance: { select: { amountReleased: true } }` and places
   `cents(claimPayable(claim) − num(claim.amountPaid))` as `reimbursable`
   (import `claimPayable`). Add two queries:
   `cashAdvance.findMany({ where: { status: 'APPROVED' } })` placed as
   `advances` at `neededBy ?? requestDate`, amount `amount − amountReleased`;
   `cashAdvance.findMany({ where: { status: 'REFUND_DUE' } })` placed as
   `refunds` at `liquidationDueDate ?? today`, amount
   `max(0, amountReleased − amountSpent) − amountRefunded`. Each bucket starts
   with `advances: 0, refunds: 0`; `net = invoiced + unbilled + refunds −
   payable − reimbursable − committed − advances`; `totals` gains `advances`
   and `refunds`.
4. `/cash-forecast.csv` (~793): emit one row per invoice, unbilled billing
   (`In`, due today), bill, claim (`Out`, claimPayable − paid), open PO with no
   bill (`Out`), approved advance (`Out`) and refund due (`In`) — same six
   columns, same `sendCsv` (which audits before the bytes go out).

`api/src/shared/insights.ts` `ForecastBucket` (~306): add
`/** Approved cash advances not yet released. */ advances: number;` and
`/** Unspent advance money due back. */ refunds: number;`.

`web/src/pages/insights/Reports.tsx`: the forecast interface gains `advances`
and `refunds` on buckets and totals; add "Advances out" and "Refunds in"
columns; include both in `peak`; the tile sub-text names them.

`api/scripts/verify-insights.ts`: `totals.advances` equals Σ APPROVED `amount −
amountReleased` read directly and equals `/finance-reports/dashboard
advancesToRelease`; `totals.reimbursable` excludes a SETTLED liquidation;
overview `collectedThisMonth` equals Σ cleared RECEIPT allocations with
`invoiceId` set.

## For others

- `api/scripts/verify-foundation.ts` (numbering case): add
  `/^GT-CA-\d{4}-\d{4}$/` for `nextNumber('cash_advance')` (verify-finance
  already asserts the same pattern on its fixture).
- `web/src/pages/delivery/ProjectWorkspace.tsx` (DEL): the cash-advances card
  reads `GET /cash-advances/for-job/:jobId` → `{ advances, claims }`; advances
  are `presentAdvance` rows (`number, status, requestedBy, amount,
  amountReleased, spent, excessDue, refundDue, refundOutstanding,
  liquidationDueDate, liquidationOverdue, liquidation`), claims are
  `presentClaim` rows (`number, status, kind, total, payable, outstanding,
  refundDue, advance`). Gate the tab on `can('gops.budget_monitoring.view_all')`.
  `ADVANCE_TONES` is exported from `pages/finance/CashAdvances.tsx` and
  `CLAIM_TONES` from `pages/finance/Expenses.tsx` for its badges.
- SVC's "Raise invoice" on a job order posts `{ jobOrderId, customerId, jobId,
  poReference, dueDate?, lines: [{ description: `${number} — ${title}`, amount
  }] }` to `POST /invoices` (needs `gfin.ar.create`).

## Owner-facing assumptions (from the plan, unchanged)

A1 approval does not touch the budget; A3 one voucher, one liquidation; A4 EXP
numbers; A5 refunds are RECEIPTs that never count as collections; A6 30 days,
one advance at a time, both editable in Finance Settings; A7 supervisor →
finance (finance staff's own advances stall while one person holds `finance`,
and `audit-workflows.ts` says so); A8 a project needs a budget line; A9
attachment routes still have no per-entity guard (pre-existing, not fixed here).
