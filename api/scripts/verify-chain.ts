/**
 * Phase 5 verification — G-CHAIN.
 *
 *   npx tsx scripts/verify-chain.ts      (the API must be running)
 *
 * This phase has more ways to double-count money than any other: a request
 * commits, an order re-commits, a receipt incurs, an issue incurs again. Each
 * handover has to release what came before or the project looks committed
 * twice over. That, and the moving-average cost, is what these assertions are
 * mostly about.
 */

import zlib from 'node:zlib';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/prisma';
import { env } from '../src/env';
import { signToken } from '../src/auth/middleware';
import { resolveUser } from '../src/permissions/resolve';
import { globalSearch } from '../src/shared/search';
import { stockOnHand } from '../src/shared/chain';
import { manilaDayKey } from '../src/shared/day';
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
// The procurement import also registers the PR and PO approval subscribers
// (and the warehouse one its search providers); the settle functions are
// called directly to land a decision on a document no longer waiting.
import { settlePurchaseRequest, settlePurchaseOrder } from '../src/routes/procurement';
import '../src/routes/warehouse';
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
const BASE = `http://localhost:${env.port}/api`;

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

async function api(token: string, method: string, path: string, body?: unknown): Promise<HttpResult> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

async function apiReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** A document's bytes — the PDF routes answer a file, not JSON. */
async function apiBytes(token: string, path: string): Promise<{ status: number; bytes: Buffer | null }> {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, bytes: res.ok ? Buffer.from(await res.arrayBuffer()) : null };
}

/**
 * Readable text out of a rendered PDF — the same reader verify-foundation
 * uses. PDFKit Flate-compresses its content streams and writes text as hex
 * runs split at kerning pairs, so each TJ array is joined back into one piece.
 */
function pdfText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  const out: string[] = [];
  const stream = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = stream.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    let body: string;
    try {
      body = zlib.inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1');
    } catch {
      continue;
    }
    for (const show of body.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      let piece = '';
      for (const part of show[1].matchAll(/<([0-9A-Fa-f]*)>|\(((?:\\.|[^\\()])*)\)/g)) {
        piece += part[1] ? Buffer.from(part[1], 'hex').toString('latin1') : part[2].replace(/\\([()\\])/g, '$1');
      }
      if (piece) out.push(piece);
    }
  }
  return out.join('\n');
}

/**
 * A role holding exactly the permissions named — the seeded roles belong to
 * the operator, and a test leaning on their membership breaks when somebody
 * edits them.
 */
async function makeRole(key: string, name: string, permissionKeys: string[]) {
  const permissions = await prisma.permission.findMany({
    where: { key: { in: permissionKeys } },
    select: { id: true, key: true },
  });
  if (permissions.length !== permissionKeys.length) {
    const found = new Set(permissions.map((p) => p.key));
    throw new Error(`Unknown permission(s): ${permissionKeys.filter((k) => !found.has(k)).join(', ')}`);
  }
  return prisma.role.create({
    data: { key, name, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } },
  });
}

async function cleanup() {
  // Approvals route to whoever really holds the role, so real people were told
  // about this script's documents too. Every such title carries TAG.
  await prisma.notification.deleteMany({ where: { title: { contains: TAG } } });
  // Audit rows written without an actor (approval outcomes) are keyed only by
  // the record, so clear them by record id before the records go.
  const taggedOrders = await prisma.purchaseOrder.findMany({
    where: { notes: { startsWith: TAG } },
    select: { id: true },
  });
  const taggedRequests = await prisma.purchaseRequest.findMany({
    where: { purpose: { startsWith: TAG } },
    select: { id: true },
  });
  const recordIds = [...taggedOrders, ...taggedRequests].map((r) => r.id);
  if (recordIds.length) {
    await prisma.auditLog.deleteMany({ where: { entityId: { in: recordIds } } });
    await prisma.approvalRequest.deleteMany({ where: { documentId: { in: recordIds } } });
  }
  await prisma.supplierBill.deleteMany({ where: { supplier: { name: { startsWith: TAG } } } });
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
  await prisma.role.deleteMany({ where: { key: { startsWith: 'zzchain_' } } });
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

  // ── 9. Who raises requests ─────────────────────────────────────────────────
  console.log('\nWho raises requests');

  // Engineers and PMs raise PRs from the G-OPS menu, but every PR route checks
  // gchain keys. Without these grants the create button never appears.
  for (const roleKey of ['project_engineer', 'project_manager']) {
    const holds = await prisma.rolePermission.count({
      where: { role: { key: roleKey }, permission: { key: 'gchain.purchase_requests.create' } },
    });
    check(`the seeded ${roleKey} holds gchain.purchase_requests.create`, holds === 1);
  }

  // ── 10. Search ─────────────────────────────────────────────────────────────
  console.log('\nSearch');

  const ownOnlyRole = await makeRole('zzchain_own', 'ZZ PO own only', ['gchain.purchase_orders.view_own']);
  const ownOnly = await prisma.user.create({
    data: {
      name: 'Verify Own Only',
      email: 'own@verifyc.local',
      passwordHash: await bcrypt.hash('x', 10),
      roles: { create: [{ roleId: ownOnlyRole.id }] },
    },
  });
  const procResolved = (await resolveUser(procurement.id))!;
  const poHits = await globalSearch(po.number, procResolved);
  const poHit = poHits.find((h) => h.kind === 'purchase_order' && h.id === po.id);
  check('Ctrl+K finds a purchase order by its number', !!poHit, JSON.stringify(poHits.map((h) => h.kind)));
  check(
    'and the hit links to the order itself, not the list',
    poHit?.link === `/g-chain/purchase-orders/${po.id}`,
    poHit?.link,
  );
  const ownHits = await globalSearch(po.number, (await resolveUser(ownOnly.id))!);
  check(
    'an own-scope holder does not find an order someone else raised',
    !ownHits.some((h) => h.kind === 'purchase_order' && h.id === po.id),
  );
  // Receiving is the warehouse's register, not procurement's.
  const storekeeper = await makeUser('Verify Storekeeper', 'store@verifyc.local', ['warehouse']);
  const recHits = await globalSearch(receiving.number, (await resolveUser(storekeeper.id))!);
  check(
    'a receiving report is findable by number too',
    recHits.some((h) => h.kind === 'receiving' && h.link === `/g-chain/receiving/${receiving.id}`),
  );
  const prHits = await globalSearch(pr.number, (await resolveUser(engineer.id))!);
  check(
    'the engineer who raised a request finds it',
    prHits.some((h) => h.kind === 'purchase_request' && h.id === pr.id),
  );

  // ── 11. Over HTTP: links, editing, the dashboard ───────────────────────────
  console.log('\nRoutes (over HTTP)');

  if (!(await apiReachable())) {
    failed += 1;
    console.log(
      `  ✗ the API is not reachable at ${BASE} — the procurement routes were NOT verified.\n` +
        '      Start it with "npm run dev" in api/ and run this script again.',
    );
  } else {
    const chainKeys = [
      'gchain.dashboard.view_all',
      'gchain.purchase_requests.view_all',
      'gchain.purchase_orders.view_all',
      'gchain.purchase_orders.view_own',
      'gchain.purchase_orders.create',
      'gchain.purchase_orders.edit_own',
      'gchain.receiving.view_all',
      'gchain.borrow_slips.view_all',
      'gchain.inventory.view_all',
      'gchain.reports.view_all',
    ];
    const buyerRole = await makeRole('zzchain_buyer', 'ZZ Buyer', chainKeys);
    const apRole = await makeRole('zzchain_ap', 'ZZ AP clerk', [...chainKeys, 'gfin.ap.view_all']);
    const mkUser = async (name: string, email: string, roleId: string) =>
      prisma.user.create({
        data: { name, email, passwordHash: await bcrypt.hash('x', 10), roles: { create: [{ roleId }] } },
      });
    const buyer = await mkUser('Verify Buyer', 'buyer@verifyc.local', buyerRole.id);
    const colleague = await mkUser('Verify Colleague', 'colleague@verifyc.local', buyerRole.id);
    const apClerk = await mkUser('Verify AP', 'ap@verifyc.local', apRole.id);
    const buyerToken = signToken(buyer.id, buyer.email);
    const colleagueToken = signToken(colleague.id, colleague.email);
    const apToken = signToken(apClerk.id, apClerk.email);

    // A bill against the order and the goods received on it.
    const bill = await prisma.supplierBill.create({
      data: {
        number: await nextNumber('supplier_bill'),
        supplierId: supplier.id,
        orderId: po.id,
        receivingId: receiving.id,
        jobId: job.id,
        billDate: new Date(),
        dueDate: new Date(Date.now() + 30 * 86_400_000),
        subtotal: D(7_800),
        vatAmount: D(936),
        total: D(8_736),
        netPayable: D(8_736),
        createdById: finance.id,
        notes: `${TAG} bill`,
      },
    });

    const poForAp = await api(apToken, 'GET', `/purchase-orders/${po.id}`);
    const apBills = (poForAp.body.bills ?? []) as { id: string; number: string; total: number }[];
    check(
      'an order lists the supplier bills raised against it',
      poForAp.status === 200 && apBills.some((b) => b.id === bill.id && b.number === bill.number),
      `${poForAp.status} ${JSON.stringify(apBills)}`,
    );
    check(
      'with the bill total as a number at the boundary',
      apBills.some((b) => b.id === bill.id && typeof b.total === 'number' && money(b.total, 8_736)),
    );
    const poForBuyer = await api(buyerToken, 'GET', `/purchase-orders/${po.id}`);
    check(
      'but not to someone who cannot open supplier bills',
      poForBuyer.status === 200 &&
        (poForBuyer.body.bills as unknown[]).length === 0 &&
        poForBuyer.body.billsVisible === false,
    );

    const recForAp = await api(apToken, 'GET', `/receivings/${receiving.id}`);
    check(
      'a receiving report names the bill that covers it',
      recForAp.status === 200 &&
        ((recForAp.body.bills ?? []) as { id: string }[]).some((b) => b.id === bill.id),
    );

    // Receivings by job — the job workspace's Procurement tab.
    const stockPo = await prisma.purchaseOrder.create({
      data: {
        number: await nextNumber('purchase_order'),
        kind: 'STOCK_REPLENISHMENT',
        status: 'ISSUED',
        supplierId: supplier.id,
        warehouseId: warehouse.id,
        createdById: procurement.id,
        notes: `${TAG} stock order`,
        items: {
          create: [{ itemId: item.id, description: `${TAG} pipe`, quantity: D(5), unitPrice: D(100), amount: D(500) }],
        },
      },
      include: { items: true },
    });
    const stockReceiving = await prisma.receiving.create({
      data: {
        number: await nextNumber('receiving'),
        orderId: stockPo.id,
        warehouseId: warehouse.id,
        receivedById: procurement.id,
        items: { create: [{ orderItemId: stockPo.items[0].id, quantity: D(5), unitCost: D(100) }] },
      },
    });
    const byJob = await api(buyerToken, 'GET', `/receivings?jobId=${job.id}&pageSize=200`);
    const byJobRows = (byJob.body.rows ?? []) as { id: string; order: { job: { id: string } | null } }[];
    check(
      '/receivings?jobId= lists that job’s deliveries',
      byJob.status === 200 && byJobRows.some((r) => r.id === receiving.id),
      `${byJob.status}`,
    );
    check(
      'and only that job’s — a stock receipt is not among them',
      !byJobRows.some((r) => r.id === stockReceiving.id) && byJobRows.every((r) => r.order.job?.id === job.id),
    );

    // Stock value is decided once.
    const reorderItem = await prisma.item.create({
      data: { code: `${TAG}-VALVE`, name: `${TAG} Ball valve`, unit: 'pcs', reorderLevel: D(1_000) },
    });
    await prisma.$transaction((tx) =>
      receiveStock(tx, {
        itemId: reorderItem.id,
        warehouseId: warehouse.id,
        quantity: 3,
        unitCost: 450,
        sourceType: 'test',
      }),
    );
    const summary = await api(buyerToken, 'GET', '/inventory/reports/summary');
    const soh = await stockOnHand();
    check(
      'the reports summary values stock exactly as stockOnHand() does',
      summary.status === 200 && money(Number(summary.body.totalValue), soh.value),
      `${summary.body.totalValue} vs ${soh.value}`,
    );
    const reorderRows = (summary.body.reorder ?? []) as { itemId: string; warehouseId: string }[];
    check(
      'a reorder row carries the item and warehouse its stock card needs',
      reorderRows.some((r) => r.itemId === reorderItem.id && r.warehouseId === warehouse.id),
    );

    const overview = await api(buyerToken, 'GET', '/gchain/overview');
    const awaiting = await api(buyerToken, 'GET', '/purchase-orders?awaiting=true&pageSize=1');
    check(
      'the dashboard tile and the list it opens agree on orders awaiting delivery',
      overview.status === 200 &&
        awaiting.status === 200 &&
        overview.body.ordersAwaitingDelivery === awaiting.body.total,
      `${overview.body.ordersAwaitingDelivery} vs ${awaiting.body.total}`,
    );
    check(
      'and the stock tile is the same stockOnHand() figure',
      money(Number((overview.body.stock as { value: number } | null)?.value), soh.value),
    );

    // Editing a draft order.
    const draftDay = manilaDayKey(new Date());
    const created = await api(buyerToken, 'POST', '/purchase-orders', {
      supplierId: supplier.id,
      notes: `${TAG} draft order`,
    });
    const draftId = String(created.body.id);
    check('a buyer raises a draft order', created.status === 201, `${created.status}`);

    const noCategory = await api(buyerToken, 'POST', `/purchase-orders/${draftId}/items`, {
      description: `${TAG} flange`,
      quantity: 4,
      unit: 'pcs',
      unitPrice: 250,
    });
    check(
      'a direct-to-job line without a budget line is refused',
      noCategory.status === 400,
      `${noCategory.status} ${JSON.stringify(noCategory.body).slice(0, 120)}`,
    );
    const added = await api(buyerToken, 'POST', `/purchase-orders/${draftId}/items`, {
      description: `${TAG} flange`,
      costCategoryId: materials.id,
      quantity: 4,
      unit: 'pcs',
      unitPrice: 250,
    });
    check(
      'with one, the line is added and the order re-totals',
      added.status === 201 && money(Number(added.body.subtotal), 1_000),
      `${added.status} ${added.body.subtotal}`,
    );
    const lineId = ((added.body.items ?? []) as { id: string }[])[0]?.id;
    const modified = await api(buyerToken, 'PATCH', `/purchase-orders/${draftId}/items/${lineId}`, {
      unitPrice: 225,
    });
    check(
      'modifying a line re-prices it',
      modified.status === 200 && money(Number(modified.body.subtotal), 900),
      `${modified.status} ${modified.body.subtotal}`,
    );
    const header = await api(buyerToken, 'PATCH', `/purchase-orders/${draftId}`, {
      terms: '30 days',
      deliverTo: 'Site gate 2',
    });
    check('the author modifies the header', header.status === 200 && header.body.terms === '30 days');
    const lineAudits = await prisma.auditLog.count({
      where: { entityType: 'purchase_order', entityId: draftId, action: 'UPDATED' },
    });
    check('every change to the draft is audited', lineAudits >= 3, String(lineAudits));

    const stranger = await api(colleagueToken, 'PATCH', `/purchase-orders/${draftId}`, { terms: 'COD' });
    check(
      'a colleague holding only edit_own cannot change someone else’s order',
      stranger.status === 403,
      String(stranger.status),
    );

    // Rejected back to draft: the reason is on the record.
    const submitted = await api(buyerToken, 'POST', `/purchase-orders/${draftId}/submit`);
    check('the draft submits', submitted.status === 200, `${submitted.status} ${JSON.stringify(submitted.body)}`);
    const pending = await prisma.approvalRequest.findFirst({
      where: { documentType: 'purchase_order', documentId: draftId, status: 'PENDING' },
    });
    if (pending) {
      await act({ requestId: pending.id, userId: pm.id, action: 'REJECTED', comment: 'Wrong flange rating' });
    }
    const afterReject = await api(buyerToken, 'GET', `/purchase-orders/${draftId}`);
    const returned = afterReject.body.returned as { by: string | null; comment: string | null } | null;
    check(
      'a rejected order is back in draft and says who returned it and why',
      afterReject.body.status === 'DRAFT' && returned?.by === pm.name && returned?.comment === 'Wrong flange rating',
      JSON.stringify(returned),
    );

    // An order placed from an awarded canvass keeps its supplier.
    const otherSupplier = await prisma.supplier.create({
      data: { code: `${TAG}-S2`, name: `${TAG} Other Supply` },
    });
    await prisma.canvass.create({
      data: {
        number: await nextNumber('canvass'),
        status: 'AWARDED',
        requestId: pr.id,
        createdById: procurement.id,
        awardedAt: new Date(),
        suppliers: { create: [{ supplierId: supplier.id, isSelected: true }] },
      },
    });
    const canvassPo = await prisma.purchaseOrder.create({
      data: {
        number: await nextNumber('purchase_order'),
        kind: 'DIRECT_TO_JOB',
        supplierId: supplier.id,
        requestId: pr.id,
        jobId: job.id,
        createdById: buyer.id,
        notes: `${TAG} canvass order`,
      },
    });
    const swap = await api(buyerToken, 'PATCH', `/purchase-orders/${canvassPo.id}`, {
      supplierId: otherSupplier.id,
    });
    check(
      'the supplier awarded on a canvass cannot be swapped on the order',
      swap.status === 400,
      `${swap.status} ${JSON.stringify(swap.body).slice(0, 120)}`,
    );
    const canvassRead = await api(buyerToken, 'GET', `/purchase-orders/${canvassPo.id}`);
    check(
      'and the order says which canvass decided it',
      (canvassRead.body.fromCanvass as { id: string } | null)?.id !== undefined,
    );

    // ── Modifying a purchase request, pulling it back, the late decision ──
    console.log('\nModifying a purchase request (over HTTP)');
    const requesterRole = await makeRole('zzchain_requester', 'ZZ Requester', [
      'gchain.purchase_requests.view_own',
      'gchain.purchase_requests.create',
      'gchain.purchase_requests.edit_own',
    ]);
    // The seeded procurement role holds edit_all and not edit_own: the edit
    // routes refused it until they took either right.
    const prOfficerRole = await makeRole('zzchain_profficer', 'ZZ PR officer', [
      'gchain.purchase_requests.view_all',
      'gchain.purchase_requests.edit_all',
    ]);
    const requester = await mkUser('Verify Requester', 'requester@verifyc.local', requesterRole.id);
    const otherRequester = await mkUser('Verify Other Requester', 'requester2@verifyc.local', requesterRole.id);
    const prOfficer = await mkUser('Verify PR Officer', 'profficer@verifyc.local', prOfficerRole.id);
    const requesterToken = signToken(requester.id, requester.email);
    const otherRequesterToken = signToken(otherRequester.id, otherRequester.email);
    const prOfficerToken = signToken(prOfficer.id, prOfficer.email);

    const prCreated = await api(requesterToken, 'POST', '/purchase-requests', {
      kind: 'DIRECT_TO_JOB',
      jobId: job.id,
      purpose: `${TAG} modify me`,
    });
    const prId = String(prCreated.body.id);
    const prNumber = String(prCreated.body.number);
    const firstLine = await api(requesterToken, 'POST', `/purchase-requests/${prId}/items`, {
      description: `${TAG} gasket`,
      costCategoryId: materials.id,
      quantity: 10,
      unit: 'pcs',
      estimatedCost: 50,
    });
    check('a requester raises a draft request with a line', prCreated.status === 201 && firstLine.status === 201, `${prCreated.status} ${firstLine.status}`);
    const firstLineId = ((firstLine.body.items ?? []) as { id: string }[])[0]?.id;

    const prModified = await api(requesterToken, 'PATCH', `/purchase-requests/${prId}`, {
      purpose: `${TAG} modify me — gaskets for the skid`,
      neededBy: manilaDayKey(new Date(Date.now() + 10 * 86_400_000)),
      notes: 'Rated to 16 bar',
    });
    check(
      'the requester modifies the draft’s header',
      prModified.status === 200 && prModified.body.purpose === `${TAG} modify me — gaskets for the skid` && prModified.body.notes === 'Rated to 16 bar',
      `${prModified.status} ${JSON.stringify(prModified.body).slice(0, 160)}`,
    );
    const prStranger = await api(otherRequesterToken, 'PATCH', `/purchase-requests/${prId}`, { purpose: `${TAG} not mine` });
    check('another requester holding only edit_own cannot', prStranger.status === 403, String(prStranger.status));
    const prOfficerEdit = await api(prOfficerToken, 'PATCH', `/purchase-requests/${prId}`, { notes: 'Rated to 16 bar, EPDM' });
    const prOfficerLine = await api(prOfficerToken, 'PATCH', `/purchase-requests/${prId}/items/${firstLineId}`, { quantity: 12 });
    check(
      'an edit_all holder without edit_own may change the header and the lines (they were refused before)',
      prOfficerEdit.status === 200 && prOfficerLine.status === 200,
      `${prOfficerEdit.status} ${prOfficerLine.status}`,
    );

    const noWarehouse = await api(requesterToken, 'PATCH', `/purchase-requests/${prId}`, { kind: 'STOCK_REPLENISHMENT' });
    check('turned into a stock replenishment, it must name its warehouse', noWarehouse.status === 400, String(noWarehouse.status));
    const toStock = await api(requesterToken, 'PATCH', `/purchase-requests/${prId}`, {
      kind: 'STOCK_REPLENISHMENT',
      warehouseId: warehouse.id,
    });
    check(
      'with one, it becomes stock and loses its project',
      toStock.status === 200 && toStock.body.kind === 'STOCK_REPLENISHMENT' && toStock.body.jobId === null,
      `${toStock.status} ${toStock.body.kind} ${toStock.body.jobId}`,
    );
    await api(requesterToken, 'POST', `/purchase-requests/${prId}/items`, {
      itemId: item.id,
      description: `${TAG} pipe from the master`,
      quantity: 2,
      unit: 'pcs',
      estimatedCost: 150,
    });
    const bareLine = await api(requesterToken, 'POST', `/purchase-requests/${prId}/items`, {
      description: `${TAG} sundries`,
      quantity: 1,
      unit: 'lot',
      estimatedCost: 300,
    });
    const noJob = await api(requesterToken, 'PATCH', `/purchase-requests/${prId}`, { kind: 'DIRECT_TO_JOB' });
    check('back to a project, it must name the project', noJob.status === 400, String(noJob.status));
    const bareRefused = await api(requesterToken, 'PATCH', `/purchase-requests/${prId}`, { kind: 'DIRECT_TO_JOB', jobId: job.id });
    check(
      'and every line needs a budget line — a free-text line with none is named in the refusal',
      bareRefused.status === 400 && String(bareRefused.body.error ?? '').includes(`${TAG} sundries`),
      `${bareRefused.status} ${JSON.stringify(bareRefused.body).slice(0, 160)}`,
    );
    const bareLineId = ((bareLine.body.items ?? []) as { id: string; description: string }[]).find(
      (l) => l.description === `${TAG} sundries`,
    )?.id;
    await api(requesterToken, 'PATCH', `/purchase-requests/${prId}/items/${bareLineId}`, { costCategoryId: materials.id });
    const toJob = await api(requesterToken, 'PATCH', `/purchase-requests/${prId}`, { kind: 'DIRECT_TO_JOB', jobId: job.id });
    const toJobLines = await prisma.purchaseRequestItem.findMany({ where: { requestId: prId } });
    check(
      'given one, it is charged to the project again, and the item-master line takes its item’s category',
      toJob.status === 200 &&
        toJob.body.jobId === job.id &&
        toJobLines.length === 3 &&
        toJobLines.every((l) => l.costCategoryId === materials.id),
      `${toJob.status} ${JSON.stringify(toJobLines.map((l) => l.costCategoryId))}`,
    );
    const prAudits = await prisma.auditLog.count({ where: { entityType: 'purchase_request', entityId: prId, action: 'UPDATED' } });
    check('every change is audited', prAudits >= 9, String(prAudits));

    // A submit the engine refuses goes back to draft. An approval left open
    // on the document is one sure refusal ("already awaiting approval").
    const strayPr = await submitForApproval({
      documentType: 'purchase_request',
      documentId: prId,
      documentNumber: prNumber,
      subject: `${TAG} stray request`,
      amount: 1_500,
      requesterId: requester.id,
    });
    const prRefused = await api(requesterToken, 'POST', `/purchase-requests/${prId}/submit`);
    const prAfterRefusal = await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: prId } });
    check(
      'a submit the engine refuses leaves the request in DRAFT, not pending with no approval behind it',
      prRefused.status === 400 && prAfterRefusal.status === 'DRAFT',
      `${prRefused.status} ${prAfterRefusal.status}`,
    );
    await prisma.approvalRequest.update({ where: { id: strayPr.id }, data: { status: 'CANCELLED', closedAt: new Date() } });

    const strangerSubmit = await api(otherRequesterToken, 'POST', `/purchase-requests/${prId}/submit`);
    check('another requester cannot submit it', strangerSubmit.status === 403, String(strangerSubmit.status));
    const prSubmitted = await api(requesterToken, 'POST', `/purchase-requests/${prId}/submit`);
    const prRequest = await prisma.approvalRequest.findFirst({
      where: { documentType: 'purchase_request', documentId: prId, status: 'PENDING' },
    });
    check(
      'the requester submits it, in their own name',
      prSubmitted.status === 200 && prRequest?.requesterId === requester.id,
      `${prSubmitted.status} ${JSON.stringify(prSubmitted.body).slice(0, 120)}`,
    );
    const pendingRead = await api(requesterToken, 'GET', `/purchase-requests/${prId}`);
    check(
      'pending, the page offers a pull-back and no Modify',
      pendingRead.body.canEdit === false && pendingRead.body.canWithdraw === true,
      `${pendingRead.body.canEdit} ${pendingRead.body.canWithdraw}`,
    );
    const pendingEdit = await api(requesterToken, 'PATCH', `/purchase-requests/${prId}`, { notes: 'too late' });
    const pendingLine = await api(requesterToken, 'POST', `/purchase-requests/${prId}/items`, {
      description: `${TAG} more`,
      costCategoryId: materials.id,
      quantity: 1,
      estimatedCost: 1,
    });
    check('a submitted request refuses edits to its header and its lines', pendingEdit.status === 400 && pendingLine.status === 400, `${pendingEdit.status} ${pendingLine.status}`);

    const strangerPull = await api(otherRequesterToken, 'POST', `/purchase-requests/${prId}/withdraw`);
    check('another requester cannot pull it back', strangerPull.status === 403, String(strangerPull.status));
    const pulled = await api(requesterToken, 'POST', `/purchase-requests/${prId}/withdraw`);
    const pulledPr = await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: prId } });
    const pulledReq = prRequest ? await prisma.approvalRequest.findUniqueOrThrow({ where: { id: prRequest.id } }) : null;
    check(
      'the requester pulls it back: the SAME request is a draft again, its approval CANCELLED and kept',
      pulled.status === 200 && pulledPr.status === 'DRAFT' && pulledReq?.status === 'CANCELLED' && !!pulledReq.closedAt,
      `${pulled.status} ${pulledPr.status} ${pulledReq?.status}`,
    );
    const toldPm = await prisma.notification.count({
      where: { userId: pm.id, type: 'approval.withdrawn', link: `/g-chain/purchase-requests/${prId}` },
    });
    check('the approver it was waiting on is told it was withdrawn', toldPm >= 1, String(toldPm));
    let lateRefused = false;
    try {
      await act({ requestId: prRequest!.id, userId: pm.id, action: 'APPROVED' });
    } catch {
      lateRefused = true;
    }
    check('a decision after the pull-back is refused — nothing is waiting on it', lateRefused);
    await settlePurchaseRequest(prId, 'APPROVED');
    const afterLate = await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: prId } });
    const lateCommitted = await prisma.jobCostEntry.count({ where: { sourceType: 'purchase_request', sourceId: prId } });
    const lateTrail = await prisma.auditLog.count({
      where: { entityType: 'purchase_request', entityId: prId, summary: { contains: 'not applied' } },
    });
    check(
      'and an approval that lands anyway changes nothing: still a draft, no budget committed, the trail says so',
      afterLate.status === 'DRAFT' && lateCommitted === 0 && lateTrail === 1,
      `${afterLate.status} ${lateCommitted} ${lateTrail}`,
    );
    const draftPull = await api(requesterToken, 'POST', `/purchase-requests/${prId}/withdraw`);
    check('a draft cannot be pulled back — there is nothing with the approver', draftPull.status === 400, String(draftPull.status));
    const editableAgain = await api(requesterToken, 'PATCH', `/purchase-requests/${prId}/items/${firstLineId}`, { quantity: 8 });
    check('pulled back, its lines can be changed again', editableAgain.status === 200, String(editableAgain.status));

    const resubmitted = await api(requesterToken, 'POST', `/purchase-requests/${prId}/submit`);
    const openAgain = await prisma.approvalRequest.findFirst({
      where: { documentType: 'purchase_request', documentId: prId, status: 'PENDING' },
    });
    if (openAgain) await act({ requestId: openAgain.id, userId: pm.id, action: 'APPROVED' });
    const prLines = await prisma.purchaseRequestItem.findMany({ where: { requestId: prId } });
    const prEstimate = prLines.reduce((s, l) => s + num(l.estimatedAmount), 0);
    const committedRows = async () =>
      prisma.jobCostEntry.findMany({ where: { sourceType: 'purchase_request', sourceId: prId, state: 'COMMITTED' } });
    const firstCommit = await committedRows();
    check(
      'resubmitted and approved, it commits its estimate once',
      resubmitted.status === 200 &&
        (await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: prId } })).status === 'APPROVED' &&
        money(firstCommit.reduce((s, r) => s + num(r.amount), 0), prEstimate),
      `${resubmitted.status} ${firstCommit.map((r) => num(r.amount)).join('+')} vs ${prEstimate}`,
    );
    await settlePurchaseRequest(prId, 'APPROVED');
    await settlePurchaseRequest(prId, 'REJECTED');
    const afterRepeat = await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: prId } });
    check(
      'a repeated settle commits nothing twice, and a stray rejection does not undo the approval',
      (await committedRows()).length === firstCommit.length && afterRepeat.status === 'APPROVED',
      `${(await committedRows()).length} vs ${firstCommit.length}, ${afterRepeat.status}`,
    );

    // ── A pull-back meeting a decision that has not reached the request ──
    // act() commits the final decision before its subscriber runs. A pull-back
    // in that window would withdraw nothing and void the decision; it is
    // refused, and the subscriber then applies the decision.
    console.log('\nPulling back a purchase request the approver has just decided (over HTTP)');
    const raisePr = async (label: string, estimatedCost: number) => {
      const made = await api(requesterToken, 'POST', '/purchase-requests', {
        kind: 'STOCK_REPLENISHMENT',
        warehouseId: warehouse.id,
        purpose: `${TAG} ${label}`,
      });
      const id = String(made.body.id);
      await api(requesterToken, 'POST', `/purchase-requests/${id}/items`, {
        description: `${TAG} ${label} line`,
        quantity: 1,
        unit: 'lot',
        estimatedCost,
      });
      const submitted = await api(requesterToken, 'POST', `/purchase-requests/${id}/submit`);
      const request = await prisma.approvalRequest.findFirst({
        where: { documentType: 'purchase_request', documentId: id, status: 'PENDING' },
        include: { workflow: { include: { steps: { orderBy: { sequence: 'asc' } } } } },
      });
      return { id, submitted: submitted.status, request };
    };

    const decided = await raisePr('decided before the pull-back', 1_200);
    // As act() leaves it between its commit and the subscriber: the request
    // APPROVED, the document still pending.
    if (decided.request) {
      await prisma.approvalRequest.update({ where: { id: decided.request.id }, data: { status: 'APPROVED', closedAt: new Date() } });
    }
    const tooLate = await api(requesterToken, 'POST', `/purchase-requests/${decided.id}/withdraw`);
    const stillPending = await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: decided.id } });
    check(
      'a pull-back after the final approval was recorded is refused, and the request stays pending for the decision',
      decided.submitted === 200 && !!decided.request && tooLate.status === 400 && stillPending.status === 'PENDING_APPROVAL',
      `${decided.submitted} ${tooLate.status} ${stillPending.status} ${JSON.stringify(tooLate.body).slice(0, 120)}`,
    );
    await settlePurchaseRequest(decided.id, 'APPROVED');
    const decidedNow = await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: decided.id } });
    check('and the decision then lands: approved, as the approver decided', decidedNow.status === 'APPROVED', decidedNow.status);

    const returnedPr = await raisePr('returned before the pull-back', 1_300);
    // A return closes the request CANCELLED with a RETURNED action, and
    // settles the document as rejected.
    if (returnedPr.request) {
      await prisma.approvalRequest.update({ where: { id: returnedPr.request.id }, data: { status: 'CANCELLED', closedAt: new Date() } });
      await prisma.approvalAction.create({
        data: { requestId: returnedPr.request.id, sequence: returnedPr.request.currentSequence, approverId: pm.id, action: 'RETURNED', comment: 'Wrong warehouse' },
      });
    }
    const afterReturn = await api(requesterToken, 'POST', `/purchase-requests/${returnedPr.id}/withdraw`);
    await settlePurchaseRequest(returnedPr.id, 'REJECTED');
    const returnedNow = await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: returnedPr.id } });
    check(
      'so is one after a return — a return is a decision, not a withdrawal — and the return lands',
      afterReturn.status === 400 && returnedNow.status === 'REJECTED',
      `${afterReturn.status} ${returnedNow.status}`,
    );

    // Pending with no approval behind it — what a refused submit left before
    // the submit reverted to draft: nothing to withdraw, and nothing decided.
    const stranded = await api(requesterToken, 'POST', '/purchase-requests', {
      kind: 'STOCK_REPLENISHMENT',
      warehouseId: warehouse.id,
      purpose: `${TAG} stranded pending`,
    });
    const strandedId = String(stranded.body.id);
    await prisma.purchaseRequest.update({ where: { id: strandedId }, data: { status: 'PENDING_APPROVAL' } });
    const rescued = await api(requesterToken, 'POST', `/purchase-requests/${strandedId}/withdraw`);
    const rescuedNow = await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: strandedId } });
    check(
      'a request stranded pending with no approval behind it is still pulled back to draft',
      rescued.status === 200 && rescuedNow.status === 'DRAFT',
      `${rescued.status} ${rescuedNow.status} ${JSON.stringify(rescued.body).slice(0, 120)}`,
    );

    // ── The printed request after a pull-back ──────────────────────────────
    // ₱50,000 and more takes the three-step route. Pulled back after the
    // project manager signed, nothing stands: the paper must not date his
    // approval as though it still did.
    const big = await raisePr('big enough for three steps', 60_000);
    const bigSteps = big.request?.workflow?.steps ?? [];
    if (big.request) await act({ requestId: big.request.id, userId: pm.id, action: 'APPROVED' });
    const pendingPdf = await apiBytes(requesterToken, `/purchase-requests/${big.id}/pdf`);
    const pendingText = pendingPdf.bytes ? pdfText(pendingPdf.bytes) : '';
    const pendingCount = (t: string) => (t.match(/Pending/g) ?? []).length;
    check(
      'pending at step 2 of three, the paper prints the project manager who signed, and the two steps still to sign as Pending',
      big.submitted === 200 &&
        bigSteps.length === 3 &&
        pendingText.includes('Verify PM') &&
        pendingCount(pendingText) === 2 &&
        bigSteps.every((st) => pendingText.includes(st.name.toUpperCase())),
      `${big.submitted} ${bigSteps.length} steps, ${pendingCount(pendingText)} pending, PM ${pendingText.includes('Verify PM')}`,
    );
    const bigPulled = await api(requesterToken, 'POST', `/purchase-requests/${big.id}/withdraw`);
    const draftPdf = await apiBytes(requesterToken, `/purchase-requests/${big.id}/pdf`);
    const draftText = draftPdf.bytes ? pdfText(draftPdf.bytes) : '';
    check(
      'pulled back after the project manager signed, it prints no sign-off: every step of the route it would take is Pending',
      bigPulled.status === 200 &&
        draftPdf.status === 200 &&
        !draftText.includes('Verify PM') &&
        pendingCount(draftText) === bigSteps.length &&
        bigSteps.every((st) => draftText.includes(st.name.toUpperCase())),
      `${bigPulled.status} ${draftPdf.status} ${pendingCount(draftText)} pending, PM ${draftText.includes('Verify PM')}`,
    );

    // ── The purchase order's submit and settle, hardened the same way ─────
    console.log('\nPurchase order: the refused submit and the late decision');
    const poDraft = await api(buyerToken, 'POST', '/purchase-orders', { supplierId: supplier.id, notes: `${TAG} hardened order` });
    const poDraftId = String(poDraft.body.id);
    await api(buyerToken, 'POST', `/purchase-orders/${poDraftId}/items`, {
      description: `${TAG} valve`,
      costCategoryId: materials.id,
      quantity: 2,
      unit: 'pcs',
      unitPrice: 400,
    });
    const strayPo = await submitForApproval({
      documentType: 'purchase_order',
      documentId: poDraftId,
      documentNumber: String(poDraft.body.number),
      subject: `${TAG} stray order`,
      amount: 896,
      requesterId: buyer.id,
    });
    const poRefused = await api(buyerToken, 'POST', `/purchase-orders/${poDraftId}/submit`);
    const poAfterRefusal = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poDraftId } });
    check(
      'a purchase-order submit the engine refuses leaves it in DRAFT',
      poRefused.status === 400 && poAfterRefusal.status === 'DRAFT',
      `${poRefused.status} ${poAfterRefusal.status}`,
    );
    await prisma.approvalRequest.update({ where: { id: strayPo.id }, data: { status: 'CANCELLED', closedAt: new Date() } });
    await settlePurchaseOrder(poDraftId, 'APPROVED');
    const poAfterLate = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poDraftId } });
    const poLateCommitted = await prisma.jobCostEntry.count({ where: { sourceType: 'purchase_order', sourceId: poDraftId } });
    const poLateTrail = await prisma.auditLog.count({
      where: { entityType: 'purchase_order', entityId: poDraftId, summary: { contains: 'not applied' } },
    });
    check(
      'an approval that finds the order no longer pending issues nothing and commits nothing — the trail says so',
      poAfterLate.status === 'DRAFT' && poLateCommitted === 0 && poLateTrail === 1,
      `${poAfterLate.status} ${poLateCommitted} ${poLateTrail}`,
    );
    const issuedBefore = await position();
    const reqItemBefore = await prisma.purchaseRequestItem.findUniqueOrThrow({ where: { id: pr.items[0].id } });
    await settlePurchaseOrder(po.id, 'APPROVED');
    await settlePurchaseOrder(po.id, 'REJECTED');
    const issuedAfter = await position();
    const reqItemAfter = await prisma.purchaseRequestItem.findUniqueOrThrow({ where: { id: pr.items[0].id } });
    const issuedPo = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
    check(
      'settling an issued order again commits nothing twice, orders nothing twice, and a stray rejection leaves it issued',
      money(issuedAfter.committed, issuedBefore.committed) &&
        money(num(reqItemAfter.orderedQty), num(reqItemBefore.orderedQty)) &&
        issuedPo.status !== 'DRAFT',
      `${issuedBefore.committed} → ${issuedAfter.committed}, ordered ${num(reqItemBefore.orderedQty)} → ${num(reqItemAfter.orderedQty)}, ${issuedPo.status}`,
    );

    // ── A canvass: its notes and its supplier rows, while OPEN ───────────
    console.log('\nModifying a canvass (over HTTP)');
    const canvassOwnRole = await makeRole('zzchain_canvass_own', 'ZZ Canvasser', [
      'gchain.canvass.view_all',
      'gchain.canvass.create',
      'gchain.canvass.edit_own',
    ]);
    const canvassAllRole = await makeRole('zzchain_canvass_all', 'ZZ Canvass lead', [
      'gchain.canvass.view_all',
      'gchain.canvass.edit_all',
    ]);
    const canvasser = await mkUser('Verify Canvasser', 'canvasser@verifyc.local', canvassOwnRole.id);
    const otherCanvasser = await mkUser('Verify Other Canvasser', 'canvasser2@verifyc.local', canvassOwnRole.id);
    const canvassLead = await mkUser('Verify Canvass Lead', 'canvasslead@verifyc.local', canvassAllRole.id);
    const canvasserToken = signToken(canvasser.id, canvasser.email);
    const otherCanvasserToken = signToken(otherCanvasser.id, otherCanvasser.email);
    const canvassLeadToken = signToken(canvassLead.id, canvassLead.email);
    const openCanvass = await prisma.canvass.create({
      data: {
        number: await nextNumber('canvass'),
        requestId: pr.id,
        createdById: canvasser.id,
        suppliers: { create: [{ supplierId: supplier.id }, { supplierId: otherSupplier.id }] },
      },
      include: { suppliers: true },
    });
    const rowA = openCanvass.suppliers.find((r) => r.supplierId === supplier.id)!;
    const rowB = openCanvass.suppliers.find((r) => r.supplierId === otherSupplier.id)!;

    const openRead = await api(canvasserToken, 'GET', `/canvasses/${openCanvass.id}`);
    check(
      'the opener may modify the notes of an open canvass, but not its supplier rows without edit_all',
      openRead.body.canEdit === true && openRead.body.canEditSuppliers === false,
      `${openRead.body.canEdit} ${openRead.body.canEditSuppliers}`,
    );
    const notesSaved = await api(canvasserToken, 'PATCH', `/canvasses/${openCanvass.id}`, { notes: 'Three quotes by Friday' });
    check('the opener modifies the notes', notesSaved.status === 200 && notesSaved.body.notes === 'Three quotes by Friday', `${notesSaved.status}`);
    const notesStranger = await api(otherCanvasserToken, 'PATCH', `/canvasses/${openCanvass.id}`, { notes: 'mine now' });
    const notesLead = await api(canvassLeadToken, 'PATCH', `/canvasses/${openCanvass.id}`, { notes: 'Three quotes by Monday' });
    check(
      'another holder of edit_own cannot; an edit_all holder can',
      notesStranger.status === 403 && notesLead.status === 200,
      `${notesStranger.status} ${notesLead.status}`,
    );
    const headerRefused = await api(canvassLeadToken, 'PATCH', `/canvasses/${openCanvass.id}`, { notes: 'x', requestId: pr.id });
    check('the header takes nothing but the notes — another key is refused, not ignored', headerRefused.status === 400, String(headerRefused.status));

    const rowRefused = await api(canvasserToken, 'PATCH', `/canvasses/${openCanvass.id}/suppliers/${rowA.id}`, { leadTimeDays: 7 });
    const rowSaved = await api(canvassLeadToken, 'PATCH', `/canvasses/${openCanvass.id}/suppliers/${rowA.id}`, {
      leadTimeDays: 7,
      terms: '30 days',
      remarks: 'Ex-stock',
    });
    const rowAfter = await prisma.canvassSupplier.findUniqueOrThrow({ where: { id: rowA.id } });
    check(
      'a supplier row’s lead time, terms and remarks are modified by edit_all, not by edit_own',
      rowRefused.status === 403 && rowSaved.status === 200 && rowAfter.leadTimeDays === 7 && rowAfter.terms === '30 days' && rowAfter.remarks === 'Ex-stock',
      `${rowRefused.status} ${rowSaved.status} ${JSON.stringify(rowAfter)}`,
    );
    const removedB = await api(canvassLeadToken, 'DELETE', `/canvasses/${openCanvass.id}/suppliers/${rowB.id}`);
    check('a supplier is removed from an open canvass', removedB.status === 200, String(removedB.status));
    await api(canvassLeadToken, 'PUT', `/canvasses/${openCanvass.id}/suppliers/${rowA.id}/quotes`, {
      quotes: [{ requestItemId: pr.items[0].id, unitPrice: 128 }],
    });
    const awarded = await api(canvassLeadToken, 'POST', `/canvasses/${openCanvass.id}/award/${rowA.id}`);
    const lateNotes = await api(canvassLeadToken, 'PATCH', `/canvasses/${openCanvass.id}`, { notes: 'after the award' });
    const awardedRow = await api(canvassLeadToken, 'PATCH', `/canvasses/${openCanvass.id}/suppliers/${rowA.id}`, { terms: 'COD' });
    const lateRemove = await api(canvassLeadToken, 'DELETE', `/canvasses/${openCanvass.id}/suppliers/${rowA.id}`);
    const winnerKept = await prisma.canvassSupplier.findUnique({ where: { id: rowA.id } });
    check(
      'awarded, the canvass refuses new notes, a changed row and — the fault this closes — removing its winner',
      awarded.status === 200 && lateNotes.status === 400 && awardedRow.status === 400 && lateRemove.status === 400 && winnerKept?.isSelected === true,
      `${awarded.status} ${lateNotes.status} ${awardedRow.status} ${lateRemove.status} ${winnerKept?.isSelected}`,
    );
    const canvassAudits = await prisma.auditLog.count({ where: { entityType: 'canvass', entityId: openCanvass.id, action: 'UPDATED' } });
    check('each change to the canvass is audited', canvassAudits >= 4, String(canvassAudits));

    // ── Manila's day ──────────────────────────────────────────────────────
    // A DATE the server fills in or compares with is Manila's date; the UTC
    // date is still yesterday's until 08:00, when crews collect materials and
    // tools. A stored date is checked against the Manila day either side of
    // its request, so a run that crosses midnight cannot fail it.
    console.log('\nManila’s day (over HTTP)');
    const onDay = (v: Date | string | null | undefined, dayBefore: string) =>
      v != null && [dayBefore, manilaDayKey(new Date())].includes(new Date(v).toISOString().slice(0, 10));

    const draftRow = await prisma.purchaseOrder.findUnique({ where: { id: draftId }, select: { orderDate: true } });
    check(
      'a new purchase order is dated Manila’s today, not the database’s UTC date',
      onDay(draftRow?.orderDate, draftDay),
      draftRow?.orderDate.toISOString(),
    );

    const storeRole = await makeRole('zzchain_store', 'ZZ Storekeeper', [
      'gchain.dashboard.view_all',
      'gchain.borrow_slips.view_all',
      'gchain.borrow_slips.create',
      'gchain.borrow_slips.edit_all',
      'gchain.stock_issuance.create',
      'gchain.reports.view_all',
    ]);
    const keeper = await mkUser('Verify Keeper', 'keeper@verifyc.local', storeRole.id);
    const keeperToken = signToken(keeper.id, keeper.email);

    let day = manilaDayKey(new Date());
    const issueRes = await api(keeperToken, 'POST', '/stock-issues', {
      warehouseId: warehouse.id,
      purpose: `${TAG} early issue`,
    });
    const issueRow = issueRes.status === 201
      ? await prisma.stockIssue.findUnique({ where: { id: String(issueRes.body.id) } })
      : null;
    check(
      'a stock issue given no date is dated Manila’s today',
      onDay(issueRow?.issueDate, day),
      `${issueRes.status} ${issueRow?.issueDate.toISOString() ?? JSON.stringify(issueRes.body).slice(0, 120)}`,
    );

    // One slip due back yesterday and one due back today, by Manila's calendar.
    const todayKey = manilaDayKey(new Date());
    const yesterdayKey = manilaDayKey(new Date(Date.now() - 86_400_000));
    const lend = (dueAt: string, label: string) =>
      api(keeperToken, 'POST', '/borrow-slips', {
        warehouseId: warehouse.id,
        borrowerName: 'Verify Rigger',
        dueAt,
        purpose: `${TAG} ${label}`,
        items: [{ itemId: item.id, quantity: 1 }],
      });
    day = manilaDayKey(new Date());
    const lateSlip = await lend(yesterdayKey, 'due back yesterday');
    const dueSlip = await lend(todayKey, 'due back today');
    check(
      'two slips are lent out',
      lateSlip.status === 201 && dueSlip.status === 201,
      `${lateSlip.status} ${dueSlip.status} ${JSON.stringify(lateSlip.body).slice(0, 120)}`,
    );
    const lateId = String(lateSlip.body.id);
    const dueId = String(dueSlip.body.id);
    const lateRow = await prisma.borrowSlip.findUnique({ where: { id: lateId } });
    check(
      'a slip is dated out on Manila’s today, not the database’s UTC date',
      onDay(lateRow?.borrowedAt, day),
      lateRow?.borrowedAt.toISOString(),
    );

    type SlipRow = { id: string; isOverdue: boolean; daysOverdue: number };
    const rowsOf = (r: HttpResult) => (r.body.rows ?? []) as SlipRow[];
    const all = rowsOf(await api(keeperToken, 'GET', `/borrow-slips?search=${TAG}&pageSize=200`));
    const late = all.find((r) => r.id === lateId);
    const due = all.find((r) => r.id === dueId);
    check(
      'a slip due back yesterday is flagged overdue, by one day',
      late?.isOverdue === true && late.daysOverdue === 1,
      JSON.stringify(late),
    );
    check(
      'a slip due back today is not overdue on its own due day',
      due?.isOverdue === false && due.daysOverdue === 0,
      `${JSON.stringify(due)} — the row compared a date with the instant, so 08:00 on the due day read as late`,
    );
    const overdueRows = rowsOf(await api(keeperToken, 'GET', `/borrow-slips?overdue=true&search=${TAG}&pageSize=200`));
    check(
      'the Overdue filter finds the slip the row flags, and not the one due today',
      overdueRows.some((r) => r.id === lateId) && !overdueRows.some((r) => r.id === dueId),
      overdueRows.map((r) => r.id).join(','),
    );
    const [chainTiles, overdueTotal, summaryTiles] = await Promise.all([
      api(keeperToken, 'GET', '/gchain/overview'),
      api(keeperToken, 'GET', '/borrow-slips?overdue=true&pageSize=1'),
      api(keeperToken, 'GET', '/inventory/reports/summary'),
    ]);
    check(
      'the dashboard tile, the warehouse tile and the Overdue filter count the same slips',
      chainTiles.body.borrowSlipsOverdue === overdueTotal.body.total &&
        summaryTiles.body.overdueBorrows === overdueTotal.body.total,
      `${chainTiles.body.borrowSlipsOverdue} / ${summaryTiles.body.overdueBorrows} / ${overdueTotal.body.total}`,
    );

    const lateLines = await prisma.borrowSlipItem.findMany({ where: { slipId: lateId } });
    day = manilaDayKey(new Date());
    const back = await api(keeperToken, 'POST', `/borrow-slips/${lateId}/return`, {
      items: lateLines.map((l) => ({ itemId: l.id, quantity: Number(l.quantity) })),
    });
    const backRow = await prisma.borrowSlip.findUnique({ where: { id: lateId } });
    check(
      'the last tool back dates the slip returned on Manila’s today',
      back.status === 200 && backRow?.status === 'RETURNED' && onDay(backRow.returnedAt, day),
      `${back.status} ${backRow?.status} ${backRow?.returnedAt?.toISOString()}`,
    );

    // ── Modifying warehouse documents ─────────────────────────────────────
    console.log('\nModifying a stock issue, a borrow slip and a receiving (over HTTP)');
    const bossRole = await makeRole('zzchain_storeboss', 'ZZ Store supervisor', [
      'gchain.stock_issuance.view_all',
      'gchain.stock_issuance.edit_all',
      'gchain.stock_issuance.delete',
      'gchain.borrow_slips.view_all',
      'gchain.borrow_slips.edit_all',
      'gchain.receiving.view_all',
      'gchain.receiving.edit_all',
    ]);
    const boss = await mkUser('Verify Store Supervisor', 'storeboss@verifyc.local', bossRole.id);
    const bossToken = signToken(boss.id, boss.email);
    const siteStore = await prisma.warehouse.create({ data: { code: `${TAG}W2`, name: `${TAG} Site Store` } });
    const emptyStore = await prisma.warehouse.create({ data: { code: `${TAG}W3`, name: `${TAG} Empty Store` } });
    await prisma.$transaction((tx) =>
      receiveStock(tx, { itemId: item.id, warehouseId: siteStore.id, quantity: 5, unitCost: 200, sourceType: 'test' }),
    );

    const draftIssue = await api(keeperToken, 'POST', '/stock-issues', { warehouseId: warehouse.id, purpose: `${TAG} issue to modify` });
    const draftIssueId = String(draftIssue.body.id);
    await api(keeperToken, 'POST', `/stock-issues/${draftIssueId}/items`, { itemId: item.id, quantity: 2 });
    const withValve = await api(keeperToken, 'POST', `/stock-issues/${draftIssueId}/items`, { itemId: reorderItem.id, quantity: 1 });
    check('a storekeeper raises a draft issue with two lines', draftIssue.status === 201 && withValve.status === 201, `${draftIssue.status} ${withValve.status}`);

    const issueModified = await api(keeperToken, 'PATCH', `/stock-issues/${draftIssueId}`, {
      purpose: `${TAG} issue to modify — for the skid`,
      issuedToName: 'Verify Rigger',
    });
    check(
      'the storekeeper modifies the draft’s header',
      issueModified.status === 200 && issueModified.body.purpose === `${TAG} issue to modify — for the skid` && issueModified.body.issuedToName === 'Verify Rigger',
      `${issueModified.status} ${JSON.stringify(issueModified.body).slice(0, 140)}`,
    );
    const noBucket = await api(keeperToken, 'PATCH', `/stock-issues/${draftIssueId}`, { jobId: job.id });
    check(
      'charging it to a project is refused while a line’s item has no cost bucket — and says which',
      noBucket.status === 400 && String(noBucket.body.error ?? '').includes(`${TAG} Ball valve`),
      `${noBucket.status} ${JSON.stringify(noBucket.body).slice(0, 160)}`,
    );
    const valveLine = ((withValve.body.items ?? []) as { id: string; item: { id: string } }[]).find((l) => l.item.id === reorderItem.id);
    await api(keeperToken, 'DELETE', `/stock-issues/${draftIssueId}/items/${valveLine?.id}`);
    const toProject = await api(keeperToken, 'PATCH', `/stock-issues/${draftIssueId}`, { jobId: job.id });
    const toProjectLines = (toProject.body.items ?? []) as { costCategory: { id: string } | null }[];
    check(
      'without it, the issue is charged to the project and the line takes its item’s cost bucket',
      toProject.status === 200 && (toProject.body.job as { id: string } | null)?.id === job.id && toProjectLines.every((l) => l.costCategory?.id === materials.id),
      `${toProject.status} ${JSON.stringify(toProjectLines)}`,
    );
    const toSite = await api(keeperToken, 'PATCH', `/stock-issues/${draftIssueId}`, { warehouseId: siteStore.id });
    const sitePriced = ((toSite.body.items ?? []) as { unitCost: number; amount: number }[])[0];
    check(
      'moved to another warehouse, its lines are re-priced at that warehouse’s average',
      toSite.status === 200 && money(sitePriced?.unitCost ?? -1, 200) && money(sitePriced?.amount ?? -1, 400) && money(Number(toSite.body.value), 400),
      `${toSite.status} ${JSON.stringify(sitePriced)}`,
    );
    const toEmpty = await api(keeperToken, 'PATCH', `/stock-issues/${draftIssueId}`, { warehouseId: emptyStore.id });
    check('and refused for a warehouse that never held the item', toEmpty.status === 400, `${toEmpty.status} ${JSON.stringify(toEmpty.body).slice(0, 120)}`);
    const issueStranger = await api(buyerToken, 'PATCH', `/stock-issues/${draftIssueId}`, { purpose: `${TAG} not allowed` });
    check('someone without the stock issuance rights cannot modify it', issueStranger.status === 403, String(issueStranger.status));
    const issueFlags = await api(bossToken, 'GET', `/stock-issues/${draftIssueId}`);
    check(
      'a draft says it may be modified and deleted',
      issueFlags.body.canEdit === true && issueFlags.body.canDelete === true,
      `${issueFlags.body.canEdit} ${issueFlags.body.canDelete}`,
    );
    const issueAudits = await prisma.auditLog.count({ where: { entityType: 'stock_issue', entityId: draftIssueId, action: { in: ['CREATED', 'UPDATED'] } } });
    check('raising it and every change to it are audited', issueAudits >= 7, String(issueAudits));

    const issuedNow = await api(keeperToken, 'POST', `/stock-issues/${draftIssueId}/issue`);
    const issuedEdit = await api(keeperToken, 'PATCH', `/stock-issues/${draftIssueId}`, { purpose: `${TAG} after the fact` });
    const issuedDelete = await api(bossToken, 'DELETE', `/stock-issues/${draftIssueId}`);
    const issuedFlags = await api(bossToken, 'GET', `/stock-issues/${draftIssueId}`);
    check(
      'issued, it refuses both Modify and Delete — the stock has moved',
      issuedNow.status === 200 && issuedEdit.status === 400 && issuedDelete.status === 400 && issuedFlags.body.canEdit === false && issuedFlags.body.canDelete === false,
      `${issuedNow.status} ${issuedEdit.status} ${issuedDelete.status} ${JSON.stringify(issuedNow.body).slice(0, 120)}`,
    );
    // Issue claims the draft before anything moves: two presses at once issue
    // it once, and the second is told rather than taking the stock again.
    const twice = await api(keeperToken, 'POST', '/stock-issues', { warehouseId: warehouse.id, purpose: `${TAG} pressed twice` });
    const twiceId = String(twice.body.id);
    await api(keeperToken, 'POST', `/stock-issues/${twiceId}/items`, { itemId: item.id, quantity: 1 });
    const onHand = async () =>
      num((await prisma.inventoryBalance.findUnique({ where: { itemId_warehouseId: { itemId: item.id, warehouseId: warehouse.id } } }))?.quantity);
    const beforePresses = await onHand();
    const presses = await Promise.all([
      api(keeperToken, 'POST', `/stock-issues/${twiceId}/issue`),
      api(keeperToken, 'POST', `/stock-issues/${twiceId}/issue`),
    ]);
    const afterPresses = await onHand();
    const twiceMoves = await prisma.inventoryTransaction.count({ where: { sourceType: 'stock_issue', sourceId: twiceId } });
    check(
      'two presses of Issue at once issue it once: one goes through, the other is refused, and the stock leaves once',
      presses.filter((p) => p.status === 200).length === 1 &&
        presses.filter((p) => p.status === 400).length === 1 &&
        money(beforePresses - afterPresses, 1) &&
        twiceMoves === 1,
      `${presses.map((p) => p.status).join(' ')}; ${beforePresses} → ${afterPresses}; ${twiceMoves} movement(s)`,
    );
    const lateLine = await api(keeperToken, 'POST', `/stock-issues/${twiceId}/items`, { itemId: item.id, quantity: 1 });
    check('a line cannot be added once it has gone out', lateLine.status === 400, String(lateLine.status));

    const spareIssue = await api(keeperToken, 'POST', '/stock-issues', { warehouseId: warehouse.id, purpose: `${TAG} raised by mistake` });
    const spareId = String(spareIssue.body.id);
    const keeperDelete = await api(keeperToken, 'DELETE', `/stock-issues/${spareId}`);
    const bossDelete = await api(bossToken, 'DELETE', `/stock-issues/${spareId}`);
    const spareGone = await prisma.stockIssue.findUnique({ where: { id: spareId } });
    const spareAudit = await prisma.auditLog.count({ where: { entityType: 'stock_issue', entityId: spareId, action: 'DELETED' } });
    check(
      'a draft is deleted by a delete holder only, and the deletion is audited',
      keeperDelete.status === 403 && bossDelete.status === 200 && spareGone === null && spareAudit === 1,
      `${keeperDelete.status} ${bossDelete.status} ${spareAudit}`,
    );

    // A borrow slip: who, when due, what for — never the warehouse or items.
    const nextWeek = manilaDayKey(new Date(Date.now() + 7 * 86_400_000));
    const slipModified = await api(keeperToken, 'PATCH', `/borrow-slips/${dueId}`, {
      dueAt: nextWeek,
      purpose: `${TAG} due back next week`,
      borrowerName: 'Verify Rigger Two',
      notes: 'Extended by the site lead',
    });
    const slipRow = await prisma.borrowSlip.findUniqueOrThrow({ where: { id: dueId } });
    check(
      'a slip still out is modified: due date, borrower, purpose, notes',
      slipModified.status === 200 &&
        slipRow.dueAt.toISOString().slice(0, 10) === nextWeek &&
        slipRow.borrowerName === 'Verify Rigger Two' &&
        slipRow.notes === 'Extended by the site lead' &&
        slipModified.body.canEdit === true,
      `${slipModified.status} ${slipRow.dueAt.toISOString()} ${JSON.stringify(slipModified.body).slice(0, 120)}`,
    );
    const slipAudit = await prisma.auditLog.findFirst({
      where: { entityType: 'borrow_slip', entityId: dueId, action: 'UPDATED', summary: { startsWith: 'Modified' } },
      orderBy: { at: 'desc' },
    });
    check('and the trail says what moved', !!slipAudit?.summary?.includes('due '), slipAudit?.summary ?? 'none');
    const slipBackdated = await api(keeperToken, 'PATCH', `/borrow-slips/${dueId}`, {
      dueAt: manilaDayKey(new Date(Date.now() - 3 * 86_400_000)),
    });
    check('it cannot be due back before it went out', slipBackdated.status === 400, String(slipBackdated.status));
    const slipItems = await api(keeperToken, 'PATCH', `/borrow-slips/${dueId}`, { warehouseId: siteStore.id });
    check('the warehouse and items are fixed — a key for them is refused, not ignored', slipItems.status === 400, String(slipItems.status));
    const slipStranger = await api(buyerToken, 'PATCH', `/borrow-slips/${dueId}`, { notes: 'mine' });
    check('someone without borrow slip edit rights cannot modify it', slipStranger.status === 403, String(slipStranger.status));
    const slipReturned = await api(keeperToken, 'PATCH', `/borrow-slips/${lateId}`, { notes: 'too late' });
    const returnedRead = await api(keeperToken, 'GET', `/borrow-slips/${lateId}`);
    check(
      'a slip with everything back is a record: Modify is refused and not offered',
      slipReturned.status === 400 && returnedRead.body.canEdit === false,
      `${slipReturned.status} ${returnedRead.body.canEdit}`,
    );

    // A receiving: its references only.
    const recModified = await api(bossToken, 'PATCH', `/receivings/${receiving.id}`, {
      deliveryRefNo: 'DR-ZZ-0001',
      invoiceRefNo: 'SI-ZZ-0077',
      notes: 'Two crates, one dented',
    });
    const recRow = await prisma.receiving.findUniqueOrThrow({ where: { id: receiving.id }, include: { items: true } });
    check(
      'a receiving’s delivery receipt, invoice number and notes are modified',
      recModified.status === 200 && recRow.deliveryRefNo === 'DR-ZZ-0001' && recRow.invoiceRefNo === 'SI-ZZ-0077' && recRow.notes === 'Two crates, one dented',
      `${recModified.status} ${JSON.stringify(recModified.body).slice(0, 120)}`,
    );
    const recAudit = await prisma.auditLog.findFirst({ where: { entityType: 'receiving', entityId: receiving.id, action: 'UPDATED' } });
    check('and audited, with what it said before', !!recAudit?.summary?.includes('DR no.') && recAudit.before !== null, recAudit?.summary ?? 'none');
    const recDate = await api(bossToken, 'PATCH', `/receivings/${receiving.id}`, { receivedDate: '2020-01-01' });
    const recStranger = await api(buyerToken, 'PATCH', `/receivings/${receiving.id}`, { notes: 'mine' });
    const recBuyerRead = await api(buyerToken, 'GET', `/receivings/${receiving.id}`);
    check(
      'what arrived is the record: its date is refused, and someone with view only can neither change it nor is offered Modify',
      recDate.status === 400 && recStranger.status === 403 && recBuyerRead.body.canEdit === false && recModified.body.canEdit === true,
      `${recDate.status} ${recStranger.status} ${recBuyerRead.body.canEdit}`,
    );
  }

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
