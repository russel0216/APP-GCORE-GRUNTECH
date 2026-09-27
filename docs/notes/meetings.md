# B — meetings: notes worth carrying forward

Package B (area-hr.md item 11). Files: `api/src/shared/meetings.ts`,
`api/src/routes/meetings.ts`, `api/scripts/verify-meetings.ts` (86 assertions, API
must be running), `web/src/pages/hr/Meetings.tsx`, `web/src/styles/meetings.css`.

## For CLAUDE.md ("Hire-to-separate notes" / G-HR block)

- **A meeting is a time slot with invitees: no workflow, no PDF, no money.** It is
  numbered `GT-MTG-…` through `nextNumber('meeting', tx)` and never routes through
  the approval engine; `audit-workflows.ts` has nothing to say about it, on purpose.
  `Meeting.status` reuses `ActivityStatus` (PLANNED/DONE/CANCELLED) rather than a
  fourth vocabulary for the same three words. Nothing sets DONE today — a past
  PLANNED meeting is simply past, and the list's `when=past` is how you find it.
- **G-CORE holds no Google credentials and never will by accident.** The organiser
  gets a pre-filled Google Calendar link (`googleCalendarUrl`, guests = invitees, so
  Google sends the email), creates the event in their own account, and pastes the
  Meet link (or a bare room code, or the Calendar event link) back.
  `parseGoogleLink` is the only thing that decides what was pasted; a non-Google link
  is refused with a message saying what to paste. `googleEventId` is reserved for a
  Calendar API integration ("path B") and stays null until that is deliberately built.
- **Invitations go out on "Send invitations", never on save.** `MeetingInvitee.notifiedAt`
  null = not yet told. Sending again reaches only people added since. A draft can be
  corrected freely before anybody hears of it.
- **A time change bumps `icsSequence` and tells only the people already told.** Moving
  an unsent meeting bumps the sequence and notifies nobody; retitling or pasting a
  link is not a move (no bump, no notification). Cancelling bumps the sequence too,
  so a re-downloaded `.ics` carries `METHOD:CANCEL` under the same UID and withdraws
  the event from the invitee's calendar. The UID is the row id — never change it.
- **Once invitations went out a meeting cannot be deleted (409) — cancel it instead,
  with a reason.** That holds for `ghr.meetings.delete` holders too: the record is what
  those people were told. A cancelled meeting refuses every edit and every response.
- **Visibility is one function, `visibleWhere(user)`** in `shared/meetings.ts`:
  everything under `view_all`, otherwise organiser-or-invitee. The list, the calendar,
  `GET /:id`, the `.ics`, Ctrl+K search (`ownWhere`) and the schedule provider all use
  it or its `participantWhere` half. A `view_own` holder who is not on the list gets a
  404, not a 403 — they do not learn the meeting exists.
- **Ownership is the organiser**, through `canEditRecord(user,'ghr','meetings',organizerId)`
  in `assertCanEdit`. Only the invitee answers for themselves (`/respond`); the
  organiser is never their own invitee (silently dropped on create/add).
- **Invitees are Users, picked through `GET /users/lookup`** — never the admin-gated
  `/users` list. An employee without a login cannot be invited in-app.
- **The `.ics` download is audited as `EXPORTED`** by whoever took it, and the Meet
  link rides in its DESCRIPTION so an invitee can join from their own calendar.
- **Today's schedule**: `registerSchedule()` in `routes/meetings.ts` lists PLANNED
  meetings I organise or am invited to (declined invitations stay off the day) with
  `kind:'meeting'` and `meetLink`, filtered `startsAt >= from && startsAt < to`.
  Anything that needs that row (verify scripts) must import `routes/meetings` for its
  side effect, like `verify-sales.ts` does for the quotation subscriber.
- **The month view is the shared `MonthCalendar`**, not a second grid: the Meetings
  page switches List/Month with `?show=month` and the calendar owns `?view=&month=`.
  `GET /meetings/calendar` caps a window at 62 days; the page buckets chips on the
  viewer's local day (`dayKeyOf`), and a cancelled chip says "(cancelled)" in words.
  Clicking a day on the grid opens New meeting at 09:00 that day for `create` holders.

## Decisions a maintainer should know

- An invitee added but not yet sent CAN see the meeting in their own list (visibility
  is by membership, not by `notifiedAt`). What they do not get is a notification. If
  the owner wants drafts invisible to invitees, narrow `participantWhere` to
  `invitees.some({ userId, notifiedAt: { not: null } })` and update case 9 of
  `verify-meetings.ts`.
- `/respond` is allowed before the invitation is sent (the invitee can already see it).
- The organiser is notified of a DECLINE only; an accept is what they assumed.
- Attachments on a meeting (`entityType="meeting"`) are editable by the organiser and
  by invitees (pre-reads, minutes). The attachment routes themselves carry no
  per-entity access check — that is the existing shared service, not this package.
