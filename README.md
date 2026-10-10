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
| Designed PDF layouts for the quotation and the sales order — boxes on a page, exported as a file | `/admin/pdf-templates` |
| Document numbering, 40 document types — yearly, monthly or per-employee counters; quotations use the house scheme `0012609001` | `/admin/numbering` |
| Approval engine, one for every document type | `/admin/workflows` |
| Pipeline stages — SCORO's statuses as data: name, odds, colour | `/admin/pipeline-stages` |
| Audit log | `/admin/audit` |
| Notification centre with deep links | bell in the top bar |
| Global search / command palette | Ctrl+K |
| Shared list pattern | `web/src/components/DataList.tsx` |
| PDF document engine | `api/src/shared/pdf.ts`, specimen at `/admin/company` |
| Attachments | `api/src/shared/attachments.ts` |
| My Work | `/my-work` (`/` is the module home) |

**Phase 2 — Master data.** Enter once, reuse everywhere.

| Capability | Where |
|---|---|
| Customers, multiple contacts, multiple sites, an optional sub-industry and a team (KAT, HIT, UIT, GIB, SIT) | `/g-ops/customers` |
| **Customer 360** — one workspace per customer | `/g-ops/customers/:id` |
| Suppliers and their contacts; **Supplier 360** | `/g-chain/suppliers` |
| Employees, with pay behind its own permission | `/g-hr/employees` |
| Item master, typed and costed | `/g-chain/items` |
| Cost categories (the six buckets, Contingency the sixth), item categories, teams, sub-industries, quotation groups, activity types and drawing types | `/admin/categories` |
| Warehouses and locations | `/g-chain/warehouses` |
| **CSV import** for every master — customers, suppliers, partners, employees, items, courses | ⋯ menu on each list |

**Phase 3 — Sales.** Lead → costing → quotation → approved.

| Capability | Where |
|---|---|
| Leads, assignable, with status and weighted value | `/g-ops/leads` |
| **Costing** — six cost buckets, margin, contract amount; assigned from a lead, or duplicated; approved by the technical manager, the team leader and the CEO | `/g-ops/costing` |
| **Schedule of values** — scope of work that billing is measured against | Costing → Scope of work |
| Quotations with preserved revisions | `/g-ops/quotations` |
| Quotation approval through the shared engine | Submit for approval |
| Quotation and costing PDFs | Print on either screen |
| **Sales orders** — a quotation's work booked in operations, with progress booking and a four-signature route | `/g-ops/sales-orders` |
| Sales calendar — a day, a week or the month, with the view and position in the URL; an activity has a page of its own | `/g-ops/calendar` |
| **Pipeline board** over leads and quotations — move by drag or keyboard, SCORO's six stages, CSV | `/g-ops/pipeline` |
| **Forecast** — every open quotation by its expected closing, by week, month, quarter or year | `/g-ops/forecast` |
| **Partners** — principals' catalogues, price lists, software and links to their other sites | `/g-ops/partners` |
| **SCORO archive** — the read-only history of quotations raised in SCORO; "Continue in G-CORE" | `/g-ops/quote-archive` (off the menu, reached by link) |

**Phase 4 — Delivery.** Job → budget → progress → billing.

| Capability | Where |
|---|---|
| Projects created from a costing | `/g-ops/projects` |
| **Project workspace** — one page, ten tabs, linked down to every PR, PO, invoice, advance and service record | `/g-ops/projects/:id` |
| Meetings held for the project, its documents and its activity | Project → Meetings & Records |
| **Four-state cost ledger** — budgeted / committed / incurred / consumed | Project → Budget Monitoring |
| Budget requests — project cash: approved by the project manager then finance, released in one voucher, liquidated through an expense claim | Project → Budget Requests, `/g-ops/budget-requests/:id` |
| Schedule of values, snapshotted from the costing; the scope of work as a Gantt chart, planned from the costing | Project → Scope of Work |
| Progress reports, chained, with period percentages | `/g-ops/progress` |
| **S-curve** — planned vs actual vs billed | Project → Overview |
| Progress billing with VAT and EWT | Project → Progress & Billing |
| Approved plans register | Project → Approved Plans |
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

**Phase 6 — G-HR.** Clock in, leave, overtime — and what overtime costs a project.

| Capability | Where |
|---|---|
| **Clock in / out with face recognition**, PIN or biometric fallback | `/g-hr/clock` |
| Attendance dashboard — present / late / on leave / absent | `/g-hr` |
| Attendance register, with manual correction | `/g-hr/attendance` |
| **CSV extract over a date range** | Dashboard → Extract CSV |
| Leave types, allotments and balances | `/g-hr/leave` |
| Leave filing with half days, approved by your supervisor | `/g-hr/leave` |
| **Overtime prior approval** — authorisation before the work | `/g-hr/overtime` |
| **Overtime actual filing** — real hours, variance explained | `/g-hr/overtime/:id` |
| Overtime by project, leave balances across the team | `/g-hr/reports` |
| Working day, breaks, premium, match threshold | `/g-hr/settings` |

**Phase 7 — G-FIN.** Billing → invoice → collection, and what is still owed.

| Capability | Where |
|---|---|
| **Invoice raised from an approved billing** — nothing retyped | `/g-fin/ar` |
| A/R measured against **net collectible**, not the invoice total | `/g-fin/ar/:id` |
| BIR 2307 certificates against withheld EWT | Invoice → Record BIR 2307 |
| Supplier bills, matched to a receiving or standing alone | `/g-fin/ap` |
| **Withholding on the payable side** — 1% goods, 2% services | New bill |
| Expense claims with receipt numbers, reimbursed on approval | `/g-fin/expenses` |
| Payments — a page per voucher, allocated across several documents | `/g-fin/payments` |
| **A/R and A/P aging** in configurable buckets | `/g-fin/reports` |
| Cash flow — cleared movement plus what is due to move | `/g-fin/cash-flow` |
| Budget vs actual across every project | `/g-fin/budget-vs-actual` |
| Executive dashboard | `/g-fin` |

**Phase 8 — Aftermarket.** A finished project becomes a renewal pipeline.

| Capability | Where |
|---|---|
| **Installed base** — what was put in, where, and its warranty | `/g-ops/installed-base` |
| Register everything a turned-over project installed, in one go | Project › Service tab → Turnover |
| Service contracts — cover, frequency, what is covered | `/g-ops/service-contracts` |
| **PM schedule written from the contract** | Contract → Activate and schedule |
| **Service Schedule** — every visit on one calendar, month or list | `/g-ops/visits` |
| **Job orders** — the project work order: links, targets, scope and personnel; approval by the project manager then the team leader builds the project | `/g-ops/job-orders` |
| **Report templates as data**, versioned | `/g-ops/report-templates` |
| Commissioning, PM and inspection reports | `/g-ops/commissioning`, `/g-ops/pm`, `/g-ops/inspections` |
| **Renewals** — contracts ending and warranties lapsing | `/g-ops/renewals` |
| Service costing | `/g-ops/service-costing` |

**Phase 9 — Insights.** Management reporting across every division.

| Capability | Where |
|---|---|
| **Company overview** — the company at a glance, one line per division, then the whole business on one screen | `/insights` |
| Twelve-month trend: won, billed, collected, cost | Overview |
| **Project profitability** with a watchlist | `/insights/profitability` |
| **Sales analytics** — funnel, win rates, weighted pipeline | `/insights/pipeline` |
| **Cash forecast** including work earned but not invoiced | `/insights/cash-forecast` |
| **Inventory analytics** — slow movers by value, reorder | `/insights/inventory` |
| Performance and the approval bottleneck | `/insights/performance` |
| A CSV twin of every report | Export on each screen |

Insights adds **no tables**. Every figure is read off documents the other
phases record, which is the only way a management report can never disagree
with the records behind it.

**Phase 10 — Depth.** Following a person from hire to separation, money handed
out before it is spent, and service work outside a contract.

| Capability | Where |
|---|---|
| **Plantilla** — authorised positions, filled and vacant counted live | `/g-hr/plantilla` |
| **Evaluations** — probation and trainee milestones; regularisation by approval | `/g-hr/evaluations` |
| **Turnover & clearance** — clearance by area, separation, turnover rate | `/g-hr/clearances` |
| **Meetings** — invitees, pasted Meet link, `.ics`, month view | `/g-hr/meetings` |
| **Academy** — courses, training calendar and sessions, training passports and readiness | `/g-hr/academy/…` |
| **Cash advances** — request, release, liquidate, refund | `/g-fin/cash-advances` |
| Budget requests, finance's window — release, refund, the liquidation | `/g-fin/budget-requests` |
| **CAD J.O.** — the design team's queue: revisions as rows with a PDF on each, the thread, progress and priority | `/g-ops/cad-job-orders` |
| **Accounts** — a login made with its person; invitations and password resets by email, or as a link to pass on | `/admin/users`, `/welcome`, `/reset-password` |
| **My Work** filled from every module — awaiting me, assigned, today, drafts, renewals | `/my-work` |
| Leave, overtime and users open by link | `/g-hr/leave/:id`, `/g-hr/overtime/:id`, `/admin/users/:id` |
| Every list's search, scope, page and filters in the URL | any list screen |

The business rules behind these are in the model doc (§4.1, §4.5, §4.6, §4.7)
and in CLAUDE.md's "Phase 10 notes".

### The costing → billing backbone

This is the part worth understanding before using it.

A costing holds two things that must agree. **Cost lines** in the six buckets
(Contingency is the sixth) give the total cost; the margin turns that into the
**contract amount** — cost ÷ (1 − margin), net of VAT.
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

Needs Node 20+ (the app is developed on 24) and Docker Desktop.

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

First sign-in on a fresh database: `admin@gruntech.com` / `ChangeMe!2026` —
**change it immediately** under Account. Override the defaults with
`SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` before running the seed if you
prefer. The seed creates that account only when it does not exist, so on a
database whose admin password has been changed, re-seeding does not reset it
(see "Locked out" below).

### Verifying

The shared services — the approval engine, numbering, permission resolution,
the PDF engine — have no click-path that proves them, so a script per area
drives them the way a module does. Each script's header says what it holds to;
the counts below are as of 2026-10-09.

```bash
cd api && npx tsx scripts/verify-foundation.ts
```

235 assertions: role inheritance and per-person overrides, record ownership,
menu derivation and the section strips' order, numbering under concurrency,
approval routing and notification, segregation of duties, the overtime two-step
rule, amount bands, the audit trail, the PDF engine's pagination, margins and
money, and the DOM-free rules the web mirrors (list URL state, number boxes,
the template resolver).

```bash
cd api && npx tsx scripts/verify-masters.ts
```

76 assertions for Phase 2: CSV parsing (quoted commas, embedded newlines,
doubled quotes, Excel's BOM), the import contract (dry run writes nothing, one
bad row blocks the file, re-import updates rather than duplicates), the
permission gate on employee pay, master numbering under concurrency, and that
global search never returns a record kind the user cannot open.

```bash
cd api && npx tsx scripts/verify-sales.ts
```

425 assertions for Phase 3, concentrated on the money: how the contract amount
is reached, that margin is profit over contract and not over cost, that the
schedule of values reconciles to the centavo on an awkward figure, VAT computed
both inclusive and exclusive, record ownership, that an author cannot approve
their own quotation, that a superseded revision keeps its own totals, the
pipeline board's and the forecast's arithmetic, that the list's summary cards
add up to the list, that the web's quotation arithmetic mirrors the server's,
that three of a sales order's four signatures book nothing, and the wording of
the designed quotation and sales order layouts.

```bash
cd api && npx tsx scripts/verify-delivery.ts
```

103 assertions for Phase 4: that the schedule of values is snapshotted and does
not move when the costing is later edited, the four-state budget arithmetic
(including that consumed is not subtracted twice), that a budget request is
project cash routed to the project's manager then finance and never a budget
change, that earned value is weighted by scope value rather than averaged, that
EWT is withheld on the gross and not the VAT, that a second billing covers only
the increment, and that the S-curve's three lines share a time basis.

```bash
cd api && npx tsx scripts/verify-chain.ts
```

135 assertions for Phase 5, mostly about not counting money twice: the moving
average (a receipt moves it, an issue does not), that a warehouse cannot issue
or lend what it does not have, that issuing an order releases the request's
commitment, that receiving releases the order's, that a direct-to-job receipt is
charged to the job and NOT added to stock, and that consumed is never subtracted
on top of incurred.

```bash
cd api && npx tsx scripts/verify-hr.ts
```

198 assertions for Phase 6. The arithmetic first — lateness against the grace
period, the dinner break deducted only from overtime that actually spans it,
weekends excluded from leave, half days read off the times. Then the two rules
this phase exists for: that a leave balance is drawn down on approval and never
on filing, and that overtime cost reaches a project **only** once the supervisor
and HR have both approved the actual hours, at the actual hours rather than the
estimate.

The face pipeline is tested on real photographs, not on numbers the script made
up: a picture with no face is refused, one with several faces is refused, the
same face through a smaller and lossier capture still matches, and two different
people land well the far side of the threshold. This one needs the API running,
because the route guards — clocking in twice, filing actual hours before
authorisation, an unexplained variance — are checked over HTTP.

```bash
cd api && npx tsx scripts/verify-finance.ts
```

244 assertions for Phase 7, almost all of them about three things. That **EWT is
withheld on the gross and not on the VAT**, and that an invoice paid to its net
collectible reads as paid rather than as short by the withheld amount. That a
**supplier bill matched to a receiving posts no job cost** — the receiving
already incurred it — while a bill with nothing received behind it does. And
that a **payment cannot be over-applied**, in either direction, to a document
that no longer owes that much.

```bash
cd api && npx tsx scripts/verify-aftermarket.ts
```

224 assertions for Phase 8. Mostly dates, because that is what this phase is:
that a quarterly contract signed in January is first visited in April rather
than on day one, that a visit falling past the end date is dropped rather than
squeezed in, and that three months after 31 January is 30 April. Then the two
rules that protect a record of what happened — **regenerating a schedule never
erases a visit that was made**, and **a template that has been used is
immutable**, so a report from two years ago still renders the way it was signed.
And the job order: approval builds its project from the quotation's costing,
once, and a settlement that arrives twice builds nothing twice.

```bash
cd api && npx tsx scripts/verify-insights.ts
```

97 assertions for Phase 9. Since it adds no records, they are about the thing a
reporting layer gets wrong instead: **reconciliation**. Profitability read
through the report equals the ledger read directly, to the centavo, on awkward
figures. The company overview and the sales report show the same pipeline
total. A job that has spent 1% of its budget is flagged as too early to judge
rather than reporting a 99% margin. Slow-moving stock ranks by value, not age.
And the whole module refuses to write anything at all.

Phase 10 and the work since added fourteen more, one per area, each named for
what it covers:

| Script | Assertions | What it holds to |
|---|---|---|
| `verify-costing` | 139 | assigning a costing moves a lead forwards only; a duplicate copies numbers, not history; the margin arithmetic; the three-signature route |
| `verify-pipeline` | 86 | the board reconciles to Sales Analytics to the centavo; the move rules over HTTP; a stage sets the odds |
| `verify-calendar` | 96 | calendar windows never count a boundary instant twice; the time grid; repeats; birthdays and the greetings |
| `verify-numbering` | 46 | per-employee counters, the collision rules, "issued this period" |
| `verify-partners` | 117 | a partner is a supplier; the price list never carries a cost; the "what they supply" filter |
| `verify-plantilla` | 99 | filled/vacant derived; clearance items derive from records; separation on approval |
| `verify-meetings` | 85 | invitations on send, not save; `.ics` sequence; visibility |
| `verify-evaluations` | 130 | regularisation only after every approval; the subject never approves or peeks |
| `verify-academy` | 97 | the passport is derived; two doors write a training record |
| `verify-cad` | 86 | the design team's queue: who may do what, revisions as rows with a PDF on each, the thread |
| `verify-archive` | 113 | the SCORO import, the numbering continuation and "Continue in G-CORE" |
| `verify-insights-brief` | 50 | every brief figure equals the module dashboard's own |
| `verify-workspace` | 39 | My Work fills from every module; every row links to a record |
| `verify-accounts` | 86 | a login made with its person; invitations and resets; the SMTP sender, against a fake mail server |

**3,006 assertions across twenty-three scripts.** Run them all:

```bash
cd api && for s in foundation masters sales costing pipeline calendar numbering partners delivery chain hr plantilla meetings evaluations academy finance aftermarket cad archive insights insights-brief workspace accounts; do npx tsx scripts/verify-$s.ts; done
```

Only `verify-foundation`, `verify-masters` and `verify-sales` run without the
API (and the SMTP half of `verify-accounts`, which talks to a fake mail server
it starts itself); the other twenty check route guards over HTTP against
`http://localhost:5100` and fail loudly if the API is not running. All
twenty-three create their own records and clean up after themselves,
notifications included. Run them after touching anything in `api/src/shared/`
or `api/src/permissions/`.

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

### Deploying

Everything for the production server is in **[`deploy/`](deploy/README.md)** —
read that first, because the target machine also runs `gasion-vision`, live
hospital oxygen-plant monitoring, and it has been taken down three times by
careless restarts.

```bash
powershell -ExecutionPolicy Bypass -File C:\G-CORE-GRUNTECH\deploy\preflight.ps1
```

Read-only. It reports what is already using the ports, container names and task
names this deployment wants, and whether the neighbouring system is healthy. Run
it before installing, and any time a rebuild behaves oddly.

Each script works out where it is from its own location, so that path is only
the *server* one. On the development machine, point it at the repository you
actually have - it prints which installation it is checking, and dry-running it
there is a reasonable thing to do.

| | |
|---|---|
| `preflight.ps1` | Changes nothing. Says what would collide. |
| `install.ps1` | First time only. Refuses to run if the preflight fails. |
| `autodeploy.ps1 -Register` | Once, on the server: makes the `GCoreGruntechDeploy` task, which every five minutes fetches `origin/master` and rebuilds when it moved — **a push to master is a deploy**. |
| `rebuild.ps1` / `rebuild.sh` | What that task runs, and the by-hand deploy: builds the new code **before** stopping the running site, so a commit that does not build changes nothing; restarts **only** our own scheduled tasks. |
| `tasks.ps1 -Ensure api\|tunnel\|deploy` | Lifts Windows' 3-day stop and "stop on battery" from G-Core's own three tasks and nothing else; the installer and both rebuilds call it. |
| `backup.ps1` | Nightly database dump and uploads archive, 30-day retention. |
| `docker-compose.prod.yml` | Our own Postgres — port 5435, own volume. **Not** the repo root compose file, which would collide with `gasion_db` on 5433. |
| `cloudflared-config.yml` | Our own tunnel. **Never** `cloudflared service install` on that host. |

G-Core Gruntech owns exactly this and nothing else: `C:\G-CORE-GRUNTECH`, port
5100, its scheduled tasks (`GCoreGruntechApi`, `GCoreGruntechTunnel`,
`GCoreGruntechDeploy`, and `GCoreGruntechBackup` once `backup.ps1` is
registered — step 7 of `deploy/README.md`), the `gcore-gruntech-db` container
on 5435, the `gcore-gruntech` tunnel, and its backups under
`C:\backups\gcore-gruntech`.

### Locked out

"Forgot password?" on the sign-in page emails a one-hour reset link once a
mailbox is set (`SMTP_*` in `api/.env`; the answer never says whether the
address has an account). With email off it makes no token at all: an
administrator issues a reset link from Admin › Users and passes it on. For the
administrator's own account, or with nobody else in, shell access is the way:

```bash
cd api && npx tsx scripts/reset-password.ts admin@gruntech.com
```

Generates a password and prints it once. Pass one as a second argument to
choose it yourself. Run it with no arguments to list the accounts on the
database. Every reset is written to the audit log.

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
  scripts/                  verify-*.ts, audit-workflows, reset-password, the SCORO import
  src/permissions/          the registry — source of truth for access AND the menu
  src/shared/               approvals, numbering, audit, notifications,
                            attachments, search, pdf  ← reused by every module
  src/routes/
web/
  src/components/DataList.tsx   the one list pattern every screen uses
  src/components/Shell.tsx      top bar, sidebar, notifications, Ctrl+K
  src/lib/                      DOM-free rules the verify scripts import
  src/pages/
deploy/                     the production server's scripts (its own README)
tools/scoro/                workstation-side SCORO converters, never on the server
docs/                       the model, the gap analysis, notes/ (an index of what remains)
```

### The two files to understand first

**`api/src/permissions/registry.ts`** declares every module, screen and action in
G-Core. It generates the `Permission` rows *and* the navigation menu, so a screen
cannot appear without the access to open it, or vanish while the access still
exists. Adding a screen in a later phase means adding an entry here.

**`api/src/shared/approvals.ts`** routes every document type — leave, overtime,
purchase requests and orders, costings, quotations, sales orders, budget
requests, supplier bills, expenses, cash advances, job orders, service reports,
clearances, evaluations, training certifications. A module calls
`submitForApproval(...)` and subscribes with `onApprovalSettled(...)`. It never
implements routing, notification or history itself.

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
