import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { BASE_CURRENCY, exchangeRates, storedRate } from './exchangeRates';
import { audit } from './audit';

/**
 * What a purchase order line costs IN PESOS (2026-10-23, the owner's call:
 * "the purchase order is USD but when it enters inventory it is PHP — I want
 * the real cost reflected … the incoming report's value based on the
 * purchase request's PHP even if the purchase order is in USD").
 *
 * The ONE rule, read by the Incoming report, the stock it builds (company,
 * project or sales order), the job cost it charges and a sales order's spend:
 *
 *   1. a line ordered from a purchase request takes the request's DECLARED
 *      unit cost — already pesos, and what Budget Monitoring subtracts;
 *   2. otherwise a peso order's own price;
 *   3. otherwise the order's price × the order's own rate to PHP
 *      (`PurchaseOrder.exchangeRate`, taken from Company Settings ›
 *      Exchange rates at save, kept after);
 *   4. a foreign order with no rate has no peso cost — the caller refuses
 *      and says where to set one, never posts the foreign figure as pesos.
 */
export type CostedOrder = { number: string; currency: string; exchangeRate: Prisma.Decimal | number | null };
export type CostedLine = { unitPrice: Prisma.Decimal | number; requestItem?: { estimatedCost: Prisma.Decimal | number } | null };
export type LineCost = { unitCost: number | null; basis: 'request' | 'order' | 'converted' | 'no_rate'; rate: number | null };

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
  const declared = n(line.requestItem?.estimatedCost);
  if (line.requestItem && declared > 0) return { unitCost: centavo(declared), basis: 'request', rate: null };
  const rate = orderRate(order);
  if (rate === 1) return { unitCost: centavo(n(line.unitPrice)), basis: 'order', rate: null };
  if (rate === null) return { unitCost: null, basis: 'no_rate', rate: null };
  return { unitCost: centavo(n(line.unitPrice) * rate), basis: 'converted', rate };
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

/**
 * The seed, every deploy, idempotent: a RECEIVED Incoming line on a foreign
 * order still carrying a cost other than its peso one (posted before
 * 2026-10-23 at the order's foreign price as if it were pesos) is restated —
 * the line, its stock movement(s), the item's last cost, and the average of
 * the shelf it went onto by the value it was off (what remains on that shelf
 * carries the difference; what already left went at the old average and is
 * not rewritten). A line whose order has no rate yet waits for one.
 */
export async function restateForeignReceipts(): Promise<{ lines: number; waiting: number }> {
  const lines = await prisma.receivingItem.findMany({
    where: {
      receiving: { status: 'RECEIVED' },
      orderItem: { order: { currency: { not: BASE_CURRENCY } } },
    },
    select: {
      id: true,
      quantity: true,
      unitCost: true,
      receivingId: true,
      receiving: { select: { number: true, warehouseId: true } },
      orderItem: {
        select: {
          itemId: true,
          unitPrice: true,
          requestItem: { select: { estimatedCost: true } },
          order: { select: { id: true, number: true, currency: true, exchangeRate: true, warehouseId: true } },
        },
      },
    },
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
    const before = n(line.unitCost);
    if (Math.abs(before - cost.unitCost) < 0.005) continue;
    const qty = n(line.quantity);
    const delta = (cost.unitCost - before) * qty;
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.receivingItem.updateMany({
        where: { id: line.id, unitCost: line.unitCost },
        data: { unitCost: new Prisma.Decimal(cost.unitCost!) },
      });
      if (!claimed.count) return;
      // Its stock movements: company, project or sales order shelf alike.
      const moves = oi.itemId
        ? await tx.inventoryTransaction.findMany({
            where: { sourceType: 'receiving', sourceId: line.receivingId, itemId: oi.itemId, type: 'RECEIPT', unitCost: line.unitCost },
            select: { id: true, warehouseId: true, jobId: true, salesOrderId: true },
          })
        : [];
      for (const m of moves) {
        await tx.inventoryTransaction.update({ where: { id: m.id }, data: { unitCost: new Prisma.Decimal(cost.unitCost!) } });
        const shift = async (onHand: number, average: number, write: (avg: Prisma.Decimal) => Promise<unknown>) => {
          if (onHand <= 0) return;
          const avg = Math.max(0, average + delta / onHand);
          await write(new Prisma.Decimal(Math.round(avg * 10000) / 10000));
        };
        if (m.jobId) {
          const ps = await tx.projectStock.findFirst({ where: { jobId: m.jobId, itemId: oi.itemId!, warehouseId: m.warehouseId } });
          if (ps) await shift(n(ps.quantity), n(ps.averageCost), (avg) => tx.projectStock.update({ where: { id: ps.id }, data: { averageCost: avg } }));
        } else if (m.salesOrderId) {
          const ss = await tx.salesOrderStock.findFirst({ where: { salesOrderId: m.salesOrderId, itemId: oi.itemId!, warehouseId: m.warehouseId } });
          if (ss) await shift(n(ss.quantity), n(ss.averageCost), (avg) => tx.salesOrderStock.update({ where: { id: ss.id }, data: { averageCost: avg } }));
        } else {
          const b = await tx.inventoryBalance.findUnique({ where: { itemId_warehouseId: { itemId: oi.itemId!, warehouseId: m.warehouseId } } });
          if (b) await shift(n(b.quantity), n(b.averageCost), (avg) => tx.inventoryBalance.update({ where: { id: b.id }, data: { averageCost: avg } }));
        }
      }
      if (oi.itemId) await tx.item.update({ where: { id: oi.itemId }, data: { lastCost: new Prisma.Decimal(cost.unitCost!) } });
      await audit(
        {
          entityType: 'receiving',
          entityId: line.receivingId,
          action: 'UPDATED',
          summary: `${line.receiving.number}: a line received on ${oi.order.number} (${oi.order.currency}) restated from ${before.toFixed(2)} to ${cost.unitCost!.toFixed(2)} in pesos — ${cost.basis === 'request' ? "the request's declared value" : `the order's price at ${cost.rate} to PHP`}`,
          before: { unitCost: before },
          after: { unitCost: cost.unitCost, basis: cost.basis, rate: cost.rate },
        },
        undefined,
        tx,
      );
      restated++;
    });
  }
  return { lines: restated, waiting };
}
