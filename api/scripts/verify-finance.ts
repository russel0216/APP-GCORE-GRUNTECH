/**
 * Phase 7 verification — G-FIN.
 *
 *   npx tsx scripts/verify-finance.ts
 *
 * Three things here are easy to get wrong and expensive to get wrong quietly:
 *
 *   · **Invoiced ≠ collectible.** EWT is withheld by the customer at source and
 *     comes back as a 2307 certificate, not as cash. An A/R balance measured
 *     against the invoice total reports the withheld part as unpaid forever,
 *     and every customer looks like a late payer.
 *   · **A supplier bill must not re-charge a job that a receiving already
 *     charged.** Receiving posts INCURRED when the goods arrive. A bill for
 *     those same goods is paperwork catching up, not a second cost. A bill with
 *     no receiving behind it — a subcontract certificate, a service call — is
 *     the first time that cost appears, so that one does post.
 *   · **A payment must not over-apply.** Allocating more than a document still
 *     owes drives its balance negative and the aging report with it.
 *
 * Everything else here exists to keep those three honest.
 */

import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/prisma';
import { rolesLike } from './lib/roles';
import { env } from '../src/env';
import { nextNumber } from '../src/shared/numbering';
import { submitForApproval, act, approversForStep, pendingFor, reopenApproved, mayReopen } from '../src/shared/approvals';
import { resolveUser } from '../src/permissions/resolve';
import { postJobCost, availableBudget } from '../src/shared/inventory';
import {
  taxBreakdown,
  bucketFor,
  bucketLabels,
  summarise,
  addDays,
  daysBetween,
  dayKey,
  settleable,
  refreshSettlement,
  financePosition,
  financeSettings,
  saveFinanceSettings,
  type AgedRow,
} from '../src/shared/finance';
import { manilaDayKey, manilaDayStart, manilaDayEnd } from '../src/shared/day';
import { statusLabel } from '../src/shared/pdf';
// Side-effect imports: register the bill, expense and cash-advance approval
// subscribers, and the procurement ones the receiving path depends on. The
// two settle handlers are imported by name as well, so a test can call each
// one twice and prove the second call does nothing.
import { settleExpense } from '../src/routes/finance';
import { settleAdvance } from '../src/routes/advances';
// Side-effect import: registers the budget_request approval subscriber.
import '../src/routes/budgetRequests';
import '../src/routes/procurement';
// Side-effect import: registers the invoice_request approval subscriber.
import { settleInvoiceRequest } from '../src/routes/invoiceRequests';
// Side-effect import: registers the commission approval subscriber (2026-10-16).
import '../src/routes/commissions';
import { commissionFigures } from '../src/shared/commission';
import { commissionFigures as webCommissionFigures } from '../../web/src/lib/commission';
import {
  flat,
  hasLine,
  labelRuns,
  labelsSaid,
  pdfText,
  pendingCount,
  signedCount,
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
const cents = (n: number) => Math.round(n * 100) / 100;

const TAG = 'ZZFIN';
/** Where the finance rules wait while the run changes them. */
const RULES_STASH = 'finance.rules.__verify__';

async function restoreRules() {
  const stash = await prisma.setting.findUnique({ where: { key: RULES_STASH } });
  if (!stash) return;
  const rules = stash.value as { advanceLiquidationDays: number; budgetRequestLiquidationDays: number; blockAdvanceWhileUnliquidated: boolean };
  await saveFinanceSettings({
    advanceLiquidationDays: rules.advanceLiquidationDays,
    budgetRequestLiquidationDays: rules.budgetRequestLiquidationDays,
    blockAdvanceWhileUnliquidated: rules.blockAdvanceWhileUnliquidated,
  });
  await prisma.setting.delete({ where: { key: RULES_STASH } });
}
const BASE = `http://localhost:${env.port}/api`;

async function cleanup() {
  await restoreRules();
  // Approvals route to whoever really holds the role, so real people were told
  // about this script's documents too. Every such title carries TAG.
  await prisma.notification.deleteMany({ where: { title: { contains: TAG } } });
  // Advances first: their allocations point at payments, their liquidations at
  // them, and they point at the fixture job and users with Restrict.
  const advances = await prisma.cashAdvance.findMany({
    where: { purpose: { startsWith: TAG } },
    select: { id: true },
  });
  const invoices = await prisma.invoice.findMany({
    where: { customer: { name: { startsWith: TAG } } },
    select: { id: true },
  });
  const bills = await prisma.supplierBill.findMany({
    where: { supplier: { name: { startsWith: TAG } } },
    select: { id: true },
  });
  const claims = await prisma.expenseClaim.findMany({
    where: { purpose: { startsWith: TAG } },
    select: { id: true },
  });
  // Budget requests (project cash) the same way: payments, liquidations, then the request.
  const requests = await prisma.budgetRequest.findMany({ where: { reason: { startsWith: TAG } }, select: { id: true } });
  const ids = [
    ...invoices.map((i) => i.id),
    ...bills.map((b) => b.id),
    ...claims.map((c) => c.id),
    ...advances.map((a) => a.id),
    ...requests.map((r) => r.id),
  ];
  if (ids.length) {
    const allocations = await prisma.paymentAllocation.findMany({
      where: {
        OR: [
          { invoiceId: { in: invoices.map((i) => i.id) } },
          { billId: { in: bills.map((b) => b.id) } },
          { claimId: { in: claims.map((c) => c.id) } },
          { advanceId: { in: advances.map((a) => a.id) } },
          { budgetRequestId: { in: requests.map((r) => r.id) } },
        ],
      },
      select: { paymentId: true },
    });
    await prisma.payment.deleteMany({
      where: { id: { in: [...new Set(allocations.map((a) => a.paymentId))] } },
    });
  }
  // Commission payouts hold their shares (Restrict); the requests hold the order.
  const commissions = await prisma.commissionRequest.findMany({ where: { customer: { name: { startsWith: TAG } } }, select: { id: true } });
  if (commissions.length) {
    const payouts = await prisma.paymentAllocation.findMany({ where: { commissionShare: { requestId: { in: commissions.map((c) => c.id) } } }, select: { paymentId: true } });
    await prisma.payment.deleteMany({ where: { id: { in: [...new Set(payouts.map((p) => p.paymentId))] } } });
    await prisma.auditLog.deleteMany({ where: { entityType: 'commission', entityId: { in: commissions.map((c) => c.id) } } });
    await prisma.commissionRequest.deleteMany({ where: { id: { in: commissions.map((c) => c.id) } } });
  }
  // A collection with only lines typed by hand settles nothing, so it is found by its customer.
  await prisma.payment.deleteMany({ where: { customer: { name: { startsWith: TAG } } } });
  // Invoice requests hold their sales order (Restrict); their invoices go next.
  await prisma.invoiceRequest.deleteMany({
    where: { OR: [{ job: { customer: { name: { startsWith: TAG } } } }, { salesOrder: { customer: { name: { startsWith: TAG } } } }] },
  });
  await prisma.invoice.deleteMany({ where: { id: { in: invoices.map((i) => i.id) } } });
  // The A/R checks' sales order and its quotation, after their invoices.
  await prisma.salesOrder.deleteMany({ where: { customer: { name: { startsWith: TAG } } } });
  await prisma.quotation.deleteMany({ where: { customer: { name: { startsWith: TAG } } } });
  await prisma.supplierBill.deleteMany({ where: { id: { in: bills.map((b) => b.id) } } });
  // Job orders after their invoices (Restrict), before the customer and users.
  await prisma.jobOrder.deleteMany({ where: { customer: { name: { startsWith: TAG } } } });
  await prisma.expenseClaim.deleteMany({ where: { id: { in: claims.map((c) => c.id) } } });
  // Any liquidation filed over HTTP against a fixture advance carries the tag too.
  await prisma.expenseClaim.deleteMany({ where: { advanceId: { in: advances.map((a) => a.id) } } });
  await prisma.expenseClaim.deleteMany({ where: { budgetRequestId: { in: requests.map((r) => r.id) } } });
  await prisma.auditLog.deleteMany({
    where: { entityType: 'cash_advance', entityId: { in: advances.map((a) => a.id) } },
  });
  await prisma.cashAdvance.deleteMany({ where: { id: { in: advances.map((a) => a.id) } } });
  await prisma.auditLog.deleteMany({ where: { entityType: 'budget_request', entityId: { in: requests.map((r) => r.id) } } });
  await prisma.budgetRequest.deleteMany({ where: { id: { in: requests.map((r) => r.id) } } });

  await prisma.progressBilling.deleteMany({ where: { job: { name: { startsWith: TAG } } } });
  await prisma.progressReport.deleteMany({ where: { job: { name: { startsWith: TAG } } } });
  // Receivings before their orders: that foreign key is Restrict on purpose.
  await prisma.receiving.deleteMany({ where: { order: { notes: { startsWith: TAG } } } });
  await prisma.purchaseOrder.deleteMany({ where: { notes: { startsWith: TAG } } });
  await prisma.job.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.costing.deleteMany({ where: { title: { startsWith: TAG } } });
  await prisma.item.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.warehouse.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.customer.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.supplier.deleteMany({ where: { name: { startsWith: TAG } } });

  const users = await prisma.user.findMany({
    where: { email: { endsWith: '@verifyf.local' } },
    select: { id: true },
  });
  const userIds = users.map((u) => u.id);
  if (userIds.length) {
    await prisma.approvalAction.deleteMany({ where: { approverId: { in: userIds } } });
    await prisma.approvalRequest.deleteMany({ where: { requesterId: { in: userIds } } });
    await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await prisma.user.updateMany({
      where: { supervisorId: { in: userIds } },
      data: { supervisorId: null },
    });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.role.deleteMany({ where: { key: { startsWith: 'zzfin_' } } });
}

/**
 * Walks an approval through every step to settlement.
 *
 * Rather than naming an approver per step, this asks the engine who is
 * eligible and picks whoever qualifies. A test that hard-codes "finance
 * approves step 2" silently becomes a test of nothing the day the workflow is
 * re-routed — which has now happened three times in this codebase.
 */
async function settle(approvalId: string, outcome: 'APPROVED' | 'REJECTED' = 'APPROVED') {
  for (let guard = 0; guard < 10; guard++) {
    const request = await prisma.approvalRequest.findUnique({
      where: { id: approvalId },
      include: { workflow: { include: { steps: { orderBy: { sequence: 'asc' } } } } },
    });
    if (!request || request.status !== 'PENDING') return request;

    const step = request.workflow?.steps.find((s) => s.sequence === request.currentSequence);
    if (!step) throw new Error(`No step ${request.currentSequence} on that workflow`);

    // With the request's project: a PROJECT_MANAGER step resolves against it.
    const eligible = (await approversForStep(step, request.requesterId, prisma, { jobId: request.jobId })).filter(
      (id) => id !== request.requesterId,
    );
    if (!eligible.length) {
      throw new Error(
        `Step "${step.name}" of "${request.workflow?.name}" has nobody who may approve it — the fixture is missing a role holder.`,
      );
    }
    await act({ requestId: approvalId, userId: eligible[0], action: outcome });
    if (outcome === 'REJECTED') break;
  }
  return prisma.approvalRequest.findUnique({ where: { id: approvalId } });
}

async function makeUser(name: string, email: string, roleKeys: string[], supervisorId?: string) {
  // A seeded role's KEY and a throwaway copy of its rights (scripts/lib/roles.ts).
  const roles = await rolesLike('zzfin_', roleKeys);
  return prisma.user.create({
    data: {
      name,
      email,
      passwordHash: await bcrypt.hash('x', 10),
      supervisorId: supervisorId ?? null,
      roles: { create: roles.map((r) => ({ roleId: r.id })) },
    },
  });
}

/** A workflow's step names as the paper prints them, in capitals. */
const stepNames = async (workflowId: string | null) =>
  (await prisma.approvalStep.findMany({ where: { workflowId: workflowId ?? '' }, orderBy: { sequence: 'asc' } })).map((st) =>
    st.name.toUpperCase(),
  );
const exportsOf = (entityType: string, entityId: string) =>
  prisma.auditLog.count({ where: { entityType, entityId, action: 'EXPORTED' } });

async function main() {
  console.log('\nG-CORE finance verification\n');
  await cleanup();

  // ══ The tax arithmetic ═══════════════════════════════════════════════════
  console.log('Tax, and the difference between invoiced and collectible');

  const t = taxBreakdown(100_000, 0.12, 0.02);
  check('VAT is added on top of the gross', money(t.vatAmount, 12_000), `got ${t.vatAmount}`);
  check(
    'EWT is withheld on the GROSS, not on the VAT',
    money(t.ewtAmount, 2_000),
    `got ${t.ewtAmount} — 2% of the VAT-inclusive 112,000 would be 2,240`,
  );
  check('the invoice total is gross plus VAT', money(t.invoiceTotal, 112_000));
  check(
    'net collectible is the invoice total less the withheld tax',
    money(t.netCollectible, 110_000),
    `got ${t.netCollectible}`,
  );
  check(
    'so 2,000 of a 112,000 invoice is never coming as cash',
    money(t.invoiceTotal - t.netCollectible, 2_000),
  );

  const awkward = taxBreakdown(333_333.33, 0.12, 0.02);
  check(
    'an awkward figure still reconciles to the centavo',
    money(awkward.grossAmount + awkward.vatAmount, awkward.invoiceTotal) &&
      money(awkward.invoiceTotal - awkward.ewtAmount, awkward.netCollectible),
    `${awkward.grossAmount} + ${awkward.vatAmount} vs ${awkward.invoiceTotal}`,
  );

  const exempt = taxBreakdown(50_000, 0.12, 0);
  check(
    'a customer who withholds nothing collects the whole invoice',
    money(exempt.netCollectible, exempt.invoiceTotal),
  );

  // ══ Aging buckets ════════════════════════════════════════════════════════
  console.log('\nAging');

  const buckets = [30, 60, 90];
  check('a bill not yet due is Current', bucketFor(-5, buckets) === 'Current');
  check('due today is Current, not overdue', bucketFor(0, buckets) === 'Current');
  check('one day late falls in the first bucket', bucketFor(1, buckets) === '1–30');
  check('thirty days late is still the first bucket', bucketFor(30, buckets) === '1–30');
  check('thirty-one days moves it on', bucketFor(31, buckets) === '31–60');
  check('past the last edge is the open-ended bucket', bucketFor(200, buckets) === '90+');
  check(
    'the labels line up with the buckets',
    bucketLabels(buckets).join('|') === 'Current|1–30|31–60|61–90|90+',
    bucketLabels(buckets).join('|'),
  );

  const aged: AgedRow[] = [
    { daysOverdue: -3, outstanding: 1000 },
    { daysOverdue: 10, outstanding: 2000 },
    { daysOverdue: 45, outstanding: 3000 },
    { daysOverdue: 200, outstanding: 4000 },
  ].map((r, i) => ({
    id: String(i),
    number: `X${i}`,
    party: 'x',
    partyId: 'x',
    date: new Date(),
    dueDate: new Date(),
    payable: r.outstanding,
    paid: 0,
    bucket: bucketFor(r.daysOverdue, buckets),
    ...r,
  }));
  const summary = summarise(aged, buckets);
  check(
    'the buckets sum to the total outstanding',
    money(
      summary.reduce((s, b) => s + b.amount, 0),
      10_000,
    ),
  );
  check(
    'and each lands where it belongs',
    summary[0].amount === 1000 && summary[1].amount === 2000 && summary[2].amount === 3000 && summary[4].amount === 4000,
    summary.map((b) => `${b.label}=${b.amount}`).join(' '),
  );

  check('thirty days added lands thirty days later', daysBetween(dayKey(new Date()), addDays(dayKey(new Date()), 30)) === 30);

  // ══ Manila's day ═════════════════════════════════════════════════════════
  // Until 08:00 in Manila the UTC date is still yesterday's. Every "today" in
  // G-FIN is dayKey(new Date()), so it is pinned here at both ends of one
  // Manila day, whatever hour this script happens to run.
  console.log('\nManila’s day');
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const earlyFirst = new Date('2026-10-01T00:30:00+08:00');
  check(
    'at 00:30 in Manila, today is already the new day',
    ymd(dayKey(earlyFirst)) === '2026-10-01',
    `${ymd(dayKey(earlyFirst))} — the UTC date is still the 30th`,
  );
  check(
    'and at 23:30 it is still that day',
    ymd(dayKey(new Date('2026-10-01T23:30:00+08:00'))) === '2026-10-01',
  );
  check(
    'an invoice due yesterday is a day overdue from Manila’s midnight, not from 08:00',
    daysBetween(new Date('2026-09-30'), earlyFirst) === 1,
    String(daysBetween(new Date('2026-09-30'), earlyFirst)),
  );
  let storedUnchanged = true;
  for (let d = new Date('2026-01-01'); d < new Date('2027-01-01'); d = addDays(d, 1)) {
    if (dayKey(d).getTime() !== d.getTime()) storedUnchanged = false;
  }
  check('a stored date comes back from dayKey() unchanged, every day of a year', storedUnchanged);

  // ══ Fixtures ═════════════════════════════════════════════════════════════

  const pm = await makeUser('ZZ Fin PM', 'pm@verifyf.local', ['project_manager']);
  const finance = await makeUser('ZZ Finance', 'fin@verifyf.local', ['finance']);
  const engineer = await makeUser('ZZ Engineer', 'eng@verifyf.local', ['project_engineer'], pm.id);
  const procurement = await makeUser('ZZ Procurement', 'proc@verifyf.local', ['procurement']);
  // A budget request's route (the sheet of 2026-10-13): the requester's Team
  // Leader (the engineer reports to the PM), Admin Back Support, the Finance
  // Manager — each needs a holder.
  const backSup = await makeUser('ZZ Back Support', 'backsupport@verifyf.local', ['back_support']);
  const finMgr = await makeUser('ZZ Finance Manager', 'finmgr@verifyf.local', ['finance_manager']);
  const teamLeader = await makeUser('ZZ Team Leader', 'teamleader@verifyf.local', ['team_leader']);
  await makeUser('ZZ Director', 'exec@verifyf.local', ['executive']);
  // Reimbursements and cash advances (2026-10-15) end with the CEO / President.
  await makeUser('ZZ CEO', 'ceo@verifyf.local', ['ceo']);
  // The supplier bill routes' first step (2026-10-15); the install's own holders are nobody's business.
  await makeUser('ZZ Fin TM', 'tm@verifyf.local', ['technical_manager']);
  // Throwaway roles for the route guards: nothing at all, project access
  // without budget monitoring, and the right to file a claim and nothing else.
  const throwaway = async (key: string, permissionKeys: string[]) => {
    const permissions = await prisma.permission.findMany({ where: { key: { in: permissionKeys } } });
    return prisma.role.create({
      data: { key, name: key, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } },
    });
  };
  await throwaway('zzfin_none', []);
  await throwaway('zzfin_projects', ['gops.projects.view_all']);
  await throwaway('zzfin_claimant', ['gfin.expenses.create']);
  // Enters supplier bills and nothing more: entering is not modifying.
  await throwaway('zzfin_apclerk', ['gfin.ap.view_all', 'gfin.ap.create']);
  const stranger = await makeUser('ZZ Stranger', 'none@verifyf.local', ['zzfin_none']);
  const projectViewer = await makeUser('ZZ Project Viewer', 'projects@verifyf.local', ['zzfin_projects']);
  const claimant = await makeUser('ZZ Claimant', 'claimant@verifyf.local', ['zzfin_claimant']);
  const apClerk = await makeUser('ZZ AP Clerk', 'apclerk@verifyf.local', ['zzfin_apclerk']);
  const todayIso = dayKey(new Date()).toISOString().slice(0, 10);

  const customer = await prisma.customer.create({
    data: { code: `${TAG}-C1`, name: `${TAG} Hospital` },
  });
  const supplier = await prisma.supplier.create({
    data: { code: `${TAG}-S1`, name: `${TAG} Steel Supply` },
  });
  const warehouse = await prisma.warehouse.create({
    data: { code: `${TAG}W`, name: `${TAG} Store` },
  });
  const categories = await prisma.costCategory.findMany({ orderBy: { sortOrder: 'asc' } });
  const materials = categories[0];
  const subcontract = categories.find((c) => /sub/i.test(c.name)) ?? categories[3] ?? categories[1];

  const item = await prisma.item.create({
    data: {
      code: `${TAG}-PIPE`,
      name: `${TAG} Pipe`,
      unit: 'pcs',
      costCategoryId: materials.id,
    },
  });

  const costing = await prisma.costing.create({
    data: {
      number: await nextNumber('costing'),
      title: `${TAG} Plant`,
      ownerId: pm.id,
      totalCost: D(800_000),
      contractValue: D(1_000_000),
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
      contractValue: D(1_000_000),
      costEntries: {
        create: [
          {
            costCategoryId: materials.id,
            state: 'BUDGETED',
            amount: D(500_000),
            sourceType: 'costing',
            sourceNumber: costing.number,
          },
          {
            costCategoryId: subcontract.id,
            state: 'BUDGETED',
            amount: D(300_000),
            sourceType: 'costing',
            sourceNumber: costing.number,
          },
        ],
      },
    },
  });

  // ══ A supplier bill must not re-charge what a receiving already charged ══
  console.log('\nA/P — the double-charge trap');

  const order = await prisma.purchaseOrder.create({
    data: {
      number: await nextNumber('purchase_order'),
      status: 'ISSUED',
      kind: 'DIRECT_TO_JOB',
      supplierId: supplier.id,
      jobId: job.id,
      warehouseId: warehouse.id,
      createdById: procurement.id,
      notes: `${TAG} steel order`,
      subtotal: D(100_000),
      vatAmount: D(12_000),
      total: D(112_000),
      issuedAt: new Date(),
      items: {
        create: [
          {
            itemId: item.id,
            costCategoryId: materials.id,
            description: `${TAG} Pipe`,
            unit: 'pcs',
            quantity: D(100),
            unitPrice: D(1000),
            amount: D(100_000),
          },
        ],
      },
    },
    include: { items: true },
  });

  const materialsBefore = await availableBudget(prisma, job.id, materials.id);

  // Receiving the goods, exactly as the Phase 5 route does it: a direct-to-job
  // receipt charges the project and does NOT build stock.
  const receiving = await prisma.$transaction(async (tx) => {
    const created = await tx.receiving.create({
      data: {
        number: await nextNumber('receiving', tx),
        orderId: order.id,
        warehouseId: warehouse.id,
        receivedById: procurement.id,
        receivedDate: dayKey(new Date()),
        items: {
          create: [{ orderItemId: order.items[0].id, quantity: D(100), unitCost: D(1000) }],
        },
      },
    });
    await postJobCost(tx, {
      jobId: job.id,
      costCategoryId: materials.id,
      state: 'INCURRED',
      amount: 100_000,
      sourceType: 'receiving',
      sourceId: created.id,
      sourceNumber: created.number,
      description: 'Goods received',
      createdById: procurement.id,
    });
    return created;
  });

  const materialsAfterReceiving = await availableBudget(prisma, job.id, materials.id);
  check(
    'receiving the goods incurs the cost, as Phase 5 already does',
    money(materialsAfterReceiving.incurred - materialsBefore.incurred, 100_000),
    `incurred moved by ${materialsAfterReceiving.incurred - materialsBefore.incurred}`,
  );

  // The supplier's invoice for those same goods.
  const matchedBill = await prisma.supplierBill.create({
    data: {
      number: await nextNumber('supplier_bill'),
      supplierId: supplier.id,
      orderId: order.id,
      receivingId: receiving.id,
      jobId: job.id,
      costCategoryId: materials.id,
      // Pending, as the submit route leaves it: the settlement claims only a
      // bill still PENDING_APPROVAL, and these are submitted directly below.
      status: 'PENDING_APPROVAL',
      supplierInvoiceNo: `${TAG}-SI-001`,
      billDate: dayKey(new Date()),
      dueDate: addDays(dayKey(new Date()), 30),
      subtotal: D(100_000),
      vatAmount: D(12_000),
      total: D(112_000),
      ewtRate: D(0.01),
      ewtAmount: D(1_000),
      netPayable: D(111_000),
      createdById: finance.id,
      lines: {
        create: [
          { sortOrder: 0, description: `${TAG} Pipe`, quantity: D(100), unitPrice: D(1000), amount: D(100_000) },
        ],
      },
    },
  });

  const matchedApproval = await submitForApproval({
    documentType: 'supplier_bill',
    documentId: matchedBill.id,
    documentNumber: matchedBill.number,
    subject: `${TAG} matched bill`,
    amount: 112_000,
    requesterId: finance.id,
  });
  await settle(matchedApproval.id);

  const afterMatchedBill = await availableBudget(prisma, job.id, materials.id);
  const matchedAfter = await prisma.supplierBill.findUnique({ where: { id: matchedBill.id } });
  check('a bill matched to a receiving still becomes payable', matchedAfter?.status === 'APPROVED');
  check(
    'but it posts NO cost — the receiving already incurred it',
    money(afterMatchedBill.incurred, materialsAfterReceiving.incurred) && matchedAfter?.postedToJob === false,
    `incurred ${afterMatchedBill.incurred} vs ${materialsAfterReceiving.incurred}, postedToJob ${matchedAfter?.postedToJob}`,
  );

  // A subcontractor's certificate: nothing was ever received against it.
  const subBefore = await availableBudget(prisma, job.id, subcontract.id);
  const unmatchedBill = await prisma.supplierBill.create({
    data: {
      number: await nextNumber('supplier_bill'),
      supplierId: supplier.id,
      jobId: job.id,
      costCategoryId: subcontract.id,
      status: 'PENDING_APPROVAL',
      supplierInvoiceNo: `${TAG}-SI-002`,
      billDate: dayKey(new Date()),
      dueDate: addDays(dayKey(new Date()), 30),
      subtotal: D(200_000),
      vatAmount: D(24_000),
      total: D(224_000),
      ewtRate: D(0.02),
      ewtAmount: D(4_000),
      netPayable: D(220_000),
      createdById: finance.id,
      lines: {
        create: [
          { sortOrder: 0, description: `${TAG} Installation`, quantity: D(1), unitPrice: D(200_000), amount: D(200_000) },
        ],
      },
    },
  });

  const unmatchedApproval = await submitForApproval({
    documentType: 'supplier_bill',
    documentId: unmatchedBill.id,
    documentNumber: unmatchedBill.number,
    subject: `${TAG} subcontract certificate`,
    amount: 224_000,
    requesterId: finance.id,
  });
  await settle(unmatchedApproval.id);

  const subAfter = await availableBudget(prisma, job.id, subcontract.id);
  const unmatchedAfter = await prisma.supplierBill.findUnique({ where: { id: unmatchedBill.id } });
  check(
    'a bill with no receiving behind it DOES post — it is the first time that cost appears',
    money(subAfter.incurred - subBefore.incurred, 200_000) && unmatchedAfter?.postedToJob === true,
    `incurred moved by ${subAfter.incurred - subBefore.incurred}`,
  );
  check(
    'and it posts the subtotal, not the VAT-inclusive total',
    money(subAfter.incurred - subBefore.incurred, 200_000),
    'input VAT is recoverable, so the project bears 200,000 and not 224,000',
  );

  const ledgerRows = await prisma.jobCostEntry.count({
    where: { jobId: job.id, sourceType: 'supplier_bill' },
  });
  check('exactly one of the two bills reached the ledger', ledgerRows === 1, `${ledgerRows} rows`);

  const rejectedBill = await prisma.supplierBill.create({
    data: {
      number: await nextNumber('supplier_bill'),
      status: 'PENDING_APPROVAL',
      supplierId: supplier.id,
      jobId: job.id,
      costCategoryId: subcontract.id,
      billDate: dayKey(new Date()),
      dueDate: addDays(dayKey(new Date()), 30),
      subtotal: D(10_000),
      vatAmount: D(1_200),
      total: D(11_200),
      netPayable: D(11_200),
      createdById: finance.id,
    },
  });
  const rejectedApproval = await submitForApproval({
    documentType: 'supplier_bill',
    documentId: rejectedBill.id,
    documentNumber: rejectedBill.number,
    subject: `${TAG} disputed`,
    amount: 11_200,
    requesterId: finance.id,
  });
  await settle(rejectedApproval.id, 'REJECTED');
  const rejectedAfter = await prisma.supplierBill.findUnique({ where: { id: rejectedBill.id } });
  const ledgerAfterRejection = await prisma.jobCostEntry.count({
    where: { jobId: job.id, sourceType: 'supplier_bill' },
  });
  check('a rejected bill is cancelled', rejectedAfter?.status === 'CANCELLED');
  check('and posts nothing', ledgerAfterRejection === 1, `${ledgerAfterRejection} rows`);

  // ══ A/R — invoicing a billing ════════════════════════════════════════════
  console.log('\nA/R — invoiced is not collectible');

  const report = await prisma.progressReport.create({
    data: {
      number: await nextNumber('progress_report'),
      jobId: job.id,
      reportNo: 1,
      status: 'APPROVED',
      periodFrom: dayKey(new Date()),
      periodTo: dayKey(new Date()),
      preparedById: engineer.id,
      accomplishment: `${TAG} 40% complete`,
    },
  });
  const billingTax = taxBreakdown(400_000, 0.12, 0.02);
  const billing = await prisma.progressBilling.create({
    data: {
      number: await nextNumber('progress_billing'),
      jobId: job.id,
      billingNo: 1,
      status: 'APPROVED',
      progressReportId: report.id,
      billingDate: dayKey(new Date()),
      grossAmount: D(billingTax.grossAmount),
      vatRate: D(0.12),
      vatAmount: D(billingTax.vatAmount),
      ewtRate: D(0.02),
      ewtAmount: D(billingTax.ewtAmount),
      invoiceTotal: D(billingTax.invoiceTotal),
      netCollectible: D(billingTax.netCollectible),
      approvedAt: new Date(),
    },
  });

  const invoice = await prisma.invoice.create({
    data: {
      number: await nextNumber('invoice'),
      customerId: customer.id,
      jobId: job.id,
      progressBillingId: billing.id,
      invoiceDate: dayKey(new Date()),
      dueDate: addDays(dayKey(new Date()), 30),
      grossAmount: billing.grossAmount,
      vatRate: billing.vatRate,
      vatAmount: billing.vatAmount,
      ewtRate: billing.ewtRate,
      ewtAmount: billing.ewtAmount,
      invoiceTotal: billing.invoiceTotal,
      netCollectible: billing.netCollectible,
      status: 'ISSUED',
      issuedAt: new Date(),
      createdById: finance.id,
    },
  });
  await prisma.progressBilling.update({ where: { id: billing.id }, data: { status: 'INVOICED' } });

  check(
    'the invoice carries the billing figures rather than recomputing them',
    money(num(invoice.invoiceTotal), 448_000) && money(num(invoice.netCollectible), 440_000),
    `${num(invoice.invoiceTotal)} / ${num(invoice.netCollectible)}`,
  );

  const open = await settleable('invoice', invoice.id);
  check(
    'outstanding is measured against NET COLLECTIBLE, not the invoice total',
    money(open!.outstanding, 440_000),
    `got ${open!.outstanding} — against the invoice total it would read 448,000`,
  );

  // Paying it in full means paying the net collectible.
  const receipt = await prisma.payment.create({
    data: {
      number: await nextNumber('payment'),
      kind: 'RECEIPT',
      method: 'BANK_TRANSFER',
      paymentDate: dayKey(new Date()),
      customerId: customer.id,
      amount: D(440_000),
      clearedAt: dayKey(new Date()),
      recordedById: finance.id,
      allocations: { create: [{ invoiceId: invoice.id, amount: D(440_000) }] },
    },
  });
  const { refreshSettlement } = await import('../src/shared/finance');
  await prisma.$transaction((tx) => refreshSettlement(tx, 'invoice', invoice.id));

  const settledInvoice = await prisma.invoice.findUnique({ where: { id: invoice.id } });
  check(
    'a customer paying the net collectible settles the invoice in full',
    settledInvoice?.status === 'PAID',
    `status ${settledInvoice?.status} after 440,000 against a 448,000 invoice`,
  );
  check(
    'so an invoice paid in full is NOT reported as 8,000 outstanding',
    money(cents(num(settledInvoice!.netCollectible) - num(settledInvoice!.amountCollected)), 0),
  );

  // The withheld 8,000 is real, but it is a tax credit rather than cash.
  check(
    'the withheld tax is still recorded on the invoice, awaiting its 2307',
    money(num(settledInvoice!.ewtAmount), 8_000) && settledInvoice!.ewtCertificateNo === null,
  );

  // ══ Allocation ═══════════════════════════════════════════════════════════
  console.log('\nPayments and allocation');

  const secondInvoice = await prisma.invoice.create({
    data: {
      number: await nextNumber('invoice'),
      customerId: customer.id,
      jobId: job.id,
      invoiceDate: dayKey(new Date()),
      dueDate: addDays(dayKey(new Date()), 30),
      grossAmount: D(100_000),
      vatAmount: D(12_000),
      ewtAmount: D(2_000),
      invoiceTotal: D(112_000),
      netCollectible: D(110_000),
      status: 'ISSUED',
      issuedAt: new Date(),
      createdById: finance.id,
    },
  });

  const partial = await prisma.payment.create({
    data: {
      number: await nextNumber('payment'),
      kind: 'RECEIPT',
      method: 'CHECK',
      paymentDate: dayKey(new Date()),
      customerId: customer.id,
      amount: D(40_000),
      reference: `${TAG}-CHK-001`,
      recordedById: finance.id,
      allocations: { create: [{ invoiceId: secondInvoice.id, amount: D(40_000) }] },
    },
  });
  await prisma.$transaction((tx) => refreshSettlement(tx, 'invoice', secondInvoice.id));

  const partlyPaid = await prisma.invoice.findUnique({ where: { id: secondInvoice.id } });
  check('a part payment moves the invoice to partially paid', partlyPaid?.status === 'PARTIALLY_PAID');
  check(
    'and leaves the remainder outstanding',
    money(cents(num(partlyPaid!.netCollectible) - num(partlyPaid!.amountCollected)), 70_000),
  );
  check(
    'an uncleared cheque is recorded but has not cleared',
    partial.clearedAt === null,
    'a cash position that counts uncleared cheques is the one that bounces',
  );

  const remaining = await settleable('invoice', secondInvoice.id);
  check('what is left to allocate is what is left to pay', money(remaining!.outstanding, 70_000));

  // Reversing the payment must put the invoice back exactly where it was.
  await prisma.$transaction(async (tx) => {
    await tx.payment.delete({ where: { id: partial.id } });
    await refreshSettlement(tx, 'invoice', secondInvoice.id);
  });
  const reversed = await prisma.invoice.findUnique({ where: { id: secondInvoice.id } });
  check(
    'reversing a payment puts the invoice back where it was',
    reversed?.status === 'ISSUED' && money(num(reversed.amountCollected), 0),
    `status ${reversed?.status}, collected ${num(reversed!.amountCollected)}`,
  );

  // One cheque across two invoices — how collections actually arrive.
  const thirdInvoice = await prisma.invoice.create({
    data: {
      number: await nextNumber('invoice'),
      customerId: customer.id,
      invoiceDate: dayKey(new Date()),
      dueDate: addDays(dayKey(new Date()), 30),
      grossAmount: D(50_000),
      vatAmount: D(6_000),
      ewtAmount: D(1_000),
      invoiceTotal: D(56_000),
      netCollectible: D(55_000),
      status: 'ISSUED',
      issuedAt: new Date(),
      createdById: finance.id,
    },
  });
  await prisma.payment.create({
    data: {
      number: await nextNumber('payment'),
      kind: 'RECEIPT',
      method: 'BANK_TRANSFER',
      paymentDate: dayKey(new Date()),
      customerId: customer.id,
      amount: D(165_000),
      clearedAt: dayKey(new Date()),
      recordedById: finance.id,
      allocations: {
        create: [
          { invoiceId: secondInvoice.id, amount: D(110_000) },
          { invoiceId: thirdInvoice.id, amount: D(55_000) },
        ],
      },
    },
  });
  await prisma.$transaction(async (tx) => {
    await refreshSettlement(tx, 'invoice', secondInvoice.id);
    await refreshSettlement(tx, 'invoice', thirdInvoice.id);
  });
  const [two, three] = await Promise.all([
    prisma.invoice.findUnique({ where: { id: secondInvoice.id } }),
    prisma.invoice.findUnique({ where: { id: thirdInvoice.id } }),
  ]);
  check(
    'one payment settles several invoices, each to its own balance',
    two?.status === 'PAID' && three?.status === 'PAID',
    `${two?.status} / ${three?.status}`,
  );

  // ══ Expense claims ═══════════════════════════════════════════════════════
  console.log('\nExpense claims');

  const claim = await prisma.expenseClaim.create({
    data: {
      number: await nextNumber('expense'),
      claimedById: engineer.id,
      jobId: job.id,
      costCategoryId: subcontract.id,
      claimDate: dayKey(new Date()),
      purpose: `${TAG} site trip`,
      total: D(8_500),
      lines: {
        create: [
          {
            sortOrder: 0,
            spentOn: dayKey(new Date()),
            description: 'Fare',
            receiptNo: 'OR-1',
            amount: D(3_500),
          },
          {
            sortOrder: 1,
            spentOn: dayKey(new Date()),
            description: 'Accommodation',
            receiptNo: 'OR-2',
            amount: D(5_000),
          },
        ],
      },
    },
  });

  await prisma.expenseClaim.update({ where: { id: claim.id }, data: { status: 'PENDING_APPROVAL' } });

  const subBeforeClaim = await availableBudget(prisma, job.id, subcontract.id);
  const claimApproval = await submitForApproval({
    documentType: 'expense',
    documentId: claim.id,
    documentNumber: claim.number,
    subject: `${TAG} claim`,
    amount: 8_500,
    requesterId: engineer.id,
  });

  // The supervisor signs first. The claim must NOT settle on that alone —
  // finance is the second step, and cost posts only when the whole thing has.
  await act({ requestId: claimApproval.id, userId: pm.id, action: 'APPROVED' });
  const claimMidApproval = await prisma.approvalRequest.findUnique({ where: { id: claimApproval.id } });
  const claimMid = await prisma.expenseClaim.findUnique({ where: { id: claim.id } });
  const subMidClaim = await availableBudget(prisma, job.id, subcontract.id);
  check(
    'the supervisor alone does not settle a claim — finance is still to come',
    claimMidApproval?.status === 'PENDING' && claimMidApproval.currentSequence === 2,
    `approval ${claimMidApproval?.status} at step ${claimMidApproval?.currentSequence}`,
  );
  check('the claim is still pending, not approved', claimMid?.status === 'PENDING_APPROVAL', `status ${claimMid?.status}`);
  check('and nothing is charged on that step alone', money(subMidClaim.incurred, subBeforeClaim.incurred));

  await settle(claimApproval.id);
  const claimAfter = await prisma.expenseClaim.findUnique({ where: { id: claim.id } });
  const subAfterClaim = await availableBudget(prisma, job.id, subcontract.id);
  check('both approvals settle the claim', claimAfter?.status === 'APPROVED');
  check(
    'an approved claim charges the project once',
    money(subAfterClaim.incurred - subBeforeClaim.incurred, 8_500),
    `incurred moved by ${subAfterClaim.incurred - subBeforeClaim.incurred}`,
  );

  const owed = await settleable('claim', claim.id);
  check('and is owed back to the person in full', money(owed!.outstanding, 8_500));

  await prisma.payment.create({
    data: {
      number: await nextNumber('disbursement'),
      kind: 'DISBURSEMENT',
      method: 'BANK_TRANSFER',
      paymentDate: dayKey(new Date()),
      payeeUserId: engineer.id,
      amount: D(8_500),
      clearedAt: dayKey(new Date()),
      recordedById: finance.id,
      allocations: { create: [{ claimId: claim.id, amount: D(8_500) }] },
    },
  });
  await prisma.$transaction((tx) => refreshSettlement(tx, 'claim', claim.id));
  const reimbursed = await prisma.expenseClaim.findUnique({ where: { id: claim.id } });
  check('reimbursing it closes the claim', reimbursed?.status === 'REIMBURSED');

  // ══ Cash advances ════════════════════════════════════════════════════════
  console.log('\nCash advances — approval moves no money');

  const settings = await financeSettings();
  const ledgerCount = () => prisma.jobCostEntry.count({ where: { jobId: job.id } });

  const newAdvance = async (who: { id: string }, amount: number, purpose: string) =>
    prisma.cashAdvance.create({
      data: {
        number: await nextNumber('cash_advance'),
        requestedById: who.id,
        jobId: job.id,
        costCategoryId: subcontract.id,
        requestDate: dayKey(new Date()),
        purpose: `${TAG} ${purpose}`,
        amount: D(amount),
      },
    });
  const submitAdvance = async (a: { id: string; number: string; amount: Prisma.Decimal; requestedById: string }) => {
    await prisma.cashAdvance.update({ where: { id: a.id }, data: { status: 'PENDING_APPROVAL' } });
    return submitForApproval({
      documentType: 'cash_advance',
      documentId: a.id,
      documentNumber: a.number,
      subject: `${TAG} advance`,
      amount: num(a.amount),
      requesterId: a.requestedById,
    });
  };
  const release = async (advanceId: string, amount: number, paymentDate: Date) => {
    const payment = await prisma.payment.create({
      data: {
        number: await nextNumber('disbursement'),
        kind: 'DISBURSEMENT',
        method: 'CASH',
        paymentDate,
        payeeUserId: engineer.id,
        amount: D(amount),
        clearedAt: paymentDate,
        recordedById: finance.id,
        allocations: { create: [{ advanceId, amount: D(amount) }] },
      },
    });
    await prisma.$transaction((tx) => refreshSettlement(tx, 'advance', advanceId));
    return payment;
  };
  const liquidate = async (
    a: { id: string; number: string; jobId: string | null; costCategoryId: string | null },
    spent: number[],
  ) => {
    const total = cents(spent.reduce((s, v) => s + v, 0));
    const claim = await prisma.expenseClaim.create({
      data: {
        number: await nextNumber('expense'),
        claimedById: engineer.id,
        advanceId: a.id,
        jobId: a.jobId,
        costCategoryId: a.costCategoryId,
        claimDate: dayKey(new Date()),
        purpose: `${TAG} liquidation of ${a.number}`,
        total: D(total),
        status: 'PENDING_APPROVAL',
        lines: {
          create: spent.map((amount, i) => ({
            sortOrder: i,
            spentOn: dayKey(new Date()),
            description: `Receipt ${i + 1}`,
            receiptNo: `OR-L${i + 1}`,
            amount: D(amount),
          })),
        },
      },
    });
    const request = await submitForApproval({
      documentType: 'expense',
      documentId: claim.id,
      documentNumber: claim.number,
      subject: `${TAG} liquidation`,
      amount: total,
      requesterId: engineer.id,
    });
    return { claim, request };
  };

  // (1) Supervisor, then finance — and nothing reaches the ledger on either.
  const a1 = await newAdvance(engineer, 10_000, 'site mobilisation');
  check('an advance takes a CA number', /^GT-CA-\d{4}-\d{4}$/.test(a1.number), a1.number);
  const ledgerBeforeAdvance = await ledgerCount();
  const a1Request = await submitAdvance(a1);
  await act({ requestId: a1Request.id, userId: pm.id, action: 'APPROVED' });
  const a1Mid = await prisma.cashAdvance.findUnique({ where: { id: a1.id } });
  check(
    'the supervisor alone does not approve an advance — finance is the second step',
    a1Mid?.status === 'PENDING_APPROVAL',
    `status ${a1Mid?.status}`,
  );
  await settle(a1Request.id);
  const a1Approved = await prisma.cashAdvance.findUnique({ where: { id: a1.id } });
  check(
    'both steps approve it',
    a1Approved?.status === 'APPROVED' && !!a1Approved.approvedAt,
    `status ${a1Approved?.status}`,
  );
  check('approval moves no money — the project ledger is untouched', (await ledgerCount()) === ledgerBeforeAdvance);

  // (2) Released in one voucher; the clock starts on the payment date.
  const toRelease = await settleable('advance', a1.id);
  check(
    'an approved advance is owed in full to the person',
    money(toRelease!.outstanding, 10_000),
    `got ${toRelease?.outstanding}`,
  );
  const releaseDate = addDays(dayKey(new Date()), -3);
  const a1Release = await release(a1.id, 10_000, releaseDate);
  const a1Released = await prisma.cashAdvance.findUniqueOrThrow({ where: { id: a1.id } });
  check('releasing it moves it to RELEASED', a1Released.status === 'RELEASED', `status ${a1Released.status}`);
  check('and records what was handed over', money(num(a1Released.amountReleased), 10_000));
  check(
    'the liquidation clock starts on the payment date, not the day it was recorded',
    a1Released.releasedAt?.getTime() === releaseDate.getTime(),
    `${a1Released.releasedAt?.toISOString()} vs ${releaseDate.toISOString()}`,
  );
  check(
    `and the deadline is ${settings.advanceLiquidationDays} days after it`,
    a1Released.liquidationDueDate?.getTime() === addDays(releaseDate, settings.advanceLiquidationDays).getTime(),
    a1Released.liquidationDueDate?.toISOString(),
  );
  check('nothing further is owed on the release', money((await settleable('advance', a1.id))!.outstanding, 0));
  check('and still nothing is charged to the project', (await ledgerCount()) === ledgerBeforeAdvance);

  // (3) Under-spend: the receipts come to 8,500 of the 10,000.
  console.log('\nLiquidation — under-spend');
  const subBeforeL1 = await availableBudget(prisma, job.id, subcontract.id);
  const { claim: l1, request: l1Request } = await liquidate(a1Released, [3_500, 5_000]);
  check('a liquidation carries an EXP number — there is no LIQ series', /^GT-EXP-/.test(l1.number), l1.number);
  await act({ requestId: l1Request.id, userId: pm.id, action: 'APPROVED' });
  const l1Mid = await prisma.expenseClaim.findUnique({ where: { id: l1.id } });
  const subMidL1 = await availableBudget(prisma, job.id, subcontract.id);
  check(
    'the supervisor alone leaves the liquidation pending',
    l1Mid?.status === 'PENDING_APPROVAL',
    `status ${l1Mid?.status}`,
  );
  check('and charges nothing', money(subMidL1.incurred, subBeforeL1.incurred));
  await settle(l1Request.id);
  const l1After = await prisma.expenseClaim.findUnique({ where: { id: l1.id } });
  const a1Liquidated = await prisma.cashAdvance.findUniqueOrThrow({ where: { id: a1.id } });
  check(
    'a liquidation the advance covered is SETTLED — nobody is owed anything on it',
    l1After?.status === 'SETTLED',
    `status ${l1After?.status}`,
  );
  check('the advance now reads REFUND_DUE', a1Liquidated.status === 'REFUND_DUE', `status ${a1Liquidated.status}`);
  check('with what was spent re-derived from the liquidation', money(num(a1Liquidated.amountSpent), 8_500));
  const refundOwed = await settleable('advance_refund', a1.id);
  check('1,500 of unspent cash is owed back', money(refundOwed!.outstanding, 1_500), `got ${refundOwed?.outstanding}`);
  const l1Ledger = await prisma.jobCostEntry.findMany({ where: { sourceType: 'expense_claim', sourceId: l1.id } });
  check(
    'the project is charged once, at what was actually spent',
    l1Ledger.length === 1 && money(num(l1Ledger[0].amount), 8_500) && l1Ledger[0].state === 'INCURRED',
    `${l1Ledger.length} rows, ${l1Ledger.map((r) => num(r.amount)).join(',')}`,
  );
  const subAfterL1 = await availableBudget(prisma, job.id, subcontract.id);
  check('and budget monitoring sees exactly that', money(subAfterL1.incurred - subBeforeL1.incurred, 8_500));
  check('the liquidation itself owes nothing', money((await settleable('claim', l1.id))!.outstanding, 0));

  // (4) The unspent cash comes back as a receipt — and can be reversed.
  const refund = await prisma.payment.create({
    data: {
      number: await nextNumber('payment'),
      kind: 'RECEIPT',
      method: 'CASH',
      paymentDate: dayKey(new Date()),
      payeeUserId: engineer.id,
      amount: D(1_500),
      clearedAt: dayKey(new Date()),
      recordedById: finance.id,
      allocations: { create: [{ advanceId: a1.id, amount: D(1_500) }] },
    },
  });
  await prisma.$transaction((tx) => refreshSettlement(tx, 'advance_refund', a1.id));
  const a1Closed = await prisma.cashAdvance.findUnique({ where: { id: a1.id } });
  check('returning the 1,500 liquidates the advance', a1Closed?.status === 'LIQUIDATED', `status ${a1Closed?.status}`);
  await prisma.$transaction(async (tx) => {
    await tx.payment.delete({ where: { id: refund.id } });
    await refreshSettlement(tx, 'advance_refund', a1.id);
  });
  const a1Reopened = await prisma.cashAdvance.findUnique({ where: { id: a1.id } });
  check(
    'reversing the refund puts it back to REFUND_DUE',
    a1Reopened?.status === 'REFUND_DUE' && money(num(a1Reopened.amountRefunded), 0),
    `status ${a1Reopened?.status}`,
  );

  // (5) Over-spend: 6,200 of receipts against a 5,000 advance.
  console.log('\nLiquidation — over-spend');
  const a2 = await newAdvance(engineer, 5_000, 'emergency parts');
  const a2Request = await submitAdvance(a2);
  await settle(a2Request.id);
  await release(a2.id, 5_000, dayKey(new Date()));
  const a2Released = await prisma.cashAdvance.findUniqueOrThrow({ where: { id: a2.id } });
  const subBeforeL2 = await availableBudget(prisma, job.id, subcontract.id);
  const { claim: l2, request: l2Request } = await liquidate(a2Released, [6_200]);
  await settle(l2Request.id);
  const l2After = await prisma.expenseClaim.findUnique({ where: { id: l2.id } });
  const a2After = await prisma.cashAdvance.findUniqueOrThrow({ where: { id: a2.id } });
  const l2Owed = await settleable('claim', l2.id);
  check(
    'an over-spent liquidation stays APPROVED — the person is owed the excess',
    l2After?.status === 'APPROVED',
    `status ${l2After?.status}`,
  );
  check(
    'the claim is settled against the excess, not its total',
    money(l2Owed!.outstanding, 1_200),
    `got ${l2Owed?.outstanding}`,
  );
  check('the advance is LIQUIDATED — nothing comes back', a2After.status === 'LIQUIDATED', `status ${a2After.status}`);
  const subAfterL2 = await availableBudget(prisma, job.id, subcontract.id);
  check('the project is charged the full 6,200 spent', money(subAfterL2.incurred - subBeforeL2.incurred, 6_200));
  await prisma.payment.create({
    data: {
      number: await nextNumber('disbursement'),
      kind: 'DISBURSEMENT',
      method: 'BANK_TRANSFER',
      paymentDate: dayKey(new Date()),
      payeeUserId: engineer.id,
      amount: D(1_200),
      clearedAt: dayKey(new Date()),
      recordedById: finance.id,
      allocations: { create: [{ claimId: l2.id, amount: D(1_200) }] },
    },
  });
  await prisma.$transaction((tx) => refreshSettlement(tx, 'claim', l2.id));
  const l2Paid = await prisma.expenseClaim.findUnique({ where: { id: l2.id } });
  check('paying the 1,200 excess reimburses the liquidation', l2Paid?.status === 'REIMBURSED', `status ${l2Paid?.status}`);

  // (6) A settle handler called twice does nothing the second time.
  console.log('\nSettling twice');
  const l2Settled = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: l2Request.id } });
  const a2LiquidatedAt = a2After.liquidatedAt?.getTime();
  await settleExpense(l2Settled, 'APPROVED');
  await settleExpense(l2Settled, 'APPROVED');
  const l2Rows = await prisma.jobCostEntry.count({ where: { sourceType: 'expense_claim', sourceId: l2.id } });
  const a2Again = await prisma.cashAdvance.findUnique({ where: { id: a2.id } });
  const l2Notices = await prisma.notification.count({
    where: { userId: engineer.id, title: `${l2.number} approved` },
  });
  check('a repeated expense settlement posts nothing more', l2Rows === 1, `${l2Rows} rows`);
  check('and does not move the liquidation date', a2Again?.liquidatedAt?.getTime() === a2LiquidatedAt);
  check('and tells the person once', l2Notices === 1, `${l2Notices} notifications`);

  const a2Settled = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: a2Request.id } });
  const a2ApprovedAt = (await prisma.cashAdvance.findUniqueOrThrow({ where: { id: a2.id } })).approvedAt?.getTime();
  const auditsBefore = await prisma.auditLog.count({ where: { entityType: 'cash_advance', entityId: a2.id } });
  await settleAdvance(a2Settled, 'APPROVED');
  await settleAdvance(a2Settled, 'APPROVED');
  const a2Final = await prisma.cashAdvance.findUnique({ where: { id: a2.id } });
  const auditsAfter = await prisma.auditLog.count({ where: { entityType: 'cash_advance', entityId: a2.id } });
  check(
    'a repeated advance settlement changes nothing and records nothing',
    a2Final?.status === 'LIQUIDATED' && a2Final.approvedAt?.getTime() === a2ApprovedAt && auditsAfter === auditsBefore,
    `status ${a2Final?.status}, audits ${auditsBefore} → ${auditsAfter}`,
  );

  // The position counts an approved advance against itself before the voucher
  // exists, and a liquidation at what is still owed, never its total.
  const a3 = await newAdvance(engineer, 2_000, 'approved not released');
  await settle((await submitAdvance(a3)).id);
  const position = await financePosition(dayKey(new Date()));
  const toReleaseDirect = (
    await prisma.cashAdvance.findMany({ where: { status: 'APPROVED' } })
  ).reduce((s, a) => s + num(a.amount) - num(a.amountReleased), 0);
  check(
    'advances to release are read straight off the approved advances',
    money(position.advancesToRelease, cents(toReleaseDirect)),
    `${position.advancesToRelease} vs ${cents(toReleaseDirect)}`,
  );
  check(
    'and the working position is receivable less everything owed, advances and project cash included',
    money(
      position.workingPosition,
      cents(position.receivable - position.payable - position.reimbursable - position.advancesToRelease - position.budgetRequestsToRelease),
    ),
  );

  // ══ Budget requests — project cash, on the request's own rules ═══════════
  console.log('\nBudget requests — project cash, liquidated in Expenses');

  // Its own liquidation days, set apart from the advance's so the deadline
  // proves which rule it read.
  // The rules are set aside under a key of their own, as verify-sales does
  // with the PDF layouts, so a run that dies puts them back on the next one.
  const originalRules = await financeSettings();
  await prisma.setting.upsert({
    where: { key: RULES_STASH },
    create: { key: RULES_STASH, value: originalRules as unknown as Prisma.InputJsonValue, description: 'verify-finance: the finance rules before the run' },
    update: { value: originalRules as unknown as Prisma.InputJsonValue },
  });
  await saveFinanceSettings({ budgetRequestLiquidationDays: 45, advanceLiquidationDays: 30 });
  const newRequest = async (who: { id: string }, amount: number, reason: string) =>
    prisma.budgetRequest.create({
      data: {
        number: await nextNumber('budget_request'),
        requestedById: who.id,
        jobId: job.id,
        costCategoryId: subcontract.id,
        reason: `${TAG} ${reason}`,
        amount: D(amount),
      },
    });
  const submitRequest = async (r: { id: string; number: string; amount: Prisma.Decimal; requestedById: string }) => {
    await prisma.budgetRequest.update({ where: { id: r.id }, data: { status: 'PENDING_APPROVAL' } });
    return submitForApproval({
      documentType: 'budget_request',
      documentId: r.id,
      documentNumber: r.number,
      subject: `${TAG} budget request`,
      amount: num(r.amount),
      requesterId: r.requestedById,
      jobId: job.id,
    });
  };
  const releaseRequest = async (id: string, amount: number, paymentDate: Date) => {
    await prisma.payment.create({
      data: {
        number: await nextNumber('disbursement'),
        kind: 'DISBURSEMENT',
        method: 'CASH',
        paymentDate,
        payeeUserId: engineer.id,
        amount: D(amount),
        clearedAt: paymentDate,
        recordedById: finance.id,
        allocations: { create: [{ budgetRequestId: id, amount: D(amount) }] },
      },
    });
    await prisma.$transaction((tx) => refreshSettlement(tx, 'budget_request', id));
  };
  const liquidateRequest = async (r: { id: string; number: string }, spent: number[]) => {
    const total = cents(spent.reduce((s, v) => s + v, 0));
    const claim = await prisma.expenseClaim.create({
      data: {
        number: await nextNumber('expense'),
        claimedById: engineer.id,
        budgetRequestId: r.id,
        jobId: job.id,
        costCategoryId: subcontract.id,
        claimDate: dayKey(new Date()),
        purpose: `${TAG} liquidation of ${r.number}`,
        total: D(total),
        status: 'PENDING_APPROVAL',
        lines: {
          create: spent.map((amount, i) => ({ sortOrder: i, spentOn: dayKey(new Date()), description: `Receipt ${i + 1}`, receiptNo: `OR-B${i + 1}`, amount: D(amount) })),
        },
      },
    });
    const request = await submitForApproval({ documentType: 'expense', documentId: claim.id, documentNumber: claim.number, subject: `${TAG} liquidation`, amount: total, requesterId: engineer.id });
    return { claim, request };
  };

  // (1) The requester's team leader, Back Support, the Finance Manager;
  // nothing on the ledger either way.
  const b1 = await newRequest(engineer, 20_000, 'fittings for the tie-in');
  check('a budget request takes a BR number', /^GT-BR-\d{4}-\d{4}$/.test(b1.number), b1.number);
  const ledgerBeforeRequest = await ledgerCount();
  const b1Request = await submitRequest(b1);
  const b1Step = await prisma.approvalStep.findFirstOrThrow({ where: { workflowId: b1Request.workflowId!, sequence: b1Request.currentSequence } });
  const b1Approvers = await approversForStep(b1Step, engineer.id, prisma, { jobId: job.id });
  check('step 1 is the requester’s team leader — who they report to', b1Approvers.length === 1 && b1Approvers[0] === pm.id, b1Approvers.join(','));
  await act({ requestId: b1Request.id, userId: pm.id, action: 'APPROVED' });
  check('the team leader alone does not approve it — Back Support and the Finance Manager follow', (await prisma.budgetRequest.findUniqueOrThrow({ where: { id: b1.id } })).status === 'PENDING_APPROVAL');
  await settle(b1Request.id);
  const b1Approved = await prisma.budgetRequest.findUniqueOrThrow({ where: { id: b1.id } });
  check('approved, it owes a release and nothing else', b1Approved.status === 'APPROVED' && !!b1Approved.approvedAt, b1Approved.status);
  check('approval moves no money and raises no budget — the ledger is untouched', (await ledgerCount()) === ledgerBeforeRequest);
  check('the whole amount is owed to the team', money((await settleable('budget_request', b1.id))!.outstanding, 20_000));

  // (2) A requester who reports to nobody goes to the Team Leaders — the
  // step's fallback — never to nobody and never to themself.
  const b2 = await newRequest(pm, 5_000, 'the manager’s own');
  const b2Request = await submitRequest(b2);
  const b2Step = await prisma.approvalStep.findFirstOrThrow({ where: { workflowId: b2Request.workflowId!, sequence: b2Request.currentSequence } });
  const b2Approvers = await approversForStep(b2Step, pm.id, prisma, { jobId: job.id });
  const leaders = await prisma.userRole.findMany({ where: { role: { key: 'team_leader' }, user: { isActive: true } }, select: { userId: true } });
  check(
    'a requester with no "Reports to" goes to the Team Leaders, not to themself',
    !b2Approvers.includes(pm.id) && b2Approvers.includes(teamLeader.id) && b2Approvers.every((id) => leaders.some((e) => e.userId === id)),
    b2Approvers.join(','),
  );
  await settle(b2Request.id, 'REJECTED');
  check('rejected, it is REJECTED and owes nothing', (await prisma.budgetRequest.findUniqueOrThrow({ where: { id: b2.id } })).status === 'REJECTED');

  // (3) Released in one voucher, on the request's own deadline.
  const b1ReleaseDate = dayKey(new Date('2026-04-01'));
  await releaseRequest(b1.id, 20_000, b1ReleaseDate);
  const b1Released = await prisma.budgetRequest.findUniqueOrThrow({ where: { id: b1.id } });
  check('the release moves it to RELEASED', b1Released.status === 'RELEASED' && money(num(b1Released.amountReleased), 20_000), b1Released.status);
  check(
    'the deadline is 45 days after the release — the budget request’s own days, not the advance’s 30',
    b1Released.liquidationDueDate?.getTime() === addDays(b1ReleaseDate, 45).getTime(),
    String(b1Released.liquidationDueDate),
  );
  await saveFinanceSettings({ budgetRequestLiquidationDays: 10 });
  await prisma.$transaction((tx) => refreshSettlement(tx, 'budget_request', b1.id));
  check(
    'changing the days never moves a deadline already given',
    (await prisma.budgetRequest.findUniqueOrThrow({ where: { id: b1.id } })).liquidationDueDate?.getTime() === addDays(b1ReleaseDate, 45).getTime(),
  );
  check('and still nothing is charged to the project', (await ledgerCount()) === ledgerBeforeRequest);

  // (4) Under-spend: 17,500 of receipts against 20,000 — the claim settles,
  //     the project is charged 17,500, and 2,500 comes back.
  const { claim: b1Claim, request: b1LiqRequest } = await liquidateRequest(b1, [10_000, 7_500]);
  await settle(b1LiqRequest.id);
  const b1Liquidated = await prisma.budgetRequest.findUniqueOrThrow({ where: { id: b1.id } });
  const b1ClaimAfter = await prisma.expenseClaim.findUniqueOrThrow({ where: { id: b1Claim.id } });
  check('the liquidation the cash covered is SETTLED', b1ClaimAfter.status === 'SETTLED', b1ClaimAfter.status);
  check('the request reads REFUND_DUE', b1Liquidated.status === 'REFUND_DUE' && money(num(b1Liquidated.amountSpent), 17_500), `${b1Liquidated.status} ${b1Liquidated.amountSpent}`);
  check('the project is charged what was spent — the first and only time the cash is cost', (await ledgerCount()) === ledgerBeforeRequest + 1);
  const b1LedgerRow = await prisma.jobCostEntry.findFirst({ where: { sourceType: 'expense_claim', sourceId: b1Claim.id } });
  check('as INCURRED, at the receipts total', b1LedgerRow?.state === 'INCURRED' && money(num(b1LedgerRow.amount), 17_500));
  check('2,500 is owed back', money((await settleable('budget_request_refund', b1.id))!.outstanding, 2_500));
  await prisma.payment.create({
    data: {
      number: await nextNumber('payment'),
      kind: 'RECEIPT',
      method: 'CASH',
      paymentDate: dayKey(new Date()),
      payeeUserId: engineer.id,
      amount: D(2_500),
      clearedAt: dayKey(new Date()),
      recordedById: finance.id,
      allocations: { create: [{ budgetRequestId: b1.id, amount: D(2_500) }] },
    },
  });
  await prisma.$transaction((tx) => refreshSettlement(tx, 'budget_request_refund', b1.id));
  check('returning it liquidates the request', (await prisma.budgetRequest.findUniqueOrThrow({ where: { id: b1.id } })).status === 'LIQUIDATED');

  // (5) Over-spend: 9,000 against 8,000 — the excess is owed on the claim.
  const b3 = await newRequest(engineer, 8_000, 'emergency gaskets');
  await settle((await submitRequest(b3)).id);
  await releaseRequest(b3.id, 8_000, dayKey(new Date()));
  const { claim: b3Claim, request: b3LiqRequest } = await liquidateRequest(b3, [9_000]);
  await settle(b3LiqRequest.id);
  const b3After = await prisma.budgetRequest.findUniqueOrThrow({ where: { id: b3.id } });
  const b3ClaimAfter = await settleable('claim', b3Claim.id);
  check('spending over the release leaves the claim APPROVED for the excess only', money(b3ClaimAfter!.outstanding, 1_000), String(b3ClaimAfter?.outstanding));
  check('and the request is LIQUIDATED — nothing comes back', b3After.status === 'LIQUIDATED', b3After.status);

  // (6) The position counts an approved request against itself, as an advance.
  const b4 = await newRequest(engineer, 3_000, 'approved not released');
  await settle((await submitRequest(b4)).id);
  const positionWithRequest = await financePosition(dayKey(new Date()));
  const requestsToReleaseDirect = (await prisma.budgetRequest.findMany({ where: { status: 'APPROVED' } })).reduce((s, r) => s + num(r.amount) - num(r.amountReleased), 0);
  check('project cash to release is read straight off the approved requests', money(positionWithRequest.budgetRequestsToRelease, cents(requestsToReleaseDirect)), `${positionWithRequest.budgetRequestsToRelease} vs ${cents(requestsToReleaseDirect)}`);
  check(
    'and counts against the working position before the voucher exists',
    money(positionWithRequest.workingPosition, cents(positionWithRequest.receivable - positionWithRequest.payable - positionWithRequest.reimbursable - positionWithRequest.advancesToRelease - positionWithRequest.budgetRequestsToRelease)),
  );
  await restoreRules();

  // ══ Pulled back after approval (2026-10-16) ═══════════════════════════════
  console.log('\nPulled back to draft after approval — advances, budget requests, liquidations');
  const reopenAs = async (userId: string) => (await resolveUser(userId))!;
  const engUser = await reopenAs(engineer.id);
  const refusal = async (type: string, id: string) => {
    try {
      await reopenApproved(type, id, engUser, `${TAG} pulled back`);
      return 'pulled back';
    } catch (err) {
      return `${(err as { status?: number }).status ?? '?'} ${(err as Error).message}`;
    }
  };
  // An advance approved and not released goes back to a draft.
  const ra = await newAdvance(engineer, 1_250, 'approved then pulled back');
  const raRequest = await submitAdvance(ra);
  await settle(raRequest.id);
  const raMay = await mayReopen('cash_advance', ra.id, engUser);
  await reopenApproved('cash_advance', ra.id, engUser, `${TAG} wrong amount`);
  const raAfter = await prisma.cashAdvance.findUniqueOrThrow({ where: { id: ra.id } });
  const raReq = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: raRequest.id } });
  check(
    'the requester pulls back an approved advance nothing was released on: a draft again, the request closed',
    raMay && raAfter.status === 'DRAFT' && raAfter.approvedAt === null && raReq.status === 'CANCELLED' && !!raReq.reopenedAt,
    `${raMay} ${raAfter.status} ${raReq.status}`,
  );
  const a4Refused = await refusal('cash_advance', a2.id);
  check('a released advance is refused, naming the release', a4Refused.startsWith('400') && a4Refused.includes('released'), a4Refused);
  // A budget request the same way.
  const rb = await newRequest(engineer, 2_000, 'approved then pulled back');
  await settle((await submitRequest(rb)).id);
  await reopenApproved('budget_request', rb.id, engUser, `${TAG} not needed yet`);
  check('an approved budget request nothing was released on goes back to a draft', (await prisma.budgetRequest.findUniqueOrThrow({ where: { id: rb.id } })).status === 'DRAFT');
  const b3Refused = await refusal('budget_request', b3.id);
  check('a released budget request is refused, naming the release', b3Refused.startsWith('400') && b3Refused.includes('released'), b3Refused);
  // A liquidation: the cost comes back off the project, the advance awaits it again.
  const rl = await newAdvance(engineer, 4_000, 'liquidated then pulled back');
  await settle((await submitAdvance(rl)).id);
  await release(rl.id, 4_000, dayKey(new Date()));
  const rlIncurredBefore = (await availableBudget(prisma, job.id, subcontract.id)).incurred;
  const { claim: rlClaim, request: rlLiq } = await liquidate(await prisma.cashAdvance.findUniqueOrThrow({ where: { id: rl.id } }), [3_000]);
  await settle(rlLiq.id);
  const rlLiquidated = await prisma.cashAdvance.findUniqueOrThrow({ where: { id: rl.id } });
  await reopenApproved('expense', rlClaim.id, engUser, `${TAG} a receipt was missing`);
  const rlClaimAfter = await prisma.expenseClaim.findUniqueOrThrow({ where: { id: rlClaim.id } });
  const rlAfter = await prisma.cashAdvance.findUniqueOrThrow({ where: { id: rl.id } });
  const rlIncurredAfter = (await availableBudget(prisma, job.id, subcontract.id)).incurred;
  const rlRows = await prisma.jobCostEntry.findMany({ where: { sourceType: 'expense_claim', sourceId: rlClaim.id } });
  check(
    'a settled liquidation pulled back: a draft, its 3,000 reversed by a negative row, and the advance RELEASED again',
    rlLiquidated.status === 'REFUND_DUE' &&
      rlClaimAfter.status === 'DRAFT' &&
      !rlClaimAfter.postedToJob &&
      rlRows.length === 2 &&
      money(rlRows.reduce((t, r) => t + num(r.amount), 0), 0) &&
      money(rlIncurredAfter, rlIncurredBefore) &&
      rlAfter.status === 'RELEASED' &&
      money(num(rlAfter.amountSpent), 0),
    `${rlLiquidated.status} → ${rlClaimAfter.status}, ${rlRows.length} rows, ${rlIncurredBefore} → ${rlIncurredAfter}, advance ${rlAfter.status}`,
  );
  // Approved again, it charges once more — and only once.
  await prisma.expenseClaim.update({ where: { id: rlClaim.id }, data: { status: 'PENDING_APPROVAL' } });
  const rlAgain = await submitForApproval({ documentType: 'expense', documentId: rlClaim.id, documentNumber: rlClaim.number, subject: `${TAG} liquidation again`, amount: 3_000, requesterId: engineer.id });
  await settle(rlAgain.id);
  check(
    'sent and approved again, the project carries the 3,000 once',
    money((await availableBudget(prisma, job.id, subcontract.id)).incurred, rlIncurredBefore + 3_000) &&
      (await prisma.cashAdvance.findUniqueOrThrow({ where: { id: rl.id } })).status === 'REFUND_DUE',
  );
  const l2Refused = await refusal('expense', l2.id);
  check('a reimbursed claim is refused, naming the payment', l2Refused.startsWith('400') && l2Refused.includes('paid'), l2Refused);
  const b1ClaimRefused = await refusal('expense', b1Claim.id);
  check('a liquidation whose unspent cash came back is refused, naming the refund', b1ClaimRefused.startsWith('400') && b1ClaimRefused.includes(b1.number), b1ClaimRefused);
  const someoneElse = await reopenAs(pm.id);
  check('someone else’s approved claim is not theirs to pull back', !(await mayReopen('expense', rlClaim.id, someoneElse)));

  // Fixtures for the route cases below: one released and not liquidated, and
  // one that belongs to somebody else.
  const a4 = await newAdvance(engineer, 3_000, 'released not liquidated');
  await settle((await submitAdvance(a4)).id);
  await release(a4.id, 3_000, dayKey(new Date()));
  const a5 = await newAdvance(pm, 1_000, 'somebody else');

  // ══ Route guards, over HTTP ══════════════════════════════════════════════
  // ══ Commission arithmetic (2026-10-16) ══════════════════════════════════
  console.log('\nCommissions — the owner’s sample, worked through shared/commission.ts and its web copy');
  const sampleInput = {
    totalAmount: 1_120_000,
    vatAmount: 120_000,
    totalCost: 650_000,
    collectedAmount: 1_120_000,
    ratePct: 0.1,
    shares: [
      { sharePct: 0.6, taxPct: 0.1, caDeduction: 3_000 },
      { sharePct: 0.4, taxPct: 0.1, caDeduction: 0 },
    ],
  };
  const sample = commissionFigures(sampleInput);
  check(
    'actual margin = collected − VAT − cost = 350,000; 10% of it is 35,000 gross',
    money(sample.netOfVat, 1_000_000) && money(sample.margin, 350_000) && money(sample.grossCommission, 35_000),
    JSON.stringify(sample).slice(0, 200),
  );
  check(
    'Brian 60%: 21,000 less 2,100 tax and 3,000 CA = 15,900; Sarah 40%: 14,000 less 1,400 = 12,600',
    money(sample.shares[0].share, 21_000) && money(sample.shares[0].tax, 2_100) && money(sample.shares[0].net, 15_900) &&
      money(sample.shares[1].share, 14_000) && money(sample.shares[1].tax, 1_400) && money(sample.shares[1].net, 12_600),
    JSON.stringify(sample.shares),
  );
  check(
    'the totals are 35,000 / 3,500 / 3,000 / 28,500',
    money(sample.totalShare, 35_000) && money(sample.totalTax, 3_500) && money(sample.totalCa, 3_000) && money(sample.totalNet, 28_500) && sample.sharesComplete,
  );
  const thirds = commissionFigures({ ...sampleInput, totalCost: 650_000.01, ratePct: 0.0733, shares: [1, 2, 3].map(() => ({ sharePct: 0.333333, taxPct: 0.1, caDeduction: 0 })).map((x, i) => (i === 2 ? { ...x, sharePct: 0.333334 } : x)) });
  check('three awkward thirds still add up to the gross to the centavo', money(thirds.totalShare, thirds.grossCommission), `${thirds.totalShare} vs ${thirds.grossCommission}`);
  let mirrorSame = true;
  for (let i = 0; i < 300; i++) {
    const r = (n: number) => Math.round(Math.random() * n * 100) / 100;
    const k = 1 + Math.floor(Math.random() * 4);
    const raw = Array.from({ length: k }, () => 1 + Math.floor(Math.random() * 100));
    const sumRaw = raw.reduce((a, b) => a + b, 0);
    const pcts = raw.map((x) => Math.round((x / sumRaw) * 1_000_000) / 1_000_000);
    pcts[k - 1] = Math.round((1 - pcts.slice(0, -1).reduce((a, b) => a + b, 0)) * 1_000_000) / 1_000_000;
    const input = {
      totalAmount: r(5_000_000),
      vatAmount: r(500_000),
      totalCost: r(3_000_000),
      collectedAmount: r(5_000_000),
      ratePct: Math.round(Math.random() * 200_000) / 1_000_000,
      shares: pcts.map((p) => ({ sharePct: p, taxPct: [0.1, 0.05, 0.15][i % 3], caDeduction: r(1_000) })),
    };
    if (JSON.stringify(commissionFigures(input)) !== JSON.stringify(webCommissionFigures(input))) mirrorSame = false;
  }
  check('the web copy (lib/commission.ts) gives the same figures on 300 random requests', mirrorSame);

  console.log('\nRoute guards (over HTTP)');

  const reachable = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) })
    .then((r) => r.ok)
    .catch(() => false);

  if (!reachable) {
    failed += 1;
    console.log(
      `  ✗ the API is not reachable at ${BASE} — the route guards were NOT verified.\n` +
        '      Start it with "npm run dev" in api/ and run this script again.',
    );
  } else {
    const { signToken } = await import('../src/auth/middleware');
    const token = signToken(finance.id, finance.email);
    const api = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : {} };
    };

    // A list filter's value is checked against its choices' VALUES (shared/
    // listPaper's `choice`): a prototype key such as "toString" once passed an
    // `in Enum` test and reached the database as a 500; a malformed day read
    // as Invalid Date. Both are a 400 naming the choices in words.
    const [protoStatus, protoKind, impossibleDay] = await Promise.all([
      api('GET', '/invoices?status=toString'),
      api('GET', '/payments?kind=constructor'),
      api('GET', '/invoices?from=2026-13-01'),
    ]);
    check(
      'a filter value that is a prototype key is a 400 naming the choices in words, never a 500',
      protoStatus.status === 400 && String(protoStatus.body.error).includes('Partially paid') &&
        protoKind.status === 400 && String(protoKind.body.error).includes('Money in'),
      `${protoStatus.status} ${JSON.stringify(protoStatus.body).slice(0, 120)} · ${protoKind.status} ${JSON.stringify(protoKind.body).slice(0, 120)}`,
    );
    check('and an impossible day is a 400, never a 500', impossibleDay.status === 400, `${impossibleDay.status} ${JSON.stringify(impossibleDay.body).slice(0, 120)}`);

    const doubleInvoice = await api('POST', `/invoices/from-billing/${billing.id}`);
    check(
      'a billing that has been invoiced cannot be invoiced again',
      doubleInvoice.status === 400 && String(doubleInvoice.body.error).includes('already been invoiced'),
      `${doubleInvoice.status} ${JSON.stringify(doubleInvoice.body).slice(0, 120)}`,
    );

    const overApply = await api('POST', '/payments', {
      kind: 'RECEIPT',
      customerId: customer.id,
      allocations: [{ kind: 'invoice', id: thirdInvoice.id, amount: 5_000 }],
    });
    check(
      'a payment cannot be applied to an invoice that is already settled',
      overApply.status === 400 && String(overApply.body.error).includes('outstanding'),
      `${overApply.status} ${JSON.stringify(overApply.body).slice(0, 140)}`,
    );

    const fourth = await api('POST', '/invoices', {
      customerId: customer.id,
      lines: [{ description: `${TAG} standalone`, amount: 10_000 }],
    });
    check('a standalone invoice can be raised', fourth.status === 201, String(fourth.status));
    check(
      'and computes its own tax the same way',
      money(fourth.body.invoiceTotal, 11_200) && money(fourth.body.netCollectible, 11_000),
      `${fourth.body.invoiceTotal} / ${fourth.body.netCollectible}`,
    );

    const overAllocate = await api('POST', '/payments', {
      kind: 'RECEIPT',
      customerId: customer.id,
      allocations: [{ kind: 'invoice', id: fourth.body.id, amount: 11_200 }],
    });
    check(
      'a customer cannot be recorded as paying the invoice total when EWT was withheld',
      overAllocate.status === 400 && String(overAllocate.body.error).includes('11000'),
      `${overAllocate.status} ${JSON.stringify(overAllocate.body).slice(0, 160)}`,
    );

    const wrongDirection = await api('POST', '/payments', {
      kind: 'DISBURSEMENT',
      allocations: [{ kind: 'invoice', id: fourth.body.id, amount: 100 }],
    });
    check(
      'money going out cannot be applied to a customer invoice',
      wrongDirection.status === 400,
      String(wrongDirection.status),
    );

    const badDue = await api('POST', '/invoices', {
      customerId: customer.id,
      invoiceDate: '2026-09-30',
      dueDate: '2026-09-01',
      lines: [{ description: `${TAG} backwards`, amount: 1000 }],
    });
    check(
      'a due date before the invoice date is refused',
      badDue.status === 400 && String(badDue.body.error).includes('before the invoice date'),
      `${badDue.status} ${JSON.stringify(badDue.body).slice(0, 120)}`,
    );

    const aging = await api('GET', '/finance-reports/ar-aging');
    check('the aging report runs', aging.status === 200, String(aging.status));
    const agingTotal = aging.body.totalOutstanding as number;
    const bucketSum = (aging.body.buckets as { amount: number }[]).reduce((s, b) => s + b.amount, 0);
    check(
      'and its buckets add up to its total',
      money(bucketSum, agingTotal),
      `${bucketSum} vs ${agingTotal}`,
    );
    check(
      'the withheld tax is reported separately from the outstanding balance',
      typeof aging.body.withheldAwaitingCertificate === 'number',
    );

    const bva = await api('GET', `/finance-reports/budget-vs-actual?jobId=${job.id}`);
    check('budget vs actual runs for one job', bva.status === 200 && bva.body.jobs.length === 1);
    const row = bva.body.jobs[0];
    check(
      'available is budgeted less committed less incurred, with consumed never subtracted',
      money(row.available, cents(row.budgeted - row.committed - row.incurred)),
      `${row.available} vs ${row.budgeted} − ${row.committed} − ${row.incurred}`,
    );
    check(
      'it shows what has been billed but not yet collected',
      money(row.uncollected, cents(row.invoiced - row.collected)),
      `${row.uncollected} vs ${row.invoiced} − ${row.collected}`,
    );

    const cash = await api('GET', '/finance-reports/cash-flow?months=3');
    check('cash flow runs', cash.status === 200 && Array.isArray(cash.body.months));
    check(
      'an uncleared cheque is neither in the actuals nor in the forecast',
      (cash.body.uncleared as unknown[]).length >= 0 && typeof cash.body.unclearedIn === 'number',
    );

    const dashboard = await api('GET', '/finance-reports/dashboard');
    check('the executive dashboard runs', dashboard.status === 200, String(dashboard.status));
    check(
      'and its receivable figure is the net collectible still owed',
      typeof dashboard.body.receivable === 'number' && dashboard.body.receivable >= 0,
      `receivable ${dashboard.body.receivable}`,
    );
    check(
      'it counts the work waiting to be invoiced and billed',
      typeof dashboard.body.queue.billingsAwaitingInvoice === 'number' &&
        typeof dashboard.body.queue.receivingsAwaitingBill === 'number',
    );

    const badBuckets = await api('PUT', '/finance-settings', { agingBuckets: [60, 30, 90] });
    check(
      'an aging bucket list out of order is refused',
      badBuckets.status === 400 && String(badBuckets.body.error).includes('increasing order'),
      `${badBuckets.status} ${JSON.stringify(badBuckets.body).slice(0, 120)}`,
    );

    const goodBuckets = await api('PUT', '/finance-settings', { agingBuckets: [30, 60, 90], defaultTermsDays: 30 });
    check(
      'finance owns its own rules without being a system administrator',
      goodBuckets.status === 200,
      `${goodBuckets.status} ${JSON.stringify(goodBuckets.body).slice(0, 120)}`,
    );

    const engineerToken = signToken(engineer.id, engineer.email);
    const nosy = await fetch(`${BASE}/finance-reports/ar-aging`, {
      headers: { Authorization: `Bearer ${engineerToken}` },
    });
    check('and an engineer cannot read the aging report', nosy.status === 403, String(nosy.status));

    // ══ Cash advances and liquidations, over HTTP ═════════════════════════
    console.log('\nCash advances (over HTTP)');

    const as = (user: { id: string; email: string }) => {
      const t = signToken(user.id, user.email);
      return async (method: string, path: string, body?: unknown) => {
        const res = await fetch(`${BASE}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${t}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const type = res.headers.get('content-type') ?? '';
        if (type.includes('application/pdf')) {
          return { status: res.status, type, body: {} as Record<string, unknown>, bytes: Buffer.from(await res.arrayBuffer()) };
        }
        const text = await res.text();
        return { status: res.status, type, body: text ? JSON.parse(text) : {}, bytes: null as Buffer | null };
      };
    };
    const eng = as(engineer);
    const fin = as(finance);
    // Money on paper: a total names the company's currency, a table's figures do not.
    const currency = (await prisma.company.findUnique({ where: { id: 'company' }, select: { currency: true } }))?.currency?.trim() || 'PHP';
    const peso = (n: number) => `${currency} ${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const receipt1 = [{ spentOn: todayIso, description: 'Fuel', receiptNo: 'OR-9', amount: 2_500 }];

    // ── Budget requests over HTTP: raise, route, release, liquidate ──────────
    console.log('\nBudget requests — the routes');
    const manager = as(pm);
    const raised = await eng('POST', '/budget-requests', { jobId: job.id, costCategoryId: subcontract.id, amount: 6_000, reason: `${TAG} scaffold hire`, neededBy: todayIso });
    check('an engineer raises a budget request on the project', raised.status === 201 && raised.body.status === 'DRAFT', `${raised.status} ${JSON.stringify(raised.body).slice(0, 120)}`);
    const raisedId = String(raised.body.id);
    const draftPage = await eng('GET', `/budget-requests/${raisedId}`);
    check(
      'the draft names its route — the team leader, back support, the finance manager — before it is submitted',
      draftPage.status === 200 &&
        draftPage.body.approvalRoute?.steps?.[0]?.approvers?.some((p: { id: string }) => p.id === pm.id) &&
        draftPage.body.approvalRoute?.steps?.[1]?.approvers?.some((p: { id: string }) => p.id === backSup.id) &&
        draftPage.body.approvalRoute?.steps?.[2]?.approvers?.some((p: { id: string }) => p.id === finMgr.id),
      String(JSON.stringify(draftPage.body.approvalRoute ?? draftPage.body)).slice(0, 200),
    );
    const brDraftPdf = await eng('GET', `/budget-requests/${raisedId}/pdf`);
    const brDraftText = brDraftPdf.bytes ? pdfText(brDraftPdf.bytes) : '';
    const brSteps = ((draftPage.body.approvalRoute?.steps ?? []) as { name: string }[]).map((st) => st.name.toUpperCase());
    check(
      'and prints it: each step by its own name — never "Approved by — …" — "Pending" under each',
      brDraftPdf.status === 200 &&
        brSteps.length === 3 &&
        brSteps.every((st) => flat(brDraftText).includes(st)) &&
        !flat(brDraftText).includes('APPROVED BY') &&
        !flat(brDraftText).includes('RECEIVED BY') &&
        // "A or B" wraps where the names run long: read them across the breaks.
        flat(brDraftText).includes(pm.name) &&
        flat(brDraftText).includes(finMgr.name) &&
        signedCount(brDraftText) === 1 &&
        pendingCount(brDraftText) === 3,
      `${brDraftPdf.status} ${brSteps.join(' / ')} · ${signedCount(brDraftText)} signed, ${pendingCount(brDraftText)} pending`,
    );
    const bothKinds = await eng('POST', '/expense-claims', { purpose: `${TAG} both`, advanceId: a4.id, budgetRequestId: raisedId, lines: receipt1 });
    check('a claim cannot liquidate an advance and a budget request at once', bothKinds.status === 400, String(bothKinds.status));
    const tooEarly = await eng('POST', '/expense-claims', { purpose: `${TAG} too early`, budgetRequestId: raisedId, lines: receipt1 });
    check('nothing can be liquidated before the cash is released', tooEarly.status === 400, String(tooEarly.status));
    const submitted = await eng('POST', `/budget-requests/${raisedId}/submit`);
    check('submitting sends it to the manager', submitted.status === 200 && submitted.body.status === 'PENDING_APPROVAL', String(submitted.status));
    const managerQueue = await pendingFor(pm.id);
    check('and it sits in the manager’s queue', managerQueue.some((r) => r.documentId === raisedId));
    const strangerRead = await as(stranger)('GET', `/budget-requests/${raisedId}`);
    check('a stranger cannot open it', strangerRead.status === 403, String(strangerRead.status));
    const managerRead = await manager('GET', `/budget-requests/${raisedId}`);
    check('the manager can — they are asked to decide it', managerRead.status === 200, String(managerRead.status));
    const openReq = await prisma.approvalRequest.findFirstOrThrow({ where: { documentType: 'budget_request', documentId: raisedId, status: 'PENDING' } });
    await act({ requestId: openReq.id, userId: pm.id, action: 'APPROVED' });
    await settle(openReq.id);
    const half = await fin('POST', '/payments', { kind: 'DISBURSEMENT', method: 'CASH', payeeUserId: engineer.id, allocations: [{ kind: 'budget_request', id: raisedId, amount: 3_000 }] });
    check('half of it cannot be released — one voucher', half.status === 400 && String(half.body.error).includes('one voucher'), `${half.status} ${JSON.stringify(half.body).slice(0, 120)}`);
    const whole = await fin('POST', '/payments', { kind: 'DISBURSEMENT', method: 'CASH', payeeUserId: engineer.id, allocations: [{ kind: 'budget_request', id: raisedId, amount: 6_000 }] });
    const afterRelease = await eng('GET', `/budget-requests/${raisedId}`);
    check(
      'finance releases the whole amount and the request reads RELEASED with its deadline',
      whole.status === 201 && afterRelease.body.status === 'RELEASED' && !!afterRelease.body.liquidationDueDate && afterRelease.body.allocations?.length === 1,
      `${whole.status} ${afterRelease.body.status}`,
    );
    const told = await prisma.notification.findFirst({ where: { userId: engineer.id, title: { contains: 'released' }, link: `/g-ops/budget-requests/${raisedId}` } });
    check('the team is told the cash is out and when the receipts are due', !!told);
    const strangerLiq = await as(stranger)('POST', '/expense-claims', { purpose: `${TAG} not mine`, budgetRequestId: raisedId, lines: receipt1 });
    check('only the person who raised it can liquidate it', strangerLiq.status === 403 || strangerLiq.status === 400, String(strangerLiq.status));
    const liq = await eng('POST', '/expense-claims', { purpose: `${TAG} scaffold receipts`, budgetRequestId: raisedId, lines: [{ spentOn: todayIso, description: 'Scaffold', receiptNo: 'OR-S1', amount: 6_000 }] });
    check(
      'the liquidation is filed in Expenses against the request, on the project and budget line it was approved for',
      liq.status === 201 && liq.body.kind === 'liquidation' && liq.body.budgetRequest?.id === raisedId && liq.body.job?.id === job.id && liq.body.costCategory?.id === subcontract.id,
      `${liq.status} ${JSON.stringify(liq.body).slice(0, 160)}`,
    );
    const second = await eng('POST', '/expense-claims', { purpose: `${TAG} twice`, budgetRequestId: raisedId, lines: receipt1 });
    check('a second liquidation of the same request is refused', second.status === 400, String(second.status));
    const finList = await fin('GET', `/budget-requests?jobId=${job.id}&status=RELEASED&pageSize=100`);
    check('finance’s Budget Requests lists it as released', finList.status === 200 && finList.body.rows.some((r: { id: string }) => r.id === raisedId), String(finList.status));
    const liqList = await fin('GET', `/expense-claims?kind=liquidation&budgetRequestId=${raisedId}`);
    check('the Expenses register filters liquidations by budget request', liqList.status === 200 && liqList.body.rows.length === 1 && liqList.body.rows[0].id === liq.body.id, String(liqList.status));
    const brPdf = await fin('GET', `/budget-requests/${raisedId}/pdf`);
    const brRaw = brPdf.bytes ? pdfText(brPdf.bytes) : '';
    // Whitespace folded: a long sign-off role wraps onto a second line.
    const brText = flat(brRaw);
    check(
      'the request prints with every step signed and dated, and who received the cash',
      brPdf.status === 200 &&
        // The document names itself in capitals, in the quotation's dress.
        brText.includes('BUDGET REQUEST') &&
        brSteps.every((st) => brText.includes(st)) &&
        brText.includes('RECEIVED BY') &&
        !brText.includes('APPROVED BY') &&
        signedCount(brRaw) === 5 &&
        pendingCount(brRaw) === 0,
      `${brPdf.status} ${signedCount(brRaw)} signed, ${pendingCount(brRaw)} pending · ${brText.slice(0, 300)}`,
    );
    const brMoney = labelRuns(brPdf.bytes, ['Amount requested', 'Released']);
    check(
      'its money is the totals block: requested, then released, the last in bold',
      brMoney.map((r) => r.text).join(',') === 'Amount requested,Released' &&
        brMoney.map((r) => r.bold).join(',') === 'false,true' &&
        brRaw.includes(peso(6_000)) &&
        !brRaw.includes('AMOUNT REQUESTED'),
      `${labelsSaid(brMoney)} · ${brRaw.split('\n').filter((l) => /requested|Released/i.test(l)).join(' | ')}`,
    );
    check('both prints are on the request’s trail as EXPORTED', (await exportsOf('budget_request', raisedId)) === 2);
    const reversal = await fin('DELETE', `/payments/${whole.body.id}`);
    check('the release cannot be reversed while a liquidation accounts for it', reversal.status === 400, String(reversal.status));

    // (8) One advance at a time, unless finance switches the rule off.
    const blocked = await eng('POST', '/cash-advances', { purpose: `${TAG} second trip`, amount: 500 });
    check(
      'a person holding an unliquidated advance is refused another',
      blocked.status === 400 && String(blocked.body.error).includes('not been liquidated'),
      `${blocked.status} ${JSON.stringify(blocked.body).slice(0, 140)}`,
    );
    const rule = settings.blockAdvanceWhileUnliquidated;
    await saveFinanceSettings({ blockAdvanceWhileUnliquidated: false });
    try {
      const allowed = await eng('POST', '/cash-advances', { purpose: `${TAG} second trip`, amount: 500 });
      check(
        'and allowed one when finance turns the rule off',
        allowed.status === 201 && /^GT-CA-/.test(String(allowed.body.number)),
        `${allowed.status} ${JSON.stringify(allowed.body).slice(0, 140)}`,
      );
      // A draft prints the route submitting it WOULD take (rule 6): every step
      // by its own name, open, with "Pending" under who may sign it — the
      // engineer's supervisor by name — and no receipt that has not happened.
      const draftAdvancePdf = await eng('GET', `/cash-advances/${allowed.body.id}/pdf`);
      const draftAdvanceText = draftAdvancePdf.bytes ? pdfText(draftAdvancePdf.bytes) : '';
      const advanceSteps = await stepNames(a1Request.workflowId);
      check(
        'a draft advance prints the route it would take: each step by its name, "Pending" under who may sign it',
        draftAdvancePdf.status === 200 &&
          flat(draftAdvanceText).includes('REQUESTED BY') &&
          advanceSteps.length > 0 &&
          advanceSteps.every((st) => flat(draftAdvanceText).includes(st)) &&
          !flat(draftAdvanceText).includes('CHECKED BY') &&
          !flat(draftAdvanceText).includes('APPROVED BY') &&
          !flat(draftAdvanceText).includes('RECEIVED BY') &&
          draftAdvanceText.includes(pm.name) &&
          signedCount(draftAdvanceText) === 1 &&
          pendingCount(draftAdvanceText) === advanceSteps.length,
        `${draftAdvancePdf.status} ${advanceSteps.join(' / ')} · ${signedCount(draftAdvanceText)} signed, ${pendingCount(draftAdvanceText)} pending`,
      );
      check(
        'and its money is a totals block of one row, the amount requested',
        draftAdvanceText.includes('Amount requested') &&
          draftAdvanceText.includes(peso(500)) &&
          !draftAdvanceText.includes('AMOUNT REQUESTED') &&
          draftAdvanceText.includes('Not yet released') &&
          draftAdvanceText.includes('Draft'),
        draftAdvanceText.split('\n').filter((l) => /requested|released|Draft/i.test(l)).join(' | '),
      );

      // A super admin may submit somebody else's draft — but the request is
      // filed in the REQUESTER's name, so it runs on their supervisor (the one
      // the draft's paper named) and the self-approval rule still sees whose
      // advance it is.
      const root = await prisma.user.create({
        data: { name: `${TAG} Root`, email: 'root@verifyf.local', passwordHash: await bcrypt.hash('x', 10), isSuperAdmin: true },
      });
      const rootSubmit = await as(root)('POST', `/cash-advances/${allowed.body.id}/submit`);
      const rootRequest = await prisma.approvalRequest.findFirst({
        where: { documentType: 'cash_advance', documentId: String(allowed.body.id), status: 'PENDING' },
      });
      check(
        'a super admin submitting someone’s advance files it in the requester’s name, on their supervisor',
        rootSubmit.status === 200 &&
          rootRequest?.requesterId === engineer.id &&
          String(rootRequest?.subject).startsWith(engineer.name) &&
          (await approversForStep(
            (await prisma.approvalStep.findFirstOrThrow({ where: { workflowId: rootRequest.workflowId ?? '', sequence: rootRequest.currentSequence } })),
            rootRequest.requesterId,
          )).includes(pm.id),
        `${rootSubmit.status} requester ${rootRequest?.requesterId === engineer.id ? 'the engineer' : rootRequest?.requesterId} · ${rootRequest?.subject}`,
      );
      // Cancelled while pending: no approval is coming, so nothing is "Pending".
      const advCancel = await eng('POST', `/cash-advances/${allowed.body.id}/cancel`, { reason: 'trip called off' });
      const cancelledAdvancePdf = await eng('GET', `/cash-advances/${allowed.body.id}/pdf`);
      const cancelledAdvanceText = cancelledAdvancePdf.bytes ? pdfText(cancelledAdvancePdf.bytes) : '';
      check(
        'cancelled while pending, it prints REQUESTED BY alone, dated — no step, nothing "Pending"',
        advCancel.status === 200 &&
          cancelledAdvancePdf.status === 200 &&
          flat(cancelledAdvanceText).includes('REQUESTED BY') &&
          advanceSteps.every((st) => !flat(cancelledAdvanceText).includes(st)) &&
          !flat(cancelledAdvanceText).includes('APPROVED BY') &&
          signedCount(cancelledAdvanceText) === 1 &&
          pendingCount(cancelledAdvanceText) === 0 &&
          cancelledAdvanceText.includes('Cancelled'),
        `${advCancel.status} ${cancelledAdvancePdf.status} · ${signedCount(cancelledAdvanceText)} signed, ${pendingCount(cancelledAdvanceText)} pending`,
      );
    } finally {
      await saveFinanceSettings({ blockAdvanceWhileUnliquidated: rule });
    }
    const unbudgeted = await eng('POST', '/cash-advances', {
      purpose: `${TAG} no budget line`,
      amount: 500,
      jobId: job.id,
    });
    check(
      'naming a project on an advance means naming a budget line',
      unbudgeted.status === 400,
      `${unbudgeted.status} ${JSON.stringify(unbudgeted.body).slice(0, 120)}`,
    );

    // (9) Scope.
    const mine = await eng('GET', '/cash-advances?pageSize=100');
    const mineRows = (mine.body.rows ?? []) as { id: string; requestedBy: { id: string } }[];
    check(
      'view_own sees only its own advances',
      mine.status === 200 &&
        mineRows.length > 0 &&
        mineRows.every((r) => r.requestedBy.id === engineer.id) &&
        mineRows.some((r) => r.id === a1.id) &&
        !mineRows.some((r) => r.id === a5.id),
      `${mine.status}, ${mineRows.length} rows`,
    );
    const theirs = await eng('GET', `/cash-advances/${a5.id}`);
    check('and cannot open somebody else’s', theirs.status === 403, String(theirs.status));
    const nobody = await as(stranger)('GET', '/cash-advances');
    check('a user with no cash-advance permission is refused the list', nobody.status === 403, String(nobody.status));

    // Liquidation rules at the route.
    const early = await eng('POST', '/expense-claims', {
      advanceId: a3.id,
      purpose: `${TAG} too early`,
      lines: receipt1,
    });
    check(
      'an advance that has not been released cannot be liquidated',
      early.status === 400 && String(early.body.error).includes('not been released'),
      `${early.status} ${JSON.stringify(early.body).slice(0, 140)}`,
    );
    const elsewhere = await eng('POST', '/expense-claims', {
      advanceId: a4.id,
      jobId: 'zz-some-other-project',
      purpose: `${TAG} wrong project`,
      lines: receipt1,
    });
    check(
      'a liquidation cannot move the cost to a different project',
      elsewhere.status === 400 && String(elsewhere.body.error).includes('different project'),
      `${elsewhere.status} ${JSON.stringify(elsewhere.body).slice(0, 140)}`,
    );
    const firstLiq = await eng('POST', '/expense-claims', {
      advanceId: a4.id,
      purpose: `${TAG} liquidating`,
      lines: receipt1,
    });
    check(
      'the liquidation takes its project and budget line from the advance',
      firstLiq.status === 201 &&
        firstLiq.body.jobId === job.id &&
        firstLiq.body.costCategoryId === subcontract.id &&
        firstLiq.body.kind === 'liquidation',
      `${firstLiq.status} ${JSON.stringify(firstLiq.body).slice(0, 160)}`,
    );
    const secondLiq = await eng('POST', '/expense-claims', {
      advanceId: a4.id,
      purpose: `${TAG} liquidating again`,
      lines: receipt1,
    });
    check(
      'one live liquidation per advance',
      secondLiq.status === 400 && String(secondLiq.body.error).includes('already being liquidated'),
      `${secondLiq.status} ${JSON.stringify(secondLiq.body).slice(0, 140)}`,
    );

    // Modifying a draft liquidation keeps what it accounts for (Phase 2).
    const liqElsewhere = await eng('PUT', `/expense-claims/${firstLiq.body.id}`, {
      advanceId: a4.id,
      jobId: 'zz-some-other-project',
      purpose: `${TAG} liquidating`,
      lines: receipt1,
    });
    check(
      'modifying a liquidation cannot move its cost to a different project',
      liqElsewhere.status === 400 && String(liqElsewhere.body.error).includes('different project'),
      `${liqElsewhere.status} ${JSON.stringify(liqElsewhere.body).slice(0, 140)}`,
    );
    const liqModified = await eng('PUT', `/expense-claims/${firstLiq.body.id}`, {
      purpose: `${TAG} liquidating, corrected`,
      lines: [...receipt1, { spentOn: todayIso, description: 'Toll', receiptNo: 'OR-10', amount: 120 }],
    });
    check(
      'modified with no advance named, a liquidation keeps its advance, project and budget line',
      liqModified.status === 200 &&
        liqModified.body.advance?.id === a4.id &&
        liqModified.body.jobId === job.id &&
        liqModified.body.costCategoryId === subcontract.id &&
        liqModified.body.kind === 'liquidation' &&
        money(liqModified.body.total, 2_620),
      `${liqModified.status} ${JSON.stringify(liqModified.body).slice(0, 200)}`,
    );

    // (7) Cancelling, and reversing a release.
    const partial = await fin('POST', '/payments', {
      kind: 'DISBURSEMENT',
      method: 'CASH',
      payeeUserId: engineer.id,
      allocations: [{ kind: 'advance', id: a3.id, amount: 1_000 }],
    });
    check(
      'an advance is released in one voucher — part of it is refused',
      partial.status === 400 && String(partial.body.error).includes('one voucher'),
      `${partial.status} ${JSON.stringify(partial.body).slice(0, 140)}`,
    );
    const cancelApproved = await eng('POST', `/cash-advances/${a3.id}/cancel`, { reason: 'trip called off' });
    const a3After = await prisma.cashAdvance.findUnique({ where: { id: a3.id } });
    check(
      'an approved advance nobody has released can be cancelled by its owner',
      cancelApproved.status === 200 && a3After?.status === 'CANCELLED',
      `${cancelApproved.status} ${a3After?.status}`,
    );
    const cancelReleased = await eng('POST', `/cash-advances/${a4.id}/cancel`, {});
    check(
      'a released advance cannot be cancelled — it is liquidated',
      cancelReleased.status === 400 && String(cancelReleased.body.error).includes('liquidate'),
      `${cancelReleased.status} ${JSON.stringify(cancelReleased.body).slice(0, 140)}`,
    );
    const reverse = await fin('DELETE', `/payments/${a1Release.id}`);
    check(
      'a release cannot be reversed while a liquidation points at it',
      reverse.status === 400 && String(reverse.body.error).includes('Cancel the liquidation first'),
      `${reverse.status} ${JSON.stringify(reverse.body).slice(0, 140)}`,
    );
    const cancelSettled = await eng('POST', `/expense-claims/${l1.id}/cancel`);
    check(
      'an approved liquidation cannot be cancelled by its owner',
      cancelSettled.status === 400 && String(cancelSettled.body.error).includes('approved'),
      `${cancelSettled.status} ${JSON.stringify(cancelSettled.body).slice(0, 140)}`,
    );

    // A claim or an advance cancelled while it waits on the supervisor takes
    // its request with it, through the engine: CANCELLED, out of the queue,
    // and the supervisor told who cancelled it and why. The routes used to
    // close the request by hand, which told nobody and audited nothing on it.
    const cancelWithdraws = async (
      what: string,
      documentType: string,
      documentId: string,
      cancelPath: string,
      link: string,
      reason?: string,
    ) => {
      const open = await prisma.approvalRequest.findFirst({ where: { documentType, documentId, status: 'PENDING' } });
      const queued = !!open && (await pendingFor(pm.id)).some((r) => r.id === open.id);
      const res = await eng('POST', cancelPath, reason ? { reason } : undefined);
      const closed = open ? await prisma.approvalRequest.findUnique({ where: { id: open.id } }) : null;
      check(
        `${what}: cancelling it closes its request CANCELLED`,
        res.status === 200 && closed?.status === 'CANCELLED' && !!closed.closedAt,
        `${res.status}, request ${closed?.status ?? 'none was open'}`,
      );
      check(`${what}: and takes it out of the supervisor's queue`, queued && !(await pendingFor(pm.id)).some((r) => r.id === open?.id));
      const why = `cancelled by ${engineer.name}${reason ? `: ${reason}` : ''}`;
      const told = await prisma.notification.findMany({ where: { type: 'approval.withdrawn', link } });
      check(
        `${what}: the supervisor is told it was withdrawn, by whom and why`,
        told.some((n) => n.userId === pm.id && n.body === `${open?.documentNumber} — ${why}`),
        JSON.stringify(told.map((n) => n.body)),
      );
      check(`${what}: the engineer who cancelled it is not told what they just did`, !told.some((n) => n.userId === engineer.id));
      return (summary: string | null) => !!summary?.startsWith('Withdrawn from approval at ') && summary.endsWith(` — ${why}`);
    };

    const calledOffClaim = await eng('POST', '/expense-claims', { purpose: `${TAG} trip called off`, lines: receipt1 });
    const calledOffClaimId = String(calledOffClaim.body.id ?? '');
    await eng('POST', `/expense-claims/${calledOffClaimId}/submit`);
    const claimWithdrawal = await cancelWithdraws(
      'a claim',
      'expense',
      calledOffClaimId,
      `/expense-claims/${calledOffClaimId}/cancel`,
      `/g-fin/expenses/${calledOffClaimId}`,
    );
    const claimTrail = await prisma.auditLog.findMany({ where: { entityId: calledOffClaimId, action: 'CANCELLED' } });
    check(
      "the claim keeps its own cancellation row, and the engine's withdrawal is filed under the approval's type",
      claimTrail.length === 2 &&
        claimTrail.some((a) => a.entityType === 'expense_claim' && a.summary === `${calledOffClaim.body.number} cancelled`) &&
        claimTrail.some((a) => a.entityType === 'expense' && claimWithdrawal(a.summary) && a.actorId === engineer.id),
      JSON.stringify(claimTrail.map((a) => [a.entityType, a.summary])),
    );

    const postponed = await newAdvance(engineer, 1_500, 'trip postponed');
    await eng('POST', `/cash-advances/${postponed.id}/submit`);
    const advanceWithdrawal = await cancelWithdraws(
      'an advance',
      'cash_advance',
      postponed.id,
      `/cash-advances/${postponed.id}/cancel`,
      `/g-fin/cash-advances/${postponed.id}`,
      'trip postponed',
    );
    const advanceTrail = await prisma.auditLog.findMany({
      where: { entityType: 'cash_advance', entityId: postponed.id, action: 'CANCELLED' },
    });
    check(
      "the advance's trail keeps both: the engine's withdrawal at its step, and the advance's own cancellation",
      advanceTrail.length === 2 &&
        advanceTrail.some((a) => advanceWithdrawal(a.summary) && a.actorId === engineer.id) &&
        advanceTrail.some((a) => a.summary === `${postponed.number} cancelled — trip postponed` && a.actorId === engineer.id),
      JSON.stringify(advanceTrail.map((a) => a.summary)),
    );

    // ══ Modifying a claim, and pulling one back (Phase 2) ═══════════════════
    console.log('\nModifying an expense claim (over HTTP)');
    const mLine = (description: string, amount: number) => ({ spentOn: todayIso, description, receiptNo: `OR-${description}`, amount });
    const mDraft = await eng('POST', '/expense-claims', {
      purpose: `${TAG} to modify`,
      jobId: job.id,
      costCategoryId: subcontract.id,
      lines: [mLine('Fare', 1_000)],
    });
    const mId = String(mDraft.body.id ?? '');
    const mBody = {
      purpose: `${TAG} modified trip`,
      jobId: job.id,
      costCategoryId: subcontract.id,
      lines: [mLine('Fare', 1_200), mLine('Meals', 350.5)],
    };
    const mPut = await eng('PUT', `/expense-claims/${mId}`, mBody);
    const mLines = await prisma.expenseClaimLine.count({ where: { claimId: mId } });
    check(
      'the claimant modifies a draft: the receipts are replaced and the total recomputed',
      mPut.status === 200 &&
        mPut.body.number === mDraft.body.number &&
        mPut.body.purpose === `${TAG} modified trip` &&
        mPut.body.claimedBy?.id === engineer.id &&
        money(mPut.body.total, 1_550.5) &&
        mLines === 2,
      `${mPut.status} ${JSON.stringify(mPut.body).slice(0, 160)} · ${mLines} lines`,
    );
    const mAudit = await prisma.auditLog.findFirst({ where: { entityType: 'expense_claim', entityId: mId, action: 'UPDATED' } });
    check('and the change is audited', !!mAudit?.summary?.includes('modified'), mAudit?.summary ?? 'no row');
    const mNotTheirs = await manager('PUT', `/expense-claims/${mId}`, mBody);
    check('a colleague who may edit their own claims cannot modify somebody else’s', mNotTheirs.status === 403, String(mNotTheirs.status));
    const mNoRight = await as(claimant)('PUT', `/expense-claims/${mId}`, mBody);
    check('the right to file a claim is not the right to modify one', mNoRight.status === 403, String(mNoRight.status));
    const mFinance = await fin('PUT', `/expense-claims/${mId}`, mBody);
    check('finance, who may edit every claim, may modify a draft', mFinance.status === 200, `${mFinance.status} ${JSON.stringify(mFinance.body).slice(0, 120)}`);
    const mRepoint = await eng('PUT', `/expense-claims/${mId}`, { ...mBody, advanceId: a4.id });
    check(
      'a claim does not become a liquidation on Modify',
      mRepoint.status === 400 && String(mRepoint.body.error).includes('liquidation'),
      `${mRepoint.status} ${JSON.stringify(mRepoint.body).slice(0, 140)}`,
    );

    const mSubmit = await eng('POST', `/expense-claims/${mId}/submit`);
    const mPending = await eng('PUT', `/expense-claims/${mId}`, mBody);
    check(
      'a claim with the approver refuses Modify — it is pulled back first',
      mSubmit.status === 200 && mPending.status === 400 && String(mPending.body.error).includes('pull it back'),
      `${mSubmit.status} / ${mPending.status} ${JSON.stringify(mPending.body).slice(0, 140)}`,
    );
    const mRequest = await prisma.approvalRequest.findFirst({ where: { documentType: 'expense', documentId: mId, status: 'PENDING' } });
    const mApproverPull = await manager('POST', `/expense-claims/${mId}/withdraw`);
    check('the approver cannot pull the claimant’s claim back', mApproverPull.status === 403, String(mApproverPull.status));
    const mPulled = await eng('POST', `/expense-claims/${mId}/withdraw`);
    const mClosed = mRequest ? await prisma.approvalRequest.findUnique({ where: { id: mRequest.id } }) : null;
    const mAfterPull = await prisma.expenseClaim.findUnique({ where: { id: mId } });
    check(
      'the claimant pulls it back: a draft again, its request CANCELLED',
      mPulled.status === 200 && mAfterPull?.status === 'DRAFT' && mClosed?.status === 'CANCELLED',
      `${mPulled.status} claim ${mAfterPull?.status}, request ${mClosed?.status ?? 'none was open'}`,
    );
    check('and out of the approver’s queue', !!mRequest && !(await pendingFor(pm.id)).some((r) => r.id === mRequest.id));
    const mTold = await prisma.notification.findFirst({
      where: { type: 'approval.withdrawn', userId: pm.id, link: `/g-fin/expenses/${mId}` },
    });
    check('the approver is told it was pulled back, and by whom', !!mTold?.body?.includes(`pulled back to draft by ${engineer.name}`), mTold?.body ?? 'nothing');
    if (mRequest) {
      await expectRejection(
        'a decision on the withdrawn request is refused by the engine',
        () => act({ requestId: mRequest.id, userId: pm.id, action: 'APPROVED' }),
        'no longer open',
      );
    }
    // The race the conditional claim exists for: a decision that reaches the
    // subscriber after the pull-back. It must change nothing.
    if (mClosed) await settleExpense(mClosed, 'APPROVED');
    const mLate = await prisma.expenseClaim.findUnique({ where: { id: mId } });
    const mPosted = await prisma.jobCostEntry.count({ where: { sourceType: 'expense_claim', sourceId: mId } });
    const mNotApplied = await prisma.auditLog.findFirst({
      where: { entityType: 'expense_claim', entityId: mId, summary: { contains: 'not applied' } },
    });
    check(
      'a late approval changes nothing: still a draft, nothing charged, and the trail says why',
      mLate?.status === 'DRAFT' && mPosted === 0 && !!mNotApplied,
      `${mLate?.status}, ${mPosted} ledger rows, ${mNotApplied?.summary ?? 'no trail'}`,
    );
    const mAgain = await eng('POST', `/expense-claims/${mId}/withdraw`);
    check('a draft has nothing to pull back', mAgain.status === 400, String(mAgain.status));
    const mFixed = await eng('PUT', `/expense-claims/${mId}`, { ...mBody, lines: [mLine('Fare', 1_200)] });
    const mResubmit = await eng('POST', `/expense-claims/${mId}/submit`);
    const mNewRequest = await prisma.approvalRequest.findFirst({ where: { documentType: 'expense', documentId: mId, status: 'PENDING' } });
    check(
      'modified again and resubmitted, it goes on a fresh request at the new amount',
      mFixed.status === 200 &&
        mResubmit.status === 200 &&
        !!mNewRequest &&
        mNewRequest.id !== mRequest?.id &&
        money(num(mNewRequest.amount), 1_200),
      `${mFixed.status} / ${mResubmit.status} / ${mNewRequest?.id} ${num(mNewRequest?.amount)}`,
    );
    const mReceipts = await prisma.attachment.count({ where: { entityType: 'expense_claim', entityId: mId } });
    const mStrangerFiles = await as(stranger)('GET', `/attachments/expense_claim/${mId}`);
    const mOwnFiles = await eng('GET', `/attachments/expense_claim/${mId}`);
    check(
      'a claim’s receipts are the claim’s: a stranger cannot list them, the claimant can',
      mStrangerFiles.status === 404 && mOwnFiles.status === 200 && Array.isArray(mOwnFiles.body) && mOwnFiles.body.length === mReceipts,
      `${mStrangerFiles.status} / ${mOwnFiles.status}`,
    );
    const mFinanceFiles = await fin('GET', `/attachments/expense_claim/${mId}`);
    check(
      'and so can finance, who reads every claim',
      mFinanceFiles.status === 200 && Array.isArray(mFinanceFiles.body) && mFinanceFiles.body.length === mReceipts,
      String(mFinanceFiles.status),
    );

    // The claim on paper (rule 6). Drafted, it prints the route submitting
    // would take — each step by its own name, "Pending" under who may sign it
    // (the engineer's supervisor by name); never "Checked by" / "Approved by".
    // Signed at step 1 and then pulled back, it prints that route again: the
    // CANCELLED request's signature is not an approval anybody now gives.
    const pClaim = await eng('POST', '/expense-claims', {
      purpose: `${TAG} on paper`,
      jobId: job.id,
      costCategoryId: subcontract.id,
      lines: [mLine('Fare', 1_200), mLine('Meals', 350.5)],
    });
    const pId = String(pClaim.body.id ?? '');
    const claimPaper = async () => {
      const res = await eng('GET', `/expense-claims/${pId}/pdf`);
      return { status: res.status, bytes: res.bytes, text: res.bytes ? pdfText(res.bytes) : '' };
    };
    const CLAIM_MONEY = ['Total', 'Claimed', 'Reimbursed', 'Still owed'];
    const pDraft = await claimPaper();
    const pSubmit = await eng('POST', `/expense-claims/${pId}/submit`);
    const pRequest = await prisma.approvalRequest.findFirst({ where: { documentType: 'expense', documentId: pId, status: 'PENDING' } });
    const claimSteps = await stepNames(pRequest?.workflowId ?? null);
    check(
      'a draft claim prints its route: PREPARED BY, then each step by its name, "Pending" under the supervisor by name',
      pClaim.status === 201 &&
        pDraft.status === 200 &&
        flat(pDraft.text).includes('PREPARED BY') &&
        claimSteps.length > 0 &&
        claimSteps.every((st) => flat(pDraft.text).includes(st)) &&
        !flat(pDraft.text).includes('CHECKED BY') &&
        !flat(pDraft.text).includes('APPROVED BY') &&
        pDraft.text.includes(pm.name) &&
        signedCount(pDraft.text) === 1 &&
        pendingCount(pDraft.text) === claimSteps.length,
      `${pClaim.status} ${pDraft.status} ${claimSteps.join(' / ')} · ${signedCount(pDraft.text)} signed, ${pendingCount(pDraft.text)} pending`,
    );
    check(
      'its receipts add up in the totals block — "Claimed", in bold, and no "Still owed" before anyone approved it — never a TOTAL row in the table',
      hasLine(pDraft.text, 'Claimed') &&
        labelsSaid(labelRuns(pDraft.bytes, CLAIM_MONEY)) === 'Claimed*' &&
        !pDraft.text.includes('Reimbursed') &&
        !pDraft.text.includes('Still owed') &&
        pDraft.text.includes(peso(1_550.5)) &&
        !pDraft.text.includes(peso(0)) &&
        !pDraft.text.includes('TOTAL') &&
        flat(pDraft.text).includes(`AMOUNT (${currency})`) &&
        pDraft.text.includes('1,200.00') &&
        !pDraft.text.includes(peso(1_200)) &&
        pDraft.text.includes('Draft') &&
        !pDraft.text.includes('DRAFT'),
      `${labelsSaid(labelRuns(pDraft.bytes, CLAIM_MONEY))} · ${pDraft.text.split('\n').filter((l) => /total|Claimed|Reimbursed|owed|AMOUNT|Draft/i.test(l)).join(' | ').slice(0, 300)}`,
    );
    if (pRequest) await act({ requestId: pRequest.id, userId: pm.id, action: 'APPROVED' });
    const pSigned = await claimPaper();
    check(
      'submitted and signed at step 1, it prints the supervisor dated and the next step "Pending"',
      pSubmit.status === 200 &&
        !!pRequest &&
        pSigned.text.includes(pm.name) &&
        signedCount(pSigned.text) === 2 &&
        pendingCount(pSigned.text) === claimSteps.length - 1 &&
        pSigned.text.includes('Pending approval'),
      `${pSubmit.status} · ${signedCount(pSigned.text)} signed, ${pendingCount(pSigned.text)} pending`,
    );
    const pPulled = await eng('POST', `/expense-claims/${pId}/withdraw`);
    const pAgain = await claimPaper();
    check(
      'pulled back to draft, it prints the route afresh — the withdrawn signature is not printed',
      pPulled.status === 200 && signedCount(pAgain.text) === 1 && pendingCount(pAgain.text) === claimSteps.length,
      `${pPulled.status} · ${signedCount(pAgain.text)} signed, ${pendingCount(pAgain.text)} pending`,
    );
    // Submitted again, signed at step 1, then cancelled: no approval is coming,
    // so the paper prints the signature that WAS given, dated, and no step
    // "Pending" — and its money states what was claimed, never a "Still owed"
    // nobody owes.
    const pResubmit = await eng('POST', `/expense-claims/${pId}/submit`);
    const pRequest2 = await prisma.approvalRequest.findFirst({ where: { documentType: 'expense', documentId: pId, status: 'PENDING' } });
    if (pRequest2) await act({ requestId: pRequest2.id, userId: pm.id, action: 'APPROVED' });
    const pCancel = await eng('POST', `/expense-claims/${pId}/cancel`);
    const pCancelled = await claimPaper();
    check(
      'cancelled after step 1 signed, it prints PREPARED BY and that signature, both dated — no step "Pending"',
      pResubmit.status === 200 &&
        !!pRequest2 &&
        pCancel.status === 200 &&
        flat(pCancelled.text).includes('PREPARED BY') &&
        flat(pCancelled.text).includes(claimSteps[0] ?? '?') &&
        pCancelled.text.includes(pm.name) &&
        claimSteps.slice(1).every((st) => !flat(pCancelled.text).includes(st)) &&
        signedCount(pCancelled.text) === 2 &&
        pendingCount(pCancelled.text) === 0 &&
        pCancelled.text.includes('Cancelled'),
      `${pResubmit.status} ${pCancel.status} · ${signedCount(pCancelled.text)} signed, ${pendingCount(pCancelled.text)} pending`,
    );
    check(
      'and its money states the claim — "Claimed" — with no "Still owed"',
      hasLine(pCancelled.text, 'Claimed') &&
        pCancelled.text.includes(peso(1_550.5)) &&
        !pCancelled.text.includes('Still owed') &&
        !pCancelled.text.includes('Reimbursed'),
      pCancelled.text.split('\n').filter((l) => /Claimed|owed|Reimbursed/.test(l)).join(' | '),
    );
    check('every print is on the claim’s trail as EXPORTED', (await exportsOf('expense_claim', pId)) === 4);

    // Rejected at its first step: nobody signed, so only the claimant's line
    // is dated — never "Pending" under the very step that refused it.
    const rClaim = await eng('POST', '/expense-claims', { purpose: `${TAG} refused on paper`, lines: [mLine('Parking', 180)] });
    const rId = String(rClaim.body.id ?? '');
    const rSubmit = await eng('POST', `/expense-claims/${rId}/submit`);
    const rRequest = await prisma.approvalRequest.findFirst({ where: { documentType: 'expense', documentId: rId, status: 'PENDING' } });
    const rSteps = await stepNames(rRequest?.workflowId ?? null);
    if (rRequest) await settle(rRequest.id, 'REJECTED');
    const rPaper = await eng('GET', `/expense-claims/${rId}/pdf`);
    const rText = rPaper.bytes ? pdfText(rPaper.bytes) : '';
    check(
      'a rejected claim prints PREPARED BY alone, dated — no step, nothing "Pending"',
      rClaim.status === 201 &&
        rSubmit.status === 200 &&
        rSteps.length > 0 &&
        (await prisma.expenseClaim.findUnique({ where: { id: rId } }))?.status === 'REJECTED' &&
        flat(rText).includes('PREPARED BY') &&
        rSteps.every((st) => !flat(rText).includes(st)) &&
        signedCount(rText) === 1 &&
        pendingCount(rText) === 0 &&
        rText.includes('Rejected') &&
        hasLine(rText, 'Claimed') &&
        !rText.includes('Still owed'),
      `${rClaim.status} ${rSubmit.status} · ${signedCount(rText)} signed, ${pendingCount(rText)} pending`,
    );

    // Approved all the way: now — and only now — the paper says where it
    // stands: what was reimbursed, and what is still owed, in bold.
    const okClaim = await eng('POST', '/expense-claims', { purpose: `${TAG} approved on paper`, lines: [mLine('Toll', 245)] });
    const okId = String(okClaim.body.id ?? '');
    const okSubmit = await eng('POST', `/expense-claims/${okId}/submit`);
    const okRequest = await prisma.approvalRequest.findFirst({ where: { documentType: 'expense', documentId: okId, status: 'PENDING' } });
    const okSteps = await stepNames(okRequest?.workflowId ?? null);
    if (okRequest) await settle(okRequest.id);
    const okPaper = await eng('GET', `/expense-claims/${okId}/pdf`);
    const okText = okPaper.bytes ? pdfText(okPaper.bytes) : '';
    check(
      'an approved claim prints every step signed and dated, then Total, Reimbursed and Still owed',
      okClaim.status === 201 &&
        okSubmit.status === 200 &&
        okSteps.every((st) => flat(okText).includes(st)) &&
        signedCount(okText) === okSteps.length + 1 &&
        pendingCount(okText) === 0 &&
        okText.includes('Approved') &&
        hasLine(okText, 'Total') &&
        hasLine(okText, 'Reimbursed') &&
        okText.includes(peso(0)) &&
        hasLine(okText, 'Still owed') &&
        okText.includes(peso(245)) &&
        !hasLine(okText, 'Claimed') &&
        // In the money block's order, only the last — what is still owed — bold.
        labelsSaid(labelRuns(okPaper.bytes, CLAIM_MONEY)) === 'Total, Reimbursed, Still owed*',
      `${okClaim.status} ${okSubmit.status} · ${signedCount(okText)} signed, ${pendingCount(okText)} pending · ${labelsSaid(labelRuns(okPaper.bytes, CLAIM_MONEY))} · ` +
        okText.split('\n').filter((l) => /Total|Reimbursed|owed|Claimed/.test(l)).join(' | '),
    );

    // A decision that landed a moment before a pull-back or a cancel: act()
    // has committed it, its subscriber has not run yet. It stands — both are
    // refused and roll back — and the settlement applies when it arrives.
    const dClaim = await eng('POST', '/expense-claims', { purpose: `${TAG} decided first`, lines: [mLine('Taxi', 400)] });
    const dId = String(dClaim.body.id ?? '');
    const dSubmit = await eng('POST', `/expense-claims/${dId}/submit`);
    const dOpen = await prisma.approvalRequest.findFirst({ where: { documentType: 'expense', documentId: dId, status: 'PENDING' } });
    const dDecided = dOpen
      ? await prisma.approvalRequest.update({ where: { id: dOpen.id }, data: { status: 'APPROVED', closedAt: new Date() } })
      : null;
    const dPull = await eng('POST', `/expense-claims/${dId}/withdraw`);
    const dCancel = await eng('POST', `/expense-claims/${dId}/cancel`);
    const dHeld = await prisma.expenseClaim.findUnique({ where: { id: dId } });
    const dRequestHeld = dOpen ? await prisma.approvalRequest.findUnique({ where: { id: dOpen.id } }) : null;
    check(
      'a decision that landed first stands: pulling back and cancelling are refused, the claim still pending, its request still approved',
      dSubmit.status === 200 &&
        !!dDecided &&
        dPull.status === 400 &&
        String(dPull.body.error).includes('decided') &&
        dCancel.status === 400 &&
        String(dCancel.body.error).includes('decided') &&
        dHeld?.status === 'PENDING_APPROVAL' &&
        dRequestHeld?.status === 'APPROVED',
      `${dSubmit.status} / pull ${dPull.status} ${JSON.stringify(dPull.body).slice(0, 100)} / cancel ${dCancel.status} ${JSON.stringify(dCancel.body).slice(0, 100)} / claim ${dHeld?.status}, request ${dRequestHeld?.status}`,
    );
    if (dDecided) await settleExpense(dDecided, 'APPROVED');
    const dApplied = await prisma.expenseClaim.findUnique({ where: { id: dId } });
    check(
      'and the settlement it carries applies when it arrives',
      dApplied?.status === 'APPROVED' && !!dApplied.approvedAt,
      String(dApplied?.status),
    );

    // Pending with nothing open and nothing decided — a submit still making
    // its request, or one that died half-way: a cancel is not refused for ever.
    const sClaim = await eng('POST', '/expense-claims', { purpose: `${TAG} nothing open`, lines: [mLine('Parking', 150)] });
    const sId = String(sClaim.body.id ?? '');
    const sSubmit = await eng('POST', `/expense-claims/${sId}/submit`);
    await prisma.approvalRequest.updateMany({
      where: { documentType: 'expense', documentId: sId, status: 'PENDING' },
      data: { status: 'CANCELLED', closedAt: new Date() },
    });
    const sCancel = await eng('POST', `/expense-claims/${sId}/cancel`);
    const sAfter = await prisma.expenseClaim.findUnique({ where: { id: sId } });
    check(
      'a pending claim with nothing open and nothing decided can still be cancelled',
      sSubmit.status === 200 && sCancel.status === 200 && sAfter?.status === 'CANCELLED',
      `${sSubmit.status} / ${sCancel.status} ${JSON.stringify(sCancel.body).slice(0, 120)} → ${sAfter?.status}`,
    );
    // A cancelled claim may be deleted (2026-10-11) — with the delete right.
    const rootUser = await prisma.user.findUnique({ where: { email: 'root@verifyf.local' } });
    const sDelNoRight = await eng('DELETE', `/expense-claims/${sId}`);
    const sDel = rootUser ? await as(rootUser)('DELETE', `/expense-claims/${sId}`) : null;
    check(
      'a cancelled claim is deleted by a holder of the delete right, and not by its claimant without it',
      sDelNoRight.status === 403 && sDel?.status === 200 && !(await prisma.expenseClaim.findUnique({ where: { id: sId } })),
      `${sDelNoRight.status} / ${sDel?.status} ${JSON.stringify(sDel?.body).slice(0, 120)}`,
    );
    // So may a cancelled budget request; an open one is cancelled first.
    const brSpare = await eng('POST', '/budget-requests', { jobId: job.id, costCategoryId: subcontract.id, amount: 1_000, reason: `${TAG} spare request`, neededBy: todayIso });
    const brSpareId = String(brSpare.body.id);
    await eng('POST', `/budget-requests/${brSpareId}/submit`);
    const brDelOpen = rootUser ? await as(rootUser)('DELETE', `/budget-requests/${brSpareId}`) : null;
    const brSpareCancel = await eng('POST', `/budget-requests/${brSpareId}/cancel`, { reason: 'not needed' });
    const brDel = rootUser ? await as(rootUser)('DELETE', `/budget-requests/${brSpareId}`) : null;
    check(
      'a budget request is deleted once cancelled, never while it is open',
      brSpare.status === 201 && brDelOpen?.status === 400 && brSpareCancel.status === 200 && brDel?.status === 200 && !(await prisma.budgetRequest.findUnique({ where: { id: brSpareId } })),
      `${brSpare.status} / open ${brDelOpen?.status} / cancel ${brSpareCancel.status} / delete ${brDel?.status} ${JSON.stringify(brDel?.body).slice(0, 120)}`,
    );

    // ══ Modifying and cancelling a supplier bill (Phase 2) ══════════════════
    console.log('\nModifying a supplier bill (over HTTP)');
    const bLine = (description: string, quantity: number, unitPrice: number) => ({ description, quantity, unitPrice });
    const bEntered = await fin('POST', '/supplier-bills', {
      supplierId: supplier.id,
      jobId: job.id,
      costCategoryId: subcontract.id,
      supplierInvoiceNo: `${TAG}-SI-M1`,
      lines: [bLine('Hauling', 1, 10_000)],
    });
    const bId = String(bEntered.body.id ?? '');
    check(
      'a bill is entered as a draft with nothing received behind it',
      bEntered.status === 201 && bEntered.body.status === 'DRAFT' && bEntered.body.receivingId === null,
      `${bEntered.status} ${JSON.stringify(bEntered.body).slice(0, 140)}`,
    );
    // The supplier's real invoice was for the piping on the order, and freight.
    const bBody = {
      supplierId: supplier.id,
      orderId: order.id,
      costCategoryId: materials.id,
      supplierInvoiceNo: `${TAG}-SI-M1`,
      vatRate: 0.12,
      ewtRate: 0.01,
      lines: [bLine('Pipe', 10, 1_000), bLine('Freight', 2, 250.5)],
    };
    const bPut = await fin('PUT', `/supplier-bills/${bId}`, bBody);
    const bLines = await prisma.supplierBillLine.count({ where: { billId: bId } });
    check(
      'finance modifies the draft: lines replaced, the money recomputed to the centavo',
      bPut.status === 200 &&
        bLines === 2 &&
        money(bPut.body.subtotal, 10_501) &&
        money(bPut.body.vatAmount, 1_260.12) &&
        money(bPut.body.total, 11_761.12) &&
        money(bPut.body.ewtAmount, 105.01) &&
        money(bPut.body.netPayable, 11_656.11),
      `${bPut.status} ${JSON.stringify(bPut.body).slice(0, 200)} · ${bLines} lines`,
    );
    check(
      'naming the order lends the bill its receiving and project — what stops a second charge at approval',
      bPut.body.receivingId === receiving.id && bPut.body.jobId === job.id,
      `receiving ${bPut.body.receivingId}, job ${bPut.body.jobId}`,
    );
    // A field Modify leaves out keeps what is stored — the withholding rate
    // above all, which the entry form would default to none.
    const bKept = await fin('PUT', `/supplier-bills/${bId}`, { lines: bBody.lines });
    check(
      'modified with only its lines, the bill keeps its supplier, order, receiving, project, budget line, invoice number and withholding',
      bKept.status === 200 &&
        bKept.body.supplierId === supplier.id &&
        bKept.body.orderId === order.id &&
        bKept.body.receivingId === receiving.id &&
        bKept.body.jobId === job.id &&
        bKept.body.costCategoryId === materials.id &&
        bKept.body.supplierInvoiceNo === `${TAG}-SI-M1` &&
        money(bKept.body.ewtRate, 0.01) &&
        money(bKept.body.netPayable, 11_656.11),
      `${bKept.status} ${JSON.stringify(bKept.body).slice(0, 240)}`,
    );
    const bInclusive = await fin('PUT', `/supplier-bills/${bId}`, { lines: bBody.lines, vatInclusive: true });
    const bInclusiveKept = await fin('PUT', `/supplier-bills/${bId}`, { lines: bBody.lines });
    check(
      'and prices entered VAT-inclusive are still read that way when Modify does not say',
      bInclusive.status === 200 &&
        money(bInclusive.body.subtotal, 9_375.89) &&
        bInclusiveKept.status === 200 &&
        money(bInclusiveKept.body.subtotal, 9_375.89),
      `${bInclusive.status} ${bInclusive.body.subtotal} / ${bInclusiveKept.status} ${bInclusiveKept.body.subtotal}`,
    );
    const bExclusive = await fin('PUT', `/supplier-bills/${bId}`, { ...bBody, vatInclusive: false });
    check(
      'until a body says otherwise',
      bExclusive.status === 200 && money(bExclusive.body.subtotal, 10_501) && money(bExclusive.body.netPayable, 11_656.11),
      `${bExclusive.status} ${bExclusive.body.subtotal}`,
    );
    const order2 = await prisma.purchaseOrder.create({
      data: {
        number: await nextNumber('purchase_order'),
        status: 'ISSUED',
        kind: 'DIRECT_TO_JOB',
        supplierId: supplier.id,
        jobId: job.id,
        warehouseId: warehouse.id,
        createdById: procurement.id,
        notes: `${TAG} second order`,
        subtotal: D(0),
        vatAmount: D(0),
        total: D(0),
        issuedAt: new Date(),
      },
    });
    const bOtherOrder = await fin('PUT', `/supplier-bills/${bId}`, { ...bBody, orderId: order2.id, receivingId: receiving.id });
    check(
      'goods received against a different order are refused',
      bOtherOrder.status === 400 && String(bOtherOrder.body.error).includes('different order'),
      `${bOtherOrder.status} ${JSON.stringify(bOtherOrder.body).slice(0, 140)}`,
    );
    const otherSupplier = await prisma.supplier.create({ data: { code: `${TAG}-S2`, name: `${TAG} Other Supply` } });
    const bWrongOrder = await fin('PUT', `/supplier-bills/${bId}`, { ...bBody, supplierId: otherSupplier.id });
    check(
      'an order placed with another supplier is refused',
      bWrongOrder.status === 400 && String(bWrongOrder.body.error).includes('different supplier'),
      `${bWrongOrder.status} ${JSON.stringify(bWrongOrder.body).slice(0, 140)}`,
    );
    const bWrongGoods = await fin('PUT', `/supplier-bills/${bId}`, {
      ...bBody,
      supplierId: otherSupplier.id,
      orderId: null,
      receivingId: receiving.id,
    });
    check(
      'and so are goods received from another supplier',
      bWrongGoods.status === 400 && String(bWrongGoods.body.error).includes('different supplier'),
      `${bWrongGoods.status} ${JSON.stringify(bWrongGoods.body).slice(0, 140)}`,
    );
    const bClerk = await as(apClerk)('PUT', `/supplier-bills/${bId}`, bBody);
    check('entering bills is not the right to modify them', bClerk.status === 403, String(bClerk.status));

    const bSubmit = await fin('POST', `/supplier-bills/${bId}/submit`);
    const bPending = await fin('PUT', `/supplier-bills/${bId}`, bBody);
    const bPendingCancel = await fin('POST', `/supplier-bills/${bId}/cancel`, { reason: 'entered twice' });
    check(
      'a bill with the approver refuses Modify and cancel',
      bSubmit.status === 200 && bPending.status === 400 && bPendingCancel.status === 400,
      `${bSubmit.status} / ${bPending.status} / ${bPendingCancel.status}`,
    );
    const bRequest = await prisma.approvalRequest.findFirst({ where: { documentType: 'supplier_bill', documentId: bId, status: 'PENDING' } });
    if (bRequest) await settle(bRequest.id);
    const bApproved = await prisma.supplierBill.findUnique({ where: { id: bId } });
    const bLedger = await prisma.jobCostEntry.count({ where: { sourceType: 'supplier_bill', sourceId: bId } });
    check(
      'approved, the bill matched on Modify charges the project nothing — the receiving already did',
      bApproved?.status === 'APPROVED' && bApproved.postedToJob === false && bLedger === 0,
      `${bApproved?.status}, posted ${bApproved?.postedToJob}, ${bLedger} ledger rows`,
    );

    // A decision that finds the bill no longer pending changes nothing.
    const bLate = await fin('POST', '/supplier-bills', {
      supplierId: supplier.id,
      jobId: job.id,
      costCategoryId: subcontract.id,
      lines: [bLine('Service call', 1, 5_000)],
    });
    const bLateId = String(bLate.body.id ?? '');
    await fin('POST', `/supplier-bills/${bLateId}/submit`);
    const bLateRequest = await prisma.approvalRequest.findFirst({ where: { documentType: 'supplier_bill', documentId: bLateId, status: 'PENDING' } });
    // As if it had left PENDING a moment before the decision landed.
    await prisma.supplierBill.update({ where: { id: bLateId }, data: { status: 'DRAFT' } });
    if (bLateRequest) await settle(bLateRequest.id);
    const bLateAfter = await prisma.supplierBill.findUnique({ where: { id: bLateId } });
    const bLateLedger = await prisma.jobCostEntry.count({ where: { sourceType: 'supplier_bill', sourceId: bLateId } });
    const bLateTrail = await prisma.auditLog.findFirst({
      where: { entityType: 'supplier_bill', entityId: bLateId, summary: { contains: 'not applied' } },
    });
    check(
      'an approval that finds the bill no longer pending applies nothing, posts nothing, and says so',
      !!bLateRequest && bLateAfter?.status === 'DRAFT' && bLateLedger === 0 && !!bLateTrail,
      `${bLateAfter?.status}, ${bLateLedger} ledger rows, ${bLateTrail?.summary ?? 'no trail'}`,
    );

    const bSpare = await fin('POST', '/supplier-bills', {
      supplierId: supplier.id,
      notes: 'Entered from the email copy',
      lines: [bLine('Hauling', 1, 2_000)],
    });
    const bSpareId = String(bSpare.body.id ?? '');
    // The engine refusing a submit — here because a request is already open
    // for the bill — leaves it a draft, never pending with nothing behind it.
    const bStray = await prisma.approvalRequest.create({
      data: {
        documentType: 'supplier_bill',
        documentId: bSpareId,
        subject: `${TAG} left behind`,
        requesterId: finance.id,
        status: 'PENDING',
        currentSequence: 1,
      },
    });
    const bRefused = await fin('POST', `/supplier-bills/${bSpareId}/submit`);
    const bAfterRefusal = await prisma.supplierBill.findUnique({ where: { id: bSpareId } });
    check(
      'a submit the engine refuses puts the bill back to draft',
      bRefused.status === 400 && String(bRefused.body.error).includes('already awaiting') && bAfterRefusal?.status === 'DRAFT',
      `${bRefused.status} ${JSON.stringify(bRefused.body).slice(0, 120)} → ${bAfterRefusal?.status}`,
    );
    const bShort = await fin('POST', `/supplier-bills/${bSpareId}/cancel`, { reason: 'no' });
    check('cancelling a draft bill asks why', bShort.status === 400, String(bShort.status));
    const bClerkCancel = await as(apClerk)('POST', `/supplier-bills/${bSpareId}/cancel`, { reason: 'entered twice' });
    check('and is not the A/P clerk’s to do', bClerkCancel.status === 403, String(bClerkCancel.status));
    const bCancel = await fin('POST', `/supplier-bills/${bSpareId}/cancel`, { reason: 'entered twice' });
    const bCancelled = await prisma.supplierBill.findUnique({ where: { id: bSpareId } });
    const bCancelTrail = await prisma.auditLog.findFirst({ where: { entityType: 'supplier_bill', entityId: bSpareId, action: 'CANCELLED' } });
    check(
      'finance cancels a draft bill: CANCELLED, the reason kept on its notes and in the trail',
      bCancel.status === 200 &&
        bCancelled?.status === 'CANCELLED' &&
        !!bCancelled.notes?.startsWith('Entered from the email copy') &&
        !!bCancelled.notes?.includes('Cancelled: entered twice') &&
        !!bCancelTrail?.summary?.includes('entered twice'),
      `${bCancel.status} ${bCancelled?.status} ${JSON.stringify(bCancelled?.notes)} ${bCancelTrail?.summary}`,
    );
    const bStrayAfter = await prisma.approvalRequest.findUnique({ where: { id: bStray.id } });
    check('and the request a refused submit left open is withdrawn with it', bStrayAfter?.status === 'CANCELLED', String(bStrayAfter?.status));
    const bCancelAgain = await fin('POST', `/supplier-bills/${bSpareId}/cancel`, { reason: 'entered twice' });
    const bCancelledEdit = await fin('PUT', `/supplier-bills/${bSpareId}`, { supplierId: supplier.id, lines: [bLine('Hauling', 1, 2_000)] });
    check(
      'a cancelled bill is neither cancelled again nor modified',
      bCancelAgain.status === 400 && bCancelledEdit.status === 400,
      `${bCancelAgain.status} / ${bCancelledEdit.status}`,
    );

    console.log('\nCash advances — the project view, refunds and the paper (over HTTP)');
    // The project view, and who may see it.
    const forJob = await eng('GET', `/cash-advances/for-job/${job.id}`);
    check(
      'the project view lists the job’s advances and its liquidations',
      forJob.status === 200 &&
        (forJob.body.advances as { id: string }[]).some((a) => a.id === a1.id) &&
        (forJob.body.claims as { id: string }[]).some((c) => c.id === l1.id),
      String(forJob.status),
    );
    const projectsOnly = await as(projectViewer)('GET', `/cash-advances/for-job/${job.id}`);
    check(
      'and project access alone is not budget-monitoring access',
      projectsOnly.status === 403,
      String(projectsOnly.status),
    );
    const chargeable = await as(claimant)('GET', '/expense-claims/chargeable');
    check(
      'somebody who may only file a claim can still name the project it is for',
      chargeable.status === 200 &&
        (chargeable.body.jobs as { id: string }[]).some((j) => j.id === job.id) &&
        (chargeable.body.categories as unknown[]).length > 0,
      String(chargeable.status),
    );

    // A refund is cash in, and never a collection.
    const before = await fin('GET', '/finance-reports/dashboard');
    const refundHttp = await fin('POST', '/payments', {
      kind: 'RECEIPT',
      method: 'CASH',
      payeeUserId: engineer.id,
      allocations: [{ kind: 'advance_refund', id: a1.id, amount: 1_500 }],
    });
    const after = await fin('GET', '/finance-reports/dashboard');
    const a1Final = await prisma.cashAdvance.findUnique({ where: { id: a1.id } });
    check(
      'recording the unspent 1,500 liquidates the advance',
      refundHttp.status === 201 && a1Final?.status === 'LIQUIDATED',
      `${refundHttp.status} ${a1Final?.status} ${JSON.stringify(refundHttp.body).slice(0, 120)}`,
    );
    check(
      'and does not count as money collected from customers',
      money(after.body.collectedThisMonth, before.body.collectedThisMonth),
      `${before.body.collectedThisMonth} → ${after.body.collectedThisMonth}`,
    );
    check(
      'the dashboard reports advances and project cash to release and in hand',
      typeof after.body.advancesToRelease === 'number' &&
        typeof after.body.advancesInHand === 'number' &&
        typeof after.body.budgetRequestsToRelease === 'number' &&
        typeof after.body.budgetRequestsInHand === 'number' &&
        typeof after.body.queue.advancesAwaitingRelease === 'number' &&
        typeof after.body.queue.liquidationsOverdue === 'number' &&
        typeof after.body.queue.refundsAwaitingReceipt === 'number' &&
        typeof after.body.queue.budgetRequestsAwaitingRelease === 'number' &&
        typeof after.body.queue.budgetLiquidationsOverdue === 'number' &&
        typeof after.body.queue.budgetRefundsAwaitingReceipt === 'number',
    );
    const found = await fin('GET', `/payments?search=${encodeURIComponent(engineer.name)}&pageSize=100`);
    check(
      'the payments register finds a person by name',
      found.status === 200 && (found.body.rows as { id: string }[]).some((p) => p.id === a1Release.id),
      `${found.status}, ${(found.body.rows ?? []).length} rows`,
    );

    // (10) The printed documents.
    const advancePdf = await eng('GET', `/cash-advances/${a1.id}/pdf`);
    const liquidationPdf = await eng('GET', `/expense-claims/${l1.id}/pdf`);
    for (const [label, res, title] of [
      ['the cash advance', advancePdf, 'Cash Advance'],
      ['the liquidation report', liquidationPdf, 'Liquidation Report'],
    ] as const) {
      const text = res.bytes ? pdfText(res.bytes) : '';
      check(`${label} prints as a PDF`, res.status === 200 && res.type.includes('application/pdf'), `${res.status} ${res.type}`);
      check(
        `${label} names itself, prints money as ${currency} and never as ±`,
        flat(text).toUpperCase().includes(title.toUpperCase()) && text.includes(currency) && !text.includes('±'),
        text.slice(0, 160),
      );
    }
    // The advance, settled all the way: its route signed step by step (the
    // supervisor by name), who received the cash, and the money in the
    // totals block down to what is still to refund — nothing, now.
    const advText = advancePdf.bytes ? pdfText(advancePdf.bytes) : '';
    const advSteps = await stepNames(a1Request.workflowId);
    check(
      'the advance prints REQUESTED BY, each step by its own name, RECEIVED BY — all dated, none "Checked by"',
      flat(advText).includes('REQUESTED BY') &&
        advSteps.every((st) => flat(advText).includes(st)) &&
        flat(advText).includes('RECEIVED BY') &&
        !flat(advText).includes('CHECKED BY') &&
        !flat(advText).includes('APPROVED BY') &&
        advText.includes(pm.name) &&
        signedCount(advText) === advSteps.length + 2 &&
        pendingCount(advText) === 0,
      `${advSteps.join(' / ')} · ${signedCount(advText)} signed, ${pendingCount(advText)} pending`,
    );
    check(
      'its money: requested, released, spent, owed back, refunded, still to refund — statuses in words',
      advText.includes('Amount requested') &&
        advText.includes(peso(10_000)) &&
        advText.includes('Spent (per liquidation)') &&
        advText.includes(peso(8_500)) &&
        advText.includes('Unspent') &&
        advText.includes('Less: refunded') &&
        advText.includes(peso(1_500)) &&
        advText.includes('Still to refund') &&
        advText.includes(peso(0)) &&
        advText.includes('Liquidated') &&
        advText.includes('Settled') &&
        !advText.includes('AMOUNT REQUESTED') &&
        !advText.includes('LIQUIDATED') &&
        !advText.includes('SETTLED'),
      advText.split('\n').filter((l) => /requested|Released|Spent|refund|Liquidated|Settled/i.test(l)).join(' | ').slice(0, 300),
    );
    const liqText = liquidationPdf.bytes ? pdfText(liquidationPdf.bytes) : '';
    const liqSteps = await stepNames(l1Request.workflowId);
    check(
      'the liquidation report prints PREPARED BY and each step by its name, signed and dated',
      flat(liqText).includes('PREPARED BY') &&
        liqSteps.every((st) => flat(liqText).includes(st)) &&
        !flat(liqText).includes('CHECKED BY') &&
        !flat(liqText).includes('APPROVED BY') &&
        signedCount(liqText) === liqSteps.length + 1 &&
        pendingCount(liqText) === 0,
      `${liqSteps.join(' / ')} · ${signedCount(liqText)} signed, ${pendingCount(liqText)} pending`,
    );
    check(
      'and its receipts add up in the totals block: Total, Advance released, the unspent owed back, less what came back — nothing still to refund',
      liqText.includes('Total') &&
        liqText.includes(peso(8_500)) &&
        liqText.includes('Advance released') &&
        liqText.includes(peso(10_000)) &&
        liqText.includes('owed back') &&
        liqText.includes(peso(1_500)) &&
        hasLine(liqText, 'Less: refunded') &&
        hasLine(liqText, 'Still to refund') &&
        liqText.includes(peso(0)) &&
        liqText.includes('3,500.00') &&
        !liqText.includes(peso(3_500)) &&
        !liqText.includes('TOTAL'),
      liqText.split('\n').filter((l) => /total|released|owed|refund|3,500/i.test(l)).join(' | ').slice(0, 300),
    );
    // Over-spent (section 5): the excess is owed on the liquidation and was
    // paid there. Both papers take the reimbursement off, so neither says
    // anything is still owed once it is.
    const a2Pdf = await eng('GET', `/cash-advances/${a2.id}/pdf`);
    const a2Text = a2Pdf.bytes ? pdfText(a2Pdf.bytes) : '';
    check(
      'an over-spent advance prints the excess, less what its liquidation reimbursed, and nothing still owed',
      a2Pdf.status === 200 &&
        hasLine(a2Text, 'Excess spent') &&
        a2Text.includes(peso(1_200)) &&
        flat(a2Text).includes(`Less: reimbursed on ${l2.number}`) &&
        hasLine(a2Text, 'Still owed to requester') &&
        a2Text.includes(peso(0)) &&
        !a2Text.includes('Excess owed'),
      a2Text.split('\n').filter((l) => /Excess|reimbursed|owed|PHP/.test(l)).join(' | ').slice(0, 300),
    );
    const l2Pdf = await eng('GET', `/expense-claims/${l2.id}/pdf`);
    const l2Text = l2Pdf.bytes ? pdfText(l2Pdf.bytes) : '';
    check(
      'and its liquidation report: Total, Advance released, Excess spent, Less: reimbursed — nothing Still owed',
      l2Pdf.status === 200 &&
        l2Text.includes(peso(6_200)) &&
        l2Text.includes(peso(5_000)) &&
        hasLine(l2Text, 'Excess spent') &&
        l2Text.includes(peso(1_200)) &&
        hasLine(l2Text, 'Less: reimbursed') &&
        hasLine(l2Text, 'Still owed') &&
        l2Text.includes(peso(0)) &&
        l2Text.includes('Reimbursed') &&
        !l2Text.includes('Excess owed'),
      l2Text.split('\n').filter((l) => /Excess|reimbursed|owed|PHP/i.test(l)).join(' | ').slice(0, 300),
    );
    check(
      'both prints are on their trails as EXPORTED',
      (await exportsOf('cash_advance', a1.id)) === 1 && (await exportsOf('expense_claim', l1.id)) === 1,
    );

    // (11) Billing a job order.
    console.log('\nInvoicing a job order (over HTTP)');
    const jobOrder = async (status: 'APPROVED' | 'COMPLETED', chargeBasis: 'WARRANTY' | 'CHARGEABLE') =>
      prisma.jobOrder.create({
        data: {
          number: await nextNumber('job_order'),
          status,
          chargeBasis,
          customerId: customer.id,
          jobId: job.id,
          title: `${TAG} compressor trip`,
          description: 'Unit tripping on high temperature',
          requestedFor: dayKey(new Date()),
          requestedById: engineer.id,
          customerPoNumber: `${TAG}-PO-77`,
        },
      });
    const warrantyOrder = await jobOrder('COMPLETED', 'WARRANTY');
    const openOrder = await jobOrder('APPROVED', 'CHARGEABLE');
    const doneOrder = await jobOrder('COMPLETED', 'CHARGEABLE');
    const billOrder = (id: string, number: string) =>
      fin('POST', '/invoices', { jobOrderId: id, lines: [{ description: `${number} — service call`, amount: 20_000 }] });

    const warrantyInv = await billOrder(warrantyOrder.id, warrantyOrder.number);
    check(
      'warranty work is not billed',
      warrantyInv.status === 400 && String(warrantyInv.body.error).includes('covered'),
      `${warrantyInv.status} ${JSON.stringify(warrantyInv.body).slice(0, 140)}`,
    );
    const earlyInv = await billOrder(openOrder.id, openOrder.number);
    check(
      'a job order is billed only once its report is approved',
      earlyInv.status === 400 && String(earlyInv.body.error).includes('report is approved'),
      `${earlyInv.status} ${JSON.stringify(earlyInv.body).slice(0, 140)}`,
    );
    const orderDay = manilaDayKey(new Date());
    const doneInv = await billOrder(doneOrder.id, doneOrder.number);
    check(
      'a completed chargeable order is invoiced, carrying the order',
      doneInv.status === 201 &&
        doneInv.body.jobOrderId === doneOrder.id &&
        doneInv.body.customer?.id === customer.id &&
        doneInv.body.poReference === `${TAG}-PO-77`,
      `${doneInv.status} ${JSON.stringify(doneInv.body).slice(0, 160)}`,
    );
    // The job-order screen sends no invoice date, so the server's is the one
    // the invoice prints. Either side of the request, in case midnight passed.
    check(
      'and, given no date, it is dated Manila’s today',
      [orderDay, manilaDayKey(new Date())].includes(String(doneInv.body.invoiceDate).slice(0, 10)),
      String(doneInv.body.invoiceDate),
    );
    check(
      'at net collectible = invoice total less EWT',
      money(doneInv.body.netCollectible, cents(doneInv.body.invoiceTotal - doneInv.body.ewtAmount)),
      `${doneInv.body.netCollectible} vs ${doneInv.body.invoiceTotal} − ${doneInv.body.ewtAmount}`,
    );
    const againInv = await billOrder(doneOrder.id, doneOrder.number);
    check(
      'and only once',
      againInv.status === 400 && String(againInv.body.error).includes('already invoiced'),
      `${againInv.status} ${JSON.stringify(againInv.body).slice(0, 140)}`,
    );

    // ══ Modifying and cancelling an invoice (Phase 2) ═══════════════════════
    console.log('\nModifying an invoice (over HTTP)');
    const iId = String(doneInv.body.id ?? '');
    const iDue = ymd(addDays(dayKey(new Date()), 45));
    const iLines = [
      { description: `${doneOrder.number} — service call`, amount: 15_000 },
      { description: 'Parts', amount: 5_000 },
    ];
    const iPut = await fin('PUT', `/invoices/${iId}`, { dueDate: iDue, poReference: `${TAG}-PO-78`, notes: 'Corrected', lines: iLines });
    const iTax = taxBreakdown(20_000, Number(doneInv.body.vatRate), Number(doneInv.body.ewtRate));
    check(
      'a draft job-order invoice is re-entered: lines replaced, tax recomputed at its own rates',
      iPut.status === 200 &&
        iPut.body.lines?.length === 2 &&
        money(iPut.body.grossAmount, 20_000) &&
        money(iPut.body.vatRate, doneInv.body.vatRate) &&
        money(iPut.body.netCollectible, iTax.netCollectible) &&
        iPut.body.poReference === `${TAG}-PO-78` &&
        String(iPut.body.dueDate).slice(0, 10) === iDue &&
        iPut.body.jobOrderId === doneOrder.id &&
        iPut.body.customer?.id === customer.id,
      `${iPut.status} ${JSON.stringify(iPut.body).slice(0, 200)}`,
    );
    const iPaper = await fin('GET', `/invoices/${iId}/pdf`);
    const iPaperText = iPaper.bytes ? pdfText(iPaper.bytes) : '';
    check(
      'its particulars print numbered under "No.", the figures in the table and the code in the head',
      iPaper.status === 200 &&
        flat(iPaperText).includes('NO.') &&
        flat(iPaperText).includes(`AMOUNT (${currency})`) &&
        iPaperText.includes('15,000.00') &&
        !iPaperText.includes(peso(15_000)) &&
        iPaperText.includes(peso(20_000)),
      iPaperText.split('\n').filter((l) => /NO\.|AMOUNT|15,000|20,000/.test(l)).join(' | '),
    );
    const iRepoint = await fin('PUT', `/invoices/${iId}`, { jobOrderId: openOrder.id, lines: iLines });
    check(
      'the job order it bills does not change',
      iRepoint.status === 400 && String(iRepoint.body.error).includes('job order'),
      `${iRepoint.status} ${JSON.stringify(iRepoint.body).slice(0, 140)}`,
    );
    const iOtherCustomer = await fin('PUT', `/invoices/${iId}`, { customerId: 'zz-somebody-else', lines: iLines });
    check(
      'nor does the customer of a job order’s invoice',
      iOtherCustomer.status === 400 && String(iOtherCustomer.body.error).includes('customer'),
      `${iOtherCustomer.status} ${JSON.stringify(iOtherCustomer.body).slice(0, 140)}`,
    );
    const iBackwards = await fin('PUT', `/invoices/${iId}`, { invoiceDate: '2026-09-30', dueDate: '2026-09-01', lines: iLines });
    check(
      'a due date before the invoice date is refused on Modify too',
      iBackwards.status === 400 && String(iBackwards.body.error).includes('before the invoice date'),
      `${iBackwards.status} ${JSON.stringify(iBackwards.body).slice(0, 140)}`,
    );
    const iNosy = await eng('PUT', `/invoices/${iId}`, { lines: iLines });
    check('nobody without A/R edit rights may modify an invoice', iNosy.status === 403, String(iNosy.status));

    // Cancelling it lets the job order go, so the corrected one can be raised.
    const iShort = await fin('POST', `/invoices/${iId}/cancel`, { reason: 'no' });
    check('cancelling an invoice asks why', iShort.status === 400, String(iShort.status));
    const iCancel = await fin('POST', `/invoices/${iId}/cancel`, { reason: 'wrong amount' });
    const iCancelled = await prisma.invoice.findUnique({ where: { id: iId } });
    const iTrail = await prisma.auditLog.findFirst({ where: { entityType: 'invoice', entityId: iId, action: 'CANCELLED' } });
    check(
      'cancelling a job order’s invoice lets the order go, and the trail says so',
      iCancel.status === 200 &&
        iCancelled?.status === 'CANCELLED' &&
        iCancelled.jobOrderId === null &&
        iCancelled.voidReason === 'wrong amount' &&
        !!iTrail?.summary?.includes(doneOrder.number),
      `${iCancel.status} ${iCancelled?.status} jobOrder ${iCancelled?.jobOrderId} · ${iTrail?.summary}`,
    );
    const iReraised = await billOrder(doneOrder.id, doneOrder.number);
    check(
      'so the job order can be invoiced again',
      iReraised.status === 201 && iReraised.body.jobOrderId === doneOrder.id,
      `${iReraised.status} ${JSON.stringify(iReraised.body).slice(0, 140)}`,
    );
    const iCancelledEdit = await fin('PUT', `/invoices/${iId}`, { lines: iLines });
    check('a cancelled invoice is not modified', iCancelledEdit.status === 400, String(iCancelledEdit.status));
    const iCancelAgain = await fin('POST', `/invoices/${iId}/cancel`, { reason: 'wrong amount' });
    check(
      'nor cancelled a second time',
      iCancelAgain.status === 400 && String(iCancelAgain.body.error).includes('Already cancelled'),
      `${iCancelAgain.status} ${JSON.stringify(iCancelAgain.body).slice(0, 120)}`,
    );

    // An invoice raised from a billing changes its header, never its figures.
    const report2 = await prisma.progressReport.create({
      data: {
        number: await nextNumber('progress_report'),
        jobId: job.id,
        reportNo: 2,
        status: 'APPROVED',
        periodFrom: dayKey(new Date()),
        periodTo: dayKey(new Date()),
        preparedById: engineer.id,
        accomplishment: `${TAG} 60% complete`,
      },
    });
    const billing2Tax = taxBreakdown(100_000, 0.12, 0.02);
    const billing2 = await prisma.progressBilling.create({
      data: {
        number: await nextNumber('progress_billing'),
        jobId: job.id,
        billingNo: 2,
        status: 'APPROVED',
        progressReportId: report2.id,
        billingDate: dayKey(new Date()),
        grossAmount: D(billing2Tax.grossAmount),
        vatRate: D(0.12),
        vatAmount: D(billing2Tax.vatAmount),
        ewtRate: D(0.02),
        ewtAmount: D(billing2Tax.ewtAmount),
        invoiceTotal: D(billing2Tax.invoiceTotal),
        netCollectible: D(billing2Tax.netCollectible),
        approvedAt: new Date(),
      },
    });
    const fbRaised = await fin('POST', `/invoices/from-billing/${billing2.id}`, {});
    const fbId = String(fbRaised.body.id ?? '');
    const fbFigures = await fin('PUT', `/invoices/${fbId}`, { lines: [{ description: 'More', amount: 1 }] });
    check(
      'a billing’s invoice refuses new figures, naming the billing they come from',
      fbRaised.status === 201 && fbFigures.status === 400 && String(fbFigures.body.error).includes(billing2.number),
      `${fbRaised.status} / ${fbFigures.status} ${JSON.stringify(fbFigures.body).slice(0, 160)}`,
    );
    const fbHeader = await fin('PUT', `/invoices/${fbId}`, { dueDate: iDue, poReference: `${TAG}-PO-90`, notes: 'Per their A/P clerk' });
    check(
      'and takes a new due date, PO reference and notes with its figures untouched',
      fbHeader.status === 200 &&
        String(fbHeader.body.dueDate).slice(0, 10) === iDue &&
        fbHeader.body.poReference === `${TAG}-PO-90` &&
        money(fbHeader.body.grossAmount, 100_000) &&
        money(fbHeader.body.netCollectible, billing2Tax.netCollectible) &&
        fbHeader.body.lines?.length === fbRaised.body.lines?.length,
      `${fbHeader.status} ${JSON.stringify(fbHeader.body).slice(0, 200)}`,
    );
    // An invoice has no route: it prints who prepared it and who issued it,
    // each dated — "Pending" while a draft — and never its creator as an
    // approver, nor a "Received by" nobody in the app fills.
    const fbDraftPdf = await fin('GET', `/invoices/${fbId}/pdf`);
    const fbDraftText = fbDraftPdf.bytes ? pdfText(fbDraftPdf.bytes) : '';
    const nameCount = (t: string, name: string) => t.split('\n').filter((l) => l.trim() === name).length;
    check(
      'a draft invoice prints PREPARED BY, dated, and ISSUED BY "Pending" under nobody — never an APPROVED BY',
      fbDraftPdf.status === 200 &&
        flat(fbDraftText).includes('PREPARED BY') &&
        flat(fbDraftText).includes('ISSUED BY') &&
        !flat(fbDraftText).includes('APPROVED BY') &&
        !flat(fbDraftText).includes('RECEIVED BY') &&
        nameCount(fbDraftText, finance.name) === 1 &&
        signedCount(fbDraftText) === 1 &&
        pendingCount(fbDraftText) === 1 &&
        fbDraftText.includes('Draft'),
      `${fbDraftPdf.status} · ${signedCount(fbDraftText)} signed, ${pendingCount(fbDraftText)} pending, ${nameCount(fbDraftText, finance.name)}× ${finance.name}`,
    );
    const fbIssue = await fin('POST', `/invoices/${fbId}/issue`);
    const fbIssuedPdf = await fin('GET', `/invoices/${fbId}/pdf`);
    const fbIssuedText = fbIssuedPdf.bytes ? pdfText(fbIssuedPdf.bytes) : '';
    check(
      'issued, it prints who issued it — the trail’s issue row — dated, and nothing Pending',
      fbIssuedPdf.status === 200 &&
        flat(fbIssuedText).includes('ISSUED BY') &&
        nameCount(fbIssuedText, finance.name) === 2 &&
        signedCount(fbIssuedText) === 2 &&
        pendingCount(fbIssuedText) === 0 &&
        fbIssuedText.includes('Issued'),
      `${fbIssuedPdf.status} · ${signedCount(fbIssuedText)} signed, ${pendingCount(fbIssuedText)} pending`,
    );
    check('both prints are on the invoice’s trail as EXPORTED', (await exportsOf('invoice', fbId)) === 2);
    const fbIssued = await fin('PUT', `/invoices/${fbId}`, { notes: 'too late' });
    check(
      'an issued invoice refuses Modify',
      fbIssue.status === 200 && fbIssued.status === 400 && String(fbIssued.body.error).includes('Only a draft'),
      `${fbIssue.status} / ${fbIssued.status} ${JSON.stringify(fbIssued.body).slice(0, 140)}`,
    );
    const fbCancel = await fin('POST', `/invoices/${fbId}/cancel`, { reason: 'customer asked for a split' });
    const billing2After = await prisma.progressBilling.findUnique({ where: { id: billing2.id }, include: { invoice: true } });
    check(
      'cancelling it puts the billing back to be invoiced again',
      fbCancel.status === 200 && billing2After?.status === 'APPROVED' && billing2After.invoice === null,
      `${fbCancel.status} ${billing2After?.status} ${billing2After?.invoice?.number ?? 'no invoice'}`,
    );

    // The customer-facing invoice prints.
    const invoicePdf = await fin('GET', `/invoices/${invoice.id}/pdf`);
    const invoiceText = invoicePdf.bytes ? pdfText(invoicePdf.bytes) : '';
    check(
      'the sales invoice prints as a PDF',
      invoicePdf.status === 200 && invoicePdf.type.includes('application/pdf'),
      `${invoicePdf.status} ${invoicePdf.type}`,
    );
    check(
      'its money is the quotation’s totals block: Gross, VAT (12%), Invoice total, Less: EWT (2%), Net collectible',
      invoiceText.includes('Gross') &&
        invoiceText.includes(peso(400_000)) &&
        invoiceText.includes('VAT (12%)') &&
        invoiceText.includes(peso(48_000)) &&
        invoiceText.includes('Invoice total') &&
        invoiceText.includes(peso(448_000)) &&
        invoiceText.includes('Less: EWT (2%)') &&
        invoiceText.includes(peso(8_000)) &&
        invoiceText.includes('Net collectible') &&
        invoiceText.includes(peso(440_000)) &&
        !invoiceText.includes('NET COLLECTIBLE') &&
        !invoiceText.includes('INVOICE TOTAL') &&
        !invoiceText.includes('±'),
      invoiceText.split('\n').filter((l) => /Gross|VAT|total|EWT|collectible/i.test(l)).join(' | '),
    );
    check(
      'an invoice issued outside the routes names no issuer rather than guessing one',
      flat(invoiceText).includes('PREPARED BY') &&
        !flat(invoiceText).includes('ISSUED BY') &&
        !flat(invoiceText).includes('APPROVED BY') &&
        signedCount(invoiceText) === 1 &&
        pendingCount(invoiceText) === 0,
      `${signedCount(invoiceText)} signed, ${pendingCount(invoiceText)} pending`,
    );
    const invoicePdfNosy = await eng('GET', `/invoices/${invoice.id}/pdf`);
    check('and is refused to anyone without A/R access', invoicePdfNosy.status === 403, String(invoicePdfNosy.status));

    // The billing points at its invoice (audit fix 15, the delivery half).
    const billingView = await fin('GET', `/billings/${billing.id}`);
    if (billingView.status === 200 && !('invoice' in billingView.body)) {
      failed += 1;
      console.log(
        '  ✗ GET /billings/:id does not carry its invoice yet — that half of audit fix 15 lives in\n' +
          '      progress.ts (the DEL package). This fails until it is merged.',
      );
    } else {
      check(
        'a billing names the invoice raised from it',
        billingView.status === 200 && billingView.body.invoice?.number === invoice.number,
        `${billingView.status} ${JSON.stringify(billingView.body.invoice ?? null)}`,
      );
    }

    // Both "Mark cleared" buttons post no body, so the server's date is the
    // only one a cleared cheque ever gets. It must be Manila's: cleared at
    // 07:30 on the 1st, the UTC date put the money in last month.
    const cheque = await prisma.payment.create({
      data: {
        number: await nextNumber('payment'),
        kind: 'RECEIPT',
        method: 'CHECK',
        paymentDate: dayKey(new Date()),
        customerId: customer.id,
        amount: D(1_000),
        reference: `${TAG}-CHK-CLEAR`,
        recordedById: finance.id,
        allocations: { create: [{ invoiceId: secondInvoice.id, amount: D(1_000) }] },
      },
    });
    const clearDay = manilaDayKey(new Date());
    const cleared = await fin('POST', `/payments/${cheque.id}/clear`);
    const clearedOn = (await prisma.payment.findUnique({ where: { id: cheque.id } }))?.clearedAt;
    check(
      'a cheque marked cleared with no date clears on Manila’s today',
      cleared.status === 200 && !!clearedOn && [clearDay, manilaDayKey(new Date())].includes(ymd(clearedOn)),
      `${cleared.status} ${clearedOn?.toISOString()}`,
    );

    // ══ Every register prints (rule 6, A5) ═════════════════════════════════
    // `GET <list>/pdf` reads the list's own where-builder, so the paper is the
    // screen: the same rows for the same query, the rows ticked with `?ids=`
    // (ANDed with who may see what), every filter named in the reference, and
    // an EXPORTED audit row with entityId 'list'.
    console.log('\nThe registers on paper');
    /** Numbers may wrap inside a narrow cell: compare with every space gone. */
    const squash = (t: string) => t.replace(/\s+/g, '');
    const listExports = (entityType: string, actorId: string) =>
      prisma.auditLog.count({ where: { entityType, entityId: 'list', action: 'EXPORTED', actorId } });
    type Row = { id: string; number: string; status?: string };
    const numbersOf = (body: { rows?: Row[] }) => (body.rows ?? []).map((r) => r.number);
    /**
     * A status that splits the rows on file — some have it, some do not — so
     * a filter check keeps some rows and drops others whatever the run left.
     */
    const splitting = (rows: Row[]) =>
      [...new Set(rows.map((r) => r.status ?? ''))].find((st) => {
        const n = rows.filter((r) => r.status === st).length;
        return st && n > 0 && n < rows.length;
      }) ?? 'NONE';
    const searched = `search=${TAG}`;
    const registers: {
      path: string;
      entity: string;
      /** The filter query (search included where it narrows the same set) and how the reference names it. */
      filter: (rows: Row[]) => { query: string; named: string };
      ownScope: boolean;
      /** Who raised a row, where the list takes `?requestedById=` — the filter must only ever narrow. */
      requester?: (id: string) => Promise<string | undefined>;
    }[] = [
      {
        path: 'invoices',
        entity: 'invoice',
        filter: (rows) => ({
          query: `${searched}&customerId=${customer.id}&status=${splitting(rows)}`,
          named: `status ${statusLabel(splitting(rows))} · customer ${customer.name}`,
        }),
        ownScope: false,
      },
      {
        path: 'supplier-bills',
        entity: 'supplier_bill',
        filter: (rows) => ({
          query: `${searched}&supplierId=${supplier.id}&status=${splitting(rows)}`,
          named: `status ${statusLabel(splitting(rows))} · supplier ${supplier.name}`,
        }),
        ownScope: false,
      },
      // The search finds the customer's receipts; the payee filter, the money
      // handed to the engineer — none of which the search found.
      { path: 'payments', entity: 'payment', filter: () => ({ query: `payeeUserId=${engineer.id}`, named: `with ${engineer.name}` }), ownScope: false },
      { path: 'expense-claims', entity: 'expense_claim', filter: () => ({ query: `${searched}&kind=reimbursement`, named: 'reimbursements' }), ownScope: true },
      {
        path: 'cash-advances',
        entity: 'cash_advance',
        filter: () => ({ query: `${searched}&requestedById=${engineer.id}`, named: `requested by ${engineer.name}` }),
        ownScope: true,
        requester: async (id) => (await prisma.cashAdvance.findUnique({ where: { id }, select: { requestedById: true } }))?.requestedById,
      },
      {
        path: 'budget-requests',
        entity: 'budget_request',
        filter: (rows) => ({
          query: `${searched}&jobId=${job.id}&status=${splitting(rows)}`,
          named: `status ${statusLabel(splitting(rows))} · project ${job.number}`,
        }),
        ownScope: true,
        requester: async (id) => (await prisma.budgetRequest.findUnique({ where: { id }, select: { requestedById: true } }))?.requestedById,
      },
    ];
    for (const reg of registers) {
      const exportsBefore = await listExports(reg.entity, finance.id);
      const screen = await fin('GET', `/${reg.path}?search=${TAG}&pageSize=200`);
      const shown = numbersOf(screen.body);
      const paper = await fin('GET', `/${reg.path}/pdf?search=${TAG}`);
      const text = paper.bytes ? pdfText(paper.bytes) : '';
      check(
        `/${reg.path}/pdf prints the list as the screen shows it — every row, the search named`,
        paper.status === 200 &&
          paper.type.includes('application/pdf') &&
          shown.length > 0 &&
          shown.every((n) => squash(text).includes(n)) &&
          flat(text).includes(`search "${TAG}"`),
        `${paper.status} ${paper.type} · ${shown.length} row(s) · missing ${shown.filter((n) => !squash(text).includes(n)).join(', ')}`,
      );

      const [first, ...rest] = (screen.body.rows ?? []) as Row[];
      const ticked = await fin('GET', `/${reg.path}/pdf?ids=${first?.id ?? 'none'}`);
      const tickedText = ticked.bytes ? pdfText(ticked.bytes) : '';
      check(
        `/${reg.path}/pdf?ids= prints only the rows ticked, and says so`,
        ticked.status === 200 &&
          !!first &&
          squash(tickedText).includes(first.number) &&
          rest.every((r) => !squash(tickedText).includes(r.number)) &&
          flat(tickedText).includes('the rows selected'),
        `${ticked.status} · ${rest.filter((r) => squash(tickedText).includes(r.number)).length} other row(s) printed`,
      );

      const { query, named } = reg.filter((screen.body.rows ?? []) as Row[]);
      const narrowed = await fin('GET', `/${reg.path}?${query}&pageSize=200`);
      const kept = numbersOf(narrowed.body);
      const dropped = shown.filter((n) => !kept.includes(n));
      const filtered = await fin('GET', `/${reg.path}/pdf?${query}`);
      const filteredText = filtered.bytes ? pdfText(filtered.bytes) : '';
      check(
        `/${reg.path}/pdf names the filter that narrowed it (${named}) and prints exactly the rows it keeps`,
        filtered.status === 200 &&
          narrowed.status === 200 &&
          flat(filteredText).includes(named) &&
          // Not vacuous: the filter keeps some rows and drops others.
          kept.length > 0 &&
          dropped.length > 0 &&
          kept.every((n) => squash(filteredText).includes(n)) &&
          dropped.every((n) => !squash(filteredText).includes(n)),
        `${filtered.status} · kept ${kept.length}, dropped ${dropped.length} · ${flat(filteredText).match(/Reference:.{0,160}/)?.[0] ?? ''}`,
      );
      check(
        `and each print of /${reg.path}/pdf is on the trail as EXPORTED, entityId "list"`,
        (await listExports(reg.entity, finance.id)) === exportsBefore + 3,
        `${(await listExports(reg.entity, finance.id)) - exportsBefore} new row(s)`,
      );

      if (reg.ownScope) {
        // A view_own holder prints their own rows, whatever they tick.
        const own = numbersOf((await eng('GET', `/${reg.path}?search=${TAG}&pageSize=200`)).body);
        const ownPaper = await eng('GET', `/${reg.path}/pdf?search=${TAG}`);
        const ownText = ownPaper.bytes ? pdfText(ownPaper.bytes) : '';
        const theirs = ((screen.body.rows ?? []) as Row[]).filter((r) => !own.includes(r.number));
        check(
          `/${reg.path}/pdf for someone who sees only their own prints only their own`,
          ownPaper.status === 200 &&
            own.length > 0 &&
            own.every((n) => squash(ownText).includes(n)) &&
            theirs.every((r) => !squash(ownText).includes(r.number)),
          `${ownPaper.status} · own ${own.length}, others ${theirs.length}`,
        );
        if (theirs.length) {
          const sneaky = await eng('GET', `/${reg.path}/pdf?ids=${theirs[0].id}`);
          const sneakyText = sneaky.bytes ? pdfText(sneaky.bytes) : '';
          check(
            `and ticking somebody else’s row on /${reg.path}/pdf prints nothing of it`,
            sneaky.status === 200 && !squash(sneakyText).includes(theirs[0].number) && flat(sneakyText).includes('Reference: 0 '),
            `${sneaky.status} ${flat(sneakyText).match(/Reference:.{0,80}/)?.[0] ?? ''}`,
          );
          // The requested-by filter is ANDed with "only their own", never
          // written over it: naming somebody else lists and prints nothing.
          if (reg.requester) {
            const other = await reg.requester(theirs[0].id);
            const askedList = await eng('GET', `/${reg.path}?requestedById=${other ?? 'none'}&pageSize=200`);
            const askedPaper = await eng('GET', `/${reg.path}/pdf?requestedById=${other ?? 'none'}`);
            const askedText = askedPaper.bytes ? pdfText(askedPaper.bytes) : '';
            check(
              `and naming somebody else as the requester on /${reg.path} lists and prints none of theirs`,
              !!other &&
                other !== engineer.id &&
                askedList.status === 200 &&
                askedList.body.total === 0 &&
                numbersOf(askedList.body).length === 0 &&
                askedPaper.status === 200 &&
                theirs.every((r) => !squash(askedText).includes(r.number)) &&
                flat(askedText).includes('Reference: 0 '),
              `${askedList.status} total ${askedList.body.total} · ${askedPaper.status} ${flat(askedText).match(/Reference:.{0,100}/)?.[0] ?? ''}`,
            );
          }
        }
      } else {
        const refused = await eng('GET', `/${reg.path}/pdf`);
        check(`/${reg.path}/pdf is refused to anyone the list itself refuses`, refused.status === 403, String(refused.status));
      }
    }

    // The money reconciles to the screen's rows. The bold Outstanding is the
    // RECEIVABLE (the payable on the bill paper) — `financePosition`'s rule:
    // only an issued or part-paid invoice, an approved or part-paid bill, is
    // owed. A draft (a bill not approved yet) is counted in the other totals
    // and prints "—" in the column; a cancelled one is in brackets.
    /** The figure a totals row prints — the line after its label ("Outstanding, all 1,234" past the cap). */
    const totalAfter = (t: string, label: string) => {
      const lines = t.split('\n').map((l) => l.trim());
      const at = lines.findIndex((l) => l === label || l.startsWith(`${label}, all `));
      return at >= 0 ? lines[at + 1] : undefined;
    };
    type MoneyRow = { id: string; number: string; status: string; outstanding: number };
    const papers = [
      {
        path: 'invoices',
        owed: ['ISSUED', 'PARTIALLY_PAID'],
        unowed: ['DRAFT'],
        note: 'counted in Invoiced and Net collectible but not in Outstanding',
        // A draft and an issued invoice on the paper, whatever the run left
        // there, so leaving one out and keeping the other is not vacuous.
        fixtures: async () =>
          Promise.all(
            (['DRAFT', 'ISSUED'] as const).map((status) =>
              prisma.invoice.create({
                data: {
                  number: `${TAG}-INV-${status}`,
                  status,
                  customerId: customer.id,
                  invoiceDate: dayKey(new Date()),
                  dueDate: dayKey(new Date()),
                  grossAmount: D(5_000),
                  vatRate: D(0.12),
                  vatAmount: D(600),
                  ewtRate: D(0.02),
                  ewtAmount: D(100),
                  invoiceTotal: D(5_600),
                  netCollectible: D(5_500),
                  createdById: finance.id,
                },
                select: { id: true },
              }),
            ),
          ),
        drop: (ids: string[]) => prisma.invoice.deleteMany({ where: { id: { in: ids } } }),
      },
      {
        path: 'supplier-bills',
        owed: ['APPROVED', 'PARTIALLY_PAID'],
        unowed: ['DRAFT', 'PENDING_APPROVAL'],
        note: 'counted in Billed and Net payable but not in Outstanding',
        fixtures: async () =>
          Promise.all(
            (['PENDING_APPROVAL', 'APPROVED'] as const).map((status) =>
              prisma.supplierBill.create({
                data: {
                  number: `${TAG}-BILL-${status}`,
                  status,
                  supplierId: supplier.id,
                  supplierInvoiceNo: `${TAG}-SI-${status}`,
                  billDate: dayKey(new Date()),
                  dueDate: dayKey(new Date()),
                  subtotal: D(2_000),
                  vatRate: D(0.12),
                  vatAmount: D(240),
                  ewtRate: D(0),
                  ewtAmount: D(0),
                  total: D(2_240),
                  netPayable: D(2_240),
                  createdById: finance.id,
                },
                select: { id: true },
              }),
            ),
          ),
        drop: (ids: string[]) => prisma.supplierBill.deleteMany({ where: { id: { in: ids } } }),
      },
    ];
    for (const p of papers) {
      const made = (await p.fixtures()).map((m) => m.id);
      const screen = await fin('GET', `/${p.path}?search=${TAG}&pageSize=200`);
      const rows = (screen.body.rows ?? []) as MoneyRow[];
      const owedRows = rows.filter((r) => p.owed.includes(r.status));
      const unowed = rows.filter((r) => p.unowed.includes(r.status));
      const expected = peso(cents(owedRows.reduce((sum, r) => sum + r.outstanding, 0)));
      const [paper, owedPaper] = await Promise.all([
        fin('GET', `/${p.path}/pdf?search=${TAG}`),
        fin('GET', `/${p.path}/pdf?search=${TAG}&outstanding=true`),
      ]);
      const text = paper.bytes ? pdfText(paper.bytes) : '';
      const owedText = owedPaper.bytes ? pdfText(owedPaper.bytes) : '';
      check(
        `the /${p.path} paper’s Outstanding is the screen’s owed rows summed — ${p.unowed.map((st) => statusLabel(st).toLowerCase()).join(' or ')} left out, the note saying so`,
        paper.status === 200 &&
          unowed.some((r) => r.outstanding > 0) &&
          owedRows.length > 0 &&
          totalAfter(text, 'Outstanding') === expected &&
          flat(text).includes(p.note),
        `expected ${expected}, printed ${totalAfter(text, 'Outstanding')} · ${owedRows.length} owed, ${unowed.length} not owed yet`,
      );
      check(
        `and it equals the /${p.path}?outstanding=true paper’s`,
        owedPaper.status === 200 && totalAfter(owedText, 'Outstanding') === totalAfter(text, 'Outstanding'),
        `${totalAfter(text, 'Outstanding')} vs ${totalAfter(owedText, 'Outstanding')}`,
      );
      await p.drop(made);
    }
    // The whole register too: unfiltered, Outstanding is the receivable and the
    // payable. Read twice at once; another suite may write between two reads,
    // so a mismatch is read once more before it counts.
    for (const path of ['invoices', 'supplier-bills']) {
      let pair: [string | undefined, string | undefined] = [undefined, undefined];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const [all, owedOnly] = await Promise.all([fin('GET', `/${path}/pdf`), fin('GET', `/${path}/pdf?outstanding=true`)]);
        pair = [
          totalAfter(all.bytes ? pdfText(all.bytes) : '', 'Outstanding'),
          totalAfter(owedOnly.bytes ? pdfText(owedOnly.bytes) : '', 'Outstanding'),
        ];
        if (pair[0] && pair[0] === pair[1]) break;
      }
      check(`the unfiltered /${path} paper’s Outstanding equals the ?outstanding=true paper’s`, !!pair[0] && pair[0] === pair[1], `${pair[0]} vs ${pair[1]}`);
    }
    const badDay = await fin('GET', '/invoices/pdf?from=not-a-date');
    check('a filter date that is not a date is a 400, never a 500', badDay.status === 400, String(badDay.status));

    // ══ Accounts Receivable per the owner's sample (2026-10-15) ═══════════
    console.log('\nAccounts Receivable — countering, terms, credit, sales orders');
    const sixtyAgo = ymd(addDays(dayKey(new Date()), -60));
    const arNew = await fin('POST', '/invoices', {
      customerId: customer.id,
      invoiceDate: sixtyAgo,
      termsDays: 30,
      lines: [{ description: `${TAG} countering`, amount: 10_000 }],
    });
    check(
      'a new invoice keeps its terms; its due date is the invoice date plus them until it is countered',
      arNew.status === 201 &&
        arNew.body.termsDays === 30 &&
        arNew.body.termsLabel === 'Net 30' &&
        arNew.body.counteredDate === null &&
        String(arNew.body.dueDate).slice(0, 10) === ymd(addDays(dayKey(new Date()), -30)),
      `${arNew.status} ${JSON.stringify(arNew.body).slice(0, 200)}`,
    );
    const arId = String(arNew.body.id ?? '');
    // Mark as received (2026-10-16): on a draft it issues and counters in one step;
    // the withholding rate is the invoice's own (1% here).
    const received = await fin('POST', '/invoices', {
      customerId: customer.id,
      termsDays: 30,
      ewtRate: 0.01,
      lines: [{ description: `${TAG} received`, amount: 10_000 }],
    });
    check(
      'an invoice withholds at the rate picked: 1% of 10,000 is 100, net collectible 11,100',
      received.status === 201 && received.body.ewtRate === 0.01 && received.body.ewtAmount === 100 && received.body.netCollectible === 11_100,
      `${received.status} ${received.body.ewtRate} ${received.body.ewtAmount} ${received.body.netCollectible}`,
    );
    const rewithheld = await fin('PUT', `/invoices/${received.body.id}`, { ewtRate: 0.02 });
    check(
      'a draft takes a new withholding rate alone, the gross kept',
      rewithheld.status === 200 && rewithheld.body.ewtAmount === 200 && rewithheld.body.netCollectible === 11_000,
      `${rewithheld.status} ${rewithheld.body.ewtAmount} ${rewithheld.body.netCollectible}`,
    );
    const markReceived = await fin('POST', `/invoices/${received.body.id}/counter`, {});
    check(
      'Mark as received issues a draft and records the day the customer received it',
      markReceived.status === 200 && markReceived.body.status === 'ISSUED' && !!markReceived.body.counteredDate && markReceived.body.awaitingCounter === false,
      `${markReceived.status} ${markReceived.body.status} ${markReceived.body.counteredDate}`,
    );
    await fin('POST', `/invoices/${arId}/issue`);
    const arIssued = await fin('GET', `/invoices/${arId}`);
    check(
      'issued and not countered, it is awaiting countering and never late, whatever its date',
      arIssued.body.awaitingCounter === true && arIssued.body.daysOverdue === 0,
      JSON.stringify({ a: arIssued.body.awaitingCounter, d: arIssued.body.daysOverdue }),
    );
    const listed = async (query: string) =>
      ((await fin('GET', `/invoices?search=${encodeURIComponent(String(arNew.body.number))}&${query}`)).body.rows ?? []).map((r: { id: string }) => r.id);
    check(
      'the list’s Overdue leaves it out, its Awaiting countering holds it',
      !(await listed('overdue=true')).includes(arId) && (await listed('countered=no')).includes(arId),
    );
    const agingNow = await fin('GET', '/finance-reports/ar-aging');
    const agedRow = (agingNow.body.rows ?? []).find((r: { id: string }) => r.id === arId);
    check(
      'and the aging counts it Current, apart as awaiting countering',
      !!agedRow && agedRow.awaitingCounter === true && agedRow.bucket === 'Current' && agingNow.body.awaitingCountering >= 11_200 - 0.005 - 200,
      JSON.stringify(agedRow ?? agingNow.body).slice(0, 160),
    );
    const tomorrow = ymd(addDays(dayKey(new Date()), 1));
    const futureCounter = await fin('POST', `/invoices/${arId}/counter`, { counteredDate: tomorrow });
    const earlyCounter = await fin('POST', `/invoices/${arId}/counter`, { counteredDate: ymd(addDays(dayKey(new Date()), -61)) });
    check(
      'it is never countered on a day still to come, nor before its invoice date',
      futureCounter.status === 400 && earlyCounter.status === 400,
      `${futureCounter.status} ${earlyCounter.status}`,
    );
    const fortyAgo = ymd(addDays(dayKey(new Date()), -40));
    const countered = await fin('POST', `/invoices/${arId}/counter`, { counteredDate: fortyAgo });
    check(
      'countered forty days ago on Net 30: expected ten days ago, ten days late',
      countered.status === 200 &&
        String(countered.body.counteredDate).slice(0, 10) === fortyAgo &&
        String(countered.body.dueDate).slice(0, 10) === ymd(addDays(dayKey(new Date()), -10)) &&
        countered.body.daysOverdue === 10 &&
        countered.body.awaitingCounter === false,
      `${countered.status} ${JSON.stringify(countered.body).slice(0, 200)}`,
    );
    check(
      'and now the list’s Overdue and Countered both hold it',
      (await listed('overdue=true')).includes(arId) && (await listed('countered=yes')).includes(arId),
    );
    const arSummary = (await fin('GET', `/invoices?search=${TAG}&pageSize=200`)).body.summary;
    check(
      'the list carries its cards: the receivable, overdue, awaiting countering and each team’s share',
      typeof arSummary?.receivable === 'number' &&
        arSummary.overdue >= 11_000 &&
        Array.isArray(arSummary.teams) &&
        money(
          arSummary.teams.reduce((sum: number, t: { value: number }) => sum + t.value, 0),
          arSummary.receivable,
        ),
      JSON.stringify(arSummary).slice(0, 200),
    );
    const badTerms = await fin('GET', '/invoices?termsDays=abc');
    const badCountered = await fin('GET', '/invoices?countered=maybe');
    check('an unknown terms or countered filter is a 400', badTerms.status === 400 && badCountered.status === 400, `${badTerms.status} ${badCountered.status}`);

    const team = await prisma.industry.findFirst({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } });
    const credited = await fin('PATCH', `/invoices/${arId}/credit`, { salespersonId: engineer.id, teamId: team?.id ?? null });
    const badTeam = await fin('PATCH', `/invoices/${arId}/credit`, { teamId: 'no-such-team' });
    check(
      'the salesperson and team are changed on an issued invoice; an unknown team is refused',
      credited.status === 200 && credited.body.salesperson?.id === engineer.id && credited.body.team?.id === team?.id && badTeam.status === 400,
      `${credited.status} ${badTeam.status}`,
    );
    const arPaper = await fin('GET', `/invoices/${arId}/pdf`);
    const arText = arPaper.bytes ? flat(pdfText(arPaper.bytes)).toLowerCase() : '';
    check(
      'the invoice paper prints the terms, the countered day and the sales personnel',
      arPaper.status === 200 && arText.includes('net 30') && arText.includes('countered') && arText.includes(engineer.name.toLowerCase()),
      arText.slice(0, 200),
    );

    // An issued sales order, billed in parts, never past its net.
    const soQuote = await prisma.quotation.create({
      data: { number: `${TAG}-Q-AR1`, customerId: customer.id, ownerId: engineer.id, subject: `${TAG} AR ORDER`, teamId: team?.id ?? null },
    });
    const so = await prisma.salesOrder.create({
      data: {
        number: `${TAG}-SO-AR1`,
        status: 'ISSUED',
        quotationId: soQuote.id,
        customerId: customer.id,
        ownerId: engineer.id,
        orderDate: dayKey(new Date()),
        termsDays: 45,
        poNumber: `${TAG}-PO-SO`,
        vatRate: D(0.12),
        subtotal: D(100_000),
        vatAmount: D(12_000),
        total: D(112_000),
      },
    });
    const soOptions = await fin('GET', `/invoices/sales-orders?customerId=${customer.id}`);
    const soOption = (soOptions.body as { id: string; net: number; left: number }[]).find?.((o) => o.id === so.id);
    check('the form offers the customer’s issued order with its net left to invoice', !!soOption && money(soOption.net, 100_000) && money(soOption.left, 100_000), JSON.stringify(soOption));
    const soInv1 = await fin('POST', '/invoices', { customerId: customer.id, salesOrderId: so.id, lines: [{ description: 'First delivery', amount: 60_000 }] });
    check(
      'an invoice bills part of it: its PO, its terms, its salesperson and its quotation’s team',
      soInv1.status === 201 &&
        soInv1.body.salesOrder?.id === so.id &&
        soInv1.body.poReference === `${TAG}-PO-SO` &&
        soInv1.body.termsDays === 45 &&
        soInv1.body.salesperson?.id === engineer.id &&
        soInv1.body.team?.id === (team?.id ?? undefined),
      `${soInv1.status} ${JSON.stringify(soInv1.body).slice(0, 220)}`,
    );
    const soTooMuch = await fin('POST', '/invoices', { customerId: customer.id, salesOrderId: so.id, lines: [{ description: 'Too much', amount: 50_000 }] });
    check('never past what is left of its net', soTooMuch.status === 400 && String(soTooMuch.body.error).includes('left to invoice'), `${soTooMuch.status} ${soTooMuch.body.error}`);
    const soRest = await fin('POST', '/invoices', { customerId: customer.id, salesOrderId: so.id, lines: [{ description: 'The rest', amount: 40_000 }] });
    const soLeft = ((await fin('GET', `/invoices/sales-orders?customerId=${customer.id}`)).body as { id: string; left: number }[]).find((o) => o.id === so.id);
    check('the rest goes on a second invoice, and nothing is left', soRest.status === 201 && !!soLeft && money(soLeft.left, 0), `${soRest.status} ${JSON.stringify(soLeft)}`);
    const otherCustomer = await prisma.customer.create({ data: { code: `${TAG}-C2`, name: `${TAG} Other` } });
    const soWrong = await fin('POST', '/invoices', { customerId: otherCustomer.id, salesOrderId: so.id, lines: [{ description: 'x', amount: 1 }] });
    check('another customer’s order is refused', soWrong.status === 400, String(soWrong.status));

    // ══ Collections (2026-10-15): the OR, the credit, the register's cards ══
    console.log('\nCollections — the official receipt, the credit, the cards');
    const arLeft = (await fin('GET', `/invoices/${arId}`)).body.outstanding as number;
    const collected = await fin('POST', '/payments', {
      kind: 'RECEIPT',
      method: 'CHECK',
      reference: `${TAG}-CHK-1`,
      allocations: [{ kind: 'invoice', id: arId, amount: arLeft }],
    });
    check(
      'a collection is given an official receipt number, and the invoices’ customer though the form named none',
      collected.status === 201 && /OR/.test(String(collected.body.orNumber)) && collected.body.customerId === customer.id,
      `${collected.status} ${JSON.stringify(collected.body).slice(0, 200)}`,
    );
    check(
      'and it is credited to the invoice’s salesperson and team',
      collected.body.salespeople?.[0]?.id === engineer.id && collected.body.teams?.[0]?.id === team?.id,
      JSON.stringify({ s: collected.body.salespeople, t: collected.body.teams }),
    );
    const payId = String(collected.body.id ?? '');
    const byCredit = await fin('GET', `/payments?kind=RECEIPT&salespersonId=${engineer.id}&pageSize=200`);
    check(
      'the register filters collections by the salesperson of the invoices they settled',
      (byCredit.body.rows ?? []).some((r: { id: string }) => r.id === payId),
    );
    const paySummary = (await fin('GET', `/payments?search=${encodeURIComponent(customer.name)}&kind=RECEIPT&pageSize=200`)).body.summary;
    check(
      'its cards: the collections, the uncleared cheques among them, each team’s share adding up to the collections',
      paySummary?.collected >= arLeft - 0.005 &&
        paySummary.uncleared >= arLeft - 0.005 &&
        money(
          (paySummary.teams as { value: number }[]).reduce((sum, t) => sum + t.value, 0),
          paySummary.collected,
        ),
      JSON.stringify(paySummary).slice(0, 200),
    );
    const receiptPaper = await fin('GET', `/payments/${payId}/pdf`);
    const receiptText = receiptPaper.bytes ? flat(pdfText(receiptPaper.bytes)) : '';
    check(
      'the Collection Receipt prints under its OR number with the invoice it settled, the cheque named uncleared',
      receiptPaper.status === 200 &&
        /COLLECTION\s*RECEIPT/i.test(receiptText) &&
        receiptText.includes(String(collected.body.orNumber)) &&
        receiptText.includes(String(arNew.body.number)) &&
        /not yet cleared/i.test(receiptText),
      receiptText.slice(0, 200),
    );
    const otherInv = await fin('POST', '/invoices', { customerId: otherCustomer.id, lines: [{ description: `${TAG} other`, amount: 1_000 }] });
    await fin('POST', `/invoices/${otherInv.body.id}/issue`);
    const mixed = await fin('POST', '/payments', {
      kind: 'RECEIPT',
      method: 'CASH',
      allocations: [
        { kind: 'invoice', id: soInv1.body.id, amount: 100 },
        { kind: 'invoice', id: otherInv.body.id, amount: 100 },
      ],
    });
    check('one collection is from one customer — two customers’ invoices are refused', mixed.status === 400, `${mixed.status} ${mixed.body.error}`);

    // ══ Finance reports (2026-10-15): one per menu, the A/R list's own rule ══
    console.log('\nFinance reports — the aging, the receivables, the forecast, the collections');
    const [agingRep, arAll] = await Promise.all([fin('GET', '/fin-reports/aging'), fin('GET', '/invoices?pageSize=1')]);
    const agingCard = (label: string) => (agingRep.body.cards as { label: string; value: number }[] | undefined)?.find((c) => c.label === label)?.value;
    check(
      'the aging’s Outstanding and Overdue are the A/R list’s Total receivables and Overdue cards',
      agingRep.status === 200 &&
        money(agingCard('Outstanding') ?? -1, arAll.body.summary?.receivable) &&
        money(agingCard('Overdue') ?? -1, arAll.body.summary?.overdue) &&
        money(agingCard('Awaiting countering') ?? -1, arAll.body.summary?.awaiting),
      `${JSON.stringify(agingRep.body.cards)} vs ${JSON.stringify(arAll.body.summary).slice(0, 160)}`,
    );
    check(
      'it ages as of one day, an Awaiting countering row first',
      agingRep.body.from === agingRep.body.to && agingRep.body.series?.rows?.[0]?.label === 'Awaiting countering',
      JSON.stringify(agingRep.body.series?.rows?.map((r: { label: string }) => r.label)),
    );
    const recBySeller = await fin('GET', `/fin-reports/receivables?from=${sixtyAgo}&salespersonId=${engineer.id}`);
    const sellerRows = (recBySeller.body.tables ?? []).find((t: { title: string }) => t.title === 'By sales personnel')?.rows ?? [];
    check(
      'the receivables report narrows to one salesperson and says so',
      recBySeller.status === 200 && sellerRows.length === 1 && sellerRows[0][0] === engineer.name && String(recBySeller.body.filterLine).includes(engineer.name),
      JSON.stringify(sellerRows) + ' ' + recBySeller.body.filterLine,
    );
    const colRep = await fin('GET', `/fin-reports/collections?salespersonId=${engineer.id}`);
    const colCard = (colRep.body.cards as { label: string; value: number }[] | undefined)?.find((c) => c.label === 'Total collections')?.value ?? 0;
    check(
      'the collections report credits the salesperson of the invoices settled, by team too',
      colRep.status === 200 &&
        colCard >= arLeft - 0.005 &&
        (colRep.body.tables ?? []).find((t: { title: string }) => t.title === 'By team')?.rows?.some((r: unknown[]) => r[0] === team?.code),
      JSON.stringify(colRep.body.cards),
    );
    const weekly = await fin('GET', '/fin-reports/collection-forecast?by=week');
    const badBy = await fin('GET', '/fin-reports/collection-forecast?by=year');
    check(
      'the forecast looks ahead ninety days by default, by week when asked; an unknown "by" is a 400',
      weekly.status === 200 && weekly.body.from === todayIso && weekly.body.series?.head === 'Week' && weekly.body.series.rows.length >= 13 && badBy.status === 400,
      `${weekly.status} ${weekly.body.from} ${weekly.body.series?.head} ${weekly.body.series?.rows?.length} · ${badBy.status}`,
    );
    const repCsv = await fetch(`${BASE}/fin-reports/aging.csv`, { headers: { Authorization: `Bearer ${signToken(finance.id, finance.email)}` } });
    const repPdf = await fin('GET', '/fin-reports/collection-forecast.pdf');
    const repAudit = await prisma.auditLog.count({ where: { entityType: 'finance_report', actorId: finance.id, action: 'EXPORTED' } });
    check(
      'each report has a CSV and a PDF twin, each on the trail',
      repCsv.status === 200 && (repCsv.headers.get('content-type') ?? '').startsWith('text/csv') && repPdf.status === 200 && !!repPdf.bytes && repAudit >= 2,
      `${repCsv.status} ${repPdf.status} ${repAudit}`,
    );
    await throwaway('zzfin_reports', ['gfin.reports.view_all']);
    const reportsOnly = as(await makeUser('ZZ Reports Only', 'reports@verifyf.local', ['zzfin_reports']));
    const [noAr, noRight] = await Promise.all([reportsOnly('GET', '/fin-reports/receivables'), eng('GET', '/fin-reports/payments')]);
    check(
      'the Reports right opens the page, but a receivables report also needs A/R’s; without Reports it is a 403',
      noAr.status === 403 && noRight.status === 403,
      `${noAr.status} ${noRight.status}`,
    );

    // ══ Accounts Payable per the owner's sample (2026-10-15) ═════════════════
    console.log('\nAccounts Payable — delivery, terms, purchaser, the cards and the AP report');
    const apDelivered = ymd(addDays(dayKey(new Date()), -3));
    const apTyped = await fin('POST', '/supplier-bills', {
      supplierId: supplier.id,
      supplierInvoiceNo: `${TAG}-AP-1`,
      deliveryDate: apDelivered,
      termsDays: 30,
      lines: [{ description: 'Service call', quantity: 1, unitPrice: 5_000 }],
    });
    check(
      'a bill runs its terms from the delivery — due = delivery + 30 days, printed "30 Days"',
      apTyped.status === 201 &&
        String(apTyped.body.deliveryDate).slice(0, 10) === apDelivered &&
        String(apTyped.body.dueDate).slice(0, 10) === ymd(addDays(new Date(`${apDelivered}T00:00:00Z`), 30)) &&
        apTyped.body.termsLabel === '30 Days',
      `${apTyped.status} ${apTyped.body.deliveryDate} ${apTyped.body.dueDate} ${apTyped.body.termsLabel}`,
    );
    const apOrder = await fin('POST', '/supplier-bills', {
      supplierId: supplier.id,
      orderId: order.id,
      supplierInvoiceNo: `${TAG}-AP-2`,
      termsDays: 15,
      lines: [{ description: 'Pipe', quantity: 1, unitPrice: 1_000 }],
    });
    const lastReceived = await prisma.receiving.findFirst({ where: { orderId: order.id, status: 'RECEIVED' }, orderBy: { receivedDate: 'desc' }, select: { receivedDate: true } });
    check(
      "a bill against an order takes the receiving's date as its delivery and the order's author as its purchaser",
      apOrder.status === 201 &&
        apOrder.body.purchaser?.id === order.createdById &&
        String(apOrder.body.deliveryDate).slice(0, 10) === ymd(lastReceived!.receivedDate),
      `${apOrder.status} ${JSON.stringify(apOrder.body.purchaser)} ${apOrder.body.deliveryDate}`,
    );
    const apBadBuyer = await fin('POST', '/supplier-bills', {
      supplierId: supplier.id,
      purchaserId: 'no-such-user',
      lines: [{ description: 'x', quantity: 1, unitPrice: 1 }],
    });
    check('a purchaser who is not an active login is refused', apBadBuyer.status === 400, `${apBadBuyer.status} ${apBadBuyer.body.error}`);
    const [apAll, apSoon, apPending, apOwed, apBuyer] = await Promise.all([
      fin('GET', '/supplier-bills?pageSize=1'),
      fin('GET', '/supplier-bills?pageSize=1&dueSoon=true'),
      fin('GET', '/supplier-bills?pageSize=1&pending=true'),
      fin('GET', '/supplier-bills?pageSize=1&outstanding=true'),
      fin('GET', `/supplier-bills?pageSize=50&purchaserId=${order.createdById}`),
    ]);
    const apSum = apAll.body.summary ?? {};
    check(
      'each A/P card equals the list it opens: payables, pending bills, due in 7 days',
      apAll.status === 200 &&
        apSum.payableCount === apOwed.body.total &&
        apSum.pendingCount === apPending.body.total &&
        apSum.dueSoonCount === apSoon.body.total &&
        money(apSum.payable, apOwed.body.summary?.payable),
      `${JSON.stringify(apSum)} vs owed ${apOwed.body.total} pending ${apPending.body.total} soon ${apSoon.body.total}`,
    );
    check(
      'the list narrows to one purchaser',
      apBuyer.status === 200 && (apBuyer.body.rows ?? apBuyer.body.data ?? []).every((r: { purchaser: { id: string } | null }) => r.purchaser?.id === order.createdById),
      `${apBuyer.status} ${apBuyer.body.total}`,
    );
    const apFrom = ymd(addDays(dayKey(new Date()), -60));
    const apTo = ymd(addDays(dayKey(new Date()), 90));
    const apRep = await fin('GET', `/fin-reports/payables?from=${apFrom}&to=${apTo}&supplierId=${supplier.id}`);
    const apDb = await prisma.supplierBill.aggregate({
      where: {
        supplierId: supplier.id,
        status: { in: ['PENDING_APPROVAL', 'APPROVED', 'PARTIALLY_PAID', 'PAID'] },
        dueDate: { gte: new Date(`${apFrom}T00:00:00Z`), lte: new Date(`${apTo}T23:59:59.999Z`) },
      },
      _sum: { netPayable: true },
    });
    const apCard = (apRep.body.cards as { label: string; value: number }[] | undefined)?.find((c) => c.label === 'Falling due')?.value;
    check(
      'the AP report sums the bills falling due in the range for the supplier asked, and names it',
      apRep.status === 200 && money(apCard ?? -1, Number(apDb._sum.netPayable ?? 0)) && String(apRep.body.filterLine).includes(supplier.name),
      `${apCard} vs ${apDb._sum.netPayable} · ${apRep.body.filterLine}`,
    );
    const apNoRight = await as(await makeUser('ZZ AP Reports Only', 'apreports@verifyf.local', ['zzfin_reports']))('GET', '/fin-reports/payables');
    check('the AP report needs A/P’s right beside the Reports right', apNoRight.status === 403, String(apNoRight.status));

    // ══ Budget requests and liquidations per the owner's modules 4 and 5 ════
    console.log('\nBudget requests and liquidations — the team column, the cards, the reports');
    const [brAll, brPending, brApproved, brReleased, brProjects] = await Promise.all([
      fin('GET', '/budget-requests?pageSize=200'),
      fin('GET', '/budget-requests?pageSize=1&pending=true'),
      fin('GET', '/budget-requests?pageSize=1&approved=true'),
      fin('GET', '/budget-requests?pageSize=200&released=true'),
      eng('GET', '/budget-requests/projects'),
    ]);
    const brSum = brAll.body.summary ?? {};
    check(
      'the register’s cards equal the lists they open: pending approval and approved funds',
      brAll.status === 200 && brSum.pendingCount === brPending.body.total && brSum.approvedCount === brApproved.body.total,
      `${JSON.stringify(brSum).slice(0, 200)} vs ${brPending.body.total} ${brApproved.body.total}`,
    );
    const engRow = (brAll.body.rows ?? []).find((r: { requestedBy: { id: string } }) => r.requestedBy.id === engineer.id);
    const engUnit = await prisma.user.findUnique({
      where: { id: engineer.id },
      select: { department: { select: { name: true } }, employee: { select: { industry: { select: { code: true } }, department: { select: { name: true } } } } },
    });
    const expectUnit = engUnit?.employee?.industry?.code ?? engUnit?.employee?.department?.name ?? engUnit?.department?.name ?? null;
    check(
      'each request names its requester’s team, else their department, and never the person’s whole record',
      !!engRow && (engRow.team?.label ?? null) === expectUnit && !('employee' in engRow.requestedBy),
      JSON.stringify(engRow?.team) + ' vs ' + expectUnit,
    );
    check(
      'the liquidation register lists only requests whose cash went out',
      brReleased.status === 200 && (brReleased.body.rows ?? []).every((r: { status: string }) => ['RELEASED', 'REFUND_DUE', 'LIQUIDATED'].includes(r.status)),
      JSON.stringify((brReleased.body.rows ?? []).map((r: { status: string }) => r.status)),
    );
    check(
      'G-FIN’s "+ Add budget request" picks from the running projects, behind the create right',
      brProjects.status === 200 && (brProjects.body as unknown as { id: string }[]).some?.((j) => j.id === job.id),
      `${brProjects.status}`,
    );
    const brFrom = ymd(addDays(dayKey(new Date()), -90));
    const brTo = ymd(addDays(dayKey(new Date()), 90));
    const [brRep, liqRep] = await Promise.all([
      fin('GET', `/fin-reports/budget-requests?from=${brFrom}&to=${brTo}&requestedById=${engineer.id}`),
      fin('GET', `/fin-reports/liquidations?from=${brFrom}&to=${brTo}`),
    ]);
    const brDb = await prisma.budgetRequest.aggregate({
      where: {
        requestedById: engineer.id,
        status: { notIn: ['DRAFT', 'REJECTED', 'CANCELLED'] },
        OR: [
          { neededBy: { gte: new Date(`${brFrom}T00:00:00Z`), lte: new Date(`${brTo}T23:59:59.999Z`) } },
          { neededBy: null, createdAt: { gte: manilaDayStart(brFrom), lte: manilaDayEnd(brTo) } },
        ],
      },
      _sum: { amount: true },
    });
    const brCard = (brRep.body.cards as { label: string; value: number }[] | undefined)?.find((c) => c.label === 'Sum of all budget requests')?.value;
    check(
      'the budget request report sums the requester’s requests needed in the range, and says whose',
      brRep.status === 200 && money(brCard ?? -1, Number(brDb._sum.amount ?? 0)) && String(brRep.body.filterLine).includes(engineer.name),
      `${brCard} vs ${brDb._sum.amount} · ${brRep.body.filterLine}`,
    );
    const liqDb = await prisma.budgetRequest.aggregate({
      where: { status: { in: ['RELEASED', 'REFUND_DUE', 'LIQUIDATED'] }, releasedAt: { gte: new Date(`${brFrom}T00:00:00Z`), lte: new Date(`${brTo}T00:00:00Z`) } },
      _sum: { amountReleased: true, amountRefunded: true },
    });
    const liqCard = (label: string) => (liqRep.body.cards as { label: string; value: number }[] | undefined)?.find((c) => c.label === label)?.value ?? -1;
    check(
      'the liquidation report’s released and returned are the requests released in the range',
      liqRep.status === 200 && money(liqCard('Released'), Number(liqDb._sum.amountReleased ?? 0)) && money(liqCard('Total excess returned'), Number(liqDb._sum.amountRefunded ?? 0)),
      `${liqCard('Released')} / ${liqCard('Total excess returned')} vs ${JSON.stringify(liqDb._sum)}`,
    );

    // ══ Reimbursements per the owner's module 6 ══════════════════════════════
    console.log('\nReimbursements — the five-signature route, the stage words, the cards and the report');
    const rmb = await eng('POST', '/expense-claims', {
      purpose: `${TAG} client dinner`,
      lines: [{ spentOn: todayIso, description: 'Dinner', receiptNo: 'OR-1', amount: 345.5 }],
    });
    const rmbSubmit = await eng('POST', `/expense-claims/${rmb.body.id}/submit`);
    const rmbReq = await prisma.approvalRequest.findFirst({
      where: { documentType: 'expense', documentId: String(rmb.body.id), status: 'PENDING' },
      include: { workflow: { include: { steps: { orderBy: { sequence: 'asc' } } } } },
    });
    check(
      'a reimbursement goes Team Leader › Back Support › Checking (Finance Staff) › Finance Manager › CEO / President',
      rmbSubmit.status === 200 &&
        JSON.stringify(rmbReq?.workflow?.steps.map((st) => st.name)) ===
          JSON.stringify(['Team Leader', 'Back Support', 'Checking (Finance Staff)', 'Finance Manager', 'CEO / President']),
      JSON.stringify(rmbReq?.workflow?.steps.map((st) => st.name)),
    );
    const stageOf = async () =>
      ((await fin('GET', `/expense-claims?pageSize=5&search=${encodeURIComponent(String(rmb.body.number))}`)).body.rows?.[0] as { stage?: string } | undefined)?.stage;
    const stageFirst = await stageOf();
    const ordered: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await prisma.approvalRequest.findUnique({ where: { id: rmbReq!.id }, include: { workflow: { include: { steps: true } } } });
      if (r?.status !== 'PENDING') break;
      const st = r.workflow!.steps.find((x) => x.sequence === r.currentSequence)!;
      // An approver who decides no later step: one who does would co-sign it
      // ("one signature per person") and the walk would skip a stage — which
      // one the database lists first is not this check's business.
      const eligible = (await approversForStep(st, r.requesterId, prisma, {})).filter((id) => id !== r.requesterId);
      const later = new Set<string>();
      for (const ls of r.workflow!.steps.filter((x) => x.sequence > r.currentSequence)) {
        for (const id of await approversForStep(ls, r.requesterId, prisma, {})) later.add(id);
      }
      const who = eligible.find((id) => !later.has(id)) ?? eligible[0];
      await act({ requestId: r.id, userId: who, action: 'APPROVED' });
      ordered.push((await stageOf()) ?? '?');
    }
    check(
      'the register says where it stands in the owner’s words: TL Approval, then Back Support, Checking, FM Approval, CEO Approval',
      stageFirst === 'TL Approval' && JSON.stringify(ordered) === JSON.stringify(['Back Support', 'Checking', 'FM Approval', 'CEO Approval']),
      `${stageFirst} → ${JSON.stringify(ordered)}`,
    );
    await settle(rmbReq!.id);
    const rmbStage = await stageOf();
    const [rmbAll, rmbPending, rmbRelease] = await Promise.all([
      fin('GET', '/expense-claims?pageSize=1'),
      fin('GET', '/expense-claims?pageSize=1&pending=true'),
      fin('GET', '/expense-claims?pageSize=1&forRelease=true'),
    ]);
    check(
      'approved by all five it is For Release, and the cards equal the lists they open',
      rmbStage === 'For Release' &&
        rmbAll.body.summary?.pendingCount === rmbPending.body.total &&
        rmbAll.body.summary?.forReleaseCount === rmbRelease.body.total,
      `${rmbStage} · ${JSON.stringify(rmbAll.body.summary)} vs ${rmbPending.body.total} ${rmbRelease.body.total}`,
    );
    const rmbRep = await fin('GET', `/fin-reports/reimbursements?from=${todayIso}&to=${todayIso}&requestedById=${engineer.id}`);
    const rmbDb = await prisma.expenseClaim.aggregate({
      where: { claimedById: engineer.id, status: { notIn: ['DRAFT', 'REJECTED', 'CANCELLED'] }, claimDate: dayKey(new Date()) },
      _sum: { total: true },
    });
    const rmbCard = (rmbRep.body.cards as { label: string; value: number }[] | undefined)?.find((c) => c.label === 'Sum of all reimbursements')?.value;
    check(
      'the reimbursement report sums the requester’s claims dated in the range',
      rmbRep.status === 200 && money(rmbCard ?? -1, Number(rmbDb._sum.total ?? 0)) && String(rmbRep.body.filterLine).includes(engineer.name),
      `${rmbCard} vs ${rmbDb._sum.total}`,
    );

    // ══ Cash advance as money lent (the owner's module 7) ═══════════════════
    console.log('\nCash advances — money lent, repaid in instalments and by salary deduction');
    await saveFinanceSettings({ blockAdvanceWhileUnliquidated: false });
    const loan = await eng('POST', '/cash-advances', { purpose: `${TAG} roadshow allowance`, amount: 3_500 });
    await eng('POST', `/cash-advances/${loan.body.id}/submit`);
    const loanReq = await prisma.approvalRequest.findFirst({ where: { documentType: 'cash_advance', documentId: String(loan.body.id), status: 'PENDING' } });
    const loanRoute = await stepNames(loanReq?.workflowId ?? null);
    await settle(loanReq!.id);
    const loanRelease = await fin('POST', '/payments', {
      kind: 'DISBURSEMENT',
      method: 'CASH',
      payeeUserId: engineer.id,
      allocations: [{ kind: 'advance', id: loan.body.id, amount: 3_500 }],
    });
    const loanOut = await prisma.cashAdvance.findUnique({ where: { id: String(loan.body.id) } });
    check(
      'a new advance is money lent: five signatures, released, then RELEASED with no liquidation deadline',
      loan.body.repayable === true &&
        JSON.stringify(loanRoute) === JSON.stringify(['TEAM LEADER', 'BACK SUPPORT', 'CHECKING (FINANCE STAFF)', 'FINANCE MANAGER', 'CEO / PRESIDENT']) &&
        loanRelease.status === 201 &&
        loanOut?.status === 'RELEASED' &&
        loanOut.liquidationDueDate === null,
      `${loan.body.repayable} ${JSON.stringify(loanRoute)} ${loanRelease.status} ${loanOut?.status} ${loanOut?.liquidationDueDate}`,
    );
    const loanLiquidate = await eng('POST', '/expense-claims', {
      purpose: `${TAG} wrong door`,
      advanceId: loan.body.id,
      lines: [{ spentOn: todayIso, description: 'x', receiptNo: 'OR', amount: 1 }],
    });
    check('money lent is repaid, never liquidated with receipts', loanLiquidate.status === 400 && /repaid, not liquidated/.test(String(loanLiquidate.body.error)), `${loanLiquidate.status} ${loanLiquidate.body.error}`);
    const deduction = await fin('POST', '/payments', {
      kind: 'RECEIPT',
      method: 'SALARY_DEDUCTION',
      payeeUserId: engineer.id,
      allocations: [{ kind: 'advance_refund', id: loan.body.id, amount: 1_000 }],
    });
    const badDeduction = await fin('POST', '/payments', {
      kind: 'DISBURSEMENT',
      method: 'SALARY_DEDUCTION',
      payeeUserId: engineer.id,
      allocations: [{ kind: 'advance', id: loan.body.id, amount: 1 }],
    });
    const loanList = await fin('GET', `/cash-advances?pageSize=5&search=${encodeURIComponent(String(loan.body.number))}`);
    const loanRow = loanList.body.rows?.[0];
    check(
      'a salary deduction repays part of it: the list says Repaying, 1,000 made, 2,500 left; a deduction settles nothing else',
      deduction.status === 201 &&
        !!deduction.body.clearedAt &&
        loanRow?.stage === 'Repaying' &&
        money(loanRow?.paymentsMade, 1_000) &&
        money(loanRow?.balance, 2_500) &&
        badDeduction.status === 400,
      `${deduction.status} ${deduction.body.clearedAt} ${loanRow?.stage} ${loanRow?.paymentsMade} ${loanRow?.balance} · ${badDeduction.status}`,
    );
    const [caAll, caOwing] = await Promise.all([fin('GET', '/cash-advances?pageSize=1'), fin('GET', '/cash-advances?pageSize=200&owing=true')]);
    const owingSum = (caOwing.body.rows ?? []).reduce((s: number, r: { balance: number }) => s + r.balance, 0);
    check(
      'the Net outstanding balance card is the balances of the loans still being repaid',
      money(caAll.body.summary?.outstanding, owingSum) && caAll.body.summary?.owingCount === caOwing.body.total,
      `${JSON.stringify(caAll.body.summary)} vs ${owingSum}`,
    );
    const tooMuch = await fin('POST', '/payments', {
      kind: 'RECEIPT',
      method: 'CASH',
      payeeUserId: engineer.id,
      allocations: [{ kind: 'advance_refund', id: loan.body.id, amount: 2_600 }],
    });
    const rest = await fin('POST', '/payments', {
      kind: 'RECEIPT',
      method: 'CASH',
      payeeUserId: engineer.id,
      allocations: [{ kind: 'advance_refund', id: loan.body.id, amount: 2_500 }],
    });
    const loanPaid = await prisma.cashAdvance.findUnique({ where: { id: String(loan.body.id) } });
    check(
      'more than the balance is refused; the last 2,500 makes it PAID, dated',
      tooMuch.status === 400 && rest.status === 201 && loanPaid?.status === 'PAID' && !!loanPaid.repaidAt,
      `${tooMuch.status} ${rest.status} ${loanPaid?.status} ${loanPaid?.repaidAt}`,
    );
    const undo = await fin('DELETE', `/payments/${rest.body.id}`);
    const loanBack = await prisma.cashAdvance.findUnique({ where: { id: String(loan.body.id) } });
    check(
      'deleting a repayment puts the balance back — re-derived, never incremented',
      undo.status === 200 && loanBack?.status === 'RELEASED' && money(Number(loanBack.amountRefunded), 1_000) && loanBack.repaidAt === null,
      `${undo.status} ${loanBack?.status} ${loanBack?.amountRefunded} ${loanBack?.repaidAt}`,
    );
    const caRep = await fin('GET', `/fin-reports/cash-advances?from=${todayIso}&to=${todayIso}&requestedById=${engineer.id}`);
    const caCard = (label: string) => (caRep.body.cards as { label: string; value: number }[] | undefined)?.find((c) => c.label === label)?.value ?? -1;
    check(
      'the CA report counts the payments made and the balance still owed',
      caRep.status === 200 && caCard('Payments made') >= 1_000 - 0.005 && caCard('Net outstanding balance') >= 2_500 - 0.005,
      JSON.stringify(caRep.body.cards),
    );

    // ══ Invoice requests (2026-10-15) ═══════════════════════════════════════
    console.log('\nInvoice requests — the salesperson asks, Back Support approves, A/R gets the draft invoice');
    const irSeller = await makeUser('ZZ IR Seller', 'irseller@verifyf.local', ['sales']);
    const irStranger = await makeUser('ZZ IR Other Seller', 'irother@verifyf.local', ['sales']);
    const irSupport = await makeUser('ZZ IR Back Support', 'irsupport@verifyf.local', ['back_support']);
    const irQuote = await prisma.quotation.create({
      data: { number: `${TAG}-Q-IR1`, customerId: customer.id, ownerId: irSeller.id, subject: `${TAG} IR PROJECT` },
    });
    const irRev = await prisma.quotationRevision.create({ data: { quotationId: irQuote.id, revision: 0, status: 'APPROVED' } });
    const irOrder = await prisma.salesOrder.create({
      data: {
        number: `${TAG}-SO-IR1`,
        status: 'ISSUED',
        quotationId: irQuote.id,
        customerId: customer.id,
        ownerId: irSeller.id,
        orderDate: dayKey(new Date()),
        termsDays: 60,
        poNumber: `${TAG}-PO-IR`,
        vatRate: D(0.12),
        subtotal: D(150_000),
        vatAmount: D(18_000),
        total: D(168_000),
      },
    });
    const irJob = await prisma.job.create({
      data: {
        number: `${TAG}-PRJ-IR`,
        name: `${TAG} Invoice request project`,
        customerId: customer.id,
        costingId: costing.id,
        quotationRevisionId: irRev.id,
        contractValue: D(150_000),
        createdById: finance.id,
      },
    });
    const irBilling = async (n: number, gross: number, status: 'APPROVED' | 'DRAFT' = 'APPROVED') => {
      const report = await prisma.progressReport.create({
        data: {
          number: `${TAG}-IR-PR-${n}`,
          reportNo: n,
          jobId: irJob.id,
          status: 'APPROVED',
          periodFrom: dayKey(new Date()),
          periodTo: dayKey(new Date()),
          preparedById: irSeller.id,
          accomplishment: `${TAG} report ${n}`,
        },
      });
      const tax = taxBreakdown(gross, 0.12, 0.02);
      return prisma.progressBilling.create({
        data: {
          number: `${TAG}-IR-PB-${n}`,
          jobId: irJob.id,
          billingNo: n,
          status,
          progressReportId: report.id,
          billingDate: dayKey(new Date()),
          grossAmount: D(tax.grossAmount),
          vatRate: D(0.12),
          vatAmount: D(tax.vatAmount),
          ewtRate: D(0.02),
          ewtAmount: D(tax.ewtAmount),
          invoiceTotal: D(tax.invoiceTotal),
          netCollectible: D(tax.netCollectible),
          approvedAt: status === 'APPROVED' ? new Date() : null,
        },
      });
    };
    const irB1 = await irBilling(1, 100_000);
    const irDraftBilling = await irBilling(2, 10_000, 'DRAFT');
    const seller = as(irSeller);
    const source = await seller('GET', `/invoice-requests/source?billingId=${irB1.id}`);
    check(
      'the request form offers the project’s issued sales order with what is left of its net, and says the seller may ask',
      source.status === 200 &&
        source.body.mayRequest === true &&
        source.body.problem === null &&
        (source.body.salesOrders as { id: string; left: number }[]).some((o) => o.id === irOrder.id && money(o.left, 150_000)),
      JSON.stringify(source.body).slice(0, 240),
    );
    const notMine = await as(irStranger)('POST', '/invoice-requests', { progressBillingId: irB1.id, salesOrderId: irOrder.id });
    const notApproved = await seller('POST', '/invoice-requests', { progressBillingId: irDraftBilling.id, salesOrderId: irOrder.id });
    check(
      'another salesperson may not ask for this project’s invoice, and a billing not yet approved cannot be asked',
      notMine.status === 403 && notApproved.status === 400,
      `${notMine.status} / ${notApproved.status} ${JSON.stringify(notApproved.body).slice(0, 120)}`,
    );
    const ir = await seller('POST', '/invoice-requests', { progressBillingId: irB1.id, salesOrderId: irOrder.id });
    const irSecond = await seller('POST', '/invoice-requests', { progressBillingId: irB1.id, salesOrderId: irOrder.id });
    check(
      'the seller raises one, numbered GT-IR, taking the order’s PO and terms — and a second while it is live is refused',
      ir.status === 201 &&
        /-IR-\d{4}-\d{4}$/.test(String(ir.body.number)) &&
        ir.body.poReference === `${TAG}-PO-IR` &&
        ir.body.termsDays === 60 &&
        ir.body.salesperson?.id === irSeller.id &&
        irSecond.status === 400,
      `${ir.status} ${ir.body.number} ${ir.body.poReference} ${ir.body.termsDays} · ${irSecond.status}`,
    );
    const irId = String(ir.body.id);
    const directWhileLive = await fin('POST', `/invoices/from-billing/${irB1.id}`, {});
    check('finance’s direct door waits while the request is open', directWhileLive.status === 400 && String(directWhileLive.body.error).includes(String(ir.body.number)), JSON.stringify(directWhileLive.body));
    const irDraftPdf = await seller('GET', `/invoice-requests/${irId}/pdf`);
    const irDraftText = (irDraftPdf.bytes ? pdfText(irDraftPdf.bytes) : '').replace(/\s+/g, ' ');
    check(
      'its paper, in the standard dress: the order, the PO, the particulars, the totals, and Back Support Pending',
      irDraftPdf.status === 200 &&
        irDraftText.includes('INVOICE REQUEST') &&
        irDraftText.includes(`${TAG}-SO-IR1`) &&
        irDraftText.includes(`${TAG}-PO-IR`) &&
        irDraftText.includes('Net collectible') &&
        irDraftText.includes('BACK SUPPORT') &&
        irDraftText.includes('Pending'),
      irDraftText.slice(0, 600),
    );
    const irSubmit = await seller('POST', `/invoice-requests/${irId}/submit`);
    const irReq = await prisma.approvalRequest.findFirst({
      where: { documentType: 'invoice_request', documentId: irId, status: 'PENDING' },
      include: { workflow: { include: { steps: true } } },
    });
    const supportApprovers = irReq ? await approversForStep(irReq.workflow!.steps[0], irSeller.id, prisma, {}) : [];
    check(
      'submitted, it goes to Back Support',
      irSubmit.status === 200 && irSubmit.body.status === 'PENDING_APPROVAL' && irReq?.workflow?.steps.map((st) => st.name).join(',') === 'Back Support' && supportApprovers.includes(irSupport.id),
      `${irSubmit.status} ${irSubmit.body.status} ${irReq?.workflow?.steps.map((st) => st.name)}`,
    );
    const irWithdraw = await seller('POST', `/invoice-requests/${irId}/withdraw`);
    const irResubmit = await seller('POST', `/invoice-requests/${irId}/submit`);
    check('pulled back it is a draft, and it is sent again', irWithdraw.body.status === 'DRAFT' && irResubmit.body.status === 'PENDING_APPROVAL', `${irWithdraw.status} ${irResubmit.status}`);
    const irOpen = await prisma.approvalRequest.findFirstOrThrow({ where: { documentType: 'invoice_request', documentId: irId, status: 'PENDING' } });
    await act({ requestId: irOpen.id, userId: irSupport.id, action: 'APPROVED' });
    const irDone = await prisma.invoiceRequest.findUniqueOrThrow({ where: { id: irId }, include: { invoice: true } });
    const irB1After = await prisma.progressBilling.findUniqueOrThrow({ where: { id: irB1.id } });
    check(
      'Back Support’s approval raises ONE draft invoice on the order, with its PO, terms and the billing’s money, and the billing is invoiced',
      irDone.status === 'APPROVED' &&
        irDone.invoice?.status === 'DRAFT' &&
        irDone.invoice.salesOrderId === irOrder.id &&
        irDone.invoice.poReference === `${TAG}-PO-IR` &&
        irDone.invoice.termsDays === 60 &&
        irDone.invoice.salespersonId === irSeller.id &&
        money(Number(irDone.invoice.netCollectible), Number(irB1.netCollectible)) &&
        irB1After.status === 'INVOICED' &&
        (await prisma.invoice.count({ where: { progressBillingId: irB1.id } })) === 1,
      `${irDone.status} ${irDone.invoice?.status} ${irDone.invoice?.poReference} ${irB1After.status}`,
    );
    await settleInvoiceRequest(irOpen, 'APPROVED');
    check('a settlement that arrives twice raises nothing more', (await prisma.invoice.count({ where: { progressBillingId: irB1.id } })) === 1);
    const financeTold = await prisma.notification.findFirst({ where: { userId: finance.id, type: 'invoice_request.invoiced', link: `/g-fin/ar/${irDone.invoiceId}` } });
    check('finance is told the draft invoice is ready to issue', !!financeTold);
    // What is left of the order now refuses a billing bigger than it.
    const irB3 = await irBilling(3, 60_000);
    const over = await seller('POST', '/invoice-requests', { progressBillingId: irB3.id, salesOrderId: irOrder.id });
    check(
      'a billing past what is left of the order’s net is refused, naming what is left',
      over.status === 400 && String(over.body.error).includes('left to invoice'),
      `${over.status} ${JSON.stringify(over.body).slice(0, 160)}`,
    );
    // Cancel and delete: a draft request is cancelled with a reason, then deleted.
    const irB4 = await irBilling(4, 20_000);
    const ir4 = await seller('POST', '/invoice-requests', { progressBillingId: irB4.id, salesOrderId: irOrder.id });
    const ir4Cancel = await seller('POST', `/invoice-requests/${ir4.body.id}/cancel`, { reason: 'raised on the wrong order' });
    const ir4Again = await seller('POST', '/invoice-requests', { progressBillingId: irB4.id, salesOrderId: irOrder.id });
    const ir4Delete = await seller('DELETE', `/invoice-requests/${ir4.body.id}`);
    check(
      'a cancelled request frees its billing for a new one, and is deleted',
      ir4Cancel.body.status === 'CANCELLED' && ir4Again.status === 201 && ir4Delete.status === 200,
      `${ir4Cancel.status} ${ir4Again.status} ${ir4Delete.status}`,
    );
    const irList = await fin('GET', `/invoice-requests?pageSize=50&jobId=${irJob.id}`);
    const irListPdf = await fin('GET', `/invoice-requests/pdf?jobId=${irJob.id}`);
    check(
      'the register lists the project’s requests with their cards, and prints',
      irList.status === 200 &&
        irList.body.total === 2 &&
        typeof irList.body.summary?.drafts === 'number' &&
        irListPdf.status === 200 &&
        (irListPdf.bytes ? pdfText(irListPdf.bytes) : '').replace(/\s+/g, ' ').includes('INVOICE REQUESTS'),
      `${irList.status} ${irList.body.total} ${JSON.stringify(irList.body.summary)} · ${irListPdf.status}`,
    );
    const irStrangerRead = await as(irStranger)('GET', `/invoice-requests/${irId}`);
    check('someone else’s request is not theirs to read', irStrangerRead.status === 404, String(irStrangerRead.status));

    // ── From the sales order (2026-10-16) ──
    console.log('\nInvoice requests from a sales order — the invoice number, the countered date, the raiser credited');
    const soSource = await seller('GET', `/invoice-requests/source?salesOrderId=${irOrder.id}`);
    check(
      'a sales order’s request form says what is left — after its invoices AND the open requests on it',
      soSource.status === 200 &&
        soSource.body.kind === 'order' &&
        soSource.body.mayRequest === true &&
        money(soSource.body.salesOrder?.requested, 20_000) &&
        money(soSource.body.salesOrder?.left, 30_000),
      JSON.stringify(soSource.body).slice(0, 300),
    );
    const soStranger = await as(irStranger)('POST', '/invoice-requests', { salesOrderId: irOrder.id, grossAmount: 1_000 });
    const soAskTooMuch = await seller('POST', '/invoice-requests', { salesOrderId: irOrder.id, grossAmount: 30_000.01 });
    const soNoAmount = await seller('POST', '/invoice-requests', { salesOrderId: irOrder.id });
    check(
      'another salesperson may not ask; more than is left, or no amount, is refused',
      soStranger.status === 403 && soAskTooMuch.status === 400 && String(soAskTooMuch.body.error).includes('left to invoice') && soNoAmount.status === 400,
      `${soStranger.status} ${soAskTooMuch.status} ${soNoAmount.status}`,
    );
    const soIr = await seller('POST', '/invoice-requests', { salesOrderId: irOrder.id, grossAmount: 25_000, description: `${TAG} first delivery` });
    check(
      'the seller asks for 25,000 of the order: no billing, the order’s PO and terms, credited to the one asking',
      soIr.status === 201 &&
        soIr.body.kind === 'order' &&
        soIr.body.progressBilling === null &&
        money(soIr.body.grossAmount, 25_000) &&
        money(soIr.body.vatAmount, 3_000) &&
        money(soIr.body.netCollectible, 27_500) &&
        soIr.body.poReference === `${TAG}-PO-IR` &&
        soIr.body.termsDays === 60 &&
        soIr.body.salesperson?.id === irSeller.id,
      `${soIr.status} ${JSON.stringify(soIr.body).slice(0, 300)}`,
    );
    const soPdf = await seller('GET', `/invoice-requests/${soIr.body.id}/pdf`);
    const soPdfText = (soPdf.bytes ? pdfText(soPdf.bytes) : '').replace(/\s+/g, ' ');
    check('its paper names the order and the line asked for', soPdf.status === 200 && soPdfText.includes(`${TAG}-SO-IR1`) && soPdfText.includes(`${TAG} first delivery`), soPdfText.slice(0, 300));
    const soSubmit = await seller('POST', `/invoice-requests/${soIr.body.id}/submit`);
    const soOpen = await prisma.approvalRequest.findFirst({ where: { documentType: 'invoice_request', documentId: String(soIr.body.id), status: 'PENDING' } });
    if (soOpen) await act({ requestId: soOpen.id, userId: irSupport.id, action: 'APPROVED' });
    const soDone = await prisma.invoiceRequest.findUniqueOrThrow({ where: { id: String(soIr.body.id) }, include: { invoice: { include: { lines: true } } } });
    check(
      'Back Support approves it and the draft invoice bills the order: 25,000 at the order’s VAT, one line, the seller credited',
      soSubmit.status === 200 &&
        soDone.status === 'APPROVED' &&
        soDone.invoice?.status === 'DRAFT' &&
        soDone.invoice.salesOrderId === irOrder.id &&
        soDone.invoice.progressBillingId === null &&
        money(Number(soDone.invoice.grossAmount), 25_000) &&
        money(Number(soDone.invoice.vatAmount), 3_000) &&
        soDone.invoice.lines.length === 1 &&
        soDone.invoice.lines[0].description === `${TAG} first delivery` &&
        soDone.invoice.salespersonId === irSeller.id,
      `${soSubmit.status} ${soDone.status} ${soDone.invoice?.grossAmount} ${soDone.invoice?.lines.length}`,
    );
    if (soOpen) await settleInvoiceRequest(soOpen, 'APPROVED');
    check('a second settlement raises no second invoice', (await prisma.invoice.count({ where: { salesOrderId: irOrder.id, progressBillingId: null } })) === 1);
    const soPage = await seller('GET', `/sales-orders/${irOrder.id}`);
    check(
      'the sales order page lists its invoice requests, and says what is left to invoice',
      soPage.status === 200 &&
        (soPage.body.invoicing?.requests as { id: string }[] | undefined)?.some((r) => r.id === soIr.body.id) === true &&
        money(soPage.body.invoicing?.left, 25_000) &&
        soPage.body.invoicing?.canRequest === true,
      JSON.stringify(soPage.body.invoicing).slice(0, 300),
    );
    const credit = await fin('GET', `/invoices/credit?salesOrderId=${irOrder.id}`);
    check('a new invoice on the order is credited to whoever raised its invoice request', credit.status === 200 && credit.body.salesperson?.id === irSeller.id, JSON.stringify(credit.body));
    const siSet = await fin('PUT', `/invoices/${soDone.invoiceId}`, { siNumber: `${TAG}SI-1` });
    const siTwice = await fin('POST', '/invoices', {
      customerId: customer.id,
      siNumber: `${TAG.toLowerCase()}si-1`,
      lines: [{ description: `${TAG} other`, amount: 100 }],
    });
    check(
      'the printed invoice number is kept on the draft — and the same number on another invoice is refused, case-blind',
      siSet.status === 200 && siSet.body.siNumber === `${TAG}SI-1` && siTwice.status === 409,
      `${siSet.status} ${siSet.body.siNumber} · ${siTwice.status}`,
    );
    const counteredDay = new Date(dayKey(new Date()).getTime() - 2 * 86_400_000).toISOString().slice(0, 10);
    const withCounter = await fin('POST', '/invoices', {
      customerId: customer.id,
      counteredDate: counteredDay,
      termsDays: 30,
      siNumber: `${TAG}SI-2`,
      lines: [{ description: `${TAG} countered`, amount: 1_000 }],
    });
    const due = new Date(new Date(`${counteredDay}T00:00:00Z`).getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
    check(
      'an invoice given only its countered date is dated and countered that day, due 30 days after',
      withCounter.status === 201 &&
        String(withCounter.body.counteredDate).slice(0, 10) === counteredDay &&
        String(withCounter.body.invoiceDate).slice(0, 10) === counteredDay &&
        String(withCounter.body.dueDate).slice(0, 10) === due,
      `${withCounter.status} ${withCounter.body.counteredDate} ${withCounter.body.invoiceDate} ${withCounter.body.dueDate}`,
    );
    const future = await fin('POST', '/invoices', { customerId: customer.id, counteredDate: '2099-01-01', lines: [{ description: `${TAG} x`, amount: 1 }] });
    check('a countered date still to come is refused', future.status === 400, String(future.status));
    const siSearch = await fin('GET', `/invoices?search=${encodeURIComponent(`${TAG}SI-2`)}`);
    check('the A/R list finds an invoice by its printed number', siSearch.status === 200 && siSearch.body.total === 1, String(siSearch.body.total));

    // ── A purchaser by name, and money on account (2026-10-16) ──
    console.log('\nA purchaser typed by name; a collection line added by hand, applied later');
    const namedBill = await fin('POST', '/supplier-bills', {
      supplierId: supplier.id,
      purchaserName: `${TAG} Walk-in Buyer`,
      lines: [{ description: `${TAG} named buyer`, quantity: 1, unitPrice: 500 }],
    });
    const namedSearch = await fin('GET', `/supplier-bills?search=${encodeURIComponent(`${TAG} Walk-in`)}`);
    const switched = await fin('PUT', `/supplier-bills/${namedBill.body.id}`, { purchaserId: finance.id, lines: [{ description: `${TAG} named buyer`, quantity: 1, unitPrice: 500 }] });
    check(
      'a bill keeps a purchaser with no login by name, is found by it, and picking a login clears the name',
      namedBill.status === 201 &&
        namedBill.body.purchaserName === `${TAG} Walk-in Buyer` &&
        namedBill.body.purchaserId === null &&
        namedSearch.body.total === 1 &&
        switched.status === 200 &&
        switched.body.purchaserId === finance.id &&
        switched.body.purchaserName === null,
      `${namedBill.status} ${namedBill.body.purchaserName} · ${namedSearch.body.total} · ${switched.status} ${switched.body.purchaserName}`,
    );
    const onAccount = await fin('POST', '/payments', {
      kind: 'RECEIPT',
      method: 'CHECK',
      customerId: customer.id,
      reference: `${TAG}-CHQ-OA`,
      lines: [{ reference: `${TAG} SI 7781 not yet on file`, amount: 1_500 }],
    });
    check(
      'a collection with only a line typed by hand is money on account: it gets an OR, the amount, and settles nothing',
      onAccount.status === 201 &&
        !!onAccount.body.orNumber &&
        money(onAccount.body.amount, 1_500) &&
        money(onAccount.body.onAccount, 1_500) &&
        (onAccount.body.allocations as unknown[]).length === 0 &&
        (onAccount.body.lines as unknown[]).length === 1,
      `${onAccount.status} ${JSON.stringify(onAccount.body).slice(0, 240)}`,
    );
    const outLines = await fin('POST', '/payments', { kind: 'DISBURSEMENT', supplierId: supplier.id, lines: [{ reference: 'x', amount: 1 }] });
    const noParty = await fin('POST', '/payments', { kind: 'RECEIPT', lines: [{ reference: 'x', amount: 1 }] });
    const nothing = await fin('POST', '/payments', { kind: 'RECEIPT', customerId: customer.id });
    check('lines by hand are money in from a named customer only, and a payment with nothing is refused', outLines.status === 400 && noParty.status === 400 && nothing.status === 400, `${outLines.status} ${noParty.status} ${nothing.status}`);
    const oaPaper = await fin('GET', `/payments/${onAccount.body.id}/pdf`);
    const oaText = (oaPaper.bytes ? pdfText(oaPaper.bytes) : '').replace(/\s+/g, ' ');
    check('the collection receipt lists the line as on account', oaPaper.status === 200 && oaText.includes('SI 7781') && oaText.includes('On account'), oaText.slice(0, 300));
    // The invoice it was for, now on file and issued.
    const later = await fin('POST', '/invoices', { customerId: customer.id, lines: [{ description: `${TAG} SI 7781`, amount: 1_000 }] });
    await fin('POST', `/invoices/${later.body.id}/issue`);
    const laterOwed = Number((await fin('GET', `/invoices/${later.body.id}`)).body.outstanding);
    const lineId = (onAccount.body.lines as { id: string }[])[0].id;
    const applied = await fin('POST', `/payments/${onAccount.body.id}/lines/${lineId}/apply`, { invoiceId: later.body.id });
    const laterAfter = await fin('GET', `/invoices/${later.body.id}`);
    check(
      'applied to the invoice once it is on file: the invoice is paid, the line keeps only what was over',
      applied.status === 200 &&
        laterAfter.body.status === 'PAID' &&
        money(applied.body.onAccount, Math.round((1_500 - laterOwed) * 100) / 100) &&
        (applied.body.allocations as { invoiceId: string }[]).some((a) => a.invoiceId === later.body.id),
      `${applied.status} ${laterAfter.body.status} ${applied.body.onAccount} owed ${laterOwed}`,
    );

    // ── Pulled back after approval (2026-10-16) ──
    console.log('\nAn invoice request pulled back after approval');
    const sellerUser = (await resolveUser(irSeller.id))!;
    // The order's request: its draft invoice is deleted and it is a draft again.
    const soInvoiceId = soDone.invoiceId!;
    const pulled = await as(irSeller)('POST', `/approvals/reopen/invoice_request/${soIr.body.id}`, { reason: `${TAG} wrong amount` });
    const soBack = await prisma.invoiceRequest.findUniqueOrThrow({ where: { id: String(soIr.body.id) } });
    check(
      'the seller pulls the approved request back: a draft, its draft invoice deleted',
      pulled.status === 200 && soBack.status === 'DRAFT' && soBack.invoiceId === null && !(await prisma.invoice.findUnique({ where: { id: soInvoiceId } })),
      `${pulled.status} ${JSON.stringify(pulled.body).slice(0, 160)} ${soBack.status}`,
    );
    // The billing's request: its invoice issued, the pull-back is refused naming it.
    await fin('POST', `/invoices/${irDone.invoiceId}/issue`);
    let issuedRefusal = '';
    try {
      await reopenApproved('invoice_request', irId, sellerUser, `${TAG} try`);
    } catch (err) {
      issuedRefusal = (err as Error).message;
    }
    check(
      'once its invoice is issued the request is refused, naming the invoice',
      issuedRefusal.includes(String(irDone.invoice?.number)) && (await prisma.invoiceRequest.findUniqueOrThrow({ where: { id: irId } })).status === 'APPROVED',
      issuedRefusal,
    );
    // Cancel it, and the billing comes back to be requested again.
    await fin('POST', `/invoices/${irDone.invoiceId}/cancel`, { reason: `${TAG} reissue` });
    const cancelledInv = await prisma.invoice.findUniqueOrThrow({ where: { id: irDone.invoiceId! } });
    if (cancelledInv.status === 'CANCELLED') {
      await reopenApproved('invoice_request', irId, sellerUser, `${TAG} reissue`);
      const irBack = await prisma.invoiceRequest.findUniqueOrThrow({ where: { id: irId } });
      const b1Back = await prisma.progressBilling.findUniqueOrThrow({ where: { id: irB1.id } });
      check('with its invoice cancelled, the request is a draft again and the billing approved to be asked afresh', irBack.status === 'DRAFT' && b1Back.status === 'APPROVED', `${irBack.status} ${b1Back.status}`);
    } else {
      check('the issued invoice could be cancelled for the next case', false, cancelledInv.status);
    }
    // ══ Commissions (2026-10-16) ══════════════════════════════════════════
    console.log('\nCommissions — fully collected first, Finance Manager then CEO, paid with the CA deduction repaid');
    const cmSeller = await makeUser('ZZ CM Seller', 'cmseller@verifyf.local', ['sales']);
    const cmQuote = await prisma.quotation.create({ data: { number: `${TAG}-Q-CM1`, customerId: customer.id, ownerId: cmSeller.id, subject: `${TAG} CM DEAL` } });
    const cmOrder = await prisma.salesOrder.create({
      data: {
        number: `${TAG}-SO-CM1`,
        status: 'ISSUED',
        quotationId: cmQuote.id,
        customerId: customer.id,
        ownerId: cmSeller.id,
        orderDate: dayKey(new Date()),
        vatRate: D(0.12),
        subtotal: D(1_000_000),
        vatAmount: D(120_000),
        total: D(1_120_000),
        lines: { create: [{ title: 'COMPRESSOR PACKAGE', quantity: D(1), unitPrice: D(1_000_000), amount: D(1_000_000), unitCost: D(650_000), costAmount: D(650_000) }] },
      },
    });
    const cmInvoice = await prisma.invoice.create({
      data: {
        number: await nextNumber('invoice'),
        customerId: customer.id,
        salesOrderId: cmOrder.id,
        invoiceDate: dayKey(new Date()),
        counteredDate: dayKey(new Date()),
        dueDate: addDays(dayKey(new Date()), 30),
        grossAmount: D(1_000_000),
        vatRate: D(0.12),
        vatAmount: D(120_000),
        ewtRate: D(0),
        ewtAmount: D(0),
        invoiceTotal: D(1_120_000),
        netCollectible: D(1_120_000),
        status: 'ISSUED',
        issuedAt: new Date(),
        createdById: finance.id,
      },
    });
    const cmAs = as(cmSeller);
    const cmBody = (caDeduction: number) => ({
      salesOrderId: cmOrder.id,
      commissionType: 'GROUP',
      ratePct: 0.1,
      shares: [
        { userId: cmSeller.id, sharePct: 0.6, taxPct: 0.1, caDeduction: 0 },
        { userId: engineer.id, sharePct: 0.4, taxPct: 0.1, caDeduction },
      ],
    });
    const cmEarly = await cmAs('POST', '/commissions', cmBody(0));
    const earlySrc = await cmAs('GET', `/commissions/source?salesOrderId=${cmOrder.id}`);
    check(
      'a commission is refused while the order is not fully collected, and the source says why',
      cmEarly.status === 400 && /not fully collected/.test(String(cmEarly.body.error)) && earlySrc.body.fullyCollected === false,
      `${cmEarly.status} ${cmEarly.body.error}`,
    );
    const collect = await fin('POST', '/payments', { kind: 'RECEIPT', method: 'CHECK', reference: `${TAG}-CHK`, allocations: [{ kind: 'invoice', id: cmInvoice.id, amount: 1_120_000 }] });
    const src = await cmAs('GET', `/commissions/source?salesOrderId=${cmOrder.id}`);
    check(
      'collected in full: the source reads margin 350,000, the OR number, and offers the order’s author',
      collect.status === 201 && src.body.fullyCollected === true && money(src.body.margin, 350_000) &&
        (src.body.orNumbers as string[]).includes(String(collect.body.orNumber)) &&
        (src.body.people as { id: string; roles: string[] }[]).some((p) => p.id === cmSeller.id && p.roles.includes('Sales order')),
      `${collect.status} ${src.body.fullyCollected} ${src.body.margin} ${JSON.stringify(src.body.orNumbers)}`,
    );
    const engLoan = await prisma.cashAdvance.findFirst({ where: { requestedById: engineer.id, repayable: true, status: 'RELEASED' } });
    const engOwed = engLoan ? cents(num(engLoan.amountReleased) - num(engLoan.amountRefunded)) : 0;
    const tooBig = await cmAs('POST', '/commissions', cmBody(cents(engOwed + 100)));
    check('a CA deduction past the person’s open advance balance is refused', !!engLoan && tooBig.status === 400 && /left to repay/.test(String(tooBig.body.error)), `${engOwed} ${tooBig.status} ${tooBig.body.error}`);
    const caTake = Math.min(2_000, engOwed);
    const rfc = await cmAs('POST', '/commissions', cmBody(caTake));
    const twice = await cmAs('POST', '/commissions', cmBody(0));
    check(
      'raised: 35,000 gross; 21,000 − 2,100 and 14,000 − 1,400 − the CA; one standing request per order',
      rfc.status === 201 && /RFC/.test(String(rfc.body.number)) && money(rfc.body.grossCommission, 35_000) &&
        money(rfc.body.shares?.[0]?.net, 18_900) && money(rfc.body.shares?.[1]?.net, cents(12_600 - caTake)) && twice.status === 400,
      `${rfc.status} ${rfc.body.error ?? ''} ${rfc.body.number} ${rfc.body.grossCommission} · ${twice.status}`,
    );
    await cmAs('POST', `/commissions/${rfc.body.id}/submit`);
    const cmReq = await prisma.approvalRequest.findFirst({ where: { documentType: 'commission', documentId: String(rfc.body.id), status: 'PENDING' } });
    const cmRoute = await stepNames(cmReq?.workflowId ?? null);
    check('the route is the Finance Manager, then the CEO / President', JSON.stringify(cmRoute) === JSON.stringify(['FINANCE MANAGER', 'CEO / PRESIDENT']), JSON.stringify(cmRoute));
    const earlyPay = await fin('POST', `/commissions/${rfc.body.id}/pay`, {});
    await settle(cmReq!.id);
    const approvedCm = await prisma.commissionRequest.findUniqueOrThrow({ where: { id: String(rfc.body.id) } });
    check('a pending commission is not paid; both signatures make it APPROVED', earlyPay.status === 400 && approvedCm.status === 'APPROVED', `${earlyPay.status} ${approvedCm.status}`);
    const paid = await fin('POST', `/commissions/${rfc.body.id}/pay`, { method: 'BANK_TRANSFER' });
    const vouchers = await prisma.paymentAllocation.findMany({ where: { commissionShare: { requestId: String(rfc.body.id) } }, include: { payment: true } });
    const loanAfter = await prisma.cashAdvance.findUniqueOrThrow({ where: { id: engLoan!.id } });
    const deductionPay = await prisma.payment.findFirst({ where: { method: 'COMMISSION_DEDUCTION', allocations: { some: { advanceId: engLoan!.id } } }, orderBy: { createdAt: 'desc' } });
    check(
      'paid: a voucher per person for their net, the CA deduction recorded as a repayment of the advance',
      paid.status === 200 && paid.body.status === 'PAID' && vouchers.length === 2 &&
        vouchers.every((v) => v.payment.kind === 'DISBURSEMENT') &&
        money(vouchers.reduce((t, v) => t + num(v.amount), 0), cents(28_500 + 3_000 - caTake)) &&
        !!deductionPay && money(num(deductionPay.amount), caTake) &&
        money(cents(num(loanAfter.amountRefunded) - num(engLoan!.amountRefunded)), caTake),
      `${paid.status} ${paid.body.error ?? paid.body.status} ${vouchers.length} ${loanAfter.amountRefunded}`,
    );
    const undoDeduction = deductionPay ? await fin('DELETE', `/payments/${deductionPay.id}`) : { status: 0, body: {} };
    const paidTwice = await fin('POST', `/commissions/${rfc.body.id}/pay`, {});
    check('a commission is paid once, and its deduction is not reversed on its own', paidTwice.status === 400 && undoDeduction.status === 400, `${paidTwice.status} ${undoDeduction.status}`);
    const cmList = await fin('GET', '/commissions?pageSize=200');
    const cmPaper = await fin('GET', `/commissions/${rfc.body.id}/pdf`);
    const cmRep = await fin('GET', `/fin-reports/commissions?from=${todayIso}&to=${todayIso}`);
    check(
      'the register lists it with its cards; it prints; the report counts it',
      cmList.status === 200 && (cmList.body.rows as { id: string }[]).some((r) => r.id === rfc.body.id) && cmList.body.summary?.paid >= 35_000 - 0.005 &&
        cmPaper.status === 200 && !!cmPaper.bytes && cmRep.status === 200,
      `${cmList.status} ${JSON.stringify(cmList.body.summary)} ${cmPaper.status} ${cmRep.status}`,
    );

    await saveFinanceSettings({ blockAdvanceWhileUnliquidated: true });
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
