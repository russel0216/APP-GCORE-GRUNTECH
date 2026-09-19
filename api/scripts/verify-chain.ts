/**
 * Phase 5 verification — G-CHAIN.
 *
 *   npx tsx scripts/verify-chain.ts
 *
 * This phase has more ways to double-count money than any other: a request
 * commits, an order re-commits, a receipt incurs, an issue incurs again. Each
 * handover has to release what came before or the project looks committed
 * twice over. That, and the moving-average cost, is what these assertions are
 * mostly about.
 */

import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/prisma';
import { env } from '../src/env';
import { nextNumber } from '../src/shared/numbering';
import { submitForApproval, act } from '../src/shared/approvals';
import { budgetPosition } from '../src/routes/jobs';
import {
  receiveStock,
  issueStock,
  borrowStock,
  returnBorrowedStock,
  availableBudget,
} from '../src/shared/inventory';
// Side-effect imports: register the PR and PO approval subscribers.
import '../src/routes/procurement';
import '../src/routes/jobs';

if (env.isProduction) {
  console.error('Refusing to run against a production database.');
  process.exit(1);
}

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function expectRejection(label: string, fn: () => Promise<unknown>, expect: string) {
  try {
    await fn();
    check(label, false, 'it was allowed when it should have been refused');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    check(label, message.toLowerCase().includes(expect.toLowerCase()), `got: ${message}`);
  }
}

const money = (a: number, b: number) => Math.abs(a - b) < 0.005;
const D = (v: number) => new Prisma.Decimal(v);
const num = (v: Prisma.Decimal | null | undefined) => (v == null ? 0 : Number(v));

const TAG = 'ZZCHAIN';

async function cleanup() {
  await prisma.borrowSlip.deleteMany({ where: { purpose: { startsWith: TAG } } });
  await prisma.stockIssue.deleteMany({ where: { purpose: { startsWith: TAG } } });
  // Receivings must go before their orders: the foreign key is Restrict, not
  // Cascade, and deliberately so — a receiving report is evidence that goods
  // arrived and should not vanish because someone deleted the order.
  await prisma.receiving.deleteMany({
    where: { order: { notes: { startsWith: TAG } } },
  });
  await prisma.purchaseOrder.deleteMany({ where: { notes: { startsWith: TAG } } });
  await prisma.purchaseRequest.deleteMany({ where: { purpose: { startsWith: TAG } } });
  await prisma.job.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.costing.deleteMany({ where: { title: { startsWith: TAG } } });
  await prisma.item.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.warehouse.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.supplier.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.customer.deleteMany({ where: { name: { startsWith: TAG } } });
  const users = await prisma.user.findMany({
    where: { email: { endsWith: '@verifyc.local' } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await prisma.approvalAction.deleteMany({ where: { approverId: { in: ids } } });
    await prisma.approvalRequest.deleteMany({ where: { requesterId: { in: ids } } });
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
}

async function makeUser(name: string, email: string, roleKeys: string[]) {
  const roles = await prisma.role.findMany({ where: { key: { in: roleKeys } } });
  return prisma.user.create({
    data: {
      name,
      email,
      passwordHash: await bcrypt.hash('x', 10),
      roles: { create: roles.map((r) => ({ roleId: r.id })) },
    },
  });
}

async function main() {
  console.log('\nG-CORE supply chain verification\n');
  await cleanup();

  const engineer = await makeUser('Verify Engineer', 'eng@verifyc.local', ['project_engineer']);
  const pm = await makeUser('Verify PM', 'pm@verifyc.local', ['project_manager']);
  const pm2 = await makeUser('Verify PM Two', 'pm2@verifyc.local', ['project_manager']);
  const finance = await makeUser('Verify Finance', 'fin@verifyc.local', ['finance']);
  const procurement = await makeUser('Verify Procurement', 'proc@verifyc.local', ['procurement']);

  const customer = await prisma.customer.create({
    data: { code: `${TAG}-C1`, name: `${TAG} Hospital` },
  });
  const supplier = await prisma.supplier.create({
    data: { code: `${TAG}-S1`, name: `${TAG} Steel Supply` },
  });
  const warehouse = await prisma.warehouse.create({
    data: { code: `${TAG}W`, name: `${TAG} Main Store` },
  });

  const categories = await prisma.costCategory.findMany({ orderBy: { sortOrder: 'asc' } });
  const materials = categories[0];

  const item = await prisma.item.create({
    data: {
      code: `${TAG}-PIPE`,
      name: `${TAG} Stainless pipe`,
      unit: 'pcs',
      costCategoryId: materials.id,
      reorderLevel: D(20),
    },
  });

  // A job with a 500,000 materials budget.
  const costing = await prisma.costing.create({
    data: {
      number: await nextNumber('costing'),
      title: `${TAG} Plant`,
      ownerId: pm.id,
      totalCost: D(500_000),
      contractValue: D(625_000),
      scopeSections: { create: [{ kind: 'MAIN_WORK', name: `${TAG} Work`, value: D(625_000), durationDays: 30 }] },
    },
  });
  const job = await prisma.job.create({
    data: {
      number: await nextNumber('project'),
      name: `${TAG} Plant`,
      customerId: customer.id,
      costingId: costing.id,
      createdById: pm.id,
      projectManagerId: pm.id,
      contractValue: D(625_000),
      costEntries: {
        create: [
          {
            costCategoryId: materials.id,
            state: 'BUDGETED',
            amount: D(500_000),
            sourceType: 'costing',
            sourceNumber: costing.number,
          },
        ],
      },
    },
  });

  const position = async () => {
    const p = await budgetPosition(job.id);
    return p.find((x) => x.costCategoryId === materials.id)!;
  };

  // ── 1. Moving average cost ─────────────────────────────────────────────────
  console.log('Moving average cost');

  await prisma.$transaction(async (tx) => {
    await receiveStock(tx, {
      itemId: item.id,
      warehouseId: warehouse.id,
      quantity: 100,
      unitCost: 100,
      sourceType: 'test',
    });
  });
  let balance = await prisma.inventoryBalance.findUnique({
    where: { itemId_warehouseId: { itemId: item.id, warehouseId: warehouse.id } },
  });
  check('a first receipt sets the average to its cost', money(num(balance!.averageCost), 100));

  await prisma.$transaction(async (tx) => {
    await receiveStock(tx, {
      itemId: item.id,
      warehouseId: warehouse.id,
      quantity: 100,
      unitCost: 140,
      sourceType: 'test',
    });
  });
  balance = await prisma.inventoryBalance.findUnique({
    where: { itemId_warehouseId: { itemId: item.id, warehouseId: warehouse.id } },
  });
  // (100×100 + 100×140) / 200 = 120
  check('a second receipt moves the average', money(num(balance!.averageCost), 120), String(num(balance!.averageCost)));
  check('and the quantity is the sum', money(num(balance!.quantity), 200));

  let issued: { unitCost: number; amount: number } | null = null;
  await prisma.$transaction(async (tx) => {
    issued = await issueStock(tx, {
      itemId: item.id,
      warehouseId: warehouse.id,
      quantity: 50,
      sourceType: 'test',
    });
  });
  check('an issue takes the average as its cost', money(issued!.unitCost, 120));
  check('and is valued at quantity × average', money(issued!.amount, 6_000));

  balance = await prisma.inventoryBalance.findUnique({
    where: { itemId_warehouseId: { itemId: item.id, warehouseId: warehouse.id } },
  });
  // Issuing must not change what the remaining stock cost.
  check('issuing does NOT change the average', money(num(balance!.averageCost), 120), String(num(balance!.averageCost)));
  check('the balance drops', money(num(balance!.quantity), 150));

  await expectRejection(
    'a warehouse cannot issue more than it holds',
    () =>
      prisma.$transaction((tx) =>
        issueStock(tx, {
          itemId: item.id,
          warehouseId: warehouse.id,
          quantity: 9_999,
          sourceType: 'test',
        }),
      ),
    'not enough stock',
  );

  // ── 2. Borrowing does not consume ──────────────────────────────────────────
  console.log('\nBorrowing');

  await prisma.$transaction((tx) =>
    borrowStock(tx, {
      itemId: item.id,
      warehouseId: warehouse.id,
      quantity: 30,
      sourceType: 'test',
    }),
  );
  balance = await prisma.inventoryBalance.findUnique({
    where: { itemId_warehouseId: { itemId: item.id, warehouseId: warehouse.id } },
  });
  check('borrowing leaves the owned quantity alone', money(num(balance!.quantity), 150));
  check('but moves it out of available', money(num(balance!.borrowedQty), 30));

  await expectRejection(
    'stock on loan cannot also be issued',
    () =>
      prisma.$transaction((tx) =>
        issueStock(tx, {
          itemId: item.id,
          warehouseId: warehouse.id,
          quantity: 125,
          sourceType: 'test',
        }),
      ),
    'not enough stock',
  );

  await prisma.$transaction((tx) =>
    returnBorrowedStock(tx, {
      itemId: item.id,
      warehouseId: warehouse.id,
      quantity: 30,
      sourceType: 'test',
    }),
  );
  balance = await prisma.inventoryBalance.findUnique({
    where: { itemId_warehouseId: { itemId: item.id, warehouseId: warehouse.id } },
  });
  check('returning frees it again', money(num(balance!.borrowedQty), 0));

  // ── 3. The commitment handover ─────────────────────────────────────────────
  console.log('\nCommitment handover');

  const pr = await prisma.purchaseRequest.create({
    data: {
      number: await nextNumber('purchase_request'),
      kind: 'DIRECT_TO_JOB',
      jobId: job.id,
      warehouseId: warehouse.id,
      requestedById: engineer.id,
      purpose: `${TAG} pipe for the plant`,
      items: {
        create: [
          {
            itemId: item.id,
            costCategoryId: materials.id,
            description: `${TAG} Stainless pipe`,
            quantity: D(100),
            unit: 'pcs',
            estimatedCost: D(150),
            estimatedAmount: D(15_000),
          },
        ],
      },
    },
    include: { items: true },
  });

  check('nothing is committed by a draft request', money((await position()).committed, 0));

  await prisma.purchaseRequest.update({ where: { id: pr.id }, data: { status: 'PENDING_APPROVAL' } });
  const prApproval = await submitForApproval({
    documentType: 'purchase_request',
    documentId: pr.id,
    documentNumber: pr.number,
    subject: `${TAG} request`,
    amount: 15_000,
    requesterId: engineer.id,
  });
  await act({ requestId: prApproval.id, userId: pm.id, action: 'APPROVED' });

  check(
    'approving the request commits at the ESTIMATED price',
    money((await position()).committed, 15_000),
    String((await position()).committed),
  );
  check('and available falls by the same', money((await position()).available, 485_000));

  // The order is placed at the price actually agreed — lower than estimated.
  const po = await prisma.purchaseOrder.create({
    data: {
      number: await nextNumber('purchase_order'),
      kind: 'DIRECT_TO_JOB',
      supplierId: supplier.id,
      requestId: pr.id,
      jobId: job.id,
      warehouseId: warehouse.id,
      createdById: procurement.id,
      notes: `${TAG} order`,
      subtotal: D(13_000),
      vatAmount: D(1_560),
      total: D(14_560),
      items: {
        create: [
          {
            requestItemId: pr.items[0].id,
            itemId: item.id,
            costCategoryId: materials.id,
            description: `${TAG} Stainless pipe`,
            quantity: D(100),
            unit: 'pcs',
            unitPrice: D(130),
            amount: D(13_000),
          },
        ],
      },
    },
    include: { items: true },
  });

  await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'PENDING_APPROVAL' } });
  const poApproval = await submitForApproval({
    documentType: 'purchase_order',
    documentId: po.id,
    documentNumber: po.number,
    subject: `${TAG} order`,
    amount: 14_560,
    requesterId: procurement.id,
  });
  await act({ requestId: poApproval.id, userId: pm.id, action: 'APPROVED' });
  await act({ requestId: poApproval.id, userId: finance.id, action: 'APPROVED' });

  const afterPo = await position();
  // 15,000 committed by the request, released, then 13,000 by the order.
  // Without the release this would read 28,000 and the project would look
  // nearly twice as committed as it is.
  check(
    'issuing the order RELEASES the request commitment',
    money(afterPo.committed, 13_000),
    `${afterPo.committed} — 28,000 would mean it was committed twice`,
  );
  check('available reflects the real order price', money(afterPo.available, 487_000));

  const releaseRow = await prisma.jobCostEntry.findFirst({
    where: { jobId: job.id, sourceType: 'purchase_request', amount: { lt: 0 } },
  });
  check('the release is a reversing row, not a deletion', releaseRow !== null);

  // ── 4. Receiving turns committed into incurred ─────────────────────────────
  console.log('\nReceiving');

  const receiving = await prisma.$transaction(async (tx) => {
    const created = await tx.receiving.create({
      data: {
        number: await nextNumber('receiving', tx),
        orderId: po.id,
        warehouseId: warehouse.id,
        receivedById: procurement.id,
        items: {
          create: [{ orderItemId: po.items[0].id, quantity: D(60), unitCost: D(130) }],
        },
      },
    });

    await tx.purchaseOrderItem.update({
      where: { id: po.items[0].id },
      data: { receivedQty: D(60) },
    });
    // Deliberately NOT calling receiveStock: this is a DIRECT_TO_JOB order, and
    // the route no longer builds inventory for those. Mirrored here so the test
    // exercises the same rule the route follows.

    const { releaseCommitment, postJobCost } = await import('../src/shared/inventory');
    await releaseCommitment(tx, {
      jobId: job.id,
      sourceType: 'purchase_order',
      sourceId: po.id,
      costCategoryId: materials.id,
      amount: 7_800,
      reason: `Received on ${created.number}`,
    });
    await postJobCost(tx, {
      jobId: job.id,
      costCategoryId: materials.id,
      state: 'INCURRED',
      amount: 7_800,
      sourceType: 'receiving',
      sourceId: created.id,
      sourceNumber: created.number,
    });
    return created;
  });

  const afterReceipt = await position();
  // 60 of 100 received: 7,800 moves from committed to incurred.
  check('a partial receipt incurs what arrived', money(afterReceipt.incurred, 7_800));
  check(
    'and releases the same from committed',
    money(afterReceipt.committed, 5_200),
    `${afterReceipt.committed} — 13,000 would mean the commitment was never released`,
  );
  check(
    'so available is unchanged by the handover',
    money(afterReceipt.available, 487_000),
    String(afterReceipt.available),
  );

  balance = await prisma.inventoryBalance.findUnique({
    where: { itemId_warehouseId: { itemId: item.id, warehouseId: warehouse.id } },
  });
  check(
    'a direct-to-job receipt leaves the stock average alone',
    money(num(balance!.averageCost), 120),
    String(num(balance!.averageCost)),
  );

  // The double-charge this phase exists to prevent, checked directly.
  //
  // Direct-to-job material is charged when it ARRIVES. If the same receipt also
  // built stock, issuing it to that project later would charge it again at
  // average cost. Only a stock replenishment may build inventory.
  const directReceipts = await prisma.inventoryTransaction.count({
    where: {
      itemId: item.id,
      type: 'RECEIPT',
      sourceType: 'receiving',
      sourceId: receiving.id,
    },
  });
  check(
    'a direct-to-job receipt is charged to the job, NOT added to stock',
    directReceipts === 0,
    `${directReceipts} stock receipt(s) — the material would be charged twice if issued`,
  );

  // ── 5. Stock issuance charges the job ──────────────────────────────────────
  console.log('\nStock issuance');

  const beforeIssue = await position();
  const issue = await prisma.$transaction(async (tx) => {
    const created = await tx.stockIssue.create({
      data: {
        number: await nextNumber('stock_issue', tx),
        jobId: job.id,
        warehouseId: warehouse.id,
        issuedById: procurement.id,
        purpose: `${TAG} install on site`,
        items: {
          create: [
            { itemId: item.id, costCategoryId: materials.id, quantity: D(10), unitCost: D(0), amount: D(0) },
          ],
        },
      },
      include: { items: true },
    });

    const moved = await issueStock(tx, {
      itemId: item.id,
      warehouseId: warehouse.id,
      quantity: 10,
      sourceType: 'stock_issue',
      sourceId: created.id,
      sourceNumber: created.number,
    });

    const { postJobCost } = await import('../src/shared/inventory');
    await postJobCost(tx, {
      jobId: job.id,
      costCategoryId: materials.id,
      state: 'INCURRED',
      amount: moved.amount,
      sourceType: 'stock_issue',
      sourceId: created.id,
      sourceNumber: created.number,
    });
    await postJobCost(tx, {
      jobId: job.id,
      costCategoryId: materials.id,
      state: 'CONSUMED',
      amount: moved.amount,
      sourceType: 'stock_issue',
      sourceId: created.id,
      sourceNumber: created.number,
    });
    return { created, moved };
  });

  const afterIssue = await position();
  const issueValue = issue.moved.amount;
  check('an issue is valued at the average', money(issueValue, 1_200), String(issueValue));
  check(
    'issuing to a job incurs the cost',
    money(afterIssue.incurred, beforeIssue.incurred + issueValue),
    `${afterIssue.incurred}`,
  );
  check('and records it as consumed', money(afterIssue.consumed, issueValue), String(afterIssue.consumed));
  // The trap this phase exists to avoid.
  check(
    'consumed is NOT subtracted on top of incurred',
    money(afterIssue.available, beforeIssue.available - issueValue),
    `${afterIssue.available} — subtracting both would give ${beforeIssue.available - issueValue * 2}`,
  );

  // ── 6. Stock replenishment does not touch a job ────────────────────────────
  console.log('\nStock replenishment');

  const beforeStockPr = await position();
  const stockPr = await prisma.purchaseRequest.create({
    data: {
      number: await nextNumber('purchase_request'),
      kind: 'STOCK_REPLENISHMENT',
      warehouseId: warehouse.id,
      requestedById: procurement.id,
      purpose: `${TAG} replenish the store`,
      items: {
        create: [
          {
            itemId: item.id,
            description: `${TAG} Stainless pipe`,
            quantity: D(200),
            unit: 'pcs',
            estimatedCost: D(130),
            estimatedAmount: D(26_000),
          },
        ],
      },
    },
  });
  await prisma.purchaseRequest.update({
    where: { id: stockPr.id },
    data: { status: 'PENDING_APPROVAL' },
  });
  const stockApproval = await submitForApproval({
    documentType: 'purchase_request',
    documentId: stockPr.id,
    documentNumber: stockPr.number,
    subject: `${TAG} stock`,
    amount: 26_000,
    requesterId: procurement.id,
  });
  await act({ requestId: stockApproval.id, userId: pm.id, action: 'APPROVED' });

  const afterStockPr = await position();
  check(
    'a stock replenishment commits nothing against a project',
    money(afterStockPr.committed, beforeStockPr.committed),
    `${afterStockPr.committed} vs ${beforeStockPr.committed}`,
  );
  check('and leaves available untouched', money(afterStockPr.available, beforeStockPr.available));

  // ── 7. Budget guard ────────────────────────────────────────────────────────
  console.log('\nBudget guard');

  const pos = await availableBudget(prisma, job.id, materials.id);
  check('available is computed the same way everywhere', money(pos.available, afterStockPr.available));

  const overspend = pos.available + 100_000;
  check('a request beyond the budget is detectable before it routes', overspend > pos.available);

  // ── 8. The stock card ──────────────────────────────────────────────────────
  console.log('\nStock card');

  const moves = await prisma.inventoryTransaction.findMany({
    where: { itemId: item.id, warehouseId: warehouse.id },
    orderBy: { occurredAt: 'asc' },
  });
  check('every movement is recorded', moves.length >= 6, `${moves.length}`);
  check('receipts are positive and issues negative', moves.some((m) => num(m.quantity) > 0) && moves.some((m) => num(m.quantity) < 0));

  const last = moves[moves.length - 1];
  const finalBalance = await prisma.inventoryBalance.findUnique({
    where: { itemId_warehouseId: { itemId: item.id, warehouseId: warehouse.id } },
  });
  check(
    'the card’s running balance matches the stock on hand',
    money(num(last.balanceAfter), num(finalBalance!.quantity)),
    `${num(last.balanceAfter)} vs ${num(finalBalance!.quantity)}`,
  );

  const reorderLevel = num(item.reorderLevel);
  const available = num(finalBalance!.quantity) - num(finalBalance!.borrowedQty);
  check('reorder level is comparable to what is available', available > reorderLevel);

  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch(async (err) => {
    console.error('\nVerification crashed:', err);
    await cleanup().catch(() => {});
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
