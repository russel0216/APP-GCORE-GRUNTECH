import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { nextNumber } from './numbering';
import { typedIdentity } from './typedItems';

const MARK = 'seed.typedItemsSplit20261123';
const D = (n: number) => new Prisma.Decimal(n);
const num = (d: Prisma.Decimal | number | null | undefined) => (d == null ? 0 : Number(d));

/**
 * Items filed from typed order lines by NAME alone before 2026-11-23 — when
 * several lines of one name, told apart only by their descriptions (THHN
 * WIRE RED / YELLOW / BLUE 8.0mm² on GT-PO-2026-0039), became one item — are
 * split once: the item keeps the first description's lines and takes its full
 * name, each other description gets an item of its own, and with it its order
 * lines, its receipts and, from the pull-out slips that took the merged item,
 * its share (in the order received). Only where every unit received has also
 * left by pull-out slip and nothing else moved the item — anything else is
 * named in the seed's log for a hand repair, never guessed.
 */
export async function splitMergedTypedItems(): Promise<{ split: string[]; skipped: string[] } | null> {
  if (await prisma.setting.findUnique({ where: { key: MARK } })) return null;
  const filed = await prisma.auditLog.findMany({
    where: { entityType: 'item', action: 'CREATED', summary: { endsWith: 'added on receiving a purchase order line' } },
    select: { entityId: true },
  });
  const split: string[] = [];
  const skipped: string[] = [];
  for (const { entityId } of filed) {
    const item = await prisma.item.findUnique({ where: { id: entityId } });
    if (!item) continue;
    const lines = await prisma.purchaseOrderItem.findMany({ where: { itemId: item.id }, orderBy: { id: 'asc' } });
    const groups = new Map<string, typeof lines>();
    for (const l of lines) {
      const key = typedIdentity(l).name.toLowerCase();
      groups.set(key, [...(groups.get(key) ?? []), l]);
    }
    if (groups.size < 2) continue;
    const result = await splitOne(item, [...groups.values()]);
    (result === true ? split : skipped).push(result === true ? `${item.code} ${item.name}` : `${item.code} ${item.name}: ${result}`);
  }
  await prisma.setting.upsert({
    where: { key: MARK },
    create: { key: MARK, value: { at: new Date().toISOString(), split, skipped }, description: 'Typed items merged by name, split by description once, 2026-11-23' },
    update: {},
  });
  return { split, skipped };
}

type OrderLine = Prisma.PurchaseOrderItemGetPayload<object>;

/** A split refused — thrown, so the transaction leaves nothing half done. */
class Skip extends Error {}

async function splitOne(item: Prisma.ItemGetPayload<object>, groups: OrderLine[][]): Promise<true | string> {
  try {
    return await splitInside(item, groups);
  } catch (e) {
    if (e instanceof Skip) return e.message;
    throw e;
  }
}

function splitInside(item: Prisma.ItemGetPayload<object>, groups: OrderLine[][]): Promise<true> {
  return prisma.$transaction(
    async (tx) => {
      const moves = await tx.inventoryTransaction.findMany({ where: { itemId: item.id }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] });
      if (moves.some((m) => !(m.type === 'RECEIPT' && m.sourceType === 'receiving') && !(m.type === 'ISSUE' && m.sourceType === 'pullout_slip')))
        throw new Skip('moved by something other than an Incoming or a pull-out slip');
      const received = moves.filter((m) => m.type === 'RECEIPT').reduce((s, m) => s + num(m.quantity), 0);
      const issued = -moves.filter((m) => m.type === 'ISSUE').reduce((s, m) => s + num(m.quantity), 0);
      if (Math.abs(received - issued) > 0.0005) throw new Skip(`${received - issued} still on a shelf`);
      if (await tx.borrowSlipItem.count({ where: { itemId: item.id } })) throw new Skip('on a borrow slip');
      if (await tx.stockIssueItem.count({ where: { itemId: item.id } })) throw new Skip('on an Outgoing slip');

      // Each group's item: the first keeps this one; the others are filed new.
      const groupItem: string[] = [];
      for (const [g, group] of groups.entries()) {
        const who = typedIdentity(group[0]);
        if (g === 0) {
          await tx.item.update({ where: { id: item.id }, data: { name: who.name, description: item.description ?? who.description } });
          groupItem.push(item.id);
        } else {
          const code = await nextNumber('item', tx);
          const made = await tx.item.create({
            data: {
              code,
              name: who.name,
              description: who.description,
              partNumber: group[0].partNumber?.trim() || null,
              unit: item.unit,
              categoryId: item.categoryId,
              costCategoryId: item.costCategoryId,
              itemType: item.itemType,
              createdById: item.createdById,
            },
          });
          await tx.purchaseOrderItem.updateMany({ where: { id: { in: group.map((l) => l.id) } }, data: { itemId: made.id } });
          await tx.purchaseRequestItem.updateMany({ where: { id: { in: group.map((l) => l.requestItemId).filter((x): x is string => !!x) }, itemId: item.id }, data: { itemId: made.id } });
          await tx.auditLog.create({
            data: { entityType: 'item', entityId: made.id, action: 'CREATED', summary: `${code} ${who.name} split from ${item.code}, which merged lines of different descriptions`, actorId: null },
          });
          groupItem.push(made.id);
        }
      }

      // Receipts: each receiving line's movement goes to its line's item
      // (paired within a receiving by quantity and cost — identical pairs are indistinguishable).
      const lineGroup = new Map<string, number>();
      groups.forEach((group, g) => group.forEach((l) => lineGroup.set(l.id, g)));
      const recLines = await tx.receivingItem.findMany({ where: { orderItemId: { in: [...lineGroup.keys()] }, receiving: { status: 'RECEIVED' } }, orderBy: { id: 'asc' } });
      const receiptsOf = new Map<number, number>(); // group → quantity received
      const pool = moves.filter((m) => m.type === 'RECEIPT');
      for (const rl of recLines) {
        const g = lineGroup.get(rl.orderItemId!)!;
        const at = pool.findIndex((m) => m.sourceId === rl.receivingId && Math.abs(num(m.quantity) - num(rl.quantity)) < 0.0005);
        if (at < 0) throw new Skip(`receipt for ${rl.id} not found`);
        const [m] = pool.splice(at, 1);
        await tx.inventoryTransaction.update({ where: { id: m.id }, data: { itemId: groupItem[g] } });
        receiptsOf.set(g, (receiptsOf.get(g) ?? 0) + num(m.quantity));
      }
      if (pool.length) throw new Skip(`${pool.length} receipt(s) with no order line`);

      // Pull-outs: what each slip took is shared out in the order received.
      const left = groups.map((_, g) => receiptsOf.get(g) ?? 0);
      const pulled = await tx.pulloutItem.findMany({ where: { itemId: item.id }, include: { slip: { select: { id: true, number: true } } }, orderBy: [{ slip: { pulloutDate: 'asc' } }, { sortOrder: 'asc' }] });
      for (const p of pulled) {
        let want = num(p.quantity);
        const parts: Array<{ g: number; q: number }> = [];
        for (let g = 0; g < left.length && want > 0.0005; g++) {
          const q = Math.min(left[g], want);
          if (q > 0.0005) {
            parts.push({ g, q });
            left[g] -= q;
            want -= q;
          }
        }
        if (want > 0.0005) throw new Skip(`${p.slip.number} took more than was received`);
        const issue = moves.find((m) => m.type === 'ISSUE' && m.sourceId === p.slipId && Math.abs(-num(m.quantity) - num(p.quantity)) < 0.0005);
        if (!issue) throw new Skip(`the movement of ${p.slip.number} not found`);
        const cost = num(p.unitCost);
        for (const [n, part] of parts.entries()) {
          const amount = D(Math.round(part.q * cost * 100) / 100);
          if (n === 0) {
            await tx.pulloutItem.update({ where: { id: p.id }, data: { itemId: groupItem[part.g], quantity: D(part.q), amount } });
            await tx.inventoryTransaction.update({ where: { id: issue.id }, data: { itemId: groupItem[part.g], quantity: D(-part.q) } });
          } else {
            await tx.pulloutItem.create({
              data: {
                slipId: p.slipId,
                itemId: groupItem[part.g],
                sourceLineId: p.sourceLineId,
                quantity: D(part.q),
                unitCost: p.unitCost,
                amount,
                sortOrder: p.sortOrder,
                serialNo: p.serialNo,
                condition: p.condition,
                orderStock: p.orderStock,
              },
            });
            const { id: _id, ...rest } = issue;
            await tx.inventoryTransaction.create({ data: { ...rest, itemId: groupItem[part.g], quantity: D(-part.q) } });
          }
        }
        // Keep the slip's lines in order: the split lines sit where the merged one did.
        const all = await tx.pulloutItem.findMany({ where: { slipId: p.slipId }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
        for (const [n, row] of all.entries()) await tx.pulloutItem.update({ where: { id: row.id }, data: { sortOrder: n } });
      }

      // Running balances on each item's movements, per holder and warehouse.
      for (const id of groupItem) {
        const own = await tx.inventoryTransaction.findMany({ where: { itemId: id }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] });
        const run = new Map<string, number>();
        for (const m of own) {
          const key = [m.warehouseId, m.jobId, m.salesOrderId, m.quotationId].join('|');
          const after = (run.get(key) ?? 0) + num(m.quantity);
          run.set(key, after);
          await tx.inventoryTransaction.update({ where: { id: m.id }, data: { balanceAfter: D(Math.round(after * 1000) / 1000) } });
        }
      }
      // The empty shelves the merged item held: one each for every item now.
      for (const ps of await tx.projectStock.findMany({ where: { itemId: item.id } })) {
        for (const id of groupItem.slice(1))
          await tx.projectStock.upsert({
            where: { jobId_itemId_warehouseId: { jobId: ps.jobId, itemId: id, warehouseId: ps.warehouseId } },
            create: { jobId: ps.jobId, itemId: id, warehouseId: ps.warehouseId, quantity: D(0), averageCost: ps.averageCost },
            update: {},
          });
      }
      for (const os of await tx.salesOrderStock.findMany({ where: { itemId: item.id } })) {
        for (const id of groupItem.slice(1))
          await tx.salesOrderStock.upsert({
            where: { salesOrderId_itemId_warehouseId: { salesOrderId: os.salesOrderId, itemId: id, warehouseId: os.warehouseId } },
            create: { salesOrderId: os.salesOrderId, itemId: id, warehouseId: os.warehouseId, quantity: D(0), averageCost: os.averageCost },
            update: {},
          });
      }
      await tx.auditLog.create({
        data: {
          entityType: 'item',
          entityId: item.id,
          action: 'UPDATED',
          summary: `${item.code} split by description into ${groups.length} items — its lines were different goods of one name`,
          actorId: null,
        },
      });
      return true as const;
    },
    { timeout: 60000 },
  );
}
