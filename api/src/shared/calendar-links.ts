import { badRequest } from '../http/kit';

/**
 * Calendar hand-offs — pure functions, no HTTP, no credentials.
 *
 * G-Core holds no Google account. A meeting or a training session is handed
 * to the organiser's own calendar two ways: a pre-filled Google Calendar link
 * (the invitees become guests, so Google sends the email), and an RFC 5545
 * `.ics` file that any calendar imports. The Meet link comes BACK the same
 * way — pasted from the event Google created — and `parseGoogleLink` is what
 * tells a Meet link from a Calendar event link from a typo.
 *
 * Both Meeting and TrainingSession call these; neither owns them. A change
 * here changes what every calendar file in the system looks like.
 */

export interface CalendarEventInput {
  /** A stable id for the record — the row id. Combined with the app host for the UID. */
  uid: string;
  /** The document number, printed on the first line of the description. */
  number: string;
  title: string;
  description?: string | null;
  location?: string | null;
  startsAt: Date;
  endsAt: Date;
  /**
   * RFC 5545 SEQUENCE — bumped on every time change so a re-downloaded file
   * replaces the event in the guest's calendar instead of duplicating it.
   */
  sequence: number;
  cancelled: boolean;
  /** App path of the record, e.g. /g-hr/meetings/abc — appended to appUrl. */
  url?: string | null;
}

export interface CalendarPerson {
  name: string;
  email: string;
  /** Optional attendees are marked OPT-PARTICIPANT. Defaults to required. */
  required?: boolean;
}

/** The company's calendar time zone, for the Google URL's `ctz`. */
const TIME_ZONE = 'Asia/Manila';

// ── The three RFC 5545 primitives ────────────────────────────────────────────

/** A UTC timestamp in the form the format wants: 20260927T093000Z. */
export function icsStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** Escapes a text value (§3.3.11): backslash, semicolon, comma and newline. */
export function icsText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Folds one content line at 75 octets (§3.1): a CRLF followed by a single
 * space continues it. Counted in bytes, not characters — a description with
 * accents or an em dash would otherwise overrun the limit on the very
 * lines that look short.
 */
export function icsFold(line: string): string {
  const out: string[] = [];
  let current = '';
  let limit = 75;
  for (const ch of line) {
    if (Buffer.byteLength(current + ch, 'utf8') > limit) {
      out.push(current);
      current = ' ';
      // The continuation line's leading space counts toward its 75.
      limit = 75;
    }
    current += ch;
  }
  out.push(current);
  return out.join('\r\n');
}

function hostOf(appUrl: string): string {
  try {
    return new URL(appUrl).host || 'gcore';
  } catch {
    return 'gcore';
  }
}

function absoluteUrl(appUrl: string, path: string | null | undefined): string | null {
  if (!path) return null;
  return `${appUrl.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

/** The description as both hand-offs print it: number, the text, the link. */
function describe(ev: CalendarEventInput, appUrl: string): string {
  return [ev.number, ev.description?.trim() || null, absoluteUrl(appUrl, ev.url)]
    .filter((s): s is string => Boolean(s))
    .join('\n');
}

// ── The .ics file ────────────────────────────────────────────────────────────

/**
 * One VEVENT in a VCALENDAR. METHOD is REQUEST for a live event and CANCEL
 * once it is cancelled, so importing the second file withdraws the first.
 * The UID never changes for a record; SEQUENCE is what tells calendars which
 * copy is newer.
 */
export function buildIcs(
  ev: CalendarEventInput,
  organizer: CalendarPerson,
  attendees: CalendarPerson[],
  appUrl: string,
): string {
  const link = absoluteUrl(appUrl, ev.url);
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//G-CORE//Gruntechnology Corp//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${ev.cancelled ? 'CANCEL' : 'REQUEST'}`,
    'BEGIN:VEVENT',
    `UID:${ev.uid}@${hostOf(appUrl)}`,
    `SEQUENCE:${Math.max(0, Math.floor(ev.sequence))}`,
    `DTSTAMP:${icsStamp(new Date())}`,
    `DTSTART:${icsStamp(ev.startsAt)}`,
    `DTEND:${icsStamp(ev.endsAt)}`,
    `SUMMARY:${icsText(ev.title)}`,
    `DESCRIPTION:${icsText(describe(ev, appUrl))}`,
  ];
  if (ev.location?.trim()) lines.push(`LOCATION:${icsText(ev.location.trim())}`);
  if (link) lines.push(`URL:${link}`);
  lines.push(`STATUS:${ev.cancelled ? 'CANCELLED' : 'CONFIRMED'}`);
  lines.push(`ORGANIZER;CN=${quoteParam(organizer.name)}:mailto:${organizer.email}`);
  for (const a of attendees) {
    lines.push(
      `ATTENDEE;CN=${quoteParam(a.name)};ROLE=${a.required === false ? 'OPT-PARTICIPANT' : 'REQ-PARTICIPANT'}` +
        `;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${a.email}`,
    );
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

/** A parameter value (§3.2) — quoted when it carries the characters that end one. */
function quoteParam(value: string): string {
  const clean = value.replace(/["\r\n]/g, ' ').trim();
  return /[;:,]/.test(clean) ? `"${clean}"` : clean;
}

// ── The Google Calendar hand-off ─────────────────────────────────────────────

/**
 * A pre-filled "create event" link. Google fills the form from the query
 * string; the organiser presses Save in their own account, the guests get
 * Google's email, and the Meet link the event was given is what gets pasted
 * back into G-Core.
 */
export function googleCalendarUrl(
  ev: CalendarEventInput,
  guests: { email: string }[],
  appUrl: string,
): string {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: ev.title,
    dates: `${icsStamp(ev.startsAt)}/${icsStamp(ev.endsAt)}`,
    details: describe(ev, appUrl),
    ctz: TIME_ZONE,
  });
  if (ev.location?.trim()) params.set('location', ev.location.trim());
  const emails = guests.map((g) => g.email.trim()).filter(Boolean);
  if (emails.length) params.set('add', emails.join(','));
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// ── What came back ───────────────────────────────────────────────────────────

export interface ParsedGoogleLink {
  /** https://meet.google.com/abc-defg-hij, normalised. */
  meetLink: string | null;
  /** The Google Calendar event page, as pasted. */
  calendarEventUrl: string | null;
}

const MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i;

/**
 * Sorts a pasted link into a Meet link or a Calendar event link, and refuses
 * anything else with a message that says what to paste. An empty paste
 * clears both — the caller decides whether that is allowed.
 *
 * A bare Meet code (abc-defg-hij) is accepted and given its URL; anything on
 * the Meet host other than a room code is refused, because a link that is
 * not a room is a link nobody can join.
 */
export function parseGoogleLink(raw: string | null | undefined): ParsedGoogleLink {
  const text = (raw ?? '').trim();
  if (!text) return { meetLink: null, calendarEventUrl: null };

  if (MEET_CODE.test(text)) {
    return { meetLink: `https://meet.google.com/${text.toLowerCase()}`, calendarEventUrl: null };
  }

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw badRequest(
      'Paste a Google Meet link (https://meet.google.com/abc-defg-hij) or the Google Calendar event link',
    );
  }
  const host = url.host.toLowerCase();

  if (host === 'meet.google.com') {
    const code = url.pathname.replace(/^\/+|\/+$/g, '');
    if (!MEET_CODE.test(code)) {
      throw badRequest('That is a Google Meet address but not a room — a room looks like meet.google.com/abc-defg-hij');
    }
    return { meetLink: `https://meet.google.com/${code.toLowerCase()}`, calendarEventUrl: null };
  }

  const isCalendar =
    (host === 'calendar.google.com' || host === 'www.google.com' || host === 'google.com') &&
    /\/calendar\b|\/event\b/i.test(url.pathname) &&
    (url.searchParams.has('eid') || /\/event\b/i.test(url.pathname));
  if (isCalendar) {
    url.protocol = 'https:';
    return { meetLink: null, calendarEventUrl: url.toString() };
  }

  throw badRequest(
    'Paste a Google Meet link (https://meet.google.com/abc-defg-hij) or the Google Calendar event link',
  );
}

// ── The time slot ────────────────────────────────────────────────────────────

/**
 * Validates a start and end as one slot: both real instants, the end after
 * the start, and no longer than `maxHours` — a meeting that "ends" next
 * month is a typo in the date, not a long meeting.
 */
export function timeWindow(
  startsAt: string | Date,
  endsAt: string | Date,
  maxHours = 24,
): { startsAt: Date; endsAt: Date; minutes: number } {
  const start = startsAt instanceof Date ? startsAt : new Date(startsAt);
  const end = endsAt instanceof Date ? endsAt : new Date(endsAt);
  if (Number.isNaN(start.getTime())) throw badRequest('When does it start?');
  if (Number.isNaN(end.getTime())) throw badRequest('When does it end?');
  const minutes = Math.round((end.getTime() - start.getTime()) / 60000);
  if (minutes <= 0) throw badRequest('It ends before it starts');
  if (minutes > maxHours * 60) {
    throw badRequest(`That runs longer than ${maxHours} hours — check the end date`);
  }
  return { startsAt: start, endsAt: end, minutes };
}
