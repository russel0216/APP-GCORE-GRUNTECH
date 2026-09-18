import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

/**
 * Notification centre (model §8).
 *
 * The rule that matters: `link` points at the actual record, never at a list
 * screen. A notification that drops you on "Purchase Requests" and leaves you
 * to find the one that needs you is not a notification, it is a reminder to go
 * looking.
 */
export type NotificationType =
  | 'approval.required'
  | 'approval.approved'
  | 'approval.rejected'
  | 'approval.returned'
  | 'quotation.awaiting'
  | 'project.behind_schedule'
  | 'po.received'
  | 'invoice.overdue'
  | 'leave.awaiting'
  | 'overtime.awaiting'
  | 'pm.due'
  | 'borrow.overdue'
  | 'system';

export interface NotifyInput {
  userId: string;
  type: NotificationType;
  title: string;
  body?: string;
  /** Deep link to the record, e.g. /g-ops/quotations/abc123 */
  link?: string;
}

export async function notify(
  input: NotifyInput | NotifyInput[],
  tx: Prisma.TransactionClient = prisma,
): Promise<void> {
  const list = Array.isArray(input) ? input : [input];
  if (!list.length) return;
  await tx.notification.createMany({
    data: list.map((n) => ({
      userId: n.userId,
      type: n.type,
      title: n.title,
      body: n.body ?? null,
      link: n.link ?? null,
    })),
  });
}

export async function unreadCount(userId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, isRead: false } });
}
