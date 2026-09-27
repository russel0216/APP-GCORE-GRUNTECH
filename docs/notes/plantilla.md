# Package A — plantilla, turnover & clearance (item 3)

What a maintainer must know before touching `shared/plantilla.ts`,
`shared/clearance.ts`, `routes/positions.ts`, `routes/clearances.ts`, the
employee routes or the employee import. `verify-plantilla.ts` (91 cases, API
running) covers every rule below.

## Plantilla notes worth carrying forward

- **Filled and vacant are counted, never stored.** `filledByPosition()` groups
  ACTIVE employees by `positionId` on every read. `Position` has no filled or
  vacant column and must never get one. `plantillaSummary()` is the one
  definition; the Plantilla screen, `GET /positions/summary` and the HR
  dashboard tile all read it.
- **Over-complement is shown, not refused.** Authorised can be set below the
  number of holders; the row reads "1 over" in danger tone. Refusing would block
  a real hire while HR catches up the plantilla.
- **`Employee.position` is a mirror with one writer.** For a linked employee it
  equals `positionRef.title`, written only through `positionFields()` /
  `setEmployeePosition()` (create, patch, import) and `mirrorPositionTitle()`
  (a position rename, inside the PATCH's transaction). A free-text title on a
  linked employee is ignored by the API; free text survives only on an
  unclassified employee (`positionId` null). The verify script asserts the
  mirror holds for EVERY linked employee in the database, not just its own.
- **A position anyone has held is deactivated, not deleted** — `DELETE` 409s
  while any employee (active or not) references it. An inactive position cannot
  be given to anyone new (400), but an employee already on one can still be
  saved: the web form only sends `positionId` when it changed.
- **The import resolves in `build` and creates in `write`.** `runImport` calls
  `build` on every dry run, so `build` only looks the title up
  (case-insensitively). An unknown title is created in `write`, inside that
  row's `$transaction`, with `nextNumber('position', tx)` and
  `authorisedHeadcount: 0` — it shows as over-complement until HR sets the
  count. A second row naming the same new title in the same file reuses it.
  A dry run creates no position and burns no POS number (tested).
- `backfillPositions()` is exported from `shared/plantilla.ts` with the same
  behaviour as the seed's inline copy, so the seed can import it and keep one
  definition.

## Clearance notes worth carrying forward

- **Items that point at a record derive their status from it.**
  `scanAccountabilities()` returns only what is still OPEN against the leaver:
  borrow slips (by `borrowerId`, or by name for a login-less employee — says
  "searched by name"), unpaid expense claims, unliquidated cash advances,
  pending leave and overtime, projects they manage, and aggregate lines for
  open tasks, leads, quotations, service visits, planned sales activities,
  scheduled training sessions they train, approvals waiting on them, and
  people who report to them. `syncClearanceItems()` (on every GET and on
  submit) adds new references, marks a reference that dropped out CLEARED by
  nobody (at the slip's `returnedAt` where known), and reopens a CLEARED one
  that came back. Manual and WAIVED items are never touched by the sync.
- **A derived item cannot be cleared by hand** — only waived, and a waiver
  needs a written reason (min 5 characters). A waived accountability without a
  reason is the weak door.
- **Who may clear is ONE function, `areaRight()`**, used by the route's refusal
  and by the `canClear` map the screen renders. SUPERVISOR is the approval
  engine's own `approversForStep({approverType:'SUPERVISOR'}, leaver's userId ??
  raiser)`; WAREHOUSE `gchain.borrow_slips.edit_all`; FINANCE
  `gfin.expenses.edit_all` or `gfin.ap.edit_all`; HR and every area
  `ghr.clearances.edit_all`; ADMIN `admin.users.edit_all`. The leaver can never
  clear their own items, whatever they hold.
- **The requester is the leaver's own login** whenever one exists, so step 1
  resolves to THEIR supervisor and the engine's self-approval rule keeps them
  off their own form. A login-less employee falls back to the raiser, so step
  1 goes to the raiser's supervisor (the Person card says so).
- **Submit writes its own `SUBMITTED` audit naming the real actor**, because
  the engine's row names the requester (the leaver).
- **Submit refuses when the raiser is the only HR holder** and the workflow has
  an HR step (`hrSignsOwnWork()`): the engine only stops the requester from
  self-approving, not the person who raised on their behalf. The HR raiser MAY
  sign the HR step while a second HR holder exists — tested.
- **Approval records the separation, and nothing else does.** The settle
  subscriber (in `routes/clearances.ts`) sets `dateSeparated = lastWorkingDay`
  (if empty) and, when that day has passed, deactivates the employee AND the
  login. A future last day is left for `sweepSeparations()`. A rejection leaves
  the items as they are for HR to fix and resubmit. Errors are logged, never
  thrown — the approval is the record of fact.
- **The sweep closes a login only behind an approved clearance.**
  `sweepSeparations()` (called at the top of `GET /employees`, `/positions`,
  `/positions/summary`, `/clearances`, `/clearances/summary`) deactivates any
  employee past `dateSeparated`; it closes the linked `User` only when a
  CLEARED clearance stands behind it. A hand-typed `dateSeparated` is one
  person's keystroke, so the sweep instead notifies `admin.users.edit_all`
  holders to close the login. Audited as `SEPARATED`, actor `system`, pay
  fields stripped by `redact()`. Its optional `scope` argument exists so the
  verify script never sweeps real people with a future date.
- **Cancel closes the PENDING ApprovalRequest** the same way leave cancel does.
- All clearance notifications go to the raiser (and, on raise, the leaver and
  their supervisor; on clearing, HR).
- `pendingFor()` walks the whole PENDING queue per call and the sync runs it on
  every open of a clearance — fine at Gruntech's volume; give approvals.ts a
  count-only path if the queue grows into the hundreds (comment in the code).

## Turnover notes worth carrying forward

- **Turnover is arithmetic over employee dates — no table.** Headcount at d =
  employees with `coalesce(dateHired, createdAt) ≤ d` and not separated by d.
  Per month: opening (day before the 1st), hires, separations, closing, rate =
  separations ÷ average(opening, closing). Totals over the range;
  `annualisedPct = rate × 12 ÷ months`; a regular-staff-only figure alongside.
  `tooEarly` when average headcount is under 5.
- **Reason comes from the leaver's CLEARED clearance**, else `UNRECORDED`
  ("No clearance on file").
- `turnover()` feeds `/hr-reports/turnover`, its `.csv` twin (audited
  `EXPORTED` before the bytes go out), `/clearances/summary` (the register's
  strip) and the dashboard tiles — one computation, so they cannot disagree.
- An employee with no Date hired counts from the day the record was created,
  so an import without hire dates looks like a hiring spike. The report says so.

## Routes added beyond the plan

- `GET /clearances/me` — the caller's own employee and any open clearance, for
  the Raise form of someone who may only raise their own.
- `GET /clearances/areas` — the five areas with labels, so the screen does not
  keep a second copy.
- `GET /positions/:id` — one position with all holders (the list previews five).
- `GET /clearances/summary` is `ghr.clearances.view_all | ghr.reports.view_all |
  ghr.dashboard.view_all` (company-wide figures — not a view_own right);
  `GET /positions/summary` is `ghr.plantilla.view_all | ghr.dashboard.view_all`
  so the dashboard tile works for dashboard viewers.
- `GET /positions/lookup` also accepts the plantilla and course keys (Academy's
  requirement picker).

## Web

- `hr/Plantilla.tsx` exports `PlantillaSummary`; `hr/Clearances.tsx` exports
  `ClearanceSummary`, `REASONS`, `CLEARANCE_TONES`. `PeopleTiles` imports the
  two summary types.
- `/g-hr/employees/:id` opens the record (route-driven modal); row click
  navigates there and close returns to the list with its URL filters intact.
  `positionId=none` is the Unclassified tile's target.
- HR Reports keeps its tab in `?tab=` (`overtime` | `leave` | `turnover`).
- DataList already reads declared filter keys from the URL, so `?status=OPEN`,
  `?vacant=true`, `?over=true` and `?positionId=none` need no `initialFilters`.
