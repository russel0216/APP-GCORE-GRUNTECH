# Plan — the owner's six of 2026-10-13 (evening): working days and finish dates, a costing PDF template, the S-curve's axis, minutes and map links on meetings, Request for Approval in place of Approved Plans, and People Flow in G-HR

The owner's words, with three screenshots and `PEOPLE_FLOW_FROM_START_TO_SEPARATION.txt`:
"1. Add Duration on Scope of Work; if there is Start Date there should be
Finished Date; the note 'Planned duration in working days (Mon–Fri) — 85
working days in all' should be Mon–Sat; check total working days; Finished
Date should tally on Total Date declared in the Scope of Work. 2. Add PDF
Template of Costing in Admin Setting to modify. 3. On Project Overview the
S-Curve card's date scale overlaps and can't be read. 4. Meetings & Records
should have minutes of meeting so anyone can back-track what was talked
about (below Agenda); allow Google Map tagging. 5. Replace Approved Plans
with Request for Approval: a form with internal approval (Technical Manager,
Team Leader, and CEO over ₱1,000,000 project costing) and a Drawing Reference
Number, which could come from a CAD J.O. 6. G-HR People Flow, per the
attached file."

Status: **built** (2026-10-13), in the order 3, 1, 4, 5, 2, 6, one commit
each, with the defaults below. Two departures, both in CLAUDE.md: the
costing's bucket subtotals are ordinary `{ cells }` rows of the designed
line table (no new `subtotal` row kind), and People Flow's stage rule holds
a person in Onboarding or Integration only within the new-hire window — the
plan's "while any Onboarding item is open" would have put every employee
in Onboarding on the day it deployed, since nobody's onboarding is recorded
yet.

## 1. Working days are Mon–Sat; a start date gives a finish date

**Today.** Every working-day rule is Mon–Fri: `workingDaysBetween()` and
`workingDayDate()` in `api/src/shared/day.ts` (the job order's target
start/finish, "Plan from costing" on a project), `planTasks()` in
`costingMath.ts` (the costing's scope, in working days with no calendar
date at all — the sheet says "85 working days in all (Mon–Fri)", the paper's
legend says the same), and `JobOrders.tsx` keeps a web copy. A costing has
NO start date: its plan is day 1 … day N. A project has `startDate` and
`targetEndDate`, typed by hand, and `createJobRecord()` (`routes/jobs.ts`)
lays the scope items out from the start date in CALENDAR days
(`addDays(cursor, durationDays)`) — so a 85-working-day plan ends on a date
that has nothing to do with 85 working days, which is the owner's "should
tally".

**Build.**
- **One work week, Mon–Sat**: `WORK_WEEK` in `shared/day.ts` (Sunday the
  one day off; `isWorkingDay(date)`), and `workingDaysBetween`,
  `workingDayDate` read it; `planTasks`'s comment and the sheet's, the
  paper's and the job order's words say "Mon–Sat". `JobOrders.tsx`'s copy
  follows and verify-aftermarket pins it equal to the server's on a month
  of dates. No holiday calendar yet (open question 1).
- **A costing takes a start date** (`Costing.plannedStart`, DATE,
  nullable; "Start date" on the sheet's Costing details, beside Valid
  until). With one, the sheet and `present()` give **Finish date** =
  `workingDayDate(plannedStart, planDays)` — derived, never stored — and
  each phase its dates beside "Day 1–4 · 4 d" ("Oct 14 – Oct 17"); the
  paper's DETAILS block prints Start and Finish, the Gantt appendix dates
  its columns. "Duration" on the Scope of Work head reads "85 working days
  (Mon–Sat) · Oct 14 – Jan 23" — the figure the owner asked to see.
- **A project's dates tally with its scope**: `createJobRecord()` places
  every scope item on WORKING days from the project's start
  (`workingDayDate`, back to back, as `planTasks` sequences them) and sets
  `targetEndDate` to the last item's end when the body names none; the
  Overview's "Target finish" shows the plan's finish beside the typed one
  and says "N working days after the start — the scope of work plans 85"
  when they differ. "Plan from costing" already uses `workingDayDate`; it
  follows the new week. The project Gantt shades Sundays as the off day.
  A job order's working days between target start and finish follow the
  same rule.
- **Verify**: verify-foundation (or a day-rules block in verify-costing)
  pins Mon–Sat on both helpers across a month; verify-costing a costing
  with a start date reporting its finish and phase dates; verify-delivery a
  project built from a 10-day plan whose target finish is 10 working days
  (two Sundays skipped) after the start.

## 2. A PDF template for the costing

**Today.** The Project Costing paper is `renderDocument` sections in
`routes/costing.ts` (details, one table with numbered bucket headings and
subtotals, the summary as `totals`, Terms, sign-offs, the Gantt appendix).
Admin › PDF Templates designs the quotation and the sales order through the
`DOCS` registry in `routes/pdfTemplates.ts` (a field catalogue, a sample, a
standard layout, a data builder) and `renderDesigned`.

**Build.** The costing becomes the third designed document:
- **`shared/costingTemplate.ts`**: the field catalogue (`costing.number`,
  `title`, `customer`, `site`, `systemUnit`, `validUntil`, `plannedStart`,
  `plannedEnd`, `planDays`, `preparedBy…`, the summary figures `totalCost`,
  `marginAmount`, `marginPct`, `contractValue`, `vatAmount`, `grandTotal`,
  `terms`, `company.*`), the line table's columns (`code`, `product` as
  name over description, `unit`, `quantity`, `unitCost`, `amount` — the
  cost columns are allowed: it is internal paper), a sample (one page and
  three), and `STANDARD_COSTING_DESIGN` — portrait, in the dress, the
  bucket names as the engine's `{ heading }` rows, the summary as the
  totals block (Project budgeted cost, Margin, Subtotal, VAT, Total), Terms
  `after` the table, the sign-offs `last`.
- **Bucket subtotals**: `DesignRow` gains `{ subtotal: { label, value } }`
  — a right-aligned bold row under a bucket's lines, drawn by the designed
  engine (`drawRow` in `shared/pdfDesign.ts`); the quotation and the order
  never send one, so nothing changes for them. The editor's preview draws
  it (`web/src/lib/pdfTemplate.ts` follows, pinned by verify-foundation).
- **The Gantt stays an appendix**: the designed engine draws boxes, not
  charts, so `GET /costings/:id/pdf` renders the designed pages, then the
  Scope of Work through `renderDocument`'s landscape `gantt` section and
  merges the two with pdf-lib — the attachments merger's route
  (`withAttachments`), reused as `withAppendix`. Page numbers stay the
  designed document's; the appendix keeps its own.
- **`costingPrintData(costing, slots)`** supplies fields, rows (headings,
  lines, subtotals), totals and signatories (Prepared by and the route's
  steps through `approvalSlots('costing', …)`, `preparedAt` as today).
- **Admin › PDF Templates** gets "Costing" in its switcher
  (`?doc=costing`), `DOCS.costing` with `previewPermissions`
  `gops.costing.view_*`; export/import files carry `type: 'costing'`.
  `pdfTemplate.costing` is its Setting; "Put the standard back" as the
  others. The paper's file name stays "Project Costing <number> …".
- **Verify**: verify-costing reads the designed paper's wording (the bucket
  headings and subtotals, the totals, the sign-offs), the Gantt page behind
  it (landscape, last), and that a saved layout prints in place of the
  standard; verify-sales' template checks run on the costing registry entry
  too (shape, unknown field, orientation).

## 3. The S-curve's date scale

**Today.** `SCurve.tsx` labels six POINTS picked by index
(`points[round(i·(n−1)/5)]`). The points are the progress reports' dates,
which cluster (Jan 6, 7, 8, 11 in the screenshot), so four labels land on
one spot.

**Build.** `curveTicks(points, width)` in `web/src/lib/sCurve.ts`,
DOM-free: ticks by TIME, not index — the first and last dates and up to
four in between at even intervals of the span, each labelled at its own x;
a label whose x is within 56 px (at the chart's own scale) of the last
drawn one is dropped; "Oct 13" within a year, "Oct 13 '26" when the span
crosses a year end. The chart draws those ticks; the points themselves are
unchanged. verify-delivery pins the helper on the screenshot's dates (Oct
13, Jan 6, 7, 8, 11 → Oct 13, Nov, Dec, Jan 11 — no two within 56 px).

## 4. Minutes of meeting, and a map on Where

**Today.** `Meeting` has `agenda` and `location` (text), `meetLink` and
the Google Calendar hand-off; nothing records what was said. The Where box
is text.

**Build.**
- **`Meeting.minutes`** (text), **`minutesAt`**, **`minutesById`**: a
  **Minutes** card under Agenda on the meeting page, written and changed IN
  the page (a panel, never a dialog) by the organizer or anyone invited,
  during or after the meeting (never on a cancelled one); every change
  audits and tells the invitees once per day of edits ("Minutes added to
  …"); files on the card go through the `meeting` attachments. The
  meetings list searches minutes; a project's Meetings & Records shows a
  "Minutes" tick in the row so the trail is visible at a glance. Attendance
  stays the invitees' answers (Going / Not going) — no separate roll call
  (open question 4).
- **Map tagging without Google credentials** (the meeting module's rule):
  `Meeting.mapUrl` (http(s) only, `safeHttpUrl`; a Google Maps link pasted
  beside Where — a place, a pin, a `maps.app.goo.gl` share link) and, with
  none, "Find on Google Maps ↗" built from the Where text
  (`https://www.google.com/maps/search/?api=1&query=…`). The page shows
  "Open in Google Maps ↗" under Where; the invitation email carries the
  link. One `MapLink` component (`components/MapLink.tsx`) — the sales
  activity's Address takes it too (`SalesActivity.mapUrl`), same rule.
- **Verify**: verify-meetings — minutes by an invitee, refused for a
  stranger and on a cancelled meeting, the bell once, a `javascript:` map
  link refused, the search finding a word from the minutes.

## 5. Request for Approval in place of Approved Plans

**Today.** `ApprovedPlan` (title, `drawingNo`, revision, discipline,
files) has its own `PATCH /:jobId/plans/:planId { status }` that writes
APPROVED by hand (`routes/progress.ts`) — a module approve route, which
rule 2 forbids — and the CAD J.O.'s "file as approved plan" creates one
FOR_APPROVAL. The hidden registry entry is `plans` ("Approved Plans",
`gops.plans.*`), the project tab "Approved Plans".

**Build.** The plan becomes a routed document, **Request for Approval**:
- **The record**: `ApprovedPlan` keeps its table and keys (`gops.plans.*`;
  the label becomes "Request for Approval" in the registry, the project
  tab and the Projects page's register link; the path `/g-ops/plans` and
  the tab key `plans` stay, so every link holds) and gains `number`
  (numbering type `plan_approval`, "RFA"), `description` (what is asked
  to be approved), `drawingNo` labelled **Drawing reference number** —
  typed, or picked from a CAD J.O. with an accepted revision
  (`cadRevisionId`; the pick fills the reference "CJO-2026-0012 R2" and
  copies the revision's files, the file-plan rule), `requestedById`,
  `amount` = the project's contract value (the costing's, snapshotted at
  submit — the band the owner named), and the engine's statuses: DRAFT →
  PENDING_APPROVAL → APPROVED / REJECTED (returned to DRAFT), and
  SUPERSEDED when a later request on the same reference is approved.
- **The route** (rule 2): `submitForApproval('plan_approval', id, {
  amount, jobId, requesterId })`; seeded "Request for approval — technical
  manager, team leader" and "… with the CEO / President above ₱1,000,000"
  (`minAmount` 1,000,000.01), both `preparerSigns` and `standIns` as the
  costing's; `settlePlanApproval()` claims PENDING → APPROVED with a
  conditional update (rejected → DRAFT, "not applied" after a cancel);
  cancel withdraws through `cancelOpenRequest`. The old PATCH-status route
  goes; `audit-workflows.ts` knows a project engineer or manager raises
  them.
- **The page** `/g-ops/plans/:id` (rule 20: every record has a page):
  RecordHeader (Submit for approval, Print, ⋯ Cancel / Delete a draft,
  Modify), the `DocumentApproval` panel where the approval notification
  lands, the drawing files (the Attachments card, `approved_plan`), the
  CAD J.O. link. The project tab lists requests with their status and
  signatures. **The paper** "Request for Approval" through `renderDocument`:
  the project, the reference, the description, the files listed and the
  PDFs printed behind it (`withAttachments`), the sign-offs through
  `approvalSlots` — Requested by, Technical Manager, Team Leader, CEO /
  President (Pending until signed).
- **CAD J.O.**: "File as approved plan" becomes "Raise a request for
  approval", which opens the new request's page as a DRAFT with the
  reference and files filled; `CadJobOrder.approvedPlanId` stays the link.
- **Verify**: verify-delivery — a request under ₱1,000,000 takes two
  signatures, one over takes three, the preparer who is Technical Manager
  signs at submit, a decision after cancel is not applied, the CAD J.O.
  hand-off, the paper's sign-offs; verify-foundation's registry check sees
  the renamed label.

## 6. People Flow in G-HR

**The owner's file**: five stages — Onboarding (pre-boarding, orientation,
role alignment with 30-60-90 goals and a buddy), Integration (job
training, early feedback 1-on-1s, probation review), Development & Growth
(performance management, skill building, career pathing), Retention &
Engagement (total rewards, workplace culture, work redesign), Separation
(notice, knowledge transfer, exit interview, revoking access and
collecting property, final pay and clearance).

**Today.** The pieces exist apart: the employee record, evaluations
(probation review), the Academy (skill building), clearance (separation:
accountabilities, access, property), turnover. Nothing strings them into
one path per person, and the items with no record (orientation, a buddy,
30-60-90 goals, 1-on-1s, exit interview, knowledge transfer) live nowhere.

**Build.** G-HR › People › **People Flow** (`ghr.people_flow`, registry:
`view_all`/`edit_all` for HR, `view_own` for the person — their own path —
and a supervisor's direct reports through `ghr.dashboard.view_all`, the
clock capture's rule), `/g-hr/people-flow`, `routes/peopleFlow.ts`,
`pages/hr/PeopleFlow.tsx`, verify-hr.
- **The checklist is data**: `hr.peopleFlow` in HR Settings — a
  `SettingListCard` list of items `{ stage, key, title, description,
  dueDays?, linksTo? }` seeded from the owner's file (the five stages, the
  sixteen items), editable there; a key is permanent (rename freely).
- **One row per person per item**: `EmployeeFlowItem` (employeeId, itemKey,
  status PENDING / DONE / WAIVED / NA, doneAt, doneById, dueOn, notes,
  files on `employee_flow_item`), made on demand when HR opens a person's
  path and merged over the template on read, so a new checklist item
  reaches everyone. **Derived items follow the record that answers for
  them** (the clearance's rule): Probation Review ← an APPROVED evaluation
  (its outcome shown), Skill Building ← training records (count and the
  latest), Knowledge transfer / exit interview / revoke access / final pay
  and clearance ← the clearance's own items; a derived item is read-only
  and says which record decided it, waived with a reason, never ticked by
  hand. The rest are ticked by HR with a date, a note and a file (the
  30-60-90 goals and the exit interview are the item's notes — a text
  box, no form of their own).
- **A person's STAGE is derived, never stored**: Separation when a
  clearance exists; Onboarding while any Onboarding item is open or within
  30 days of `dateHired`; Integration until the probation review is done
  (an approved evaluation, or regularisation); then Development & Growth,
  with Retention & Engagement as the second checklist of the same steady
  state. `stageOf(employee, items)` in `shared/peopleFlow.ts`, pure,
  verify-hr.
- **The screens**: People Flow — five `Stat` tiles (people per stage,
  overdue onboarding items, probation reviews due) over a DataList of
  people with their stage, open items and days in stage (`?stage=` a
  declared filter, the tiles linking to it with the same query); the
  employee record's **People Flow** tab — the five stages as sections, each
  item with its tick, date, who, note, file, and the derived ones linking
  to their record; **My Work** rows for HR: items due (`dueDays` from the
  stage's start) and probation reviews due; the person sees their own
  onboarding list on My Work (read-only, "ask HR"). The list prints
  (`GET /people-flow/pdf`); no PDF per person yet.
- **Verify**: verify-hr — the seeded checklist, a new hire's stage moving
  Onboarding → Integration → Development as items and an evaluation land,
  a derived item refusing a hand tick, waiving with a reason, the person
  reading only their own path, the supervisor their reports', the tile
  counts equal to the filtered list.

## Open questions (defaults in bold)

1. §1 — holidays: **none yet** (Mon–Sat only); an HR holiday list can be
   added to `WORK_WEEK` later without changing a stored day.
2. §1 — Mon–Sat for EVERY working-day figure (the costing, the project,
   the job order): **yes, one rule**.
3. §2 — the Gantt chart stays an appendix behind the designed pages, not
   a box an administrator places: **yes** (the engine draws charts, the
   designer draws boxes).
4. §4 — attendance at a meeting: **the invitees' Going / Not going as
   today**, no roll call; minutes are one text with files.
5. §5 — the amount band is the project's contract value (the costing's):
   **yes**; keys and path keep `plans`, only the words change.
6. §6 — who ticks: **HR (`edit_all`)**; the person reads their own path,
   a supervisor their direct reports'.

## Order of work and effort

Six commits, one per item, each with its verify cases and CLAUDE.md lines;
the full suite before each push. Build 3 first (an hour, visible at once),
then 1, 4, 5, 2, 6 — 5 before 2 because the request's paper reuses nothing
of the designed costing, and 6 last because it is the widest new screen.

| # | Item | Touches | Effort (hands-on) |
|---|---|---|---|
| 3 | S-curve ticks | `lib/sCurve.ts`, `SCurve.tsx`, verify-delivery | 1 h |
| 1 | Mon–Sat, start/finish dates, project tally | `day.ts`, costing schema/sheet/paper, `createJobRecord`, overview, Gantt shading, 3 verify scripts | 3–4 h |
| 4 | Minutes and map links | `Meeting` schema, routes, page, `MapLink`, activity address, verify-meetings | 2–3 h |
| 5 | Request for Approval | schema, numbering, seed routes, `submitForApproval`/settle, routes, page, paper, CAD hand-off, project tab, registry label, verify-delivery | 5–7 h |
| 2 | Costing PDF template | `costingTemplate.ts`, subtotal rows in the engine and the editor, appendix merge, print data, registry, admin switcher, verify | 6–8 h |
| 6 | People Flow | settings list, `EmployeeFlowItem`, derived rules, routes, board, tab, My Work, paper, verify-hr | 6–8 h |
| | **Total** | | **23–31 h — five to seven sessions** |
