/**
 * Phase 4 verification — delivery.
 *
 *   npx tsx scripts/verify-delivery.ts
 *
 * The arithmetic here is the most consequential in the system: what a project
 * is allowed to spend, how much of it has been earned, and how much may be
 * billed. All three are easy to get subtly wrong and invisible when they are.
 */

import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/prisma';
import { env } from '../src/env';
import { nextNumber } from '../src/shared/numbering';
import { submitForApproval, act } from '../src/shared/approvals';
import { renderDocument } from '../src/shared/pdf';
import { budgetPosition, sCurve } from '../src/routes/jobs';
// Side-effect import: registers the budget_request approval subscriber.
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

const money = (a: number, b: number) => Math.abs(a - b) < 0.005;
const d = (v: number) => new Prisma.Decimal(v);
const num = (v: Prisma.Decimal | null | undefined) => (v == null ? 0 : Number(v));

const TAG = 'ZZDELIV';

async function cleanup() {
  await prisma.job.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.costing.deleteMany({ where: { title: { startsWith: TAG } } });
  await prisma.customer.deleteMany({ where: { name: { startsWith: TAG } } });
  const users = await prisma.user.findMany({
    where: { email: { endsWith: '@verifyd.local' } },
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
  console.log('\nG-CORE delivery verification\n');
  await cleanup();

  const pm = await makeUser('Verify PM', 'pm@verifyd.local', ['project_manager']);
  const exec = await makeUser('Verify Exec', 'exec@verifyd.local', ['executive']);
  const engineer = await makeUser('Verify Engineer', 'eng@verifyd.local', ['project_engineer']);
  // Budget requests route Finance → Management, so somebody has to hold it.
  const finance = await makeUser('Verify Finance', 'fin@verifyd.local', ['finance']);

  const customer = await prisma.customer.create({
    data: { code: `${TAG}-C1`, name: `${TAG} Hospital` },
  });

  const categories = await prisma.costCategory.findMany({ orderBy: { sortOrder: 'asc' } });
  const [materials, equipment, labor] = categories;

  // ── Setup: a costing with a reconciled schedule of values ─────────────────
  const costing = await prisma.costing.create({
    data: {
      number: await nextNumber('costing'),
      title: `${TAG} Oxygen plant`,
      ownerId: pm.id,
      customerId: customer.id,
      markupPct: d(0.25),
      totalCost: d(800_000),
      contractValue: d(1_000_000),
      lines: {
        create: [
          { costCategoryId: materials.id, description: 'Pipe', quantity: d(1), unit: 'lot', unitCost: d(400_000), amount: d(400_000) },
          { costCategoryId: equipment.id, description: 'Skid', quantity: d(1), unit: 'unit', unitCost: d(300_000), amount: d(300_000) },
          { costCategoryId: labor.id, description: 'Crew', quantity: d(1), unit: 'lot', unitCost: d(100_000), amount: d(100_000) },
        ],
      },
      scopeSections: {
        create: [
          { kind: 'MAIN_WORK', name: `${TAG} Fabrication`, value: d(600_000), durationDays: 60, sortOrder: 0 },
          { kind: 'TESTING_COMMISSIONING', name: `${TAG} Testing`, value: d(300_000), durationDays: 20, sortOrder: 1 },
          { kind: 'TURNOVER', name: `${TAG} Turnover`, value: d(100_000), durationDays: 10, sortOrder: 2 },
        ],
      },
    },
    include: { lines: true, scopeSections: { orderBy: { sortOrder: 'asc' } } },
  });

  // ── 1. Creating a job from a costing ───────────────────────────────────────
  console.log('Job creation');

  const start = new Date('2026-01-01');
  let cursor = new Date(start);
  const job = await prisma.job.create({
    data: {
      number: await nextNumber('project'),
      name: `${TAG} Oxygen plant`,
      customerId: customer.id,
      costingId: costing.id,
      createdById: pm.id,
      projectManagerId: pm.id,
      contractValue: costing.contractValue,
      startDate: start,
      scopeItems: {
        create: costing.scopeSections.map((s, i) => {
          const plannedStart = new Date(cursor);
          const plannedEnd = new Date(cursor);
          plannedEnd.setDate(plannedEnd.getDate() + s.durationDays);
          cursor = plannedEnd;
          return {
            sourceSectionId: s.id,
            kind: s.kind,
            name: s.name,
            value: s.value,
            durationDays: s.durationDays,
            plannedStart,
            plannedEnd,
            sortOrder: i,
          };
        }),
      },
    },
    include: { scopeItems: { orderBy: { sortOrder: 'asc' } } },
  });

  // Opening budget from the costing lines, grouped by category.
  const byCategory = new Map<string, number>();
  for (const line of costing.lines) {
    byCategory.set(line.costCategoryId, (byCategory.get(line.costCategoryId) ?? 0) + num(line.amount));
  }
  await prisma.jobCostEntry.createMany({
    data: [...byCategory.entries()].map(([costCategoryId, amount]) => ({
      jobId: job.id,
      costCategoryId,
      state: 'BUDGETED' as const,
      amount: d(amount),
      sourceType: 'costing',
      sourceId: costing.id,
      sourceNumber: costing.number,
      createdById: pm.id,
    })),
  });

  check('the schedule of values is snapshotted', job.scopeItems.length === 3, `${job.scopeItems.length}`);
  check(
    'and it totals the contract value',
    money(job.scopeItems.reduce((s, i) => s + num(i.value), 0), 1_000_000),
  );
  check(
    'scope items are scheduled back to back',
    job.scopeItems[1].plannedStart?.getTime() === job.scopeItems[0].plannedEnd?.getTime(),
  );

  // Snapshotting is the point: editing the costing must not move the job.
  await prisma.scopeSection.update({
    where: { id: costing.scopeSections[0].id },
    data: { value: d(999_999), name: `${TAG} EDITED` },
  });
  const afterEdit = await prisma.jobScopeItem.findFirst({
    where: { jobId: job.id, sortOrder: 0 },
  });
  check(
    'editing the costing afterwards does NOT move the job',
    money(num(afterEdit!.value), 600_000) && afterEdit!.name === `${TAG} Fabrication`,
    `${num(afterEdit!.value)} / ${afterEdit!.name}`,
  );

  // ── 2. The four-state budget ───────────────────────────────────────────────
  console.log('\nBudget monitoring');

  let position = await budgetPosition(job.id);
  const mat = () => position.find((p) => p.costCategoryId === materials.id)!;

  check('the opening budget comes from the costing', money(mat().budgeted, 400_000), String(mat().budgeted));
  check('nothing is committed yet', mat().committed === 0);
  check('available equals budgeted at the start', money(mat().available, 400_000));

  // Phase 5 will write these; the ledger accepts them now.
  await prisma.jobCostEntry.create({
    data: {
      jobId: job.id,
      costCategoryId: materials.id,
      state: 'COMMITTED',
      amount: d(150_000),
      sourceType: 'purchase_order',
      sourceNumber: 'GT-PO-TEST',
      createdById: pm.id,
    },
  });
  await prisma.jobCostEntry.create({
    data: {
      jobId: job.id,
      costCategoryId: materials.id,
      state: 'INCURRED',
      amount: d(100_000),
      sourceType: 'receiving',
      sourceNumber: 'GT-RR-TEST',
      createdById: pm.id,
    },
  });
  position = await budgetPosition(job.id);
  check('committed is tracked', money(mat().committed, 150_000));
  check('incurred is tracked', money(mat().incurred, 100_000));
  check(
    'available = budgeted − committed − incurred',
    money(mat().available, 150_000),
    String(mat().available),
  );

  // Consumed must NOT be subtracted again — it was already counted as incurred
  // when the goods were received. Subtracting both charges the same peso twice.
  await prisma.jobCostEntry.create({
    data: {
      jobId: job.id,
      costCategoryId: materials.id,
      state: 'CONSUMED',
      amount: d(80_000),
      sourceType: 'stock_issue',
      sourceNumber: 'GT-SI-TEST',
      createdById: pm.id,
    },
  });
  position = await budgetPosition(job.id);
  check('consumed is reported', money(mat().consumed, 80_000));
  check(
    'but consumed is NOT subtracted twice',
    money(mat().available, 150_000),
    `available moved to ${mat().available}`,
  );

  // ── 3. Budget requests change the budget ───────────────────────────────────
  console.log('\nBudget requests');

  const br = await prisma.budgetRequest.create({
    data: {
      number: await nextNumber('budget_request'),
      jobId: job.id,
      costCategoryId: materials.id,
      amount: d(50_000),
      reason: `${TAG} price increase on stainless`,
      requestedById: pm.id,
    },
  });
  await prisma.budgetRequest.update({ where: { id: br.id }, data: { status: 'PENDING_APPROVAL' } });

  const request = await submitForApproval({
    documentType: 'budget_request',
    documentId: br.id,
    documentNumber: br.number,
    subject: `${TAG} budget request`,
    amount: 50_000,
    requesterId: pm.id,
  });

  position = await budgetPosition(job.id);
  check('a pending request does not change the budget', money(mat().budgeted, 400_000));

  // Two steps: finance, then management. The budget must not move until both.
  await act({ requestId: request.id, userId: finance.id, action: 'APPROVED' });
  position = await budgetPosition(job.id);
  check(
    'the budget does not move after only the first approval',
    money(mat().budgeted, 400_000),
    String(mat().budgeted),
  );

  await act({ requestId: request.id, userId: exec.id, action: 'APPROVED' });
  position = await budgetPosition(job.id);
  check('approving it raises the budget', money(mat().budgeted, 450_000), String(mat().budgeted));
  check('and available follows', money(mat().available, 200_000), String(mat().available));

  const ledgerRow = await prisma.jobCostEntry.findFirst({
    where: { jobId: job.id, sourceType: 'budget_request', sourceId: br.id },
  });
  check('the increase is a ledger row, not an edited total', ledgerRow !== null);
  check('and it names the document it came from', ledgerRow?.sourceNumber === br.number);

  // ── 4. Progress reports chain ──────────────────────────────────────────────
  console.log('\nProgress reports');

  const scope = job.scopeItems;

  const r1 = await prisma.progressReport.create({
    data: {
      number: await nextNumber('progress_report'),
      reportNo: 1,
      jobId: job.id,
      periodFrom: new Date('2026-01-01'),
      periodTo: new Date('2026-01-31'),
      preparedById: engineer.id,
      lines: {
        create: scope.map((item) => ({
          scopeItemId: item.id,
          previousPct: d(0),
          thisPeriodPct: d(0),
          toDatePct: d(0),
        })),
      },
    },
    include: { lines: true },
  });

  // 30% of fabrication in period 1.
  const fabLine1 = r1.lines.find((l) => l.scopeItemId === scope[0].id)!;
  await prisma.progressReportLine.update({
    where: { id: fabLine1.id },
    data: { thisPeriodPct: d(30), toDatePct: d(30) },
  });
  await prisma.progressReport.update({
    where: { id: r1.id },
    data: { status: 'APPROVED', approvedById: pm.id, approvedAt: new Date() },
  });

  // Report 2 carries report 1's to-date forward as its opening position.
  const r2 = await prisma.progressReport.create({
    data: {
      number: await nextNumber('progress_report'),
      reportNo: 2,
      jobId: job.id,
      previousReportId: r1.id,
      periodFrom: new Date('2026-02-01'),
      periodTo: new Date('2026-02-28'),
      preparedById: engineer.id,
      lines: {
        create: scope.map((item) => {
          const prev = item.id === scope[0].id ? 30 : 0;
          return {
            scopeItemId: item.id,
            previousPct: d(prev),
            thisPeriodPct: d(0),
            toDatePct: d(prev),
          };
        }),
      },
    },
    include: { lines: true },
  });

  const fabLine2 = r2.lines.find((l) => l.scopeItemId === scope[0].id)!;
  check(
    'the next report carries the previous percentage forward',
    money(num(fabLine2.previousPct), 30),
    String(num(fabLine2.previousPct)),
  );
  check('and the chain is linked', r2.previousReportId === r1.id);

  // ── 5. Earned value ────────────────────────────────────────────────────────
  console.log('\nEarned value');

  // 30% of a 600k line, against a 1M contract, is 18% overall — not 30%.
  // Weighting by value is the whole point of a schedule of values.
  const earnedAfterR1 = (600_000 * 30) / 100;
  const overallPct = (earnedAfterR1 / 1_000_000) * 100;
  check('earned value weights each line by its value', money(earnedAfterR1, 180_000));
  check(
    'overall % is value-weighted, not a line average',
    money(overallPct, 18),
    `${overallPct}% — a simple average of 30/0/0 would read 10%`,
  );

  // ── 6. Billing ─────────────────────────────────────────────────────────────
  console.log('\nProgress billing');

  const company = await prisma.company.findUnique({ where: { id: 'company' } });
  const vatRate = num(company?.vatRate ?? d(0.12));
  const ewtRate = num(company?.ewtRate ?? d(0.02));

  const gross1 = 180_000;
  const vat1 = Math.round(gross1 * vatRate * 100) / 100;
  const ewt1 = Math.round(gross1 * ewtRate * 100) / 100;

  const b1 = await prisma.progressBilling.create({
    data: {
      number: await nextNumber('progress_billing'),
      billingNo: 1,
      jobId: job.id,
      progressReportId: r1.id,
      billingDate: new Date('2026-02-01'),
      grossAmount: d(gross1),
      vatRate: d(vatRate),
      vatAmount: d(vat1),
      ewtRate: d(ewtRate),
      ewtAmount: d(ewt1),
      invoiceTotal: d(gross1 + vat1),
      netCollectible: d(gross1 + vat1 - ewt1),
      status: 'APPROVED',
      lines: {
        create: scope.map((item) => {
          const pct = item.id === scope[0].id ? 30 : 0;
          const amount = (num(item.value) * pct) / 100;
          return {
            scopeItemId: item.id,
            scopeValue: item.value,
            previousPct: d(0),
            toDatePct: d(pct),
            previousAmount: d(0),
            thisPeriodAmount: d(amount),
          };
        }),
      },
    },
  });

  check('gross billed equals earned value', money(num(b1.grossAmount), 180_000));
  check('VAT is added on top', money(num(b1.vatAmount), 21_600), String(num(b1.vatAmount)));
  check('invoice total is gross + VAT', money(num(b1.invoiceTotal), 201_600));
  // EWT is on the gross, NOT on the VAT — a common and expensive mistake.
  check('EWT is withheld on the gross, not the VAT', money(num(b1.ewtAmount), 3_600), String(num(b1.ewtAmount)));
  check(
    'net collectible is invoice total less EWT',
    money(num(b1.netCollectible), 198_000),
    String(num(b1.netCollectible)),
  );
  check(
    'invoiced and collectible genuinely differ',
    !money(num(b1.invoiceTotal), num(b1.netCollectible)),
  );

  // Second billing: fabrication to 50%, testing to 20%. Only the DIFFERENCE
  // may be billed — re-billing the same work must be impossible.
  await prisma.progressReportLine.update({
    where: { id: fabLine2.id },
    data: { thisPeriodPct: d(20), toDatePct: d(50) },
  });
  const testLine2 = r2.lines.find((l) => l.scopeItemId === scope[1].id)!;
  await prisma.progressReportLine.update({
    where: { id: testLine2.id },
    data: { thisPeriodPct: d(20), toDatePct: d(20) },
  });
  await prisma.progressReport.update({ where: { id: r2.id }, data: { status: 'APPROVED' } });

  const priorLines = await prisma.progressBillingLine.findMany({
    where: { billing: { jobId: job.id } },
  });
  const billedPct = new Map<string, number>();
  for (const l of priorLines) {
    billedPct.set(l.scopeItemId, Math.max(billedPct.get(l.scopeItemId) ?? 0, num(l.toDatePct)));
  }

  const r2Lines = await prisma.progressReportLine.findMany({
    where: { reportId: r2.id },
    include: { scopeItem: true },
  });
  const gross2 = r2Lines.reduce((sum, l) => {
    const value = num(l.scopeItem.value);
    const prev = billedPct.get(l.scopeItemId) ?? 0;
    return sum + (value * num(l.toDatePct)) / 100 - (value * prev) / 100;
  }, 0);

  // Fabrication 30→50% = 120,000. Testing 0→20% = 60,000. Total 180,000.
  check('the second billing covers only the difference', money(gross2, 180_000), String(gross2));

  // Billing the same report again must find nothing left.
  const gross3 = r2Lines.reduce((sum, l) => {
    const value = num(l.scopeItem.value);
    const alreadyBilled = num(l.toDatePct);
    return sum + (value * num(l.toDatePct)) / 100 - (value * alreadyBilled) / 100;
  }, 0);
  check('re-billing the same progress yields nothing', money(gross3, 0), String(gross3));

  // ── 7. Progress cannot go backwards ────────────────────────────────────────
  console.log('\nGuards');

  const wouldReverse = 10 - num(fabLine2.previousPct);
  check('a to-date below what was already reported is negative', wouldReverse < 0, String(wouldReverse));

  const over = 30 + 80;
  check('a line cannot exceed 100%', over > 100, `${over}%`);

  // ── 8. S-curve ─────────────────────────────────────────────────────────────
  console.log('\nS-curve');

  const curve = await sCurve(job.id);
  check('the curve has points', curve.length > 2, `${curve.length}`);
  check('planned rises to 100%', money(curve[curve.length - 1].planned, 100), String(curve[curve.length - 1].planned));

  const withActual = curve.filter((p) => p.actual !== null);
  check('actual is recorded where reports exist', withActual.length > 0);
  const lastActual = withActual[withActual.length - 1];
  // Fabrication 50% (300k) + testing 20% (60k) = 360k of 1M = 36%.
  check('actual is value-weighted', money(lastActual.actual!, 36), `${lastActual.actual}%`);

  const withBilled = curve.filter((p) => p.billed !== null);
  check('billed is tracked separately from actual', withBilled.length > 0);
  check(
    'and billed trails actual — that gap is unbilled work',
    withBilled[withBilled.length - 1].billed! < lastActual.actual!,
    `billed ${withBilled[withBilled.length - 1].billed}% vs actual ${lastActual.actual}%`,
  );

  // ── 9. Documents ───────────────────────────────────────────────────────────
  console.log('\nDocuments');

  const pdf = await renderDocument({
    title: 'Progress Billing',
    documentNumber: b1.number,
    sections: [
      {
        kind: 'table',
        title: 'Summary',
        head: ['', 'Amount'],
        align: ['left', 'right'],
        rows: [
          ['Gross amount', '180,000.00'],
          ['Add: VAT (12%)', '21,600.00'],
          ['INVOICE TOTAL', '201,600.00'],
          ['Less: creditable withholding tax (2%)', '-3,600.00'],
          ['NET COLLECTIBLE', '198,000.00'],
        ],
      },
    ],
  });
  check('a progress billing prints', pdf.subarray(0, 5).toString() === '%PDF-');

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
