# P5 — calendar: notes worth carrying forward

Package P5 (area-sales.md item 5, audit fix 12). Files: `web/src/components/MonthCalendar.tsx`,
`web/src/lib/day.ts`, `web/src/pages/sales/Calendar.tsx`, `web/src/styles/calendar.css`,
`api/scripts/verify-calendar.ts` (38 assertions).

## For CLAUDE.md (Phase 3 notes)

- **Every calendar renders through `components/MonthCalendar.tsx`.** `useCalendarNav`
  owns the position, `CalendarToolbar` the buttons and the Week/Month switch,
  `MonthCalendar` the grid. The file knows nothing about activities, visits or
  trainings: a caller hands it `CalendarEvent`s already bucketed on a LOCAL day key
  (`dayKeyOf`) and already toned through `statusTone(status, extra)`. Do not draw a
  second grid, and do not put a status-to-colour rule inside a caller.
- **View and position live in the URL, not in the browser.** `?view=&month=&week=`;
  `?date=YYYY-MM-DD` is an alias resolved in the initial state and rewritten once on
  mount. A view switch pushes history (back undoes it); Previous/Next/Today replace it
  and always write `?view=` too. Nothing goes in localStorage: a calendar that opens
  on the month you last looked at opens on the wrong month.
- **Fetch on `nav.windowKey`, never on `from`/`to`.** `from`/`to` are memoised on
  `[view, month, week]` and `to` is the last grid day at 23:59:59.999 local — the
  API's `lte` is inclusive, and a window ending on midnight would count that instant
  in two adjacent windows. `verify-calendar.ts` books an activity on the boundary and
  proves it lands in exactly one.
- **Never `new Date('YYYY-MM-DD')` in the browser** — that is UTC midnight, 08:00
  Manila. `parseDay` builds local midnight; `dayKeyOf` reads the local date. Both live
  in `web/src/lib/day.ts`, which is DOM-free on purpose: `api/scripts/verify-calendar.ts`
  imports it through tsx and pins the edge months (a month starting on Sunday, a
  28-day February starting on Monday, December + 1).
- **One roving tab stop.** Exactly one gridcell has `tabIndex=0` — `nav.focus`,
  re-derived each render so it is always inside the current grid. Arrows move it,
  arrows past the edge turn the page, Home/End go to Monday/Sunday, PageUp/PageDown
  change the month. DOM focus follows only keyboard moves (a `movedByKeyboard` ref),
  so a toolbar click leaves the person on the button they pressed with one cell
  waiting on Tab. Chips and "+N more" are `<button>`s that Tab reaches only inside the
  focused cell.

## Decisions taken while building

- `CalendarNav` carries `views` (the list the page offered) in addition to the
  contract's fields, so `CalendarToolbar` can hide the switch when there is one view.
  It is a superset of the contract; nothing that codes against the hook breaks.
- The URL carries only the ACTIVE view's key (`month=` or `week=`), and the write
  drops the other one. The inactive key on `CalendarNav` is derived from the focus,
  which is always inside the active grid, so the two can never disagree.
- Week view: the day head is a `<button aria-pressed>` that picks the day
  "+ Schedule" will propose (the focused day at 09:00; today keeps "an hour from
  now"). This is slightly wider than the plan's "09:00 when the focused day is
  outside this week": a day picked inside this week also gets 09:00, because picking
  Thursday and being offered an hour from now on Tuesday is the wrong answer. Month view: clicking a day or "+N more" zooms to that week — the month is
  the overview, the week is the zoom. No drag-to-reschedule in either.
- An activity has its own page since 2026-10-08 (SCORO's event page):
  `/g-ops/calendar/activities/<id>` (`pages/sales/ActivityPage.tsx`). A chip click
  navigates there; every notification links there (`activityLink()` in
  `shared/activities.ts`); the page reads `GET /activities/:id` itself, so a link to
  a moved activity still finds it, and a 404 says "Activity not found". The older
  `?activity=<id>&date=<Manila day>` link on the calendar redirects to the page on
  mount (replace), carrying `?respond=` with it. The id is read once from a ref —
  StrictMode runs the effect twice and cancels the first, so consuming it inside the
  effect would redirect nothing.
- The person filter (`who`) is NOT mirrored to the URL (plan decision). It reads
  `/users/lookup?holding=gops.calendar.view_all` — only people who can open the
  calendar can be booked on it — instead of the admin-gated `/users` list. An
  activity's existing assignee who has since lost that right is still offered in the
  modal, so editing never silently reassigns it.
- ActivityModal: the lead select excludes WON/LOST but keeps an already-linked closed
  lead selectable, so editing never silently unlinks it. Lead, quotation and customer
  are all searched pickers (`/leads?search=`, `/quotations?search=`,
  `/customers/lookup?q=`), because all three lists grow without bound and a select of
  the first page would hide the rest. A 403 on either lookup leaves that picker empty rather than
  failing the form.
- `calendar.css` row heights are token arithmetic (`calc(var(--s-8) * 2 + var(--s-4))`)
  rather than bare pixel values; weekday names drop to two letters under 520px through
  a pair of spans, not JS.

## For other packages (exact edits, not made here)

- `api/src/routes/sales.ts` (P3): `PATCH /activities/:id` does not write `leadId`,
  `quotationId` or `customerId` — the modal sends all three and a Modify silently keeps
  the old links. Add to the update data:
  `...(body.leadId !== undefined ? { leadId: body.leadId || null } : {})` and the same
  for `quotationId` and `customerId`.
- `api/src/routes/sales.ts` (P3): the activity POST / PATCH / DELETE handlers write no
  `audit(...)` row (rule 8, "every write audits"). Add
  `await audit({ entityType: 'salesActivity', entityId: activity.id, action: 'CREATED' | 'UPDATED' | 'DELETED', summary: `…${activity.subject}` }, req);`
  in each, matching the signature used by the lead handlers in the same file.
- `web/src/pages/insights/Overview.tsx` (P1): `monthStart` at ~L41 can become
  `firstOfMonth(monthOf(todayLocal()))` from `lib/day`.
