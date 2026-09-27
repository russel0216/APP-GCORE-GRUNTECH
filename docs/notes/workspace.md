# SHELL — workspace (My Work, Home, ComingSoon, Audit)

Audit fixes 2, 3, 4 (Misc), 6 (Audit, Home) and G-HR's "Today" card.
Verify: `cd api && npx tsx scripts/verify-workspace.ts` (API must be running; 39 assertions).

## What landed

- `GET /my-work` (`api/src/routes/workspace.ts`) now fills every section:
  - `assignedToMe` — leads I am working (`assignedToId`, not WON/LOST, overdue
    on `nextActionDate`), jobs I manage (PLANNING/IN_PROGRESS/ON_HOLD, overdue
    on `targetEndDate` except ON_HOLD), SCHEDULED visits on my name
    (`/g-ops/visits?visit=`), open tasks (≠ DONE, link to the job), APPROVED job
    orders assigned to me, and PLANNED sales activities that slipped past their
    day (always overdue, `/g-ops/calendar?activity=`). Overdue first, then by date.
  - `todaysSchedule` — the union of every `registerSchedule()` provider for
    [local midnight, next midnight). workspace.ts registers the one provider it
    owns: PLANNED sales activities assigned to me, `kind: 'activity'`, ending at
    `startsAt + durationMinutes`. Meetings and the Academy register theirs from
    their own modules.
  - `myDrafts` — my DRAFT quotation revisions (linked to the quotation), PRs,
    expense claims, cash advances, leave requests (through my Employee record)
    and job orders I raised. Most recently touched first.
  - `renewals` — `renewalPipeline(expiryWarningDays)` only when the caller holds
    `gops.service_contracts.view_all`, each row linked to the contract or the
    installed asset.
  - `awaitingMyApproval` and `GET /approvals/pending` carry `requester.name`.
  - Everything runs in one `Promise.all`, `take: 10` per list, after exactly one
    `sweepOverdue()` per request.
- `MyWork.tsx`: Awaiting me (Document cell is a `<Link>` to the record, "Raised
  by" column, `DecisionModal` has "Open {number}"), Today (time `mono`, title
  link, `Join` when `meetLink`), Assigned to me, My drafts, Renewals due (only
  when non-empty), My submissions (`StatusBadge`).
- `Home.tsx`: every card row is a `<Link>` (the `<div onClick>` rows are gone,
  rule 13); "In flight" rows fall back to `/my-work`; new "Assigned to me" and
  "Today" cards; Recent activity links through `recordLink()` and prints plain
  text where the record type has no screen.
- `Misc.tsx` `ComingSoon`: matches on `useLocation().pathname` —
  `pathname === sub.path || pathname.startsWith(sub.path + '/')`, most specific
  wins. The old `params['*']` gave `leave/abc` under `/g-hr/*` and made every
  fall-through claim its screen "does not exist yet".
- `admin/Audit.tsx`: Record column links via `recordLink()` when non-null, row
  click opens the record; action pill is `StatusBadge` with an `extra` map
  (audit verbs are not document statuses); Record filter lists the Phase 10
  entity types.

## Notes worth carrying forward

- **The `/my-work` row contract is `{ id, kind, title, subtitle?, when?,
  overdue?, link }`, and `link` always starts with `/`.** Home and My Work render
  any module's work without knowing the module; verify-workspace.ts checks the
  prefix on every row the route returns. A new source of "my work" adds a query
  and a mapper in `assignedTo()` / `draftsOf()` — never a new section shape.
- **"Today" is a timestamp window on the server's clock** (local midnight to
  the next), not `dayKey()`, which is a key for `@db.Date` columns and would put
  the boundary at 08:00 Manila. Providers filter `startsAt >= from && startsAt < to`.
- **A planned activity lives in exactly one place per day:** today's go to
  `todaysSchedule`, earlier unfinished ones to `assignedToMe` as overdue. Future
  ones appear in neither — the calendar is where you plan, My Work is what is due.
- **Overtime has no draft.** Filing it submits it (`OtStage` has no DRAFT), so
  it is absent from `myDrafts` by design, not by omission.
- **A draft is invisible to everyone else**, which is exactly why it needs a
  place on its owner's own screen: nobody else will ever chase it.
- **Renewals are gated by `gops.service_contracts.view_all`, server-side.** The
  section is withheld (empty array), not hidden in the UI.
- **Home shows three of each list.** The counts in the card titles are the full
  (capped at ten) lists; "and N more…" sends people to My Work.
- **A `recordLink()` of null prints text, never a link** — a link that lands on
  "Not built yet" is worse than none.

## Integration dependency

- verify-workspace.ts's "a purchase order is findable by its number and
  deep-links to the order" needs the `purchase_order` search provider that the
  PROC package registers in `api/src/routes/procurement.ts`. Until PROC lands it
  fails with an explicit "provider not registered" line; every other case is green.
