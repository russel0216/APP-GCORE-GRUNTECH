# Costing handoffs and duplication — notes worth carrying forward

Package P6 (audit fixes 9, 10 and 25, the costing halves). Files:
`api/src/routes/costing.ts`, `api/scripts/verify-costing.ts`,
`web/src/pages/sales/Costings.tsx`, `web/src/pages/sales/CostingDetail.tsx`.

## Invariants

- **"Start costing" moves a lead forwards only.** `POST /costings` with a
  `leadId` sets `Costing.leadId` and, in the same transaction, moves the lead to
  COSTING — but only from NEW, CONTACTED, QUALIFIED or SITE_VISIT
  (`LEAD_STAGES_BEFORE_COSTING`). A lead in NEGOTIATION that gets re-costed
  stays in NEGOTIATION. An unknown lead is a 404 and, because the lookup runs
  before `nextNumber`, no costing number is burned. Covered by a test.
- **The costing takes the lead's customer and site unless the body names its
  own.** Body values win; a body `customerId` that differs from the lead's drops
  the lead's site rather than pairing a site with the wrong customer.
- **`PATCH { leadId }` is a correction, not a handoff.** Re-linking never moves
  the lead. Only creation does. The web form sends `leadId` on create only.
- **A duplicate copies the numbers and not the history.** `POST
  /costings/:id/duplicate` (`gops.costing.create`, own-scope read check) copies
  the header, cost lines, scope sections and their tasks; the copy is DRAFT
  even when the source is FINAL, owned by whoever copied it, numbered by
  `nextNumber('costing', tx)`, and carries **no** `leadId`, quotation revisions
  or jobs. Totals are recomputed from the copied lines through `recalc(tx)`
  rather than copied, so the copy can never carry a figure its own lines do
  not add up to. An optional body `{ title }` renames the copy.
- **Renewal copies last year's prices deliberately.** The Contracts screen
  duplicates the old contract's costing and lands on
  `/g-ops/costing/:id?renewFrom=<contractId>`; the page's banner says the
  prices are last year's and the "Create service contract" button only
  appears once the costing is FINAL. The button goes to
  `/g-ops/projects?new=1&costingId=&type=SERVICE_CONTRACT&renewFrom=` — a
  service contract is a job of that type (model §4.5), so the renewal path is
  the project path with the type and the old contract on it.
- **A project is built on a FINAL costing.** "Create project" on the detail
  page is shown only when `status === 'FINAL'` and the caller holds
  `gops.projects.create`; a draft says "mark this one final first". `jobs.ts`
  enforces the same server-side.

## Contracts other packages rely on

- `GET /costings/:id` now returns `lead {id, number, companyName, status} |
  null` and `jobs [{id, number, name, status, type}]` (newest first).
- `GET /costings/lookup?status=FINAL|DRAFT|DRAFT,FINAL&q=` — rows are
  `{ id, number, title, status, contractValue: number, customer: {id, name} |
  null }`, take 50, own-scope honoured. An unrecognised status value is
  ignored, not refused. `Projects.tsx`'s picker should pass `status=FINAL`.
- `POST /costings/:id/duplicate` → 201 with the full presented costing plus
  `canEdit: true` and `duplicatedFrom: { id, number }`.
- `Costings.tsx` reads `?new=1&leadId=` and opens the form prefilled: title
  from the first line of the lead's description (else "<company> —
  requirement"), customer and site from the lead. Both params are removed from
  the URL when the form closes so back/refresh do not reopen it. Only fields
  still empty are prefilled. `Costing` has no contact column, so no contact is
  carried — the lead's contact stays on the lead.
- `COSTING_TONES` is exported from `Costings.tsx` for `StatusBadge` (DRAFT
  warn, FINAL ok) — use it rather than a local badge.
- `CostingDetail` "Where this goes next" lists quotations and jobs as Links,
  offers `Create quotation` → `/g-ops/quotations?new=1&costingId=` when the
  caller holds `gops.quotations.create`, and `Create project` as above. The
  customer name links to `/g-ops/customers/:id` when the caller holds
  `gops.customers.view_all`, else prints as text (a Link that 403s is worse
  than none).

## Verification

`cd api && npx tsx scripts/verify-costing.ts` — 40 assertions, needs the API
running. Own throwaway roles (`zzcost_*`), users (`@verifycosting.local`) and
`ZZCOST`-tagged records; cleans up at start and end.
