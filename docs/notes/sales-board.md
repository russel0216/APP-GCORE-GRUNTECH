# P3 — sales board: notes worth carrying forward

Package: item 7 (pipeline kanban), the sales halves of items 5 and 6, item 4's
lead quick-add, and the sales-side audit fixes (#9, #10, #12 of area-audits §7,
plus the SVC "Request job order" WON-block edit).

## For the model doc (§4.1 pipeline paragraph)

- **The board is a view over Lead + Quotation, never a third record.** Columns
  ARE the LeadStatus / QuotationOutcome enums: New, Contacted, Qualified, Site
  visit, Costing (lead stages) · Quotation drafted (OPEN), Submitted,
  Negotiation (quotation stages) · Won, Lost · On hold (leads only) · plus a
  computed, read-only "This month forecast" column.
- **A lead with any quotation is never a card** — its quotation is. The lead's
  own status from QUOTATION_CREATED onward is written back from the
  quotation's outcome, so showing both counted the same deal twice (the old
  board did, in Negotiation).
- **One value rule:** a quotation is worth its APPROVED revision's total, else
  its highest-numbered revision's total, else 0 — `quotationValue()` in
  `api/src/shared/pipeline.ts`. The board's open quotes / quoted value /
  weighted value reconcile to Sales Analytics' `totals` to the centavo
  (asserted in `verify-pipeline.ts`). Weighted sums are rounded ONCE at the
  end, the way Insights sums them; summing per-card rounded figures drifts.
- **Lead estimates are never added to quoted value.** `kpis.leadEstimate`
  stays separate from `kpis.quotedValue`.
- **Won and Lost are bounded** to the last `decidedWithinDays` (default 90,
  clamped 30–730), by `decidedAt` for quotations and `updatedAt` for lost
  leads. Column totals are smaller than the old board's; the old ones were
  inflated, not these wrong.
- **Forecast** = open cards (not On hold, not Won/Lost) whose expected closing
  falls in the current MANILA month (`manilaMonthKey`), weighted by
  probability. `Quotation.expectedClosing` is copied from the lead when the
  quotation is raised from one and is editable on the quotation (Modify).
  The forecast tile says how many of its cards have no probability yet.
- **Move rules (one set, on the routes):** `assertLeadStatusChange` and
  `assertOutcomeChange` run inside `PATCH /leads/:id` and
  `PATCH /quotations/:id`; the board reads its drop targets from
  `allowedTargets()` built on the same rules, so the board, the lead page and
  the quotation page refuse the same things with the same words:
  - WON needs an APPROVED revision.
  - LOST needs a reason (the UI asks through `LostReasonModal`).
  - A lead cannot be quoted, negotiated or won by hand when it has no
    quotation — "a lead is won by its quotation".
  - A quotation cannot be dropped on a lead stage or On hold.
  - A WON quotation that a job references cannot leave WON.
- **No board-only write path and no new permission.** A move is a PATCH on the
  record, governed by `gops.leads.edit_*` / `gops.quotations.edit_*` through
  `canEditRecord`; the board's `canMove` is computed server-side with the same
  call. A manager moving someone else's card notifies the owner.
- The salesperson's probability is never rewritten by a drop.

## For CLAUDE.md (Phase 3 notes)

- The one value rule lives in `api/src/shared/pipeline.ts` (`quotationValue`).
  Anything that values a quotation — Insights, the board, Customer 360, job
  orders — calls it rather than writing a fourth lambda.
- A lead with a quotation is never a board card.
- The move rules are `assertLeadStatusChange` / `assertOutcomeChange` in
  `shared/pipeline.ts`, called from the PATCH routes. Do not add a board-only
  move endpoint; do not re-implement the rules in a page.
- `buildBoard()` is pure; `GET /pipeline` only fetches. Test board arithmetic
  in `verify-sales.ts` (no server) and reconciliation in `verify-pipeline.ts`
  (HTTP).

## Decisions and deviations

- **CSV twin is `GET /api/pipeline/board.csv`, not `/api/pipeline.csv`.** The
  router is mounted at `/api/pipeline` and Express hands it only paths that
  continue with a slash, so `/api/pipeline.csv` could never reach it without an
  `index.ts` change (orchestrator-only). Guarded by `gops.pipeline.export`,
  audited (`entityType 'pipeline'`, `entityId 'sales-pipeline-board'`,
  `EXPORTED`) BEFORE the bytes go out; takes the same query as the board.
- **Views**: named views are `SavedFilter` rows with `listKey 'pipeline'`
  (shareable; PATCH to update in place). The unsaved working view is
  per-browser in localStorage `gcore_pipeline_view`, sanitised on read (unknown
  keys dropped). A browser with no working view opens on the person's own view
  named "Default" if there is one.
- **Hiding a column is collapsing it** — a collapsed column is a narrow strip
  that is still a drop target, so nothing a drop could land on is ever hidden.
- **Keyboard / touch**: HTML5 drag-and-drop does not fire on most touch
  browsers. Enter/Space on a focused card opens the Move menu (`role=menu`,
  arrows cycle, Escape returns focus to the card); Shift+←/→ steps a card to
  the nearest legal column (never LOST — that needs the reason). Moves and
  refusals are announced in an `aria-live` region.
- **Board search is server-side** (`?search=`), debounced, so the KPI row, the
  columns and the CSV all describe the same set of cards.
- **Quotation outcome buttons** show legal moves only: OPEN → Submitted /
  Negotiation / Lost; SUBMITTED → Negotiation / Won / Lost; NEGOTIATION →
  Won / Lost; WON (no project) and LOST → Reopen (to Negotiation). Won is
  disabled with a reason until a revision is approved. Reopening from LOST
  keeps the old lost reason on the record as history.
- **Pulling a quotation back to OPEN** writes its lead back to
  QUOTATION_CREATED (previously the lead was left where it was).
- **Number preview**: `GET /quotations/next-number` (`gops.quotations.create`,
  declared above `/:id`) returns `{ number, employeeNo, linked,
  usesEmployeeDigits }` from `previewNext('quotation', { ownerId })`. The form
  warns about the `000` digits only when the configured pattern contains
  `{EMP}` and the account is unlinked. `POST /quotations` numbers with
  `nextNumber('quotation', tx, { ownerId: me.id })`.
- **`POST /quotations` customerId is optional** when a `leadId` is given: the
  lead's customer and (for that customer) its site are used; a lead with no
  customer on file is refused with "Link the lead to a customer first — open
  the lead, Modify, and pick or add the company".
- **Activities**: `GET /activities` spreads `activityWhere()` from
  `shared/activities.ts`; `GET /activities/:id` exists; the assignee
  notification links to `/g-ops/calendar?activity=<id>&date=<Manila day>`
  (the `date` lets the calendar load the right window first) and its body is
  Manila-pinned `formatDateTime`. Activity create / update / delete are now
  audited (`entityType 'sales_activity'`). `ActivityLog` takes a time of day
  (the old `T12:00:00` put every planned visit at noon) and is shown on the
  quotation page too.
- **People picker** on the lead form reads `/users/lookup` (everyone) and
  `/users/lookup?holding=gops.leads.edit_own` (who sells) instead of the
  admin-gated `/users?pageSize=200`.
- **Lead quick-add customer** asks for the industry beside the "add as a new
  customer" button (`/reference/industries?active=true`, `{code} — {name}`),
  posts `{ name, industryId }`, and says plainly when no industries are set up.
- **`Avatar`** caches one object-URL promise per attachment id for the page's
  life, so sixty cards owned by one person fetch the photo once.

## Hand-offs other packages read (URL contracts)

- Lead page → `/g-ops/costing?new=1&leadId=<id>&customerId=<id>` (P6/costing
  reads it) and `/g-ops/quotations?new=1&leadId=<id>&costingId=<latest>`.
- Quotations list reads `?new=1` with any of `leadId`, `costingId`,
  `customerId` (Customer 360 and CostingDetail link here) and opens the one
  create form prefilled: customer, site, attention (lead contact by name, else
  the customer's primary), subject (enquiry's first line or costing title),
  expected close, costing.
- WON block → `/g-ops/projects?new=1&costingId=<approved rev's costing>&quotationRevisionId=<approved rev>`
  (DEL's Projects.tsx reads it) and, with `gops.job_orders.create`,
  `/g-ops/job-orders?new=1&customerId=&siteId=&quotationId=` (SVC's
  JobOrders.tsx reads it). A quotation already delivered shows "Delivered as
  <job link>" instead, from `revisions[].jobs` on `GET /quotations/:id`.
- Pipeline column heads link to `/g-ops/leads?status=<KEY>` and
  `/g-ops/quotations?outcome=<OUTCOME>`; both keys are declared DataList
  filters, so P2's URL seeding makes them filter.

## Verification

- `api/scripts/verify-sales.ts` — item 7 cases 1-10 (pure, from
  `shared/pipeline`), `salesActivity.deleteMany` first in `cleanup()`,
  fixtures numbered with `{ ownerId }`. 64 assertions.
- `api/scripts/verify-pipeline.ts` (new, API running) — board ↔ Sales
  Analytics reconciliation to the centavo, one card per deal, approved-revision
  valuation, window clamp, CSV 200 + audit row, 403s, the move rules over HTTP
  (WON without approval, LOST without reason, lead WON without quotation),
  lead follows LOST with its reason, reopen, owner notified of a manager's
  move, lead → quotation prefill and refusal, lead costings, revision jobs,
  expected closing PATCH, next-number = previewNext (+ the sales default on a
  throwaway type: `007YYMM001`), activity by id, Manila-day deep link, activity
  audit. 44 assertions.
