# PROJECT_CONTEXT.md

Working context for G-CORE: what it is, how it is built, the conventions that
govern it, and exactly where it stands today.

Companion document: **`AI_APPLICATION_CONTEXT.md`** describes the *application*
in depth — every module, the navigation tree, the data model, business
workflows, roles and cross-module relationships. This file covers the
*project*: stack, design system, conventions, current state and what is in
flight. Read that one to understand the business; read this one to work on it.

State at the time of writing: `HEAD` = `ff764f8`, with an uncommitted UI branch
in the working tree (§7).

---

## 1. What this is

**G-CORE** — the integrated business operations platform for **Gruntechnology
Corp**, a Philippine contractor that designs, installs and maintains industrial
gas systems, principally oxygen generation plants for hospitals.

It replaced four separate applications that each kept their own database and
their own copy of "customer". The purpose of the rebuild is **one codebase, one
database, one schema**: a customer, a job and a peso of cost exist once.

Deployed at `gruntech.gcore.tech`. Single tenant, internal only — roughly
12–40 employees across sales, delivery, procurement, warehouse, service, finance
and HR. No customer portal, no public surface.

**Six modules:** G-OPS (operations — sales, delivery, aftermarket), G-HR,
G-FIN, G-CHAIN (supply chain), Insights (reporting), Admin.

---

## 2. Stack

| Layer | Choice |
|---|---|
| Frontend | React 18 · React Router 6 · TypeScript · Vite 6 |
| Backend | Node 24 · Express · TypeScript |
| ORM / DB | Prisma 6.19.3 (pinned) · PostgreSQL 17 |
| Auth | JWT bearer tokens · bcryptjs |
| UI library | **none** |
| CSS | one hand-written stylesheet with custom properties |
| State | none — `useState`/`useEffect` + two contexts |
| API | REST/JSON under `/api` |

**The entire frontend dependency list is `react`, `react-dom`,
`react-router-dom`.** No Tailwind, no MUI, no Redux, no React Query, no charting
library, no icon package. This is a standing constraint, not an accident.

Notable API dependencies: `pdfkit` (document engine), `multer`+`sharp`
(attachments), `zod` (validation), `@vladmandic/face-api`+`@tensorflow/tfjs`
(server-side face matching for the time clock).

**Size:** ~21,900 lines API · ~31,200 lines web · 2,889-line Prisma schema
(83 models, 43 enums) · 2,934-line stylesheet.

---

## 3. Repository layout

```
/
├── api/
│   ├── prisma/schema.prisma       the whole data model
│   ├── prisma/seed.ts             14 roles, permissions, approval workflows
│   ├── scripts/verify-*.ts        9 scripts, 495 assertions
│   ├── scripts/audit-workflows.ts read-only check for unroutable approvals
│   ├── scripts/sandbox.ts         12 demo users + a worked example job
│   └── src/
│       ├── permissions/registry.ts  SOURCE OF THE MENU AND THE PERMISSIONS
│       ├── permissions/resolve.ts   resolveUser, can, canEditRecord, menuFor
│       ├── shared/                  14 cross-cutting services
│       ├── routes/                  18 route files
│       ├── auth/ · http/            JWT middleware, list/query helpers
│       └── index.ts                 mounts every route group
├── web/src/
│   ├── components/    8 shared components (§5)
│   ├── lib/api.ts     fetch wrapper, ApiError, ListResult, SHIPPED_PHASE
│   ├── lib/auth.tsx   AuthProvider → { me, can, canView, signOut }
│   ├── pages/         ~45 page files in 8 folders
│   ├── App.tsx        every route, each behind Guard/GuardAny
│   └── styles.css     the entire design system
├── docs/              BUSINESS-OPERATIONS-MODEL.md (the spec), GAP-ANALYSIS,
│                      UI-IMPROVEMENT-PLAN
├── deploy/            PowerShell/bash deployment scripts
├── CLAUDE.md          15 standing rules — read first
└── AI_APPLICATION_CONTEXT.md
```

**Folder names do not match module names.** `sales/` holds leads, costings and
quotations; `delivery/` holds projects and progress billing; `chain/` holds
procurement and warehouse; `service/` holds aftermarket; `masters/` holds
customers, suppliers, employees and items.

---

## 4. The design system

Everything lives in `web/src/styles.css`. There is no CSS framework and no
build-time style tooling beyond Vite.

### Identity
Dark, deliberately. Black background, **neon green `#39ff9d`** and **magenta
`#c026d3`** as the two accents, **Orbitron** for display type and **Inter** for
anything data-dense.

**Neon is the affordance colour** — hover, focus, "you can act on this".
**Magenta is the state colour** — the active nav item, the focused input, the
primary button, the step a document is currently sitting on. Keeping those
apart is what stops a row of hovered cards reading as a row of selected ones.

### Tokens
```
Spacing   --s-1 … --s-8         4 8 12 16 20 24 32 40
Type      --fs-xs … --fs-2xl    11 12 13 14 16 20 24
Colour    --neon --magenta --text --muted --faint
          --ok --warn --danger --info
          --bg --surface --surface-2 --surface-3 --line --line-soft
Shadow    --shadow-sm/md/lg
Focus     --focus-ring          neon, offset
Radius    --radius-sm/--radius/--radius-lg
Fonts     --display (Orbitron) --body (Inter) --mono (JetBrains Mono)
```

Text contrast is **measured, not eyeballed**: `--text` 16.0:1, `--muted` 7.2:1,
`--faint` 4.6:1 against the card surface. **`--faint` is the dimmest readable
colour in the system** — nothing goes below it.

### Class vocabulary
`.card` · `.card-title` · `.page-head` · `.grid`/`.grid-2/3/4` · `.row` ·
`.stack` · `.data` (tables) · `.table-wrap` · `.badge` + tones · `.alert` +
tones · `.btn` + variants · `.field` · `.checkbox` · `.mono` · `.muted` ·
`.faint` · `.scope-switch` · `.kv` · `.sidebar` · `.nav-item` · `.topbar` ·
`.sub-nav` · `.modal` · `.drawer` · `.toast` · `.empty` · `.breadcrumb` ·
`.section-label` · `.kpi-grid`/`.kpi-card` · `.stepper`/`.step-item` ·
`.record-head`

### Responsive
Breakpoints at **860px** (sidebar → horizontal section strip), **720px** (list
tools wrap), **640px** (page header and stepper stack), **520px** (top bar
sheds the module badge and Sign out). Plus `@media (pointer: coarse)` for 44px
touch targets and `prefers-reduced-motion`.

Verified at 1440 / 1280 / 1024 / 768 / 375px with **no horizontal overflow**.

### Accessibility baseline
Global `:focus-visible` ring · skip-to-content link · `aria-current` on the
active nav item · `aria-sort` on sortable headers · `aria-live` on toasts ·
labels wired to controls via `useId` · keyboard-operable rows, headers and
cards · every chart series carries its own number so nothing depends on colour
alone.

---

## 5. Shared components

Read these before writing a screen. Between them they determine what most of
the app looks like.

| Component | Role |
|---|---|
| `Shell.tsx` | Application frame: top bar, two-level menu, sidebar, notification drawer, Ctrl+K trigger |
| `DataList.tsx` | **Every list screen.** ~30 uses. One column definition buys search, filters, scope switch, column prefs, CSV export, server sorting, pagination, empty states |
| `ui.tsx` | `ToastProvider`, `ErrorBox`, `Loading`, `Empty`, `Modal` (focus trap), `Field`, `Checkbox`, `StatusBadge`/`statusTone`/`humanise`, formatters |
| `charts.tsx` | `Stat` (the KPI card), `BarList`, `Funnel`, `Donut`, `Meter`, `MiniBar`, `Panel` — hand-rolled SVG/CSS |
| `ApprovalStepper.tsx` | `ApprovalStepper` (presentational) + `DocumentApproval` (reads the chain from the API) |
| `RecordHeader.tsx` | The header on a single-record page: kind • code, status, title, amount, actions |
| `CommandPalette.tsx` | Ctrl+K global search |
| `ImportModal.tsx` | Shared CSV import flow |

On the API side, `renderDocument(...)` in `shared/pdf.ts` is the equivalent
single point — every printable document goes through it.

---

## 6. Conventions

From `CLAUDE.md`. All 15 are load-bearing; these are the ones most easily
broken by UI work.

1. **The permission registry drives the menu.** `permissions/registry.ts`
   generates both the `Permission` rows and the navigation. Never hard-code a
   menu item; never check a permission string the registry does not define.
2. **One approval engine.** Never invent a second approval path.
3. **A requester can never approve their own document.**
4. **Numbers come from `nextNumber(type, tx)`.**
5. **Every printable document goes through `renderDocument(...)`.**
6. **Record ownership via `canEditRecord(...)`.**
7. **Every list screen uses `DataList`; every chart uses `charts.tsx`.**
8. **Money is `Decimal`** in Prisma, `Number()` only at the API boundary.
9. **Spacing, type and colour come from tokens.** No raw pixel values in inline
   styles.
10. **One status pill** — `StatusBadge`, with an `extra` map for module-specific
    statuses.
11. **Everything interactive is keyboard-reachable.** A `<div onClick>` that
    opens a record is a bug.
12. **A menu entry must open what its label says** — the path must have a route
    and the screen must show what the label promises.

### Code style actually in use
- Plain `export function Component()`. **Zero `React.FC` and zero
  `import React`** across 54 component files — the automatic JSX runtime is on.
- Classes over inline styles. Inline styles only for genuinely dynamic values.
- `var(--token)` in inline styles when one is unavoidable, never raw px.
- Comments explain *why*, not *what*.

---

## 7. Current state

`HEAD` is `ff764f8`. All nine build phases are complete: 495 assertions pass
across nine `verify-*.ts` scripts, both halves type-check and build.

### Uncommitted UI work in the tree

Five rounds of design work, verified but not yet committed:

```
M  web/src/styles.css                       tokens, KPI cards, stepper, record head
M  web/src/components/charts.tsx            Stat becomes the one KPI card
M  web/src/pages/hr/Dashboard.tsx           KPI cards
M  web/src/pages/finance/Reports.tsx        KPI cards
M  web/src/pages/chain/Warehouse.tsx        KPI cards
M  web/src/pages/insights/Overview.tsx      Tile now points at the shared card
M  web/src/pages/chain/PurchaseRequests.tsx RecordHeader + DocumentApproval
?? web/src/components/ApprovalStepper.tsx   new
?? web/src/components/RecordHeader.tsx      new
?? AI_APPLICATION_CONTEXT.md                new
```

What it does:

- **One KPI card** (`.kpi-card`) replaces three implementations across five
  dashboards. 28 rendered cards, all `<a>` links — **32 Insights tiles were
  previously `<div onClick>` and unreachable by keyboard.**
- **Approval stepper** renders `GET /approvals/history/:type/:id`, an endpoint
  served since Phase 1 that nothing in the web app had ever called.
- **Record header** standardises single-record pages: kind • code, status
  beside the number, amount, actions grouped.
- **G-OPS dashboard** charted — a sales funnel with drop-off per stage, a
  project donut, contract bars.

### Known issues, not fixed

- **`status` query params are cast straight into Prisma enum filters without
  validation — 18 sites across 7 route files.** A typo in a URL returns **500**
  rather than 400 or an ignored filter.
- **`.nav-item.active` suppresses its own focus ring.** Specificity (0,2,0) on
  the inset magenta bar beats the global `:focus-visible` (0,1,0), so the item
  a keyboard user is most likely to land on shows no ring.
- **The record header is not sticky**, though it was meant to be. `.content`
  carries `overflow-x: auto`, which makes it the containing block for a sticky
  descendant, so a `top` offset resolves against the content box and pins the
  bar below its own resting position. Fixing it means dropping that safety net
  app-wide.
- **Orbitron renders a slashed zero.** Legible at 60px, ambiguous at the KPI
  card's 20px — and `0` is the most common value on a quiet dashboard. A
  one-line change to `var(--body)` reverses it.
- Single ~730 kB JS chunk, no code splitting. No automated front-end tests.
- `/admin/templates` is the only menu entry with no screen.

---

## 8. Running it

```bash
docker compose up -d      # Postgres on host port 5433, NOT 5432
cd api && npm run dev     # API on 5100
cd web && npm run dev     # web on 5173
```

Seeded admin: `admin@gruntech.com`. `api/scripts/sandbox.ts` creates twelve demo
users (password `Sandbox!2026`) and a worked example job.

### Verification

```bash
cd api && for s in foundation masters sales delivery chain hr finance aftermarket insights; do npx tsx scripts/verify-$s.ts; done
```

495 assertions. `verify-hr`, `verify-finance`, `verify-aftermarket` and
`verify-insights` need the API running — they check route guards over HTTP and
say so loudly rather than skipping if it is down.

```bash
npx tsx scripts/audit-workflows.ts   # approvals routed to a role nobody holds
```

Run the suite after touching anything in `api/src/shared/` or
`api/src/permissions/`. Add cases when you add a shared service.

---

## 9. Deployment — the hard constraint

The production server is **shared with `gasion-vision`, a live hospital
oxygen-plant monitoring system.** Careless restarts have taken it down three
times.

- **Never** kill Node by image name (`taskkill /F /IM node.exe`,
  `Get-Process node | Stop-Process`). A window-title filter does not make it
  safe — background processes have no window title, so the filter matches
  nothing and any `||` fallback runs the unfiltered kill.
- **Never** stop or reconfigure the `Cloudflared` Windows service.
- **Never** run `pm2 kill` / `pm2 delete all` / `pm2 startup`.
- Restart only by PID, by port, or via the `GCoreGruntechApi` scheduled task.

G-Core owns `C:\G-CORE-GRUNTECH`, port **5100**, the `GCoreGruntechApi` task,
the `gcore-gruntech-db` container on **5434**, and the `gcore-gruntech` tunnel.
Nothing else on that machine. Full detail in `deploy/README.md`.

---

## 10. Do not change

1. **The launcher page.** `web/src/pages/Home.tsx`, the `.home-*`/`.module-*`
   styles and `web/public/modules/*.gif` were explicitly retained by the owner.
2. **Single tenant.** No tenant scoping.
3. **No new dependencies.**
4. **The dark neon identity.**
5. **`Available = Budgeted − Committed − Incurred`** — CONSUMED is reported but
   never subtracted, or the same peso is charged twice.
6. **EWT is withheld on the gross, not the VAT.** A/R measures against net
   collectible; invoiced ≠ collectible.
7. **`JobScopeItem` is a snapshot**, not a reference.
8. **The two purchase kinds stay disjoint** — direct-to-job never builds stock.
9. **A leave balance is spent on approval, not on filing.**
10. **Face descriptors are computed server-side**; a photo with more than one
    face is refused.
11. **Tax rates are snapshotted** onto documents.
12. **Insights owns no table** and its router refuses non-GET.

---

## 11. Open questions for the owner

Business decisions, not technical ones:

1. **Retention and downpayment recoupment** — deferred, with nullable columns
   reserved on `Job` and `ProgressBilling`. This is the one that gets more
   expensive the longer real billing data accumulates.
2. **Whether Gruntech withholds tax from its own suppliers.**
3. Assigning the seeded roles to real people on the server — run
   `audit-workflows.ts`; approvals route to roles, and an unheld role means
   documents stall.
4. Whether a quotation's **CONFORME** slot should keep a signature rule. Every
   other sign-off is recorded in the system; that one is the customer's, signed
   by hand.
