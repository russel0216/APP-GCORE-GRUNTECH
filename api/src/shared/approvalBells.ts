import { prisma } from '../prisma';

/**
 * The bells left over from before decided steps cleared their own
 * (GT-HT-2026-0025, 2026-11-26): once, every unread "please decide" bell
 * (`approval.required`, `approval.follow_up`) whose document has NO request
 * waiting any more is marked read — it was approved, returned, rejected or
 * withdrawn long ago. A document still waiting keeps its bells. Kept, never
 * deleted: the bell's All list still shows them. Marked so it runs once.
 */
const MARK = 'seed.approvalBellsCleared20261126';

export async function clearDecidedApprovalBells(): Promise<number | null> {
  if (await prisma.setting.findUnique({ where: { key: MARK } })) return null;
  const waiting = await prisma.approvalRequest.findMany({
    where: { status: 'PENDING', link: { not: null } },
    select: { link: true },
  });
  const open = [...new Set(waiting.map((r) => r.link!))];
  const done = await prisma.notification.updateMany({
    where: {
      isRead: false,
      type: { in: ['approval.required', 'approval.follow_up'] },
      ...(open.length ? { link: { notIn: open } } : {}),
    },
    data: { isRead: true, readAt: new Date() },
  });
  await prisma.setting.create({ data: { key: MARK, value: { at: new Date().toISOString(), cleared: done.count } } });
  return done.count;
}
