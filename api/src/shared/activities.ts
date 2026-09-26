import { Prisma } from '@prisma/client';

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
      ...(assignedToId ? { assignedToId } : {}),
    },
    orderBy: { startsAt: forRecord ? 'desc' : 'asc' },
  };
}
