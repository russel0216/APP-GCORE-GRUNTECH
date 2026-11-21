import { prisma } from '../prisma';
import { env } from '../env';
import { addDays, dayKey, daysBetween, manilaMinutesOfDay } from './day';
import { mailConfig, sendMail } from './mail';
import { notify } from './notifications';
import { formatDate, formatMoney } from './pdf';

/**
 * Liquidation reminders (2026-11-21, the owner's call): cash released on a
 * budget or travel request is accounted for by its deadline. The requester
 * is told three days before it (`liquidationReminderAt`) and on the day it
 * falls due (`liquidationDueNoticeAt`) — each ONCE, claimed with a
 * conditional update before anybody is told, so two ticks or two processes
 * never send it twice. From 08:00 Manila, on the activity reminders' minute
 * tick; a reminder whose moment passed while the API was down still goes,
 * and one for a request already liquidated (or with its liquidation filed)
 * never does. Past the deadline, a new request is refused
 * (`overdueLiquidationOf`, routes/budgetRequests.ts).
 */
export const REMIND_DAYS_BEFORE = 3;
const FROM_MINUTE = 8 * 60;

/** A liquidation filed and not refused: the requester's part is done. */
const FILED = ['PENDING_APPROVAL', 'APPROVED', 'SETTLED', 'REIMBURSED'] as const;

export async function sendLiquidationReminders(now = new Date()): Promise<number> {
  if (manilaMinutesOfDay(now) < FROM_MINUTE) return 0;
  const today = dayKey(now);
  const soon = addDays(today, REMIND_DAYS_BEFORE);
  const due = await prisma.budgetRequest.findMany({
    where: {
      status: 'RELEASED',
      liquidationDueDate: { not: null, lte: soon },
      OR: [{ liquidationReminderAt: null }, { liquidationDueNoticeAt: null, liquidationDueDate: { lte: today } }],
      liquidations: { none: { status: { in: [...FILED] } } },
    },
    select: { id: true, number: true, isTravel: true, reason: true, amountReleased: true, liquidationDueDate: true, liquidationReminderAt: true, liquidationDueNoticeAt: true, requestedById: true },
    take: 200,
  });
  let sent = 0;
  for (const r of due) {
    const dueOn = r.liquidationDueDate!;
    const late = daysBetween(dueOn, today);
    const onTheDay = late >= 0;
    // Claim the notice first: only the process whose update lands tells anybody.
    const claimed = onTheDay
      ? await prisma.budgetRequest.updateMany({
          where: { id: r.id, status: 'RELEASED', liquidationDueNoticeAt: null },
          data: { liquidationDueNoticeAt: now, ...(r.liquidationReminderAt ? {} : { liquidationReminderAt: now }) },
        })
      : await prisma.budgetRequest.updateMany({ where: { id: r.id, status: 'RELEASED', liquidationReminderAt: null }, data: { liquidationReminderAt: now } });
    if (!claimed.count) continue;
    const what = r.isTravel ? 'travel request' : 'budget request';
    const title = onTheDay
      ? late === 0
        ? `Liquidate ${r.number} today`
        : `${r.number} is ${late} day${late === 1 ? '' : 's'} past its liquidation deadline`
      : `Liquidate ${r.number} by ${formatDate(dueOn)}`;
    const body =
      `${formatMoney(Number(r.amountReleased))} released on your ${what} — ${r.reason}. ` +
      (onTheDay
        ? 'File the liquidation with your receipts. Until it is filed you cannot raise a new budget or travel request.'
        : `File the liquidation with your receipts before ${formatDate(dueOn)}.`);
    const link = `/g-ops/${r.isTravel ? 'travel-requests' : 'budget-requests'}/${r.id}`;
    await notify({ userId: r.requestedById, type: 'system', title, body, link });
    const cfg = mailConfig();
    if (cfg) {
      const person = await prisma.user.findUnique({ where: { id: r.requestedById }, select: { name: true, email: true, isActive: true } });
      if (person?.isActive) {
        try {
          await sendMail({ to: person.email, toName: person.name, subject: title, text: `${body}\n\n${env.appUrl.replace(/\/+$/, '')}${link}` }, cfg);
        } catch (err) {
          console.error('Liquidation reminder email failed:', err);
        }
      }
    }
    sent++;
  }
  return sent;
}
