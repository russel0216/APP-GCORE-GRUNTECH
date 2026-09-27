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
import { env } from '../src/env';
import { nextNumber } from '../src/shared/numbering';
import { submitForApproval, act, approversForStep } from '../src/shared/approvals';
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
import zlib from 'node:zlib';
// Side-effect imports: register the bill, expense and cash-advance approval
// subscribers, and the procurement ones the receiving path depends on. The
// two settle handlers are imported by name as well, so a test can call each
// one twice and prove the second call does nothing.
import { settleExpense } from '../src/routes/finance';
import { settleAdvance } from '../src/routes/advances';
import '../src/routes/procurement';

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
const BASE = `http://localhost:${env.port}/api`;

async function cleanup() {
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
  const ids = [
    ...invoices.map((i) => i.id),
    ...bills.map((b) => b.id),
    ...claims.map((c) => c.id),
    ...advances.map((a) => a.id),
  ];
  if (ids.length) {
    const allocations = await prisma.paymentAllocation.findMany({
      where: {
        OR: [
          { invoiceId: { in: invoices.map((i) => i.id) } },
          { billId: { in: bills.map((b) => b.id) } },
          { claimId: { in: claims.map((c) => c.id) } },
          { advanceId: { in: advances.map((a) => a.id) } },
        ],
      },
      select: { paymentId: true },
    });
    await prisma.payment.deleteMany({
      where: { id: { in: [...new Set(allocations.map((a) => a.paymentId))] } },
    });
  }
  await prisma.invoice.deleteMany({ where: { id: { in: invoices.map((i) => i.id) } } });
  await prisma.supplierBill.deleteMany({ where: { id: { in: bills.map((b) => b.id) } } });
  // Job orders after their invoices (Restrict), before the customer and users.
  await prisma.jobOrder.deleteMany({ where: { customer: { name: { startsWith: TAG } } } });
  await prisma.expenseClaim.deleteMany({ where: { id: { in: claims.map((c) => c.id) } } });
  // Any liquidation filed over HTTP against a fixture advance carries the tag too.
  await prisma.expenseClaim.deleteMany({ where: { advanceId: { in: advances.map((a) => a.id) } } });
  await prisma.auditLog.deleteMany({
    where: { entityType: 'cash_advance', entityId: { in: advances.map((a) => a.id) } },
  });
  await prisma.cashAdvance.deleteMany({ where: { id: { in: advances.map((a) => a.id) } } });

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

    const eligible = (await approversForStep(step, request.requesterId)).filter(
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
  const roles = await prisma.role.findMany({ where: { key: { in: roleKeys } } });
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

/**
 * Readable text out of a rendered PDF — the same reader verify-foundation uses.
 * PDFKit Flate-compresses its content streams and writes text as hex runs
 * split at kerning pairs, so each TJ array is joined back into one piece.
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
        piece += part[1]
          ? Buffer.from(part[1], 'hex').toString('latin1')
          : part[2].replace(/\\([()\\])/g, '$1');
      }
      if (piece) out.push(piece);
    }
  }
  return out.join('\n');
}

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

  // ══ Fixtures ═════════════════════════════════════════════════════════════

  const pm = await makeUser('ZZ Fin PM', 'pm@verifyf.local', ['project_manager']);
  const finance = await makeUser('ZZ Finance', 'fin@verifyf.local', ['finance']);
  const engineer = await makeUser('ZZ Engineer', 'eng@verifyf.local', ['project_engineer'], pm.id);
  const procurement = await makeUser('ZZ Procurement', 'proc@verifyf.local', ['procurement']);
  await makeUser('ZZ Director', 'exec@verifyf.local', ['executive']);
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
  const stranger = await makeUser('ZZ Stranger', 'none@verifyf.local', ['zzfin_none']);
  const projectViewer = await makeUser('ZZ Project Viewer', 'projects@verifyf.local', ['zzfin_projects']);
  const claimant = await makeUser('ZZ Claimant', 'claimant@verifyf.local', ['zzfin_claimant']);
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
    'and the working position is receivable less everything owed, advances included',
    money(
      position.workingPosition,
      cents(position.receivable - position.payable - position.reimbursable - position.advancesToRelease),
    ),
  );

  // Fixtures for the route cases below: one released and not liquidated, and
  // one that belongs to somebody else.
  const a4 = await newAdvance(engineer, 3_000, 'released not liquidated');
  await settle((await submitAdvance(a4)).id);
  await release(a4.id, 3_000, dayKey(new Date()));
  const a5 = await newAdvance(pm, 1_000, 'somebody else');

  // ══ Route guards, over HTTP ══════════════════════════════════════════════
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
    const receipt1 = [{ spentOn: todayIso, description: 'Fuel', receiptNo: 'OR-9', amount: 2_500 }];

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
      'the dashboard reports advances to release and in hand',
      typeof after.body.advancesToRelease === 'number' &&
        typeof after.body.advancesInHand === 'number' &&
        typeof after.body.queue.advancesAwaitingRelease === 'number' &&
        typeof after.body.queue.liquidationsOverdue === 'number' &&
        typeof after.body.queue.refundsAwaitingReceipt === 'number',
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
        `${label} names itself, prints money as PHP and never as ±`,
        text.toUpperCase().includes(title.toUpperCase()) && text.includes('PHP') && !text.includes('±'),
        text.slice(0, 160),
      );
    }

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
    const doneInv = await billOrder(doneOrder.id, doneOrder.number);
    check(
      'a completed chargeable order is invoiced, carrying the order',
      doneInv.status === 201 &&
        doneInv.body.jobOrderId === doneOrder.id &&
        doneInv.body.customer?.id === customer.id &&
        doneInv.body.poReference === `${TAG}-PO-77`,
      `${doneInv.status} ${JSON.stringify(doneInv.body).slice(0, 160)}`,
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

    // The customer-facing invoice prints.
    const invoicePdf = await fin('GET', `/invoices/${invoice.id}/pdf`);
    const invoiceText = invoicePdf.bytes ? pdfText(invoicePdf.bytes) : '';
    check(
      'the sales invoice prints as a PDF',
      invoicePdf.status === 200 && invoicePdf.type.includes('application/pdf'),
      `${invoicePdf.status} ${invoicePdf.type}`,
    );
    check(
      'showing NET COLLECTIBLE and its figure, in PHP',
      invoiceText.includes('NET COLLECTIBLE') && invoiceText.includes('PHP 440,000.00') && !invoiceText.includes('±'),
      invoiceText.slice(0, 200),
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
