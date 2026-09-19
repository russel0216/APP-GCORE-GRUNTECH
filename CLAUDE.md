# G-CORE — notes for AI agents

Integrated business operations platform for Gruntechnology Corp
(`gruntech.gcore.tech`). Node + Express + TypeScript + Prisma + PostgreSQL API,
React + Vite + TypeScript web app, one database.

## Read first

`docs/BUSINESS-OPERATIONS-MODEL.md` is the specification, not background
reading. Before adding a table, screen, form or workflow, check whether an
existing business entity already carries the concept (model §2.9). The whole
point of this rebuild is that the previous implementation was four apps with
four databases and four copies of "customer".

## The rules that are easy to break

1. **The permission registry drives the menu.** `api/src/permissions/registry.ts`
   generates both the `Permission` rows and the navigation. Adding a screen means
   adding a registry entry — never hard-code a menu item, and never check a
   permission string that the registry does not define.
2. **Never invent a second approval path.** Every document type routes through
   `api/src/shared/approvals.ts`. Call `submitForApproval(...)`, subscribe with
   `onApprovalSettled(...)`. Do not write per-module routing, notification or
   history.
3. **A requester can never approve their own document.** Enforced in `act()`,
   before the eligibility check, and for super admins too.
4. **Cost posts only when every step has approved.** Overtime is the live
   example: supervisor *and* HR. Subscribe to the settled event; never post on an
   intermediate approval.
5. **Numbers come from `nextNumber(documentType, tx)`.** Never format a document
   number by hand. Pass the caller's transaction so a rollback does not burn a
   number.
6. **Every printable document goes through `renderDocument(...)`.** Uniform PDFs
   across all menus is an explicit requirement. A module supplies sections; it
   never draws a header, signature block or page number.
7. **Record ownership is real.** Use `canEditRecord(user, module, sub, ownerId)`.
   "Only the author can edit the quotation, super admin can edit all."
8. **Audit through `audit(...)`**, and keep `redact()` in front of anything
   holding a password hash or a cost rate.
9. **Every list screen uses `web/src/components/DataList.tsx`.** Same toolbar,
   same scope switch, same export, everywhere.
10. **Money is `Decimal` in Prisma**, converted with `Number()` only at the API
    boundary. Never do arithmetic on a float and store it back.

## Verification

```bash
cd api && for s in foundation masters sales delivery chain hr finance aftermarket insights; do npx tsx scripts/verify-$s.ts; done
```

473 assertions across permission resolution, numbering concurrency, the approval
engine, the overtime two-step rule, amount bands, the audit trail, the PDF
engine, CSV parsing, the import contract, Phase 3's money paths (contract
amount, schedule-of-values reconciliation, VAT both ways, revision immutability)
Phase 6's HR arithmetic and face pipeline, Phase 7's tax, aging and allocation
arithmetic, Phase 8's schedule dates and template versioning, and Phase 9's
reconciliation between the reports and the records. `verify-hr.ts`,
`verify-finance.ts`, `verify-aftermarket.ts` and `verify-insights.ts` need the
API running: their route guards are checked over HTTP, and they say so loudly
rather than skipping them if the API is down. All create their own records and clean
up. Run them after touching anything in
`api/src/shared/` or `api/src/permissions/`. Add cases when you add a shared
service — the services have no click-path to test them, which is exactly why
these scripts exist.

`npx tsx scripts/audit-workflows.ts` is a separate read-only check: it reports
any workflow step routed to a role nobody holds, or to the role that normally
raises that document. Two seeded workflows shipped with that second fault and
were found one at a time by documents refusing to submit — run this instead.

`verify-sales.ts` imports `src/routes/sales` purely for its side effect, because
that import is what registers the quotation's `onApprovalSettled` subscriber. If
a test ever needs an approval outcome to do something, it must import the module
that subscribes — otherwise the approval settles into the void, and the engine
warns about exactly that.

## Local development

```bash
docker compose up -d
```

Postgres is on host port **5433**, not 5432, so it cannot collide with an
existing local install. Then `cd api && npm run dev` and `cd web && npm run dev`.

Seeded admin: `admin@gruntech.com` / `ChangeMe!2026`.

Re-running `npm run seed` is safe, and the rule it follows is worth knowing
before you change it:

- Permissions are refreshed from the registry and stale ones removed.
- A role/permission pair the seed has **never offered** is granted. This is how
  a permission introduced by a later phase reaches existing roles — without it,
  every new screen stays invisible until someone ticks it by hand.
- A pair it **has** offered before is left alone, because its absence now means
  an administrator revoked it deliberately.

The record of what has been offered lives in the `seed.offeredRolePermissions`
setting. Deleting that row makes the next seed re-grant every role its full
starting set, overriding any revocation.

## Decided, do not relitigate

- **Single tenant.** Gruntech only. Gas Ion keeps its own deployment. Company
  details still live in Settings because configurable PDF branding is a stated
  requirement — that is not tenancy work.
- **G-FIN is operations-driven only** — AR, AP, expenses, payments, cash flow,
  budget vs actual. No general ledger, payroll, fixed assets or tax filing.
- **Billing is VAT 12% + EWT 2%**, rates configurable. Downpayment recoupment and
  retention are deferred, with nullable columns reserved on `Job` and
  `ProgressBilling` so either can be switched on without migrating history.
- **EWT is withheld at source.** Invoiced ≠ collectible. A/R aging must never
  report withheld EWT as overdue.
- **Master data starts clean** — nothing migrates from the gasiontech apps.
  Phase 2 still ships a CSV import per master so a bulk load stays possible.

## Deployment — the hard constraint

The production server is **shared with a safety-critical system**
(`gasion-vision`, live hospital oxygen-plant monitoring). Careless restarts have
taken it down three times.

- **Never** kill Node by image name (`taskkill /F /IM node.exe`,
  `Get-Process node | Stop-Process`). A `//FI "WINDOWTITLE eq ..."` filter does
  not make it safe — background processes have no window title, so the filter
  matches nothing and any `||` fallback runs the unfiltered kill.
- **Never** stop or reconfigure the `Cloudflared` Windows service.
- **Never** run `pm2 kill` / `pm2 delete all` / `pm2 startup` on that host.
- Restart only by PID, by port, or via G-Core's own service entry.

In production the API serves `web/dist`, so there is one origin and one tunnel.

## Known advisory

`npm audit` flags `deepmerge-ts` (high) reached through the Prisma **CLI**'s
config loader — a dev-time dependency that only parses our own schema, not in the
server's runtime path. Prisma 7 drops it but adds an unused `mysql2` advisory, so
the tree is pinned to Prisma 6.19.3. Re-evaluate when Prisma 7 stabilises.

## Build order

**All nine phases are built.** The sequence in
`docs/BUSINESS-OPERATIONS-MODEL.md` §11 is complete.

What is left is not more phases. It is: deploying to the server under the
constraints below, assigning the seeded roles to real people (run
`scripts/audit-workflows.ts` — approvals route to roles, and an unheld role
means documents stall), entering real master data, and the two open questions
in model §14 (retention/downpayment, and whether Gruntech withholds from
suppliers). Treat further work as changes to a live system rather than as
phases: add a case to the matching `verify-*.ts` for anything that touches
`api/src/shared/`.

`SHIPPED_PHASE` in `web/src/lib/api.ts` is the single switch that turns a
phase's screens from "upcoming" to live. Bump it when a phase lands.

Screens from later phases already appear in the menu tagged with their phase and
are permission-configurable — that is deliberate, not a stub left behind.

## Phase 2 notes worth carrying forward

- **Employee vs User.** `Employee` is the person; `User` is the login, linked
  1:1 and optional. The reporting line lives on `User`, not `Employee`, because
  the approval engine routes by user and two places to record "who approves for
  me" is one too many.
- **Pay data** (`dailyRate`, `burdenMultiplier`, statutory numbers) is stripped
  server-side unless the caller holds `ghr.employee_rates.view_all`. Never hide
  it in the UI alone. Projects are charged the burdened rate, never the wage.
- **Cost categories are system rows.** The five cannot be deleted; the ledger
  groups by them. Labels are editable.
- **Deleting a master** is fine today because nothing references them. From
  Phase 3 onward, a customer with quotations or a supplier with POs must be
  deactivated, not deleted — commercial history cannot lose its counterparty.

## Phase 3 notes worth carrying forward

- **ScopeSection is both the scope of work AND the Schedule of Values.** One
  record, deliberately. Phase 4 reports progress against these sections, bills
  against them and draws the S-curve from their durations. Do not add a parallel
  SOV table.
- **The SOV must total the contract value.** `POST /costings/:id/sections/
  distribute` reconciles it, putting the rounding remainder on the last section
  so the sum is exact rather than a centavo out.
- **No Opportunity entity.** The requirements treat the opportunity as the lead
  until a quotation exists, so the pipeline is a view over leads + quotations.
  Do not introduce a third record to keep in step.
- **A revision leaves DRAFT and never comes back.** Approved, rejected and
  superseded revisions reject edits at the route. Raise a new revision instead —
  that is what revision control is for.
- **Only one revision per quotation may be APPROVED**; approving supersedes any
  earlier approved one, inside a transaction.
- **A costing marked FINAL rejects edits** except the status change that reopens
  it. An approved quotation and, in Phase 4, a project budget derive from it.
- **`vatRate` is snapshotted onto each revision** so an old revision still prints
  the tax it was issued with after Settings change. Same principle will apply to
  billing in Phase 7.

## Phase 4 notes worth carrying forward

- **`JobScopeItem` is a SNAPSHOT of the costing's `ScopeSection`**, not a
  reference. A costing can be reopened and edited; if progress were measured
  against live costing rows, every reported percentage would shift underneath
  the reports that recorded it. Covered by a test.
- **All cost reaches a job through `JobCostEntry`.** Never edit a stored budget
  total — write a ledger row with a `sourceType`/`sourceId`. Budget Monitoring is
  a view over that table.
- **Available = budgeted − committed − incurred.** CONSUMED is reported but NOT
  subtracted: stock issued to a job was already counted as incurred when it was
  received, and subtracting both charges the same peso twice.
- **Phase 5 writes COMMITTED (approved PR → issued PO), INCURRED (receiving) and
  CONSUMED (stock issuance).** Phase 6 writes INCURRED for posted overtime. The
  columns already exist and are already displayed.
- **Margin is reported as EXPECTED margin**, from the budget. Margin computed
  from spend-so-far reads 100% on a job that has not spent anything, which is
  true and useless. `grossMarginPct` is still returned but only means something
  near completion.
- **A progress report is a chain.** Only one may be open at a time, each carries
  the previous to-date percentages forward, and an approved one cannot be edited.
- **Billing covers only the increment.** It compares the report's to-date
  percentage against the highest already billed per scope line, so re-billing
  the same work is arithmetically impossible rather than merely discouraged.
- **EWT is withheld on the gross, not on the VAT.** Net collectible = gross + VAT
  − EWT. Invoiced ≠ collectible, and A/R must never read the withheld part as
  overdue.
## Phase 5 notes worth carrying forward

- **The two purchase kinds must stay disjoint.** DIRECT_TO_JOB charges the job
  at receiving and does NOT build stock. STOCK_REPLENISHMENT builds stock and
  charges a job only at issuance. Adding a direct-to-job receipt to inventory
  would let the same material be charged twice — a bug that shipped briefly and
  is now covered by a test.
- **Every handover releases what came before.** PR approval commits at estimate
  → PO issue releases that and commits the agreed price → receiving releases
  that and incurs. Use `releaseCommitment()`; it posts a negative row rather
  than deleting, so the ledger stays a history.
- **Moving weighted average**: a receipt recomputes it, an issue takes it as
  given. Issuing must never change the cost of what remains.
- **Borrowing does not charge job cost.** It moves stock out of *available*
  while leaving it owned. Only configure an internal rental rate if Gruntech
  actually charges projects for tool time (model §4.3).
- **The budget guard** blocks a direct-to-job PR that exceeds a category's
  available budget, unless `procurement.blockOverBudget` is set to false in
  Settings. Default on.
- **The S-curve's three lines share a time basis** — billed is plotted against
  the period its progress report covers, not the date the billing was raised.
  Otherwise comparing the lines is meaningless.

## Phase 6 notes worth carrying forward

- **The descriptor is computed on the server.** `describeFace()` in
  `src/shared/face.ts` takes the photo bytes; the browser posts a picture and
  nothing else. If you ever move that into the page for speed, you have handed
  the client the right to assert who it is. The photo is stored on every clock
  entry, whatever the method — it is the evidence, the match is the convenience.
- **Refuse a photo with more than one face.** Picking the largest is how you
  clock in a colleague who is not there. Covered by a test against the sample
  group photo.
- **Prior approval moves no money.** `overtime_prior` settles to
  `PRIOR_APPROVED` and writes nothing to the ledger. Only `overtime_request` —
  the actual filing, through the seeded two-step supervisor → HR workflow —
  posts INCURRED, and at the ACTUAL hours, never the estimate.
- **A leave balance is spent on approval, not on filing.** Pending days are
  reported separately (`remainingAfterPending`) so nobody over-commits, and
  cancelling an approved request gives the days back. Filing must never be able
  to cost somebody an entitlement.
- **Absence is derived, never stored.** The dashboard infers it from active
  employees with no attendance row and no approved leave. A nightly job writing
  absence rows would be wrong the moment someone clocked in late.
- **A fallback always carries a written reason.** The fallback is the weak door;
  an unexplained one is all an audit would have to go on.
- **Overtime's job lookup is `/overtime/chargeable`, not `/jobs/lookup`.**
  Naming the job you worked on is not the same right as project-management
  access. It returns numbers and names only. Note the route order — it must sit
  above `/:id` or the `:id` route swallows it.
- **Burdened, never the wage.** A project is charged
  `dailyRate × burden ÷ hoursPerDay × premium`. Nobody sees a colleague's salary
  on a project screen; `ghr.employee_rates.view_all` gates the rate itself.
- **The menu highlights the longest matching path.** A module dashboard lives at
  the module root (`/g-hr`, `/g-chain`), so a plain prefix test lights it up on
  every screen in that module. `Shell.tsx` picks the most specific match.

## Phase 7 notes worth carrying forward

- **Outstanding is measured against NET COLLECTIBLE, never the invoice total.**
  `settleable()` and `refreshSettlement()` in `src/shared/finance.ts` are the
  only places that decide it. An invoice paid to its net collectible is PAID;
  measuring against the invoice total would leave every customer permanently
  short by the withheld EWT and make them all look like late payers.
- **EWT is withheld on the gross, not on the VAT** — on both sides. Same rule as
  Phase 4's billing, in the other direction for supplier bills.
- **A supplier bill matched to a receiving posts NO job cost.** The receiving
  already incurred it (Phase 5); posting again charges the project twice.
  `bill.receivingId !== null` is the whole test. A bill with nothing received
  behind it — subcontract certificate, service call, utility — is the first time
  that cost appears, so that one does post, at the SUBTOTAL because input VAT is
  recoverable. Covered by a test that asserts exactly one of two bills reaches
  the ledger.
- **A payment must be fully allocated, and cannot over-apply.** Every allocation
  is checked against `outstanding` before anything is written. Settled totals are
  RE-DERIVED from the allocation rows, never incremented, so deleting a payment
  cannot leave a stale balance behind.
- **Cleared money only.** Cash-flow actuals count payments with a `clearedAt`. A
  cheque is recorded on the day it is written and stays uncleared until somebody
  says otherwise — a position that counts promises is the one that bounces.
- **An invoice is raised FROM a billing and carries its figures.** Both rates,
  both tax amounts and the line breakdown are copied, never recomputed, so an
  invoice raised months later still prints the tax the work was billed under.
  `progressBillingId` is unique, which is what makes double-invoicing impossible
  rather than merely discouraged.
- **The supplier-bill workflow must not route to finance.** Finance receives the
  supplier's invoice, so finance raises it — the third seeded workflow to ship
  with that fault. `audit-workflows.ts` now knows the typical requester for it.
- **Finance owns its own rules** (`gfin.settings`), the same way HR owns the
  working day. Payment terms, supplier withholding and the aging buckets live
  there; VAT and EWT stay on the company record because they print on documents
  from three other modules.

## Phase 8 notes worth carrying forward

- **A service contract IS a job of type SERVICE_CONTRACT** (model §4.5). Its
  costing, budget, schedule of values and progress billing are the Phase 3/4
  machinery unchanged. `ServiceContract` is a 1:1 extension carrying only what a
  job cannot: what is covered, how often, and until when. Do not give it a
  second commercial record to drift out of step.
- **Service Costing is the costing list narrowed to service jobs**, via
  `?jobType=SERVICE_CONTRACT`. A service costing is a costing whose job happens
  to be a contract — it is not a different table.
- **The first PM visit falls one interval AFTER cover starts**, not on day one;
  a visit that would fall past the end date is dropped, not clamped. `addMonths`
  clamps to the month end, so three months after 31 January is 30 April.
- **Regenerating a schedule only rewrites SCHEDULED and CANCELLED visits.**
  COMPLETED and MISSED ones are a record of what happened and must survive.
- **A template that has been used is immutable.** Editing publishes a new
  version under the same key and flips `isCurrent`; reports keep pointing at the
  exact version row they were filled in on. That is the only reason an old
  report still renders the way it was signed.
- **A visit completes when its REPORT is approved**, not when the engineer
  leaves site — otherwise the schedule counts visits nobody has checked. A
  rejected report leaves its visit open.
- **Warranty is a fact, not a tick box.** `underWarranty` is decided from the
  asset's dates against the date the work was done, at the moment the report is
  created. A commissioning report is what starts a warranty running.
- **A report cannot be submitted half-filled or unsigned**, but saves as a draft
  freely — it is written on site, often on bad signal, and a form that refuses to
  save gets filled in afterwards from memory instead.
- **Expiry and missed visits are swept on read**, in `sweepOverdue()`, called
  when the aftermarket screens load. G-Core has no scheduler, and a status that
  is only correct when a cron job ran is worse than one derived on read.
- **The renewal pipeline has two sources**: contracts ending, and warranties
  lapsing on equipment with no active contract. The second is the one nobody
  sees and usually the larger opportunity.
- **The three report menus are one screen.** Commissioning, PM and Inspection
  are `kind` filters over `ServiceReport`; what differs between them lives in
  the template, which is data.

## Phase 9 notes worth carrying forward

- **Insights adds NO tables, and must never acquire one.** Every figure is read
  off documents the other phases record. The moment a report keeps its own copy
  of a number, it gains the ability to disagree with the document behind it —
  which is the whole failure mode this layer exists to avoid. The router ends
  with a middleware that refuses any non-GET request, and there is a test for it.
- **Where a report disagrees with a module screen, the report is wrong.**
  `verify-insights.ts` asserts profitability against the ledger read directly,
  and the company overview against the sales report. Add a reconciliation
  assertion whenever you add a figure that also appears somewhere else.
- **A quotation's value is its latest APPROVED revision, else its latest.** The
  overview briefly counted only approved ones and showed an open quotation as
  worth nothing while Sales Analytics showed its real value. Two screens
  disagreeing is the bug this module is most prone to.
- **Say when a number is not yet meaningful.** `tooEarly` flags a job that has
  spent under 20% of its budget, because its running margin is ~100% and that is
  true and useless. Screens lead with EXPECTED margin, which comes from the
  budget and means something on day one.
- **Slow-moving stock ranks by VALUE, not age.** A thousand idle washers matter
  less than one idle compressor, and sorting by age buries the compressor.
- **The cash forecast counts what is waiting on US** — approved billings nobody
  invoiced, and issued purchase orders nobody has billed us for. A forecast
  built only from invoices flatters the position on both sides.
- **Performance is about output, never attendance.** Lateness and leave stay in
  G-HR behind HR's permissions. Aggregating them into a management league table
  would turn a payroll record into a surveillance tool without anybody deciding
  to. The approval-bottleneck view is the useful half anyway.
- **Every report has a `.csv` twin, and the export is audited before the bytes
  go out.** An export that failed to be logged should not have happened.
- **Each role gets the cross-cutting view its job needs**; only `executive` sees
  all of them, because Insights aggregates margin.
