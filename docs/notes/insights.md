# Insights — the company at a glance, industries, one quotation value (package P1)

Notes for the model doc (§9, §11) and CLAUDE.md's Phase 9 notes.

## What was built

- **The brief.** The top of Insights › Company Overview carries "The company at a
  glance": one sentence per division (G-OPS, G-CHAIN, G-HR, G-FIN), every figure
  a link to the list it counts. It rides on `GET /insights/dashboard` as
  `summary: { range, asOf, lines: { gops, gchain, ghr, gfin } }` — one read, one
  snapshot. `GET /insights/summary.csv` is its CSV twin.
- **`api/src/shared/gops.ts`** — `periodWhere()` and `gopsOverview(me, query)`,
  moved verbatim out of `routes/gops.ts`. `/gops/overview` is now
  `res.json(gopsOverview(...) minus _scope)` and is byte-identical.
- **Sales Analytics by industry.** `/insights/pipeline` gains `industries[]`
  (`{ code, name, leads, quotations, quotedValue, won, wonValue, lost,
  winRatePct, openValue, weightedValue }`); `/pipeline.csv` appends an
  `Industry` column. The screen has a "By industry" card (BarList + table).
- **One quotation value.** Every Insights reader (dashboard, trend, pipeline,
  pipeline CSV, performance) calls `quotationValue()` from `shared/pipeline.ts`.
  The five inline "approved else latest" lambdas are gone.
- **FIN's Insights half.** `ForecastBucket` gains `advances` (out) and `refunds`
  (in); claims are measured with `claimPayable()`; `net = invoiced + unbilled +
  refunds − payable − reimbursable − committed − advances`. The cash-forecast
  CSV now lists every document the screen counts (invoices, unbilled billings,
  bills, claims, open POs, advances, refunds) from the same `forecastItems()`.
- **Record links.** Cash forecast "Waiting on us" rows open `/g-ops/billings/:id`;
  "Uncleared" rows open `/g-fin/payments?payment=`; Performance bottleneck rows
  open `ApprovalRequest.link`. `approvalBottleneck()` in `shared/insights.ts`
  serves both `/performance` and `/performance.csv`; the CSV APPENDS a `Link`
  column.
- **`Brief`** in `web/src/components/charts.tsx` (`BriefPart`, `BriefLine`),
  styled by `web/src/styles/brief.css`.

## Invariants worth carrying forward

- **The brief reconciles to the MODULE dashboards, through their own
  functions.** `gopsOverview` (G-OPS), `chainOverview` (G-CHAIN),
  `attendanceDay` (G-HR), `financePosition` (G-FIN). Change the shared
  function, never the brief. `verify-insights-brief.ts` asserts every figure
  against the module's own endpoint.
- **Who sees a line is that module's `*.dashboard.view_all`, decided on the
  server.** A figure the caller may not see is OMITTED, never sent as 0. Out of
  the box only `executive` sees all four; `finance` sees G-FIN only; someone
  holding just `insights.dashboard.view_all` gets the page with all four lines
  null ("holding the overview is not holding the counts").
- **The CSV needs two exports.** `insights.dashboard.export` to call it, and a
  module's rows also need `<module>.dashboard.export`. Seeing a number on screen
  is not the right to take a file of it away. The export is audited
  (`entityType 'insights'`, `entityId 'company-summary'`) before the bytes go out.
- **`scope: 'mine'`.** G-OPS figures carry the scope `gopsOverview` counted
  them with (`_scope` — present on the function's result, STRIPPED by the
  `/gops/overview` route so that response did not change). A view_own holder's
  quotations are marked "(yours)" in the sentence and `mine` in the CSV's
  `Scope` column. G-CHAIN's purchase-request count is scoped the same way.
- **Every day on the panel is Manila's, each line read its own module's way.**
  G-OPS period figures through `periodWhere`; the G-HR day through HR's local
  `dayKey` (the server clock), with the brief's overtime window parsed exactly
  as `/hr-reports/overtime-by-project` parses it (`hrReportWindow()`); G-FIN
  and G-CHAIN through `dayKey`, which is `manilaDate`. Until 2026-10-02 these
  were three different days: G-FIN and G-CHAIN took the UTC date, yesterday's
  until 08:00, and G-OPS ranges opened at UTC midnight, 08:00 in Manila
  (`docs/notes/day-boundaries.md`). The caption on the panel says so.
- **`parseRange()` has two pairs of edges.** `from`/`to` are for `@db.Date`
  columns: UTC midnight to 23:59:59.999Z of the last day. (`to` used to be
  midnight, which silently dropped the last day for timestamps — "this month,
  to today" left out a quotation won this morning.) `fromAt`/`toAt` are for
  timestamps (`decidedAt`, `createdAt`): Manila midnight to 23:59:59.999 in
  Manila. On the DATE edges a timestamp's day ran 08:00 to 08:00, and a
  quotation won at 07:00 on the 1st counted in the month before.
- **The working position is G-FIN's, to the centavo.**
  `receivable − payable − reimbursable − advancesToRelease`, from
  `financePosition()`. The Insights tile used to print receivable − payable and
  now drops by the approved, unpaid claims and approved, unreleased advances.
  Its sub-text reads "receivable less everything owed".
- **"Collected" is customer receipts only** (`customerId: { not: null }`) on
  the dashboard, the trend and the brief. An advance refund is cash in, never a
  collection. The cash forecast counts it — as `refunds`, not as a collection.
- **The cash forecast totals ARE the finance position**: `invoiced =
  receivable`, `payable = payable`, `reimbursable = reimbursable`,
  `advances = advancesToRelease`. Asserted in both verify scripts.
- **Industry is the customer's.** A quotation reports under its customer's
  industry; a lead under its customer's, and a lead with no customer — or a
  customer nobody classified — under `UNCLASSIFIED`, always the last row.
  Every ACTIVE industry is listed even at zero; an inactive one appears only
  while a record still carries it. The industry table sums to the report's own
  totals (leads, won, won value, lost, open, weighted) — asserted.
- **Stock on hand is `stockOnHand()`** for `/insights/dashboard.chain`,
  `/insights/inventory.totalValue` and the brief — the same function the
  G-CHAIN dashboard and `/inventory/reports/summary` use.
- **CSV columns are appended, never reordered** (`Industry` on the pipeline
  export, `Link` on the approvals export) so a sheet somebody built on an
  export keeps working.
- **Insights still adds no tables**, and the non-GET guard still ends the
  router; `POST /insights/summary.csv` is refused with "read-only".

## Brief figure links (each query key is a filter the target DataList declares)

| Figure | Opens |
|---|---|
| enquiries in play | `/g-ops/leads` |
| quotations out / in negotiation | `/g-ops/quotations` |
| projects in progress / on hold | `/g-ops/projects` |
| progress reports awaiting approval | `/g-ops/progress` |
| service contracts running | `/g-ops/service-contracts` |
| PM visits done | `/g-ops/visits` |
| purchase requests awaiting approval | `/g-chain/purchase-requests?status=PENDING_APPROVAL` |
| orders awaiting delivery | `/g-chain/purchase-orders` |
| borrow slips overdue | `/g-chain/borrow-slips?overdue=true` |
| stock on hand | `/g-chain/inventory` |
| active employees | `/g-hr/employees` |
| present / late today | `/g-hr/attendance?status=PRESENT` / `?status=LATE` |
| on leave today | `/g-hr/leave?status=APPROVED` |
| absent today, HR approvals waiting | `/g-hr` (absence is inferred; no register lists it) |
| overtime hours / pesos | `/g-hr/reports` |
| receivable / overdue | `/g-fin/ar?outstanding=true` / `/g-fin/ar?overdue=true` |
| payable / overdue | `/g-fin/ap?outstanding=true` / `/g-fin/ap?overdue=true` |
| owed to staff | `/g-fin/expenses?status=APPROVED` |
| advances approved, not released | `/g-fin/cash-advances?status=APPROVED` |
| working position | `/g-fin` (the finance dashboard prints it) |
| collected in range | `/g-fin/payments` |
| approved billings not invoiced | `/g-fin/ar` |

Checked against the screens' declared filters: Receivables (`status`,
`outstanding`, `overdue`), Payables (`status`, `outstanding`, `overdue`),
Expenses (`status`), CashAdvances (`status`, `overdue`), PurchaseRequests
(`status`), BorrowSlips (`status`, `overdue`), AttendanceRegister (`status`),
Leave (`status`).

## Deviations from the plan, and why

- **The brief's G-FIN line adds `advancesToRelease`.** FIN's
  `financePosition().workingPosition` subtracts approved advances, so without
  that figure the sentence's arithmetic would not add up on screen.
- **`absent` and `pendingApprovals` open `/g-hr`, `present` opens
  `/g-hr/attendance?status=PRESENT`.** Absence is derived and never stored, so
  the attendance register cannot list it; the HR dashboard is the screen that
  prints that number.
- **`workingPosition` opens `/g-fin`** (the plan said `/g-fin/cash-flow`): the
  finance dashboard is where that exact figure is printed.
- **`verify-insights-brief.ts` uses its own tag (`ZZINB`, `@verifyib.local`,
  roles `zzinb_`)** rather than the plan's `ZZINS`, so it and
  `verify-insights.ts` never delete each other's fixtures.
- **Raw pixels and rgba literals** in `insights/Overview.tsx` and
  `insights/Reports.tsx` were replaced with spacing tokens and
  `rgb(var(--*-rgb) / a)`.

## Verification

- `npx tsx scripts/verify-insights.ts` — 92 passed (was 80): the old
  "working position is receivable less payable" assertion is replaced by G-FIN
  parity; new cases for advances, refunds, SETTLED liquidations, customer-only
  collections, forecast ↔ finance position, CSV parity, bottleneck links.
- `npx tsx scripts/verify-insights-brief.ts` — 43 passed (new).
