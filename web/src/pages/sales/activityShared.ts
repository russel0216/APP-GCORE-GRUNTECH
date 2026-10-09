/**
 * What the sales calendar, the activity's page and the activity form share:
 * the row as the API sends it, the invitee's answers, the reminder offsets
 * and the types' stand-ins. No React in here, so the three screens import
 * it without importing each other.
 */

/**
 * An activity type as Admin › Categories › Activity types has it (2026-10-08,
 * SCORO's customisable types). The list is data; an activity carries the key.
 */
export interface ActivityTypeDef {
  id: string;
  key: string;
  name: string;
  color: string | null;
  isActive: boolean;
}

/** The six built-ins, standing in until the list loads. */
export const BUILTIN_TYPES: ActivityTypeDef[] = [
  { id: 'SITE_VISIT', key: 'SITE_VISIT', name: 'Site visit', color: null, isActive: true },
  { id: 'MEETING', key: 'MEETING', name: 'Meeting', color: null, isActive: true },
  { id: 'CALL', key: 'CALL', name: 'Call', color: null, isActive: true },
  { id: 'FOLLOW_UP', key: 'FOLLOW_UP', name: 'Follow-up', color: null, isActive: true },
  { id: 'SUBMISSION', key: 'SUBMISSION', name: 'Submission', color: null, isActive: true },
  { id: 'OTHER', key: 'OTHER', name: 'Other', color: null, isActive: true },
];

/** Planned is the default chip; done reads as settled. Cancelled falls to statusTone's danger. */
export const ACTIVITY_TONES = { PLANNED: '', DONE: 'ok' } as const;

/** An invitee's answer (InviteeResponse): PENDING is "No reply". */
export type Rsvp = 'PENDING' | 'ACCEPTED' | 'TENTATIVE' | 'DECLINED';
export const RSVP_LABEL: Record<Rsvp, string> = { ACCEPTED: 'Going', TENTATIVE: 'Maybe', DECLINED: 'Not going', PENDING: 'No reply' };
/** The marks a chip carries — readable without colour, and without the words. */
export const RSVP_MARK: Record<Rsvp, string> = { ACCEPTED: '✓', TENTATIVE: '~', DECLINED: '✗', PENDING: '?' };
export const ANSWERS: Rsvp[] = ['ACCEPTED', 'TENTATIVE', 'DECLINED'];

export interface Activity {
  id: string;
  /** The type's key (SalesActivityType.key). */
  type: string;
  /** The type's name as Admin › Categories has it. */
  typeName?: string;
  status: string;
  subject: string;
  notes: string | null;
  location: string | null;
  startsAt: string;
  /** Derived by the API: startsAt + durationMinutes. */
  endsAt: string;
  durationMinutes: number;
  reminderMinutes: number | null;
  /** `photoPath` is the person's photo — an attachment id — for the faces on the activity's page. */
  assignedTo: { id: string; name: string; photoPath?: string | null };
  invitees: {
    userId: string;
    response: Rsvp;
    respondedAt: string | null;
    user: { id: string; name: string; photoPath?: string | null };
  }[];
  /** The API's tally of the invitees' answers. */
  responses?: { going: number; maybe: number; notGoing: number; noReply: number };
  lead: { id: string; number: string; companyName: string } | null;
  quotation: { id: string; number: string } | null;
  customer: { id: string; name: string } | null;
  // ── SCORO's New event dialog (2026-10-08) ──
  /** A whole day: starts at Manila midnight, runs whole days; drawn in the all-day row. */
  allDay: boolean;
  /** "Personal": only the people on it see what it is; everyone else reads "Busy" (`masked`). */
  isPrivate: boolean;
  /** Conference call link, http(s). */
  callLink: string | null;
  /** The customer's contact person it is with. */
  contact: { id: string; name: string; position: string | null } | null;
  /** The project it is for. */
  job: { id: string; number: string; name: string } | null;
  /** Who booked it (null on older rows). */
  createdBy: { id: string; name: string } | null;
  /** The first occurrence's id when it is one of a repeating booking. */
  seriesId: string | null;
  /** True on a private activity read by someone not on it: "Busy" and nothing else. */
  masked?: boolean;
  /** On GET /activities/:id, for a planned activity: SCORO's "Open in Google Calendar" hand-off. */
  googleCalendarUrl?: string | null;
}

export interface Person {
  id: string;
  name: string;
  /** The photo (an attachment id), for a picker that shows faces. */
  photoPath?: string | null;
}

/** The reminder offsets the API accepts (REMINDER_MINUTES in shared/activities.ts). */
export const REMINDERS = [
  { value: '', label: 'No reminder' },
  { value: '15', label: '15 minutes before' },
  { value: '60', label: '1 hour before' },
  { value: '120', label: '2 hours before' },
  { value: '1440', label: '1 day before' },
];

/** How a booking may repeat (REPEAT_EVERY in shared/activities.ts). */
export const REPEATS = [
  { value: '', label: 'Does not repeat' },
  { value: 'DAY', label: 'Every day' },
  { value: 'WEEK', label: 'Every week' },
  { value: 'MONTH', label: 'Every month' },
];

/** Local wall-clock value for a datetime-local input. */
export function toLocalInput(d: Date): string {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
