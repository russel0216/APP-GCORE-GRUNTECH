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
5. **Numbers come from `nextNumber(documentType, tx, ctx?)`.** Never format a
   document number by hand. Pass the caller's transaction so a rollback does not
   burn a number, and pass `{ ownerId }` in `ctx` for anything whose pattern may
   carry `{EMP}` (the quotation's does). `ctx` is a `NumberContext`
   (`{ at?, ownerId?, employeeNo? }`), never a bare `Date`.
6. **Every printable document goes through `renderDocument(...)`.** Uniform PDFs
   across all menus is an explicit requirement. A module supplies sections; it
   never draws a header, sign-off block, footer or page number. The layout is
   patterned on the paperwork the business already issues (`P00340`,
   `REQ-00073`): a **14pt margin**, the document naming itself top-left, the
   logo top-right, a slate table head in white, the company block in the footer,
   and sign-offs as one line each — `APPROVED BY : Name (Position), Sep 17,
   2026, 9:13 AM` — with **no signature rules**.
   **Give every signatory an `at`**, so a document dates its own sign-offs. For
   anything routed through the approval engine,
   `approvalSignoffs(documentType, documentId)` returns the name and timestamp
   per step; spread it into the matching slot. Leave `at` off where nothing has
   happened — the slot then prints "Pending", which is the truth, rather than
   borrowing the document's date.
   **Money is `formatMoney`, which prints `PHP 1,562.20`** — the currency code,
   not `₱`. U+20B1 is outside WinAnsiEncoding, so a standard PDF font draws it
   as `±`. Never put a non-Latin-1 character in a PDF without embedding a font.
   **The quotation is the one exception: a designed document.** Its layout is
   DATA — boxes on an A4 page that an administrator places in Admin › PDF
   Templates — and it prints through `renderDesigned(design, data)` in
   `shared/pdfDesign.ts`, the same engine's other door. The module still
   draws nothing: `quotationPrintData()` supplies fields, rows, totals and
   signatories; the engine places every box, keeps the dated sign-offs, and
   puts every string through `pdfSafe`. The standard layout
   (`STANDARD_QUOTATION_DESIGN`) is the owner's Quotation_Template (36pt
   margins, purple #5B2A8C heads, green #2E9A4B number and subheadings, light
   #D9D9D9 rules, totals flush right, sign-offs side by side, the strapline on
   every page, a running header after page one, no Conforme); table figures
   are `formatAmount`, because the currency is named in the head and the
   total. Every other document stays on the house style, which is code — see
   "Quotation PDF template" below.
7. **Record ownership is real.** Use `canEditRecord(user, module, sub, ownerId)`.
   "Only the author can edit the quotation, super admin can edit all."
8. **Audit through `audit(...)`**, and keep `redact()` in front of anything
   holding a password hash or a cost rate.
9. **Every list screen uses `web/src/components/DataList.tsx`.** Same toolbar,
   same scope switch, same export, everywhere. **Every chart uses
   `web/src/components/charts.tsx`** — `Stat`, `BarList`, `Funnel`, `Donut`,
   `Meter`, `MiniBar`, `Panel`. There were three hand-rolled bars before that
   file and none of them looked alike. Two rules they hold to: a chart is
   readable without colour (every series carries its own number), and an empty
   series says "nothing yet" rather than drawing a frame that looks like a
   failed load.
9a. **A menu entry must open what its label says.** Both halves of that: the
   path in the registry has to have a route (G-OPS Purchase Requests had none
   and fell through to "Not built yet"), and the screen has to show what the
   label promises ("Progress & Billing" showed progress reports only). Run the
   label-to-component map before adding a menu entry, not after.
10. **Money is `Decimal` in Prisma**, converted with `Number()` only at the API
    boundary. Never do arithmetic on a float and store it back.
11. **Spacing, type and colour come from tokens in `web/src/styles.css`.** Use
    `var(--s-1..--s-8)` for spacing, `var(--fs-xs..--fs-2xl)` for type. Do not
    write a raw pixel value in an inline `style`; the app carried 537 of them
    across fourteen different margin values, and that is what the tokens exist
    to stop. `--faint` is the *lowest* readable text colour at 4.6:1 — nothing
    dimmer.
12. **One status pill: `StatusBadge` from `components/ui.tsx`.** `statusTone()`
    takes an `extra` map for a module's own statuses. Do not write a tenth local
    `tone()`; there were nine and they had already drifted.
13. **Every interactive thing is reachable from a keyboard.** A `<div onClick>`
    that opens a record is a bug. Use a `<Link>` or a `<button>`, or give it
    `tabIndex` and an Enter/Space handler. `:focus-visible` is global — do not
    remove an outline without replacing it.
14. **The menu is two levels, and both come from `SubmoduleDef.group`** in
    `api/src/permissions/registry.ts`, carried through `menuFor()`. The sidebar
    lists a module's SECTIONS; the section you are in opens its screens on a
    second line across the top. A module whose entries declare no group renders
    flat with no second line. `group` takes no part in permission keys — adding
    or renaming one leaves `allPermissions()` byte-identical. Never hard-code a
    grouping in `Shell.tsx`, and keep a section to roughly six screens: ten on
    one line is what the two levels exist to avoid.
15. **A menu path must be a path the app actually renders.** Three aftermarket
    entries used to `<Navigate>` to `/g-ops/service-reports?kind=…`, a URL the
    registry does not declare — so the menu could highlight nothing, and the
    `?kind=` was never read, leaving all three menus showing every report. One
    screen serving several menu entries takes `initialFilters` on `DataList` and
    keeps each entry's own path.
16. **A DataList's state lives in the URL, and only for keys it declares.**
    `?q=`, `?scope=`, `?page=` and `?<key>=` for every key in the screen's
    `filters` are read on mount and written back with `replace`; undeclared keys
    (`new`, `customerId`, `visit`, `tab`…) are left untouched, so a list never
    eats another screen's deep-link parameter. The URL beats `initialFilters`,
    and a value equal to the route's preset is not written, so a preset menu
    entry keeps the path the registry declares (rule 15). The API query still
    says `search=`; only the browser URL says `q=`. A link such as
    `/g-fin/ar?overdue=true` filters only if that DataList **declares**
    `overdue` — link to declared keys only, and when a dashboard tile links to a
    list, the tile's count and the filtered list's total must come from the same
    query (the G-CHAIN "awaiting delivery" tile and `?awaiting=true` are asserted
    equal). A page mounting two DataLists at once passes `urlState={false}` on
    one of them, or they share `?page=`.

## Verification

```bash
cd api && for s in foundation masters sales costing pipeline calendar numbering partners delivery chain hr plantilla meetings evaluations academy finance aftermarket archive insights insights-brief workspace accounts; do npx tsx scripts/verify-$s.ts; done
```

**2,131 assertions across twenty-two scripts** (counted 2026-10-02): foundation 175,
masters 54, sales 251, costing 105, pipeline 44, calendar 38, numbering 46,
partners 82, delivery 78, chain 72, hr 104, plantilla 91, meetings 86,
evaluations 125, academy 97, finance 139, aftermarket 168, archive 113,
insights 94, insights-brief 44, workspace 39, accounts 86. They cover permission resolution, numbering
concurrency and the per-employee counters, the approval engine, the overtime
two-step rule, amount bands, the audit trail, the PDF engine and the sign-offs,
margins and money it prints, CSV parsing, the import contract, Phase 3's money
paths (contract amount, schedule-of-values reconciliation, VAT both ways,
revision immutability), Phase 6's HR arithmetic and face pipeline, Phase 7's
tax, aging and allocation arithmetic, Phase 8's schedule dates and template
versioning, Phase 9's reconciliation between the reports and the records, and
Phase 10's rules listed below.

**Only `verify-foundation`, `verify-masters` and `verify-sales` run without the
API** (and the SMTP half of `verify-accounts`, which talks to a fake mail server
it starts on 127.0.0.1). The other nineteen check route guards and responses over HTTP against
`http://localhost:5100`, and say so loudly — a failed "API is not reachable"
line — rather than skipping them if the API is down or restarting (under
`tsx watch` an edit elsewhere restarts it mid-run; rerun that script). All create
their own records and clean up. Run them after touching anything in
`api/src/shared/` or `api/src/permissions/`. Add cases when you add a shared
service — the services have no click-path to test them, which is exactly why
these scripts exist. A script that needs a module's `onApprovalSettled`,
`registerSearch` or `registerSchedule` side effect imports that route module
(`verify-academy` imports `routes/academy`, `verify-numbering` imports
`issuedThisPeriod` from `routes/admin`).

`npx tsx scripts/audit-workflows.ts` is a separate read-only check: it reports
any workflow step routed to a role nobody holds, or to the role that normally
raises that document. Two seeded workflows shipped with that second fault and
were found one at a time by documents refusing to submit — run this instead.

`verify-sales.ts` checks the STANDARD quotation layout's wording, so it sets an
administrator's saved layout aside for the run (`pdfTemplate.quotation.__verify__`,
a Setting of its own) and `cleanup()` — which also runs first — puts it back.

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

Seeded admin: the seed creates `admin@gruntech.com` / `ChangeMe!2026` (or
`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`) **only on a fresh database** — when
the account already exists it is left alone. The local dev database's admin
password has since been changed, so that pair will not sign in here; use
`npx tsx scripts/reset-password.ts admin@gruntech.com` if you need in.

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

**The scripts are in `deploy/`.** `preflight.ps1` is read-only and reports what
would collide; `install.ps1` runs once and refuses if the preflight fails;
`rebuild.ps1` / `rebuild.sh` are every deploy after that. G-Core owns
`C:\G-CORE-GRUNTECH`, port **5100**, the **`GCoreGruntechApi`** scheduled task,
the **`gcore-gruntech-db`** container on **5435**, and the **`gcore-gruntech`**
tunnel — nothing else on that machine.

Two traps worth knowing before you edit those scripts:

- **The repository's root `docker-compose.yml` must never run on that server.**
  It publishes 5433, which is already `gasion_db`. `deploy/docker-compose.prod.yml`
  uses 5435 and its own volume.
- **`node.exe` reports the same executable path for every node process on the
  box**, so an ownership check on `Process.Path` would judge our own API a
  stranger and refuse to free the port on every rebuild. `Test-OurProcess`
  matches on the *command line*, which is why `start-api.cmd` launches with an
  absolute script path. Do not "simplify" either half.

## Known advisory

`npm audit` flags `deepmerge-ts` (high) reached through the Prisma **CLI**'s
config loader — a dev-time dependency that only parses our own schema, not in the
server's runtime path. Prisma 7 drops it but adds an unused `mysql2` advisory, so
the tree is pinned to Prisma 6.19.3. Re-evaluate when Prisma 7 stabilises.

## Build order

**All ten phases are built.** The sequence in
`docs/BUSINESS-OPERATIONS-MODEL.md` §11 is complete; Phase 10 added depth across
every division (hire-to-separate, cash advances, job orders, the pipeline board,
partners, the numbering house scheme and more — see "Phase 10 notes" below and
model §4.7).

What is left is not more phases. It is: deploying to the server under the
constraints below, assigning the seeded roles to real people (run
`scripts/audit-workflows.ts` — approvals route to roles, and an unheld role
means documents stall), entering real master data, and the two open questions
in model §14 (retention/downpayment, and whether Gruntech withholds from
suppliers) plus the Phase 10 decisions listed there. Treat further work as
changes to a live system rather than as
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
- **A quotation's value is its latest APPROVED revision, else its latest** —
  `quotationValue()` in `shared/pipeline.ts`, and nothing else. The overview
  briefly counted only approved ones and showed an open quotation as worth
  nothing while Sales Analytics showed its real value. Two screens disagreeing
  is the bug this module is most prone to; there used to be five inline copies
  of this rule.
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

## Phase 10 notes worth carrying forward

Phase 10 added depth to every division rather than a new one. The rules below
are grouped by area; the model doc carries the business version (§4.1, §4.5,
§4.6, §4.7, §7, §13).

### Shared seams

- **Manila calendar keys live in `shared/day.ts`** (`manilaDayKey`,
  `manilaMonthKey`). Deep links and forecast columns bucket on these, never on
  the host clock, because the server's clock is not the business's day.
  Numbering keeps its local-getter `{YYYY}`/`{MM}`.
- **Today, for a DATE column, is `manilaDate(new Date())`** (`shared/day.ts`).
  Until 08:00 in Manila the UTC date is still yesterday's, and it arrives
  unasked three ways: `getUTC*`; a bare `new Date()` written into, or compared
  with, a `@db.Date` column (Prisma binds it as a DATE and drops the time); and
  a DATE column's `@default(now())`, which the database evaluates in UTC — so a
  route sets that column itself. The `dayKey()`s of `shared/finance.ts`,
  `shared/aftermarket.ts` and `shared/insights.ts` ARE `manilaDate()`; a stored
  DATE or a parsed `'YYYY-MM-DD'` is UTC midnight, 08:00 in Manila, and comes
  back unchanged. A DATE compared in JavaScript is compared with that day, never
  with the instant — a borrow slip once flagged itself overdue at 08:00 on the
  day it was due. `docs/notes/day-boundaries.md` has the audit.
- **"Today" in My Work is a timestamp window**, local midnight to the next, not
  `dayKey()`. `dayKey()` is a key for `@db.Date` columns (UTC midnight of the
  local date) and would put the boundary at 08:00 Manila. A provider comparing a
  DATE column to that window asks for a padded range and filters in code, because
  comparing a DATE to a timestamp truncates the edges.
- **`registerSchedule(fn)` in `routes/workspace.ts` is the seam for "today"**;
  Meetings, the Academy and the Service Schedule register from their own
  modules. The `/my-work` row contract is `{ id, kind, title, subtitle?, when?,
  overdue?, link }` with `link` starting `/` — a new source of work adds a query
  and a mapper, never a new section shape.
- **Search providers may declare `permission: string[]` and `ownWhere(user)`**;
  own-scope narrowing applies only when the caller holds none of the provider's
  non-`view_own` keys. A provider without it shows every record to a `view_own`
  holder.
- **`GET /users/lookup?q=&holding=` is the people picker** — authenticated only,
  names only, declared above `/:id`. Never feed a picker from the admin-gated
  `/users`; the salesperson or engineer using the form cannot read it.
  `/employees/lookup` answers at most 50 rows — a picker that needs everyone adds
  a search box, as the Academy's does.
- **HR lists are Settings, whitelisted by route**: `GET/PUT
  /hr-settings/lists/:key` for `hr.clearanceChecklist` and
  `hr.evaluationCriteria`, each with its own zod row schema. A screen renders
  settings from the merged `GET /hr-settings`, never the raw row, because the
  seed's `update: {}` means an existing install has none of the newer keys
  stored. A settings card PUTs only the keys it edits — sending the whole object
  it loaded writes stale keys back over another card's save.
- **`redact()` strips `dailyRate, burdenMultiplier, sssNo, philhealthNo,
  pagibigNo, tin`.** Anything that audits an employee goes through it.
- **A `recordLink()` of null prints text, never a link** — a link that lands on
  "Not built yet" is worse than none. `ComingSoon` matches on
  `useLocation().pathname`, most specific wins.
- **`openAttachment()` in `components/Attachments.tsx` is the one way to open a
  stored file** outside the Attachments card (bearer token → blob). The
  attachment routes check authentication only, not per-record visibility — an
  open owner decision (model §14), not something to paper over per screen.
- **The deploy scripts seed after `prisma generate`**, not straight after
  `db push`: the seed runs through the generated client, and that is the first
  point where the client matches the schema.
- **The seed's numbering loop creates with `dt.defaults ?? STOCK_NUMBERING` but
  updates only `{ label }`**, so an administrator's pattern is never
  overwritten. Industries are seeded like cost categories (`isSystem`). The
  new `trainer` role and every Phase 10 role/permission pair reach existing
  installs through the never-offered rule above.
- **`audit-workflows.ts` knows the typical requester** of `cash_advance`,
  `job_order`, `clearance`, `evaluation` and `training_certification`, and also
  reports an HR step on a document HR sometimes raises while only one person
  holds `hr` — the HR-typed version of the single-holder fault.
- **Employee routes live in `routes/employees.ts`, the employee import in
  `routes/imports/employees.ts`.** `imports.ts` exports `Registered`, so a module
  (the Academy's `courseImport`) is wired into `REGISTRY` with one line.
- **Shared web pieces from Phase 10**: `PeoplePicker` (pure UI over
  `{ id, name, sub?, group? }[]`), `MeetLink`, `SettingListCard` (the
  `/hr-settings/lists/:key` editor), `RecordHeader`'s `statusExtra`,
  `openPdf(fullPath)` and `downloadBlob(apiPath, filename)` in `lib/api.ts`. A
  package's own styles go in one file under `web/src/styles/`, imported from
  `main.tsx` after `styles.css`, tokens only.

### Numbering

- **An OWNER-scoped counter keys its rows `2026-09@007`**; the template row is
  `periodKey ''`. `{EMP}` is the last run of digits in the employee number padded
  to three, `000` for an unlinked login; `Employee.employeeNo` wins over
  `User.employeeNo`.
- **An existing database keeps its configured pattern.** The seed only creates a
  missing template; `PUT /numbering/:type` is the only thing that changes one. A
  dev database older than the house scheme still issues `GT-QT-…` until an
  administrator sets the quotation pattern once — verify scripts use throwaway
  types so they pass either way.
- **Changing period or scope starts a fresh run and keeps the old counters.**
  Rows keyed for a period the type no longer uses stop being matched; they are
  the record of what was issued, so never "clean them up".
- **Three collision rules are enforced when a pattern is saved** (zod issues on
  `pattern`): per employee needs `{EMP}`, monthly needs `{MM}` and a year,
  yearly needs a year. `nextNumber` refuses the first again at issue time; the
  other two it cannot tell from a deliberate choice, so the PUT is the only
  guard.
- **"Issued this period" is a sum** — `issuedThisPeriod()` in `routes/admin.ts`
  adds the current key and every `<current>@<emp>` row. The screen's figure must
  equal it; `verify-numbering.ts` asserts it for every type.
- **Samples on Admin › Numbering carry the viewer's own `{EMP}` digits**, and a
  template that cannot issue shows a `problem` instead of failing the screen —
  the administrator is the one who can fix it.

### Masters and partners

- **Industry is a reference row, like `CostCategory`.** The five seeded rows are
  `isSystem`: undeletable and never recoded, because reports group by the code.
  Required on every new customer and deliberately not `.nullable()` on PATCH, so
  a classified customer can never be unclassified. Reclassifying never
  regenerates the customer code — identifiers do not move under the quotations
  and invoices that print them. A lead's industry is its customer's; do not add
  `industryId` to Lead, it would be a second copy that drifts.
- **A partner IS a supplier with `isPartner`**, set and cleared only through
  `/api/partners` so "who made this a partner" is audited in one place.
  Removing a partner keeps the supplier and its resources; `DELETE
  /suppliers/:id` refuses while `isPartner` is true, because the cascade would
  drop catalogues G-CHAIN never shows.
- **Partner links are http(s) only** (`safeHttpUrl()` on the server, and the
  client only ever turns an http(s) string into an `href`). That is what keeps
  `javascript:` out of a link a salesperson clicks.
- **The price list is prices, never costs.** `partnerPriceList()` uses a strict
  `select`, never `include`, and `verify-partners.ts` asserts the response bytes
  contain neither `standardCost` nor `lastCost`. Switching to `include`
  reintroduces the leak.
- **Customer 360 and Supplier 360 are a window, never a way around.** Each
  collection loads only when the caller holds the list permission of the screen
  it comes from, and arrives as `[]` otherwise. Add a collection the same way —
  never unconditionally.
- **An import that matches on a non-unique name refuses rather than guesses** —
  the items import's Preferred Supplier matching two suppliers (a principal and
  its distributor sharing a brand) is an error, not a silent pick.

### Sales: board, calendar, costing

- **A lead with a quotation is never a board card**, and every quotation value
  is `quotationValue()` — Insights, the board, Customer 360 and job orders call
  it rather than a fourth lambda.
- **The move rules are `assertLeadStatusChange` / `assertOutcomeChange`** in
  `shared/pipeline.ts`, called from the PATCH routes; the board's drop targets
  come from `allowedTargets()` on the same rules. Do not add a board-only move
  endpoint or re-implement the rules in a page — three screens would then refuse
  different things.
- **`buildBoard()` is pure; `GET /pipeline` only fetches.** Test board arithmetic
  in `verify-sales.ts` and reconciliation in `verify-pipeline.ts`. Weighted sums
  round once at the end; summing rounded cards drifts. The CSV twin is
  `/api/pipeline/board.csv` — Express never hands the router `/api/pipeline.csv`.
- **Every calendar renders through `components/MonthCalendar.tsx`.** Callers hand
  it `CalendarEvent`s already bucketed on a local day key (`dayKeyOf`) and toned
  through `statusTone(status, extra)`. Do not draw a second grid or put a
  status-to-colour rule in a caller.
- **Calendar view and position live in the URL** (`?view=&month=&week=`,
  `?date=` as an alias), never in localStorage — a calendar that opens on the
  month you last looked at opens on the wrong month.
- **Fetch on `nav.windowKey`, never on `from`/`to`**, and `to` is the last grid
  day at 23:59:59.999 local: the API's `lte` is inclusive, and a window ending on
  midnight counts that instant in two windows. `verify-calendar.ts` proves a
  boundary activity lands in exactly one.
- **Never `new Date('YYYY-MM-DD')` in the browser** — that is 08:00 Manila. Use
  `parseDay`/`dayKeyOf` from `web/src/lib/day.ts`, which is DOM-free so the verify
  script can import it.
- **One roving tab stop per calendar grid**, and DOM focus follows only keyboard
  moves, so a toolbar click leaves the person on the button they pressed.
- **`activityWhere()` in `shared/activities.ts` is the one rule** for which sales
  activities a query means (inclusive `lte`, 14-day default). Activity writes are
  audited like every other write.
- **"Start costing" moves a lead forwards only** (from NEW, CONTACTED, QUALIFIED
  or SITE_VISIT to COSTING), and the lead lookup runs before `nextNumber` so an
  unknown lead burns no number. `PATCH { leadId }` is a correction and moves
  nothing.
- **A duplicated costing copies the numbers and not the history** — DRAFT, owned
  by the copier, no lead, revisions or jobs, totals recomputed through
  `recalc(tx)` rather than copied, so it can never carry a figure its own lines
  do not add up to.

### Delivery and procurement

- **A job's customer is its costing's customer**; `POST /jobs` refuses another.
  **A renewal is one transaction**: `renewedFromContractId` forces
  SERVICE_CONTRACT and writes the DRAFT contract with the job, so a refused
  renewal leaves no job behind. `renewalTerm()` keeps whole-month terms whole.
- **Turnover registers equipment, then moves the status** — never a TURNED_OVER
  job with nothing in the installed base.
- **`GET /jobs/lookup` excludes COMPLETED and TURNED_OVER** unless
  `?includeClosed=true`; equipment registration and supplier bills need it.
- **Cross-module cards are hidden, not empty, without their `view_all`**, and a
  card reading another module's list with `?jobId=` re-checks each row's job on
  the client, so a register that has not learned the filter shows nothing rather
  than every project's documents.
- **Overtime on a project shows the posted amount only**, never the rate, even
  though the list endpoint returns it.
- **A PO is edited only while DRAFT, by its author or `edit_all`**
  (`canEditRecord` in `poForEdit()`), and every edit audits. A direct-to-job PO
  line must name its cost category (`requireCategory()`) — without it the
  approved order commits nothing for that line. An order from an awarded canvass
  keeps its supplier; the link is derived (`awardedCanvass()`), there is no
  `canvassId`.
- **Stock value is `stockOnHand()` everywhere** — the G-CHAIN dashboard,
  `/inventory/reports/summary` and Insights. **A dashboard never prints a zero
  it could not count**: `chainOverview()` returns `null` for a figure the caller
  cannot open, and the tile prints "—".
- **Supplier bills appear on a PO or receiving only for `gfin.ap.view_all`**
  (`billsVisible`); a link to a bill the reader cannot open is a 403 waiting to
  happen.

### Aftermarket: Service Schedule and job orders

- **`regenerateSchedule` only touches GENERATED visits** (`sequence: { not:
  null }` in both the delete and the kept count). A hand-booked call-out or a job
  order's visit has no sequence and must survive; this `where` is the one place
  such a visit could be deleted silently — do not simplify it.
- **`GET /service-visits/calendar` is a range feed** (≤ 62 days, runs
  `sweepOverdue()` first) and `GET /service-visits/:id` is what every `?visit=`
  link depends on. Both sit above the other visit routes — the
  `/overtime/chargeable` route-order trap.
- **Overdue is derived, missed is swept.** Cancelling a visit requires a written
  reason. A visit takes exactly one report (a second is a 400, not a
  unique-constraint 500), and the report takes the visit's facts.
- **A returned (REJECTED) service report is edited and resubmitted**; freezing it
  left its visit unable ever to complete.
- **Job-order approval creates exactly one visit**, in the same transaction:
  `settleJobOrder` is guarded on PENDING_APPROVAL and claims the row with a
  conditional `updateMany`, so a double settle schedules nothing twice. The order
  completes in the existing `onReportSettled` — no second path.
- **Cover is `coverageFor(assetId, date)`**: CONTRACT, else WARRANTY, else
  CHARGEABLE, from facts on the requested date. **A job order posts no cost**;
  cost reaches its `jobId` through overtime, PRs, stock issues and claims.
- **The amount taken from a quotation is its SUBTOTAL** — the invoice adds VAT,
  so the total would tax the work twice.
- **`/job-orders/options` feeds the form's pickers** behind the form's own
  permission, because a salesperson holds no Installed Base permission.
- **Section photos** are attachments on `service_report` with entityId
  `<reportId>~<sectionKey>`; `GET /service-reports/:id` returns them by prefix.

### Finance: cash advances and liquidation

- **`refreshAdvance(tx, id)` is the only thing that decides an advance's figures
  and status**, re-derived from DISBURSEMENT and RECEIPT allocations and the
  approved liquidation, never incremented — so deleting a payment rolls it back
  exactly. Direction comes from `Payment.kind` (`allocationKind()`), never a
  second column.
- **An advance is released in one voucher**; `POST /payments` refuses anything
  but exactly its outstanding. The liquidation deadline is snapshotted at
  release from `finance.rules.advanceLiquidationDays`, so a settings change never
  moves a deadline already given.
- **`claimPayable(row) = max(0, total − advance.amountReleased)`** — everything
  that asks what is still owed on a claim goes through it, or the person is owed
  their advance twice. SETTLED is terminal.
- **Both settle handlers are idempotent and exported** (`settleExpense`,
  `settleAdvance`): a repeated settlement posts, notifies and audits nothing.
- **An expense claim is submitted with `requesterId: claim.claimedById`**, not
  whoever pressed the button — otherwise a super admin submitting for somebody
  could approve a claim they did not file. A refused submit reverts to DRAFT.
- **A refund is cash in, never a collection**: every "collected" aggregate
  filters `customerId: { not: null }`.
- **`financePosition(today)` in `shared/finance.ts` is the one definition of the
  working position** (receivable − payable − reimbursable − advancesToRelease).
  G-FIN's dashboard and Insights both read it; the cash forecast's totals equal
  it and both verify scripts assert that.
- **`GET /cash-advances/for-job/:jobId` is budget monitoring, not finance** —
  it requires `gops.budget_monitoring.view_all` and lives in `advances.ts` so
  `jobs.ts` imports nothing from finance. `/expense-claims/chargeable` is what
  the claim and advance forms load, not `/jobs/lookup`, which filers cannot see.
- **`Invoice.jobOrderId` is unique**, and `POST /invoices { jobOrderId }` refuses
  a warranty/contract order, an uncompleted one and a second invoice.

### HR: leave and overtime by id

- **A single leave or overtime record is readable by `view_all`, the owner, or an
  approver of that document** (`mayReadHrRecord` / `isApproverOf` in `hr.ts`).
  The approver door exists because a `view_own` supervisor must open what they
  are asked to decide. `GET /overtime/:id` had no own-scope check at all before.
- **`canCancel` / `canFileActual` mirror the POST routes' own checks** — change
  the flag with the route, or an approver is offered a button the route refuses.
- **A leave submit the engine refuses reverts to DRAFT**, never PENDING with no
  approval behind it. Every HR filing write audits.

### Hire-to-separate: plantilla, clearance, turnover

- **Filled and vacant are counted, never stored.** `plantillaSummary()` is the
  one definition; `Position` must never get a filled or vacant column.
  Over-complement is shown, not refused — refusing would block a real hire.
- **`Employee.position` is a mirror with one writer** — `positionFields()` /
  `setEmployeePosition()` and `mirrorPositionTitle()`. `verify-plantilla.ts`
  asserts the mirror for every linked employee in the database. A position anyone
  has held is deactivated, not deleted.
- **The import resolves in `build` and creates in `write`**, because `runImport`
  calls `build` on every dry run; a dry run creates no position and burns no
  number.
- **Clearance items that point at a record derive their status from it**
  (`scanAccountabilities()` / `syncClearanceItems()` on every GET and on submit).
  A derived item is waived with a reason, never cleared by hand; the leaver never
  clears their own.
- **Who may clear is one function, `areaRight()`**, used by the route and by the
  screen's `canClear` map. The requester is the leaver's own login where one
  exists, so step 1 is *their* supervisor and the self-approval rule keeps them
  off their own form; `hrSignsOwnWork()` refuses a submit when the raiser is the
  only HR holder.
- **Approval records the separation, and nothing else does.** The settle
  subscriber sets `dateSeparated` and deactivates employee and login once the day
  has passed; `sweepSeparations()` (on read) closes a login only behind a CLEARED
  clearance and otherwise asks an admin — a hand-typed date is one keystroke.
  Errors in the subscriber are logged, never thrown: the approval is the record
  of fact.
- **Turnover is arithmetic over employee dates, no table** — `turnover()` feeds
  the report, its CSV, the register strip and the dashboard, so they cannot
  disagree. An employee with no hire date counts from record creation, and the
  report says so.
- **`DELETE /employees/:id` 409s** once the employee has a clearance, evaluation,
  training record or attendance row — deactivate instead.

### Evaluations

- **Regularisation is an approved document, not a field edit** — the employee row
  changes only in the `onApprovalSettled('evaluation')` subscriber, after HR
  *and* executive. ABSORB keeps `dateHired`; END changes nothing and tells HR to
  raise a clearance.
- **Due is derived on read** (`dueEvaluations()` / `milestonesFor()`); an
  evaluation covers a milestone only if its `dueDate` is on or after it, which is
  what makes an EXTEND bring END due again. Reading `/due` notifies HR once per
  milestone, deduplicated on the link — there is no scheduler.
- **`visibleTo()` is the one rule**: the subject sees their evaluation only once
  APPROVED, and anybody else gets a **404, not a 403** — "there is an evaluation
  about you" is itself information.
- **The subject can never approve their own evaluation** — `/submit` refuses when
  any step's approvers include them, and the subscriber refuses to apply an
  approval any of whose actions they took, because roles change between
  submission and decision.
- **Ratings never reach the audit log** (a summary, null before/after —
  asserted), because admins read the audit trail and a rating is not between
  them. **Evaluations have no search provider**, deliberately.
- **Criteria are snapshotted onto `EmployeeEvaluationLine`** when the form opens;
  a key is permanent (rename freely, never reuse). The score is the weighted mean
  of RATED lines only. A RETURNED evaluation goes back to DRAFT; REJECTED closes
  it. There is no DELETE route although `ghr.evaluations.delete` exists — a
  numbered document is cancelled.

### Meetings

- **A meeting has no workflow, no PDF and no money**; it reuses `ActivityStatus`
  rather than a fourth vocabulary for the same three words.
- **G-Core holds no Google credentials.** `parseGoogleLink` is the only thing
  that decides what was pasted; `googleEventId` stays null until a Calendar
  integration is deliberately built.
- **Invitations go out on "Send invitations", never on save**
  (`MeetingInvitee.notifiedAt`). A time change bumps `icsSequence` and tells only
  those already told; cancelling bumps it too so the `.ics` withdraws the event
  under the same UID. The UID is the row id — never change it.
- **Once invitations went out a meeting cannot be deleted** (409, for `delete`
  holders too) — it is cancelled with a reason, because the record is what those
  people were told.
- **Visibility is one function, `visibleWhere(user)`**; a `view_own` holder who is
  not on the list gets a 404. Only the invitee answers for themselves.

### Academy

- **The passport is derived, never kept** — `lineState()`, `readinessFor()` and
  `teamReadiness()` are the only arithmetic, and expiry uses `expiryState()` from
  `shared/aftermarket.ts` (the warranty rule). Requirements match by id, never by
  title.
- **The record that answers for a course is the one that lasts longest**
  (`bestRecord`), so a renewal supersedes without deleting.
- **Two doors write a `TrainingRecord`**: `completeSession` (VERIFIED, number
  null, final; `@@unique([sessionId, employeeId])` makes completing twice
  impossible) and the external certificate through `training_certification`
  (`pickWorkflow` checked before `nextNumber` so a missing workflow burns no
  number). HR never records their own.
- **Changing a course's validity never rewrites an expiry on file** — the VAT
  snapshot principle.
- **The trainer is the owner** (`canEditRecord` on `trainerId`) and must hold
  `ghr.training_sessions.create`. **The calendar is company-wide; results are
  not** — someone who sees a session only through the calendar sees who is going
  and their own result.
- **Cancel, don't delete** a session anyone is enrolled on; a time or course
  change bumps the `.ics` sequence and tells attendees. Expiry notices are swept
  on read, once per record, claimed with a conditional `updateMany`.

### Insights

- **The brief reconciles to the module dashboards through their own functions**
  — `gopsOverview`, `chainOverview`, `attendanceDay`, `financePosition`. Change the
  shared function, never the brief; `verify-insights-brief.ts` asserts each figure
  against the module's endpoint. `attendanceDay()` IS the HR dashboard.
- **A figure the caller may not see is omitted, never sent as 0.** Each line
  needs that module's `*.dashboard.view_all`; the summary CSV needs
  `insights.dashboard.export` plus each module's `*.dashboard.export` — seeing a
  number is not the right to take a file of it away.
- **`parseRange().to` is 23:59:59.999Z of the last day**; midnight dropped the
  last day for timestamp-dated documents. G-OPS period figures keep
  `periodWhere`'s server-clock end of day (verify-aftermarket pins
  `/gops/overview`); three day conventions, never mixed in one line.
- **CSV columns are appended, never reordered**, so a sheet built on an export
  keeps working.
- **Industry reporting puts UNCLASSIFIED last**, and the industry table sums to
  the report's own totals — asserted.

## Accounts and sign-in

- **Employee and User stay two records** (Phase 2), but a login is made in the
  same save as its person: `POST /employees { login }`, `POST /employees/:id/login`
  for someone already on the register, or `POST /users { employeeId }` from
  Admin — all through `createLogin()` in `shared/accounts.ts`. Making a login
  needs `admin.users.create`, checked BEFORE anything is written, so HR without
  it saves the person and no half-made record is left. A login from an
  employee record copies name, department, position and mobile and starts with
  the seeded `employee` role.
- **No password is typed for a new person — they are invited.** `invitePending`
  marks the account; its password hash is of random bytes nobody sees. The
  invitation (7 days), a self-service reset (1 hour) and an admin-issued reset
  (24 hours) are `AccountToken` rows holding only the SHA-256 of the token. The
  link carries it in the URL **#fragment** (`/welcome#token=…`,
  `/reset-password#token=…`), which no server log or Referer sees; the pages
  POST it. A link is claimed by a conditional `updateMany` (used once), the
  next of its kind supersedes it, and it dies with the account's `isActive`.
  Accepting or resetting kills every other live link of that person.
- **"Forgot password?" never tells whether an address has an account**: the
  answer is identical, the email is sent after it, requests are throttled per
  address and overall, and the link goes only to the mailbox — never back to
  the caller. With email off it makes no token at all.
- **`shared/mail.ts` is the one mail sender**, SMTP over Node's own sockets (no
  dependency): TLS on 465 or STARTTLS on 587, and it refuses to send the
  mailbox password over an unencrypted connection. Header values lose CR/LF
  (no injected Bcc), bodies go base64 UTF-8. `SMTP_*` in api/.env; unset
  `SMTP_HOST` = email off, and every issued link is returned to the
  administrator who issued it to pass on (`components/LinkDelivery.tsx`).
- **A person keeps their own contact details** through `/auth/profile`:
  mobile, address, birthday and emergency contact on their linked employee —
  never the employment, pay or statutory fields.
- **A person's team is `Employee.industryId`** — an Industry row, the same
  list customers are classified by; HR sets it on the employee form (or the
  import's `Team` column, by code or name, blank keeps what is on file). An
  industry with people on its team is deactivated, not deleted. **Team,
  position and employee number are SHOWN, never edited, on the invitation and
  My Account** (`hrFacts()` in `routes/auth.ts`, `components/HrFacts.tsx`): the
  employee number is the `{EMP}` in their quotation numbers and the position
  has one writer. `personalSchema` strips them, and verify-accounts sends them
  anyway to prove it. The invitation asks only for mobile, photo and birthday;
  address and emergency contact are kept from My Account.
- **`PasswordInput` is the one password box** (Show / Hide, a real button with
  `aria-pressed`). The signed-out pages (`/welcome`, `/reset-password`,
  `/forgot-password`) are `SIGNED_OUT_PAGES` in `App.tsx`, matched before the
  signed-in check.

## SCORO migration notes

Gruntech moved from SCORO. Customers came across through the ordinary CSV
import; quotations come across as a **read-only archive**, and new work starts
in G-CORE. `tools/scoro/` holds the workstation-side converters (Python +
PyMuPDF — never installed on the server); `docs/notes/{S,C,Q,A,R}-*.md` carry
the detail.

- **`LegacyQuote` is history, not a quotation.** Nothing live points at it; the
  only link is one-way, `continuedQuotationId`, set by "Continue in G-CORE",
  which creates a real quotation with the SAME number from an OPEN SCORO status.
  Never report archive values as pipeline — Insights and the board read
  `Quotation` only.
- **Import is `importBundle()` in `shared/legacyQuotes.ts`**, from the CLI
  (`scripts/import-scoro-quotes.ts <bundle> [--commit]`) or the archive's Import
  button — one function, dry run by default. Re-import upserts on
  `(source, sourceId)` and never clears `continuedQuotationId`. A quote with
  `pdf: null` is archived without an attachment. `readBundle()` strips control
  characters from every string (`cleanText`): SCORO's PDFs leave NULs in some
  descriptions, PostgreSQL refuses a NUL in text and jsonb, and one rolled back a
  whole import on the server. The converter strips them too.
- **The quotation count runs through the YEAR and restarts each January**, as
  SCORO's did (`0012609059` is employee 001's 59th quotation of 2026); the month
  is printed, never counted. The seed's default is `{EMP}{YY}{MM}{SEQ}`, YEAR,
  OWNER — an installation seeded before that keeps MONTH until an administrator
  changes it in Admin › Numbering.
- **Counters continue SCORO's numbering, and are only ever raised.** The key
  follows the template's period: YEAR seeds `<YYYY>@<code>` from every house
  number of the current year (`parseYearNumber` — code and year must match the
  quote's date, the month part only has to be a month, because SCORO's month
  part often lagged); MONTH seeds `<YYYY-MM>@<code>` from house numbers whose
  YYMM equals the quote's own date, for the current month onward. Keyed per CODE, not per owner: salespeople issued
  numbers under colleagues' codes, and every such number must stay unissuable.
  SCORO dropped leading zeros on some (`12609060` is `0012609060`), so 8/9-digit
  numbers are padded before the date test. Numbers that fail (Camille's
  `83`+YYMM+run, Erica's frozen `2601` month) are archived as-is and seed nothing.
- **One quotation arithmetic: `shared/quotation.ts`.** `subtotal` is PRE-discount;
  net = subtotal − discountAmount; VAT on net (honouring `vatInclusive` and the
  snapshotted rate); margin is measured against net of tax, never a VAT-inclusive
  figure. `recalcQuotationRevision(revisionId, tx)` is the only writer of
  revision totals.
- **Cost never leaves unless the caller may see it** — `canSeeQuotationCost`
  (the author, `edit_all`, or `gops.costing.view_all`) strips `unitCost`,
  `costAmount`, the provider and `costNote` server-side, and the quotation PDF
  never reads cost at all.
- **The letterhead lives in the engine**: Tel/Fax, TIN, REG. NO. and the
  company's `documentTagline` print on every document when set; unset lines are
  left out — in the footer on the house style, and through the `company.*`
  fields (which `renderDesigned` reads itself) on the quotation's layout. The
  standard quotation layout prints no subject and no validity; both are fields
  an administrator can place. `PdfCell` (`string | { title, body? }`) is how a
  table cell prints a bold title over its description. Bank details are
  fields of the quotation layout, printed only where one is placed.
- **The quotation editor is a page, not a dialog** (SCORO's "Modify quote
  details"): `/g-ops/quotations/new` and `/g-ops/quotations/:id/edit`
  (`QuotationEditor.tsx`). **One save = one transaction** on create —
  `POST /quotations` takes the header AND `lines[]`, issues the number with the
  caller's `tx`, writes the lines in order and recalculates, so a refused line
  burns no number. Edit replaces a DRAFT's lines with the idempotent
  `PUT …/revisions/:revisionId/lines`. `ownerId` is honoured only for
  `edit_all` (403 otherwise). The page's live figures come from
  `web/src/lib/quotationMath.ts`, a BigInt mirror of `quotationTotals` pinned
  equal by `verify-sales.ts` — not a second rule. The editor's costing preview
  is `GET /quotations/costing-lines`, the same `quotationLinesFromSections()`
  that `from-costing` writes. **The old `?new=1&leadId=&costingId=&customerId=`
  links redirect** to `/new` with the same preset; new links point at `/new`.
  `docs/notes/quotation-editor.md` has the detail.
- **The quotation page is SCORO's "Quote details"** (`QuotationDetail` in
  `pages/sales/Quotations.tsx`): SCORO's labels in two columns, Duplicate and
  Modify top right, and SCORO's action bar (PDF, Submit for approval, Mark as
  sent) across the card's foot — in flow, because `.content` scrolls and a
  fixed bar would sit on the toasts. Its status block (Previous status, who
  moved it and when, Date confirmed, Sent, days per status) is
  `outcomeChanges()` / `outcomeStages()` in `shared/pipeline.ts`, read off the
  quotation's audit rows — there is no history table. The PATCH writes each
  move as `before/after: { outcome }`; older rows are read from the summary
  `…: FROM → TO`, so never reword that summary. **Duplicate** is the editor's
  `?duplicate=&revision=` preset: client, contact, site, name, terms and lines
  (cost only where the viewer was sent it), never the PR number, enquiry or
  costing; nothing is written and no number used until Save.
- **The editor is SCORO's "Modify quote details" too**: one card, labels
  beside their values (`.qe-rows`), the contact beside the client, quantity
  beside unit, SCORO's grey with-VAT figure under each amount (shown, never
  stored), the person/building toggles for who carries a line's cost, and Add
  row / Append quote under the lines. **Append quote** pulls another
  quotation's newest revision's lines through the ordinary list search and
  `GET /quotations/:id`, so it finds only what the viewer may read and brings
  cost only where the server sends it. **Status** on the Modify page is applied
  on Save through the same `PATCH /quotations/:id` and `assertOutcomeChange`
  as the quotation page and the board — never a second move path.
- **The Tax dropdown is `vatRate` on the revision: the company rate, 8%, 6%
  (Government) or 0%** (a zero-rated PEZA/BOI customer or an export) —
  `quotationTaxOptions()` / `QUOTATION_EXTRA_TAX_RATES` in `shared/quotation.ts`,
  sent to the page as `taxOptions` so the dropdown cannot drift from the rule —
  checked by `checkVatRate()`
  before anything is written so a refused rate burns no number; a draft may
  keep the rate it was snapshotted with. A new revision copies it. **Progress
  billing still takes the company rate** (`routes/progress.ts`), so a job won
  from a zero-rated quotation is billed VAT — an open item: billing should
  read the rate of the revision the job came from.
- **`hideTotal` ("Hide total") only changes the paper**: the PDF prints the
  lines and prices without the totals block; the stored totals are computed
  as always, and a new revision copies the flag.

## Quotation module rework (2026-10-01)

- **No dialog anywhere in the quotation module.** Modify always opens
  `/g-ops/quotations/:id/edit`: the full editor on a DRAFT, or — when no
  revision is a draft — `QuotationDetailsEditor` (number, name, contact, site,
  closing date, status) with "Raise a new revision" to change the lines. Lost
  asks its reason in the page, Delete confirms in the page, Append quote is a
  panel, "Fill from costing" and leaving unsaved confirm in the page.
- **The quote number may be typed by hand.** `number` on `POST` and `PATCH
  /quotations/:id`, checked by `checkQuoteNumber()` — shape, then case-blind
  against every quotation and every SCORO archive number (a continued
  quotation keeps its own). A duplicate is a 409 before anything is written,
  so it burns no number. Unsent, the next number comes from
  `nextFreeQuoteNumber()`, which STEPS OVER numbers taken by hand rather than
  issuing them twice; `previewNext(..., isTaken)` does the same for the
  suggestion. Counters are never raised for a typed number, so a typo far
  ahead does not move the series. `/next-number` also returns `lastNumber` and
  `taxOptions`; `/number-available` answers the page as the number is typed.
- **A line may be a subheading** (`QuotationItem.isHeading`): its title is the
  heading; `lineData()` stores it with no quantity, price, cost or provider,
  whatever was sent. `quotationTotals` (and the `quotationMath` mirror) leave
  it out of `lineCount`. A line keeps its SCORO group in a Group column of its
  own, on the editor and the quotation page; the PDF prints a group as a
  heading where it changes, unless the layout gives the table a Group column.
- **Probability is no longer asked for.** A new quotation takes its lead's
  probability, else 50; the weighted pipeline still reads the stored value.
- **Delete** is `DELETE /quotations/:id`: `gops.quotations.delete` (the sales
  role holds it) AND authorship (`canEditRecord`); refused when won, built into
  a project or a job order, or pending approval. A lead left with no
  quotation steps back to COSTING (it has a costing) or QUALIFIED, audited.
- **Optional approval routes are data.** `ApprovalWorkflow.optionLabel` marks a
  route the submitter may tick; `pickWorkflow` never picks one unasked;
  `approvalOptions(type, amount)` lists those in band; `submitForApproval({
  optionId })` uses it or refuses. Seeded: "Quotation — over ₱1,000,000, with
  the CEO" (Sales Manager → CEO approval, role executive), offered as "Add the
  CEO as approver". A refused submit puts the revision back to DRAFT.
  `approvalSlots(type, id)` lists every step of the latest request — the PDF
  prints one APPROVED BY per step, "Pending" until it acts.
  Admin › Approval Workflows edits the label ("Offer as an option"); a PUT
  that does not mention it keeps it, because clearing it by omission would
  make the CEO a step every quotation over a million takes.
- **Who decides is named before they decide** (2026-10-02). In
  `shared/approvals.ts`: `namedApprovers(step, requesterId)` — the step's
  approvers by name, NEVER the requester (act() refuses them; empty means
  nobody can, and submit refuses); `routePreview(type, amount, requesterId,
  optionId?)` — the route a draft WOULD take; `approvalSlots(…, draft?)` gives
  an open or draft step `assigned` people while `name`/`at` stay "who signed,
  when"; `historyFor()` adds `approvers` to the open steps of a PENDING
  request. The quotation page shows "Submit for approval sends it to …" under
  the action bar (`approvalRoutes` on `GET /quotations/:id`: the standard
  route and each option's, names only, the caller as requester) and switches
  to the CEO route when it is ticked; the Approval panel says "Waiting on …"
  and "Then …". The PDF names who will sign each open step with "Pending"
  under them — one person with their contact lines, several as "A or B" with
  none — and a draft's PDF prints the route submitting would take; the PDF
  button passes the ticked option as `?option=`, and one that no longer
  applies falls back to the standard route.
- **`GET /quotations/suggest?q=`** offers past lines (newest price, unit,
  description, use count) from quotations the caller may read, a line's cost
  only where `canSeeQuotationCost` allows, and items with their list price
  (standard cost only with `gops.costing.view_all` or `gchain.items.view_all`).
- **A line is ONE row, as SCORO edits it** (2026-10-02): Group | Product and
  description | Quantity and unit | Unit price | Amount (with-VAT under) |
  Cost and provider info (toggles and provider, then notes beside the unit
  cost) | Margin. Every column but the product has a fixed width, so the
  product takes what is left; narrower than the table's minimum, the table
  scrolls inside its card. Never split a line's cost onto a row of its own.
  Labels and values share one size (`--fs-md`) on both pages. The quotation
  page has no Margin card — the cost panel beside the totals says it.

## Quotation PDF template (2026-10-02)

Admin › PDF Templates (`/admin/pdf-templates`, `admin.pdf_templates.*`,
`PdfTemplates.tsx`) lays out the quotation's PDF: boxes on an A4 page, each
printing fixed text and `{{fields}}`. Only the quotation is designed; adding
another document means a field catalogue, a sample, a standard layout and a
data builder like `quotationTemplate.ts` and `quotationPrintData()`.

- **The layout is one `Setting` row, `pdfTemplate.quotation`**, read by
  `quotationDesign()`; none (or one that no longer parses — it is logged and
  the editor says so) prints `STANDARD_QUOTATION_DESIGN`. `PUT
  /api/pdf-templates/quotation` checks the shape (`designSchema`: one line
  table, one totals and one sign-off block at most, boxes on the page, colours
  `#RRGGBB`) and every field the layout names (`unknownFields()`), so a typo is
  a 400 naming it rather than a blank on a customer's quotation. Audited.
  `DELETE` puts the standard back. `POST …/preview` prints whatever the editor
  holds against the sample (one page or three) or a quotation the caller may
  print (`printableQuotation()`, audited as EXPORTED).
- **Anchors make a fixed layout work for a document of unknown length**:
  `first` (page 1; a box that grows pushes down what sits under it, the line
  table included, and never moves anything up), `every`, `later` (pages 2+),
  `after` (follows the line table, keeping its design distance under the table
  or under the box DIRECTLY above it — `covers()` — so a box with nothing to
  print closes up; one that does not fit goes over whole, text of four lines
  or more runs on), and `last` (where it was put on the last page, keeping its
  BOTTOM edge — printing more than its box holds it grows upward, never into
  the footer — or on a page of its own if the content reaches it). The table starts where it is on page
  1 and resumes at `flowTop` with its head repeated; content stops at
  `flowBottom`. A row taller than a page is split, never cut off.
- **Fields are filled by `resolveTemplate()`**: parts of a line split by
  ` | ` drop out when every field in them is empty, a line whose parts all
  went is left out, `{{field|—}}` prints the fallback, `**…**` is bold in the
  TEMPLATE only (a value's `**` prints as typed), and a value with newlines
  runs over as many lines. `web/src/lib/pdfTemplate.ts` is the editor's COPY of
  that rule for its preview, pinned equal by verify-foundation — change both.
- **Every string reaches the page through `pdfSafe`**, text is drawn run by
  run with no PDFKit wrapping (margins are 0, so PDFKit never starts a page by
  itself), and `{{pages}}` outside the page furniture renders twice to know
  the count. Graphics anchored every/later are drawn when a page is made, so
  they sit behind its content.
- **The sign-offs** (2026-10-02, the owner's call): each column is the role,
  the NAME in bold at `nameSize` (10pt), then smaller the contact number, the
  email and the date — or "Pending". No position unless the layout ticks
  `showPosition`; `showPhone` / `showEmail` drop either line. The number is
  `contactPhone()` in `shared/approvals.ts`: the login's `User.phone`, else the
  linked employee's `mobile` (kept on My Account). `approvalSlots()` returns
  each approver's phone and email; the author's are read in
  `quotationPrintData()` for the paper only — `GET /quotations/:id` never
  carries a mobile. The house style's one-line sign-offs are unchanged.
- **"Hide total" hides the money everywhere**: `quotationPrintData()` blanks
  the money fields as well as passing no totals, so a layout that prints
  `{{quotation.total}}` in a box of its own still obeys it. Cost is never in
  the data, so no layout can print it.
- **The editor**: drag to move, handles to size, snapping to margins and other
  boxes (Alt places freely); a focused box moves with the arrows (Shift 10pt)
  and sizes with Ctrl+arrows; Ctrl+Z/Y undo and redo — through a reducer that
  applies each change to the layout as it stands, so key repeats faster than
  a render are not lost. Moving or sizing the line table moves the `after`
  boxes with it. The page is drawn white (`--paper`) in either theme; the
  colours on it are the layout's own.
- **The company's fields on the editor are the REAL Company Settings**, not
  samples, so an empty one leaves its line out there exactly as on the PDF —
  which reads as a broken template unless it is said. `emptyFieldsIn()` (in
  `web/src/lib/pdfTemplate.ts`; a field with a `|fallback` and the page count
  never count) drives the page's "Empty in Company Settings: …" note, named as
  Company Settings names them (`COMPANY_SETTING_NAMES`) and linked there, and
  the selected box's "Not printing now: …". Hidden, the note stays hidden only
  until a different set of fields is empty (a per-browser convenience).

## Costing sheet notes

The costing is patterned on gasiontech G-CORE's costing (and its "Material
Cost Estimate" PDF) in G-CORE's own style.

- **The sheet is a page, never a dialog**: `/g-ops/costing/new` and
  `/g-ops/costing/:id/edit` (`CostingSheet.tsx`). **One save = one
  transaction**: `POST /costings` and `PUT /costings/:id/sheet` take the header,
  `lines[]` and `sections[]` (with `tasks[]`) and write them through
  `writeSheet()`; every reference is checked before `nextNumber`, so a refused
  sheet burns no number. Rows sent with their `id` are updated in place, rows
  left out are deleted — never delete-and-recreate. The old
  `?new=1&leadId=&customerId=` list links redirect to `/new`. The per-line and
  per-section routes stay for scripts and the renewal path.
- **One arithmetic: `shared/costingMath.ts`**, exact in BigInt: line amount =
  qty (3 dp) × cost (2 dp) rounded half away from zero; markup and contingency
  are % of the budgeted cost; contract value = cost + markup + contingency −
  discount, never below 0, **net of VAT** (the SOV and billing are unchanged);
  VAT and grand total are shown, not stored. `web/src/lib/costingMath.ts` is a
  COPY for the page's live figures, pinned equal on 400 random sheets by
  verify-costing. `recalc()` is the only writer of `totalCost`/`contractValue`.
- **A line has `name` (bold) and `description`**; a line typed as a name alone
  carries it as its description too, because every older reader prints
  `description`. **`isHeading` is a subheading**: amount 0, no code.
  **Codes are derived, never stored**: `lineCodes()` numbers cost lines 101,
  102… per bucket by the bucket's rank (Materials 1 … Indirect 5).
- **The plan is working days, not dates** (`planTasks()`): a task with a
  `startDay` keeps it; one without starts the day after the previous task ends.
  On save a phase with tasks takes their span as `durationDays` and the costing
  the plan's total — the job schedule reads those. "Sequence tasks" only writes
  the computed starts down. `spread: true` on a save runs `spreadSections()`
  (the same rule as `/sections/distribute`) so the SOV equals the contract value.
- **VAT is the company rate or 0%** (`checkVatRate`, as on the quotation),
  snapshotted at creation; a draft keeps its rate after Settings change.
- **Approval is the seeded `costing` workflow (executive)**. With it active the
  author cannot PATCH to FINAL; `POST /:id/submit` claims DRAFT →
  PENDING_APPROVAL with a conditional update, submits in the AUTHOR's name, and
  reverts to DRAFT if the engine refuses. `settleCosting()` moves APPROVED →
  FINAL, REJECTED → DRAFT. A PENDING costing refuses edits, deletion and
  `POST /jobs`. To run without costing approval, DEACTIVATE the workflow — a
  deleted seeded workflow is recreated by the next seed; the page then offers
  "Mark final" again. Reopen (FINAL → DRAFT) stays the author's, and needs a
  fresh approval.
- **The PDF is "Material Cost Estimate"** (house style): details, one table with
  numbered bucket headings, name-over-description cells, subtotals, the summary
  as `totals`, Terms & Conditions — **never the internal notes** — then the
  Scope of Work as the engine's **`gantt` section** on landscape pages. The
  sign-offs come from `approvalSignoffs('costing', …)` once FINAL: every step
  but the last prints as CHECKED BY, the last as APPROVED BY; a costing marked
  final without a workflow prints "Pending" for the approver, which is true.
- **Predictions never widen visibility**: `GET /costings/suggest?q=` offers past
  lines (newest price, use count) only from costings the caller may read, plus
  the item master; `/suggest/lists` feeds the datalists (units, System / Unit,
  phase and task names, your own last terms, the company VAT rate). Both sit
  above `/:id`.
- **A template is `CostingTemplate.body` JSON**, categories by CODE, with
  nothing pointing at it and no link back from a costing made from it. Saved
  from a costing (`costingId`) or the unsaved sheet (`sheet`); `withPrices:
  false` zeroes every unit cost. Author or `edit_all` renames/deletes; anyone
  who reads costings uses it. No new permission keys — `gops.costing.*` covers it.

