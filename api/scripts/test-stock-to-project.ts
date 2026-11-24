/**
 * Proves moveStockPurchaseToProject() on a fixture built inside a transaction
 * that is rolled back at the end — nothing stays in the database.
 *
 *   npx tsx scripts/test-stock-to-project.ts
 */
import { prisma } from '../src/prisma';
import { receiveStock } from '../src/shared/inventory';
import { moveStockPurchaseToProject } from '../src/shared/stockToProject';

let failed = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? '✓' : '✗'} ${what}`); if (!ok) failed += 1; };
class Rollback extends Error {}

async function main() {
  const tag = `ZZSTP${Date.now()}`;
  try {
    await prisma.$transaction(async (tx) => {
      const job = await tx.job.findFirstOrThrow({ where: { status: { not: 'CANCELLED' } }, select: { id: true, number: true } });
      const wh = await tx.warehouse.findFirstOrThrow({ where: { isActive: true }, select: { id: true } });
      const user = await tx.user.findFirstOrThrow({ where: { isSuperAdmin: true }, select: { id: true } });
      const supplier = await tx.supplier.findFirstOrThrow({ select: { id: true } });
      const mat = await tx.costCategory.findFirstOrThrow({ where: { code: 'MAT' }, select: { id: true } });
      const item = await tx.item.create({ data: { code: `${tag}-I`, name: `${tag} enclosure`, unit: 'pcs' } });

      const pr = await tx.purchaseRequest.create({
        data: { number: `${tag}-PR`, kind: 'STOCK_REPLENISHMENT', status: 'ORDERED', warehouseId: wh.id, requestedById: user.id, purpose: tag,
          items: { create: [{ itemId: item.id, description: 'enclosure', quantity: 1, unit: 'pcs', estimatedCost: 19140, orderedQty: 1 }] } },
        include: { items: true },
      });
      const po = await tx.purchaseOrder.create({
        data: { number: `${tag}-PO`, kind: 'STOCK_REPLENISHMENT', status: 'RECEIVED', supplierId: supplier.id, requestId: pr.id, warehouseId: wh.id, createdById: user.id, subtotal: 18565.8, total: 18565.8,
          items: { create: [{ itemId: item.id, requestItemId: pr.items[0].id, description: 'enclosure', quantity: 1, unit: 'pcs', unitPrice: 18565.8, amount: 18565.8, receivedQty: 1 }] } },
        include: { items: true },
      });
      const rec = await tx.receiving.create({
        data: { number: `${tag}-RR`, status: 'RECEIVED', orderId: po.id, warehouseId: wh.id, receivedById: user.id,
          items: { create: [{ orderItemId: po.items[0].id, itemId: item.id, quantity: 1, unitCost: 19140 }] } },
      });
      await receiveStock(tx, { itemId: item.id, warehouseId: wh.id, quantity: 1, unitCost: 19140, sourceType: 'receiving', sourceId: rec.id, sourceNumber: rec.number });
      const si = await tx.stockIssue.create({
        data: { number: `${tag}-SI`, status: 'DRAFT', jobId: job.id, warehouseId: wh.id, purpose: tag, issuedById: user.id,
          items: { create: [{ itemId: item.id, quantity: 1, unitCost: 19140, costCategoryId: mat.id }] } },
      });

      const adaptor = await tx.item.create({ data: { code: `${tag}-A`, name: `${tag} adaptor`, unit: 'pcs' } });
      await receiveStock(tx, { itemId: adaptor.id, warehouseId: wh.id, quantity: 1, unitCost: 1485, sourceType: 'test', sourceNumber: tag });
      const slip = await tx.pulloutSlip.create({
        data: { number: `${tag}-PS`, kind: 'OTHER', purpose: 'OTHER', warehouseId: wh.id, preparedById: user.id, pulloutDate: new Date(), destination: 'GAS ION', reason: tag,
          items: { create: [{ itemId: item.id, quantity: 1, unitCost: 19140, amount: 19140 }, { itemId: adaptor.id, quantity: 1, unitCost: 1485, amount: 1485, sortOrder: 1 }] } },
      });
      const r = await moveStockPurchaseToProject({ mark: `${tag}.mark`, requestNumber: pr.number, projectNumber: job.number, pullouts: [slip.number] }, { tx });
      check(!!r?.done, `moved (${r && !r.done ? r.reason : r?.done ? r.moved.join(', ') : 'null'})`);
      const pr2 = await tx.purchaseRequest.findUniqueOrThrow({ where: { id: pr.id } });
      const po2 = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: { items: true } });
      check(pr2.kind === 'DIRECT_TO_JOB' && pr2.jobId === job.id, 'the request is the project\'s');
      check(po2.kind === 'DIRECT_TO_JOB' && po2.jobId === job.id && po2.items[0].costCategoryId === mat.id, 'the order is the project\'s, on Materials');
      const bal = await tx.inventoryBalance.findUnique({ where: { itemId_warehouseId: { itemId: item.id, warehouseId: wh.id } } });
      check(Number(bal?.quantity ?? 0) === 0, `off the company shelf (${Number(bal?.quantity ?? 0)})`);
      const ps = await tx.projectStock.findUnique({ where: { jobId_itemId_warehouseId: { jobId: job.id, itemId: item.id, warehouseId: wh.id } } });
      check(Number(ps?.quantity) === 1 && Number(ps?.averageCost) === 19140, 'on the shelf as the project\'s stock at 19,140');
      const led = await tx.jobCostEntry.findMany({ where: { jobId: job.id, sourceId: rec.id } });
      check(led.length === 1 && led[0].state === 'INCURRED' && Number(led[0].amount) === 19140 && led[0].costCategoryId === mat.id, 'the project charged INCURRED 19,140 on Materials');
      const line = await tx.stockIssueItem.findFirstOrThrow({ where: { issueId: si.id } });
      check(line.projectStock, 'the draft Outgoing line takes it from the project\'s stock');
      const ps2 = await tx.pulloutSlip.findUniqueOrThrow({ where: { id: slip.id }, include: { items: true } });
      check(ps2.kind === 'PROJECT_STOCK' && ps2.jobId === job.id && ps2.purpose === 'PROJECT_USE' && ps2.items.length === 1 && ps2.items[0].itemId === item.id, "the slip pulls out the project's enclosure alone");
      const twin = await tx.pulloutSlip.findFirst({ where: { reason: { contains: `split from ${slip.number}` } }, include: { items: true } });
      check(!!twin && twin.kind === 'OTHER' && twin.jobId === job.id && twin.status === 'DRAFT' && twin.destination === 'GAS ION' && twin.items.length === 1 && twin.items[0].itemId === adaptor.id, `the adaptor is on a new slip for the project (${twin?.number})`);
      const a2 = await tx.item.findUniqueOrThrow({ where: { id: adaptor.id } });
      check(a2.costCategoryId === mat.id, 'the adaptor item has a budget line (Materials)');
      const again = await moveStockPurchaseToProject({ mark: `${tag}.mark`, requestNumber: pr.number, projectNumber: job.number }, { tx });
      check(again === null, 'a second run does nothing');
      throw new Rollback();
    }, { timeout: 60_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
    console.log('Rolled back — nothing kept.');
  }
}

main().catch((e) => { console.error(e); failed += 1; }).finally(async () => { await prisma.$disconnect(); if (failed) process.exitCode = 1; });
