import { prisma } from '../prisma';
import { audit } from './audit';
import { D, num, refreshBudgetRequest } from './finance';

const MARK = 'seed.travelSplit20261121';

/**
 * Once (2026-11-21, the split travel request): a travel request finance
 * booked and paid before the split was booked WHOLE — its every line is the
 * finance part, its payment allocations bookings. Marked here so the new
 * arithmetic (`refreshBudgetRequest()`: bookings spent at once, only the cash
 * part released and liquidated) reads them as they were paid. Every other
 * request has no finance part and reads as before.
 */
export async function markBookedTravelRequests(): Promise<number | null> {
  if (await prisma.setting.findUnique({ where: { key: MARK } })) return null;
  const rows = await prisma.budgetRequest.findMany({ where: { isTravel: true, paidDirect: true }, select: { id: true, number: true, amount: true } });
  for (const r of rows) {
    await prisma.$transaction(async (tx) => {
      await tx.budgetRequestItem.updateMany({ where: { requestId: r.id }, data: { financePays: true } });
      await tx.budgetRequest.update({ where: { id: r.id }, data: { financePart: D(num(r.amount)) } });
      await tx.paymentAllocation.updateMany({ where: { budgetRequestId: r.id, payment: { kind: 'DISBURSEMENT' } }, data: { booking: true } });
      await refreshBudgetRequest(tx, r.id);
    });
    await audit({
      entityType: 'budget_request',
      entityId: r.id,
      action: 'UPDATED',
      summary: `${r.number}: booked by finance before the split — every line marked as finance's to book`,
      actorName: 'system',
    });
  }
  await prisma.setting.upsert({
    where: { key: MARK },
    create: { key: MARK, value: { at: new Date().toISOString(), requests: rows.length }, description: 'Travel requests booked whole before the split, marked once, 2026-11-21' },
    update: {},
  });
  return rows.length;
}
