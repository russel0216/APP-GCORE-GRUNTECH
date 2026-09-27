import { Prisma } from '@prisma/client';
import { can, canEditRecord, type ResolvedUser } from '../permissions/resolve';
import { conflict, forbidden } from '../http/kit';
import { manilaDayKey } from './day';
import type { CalendarEventInput } from './calendar-links';

/**
 * Meetings (G-HR › My day, item 11).
 *
 * An internal meeting is a time slot with invitees. It has no workflow, no
 * PDF and no money: the whole lifecycle is PLANNED → CANCELLED (or simply
 * past), which is why `Meeting.status` borrows `ActivityStatus` rather than
 * growing a fourth vocabulary for three identical words.
 *
 * The rules that matter live here rather than in the route, so the search
 * provider, the schedule provider and the HTTP handlers agree on who sees
 * what without three copies of the test:
 *
 *   · who can SEE a meeting — `visibleWhere()`
 *   · who can CHANGE one — `assertCanEdit()`
 *   · what a meeting looks like on a calendar — `meetingToCalendarEvent()`
 *   · what a meeting looks like to a calendar FILE — `meetingCalendarInput()`
 */

export const MEETING_LINK = (id: string) => `/g-hr/meetings/${id}`;

/**
 * The rows a person may open: everything under `view_all`; otherwise the
 * meetings they organise or are invited to. A `view_own` holder who is not
 * on the list does not learn the meeting exists — a 404, not a 403.
 */
export function visibleWhere(user: ResolvedUser): Prisma.MeetingWhereInput {
  if (can(user, 'ghr.meetings.view_all')) return {};
  return participantWhere(user.id);
}

/** Organiser or invitee — the rows that belong on somebody's own day. */
export function participantWhere(userId: string): Prisma.MeetingWhereInput {
  return { OR: [{ organizerId: userId }, { invitees: { some: { userId } } }] };
}

/**
 * Ownership is the organiser (rule 7: `canEditRecord`). A cancelled meeting
 * is history and refuses every change — raise a new one instead, so the
 * invitees who were told it was off are never quietly told it is back on.
 */
export function assertCanEdit(
  user: ResolvedUser,
  meeting: { organizerId: string; status: string },
): void {
  if (!canEditRecord(user, 'ghr', 'meetings', meeting.organizerId)) {
    throw forbidden('Only the organiser can change this meeting');
  }
  if (meeting.status === 'CANCELLED') {
    throw conflict('This meeting was cancelled — schedule a new one instead');
  }
}

/** Fields the calendar hand-offs need; the detail select is a superset. */
export interface MeetingForCalendar {
  id: string;
  number: string;
  title: string;
  agenda: string | null;
  location: string | null;
  startsAt: Date;
  endsAt: Date;
  status: string;
  icsSequence: number;
  meetLink: string | null;
  organizer: { id: string; name: string };
}

/** The item-5 `CalendarEvent` shape, plus the fields a chip needs to open it. */
export interface MeetingCalendarRow {
  id: string;
  number: string;
  /** Manila day key — the only thing a month grid buckets on. */
  date: string;
  sortAt: number;
  time: string;
  label: string;
  detail: string;
  done: boolean;
  status: string;
  startsAt: Date;
  endsAt: Date;
  link: string;
  meetLink: string | null;
  organizer: { id: string; name: string };
  /** Whether the viewer organises it — the chip says "yours" without a lookup. */
  mine: boolean;
}

const timeFmt = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  hour: '2-digit',
  minute: '2-digit',
});

/** A meeting as a calendar chip. `tone` is the client's, via statusTone(). */
export function meetingToCalendarEvent(m: MeetingForCalendar, viewerId: string): MeetingCalendarRow {
  return {
    id: m.id,
    number: m.number,
    date: manilaDayKey(m.startsAt),
    sortAt: m.startsAt.getTime(),
    time: timeFmt.format(m.startsAt),
    label: m.title,
    detail: [m.organizer.name, m.location?.trim() || (m.meetLink ? 'Google Meet' : null)]
      .filter((s): s is string => Boolean(s))
      .join(' · '),
    done: m.status !== 'PLANNED' || m.endsAt.getTime() < Date.now(),
    status: m.status,
    startsAt: m.startsAt,
    endsAt: m.endsAt,
    link: MEETING_LINK(m.id),
    meetLink: m.meetLink,
    organizer: m.organizer,
    mine: m.organizer.id === viewerId,
  };
}

/** The same meeting for `buildIcs()` and `googleCalendarUrl()`. */
export function meetingCalendarInput(m: MeetingForCalendar): CalendarEventInput {
  return {
    uid: m.id,
    number: m.number,
    title: m.title,
    // The Meet link rides in the description as well as on the record: an
    // invitee who imports the file should be able to join from their own
    // calendar without coming back to G-Core for the room.
    description: [m.agenda?.trim() || null, m.meetLink ? `Join with Google Meet: ${m.meetLink}` : null]
      .filter((s): s is string => Boolean(s))
      .join('\n') || null,
    location: m.location,
    startsAt: m.startsAt,
    endsAt: m.endsAt,
    sequence: m.icsSequence,
    cancelled: m.status === 'CANCELLED',
    url: MEETING_LINK(m.id),
  };
}

/**
 * "Live" is when Join makes sense: from a quarter of an hour before the
 * start until the end. Outside that a Join button is a link to an empty room.
 */
export function isLive(m: { startsAt: Date; endsAt: Date; status: string }, now = new Date()): boolean {
  if (m.status !== 'PLANNED') return false;
  const t = now.getTime();
  return t >= m.startsAt.getTime() - 15 * 60_000 && t <= m.endsAt.getTime();
}

/** The `when` filter on the list — one place, so the menu and the API agree. */
export function whenWhere(when: string | undefined, now = new Date()): Prisma.MeetingWhereInput {
  switch (when) {
    case 'upcoming':
      return { endsAt: { gte: now } };
    case 'past':
      return { endsAt: { lt: now } };
    case 'today': {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const end = new Date(start.getTime() + 86_400_000);
      return { startsAt: { gte: start, lt: end } };
    }
    default:
      return {};
  }
}
