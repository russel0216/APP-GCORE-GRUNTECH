import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { badRequest, notFound } from '../http/kit';
import { audit } from './audit';
import { postJobCost, receiveStock } from './inventory';
import { inBase, RATE_SELECT } from './exchangeRates';
import { receiptUnitCost } from './receiptCost';
import { valueRevision } from './pipeline';
import { refreshBudgetRequest } from './finance';
import { projectBudgetByLine } from './projectBudget';
import { officeLineFor } from './officeBudget';

/**
 * BUYING AHEAD FOR A QUOTATION (2026-11-10, the owner's call: "on Purchase
 * Request allow to request also reference by Quotation … it should be
 * allocated or charged once the quotation is won or the sales order filed";
 * his answers: an open quotation's request may go all the way to a purchase
 * order and an Incoming; a lost one is re-allocated to a project with budget
 * left, or to an office budget line).
 *
 * A request of kind QUOTATION names an OPEN or WON quotation; its order, RFQ,
 * canvass and incoming reports carry it. Until the deal has somewhere to be
 * charged, NOTHING is charged anywhere:
 *
 * - no job ledger is touched;
 * - goods received into a warehouse are held as the quotation's own stock
 *   (`QuotationStock`, its own moving average, every movement an
 *   `InventoryTransaction` carrying `quotationId`) — never the company's;
 * - what it spent is read off the documents (`quotationSpend()`), against
 *   the quotation's quoted cost.
 *
 * The charge lands when the deal does:
 *
 * - a SALES ORDER issued on the quotation takes everything over
 *   (`handOverToSalesOrder`): requests and orders become SALES_ORDER kind,
 *   the held goods the order's own stock, the budget (and travel) requests
 *   the order's — `salesOrderSpend()` counts them from then on;
 * - a PROJECT built from the quotation with no sales order in between takes
 *   them (`handOverToProject`): DIRECT_TO_JOB, the declared value of what is
 *   still to come COMMITTED, what was received INCURRED, the goods the
 *   project's stock.
 *
 * LOST (or cancelled), the quotation's page lists what was spent on it and
 * each document is re-allocated by hand (`reallocatePurchasing`,
 * `reallocateBudgetRequest`): purchasing to a project with budget left or to
 * warehouse stock; a budget or travel request to a project with budget left
 * or to an office budget line.
 */

type Tx = Prisma.TransactionClient;
const D = (v: number | string) => new Prisma.Decimal(v);
const num = (v: Prisma.Decimal | null | undefined) => (v == null ? 0 : Number(v));
const qty = (n: number) => Math.round(n * 1000) / 1000;
const cents = (n: number) => Math.round(n * 100) / 100;

/** A quotation a request may buy ahead for: still open, or won. */
const BUYABLE = ['OPEN', 'SUBMITTED', 'NEGOTIATION', 'WON'] as const;
const LOST = ['LOST'] as const;
const PR_LIVE = ['APPROVED', 'PARTIALLY_ORDERED', 'ORDERED'] as const;
const PO_OPEN = ['ISSUED', 'PARTIALLY_RECEIVED'] as const;

export async function checkQuotationTarget(quotationId: string) {
  const q = await prisma.quotation.findUnique({
    where: { id: quotationId },
    select: { number: true, outcome: true, salesOrders: { where: { status: 'ISSUED' }, select: { number: true }, take: 1 } },
  });
  if (!q) throw notFound('Quotation not found');
  if (!(BUYABLE as readonly string[]).includes(q.outcome)) {
    throw badRequest(`${q.number} is ${q.outcome.toLowerCase().replace(/_/g, ' ')} — a purchase request takes an open or won quotation`);
  }
  if (q.salesOrders.length) {
    throw badRequest(`${q.number} already has sales order ${q.salesOrders[0].number} — raise the request for that sales order`);
  }
  return q;
}

export interface QuoteMove {
  quotationId: string;
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

const key = (m: { quotationId: string; itemId: string; warehouseId: string }) => ({
  quotationId_itemId_warehouseId: { quotationId: m.quotationId, itemId: m.itemId, warehouseId: m.warehouseId },
});

/** Goods bought ahead come into the warehouse, held for the quotation at what they cost. */
export async function receiveQuoteStock(tx: Tx, m: QuoteMove & { unitCost: number }) {
  if (m.quantity <= 0) throw badRequest('Received quantity must be more than zero');
  const row = await tx.quotationStock.findUnique({ where: key(m) });
  const onHand = num(row?.quantity);
  const newQty = qty(onHand + m.quantity);
  const newAverage = onHand > 0 ? (onHand * num(row?.averageCost) + m.quantity * m.unitCost) / newQty : m.unitCost;
  await tx.quotationStock.upsert({
    where: key(m),
    create: { quotationId: m.quotationId, itemId: m.itemId, warehouseId: m.warehouseId, quantity: D(newQty), averageCost: D(Math.round(newAverage * 10000) / 10000), locationId: m.locationId ?? null },
    update: { quantity: D(newQty), averageCost: D(Math.round(newAverage * 10000) / 10000), ...(m.locationId && !row?.locationId ? { locationId: m.locationId } : {}) },
  });
  await tx.inventoryTransaction.create({
    data: {
      itemId: m.itemId,
      warehouseId: m.warehouseId,
      quotationId: m.quotationId,
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

/** A receipt pulled back: the held goods go out again, never below nothing. */
export async function unreceiveQuoteStock(tx: Tx, m: QuoteMove) {
  const row = await tx.quotationStock.findUnique({ where: key(m), include: { item: { select: { code: true, name: true } }, quotation: { select: { number: true } } } });
  const onHand = num(row?.quantity);
  if (!row || onHand < m.quantity - 0.0005) {
    throw badRequest(`Not enough of ${row ? `${row.item.code} — ${row.item.name}` : 'that item'} is still held for ${row?.quotation.number ?? 'the quotation'}: ${qty(onHand)} on hand, ${m.quantity} asked.`);
  }
  const newQty = qty(onHand - m.quantity);
  await tx.quotationStock.update({ where: { id: row.id }, data: { quantity: D(newQty) } });
  await tx.inventoryTransaction.create({
    data: {
      itemId: m.itemId,
      warehouseId: m.warehouseId,
      quotationId: m.quotationId,
      type: 'RECEIPT',
      quantity: D(-m.quantity),
      unitCost: row.averageCost,
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
 * What was spent buying ahead for a quotation, read off the documents — the
 * sales order's rule (`salesOrderSpend`), against the quotation's quoted cost
 * (its value revision's lines, in pesos at its rate). Budget and travel
 * requests on it count too: released cash is committed, a settled one's
 * spend incurred.
 */
export async function quotationSpend(quotationId: string, db: Tx | typeof prisma = prisma) {
  const [q, requests, orders, received, cash] = await Promise.all([
    db.quotation.findUnique({
      where: { id: quotationId },
      select: {
        id: true,
        number: true,
        outcome: true,
        ...RATE_SELECT,
        revisions: { select: { status: true, revision: true, items: { where: { isHeading: false }, select: { costAmount: true } } } },
      },
    }),
    db.purchaseRequest.findMany({
      where: { quotationId, kind: 'QUOTATION', status: { in: ['PENDING_APPROVAL', ...PR_LIVE] } },
      select: { status: true, items: { select: { quantity: true, orderedQty: true, pulledQty: true, estimatedCost: true, estimatedAmount: true } } },
    }),
    db.purchaseOrder.findMany({
      where: { quotationId, kind: 'QUOTATION', status: { in: [...PO_OPEN] } },
      select: {
        number: true,
        currency: true,
        exchangeRate: true,
        discountPct: true,
        items: { select: { quantity: true, receivedQty: true, unitPrice: true, landedUnitCost: true, requestItem: { select: { estimatedCost: true } } } },
      },
    }),
    db.receivingItem.findMany({
      where: { receiving: { status: 'RECEIVED', order: { quotationId, kind: 'QUOTATION' } } },
      select: { quantity: true, unitCost: true },
    }),
    db.budgetRequest.findMany({
      where: { quotationId, jobId: null, salesOrderId: null, officeBudgetLineId: null, status: { in: ['PENDING_APPROVAL', 'APPROVED', 'RELEASED', 'REFUND_DUE', 'LIQUIDATED'] } },
      select: { status: true, amount: true, amountReleased: true, amountRefunded: true, amountSpent: true, liquidatedAt: true },
    }),
  ]);
  if (!q) return null;
  const rev = valueRevision(q.revisions);
  const quoted = inBase(cents((rev?.items ?? []).reduce((s, l) => s + num(l.costAmount), 0)), q);
  let requested = 0;
  let committed = 0;
  for (const r of requests) {
    for (const i of r.items) {
      if (r.status === 'PENDING_APPROVAL') requested += num(i.estimatedAmount);
      else committed += Math.max(0, num(i.quantity) - num(i.orderedQty) - num(i.pulledQty)) * num(i.estimatedCost);
    }
  }
  for (const o of orders) {
    for (const i of o.items) committed += Math.max(0, num(i.quantity) - num(i.receivedQty)) * (receiptUnitCost(o, i).unitCost ?? num(i.unitPrice));
  }
  let incurred = received.reduce((s, l) => s + num(l.quantity) * num(l.unitCost), 0);
  for (const r of cash) {
    if (r.liquidatedAt) incurred += num(r.amountSpent);
    else if (r.status === 'PENDING_APPROVAL' || r.status === 'APPROVED') requested += num(r.amount);
    else committed += Math.max(0, num(r.amountReleased) - num(r.amountRefunded));
  }
  return {
    quotationId: q.id,
    number: q.number,
    outcome: q.outcome,
    /** Nothing is charged until the deal has a sales order or a project. */
    charged: false,
    quoted: cents(quoted),
    requested: cents(requested),
    committed: cents(committed),
    incurred: cents(incurred),
    left: cents(quoted - committed - incurred),
  };
}

async function auditOn(tx: Tx, entityType: string, entityId: string, summary: string, actor?: { id: string; name: string }) {
  await audit({ entityType, entityId, action: 'UPDATED', summary, ...(actor ? { actorId: actor.id, actorName: actor.name } : {}) }, undefined, tx);
}

/**
 * A sales order ISSUED on the quotation takes over everything bought ahead
 * for it. Idempotent: what already moved is not found again.
 */
export async function handOverToSalesOrder(tx: Tx, salesOrderId: string, actor?: { id: string; name: string }): Promise<string[]> {
  const so = await tx.salesOrder.findUnique({ where: { id: salesOrderId }, select: { id: true, number: true, quotationId: true } });
  if (!so) return [];
  const quotationId = so.quotationId;
  const moved: string[] = [];
  const requests = await tx.purchaseRequest.findMany({ where: { quotationId, kind: 'QUOTATION' }, select: { id: true, number: true } });
  for (const r of requests) {
    await tx.purchaseRequest.update({ where: { id: r.id }, data: { kind: 'SALES_ORDER', salesOrderId: so.id } });
    await auditOn(tx, 'purchase_request', r.id, `${r.number} taken over by sales order ${so.number} — bought ahead for its quotation, it now counts on the order`, actor);
    moved.push(r.number);
  }
  const orders = await tx.purchaseOrder.findMany({ where: { quotationId, kind: 'QUOTATION' }, select: { id: true, number: true } });
  for (const o of orders) {
    await tx.purchaseOrder.update({ where: { id: o.id }, data: { kind: 'SALES_ORDER', salesOrderId: so.id } });
    await auditOn(tx, 'purchase_order', o.id, `${o.number} taken over by sales order ${so.number}`, actor);
    moved.push(o.number);
  }
  // The goods held for the quotation become the order's own stock.
  const held = await tx.quotationStock.findMany({ where: { quotationId } });
  for (const h of held) {
    const where = { salesOrderId_itemId_warehouseId: { salesOrderId: so.id, itemId: h.itemId, warehouseId: h.warehouseId } };
    const row = await tx.salesOrderStock.findUnique({ where });
    const onHand = num(row?.quantity);
    const total = qty(onHand + num(h.quantity));
    const average = total > 0 ? (onHand * num(row?.averageCost) + num(h.quantity) * num(h.averageCost)) / total : num(h.averageCost);
    await tx.salesOrderStock.upsert({
      where,
      create: { salesOrderId: so.id, itemId: h.itemId, warehouseId: h.warehouseId, quantity: D(total), averageCost: D(Math.round(average * 10000) / 10000), locationId: h.locationId },
      update: { quantity: D(total), averageCost: D(Math.round(average * 10000) / 10000) },
    });
    await tx.quotationStock.delete({ where: { id: h.id } });
  }
  await tx.inventoryTransaction.updateMany({ where: { quotationId }, data: { salesOrderId: so.id, quotationId: null } });
  // Budget and travel requests raised on the quotation count on the order from now on.
  const cash = await tx.budgetRequest.findMany({
    where: { quotationId, jobId: null, salesOrderId: null, officeBudgetLineId: null, status: { notIn: ['REJECTED', 'CANCELLED'] } },
    select: { id: true, number: true },
  });
  for (const r of cash) {
    await tx.budgetRequest.update({ where: { id: r.id }, data: { salesOrderId: so.id } });
    await auditOn(tx, 'budget_request', r.id, `${r.number} taken over by sales order ${so.number} — raised on its quotation, it now counts on the order`, actor);
    moved.push(r.number);
  }
  return moved;
}

/** The budget line a line bought ahead is charged to once a project takes it: its own, its item's, else Materials. */
async function budgetLineFor(tx: Tx, line: { costCategoryId: string | null; itemId: string | null }, fallbackId: string) {
  if (line.costCategoryId) return line.costCategoryId;
  if (line.itemId) {
    const item = await tx.item.findUnique({ where: { id: line.itemId }, select: { costCategoryId: true } });
    if (item?.costCategoryId) return item.costCategoryId;
  }
  return fallbackId;
}

/**
 * A project takes over the purchasing still held on a quotation — one built
 * from it with no sales order in between, or the project a LOST quotation's
 * purchasing is re-allocated to. The ledger is brought to where the ordinary
 * flow would have left it: each live request's declared value still to come
 * COMMITTED, what its orders received INCURRED (on the receiving that brought
 * it), and the held goods the project's own stock.
 */
export async function handOverToProject(
  tx: Tx,
  jobId: string,
  quotationId: string,
  opts: { actor?: { id: string; name: string }; costCategoryId?: string | null; why?: string } = {},
): Promise<string[]> {
  const requests = await tx.purchaseRequest.findMany({
    where: { quotationId, kind: 'QUOTATION' },
    include: { items: true, orders: { select: { id: true, number: true } } },
  });
  const orders = await tx.purchaseOrder.findMany({ where: { quotationId, kind: 'QUOTATION' }, include: { items: true, supplier: { select: { name: true } } } });
  if (!requests.length && !orders.length) return [];
  const job = await tx.job.findUnique({ where: { id: jobId }, select: { number: true } });
  const materials =
    (opts.costCategoryId ? await tx.costCategory.findUnique({ where: { id: opts.costCategoryId }, select: { id: true } }) : null) ??
    (await tx.costCategory.findFirst({ where: { code: 'MAT' }, select: { id: true } })) ??
    (await tx.costCategory.findFirst({ orderBy: { sortOrder: 'asc' }, select: { id: true } }));
  if (!materials) throw badRequest('No cost category is on file');
  const why = opts.why ?? `taken over by project ${job?.number ?? ''}`;
  const moved: string[] = [];
  const lineCategory = new Map<string, string>();

  for (const r of requests) {
    await tx.purchaseRequest.update({ where: { id: r.id }, data: { kind: 'DIRECT_TO_JOB', jobId } });
    const committed = new Map<string, number>();
    for (const i of r.items) {
      const cat = await budgetLineFor(tx, i, materials.id);
      lineCategory.set(i.id, cat);
      if (cat !== i.costCategoryId) await tx.purchaseRequestItem.update({ where: { id: i.id }, data: { costCategoryId: cat } });
      if ((PR_LIVE as readonly string[]).includes(r.status)) {
        // Received so far on this line, across its orders' RECEIVED reports.
        const got = await tx.receivingItem.aggregate({
          where: { receiving: { status: 'RECEIVED' }, orderItem: { requestItemId: i.id } },
          _sum: { quantity: true },
        });
        const still = Math.max(0, num(i.quantity) - num(i.pulledQty) - num(got._sum.quantity));
        if (still > 0) committed.set(cat, (committed.get(cat) ?? 0) + still * num(i.estimatedCost));
      }
    }
    for (const [costCategoryId, amount] of committed) {
      await postJobCost(tx, {
        jobId,
        costCategoryId,
        state: 'COMMITTED',
        amount: cents(amount),
        sourceType: 'purchase_request',
        sourceId: r.id,
        sourceNumber: r.number,
        description: `Purchase request approved — bought ahead for a quotation, ${why}`,
        createdById: opts.actor?.id ?? null,
      });
    }
    await auditOn(tx, 'purchase_request', r.id, `${r.number} ${why} — its declared value now counts on the project's budget`, opts.actor);
    moved.push(r.number);
  }

  for (const o of orders) {
    await tx.purchaseOrder.update({ where: { id: o.id }, data: { kind: 'DIRECT_TO_JOB', jobId } });
    for (const i of o.items) {
      const cat = (i.requestItemId && lineCategory.get(i.requestItemId)) || (await budgetLineFor(tx, i, materials.id));
      lineCategory.set(`po:${i.id}`, cat);
      if (cat !== i.costCategoryId) await tx.purchaseOrderItem.update({ where: { id: i.id }, data: { costCategoryId: cat } });
    }
    // What its RECEIVED reports brought in is INCURRED, at the request's declared value where it has one.
    const receivings = await tx.receiving.findMany({
      where: { orderId: o.id, status: 'RECEIVED' },
      include: { items: { include: { orderItem: { include: { requestItem: { select: { estimatedCost: true } } } } } } },
    });
    for (const rec of receivings) {
      const byCat = new Map<string, number>();
      for (const line of rec.items) {
        if (!line.orderItem) continue;
        const cat = lineCategory.get(`po:${line.orderItem.id}`) ?? materials.id;
        const unit = line.orderItem.requestItem ? num(line.orderItem.requestItem.estimatedCost) : num(line.unitCost);
        byCat.set(cat, (byCat.get(cat) ?? 0) + num(line.quantity) * unit);
      }
      for (const [costCategoryId, amount] of byCat) {
        await postJobCost(tx, {
          jobId,
          costCategoryId,
          state: 'INCURRED',
          amount: cents(amount),
          sourceType: 'receiving',
          sourceId: rec.id,
          sourceNumber: rec.number,
          description: `Goods received from ${o.supplier.name} — bought ahead for a quotation, ${why}`,
          createdById: opts.actor?.id ?? null,
        });
      }
    }
    await auditOn(tx, 'purchase_order', o.id, `${o.number} ${why}`, opts.actor);
    moved.push(o.number);
  }

  // The held goods become the project's own stock.
  const held = await tx.quotationStock.findMany({ where: { quotationId } });
  for (const h of held) {
    const where = { jobId_itemId_warehouseId: { jobId, itemId: h.itemId, warehouseId: h.warehouseId } };
    const row = await tx.projectStock.findUnique({ where });
    const onHand = num(row?.quantity);
    const total = qty(onHand + num(h.quantity));
    const average = total > 0 ? (onHand * num(row?.averageCost) + num(h.quantity) * num(h.averageCost)) / total : num(h.averageCost);
    await tx.projectStock.upsert({
      where,
      create: { jobId, itemId: h.itemId, warehouseId: h.warehouseId, quantity: D(total), averageCost: D(Math.round(average * 10000) / 10000), locationId: h.locationId },
      update: { quantity: D(total), averageCost: D(Math.round(average * 10000) / 10000) },
    });
    await tx.quotationStock.delete({ where: { id: h.id } });
  }
  await tx.inventoryTransaction.updateMany({ where: { quotationId }, data: { jobId, quotationId: null } });
  return moved;
}

/** What a LOST (or cancelled) quotation still carries, to be re-allocated by hand. */
export async function costsToReallocate(quotationId: string, db: Tx | typeof prisma = prisma) {
  const [requests, orders, held, cash] = await Promise.all([
    db.purchaseRequest.findMany({
      where: { quotationId, kind: 'QUOTATION', status: { notIn: ['DRAFT', 'REJECTED', 'CANCELLED'] } },
      select: { id: true, number: true, status: true, items: { select: { estimatedAmount: true } } },
    }),
    db.purchaseOrder.findMany({ where: { quotationId, kind: 'QUOTATION', status: { not: 'CANCELLED' } }, select: { id: true, number: true, status: true } }),
    db.quotationStock.findMany({ where: { quotationId, quantity: { gt: 0 } }, select: { quantity: true, averageCost: true } }),
    db.budgetRequest.findMany({
      where: { quotationId, jobId: null, salesOrderId: null, officeBudgetLineId: null, status: { in: ['APPROVED', 'RELEASED', 'REFUND_DUE', 'LIQUIDATED'] } },
      select: { id: true, number: true, status: true, amount: true, amountReleased: true, amountRefunded: true, amountSpent: true, liquidatedAt: true, reason: true, isTravel: true },
    }),
  ]);
  return {
    purchasing: {
      requests: requests.map((r) => ({ id: r.id, number: r.number, status: r.status, amount: cents(r.items.reduce((s, i) => s + num(i.estimatedAmount), 0)) })),
      orders,
      amount: cents(requests.reduce((s, r) => s + r.items.reduce((t, i) => t + num(i.estimatedAmount), 0), 0)),
      heldValue: cents(held.reduce((s, h) => s + num(h.quantity) * num(h.averageCost), 0)),
    },
    cash: cash.map((r) => ({
      id: r.id,
      number: r.number,
      status: r.status,
      reason: r.reason,
      isTravel: r.isTravel,
      amount: r.liquidatedAt ? num(r.amountSpent) : r.status === 'APPROVED' ? num(r.amount) : cents(Math.max(0, num(r.amountReleased) - num(r.amountRefunded))),
    })),
  };
}

async function lostQuotation(tx: Tx, quotationId: string) {
  const q = await tx.quotation.findUnique({ where: { id: quotationId }, select: { id: true, number: true, outcome: true } });
  if (!q) throw notFound('Quotation not found');
  if (!(LOST as readonly string[]).includes(q.outcome)) {
    throw badRequest(`${q.number} is not lost — what was bought ahead for it stays on it until a sales order or a project takes it`);
  }
  return q;
}

async function assertBudgetLeft(jobId: string, costCategoryId: string, amount: number) {
  const pool = await projectBudgetByLine(jobId);
  const line = pool.lines.find((l) => l.id === costCategoryId);
  if (!line) throw badRequest('That budget line is not on the project');
  if (line.available + 0.005 < amount) {
    throw badRequest(`${line.name} has ${line.available.toFixed(2)} left — less than the ${amount.toFixed(2)} to be charged. Choose a project and budget line with budget remaining`);
  }
}

/**
 * A lost quotation's PURCHASING, re-allocated whole: to a project with
 * budget left on the line named (`handOverToProject`), or to the warehouse
 * as the company's own stock (requests and orders become stock
 * replenishments, the held goods company stock at their average).
 */
export async function reallocatePurchasing(
  tx: Tx,
  quotationId: string,
  to: { jobId: string; costCategoryId: string } | { stock: true },
  actor: { id: string; name: string },
) {
  const q = await lostQuotation(tx, quotationId);
  const costs = await costsToReallocate(quotationId, tx);
  if ('jobId' in to) {
    const job = await tx.job.findUnique({ where: { id: to.jobId }, select: { number: true, status: true } });
    if (!job || job.status === 'CANCELLED') throw badRequest('That project cannot be charged');
    await assertBudgetLeft(to.jobId, to.costCategoryId, costs.purchasing.amount);
    return handOverToProject(tx, to.jobId, quotationId, { actor, costCategoryId: to.costCategoryId, why: `re-allocated from lost quotation ${q.number} to project ${job.number}` });
  }
  const moved: string[] = [];
  const requests = await tx.purchaseRequest.findMany({ where: { quotationId, kind: 'QUOTATION' }, select: { id: true, number: true } });
  const held = await tx.quotationStock.findMany({ where: { quotationId } });
  const warehouseId = held[0]?.warehouseId ?? (await tx.warehouse.findFirst({ where: { isActive: true }, orderBy: { code: 'asc' }, select: { id: true } }))?.id ?? null;
  for (const r of requests) {
    await tx.purchaseRequest.update({ where: { id: r.id }, data: { kind: 'STOCK_REPLENISHMENT', warehouseId } });
    await auditOn(tx, 'purchase_request', r.id, `${r.number} re-allocated from lost quotation ${q.number} to warehouse stock`, actor);
    moved.push(r.number);
  }
  const orders = await tx.purchaseOrder.findMany({ where: { quotationId, kind: 'QUOTATION' }, select: { id: true, number: true } });
  for (const o of orders) {
    await tx.purchaseOrder.update({ where: { id: o.id }, data: { kind: 'STOCK_REPLENISHMENT', warehouseId } });
    await auditOn(tx, 'purchase_order', o.id, `${o.number} re-allocated from lost quotation ${q.number} to warehouse stock`, actor);
    moved.push(o.number);
  }
  for (const h of held) {
    if (num(h.quantity) > 0) {
      await tx.inventoryTransaction.create({
        data: { itemId: h.itemId, warehouseId: h.warehouseId, quotationId, type: 'ISSUE', quantity: D(-num(h.quantity)), unitCost: h.averageCost, balanceAfter: D(0), sourceType: 'quotation_lost', sourceId: quotationId, sourceNumber: q.number, notes: 'Moved to the company’s stock', createdById: actor.id },
      });
      await receiveStock(tx, {
        itemId: h.itemId,
        warehouseId: h.warehouseId,
        quantity: num(h.quantity),
        unitCost: num(h.averageCost),
        sourceType: 'quotation_lost',
        sourceId: quotationId,
        sourceNumber: q.number,
        notes: `Bought ahead for ${q.number}, which was lost`,
        createdById: actor.id,
      });
    }
    await tx.quotationStock.delete({ where: { id: h.id } });
  }
  return moved;
}

/**
 * A lost quotation's budget or travel request, re-allocated: to a project
 * with budget left on the line named (its cash then commits there, an
 * approved liquidation is charged there), or to an office budget line.
 */
export async function reallocateBudgetRequest(
  tx: Tx,
  quotationId: string,
  requestId: string,
  to: { jobId: string; costCategoryId: string } | { officeBudgetLineId: string },
  actor: { id: string; name: string },
) {
  const q = await lostQuotation(tx, quotationId);
  const r = await tx.budgetRequest.findFirst({
    where: { id: requestId, quotationId, jobId: null, salesOrderId: null, officeBudgetLineId: null },
    include: { liquidations: { where: { status: { in: ['APPROVED', 'SETTLED', 'REIMBURSED'] }, jobId: null }, select: { id: true, number: true, total: true, purpose: true, claimedBy: { select: { name: true } } } } },
  });
  if (!r) throw badRequest('That request is not waiting on this quotation');
  if ('officeBudgetLineId' in to) {
    const line = await officeLineFor(to.officeBudgetLineId);
    await tx.budgetRequest.update({ where: { id: r.id }, data: { officeBudgetLineId: line.id } });
    await tx.expenseClaim.updateMany({ where: { budgetRequestId: r.id }, data: { officeBudgetLineId: line.id } });
    await auditOn(tx, 'budget_request', r.id, `${r.number} re-allocated from lost quotation ${q.number} to office budget line ${line.code} ${line.name}`, actor);
    return r.number;
  }
  const job = await tx.job.findUnique({ where: { id: to.jobId }, select: { number: true, status: true } });
  if (!job || job.status === 'CANCELLED') throw badRequest('That project cannot be charged');
  const amount = r.liquidatedAt ? num(r.amountSpent) : r.status === 'APPROVED' ? num(r.amount) : Math.max(0, num(r.amountReleased) - num(r.amountRefunded));
  await assertBudgetLeft(to.jobId, to.costCategoryId, amount);
  await tx.budgetRequest.update({ where: { id: r.id }, data: { jobId: to.jobId, costCategoryId: to.costCategoryId } });
  await tx.expenseClaim.updateMany({ where: { budgetRequestId: r.id, jobId: null, status: { in: ['DRAFT', 'PENDING_APPROVAL'] } }, data: { jobId: to.jobId, costCategoryId: to.costCategoryId } });
  for (const claim of r.liquidations) {
    await tx.expenseClaim.update({ where: { id: claim.id }, data: { jobId: to.jobId, costCategoryId: to.costCategoryId, postedToJob: true, postedAt: new Date() } });
    await postJobCost(tx, {
      jobId: to.jobId,
      costCategoryId: to.costCategoryId,
      state: 'INCURRED',
      amount: num(claim.total),
      sourceType: 'expense_claim',
      sourceId: claim.id,
      sourceNumber: claim.number,
      description: `${claim.claimedBy.name} — ${claim.purpose} (liquidation of ${r.number}, re-allocated from lost quotation ${q.number})`,
    });
  }
  await refreshBudgetRequest(tx, r.id);
  await auditOn(tx, 'budget_request', r.id, `${r.number} re-allocated from lost quotation ${q.number} to project ${job.number}`, actor);
  return r.number;
}
