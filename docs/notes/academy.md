# Package D — Gruntech Academy (item 13): notes worth carrying forward

Courses, training sessions, the training calendar and the training passport,
under G-HR › Academy. Files: `api/src/shared/academy.ts`,
`api/src/routes/academy.ts`, `api/scripts/verify-academy.ts`,
`web/src/pages/hr/academy/*`, `web/src/pages/hr/settings/AcademyCard.tsx`,
`web/src/pages/hr/dashboard/ReadinessTile.tsx`, `web/src/styles/academy.css`.

## Invariants

- **The passport is derived, never kept.** Which courses a person must hold
  comes from `CourseRequirement`; whether they hold one comes from their
  VERIFIED `TrainingRecord`s; CURRENT / EXPIRING / EXPIRED comes from
  `expiresAt` against today through `expiryState()` from `shared/aftermarket.ts`
  (the warranty rule, reused). No column says "compliant". `lineState()`,
  `readinessFor()` (batch) and `teamReadiness()` are the only arithmetic; the
  passport, the Passports register, `GET /passports/summary` and the HR
  dashboard `ReadinessTile` all read them. `verify-academy.ts` asserts the
  batch figure equals the passport's own, and the summary equals
  `teamReadiness()` read directly.
- **Requirements match by id, never by title.** Both null = everyone;
  department only = everyone in it; position only = every holder of that
  plantilla `Position`; both = the intersection. An unclassified employee (no
  `positionId`) matches department-only and everyone rules only. A course can
  therefore only be required of a position the plantilla has.
- **The record that answers for a course is the one that lasts longest**
  (`bestRecord`): never-expiring beats any date, a later expiry beats an
  earlier one. A renewal supersedes the certificate it renews without anybody
  deleting the old one. PENDING and REJECTED records never count.
- **Readiness counts people with at least one required course.** Somebody
  with nothing required is neither ready nor unready and is left out of the
  company figure rather than inflating it. Held = CURRENT or EXPIRING (an
  expiring certificate is still valid today).
- **Two doors write a record, and only two.**
  1. *Session completion* (`completeSession`) — final, no approval step: the
     trainer completing the session IS the verification. Writes VERIFIED,
     `verifiedById` = the trainer, `number` = null, dated the Manila day the
     session ended, expiring `addMonths(completedAt, validityMonths)`. Only
     PASSED attendees get a record. Refused while any result is PENDING, and
     for an assessed course while a PASSED/FAILED result has no score.
     `@@unique([sessionId, employeeId])` makes completing twice impossible.
  2. *External certificate* — the employee files it from My Training Passport
     (`POST /passports/me/records`): numbered `nextNumber('training_certification', tx)`
     (GT-TC-…), PENDING_VERIFICATION, submitted as `training_certification`
     through the approval engine (seeded workflow: one HR step). The record is
     deleted again if `submitForApproval` throws; `pickWorkflow` is checked
     first so a missing workflow does not burn a number. `onApprovalSettled`
     flips it VERIFIED (verifier = last approver) or REJECTED.
     HR may also record one directly for somebody else
     (`POST /passports/:employeeId/records`, `ghr.passports.create`) —
     VERIFIED at once, also GT-TC-numbered — **never for themselves**: their
     own goes through My Training Passport so another HR officer verifies it.
- **Changing a course's validity never rewrites an expiry on file.** A
  certificate expires on the date it was issued with; the new validity
  applies from the next completion (same principle as the VAT snapshot).
- **Session records are the session's.** They cannot be edited or deleted
  from the passport (409). External records can be corrected by
  `ghr.passports.edit_all` (not your own), deleted by `ghr.passports.delete`,
  or removed by their owner once REJECTED. A record awaiting HR cannot be
  touched until it is decided.
- **Expiry notices are swept on read** (`sweepExpiryNotices`, called when a
  passport loads) — G-Core has no scheduler. Once per record, claimed with a
  conditional `updateMany` so two screens loading at once send one notice;
  a record already superseded by a later-expiring one is claimed silently.
  Correcting `expiresAt` resets `expiryNoticeAt` so the new date earns its own.
- **The trainer is the owner** (`canEditRecord(user, 'ghr', 'training_sessions', trainerId)`).
  A trainer must hold `ghr.training_sessions.create` (role or ALLOW override,
  checked through `resolveUser` + `can`, so a DENY override wins). Only
  `edit_all` (HR) picks somebody else as trainer; the trainer picker reads
  `/users/lookup?holding=ghr.training_sessions.create`.
- **The calendar is company-wide.** `ghr.training_calendar.view_all` sees every
  session (the `/calendar` feed, `GET /:id`, `.ics`, enrol-me). The session
  LIST is the trainer right (`training_sessions.view_*`); under `view_own` it
  shows sessions I train, created or attend. **Results are not
  company-wide**: somebody who can see a session only through the calendar
  sees who is going and their own result, never a colleague's.
- **Self-enrolment** is `academy.rules.allowSelfEnrolment` (default on). A
  self-enrolment is recorded with `enrolledById = null`, which is what lets
  that person withdraw again before the start; somebody HR or the trainer
  enrolled cannot withdraw themselves. Capacity is enforced on every door.
- **Cancel, don't delete.** A session with anybody enrolled, or completed,
  cannot be deleted — cancelling keeps the record, bumps the `.ics`
  SEQUENCE and tells everyone enrolled. A time or course change also bumps
  the sequence and tells the attendees (`training.rescheduled`); pasting a
  Meet link does neither.
- **A session keeps a Meet link only** (no `calendarEventUrl` column): a pasted
  Calendar event link is refused with "paste the Meet link instead".
  `.ics` / Google hand-off come from `shared/calendar-links.ts`, exactly as
  meetings use them.
- **Sessions can run over several days** — `timeWindow(…, 24 × 14)` hours,
  not the meetings' 24.
- **Every print goes through `renderDocument`**: the attendance sheet
  (`GET /training-sessions/:id/pdf`) signs "Scheduled by" (at createdAt) and
  "Conducted by" (at completedAt — Pending until completed). No approval routes
  a session, so there is no `approvalSignoffs` slot to fill. Exports (.ics,
  PDF) are audited EXPORTED before the bytes go out.
- **People pickers**: enrolment uses `/employees/lookup?active=true` fed into
  the shared `PeoplePicker`. That lookup answers fifty rows, so the Academy's
  picker adds a "search all employees" box that queries the lookup and merges
  results into the list; ticked people stay ticked whatever the search.

## Routes (all authenticated)

- `/api/courses`: `GET /` (view_all, DataList), `GET /lookup` (any Academy
  right that picks a course), `GET /:id`, `POST /` (create), `PATCH /:id`
  (edit_all), `PUT /:id/requirements` (edit_all; body `[{departmentId?, positionId?}]`
  or `{ requirements }`, deduped, replaced in one tx), `DELETE /:id` (delete;
  409 when any session or record exists — deactivate instead).
- `/api/training-sessions`: `GET /calendar?from&to` (≤ 62 days, `cancelled=true`
  to include cancelled), `GET /`, `GET /:id`, `GET /:id/ics`, `GET /:id/pdf`,
  `POST /`, `PATCH /:id`, `POST /:id/attendees`, `DELETE /:id/attendees/:employeeId`,
  `POST|DELETE /:id/enrol-me`, `PUT /:id/results`, `POST /:id/complete`,
  `POST /:id/cancel`, `DELETE /:id`.
- `/api/passports`: `GET /summary` (passports.view_all or dashboard.view_all →
  `teamReadiness()`), `GET /records?status=` (verification queue), `GET /me`,
  `GET /` (register; filters `state=gaps|expiring|pending|ready|none`,
  `departmentId`, `positionId`, `active`), `GET /:employeeId`,
  `POST /me/records`, `POST /:employeeId/records`, `PATCH /records/:id`,
  `DELETE /records/:id`.
- `/api/academy-settings`: `GET /` (any signed-in user — categories and the
  self-enrolment switch are not secret), `PUT /` (`ghr.settings.edit_all`,
  audited on `setting/academy.rules`).
- Side-effect registrations in `routes/academy.ts`: `onApprovalSettled('training_certification')`,
  `registerSearch` for `course` (link `/g-hr/academy/courses?course=<id>`, which
  opens the course) and `training_session`, `registerSchedule` for today's
  SCHEDULED sessions I train or attend (a pre-marked NO_SHOW is left off).
- `courseImport: Registered` (CSV: Code, Title, Category, Description, Hours,
  Validity Months, Requires Assessment, Active; natural key Code,
  case-insensitive; permission `ghr.courses.create`).

## Notifications used

`training.enrolled` (to attendees; to the trainer on a self-enrolment),
`training.assigned` (to a trainer given a session), `training.rescheduled`,
`training.cancelled` (session cancelled, or taken off it), `training.completed`
(passed / not passed — no-shows are not told), `training.expiring` (once per
certificate, from the sweep). Approval notifications for external
certificates come from the engine.

## Verification

`cd api && npx tsx scripts/verify-academy.ts` — 97 assertions: requirement
matching (by id; unclassified matches department-only and everyone only),
line state and best-record rules, expiry dates (month-end clamp), the CSV
import spec, course master rules, trainer right, capacity, Meet-link
parsing, result privacy, completion rules and what it writes (SESSION record
VERIFIED with a null number, expiry by validity, final), passport and
register and summary reconciliation, the external certificate round trip
(GT-TC number, approval to HR, self-approval refused, VERIFIED/REJECTED),
HR-cannot-self-record, expiry notice once and reset on correction,
self-enrolment on/off and withdraw rules, the calendar window, `.ics`
sequence, the attendance PDF, cancel notices, search and schedule providers,
delete guards, settings validation and the audit trail. Restores
`academy.rules` and cleans up its own `ZZAC` fixtures.
