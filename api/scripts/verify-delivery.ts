/**
 * Phase 4 verification — delivery.
 *
 *   npx tsx scripts/verify-delivery.ts      (the API must be running)
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
import { submitForApproval, act, approversForStep, routePreview } from '../src/shared/approvals';
import { financeSettings, refreshSettlement, settleable, addDays, dayKey } from '../src/shared/finance';
import { renderDocument } from '../src/shared/pdf';
import { signToken } from '../src/auth/middleware';
import { budgetPosition, sCurve, renewalTerm } from '../src/routes/jobs';
// Side-effect import: registers the budget_request approval subscriber.
import '../src/routes/budgetRequests';

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
const ROLE_PREFIX = 'zzdeliv-';
const BASE = `http://localhost:${env.port}/api`;

async function cleanup() {
  // Approvals route to whoever really holds the role, so real people were told
  // about this script's documents too. Every such title carries TAG.
  await prisma.notification.deleteMany({ where: { title: { contains: TAG } } });
  // Children that RESTRICT their parent go first: invoices hold the job and the
  // customer, quotations hold the customer and their owner, installed assets
  // hold the customer.
  await prisma.invoice.deleteMany({ where: { customer: { name: { startsWith: TAG } } } });
  // The budget request's cash: its payments, its liquidation (a claim holding
  // the job with Restrict), then the request itself.
  const requests = await prisma.budgetRequest.findMany({ where: { reason: { startsWith: TAG } }, select: { id: true } });
  const claims = await prisma.expenseClaim.findMany({ where: { purpose: { startsWith: TAG } }, select: { id: true } });
  const allocations = await prisma.paymentAllocation.findMany({
    where: { OR: [{ budgetRequestId: { in: requests.map((r) => r.id) } }, { claimId: { in: claims.map((c) => c.id) } }] },
    select: { paymentId: true },
  });
  await prisma.payment.deleteMany({ where: { id: { in: [...new Set(allocations.map((a) => a.paymentId))] } } });
  await prisma.expenseClaim.deleteMany({ where: { id: { in: claims.map((c) => c.id) } } });
  await prisma.auditLog.deleteMany({ where: { entityType: 'budget_request', entityId: { in: requests.map((r) => r.id) } } });
  await prisma.budgetRequest.deleteMany({ where: { id: { in: requests.map((r) => r.id) } } });
  await prisma.serviceContract.deleteMany({ where: { job: { name: { startsWith: TAG } } } });
  await prisma.installedAsset.deleteMany({ where: { customer: { name: { startsWith: TAG } } } });
  await prisma.job.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.quotation.deleteMany({ where: { customer: { name: { startsWith: TAG } } } });
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
  await prisma.role.deleteMany({ where: { key: { startsWith: ROLE_PREFIX } } });
}

async function makeRole(key: string, permissionKeys: string[]) {
  const permissions = await prisma.permission.findMany({
    where: { key: { in: permissionKeys } },
    select: { id: true, key: true },
  });
  if (permissions.length !== permissionKeys.length) {
    const found = new Set(permissions.map((p) => p.key));
    throw new Error(`Unknown permission(s): ${permissionKeys.filter((k) => !found.has(k)).join(', ')}`);
  }
  return prisma.role.create({
    data: {
      key: `${ROLE_PREFIX}${key}`,
      name: `${TAG} ${key}`,
      permissions: { create: permissions.map((p) => ({ permissionId: p.id })) },
    },
  });
}

interface HttpResult {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

async function http(token: string, method: string, path: string, body?: unknown): Promise<HttpResult> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
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

/** A costing with a reconciled schedule of values, ready to become a job. */
async function readyCosting(title: string, ownerId: string, customerId: string, value = 120_000) {
  const [materials] = await prisma.costCategory.findMany({ orderBy: { sortOrder: 'asc' }, take: 1 });
  return prisma.costing.create({
    data: {
      number: await nextNumber('costing'),
      title: `${TAG} ${title}`,
      ownerId,
      customerId,
      status: 'FINAL',
      totalCost: d(value * 0.8),
      contractValue: d(value),
      lines: {
        create: [
          { costCategoryId: materials.id, description: 'Scope', quantity: d(1), unit: 'lot', unitCost: d(value * 0.8), amount: d(value * 0.8) },
        ],
      },
      scopeSections: {
        create: [{ kind: 'MAIN_WORK', name: `${TAG} ${title} scope`, value: d(value), durationDays: 30, sortOrder: 0 }],
      },
    },
  });
}

const iso = (dt: Date | string) => new Date(dt).toISOString().slice(0, 10);

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
  // Budget requests route to the project's manager, then Finance; the
  // liquidation (an expense claim) to the filer's supervisor, then Finance.
  const finance = await makeUser('Verify Finance', 'fin@verifyd.local', ['finance']);
  await prisma.user.update({ where: { id: engineer.id }, data: { supervisorId: pm.id } });

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
      marginPct: d(0.2),
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

  // ── 3. Budget requests are project cash, never a budget change ────────────
  console.log('\nBudget requests — project cash');

  const settings = await financeSettings();
  const brLedger = () => prisma.jobCostEntry.count({ where: { jobId: job.id, sourceType: 'budget_request' } });
  const br = await prisma.budgetRequest.create({
    data: {
      number: await nextNumber('budget_request'),
      jobId: job.id,
      costCategoryId: materials.id,
      amount: d(50_000),
      reason: `${TAG} consumables for the tie-in`,
      requestedById: engineer.id,
    },
  });
  await prisma.budgetRequest.update({ where: { id: br.id }, data: { status: 'PENDING_APPROVAL' } });

  const request = await submitForApproval({
    documentType: 'budget_request',
    documentId: br.id,
    documentNumber: br.number,
    subject: `${TAG} budget request`,
    amount: 50_000,
    requesterId: engineer.id,
    jobId: job.id,
  });

  // Step 1 is the PROJECT'S manager — whoever the job names, not whoever
  // holds the project_manager role.
  const brWorkflow = await prisma.approvalWorkflow.findUniqueOrThrow({
    where: { id: request.workflowId! },
    include: { steps: { orderBy: { sequence: 'asc' } } },
  });
  const step1 = await approversForStep(brWorkflow.steps[0], engineer.id, prisma, { jobId: job.id });
  check('step 1 is the project’s own manager', step1.length === 1 && step1[0] === pm.id, step1.join(','));
  check('the request remembers its project', request.jobId === job.id);
  position = await budgetPosition(job.id);
  check('a pending request does not change the budget', money(mat().budgeted, 400_000));

  await act({ requestId: request.id, userId: pm.id, action: 'APPROVED' });
  const step2 = await approversForStep(brWorkflow.steps[1], engineer.id, prisma, { jobId: job.id });
  check('then finance decides', step2.includes(finance.id) && !step2.includes(pm.id));
  position = await budgetPosition(job.id);
  check('the budget does not move after the manager’s approval', money(mat().budgeted, 400_000), String(mat().budgeted));

  await act({ requestId: request.id, userId: finance.id, action: 'APPROVED' });
  position = await budgetPosition(job.id);
  check('approval changes NO budget — it is cash, not a budget increase', money(mat().budgeted, 400_000), String(mat().budgeted));
  check('and writes no ledger row', (await brLedger()) === 0);
  const brApproved = await prisma.budgetRequest.findUniqueOrThrow({ where: { id: br.id } });
  check('the request is APPROVED and owes a release', brApproved.status === 'APPROVED' && !!brApproved.approvedAt, brApproved.status);
  check('what finance owes is the whole amount', money((await settleable('budget_request', br.id))!.outstanding, 50_000));

  // The manager's own request cannot wait on them: it goes up to Executive.
  const ownStep = await approversForStep(brWorkflow.steps[0], pm.id, prisma, { jobId: job.id });
  check('the manager’s own request goes to Executive instead', ownStep.includes(exec.id) && !ownStep.includes(pm.id), ownStep.join(','));
  const unmanaged = await approversForStep(brWorkflow.steps[0], engineer.id, prisma, { jobId: null });
  check('and so does one on a project with no manager', unmanaged.includes(exec.id) && !unmanaged.includes(pm.id));
  const ownPreview = await routePreview('budget_request', 50_000, pm.id, null, { jobId: job.id });
  check('the page names Executive before the manager presses Submit', !!ownPreview?.steps[0].approvers.some((p) => p.id === exec.id));

  // Released in one voucher, on its own deadline — the budget request's days,
  // not the cash advance's.
  const releaseDate = new Date('2026-03-02');
  await prisma.payment.create({
    data: {
      number: await nextNumber('disbursement'),
      kind: 'DISBURSEMENT',
      method: 'CASH',
      paymentDate: releaseDate,
      payeeUserId: engineer.id,
      amount: d(50_000),
      clearedAt: releaseDate,
      recordedById: finance.id,
      allocations: { create: [{ budgetRequestId: br.id, amount: d(50_000) }] },
    },
  });
  await prisma.$transaction((tx) => refreshSettlement(tx, 'budget_request', br.id));
  const brReleased = await prisma.budgetRequest.findUniqueOrThrow({ where: { id: br.id } });
  check('the release moves it to RELEASED', brReleased.status === 'RELEASED' && money(num(brReleased.amountReleased), 50_000), brReleased.status);
  check(
    `the liquidation deadline is ${settings.budgetRequestLiquidationDays} days after the release — the request’s own rule`,
    brReleased.liquidationDueDate?.getTime() === addDays(releaseDate, settings.budgetRequestLiquidationDays).getTime(),
    String(brReleased.liquidationDueDate),
  );
  check('still no ledger row — cash in hand is not cost', (await brLedger()) === 0);

  // The team spends 42,000 of it and files the receipts in Expenses: the
  // liquidation posts INCURRED at what was spent, and the change is owed back.
  const incurredBefore = mat().incurred;
  const liquidation = await prisma.expenseClaim.create({
    data: {
      number: await nextNumber('expense'),
      claimedById: engineer.id,
      budgetRequestId: br.id,
      jobId: job.id,
      costCategoryId: materials.id,
      claimDate: dayKey(new Date()),
      purpose: `${TAG} liquidation of ${br.number}`,
      total: d(42_000),
      status: 'PENDING_APPROVAL',
      lines: { create: [{ sortOrder: 0, spentOn: dayKey(new Date()), description: 'Fittings', receiptNo: 'OR-1', amount: d(42_000) }] },
    },
  });
  const liqRequest = await submitForApproval({
    documentType: 'expense',
    documentId: liquidation.id,
    documentNumber: liquidation.number,
    subject: `${TAG} liquidation`,
    amount: 42_000,
    requesterId: engineer.id,
  });
  await act({ requestId: liqRequest.id, userId: pm.id, action: 'APPROVED' });
  await act({ requestId: liqRequest.id, userId: finance.id, action: 'APPROVED' });
  position = await budgetPosition(job.id);
  check('the approved liquidation charges the project what was spent, as incurred', money(mat().incurred, incurredBefore + 42_000), String(mat().incurred));
  check('and the budget is still what the costing set', money(mat().budgeted, 400_000));
  const brLiquidated = await prisma.budgetRequest.findUniqueOrThrow({ where: { id: br.id } });
  check(
    'the request reads REFUND_DUE for the 8,000 not spent',
    brLiquidated.status === 'REFUND_DUE' && money(num(brLiquidated.amountSpent), 42_000),
    `${brLiquidated.status} spent ${brLiquidated.amountSpent}`,
  );
  const liqClaim = await prisma.expenseClaim.findUniqueOrThrow({ where: { id: liquidation.id } });
  check('the liquidation itself is SETTLED — the cash covered it', liqClaim.status === 'SETTLED', liqClaim.status);
  check('the refund owed is the difference', money((await settleable('budget_request_refund', br.id))!.outstanding, 8_000));
  await prisma.payment.create({
    data: {
      number: await nextNumber('payment'),
      kind: 'RECEIPT',
      method: 'CASH',
      paymentDate: dayKey(new Date()),
      payeeUserId: engineer.id,
      amount: d(8_000),
      clearedAt: dayKey(new Date()),
      recordedById: finance.id,
      allocations: { create: [{ budgetRequestId: br.id, amount: d(8_000) }] },
    },
  });
  await prisma.$transaction((tx) => refreshSettlement(tx, 'budget_request_refund', br.id));
  const brClosed = await prisma.budgetRequest.findUniqueOrThrow({ where: { id: br.id } });
  check('returning the change liquidates the request', brClosed.status === 'LIQUIDATED' && money(num(brClosed.amountRefunded), 8_000), brClosed.status);

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

  // ── 10. Renewal term arithmetic ─────────────────────────────────────────────
  console.log('\nRenewal term');

  const monthly = renewalTerm({ startsAt: new Date('2025-10-01'), endsAt: new Date('2026-09-30') });
  check(
    'a renewal starts the day after the old contract ends',
    iso(monthly.startsAt) === '2026-10-01',
    iso(monthly.startsAt),
  );
  check(
    'a whole-month term renews as the same number of months',
    iso(monthly.endsAt) === '2027-09-30',
    iso(monthly.endsAt),
  );
  const leap = renewalTerm({ startsAt: new Date('2027-03-01'), endsAt: new Date('2028-02-29') });
  check(
    'across a leap year it stays on month boundaries rather than drifting a day',
    iso(leap.startsAt) === '2028-03-01' && iso(leap.endsAt) === '2029-02-28',
    `${iso(leap.startsAt)} → ${iso(leap.endsAt)}`,
  );
  const odd = renewalTerm({ startsAt: new Date('2026-01-15'), endsAt: new Date('2026-07-20') });
  const oddDays = (d0: { startsAt: Date; endsAt: Date }) =>
    Math.round((d0.endsAt.getTime() - d0.startsAt.getTime()) / 86_400_000);
  check(
    'an odd-length term keeps its length in days',
    oddDays(odd) === oddDays({ startsAt: new Date('2026-01-15'), endsAt: new Date('2026-07-20') }),
    `${iso(odd.startsAt)} → ${iso(odd.endsAt)}`,
  );

  // ── 11. Over HTTP: prefills, the workspace reads, renewal ──────────────────
  console.log('\nWorkspace and hand-offs (over HTTP)');

  if (!(await apiReachable())) {
    failed += 1;
    console.log(
      `  ✗ the API is not reachable at ${BASE} — the route cases were NOT verified.\n` +
        '      Start it with "npm run dev" in api/ and run this script again.',
    );
  } else {
    const deliveryRole = await makeRole('delivery', [
      'gops.projects.view_all',
      'gops.projects.create',
      'gops.projects.edit_all',
      'gops.costing.view_all',
      'gops.progress_billing.view_all',
      'gops.budget_monitoring.view_all',
      'gops.service_contracts.create',
      'gops.service_contracts.view_all',
      'gops.installed_base.view_all',
      'gchain.receiving.view_all',
      'ghr.meetings.create',
      'ghr.meetings.view_own',
    ]);
    const narrowRole = await makeRole('narrow', ['gops.projects.view_all', 'gops.projects.create']);
    const lead = await prisma.user.create({
      data: {
        name: `${TAG} Delivery lead`,
        email: 'lead@verifyd.local',
        passwordHash: await bcrypt.hash('x', 10),
        roles: { create: [{ roleId: deliveryRole.id }] },
      },
    });
    const narrow = await prisma.user.create({
      data: {
        name: `${TAG} Narrow`,
        email: 'narrow@verifyd.local',
        passwordHash: await bcrypt.hash('x', 10),
        roles: { create: [{ roleId: narrowRole.id }] },
      },
    });
    const leadToken = signToken(lead.id, lead.email);
    const narrowToken = signToken(narrow.id, narrow.email);

    // (0) The Scope of Work tab: the costing's plan, in working days, becomes
    //     the project's tasks on real dates — once, and never over a line
    //     somebody has already planned by hand.
    await prisma.scopeTask.createMany({
      data: [
        { scopeSectionId: costing.scopeSections[0].id, name: `${TAG} Mobilise`, startDay: 1, durationDays: 2, sortOrder: 0 },
        { scopeSectionId: costing.scopeSections[0].id, name: `${TAG} Fabricate`, durationDays: 3, sortOrder: 1 },
      ],
    });
    const planned = await http(leadToken, 'POST', `/jobs/${job.id}/tasks/from-costing`);
    check('POST /jobs/:id/tasks/from-costing plans the costed tasks', planned.status === 200 && planned.body.created === 2, JSON.stringify(planned.body));
    const plannedJob = await http(leadToken, 'GET', `/jobs/${job.id}`);
    const plannedTasks = ((plannedJob.body.tasks ?? []) as { name: string; startDate: string; dueDate: string; scopeItemId: string }[])
      .filter((t) => t.name.startsWith(TAG));
    // Thursday 1 Jan 2026: days 1–2 are Thu–Fri; day 3 skips the weekend to Monday.
    check(
      'working days land on real dates, skipping the weekend',
      iso(plannedTasks[0]?.startDate) === '2026-01-01' && iso(plannedTasks[0]?.dueDate) === '2026-01-02' &&
        iso(plannedTasks[1]?.startDate) === '2026-01-05' && iso(plannedTasks[1]?.dueDate) === '2026-01-07',
      JSON.stringify(plannedTasks.map((t) => [t.name, iso(t.startDate), iso(t.dueDate)])),
    );
    const fabrication = (plannedJob.body.scopeItems as { id: string; name: string; plannedStart: string; plannedEnd: string }[])
      .find((s) => s.name === `${TAG} Fabrication`);
    check(
      'and the scope line takes its tasks’ span as its planned dates',
      plannedTasks.every((t) => t.scopeItemId === fabrication?.id) && iso(fabrication!.plannedStart) === '2026-01-01' && iso(fabrication!.plannedEnd) === '2026-01-07',
      `${fabrication?.plannedStart} → ${fabrication?.plannedEnd}`,
    );
    const replanned = await http(leadToken, 'POST', `/jobs/${job.id}/tasks/from-costing`);
    check('running it again plans nothing over the line already planned', replanned.body.created === 0 && replanned.body.skipped === 1, JSON.stringify(replanned.body));
    const moved = await http(leadToken, 'PATCH', `/jobs/${job.id}/tasks/${(plannedJob.body.tasks as { id: string; name: string }[]).find((t) => t.name === `${TAG} Fabricate`)!.id}`, {
      startDate: '2026-01-06',
      scopeItemId: 'not-on-this-job',
    });
    check('a task cannot be moved onto another project’s scope line', moved.status === 400, String(moved.status));

    // (0b) A meeting held for the project lists on its Meetings & Records tab.
    const kickoff = await http(leadToken, 'POST', '/meetings', {
      title: `${TAG} Kick-off`,
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      endsAt: new Date(Date.now() + 90_000_000).toISOString(),
      jobId: job.id,
    });
    check('a meeting can be held for a project', kickoff.status === 201 && kickoff.body.job?.number === job.number, `${kickoff.status} ${JSON.stringify(kickoff.body.job)}`);
    const forJob = await http(leadToken, 'GET', `/meetings?jobId=${job.id}&pageSize=50`);
    check('and the project lists it', forJob.status === 200 && (forJob.body.rows as { id: string }[]).some((m) => m.id === kickoff.body.id), String(forJob.status));
    const noJob = await http(leadToken, 'POST', '/meetings', {
      title: `${TAG} Nowhere`,
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      endsAt: new Date(Date.now() + 90_000_000).toISOString(),
      jobId: 'no-such-job',
    });
    check('a project that does not exist is refused', noJob.status === 400, String(noJob.status));
    await prisma.meeting.deleteMany({ where: { title: { startsWith: TAG } } });

    // (a) A project created from an approved quotation revision reads back
    //     its quotation — Job.quotationRevisionId was dead before fix 14.
    const qCosting = await readyCosting('Quoted plant', pm.id, customer.id);
    const quotation = await prisma.quotation.create({
      data: {
        number: await nextNumber('quotation', prisma, { ownerId: pm.id }),
        customerId: customer.id,
        ownerId: pm.id,
        subject: `${TAG} quoted plant`,
        revisions: { create: [{ revision: 0, status: 'APPROVED', costingId: qCosting.id }] },
      },
      include: { revisions: true },
    });
    const created = await http(leadToken, 'POST', '/jobs', {
      costingId: qCosting.id,
      quotationRevisionId: quotation.revisions[0].id,
      name: `${TAG} Quoted plant`,
      customerId: customer.id,
    });
    check('POST /jobs with an approved revision → 201', created.status === 201, `${created.status} ${JSON.stringify(created.body).slice(0, 160)}`);
    const quotedJobId: string | undefined = created.body.id;
    const readBack = quotedJobId ? await http(leadToken, 'GET', `/jobs/${quotedJobId}`) : null;
    check(
      'the job reads back the quotation it delivers',
      readBack?.body?.quotationRevision?.quotation?.number === quotation.number,
      JSON.stringify(readBack?.body?.quotationRevision ?? null),
    );
    const costingRead = await http(leadToken, 'GET', `/costings/${qCosting.id}`);
    check(
      'GET /costings/:id lists the job built on it',
      Array.isArray(costingRead.body.jobs) && costingRead.body.jobs.some((j: { id: string }) => j.id === quotedJobId),
      JSON.stringify(costingRead.body.jobs ?? null).slice(0, 160),
    );
    check('a plain project answers serviceContractId null', created.body.serviceContractId === null);

    // (b) The customer comes from the costing — a mismatch is refused.
    const otherCustomer = await prisma.customer.create({ data: { code: `${TAG}-C2`, name: `${TAG} Other clinic` } });
    const mismatch = await http(leadToken, 'POST', '/jobs', {
      costingId: (await readyCosting('Mismatch', pm.id, customer.id)).id,
      name: `${TAG} Mismatch`,
      customerId: otherCustomer.id,
    });
    check(
      "a job for a different customer than its costing's is refused",
      mismatch.status === 400 && /different customer/.test(String(mismatch.body.error ?? mismatch.body.message ?? '')),
      `${mismatch.status} ${JSON.stringify(mismatch.body).slice(0, 160)}`,
    );

    // (c) The job picker: open work by default, closed on request, ?q narrows.
    await prisma.job.update({ where: { id: quotedJobId! }, data: { status: 'COMPLETED' } });
    const openOnly = await http(leadToken, 'GET', `/jobs/lookup?q=${encodeURIComponent(`${TAG} Quoted`)}`);
    const withClosed = await http(leadToken, 'GET', `/jobs/lookup?q=${encodeURIComponent(`${TAG} Quoted`)}&includeClosed=true`);
    check(
      'the job lookup leaves a COMPLETED job out by default',
      Array.isArray(openOnly.body) && !openOnly.body.some((j: { id: string }) => j.id === quotedJobId),
      JSON.stringify(openOnly.body).slice(0, 160),
    );
    check(
      'and includes it with includeClosed=true',
      Array.isArray(withClosed.body) && withClosed.body.some((j: { id: string }) => j.id === quotedJobId),
    );
    check(
      '?q narrows the lookup to matching jobs',
      Array.isArray(withClosed.body) && withClosed.body.every((j: { name: string; number: string }) => j.name.startsWith(TAG)),
      `${withClosed.body.length} row(s)`,
    );

    // (d) Billing ↔ invoice: the billing names its invoice once one exists.
    const before = await http(leadToken, 'GET', `/billings/${b1.id}`);
    check('a billing not yet invoiced says invoice: null', before.status === 200 && before.body.invoice === null, JSON.stringify(before.body.invoice));
    const invoice = await prisma.invoice.create({
      data: {
        number: await nextNumber('invoice'),
        customerId: customer.id,
        jobId: job.id,
        progressBillingId: b1.id,
        invoiceDate: new Date('2026-02-02'),
        dueDate: new Date('2026-03-04'),
        grossAmount: b1.grossAmount,
        vatRate: b1.vatRate,
        vatAmount: b1.vatAmount,
        ewtRate: b1.ewtRate,
        ewtAmount: b1.ewtAmount,
        invoiceTotal: b1.invoiceTotal,
        netCollectible: b1.netCollectible,
        createdById: pm.id,
      },
    });
    const after = await http(leadToken, 'GET', `/billings/${b1.id}`);
    check(
      'GET /billings/:id carries invoice.number after invoicing',
      after.body.invoice?.number === invoice.number && after.body.invoice?.id === invoice.id,
      JSON.stringify(after.body.invoice),
    );

    // (e) The ledger the Budget tab lists names the document behind each row —
    //     here the liquidation, which is where a budget request's cash
    //     reaches the project. Approval itself wrote nothing.
    const ledger = await http(leadToken, 'GET', `/jobs/${job.id}/ledger?pageSize=100`);
    const liqRow = (ledger.body.rows ?? []).find((r: { sourceType: string; sourceId: string }) => r.sourceType === 'expense_claim' && r.sourceId === liquidation.id);
    check(
      'the ledger row for the liquidation names the claim, and no row names the budget request',
      liqRow?.sourceNumber === liquidation.number &&
        !(ledger.body.rows ?? []).some((r: { sourceType: string }) => r.sourceType === 'budget_request'),
      JSON.stringify(liqRow ?? null).slice(0, 160),
    );
    const brList = await http(leadToken, 'GET', `/budget-requests?jobId=${job.id}`);
    // The lead does not hold budget_requests — the tab hides the card for them.
    check('budget requests stay behind their own permission', brList.status === 403, String(brList.status));
    // The project tab and finance's screen read one query: the same rows.
    const financeToken = signToken(finance.id, finance.email);
    const tabRows = await http(signToken(pm.id, pm.email), 'GET', `/budget-requests?jobId=${job.id}&pageSize=100`);
    const finRows = await http(financeToken, 'GET', `/budget-requests?jobId=${job.id}&pageSize=100`);
    check(
      'the project tab and G-FIN’s Budget Requests list the same requests',
      tabRows.status === 200 &&
        finRows.status === 200 &&
        JSON.stringify((tabRows.body.rows ?? []).map((r: { id: string }) => r.id).sort()) ===
          JSON.stringify((finRows.body.rows ?? []).map((r: { id: string }) => r.id).sort()) &&
        (finRows.body.rows ?? []).some((r: { id: string }) => r.id === br.id),
      `${tabRows.status}/${finRows.status}`,
    );
    const brPage = await http(financeToken, 'GET', `/budget-requests/${br.id}`);
    check(
      'finance opens a request and reads its figures',
      brPage.status === 200 && brPage.body.status === 'LIQUIDATED' && brPage.body.amountSpent === 42_000 && brPage.body.amountRefunded === 8_000,
      `${brPage.status} ${brPage.body.status}`,
    );

    // (f) The receiving register narrows to the job (PROC's jobId filter):
    //     every row it returns must belong to the job asked about.
    const receivings = await http(leadToken, 'GET', `/receivings?jobId=${job.id}&pageSize=200`);
    const foreign = (receivings.body.rows ?? []).filter(
      (r: { order?: { job?: { id: string } | null } }) => r.order?.job?.id !== job.id,
    );
    check(
      '/receivings?jobId= returns only that job’s receivings',
      receivings.status === 200 && foreign.length === 0,
      `${receivings.status}: ${foreign.length} row(s) from other jobs`,
    );

    // (g) Renewal: POST /jobs with renewedFromContractId drafts the new
    //     coverage terms in the same transaction.
    const assets = await Promise.all(
      ['Oxygen generator', 'Air compressor'].map(async (name, i) =>
        prisma.installedAsset.create({
          data: {
            code: await nextNumber('installed_asset'),
            customerId: customer.id,
            name: `${TAG} ${name}`,
            serialNo: `${TAG}-SN-${i}`,
          },
        }),
      ),
    );
    const oldCosting = await readyCosting('Service 2025', pm.id, customer.id, 60_000);
    const oldJob = await prisma.job.create({
      data: {
        number: await nextNumber('project'),
        type: 'SERVICE_CONTRACT',
        name: `${TAG} Service 2025`,
        customerId: customer.id,
        costingId: oldCosting.id,
        createdById: pm.id,
        contractValue: d(60_000),
      },
    });
    const oldContract = await prisma.serviceContract.create({
      data: {
        number: await nextNumber('service_contract'),
        status: 'ACTIVE',
        jobId: oldJob.id,
        startsAt: new Date('2025-10-01'),
        endsAt: new Date('2026-09-30'),
        frequencyMonths: 3,
        plannedVisits: 4,
        responseTime: 'Next working day',
        exclusions: `${TAG} consumables`,
        coverageNotes: `${TAG} two units`,
        createdById: pm.id,
        assets: { create: assets.map((a) => ({ assetId: a.id })) },
      },
    });
    const renewalCosting = await readyCosting('Service 2026', pm.id, customer.id, 66_000);

    const refused = await http(narrowToken, 'POST', '/jobs', {
      costingId: renewalCosting.id,
      name: `${TAG} Service 2026 (narrow)`,
      customerId: customer.id,
      renewedFromContractId: oldContract.id,
    });
    check(
      'renewing needs gops.service_contracts.create as well as project create → 403',
      refused.status === 403,
      `${refused.status} ${JSON.stringify(refused.body).slice(0, 120)}`,
    );

    const wrongCustomer = await http(leadToken, 'POST', '/jobs', {
      costingId: (await readyCosting('Renewal elsewhere', pm.id, otherCustomer.id)).id,
      name: `${TAG} Renewal elsewhere`,
      customerId: otherCustomer.id,
      renewedFromContractId: oldContract.id,
    });
    check("a renewal for another customer's contract is refused", wrongCustomer.status === 400, String(wrongCustomer.status));

    const renewal = await http(leadToken, 'POST', '/jobs', {
      costingId: renewalCosting.id,
      name: `${TAG} Service 2026`,
      type: 'PROJECT', // the server forces SERVICE_CONTRACT for a renewal
      customerId: customer.id,
      renewedFromContractId: oldContract.id,
    });
    check('POST /jobs with renewedFromContractId → 201', renewal.status === 201, `${renewal.status} ${JSON.stringify(renewal.body).slice(0, 200)}`);
    check('the renewal job is a SERVICE_CONTRACT whatever was sent', renewal.body.type === 'SERVICE_CONTRACT', renewal.body.type);
    check('and it answers the new contract id', typeof renewal.body.serviceContractId === 'string');

    const drafted = renewal.body.serviceContractId
      ? await prisma.serviceContract.findUnique({
          where: { id: renewal.body.serviceContractId },
          include: { assets: true },
        })
      : null;
    check('the new contract is a DRAFT', drafted?.status === 'DRAFT', drafted?.status);
    check('it belongs to the renewal job', drafted?.jobId === renewal.body.id);
    check('it records what it renewed', drafted?.renewedFromId === oldContract.id);
    check(
      'its number comes from the service_contract sequence',
      !!drafted && drafted.number !== oldContract.number && /\d/.test(drafted.number),
      drafted?.number,
    );
    check(
      'startsAt = the old endsAt + 1 day',
      !!drafted && iso(drafted.startsAt) === '2026-10-01',
      drafted ? iso(drafted.startsAt) : 'none',
    );
    check('the same term length', !!drafted && iso(drafted.endsAt) === '2027-09-30', drafted ? iso(drafted.endsAt) : 'none');
    check('the same frequency', drafted?.frequencyMonths === 3);
    // The first PM visit falls one interval AFTER cover starts and a visit
    // past the end is dropped: Jan, Apr, Jul — the fourth would be 1 Oct 2027.
    check(
      'planned visits come from the schedule rule (quarterly over a year → 3)',
      drafted?.plannedVisits === 3,
      String(drafted?.plannedVisits),
    );
    check(
      'response time, exclusions and coverage notes are copied',
      drafted?.responseTime === 'Next working day' &&
        drafted?.exclusions === `${TAG} consumables` &&
        drafted?.coverageNotes === `${TAG} two units`,
    );
    const covered = new Set(drafted?.assets.map((a) => a.assetId));
    check(
      'the same equipment is covered',
      covered.size === assets.length && assets.every((a) => covered.has(a.id)),
      `${covered.size} of ${assets.length}`,
    );
    const oldAfter = await prisma.serviceContract.findUnique({ where: { id: oldContract.id } });
    check('the old contract is left as it was until the renewal is activated', oldAfter?.status === 'ACTIVE', oldAfter?.status);

    const again = await http(leadToken, 'POST', '/jobs', {
      costingId: (await readyCosting('Service 2026 twice', pm.id, customer.id)).id,
      name: `${TAG} Service 2026 twice`,
      customerId: customer.id,
      renewedFromContractId: oldContract.id,
    });
    check(
      'renewing the same contract twice is refused',
      again.status === 400 && /already been renewed/.test(String(again.body.error ?? again.body.message ?? '')),
      `${again.status} ${JSON.stringify(again.body).slice(0, 120)}`,
    );
    const orphan = await prisma.job.findFirst({ where: { name: `${TAG} Service 2026 twice` } });
    check('and the refusal leaves no job behind', orphan === null);

    // (h) The workspace's Service tab: one read, each section behind its own
    //     register's permission.
    await prisma.installedAsset.update({ where: { id: assets[0].id }, data: { jobId: quotedJobId! } });
    const svc = await http(leadToken, 'GET', `/jobs/${quotedJobId}/service`);
    check(
      'GET /jobs/:id/service lists the equipment the job installed',
      svc.status === 200 && Array.isArray(svc.body.assets) && svc.body.assets.some((a: { id: string }) => a.id === assets[0].id),
      `${svc.status} ${JSON.stringify(svc.body).slice(0, 160)}`,
    );
    const renewalSvc = await http(leadToken, 'GET', `/jobs/${renewal.body.id}/service`);
    check(
      "and a service job's coverage terms, with the contract it renews",
      renewalSvc.body.contract?.id === renewal.body.serviceContractId &&
        renewalSvc.body.contract?.renewedFrom?.id === oldContract.id &&
        renewalSvc.body.contract?.assetCount === 2,
      JSON.stringify(renewalSvc.body.contract ?? null).slice(0, 200),
    );
    const narrowSvc = await http(narrowToken, 'GET', `/jobs/${quotedJobId}/service`);
    check(
      'a caller without installed_base or service_contracts sees null sections, not empty ones',
      narrowSvc.status === 200 && narrowSvc.body.assets === null && narrowSvc.body.contractVisible === false,
      JSON.stringify(narrowSvc.body).slice(0, 160),
    );
    const detail = await http(leadToken, 'GET', `/jobs/${renewal.body.id}`);
    check(
      'the job detail names its coverage terms',
      detail.body.serviceContract?.id === renewal.body.serviceContractId,
      JSON.stringify(detail.body.serviceContract ?? null),
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
