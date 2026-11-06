import { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../prisma';

/**
 * "Delivered to site" (2026-11-06, the owner's call: "if it is still delivered
 * to site, the requestor should still need to create a pull-out slip").
 *
 * Goods on a project order received STRAIGHT TO SITE used to be charged to the
 * project and held nowhere, so nothing confirmed that they reached the people
 * who asked for them. Now they are held as the project's own stock at one
 * virtual place — this warehouse row, `isSite` — until the requestor raises a
 * pull-out slip ("Goods bought for a project") that confirms the hand-over.
 * Nothing is charged twice: the receipt charged the project, the slip posts
 * CONSUMED only (shared/projectStock.ts).
 *
 * The row is INACTIVE on purpose: every company-stock picker lists active
 * warehouses only, so nobody can receive company stock, order, borrow or issue
 * an Outgoing slip from it. The pull-out slip's project-stock path and the
 * Incoming's "Delivered to site" choice are the two doors that name it.
 */

export const SITE_WAREHOUSE_CODE = 'PROJECT-SITE';
export const SITE_WAREHOUSE_NAME = 'Delivered to site';

type Db = Prisma.TransactionClient | PrismaClient;

/** The one "Delivered to site" row, made the first time it is needed. */
export async function siteWarehouse(db: Db = prisma): Promise<{ id: string; name: string }> {
  const found = await db.warehouse.findFirst({ where: { isSite: true }, select: { id: true, name: true } });
  if (found) return found;
  // A code an administrator already used is stepped over.
  let code = SITE_WAREHOUSE_CODE;
  for (let n = 2; await db.warehouse.findUnique({ where: { code }, select: { id: true } }); n += 1) code = `${SITE_WAREHOUSE_CODE}-${n}`;
  return db.warehouse.create({
    data: { code, name: SITE_WAREHOUSE_NAME, isActive: false, isSite: true },
    select: { id: true, name: true },
  });
}

/**
 * The seed, once (`seed.siteDeliveriesShelved20261106`): a project's goods
 * received straight to site BEFORE this rule were charged to the project and
 * held nowhere. Each such receipt now names "Delivered to site" and its goods
 * are held there as the project's stock, at the cost they were received at —
 * nothing is posted to any ledger — so the requestor can confirm them with a
 * pull-out slip. A service is never shelved. Returns the lines held, or null
 * once it had run.
 */
export async function shelveSiteDeliveries(db: PrismaClient = prisma): Promise<{ receipts: number; lines: number } | null> {
  const MARK = 'seed.siteDeliveriesShelved20261106';
  if (await db.setting.findUnique({ where: { key: MARK } })) return null;
  const { itemForTypedLine } = await import('./typedItems');
  const { receiveProjectStock } = await import('./projectStock');
  const site = await siteWarehouse(db);
  const receipts = await db.receiving.findMany({
    where: { status: 'RECEIVED', warehouseId: null, order: { kind: 'DIRECT_TO_JOB', jobId: { not: null } } },
    include: { items: true, order: { include: { items: true } } },
    orderBy: { receivedDate: 'asc' },
  });
  let lines = 0;
  for (const r of receipts) {
    await db.$transaction(async (tx) => {
      const byOrderItem = new Map(r.order!.items.map((i) => [i.id, i]));
      for (const line of r.items) {
        const orderItem = line.orderItemId ? byOrderItem.get(line.orderItemId) : undefined;
        if (!orderItem || orderItem.nature === 'SERVICE' || Number(line.quantity) <= 0) continue;
        let itemId = orderItem.itemId;
        if (!itemId) {
          itemId = await itemForTypedLine(tx, orderItem, r.receivedById, line.categoryId);
          await tx.purchaseOrderItem.update({ where: { id: orderItem.id }, data: { itemId } });
          orderItem.itemId = itemId;
        }
        await receiveProjectStock(tx, {
          jobId: r.order!.jobId!,
          itemId,
          warehouseId: site.id,
          quantity: Number(line.quantity),
          unitCost: Number(line.unitCost),
          sourceType: 'receiving',
          sourceId: r.id,
          sourceNumber: r.number,
          notes: 'Delivered to site before this was kept — held as the project’s stock for the requestor to confirm with a pull-out slip (no cost posted)',
          createdById: r.receivedById,
        });
        lines += 1;
      }
      await tx.receiving.update({ where: { id: r.id }, data: { warehouseId: site.id } });
      await tx.auditLog.create({
        data: {
          entityType: 'receiving',
          entityId: r.id,
          action: 'UPDATED',
          summary: `${r.number}: delivered to site — its goods held as the project’s stock until a pull-out slip confirms them (no cost posted)`,
        },
      });
    });
  }
  await db.setting.create({ data: { key: MARK, value: { at: new Date().toISOString(), receipts: receipts.length, lines } } });
  return { receipts: receipts.length, lines };
}

/** Whether a warehouse id is the "Delivered to site" row. */
export async function isSiteWarehouse(db: Db, warehouseId: string | null | undefined): Promise<boolean> {
  if (!warehouseId) return false;
  const w = await db.warehouse.findUnique({ where: { id: warehouseId }, select: { isSite: true } });
  return !!w?.isSite;
}
