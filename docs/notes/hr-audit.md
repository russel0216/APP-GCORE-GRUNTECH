# HR-AUD — leave by URL, overtime chains, Users by id, the clock's link

Package notes for the orchestrator to merge into the model doc (§8 notifications,
§6 approvals) and CLAUDE.md (Phase 6 notes).

## What changed

- `GET /leave/:id` (`api/src/routes/hr.ts`) — the last GET on `leaveRoutes`, after
  `/types` and `/balances`, so the literal routes still match first (a verify case
  asserts both still answer). Response = the list row + `proofNote`, `decidedAt`,
  `createdAt`, `canCancel`. The employee's `userId` is stripped.
- `/g-hr/leave/:id` opens `LeaveDetailModal` over the register, read from that
  endpoint (not from the list row). Row click navigates there and keeps the list's
  query string; close navigates back to `/g-hr/leave` with the same query string.
  The modal shows the proof note and `DocumentApproval` (`leave_request`).
- Leave register: Employee filter (`employeeId`, from `/employees/lookup`, former
  employees included) when the viewer holds `ghr.leave.view_all`.
- Overtime record: two `DocumentApproval` chains — `overtime_prior` ("Before the
  work") and `overtime_request` ("After the work", shown once the hours are filed).
  They replace the sentence "the supervisor who directed the work signs first, then
  HR", which was the workflow's configuration printed as fact. Employee name links
  to `/g-hr/employees/:id` (with `ghr.employees.view_all`), the job to
  `/g-ops/projects/:id` (with either projects view key).
- `GET /overtime/chargeable` returns `defaults: { jobId, costCategoryId }` — the job
  and budget line of the caller's last non-cancelled filing while that job is still
  chargeable; otherwise no job and the labour category. The prior-approval form
  starts on it.
- `/admin/users/:id` opens the editor for that user; row click navigates there;
  close returns to the list (query string kept). "+ Add user" stays a local modal.
  The permission-override chips are `<button>`s now (they were `<span onClick>`,
  mouse-only — rule 13) with an `aria-label` naming the current state.
- Clock, unlinked login: for a holder of `ghr.employees.edit_all`, "Ask HR to link
  it" is followed by a link to the employee record — `/clock/me` now returns
  `candidate` (the unlinked Employee whose `employeeNo` equals the login's), else a
  link to the register searched by surname. `candidate` is only computed for a
  caller holding `ghr.employees.view_all`; everyone else gets `null`.
- Search providers `leave_request` (`/g-hr/leave/:id`) and `overtime_request`
  (`/g-hr/overtime/:id`), both with `view_all | view_own` and
  `ownWhere: { employee: { userId } }` — same scope as the list routes.

## Invariants worth carrying forward

- **A single leave or overtime record is readable by: `view_all`, the owner, or an
  approver of that document** — anyone who has acted on any of its approval
  requests, or is eligible for the current step of a pending one
  (`mayReadHrRecord` / `isApproverOf` in `hr.ts`). The approver door exists because
  a supervisor holding only `view_own` must be able to open what they are asked to
  decide; approving from a notification's subject line is approving blind. Anyone
  else holding only `view_own` gets 403.
- **`GET /overtime/:id` had no own-scope check at all.** The list was scoped; the
  record was not, so any `view_own` holder could read a colleague's hours and
  burdened rate by id. It now follows the rule above. Covered by a test.
- `canCancel` / `canFileActual` on the two detail responses mirror the POST routes'
  own checks exactly, so an approver reading a filing is never offered a button the
  route would refuse. If a route's check changes, change the flag with it.
- A leave submit that `submitForApproval` refuses (no workflow, nobody to route to)
  reverts the request to DRAFT rather than leaving it PENDING_APPROVAL with no
  approval behind it.
- Every write in the HR filing routes audits now: leave `SUBMITTED`, overtime actual
  filing `SUBMITTED`, overtime `CANCELLED` (the last two did not). Cancelling an
  already-cancelled overtime is a 400.

## Verification

`verify-hr.ts` gained a "Leave and overtime by id" section (104 assertions total,
green): owner 200 / colleague 403 / HR 200 / unknown 404 on `GET /leave/:id`;
`/types` and `/balances` not swallowed; a leave filed over HTTP carries approval and
notification links `/g-hr/leave/<id>` and a SUBMITTED audit; the routed supervisor
with only `view_own` reads the pending request (and gets `canCancel: false`) while a
colleague cannot; the same four-way check on `GET /overtime/:id`; own-scope search
for both kinds; `/overtime/chargeable` defaults; the two new audits; the clock's
`candidate` for HR and `null` for a non-HR login.

## Known limits (not fixed here)

- The Leave Employee filter's options come from `/employees/lookup`, which returns at
  most 50 rows. A company with more than 50 employees (current and former) will not
  see everyone in the dropdown; a `?employeeId=` URL still filters correctly. The fix
  is a typeahead filter in `DataList` (the "shared Lookup.tsx" item under Later).
- The overtime job link opens `/g-ops/projects/:id` for a `view_own` holder who may
  not manage that project; the route guard then answers with its own 403 page.
