import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { audit } from './audit';
import { nextNumber } from './numbering';
import { notify } from './notifications';
import { availableOf, belowReorder } from './chain';
import { usersInRole } from './approvals';

/**
 * The automatic reorder (2026-10-15, the owner's call on the inventory
 * screen: "minimum stock warnings auto-generate purchase requisitions" —
 * "Automatic").
 *
 * When stock leaves a warehouse (an issue, a pull-out, a borrow), the items
 * that moved are checked a moment later: an item at or under its reorder
 * level, with nothing already on the way for it there, is added to that
 * warehouse's AUTO REORDER requisition — one DRAFT stock replenishment per
 * warehouse, `PurchaseRequest.autoReorder`, collecting the items as they
 * fall. The system never submits it: a person checks the quantities and
 * presses Submit for approval, so no approval request exists that nobody
 * wrote (rule 2).
 *
 * "Already on the way" is any line for the item on a request not yet fully
 * ordered (DRAFT, PENDING_APPROVAL, APPROVED, PARTIALLY_ORDERED) for that
 * warehouse, or an issued purchase order for it still to arrive there — so a
 * falling item is requisitioned once, not on every issue.
 *
 * The quantity orders up to twice the reorder level: 2 × level − available −
 * what is on the way, at least one. The requester is the warehouse's
 * supervisor (the first active Warehouse Supervisor), else the Purchasing
 * Manager; with neither, nothing is raised and the trail says why.
 */

type Pair = { itemId: string; warehouseId: string };

const pending = new Map<string, Pair>();
let timer: NodeJS.Timeout | null = null;

/** Called wherever stock goes out: the check runs a moment after, outside the caller's transaction. */
export function queueReorderCheck(itemId: string, warehouseId: string) {
  pending.set(`${itemId}|${warehouseId}`, { itemId, warehouseId });
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const pairs = [...pending.values()];
    pending.clear();
    runReorderCheck(pairs).catch((err) => console.error('[reorder] check failed', err));
  }, 800);
  // A script that imports a route never waits on this.
  timer.unref?.();
}

const num = (v: Prisma.Decimal | number | null | undefined) => (v == null ? 0 : Number(v));
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const cents = (n: number) => Math.round(n * 100) / 100;

/** Who raises the automatic requisition: a Warehouse Supervisor, else the Purchasing Manager. */
async function reorderRequester(): Promise<string | null> {
  for (const key of ['warehouse_supervisor', 'purchasing_manager']) {
    const ids = await usersInRole(key);
    if (ids.length) {
      const first = await prisma.user.findFirst({ where: { id: { in: ids }, isActive: true }, orderBy: { createdAt: 'asc' }, select: { id: true } });
      if (first) return first.id;
    }
  }
  return null;
}

/** What is already on the way for an item into a warehouse: open request lines left to order, and issued orders left to receive. */
async function onTheWay(itemId: string, warehouseId: string): Promise<number> {
  const [requested, ordered] = await Promise.all([
    prisma.purchaseRequestItem.findMany({
      where: {
        itemId,
        request: { warehouseId, status: { in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PARTIALLY_ORDERED'] } },
      },
      select: { quantity: true, orderedQty: true, pulledQty: true },
    }),
    prisma.purchaseOrderItem.findMany({
      where: { itemId, order: { warehouseId, status: { in: ['ISSUED', 'PARTIALLY_RECEIVED'] } } },
      select: { quantity: true, receivedQty: true },
    }),
  ]);
  return round3(
    requested.reduce((s, r) => s + Math.max(0, num(r.quantity) - num(r.orderedQty) - num(r.pulledQty)), 0) +
      ordered.reduce((s, o) => s + Math.max(0, num(o.quantity) - num(o.receivedQty)), 0),
  );
}

/**
 * Checks the pairs and adds what has fallen to each warehouse's automatic
 * requisition. Exported for the verify scripts and for a change of reorder
 * level on the item master. Returns the lines it added.
 */
export async function runReorderCheck(pairs: Pair[]): Promise<{ requestId: string; number: string; itemId: string; quantity: number }[]> {
  if (!pairs.length) return [];
  const balances = await prisma.inventoryBalance.findMany({
    where: { OR: pairs.map((p) => ({ itemId: p.itemId, warehouseId: p.warehouseId })) },
    include: {
      item: {
        select: {
          id: true,
          code: true,
          name: true,
          partNumber: true,
          unit: true,
          isActive: true,
          isStocked: true,
          reorderLevel: true,
          standardCost: true,
          lastCost: true,
          costCategoryId: true,
          preferredSupplier: { select: { name: true } },
        },
      },
      warehouse: { select: { id: true, name: true, isActive: true } },
    },
  });
  const falling = balances.filter((b) => b.item.isActive && b.item.isStocked && b.warehouse.isActive && belowReorder(b));
  if (!falling.length) return [];

  const added: { requestId: string; number: string; itemId: string; quantity: number }[] = [];
  let requesterId: string | null | undefined;

  for (const b of falling) {
    const level = num(b.item.reorderLevel);
    const coming = await onTheWay(b.itemId, b.warehouseId);
    const quantity = Math.max(1, Math.ceil(round3(2 * level - availableOf(b) - coming)));
    // Something already on the way covers it: nothing to add.
    if (availableOf(b) + coming > level) continue;

    if (requesterId === undefined) requesterId = await reorderRequester();
    if (!requesterId) {
      await audit({
        entityType: 'purchase_request',
        entityId: 'auto-reorder',
        action: 'REJECTED',
        summary: `${b.item.code} is under its reorder level at ${b.warehouse.name}, but no Warehouse Supervisor or Purchasing Manager holds the role to raise the requisition`,
        actorName: 'system',
      });
      continue;
    }

    const estimate = num(b.item.standardCost) || num(b.item.lastCost) || num(b.averageCost);
    const line = {
      itemId: b.itemId,
      costCategoryId: b.item.costCategoryId,
      name: b.item.name,
      partNumber: b.item.partNumber,
      // Under the name, why it is here — what the person checking it needs.
      description: `Automatic reorder: ${availableOf(b)} ${b.item.unit} available, reorder level ${level}`,
      quantity: new Prisma.Decimal(quantity),
      unit: b.item.unit,
      estimatedCost: new Prisma.Decimal(cents(estimate)),
      estimatedAmount: new Prisma.Decimal(cents(estimate * quantity)),
    };

    const result = await prisma.$transaction(async (tx) => {
      // One open automatic requisition per warehouse; lock it so two checks
      // cannot both add the same item.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`auto-reorder:${b.warehouseId}`}))`;
      const already = await tx.purchaseRequestItem.count({
        where: { itemId: b.itemId, request: { warehouseId: b.warehouseId, autoReorder: true, status: 'DRAFT' } },
      });
      if (already) return null;
      let pr = await tx.purchaseRequest.findFirst({
        where: { warehouseId: b.warehouseId, autoReorder: true, status: 'DRAFT' },
        select: { id: true, number: true, requestedById: true },
      });
      if (!pr) {
        pr = await tx.purchaseRequest.create({
          data: {
            number: await nextNumber('purchase_request', tx),
            kind: 'STOCK_REPLENISHMENT',
            warehouseId: b.warehouseId,
            requestedById: requesterId!,
            purpose: `Automatic reorder — ${b.warehouse.name}`,
            notes: 'Raised by G-CORE when stock fell to its reorder level. Check the quantities, then submit it for approval.',
            preferredSupplier: b.item.preferredSupplier?.name ?? null,
            autoReorder: true,
          },
          select: { id: true, number: true, requestedById: true },
        });
      }
      const order = await tx.purchaseRequestItem.count({ where: { requestId: pr.id } });
      await tx.purchaseRequestItem.create({ data: { requestId: pr.id, sortOrder: order, ...line } });
      return pr;
    });
    if (!result) continue;

    added.push({ requestId: result.id, number: result.number, itemId: b.itemId, quantity });
    await audit({
      entityType: 'purchase_request',
      entityId: result.id,
      action: 'UPDATED',
      summary: `${result.number}: ${b.item.code} ${b.item.name} added by the automatic reorder — ${availableOf(b)} ${b.item.unit} available at ${b.warehouse.name}, reorder level ${level}; ${quantity} ${b.item.unit} requested`,
      actorName: 'system',
    });
    await notify({
      userId: result.requestedById,
      type: 'reorder.raised',
      title: `Reorder: ${b.item.name}`,
      body: `${result.number} — ${availableOf(b)} ${b.item.unit} left at ${b.warehouse.name}. Check and submit it.`,
      link: `/g-chain/purchase-requests/${result.id}`,
    });
  }
  return added;
}
