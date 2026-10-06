import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { env } from '../env';
import { mailConfig, sendMail } from './mail';
import { notify, type NotificationType } from './notifications';
import { formatDateTime } from './pdf';
import { manilaDayKey } from './day';

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

// ── Invitees, reminders, and telling people ──────────────────────────────────

/** The reminder offsets the form offers, in minutes before the start. */
export const REMINDER_MINUTES = [15, 60, 120, 1440] as const;

/** The longest an activity may run: a site visit can take most of a week. */
export const MAX_ACTIVITY_MINUTES = 7 * 1440;

/** Where a notification about an activity lands: the activity, on its Manila day. */
export function activityLink(a: { id: string; startsAt: Date }): string {
  return `/g-ops/calendar?activity=${a.id}&date=${manilaDayKey(a.startsAt)}`;
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
          text: `${message.title}\n\n${message.body}\n\nOpen it in G-CORE: ${url}\n`,
        },
        cfg,
      );
    } catch (err) {
      console.error(`Activity email to ${person.email} failed:`, err instanceof Error ? err.message : err);
    }
  }
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

/** Runs `sendDueReminders` once a minute in the API process. Idempotent. */
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
    } finally {
      running = false;
    }
  };
  reminderTimer = setInterval(() => void tick(), 60_000);
  reminderTimer.unref();
  void tick();
}
