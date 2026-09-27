# Package SVC — Service Schedule (item 8) and Job Orders (item 9)

For the orchestrator to merge into `docs/BUSINESS-OPERATIONS-MODEL.md` §10
(Aftermarket) and CLAUDE.md "Phase 8 notes worth carrying forward".

`verify-aftermarket.ts` went from **85 to 166 assertions** (all green with the
API running). Update the total in CLAUDE.md's Verification paragraph.

## Notes worth carrying forward (CLAUDE.md, Phase 8)

- **The Service Schedule is the old PM Schedule, relabelled and widened.** One
  path (`/g-ops/visits`), one permission (`gops.visits`), every visit kind. A
  month grid by default (the shared `MonthCalendar`, never a second grid), a
  list beside it at `?mode=list`, and `?visit=<id>` opens the visit sheet from
  anywhere. `?month=` is the calendar hook's; the list's filters (`status`,
  `kind`, `due`) and the bar's (`assignedToId`, `contractId`, `customerId`,
  `assetId`, `scope=mine`) are plain URL keys both views read. No drag to
  reschedule: moving a contractual date happens in the sheet, which asks.
- **`GET /service-visits/calendar` is a range feed, not a list.** `from`/`to`
  required, at most 62 days (400 otherwise), `take: 1000`. It runs
  `sweepOverdue()` first — a calendar that shows a three-week-late visit as
  "scheduled" lies. Response `{ from, to, asOf, visits (with daysUntilDue,
  overdue), reports (no-visit reports in the window), engineers, missedAfterDays }`.
  It is the contract the sales calendar consumes when item 5's owner wires the
  service series; `includeReports=false` for that use.
- **Overdue is derived, missed is swept.** A SCHEDULED visit past its date reads
  "overdue" (computed on read, never stored) until `missedAfterDays`, when the
  sweep makes it MISSED. The legend and the page blurb say so.
- **`GET /service-visits/:id` is what every `?visit=` link depends on**
  (notifications, contract, asset, report, My Work, Ctrl+K). `/calendar` and
  `/:id` are registered before the other visit routes — the `/overtime/chargeable`
  route-order trap.
- **Visit notifications link to the record**: `/g-ops/visits?visit=<id>`.
- **A visit PATCH is audited**, and cancelling one requires a written `reason`
  (appended to the visit's notes, audited as CANCELLED). A cancelled visit can be
  put back on the schedule from the sheet; a MISSED one can be given a new date
  (it goes back to SCHEDULED).
- **"Own" on the schedule**: someone who sees visits only through
  `gops.pm_reports.view_own` sees the visits booked on them — list, feed and
  `/:id` alike. `gops.visits.view_all` (the menu entry's own permission) is now
  accepted on those routes too; holding it and being refused the data behind the
  screen was a mismatch.
- **`regenerateSchedule` only touches GENERATED visits** — `sequence: { not: null }`
  in both the delete and the kept count. A visit with no sequence under a
  contract is a hand-booked call-out or a job order's visit and survives
  regeneration. This `where` clause is the one place such a visit could be
  deleted silently; do not simplify it. (It used to delete hand-made call-outs.)
- **A report written from a visit takes the visit's facts.** `POST
  /service-reports { visitId }` fills customer, site, machine, contract, kind and
  the job that carries the cost (the contract's job, or the job order's). It
  refuses a body naming a different customer (400), a cancelled visit (400), and
  a second report on the same visit ("This visit already has report …" — was a
  unique-constraint 500). Covered contract work is therefore not billable by
  default; a job order's visit is billable exactly when the order's basis is
  CHARGEABLE.
- **A returned (REJECTED) service report is corrected and sent again.** PATCH and
  submit accept DRAFT or REJECTED. It used to be frozen, and because a visit takes
  exactly one report, its visit could never complete.
- **Section photos** on a service report are attachments with entityType
  `service_report` and entityId `<report id>~<section key>`; the rest use the
  report id. `GET /service-reports/:id` returns `photos` by id prefix, so a future
  PDF finds all of them and can group by section.
- **A job order is the authorisation document**: raised (usually by sales),
  accepted by the service manager, and only then dispatched. Approval creates
  exactly ONE `ServiceVisit` (`sequence: null`, `jobOrderId`, numbered with
  `nextNumber('service_visit', tx)` in the same transaction as the status change).
  `settleJobOrder` is exported, guarded on `status === PENDING_APPROVAL` and
  claims the row with a conditional `updateMany`, so a settle that arrives twice
  schedules nothing twice.
- **A job order completes on its visit's approved report**, in the existing
  `onReportSettled` (no second path), with `completedAt = report.performedAt`.
  Only an APPROVED order moves; a returned report leaves the order open.
- **Cover is decided from facts on the requested date** by
  `coverageFor(assetId, date)` in `shared/aftermarket.ts`: an ACTIVE contract that
  lists the machine and whose term includes the date → CONTRACT (cost to the
  contract's job); else a warranty running to or past the date → WARRANTY (cost to
  the installing project); else CHARGEABLE. `chargeBasis` is the decision and may
  be overridden; `underWarranty` is the fact and is kept either way. Choosing
  CONTRACT with no covering contract is refused.
- **A job order posts no cost.** Labour, parts and out-of-pocket reach its
  `jobId` through overtime, PRs, stock issues and expense claims that quote it.
  Warranty work therefore lands on a TURNED_OVER project's budget — that is the
  truth, and project managers should be told.
- **The agreed amount taken from a quotation is its SUBTOTAL** (latest APPROVED
  revision, else latest), because the invoice adds VAT itself — the revision
  total would tax the work twice.
- **A chargeable job order is billed once, through the ONE invoice path**
  (`POST /invoices { jobOrderId, … }`, FIN's validation). The "Raise invoice"
  button shows only when COMPLETED, CHARGEABLE, not yet invoiced, and the viewer
  holds `gfin.ar.create`. Job Orders' `?unbilled=true` filter is finance's queue.
- **The job-order form's pickers come from `GET /job-orders/options`**, behind
  the form's own permission: a salesperson holds no Installed Base permission, so
  the machine list cannot come from `/installed-assets`. Names and numbers only.
  `/options` and `/coverage` sit above `/:id`.
- **Cancelling**: DRAFT, REJECTED or APPROVED, with a reason; an APPROVED order's
  SCHEDULED visit is cancelled with it and the engineer is told. PENDING is
  refused ("ask the approver to return it" — the engine has no requester
  withdrawal, and one does not belong in a module). COMPLETED is refused.
- **Ctrl+K** now finds installed assets, service contracts (own = the job's PM),
  service reports (one provider per report permission, one `service_report`
  group), visits (`gops.visits.view_all`) and job orders (own = raised by or
  assigned to me). **My Work's day** gets a schedule provider: SCHEDULED visits
  booked on me whose due date falls in the window. A due date is a DATE column
  (UTC midnight); the provider asks for a padded range and applies the
  timestamp window in code, because comparing a DATE to a timestamp truncates
  the window's edges.

## Model §10 — Aftermarket (text to merge)

- Service Schedule (`/g-ops/visits`): month / list, visit sheet, call-outs,
  report hand-off. Data: `ServiceVisit`; feed `GET /service-visits/calendar`.
- Job Orders (`/g-ops/job-orders`): `JobOrder` (DRAFT → PENDING_APPROVAL →
  APPROVED → COMPLETED; REJECTED; CANCELLED), numbered `job_order` (JO),
  workflow `job_order` (service manager). One order → one visit → one report →
  at most one invoice. PDF "Job Order" with Requested / Approved / customer
  acknowledgement sign-offs.

## Decisions taken here (tell the owner)

- `/job-orders/options` was added (not in the plan) because the plan's pickers
  (`/installed-assets`, `/customers`) are closed to the salespeople who raise job
  orders.
- The visit sheet's engineer picker and the call-out form use
  `/users/lookup?holding=gops.pm_reports.create` (the orchestrator's people-picker
  contract), not `/users`. The schedule's engineer FILTER lists only people
  already booked on a visit (from the feed), so it hands no directory to viewers.
- The calendar leaves the no-visit report series out when a visit status filter
  or "unassigned" is set: those filters ask about visits.
- Clicking a day that has visits opens the list for that day
  (`?mode=list&from=d&to=d`) — the "day view" the component does not have.
- Templates' "Visits overdue" tile now opens `/g-ops/visits?mode=list&due=true`
  (the list, not the month); the Aftermarket dashboard, contract progress and
  Renewals tiles moved onto `Stat`. The contract cover form's equipment rows were
  mouse-only (a read-only checkbox in a clickable row) and are now real
  checkboxes in labels.
- Service contract **Renew** (EXPIRING/EXPIRED, no successor, `gops.costing.create`)
  duplicates the contract's costing and opens it with `?renewFrom=<contract>`;
  the costing page (P3) takes it from there.

## Not done here (other owners)

- Customer 360 "Job orders" collection and "Request job order" button
  (`customers.ts`, `Customer360.tsx`), and the Quotations WON-block "Request job
  order" link — files owned by the sales/audit packages. Links they should use:
  `/g-ops/job-orders?new=1&customerId=<id>` and
  `/g-ops/job-orders?new=1&customerId=<id>&siteId=<id>&quotationId=<id>`; the
  Job Orders screen opens the form prefilled from those keys.
- Sales calendar service series (item 5's owner) against the feed above.
- Service report PDF (listed "later" in the audit plan).
