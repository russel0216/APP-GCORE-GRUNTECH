import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { badRequest } from '../http/kit';
import { inBase, RATE_SELECT } from './exchangeRates';
import { receiptUnitCost } from './receiptCost';

/**
 * Buying for a SALES ORDER with no project (2026-10-21, the owner's call:
 * "purchase request till purchase order without the need to create a
 * project, a sales order only — there are instances that it happens").
 *
 * A request of kind SALES_ORDER names an ISSUED sales order; its order, RFQ,
 * canvass and incoming reports carry it. Nothing reaches a job's ledger — the
 * deal bears the cost — so what the deal has spent is READ off the documents
 * (`salesOrderSpend`), never stored, and its goods received into a warehouse
 * sit there as the order's own stock (`SalesOrderStock`), apart from the
 * company's: never in its average or value, and leaving by a pull-out or an
 * Outgoing slip on the order without posting anything again — the project
 * stock's rule (shared/projectStock.ts).
 */

type Tx = Prisma.TransactionClient;
const D = (v: number | string) => new Prisma.Decimal(v);
const num = (v: Prisma.Decimal | null | undefined) => (v == null ? 0 : Number(v));
const qty = (n: number) => Math.round(n * 1000) / 1000;
const cents = (n: number) => Math.round(n * 100) / 100;

export interface OrderMove {
  salesOrderId: string;
  itemId: string;
  warehouseId: string;
  quantity: number;
  sourceType: string;
  sourceId?: string | null;
  sourceNumber?: string | null;
  notes?: string | null;
  createdById?: string | null;
  locationId?: string | null;
}

const key = (m: OrderMove) => ({
  salesOrderId_itemId_warehouseId: { salesOrderId: m.salesOrderId, itemId: m.itemId, warehouseId: m.warehouseId },
});

/** Goods bought for the deal come into the warehouse, at what they cost it. */
export async function receiveOrderStock(tx: Tx, m: OrderMove & { unitCost: number }) {
  if (m.quantity <= 0) throw badRequest('Received quantity must be more than zero');
  const row = await tx.salesOrderStock.findUnique({ where: key(m) });
  const onHand = num(row?.quantity);
  const average = num(row?.averageCost);
  const newQty = qty(onHand + m.quantity);
  const newAverage = onHand > 0 ? (onHand * average + m.quantity * m.unitCost) / newQty : m.unitCost;
  await tx.salesOrderStock.upsert({
    where: key(m),
    create: {
      salesOrderId: m.salesOrderId,
      itemId: m.itemId,
      warehouseId: m.warehouseId,
      quantity: D(newQty),
      averageCost: D(Math.round(newAverage * 10000) / 10000),
      locationId: m.locationId ?? null,
    },
    update: {
      quantity: D(newQty),
      averageCost: D(Math.round(newAverage * 10000) / 10000),
      ...(m.locationId && !row?.locationId ? { locationId: m.locationId } : {}),
    },
  });
  await tx.inventoryTransaction.create({
    data: {
      itemId: m.itemId,
      warehouseId: m.warehouseId,
      salesOrderId: m.salesOrderId,
      type: 'RECEIPT',
      quantity: D(m.quantity),
      unitCost: D(m.unitCost),
      balanceAfter: D(newQty),
      sourceType: m.sourceType,
      sourceId: m.sourceId ?? null,
      sourceNumber: m.sourceNumber ?? null,
      notes: m.notes ?? null,
      createdById: m.createdById ?? null,
    },
  });
}

/**
 * The deal's goods leave the warehouse (or a receipt is pulled back): at
 * their average, never below nothing. Returns what they were worth.
 */
export async function issueOrderStock(tx: Tx, m: OrderMove & { type?: 'ISSUE' | 'RECEIPT' }) {
  if (m.quantity <= 0) throw badRequest('Issued quantity must be more than zero');
  const row = await tx.salesOrderStock.findUnique({
    where: key(m),
    include: { item: { select: { code: true, name: true } }, salesOrder: { select: { number: true } } },
  });
  const onHand = num(row?.quantity);
  if (!row || onHand < m.quantity - 0.0005) {
    const label = row ? `${row.item.code} — ${row.item.name}` : 'that item';
    throw badRequest(`Not enough of ${label} held for ${row?.salesOrder.number ?? 'the sales order'}: ${qty(onHand)} on hand, ${m.quantity} asked.`);
  }
  const unitCost = num(row.averageCost);
  const newQty = qty(onHand - m.quantity);
  await tx.salesOrderStock.update({ where: { id: row.id }, data: { quantity: D(newQty) } });
  await tx.inventoryTransaction.create({
    data: {
      itemId: m.itemId,
      warehouseId: m.warehouseId,
      salesOrderId: m.salesOrderId,
      type: m.type ?? 'ISSUE',
      quantity: D(-m.quantity),
      unitCost: D(unitCost),
      balanceAfter: D(newQty),
      sourceType: m.sourceType,
      sourceId: m.sourceId ?? null,
      sourceNumber: m.sourceNumber ?? null,
      notes: m.notes ?? null,
      createdById: m.createdById ?? null,
    },
  });
  return { unitCost, amount: cents(m.quantity * unitCost) };
}

/** What a sales order holds at a warehouse, by item — for the forms' checks and pickers. */
export async function orderHoldings(db: Tx, salesOrderId: string, warehouseId: string) {
  const rows = await db.salesOrderStock.findMany({
    where: { salesOrderId, warehouseId, quantity: { gt: 0 } },
    include: { item: { select: { id: true, code: true, name: true, partNumber: true, unit: true, costCategoryId: true } } },
  });
  return new Map(rows.map((r) => [r.itemId, r]));
}

/** The statuses of a request whose estimate still stands as a promise to buy. */
const PR_LIVE = ['APPROVED', 'PARTIALLY_ORDERED', 'ORDERED'] as const;
/** An order placed and not yet fully received. */
const PO_OPEN = ['ISSUED', 'PARTIALLY_RECEIVED'] as const;

/**
 * What a sales order has spent buying for itself, read off the documents —
 * the deal's Actual cost card and the requisition page's budget panel. All in
 * pesos: the order's quoted cost at its quotation's rate.
 *
 * - quoted: the order's own lines' cost (what the quotation said it would cost);
 * - requested: requests still waiting for approval;
 * - committed: what approved requests have not yet ordered (at their
 *   estimate) and what issued orders have not yet received (at their price);
 * - incurred: what incoming reports received (at the cost taken in);
 * - left: quoted − committed − incurred.
 */
export async function salesOrderSpend(salesOrderId: string, db: Tx | typeof prisma = prisma, opts: { excludeBudgetRequestId?: string } = {}) {
  const [order, requests, orders, received, cash] = await Promise.all([
    db.salesOrder.findUnique({
      where: { id: salesOrderId },
      select: {
        id: true,
        number: true,
        lines: { where: { isHeading: false }, select: { costAmount: true } },
        quotation: { select: RATE_SELECT },
      },
    }),
    db.purchaseRequest.findMany({
      where: { salesOrderId, kind: 'SALES_ORDER', status: { in: ['PENDING_APPROVAL', ...PR_LIVE] } },
      select: {
        id: true,
        number: true,
        status: true,
        items: { select: { quantity: true, orderedQty: true, pulledQty: true, estimatedCost: true, estimatedAmount: true } },
      },
    }),
    db.purchaseOrder.findMany({
      where: { salesOrderId, kind: 'SALES_ORDER', status: { in: [...PO_OPEN] } },
      select: {
        number: true,
        currency: true,
        exchangeRate: true,
        discountPct: true,
        items: { select: { quantity: true, receivedQty: true, unitPrice: true, landedUnitCost: true, requestItem: { select: { estimatedCost: true } } } },
      },
    }),
    db.receivingItem.findMany({
      where: { receiving: { status: 'RECEIVED', order: { salesOrderId, kind: 'SALES_ORDER' } } },
      select: { quantity: true, unitCost: true },
    }),
    // Budget requests on the order (2026-10-26): released cash is committed
    // until liquidated, then what was spent is incurred — Budget Monitoring's
    // rule for a project's requests. One a project has taken over counts there.
    db.budgetRequest.findMany({
      where: {
        salesOrderId,
        jobId: null,
        status: { in: ['RELEASED', 'REFUND_DUE', 'LIQUIDATED'] },
        ...(opts.excludeBudgetRequestId ? { id: { not: opts.excludeBudgetRequestId } } : {}),
      },
      select: { amountReleased: true, amountRefunded: true, amountSpent: true, liquidatedAt: true },
    }),
  ]);
  if (!order) return null;
  const quoted = inBase(
    cents(order.lines.reduce((s, l) => s + num(l.costAmount), 0)),
    order.quotation,
  );
  let requested = 0;
  let committed = 0;
  for (const r of requests) {
    for (const i of r.items) {
      if (r.status === 'PENDING_APPROVAL') requested += num(i.estimatedAmount);
      else committed += Math.max(0, num(i.quantity) - num(i.orderedQty) - num(i.pulledQty)) * num(i.estimatedCost);
    }
  }
  for (const o of orders) {
    // In pesos (2026-10-23): the landed cost, else the request's declared cost, else the price at
    // the order's rate — what the goods will be taken in at when received.
    for (const i of o.items) committed += Math.max(0, num(i.quantity) - num(i.receivedQty)) * (receiptUnitCost(o, i).unitCost ?? num(i.unitPrice));
  }
  let incurred = received.reduce((s, l) => s + num(l.quantity) * num(l.unitCost), 0);
  for (const r of cash) {
    if (r.liquidatedAt) incurred += num(r.amountSpent);
    else committed += Math.max(0, num(r.amountReleased) - num(r.amountRefunded));
  }
  return {
    salesOrderId: order.id,
    number: order.number,
    quoted: cents(quoted),
    requested: cents(requested),
    committed: cents(committed),
    incurred: cents(incurred),
    left: cents(quoted - committed - incurred),
  };
}
