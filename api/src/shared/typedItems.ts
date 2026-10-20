import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { nextNumber } from './numbering';
import { receiveStock } from './inventory';

/** The item a typed order line is: one active match by part number or code, else by name, else filed new. */
export async function itemForTypedLine(
  tx: Prisma.TransactionClient,
  line: { name: string | null; partNumber: string | null; description: string; unit: string },
  actorId: string,
  /** The product group the incoming line named (2026-10-20): a new item's, and a matched item's when it has none. */
  categoryId: string | null = null,
): Promise<string> {
  const matched = await matchTypedItem(tx, line);
  if (matched) {
    if (categoryId) await tx.item.updateMany({ where: { id: matched, categoryId: null }, data: { categoryId } });
    return matched;
  }
  const part = line.partNumber?.trim() || null;
  const name = (line.name?.trim() || line.description.trim()).slice(0, 300);
  const code = await nextNumber('item', tx);
  const created = await tx.item.create({ data: { code, name, partNumber: part, unit: line.unit || 'pcs', categoryId } });
  await tx.auditLog.create({
    data: { entityType: 'item', entityId: created.id, action: 'CREATED', summary: `${code} ${name} added on receiving a purchase order line`, actorId: actorId || null },
  });
  return created.id;
}

/** The one active item a typed line is — by part number or code, else by name — or null when it would be filed new. */
export async function matchTypedItem(
  db: Prisma.TransactionClient | typeof prisma,
  line: { name: string | null; partNumber: string | null; description: string },
): Promise<string | null> {
  const part = line.partNumber?.trim() || null;
  const name = (line.name?.trim() || line.description.trim()).slice(0, 300);
  const found = part
    ? await db.item.findMany({ where: { isActive: true, OR: [{ partNumber: { equals: part, mode: 'insensitive' } }, { code: { equals: part, mode: 'insensitive' } }] }, select: { id: true }, take: 2 })
    : [];
  if (found.length === 1) return found[0].id;
  if (!found.length) {
    const byName = await db.item.findMany({ where: { isActive: true, name: { equals: name, mode: 'insensitive' } }, select: { id: true }, take: 2 });
    if (byName.length === 1) return byName[0].id;
  }
  return null;
}

/**
 * Receipts posted before 2026-10-16 against a stock replenishment order whose
 * line named no item built no stock. Each such line now takes its item and
 * the stock it brought, at its own cost and date, once: the order line is
 * linked, so a second run finds nothing.
 */
export async function repairTypedStockReceipts(): Promise<number> {
  const lines = await prisma.receivingItem.findMany({
    where: {
      receiving: { status: 'RECEIVED', order: { kind: 'STOCK_REPLENISHMENT' } },
      orderItem: { itemId: null },
    },
    include: { orderItem: true, receiving: { include: { order: { select: { warehouseId: true } } } } },
    orderBy: { receiving: { receivedDate: 'asc' } },
  });
  let fixed = 0;
  for (const line of lines) {
    const orderItem = line.orderItem!;
    const warehouseId = line.receiving.warehouseId ?? line.receiving.order?.warehouseId;
    if (!warehouseId) continue;
    await prisma.$transaction(async (tx) => {
      const current = await tx.purchaseOrderItem.findUniqueOrThrow({ where: { id: orderItem.id } });
      const itemId = current.itemId ?? (await itemForTypedLine(tx, current, line.receiving.receivedById ?? ''));
      if (!current.itemId) await tx.purchaseOrderItem.update({ where: { id: current.id }, data: { itemId } });
      await receiveStock(tx, {
        itemId,
        warehouseId,
        quantity: Number(line.quantity),
        unitCost: Number(line.unitCost),
        sourceType: 'receiving',
        sourceId: line.receiving.id,
        sourceNumber: line.receiving.number,
        notes: 'Stock a typed order line brought, posted late',
        createdById: line.receiving.receivedById ?? null,
        occurredAt: line.receiving.receivedDate,
      });
    }, { timeout: 30000 });
    fixed += 1;
  }
  return fixed;
}
