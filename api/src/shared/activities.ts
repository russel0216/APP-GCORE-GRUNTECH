import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { env } from '../env';
import { badRequest } from '../http/kit';
import { mailConfig, sendMail } from './mail';
import { notify, type NotificationType } from './notifications';
import { formatDateTime } from './pdf';
import { manilaDayKey } from './day';
import { sendDueGreetings } from './celebrations';

/**
 * The one place that decides which sales activities a query means.
 *
 * Two questions, one table.
 *
 * The calendar asks "what is happening between these dates" and wants a
 * window. A record asks "what has anyone ever done about this", and a window
 * is exactly wrong for it — the call that mattered was in March. Naming a
 * record drops the window and returns its whole history, newest first,
 * because a log is read from the top.
 *
 * Shared so the route and the calendar's verification read the same rule —
 * an inclusive `lte`, a 14-day default, the window dropped for a record.
 */

export interface ActivityQuery {
  from?: string;
  to?: string;
  leadId?: string;
  quotationId?: string;
  customerId?: string;
  assignedToId?: string;
}

export function activityWhere(q: ActivityQuery): {
  where: Prisma.SalesActivityWhereInput;
  orderBy: Prisma.SalesActivityOrderByWithRelationInput;
} {
  const assignedToId = q.assignedToId ? String(q.assignedToId) : undefined;

  const leadId = q.leadId ? String(q.leadId) : undefined;
  const quotationId = q.quotationId ? String(q.quotationId) : undefined;
  const customerId = q.customerId ? String(q.customerId) : undefined;
  const forRecord = leadId || quotationId || customerId;

  const from = q.from ? new Date(String(q.from)) : new Date();
  const to = q.to ? new Date(String(q.to)) : new Date(from.getTime() + 14 * 86400000);

  return {
    where: {
      ...(forRecord ? {} : { startsAt: { gte: from, lte: to } }),
      ...(leadId ? { leadId } : {}),
      ...(quotationId ? { quotationId } : {}),
      ...(customerId ? { customerId } : {}),
      // "Whose activities": the ones they are booked for AND the ones they
      // are invited to — an invitee's calendar shows what they were asked to.
      ...(assignedToId ? { OR: [{ assignedToId }, { invitees: { some: { userId: assignedToId } } }] } : {}),
    },
    orderBy: { startsAt: forRecord ? 'desc' : 'asc' },
  };
}

// ── SCORO's New event dialog (2026-10-08): repeats and "Personal" ───────────

/** How often a repeating booking recurs, and the most occurrences one save may make. */
export const REPEAT_EVERY = ['DAY', 'WEEK', 'MONTH'] as const;
export type RepeatEvery = (typeof REPEAT_EVERY)[number];
export const MAX_OCCURRENCES = 60;

/** Manila's offset: no daylight saving, so a fixed shift makes wall-clock arithmetic exact. */
const MANILA_OFFSET_MS = 8 * 3_600_000;

/**
 * `months` after `d` on the Manila wall clock, keeping the time of day and
 * the day of month, clamped to the month's end — counted from the FIRST
 * date each time, so a booking on the 31st falls on 28 February and is back
 * on 31 March, which is what a monthly call means.
 */
function addMonthsManila(d: Date, months: number): Date {
  const local = new Date(d.getTime() + MANILA_OFFSET_MS);
  const day = local.getUTCDate();
  local.setUTCDate(1);
  local.setUTCMonth(local.getUTCMonth() + months);
  const last = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 0)).getUTCDate();
  local.setUTCDate(Math.min(day, last));
  return new Date(local.getTime() - MANILA_OFFSET_MS);
}

/**
 * The starts of a repeating booking: the first, then every day, week or
 * month after it, up to and including the last Manila day `until` names.
 * Each occurrence is an ordinary activity (`seriesId` = the first's id); no
 * rule row, so a later occurrence moved on its own stays moved. More than
 * MAX_OCCURRENCES is refused: a year of daily calls is 365 rows nobody
 * meant, and the form asked for an end date.
 */
export function repeatOccurrences(first: Date, every: RepeatEvery, until: string): Date[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) throw badRequest('Repeat until needs a date');
  if (until < manilaDayKey(first)) throw badRequest('Repeat until must be on or after the first day');
  const out: Date[] = [];
  for (let n = 0; ; n++) {
    const at = every === 'MONTH' ? addMonthsManila(first, n) : new Date(first.getTime() + n * (every === 'DAY' ? 1 : 7) * 86_400_000);
    if (manilaDayKey(at) > until) break;
    out.push(at);
    if (out.length > MAX_OCCURRENCES) throw badRequest(`That repeats more than ${MAX_OCCURRENCES} times — bring the end date closer`);
  }
  return out;
}

/** Whether this person is on the activity: booked for it, invited, or the one who booked it. */
export function isOnActivity(
  a: { assignedToId: string; createdById?: string | null; invitees?: { userId: string }[] },
  userId: string,
): boolean {
  return a.assignedToId === userId || a.createdById === userId || (a.invitees ?? []).some((i) => i.userId === userId);
}

/**
 * SCORO's "Personal": a private activity shows the people on it everything,
 * and everyone else only that the time is taken — "Busy", with no notes,
 * address, call link, links or invitees. Every read that leaves the API
 * goes through it (the list and the one; My Work lists only the viewer's
 * own). A super admin sees it whole, as they do every record.
 */
export function maskPrivate<
  A extends { isPrivate: boolean; assignedToId: string; createdById?: string | null; invitees?: { userId: string }[] },
>(a: A, viewer: { id: string; isSuperAdmin: boolean }): A & { masked?: boolean } {
  if (!a.isPrivate || viewer.isSuperAdmin || isOnActivity(a, viewer.id)) return a;
  return {
    ...a,
    subject: 'Busy',
    notes: null,
    location: null,
    callLink: null,
    lead: null,
    quotation: null,
    customer: null,
    contact: null,
    job: null,
    leadId: null,
    quotationId: null,
    customerId: null,
    contactId: null,
    jobId: null,
    reminderMinutes: null,
    invitees: [],
    responses: undefined,
    masked: true,
  };
}

// ── Invitees, reminders, and telling people ──────────────────────────────────

/** The reminder offsets the form offers, in minutes before the start. */
export const REMINDER_MINUTES = [15, 60, 120, 1440] as const;

/** The longest an activity may run: a site visit can take most of a week. */
export const MAX_ACTIVITY_MINUTES = 7 * 1440;

/**
 * Where a notification about an activity lands: the activity's own page
 * (2026-10-08, SCORO's event page — it was `?activity=` on the calendar,
 * which still redirects there).
 */
export function activityLink(a: { id: string }): string {
  return `/g-ops/calendar/activities/${a.id}`;
}

/**
 * Tells people about an activity: a bell notification each, and — when email
 * is set up — an email to each, sent after the notifications are written and
 * never allowed to fail the save (a mail server that is down costs an email,
 * not the activity). No SMS: the owner's call.
 */
export async function tellAboutActivity(
  userIds: string[],
  message: { type: NotificationType; title: string; body: string; link: string },
  /** `respondLinks`: an invitation — the email carries Going / Not going / Maybe links (2026-10-08). */
  opts: { respondLinks?: boolean } = {},
): Promise<void> {
  const ids = [...new Set(userIds)];
  if (!ids.length) return;
  await notify(ids.map((userId) => ({ userId, ...message })));
  const cfg = mailConfig();
  if (!cfg) return;
  const people = await prisma.user.findMany({
    where: { id: { in: ids }, isActive: true },
    select: { name: true, email: true },
  });
  const url = `${env.appUrl.replace(/\/+$/, '')}${message.link}`;
  for (const person of people) {
    try {
      await sendMail(
        {
          to: person.email,
          toName: person.name,
          subject: message.title,
          text: activityEmailText(message, url, opts.respondLinks ?? false),
        },
        cfg,
      );
    } catch (err) {
      console.error(`Activity email to ${person.email} failed:`, err instanceof Error ? err.message : err);
    }
  }
}

/**
 * The plain-text email about an activity. An invitation adds the answers as
 * links: the activity's page opens and records the answer the link carries
 * (`?respond=`), so "Going" is one tap from the inbox.
 */
export function activityEmailText(message: { title: string; body: string }, url: string, respondLinks = false): string {
  const lines = [message.title, '', message.body, '', `Open it in G-CORE: ${url}`];
  if (respondLinks) {
    const answer = (r: string) => `${url}${url.includes('?') ? '&' : '?'}respond=${r}`;
    lines.push('', 'Let them know:', `Going: ${answer('ACCEPTED')}`, `Not going: ${answer('DECLINED')}`, `Maybe: ${answer('TENTATIVE')}`);
  }
  return `${lines.join('\n')}\n`;
}

/** "Thu, Oct 8, 2026, 9:00 AM – 10:30 AM", Manila time, for a notification. */
export function activityWhen(a: { startsAt: Date; durationMinutes: number }): string {
  const end = new Date(a.startsAt.getTime() + a.durationMinutes * 60_000);
  const sameDay = manilaDayKey(end) === manilaDayKey(a.startsAt);
  const endText = formatDateTime(end);
  return `${formatDateTime(a.startsAt)} – ${sameDay ? endText.replace(/^.*?(\d{1,2}:\d{2}\s?[AP]M)$/i, '$1') : endText}`;
}

/**
 * Sends every reminder that is due: a PLANNED activity with a reminder, not
 * yet reminded, whose start is still ahead and whose reminder time has come.
 * Each is CLAIMED with a conditional update before anyone is told, so two
 * ticks (or two API processes) never send it twice. Returns how many went.
 *
 * G-CORE has no scheduler; the API runs this once a minute
 * (`startActivityReminders`). A reminder whose moment passed while the API
 * was down still goes out late, as long as the activity has not started.
 */
export async function sendDueReminders(now = new Date()): Promise<number> {
  const horizon = new Date(now.getTime() + Math.max(...REMINDER_MINUTES) * 60_000);
  const candidates = await prisma.salesActivity.findMany({
    where: {
      status: 'PLANNED',
      reminderMinutes: { not: null },
      reminderSentAt: null,
      startsAt: { gt: now, lte: horizon },
    },
    select: {
      id: true,
      subject: true,
      startsAt: true,
      durationMinutes: true,
      reminderMinutes: true,
      location: true,
      assignedToId: true,
      invitees: { select: { userId: true } },
    },
  });
  let sent = 0;
  for (const a of candidates) {
    if (a.startsAt.getTime() - a.reminderMinutes! * 60_000 > now.getTime()) continue;
    const claimed = await prisma.salesActivity.updateMany({
      where: { id: a.id, reminderSentAt: null, status: 'PLANNED', startsAt: a.startsAt, reminderMinutes: a.reminderMinutes },
      data: { reminderSentAt: now },
    });
    if (!claimed.count) continue;
    sent++;
    await tellAboutActivity([a.assignedToId, ...a.invitees.map((i) => i.userId)], {
      type: 'activity.reminder',
      title: `Reminder: ${a.subject}`,
      body: `${activityWhen(a)}${a.location ? ` · ${a.location}` : ''}`,
      link: activityLink(a),
    });
  }
  return sent;
}

let reminderTimer: NodeJS.Timeout | null = null;

/**
 * Runs `sendDueReminders` once a minute in the API process — and, on the
 * same tick, the day's birthday and work-anniversary greetings
 * (shared/celebrations.ts), which claim their own rows so a minute's tick
 * is as safe as a day's. Idempotent.
 */
export function startActivityReminders(): void {
  if (reminderTimer) return;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await sendDueReminders();
    } catch (err) {
      console.error('Activity reminders failed:', err);
    }
    try {
      await sendDueGreetings();
    } catch (err) {
      console.error('Greetings failed:', err);
    } finally {
      running = false;
    }
  };
  reminderTimer = setInterval(() => void tick(), 60_000);
  reminderTimer.unref();
  void tick();
}
