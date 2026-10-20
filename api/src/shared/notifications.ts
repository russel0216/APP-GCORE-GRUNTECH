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
  | 'approval.withdrawn'
  /** The requester followed up an unanswered step to the approver's manager (2026-10-17). */
  | 'approval.follow_up'
  | 'quotation.awaiting'
  | 'project.behind_schedule'
  | 'po.received'
  | 'warehouse.not_posted'
  | 'borrow.to_release'
  | 'borrow.released'
  | 'borrow.cancelled'
  | 'pullout.done'
  // An approved invoice request raised a draft invoice, or could not (2026-10-15).
  | 'invoice_request.invoiced'
  | 'invoice_request.not_invoiced'
  /** The automatic reorder added an item to a draft replenishment (2026-10-15). */
  | 'reorder.raised'
  /** Outgoing as the receive proof (2026-10-15): issued to you, and confirmed received. */
  | 'warehouse.issued_to_you'
  | 'warehouse.received'
  | 'invoice.overdue'
  | 'leave.awaiting'
  | 'overtime.awaiting'
  | 'pm.due'
  | 'borrow.overdue'
  | 'clearance.raised'
  | 'clearance.cleared'
  | 'meeting.invited'
  | 'meeting.updated'
  | 'meeting.cancelled'
  /** The minutes went out for the attendees to agree (2026-10-14), and an attendee answered. */
  | 'minutes.to_agree'
  | 'minutes.answered'
  | 'evaluation.due'
  | 'training.enrolled'
  | 'training.assigned'
  | 'training.rescheduled'
  | 'training.cancelled'
  | 'training.completed'
  | 'training.expiring'
  | 'activity.invited'
  | 'activity.updated'
  | 'activity.reminder'
  /** An invitee answered Going / Maybe / Not going — told to whoever booked it. */
  | 'activity.responded'
  /** A birthday or work-anniversary greeting (shared/celebrations.ts). */
  | 'greeting'
  /** CAD job orders (2026-10-09): a new request to the design team, an assignment, a revision, a comment, a change of status or priority. */
  | 'cad.requested'
  | 'cad.assigned'
  | 'cad.revision'
  | 'cad.comment'
  | 'cad.updated'
  /** The Help box (2026-10-11): a new ticket to the super admins, a reply or a change of status to the other side. */
  | 'help.ticket'
  | 'help.reply'
  /** Memos (2026-10-20): a memo issued to you, and a reminder to acknowledge it. */
  | 'memo.issued'
  | 'memo.reminder'
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
