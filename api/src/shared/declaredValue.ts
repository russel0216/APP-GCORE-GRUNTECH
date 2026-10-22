import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { PULLED_BACK, reverseJobCost } from './inventory';

const num = (v: Prisma.Decimal | number | null | undefined) => (v == null ? 0 : Number(v));
const cents = (v: number) => Math.round(v * 100) / 100;

/**
 * The declared-value rule of 2026-10-22 (the owner's call: "the declared
 * value in the purchase request should be the one to subtract in budget
 * monitoring — the purchaser or importer is the one who manually inputs the
 * price"), applied ONCE to the orders issued before it
 * (`seed.declaredValueRule20261022`).
 *
 * Until then an order's issue released its request's commitment ("Superseded
 * by order …") and committed the order's typed price. For every such
 * direct-to-job order from a request still standing (issued, partly or fully
 * received), in one transaction each:
 *   - the order's own COMMITTED rows are reversed (net — what the receipts
 *     had not yet released);
 *   - the request's commitment is restored at the DECLARED estimate of the
 *     quantity not yet received, under the issue's own release words with
 *     " — pulled back" after them, so a later pull-back of the order (refused
 *     anyway once goods arrived) finds nothing left to restore.
 * The goods already received stay charged at the price they were charged at.
 * Returns the orders moved, or null when it had run.
 */
export async function applyDeclaredValueRule(prisma: PrismaClient, opts: { only?: string[] } = {}): Promise<number | null> {
  const MARK = 'seed.declaredValueRule20261022';
  // `only` is the verify script's: those orders alone, and no mark written.
  if (!opts.only && (await prisma.setting.findUnique({ where: { key: MARK } }))) return null;
  const orders = await prisma.purchaseOrder.findMany({
    where: {
      kind: 'DIRECT_TO_JOB',
      jobId: { not: null },
      requestId: { not: null },
      status: { in: ['ISSUED', 'PARTIALLY_RECEIVED', 'RECEIVED'] },
      ...(opts.only ? { id: { in: opts.only } } : {}),
    },
    include: { items: { include: { requestItem: { select: { estimatedCost: true, costCategoryId: true } } } } },
  });
  let moved = 0;
  for (const po of orders) {
    const supersededWords = `Superseded by order ${po.number}`;
    const ownCommitted = await prisma.jobCostEntry.aggregate({
      where: { sourceType: 'purchase_order', sourceId: po.id, state: 'COMMITTED' },
      _sum: { amount: true },
    });
    const ownNet = num(ownCommitted._sum.amount);
    // An order still committing its own price is one issued under the price
    // rule with goods to come; one committing nothing was issued under the
    // new rule, fully received, or put right already — nothing to move.
    if (Math.abs(ownNet) < 0.005) continue;
    await prisma.$transaction(async (tx) => {
      const why = `${po.number} — the declared value rule of 2026-10-22: the request's estimate is what Budget Monitoring counts`;
      await reverseJobCost(tx, { sourceType: 'purchase_order', sourceId: po.id, states: ['COMMITTED'], reason: why, sourceNumber: po.number });
      const restore = new Map<string, number>();
      for (const line of po.items) {
        const category = line.requestItem?.costCategoryId ?? line.costCategoryId;
        if (!line.requestItem || !category) continue;
        const left = Math.max(0, num(line.quantity) - num(line.receivedQty));
        const declared = cents(left * num(line.requestItem.estimatedCost));
        if (declared > 0) restore.set(category, cents((restore.get(category) ?? 0) + declared));
      }
      for (const [costCategoryId, amount] of restore) {
        await tx.jobCostEntry.create({
          data: {
            jobId: po.jobId!,
            costCategoryId,
            state: 'COMMITTED',
            amount: new Prisma.Decimal(amount),
            sourceType: 'purchase_request',
            sourceId: po.requestId!,
            sourceNumber: null,
            description: supersededWords + PULLED_BACK,
          },
        });
      }
      await tx.auditLog.create({
        data: {
          entityType: 'purchase_order',
          entityId: po.id,
          action: 'UPDATED',
          summary: `${po.number} — Budget Monitoring now counts its request's declared value (restored ${[...restore.values()].reduce((s, v) => s + v, 0).toFixed(2)}), not the order's price`,
        },
      });
    });
    moved++;
  }
  if (!opts.only) await prisma.setting.create({ data: { key: MARK, value: { at: new Date().toISOString(), moved } } });
  return moved;
}
