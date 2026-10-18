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

import { repairTypedStockReceipts } from '../src/shared/typedItems';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/prisma';
import { rolesLike } from './lib/roles';
import { roleSeedPermissionKeys } from '../src/shared/roleSeeds';
import { env } from '../src/env';
import { signToken } from '../src/auth/middleware';
import { resolveUser } from '../src/permissions/resolve';
import { globalSearch } from '../src/shared/search';
import { stockOnHand } from '../src/shared/chain';
import { manilaDayKey } from '../src/shared/day';
import { statusLabel } from '../src/shared/pdf';
import { nextNumber } from '../src/shared/numbering';
import { CANVASS_CODE_MOVED, moveCanvassCode } from '../src/shared/canvassCode';
import { canvassFigures } from '../src/shared/canvassMath';
import { deleteAttachment } from '../src/shared/attachments';
import { PDFDocument } from 'pdf-lib';
import { submitForApproval, act, pickWorkflow, reopenApproved } from '../src/shared/approvals';
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
import { settleBorrowSlip, settleReceiving, settleStockIssue } from '../src/routes/warehouse';
import { settlePullout } from '../src/routes/pullouts';
import { runReorderCheck } from '../src/shared/reorder';
// The RFQ's search provider registers on import.
import '../src/routes/rfq';
import '../src/routes/jobs';
import {
  flat,
  LANDSCAPE,
  pendingCount,
  PORTRAIT,
  printed,
  saysCount,
  signedCount,
  splittingValue,
} from './lib/paper';

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
  // Pull-out slips hold their request, order and warehouse (Restrict), so go first.
  const taggedPullouts = await prisma.pulloutSlip.findMany({
    where: {
      OR: [
        { request: { purpose: { startsWith: TAG } } },
        { warehouse: { name: { startsWith: TAG } } },
        { salesOrder: { number: { startsWith: TAG } } },
        { reason: { startsWith: TAG } },
      ],
    },
    select: { id: true },
  });
  if (taggedPullouts.length) {
    await prisma.auditLog.deleteMany({ where: { entityId: { in: taggedPullouts.map((t) => t.id) } } });
    await prisma.approvalRequest.deleteMany({ where: { documentId: { in: taggedPullouts.map((t) => t.id) } } });
    await prisma.pulloutSlip.deleteMany({ where: { id: { in: taggedPullouts.map((t) => t.id) } } });
  }
  await prisma.salesOrder.deleteMany({ where: { number: { startsWith: TAG } } });
  await prisma.quotation.deleteMany({ where: { subject: { startsWith: TAG } } });
  // The warehouse's bells about this script's borrow slips name the slip,
  // not the TAG, so they are found by the link.
  const taggedSlips = await prisma.borrowSlip.findMany({ where: { purpose: { startsWith: TAG } }, select: { id: true } });
  if (taggedSlips.length) {
    await prisma.notification.deleteMany({ where: { link: { in: taggedSlips.map((t) => `/g-chain/borrow-slips/${t.id}`) } } });
  }
  // The files the warehouse checks attached — rows AND bytes: the rows
  // would cascade with their uploader, the files on disk would not.
  for (const f of await prisma.attachment.findMany({ where: { uploadedBy: { email: { endsWith: '@verifyc.local' } } }, select: { id: true } })) {
    await deleteAttachment(f.id);
  }
  // A settled approval's own rows (actor "system") are keyed only by the
  // warehouse document they posted.
  const warehouseDocs = [
    ...(await prisma.stockIssue.findMany({ where: { purpose: { startsWith: TAG } }, select: { id: true } })),
    ...(await prisma.receiving.findMany({ where: { order: { notes: { startsWith: TAG } } }, select: { id: true } })),
    ...taggedSlips,
  ].map((r) => r.id);
  if (warehouseDocs.length) {
    await prisma.auditLog.deleteMany({ where: { entityId: { in: warehouseDocs } } });
    await prisma.approvalRequest.deleteMany({ where: { documentId: { in: warehouseDocs } } });
  }
  await prisma.supplierBill.deleteMany({ where: { supplier: { name: { startsWith: TAG } } } });
  await prisma.borrowSlip.deleteMany({ where: { purpose: { startsWith: TAG } } });
  await prisma.stockIssue.deleteMany({ where: { purpose: { startsWith: TAG } } });
  // Receivings must go before their orders: the foreign key is Restrict, not
  // Cascade, and deliberately so — a receiving report is evidence that goods
  // arrived and should not vanish because someone deleted the order.
  await prisma.receiving.deleteMany({
    // …and the reports received without an order, by the name they came from.
    where: { OR: [{ order: { notes: { startsWith: TAG } } }, { sourceName: { startsWith: TAG } }] },
  });
  await prisma.purchaseOrder.deleteMany({ where: { notes: { startsWith: TAG } } });
  await prisma.purchaseRequest.deleteMany({ where: { purpose: { startsWith: TAG } } });
  // The automatic reorder's lines for this script's items, and its
  // requisitions left empty (one for the script's warehouse in full).
  await prisma.purchaseRequestItem.deleteMany({ where: { request: { autoReorder: true }, OR: [{ name: { startsWith: TAG } }, { item: { name: { startsWith: TAG } } }] } });
  await prisma.purchaseRequest.deleteMany({ where: { autoReorder: true, OR: [{ items: { none: {} } }, { warehouse: { name: { startsWith: TAG } } }] } });
  await prisma.notification.deleteMany({ where: { type: 'reorder.raised', title: { contains: TAG } } });
  await prisma.job.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.costing.deleteMany({ where: { title: { startsWith: TAG } } });
  await prisma.item.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.warehouse.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.supplier.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.customer.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.employee.deleteMany({ where: { employeeNo: { startsWith: TAG } } });
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
  // A seeded role's KEY and a throwaway copy of its rights (scripts/lib/roles.ts).
  const roles = await rolesLike('zzchain_', roleKeys);
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
  // The routing sheet of 2026-10-13: a requisition goes to the Technical
  // Manager, then the requester's Team Leader ("Reports to"); a purchase
  // order to the Purchasing Manager, and the CEO / President above ₱100,000.
  // The PM here is also a Technical Manager and the engineer's (and the
  // buyer's) Team Leader, so one Approve signs both steps (one signature per
  // person); the requester further down reports to a Team Leader of their own.
  const pm = await makeUser('Verify PM', 'pm@verifyc.local', ['project_manager', 'technical_manager']);
  const pm2 = await makeUser('Verify PM Two', 'pm2@verifyc.local', ['project_manager']);
  const finance = await makeUser('Verify Finance', 'fin@verifyc.local', ['finance']);
  const procurement = await makeUser('Verify Procurement', 'proc@verifyc.local', ['procurement']);
  const leader = await makeUser('Verify Team Leader', 'leader@verifyc.local', ['team_leader']);
  const purchMgr = await makeUser('Verify Purchasing Manager', 'purchmgr@verifyc.local', ['purchasing_manager']);
  const ceoUser = await makeUser('Verify CEO', 'ceo@verifyc.local', ['ceo']);
  await prisma.user.updateMany({ where: { id: { in: [engineer.id, procurement.id] } }, data: { supervisorId: pm.id } });

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
  const prSigned = await prisma.approvalAction.findMany({ where: { requestId: prApproval.id }, orderBy: { sequence: 'asc' } });
  check(
    'a requisition goes to the Technical Manager, then the Team Leader — and one person holding both signs both with one Approve, at one instant',
    (await prisma.approvalRequest.findUniqueOrThrow({ where: { id: prApproval.id } })).status === 'APPROVED' &&
      prSigned.length === 2 &&
      prSigned.every((a) => a.approverId === pm.id) &&
      prSigned[1].coSignedWith === 1 &&
      prSigned[0].actedAt.getTime() === prSigned[1].actedAt.getTime(),
    JSON.stringify(prSigned.map((a) => [a.sequence, a.coSignedWith])),
  );
  const poRoute = async (amount: number) => (await pickWorkflow('purchase_order', amount))?.steps.map((st) => st.name).join(' › ');
  check(
    'a purchase order up to ₱100,000.00 goes to the Purchasing Manager alone; above it, the CEO / President follows',
    (await poRoute(100_000)) === 'Purchasing Manager' && (await poRoute(100_000.01)) === 'Purchasing Manager › CEO / President',
    `${await poRoute(100_000)} | ${await poRoute(100_000.01)}`,
  );

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
  await act({ requestId: poApproval.id, userId: purchMgr.id, action: 'APPROVED' });

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
  // The routing sheet of 2026-10-13 adds Industry Specialists, Technical
  // Managers and Team Leaders as preparers.
  // The seed's DEFINITION — the install's own roles were emptied for the
  // owner's (2026-10-18) and may hold anything.
  for (const roleKey of ['project_engineer', 'project_manager', 'industry_specialist', 'technical_manager', 'team_leader']) {
    const holds = roleSeedPermissionKeys(roleKey).includes('gchain.purchase_requests.create');
    check(`the seeded ${roleKey} holds gchain.purchase_requests.create`, holds);
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
    recHits.some((h) => h.kind === 'receiving' && h.link === `/g-chain/incoming/${receiving.id}`),
  );
  const prHits = await globalSearch(pr.number, (await resolveUser(engineer.id))!);
  check(
    'the engineer who raised a request finds it',
    prHits.some((h) => h.kind === 'purchase_request' && h.id === pr.id),
  );

  // ── 10b. A project's own stock (2026-10-18) ───────────────────────────────
  // Project goods received into a warehouse sit on its shelf as the project's
  // stock: charged once at receiving, never again when they go out, and never
  // in the company's balance or its average.
  console.log('\nProject stock');
  {
    const { receiveProjectStock, issueProjectStock } = await import('../src/shared/projectStock');
    const companyBefore = await prisma.inventoryBalance.findUnique({ where: { itemId_warehouseId: { itemId: item.id, warehouseId: warehouse.id } } });
    await prisma.$transaction((tx) =>
      receiveProjectStock(tx, { jobId: job.id, itemId: item.id, warehouseId: warehouse.id, quantity: 10, unitCost: 200, sourceType: 'test', createdById: procurement.id }),
    );
    const own = await prisma.projectStock.findUnique({ where: { jobId_itemId_warehouseId: { jobId: job.id, itemId: item.id, warehouseId: warehouse.id } } });
    const companyAfter = await prisma.inventoryBalance.findUnique({ where: { itemId_warehouseId: { itemId: item.id, warehouseId: warehouse.id } } });
    check('a project receipt into a warehouse is the project\'s own stock (10 at 200)', !!own && money(num(own.quantity), 10) && money(num(own.averageCost), 200));
    check(
      'and leaves the company\'s balance and its average alone',
      num(companyAfter?.quantity) === num(companyBefore?.quantity) && num(companyAfter?.averageCost) === num(companyBefore?.averageCost),
    );
    check(
      'its movement carries the project',
      (await prisma.inventoryTransaction.count({ where: { jobId: job.id, itemId: item.id, sourceType: 'test', type: 'RECEIPT' } })) === 1,
    );

    // An Outgoing slip drawing the project's stock, approved.
    const issue = await prisma.stockIssue.create({
      data: {
        number: await nextNumber('stock_issue'),
        status: 'PENDING_APPROVAL',
        jobId: job.id,
        warehouseId: warehouse.id,
        issuedById: procurement.id,
        purpose: `${TAG} project stock to site`,
        items: { create: [{ itemId: item.id, costCategoryId: materials.id, quantity: D(4), unitCost: D(200), amount: D(800), projectStock: true }] },
      },
    });
    const incurredBefore = (await position()).incurred;
    await settleStockIssue(issue.id, 'APPROVED');
    const issued = await prisma.stockIssue.findUnique({ where: { id: issue.id } });
    const ownAfterIssue = await prisma.projectStock.findUnique({ where: { id: own!.id } });
    const issueCost = await prisma.jobCostEntry.findMany({ where: { sourceType: 'stock_issue', sourceId: issue.id } });
    check('an Outgoing slip of project stock is issued on approval', issued?.status === 'ISSUED', issued?.status);
    check('and takes it off the project\'s shelf (6 left)', money(num(ownAfterIssue!.quantity), 6), String(num(ownAfterIssue!.quantity)));
    check(
      'posting CONSUMED only — no second INCURRED',
      issueCost.length === 1 && issueCost[0].state === 'CONSUMED' && money(num(issueCost[0].amount), 800),
      issueCost.map((c) => `${c.state} ${num(c.amount)}`).join(', '),
    );
    check('so the project\'s incurred cost does not move', money((await position()).incurred, incurredBefore));
    const companyAfterIssue = await prisma.inventoryBalance.findUnique({ where: { itemId_warehouseId: { itemId: item.id, warehouseId: warehouse.id } } });
    check('and the company\'s stock is untouched', num(companyAfterIssue?.quantity) === num(companyBefore?.quantity));

    await expectRejection(
      'more than the project holds is refused',
      () => prisma.$transaction((tx) => issueProjectStock(tx, { jobId: job.id, itemId: item.id, warehouseId: warehouse.id, quantity: 7, sourceType: 'test' })),
      'Not enough',
    );

    // A pull-out slip of the project's stock, approved.
    const slip = await prisma.pulloutSlip.create({
      data: {
        number: await nextNumber('pullout_slip'),
        kind: 'PROJECT_STOCK',
        status: 'PENDING_APPROVAL',
        jobId: job.id,
        warehouseId: warehouse.id,
        preparedById: pm.id,
        pulloutDate: new Date(),
        notes: `${TAG} project stock pull-out`,
        items: { create: [{ itemId: item.id, quantity: D(2), unitCost: D(200), amount: D(400) }] },
      },
    });
    await settlePullout(slip.id, 'APPROVED');
    const pulled = await prisma.pulloutSlip.findUnique({ where: { id: slip.id } });
    const ownAfterPull = await prisma.projectStock.findUnique({ where: { id: own!.id } });
    const pullCost = await prisma.jobCostEntry.findMany({ where: { sourceType: 'pullout_slip', sourceId: slip.id } });
    check('a PROJECT_STOCK pull-out goes out on approval', pulled?.status === 'PULLED_OUT', pulled?.status);
    check('from the project\'s shelf (4 left)', money(num(ownAfterPull!.quantity), 4), String(num(ownAfterPull!.quantity)));
    check(
      'posting CONSUMED only',
      pullCost.length === 1 && pullCost[0].state === 'CONSUMED' && money(num(pullCost[0].amount), 400),
      pullCost.map((c) => `${c.state} ${num(c.amount)}`).join(', '),
    );
  }

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

    // The project's own stock on the inventory list (2026-10-18).
    {
      const ownList = await api(buyerToken, 'GET', `/inventory?stock=project&jobId=${job.id}`);
      const ownBody = ownList.body as { rows?: { project?: { id: string }; quantity: number }[]; summary?: { stock?: string; valuation?: number } };
      check(
        'GET /inventory?stock=project lists the project\'s own goods (4 at 200)',
        ownList.status === 200 && ownBody.summary?.stock === 'project' && ownBody.rows?.length === 1 && ownBody.rows[0].project?.id === job.id && ownBody.rows[0].quantity === 4 && ownBody.summary?.valuation === 800,
        `${ownList.status} ${JSON.stringify(ownBody.summary)}`,
      );
      const company = await api(buyerToken, 'GET', `/inventory?warehouseId=${warehouse.id}`);
      const companyBody = company.body as { summary?: { projectStock?: { lines: number } } };
      check('and the company list counts it on its Project stock card', (companyBody.summary?.projectStock?.lines ?? 0) >= 1, JSON.stringify(companyBody.summary?.projectStock));
    }

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
    // A stock line typed without an item (2026-10-16, "received but not in
    // inventory"): receiving it builds stock under its matched or new item.
    {
      const typedPart = `${TAG}-TPO-${Date.now()}`;
      const typedPo = await prisma.purchaseOrder.create({
        data: {
          number: await nextNumber('purchase_order'), kind: 'STOCK_REPLENISHMENT', status: 'ISSUED', supplierId: supplier.id,
          warehouseId: warehouse.id, createdById: procurement.id, notes: `${TAG} typed stock order`,
          items: { create: [{ name: `${TAG} typed gasket`, partNumber: typedPart, description: `${TAG} typed gasket`, quantity: D(4), unitPrice: D(25), amount: D(100) }] },
        },
        include: { items: true },
      });
      const typedRec = await prisma.receiving.create({
        data: { number: await nextNumber('receiving'), orderId: typedPo.id, warehouseId: warehouse.id, receivedById: procurement.id,
          items: { create: [{ orderItemId: typedPo.items[0].id, quantity: D(4), unitCost: D(25) }] } },
      });
      const first = await repairTypedStockReceipts();
      const again = await repairTypedStockReceipts();
      const made = await prisma.item.findMany({ where: { partNumber: typedPart } });
      const bal = made[0] ? await prisma.inventoryBalance.findUnique({ where: { itemId_warehouseId: { itemId: made[0].id, warehouseId: warehouse.id } } }) : null;
      check(
        'a stock order line typed without an item builds stock when received, under one item, once',
        first >= 1 && again === 0 && made.length === 1 && Number(bal?.quantity) === 4,
        `first ${first} again ${again} items ${made.length} qty ${bal?.quantity}`,
      );
      await prisma.inventoryTransaction.deleteMany({ where: { sourceId: typedRec.id } });
      await prisma.inventoryBalance.deleteMany({ where: { itemId: { in: made.map((m) => m.id) } } });
      await prisma.receiving.delete({ where: { id: typedRec.id } });
      await prisma.purchaseOrder.delete({ where: { id: typedPo.id } });
      await prisma.auditLog.deleteMany({ where: { entityType: 'item', entityId: { in: made.map((m) => m.id) } } });
      await prisma.item.deleteMany({ where: { id: { in: made.map((m) => m.id) } } });
    }
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
      await act({ requestId: pending.id, userId: purchMgr.id, action: 'REJECTED', comment: 'Wrong flange rating' });
    }
    const afterReject = await api(buyerToken, 'GET', `/purchase-orders/${draftId}`);
    const returned = afterReject.body.returned as { by: string | null; comment: string | null } | null;
    check(
      'a rejected order is back in draft and says who returned it and why',
      afterReject.body.status === 'DRAFT' && returned?.by === purchMgr.name && returned?.comment === 'Wrong flange rating',
      JSON.stringify(returned),
    );

    // Pulled back to draft (2026-10-16): the request withdrawn, the same order back.
    const resent = await api(buyerToken, 'POST', `/purchase-orders/${draftId}/submit`);
    const poPulled = await api(buyerToken, 'POST', `/purchase-orders/${draftId}/withdraw`);
    const pulledAgain = await api(buyerToken, 'POST', `/purchase-orders/${draftId}/withdraw`);
    const stillOpen = await prisma.approvalRequest.count({ where: { documentType: 'purchase_order', documentId: draftId, status: 'PENDING' } });
    const afterPull = await api(buyerToken, 'GET', `/purchase-orders/${draftId}`);
    check(
      'a pending order is pulled back to the same draft, its request withdrawn; a second pull has nothing to pull',
      resent.status === 200 && poPulled.status === 200 && pulledAgain.status === 400 && stillOpen === 0 && afterPull.body.status === 'DRAFT' && afterPull.body.canEdit === true,
      `${resent.status} ${poPulled.status} ${pulledAgain.status} open ${stillOpen} ${afterPull.body.status}`,
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
    await prisma.user.update({ where: { id: requester.id }, data: { supervisorId: leader.id } });
    const prOfficer = await mkUser('Verify PR Officer', 'profficer@verifyc.local', prOfficerRole.id);
    const requesterToken = signToken(requester.id, requester.email);
    const otherRequesterToken = signToken(otherRequester.id, otherRequester.email);
    const prOfficerToken = signToken(prOfficer.id, prOfficer.email);

    // ── The requisition page: header and lines in one save (2026-10-13) ──
    console.log('\nThe purchase requisition page (over HTTP)');
    const labour = categories[1];
    await prisma.costingLine.createMany({
      data: [
        { costingId: costing.id, costCategoryId: materials.id, name: `${TAG} Gasket set`, description: 'EPDM, 16 bar', quantity: D(4), unit: 'set', unitCost: D(950), amount: D(3800), sortOrder: 0 },
        { costingId: costing.id, costCategoryId: materials.id, description: `${TAG} heading`, isHeading: true, sortOrder: 1 },
      ],
    });
    const sheetLines = [
      { costCategoryId: materials.id, partNumber: 'GK-16', name: `${TAG} Gasket set`, description: 'EPDM, 16 bar', quantity: 4, unit: 'set', estimatedCost: 950.555 },
      { itemId: item.id, name: `${TAG} Stainless pipe`, quantity: 3, unit: 'pcs', estimatedCost: 100 },
    ];
    const sheetA = await api(requesterToken, 'POST', '/purchase-requests', {
      kind: 'DIRECT_TO_JOB',
      jobId: job.id,
      purpose: `${TAG} sheet save`,
      preferredSupplier: 'GiTi Warehouse',
      lines: sheetLines,
    });
    const sheetId = String(sheetA.body.id);
    const sheetRead = await api(requesterToken, 'GET', `/purchase-requests/${sheetId}`);
    const sheetItems = (sheetRead.body.items ?? []) as { id: string; name: string | null; partNumber: string | null; description: string; estimatedAmount: number; costCategory: { id: string } | null }[];
    check(
      'POST /purchase-requests takes the header and its lines in one save',
      sheetA.status === 201 && sheetItems.length === 2 && sheetRead.body.preferredSupplier === 'GiTi Warehouse',
      `${sheetA.status} ${sheetItems.length} ${JSON.stringify(sheetA.body).slice(0, 160)}`,
    );
    check(
      'a line keeps its part number and name, its amount is the server\'s centavo rule',
      sheetItems[0]?.partNumber === 'GK-16' && sheetItems[0]?.name === `${TAG} Gasket set` && sheetItems[0]?.description === 'EPDM, 16 bar' &&
        sheetItems[0]?.estimatedAmount === Math.round(4 * 950.555 * 100) / 100,
      JSON.stringify(sheetItems[0]),
    );
    check(
      'a line named by item alone takes the item\'s budget line, and its name as its description',
      sheetItems[1]?.costCategory?.id === materials.id && sheetItems[1]?.description === `${TAG} Stainless pipe`,
      JSON.stringify(sheetItems[1]),
    );
    const counterBefore = await prisma.purchaseRequest.count();
    const bareSheet = await api(requesterToken, 'POST', '/purchase-requests', {
      kind: 'DIRECT_TO_JOB',
      jobId: job.id,
      purpose: `${TAG} refused sheet`,
      lines: [{ name: `${TAG} no budget line`, quantity: 1, estimatedCost: 5 }],
    });
    const sheetB = await api(requesterToken, 'POST', '/purchase-requests', { kind: 'DIRECT_TO_JOB', jobId: job.id, purpose: `${TAG} next number`, lines: [] });
    const seq = (n: unknown) => Number(String(n).match(/(\d+)$/)?.[1] ?? NaN);
    check(
      'a direct-to-job line with no budget line is refused naming the line, and burns no number',
      bareSheet.status === 400 && /Line 1/.test(String(bareSheet.body.error ?? bareSheet.body.message ?? JSON.stringify(bareSheet.body))) &&
        (await prisma.purchaseRequest.count()) === counterBefore + 1 && seq(sheetB.body.number) === seq(sheetA.body.number) + 1,
      `${bareSheet.status} ${JSON.stringify(bareSheet.body).slice(0, 140)} ${sheetA.body.number} ${sheetB.body.number}`,
    );
    const version = String(sheetRead.body.version);
    const sheetPut = await api(requesterToken, 'PUT', `/purchase-requests/${sheetId}/sheet`, {
      kind: 'DIRECT_TO_JOB',
      jobId: job.id,
      purpose: `${TAG} sheet save, modified`,
      preferredSupplier: 'GiTi Warehouse',
      version,
      lines: [
        { ...sheetLines[0], id: sheetItems[0].id, quantity: 6 },
        { costCategoryId: labour.id, name: `${TAG} Rigging crew`, quantity: 2, unit: 'day', estimatedCost: 4500 },
      ],
    });
    const afterPut = await prisma.purchaseRequestItem.findMany({ where: { requestId: sheetId }, orderBy: { sortOrder: 'asc' } });
    check(
      'PUT /:id/sheet updates a line in place, drops the one left out, adds the new one',
      sheetPut.status === 200 && afterPut.length === 2 && afterPut[0].id === sheetItems[0].id && Number(afterPut[0].quantity) === 6 &&
        afterPut[1].name === `${TAG} Rigging crew` && !afterPut.some((l) => l.id === sheetItems[1].id),
      `${sheetPut.status} ${JSON.stringify(sheetPut.body).slice(0, 160)}`,
    );
    const stalePut = await api(requesterToken, 'PUT', `/purchase-requests/${sheetId}/sheet`, {
      kind: 'DIRECT_TO_JOB', jobId: job.id, purpose: `${TAG} stale`, version, lines: [],
    });
    check('a save on what changed since it was read is refused, nothing written', stalePut.status === 400 && (await prisma.purchaseRequestItem.count({ where: { requestId: sheetId } })) === 2, String(stalePut.status));
    const fresh = await api(requesterToken, 'GET', `/purchase-requests/${sheetId}`);
    const foreignLine = await api(requesterToken, 'PUT', `/purchase-requests/${sheetId}/sheet`, {
      kind: 'DIRECT_TO_JOB', jobId: job.id, purpose: `${TAG} foreign`, version: String(fresh.body.version),
      lines: [{ id: 'clnotthisrequestsline', costCategoryId: materials.id, name: 'x', quantity: 1, estimatedCost: 1 }],
    });
    check('a line id that is not the request\'s own is refused', foreignLine.status === 400, String(foreignLine.status));
    const strangerSheet = await api(otherRequesterToken, 'PUT', `/purchase-requests/${sheetId}/sheet`, {
      kind: 'DIRECT_TO_JOB', jobId: job.id, purpose: `${TAG} not mine`, lines: [],
    });
    check('another requester cannot save over it', strangerSheet.status === 403, String(strangerSheet.status));

    const budgetRead = await api(requesterToken, 'GET', `/purchase-requests/budget?jobId=${job.id}`);
    const budgetLines = (budgetRead.body.lines ?? []) as { id: string; budgeted: number; committed: number; incurred: number; available: number }[];
    const positions = await budgetPosition(job.id);
    const agrees = budgetLines.every((b) => {
      const p = positions.find((x) => x.costCategoryId === b.id);
      return p ? Math.abs(p.available - b.available) < 0.005 && Math.abs(p.budgeted - b.budgeted) < 0.005 : b.budgeted === 0 && b.available === 0;
    });
    check(
      'GET /budget gives every budget line as Budget Monitoring has it, and names the project',
      budgetRead.status === 200 && agrees && (budgetRead.body.job as { id: string })?.id === job.id && budgetLines.length > 0,
      `${budgetRead.status} ${JSON.stringify(budgetLines.slice(0, 2))}`,
    );
    const suggestAll = await api(requesterToken, 'GET', `/purchase-requests/suggest?jobId=${job.id}`);
    const fromCosting = (suggestAll.body.costing ?? []) as { name: string; unitCost: number | null; costCategory: { id: string } | null }[];
    check(
      'GET /suggest lists the costing\'s lines (no headings), and no cost to a requester who may not see it',
      suggestAll.status === 200 && fromCosting.length === 1 && fromCosting[0].name === `${TAG} Gasket set` && fromCosting.every((l) => l.unitCost === null),
      `${suggestAll.status} ${JSON.stringify(fromCosting)}`,
    );
    const suggestPm = await api(signToken(pm.id, pm.email), 'GET', `/purchase-requests/suggest?jobId=${job.id}&q=${encodeURIComponent('gasket')}`);
    check(
      'the project\'s manager is sent the costing\'s cost',
      ((suggestPm.body.costing ?? []) as { unitCost: number | null }[])[0]?.unitCost === 950,
      JSON.stringify(suggestPm.body).slice(0, 200),
    );
    const routeRead = await api(requesterToken, 'GET', `/purchase-requests/route?amount=1000&jobId=${job.id}&requestId=${sheetId}`);
    check(
      'GET /route previews the route submitting would take',
      routeRead.status === 200 && ((routeRead.body.route as { steps: unknown[] } | null)?.steps.length ?? 0) > 0,
      JSON.stringify(routeRead.body).slice(0, 160),
    );
    const sheetPaper = flat((await printed(requesterToken, `/purchase-requests/${sheetId}/pdf`)).text);
    check(
      'its paper prints the part number, the name and the preferred supplier',
      sheetPaper.includes('GK-16') && sheetPaper.includes('Gasket set') && sheetPaper.includes('GiTi Warehouse'),
      sheetPaper.slice(0, 200),
    );

    // ── The purchase order page: header and lines in one save (2026-10-13) ──
    console.log('\nThe purchase order page (over HTTP)');
    const approvedPr = await prisma.purchaseRequest.create({
      data: {
        number: await nextNumber('purchase_request'),
        kind: 'DIRECT_TO_JOB',
        status: 'APPROVED',
        jobId: job.id,
        requestedById: requester.id,
        purpose: `${TAG} order page request`,
        preferredSupplier: 'GiTi Warehouse',
        items: {
          create: [
            { costCategoryId: materials.id, partNumber: 'GK-16', name: `${TAG} Gasket set`, description: 'EPDM', quantity: D(4), unit: 'set', estimatedCost: D(900), estimatedAmount: D(3600), sortOrder: 0 },
            { costCategoryId: materials.id, name: `${TAG} Flange`, description: `${TAG} Flange`, quantity: D(2), unit: 'pcs', estimatedCost: D(500), estimatedAmount: D(1000), sortOrder: 1 },
          ],
        },
      },
      include: { items: { orderBy: { sortOrder: 'asc' } } },
    });
    await prisma.jobCostEntry.create({
      data: { jobId: job.id, costCategoryId: materials.id, state: 'COMMITTED', amount: D(4600), sourceType: 'purchase_request', sourceId: approvedPr.id, sourceNumber: approvedPr.number },
    });
    const poDraftRead = await api(buyerToken, 'GET', `/purchase-orders/draft?requestId=${approvedPr.id}`);
    const draftLines = (poDraftRead.body.lines ?? []) as { requestItemId: string; partNumber: string | null; name: string | null; unitPrice: number; quantity: number }[];
    check(
      'GET /purchase-orders/draft gives the request\'s lines still to order, with part number and name, at its estimates',
      poDraftRead.status === 200 && draftLines.length === 2 && draftLines[0].partNumber === 'GK-16' && draftLines[0].unitPrice === 900 &&
        (poDraftRead.body.request as { preferredSupplier: string })?.preferredSupplier === 'GiTi Warehouse',
      JSON.stringify(poDraftRead.body).slice(0, 200),
    );
    const poBudget = await api(buyerToken, 'GET', `/purchase-orders/budget?jobId=${job.id}&requestId=${approvedPr.id}`);
    check(
      'GET /purchase-orders/budget says what issuing releases from the request, per budget line',
      poBudget.status === 200 && (poBudget.body.released as Record<string, number>)?.[materials.id] === 4600,
      JSON.stringify(poBudget.body.released),
    );
    const foreignRequestLine = await api(buyerToken, 'POST', '/purchase-orders', {
      supplierId: supplier.id, requestId: approvedPr.id, notes: `${TAG} foreign line`,
      lines: [{ requestItemId: sheetItems[0].id, costCategoryId: materials.id, name: 'x', quantity: 1, unitPrice: 1 }],
    });
    check('a line pointing at another request\'s line is refused', foreignRequestLine.status === 400, String(foreignRequestLine.status));
    const pageOrder = await api(buyerToken, 'POST', '/purchase-orders', {
      supplierId: supplier.id,
      requestId: approvedPr.id,
      notes: `${TAG} order page`,
      vatInclusive: false,
      lines: [
        { requestItemId: approvedPr.items[0].id, costCategoryId: materials.id, partNumber: 'GK-16', name: `${TAG} Gasket set`, description: 'EPDM', quantity: 4, unit: 'set', unitPrice: 875.5 },
        { costCategoryId: labour.id, name: `${TAG} Delivery`, quantity: 1, unit: 'lot', unitPrice: 1200 },
      ],
    });
    const pageOrderId = String(pageOrder.body.id);
    const pageOrderRead = await api(buyerToken, 'GET', `/purchase-orders/${pageOrderId}`);
    const pageLines = (pageOrderRead.body.items ?? []) as { id: string; requestItemId: string | null; partNumber: string | null; name: string | null; amount: number }[];
    check(
      'POST /purchase-orders takes the lines as the page shows them: the request\'s line at the agreed price, and a line of its own',
      pageOrder.status === 201 && pageLines.length === 2 && pageLines[0].requestItemId === approvedPr.items[0].id &&
        pageLines[0].amount === 3502 && pageLines[1].requestItemId === null && pageOrderRead.body.subtotal === 4702 &&
        pageOrderRead.body.total === Math.round(4702 * 1.12 * 100) / 100,
      `${pageOrder.status} ${JSON.stringify(pageOrderRead.body).slice(0, 200)}`,
    );
    const pagePut = await api(buyerToken, 'PUT', `/purchase-orders/${pageOrderId}/sheet`, {
      supplierId: supplier.id,
      notes: `${TAG} order page, modified`,
      vatInclusive: true,
      version: String(pageOrderRead.body.version),
      lines: [{ id: pageLines[0].id, requestItemId: approvedPr.items[0].id, costCategoryId: materials.id, partNumber: 'GK-16B', name: `${TAG} Gasket set`, quantity: 3, unit: 'set', unitPrice: 875.5 }],
    });
    const afterPagePut = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: pageOrderId }, include: { items: true } });
    check(
      'PUT /purchase-orders/:id/sheet saves header and lines together, the totals recalculated',
      pagePut.status === 200 && afterPagePut.items.length === 1 && afterPagePut.items[0].id === pageLines[0].id &&
        afterPagePut.items[0].partNumber === 'GK-16B' && Number(afterPagePut.subtotal) === 2626.5 && Number(afterPagePut.total) === 2626.5 && afterPagePut.vatInclusive,
      `${pagePut.status} ${JSON.stringify(pagePut.body).slice(0, 160)}`,
    );
    const noVat = await api(buyerToken, 'PUT', `/purchase-orders/${pageOrderId}/sheet`, {
      supplierId: supplier.id, notes: `${TAG} importation`, applyVat: false, currency: 'USD',
      version: String(afterPagePut.updatedAt.toISOString()),
      lines: [{ id: pageLines[0].id, requestItemId: approvedPr.items[0].id, costCategoryId: materials.id, partNumber: 'GK-16B', name: `${TAG} Gasket set`, quantity: 3, unit: 'set', unitPrice: 875.5 }],
    });
    const afterNoVat = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: pageOrderId } });
    check(
      'an importation order: Apply VAT off keeps the total at the subtotal, in its own currency',
      noVat.status === 200 && Number(afterNoVat.vatRate) === 0 && Number(afterNoVat.total) === Number(afterNoVat.subtotal) && afterNoVat.currency === 'USD',
      `${noVat.status} ${JSON.stringify(noVat.body).slice(0, 160)}`,
    );
    const stalePo = await api(buyerToken, 'PUT', `/purchase-orders/${pageOrderId}/sheet`, {
      supplierId: supplier.id, notes: `${TAG} stale`, version: String(pageOrderRead.body.version), lines: [],
    });
    check('a save on what changed since it was read is refused', stalePo.status === 400, String(stalePo.status));
    const strangerPo = await api(otherRequesterToken, 'PUT', `/purchase-orders/${pageOrderId}/sheet`, { supplierId: supplier.id, lines: [] });
    check('someone without the order\'s edit rights cannot save over it', strangerPo.status === 403, String(strangerPo.status));
    const poRoute = await api(buyerToken, 'GET', `/purchase-orders/route?amount=150000&orderId=${pageOrderId}`);
    check(
      'GET /purchase-orders/route previews the route at the order\'s total — the CEO / President above ₱100,000',
      poRoute.status === 200 && ((poRoute.body.route as { steps: unknown[] } | null)?.steps.length ?? 0) >= 2,
      JSON.stringify(poRoute.body).slice(0, 200),
    );
    const poPaper = flat((await printed(buyerToken, `/purchase-orders/${pageOrderId}/pdf`)).text);
    check('the order\'s paper prints the part number and the name', poPaper.includes('GK-16B') && poPaper.includes('Gasket set'), poPaper.slice(0, 200));
    // The owner's five of 2026-10-14: P.O. Date under the number, the
    // quotation reference and delivery date in DETAILS, the supplier's
    // contact, and neither "For" (internal) nor the TIN.
    await api(buyerToken, 'PATCH', `/purchase-orders/${pageOrderId}`, { quoteRef: 'SQ-77881', deliveryDate: '2026-11-20' });
    const contactRow = await prisma.supplierContact.create({ data: { supplierId: supplier.id, name: `${TAG} Rosa Lim`, mobile: '0917 555 0101', email: 'rosa@example.test', isPrimary: true } });
    const poPaper2 = flat((await printed(buyerToken, `/purchase-orders/${pageOrderId}/pdf`)).text);
    await prisma.supplierContact.delete({ where: { id: contactRow.id } });
    check(
      'the order\'s paper (the owner\'s layout) prints the date, the quotation reference, the delivery date and the supplier\'s contact — no "For", no TIN',
      poPaper2.includes('Date: ') && poPaper2.includes('digital signature of approval') && poPaper2.includes('SHIP TO') && !poPaper2.includes('DELIVERY AND TERMS') && !poPaper2.includes('Purchase request:') && !poPaper2.includes('Status:') && poPaper2.includes('SQ-77881') && poPaper2.includes('November 20, 2026') &&
        poPaper2.includes('Rosa Lim') && poPaper2.includes('0917 555 0101') && poPaper2.includes('rosa@example.test') &&
        !/\bTIN\b/.test(poPaper2.replace(/TIN: [^|]*\|/, '')) && !poPaper2.includes('For:') && !poPaper2.includes('FOR '),
      poPaper2.slice(0, 400),
    );

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
    if (openAgain) {
      await act({ requestId: openAgain.id, userId: pm.id, action: 'APPROVED' });
      await act({ requestId: openAgain.id, userId: leader.id, action: 'APPROVED' });
    }
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
    {
      // Its page sets it against the budget WITHOUT its own commitment, so the
      // approved request is never counted twice (the owner's report, 2026-10-14:
      // "Already committed" equal to the request, "After" its negative).
      const page = await api(requesterToken, 'GET', `/purchase-requests/${prId}`);
      const shown = Object.entries(page.body.budget as Record<string, { committed: number; available: number }>);
      const ok = await Promise.all(
        shown.map(async ([categoryId, b]) => {
          const raw = await availableBudget(prisma, job.id, categoryId);
          const mine = firstCommit.filter((r) => r.costCategoryId === categoryId).reduce((t, r) => t + num(r.amount), 0);
          return money(b.committed, raw.committed - mine) && money(b.available, raw.available + mine);
        }),
      );
      check(
        'an approved request\'s page leaves its own commitment out of "Already committed" and "Available"',
        page.status === 200 && shown.length > 0 && ok.every(Boolean),
        JSON.stringify(page.body.budget),
      );
    }

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
    // The requisition's two steps (2026-10-13). Pulled back after the
    // technical manager signed, nothing stands: the paper must not date his
    // approval as though it still did.
    const big = await raisePr('big enough to print', 60_000);
    const bigSteps = big.request?.workflow?.steps ?? [];
    if (big.request) await act({ requestId: big.request.id, userId: pm.id, action: 'APPROVED' });
    const pendingPdf = await printed(requesterToken, `/purchase-requests/${big.id}/pdf`);
    const pendingText = pendingPdf.text;
    // pendingCount / signedCount (scripts/lib/paper): a sign-off's "Pending"
    // is a run of its own — never the "Pending approval" a status prints —
    // and a dated sign-off prints "Oct 10, 2026, 6:07 AM" under its name, the
    // requester's always and each step's once it has signed.
    const currency = (await prisma.company.findUnique({ where: { id: 'company' }, select: { currency: true } }))?.currency?.trim() || 'PHP';
    check(
      'pending at step 2 of two, the paper prints the technical manager who signed, dated, and the team leader still to sign as Pending',
      big.submitted === 200 &&
        bigSteps.length === 2 &&
        pendingText.includes('Verify PM') &&
        signedCount(pendingText) === 2 &&
        pendingCount(pendingText) === 1 &&
        bigSteps.every((st) => flat(pendingText).includes(st.name.toUpperCase())),
      `${big.submitted} ${bigSteps.length} steps, ${signedCount(pendingText)} signed, ${pendingCount(pendingText)} pending, PM ${pendingText.includes('Verify PM')}`,
    );
    // The sign-offs are the engine's one mapping (slotSignatories): the step's
    // name alone is the role — never "Approved by — Team Leader" — and the
    // team leader's step still open names who may sign it over its Pending.
    check(
      'each step signs in its own name — no "Approved by —" prefix — and an open step names who may sign it',
      !flat(pendingText).includes('APPROVED BY') && flat(pendingText).includes('Verify Team Leader'),
      `approved-by ${flat(pendingText).includes('APPROVED BY')}, leader named ${flat(pendingText).includes('Verify Team Leader')}`,
    );
    check(
      'the paper says "Pending approval" (never the enum), heads its lines "No." and names the currency in the column head, and prints its money as a totals block',
      pendingText.includes('Pending approval') &&
        !pendingText.includes('PENDING_APPROVAL') &&
        pendingText.includes('NO.') &&
        flat(pendingText).includes(`EST. AMOUNT (${currency})`) &&
        pendingText.includes('Estimated total') &&
        pendingText.includes(`${currency} 60,000.00`) &&
        !pendingText.includes('ESTIMATED TOTAL'),
      pendingText.split('\n').filter((l) => /Pending|TOTAL|total|NO\.|EST\./.test(l)).join(' | ').slice(0, 200),
    );
    const bigPulled = await api(requesterToken, 'POST', `/purchase-requests/${big.id}/withdraw`);
    const draftPdf = await printed(requesterToken, `/purchase-requests/${big.id}/pdf`);
    const draftText = draftPdf.text;
    check(
      'pulled back after the project manager signed, it prints no sign-off but the requester\'s: every step of the route it would take is Pending, under who may sign it',
      bigPulled.status === 200 &&
        draftPdf.status === 200 &&
        signedCount(draftText) === 1 &&
        flat(draftText).includes('Verify PM') &&
        flat(draftText).includes('Status: Draft') &&
        pendingCount(draftText) === bigSteps.length &&
        bigSteps.every((st) => flat(draftText).includes(st.name.toUpperCase())),
      `${bigPulled.status} ${draftPdf.status} ${signedCount(draftText)} signed, ${pendingCount(draftText)} pending, PM ${draftText.includes('Verify PM')}`,
    );
    const prPrints = await prisma.auditLog.count({ where: { entityType: 'purchase_request', entityId: big.id, action: 'EXPORTED' } });
    check('both prints of the request are on its trail as EXPORTED', prPrints === 2, String(prPrints));

    // Cancelling a request, and deleting it once cancelled (2026-10-11).
    const cancelNoReason = await api(requesterToken, 'POST', `/purchase-requests/${big.id}/cancel`, {});
    const cancelStranger = await api(otherRequesterToken, 'POST', `/purchase-requests/${big.id}/cancel`, { reason: 'not mine' });
    const cancelled = await api(requesterToken, 'POST', `/purchase-requests/${big.id}/cancel`, { reason: 'no longer needed' });
    const cancelledRow = await prisma.purchaseRequest.findUnique({ where: { id: big.id } });
    check(
      'its requester cancels it with a reason; nobody else does, and not without one',
      cancelNoReason.status === 400 && cancelStranger.status === 403 && cancelled.status === 200 && cancelledRow?.status === 'CANCELLED',
      `${cancelNoReason.status} ${cancelStranger.status} ${cancelled.status} ${cancelledRow?.status}`,
    );
    const delNoRight = await api(requesterToken, 'DELETE', `/purchase-requests/${big.id}`);
    await prisma.user.update({ where: { id: requester.id }, data: { isSuperAdmin: true } });
    const delCancelled = await api(requesterToken, 'DELETE', `/purchase-requests/${big.id}`);
    await prisma.user.update({ where: { id: requester.id }, data: { isSuperAdmin: false } });
    check(
      'a cancelled request is deleted with the delete right, not without it',
      delNoRight.status === 403 && delCancelled.status === 200 && !(await prisma.purchaseRequest.findUnique({ where: { id: big.id } })),
      `${delNoRight.status} ${delCancelled.status}`,
    );

    // ── The printed request once it is refused ──────────────────────────
    // A rejection is final for a request (settlePurchaseRequest), so nobody
    // will ever sign the steps still unsigned: the paper prints no "Pending"
    // under them — "Pending" only where it is the truth — and no open
    // "Approved by" either. What a step DID sign before the refusal stands.
    const stepNamed = (t: string, name: string) => flat(t).includes(name.toUpperCase());
    const rejectedFirst = await raisePr('rejected at the first step', 60_000);
    const rejectedFirstSteps = rejectedFirst.request?.workflow?.steps ?? [];
    if (rejectedFirst.request) {
      await act({ requestId: rejectedFirst.request.id, userId: pm.id, action: 'REJECTED', comment: `${TAG} not this quarter` });
    }
    const rejectedFirstNow = await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: rejectedFirst.id } });
    const rejectedFirstPdf = await printed(requesterToken, `/purchase-requests/${rejectedFirst.id}/pdf`);
    const rejectedFirstText = rejectedFirstPdf.text;
    check(
      'rejected at its first step, the request prints no Pending and no open "Approved by" — only the requester\'s dated sign-off',
      rejectedFirst.submitted === 200 &&
        rejectedFirstSteps.length === 2 &&
        rejectedFirstNow.status === 'REJECTED' &&
        rejectedFirstPdf.status === 200 &&
        pendingCount(rejectedFirstText) === 0 &&
        signedCount(rejectedFirstText) === 1 &&
        flat(rejectedFirstText).includes('REQUESTED BY') &&
        !flat(rejectedFirstText).includes('APPROVED BY') &&
        !rejectedFirstSteps.some((st) => stepNamed(rejectedFirstText, st.name)) &&
        flat(rejectedFirstText).includes('Status: Rejected'),
      `${rejectedFirst.submitted} ${rejectedFirstNow.status} ${rejectedFirstPdf.status}: ${signedCount(rejectedFirstText)} signed, ${pendingCount(rejectedFirstText)} pending`,
    );

    const rejectedLater = await raisePr('rejected by the team leader', 60_000);
    const rejectedLaterSteps = rejectedLater.request?.workflow?.steps ?? [];
    if (rejectedLater.request) {
      await act({ requestId: rejectedLater.request.id, userId: pm.id, action: 'APPROVED' });
      await act({ requestId: rejectedLater.request.id, userId: leader.id, action: 'REJECTED', comment: `${TAG} over budget` });
    }
    const rejectedLaterNow = await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: rejectedLater.id } });
    const rejectedLaterPdf = await printed(requesterToken, `/purchase-requests/${rejectedLater.id}/pdf`);
    const rejectedLaterText = rejectedLaterPdf.text;
    check(
      'rejected by the team leader after the technical manager signed, it prints his dated sign-off and nothing for the step nobody will sign',
      rejectedLaterSteps.length === 2 &&
        rejectedLaterNow.status === 'REJECTED' &&
        rejectedLaterPdf.status === 200 &&
        pendingCount(rejectedLaterText) === 0 &&
        signedCount(rejectedLaterText) === 2 &&
        rejectedLaterText.includes('Verify PM') &&
        stepNamed(rejectedLaterText, rejectedLaterSteps[0].name) &&
        !rejectedLaterSteps.slice(1).some((st) => stepNamed(rejectedLaterText, st.name)) &&
        !flat(rejectedLaterText).includes('Verify Team Leader'),
      `${rejectedLaterNow.status} ${rejectedLaterPdf.status}: ${signedCount(rejectedLaterText)} signed, ${pendingCount(rejectedLaterText)} pending`,
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

    // ── The printed order: every step of its route, and the money block ──
    // The order was signed by the Purchasing Manager (its route under
    // ₱100,000, the sheet of 2026-10-13); the paper prints the step, dated, in
    // its own name — never under "Approved by". Nothing waits on a "Received
    // by": receiving is its own document.
    console.log('\nThe printed purchase order and supplier list');
    const poPrintsBefore = await prisma.auditLog.count({ where: { entityType: 'purchase_order', entityId: po.id, action: 'EXPORTED' } });
    const poPdf = await printed(buyerToken, `/purchase-orders/${po.id}/pdf`);
    const poText = poPdf.text;
    const poSteps = (await prisma.approvalRequest.findFirstOrThrow({
      where: { documentType: 'purchase_order', documentId: po.id },
      orderBy: { createdAt: 'desc' },
      include: { workflow: { select: { steps: { orderBy: { sequence: 'asc' } } } } },
    })).workflow?.steps ?? [];
    check(
      'an issued order prints every step of its route — the purchasing manager under ₱100,000, dated — and nothing Pending',
      poPdf.status === 200 &&
        poSteps.length === 1 &&
        poSteps.every((st) => flat(poText).includes(st.name.toUpperCase())) &&
        flat(poText).includes('Verify Purchasing Manager') &&
        signedCount(poText) === 2 &&
        pendingCount(poText) === 0 &&
        !flat(poText).includes('APPROVED BY') &&
        !flat(poText).includes('RECEIVED BY'),
      `${poPdf.status} ${poSteps.length} steps, ${signedCount(poText)} signed, ${pendingCount(poText)} pending`,
    );
    check(
      'its money is the quotation\'s block — Subtotal, VAT (12%), Total — bare figures, the currency named under Order details, never a TOTAL row in the lines',
      poText.includes('Subtotal') &&
        poText.includes('VAT (12%)') &&
        poText.includes('Total') &&
        /^14,560\.00$/m.test(poText) &&
        flat(poText).includes(`Currency: ${currency}`) &&
        // The one line's amount in the table and again as the Subtotal, bare.
        (poText.match(/^13,000\.00$/gm) ?? []).length === 2 &&
        !poText.includes('TOTAL') &&
        poText.includes('NO.'),
      poText.split('\n').filter((l) => /Subtotal|VAT|Total|TOTAL|AMOUNT|13,000/.test(l)).join(' | ').slice(0, 200),
    );
    const poPrintsAfter = await prisma.auditLog.count({ where: { entityType: 'purchase_order', entityId: po.id, action: 'EXPORTED' } });
    check('the print is on the order\'s trail as EXPORTED', poPrintsAfter === poPrintsBefore + 1, `${poPrintsBefore} → ${poPrintsAfter}`);
    // A draft — this one back in DRAFT with a cancelled stray request behind
    // it — prints the route submitting would take, every step Pending, under
    // whoever may sign it; only the buyer's own sign-off is dated.
    const poDraftPdf = await printed(buyerToken, `/purchase-orders/${poDraftId}/pdf`);
    const poDraftText = poDraftPdf.text;
    check(
      'a draft order prints the route it would take: its step Pending under who may sign it, the buyer\'s the only dated sign-off',
      poDraftPdf.status === 200 &&
        poSteps.every((st) => flat(poDraftText).includes(st.name.toUpperCase())) &&
        pendingCount(poDraftText) === 1 &&
        signedCount(poDraftText) === 1 &&
        flat(poDraftText).includes('Verify Purchasing Manager') &&
        flat(poDraftText).includes('DRAFT — NOT YET ISSUED.'),
      `${poDraftPdf.status} ${signedCount(poDraftText)} signed, ${pendingCount(poDraftText)} pending`,
    );

    // The supplier list on paper: ten columns, so landscape, each column
    // sized from what it holds — a head is never broken mid-word ("AWAI /
    // TING" was), a list's dates are MM/DD/YYYY, and the print is audited.
    const listerRole = await makeRole('zzchain_lister', 'ZZ Lister', ['gchain.suppliers.view_all', 'gchain.purchase_orders.view_all']);
    const lister = await mkUser('Verify Lister', 'lister@verifyc.local', listerRole.id);
    const listPrintsBefore = await prisma.auditLog.count({ where: { entityType: 'supplier', entityId: 'list', action: 'EXPORTED' } });
    // Filtered to today's additions, so the paper's filter line names a day.
    const listDayKey = manilaDayKey(new Date());
    const listPdf = await printed(
      signToken(lister.id, lister.email),
      `/suppliers/pdf?search=${encodeURIComponent(TAG)}&createdFrom=${listDayKey}&createdTo=${listDayKey}`,
    );
    const listText = listPdf.text;
    const listBoxes = listPdf.pages;
    const listPrintsAfter = await prisma.auditLog.count({ where: { entityType: 'supplier', entityId: 'list', action: 'EXPORTED' } });
    check(
      'the supplier list prints on landscape pages, its heads whole, its dates MM/DD/YYYY, and is audited as EXPORTED',
      listPdf.status === 200 &&
        listBoxes.length > 0 &&
        listBoxes.every((b) => b === '841.89x595.28') &&
        listText.includes('AWAITING') &&
        listText.includes('CONTACTS') &&
        listText.includes(`${TAG} Steel Supply`) &&
        /\d{2}\/\d{2}\/\d{4}/.test(listText) &&
        // The filter line's days are a list's dates too — never 'YYYY-MM-DD'.
        flat(listText).includes(`added ${listDayKey.slice(5, 7)}/${listDayKey.slice(8, 10)}/${listDayKey.slice(0, 4)} to `) &&
        !listText.includes(listDayKey) &&
        listPrintsAfter === listPrintsBefore + 1,
      `${listPdf.status} boxes ${listBoxes.join(',')}, awaiting ${listText.includes('AWAITING')}, audited ${listPrintsBefore} → ${listPrintsAfter}`,
    );

    // ── A colleague submits someone else's order ──────────────────────────
    // The approval is filed in the BUYER's name whoever presses Submit, as a
    // purchase request is in its requester's. Here the buyer is the
    // Purchasing Manager (the routing sheet of 2026-10-13): filed in their
    // name, step 1 is THEIR signature at submit (one signature per person),
    // the CEO / President's still to come above ₱100,000, and they can never
    // approve what is left of their own order. Filed in the colleague's name,
    // nobody would have signed and the paper would print a route not taken.
    console.log('\nAn order submitted by a colleague stays the buyer\'s');
    const purchasingRole = await prisma.role.findUniqueOrThrow({ where: { key: 'purchasing_manager' } });
    const buyerPm = await prisma.user.create({
      data: {
        name: 'Verify Buyer PM',
        email: 'buyerpm@verifyc.local',
        passwordHash: await bcrypt.hash('x', 10),
        roles: { create: [{ roleId: buyerRole.id }, { roleId: purchasingRole.id }] },
      },
    });
    const buyerPmToken = signToken(buyerPm.id, buyerPm.email);
    const handedOn = await api(buyerPmToken, 'POST', '/purchase-orders', { supplierId: supplier.id, notes: `${TAG} submitted by a colleague` });
    const handedOnId = String(handedOn.body.id);
    await api(buyerPmToken, 'POST', `/purchase-orders/${handedOnId}/items`, {
      description: `${TAG} gasket`,
      costCategoryId: materials.id,
      quantity: 4,
      unit: 'pcs',
      unitPrice: 30_000,
    });
    const handedOnSubmit = await api(colleagueToken, 'POST', `/purchase-orders/${handedOnId}/submit`);
    const handedOnRequest = await prisma.approvalRequest.findFirst({
      where: { documentType: 'purchase_order', documentId: handedOnId, status: 'PENDING' },
      include: { workflow: { select: { steps: true } }, actions: true },
    });
    let selfApproval = 'not tried';
    if (handedOnRequest) {
      try {
        await act({ requestId: handedOnRequest.id, userId: buyerPm.id, action: 'APPROVED' });
        selfApproval = 'approved';
      } catch (err) {
        selfApproval = (err as Error).message;
      }
    }
    const handedOnNow = handedOnRequest ? await prisma.approvalRequest.findUniqueOrThrow({ where: { id: handedOnRequest.id } }) : null;
    check(
      'a colleague\'s submit files the order in the buyer\'s name: the Purchasing Manager signs their step at submit, the CEO / President waits, and the buyer cannot approve the rest',
      handedOnSubmit.status === 200 &&
        handedOnRequest?.requesterId === buyerPm.id &&
        handedOnRequest.workflow?.steps.length === 2 &&
        handedOnRequest.currentSequence === 2 &&
        handedOnRequest.actions.length === 1 &&
        handedOnRequest.actions[0].selfSigned &&
        handedOnRequest.actions[0].approverId === buyerPm.id &&
        /raised yourself/.test(selfApproval) &&
        handedOnNow?.status === 'PENDING' &&
        handedOnNow.currentSequence === 2,
      `${handedOnSubmit.status} requester ${handedOnRequest?.requesterId === buyerPm.id ? 'the buyer' : handedOnRequest?.requesterId === colleague.id ? 'the colleague' : 'none'}, self-approval: ${selfApproval}`,
    );
    const handedOnPdf = await printed(buyerPmToken, `/purchase-orders/${handedOnId}/pdf`);
    const handedOnText = handedOnPdf.text;
    const preparedLine = (t: string) => (flat(t).match(/PREPARED BY Verify Buyer PM .*?(\w{3} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M)/) ?? [])[1];
    const managerLine = (t: string) => (flat(t).match(/PURCHASING MANAGER Verify Buyer PM .*?(\w{3} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M)/) ?? [])[1];
    check(
      'and its paper prints the buyer as who prepared it and as the Purchasing Manager, under ONE timestamp, with the CEO / President Pending',
      handedOnPdf.status === 200 &&
        !!preparedLine(handedOnText) &&
        preparedLine(handedOnText) === managerLine(handedOnText) &&
        flat(handedOnText).includes('Verify CEO') &&
        pendingCount(handedOnText) === 1,
      `${handedOnPdf.status}: prepared ${preparedLine(handedOnText)}, manager ${managerLine(handedOnText)}, ${pendingCount(handedOnText)} pending — ${flat(handedOnText).slice(-400)}`,
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

    // ── Cancelling and deleting a canvass ────────────────────────────────
    console.log('\nCancelling and deleting a canvass (over HTTP)');
    const liveOrders = await prisma.purchaseOrder.count({
      where: { requestId: pr.id, supplierId: supplier.id, status: { not: 'CANCELLED' } },
    });
    const awardedCancel = await api(canvassLeadToken, 'POST', `/canvasses/${openCanvass.id}/cancel`, { reason: 'changed our mind' });
    check(
      'an award with a live order on it is not cancelled — the order goes first',
      liveOrders > 0 ? awardedCancel.status === 400 && /cancel it first/.test(String(awardedCancel.body.error)) : awardedCancel.status === 200,
      `${liveOrders} ${awardedCancel.status} ${String(awardedCancel.body.error)}`,
    );
    const toCancel = await prisma.canvass.create({
      data: { number: await nextNumber('canvass'), requestId: pr.id, createdById: canvasser.id, suppliers: { create: [{ supplierId: otherSupplier.id }] } },
    });
    const flagsOpen = await api(canvasserToken, 'GET', `/canvasses/${toCancel.id}`);
    const cNoReason = await api(canvasserToken, 'POST', `/canvasses/${toCancel.id}/cancel`, {});
    const cStranger = await api(otherCanvasserToken, 'POST', `/canvasses/${toCancel.id}/cancel`, { reason: 'not mine' });
    const delOpen = await api(canvasserToken, 'DELETE', `/canvasses/${toCancel.id}`);
    const cDone = await api(canvasserToken, 'POST', `/canvasses/${toCancel.id}/cancel`, { reason: 'supplier list was wrong' });
    const cAgain = await api(canvasserToken, 'POST', `/canvasses/${toCancel.id}/cancel`, { reason: 'twice' });
    const cRow = await prisma.canvass.findUniqueOrThrow({ where: { id: toCancel.id } });
    check(
      'its opener cancels an open canvass with a reason; nobody else, not without one, and not twice',
      flagsOpen.body.canCancel === true && flagsOpen.body.canDelete === false &&
        cNoReason.status === 400 && cStranger.status === 403 && cDone.status === 200 && cAgain.status === 400 &&
        cRow.status === 'CANCELLED' && /supplier list was wrong/.test(cRow.notes ?? ''),
      `${flagsOpen.body.canCancel} ${flagsOpen.body.canDelete} ${cNoReason.status} ${cStranger.status} ${cDone.status} ${cAgain.status} ${cRow.status}`,
    );
    const delNoCanvassRight = await api(canvasserToken, 'DELETE', `/canvasses/${toCancel.id}`);
    await prisma.user.update({ where: { id: canvasser.id }, data: { isSuperAdmin: true } });
    const flagsCancelled = await api(canvasserToken, 'GET', `/canvasses/${toCancel.id}`);
    const delCanvass = await api(canvasserToken, 'DELETE', `/canvasses/${toCancel.id}`);
    await prisma.user.update({ where: { id: canvasser.id }, data: { isSuperAdmin: false } });
    check(
      'a cancelled canvass is deleted with the delete right (never an open one), its suppliers with it',
      delOpen.status === 403 && delNoCanvassRight.status === 403 && flagsCancelled.body.canDelete === true &&
        delCanvass.status === 200 && !(await prisma.canvass.findUnique({ where: { id: toCancel.id } })) &&
        (await prisma.canvassSupplier.count({ where: { canvassId: toCancel.id } })) === 0,
      `${delOpen.status} ${delNoCanvassRight.status} ${flagsCancelled.body.canDelete} ${delCanvass.status}`,
    );
    const cancelAudit = await prisma.auditLog.count({ where: { entityType: 'canvass', entityId: toCancel.id, action: { in: ['CANCELLED', 'DELETED'] } } });
    check('the cancel and the delete are audited', cancelAudit === 2, String(cancelAudit));

    {
      // ── Requests for Quotation (2026-10-14) ──────────────────────────────
      // PR › RFQ › Canvass › PO: an RFQ is raised from an APPROVED request,
      // asks some or all of its lines, is printed one paper per supplier, and
      // takes the quotes that come back. No approval route.
      console.log('\nRequests for Quotation (over HTTP)');
      const started = new Date();
      const rfqOwnRole = await makeRole('zzchain_rfq_own', 'ZZ RFQ buyer', [
        'gchain.rfq.view_own',
        'gchain.rfq.create',
        'gchain.rfq.edit_own',
        'gchain.rfq.delete',
      ]);
      const rfqAllRole = await makeRole('zzchain_rfq_all', 'ZZ RFQ lead', ['gchain.rfq.view_all', 'gchain.rfq.edit_all']);
      const rfqBuyer = await mkUser('Verify RFQ Buyer', 'rfqbuyer@verifyc.local', rfqOwnRole.id);
      const rfqOther = await mkUser('Verify RFQ Other', 'rfqother@verifyc.local', rfqOwnRole.id);
      const rfqLead = await mkUser('Verify RFQ Lead', 'rfqlead@verifyc.local', rfqAllRole.id);
      const rfqBuyerToken = signToken(rfqBuyer.id, rfqBuyer.email);
      const rfqOtherToken = signToken(rfqOther.id, rfqOther.email);
      const rfqLeadToken = signToken(rfqLead.id, rfqLead.email);
      const rfqPr = await prisma.purchaseRequest.create({
        data: {
          number: await nextNumber('purchase_request'),
          kind: 'DIRECT_TO_JOB',
          jobId: job.id,
          requestedById: engineer.id,
          status: 'APPROVED',
          approvedAt: new Date(),
          purpose: `${TAG} cable tray for the RFQ`,
          items: {
            create: [
              { sortOrder: 0, costCategoryId: materials.id, partNumber: 'CT-300', name: `${TAG} CABLE TRAY`, description: '300 mm ladder type', quantity: D(40), unit: 'pcs', estimatedCost: D(1_200), estimatedAmount: D(48_000) },
              { sortOrder: 1, costCategoryId: materials.id, name: `${TAG} SUPPORT BRACKET`, description: `${TAG} SUPPORT BRACKET`, quantity: D(80), unit: 'pcs', estimatedCost: D(150), estimatedAmount: D(12_000) },
            ],
          },
        },
        include: { items: { orderBy: { sortOrder: 'asc' } } },
      });
      const [trayLine, bracketLine] = rfqPr.items;
      const draftPr = await prisma.purchaseRequest.create({
        data: { number: await nextNumber('purchase_request'), kind: 'DIRECT_TO_JOB', jobId: job.id, requestedById: engineer.id, purpose: `${TAG} still a draft` },
      });

      const fromDraft = await api(rfqBuyerToken, 'POST', '/rfqs', { requestId: draftPr.id });
      const source = await api(rfqBuyerToken, 'GET', `/rfqs/source?requestId=${rfqPr.id}`);
      const sourceLines = (source.body.lines as { id: string }[] | undefined) ?? [];
      check(
        'an RFQ is raised only from an approved request, and its source offers every line of it with where it is delivered',
        fromDraft.status === 400 && /only an approved request/.test(String(fromDraft.body.error)) &&
          source.status === 200 && sourceLines.length === 2 && String(source.body.deliverTo).includes(job.name),
        `${fromDraft.status} ${String(fromDraft.body.error)} · ${source.status} ${sourceLines.length} "${String(source.body.deliverTo)}"`,
      );

      const foreignLine = await api(rfqBuyerToken, 'POST', '/rfqs', { requestId: rfqPr.id, itemIds: [pr.items[0].id] });
      const twice = await api(rfqBuyerToken, 'POST', '/rfqs', {
        requestId: rfqPr.id,
        suppliers: [{ supplierId: supplier.id }, { supplierId: supplier.id }],
      });
      const noLine = await api(rfqBuyerToken, 'POST', '/rfqs', { requestId: rfqPr.id, itemIds: [] });
      check(
        'a line of another request, a supplier named twice and no line at all are refused before a number is issued',
        foreignLine.status === 400 && twice.status === 400 && noLine.status === 400,
        `${foreignLine.status} ${twice.status} ${noLine.status}`,
      );

      const created = await api(rfqBuyerToken, 'POST', '/rfqs', {
        requestId: rfqPr.id,
        itemIds: [trayLine.id],
        suppliers: [{ supplierId: supplier.id, contactName: 'Ana Reyes' }, { supplierId: otherSupplier.id }],
        dueDate: '2026-10-30',
      });
      const rfqId = String(created.body.id);
      const rfqNumber = String(created.body.number);
      const fresh = await api(rfqBuyerToken, 'GET', `/rfqs/${rfqId}`);
      check(
        'the buyer prepares an RFQ for one line and two suppliers, numbered as an RFQ, a draft that may be sent',
        created.status === 201 && /RFQ/.test(rfqNumber) && fresh.body.status === 'DRAFT' &&
          (fresh.body.lines as unknown[]).length === 1 && (fresh.body.suppliers as unknown[]).length === 2 &&
          fresh.body.canSend === true && fresh.body.canRecordQuotes === false && fresh.body.canEditLines === true,
        `${created.status} ${rfqNumber} ${String(fresh.body.status)} ${fresh.body.canSend}`,
      );
      const asked = await api(rfqBuyerToken, 'GET', `/rfqs/source?requestId=${rfqPr.id}`);
      const askedOn = (asked.body.lines as { id: string; askedOn: string[] }[]).find((l) => l.id === trayLine.id)?.askedOn ?? [];
      check('the request\'s source marks the line already asked on that RFQ', askedOn.includes(rfqNumber), askedOn.join());

      const otherList = await api(rfqOtherToken, 'GET', `/rfqs?requestId=${rfqPr.id}`);
      const otherRead = await api(rfqOtherToken, 'GET', `/rfqs/${rfqId}`);
      const otherSheet = await api(rfqOtherToken, 'PUT', `/rfqs/${rfqId}/sheet`, { version: fresh.body.version, suppliers: [] });
      const leadList = await api(rfqLeadToken, 'GET', `/rfqs?requestId=${rfqPr.id}`);
      check(
        'a view-own colleague neither lists nor opens nor changes it; the lead with view_all lists it',
        (otherList.body.total as number) === 0 && otherRead.status === 404 && otherSheet.status === 403 && (leadList.body.total as number) === 1,
        `${otherList.body.total} ${otherRead.status} ${otherSheet.status} ${leadList.body.total}`,
      );

      const rows0 = fresh.body.suppliers as { id: string; supplierId: string }[];
      const keepRow = rows0.find((r) => r.supplierId === supplier.id)!;
      const stale = await api(rfqBuyerToken, 'PUT', `/rfqs/${rfqId}/sheet`, { version: '2000-01-01T00:00:00.000Z', suppliers: [] });
      const sheet = await api(rfqBuyerToken, 'PUT', `/rfqs/${rfqId}/sheet`, {
        version: fresh.body.version,
        itemIds: [trayLine.id, bracketLine.id],
        suppliers: [{ id: keepRow.id, supplierId: supplier.id, contactName: 'Ana Reyes', contactPhone: '0917 000 0000' }],
        deliverTo: 'Plant gate 2',
        terms: 'Quote VAT inclusive; 30 days.',
      });
      check(
        'one save changes the header, asks the second line and drops a supplier; a stale version is refused',
        stale.status === 400 && /changed a moment ago/.test(String(stale.body.error)) && sheet.status === 200 &&
          (sheet.body.lines as unknown[]).length === 2 && (sheet.body.suppliers as unknown[]).length === 1 &&
          sheet.body.deliverTo === 'Plant gate 2',
        `${stale.status} ${sheet.status} ${(sheet.body.lines as unknown[] | undefined)?.length} ${(sheet.body.suppliers as unknown[] | undefined)?.length}`,
      );

      const earlyQuote = await api(rfqBuyerToken, 'PUT', `/rfqs/${rfqId}/suppliers/${keepRow.id}/quote`, { quotes: [] });
      const sent = await api(rfqBuyerToken, 'POST', `/rfqs/${rfqId}/send`);
      const sentAgain = await api(rfqBuyerToken, 'POST', `/rfqs/${rfqId}/send`);
      const sentRows = await prisma.rfqSupplier.findMany({ where: { rfqId } });
      check(
        'a quote waits until it is sent; Mark sent dates the RFQ and each supplier asked, once',
        earlyQuote.status === 400 && sent.status === 200 && sent.body.status === 'SENT' && !!sent.body.sentAt &&
          sentRows.every((r) => r.sentAt) && sentAgain.status === 400,
        `${earlyQuote.status} ${sent.status} ${String(sent.body.status)} ${sentAgain.status}`,
      );

      const linesAfterSend = await api(rfqBuyerToken, 'PUT', `/rfqs/${rfqId}/sheet`, {
        version: sent.body.version,
        itemIds: [trayLine.id],
        suppliers: [{ id: keepRow.id, supplierId: supplier.id }],
      });
      const lateSupplier = await api(rfqBuyerToken, 'PUT', `/rfqs/${rfqId}/sheet`, {
        version: sent.body.version,
        suppliers: [{ id: keepRow.id, supplierId: supplier.id, contactName: 'Ana Reyes' }, { supplierId: otherSupplier.id }],
      });
      const lateRow = await prisma.rfqSupplier.findFirst({ where: { rfqId, supplierId: otherSupplier.id } });
      check(
        'once sent its lines are fixed, and a supplier added late is asked on the day it is added',
        linesAfterSend.status === 400 && /was sent/.test(String(linesAfterSend.body.error)) && lateSupplier.status === 200 && !!lateRow?.sentAt,
        `${linesAfterSend.status} ${lateSupplier.status} ${lateRow?.sentAt?.toISOString()}`,
      );

      const notAsked = await api(rfqBuyerToken, 'PUT', `/rfqs/${rfqId}/suppliers/${keepRow.id}/quote`, {
        quotes: [{ requestItemId: pr.items[0].id, unitPrice: 1 }],
      });
      const quote = await api(rfqBuyerToken, 'PUT', `/rfqs/${rfqId}/suppliers/${keepRow.id}/quote`, {
        quotes: [
          { requestItemId: trayLine.id, unitPrice: 1_150.5 },
          { requestItemId: bracketLine.id, unitPrice: 140 },
        ],
        quoteRef: 'Q-7781',
        leadTimeDays: 14,
        terms: '30 days',
        validUntil: '2026-11-30',
      });
      const quotedRow = (quote.body.suppliers as { id: string; total: number; complete: boolean; quotedCount: number }[] | undefined)?.find((r) => r.id === keepRow.id);
      check(
        'a supplier\'s quote is recorded per line asked (a line not asked is refused); the RFQ is QUOTED and the total is quantity × price',
        notAsked.status === 400 && quote.status === 200 && quote.body.status === 'QUOTED' &&
          quotedRow?.total === 40 * 1_150.5 + 80 * 140 && quotedRow.complete === true && quotedRow.quotedCount === 2,
        `${notAsked.status} ${quote.status} ${String(quote.body.status)} ${quotedRow?.total}`,
      );
      const dropQuoted = await api(rfqBuyerToken, 'PUT', `/rfqs/${rfqId}/sheet`, {
        version: quote.body.version,
        suppliers: [{ supplierId: otherSupplier.id, id: lateRow!.id }],
      });
      check('a supplier who quoted stays on the RFQ', dropQuoted.status === 400 && /quoted/.test(String(dropQuoted.body.error)), `${dropQuoted.status} ${String(dropQuoted.body.error)}`);

      const theirPaper = await printed(rfqBuyerToken, `/rfqs/${rfqId}/pdf?supplier=${keepRow.id}`);
      const theirText = flat(theirPaper.text);
      const wholePaper = await printed(rfqBuyerToken, `/rfqs/${rfqId}/pdf`);
      const wholeText = flat(wholePaper.text);
      check(
        'each supplier\'s paper is addressed to them alone, asks every line with the price left blank, and prints Prepared by with its timestamp',
        theirPaper.status === 200 && /REQUEST FOR QUOTATION/.test(theirText) && theirText.includes(`${TAG} Steel Supply`) &&
          !theirText.includes(`${TAG} Other Supply`) && theirText.includes(`${TAG} CABLE TRAY`) && theirText.includes(`${TAG} SUPPORT BRACKET`) &&
          !theirText.includes('1,150.50') && /PREPARED BY Verify RFQ Buyer .*?\w{3} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M/.test(theirText) &&
          theirText.includes('Quote VAT inclusive'),
        `${theirPaper.status} — ${theirText.slice(0, 500)}`,
      );
      check(
        'the RFQ\'s own paper lists every supplier asked and what each quoted',
        wholePaper.status === 200 && wholeText.includes(`${TAG} Steel Supply`) && wholeText.includes(`${TAG} Other Supply`) &&
          wholeText.includes('57,220.00') && /Prepared by|PREPARED BY/.test(wholeText),
        `${wholePaper.status} — ${wholeText.slice(0, 400)}`,
      );
      const listPaper = await printed(rfqLeadToken, `/rfqs/pdf?requestId=${rfqPr.id}`);
      check(
        'the RFQ list prints, naming the request that narrowed it',
        listPaper.status === 200 && flat(listPaper.text).includes(rfqNumber) && flat(listPaper.text).includes(rfqPr.number),
        `${listPaper.status} ${flat(listPaper.text).slice(0, 300)}`,
      );

      const guardOwn = await api(rfqBuyerToken, 'GET', `/attachments/rfq_supplier/${keepRow.id}`);
      const guardOther = await api(rfqOtherToken, 'GET', `/attachments/rfq_supplier/${keepRow.id}`);
      check('a supplier\'s quotation files are read as the RFQ is read', guardOwn.status === 200 && guardOther.status === 404, `${guardOwn.status} ${guardOther.status}`);

      const hits = await globalSearch(rfqNumber, (await resolveUser(rfqLead.id))!);
      const otherHits = await globalSearch(rfqNumber, (await resolveUser(rfqOther.id))!);
      check(
        'Ctrl+K finds the RFQ for whoever may read it, and not for a view-own colleague',
        hits.some((h) => h.kind === 'rfq' && h.id === rfqId) && !otherHits.some((h) => h.kind === 'rfq' && h.id === rfqId),
        JSON.stringify(hits.map((h) => h.kind)),
      );

      // ── The canvass sheet from the RFQ (push 3) ─────────────────────────
      console.log('\nThe canvass sheet (over HTTP)');
      const sheetRole = await makeRole('zzchain_sheet', 'ZZ Canvasser of sheets', [
        'gchain.canvass.view_all',
        'gchain.canvass.create',
        'gchain.canvass.edit_own',
        'gchain.canvass.edit_all',
        'gchain.canvass.delete',
        'gchain.purchase_orders.view_all',
      ]);
      const sheetBuyer = await mkUser('Verify Sheet Buyer', 'sheetbuyer@verifyc.local', sheetRole.id);
      const sheetToken = signToken(sheetBuyer.id, sheetBuyer.email);
      // A partial quote too: the late supplier prices the tray alone, under the complete one.
      const partial = await api(rfqBuyerToken, 'PUT', `/rfqs/${rfqId}/suppliers/${lateRow!.id}/quote`, {
        quotes: [{ requestItemId: trayLine.id, unitPrice: 1_100 }],
      });
      const draftRfq = await api(rfqBuyerToken, 'POST', '/rfqs', { requestId: rfqPr.id, itemIds: [bracketLine.id] });
      const fromDraftRfq = await api(sheetToken, 'POST', '/canvasses', { rfqId: draftRfq.body.id });
      await api(rfqBuyerToken, 'DELETE', `/rfqs/${String(draftRfq.body.id)}`);
      const readyBefore = await api(sheetToken, 'GET', '/rfqs/canvassable');
      const sheetMade = await api(sheetToken, 'POST', '/canvasses', { rfqId });
      const readyAfter = await api(sheetToken, 'GET', '/rfqs/canvassable');
      check(
        '"+ New canvass" offers an RFQ with quotes and no live sheet, and no longer once a sheet compares it',
        readyBefore.status === 200 &&
          (readyBefore.body as { id: string }[]).some((r) => r.id === rfqId) &&
          !(readyAfter.body as { id: string }[]).some((r) => r.id === rfqId),
        `${readyBefore.status} ${JSON.stringify(readyBefore.body).slice(0, 160)}`,
      );
      const sheetId = String(sheetMade.body.id);
      const secondSheet = await api(sheetToken, 'POST', '/canvasses', { rfqId });
      const sheetRow = await prisma.canvass.findUniqueOrThrow({ where: { id: sheetId }, include: { suppliers: { include: { quotes: true } } } });
      check(
        'a sheet is raised only from an RFQ that went out, one live at a time, snapshotting its lines and the suppliers that quoted with their quotes',
        partial.status === 200 && fromDraftRfq.status === 400 && sheetMade.status === 201 && secondSheet.status === 400 &&
          sheetRow.rfqId === rfqId && sheetRow.lineIds.length === 2 && sheetRow.suppliers.length === 2 &&
          sheetRow.suppliers.every((r) => !!r.rfqSupplierId) && sheetRow.suppliers.reduce((n, r) => n + r.quotes.length, 0) === 3,
        `${partial.status} ${fromDraftRfq.status} ${sheetMade.status} ${secondSheet.status} ${sheetRow.lineIds.length} ${sheetRow.suppliers.length}`,
      );
      type SheetCol = { id: string; supplierId: string; total: number; savings: number; savingsPct: number | null; budgetOnQuoted: number; complete: boolean; quotedCount: number };
      const sheet1 = await api(sheetToken, 'GET', `/canvasses/${sheetId}`);
      const cols1 = sheet1.body.suppliers as SheetCol[];
      const fullCol = cols1.find((c) => c.supplierId === supplier.id)!;
      const partCol = cols1.find((c) => c.supplierId === otherSupplier.id)!;
      check(
        'the sheet reads the reference budget off the request (₱60,000), each column\'s saving against it, a partial quote measured on its own lines and kept out of "lowest"',
        sheet1.body.budget === 60_000 &&
          fullCol.total === 57_220 && fullCol.savings === 2_780 && fullCol.savingsPct === 4.63 && fullCol.complete &&
          partCol.total === 44_000 && partCol.budgetOnQuoted === 48_000 && partCol.savings === 4_000 && partCol.savingsPct === 8.33 && !partCol.complete &&
          sheet1.body.lowestSupplierId === fullCol.id,
        JSON.stringify({ budget: sheet1.body.budget, cols1, lowest: sheet1.body.lowestSupplierId }),
      );
      const figures = canvassFigures(
        [
          { id: 'a', quantity: 3, estimatedCost: 33.33, estimatedAmount: 99.99 },
          { id: 'b', quantity: 0.5, estimatedCost: 10.01, estimatedAmount: 5.01 },
        ],
        [{ id: 'x', prices: { a: 33.34, b: 10.01 } }, { id: 'y', prices: {} }],
      );
      check(
        'the sheet\'s arithmetic is exact to the centavo, half away from zero, and a column with no quote has no saving',
        // 0.5 × 10.01 = 5.005 → 5.01 (half away from zero); −0.03 of 105 is −0.0286% → −0.03%.
        figures.budget === 105 && figures.columns[0].amounts.a === 100.02 && figures.columns[0].amounts.b === 5.01 &&
          figures.columns[0].total === 105.03 && figures.columns[0].savingsPct === -0.03 && figures.columns[1].savingsPct === null &&
          figures.lowestCompleteId === 'x',
        JSON.stringify(figures),
      );

      // The snapshot: a quote changed on the RFQ moves nothing until "Refresh from RFQ".
      await api(rfqBuyerToken, 'PUT', `/rfqs/${rfqId}/suppliers/${keepRow.id}/quote`, {
        quotes: [
          { requestItemId: trayLine.id, unitPrice: 1_000 },
          { requestItemId: bracketLine.id, unitPrice: 140 },
        ],
        quoteRef: 'Q-7781-B',
      });
      const unmoved = ((await api(sheetToken, 'GET', `/canvasses/${sheetId}`)).body.suppliers as SheetCol[]).find((c) => c.supplierId === supplier.id)!;
      const refreshed = await api(sheetToken, 'POST', `/canvasses/${sheetId}/refresh`);
      const moved = (refreshed.body.suppliers as SheetCol[] | undefined)?.find((c) => c.supplierId === supplier.id);
      check(
        'the sheet keeps the quotes it was raised with until "Refresh from RFQ" copies them again',
        unmoved.total === 57_220 && refreshed.status === 200 && moved?.total === 51_200 && moved.savingsPct === 14.67,
        `${unmoved.total} ${refreshed.status} ${moved?.total} ${moved?.savingsPct}`,
      );
      const offSheet = await api(sheetToken, 'PUT', `/canvasses/${sheetId}/suppliers/${fullCol.id}/quotes`, {
        quotes: [{ requestItemId: pr.items[0].id, unitPrice: 1 }],
      });
      const recommended = await api(sheetToken, 'PATCH', `/canvasses/${sheetId}`, { recommendedRowId: partCol.id });
      const rfqCancelLive = await api(rfqBuyerToken, 'POST', `/rfqs/${rfqId}/cancel`, { reason: 'too early' });
      check(
        'a price for a line the sheet does not compare is refused; the buyer recommends a column; the RFQ is not cancelled while a sheet compares it',
        offSheet.status === 400 && recommended.status === 200 && recommended.body.recommendedRowId === partCol.id &&
          rfqCancelLive.status === 400 && String(rfqCancelLive.body.error).includes(String(sheetMade.body.number)),
        `${offSheet.status} ${recommended.status} ${rfqCancelLive.status} ${String(rfqCancelLive.body.error)}`,
      );

      const awardedSheet = await api(sheetToken, 'POST', `/canvasses/${sheetId}/award/${fullCol.id}`);
      const awardAgain = await api(sheetToken, 'POST', `/canvasses/${sheetId}/award/${partCol.id}`);
      const afterAward = await prisma.canvass.findUniqueOrThrow({ where: { id: sheetId } });
      const rfqAfterAward = await prisma.rfq.findUniqueOrThrow({ where: { id: rfqId } });
      const listed = await api(sheetToken, 'GET', `/canvasses?rfqId=${rfqId}`);
      const listRow = (listed.body.rows as { id: string; budget: number; pick: { name: string; awarded: boolean; savingsPct: number } | null }[]).find((r) => r.id === sheetId);
      check(
        'the award records who awarded it, closes the RFQ, cannot land twice, and the list reads the sheet\'s saving off the award',
        awardedSheet.status === 200 && awardAgain.status === 400 && afterAward.status === 'AWARDED' && afterAward.awardedById === sheetBuyer.id &&
          rfqAfterAward.status === 'CLOSED' && listRow?.budget === 60_000 && listRow.pick?.awarded === true && listRow.pick.savingsPct === 14.67,
        `${awardedSheet.status} ${awardAgain.status} ${afterAward.status} ${rfqAfterAward.status} ${JSON.stringify(listRow)}`,
      );

      const sheetPaper = await printed(sheetToken, `/canvasses/${sheetId}/pdf`);
      const sheetText = flat(sheetPaper.text);
      check(
        'the canvass sheet prints landscape: the reference budget, each supplier with its contact, the total, the savings (pesos and %), and who canvassed and who awarded it, each with the timestamp',
        sheetPaper.status === 200 && sheetPaper.pages.every((pg) => pg === LANDSCAPE) && /CANVASS SHEET/.test(sheetText) &&
          /REFERENCE BUDGET/.test(sheetText) && sheetText.includes(`${TAG} STEEL SUPPLY`) && sheetText.includes(`${TAG} OTHER SUPPLY`) &&
          /SAVINGS vs reference budget/.test(sheetText) && sheetText.includes('8,800.00') && sheetText.includes('14.67%') &&
          sheetText.includes('not quoted') && sheetText.includes('60,000.00') &&
          /CANVASSED BY Verify Sheet Buyer .*?\w{3} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M/.test(sheetText) &&
          /AWARDED BY Verify Sheet Buyer .*?\w{3} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M/.test(sheetText),
        `${sheetPaper.status} ${sheetPaper.pages.join()} — ${sheetText.slice(0, 600)}`,
      );

      const sheetCancel = await api(sheetToken, 'POST', `/canvasses/${sheetId}/cancel`, { reason: 'the scope changed' });
      const rfqAfterCancel = await prisma.rfq.findUniqueOrThrow({ where: { id: rfqId } });
      check(
        'an award withdrawn (no order on it) opens its RFQ again, to be canvassed anew',
        sheetCancel.status === 200 && rfqAfterCancel.status === 'QUOTED',
        `${sheetCancel.status} ${rfqAfterCancel.status}`,
      );
      await api(sheetToken, 'DELETE', `/canvasses/${sheetId}`);
      await prisma.auditLog.deleteMany({ where: { entityType: 'canvass', entityId: sheetId } });

      // The request cannot be cancelled while it is out for quotation.
      await prisma.user.update({ where: { id: rfqBuyer.id }, data: { isSuperAdmin: true } });
      const prCancel = await api(rfqBuyerToken, 'POST', `/purchase-requests/${rfqPr.id}/cancel`, { reason: 'not needed any more' });
      await prisma.user.update({ where: { id: rfqBuyer.id }, data: { isSuperAdmin: false } });
      check(
        'a purchase request out for quotation is not cancelled — its open RFQ goes first',
        prCancel.status === 400 && String(prCancel.body.error).includes(rfqNumber),
        `${prCancel.status} ${String(prCancel.body.error)}`,
      );

      const delOpenRfq = await api(rfqBuyerToken, 'DELETE', `/rfqs/${rfqId}`);
      const cancelNoReason = await api(rfqBuyerToken, 'POST', `/rfqs/${rfqId}/cancel`, {});
      const cancelOther = await api(rfqOtherToken, 'POST', `/rfqs/${rfqId}/cancel`, { reason: 'not mine' });
      const cancelled = await api(rfqBuyerToken, 'POST', `/rfqs/${rfqId}/cancel`, { reason: 'the scope changed' });
      const lateQuote = await api(rfqBuyerToken, 'PUT', `/rfqs/${rfqId}/suppliers/${keepRow.id}/quote`, { quotes: [] });
      check(
        'an open RFQ is not deleted; its preparer cancels it with a reason, nobody else; a cancelled one takes no quote',
        delOpenRfq.status === 400 && cancelNoReason.status === 400 && cancelOther.status === 403 && cancelled.status === 200 && lateQuote.status === 400,
        `${delOpenRfq.status} ${cancelNoReason.status} ${cancelOther.status} ${cancelled.status} ${lateQuote.status}`,
      );
      const deleted = await api(rfqBuyerToken, 'DELETE', `/rfqs/${rfqId}`);
      check(
        'a cancelled RFQ is deleted with its suppliers and their quotes',
        deleted.status === 200 && !(await prisma.rfq.findUnique({ where: { id: rfqId } })) &&
          (await prisma.rfqQuote.count({ where: { rfqSupplierId: keepRow.id } })) === 0,
        String(deleted.status),
      );
      const rfqAudits = await prisma.auditLog.groupBy({ by: ['action'], where: { entityType: 'rfq', entityId: rfqId }, _count: true });
      const auditOf = (a: string) => rfqAudits.find((r) => r.action === a)?._count ?? 0;
      check(
        'prepared, every change, each print, the cancel and the delete are audited',
        auditOf('CREATED') === 1 && auditOf('UPDATED') >= 4 && auditOf('EXPORTED') >= 2 && auditOf('CANCELLED') === 1 && auditOf('DELETED') === 1,
        JSON.stringify(rfqAudits),
      );
      await prisma.auditLog.deleteMany({ where: { entityType: 'rfq', entityId: { in: [rfqId, 'list'] } } });

      // The canvass gave its numbering code to the RFQ: a template still on
      // 'RFQ' moves to 'CVS' once, and a code set afterwards is kept.
      {
        const rows = await prisma.numberSequence.findMany({ where: { documentType: 'canvass' }, select: { id: true, periodKey: true, typeCode: true } });
        const template = rows.find((r) => r.periodKey === '');
        const mark = await prisma.setting.findUnique({ where: { key: CANVASS_CODE_MOVED } });
        const codes = async () => (await prisma.numberSequence.findMany({ where: { documentType: 'canvass' }, select: { typeCode: true } })).map((r) => r.typeCode);
        try {
          if (template) {
            await prisma.setting.deleteMany({ where: { key: CANVASS_CODE_MOVED } });
            // A period counter too: it prints with its own copy of the code.
            const year = await prisma.numberSequence.upsert({
              where: { documentType_periodKey: { documentType: 'canvass', periodKey: '2099' } },
              create: { documentType: 'canvass', periodKey: '2099', label: 'Canvass', pattern: '{PREFIX}-{TYPE}-{YYYY}-{SEQ}', typeCode: 'RFQ', period: 'YEAR', scope: 'GLOBAL', padding: 4, lastNumber: 0 },
              update: { typeCode: 'RFQ' },
            });
            // Every row on RFQ — a fresh move.
            await prisma.numberSequence.updateMany({ where: { documentType: 'canvass' }, data: { typeCode: 'RFQ' } });
            const first = await moveCanvassCode();
            const afterFirst = await codes();
            // Once only: a code set afterwards stays.
            await prisma.numberSequence.update({ where: { id: template.id }, data: { typeCode: 'RFQ' } });
            const second = await moveCanvassCode();
            const afterSecond = (await prisma.numberSequence.findUniqueOrThrow({ where: { id: template.id } })).typeCode;
            // What the first version left on an install: the template moved, the counter not.
            await prisma.setting.deleteMany({ where: { key: CANVASS_CODE_MOVED } });
            await prisma.numberSequence.update({ where: { id: template.id }, data: { typeCode: 'CVS' } });
            await prisma.numberSequence.update({ where: { id: year.id }, data: { typeCode: 'RFQ' } });
            const mended = await moveCanvassCode();
            const afterMend = await codes();
            // An administrator's own code is theirs.
            await prisma.setting.deleteMany({ where: { key: CANVASS_CODE_MOVED } });
            await prisma.numberSequence.updateMany({ where: { documentType: 'canvass' }, data: { typeCode: 'CNV' } });
            const theirs = await moveCanvassCode();
            const afterTheirs = await codes();
            const rfqTemplate = await prisma.numberSequence.findFirst({ where: { documentType: 'rfq', periodKey: '' } });
            await prisma.numberSequence.delete({ where: { id: year.id } });
            check(
              'the canvass\'s numbering code moves from RFQ to CVS once — the template and every period counter, mending an install where only the template moved — never over a code set afterwards or an administrator\'s own, and RFQ numbers the RFQ',
              first.moved && afterFirst.every((c) => c === 'CVS') && !second.moved && afterSecond === 'RFQ' &&
                mended.moved && afterMend.every((c) => c === 'CVS') && !theirs.moved && afterTheirs.every((c) => c === 'CNV') &&
                rfqTemplate?.typeCode === 'RFQ',
              `${first.moved} ${afterFirst.join()} ${second.moved} ${afterSecond} ${mended.moved} ${afterMend.join()} ${theirs.moved} ${afterTheirs.join()} ${rfqTemplate?.typeCode}`,
            );
          }
        } finally {
          for (const r of rows) await prisma.numberSequence.updateMany({ where: { id: r.id }, data: { typeCode: r.typeCode } });
          await prisma.numberSequence.deleteMany({ where: { documentType: 'canvass', periodKey: '2099' } });
          await prisma.setting.deleteMany({ where: { key: CANVASS_CODE_MOVED } });
          if (mark) await prisma.setting.create({ data: { key: mark.key, value: mark.value as Prisma.InputJsonValue, description: mark.description } });
          await prisma.auditLog.deleteMany({ where: { entityType: 'number_sequence', entityId: 'canvass', summary: { contains: 'moved from RFQ to CVS' }, at: { gte: started } } });
        }
      }
    }

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
    // A slip goes out the way every slip does since 2026-10-14: requested,
    // approved by a Team Leader and the Warehouse Supervisor, released by
    // the warehouse. A request cannot be due back before today, so the late
    // one is moved back a day once it is out — the state a slip is in a day
    // after its due date.
    const todayKey = manilaDayKey(new Date());
    const yesterdayKey = manilaDayKey(new Date(Date.now() - 86_400_000));
    const whSup = await makeUser('Verify Warehouse Supervisor', 'whsup@verifyc.local', ['warehouse_supervisor']);
    const lend = async (dueAt: string, label: string): Promise<HttpResult> => {
      const made = await api(keeperToken, 'POST', '/borrow-slips', {
        warehouseId: warehouse.id,
        borrowerName: 'Verify Rigger',
        dueAt: dueAt < todayKey ? todayKey : dueAt,
        purpose: `${TAG} ${label}`,
        items: [{ itemId: item.id, quantity: 1 }],
      });
      if (made.status !== 201) return made;
      const slipId = String(made.body.id);
      const sent = await api(keeperToken, 'POST', `/borrow-slips/${slipId}/submit`);
      const pending = await prisma.approvalRequest.findFirst({ where: { documentType: 'borrow_slip', documentId: slipId, status: 'PENDING' } });
      if (pending) {
        // Step 1 is the keeper's "Reports to" once they have one (the store
        // supervisor, further down), else a Team Leader.
        const reportsTo = (await prisma.user.findUniqueOrThrow({ where: { id: keeper.id }, select: { supervisorId: true } })).supervisorId;
        await act({ requestId: pending.id, userId: reportsTo ?? leader.id, action: 'APPROVED' });
        await act({ requestId: pending.id, userId: whSup.id, action: 'APPROVED' });
      }
      const released = await api(keeperToken, 'POST', `/borrow-slips/${slipId}/release`, {});
      if (dueAt < todayKey) await prisma.borrowSlip.update({ where: { id: slipId }, data: { dueAt: new Date(`${dueAt}T00:00:00Z`) } });
      return sent.status === 200 && released.status === 200 ? made : { ...released, body: { ...released.body, id: slipId } };
    };
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
    // Outgoing and Incoming go to the issuer's or receiver's "Reports to".
    await prisma.user.update({ where: { id: keeper.id }, data: { supervisorId: boss.id } });
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

    // Outgoing goes for approval (2026-10-14, the owner's call): the issuer's
    // "Reports to" decides — here the keeper reports to the store supervisor —
    // and the approval issues it. The draft on paper: who raised it, dated,
    // then the route submitting would take and the person it goes to, each
    // "Pending" under the name. Never an "Issued by" on a routed slip (the
    // approval moved the stock) and never the "Noted by" nobody fills.
    check(
      'a draft says it goes for approval, to the issuer’s supervisor, and offers Submit — not Issue',
      issueFlags.body.needsApproval === true &&
        issueFlags.body.canSubmit === true && // edit_all may send it up, in the issuer's name
        issueFlags.body.canIssue === false &&
        ((issueFlags.body.approvalRoute as { steps: { approvers: { name: string }[] }[] } | null)?.steps ?? [])
          .flatMap((s) => s.approvers.map((p) => p.name))
          .includes('Verify Store Supervisor'),
      JSON.stringify({ n: issueFlags.body.needsApproval, s: issueFlags.body.canSubmit, i: issueFlags.body.canIssue, r: issueFlags.body.approvalRoute }).slice(0, 220),
    );
    const issuePrintsBefore = await prisma.auditLog.count({ where: { entityType: 'stock_issue', entityId: draftIssueId, action: 'EXPORTED' } });
    const draftIssuePdf = await printed(bossToken, `/stock-issues/${draftIssueId}/pdf`);
    const draftIssueText = draftIssuePdf.text;
    check(
      'a draft outgoing slip is a Delivery Receipt: who prepared it, dated, then the supervisor and the receiver over Pending — no "Issued by", no "Noted by", and DRAFT in its foot',
      draftIssuePdf.status === 200 &&
        // The title, in capitals, wraps in its box: DELIVERY over RECEIPT.
        /DELIVERY\s+RECEIPT/.test(draftIssueText) &&
        flat(draftIssueText).includes('PREPARED & DISPATCHED BY') &&
        flat(draftIssueText).includes('SUPERVISOR') &&
        flat(draftIssueText).includes('RECEIVED IN GOOD ORDER BY') &&
        !flat(draftIssueText).includes('ISSUED BY') &&
        !flat(draftIssueText).includes('NOTED BY') &&
        flat(draftIssueText).includes('Verify Keeper') &&
        flat(draftIssueText).includes('Verify Store Supervisor') &&
        flat(draftIssueText).includes('Verify Rigger') &&
        signedCount(draftIssueText) === 1 &&
        pendingCount(draftIssueText) === 2 &&
        flat(draftIssueText).includes('DRAFT — NOT YET ISSUED.'),
      `${draftIssuePdf.status} ${signedCount(draftIssueText)} signed, ${pendingCount(draftIssueText)} pending; ${JSON.stringify(
        ['PREPARED & DISPATCHED BY', 'RECEIVED IN GOOD ORDER BY', 'DRAFT — NOT YET ISSUED.'].filter((w) => !flat(draftIssueText).includes(w)),
      )}`,
    );

    const onHand = async (w = warehouse.id) =>
      num((await prisma.inventoryBalance.findUnique({ where: { itemId_warehouseId: { itemId: item.id, warehouseId: w } } }))?.quantity);
    const pressIssue = await api(keeperToken, 'POST', `/stock-issues/${draftIssueId}/issue`);
    check(
      'with its route active, Issue is refused and says the slip goes for approval',
      pressIssue.status === 400 && String(pressIssue.body.error ?? '').includes('goes for approval'),
      `${pressIssue.status} ${JSON.stringify(pressIssue.body).slice(0, 140)}`,
    );
    const siteBefore = await onHand(siteStore.id);
    const issueSubmitted = await api(keeperToken, 'POST', `/stock-issues/${draftIssueId}/submit`);
    const issuePendingEdit = await api(keeperToken, 'PATCH', `/stock-issues/${draftIssueId}`, { purpose: `${TAG} behind the approver` });
    const issuePendingLine = await api(keeperToken, 'POST', `/stock-issues/${draftIssueId}/items`, { itemId: item.id, quantity: 1 });
    const siteWhilePending = await onHand(siteStore.id);
    const issueRequest = await prisma.approvalRequest.findFirst({
      where: { documentType: 'stock_issue', documentId: draftIssueId, status: 'PENDING' },
    });
    check(
      'issueSubmitted, it waits on the supervisor: nothing has left the shelf, and it cannot be modified behind the approver',
      issueSubmitted.status === 200 &&
        issueSubmitted.body.status === 'PENDING_APPROVAL' &&
        issueSubmitted.body.canWithdraw === true &&
        !!issueRequest &&
        issuePendingEdit.status === 400 &&
        issuePendingLine.status === 400 &&
        money(siteBefore - siteWhilePending, 0),
      `${issueSubmitted.status} ${issueSubmitted.body.status} req ${!!issueRequest}; edit ${issuePendingEdit.status} line ${issuePendingLine.status}; ${siteBefore} → ${siteWhilePending}`,
    );

    // Pulled back and sent again, then the supervisor decides from the
    // document itself (the Approval panel's door) and the approval issues it.
    const pulledBack = await api(keeperToken, 'POST', `/stock-issues/${draftIssueId}/withdraw`);
    const withdrawnRequest = issueRequest ? await prisma.approvalRequest.findUnique({ where: { id: issueRequest.id } }) : null;
    check(
      'pulled back, it is a draft again and its request is withdrawn — not left in the supervisor’s queue',
      pulledBack.status === 200 && pulledBack.body.status === 'DRAFT' && withdrawnRequest?.status === 'CANCELLED',
      `${pulledBack.status} ${pulledBack.body.status} ${withdrawnRequest?.status}`,
    );
    const again = await api(keeperToken, 'POST', `/stock-issues/${draftIssueId}/submit`);
    const openRequest = await prisma.approvalRequest.findFirst({
      where: { documentType: 'stock_issue', documentId: draftIssueId, status: 'PENDING' },
    });
    const keeperSelf = openRequest ? await act({ requestId: openRequest.id, userId: keeper.id, action: 'APPROVED' }).then(() => 'acted', (e: Error) => e.message) : 'none';
    const bossDecides = openRequest
      ? await api(bossToken, 'POST', `/approvals/${openRequest.id}/act`, { action: 'APPROVED' })
      : { status: 0, body: {} as Record<string, unknown> };
    const siteAfter = await onHand(siteStore.id);
    const issuedMoves = await prisma.inventoryTransaction.count({ where: { sourceType: 'stock_issue', sourceId: draftIssueId } });
    const issuedRow = await prisma.stockIssue.findUniqueOrThrow({ where: { id: draftIssueId } });
    check(
      'the storekeeper cannot approve their own slip; the supervisor approves it and the approval issues it — the stock leaves once',
      again.status === 200 &&
        keeperSelf !== 'acted' &&
        bossDecides.status === 200 &&
        issuedRow.status === 'ISSUED' &&
        issuedRow.issuedAt !== null &&
        money(siteBefore - siteAfter, 2) &&
        issuedMoves === 1,
      `${again.status} self: ${keeperSelf}; boss ${bossDecides.status} ${JSON.stringify(bossDecides.body).slice(0, 100)}; ${issuedRow.status}; ${siteBefore} → ${siteAfter}; ${issuedMoves} move(s)`,
    );
    const settledTwice = await settleStockIssue(draftIssueId, 'APPROVED').then(() => 'ok', (e: Error) => e.message);
    const movesAfterTwice = await prisma.inventoryTransaction.count({ where: { sourceType: 'stock_issue', sourceId: draftIssueId } });
    check(
      'a second settlement of the same approval moves nothing again',
      settledTwice === 'ok' && movesAfterTwice === 1 && money(siteAfter - (await onHand(siteStore.id)), 0),
      `${settledTwice} ${movesAfterTwice}`,
    );

    // Pulled back after approval (2026-10-16, the owner's call): an issued
    // slip goes back to a draft through the engine's one door, its stock
    // returned and the project's cost reversed by rows of its own; once the
    // receiver confirms it, it is refused.
    {
      const made = await api(keeperToken, 'POST', '/stock-issues', { warehouseId: warehouse.id, purpose: `${TAG} issue to pull back` });
      const backId = String(made.body.id);
      await api(keeperToken, 'POST', `/stock-issues/${backId}/items`, { itemId: item.id, quantity: 1 });
      await api(keeperToken, 'PATCH', `/stock-issues/${backId}`, { jobId: job.id });
      const approveIt = async () => {
        await api(keeperToken, 'POST', `/stock-issues/${backId}/submit`);
        const open = await prisma.approvalRequest.findFirst({ where: { documentType: 'stock_issue', documentId: backId, status: 'PENDING' } });
        if (open) await api(bossToken, 'POST', `/approvals/${open.id}/act`, { action: 'APPROVED' });
        return (await prisma.stockIssue.findUniqueOrThrow({ where: { id: backId } })).status;
      };
      const before = await onHand();
      const incurredBefore = (await position()).incurred;
      const firstIssue = await approveIt();
      const whileOut = await onHand();
      const back = await api(keeperToken, 'POST', `/approvals/reopen/stock_issue/${backId}`, { reason: `${TAG} wrong project` });
      const backRow = await prisma.stockIssue.findUniqueOrThrow({ where: { id: backId } });
      const ledgerNet = await prisma.jobCostEntry.aggregate({ where: { sourceType: 'stock_issue', sourceId: backId }, _sum: { amount: true } });
      const reversals = await prisma.jobCostEntry.count({ where: { sourceType: 'stock_issue', sourceId: backId, amount: { lt: 0 } } });
      check(
        'an issued outgoing slip is pulled back to a draft by its issuer: the stock comes back and the project’s cost is reversed by negative rows, never deleted',
        firstIssue === 'ISSUED' &&
          money(before - whileOut, 1) &&
          back.status === 200 &&
          backRow.status === 'DRAFT' &&
          backRow.issuedAt === null &&
          money(await onHand(), before) &&
          money((await position()).incurred, incurredBefore) &&
          num(ledgerNet._sum.amount) === 0 &&
          reversals === 2,
        `${firstIssue}; ${before} → ${whileOut} → ${await onHand()}; ${back.status} ${JSON.stringify(back.body).slice(0, 140)}; ${backRow.status}; incurred ${incurredBefore} → ${(await position()).incurred}; net ${ledgerNet._sum.amount} (${reversals} reversals)`,
      );
      const secondIssue = await approveIt();
      const confirmed = await api(bossToken, 'POST', `/stock-issues/${backId}/receive`, { note: `${TAG} signed copy` });
      const refused = await api(keeperToken, 'POST', `/approvals/reopen/stock_issue/${backId}`, { reason: `${TAG} too late` });
      check(
        'sent again it issues again; once the receiver confirmed it, pulling it back is refused and says why',
        secondIssue === 'ISSUED' &&
          confirmed.status === 200 &&
          refused.status === 400 &&
          String(refused.body.error ?? '').includes('confirmed received') &&
          (await prisma.stockIssue.findUniqueOrThrow({ where: { id: backId } })).status === 'ISSUED',
        `${secondIssue}; confirm ${confirmed.status}; ${refused.status} ${JSON.stringify(refused.body).slice(0, 140)}`,
      );
    }

    const issuedEdit = await api(keeperToken, 'PATCH', `/stock-issues/${draftIssueId}`, { purpose: `${TAG} after the fact` });
    const issuedDelete = await api(bossToken, 'DELETE', `/stock-issues/${draftIssueId}`);
    const issuedFlags = await api(bossToken, 'GET', `/stock-issues/${draftIssueId}`);
    check(
      'issued, it refuses both Modify and Delete — the stock has moved',
      issuedEdit.status === 400 && issuedDelete.status === 400 && issuedFlags.body.canEdit === false && issuedFlags.body.canDelete === false,
      `${issuedEdit.status} ${issuedDelete.status}`,
    );
    // Issued, the paper dates who prepared it and the supervisor who approved
    // it; "Received in good order by" waits for the receiver to confirm it
    // (2026-10-15, the owner's call: Outgoing is the internal receive proof).
    // A receipt prints no prices.
    const issuedPdf = await printed(bossToken, `/stock-issues/${draftIssueId}/pdf`);
    const issuedText = issuedPdf.text;
    const issuePrintsAfter = await prisma.auditLog.count({ where: { entityType: 'stock_issue', entityId: draftIssueId, action: 'EXPORTED' } });
    check(
      'an issued outgoing slip dates who prepared it and the supervisor who approved it; the receiver is Pending until they confirm',
      issuedPdf.status === 200 &&
        ['PREPARED & DISPATCHED BY', 'SUPERVISOR', 'RECEIVED IN GOOD ORDER BY'].every((r) => flat(issuedText).includes(r)) &&
        !flat(issuedText).includes('NOTED BY') &&
        !flat(issuedText).includes('ISSUED BY') &&
        signedCount(issuedText) === 2 &&
        pendingCount(issuedText) === 1 &&
        !flat(issuedText).includes('DRAFT — NOT YET ISSUED.'),
      `${issuedPdf.status} ${signedCount(issuedText)} signed, ${pendingCount(issuedText)} pending`,
    );
    check(
      'the receipt lists serial and condition and prints no price, cost or total',
      flat(issuedText).includes('SERIAL / BATCH') &&
        flat(issuedText).includes('CONDITION') &&
        flat(issuedText).includes('DELIVERY DETAILS') &&
        !flat(issuedText).includes('UNIT COST') &&
        !issuedText.includes(`${currency} 400.00`) &&
        !/^Total$/m.test(issuedText),
      issuedText.split('\n').filter((l) => /Total|COST|SERIAL|400/.test(l)).join(' | ').slice(0, 200),
    );
    check('both prints of the stock issue are on its trail as EXPORTED', issuePrintsAfter === issuePrintsBefore + 2, `${issuePrintsBefore} → ${issuePrintsAfter}`);

    // The receive proof for a receiver with no login (a name on the slip):
    // the warehouse lead records the signed paper copy for them, once; a
    // stranger cannot.
    const strangerReceipt = await api(buyerToken, 'POST', `/stock-issues/${draftIssueId}/receive`, {});
    const recorded = await api(bossToken, 'POST', `/stock-issues/${draftIssueId}/receive`, { note: 'paper copy signed at the gate' });
    const recordedTwice = await api(bossToken, 'POST', `/stock-issues/${draftIssueId}/receive`, {});
    const recordedRow = await prisma.stockIssue.findUniqueOrThrow({ where: { id: draftIssueId } });
    check(
      'the warehouse lead records the receipt for a receiver with no login — once, saying who entered it; a stranger cannot',
      strangerReceipt.status === 403 &&
        recorded.status === 200 &&
        recorded.body.canConfirmReceipt === false &&
        recordedRow.receivedAt !== null &&
        recordedRow.receivedById === boss.id &&
        String(recordedRow.receivedNote ?? '').includes('Recorded by Verify Store Supervisor for Verify Rigger') &&
        String(recordedRow.receivedNote ?? '').includes('paper copy signed at the gate') &&
        recordedTwice.status === 400,
      `${strangerReceipt.status} ${recorded.status} ${recordedTwice.status} ${recordedRow.receivedNote}`,
    );
    const receivedText = (await printed(bossToken, `/stock-issues/${draftIssueId}/pdf`)).text;
    check(
      'confirmed, the receipt dates all three — nothing Pending — and says what was noted on receipt',
      signedCount(receivedText) === 3 && pendingCount(receivedText) === 0 && flat(receivedText).includes('paper copy signed at the gate'),
      `${signedCount(receivedText)} signed, ${pendingCount(receivedText)} pending`,
    );

    // The Outgoing page saves header and lines at once (2026-10-15): issued
    // to a person with a login, who reads their own slip with no warehouse
    // right, is told when it is issued, finds it in My Work and confirms it.
    const plainRole = await makeRole('zzchain_plain', 'ZZ No warehouse right', ['gchain.dashboard.view_all']);
    const plain = await mkUser('Verify Plain', 'plain@verifyc.local', plainRole.id);
    const plainToken = signToken(plain.id, plain.email);
    const outSheetBody = {
      warehouseId: siteStore.id,
      purpose: `${TAG} for the requestor`,
      issuedToId: buyer.id,
      deliverTo: 'Plant 2, compressor room',
      referenceNo: 'JO-REQ-77',
      carrier: 'Company van ABC 1234',
      driverName: 'Verify Driver',
      lines: [{ itemId: item.id, quantity: 1, serialNo: 'SN-0001', condition: 'New' }],
    };
    const outTooMuch = await api(keeperToken, 'POST', '/stock-issues', { ...outSheetBody, purpose: `${TAG} too much`, lines: [{ itemId: item.id, quantity: 999 }] });
    const outTooMuchRows = await prisma.stockIssue.count({ where: { purpose: `${TAG} too much` } });
    const outSheet = await api(keeperToken, 'POST', '/stock-issues', outSheetBody);
    const outSheetId = String(outSheet.body.id);
    const outSheetRow = await prisma.stockIssue.findUniqueOrThrow({ where: { id: outSheetId }, include: { items: true } });
    check(
      'the page saves the slip with its lines at once — priced at the average, the standard terms of receipt filled in — and refuses more than is available before writing anything',
      outTooMuch.status === 400 &&
        String(outTooMuch.body.error ?? '').includes('available') &&
        outTooMuchRows === 0 &&
        outSheet.status === 201 &&
        outSheetRow.items.length === 1 &&
        outSheetRow.items[0].serialNo === 'SN-0001' &&
        money(num(outSheetRow.items[0].amount), 200) &&
        String(outSheetRow.instructions ?? '').startsWith('Please check') &&
        outSheetRow.issuedToId === buyer.id,
      `${outTooMuch.status} ${outTooMuchRows}; ${outSheet.status} ${outSheetRow.items.length} ${outSheetRow.instructions?.slice(0, 20)}`,
    );
    const outStale = await api(keeperToken, 'PUT', `/stock-issues/${outSheetId}/sheet`, { ...outSheetBody, version: new Date(Date.now() - 60_000).toISOString() });
    const outResheet = await api(keeperToken, 'PUT', `/stock-issues/${outSheetId}/sheet`, {
      ...outSheetBody,
      version: outSheetRow.updatedAt.toISOString(),
      lines: [{ itemId: item.id, quantity: 2, serialNo: 'SN-0001, SN-0002', condition: 'New' }],
    });
    check(
      'a modify read before somebody else’s save is refused; the current one replaces the lines and re-prices them',
      outStale.status === 400 && outResheet.status === 200 && money(Number(outResheet.body.value), 400) && (outResheet.body.items as unknown[]).length === 1,
      `${outStale.status} ${outResheet.status} ${outResheet.body.value}`,
    );
    const outReadsOwn = await api(buyerToken, 'GET', `/stock-issues/${outSheetId}`);
    const outStrangerReads = await api(plainToken, 'GET', `/stock-issues/${outSheetId}`);
    const outEarlyConfirm = await api(buyerToken, 'POST', `/stock-issues/${outSheetId}/receive`, {});
    check(
      'the person it is issued to reads their own slip with no warehouse right; someone else gets a 404; nothing to confirm before it is issued',
      outReadsOwn.status === 200 && outStrangerReads.status === 404 && outEarlyConfirm.status === 400,
      `${outReadsOwn.status} ${outStrangerReads.status} ${outEarlyConfirm.status}`,
    );
    await api(keeperToken, 'POST', `/stock-issues/${outSheetId}/submit`);
    const outSheetRequest = await prisma.approvalRequest.findFirst({ where: { documentType: 'stock_issue', documentId: outSheetId, status: 'PENDING' } });
    const outSheetApproved = outSheetRequest ? await api(bossToken, 'POST', `/approvals/${outSheetRequest.id}/act`, { action: 'APPROVED' }) : { status: 0, body: {} };
    const outToldIssued = await prisma.notification.count({ where: { userId: buyer.id, type: 'warehouse.issued_to_you', link: `/g-chain/outgoing/${outSheetId}` } });
    const outBuyerWork = await api(buyerToken, 'GET', '/my-work');
    const outInWork = ((outBuyerWork.body.assignedToMe ?? []) as { kind: string; link: string }[]).some((r) => r.kind === 'stock_issue' && r.link === `/g-chain/outgoing/${outSheetId}`);
    const outNotYet = await api(bossToken, 'GET', `/stock-issues?received=no&search=${encodeURIComponent(`${TAG} for the requestor`)}`);
    check(
      'approved, it is issued and its receiver is told, and My Work asks them to confirm it; the list counts it as not yet confirmed',
      outSheetApproved.status === 200 &&
        outToldIssued === 1 &&
        outInWork &&
        outNotYet.status === 200 &&
        Number((outNotYet.body as { total?: number }).total) === 1 &&
        Number((outNotYet.body.summary as { toConfirm?: number } | undefined)?.toConfirm) === 1,
      `${outSheetApproved.status} bell ${outToldIssued} work ${outInWork} list ${outNotYet.status} ${JSON.stringify(outNotYet.body.summary)}`,
    );
    const outConfirmed = await api(buyerToken, 'POST', `/stock-issues/${outSheetId}/receive`, { note: 'complete' });
    const outKeeperTold = await prisma.notification.count({ where: { userId: keeper.id, type: 'warehouse.received', link: `/g-chain/outgoing/${outSheetId}` } });
    const outConfirmedRow = await prisma.stockIssue.findUniqueOrThrow({ where: { id: outSheetId } });
    const outNowConfirmed = await api(bossToken, 'GET', `/stock-issues?received=yes&search=${encodeURIComponent(`${TAG} for the requestor`)}`);
    const outPaper = await printed(buyerToken, `/stock-issues/${outSheetId}/pdf`);
    check(
      'the receiver confirms it themself — dated, in their own name — the warehouse is told, and their paper signs "Received in good order by" with nothing Pending',
      outConfirmed.status === 200 &&
        outConfirmedRow.receivedById === buyer.id &&
        outConfirmedRow.receivedNote === 'complete' &&
        outKeeperTold === 1 &&
        Number((outNowConfirmed.body as { total?: number }).total) === 1 &&
        outPaper.status === 200 &&
        flat(outPaper.text).includes('RECEIVED IN GOOD ORDER BY') &&
        flat(outPaper.text).includes(buyer.name) &&
        flat(outPaper.text).includes('Plant 2, compressor room') &&
        flat(outPaper.text).includes('SN-0001, SN-0002') &&
        pendingCount(outPaper.text) === 0,
      `${outConfirmed.status} ${outConfirmedRow.receivedNote} told ${outKeeperTold} list ${outNowConfirmed.body.total} paper ${outPaper.status} ${pendingCount(outPaper.text)}`,
    );

    // Submit claims the draft before anything is sent: two presses at once
    // send it once, and the second is told. A decision that lands after the
    // slip was pulled back changes nothing.
    const twice = await api(keeperToken, 'POST', '/stock-issues', { warehouseId: warehouse.id, purpose: `${TAG} pressed twice` });
    const twiceId = String(twice.body.id);
    await api(keeperToken, 'POST', `/stock-issues/${twiceId}/items`, { itemId: item.id, quantity: 1 });
    const presses = await Promise.all([
      api(keeperToken, 'POST', `/stock-issues/${twiceId}/submit`),
      api(keeperToken, 'POST', `/stock-issues/${twiceId}/submit`),
    ]);
    const twiceRequests = await prisma.approvalRequest.count({ where: { documentType: 'stock_issue', documentId: twiceId } });
    check(
      'two presses of Submit at once send it once: one goes through, the other is refused',
      presses.filter((p) => p.status === 200).length === 1 && presses.filter((p) => p.status === 400).length === 1 && twiceRequests === 1,
      `${presses.map((p) => p.status).join(' ')}; ${twiceRequests} request(s)`,
    );
    const lateLine = await api(keeperToken, 'POST', `/stock-issues/${twiceId}/items`, { itemId: item.id, quantity: 1 });
    check('a line cannot be added once it has gone for approval', lateLine.status === 400, String(lateLine.status));
    const beforeLate = await onHand();
    await api(keeperToken, 'POST', `/stock-issues/${twiceId}/withdraw`);
    await settleStockIssue(twiceId, 'APPROVED');
    const issueLateRow = await prisma.stockIssue.findUniqueOrThrow({ where: { id: twiceId } });
    const issueLateTrail = await prisma.auditLog.findFirst({
      where: { entityType: 'stock_issue', entityId: twiceId, summary: { contains: 'not applied' } },
    });
    check(
      'an approval that lands after the slip was pulled back issues nothing, and its trail says so',
      issueLateRow.status === 'DRAFT' && money(beforeLate - (await onHand()), 0) && !!issueLateTrail,
      `${issueLateRow.status} ${issueLateTrail?.summary ?? 'no trail'}`,
    );

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

    // ── Borrow requests (2026-10-14) ─────────────────────────────────────
    // Anyone asks to borrow; the Team Leader they report to — or a Technical
    // Manager on their team — then the Warehouse Supervisor approve; the
    // warehouse releases it. Nothing leaves the shelf before the release.
    console.log('\nBorrow requests (over HTTP)');
    {
      const [kat, hit] = await Promise.all([
        prisma.industry.findFirstOrThrow({ where: { code: 'KAT' } }),
        prisma.industry.findFirstOrThrow({ where: { code: 'HIT' } }),
      ]);
      const borrower = await makeUser('Verify Borrower', 'borrower@verifyc.local', ['employee']);
      const tmKat = await makeUser('Verify Borrow TM', 'btm@verifyc.local', ['technical_manager', 'employee']);
      const tmHit = await makeUser('Verify Other TM', 'btm2@verifyc.local', ['technical_manager']);
      const bystander = await makeUser('Verify Bystander', 'bystander@verifyc.local', ['employee']);
      await prisma.user.update({ where: { id: borrower.id }, data: { supervisorId: leader.id } });
      for (const [u, team, no] of [
        [borrower, kat, 1],
        [tmKat, kat, 2],
        [tmHit, hit, 3],
      ] as const) {
        await prisma.employee.create({
          data: { employeeNo: `${TAG}-E${no}`, firstName: u.name.split(' ')[1], lastName: u.name.split(' ').slice(2).join(' ') || 'Verify', userId: u.id, industryId: team.id },
        });
      }
      const borrowerToken = signToken(borrower.id, borrower.email);
      const tmKatToken = signToken(tmKat.id, tmKat.email);
      const tmHitToken = signToken(tmHit.id, tmHit.email);
      const bystanderToken = signToken(bystander.id, bystander.email);
      const available = async () => {
        const b = await prisma.inventoryBalance.findUnique({ where: { itemId_warehouseId: { itemId: item.id, warehouseId: warehouse.id } } });
        return num(b?.quantity) - num(b?.borrowedQty);
      };
      const inDays = (n: number) => manilaDayKey(new Date(Date.now() + n * 86_400_000));
      const ask = (token: string, extra: Record<string, unknown> = {}) =>
        api(token, 'POST', '/borrow-slips', {
          warehouseId: warehouse.id,
          dueAt: inDays(3),
          neededOn: inDays(1),
          purpose: `${TAG} borrow request`,
          items: [{ itemId: item.id, quantity: 2 }],
          ...extra,
        });

      const forSomeoneElse = await ask(borrowerToken, { borrowerId: keeper.id });
      const tooMany = await ask(borrowerToken, { items: [{ itemId: item.id, quantity: 999_999 }] });
      const backdated = await ask(borrowerToken, { dueAt: yesterdayKey });
      check(
        'anyone asks for themselves only, for what the shelf holds available, and never due back before today',
        forSomeoneElse.status === 403 && tooMany.status === 400 && String(tooMany.body.error ?? '').startsWith('Only') && backdated.status === 400,
        `${forSomeoneElse.status} ${tooMany.status} ${JSON.stringify(tooMany.body).slice(0, 100)} ${backdated.status}`,
      );

      const freeBefore = await available();
      const asked = await ask(borrowerToken, { borrowerName: 'Somebody Else' });
      const askedId = String(asked.body.id);
      const askedRow = await prisma.borrowSlip.findUniqueOrThrow({ where: { id: askedId } });
      check(
        'an employee’s request is a DRAFT in their own name — the name typed is ignored — and nothing leaves the shelf',
        asked.status === 201 &&
          asked.body.needsApproval === true &&
          askedRow.status === 'DRAFT' &&
          askedRow.borrowerId === borrower.id &&
          askedRow.borrowerName === 'Verify Borrower' &&
          askedRow.requestedById === borrower.id &&
          askedRow.issuedById === null &&
          money(await available(), freeBefore),
        `${asked.status} ${askedRow.status} ${askedRow.borrowerName} ${askedRow.issuedById}; ${freeBefore} → ${await available()}`,
      );

      const mineRead = await api(borrowerToken, 'GET', `/borrow-slips/${askedId}`);
      const stepNames = (r: HttpResult, n: number) =>
        ((r.body.approvalRoute as { steps: { approvers: { name: string }[] }[] } | null)?.steps[n]?.approvers ?? []).map((p) => p.name);
      check(
        'the route names the Team Leader they report to AND the Technical Manager on their team — not one on another team — then the Warehouse Supervisor',
        mineRead.status === 200 &&
          mineRead.body.canSubmit === true &&
          mineRead.body.canRelease === false &&
          stepNames(mineRead, 0).includes('Verify Team Leader') &&
          stepNames(mineRead, 0).includes('Verify Borrow TM') &&
          !stepNames(mineRead, 0).includes('Verify Other TM') &&
          stepNames(mineRead, 1).includes('Verify Warehouse Supervisor'),
        JSON.stringify(mineRead.body.approvalRoute).slice(0, 260),
      );
      const strangerRead = await api(bystanderToken, 'GET', `/borrow-slips/${askedId}`);
      const strangerList = (await api(bystanderToken, 'GET', `/borrow-slips?search=${TAG}&pageSize=200`)).body.rows as { id: string }[];
      const mineList = await api(borrowerToken, 'GET', `/borrow-slips?search=${TAG}&pageSize=200`);
      check(
        'a colleague cannot open it nor find it on the list; the requester’s own list holds it, with the summary cards',
        strangerRead.status === 404 &&
          !strangerList.some((r) => r.id === askedId) &&
          (mineList.body.rows as { id: string }[]).every((r) => r.id !== lateId) &&
          (mineList.body.rows as { id: string }[]).some((r) => r.id === askedId) &&
          typeof (mineList.body.summary as { awaitingApproval?: number } | undefined)?.awaitingApproval === 'number',
        `${strangerRead.status} ${strangerList.length} ${JSON.stringify(mineList.body.summary)}`,
      );

      const sentUp = await api(borrowerToken, 'POST', `/borrow-slips/${askedId}/submit`);
      const borrowRequest = await prisma.approvalRequest.findFirst({ where: { documentType: 'borrow_slip', documentId: askedId, status: 'PENDING' } });
      const tmKatRead = await api(tmKatToken, 'GET', `/borrow-slips/${askedId}`);
      const tmHitRead = await api(tmHitToken, 'GET', `/borrow-slips/${askedId}`);
      check(
        'submitted, the Technical Manager on the team may open it to decide; one on another team may not',
        sentUp.status === 200 && sentUp.body.status === 'PENDING_APPROVAL' && !!borrowRequest && tmKatRead.status === 200 && tmHitRead.status === 404,
        `${sentUp.status} ${sentUp.body.status} ${tmKatRead.status} ${tmHitRead.status}`,
      );

      if (borrowRequest) await act({ requestId: borrowRequest.id, userId: tmKat.id, action: 'APPROVED' });
      const afterStep1 = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: borrowRequest!.id } });
      const earlyRelease = await api(borrowerToken, 'POST', `/borrow-slips/${askedId}/release`, {});
      const keeperEarly = await api(keeperToken, 'POST', `/borrow-slips/${askedId}/release`, {});
      check(
        'the Technical Manager signs step 1; it waits on the Warehouse Supervisor, and nobody releases it before',
        afterStep1.status === 'PENDING' && afterStep1.currentSequence === 2 && earlyRelease.status === 403 && keeperEarly.status === 400,
        `${afterStep1.status} step ${afterStep1.currentSequence}; ${earlyRelease.status} ${keeperEarly.status}`,
      );

      await act({ requestId: borrowRequest!.id, userId: whSup.id, action: 'APPROVED' });
      const approvedRow = await prisma.borrowSlip.findUniqueOrThrow({ where: { id: askedId } });
      const toRelease = await prisma.notification.count({ where: { userId: whSup.id, type: 'borrow.to_release', link: `/g-chain/borrow-slips/${askedId}` } });
      check(
        'the Warehouse Supervisor’s signature approves it — the warehouse is told it waits for release — and still nothing has left the shelf',
        approvedRow.status === 'APPROVED' && toRelease === 1 && money(await available(), freeBefore),
        `${approvedRow.status} ${toRelease} bell(s); ${freeBefore} → ${await available()}`,
      );
      const keeperWork = await api(keeperToken, 'GET', '/my-work');
      check(
        'My Work lists the approved request for the warehouse to release',
        ((keeperWork.body.assignedToMe ?? []) as { kind: string; link: string }[]).some((r) => r.kind === 'borrow_slip' && r.link === `/g-chain/borrow-slips/${askedId}`),
        String(keeperWork.status),
      );

      const released = await api(keeperToken, 'POST', `/borrow-slips/${askedId}/release`, {});
      const releasedRow = await prisma.borrowSlip.findUniqueOrThrow({ where: { id: askedId } });
      const releasedBell = await prisma.notification.count({ where: { userId: borrower.id, type: 'borrow.released' } });
      const twiceReleased = await api(keeperToken, 'POST', `/borrow-slips/${askedId}/release`, {});
      check(
        'the warehouse releases it: OUT, released by the storekeeper, two lent out of available — once — and the requester is told',
        released.status === 200 &&
          releasedRow.status === 'OUT' &&
          releasedRow.issuedById === keeper.id &&
          releasedRow.releasedAt !== null &&
          money(freeBefore - (await available()), 2) &&
          releasedBell === 1 &&
          twiceReleased.status === 400,
        `${released.status} ${releasedRow.status} ${releasedRow.issuedById === keeper.id}; ${freeBefore} → ${await available()}; ${releasedBell} ${twiceReleased.status}`,
      );
      const slipPaper = await printed(borrowerToken, `/borrow-slips/${askedId}/pdf`);
      check(
        'its paper signs REQUESTED BY, the Team Leader / Technical Manager, the Warehouse Supervisor and RELEASED BY — each dated',
        slipPaper.status === 200 &&
          ['REQUESTED BY', 'TEAM LEADER / TECHNICAL MANAGER', 'WAREHOUSE SUPERVISOR', 'RELEASED BY'].every((r) => flat(slipPaper.text).includes(r)) &&
          flat(slipPaper.text).includes('Verify Borrow TM') &&
          signedCount(slipPaper.text) === 4 &&
          pendingCount(slipPaper.text) === 0,
        `${slipPaper.status} ${signedCount(slipPaper.text)} signed, ${pendingCount(slipPaper.text)} pending`,
      );
      // The borrower's slip (2026-10-15, the owner's form): the paper's five
      // sections, the clearance lines blank while anything is out; the
      // custodian records what came back and in what condition.
      const SLIP_WORDS = ["BORROWER'S DETAILS", 'EQUIPMENT & TOOL DETAILS', 'CONDITION OUT', 'REASON FOR BORROWING', 'RETURN CLEARANCE'];
      check(
        "its paper is the Borrower's Slip: the borrower's details, the equipment with its condition out, the reason and site, and the return clearance left blank for the custodian",
        /BORROWER'?S\s+SLIP/i.test(slipPaper.text) &&
          SLIP_WORDS.every((w) => flat(slipPaper.text).toUpperCase().includes(w)) &&
          flat(slipPaper.text).includes('Actual return date: ______') &&
          flat(slipPaper.text).includes('Site location:'),
        SLIP_WORDS.filter((w) => !flat(slipPaper.text).toUpperCase().includes(w)).join(','),
      );
      const askedLines = await prisma.borrowSlipItem.findMany({ where: { slipId: askedId } });
      const broughtBack = await api(keeperToken, 'POST', `/borrow-slips/${askedId}/return`, {
        items: askedLines.map((l) => ({ itemId: l.id, quantity: Number(l.quantity), conditionBack: 'Fair' })),
        returnedCondition: 'DAMAGED',
        note: `${TAG} handle cracked`,
      });
      const backRow = await prisma.borrowSlip.findUniqueOrThrow({ where: { id: askedId }, include: { items: true } });
      check(
        'taken back whole, it is RETURNED and the stock is available again',
        broughtBack.status === 200 && backRow.status === 'RETURNED' && money(await available(), freeBefore),
        `${broughtBack.status} ${await available()}`,
      );
      const backPaper = await printed(borrowerToken, `/borrow-slips/${askedId}/pdf`);
      check(
        'the return clearance records each line’s condition back, the custodian’s verdict and note, who inspected it and when — on the record and the paper',
        backRow.returnedCondition === 'DAMAGED' &&
          backRow.inspectedById === keeper.id &&
          backRow.inspectedAt !== null &&
          backRow.returnNote === `${TAG} handle cracked` &&
          backRow.items.every((i) => i.conditionBack === 'Fair') &&
          flat(backPaper.text).includes('Returned condition: Damaged') &&
          flat(backPaper.text).includes('Inspected by: Verify Keeper') &&
          flat(backPaper.text).includes('handle cracked') &&
          !flat(backPaper.text).includes('Actual return date: ______'),
        `${backRow.returnedCondition} ${backRow.inspectedById === keeper.id} ${backRow.items.map((i) => i.conditionBack)} ${backPaper.status}`,
      );
      const typed = await api(borrowerToken, 'POST', '/borrow-slips', {
        warehouseId: warehouse.id,
        borrowType: 'ON_SITE_PROJECT',
        siteLocation: `${TAG} customer plant, Pasig`,
        contactNo: '0917 000 0000',
        dueAt: todayKey,
        purpose: `${TAG} typed borrow`,
        items: [{ itemId: item.id, quantity: 1, conditionOut: 'Fair' }],
      });
      const typedRow = await prisma.borrowSlip.findUniqueOrThrow({ where: { id: String(typed.body.id) }, include: { items: true } });
      const byType = await api(keeperToken, 'GET', `/borrow-slips?borrowType=ON_SITE_PROJECT&search=${encodeURIComponent(`${TAG} customer plant`)}`);
      const badType = await api(keeperToken, 'GET', `/borrow-slips?borrowType=LENDING`);
      check(
        'a request carries its borrowing type, site and contact, each line its condition out; the list filters by type and refuses one it does not know',
        typed.status === 201 &&
          typedRow.borrowType === 'ON_SITE_PROJECT' &&
          typedRow.siteLocation === `${TAG} customer plant, Pasig` &&
          typedRow.items[0]?.conditionOut === 'Fair' &&
          byType.body.total === 1 &&
          (byType.body.rows as { borrowTypeLabel: string }[])[0]?.borrowTypeLabel === 'On-site project / customer site' &&
          badType.status === 400,
        `${typed.status} ${typedRow.borrowType} ${byType.body.total} ${badType.status}`,
      );

      // A Technical Manager's own request: they hold step 1, so it is signed
      // when they submit it (the preparer signs) and goes to the warehouse.
      const tmAsk = await ask(tmKatToken);
      const tmSent = await api(tmKatToken, 'POST', `/borrow-slips/${String(tmAsk.body.id)}/submit`);
      const tmRequest = await prisma.approvalRequest.findFirst({
        where: { documentType: 'borrow_slip', documentId: String(tmAsk.body.id) },
        include: { actions: true },
      });
      check(
        'a Technical Manager’s own request is signed at step 1 when submitted, and waits on the Warehouse Supervisor',
        tmAsk.status === 201 &&
          tmSent.status === 200 &&
          tmRequest?.status === 'PENDING' &&
          tmRequest.currentSequence === 2 &&
          tmRequest.actions.some((a) => a.selfSigned && a.action === 'APPROVED'),
        `${tmAsk.status} ${tmSent.status} ${tmRequest?.status} step ${tmRequest?.currentSequence}`,
      );

      // Pulled back, sent again, then cancelled while waiting: the request is
      // withdrawn, and an approval that lands afterwards changes nothing.
      const second = await ask(borrowerToken);
      const secondId = String(second.body.id);
      await api(borrowerToken, 'POST', `/borrow-slips/${secondId}/submit`);
      const pulled = await api(borrowerToken, 'POST', `/borrow-slips/${secondId}/withdraw`);
      const resent = await api(borrowerToken, 'POST', `/borrow-slips/${secondId}/submit`);
      const resentRequest = await prisma.approvalRequest.findFirst({ where: { documentType: 'borrow_slip', documentId: secondId, status: 'PENDING' } });
      const cancelled = await api(borrowerToken, 'POST', `/borrow-slips/${secondId}/cancel`, { reason: `${TAG} not needed after all` });
      await settleBorrowSlip(secondId, 'APPROVED');
      const secondRow = await prisma.borrowSlip.findUniqueOrThrow({ where: { id: secondId } });
      const lateApproval = await prisma.auditLog.findFirst({ where: { entityType: 'borrow_slip', entityId: secondId, summary: { contains: 'not applied' } } });
      check(
        'pulled back, sent again and cancelled with its reason: the request is withdrawn, and a late approval is not applied',
        pulled.status === 200 &&
          pulled.body.status === 'DRAFT' &&
          resent.status === 200 &&
          cancelled.status === 200 &&
          secondRow.status === 'CANCELLED' &&
          secondRow.cancelReason === `${TAG} not needed after all` &&
          (await prisma.approvalRequest.findUnique({ where: { id: resentRequest!.id } }))?.status === 'CANCELLED' &&
          !!lateApproval,
        `${pulled.status}/${pulled.body.status} ${resent.status} ${cancelled.status} ${secondRow.status} ${lateApproval?.summary ?? 'no trail'}`,
      );

      // The warehouse cancels an approved request it will not release.
      const third = await ask(borrowerToken);
      const thirdId = String(third.body.id);
      await api(borrowerToken, 'POST', `/borrow-slips/${thirdId}/submit`);
      const thirdRequest = await prisma.approvalRequest.findFirst({ where: { documentType: 'borrow_slip', documentId: thirdId, status: 'PENDING' } });
      await act({ requestId: thirdRequest!.id, userId: leader.id, action: 'APPROVED' });
      await act({ requestId: thirdRequest!.id, userId: whSup.id, action: 'APPROVED' });
      const notOnShelf = await api(keeperToken, 'POST', `/borrow-slips/${thirdId}/cancel`, { reason: `${TAG} not on the shelf` });
      const cancelBell = await prisma.notification.count({ where: { userId: borrower.id, type: 'borrow.cancelled', link: `/g-chain/borrow-slips/${thirdId}` } });
      check(
        'the warehouse cancels an approved request it will not release, and the requester is told why',
        notOnShelf.status === 200 && (await prisma.borrowSlip.findUniqueOrThrow({ where: { id: thirdId } })).status === 'CANCELLED' && cancelBell === 1,
        `${notOnShelf.status} ${cancelBell}`,
      );
      const outCancel = await api(keeperToken, 'POST', `/borrow-slips/${dueId}/cancel`, { reason: `${TAG} too late` });
      check('a slip already out is not cancelled — its items are taken back instead', outCancel.status === 400, String(outCancel.status));
    }

    // ── Pull-out slips (2026-10-14) ──────────────────────────────────────
    // Stock out against an approved project request (taken from the shelf
    // instead of bought) or an issued sales order (the customer's delivery),
    // approved by the preparer's "Reports to"; nothing moves before.
    console.log('\nPull-out slips (over HTTP)');
    {
      const pullerRole = await makeRole('zzchain_puller', 'ZZ Puller', ['gchain.pullout_slips.view_all', 'gchain.pullout_slips.create', 'gchain.pullout_slips.edit_own']);
      const puller = await mkUser('Verify Puller', 'puller@verifyc.local', pullerRole.id);
      await prisma.user.update({ where: { id: puller.id }, data: { supervisorId: boss.id } });
      const pullerToken = signToken(puller.id, puller.email);
      const procurementToken = signToken(procurement.id, procurement.email);
      const seller = await makeUser('Verify Seller', 'seller@verifyc.local', ['sales']);
      const sellerToken = signToken(seller.id, seller.email);
      await prisma.item.update({ where: { id: item.id }, data: { partNumber: `${TAG}-PN1` } });
      const onShelf = async () => {
        const b = await prisma.inventoryBalance.findUnique({ where: { itemId_warehouseId: { itemId: item.id, warehouseId: warehouse.id } } });
        return num(b?.quantity) - num(b?.borrowedQty);
      };

      // An approved project request for five, its estimate committed.
      const pullPr = await prisma.purchaseRequest.create({
        data: {
          number: await nextNumber('purchase_request'),
          status: 'APPROVED',
          kind: 'DIRECT_TO_JOB',
          jobId: job.id,
          requestedById: engineer.id,
          purpose: `${TAG} pull-out request`,
          items: { create: [{ itemId: item.id, costCategoryId: materials.id, description: `${TAG} Stainless pipe`, quantity: D(5), unit: 'pcs', estimatedCost: D(120), estimatedAmount: D(600) }] },
        },
        include: { items: true },
      });
      const prLine = pullPr.items[0];
      await prisma.jobCostEntry.create({
        data: { jobId: job.id, costCategoryId: materials.id, state: 'COMMITTED', amount: D(600), sourceType: 'purchase_request', sourceId: pullPr.id, sourceNumber: pullPr.number, description: 'Approved' },
      });
      const committed = async () =>
        num(
          (await prisma.jobCostEntry.aggregate({ where: { jobId: job.id, state: 'COMMITTED', sourceType: 'purchase_request', sourceId: pullPr.id }, _sum: { amount: true } }))._sum.amount,
        );

      const prSource = await api(pullerToken, 'GET', `/pullout-slips/source?requestId=${pullPr.id}&warehouseId=${warehouse.id}`);
      const prSourceLine = ((prSource.body.source as { lines: { id: string; left: number; itemId: string | null }[] }) ?? { lines: [] }).lines[0];
      check(
        'a project request offers its lines to pull out, five left, naming its item',
        prSource.status === 200 && prSourceLine?.left === 5 && prSourceLine.itemId === item.id && (prSource.body.source as { jobId: string }).jobId === job.id,
        `${prSource.status} ${JSON.stringify(prSourceLine)}`,
      );
      const pullOut = (quantity: number, itemId = item.id) =>
        api(pullerToken, 'POST', '/pullout-slips', {
          kind: 'PURCHASE_REQUEST',
          requestId: pullPr.id,
          warehouseId: warehouse.id,
          receivedByName: 'Verify Site Foreman',
          lines: [{ sourceLineId: prLine.id, itemId, quantity }],
        });
      const tooMuch = await pullOut(6);
      const wrongItem = await pullOut(1, reorderItem.id);
      check(
        'more than is left on the line is refused, and so is another item than the line names',
        tooMuch.status === 400 && String(tooMuch.body.error ?? '').startsWith('Only 5') && wrongItem.status === 400,
        `${tooMuch.status} ${JSON.stringify(tooMuch.body).slice(0, 90)} ${wrongItem.status}`,
      );
      const shelfBefore = await onShelf();
      const slipRes = await pullOut(3);
      const slipId = String(slipRes.body.id);
      check(
        'a pull-out slip for three is a DRAFT that moves nothing',
        slipRes.status === 201 && slipRes.body.status === 'DRAFT' && slipRes.body.needsApproval === true && money(await onShelf(), shelfBefore),
        `${slipRes.status} ${slipRes.body.status} ${slipRes.body.needsApproval}`,
      );
      const slipSent = await api(pullerToken, 'POST', `/pullout-slips/${slipId}/submit`);
      const overPending = await pullOut(3);
      check(
        'submitted, its three count against the line: another slip for three more is refused',
        slipSent.status === 200 && slipSent.body.status === 'PENDING_APPROVAL' && overPending.status === 400 && money(await onShelf(), shelfBefore),
        `${slipSent.status} ${slipSent.body.status} ${overPending.status}`,
      );
      const prCancelBlocked = await api(procurementToken, 'POST', `/purchase-requests/${pullPr.id}/cancel`, { reason: `${TAG} no longer needed` });
      check(
        'the request is not cancelled while a pull-out slip stands on it',
        prCancelBlocked.status === 400 && String(prCancelBlocked.body.error ?? '').includes('Pull-out slip'),
        `${prCancelBlocked.status} ${JSON.stringify(prCancelBlocked.body).slice(0, 100)}`,
      );

      const commitBefore = await committed();
      const pullRequest = await prisma.approvalRequest.findFirst({ where: { documentType: 'pullout_slip', documentId: slipId, status: 'PENDING' } });
      const pullerSelf = pullRequest ? await act({ requestId: pullRequest.id, userId: puller.id, action: 'APPROVED' }).then(() => 'acted', (e: Error) => e.message) : 'none';
      const bossPull = pullRequest ? await api(bossToken, 'POST', `/approvals/${pullRequest.id}/act`, { action: 'APPROVED' }) : { status: 0, body: {} };
      const pulledRow = await prisma.pulloutSlip.findUniqueOrThrow({ where: { id: slipId }, include: { items: true } });
      const prLineAfter = await prisma.purchaseRequestItem.findUniqueOrThrow({ where: { id: prLine.id } });
      const prAfter = await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: pullPr.id } });
      const ledger = await prisma.jobCostEntry.groupBy({ by: ['state'], where: { sourceType: 'pullout_slip', sourceId: slipId }, _sum: { amount: true } });
      const ledgerOf = (state: string) => num(ledger.find((l) => l.state === state)?._sum.amount);
      const pulledAmount = num(pulledRow.items[0]?.amount);
      check(
        'the preparer cannot approve it; the supervisor’s approval pulls three out — once — at the average cost',
        pullerSelf !== 'acted' &&
          bossPull.status === 200 &&
          pulledRow.status === 'PULLED_OUT' &&
          pulledRow.releasedAt !== null &&
          money(shelfBefore - (await onShelf()), 3) &&
          (await prisma.inventoryTransaction.count({ where: { sourceType: 'pullout_slip', sourceId: slipId } })) === 1 &&
          pulledAmount > 0,
        `self: ${pullerSelf}; ${bossPull.status}; ${pulledRow.status}; ${shelfBefore} → ${await onShelf()}; amount ${pulledAmount}`,
      );
      check(
        'the request line takes three as pulled from stock, the request is partly covered, and its commitment drops by three at its estimate',
        num(prLineAfter.pulledQty) === 3 && prAfter.status === 'PARTIALLY_ORDERED' && money(commitBefore - (await committed()), 360),
        `${num(prLineAfter.pulledQty)} ${prAfter.status}; committed ${commitBefore} → ${await committed()}`,
      );
      check(
        'the project is charged INCURRED and CONSUMED at what it cost — the stock issue’s rule',
        money(ledgerOf('INCURRED'), pulledAmount) && money(ledgerOf('CONSUMED'), pulledAmount),
        JSON.stringify(ledger),
      );
      const poDraft = await api(buyerToken, 'GET', `/purchase-orders/draft?requestId=${pullPr.id}`);
      const poLine = ((poDraft.body.lines ?? []) as { requestItemId: string; quantity: number }[]).find((l) => l.requestItemId === prLine.id);
      check('a purchase order raised from the request now offers only the two left to buy', poDraft.status === 200 && poLine?.quantity === 2, `${poDraft.status} ${JSON.stringify(poLine)}`);
      check(
        'the requester is told it was pulled out',
        (await prisma.notification.count({ where: { userId: engineer.id, type: 'pullout.done', link: `/g-chain/pullout-slips/${slipId}` } })) === 1,
        'no bell',
      );
      const pullPaper = await printed(pullerToken, `/pullout-slips/${slipId}/pdf`);
      check(
        'its paper signs REQUESTED BY, the supervisor, WAREHOUSE RELEASED BY and PULLED OUT / RECEIVED BY — each dated — and prints no cost',
        pullPaper.status === 200 &&
          ['REQUESTED BY', 'SUPERVISOR', 'WAREHOUSE RELEASED BY', 'PULLED OUT / RECEIVED BY'].every((r) => flat(pullPaper.text).includes(r)) &&
          flat(pullPaper.text).includes('Verify Site Foreman') &&
          signedCount(pullPaper.text) === 4 &&
          pendingCount(pullPaper.text) === 0 &&
          !/COST|AMOUNT/.test(pullPaper.text),
        `${pullPaper.status} ${signedCount(pullPaper.text)} signed, ${pendingCount(pullPaper.text)} pending`,
      );
      await settlePullout(slipId, 'APPROVED');
      check(
        'a second settlement of the same approval moves nothing again',
        (await prisma.inventoryTransaction.count({ where: { sourceType: 'pullout_slip', sourceId: slipId } })) === 1 &&
          num((await prisma.purchaseRequestItem.findUniqueOrThrow({ where: { id: prLine.id } })).pulledQty) === 3,
        'moved twice',
      );

      // Pulled back, then cancelled while waiting: the request is withdrawn and a late approval is not applied.
      const second = await pullOut(2);
      const secondId = String(second.body.id);
      await api(pullerToken, 'POST', `/pullout-slips/${secondId}/submit`);
      const secondReq = await prisma.approvalRequest.findFirst({ where: { documentType: 'pullout_slip', documentId: secondId, status: 'PENDING' } });
      const secondCancel = await api(pullerToken, 'POST', `/pullout-slips/${secondId}/cancel`, { reason: `${TAG} bought instead` });
      await settlePullout(secondId, 'APPROVED');
      const secondRow = await prisma.pulloutSlip.findUniqueOrThrow({ where: { id: secondId } });
      check(
        'a pending slip cancelled with its reason withdraws its request, and a late approval moves nothing',
        secondCancel.status === 200 &&
          secondRow.status === 'CANCELLED' &&
          (await prisma.approvalRequest.findUnique({ where: { id: secondReq!.id } }))?.status === 'CANCELLED' &&
          (await prisma.inventoryTransaction.count({ where: { sourceType: 'pullout_slip', sourceId: secondId } })) === 0 &&
          !!(await prisma.auditLog.findFirst({ where: { entityType: 'pullout_slip', entityId: secondId, summary: { contains: 'not applied' } } })),
        `${secondCancel.status} ${secondRow.status}`,
      );

      // A sales order: the customer's delivery. No project was built from
      // its quotation, so the order is the whole reference and no job pays.
      const soQuote = await prisma.quotation.create({
        data: { number: `${TAG}-Q-${Date.now()}`, customerId: customer.id, ownerId: seller.id, subject: `${TAG} delivery quote` },
      });
      const so = await prisma.salesOrder.create({
        data: {
          number: `${TAG}-SO-${Date.now()}`,
          status: 'ISSUED',
          quotationId: soQuote.id,
          customerId: customer.id,
          ownerId: seller.id,
          orderDate: new Date(`${todayKey}T00:00:00Z`),
          lines: { create: [{ title: `${TAG} Stainless pipe`, partNumber: `${TAG}-PN1`, quantity: D(2), unit: 'pcs', unitPrice: D(500), amount: D(1000) }] },
        },
        include: { lines: true },
      });
      const soSource = await api(pullerToken, 'GET', `/pullout-slips/source?salesOrderId=${so.id}`);
      const soLine = ((soSource.body.source as { lines: { id: string; itemId: string | null; left: number }[] }) ?? { lines: [] }).lines[0];
      check(
        'an issued sales order offers its lines, the item matched by part number, and names no project when none was built',
        soSource.status === 200 && soLine?.itemId === item.id && soLine.left === 2 && (soSource.body.source as { jobId: string | null }).jobId === null,
        `${soSource.status} ${JSON.stringify(soLine)}`,
      );
      const soSlip = await api(pullerToken, 'POST', '/pullout-slips', {
        kind: 'SALES_ORDER',
        salesOrderId: so.id,
        warehouseId: warehouse.id,
        receivedByName: 'Customer driver',
        lines: [{ sourceLineId: so.lines[0].id, itemId: item.id, quantity: 2 }],
      });
      const soSlipId = String(soSlip.body.id);
      await api(pullerToken, 'POST', `/pullout-slips/${soSlipId}/submit`);
      const soReq = await prisma.approvalRequest.findFirst({ where: { documentType: 'pullout_slip', documentId: soSlipId, status: 'PENDING' } });
      if (soReq) await api(bossToken, 'POST', `/approvals/${soReq.id}/act`, { action: 'APPROVED' });
      const soRow = await prisma.pulloutSlip.findUniqueOrThrow({ where: { id: soSlipId } });
      const reopenBlocked = await api(sellerToken, 'POST', `/sales-orders/${so.id}/reopen`);
      check(
        'pulled out against the order, no job is charged; the order is not reopened while the slip stands',
        soRow.status === 'PULLED_OUT' &&
          soRow.jobId === null &&
          (await prisma.jobCostEntry.count({ where: { sourceType: 'pullout_slip', sourceId: soSlipId } })) === 0 &&
          reopenBlocked.status === 400 &&
          String(reopenBlocked.body.error ?? '').includes('pull-out slip'),
        `${soRow.status} ${soRow.jobId} ${reopenBlocked.status}`,
      );
      const listed = await api(pullerToken, 'GET', `/pullout-slips?salesOrderId=${so.id}`);
      check(
        'the sales order’s pull-outs list under it',
        listed.status === 200 && ((listed.body.rows ?? []) as { id: string }[]).some((r) => r.id === soSlipId) && listed.body.total === 1,
        `${listed.status} ${listed.body.total}`,
      );
      const stockPr = await prisma.purchaseRequest.create({
        data: { number: await nextNumber('purchase_request'), status: 'APPROVED', kind: 'STOCK_REPLENISHMENT', warehouseId: warehouse.id, requestedById: engineer.id, purpose: `${TAG} stock buy` },
      });
      const stockSource = await api(pullerToken, 'GET', `/pullout-slips/source?requestId=${stockPr.id}`);
      check('a request that buys for warehouse stock is not pulled out against', stockSource.status === 400, String(stockSource.status));

      // No source document (2026-10-15, the owner's call): a supplier
      // return, testing, a repair — the reason kept, no project charged.
      // Who asked for it reads the slip with no warehouse right, and it goes
      // to THEIR supervisor; the paper is the internal release slip.
      const asker = await makeUser('Verify Asker', 'asker@verifyc.local', ['sales']);
      await prisma.user.update({ where: { id: asker.id }, data: { supervisorId: boss.id } });
      const askerToken = signToken(asker.id, asker.email);
      const freeBody = {
        kind: 'OTHER',
        warehouseId: warehouse.id,
        purpose: 'SUPPLIER_RETURN',
        requestedById: asker.id,
        reason: `${TAG} wrong size delivered — back to the supplier`,
        receivedByName: 'Verify Courier',
        courierCompany: 'Express Logistics',
        courierContact: '+63 917 000 0000',
        vehicle: 'NFK-8921 (Canter truck)',
        destination: 'Supplier warehouse, Pasig',
        poReference: `${TAG}-PO-77`,
        returnBy: null,
        notes: 'With the original box',
        lines: [{ itemId: item.id, quantity: 1, serialNo: 'SN-RET-01', condition: 'For return' }],
      };
      const noReason = await api(pullerToken, 'POST', '/pullout-slips', { ...freeBody, reason: '' });
      const projectPurpose = await api(pullerToken, 'POST', '/pullout-slips', { ...freeBody, purpose: 'PROJECT_USE' });
      const answersLine = await api(pullerToken, 'POST', '/pullout-slips', { ...freeBody, lines: [{ ...freeBody.lines[0], sourceLineId: prLine.id }] });
      check(
        'with no source document the reason is required, the purpose is not a sales order or a project’s use, and no line answers a source',
        noReason.status === 400 && projectPurpose.status === 400 && answersLine.status === 400,
        `${noReason.status} ${projectPurpose.status} ${answersLine.status}`,
      );
      const freeShelf = await onShelf();
      const free = await api(pullerToken, 'POST', '/pullout-slips', freeBody);
      const freeId = String(free.body.id);
      const askerReads = await api(askerToken, 'GET', `/pullout-slips/${freeId}`);
      await api(pullerToken, 'POST', `/pullout-slips/${freeId}/submit`);
      const freeReq = await prisma.approvalRequest.findFirst({ where: { documentType: 'pullout_slip', documentId: freeId, status: 'PENDING' } });
      check(
        'a slip with no source document is saved for whoever asked, who reads it with no warehouse right — and it goes for approval in their name',
        free.status === 201 && askerReads.status === 200 && askerReads.body.purposeLabel === 'Supplier return' && freeReq?.requesterId === asker.id,
        `${free.status} ${askerReads.status} ${askerReads.body.purposeLabel} ${freeReq?.requesterId === asker.id}`,
      );
      if (freeReq) await api(bossToken, 'POST', `/approvals/${freeReq.id}/act`, { action: 'APPROVED' });
      const freeRow = await prisma.pulloutSlip.findUniqueOrThrow({ where: { id: freeId }, include: { items: true } });
      check(
        'approved, it goes out — the stock leaves, no project is charged, and who asked is told',
        freeRow.status === 'PULLED_OUT' &&
          freeRow.jobId === null &&
          freeRow.items[0]?.serialNo === 'SN-RET-01' &&
          money(freeShelf - (await onShelf()), 1) &&
          (await prisma.jobCostEntry.count({ where: { sourceType: 'pullout_slip', sourceId: freeId } })) === 0 &&
          (await prisma.notification.count({ where: { userId: asker.id, type: 'pullout.done', link: `/g-chain/pullout-slips/${freeId}` } })) === 1,
        `${freeRow.status} ${freeRow.jobId} ${freeShelf} → ${await onShelf()}`,
      );
      const freePaper = await printed(askerToken, `/pullout-slips/${freeId}/pdf`);
      check(
        'its paper is the internal release slip: references, purpose, courier and destination, serial and condition, the reason, the gate clearance — and who asked signs first',
        freePaper.status === 200 &&
          ['REFERENCES', 'AUTHORIZED PERSON / COURIER', 'DESTINATION', 'SERIAL / BATCH NO.', 'WAREHOUSE GATE CLEARANCE & INSPECTION', 'WHY THERE IS NO SOURCE DOCUMENT'].every((w) =>
            flat(freePaper.text).includes(w),
          ) &&
          ['Supplier return', 'Express Logistics', 'NFK-8921 (Canter truck)', 'Supplier warehouse, Pasig', 'SN-RET-01', 'For return', `${TAG}-PO-77`].every((w) => flat(freePaper.text).includes(w)) &&
          /REQUESTED BY\s+Verify Asker/.test(freePaper.text) &&
          pendingCount(freePaper.text) === 0,
        `${freePaper.status} ${['REFERENCES', 'AUTHORIZED PERSON / COURIER', 'WAREHOUSE GATE CLEARANCE & INSPECTION'].filter((w) => !flat(freePaper.text).includes(w))}`,
      );
      const byKind = await api(pullerToken, 'GET', `/pullout-slips?kind=OTHER&search=${encodeURIComponent('Supplier warehouse, Pasig')}`);
      const byPurpose = await api(pullerToken, 'GET', `/pullout-slips?purpose=SUPPLIER_RETURN&search=${encodeURIComponent('Supplier warehouse, Pasig')}`);
      await prisma.pulloutSlip.update({ where: { id: soSlipId }, data: { purpose: null } });
      const byOldPurpose = await api(pullerToken, 'GET', `/pullout-slips?purpose=SALES_ORDER&salesOrderId=${so.id}`);
      check(
        'the list filters by no source document and by purpose — a slip from before the purposes reads its purpose from its kind',
        byKind.body.total === 1 && byPurpose.body.total === 1 && byOldPurpose.body.total === 1,
        `${byKind.body.total} ${byPurpose.body.total} ${byOldPurpose.body.total}`,
      );
    }

    // ── G-CHAIN reports (2026-10-15) ─────────────────────────────────────
    // One report per menu over a chosen range, each with a CSV and a PDF
    // twin behind the one reports right; a figure the report shows is the
    // menu's own figure (rule: where a report disagrees with a screen, the
    // report is wrong).
    console.log('\nG-CHAIN reports (over HTTP)');
    {
      const KINDS = ['overview', 'purchase-requests', 'rfq', 'canvass', 'purchase-orders', 'incoming', 'inventory', 'outgoing', 'borrow', 'pullout'];
      const range = `from=${todayKey.slice(0, 4)}-01-01&to=${todayKey}`;
      const answers = await Promise.all(
        KINDS.map(async (k) => {
          const j = await api(keeperToken, 'GET', `/chain-reports/${k}?${range}`);
          const c = await printed(keeperToken, `/chain-reports/${k}.csv?${range}`);
          const p = await printed(keeperToken, `/chain-reports/${k}.pdf?${range}`);
          const body = j.body as { kind?: string; cards?: unknown[]; series?: { rows: unknown[] }; tables?: unknown[] };
          return {
            k,
            ok:
              j.status === 200 &&
              body.kind === k &&
              Array.isArray(body.cards) &&
              body.cards.length >= 3 &&
              (body.series?.rows.length ?? 0) === Number(todayKey.slice(5, 7)) &&
              Array.isArray(body.tables) &&
              c.status === 200 &&
              c.type.startsWith('text/csv') &&
              !!c.bytes &&
              p.status === 200 &&
              p.text.length > 100,
            why: `${j.status}/${c.status}/${p.status} months ${body.series?.rows.length}`,
          };
        }),
      );
      check(
        'every report answers for the reports right — the JSON with its cards and a row per month of the year to date, and its CSV and PDF twins',
        answers.every((a) => a.ok),
        answers.filter((a) => !a.ok).map((a) => `${a.k}: ${a.why}`).join('; '),
      );
      const noReportsRole = await makeRole('zzchain_noreports', 'ZZ No reports right', ['gchain.dashboard.view_all']);
      const nobody = await mkUser('Verify Nobody', 'nobody@verifyc.local', noReportsRole.id);
      const nobodyToken = signToken(nobody.id, nobody.email);
      const noRight = await api(nobodyToken, 'GET', `/chain-reports/outgoing?${range}`);
      const noRightPdf = await printed(nobodyToken, `/chain-reports/outgoing.pdf?${range}`);
      const badKind = await api(keeperToken, 'GET', `/chain-reports/nope?${range}`);
      const badRange = await api(keeperToken, 'GET', `/chain-reports/outgoing?from=${todayKey}&to=2020-01-01`);
      check(
        'without the reports right the report and its paper are refused; an unknown report and a range that ends before it starts are 400s',
        noRight.status === 403 && noRightPdf.status === 403 && badKind.status === 400 && badRange.status === 400,
        `${noRight.status} ${noRightPdf.status} ${badKind.status} ${badRange.status}`,
      );
      // The outgoing report reconciles to the slips: its count and value are
      // the ISSUED slips of the range, read off the register's own rows.
      const rep = await api(keeperToken, 'GET', `/chain-reports/outgoing?${range}`);
      const repCards = (rep.body.cards ?? []) as { label: string; value: number }[];
      const repSeries = (rep.body.series as { rows: { values: number[] }[] }).rows;
      const issuedRows = await prisma.stockIssue.findMany({
        where: { status: 'ISSUED', issueDate: { gte: new Date(`${todayKey.slice(0, 4)}-01-01T00:00:00Z`), lte: new Date(`${todayKey}T00:00:00Z`) } },
        include: { items: { select: { amount: true } } },
      });
      const issuedValue = Math.round(issuedRows.reduce((s, r) => s + r.items.reduce((t, i) => t + num(i.amount), 0), 0) * 100) / 100;
      const seriesValue = Math.round(repSeries.reduce((s, r) => s + (r.values[2] ?? 0), 0) * 100) / 100;
      check(
        'the outgoing report counts and values exactly the issued slips of its range, and its months add up to its cards',
        repCards.find((c) => c.label === 'Slips issued')?.value === issuedRows.length &&
          money(repCards.find((c) => c.label === 'Value issued')?.value ?? -1, issuedValue) &&
          repSeries.reduce((s, r) => s + r.values[0], 0) === issuedRows.length &&
          money(seriesValue, issuedValue),
        `report ${repCards.find((c) => c.label === 'Slips issued')?.value} / ${repCards.find((c) => c.label === 'Value issued')?.value}; slips ${issuedRows.length} / ${issuedValue}; series ${seriesValue}`,
      );
      const exported = await prisma.auditLog.count({ where: { entityType: 'chain_report', entityId: 'outgoing', action: 'EXPORTED' } });
      check('each CSV and PDF of a report is on the trail as EXPORTED', exported >= 2, String(exported));
    }

    // ── Inventory as a board (2026-10-14) ────────────────────────────────
    // The Kanban view reads the list's own query: the same rows, every
    // warehouse a column of what it has available, the rest Out of stock.
    console.log('\nInventory as a board (over HTTP)');
    {
      const invRole = await makeRole('zzchain_stockview', 'ZZ Stock viewer', ['gchain.inventory.view_all']);
      const viewer = await mkUser('Verify Stock Viewer', 'stockview@verifyc.local', invRole.id);
      const viewerToken = signToken(viewer.id, viewer.email);
      const outItem = await prisma.item.create({ data: { code: `${TAG}-OUT`, name: `${TAG} Spent gasket`, unit: 'pcs' } });
      await prisma.inventoryBalance.create({ data: { itemId: outItem.id, warehouseId: warehouse.id, quantity: D(0), averageCost: D(10) } });
      const listed = await api(viewerToken, 'GET', `/inventory?search=${TAG}&pageSize=200`);
      const board = await api(viewerToken, 'GET', `/inventory/board?search=${TAG}`);
      type BoardCol = { warehouse: { id: string }; count: number; cards: { id: string; available: number }[] };
      const cols = (board.body.columns ?? []) as BoardCol[];
      const out = (board.body.outOfStock ?? { count: 0, cards: [] }) as { count: number; cards: { id: string; available: number; item: { id: string } }[] };
      const onBoard = cols.reduce((n, c) => n + c.count, 0) + out.count;
      check(
        'the board holds exactly the rows the list holds for the same search — every column counted, Out of stock included',
        board.status === 200 && listed.status === 200 && board.body.total === listed.body.total && onBoard === listed.body.total,
        `${board.body.total} / ${onBoard} vs ${listed.body.total}`,
      );
      check(
        'a warehouse column holds only what is available there; a row with nothing available is Out of stock',
        cols.every((c) => c.cards.every((k) => k.available > 0)) &&
          out.cards.every((k) => k.available <= 0) &&
          out.cards.some((k) => k.item.id === outItem.id) &&
          cols.some((c) => c.warehouse.id === warehouse.id),
        JSON.stringify(out.cards.map((k) => k.available)).slice(0, 120),
      );
    }

    // ── Incoming goes for approval (2026-10-14) ──────────────────────────
    // A receiving report is saved as a draft and posts NOTHING until the
    // receiver's "Reports to" approves it: the stock, the order's received
    // quantities and its status all wait. Quantities waiting for approval
    // count against what the order can still take, so two reports cannot
    // both receive the last ten.
    console.log('\nIncoming on approval (over HTTP)');
    const receiverRole = await makeRole('zzchain_receiver', 'ZZ Receiver', ['gchain.receiving.view_all', 'gchain.receiving.create']);
    const receiver = await mkUser('Verify Receiver', 'receiver@verifyc.local', receiverRole.id);
    await prisma.user.update({ where: { id: receiver.id }, data: { supervisorId: boss.id } });
    // Incoming routes to Back Support, then the Purchasing Manager
    // (2026-10-14): the store supervisor holds both here, so one Approve
    // signs both steps (one signature per person).
    for (const key of ['back_support', 'purchasing_manager']) {
      const r = await prisma.role.findUniqueOrThrow({ where: { key } });
      await prisma.userRole.upsert({ where: { userId_roleId: { userId: boss.id, roleId: r.id } }, create: { userId: boss.id, roleId: r.id }, update: {} });
    }
    const receiverToken = signToken(receiver.id, receiver.email);
    const billerRole = await makeRole('zzchain_biller', 'ZZ Biller', ['gfin.ap.view_all', 'gfin.ap.create', 'gchain.receiving.view_all']);
    const biller = await mkUser('Verify Biller', 'biller@verifyc.local', billerRole.id);
    const billerToken = signToken(biller.id, biller.email);
    const stockOrder = await prisma.purchaseOrder.create({
      data: {
        number: await nextNumber('purchase_order'),
        status: 'ISSUED',
        kind: 'STOCK_REPLENISHMENT',
        supplierId: supplier.id,
        warehouseId: warehouse.id,
        createdById: procurement.id,
        issuedAt: new Date(),
        notes: `${TAG} stock order for Incoming`,
        subtotal: D(1500),
        total: D(1500),
        items: { create: [{ itemId: item.id, description: `${TAG} Stainless pipe`, quantity: D(10), unit: 'pcs', unitPrice: D(150), amount: D(1500) }] },
      },
      include: { items: true },
    });
    const stockLine = stockOrder.items[0];
    const mainBefore = await onHand();
    const firstIn = await api(receiverToken, 'POST', '/receivings', {
      orderId: stockOrder.id,
      deliveryRefNo: 'DR-ZZ-IN-1',
      items: [{ orderItemId: stockLine.id, quantity: 6 }],
    });
    const firstInId = String(firstIn.body.id);
    const orderAfterDraft = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: stockOrder.id }, include: { items: true } });
    check(
      'a receiving saved with the Incoming route active is a DRAFT that moves nothing — no stock, no received quantity, the order still Issued',
      firstIn.status === 201 &&
        firstIn.body.needsApproval === true &&
        firstIn.body.status === 'DRAFT' &&
        money(await onHand(), mainBefore) &&
        num(orderAfterDraft.items[0].receivedQty) === 0 &&
        orderAfterDraft.status === 'ISSUED',
      `${firstIn.status} ${firstIn.body.status} ${firstIn.body.needsApproval}; ${mainBefore} → ${await onHand()}; ${orderAfterDraft.status}`,
    );
    const inRead = await api(receiverToken, 'GET', `/receivings/${firstInId}`);
    check(
      'it offers Submit for approval and names Back Support and the Purchasing Manager as who signs',
      inRead.body.canSubmit === true &&
        inRead.body.needsApproval === true &&
        ((inRead.body.approvalRoute as { steps: { approvers: { name: string }[] }[] } | null)?.steps ?? [])
          .flatMap((s) => s.approvers.map((p) => p.name))
          .includes('Verify Store Supervisor'),
      JSON.stringify({ s: inRead.body.canSubmit, r: inRead.body.approvalRoute }).slice(0, 200),
    );

    // The packing list goes on the report while it is a draft, and prints
    // behind it.
    const packing = await PDFDocument.create();
    packing.addPage([300, 400]);
    const packingForm = new FormData();
    packingForm.append('files', new Blob([Buffer.from(await packing.save())], { type: 'application/pdf' }), `${TAG}-packing-list.pdf`);
    const packingUp = await fetch(`${BASE}/attachments/receiving/${firstInId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${receiverToken}` },
      body: packingForm,
    });
    check('the receiver attaches the packing list to the draft', packingUp.status === 201, String(packingUp.status));

    const inSubmit = await api(receiverToken, 'POST', `/receivings/${firstInId}/submit`);
    const secondIn = await api(receiverToken, 'POST', '/receivings', { orderId: stockOrder.id, items: [{ orderItemId: stockLine.id, quantity: 5 }] });
    const fitsIn = await api(receiverToken, 'POST', '/receivings', { orderId: stockOrder.id, items: [{ orderItemId: stockLine.id, quantity: 4 }] });
    check(
      'submitted, its six count against the order: a second report for five is refused, one for the last four is not',
      inSubmit.status === 200 && inSubmit.body.status === 'PENDING_APPROVAL' && secondIn.status === 400 && fitsIn.status === 201,
      `${inSubmit.status} ${inSubmit.body.status}; ${secondIn.status} ${JSON.stringify(secondIn.body).slice(0, 100)}; ${fitsIn.status}`,
    );
    const fitsInId = String(fitsIn.body.id);

    const draftInPdf = await printed(bossToken, `/receivings/${firstInId}/pdf`);
    // The report, its Attachments page, then the packing list's own page.
    const draftInPages = draftInPdf.bytes ? (await PDFDocument.load(draftInPdf.bytes)).getPageCount() : 0;
    check(
      'the Incoming Report prints who prepared it, dated, Back Support and the Purchasing Manager over Pending, and the packing list behind it',
      draftInPdf.status === 200 &&
        flat(draftInPdf.text).includes('PREPARED BY') &&
        flat(draftInPdf.text).includes('BACK SUPPORT') &&
        flat(draftInPdf.text).includes('PURCHASING MANAGER') &&
        flat(draftInPdf.text).includes('Verify Receiver') &&
        flat(draftInPdf.text).includes('Verify Store Supervisor') &&
        signedCount(draftInPdf.text) === 1 &&
        pendingCount(draftInPdf.text) === 2 &&
        draftInPdf.text.includes(`${TAG}-packing-list.pdf`) &&
        draftInPages === 3,
      `${draftInPdf.status} ${signedCount(draftInPdf.text)} signed, ${pendingCount(draftInPdf.text)} pending, ${draftInPages} page(s); ` +
        `listed ${draftInPdf.text.includes(`${TAG}-packing-list.pdf`)}`,
    );

    const inRequest = await prisma.approvalRequest.findFirst({ where: { documentType: 'receiving', documentId: firstInId, status: 'PENDING' } });
    const receiverSelf = inRequest
      ? await act({ requestId: inRequest.id, userId: receiver.id, action: 'APPROVED' }).then(() => 'acted', (e: Error) => e.message)
      : 'none';
    const inApproved = inRequest ? await api(bossToken, 'POST', `/approvals/${inRequest.id}/act`, { action: 'APPROVED' }) : { status: 0, body: {} };
    const orderAfterApproval = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: stockOrder.id }, include: { items: true } });
    const inRow = await prisma.receiving.findUniqueOrThrow({ where: { id: firstInId } });
    const inMoves = await prisma.inventoryTransaction.count({ where: { sourceType: 'receiving', sourceId: firstInId } });
    check(
      'the receiver cannot approve their own report; one approval by the holder of both steps receives it — six into stock, once, and the order part received',
      receiverSelf !== 'acted' &&
        inApproved.status === 200 &&
        inRow.status === 'RECEIVED' &&
        money((await onHand()) - mainBefore, 6) &&
        inMoves === 1 &&
        num(orderAfterApproval.items[0].receivedQty) === 6 &&
        orderAfterApproval.status === 'PARTIALLY_RECEIVED',
      `self: ${receiverSelf}; ${inApproved.status}; ${inRow.status}; ${mainBefore} → ${await onHand()}; ${inMoves} move(s); ` +
        `${num(orderAfterApproval.items[0].receivedQty)} ${orderAfterApproval.status}`,
    );
    await settleReceiving(firstInId, 'APPROVED');
    check(
      'a second settlement of the same approval receives nothing again',
      (await prisma.inventoryTransaction.count({ where: { sourceType: 'receiving', sourceId: firstInId } })) === 1 && money((await onHand()) - mainBefore, 6),
      String(await onHand()),
    );

    // A line typed without picking an item (2026-10-16, "Can't save"): the
    // item is filed in the master when the report is saved, and a second
    // report typing the same part number takes that item, never a twin.
    {
      const typedPart = `${TAG}-PN-${Date.now()}`;
      const typedBody = {
        sourceName: `${TAG} typed`,
        reason: `${TAG} typed item`,
        warehouseId: warehouse.id,
        items: [{ partNumber: typedPart, description: `${TAG} typed valve`, unit: 'set', quantity: 1, unitCost: 50 }],
      };
      const t1 = await api(receiverToken, 'POST', '/receivings', typedBody);
      const t2 = await api(receiverToken, 'POST', '/receivings', typedBody);
      const made = await prisma.item.findMany({ where: { partNumber: typedPart } });
      const lines = await prisma.receivingItem.findMany({ where: { receivingId: { in: [String(t1.body.id), String(t2.body.id)] } } });
      const blank = await api(receiverToken, 'POST', '/receivings', { ...typedBody, items: [{ quantity: 1, unitCost: 1 }] });
      check(
        'a line typed without picking an item files it once in the item master and the next report takes it',
        t1.status === 201 && t2.status === 201 && made.length === 1 && made[0].unit === 'set' &&
          lines.length === 2 && lines.every((l) => l.itemId === made[0].id) && blank.status === 400,
        `${t1.status}/${t2.status} items ${made.length} lines ${lines.map((l) => l.itemId).join(',')} blank ${blank.status}`,
      );
      await prisma.receiving.deleteMany({ where: { id: { in: [String(t1.body.id), String(t2.body.id)] } } });
      await prisma.auditLog.deleteMany({ where: { entityType: 'item', entityId: { in: made.map((m) => m.id) } } });
      await prisma.item.deleteMany({ where: { id: { in: made.map((m) => m.id) } } });
    }

    // Without a purchase order (2026-10-14): where from, why, a warehouse and
    // an item per line; refused without them; approved, it builds stock at
    // the typed cost and charges no order.
    const noWhy = await api(receiverToken, 'POST', '/receivings', { sourceName: `${TAG} site return`, warehouseId: warehouse.id, items: [{ itemId: item.id, quantity: 2, unitCost: 100 }] });
    const freeNoWarehouse = await api(receiverToken, 'POST', '/receivings', { sourceName: `${TAG} site return`, reason: 'returned', items: [{ itemId: item.id, quantity: 2, unitCost: 100 }] });
    const freeIn = await api(receiverToken, 'POST', '/receivings', {
      sourceName: `${TAG} site return`,
      reason: `${TAG} returned unused from site`,
      warehouseId: warehouse.id,
      items: [{ itemId: item.id, quantity: 2, unitCost: 100 }],
    });
    const freeId = String(freeIn.body.id);
    const freeBefore = await onHand();
    const freeSubmit = await api(receiverToken, 'POST', `/receivings/${freeId}/submit`);
    const freeRequest = await prisma.approvalRequest.findFirst({ where: { documentType: 'receiving', documentId: freeId, status: 'PENDING' } });
    const freeApproved = freeRequest ? await api(bossToken, 'POST', `/approvals/${freeRequest.id}/act`, { action: 'APPROVED' }) : { status: 0, body: {} };
    const freeRow = await prisma.receiving.findUniqueOrThrow({ where: { id: freeId } });
    const freeList = await api(receiverToken, 'GET', `/receivings?against=none&search=${TAG}`);
    check(
      'goods without a purchase order: refused without a reason or a warehouse; approved, two go into stock at the typed cost, and the list says where they came from',
      noWhy.status === 400 &&
        freeNoWarehouse.status === 400 &&
        freeIn.status === 201 &&
        freeSubmit.status === 200 &&
        freeApproved.status === 200 &&
        freeRow.status === 'RECEIVED' &&
        freeRow.orderId === null &&
        money((await onHand()) - freeBefore, 2) &&
        ((freeList.body.rows ?? []) as { id: string; from: string; order: unknown }[]).some((r) => r.id === freeId && r.from === `${TAG} site return` && r.order === null),
      `${noWhy.status} ${freeNoWarehouse.status} ${freeIn.status} ${freeSubmit.status} ${freeApproved.status} ${freeRow.status}; ${freeBefore} → ${await onHand()}`,
    );

    // The last four: pulled back, sent again, then cancelled while waiting —
    // its request withdrawn, nothing moved, and a decision that lands after
    // the cancel changes nothing.
    const fitsSubmit = await api(receiverToken, 'POST', `/receivings/${fitsInId}/submit`);
    const fitsBack = await api(receiverToken, 'POST', `/receivings/${fitsInId}/withdraw`);
    const fitsAgain = await api(receiverToken, 'POST', `/receivings/${fitsInId}/submit`);
    const fitsRequest = await prisma.approvalRequest.findFirst({ where: { documentType: 'receiving', documentId: fitsInId, status: 'PENDING' } });
    const fitsCancel = await api(receiverToken, 'POST', `/receivings/${fitsInId}/cancel`, { reason: `${TAG} wrong delivery` });
    const fitsRequestAfter = fitsRequest ? await prisma.approvalRequest.findUnique({ where: { id: fitsRequest.id } }) : null;
    await settleReceiving(fitsInId, 'APPROVED');
    const fitsRow = await prisma.receiving.findUniqueOrThrow({ where: { id: fitsInId } });
    const fitsTrail = await prisma.auditLog.findFirst({ where: { entityType: 'receiving', entityId: fitsInId, summary: { contains: 'not applied' } } });
    check(
      'a pending report is pulled back and sent again, then cancelled with its reason: the request is withdrawn, nothing is received, and a late approval is not applied',
      fitsSubmit.status === 200 &&
        fitsBack.status === 200 &&
        fitsBack.body.status === 'DRAFT' &&
        fitsAgain.status === 200 &&
        fitsCancel.status === 200 &&
        fitsRequestAfter?.status === 'CANCELLED' &&
        fitsRow.status === 'CANCELLED' &&
        fitsRow.cancelReason === `${TAG} wrong delivery` &&
        money((await onHand()) - mainBefore, 8) &&
        !!fitsTrail,
      `${fitsSubmit.status} ${fitsBack.status}/${fitsBack.body.status} ${fitsAgain.status} ${fitsCancel.status}; req ${fitsRequestAfter?.status}; ${fitsRow.status}; ${fitsTrail?.summary ?? 'no trail'}`,
    );
    const afterCancelIn = await api(receiverToken, 'POST', '/receivings', { orderId: stockOrder.id, items: [{ orderItemId: stockLine.id, quantity: 4 }] });
    check('a cancelled report gives its quantity back: the last four may be received again', afterCancelIn.status === 201, String(afterCancelIn.status));
    const receivedCancel = await api(receiverToken, 'POST', `/receivings/${firstInId}/cancel`, { reason: `${TAG} too late` });
    check('a received report is not cancelled — the goods are in', receivedCancel.status === 400, String(receivedCancel.status));

    // A supplier's bill is matched to goods RECEIVED, never to a report
    // still waiting for its approval — that one posted nothing.
    const billOn = (receivingId: string) =>
      api(billerToken, 'POST', '/supplier-bills', {
        supplierId: supplier.id,
        orderId: stockOrder.id,
        receivingId,
        supplierInvoiceNo: `${TAG}-INV`,
        notes: `${TAG} bill on a draft`,
        lines: [{ description: `${TAG} Stainless pipe`, quantity: 4, unitPrice: 150 }],
      });
    const billOnDraft = await billOn(String(afterCancelIn.body.id));
    check(
      'a bill naming a receiving still in draft is refused, and says why',
      billOnDraft.status === 400 && String(billOnDraft.body.error ?? '').includes('a bill is matched to goods received'),
      `${billOnDraft.status} ${JSON.stringify(billOnDraft.body).slice(0, 140)}`,
    );

    // ── Closed and late documents, for the printed lists ──────────────────
    // A purchase order and a stock issue that were cancelled, so the papers'
    // brackets and their notes have a figure to print, and a slip lent five
    // days ago, due back two days ago and still out, so the Overdue paper has
    // a row to hold. No route cancels an order or an issue (a draft is
    // deleted instead), so CANCELLED is written here — on a draft that
    // committed and moved nothing, the state a cancelled one is in.
    console.log('\nClosed and late documents for the printed lists');
    // A canvass still out for quotes beside the two awarded above, so a status
    // filter on the canvass list has one to keep and one to drop.
    await prisma.canvass.create({
      data: { number: await nextNumber('canvass'), requestId: pr.id, createdById: procurement.id, notes: `${TAG} still out for quotes` },
    });
    const cancelledPo = await api(buyerToken, 'POST', '/purchase-orders', { supplierId: supplier.id, notes: `${TAG} cancelled order` });
    const cancelledPoId = String(cancelledPo.body.id);
    const cancelledPoLine = await api(buyerToken, 'POST', `/purchase-orders/${cancelledPoId}/items`, {
      description: `${TAG} cancelled valve`,
      costCategoryId: materials.id,
      quantity: 3,
      unit: 'pcs',
      unitPrice: 250,
    });
    await prisma.purchaseOrder.update({ where: { id: cancelledPoId }, data: { status: 'CANCELLED' } });
    const cancelledIssue = await api(keeperToken, 'POST', '/stock-issues', { warehouseId: warehouse.id, purpose: `${TAG} cancelled issue` });
    const cancelledIssueId = String(cancelledIssue.body.id);
    const cancelledIssueLine = await api(keeperToken, 'POST', `/stock-issues/${cancelledIssueId}/items`, { itemId: item.id, quantity: 1 });
    await prisma.stockIssue.update({ where: { id: cancelledIssueId }, data: { status: 'CANCELLED' } });
    const longOut = await lend(todayKey, 'out five days, due back two days ago');
    const longOutId = String(longOut.body.id);
    const dayAgo = (n: number) => new Date(`${manilaDayKey(new Date(Date.now() - n * 86_400_000))}T00:00:00Z`);
    await prisma.borrowSlip.update({ where: { id: longOutId }, data: { borrowedAt: dayAgo(5), dueAt: dayAgo(2) } });
    const [cancelledPoRow, cancelledIssueRow] = await Promise.all([
      prisma.purchaseOrder.findUniqueOrThrow({ where: { id: cancelledPoId } }),
      prisma.stockIssue.findUniqueOrThrow({ where: { id: cancelledIssueId }, include: { items: true } }),
    ]);
    check(
      'the fixtures stand: a cancelled order and a cancelled issue, each with a figure, and a slip still out two days late',
      cancelledPo.status === 201 &&
        cancelledPoLine.status < 300 &&
        num(cancelledPoRow.total) > 0 &&
        cancelledIssue.status === 201 &&
        cancelledIssueLine.status < 300 &&
        cancelledIssueRow.items.reduce((t, i) => t + num(i.amount), 0) > 0 &&
        longOut.status === 201,
      `${cancelledPo.status}/${cancelledPoLine.status} total ${num(cancelledPoRow.total)}; ${cancelledIssue.status}/${cancelledIssueLine.status} ` +
        `${cancelledIssueRow.items.length} line(s); slip ${longOut.status}`,
    );

    // ── Every G-CHAIN list prints (A5) ────────────────────────────────────
    // Each register's printed twin reads the list's own where-builder: the
    // paper holds exactly the rows the list holds for the same query, names
    // every filter that narrowed it, prints only the rows ticked with ?ids=,
    // turns landscape past seven columns, and is audited as an export of the
    // 'list'. Its total is the column's sum, cancelled figures left out.
    console.log('\nEvery G-CHAIN list prints');
    const printerRole = await makeRole('zzchain_printer', 'ZZ Printer', [
      'gchain.purchase_requests.view_all',
      'gchain.canvass.view_all',
      'gchain.purchase_orders.view_all',
      'gchain.receiving.view_all',
      'gchain.stock_issuance.view_all',
      'gchain.borrow_slips.view_all',
      'gchain.inventory.view_all',
      'gchain.items.view_all',
      'gchain.reports.view_all',
    ]);
    const printer = await mkUser('Verify Printer', 'printer@verifyc.local', printerRole.id);
    const printerToken = signToken(printer.id, printer.email);

    // Two items under their reorder level and one over it, so "Below level"
    // has something to leave out — and two to count across a page of one.
    const reorderItems = await Promise.all(
      ([
        ['GSK', 'Reorder gasket', 10, 3, 'MATERIAL'],
        ['BLT', 'Reorder bolt', 5, 2, 'MATERIAL'],
        // A consumable, so the item list's Type filter has one to leave out.
        ['WSH', 'Plenty washer', 1, 50, 'CONSUMABLE'],
      ] as const).map(([code, name, level, onHand, itemType]) =>
        prisma.item.create({
          data: { code: `${TAG}-${code}`, name: `${TAG} ${name}`, unit: 'pcs', itemType, reorderLevel: D(level), costCategoryId: materials.id },
        }).then(async (it) => {
          await prisma.$transaction((tx) =>
            receiveStock(tx, { itemId: it.id, warehouseId: warehouse.id, quantity: onHand, unitCost: 50, sourceType: 'test' }),
          );
          return it;
        }),
      ),
    );

    /** The money a totals row prints, read off the paper: "<label> PHP 1,234.00". */
    const totalOn = (text: string, label: string) => {
      const m = text.match(new RegExp(`${label} ${currency} (-?[\\d,]+\\.\\d{2})`));
      return m ? Number(m[1].replace(/,/g, '')) : NaN;
    };
    const exported = (entityType: string) =>
      prisma.auditLog.count({ where: { entityType, entityId: 'list', action: 'EXPORTED', actorId: printer.id } });
    type Row = Record<string, unknown>;
    const lists: {
      path: string;
      entity: string;
      noun: readonly [string, string];
      page: string;
      /** What the paper prints for a row — its number, or what stands for it. */
      key: (row: Row) => string;
      /** A filter, and the words the paper must name it by — one that keeps some of the rows and drops others. */
      filter: [string, string] | ((rows: Row[]) => [string, string]);
      /** What on the paper shows a dropped row is absent, where `key` is shared with a kept one (a stock line's item). */
      dropKey?: (row: Row) => string;
      /** The totals row the paper must add up, from the list's own rows. */
      total?: { label: string; of: (rows: Row[]) => number };
      /** Rows listed but not summed: each figure in brackets, and the note that counts them. */
      closed?: { is: (row: Row) => boolean; figure: (row: Row) => number; note: (n: number) => string };
      /** Rows summed though nothing has moved on them yet, and the note that says how many. */
      unsettled?: { is: (row: Row) => boolean; note: (n: number) => string };
    }[] = [
      {
        path: 'purchase-requests',
        entity: 'purchase_request',
        noun: ['purchase request', 'purchase requests'],
        page: LANDSCAPE,
        key: (r) => String(r.number),
        filter: ['status=DRAFT', 'status Draft'],
        total: {
          label: 'Estimated total',
          of: (rows) => rows.filter((r) => !['CANCELLED', 'REJECTED'].includes(String(r.status))).reduce((t, r) => t + Number(r.estimatedTotal), 0),
        },
        closed: {
          is: (r) => ['CANCELLED', 'REJECTED'].includes(String(r.status)),
          figure: (r) => Number(r.estimatedTotal),
          note: (n) => `${n} cancelled or rejected request${n === 1 ? ', in brackets, is' : 's, in brackets, are'} not counted.`,
        },
      },
      {
        path: 'canvasses',
        entity: 'canvass',
        noun: ['canvass', 'canvasses'],
        page: LANDSCAPE,
        key: (r) => String(r.number),
        // Neither canvass here is still open: filter on a status one has and the other has not.
        filter: (rows) => {
          const status = splittingValue(rows, 'status');
          return [`status=${status}`, `status ${statusLabel(status)}`];
        },
      },
      {
        path: 'purchase-orders',
        entity: 'purchase_order',
        noun: ['purchase order', 'purchase orders'],
        page: LANDSCAPE,
        key: (r) => String(r.number),
        filter: ['awaiting=true', 'awaiting delivery'],
        total: { label: 'Total', of: (rows) => rows.filter((r) => r.status !== 'CANCELLED').reduce((t, r) => t + Number(r.total), 0) },
        closed: {
          is: (r) => r.status === 'CANCELLED',
          figure: (r) => Number(r.total),
          note: (n) => `${n} cancelled order${n === 1 ? ', in brackets, is' : 's, in brackets, are'} not counted.`,
        },
        // Summed, as G-FIN sums a draft invoice — and said.
        unsettled: {
          is: (r) => ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(String(r.status)),
          note: (n) =>
            `The total includes ${n} order${n === 1 ? '' : 's'} not issued yet — nothing is committed on ${n === 1 ? 'it until it is' : 'them until they are'}.`,
        },
      },
      {
        path: 'receivings',
        entity: 'receiving',
        noun: ['incoming report', 'incoming reports'],
        page: LANDSCAPE,
        key: (r) => String(r.number),
        filter: [`orderId=${po.id}`, `order ${po.number}`],
        // Only goods RECEIVED count: a draft, pending or cancelled report
        // posted nothing, so its figure prints in brackets (2026-10-14).
        total: { label: 'Total received', of: (rows) => rows.filter((r) => r.status === 'RECEIVED').reduce((t, r) => t + Number(r.value), 0) },
        closed: {
          is: (r) => r.status !== 'RECEIVED',
          figure: (r) => Number(r.value),
          note: (n) =>
            `${n} ${n === 1 ? 'report not received yet (a draft, pending or cancelled), in brackets, is' : 'reports not received yet (drafts, pending or cancelled), in brackets, are'} not counted.`,
        },
      },
      {
        path: 'stock-issues',
        entity: 'stock_issue',
        noun: ['outgoing slip', 'outgoing slips'],
        page: LANDSCAPE,
        key: (r) => String(r.number),
        filter: ['status=ISSUED', 'status Issued'],
        total: { label: 'Total', of: (rows) => rows.filter((r) => r.status !== 'CANCELLED').reduce((t, r) => t + Number(r.value), 0) },
        closed: {
          is: (r) => r.status === 'CANCELLED',
          figure: (r) => Number(r.value),
          note: (n) => `${n} cancelled issue${n === 1 ? ', in brackets, is' : 's, in brackets, are'} not counted.`,
        },
        unsettled: {
          is: (r) => r.status === 'DRAFT' || r.status === 'PENDING_APPROVAL',
          note: (n) =>
            `The total includes ${n} draft or pending issue${n === 1 ? '' : 's'}, not issued yet — nothing leaves the warehouse on ${n === 1 ? 'it until it is' : 'them until they are'}.`,
        },
      },
      { path: 'borrow-slips', entity: 'borrow_slip', noun: ['borrow slip', 'borrow slips'], page: LANDSCAPE, key: (r) => String(r.number), filter: ['overdue=true', '· overdue'] },
      {
        path: 'inventory',
        entity: 'inventory',
        noun: ['stock line', 'stock lines'],
        page: LANDSCAPE,
        key: (r) => String((r.item as { code: string }).code),
        filter: [`warehouseId=${warehouse.id}`, `warehouse ${warehouse.name}`],
        // The item stocked in the site store is stocked in the main store too: its line elsewhere is told by the warehouse.
        dropKey: (r) => String((r.warehouse as { name: string }).name),
        // Valued as stockOnHand() values stock: the sum, rounded once.
        total: { label: 'Stock value', of: (rows) => rows.reduce((t, r) => t + Number(r.quantity) * Number(r.averageCost), 0) },
      },
      { path: 'items', entity: 'item', noun: ['item', 'items'], page: LANDSCAPE, key: (r) => String(r.code), filter: ['itemType=MATERIAL', 'type Material'] },
    ];

    for (const l of lists) {
      const listed = await api(printerToken, 'GET', `/${l.path}?search=${TAG}&pageSize=200`);
      const rows = (listed.body.rows ?? []) as Row[];
      const before = await exported(l.entity);
      const paper = await printed(printerToken, `/${l.path}/pdf?search=${TAG}`);
      const text = flat(paper.text);
      const after = await exported(l.entity);
      const boxes = paper.pages;
      check(
        `${l.path}: its paper is a PDF of exactly the rows the list holds, the search named, on ${l.page === LANDSCAPE ? 'landscape' : 'portrait'} pages, audited as an export of the list`,
        paper.status === 200 &&
          paper.type.startsWith('application/pdf') &&
          rows.length > 1 &&
          rows.length === Number(listed.body.total) &&
          rows.every((r) => text.includes(l.key(r))) &&
          saysCount(text, rows.length, l.noun) &&
          text.includes(`search "${TAG}"`) &&
          boxes.length > 0 &&
          boxes.every((b) => b === l.page) &&
          after === before + 1,
        `${paper.status} ${paper.type}, ${rows.length} of ${listed.body.total} listed, missing ${rows.filter((r) => !text.includes(l.key(r))).map(l.key).join(',') || 'none'}, ` +
          `count ${saysCount(text, rows.length, l.noun)}, pages ${boxes.join(',')}, audited ${before} → ${after}`,
      );
      if (l.total) {
        const expected = Math.round(l.total.of(rows) * 100) / 100;
        const printedTotal = totalOn(text, l.total.label);
        check(`${l.path}: its "${l.total.label}" adds up the rows it lists — a cancelled one's figure left out`, money(printedTotal, expected), `${printedTotal} vs ${expected}`);
      }
      if (l.closed && l.total) {
        const closed = l.closed;
        const closedRows = rows.filter(closed.is);
        const everything = Math.round(rows.reduce((t, r) => t + closed.figure(r), 0) * 100) / 100;
        const printedTotal = totalOn(text, l.total.label);
        const amount = (v: number) => v.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const inBrackets = text.match(/\(\d[\d,]*\.\d{2}\)/g) ?? [];
        check(
          `${l.path}: each closed row's figure prints in brackets, and only theirs; the note counts them ("${closed.note(closedRows.length)}"); the total is not the sum with them in`,
          closedRows.length > 0 &&
            closedRows.some((r) => closed.figure(r) > 0) &&
            closedRows.every((r) => text.includes(`(${amount(closed.figure(r))})`)) &&
            inBrackets.length === closedRows.length &&
            text.includes(closed.note(closedRows.length)) &&
            !money(printedTotal, everything),
          `${closedRows.length} closed (${closedRows.map((r) => amount(closed.figure(r))).join(', ')}); on paper ${inBrackets.join(' ') || 'none'}; ` +
            `note ${text.includes(closed.note(closedRows.length))}; total ${printedTotal} vs all ${everything}`,
        );
      }
      if (l.unsettled) {
        const n = rows.filter(l.unsettled.is).length;
        const onPaper = l.unsettled.note(n);
        check(
          `${l.path}: the note says how many the total includes that nothing has moved on yet ("${onPaper}")`,
          n > 0 && text.includes(onPaper),
          `${n} such row(s); ${text.match(/The total includes[^.]*\./)?.[0] ?? 'no note'}`,
        );
      }

      const [first] = rows;
      const ticked = await printed(printerToken, `/${l.path}/pdf?ids=${first ? String(first.id) : 'none'}`);
      const tickedText = flat(ticked.text);
      check(
        `${l.path}: ?ids= prints only the row ticked, and says so`,
        ticked.status === 200 &&
          !!first &&
          tickedText.includes(l.key(first)) &&
          rows.length > 1 &&
          // A stock line shares its item's code with the item's line elsewhere: those are not "another row" on paper.
          rows.slice(1).filter((r) => l.key(r) !== l.key(first)).every((r) => !tickedText.includes(l.key(r))) &&
          saysCount(tickedText, 1, l.noun) &&
          tickedText.includes('the rows selected'),
        `${ticked.status} ${tickedText.match(/Reference: [^—]*—[^·]*/)?.[0] ?? tickedText.slice(0, 120)} · ${rows.slice(1).filter((r) => l.key(r) !== l.key(first) && tickedText.includes(l.key(r))).length} other row(s) printed`,
      );

      const [filterQuery, filterWords] = typeof l.filter === 'function' ? l.filter(rows) : l.filter;
      const dropKey = l.dropKey ?? l.key;
      const narrowed = await api(printerToken, 'GET', `/${l.path}?search=${TAG}&${filterQuery}&pageSize=200`);
      const filtered = await printed(printerToken, `/${l.path}/pdf?search=${TAG}&${filterQuery}`);
      const filteredText = flat(filtered.text);
      // Narrows: it keeps some rows and drops others — on the paper as on
      // the screen, so a filter the paper ignored prints a row it dropped.
      const kept = (narrowed.body.rows ?? []) as Row[];
      const dropped = rows.filter((r) => !kept.some((k) => k.id === r.id));
      check(
        `${l.path}: a filter narrows the paper as it narrows the list, and the paper names it ("${filterWords}")`,
        filtered.status === 200 &&
          kept.length > 0 &&
          dropped.length > 0 &&
          Number(narrowed.body.total) === kept.length &&
          saysCount(filteredText, kept.length, l.noun) &&
          filteredText.includes(filterWords) &&
          kept.every((r) => filteredText.includes(l.key(r))) &&
          dropped.every((r) => !filteredText.includes(dropKey(r))),
        `${filtered.status}: list ${narrowed.body.total} of ${rows.length}, ${dropped.length} dropped, ${dropped.filter((r) => filteredText.includes(dropKey(r))).length} of them printed; ${filteredText.match(/Reference: [^]*?(?= NUMBER| ITEM| CODE)/)?.[0] ?? filteredText.slice(0, 160)}`,
      );
    }

    // The Overdue paper holds exactly the slips the Overdue list holds — one at
    // least, the slip two days late — and prints how late each is where the
    // list shows its badge; a slip that is not late is not on it.
    const slipsListed = (((await api(printerToken, 'GET', `/borrow-slips?search=${TAG}&pageSize=200`)).body.rows ?? []) as Row[]);
    const overdueListed = (((await api(printerToken, 'GET', `/borrow-slips?search=${TAG}&overdue=true&pageSize=200`)).body.rows ?? []) as Row[]);
    const overduePaper = await printed(printerToken, `/borrow-slips/pdf?search=${TAG}&overdue=true`);
    const overdueText = flat(overduePaper.text);
    const lateWords = (r: Row) => `Overdue, ${Number(r.daysOverdue)} day${Number(r.daysOverdue) === 1 ? '' : 's'}`;
    check(
      'the Overdue paper holds exactly the overdue slips the list holds, and prints "Overdue, 2 days" for the slip two days late',
      overduePaper.status === 200 &&
        overdueListed.length > 0 &&
        overdueListed.some((r) => r.id === longOutId && Number(r.daysOverdue) === 2) &&
        overdueListed.every((r) => overdueText.includes(String(r.number)) && overdueText.includes(lateWords(r))) &&
        overdueText.includes('Overdue, 2 days') &&
        saysCount(overdueText, overdueListed.length, ['borrow slip', 'borrow slips']) &&
        slipsListed.filter((r) => !overdueListed.some((o) => o.id === r.id)).every((r) => !overdueText.includes(String(r.number))),
      `${overduePaper.status}: ${overdueListed.length} overdue of ${slipsListed.length}; ` +
        `${overdueListed.map((r) => `${String(r.number)} ${Number(r.daysOverdue)}d`).join(', ')}; ${overdueText.match(/Overdue, \d+ days?/g)?.join(' | ') ?? 'no Overdue cell'}`,
    );

    // A list longer than the cap prints its first 1,000 and says so.
    await prisma.item.createMany({
      data: Array.from({ length: 1001 }, (_, n) => ({
        code: `${TAG}-CAP-${String(n + 1).padStart(4, '0')}`,
        name: `${TAG} CAP item ${n + 1}`,
        unit: 'pcs',
      })),
    });
    const capped = await printed(printerToken, `/items/pdf?search=${encodeURIComponent(`${TAG} CAP`)}&sort=code&dir=asc`);
    const cappedText = flat(capped.text);
    check(
      'a list longer than the cap prints its first 1,000 rows and says "first 1,000 of 1,001 items printed"',
      capped.status === 200 &&
        cappedText.includes('Reference: first 1,000 of 1,001 items printed') &&
        cappedText.includes(`${TAG}-CAP-1000`) &&
        !cappedText.includes(`${TAG}-CAP-1001`),
      `${capped.status} ${cappedText.match(/Reference: [^"]*/)?.[0] ?? cappedText.slice(0, 120)}`,
    );

    // A status that is not one is a 400 naming the choices — on the list and
    // on its paper alike — never a 500 from the database.
    const badPaths = [
      ...['purchase-requests', 'canvasses', 'purchase-orders', 'stock-issues', 'borrow-slips'].flatMap((list) => [list, `${list}/pdf`]),
      'items?itemType=GADGET&x=',
      'items/pdf?itemType=GADGET&x=',
    ];
    const badStatus = await Promise.all(badPaths.map((path) => api(printerToken, 'GET', `/${path}${path.includes('?') ? '' : '?status=MAYBE'}`)));
    check(
      'a status that is not one is a 400 on every list and its paper',
      badStatus.every((r) => r.status === 400),
      badPaths.map((path, n) => `${path} ${badStatus[n].status}`).join(', '),
    );

    // A view_own holder prints their own requests and nobody else's, as the
    // list shows them — the visibility rule is ANDed with ?ids= too.
    const othersRequest = await prisma.purchaseRequest.findFirstOrThrow({
      where: { purpose: { startsWith: TAG }, requestedById: { not: requester.id } },
      select: { id: true, number: true },
    });
    const ownListed = await api(requesterToken, 'GET', `/purchase-requests?search=${TAG}&pageSize=200`);
    const ownRows = (ownListed.body.rows ?? []) as Row[];
    const ownPaper = await printed(requesterToken, `/purchase-requests/pdf?search=${TAG}`);
    const ownText = flat(ownPaper.text);
    const ownTicked = await printed(requesterToken, `/purchase-requests/pdf?ids=${othersRequest.id}`);
    const ownTickedText = flat(ownTicked.text);
    check(
      'a requester who sees only their own prints only their own — "raised by me" — and ticking another\'s id prints nothing of it',
      ownPaper.status === 200 &&
        ownRows.length > 0 &&
        ownRows.every((r) => (r.requestedBy as { id: string }).id === requester.id && ownText.includes(String(r.number))) &&
        saysCount(ownText, ownRows.length, ['purchase request', 'purchase requests']) &&
        ownText.includes('raised by me') &&
        !ownText.includes(othersRequest.number) &&
        ownTicked.status === 200 &&
        saysCount(ownTickedText, 0, ['purchase request', 'purchase requests']) &&
        !ownTickedText.includes(othersRequest.number),
      `${ownPaper.status} ${ownRows.length} own; other's on paper ${ownText.includes(othersRequest.number)}, ticked ${ownTickedText.includes(othersRequest.number)}`,
    );

    // "Below level" compares two columns, so the list used to filter one page
    // after the database cut it: a page of one reported a total of one, or
    // none. It is now a where-clause like any other — the list pages it, the
    // paper prints it, and the reports tile counts the same set.
    const tagBalances = await prisma.inventoryBalance.findMany({
      where: { item: { name: { startsWith: TAG } } },
      select: { quantity: true, borrowedQty: true, item: { select: { reorderLevel: true } } },
    });
    const belowCount = tagBalances.filter(
      (b) => b.item.reorderLevel !== null && Math.round((num(b.quantity) - num(b.borrowedQty)) * 100) / 100 <= num(b.item.reorderLevel),
    ).length;
    const reorderPage = await api(printerToken, 'GET', `/inventory?search=${TAG}&needsReorder=true&pageSize=1`);
    const reorderPaper = await printed(printerToken, `/inventory/pdf?search=${TAG}&needsReorder=true`);
    const reorderText = flat(reorderPaper.text);
    const report = await api(printerToken, 'GET', '/inventory/reports/summary');
    const reportCount = ((report.body.reorder ?? []) as { code: string }[]).filter((r) => r.code.startsWith(TAG)).length;
    check(
      'the Reorder filter counts every line below its level across pages, its paper prints each one\'s state, and the reports tile counts the same set',
      belowCount >= 2 &&
        reorderItems.length === 3 &&
        Number(reorderPage.body.total) === belowCount &&
        ((reorderPage.body.rows ?? []) as Row[]).length === 1 &&
        reorderPaper.status === 200 &&
        saysCount(reorderText, belowCount, ['stock line', 'stock lines']) &&
        reorderText.includes('below reorder level') &&
        // Each prints its state (2026-10-15): low, critical or on order — never "In stock".
        (reorderText.match(/Low stock|Critical|On order/g) ?? []).length === belowCount &&
        !reorderText.includes('In stock') &&
        !reorderText.includes(`${TAG}-WSH`) &&
        reportCount === belowCount,
      `expected ${belowCount}; page total ${reorderPage.body.total} (${((reorderPage.body.rows ?? []) as Row[]).length} row), paper ${(reorderText.match(/Below level/g) ?? []).length}, report ${reportCount}`,
    );

    // The stock states (2026-10-15): the gasket at its minimum is Critical,
    // the bolt under its level is Low stock, the washer In stock; the cards
    // count what the Status filter lists.
    const [gsk, blt, wsh] = reorderItems;
    await prisma.item.update({ where: { id: gsk.id }, data: { minStock: D(3) } });
    const stateOf = async (state: string) => {
      const r = await api(printerToken, 'GET', `/inventory?search=${TAG}&state=${state}&pageSize=100`);
      return { total: Number(r.body.total), codes: ((r.body.rows ?? []) as { item: { code: string } }[]).map((x) => x.item.code), summary: r.body.summary as Record<string, number> };
    };
    const critical = await stateOf('CRITICAL');
    const low = await stateOf('LOW_STOCK');
    const fine = await stateOf('IN_STOCK');
    const allTag = await api(printerToken, 'GET', `/inventory?search=${TAG}&pageSize=100`);
    const tagSummary = allTag.body.summary as { critical: number; lowStock: number };
    const badState = await api(printerToken, 'GET', `/inventory?state=SOMETIMES`);
    check(
      'a line at its minimum is Critical, one under its reorder level Low stock, one over it In stock; the cards count what the Status filter lists, and an unknown state is a 400',
      critical.codes.includes(gsk.code) &&
        low.codes.includes(blt.code) &&
        fine.codes.includes(wsh.code) &&
        !low.codes.includes(gsk.code) &&
        tagSummary.critical === critical.total &&
        tagSummary.lowStock === low.total &&
        badState.status === 400,
      `critical ${critical.codes.join(',')}; low ${low.codes.join(',')}; in ${fine.codes.join(',')}; cards ${tagSummary.critical}/${tagSummary.lowStock}; ${badState.status}`,
    );

    // The automatic reorder (2026-10-15): an item under its level is added
    // to its warehouse's one DRAFT replenishment, quantity up to twice the
    // level; a second check adds nothing; a covered item is left alone; the
    // system never submits it.
    const supervisorRole = await prisma.role.findUniqueOrThrow({ where: { key: 'warehouse_supervisor' } });
    await prisma.userRole.upsert({ where: { userId_roleId: { userId: boss.id, roleId: supervisorRole.id } }, create: { userId: boss.id, roleId: supervisorRole.id }, update: {} });
    const firstAdd = await runReorderCheck([{ itemId: blt.id, warehouseId: warehouse.id }, { itemId: wsh.id, warehouseId: warehouse.id }]);
    const secondAdd = await runReorderCheck([{ itemId: blt.id, warehouseId: warehouse.id }]);
    const gskAdd = await runReorderCheck([{ itemId: gsk.id, warehouseId: warehouse.id }]);
    const autoPrs = await prisma.purchaseRequest.findMany({
      where: { warehouseId: warehouse.id, autoReorder: true },
      include: { items: { select: { itemId: true, quantity: true } } },
    });
    const bltLine = autoPrs.flatMap((pr) => pr.items).find((i) => i.itemId === blt.id);
    const bltBalance = await prisma.inventoryBalance.findUniqueOrThrow({ where: { itemId_warehouseId: { itemId: blt.id, warehouseId: warehouse.id } } });
    const expectedQty = Math.ceil(2 * 5 - (num(bltBalance.quantity) - num(bltBalance.borrowedQty)));
    check(
      'the automatic reorder adds a fallen item to its warehouse\'s one draft replenishment (twice the level less what is there), never twice, never an item over its level, and never submits it',
      firstAdd.length === 1 &&
        firstAdd[0].itemId === blt.id &&
        secondAdd.length === 0 &&
        gskAdd.length === 1 &&
        autoPrs.length === 1 &&
        autoPrs[0].status === 'DRAFT' &&
        autoPrs[0].kind === 'STOCK_REPLENISHMENT' &&
        autoPrs[0].items.length === 2 &&
        !!bltLine &&
        num(bltLine.quantity) === expectedQty &&
        (await prisma.approvalRequest.count({ where: { documentType: 'purchase_request', documentId: autoPrs[0].id } })) === 0,
      `${firstAdd.length}/${secondAdd.length}/${gskAdd.length}; ${autoPrs.length} PR(s) ${autoPrs[0]?.status} ${autoPrs[0]?.items.length} line(s); bolt ${bltLine ? num(bltLine.quantity) : 'none'} (expected ${expectedQty})`,
    );
  }

  // ── Pulled back after approval (2026-10-16) ───────────────────────────────
  // The owner's call: "every approval request can be pulled back and return
  // to draft, even if it's fully approved". The requisition's approval
  // committed budget, the order's issue replaced it with its own: pulling
  // either back undoes exactly that, and anything standing on it refuses.
  console.log('\nPulled back after approval');
  {
    const engResolved = (await resolveUser(engineer.id))!;
    const procResolved = (await resolveUser(procurement.id))!;
    const finResolved = (await resolveUser(finance.id))!;
    const committedBefore = (await position()).committed;
    const backPr = await prisma.purchaseRequest.create({
      data: {
        number: await nextNumber('purchase_request'),
        kind: 'DIRECT_TO_JOB',
        jobId: job.id,
        warehouseId: warehouse.id,
        requestedById: engineer.id,
        purpose: `${TAG} request to pull back`,
        items: {
          create: [{ itemId: item.id, costCategoryId: materials.id, description: `${TAG} Stainless pipe`, quantity: D(10), unit: 'pcs', estimatedCost: D(100), estimatedAmount: D(1_000) }],
        },
      },
      include: { items: true },
    });
    const approvePr = async () => {
      await prisma.purchaseRequest.update({ where: { id: backPr.id }, data: { status: 'PENDING_APPROVAL' } });
      const r = await submitForApproval({
        documentType: 'purchase_request',
        documentId: backPr.id,
        documentNumber: backPr.number,
        subject: `${TAG} request to pull back`,
        amount: 1_000,
        requesterId: engineer.id,
      });
      await act({ requestId: r.id, userId: pm.id, action: 'APPROVED' });
      return r;
    };
    const prReq = await approvePr();
    const committedApproved = (await position()).committed;
    const strangerTry = await reopenApproved('purchase_request', backPr.id, finResolved, `${TAG} not mine`).then(() => 'reopened', (e: Error) => e.message);
    const prBack = await reopenApproved('purchase_request', backPr.id, engResolved, `${TAG} wrong quantity`).then(() => 'ok', (e: Error) => e.message);
    const prRow = await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: backPr.id } });
    const prReqRow = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: prReq.id } });
    check(
      'an approved requisition is pulled back to a draft by its requester (nobody else): its request closes, and the budget its approval committed is released by a negative row',
      money(committedApproved - committedBefore, 1_000) &&
        strangerTry !== 'reopened' &&
        prBack === 'ok' &&
        prRow.status === 'DRAFT' &&
        prRow.approvedAt === null &&
        prReqRow.status === 'CANCELLED' &&
        prReqRow.reopenedById === engineer.id &&
        money((await position()).committed, committedBefore),
      `${committedBefore} → ${committedApproved} → ${(await position()).committed}; stranger: ${strangerTry}; ${prBack}; ${prRow.status} ${prReqRow.status}`,
    );

    await approvePr();
    const backPo = await prisma.purchaseOrder.create({
      data: {
        number: await nextNumber('purchase_order'),
        kind: 'DIRECT_TO_JOB',
        supplierId: supplier.id,
        requestId: backPr.id,
        jobId: job.id,
        warehouseId: warehouse.id,
        createdById: procurement.id,
        notes: `${TAG} order to pull back`,
        subtotal: D(900),
        total: D(900),
        items: {
          create: [{ requestItemId: backPr.items[0].id, itemId: item.id, costCategoryId: materials.id, description: `${TAG} Stainless pipe`, quantity: D(10), unit: 'pcs', unitPrice: D(90), amount: D(900) }],
        },
      },
    });
    const prWithOrder = await reopenApproved('purchase_request', backPr.id, engResolved, `${TAG} again`).then(() => 'ok', (e: Error) => e.message);
    check(
      'a requisition with a purchase order standing on it (even a draft one) is refused, naming the order',
      prWithOrder.includes(backPo.number) && (await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: backPr.id } })).status === 'APPROVED',
      prWithOrder,
    );

    const approvePo = async () => {
      await prisma.purchaseOrder.update({ where: { id: backPo.id }, data: { status: 'PENDING_APPROVAL' } });
      const r = await submitForApproval({
        documentType: 'purchase_order',
        documentId: backPo.id,
        documentNumber: backPo.number,
        subject: `${TAG} order to pull back`,
        amount: 900,
        requesterId: procurement.id,
      });
      await act({ requestId: r.id, userId: purchMgr.id, action: 'APPROVED' });
    };
    await approvePo();
    const issuedPo = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: backPo.id } });
    const committedIssued = (await position()).committed;
    const poBack = await reopenApproved('purchase_order', backPo.id, procResolved, `${TAG} wrong supplier`).then(() => 'ok', (e: Error) => e.message);
    const poRow = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: backPo.id } });
    const prAfterPo = await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: backPr.id }, include: { items: true } });
    check(
      'an issued order is pulled back to a draft by its buyer: its firm commitment reversed, the request’s ordered quantity and status put back, and the request’s commitment restored',
      issuedPo.status === 'ISSUED' &&
        money(committedIssued - committedBefore, 900) &&
        poBack === 'ok' &&
        poRow.status === 'DRAFT' &&
        poRow.issuedAt === null &&
        prAfterPo.status === 'APPROVED' &&
        num(prAfterPo.items[0].orderedQty) === 0 &&
        money((await position()).committed - committedBefore, 1_000),
      `${issuedPo.status}; committed ${committedIssued} → ${(await position()).committed} (from ${committedBefore}); ${poBack}; ${poRow.status}; PR ${prAfterPo.status} ordered ${num(prAfterPo.items[0].orderedQty)}`,
    );

    await approvePo();
    const committedAgain = (await position()).committed;
    const draftIn = await prisma.receiving.create({
      data: {
        number: await nextNumber('receiving'),
        orderId: backPo.id,
        warehouseId: warehouse.id,
        receivedById: procurement.id,
        status: 'DRAFT',
        items: { create: [{ orderItemId: (await prisma.purchaseOrderItem.findFirstOrThrow({ where: { orderId: backPo.id } })).id, quantity: D(1), unitCost: D(90) }] },
      },
    });
    const poWithGoods = await reopenApproved('purchase_order', backPo.id, procResolved, `${TAG} again`).then(() => 'ok', (e: Error) => e.message);
    check(
      'issued a second time it commits once more at the order’s price (not twice); with goods being received against it, pulling it back is refused, naming the report',
      money(committedAgain - committedBefore, 900) &&
        poWithGoods.includes(draftIn.number) &&
        (await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: backPo.id } })).status === 'ISSUED',
      `${committedAgain}; ${poWithGoods}`,
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
