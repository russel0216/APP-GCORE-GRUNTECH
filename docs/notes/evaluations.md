# C — evaluations: notes worth carrying forward

Package C (area-hr.md item 12). Files: `api/src/shared/evaluations.ts`,
`api/src/routes/evaluations.ts`, `api/scripts/verify-evaluations.ts` (113 assertions),
`web/src/pages/hr/Evaluations.tsx` (`Evaluations`, `EvaluationDetail`, plus the shared
`DueTable`, `ScheduleModal`, `scheduleLink`, `dueText`, `EVALUATION_TONES`, `RECOMMENDATION`),
`web/src/pages/hr/EmployeeEvaluationsTab.tsx`, `web/src/pages/hr/settings/ProbationCard.tsx`,
`web/src/pages/hr/dashboard/EvaluationsDuePanel.tsx` (`EvaluationsDuePanel`,
`EvaluationsDueStat`), `web/src/styles/evaluations.css`.

## For CLAUDE.md ("Hire-to-separate notes")

- **Regularisation is an approved document, not a field edit.** The employee row changes
  because of an evaluation in exactly one place: the `onApprovalSettled('evaluation', …)`
  subscriber at the bottom of `routes/evaluations.ts`, and only when every step (HR, then
  executive) has approved. REGULARIZE → `REGULAR`, `dateRegularized = effective`,
  `periodEndDate = null`. EXTEND → `periodEndDate = extendedTo`. ABSORB (trainee) →
  `PROBATIONARY`, `periodEndDate = effective + probationMonths`, **`dateHired` unchanged**.
  END changes nothing on the row; every HR holder is told to process the separation through
  a clearance (item 3's machinery). `verify-evaluations.ts` asserts the employee is still
  probationary after HR's step alone.
- **Due is derived on read, never stored.** `dueEvaluations()` / `milestonesFor()` in
  `shared/evaluations.ts` work it out from `dateHired` (or the approved ABSORB's effective
  date — `periodAnchor()`), `hr.rules.evaluationMilestoneMonths`, `probationMonths` and the
  period end. The first milestone falls N months after the anchor; a month milestone on or
  after the period end is dropped, not clamped; END is the period end itself; a trainee with
  no `periodEndDate` has no END. An evaluation "covers" a milestone when it is the same
  employee, kind and milestone, is SCHEDULED/DRAFT/PENDING_APPROVAL/APPROVED, and its
  `dueDate` is on or after the milestone date — that last clause is what makes an EXTEND
  work: the old END evaluation carries the old date, so the new END falls due again.
  REJECTED and CANCELLED cover nothing.
- **The subject reads only what has been approved.** `visibleTo()` is the one rule: view_all
  sees everything; the evaluator and whoever scheduled it see it at every stage; the person
  evaluated sees it only once APPROVED. Anybody else gets a **404, not a 403** — "there is an
  evaluation about you" is itself information the subject is not owed while it is pending.
  The list's `Mine` scope and the PDF follow the same rule.
- **The subject can never approve their own evaluation.** Two guards, because the engine's
  own rule only stops the REQUESTER: `/submit` refuses when any step's approvers include the
  subject's login (an HR officer on probation would route to HR), and the settled subscriber
  refuses to APPLY an approval where any `ApprovalAction.approverId` is the subject — roles
  change between submission and decision. That case sets REJECTED, logs `console.error`
  loudly, and tells the evaluator. `/submit` also refuses when a step has no approver other
  than the submitter (the engine would never let them clear it).
- **Ratings never reach the audit log.** PATCH audits a summary ("4 of 6 criteria rated,
  recommendation regularise") with no before/after. The audit trail is read by admins, who
  are not the people a rating is between. A test asserts every evaluation audit row has
  null before/after.
- **Criteria are a Setting list, not a table** (`hr.evaluationCriteria`, edited through
  `SettingListCard` on HR Settings via `GET/PUT /hr-settings/lists/:key`). They are
  SNAPSHOTTED onto `EmployeeEvaluationLine` (key, name, weight, order) when the form is
  opened, so renaming, reweighting or retiring one never rewrites a written form. There is
  no `/criteria` route. The key is permanent: rename freely, never reuse a key.
- **The score is the weighted mean of the RATED lines**, to two decimals, recomputed on the
  server on every PATCH. An unrated line is left out, not counted as zero. Not money — no
  `formatMoney`.
- **A returned evaluation goes back to DRAFT; a rejected one closes.** The engine reports
  RETURNED as REJECTED to subscribers; the subscriber reads the request's last action and,
  for RETURNED, puts the evaluation back in the evaluator's hands (`submittedAt = null`) to
  correct and resubmit. REJECTED closes it and the milestone falls due again.
- **HR reads `/due` and is told.** Reading `GET /evaluations/due` (view_all) notifies every
  `hr` role holder once per uncovered milestone, deduplicated on the notification's link
  (`/g-hr/evaluations?employeeId=&milestone=&due=`). That same link opens the Evaluations
  page with the schedule modal preset — the dashboard panel's Schedule button uses it too.
  G-Core has no scheduler; a nudge that depends on a cron job is worse than one on read.
- **No global search provider**, deliberately. A rating is not something Ctrl+K should
  surface. Tested.
- **HR Settings must render the probation rules from `GET /hr-settings` (merged)**, never
  the raw Setting row: the seed's `update: {}` means an existing install has none of the
  five keys stored. `ProbationCard` PUTs only its five keys.

## Routes (`/api/evaluations`)

`GET /due` (view_all; `?employeeId=`, `?all=1` includes covered) · `GET /milestones/:employeeId`
(view_all) · `GET /` (view_all | view_own; filters status, kind, employeeId, evaluatorId,
milestone, `open=1`; scope=mine) · `POST /` (create; the caller is the evaluator, DRAFT) ·
`POST /schedule` (create; `evaluatorId` another user → SCHEDULED + `evaluation.due`
notification) · `GET /:id` (404 when invisible; adds `canEdit`, `canCancel`, `isSubject`,
`ratingScale`, `ratingLabels`) · `PATCH /:id` (edit_own | edit_all via `canEditRecord` on
`evaluatorId`; DRAFT/SCHEDULED only) · `POST /:id/submit` · `POST /:id/cancel` · `POST
/:id/acknowledge` (the subject only, APPROVED only) · `GET /:id/pdf` (renderDocument;
sign-offs Evaluated by / Reviewed by (HR) / Approved by from `approvalSignoffs` /
Acknowledged by, each dated by its own event, "Pending" otherwise; audited EXPORTED).

## Decisions taken while building

- `POST /` opens an evaluation for the caller only; naming another evaluator is `POST
  /schedule`, so "I am writing this" and "I am asking somebody to write this" are separate
  rights in the audit trail and the notification.
- One open (SCHEDULED/DRAFT/PENDING) evaluation per employee + milestone + kind.
- The due date defaults to the milestone's own date so the due list recognises it; ADHOC
  defaults to today.
- No DELETE route although the registry grants `ghr.evaluations.delete`: an evaluation has a
  number from `nextNumber()` and a history; it is cancelled, not deleted. The permission is
  simply unused.
- Attachments on an evaluation use the shared `/attachments/:entityType/:entityId` route,
  which checks authentication but not per-entity visibility — the same as every other
  entity type today. Ids are cuids; flagged here rather than changed (not this package's file).

## For the orchestrator (mounting)

- `web/src/pages/hr/Dashboard.tsx`: `<EvaluationsDueStat/>` is the sixth tile for the
  kpi-grid; `<EvaluationsDuePanel/>` goes under the attendance table. Both render nothing
  without `ghr.evaluations.view_all`.
- `web/src/pages/hr/Settings.tsx`: mount `<ProbationCard/>`. **Its own `save()` must stop
  sending the whole settings object** — it PUTs everything it loaded at mount, which would
  write stale probation keys back over a change just saved on `ProbationCard`. Send only the
  working-day keys it edits (`workStart … faceThreshold`).
- `web/src/pages/masters/Employees.tsx`: `<EmployeeEvaluationsTab employeeId={employee.id}
  employmentType={employee.employmentType} dateRegularized={employee.dateRegularized} />`
  as a fourth tab when `employee && can('ghr.evaluations.view_all')`.
