import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { BASE_CURRENCY, exchangeRates, storedRate } from './exchangeRates';
import { audit } from './audit';
import { postJobCost } from './inventory';

/**
 * What a purchase order line costs IN PESOS (2026-10-23, the owner's call:
 * "the purchase order is USD but when it enters inventory it is PHP — I want
 * the real cost reflected … the incoming report's value based on the
 * purchase request's PHP even if the purchase order is in USD").
 *
 * The ONE rule, read by the Incoming report, the stock it builds (company,
 * project or sales order), the job cost it charges and a sales order's spend:
 *
 *   1. the LANDED unit cost the buyer typed on the order line (pesos,
 *      freight and duties in — `PurchaseOrderItem.landedUnitCost`);
 *   2. otherwise a line ordered from a purchase request takes the request's
 *      DECLARED unit cost — already pesos, and what Budget Monitoring
 *      subtracts;
 *   3. otherwise a peso order's own price;
 *   4. otherwise the order's price × the order's own rate to PHP
 *      (`PurchaseOrder.exchangeRate`, taken from Company Settings ›
 *      Exchange rates at save, kept after);
 *   5. a foreign order with no rate has no peso cost — the caller refuses
 *      and says where to set one, never posts the foreign figure as pesos.
 *
 * A cost typed on the Incoming line itself (`ReceivingItem.costTyped`) beats
 * all of them for that receipt. A project's budget is charged the request's
 * declared value whatever this says (the 2026-10-22 rule).
 */
export type CostedOrder = { number: string; currency: string; exchangeRate: Prisma.Decimal | number | null };
export type CostedLine = {
  unitPrice: Prisma.Decimal | number;
  landedUnitCost?: Prisma.Decimal | number | null;
  requestItem?: { estimatedCost: Prisma.Decimal | number } | null;
};
export type CostBasis = 'landed' | 'request' | 'order' | 'converted' | 'no_rate';
export type LineCost = { unitCost: number | null; basis: CostBasis; rate: number | null };

const n = (v: Prisma.Decimal | number | null | undefined) => (v == null ? 0 : Number(v));
const centavo = (v: number) => Math.round(v * 100) / 100;

/** Pesos per unit of the order's currency: 1 for PHP, the order's rate, else null. */
export function orderRate(order: Pick<CostedOrder, 'currency' | 'exchangeRate'>): number | null {
  if (!order.currency || order.currency === BASE_CURRENCY) return 1;
  const r = n(order.exchangeRate);
  return r > 0 ? r : null;
}

/** A figure in the order's own currency, in pesos — null when the order has no rate. */
export function orderInPesos(order: Pick<CostedOrder, 'currency' | 'exchangeRate'>, value: number): number | null {
  const r = orderRate(order);
  return r === null ? null : centavo(value * r);
}

export function receiptUnitCost(order: CostedOrder, line: CostedLine): LineCost {
  if (line.landedUnitCost != null && n(line.landedUnitCost) > 0) return { unitCost: centavo(n(line.landedUnitCost)), basis: 'landed', rate: null };
  const declared = n(line.requestItem?.estimatedCost);
  if (line.requestItem && declared > 0) return { unitCost: centavo(declared), basis: 'request', rate: null };
  const rate = orderRate(order);
  if (rate === 1) return { unitCost: centavo(n(line.unitPrice)), basis: 'order', rate: null };
  if (rate === null) return { unitCost: null, basis: 'no_rate', rate: null };
  return { unitCost: centavo(n(line.unitPrice) * rate), basis: 'converted', rate };
}

/** What an order comes to in pesos, line by line through the rule — null while any line has no peso cost. */
export function orderLandedTotal(order: CostedOrder, lines: Array<CostedLine & { quantity: Prisma.Decimal | number }>): number | null {
  let cents = 0;
  for (const l of lines) {
    const c = receiptUnitCost(order, l).unitCost;
    if (c === null) return null;
    cents += Math.round(c * n(l.quantity) * 100);
  }
  return cents / 100;
}

export function basisWords(cost: LineCost): string {
  switch (cost.basis) {
    case 'landed': return 'the landed cost typed on the order';
    case 'request': return "the request's declared value";
    case 'order': return "the order's price";
    case 'converted': return `the order's price at ${cost.rate} to PHP`;
    default: return 'no rate to PHP';
  }
}

export function noRateMessage(order: Pick<CostedOrder, 'number' | 'currency'>): string {
  return `${order.number} is in ${order.currency} with no rate to PHP — type its rate on the order, or set ${order.currency} in Company Settings › Exchange rates, so the goods are valued in pesos`;
}

/** The rate an order stores at save: none for PHP, the one typed, else Settings'. */
export async function rateForOrder(
  currency: string,
  typed: number | null | undefined,
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<Prisma.Decimal | null> {
  return storedRate(currency, typed, await exchangeRates(db));
}

/**
 * The seed, every deploy: a foreign-currency order with no rate takes
 * Settings' rate for its currency, once Settings has one. Claimed on null,
 * so a rate typed on an order is never overwritten.
 */
export async function fillOrderRates(): Promise<number> {
  const table = await exchangeRates();
  let filled = 0;
  for (const [code, rate] of Object.entries(table)) {
    const r = await prisma.purchaseOrder.updateMany({
      where: { currency: code, exchangeRate: null },
      data: { exchangeRate: new Prisma.Decimal(rate).toDecimalPlaces(6) },
    });
    filled += r.count;
  }
  return filled;
}

/** What restating a received line reads: the line, its receipt, its order line. */
export const RESTATE_SELECT = {
  id: true,
  quantity: true,
  unitCost: true,
  costTyped: true,
  itemId: true,
  receivingId: true,
  receiving: { select: { number: true } },
  orderItem: {
    select: {
      itemId: true,
      unitPrice: true,
      landedUnitCost: true,
      costCategoryId: true,
      requestItem: { select: { estimatedCost: true } },
      order: { select: { id: true, number: true, currency: true, exchangeRate: true, kind: true, jobId: true } },
    },
  },
} satisfies Prisma.ReceivingItemSelect;
export type RestateLine = Prisma.ReceivingItemGetPayload<{ select: typeof RESTATE_SELECT }>;

/**
 * Puts a RECEIVED Incoming line at a new peso unit cost, inside the caller's
 * transaction: the line (claimed on the cost it was read with), its stock
 * movement(s), the average of the shelf it went onto by the value it was off
 * (what remains carries the difference; what already left went at the old
 * average and is not rewritten), the item's last cost, and — for a project
 * line with no request behind it, which was charged at the receipt's cost —
 * the job's INCURRED by the difference. A line from a request was charged at
 * the request's declared value and stays so. False when the line moved
 * meanwhile; nothing is written then.
 */
export async function restateReceiptLine(
  tx: Prisma.TransactionClient,
  line: RestateLine,
  newCost: number,
  opts: { summary: string; after: Record<string, unknown>; actorId?: string; typed?: boolean },
): Promise<boolean> {
  const before = n(line.unitCost);
  const cost = centavo(newCost);
  const claimed = await tx.receivingItem.updateMany({
    where: { id: line.id, unitCost: line.unitCost },
    data: { unitCost: new Prisma.Decimal(cost), ...(opts.typed === undefined ? {} : { costTyped: opts.typed }) },
  });
  if (!claimed.count) return false;
  if (Math.abs(before - cost) < 0.005) return true;
  const qty = n(line.quantity);
  const delta = (cost - before) * qty;
  const itemId = line.itemId ?? line.orderItem?.itemId ?? null;
  const moves = itemId
    ? await tx.inventoryTransaction.findMany({
        where: { sourceType: 'receiving', sourceId: line.receivingId, itemId, type: 'RECEIPT', unitCost: line.unitCost },
        select: { id: true, warehouseId: true, jobId: true, salesOrderId: true },
      })
    : [];
  for (const m of moves) {
    const iid = itemId!;
    await tx.inventoryTransaction.update({ where: { id: m.id }, data: { unitCost: new Prisma.Decimal(cost) } });
    const shift = async (onHand: number, average: number, write: (avg: Prisma.Decimal) => Promise<unknown>) => {
      if (onHand <= 0) return;
      const avg = Math.max(0, average + delta / onHand);
      await write(new Prisma.Decimal(Math.round(avg * 10000) / 10000));
    };
    if (m.jobId) {
      const ps = await tx.projectStock.findFirst({ where: { jobId: m.jobId, itemId: iid, warehouseId: m.warehouseId } });
      if (ps) await shift(n(ps.quantity), n(ps.averageCost), (avg) => tx.projectStock.update({ where: { id: ps.id }, data: { averageCost: avg } }));
    } else if (m.salesOrderId) {
      const ss = await tx.salesOrderStock.findFirst({ where: { salesOrderId: m.salesOrderId, itemId: iid, warehouseId: m.warehouseId } });
      if (ss) await shift(n(ss.quantity), n(ss.averageCost), (avg) => tx.salesOrderStock.update({ where: { id: ss.id }, data: { averageCost: avg } }));
    } else {
      const b = await tx.inventoryBalance.findUnique({ where: { itemId_warehouseId: { itemId: iid, warehouseId: m.warehouseId } } });
      if (b) await shift(n(b.quantity), n(b.averageCost), (avg) => tx.inventoryBalance.update({ where: { id: b.id }, data: { averageCost: avg } }));
    }
  }
  if (itemId) await tx.item.update({ where: { id: itemId }, data: { lastCost: new Prisma.Decimal(cost) } });
  const oi = line.orderItem;
  if (oi && oi.order.kind === 'DIRECT_TO_JOB' && oi.order.jobId && oi.costCategoryId && !oi.requestItem && Math.abs(delta) >= 0.005) {
    await postJobCost(tx, {
      jobId: oi.order.jobId,
      costCategoryId: oi.costCategoryId,
      state: 'INCURRED',
      amount: Math.round(delta * 100) / 100,
      sourceType: 'receiving',
      sourceId: line.receivingId,
      sourceNumber: line.receiving.number,
      description: `${line.receiving.number}: received cost restated from ${before.toFixed(2)} to ${cost.toFixed(2)} a unit`,
      createdById: opts.actorId ?? null,
    });
  }
  await audit(
    {
      entityType: 'receiving',
      entityId: line.receivingId,
      action: 'UPDATED',
      summary: opts.summary,
      before: { unitCost: before },
      after: { unitCost: cost, ...opts.after },
      ...(opts.actorId ? { actorId: opts.actorId } : {}),
    },
    undefined,
    tx,
  );
  return true;
}

/**
 * The seed, every deploy, idempotent: a RECEIVED Incoming line on a foreign
 * order, or on an order line with a landed cost, still carrying a cost other
 * than the rule's (`receiptUnitCost`) is restated through
 * `restateReceiptLine`. A cost typed on the Incoming line stays. A line whose
 * order has no rate yet waits for one.
 */
export async function restateForeignReceipts(): Promise<{ lines: number; waiting: number }> {
  const lines = await prisma.receivingItem.findMany({
    where: {
      costTyped: false,
      receiving: { status: 'RECEIVED' },
      OR: [{ orderItem: { order: { currency: { not: BASE_CURRENCY } } } }, { orderItem: { landedUnitCost: { not: null } } }],
    },
    select: RESTATE_SELECT,
  });
  let restated = 0;
  let waiting = 0;
  for (const line of lines) {
    const oi = line.orderItem!;
    const cost = receiptUnitCost(oi.order, oi);
    if (cost.unitCost === null) {
      waiting++;
      continue;
    }
    if (Math.abs(n(line.unitCost) - cost.unitCost) < 0.005) continue;
    const done = await prisma.$transaction((tx) =>
      restateReceiptLine(tx, line, cost.unitCost!, {
        summary: `${line.receiving.number}: a line received on ${oi.order.number} (${oi.order.currency}) restated from ${n(line.unitCost).toFixed(2)} to ${cost.unitCost!.toFixed(2)} in pesos — ${basisWords(cost)}`,
        after: { basis: cost.basis, rate: cost.rate },
      }),
    );
    if (done) restated++;
  }
  return { lines: restated, waiting };
}
