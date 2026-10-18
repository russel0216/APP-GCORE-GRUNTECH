import { Prisma } from '@prisma/client';
import { badRequest } from '../http/kit';

/**
 * A project's own stock (2026-10-18, the owner's call: "project goods received
 * into the warehouse should also show in inventory so that the warehouse
 * officer can create an outgoing; project management or anyone should create
 * a pull-out slip").
 *
 * Goods on a direct-to-job order are charged to the project when they arrive
 * (Phase 5). Received into a WAREHOUSE rather than to site, they now also sit
 * on the shelf as the project's stock — a `ProjectStock` row per project, item
 * and warehouse, apart from the company's `InventoryBalance`:
 *
 * - they never mix into the company stock's moving average, and never count
 *   in its value (the project already bears their cost);
 * - leaving the warehouse for the project — an Outgoing line marked project
 *   stock, or a PROJECT_STOCK pull-out — posts no cost again: the receipt
 *   already did. The two purchase kinds stay disjoint in money.
 *
 * Every movement is an `InventoryTransaction` carrying `jobId`, so the stock
 * card and the movement log show it; `balanceAfter` is the project's own count.
 */

type Tx = Prisma.TransactionClient;
const D = (v: number | string) => new Prisma.Decimal(v);
const num = (v: Prisma.Decimal | null | undefined) => (v == null ? 0 : Number(v));
const qty = (n: number) => Math.round(n * 1000) / 1000;
const cents = (n: number) => Math.round(n * 100) / 100;

export interface ProjectMove {
  jobId: string;
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

const key = (m: ProjectMove) => ({ jobId_itemId_warehouseId: { jobId: m.jobId, itemId: m.itemId, warehouseId: m.warehouseId } });

/** Goods for the project come into the warehouse, at what they cost it. */
export async function receiveProjectStock(tx: Tx, m: ProjectMove & { unitCost: number }) {
  if (m.quantity <= 0) throw badRequest('Received quantity must be more than zero');
  const row = await tx.projectStock.findUnique({ where: key(m) });
  const onHand = num(row?.quantity);
  const average = num(row?.averageCost);
  const newQty = qty(onHand + m.quantity);
  const newAverage = onHand > 0 ? (onHand * average + m.quantity * m.unitCost) / newQty : m.unitCost;
  await tx.projectStock.upsert({
    where: key(m),
    create: {
      jobId: m.jobId,
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
      jobId: m.jobId,
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
 * The project's goods leave the warehouse (or a receipt is pulled back): at
 * their average, never below nothing. Returns what they were worth.
 */
export async function issueProjectStock(tx: Tx, m: ProjectMove & { type?: 'ISSUE' | 'RECEIPT' }) {
  if (m.quantity <= 0) throw badRequest('Issued quantity must be more than zero');
  const row = await tx.projectStock.findUnique({
    where: key(m),
    include: { item: { select: { code: true, name: true } }, job: { select: { number: true } } },
  });
  const onHand = num(row?.quantity);
  if (!row || onHand < m.quantity - 0.0005) {
    const label = row ? `${row.item.code} — ${row.item.name}` : 'that item';
    throw badRequest(`Not enough of ${label} in ${row?.job.number ?? 'the project'}'s stock: ${qty(onHand)} on hand, ${m.quantity} asked.`);
  }
  const unitCost = num(row.averageCost);
  const newQty = qty(onHand - m.quantity);
  await tx.projectStock.update({ where: { id: row.id }, data: { quantity: D(newQty) } });
  await tx.inventoryTransaction.create({
    data: {
      itemId: m.itemId,
      warehouseId: m.warehouseId,
      jobId: m.jobId,
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

/** What a project holds at a warehouse, by item — for the forms' checks and pickers. */
export async function projectHoldings(db: Tx | Prisma.TransactionClient, jobId: string, warehouseId: string) {
  const rows = await db.projectStock.findMany({
    where: { jobId, warehouseId, quantity: { gt: 0 } },
    include: { item: { select: { id: true, code: true, name: true, partNumber: true, unit: true, costCategoryId: true } } },
  });
  return new Map(rows.map((r) => [r.itemId, r]));
}

/**
 * The seed, once (`seed.projectStockBackfilled`): project goods received into
 * a warehouse BEFORE 2026-10-18 were charged to the project and entered no
 * stock. They are put on the shelf as the project's stock now, at the cost
 * they were received at — nothing is posted to any ledger. Returns the lines
 * stocked, or null when it had run.
 */
export async function backfillProjectStock(prisma: import('@prisma/client').PrismaClient): Promise<number | null> {
  const MARK = 'seed.projectStockBackfilled';
  if (await prisma.setting.findUnique({ where: { key: MARK } })) return null;
  const { itemForTypedLine } = await import('./typedItems');
  const receipts = await prisma.receiving.findMany({
    where: { status: 'RECEIVED', warehouseId: { not: null }, order: { kind: 'DIRECT_TO_JOB', jobId: { not: null } } },
    include: { items: true, order: { include: { items: true } } },
    orderBy: { receivedDate: 'asc' },
  });
  let lines = 0;
  for (const r of receipts) {
    await prisma.$transaction(async (tx) => {
      const byOrderItem = new Map(r.order!.items.map((i) => [i.id, i]));
      for (const line of r.items) {
        const orderItem = line.orderItemId ? byOrderItem.get(line.orderItemId) : undefined;
        if (!orderItem || num(line.quantity) <= 0) continue;
        let itemId = orderItem.itemId;
        if (!itemId) {
          itemId = await itemForTypedLine(tx, orderItem, r.receivedById);
          await tx.purchaseOrderItem.update({ where: { id: orderItem.id }, data: { itemId } });
          orderItem.itemId = itemId;
        }
        await receiveProjectStock(tx, {
          jobId: r.order!.jobId!,
          itemId,
          warehouseId: r.warehouseId!,
          quantity: num(line.quantity),
          unitCost: num(line.unitCost),
          locationId: line.locationId,
          sourceType: 'receiving',
          sourceId: r.id,
          sourceNumber: r.number,
          notes: 'Received before project stock was kept — put on the shelf as the project’s own (no cost posted)',
          createdById: r.receivedById,
        });
        lines += 1;
      }
    });
  }
  await prisma.setting.create({ data: { key: MARK, value: { at: new Date().toISOString(), lines } } });
  return lines;
}
