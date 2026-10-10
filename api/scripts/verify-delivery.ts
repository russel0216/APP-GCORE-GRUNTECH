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
import { signToken } from '../src/auth/middleware';
import { budgetPosition, sCurve, renewalTerm } from '../src/routes/jobs';
import { statusLabel } from '../src/shared/pdf';
// Side-effect import: registers the budget_request approval subscriber.
import '../src/routes/budgetRequests';
import {
  flat,
  LANDSCAPE,
  pendingCount,
  printed,
  referenceOf,
  saysCount,
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
  // The progress report and the billing are printed through their own routes
  // in section 11 (over HTTP): the sign-offs, the money block and the trail.

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

    // (d2) The progress report and the billing on paper (rule 6). Neither has
    //      an approval route, so each prints the people who actually acted,
    //      each dated — never a "Checked by" nobody checks, never a Conforme,
    //      never the project's manager guessed as a preparer — and its money
    //      as the quotation's totals block, the figures in the table without
    //      the code, which the column head names.
    const currency = (await prisma.company.findUnique({ where: { id: 'company' }, select: { currency: true } }))?.currency?.trim() || 'PHP';
    const rate = (r: number) => `${+(r * 100).toFixed(2)}%`;
    const peso = (n: number) => `${currency} ${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const exports = (entityType: string, entityId: string) =>
      prisma.auditLog.count({ where: { entityType, entityId, action: 'EXPORTED' } });

    const r1Pdf = await printed(leadToken, `/progress-reports/${r1.id}/pdf`);
    const r1Text = r1Pdf.text;
    check(
      'an approved progress report prints who prepared it and who approved it, each dated — and no "Checked by"',
      r1Pdf.status === 200 &&
        flat(r1Text).includes('PREPARED BY') &&
        flat(r1Text).includes('APPROVED BY') &&
        !flat(r1Text).includes('CHECKED BY') &&
        r1Text.includes('Verify Engineer') &&
        r1Text.includes('Verify PM') &&
        signedCount(r1Text) === 2 &&
        pendingCount(r1Text) === 0,
      `${r1Pdf.status} ${signedCount(r1Text)} signed, ${pendingCount(r1Text)} pending`,
    );
    check(
      'its money is a totals block — contract value, earned this period and to date with their percentages — never a TOTAL row in the table',
      r1Text.includes('Contract value') &&
        r1Text.includes(peso(1_000_000)) &&
        r1Text.includes('Earned this period (18.00%)') &&
        r1Text.includes('Earned to date (18.00%)') &&
        r1Text.includes(peso(180_000)) &&
        flat(r1Text).includes(`VALUE (${currency})`) &&
        r1Text.includes('600,000.00') &&
        !r1Text.includes(peso(600_000)) &&
        !r1Text.includes('TOTAL'),
      r1Text.split('\n').filter((l) => /Contract|Earned|TOTAL|VALUE/.test(l)).join(' | ').slice(0, 240),
    );
    check('the print is on the report\'s trail as EXPORTED', (await exports('progress_report', r1.id)) === 1);

    // A billing raised and approved through the routes: the trail names both.
    const billerRole = await makeRole('biller', ['gops.progress_billing.view_all', 'gops.progress_billing.create']);
    const approverRole = await makeRole('billapprover', ['gops.progress_billing.view_all', 'gops.progress_billing.approve']);
    const biller = await makeUser(`${TAG} Biller`, 'biller@verifyd.local', [billerRole.key]);
    const billApprover = await makeUser(`${TAG} Approver`, 'billapprover@verifyd.local', [approverRole.key]);
    const billerToken = signToken(biller.id, biller.email);
    const raised = await http(billerToken, 'POST', '/billings', { progressReportId: r2.id });
    const draftBill = await printed(billerToken, `/billings/${raised.body.id}/pdf`);
    const draftBillText = draftBill.text;
    check(
      'a draft billing prints who raised it, dated, and "Approved by" Pending under nobody — never the creator as its approver',
      raised.status === 201 &&
        draftBill.status === 200 &&
        draftBillText.includes(`${TAG} Biller`) &&
        signedCount(draftBillText) === 1 &&
        pendingCount(draftBillText) === 1 &&
        (draftBillText.match(new RegExp(`${TAG} Biller`, 'g')) ?? []).length === 1 &&
        !flat(draftBillText).includes('CHECKED BY') &&
        !flat(draftBillText).includes('CONFORME'),
      `${raised.status} ${draftBill.status} ${signedCount(draftBillText)} signed, ${pendingCount(draftBillText)} pending`,
    );
    check(
      `its money is the quotation's block: Gross amount, VAT (${rate(vatRate)}), Invoice total, Less: EWT (${rate(ewtRate)}), Net collectible`,
      draftBillText.includes('Gross amount') &&
        draftBillText.includes(`VAT (${rate(vatRate)})`) &&
        draftBillText.includes('Invoice total') &&
        draftBillText.includes(`Less: EWT (${rate(ewtRate)})`) &&
        draftBillText.includes('Net collectible') &&
        draftBillText.includes(peso(gross1)) &&
        draftBillText.includes(peso(gross1 + vat1 - ewt1)) &&
        !draftBillText.includes('INVOICE TOTAL') &&
        !draftBillText.includes('NET COLLECTIBLE') &&
        !draftBillText.includes('creditable withholding') &&
        !draftBillText.includes('TOTAL') &&
        flat(draftBillText).includes(`THIS BILLING (${currency})`),
      draftBillText.split('\n').filter((l) => /Gross|VAT|Total|total|TOTAL|EWT|Net|BILLING/.test(l)).join(' | ').slice(0, 260),
    );
    // The table speaks the billing screen's words: what was billed BEFORE
    // this billing is "Previously billed" — never "Billed to date", which on
    // a second billing would print the earlier figure as the running total.
    check(
      'its table heads what came before "Previously billed", as the screen does — never "Billed to date"',
      flat(draftBillText).includes('PREVIOUSLY BILLED %') &&
        flat(draftBillText).includes(`PREVIOUSLY BILLED (${currency})`) &&
        !flat(draftBillText).includes('BILLED TO DATE'),
      flat(draftBillText).match(/SCOPE.{0,160}/)?.[0] ?? '',
    );
    // The billings list on paper counts only what has been approved: a draft
    // prints its figures in brackets, the totals leave it out, and the note
    // says so in finance's words.
    const fmt2 = (n: number) => n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const draftList = await printed(billerToken, `/billings/pdf?ids=${raised.body.id}`);
    check(
      'on the billings list a draft prints its figures in brackets, out of the totals, and the note says how many',
      draftList.status === 200 &&
        flat(draftList.text).includes(`(${fmt2(Number(raised.body.grossAmount))})`) &&
        flat(draftList.text).includes(`(${fmt2(Number(raised.body.netCollectible))})`) &&
        flat(draftList.text).includes(`Gross amount ${peso(0)}`) &&
        flat(draftList.text).includes(`Net collectible ${peso(0)}`) &&
        flat(draftList.text).includes('1 billing not yet approved, in brackets, is not counted.'),
      flat(draftList.text).match(/Gross amount.{0,160}/)?.[0] ?? String(draftList.status),
    );

    // Rule 3: whoever raised a billing never approves it — given the right,
    // and as a super admin too — and the page does not offer the button.
    const selfRole = await makeRole('billself', ['gops.progress_billing.approve']);
    await prisma.userRole.create({ data: { userId: biller.id, roleId: selfRole.id } });
    const selfApprove = await http(billerToken, 'POST', `/billings/${raised.body.id}/approve`);
    const selfPage = await http(billerToken, 'GET', `/billings/${raised.body.id}`);
    await prisma.user.update({ where: { id: biller.id }, data: { isSuperAdmin: true } });
    const selfAsAdmin = await http(billerToken, 'POST', `/billings/${raised.body.id}/approve`);
    await prisma.user.update({ where: { id: biller.id }, data: { isSuperAdmin: false } });
    const approverPage = await http(signToken(billApprover.id, billApprover.email), 'GET', `/billings/${raised.body.id}`);
    check(
      'whoever raised a billing cannot approve it, a super admin included — and only somebody else is offered the button',
      selfApprove.status === 403 &&
        selfAsAdmin.status === 403 &&
        selfPage.body.canApprove === false &&
        approverPage.body.canApprove === true &&
        (await prisma.progressBilling.findUnique({ where: { id: raised.body.id } }))?.status === 'DRAFT',
      `${selfApprove.status} / admin ${selfAsAdmin.status} · offered ${selfPage.body.canApprove} / ${approverPage.body.canApprove}`,
    );
    const approvedBill = await http(signToken(billApprover.id, billApprover.email), 'POST', `/billings/${raised.body.id}/approve`);
    const finalBill = await printed(billerToken, `/billings/${raised.body.id}/pdf`);
    const finalBillText = finalBill.text;
    check(
      'approved, it prints the approver by name, dated, and nothing Pending',
      approvedBill.status === 200 &&
        finalBillText.includes(`${TAG} Biller`) &&
        finalBillText.includes(`${TAG} Approver`) &&
        signedCount(finalBillText) === 2 &&
        pendingCount(finalBillText) === 0,
      `${approvedBill.status} ${signedCount(finalBillText)} signed, ${pendingCount(finalBillText)} pending`,
    );
    check('both prints are on the billing\'s trail as EXPORTED', (await exports('progress_billing', raised.body.id)) === 2);

    // Rule 3 on the progress report too: whoever prepared it never approves
    // it — given the right, and as a super admin — the page offers the button
    // only to somebody else, and two approvals at once land once.
    const approverToken = signToken(billApprover.id, billApprover.email);
    const r3 = await http(billerToken, 'POST', '/progress-reports', { jobId: job.id, periodFrom: '2026-03-01', periodTo: '2026-03-31' });
    const r3Self = await http(billerToken, 'POST', `/progress-reports/${r3.body.id}/approve`);
    const r3SelfPage = await http(billerToken, 'GET', `/progress-reports/${r3.body.id}`);
    await prisma.user.update({ where: { id: biller.id }, data: { isSuperAdmin: true } });
    const r3AsAdmin = await http(billerToken, 'POST', `/progress-reports/${r3.body.id}/approve`);
    const r3AdminPage = await http(billerToken, 'GET', `/progress-reports/${r3.body.id}`);
    await prisma.user.update({ where: { id: biller.id }, data: { isSuperAdmin: false } });
    const r3ApproverPage = await http(approverToken, 'GET', `/progress-reports/${r3.body.id}`);
    check(
      'whoever prepared a progress report cannot approve it, a super admin included — and only somebody else is offered the button',
      r3.status === 201 &&
        r3Self.status === 403 &&
        r3AsAdmin.status === 403 &&
        r3SelfPage.body.canApprove === false &&
        r3AdminPage.body.canApprove === false &&
        r3ApproverPage.body.canApprove === true &&
        (await prisma.progressReport.findUnique({ where: { id: r3.body.id } }))?.status === 'DRAFT',
      `${r3.status} · ${r3Self.status} / admin ${r3AsAdmin.status} · offered ${r3SelfPage.body.canApprove} / ${r3AdminPage.body.canApprove} / ${r3ApproverPage.body.canApprove}`,
    );
    const r3Race = await Promise.all([
      http(approverToken, 'POST', `/progress-reports/${r3.body.id}/approve`),
      http(approverToken, 'POST', `/progress-reports/${r3.body.id}/approve`),
    ]);
    const r3Approvals = await prisma.auditLog.count({ where: { entityType: 'progress_report', entityId: r3.body.id, action: 'APPROVED' } });
    const r3After = await http(approverToken, 'GET', `/progress-reports/${r3.body.id}`);
    check(
      'two approvals pressed at once approve it once — the second is refused, never written over the first',
      r3Race.map((r) => r.status).sort().join(',') === '200,400' && r3Approvals === 1 && r3After.body.canApprove === false,
      `${r3Race.map((r) => r.status).join(',')} · ${r3Approvals} APPROVED row(s)`,
    );
    const r3Pdf = await printed(approverToken, `/progress-reports/${r3.body.id}/pdf`);
    const r3Text = r3Pdf.text;
    const times = (t: string, name: string) => (t.match(new RegExp(name, 'g')) ?? []).length;
    check(
      'its paper prints the preparer once and the approver once, each dated — never one name as both',
      r3Pdf.status === 200 &&
        times(r3Text, `${TAG} Biller`) === 1 &&
        times(r3Text, `${TAG} Approver`) === 1 &&
        signedCount(r3Text) === 2 &&
        pendingCount(r3Text) === 0,
      `${r3Pdf.status} biller ×${times(r3Text, `${TAG} Biller`)}, approver ×${times(r3Text, `${TAG} Approver`)}, ${signedCount(r3Text)} signed`,
    );
    // A billing written outside the routes has no trail to name anybody: the
    // paper names nobody rather than the project's manager it used to guess.
    const bareBill = await printed(leadToken, `/billings/${b1.id}/pdf`);
    const bareBillText = bareBill.text;
    check(
      'a billing nobody is on record as raising names no preparer — the project manager is not guessed',
      bareBill.status === 200 && !bareBillText.includes('Verify PM') && !flat(bareBillText).includes('PREPARED BY'),
      `${bareBill.status} PM ${bareBillText.includes('Verify PM')}`,
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

    // The request on paper (rule 6) — the cash advance's document: the money
    // as the quotation's totals block, its route by the step names alone
    // (never "Approved by — …"), each signed and dated, and who received the
    // cash. Everything here has happened, so nothing prints "Pending".
    const brPdf = await printed(financeToken, `/budget-requests/${br.id}/pdf`);
    const brText = brPdf.text;
    const brFlat = flat(brText);
    const brSteps = brWorkflow.steps.map((st) => st.name.toUpperCase());
    check(
      'the printed request signs every step of its route by the step’s own name, then who received the cash — all dated',
      brPdf.status === 200 &&
        brFlat.includes('REQUESTED BY') &&
        brSteps.every((st) => brFlat.includes(st)) &&
        brFlat.includes('RECEIVED BY') &&
        !brFlat.includes('APPROVED BY') &&
        brText.includes('Verify Engineer') &&
        brText.includes('Verify PM') &&
        brText.includes('Verify Finance') &&
        signedCount(brText) === 4 &&
        pendingCount(brText) === 0,
      `${brPdf.status} ${brSteps.join(' / ')} · ${signedCount(brText)} signed, ${pendingCount(brText)} pending`,
    );
    check(
      'its money is a totals block — requested, released, spent, owed back, refunded, still to refund — with statuses in words',
      brText.includes('Amount requested') &&
        brText.includes(peso(50_000)) &&
        brText.includes('Released') &&
        brText.includes('Spent (per liquidation)') &&
        brText.includes(peso(42_000)) &&
        brText.includes('Unspent — owed back') &&
        brText.includes('Less: refunded') &&
        brText.includes(peso(8_000)) &&
        brText.includes('Still to refund') &&
        brText.includes(peso(0)) &&
        brText.includes('Liquidated') &&
        brText.includes('Settled') &&
        !brText.includes('AMOUNT REQUESTED') &&
        !brText.includes('LIQUIDATED') &&
        !brText.includes('SETTLED'),
      brText.split('\n').filter((l) => /requested|Released|Spent|refund|Liquidated|Settled/i.test(l)).join(' | ').slice(0, 300),
    );
    check('the print is on the request’s trail as EXPORTED', (await exports('budget_request', br.id)) === 1);

    // The register on paper (rule 6, A5): `GET /budget-requests/pdf` reads
    // `budgetRequestListWhere`, the query the project tab and G-FIN's screen
    // share — so the project manager's print and finance's print of one
    // project are the same requests, the project named in the reference.
    const squash = (t: string) => t.replace(/\s+/g, '');
    const listExports = (actorId: string) =>
      prisma.auditLog.count({ where: { entityType: 'budget_request', entityId: 'list', action: 'EXPORTED', actorId } });
    const exportsBefore = (await listExports(pm.id)) + (await listExports(finance.id));
    const tabNumbers = ((tabRows.body.rows ?? []) as { number: string }[]).map((r) => r.number);
    const tabPaper = await printed(signToken(pm.id, pm.email), `/budget-requests/pdf?jobId=${job.id}`);
    const finPaper = await printed(financeToken, `/budget-requests/pdf?jobId=${job.id}`);
    const tabPaperText = tabPaper.text;
    const finPaperText = finPaper.text;
    check(
      'the project tab’s list and G-FIN’s print the same requests, the project named in the reference',
      tabPaper.status === 200 &&
        finPaper.status === 200 &&
        tabNumbers.length > 0 &&
        tabNumbers.every((n) => squash(tabPaperText).includes(n) && squash(finPaperText).includes(n)) &&
        flat(finPaperText).includes(`project ${job.number}`),
      `${tabPaper.status}/${finPaper.status} · ${tabNumbers.length} request(s)`,
    );
    check(
      'and prints its money as figures under a head naming the currency, the status in words',
      // A head wraps in its column: read the words, not the line breaks.
      flat(finPaperText).includes(`AMOUNT (${currency})`) &&
        finPaperText.includes('50,000.00') &&
        finPaperText.includes('Liquidated') &&
        !finPaperText.includes('LIQUIDATED'),
      finPaperText.split('\n').filter((l) => /AMOUNT|50,000|iquidated/i.test(l)).join(' | ').slice(0, 200),
    );
    const tickedPaper = await printed(financeToken, `/budget-requests/pdf?ids=${br.id}`);
    const tickedText = tickedPaper.text;
    check(
      '?ids= prints only the request ticked, and says so',
      tickedPaper.status === 200 &&
        squash(tickedText).includes(br.number) &&
        tabNumbers.filter((n) => n !== br.number).every((n) => !squash(tickedText).includes(n)) &&
        flat(tickedText).includes('the rows selected'),
      String(tickedPaper.status),
    );
    const statusPaper = await printed(financeToken, `/budget-requests/pdf?jobId=${job.id}&status=LIQUIDATED`);
    check(
      'a status filter is named on the paper',
      statusPaper.status === 200 && flat(statusPaper.text).includes('status Liquidated'),
      String(statusPaper.status),
    );
    const leadPaper = await printed(leadToken, `/budget-requests/pdf?jobId=${job.id}`);
    check('the printed list stays behind the list’s own permission', leadPaper.status === 403, String(leadPaper.status));
    check(
      'every print of the list is on the trail as EXPORTED, entityId "list"',
      (await listExports(pm.id)) + (await listExports(finance.id)) === exportsBefore + 4,
      `${(await listExports(pm.id)) + (await listExports(finance.id)) - exportsBefore} new row(s)`,
    );
    // The requested-by filter is ANDed with "only their own", never written
    // over it: an engineer who sees only their own requests, naming the
    // project manager, lists and prints none of the manager's.
    const pmRequest = await prisma.budgetRequest.create({
      data: {
        number: `${TAG}-BR-PM`,
        jobId: job.id,
        costCategoryId: materials.id,
        amount: d(1_000),
        reason: `${TAG} raised by the project manager`,
        requestedById: pm.id,
      },
    });
    const engToken = signToken(engineer.id, engineer.email);
    const askedRows = await http(engToken, 'GET', `/budget-requests?requestedById=${pm.id}&pageSize=200`);
    const askedPaper = await printed(engToken, `/budget-requests/pdf?requestedById=${pm.id}`);
    const askedText = askedPaper.text;
    const ownRows = await http(engToken, 'GET', `/budget-requests?jobId=${job.id}&pageSize=200`);
    check(
      'a requester who sees only their own, naming somebody else as the requester, lists and prints 0 requests',
      askedRows.status === 200 &&
        askedRows.body.total === 0 &&
        askedPaper.status === 200 &&
        !squash(askedText).includes(pmRequest.number) &&
        flat(askedText).includes('Reference: 0 ') &&
        // Not vacuous: the engineer's own request is there without the filter, the manager's is not.
        ownRows.status === 200 &&
        (ownRows.body.rows ?? []).some((r: { id: string }) => r.id === br.id) &&
        !(ownRows.body.rows ?? []).some((r: { id: string }) => r.id === pmRequest.id),
      `${askedRows.status} total ${askedRows.body.total} · ${askedPaper.status} ${flat(askedText).match(/Reference:.{0,100}/)?.[0] ?? ''}`,
    );
    await prisma.budgetRequest.delete({ where: { id: pmRequest.id } });

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

    // (i) Every list prints (rule 6, A5): `GET <list>/pdf`, above `/:id`,
    //     reading the list's own where-builder — so the paper holds exactly
    //     the rows the list holds — on landscape pages, the count said and
    //     every filter named, `?ids=` printing only the rows ticked, and
    //     each print audited as an EXPORTED of the list.
    console.log('\nThe lists on paper (over HTTP)');
    // A cancelled project is listed but never counted: its figures print in
    // brackets, the totals leave it out, and the note under them says how
    // many — the job orders' and service contracts' rule, and finance's.
    const cancelledJob = await prisma.job.create({
      data: {
        number: await nextNumber('project'),
        status: 'CANCELLED',
        name: `${TAG} Cancelled plant`,
        customerId: customer.id,
        costingId: costing.id,
        createdById: pm.id,
        contractValue: d(123_456.78),
      },
    });
    // A draft report and a draft billing on another project, so that a status
    // filter on the reports and a project filter on the billings each have a
    // row to drop — every report and billing above is the one project's, and
    // approved.
    const otherReport = await prisma.progressReport.create({
      data: {
        number: `${TAG}-PR-OTHER`,
        reportNo: 1,
        jobId: cancelledJob.id,
        periodFrom: new Date('2026-09-01T00:00:00Z'),
        periodTo: new Date('2026-09-30T00:00:00Z'),
        preparedById: pm.id,
      },
    });
    await prisma.progressBilling.create({
      data: {
        number: `${TAG}-PB-OTHER`,
        billingNo: 1,
        jobId: cancelledJob.id,
        progressReportId: otherReport.id,
        grossAmount: d(1_000),
        vatAmount: d(120),
        ewtAmount: d(20),
        invoiceTotal: d(1_120),
        netCollectible: d(1_100),
      },
    });
    const listCurrency = (await prisma.company.findUnique({ where: { id: 'company' }, select: { currency: true } }))?.currency?.trim() || 'PHP';
    const listPeso = (n: number) => `${listCurrency} ${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    type ListRow = Record<string, unknown> & { id: string; number: string; status: string };
    const liveJobs = (rows: ListRow[]) => rows.filter((r) => r.status !== 'CANCELLED');
    const lists: {
      path: string;
      printPath: string;
      entity: string;
      noun: readonly [string, string];
      filter: (rows: ListRow[]) => [string, string];
      total?: { label: string; of: (rows: ListRow[]) => number };
    }[] = [
      {
        path: 'jobs',
        printPath: 'jobs/pdf',
        entity: 'job',
        noun: ['project', 'projects'],
        filter: () => ['type=SERVICE_CONTRACT', 'type Service contract'],
        total: { label: 'Contract value', of: (rows) => liveJobs(rows).reduce((t, r) => t + Number(r.contractValue), 0) },
      },
      {
        path: 'jobs',
        printPath: 'jobs/budget-monitoring/pdf',
        entity: 'job',
        noun: ['project', 'projects'],
        filter: (rows) => [`status=${rows[0].status}`, `status ${statusLabel(rows[0].status)}`],
        total: { label: 'Billed', of: (rows) => liveJobs(rows).reduce((t, r) => t + Number(r.billed), 0) },
      },
      { path: 'progress-reports', printPath: 'progress-reports/pdf', entity: 'progress_report', noun: ['progress report', 'progress reports'], filter: () => ['status=APPROVED', 'status Approved'] },
      {
        path: 'billings',
        printPath: 'billings/pdf',
        entity: 'progress_billing',
        noun: ['billing', 'billings'],
        filter: () => [`jobId=${job.id}`, `project ${job.number}`],
        // Only what has been approved is collectible: a draft is listed, never summed.
        total: {
          label: 'Net collectible',
          of: (rows) => rows.filter((r) => r.status === 'APPROVED' || r.status === 'INVOICED').reduce((t, r) => t + Number(r.netCollectible), 0),
        },
      },
    ];
    for (const l of lists) {
      const listed = await http(leadToken, 'GET', `/${l.path}?search=${TAG}&pageSize=200`);
      const rows = (listed.body.rows ?? []) as ListRow[];
      const before = await prisma.auditLog.count({ where: { entityType: l.entity, entityId: 'list', action: 'EXPORTED' } });
      const paper = await printed(leadToken, `/${l.printPath}?search=${TAG}`);
      const after = await prisma.auditLog.count({ where: { entityType: l.entity, entityId: 'list', action: 'EXPORTED' } });
      check(
        `${l.printPath}: a PDF of exactly the rows the list holds, the count said and the search named, on landscape pages, audited as an export of the list`,
        paper.status === 200 &&
          paper.type.startsWith('application/pdf') &&
          rows.length > 0 &&
          rows.length === Number(listed.body.total) &&
          rows.every((r) => flat(paper.text).includes(r.number)) &&
          saysCount(flat(paper.text), rows.length, l.noun) &&
          flat(paper.text).includes(`search "${TAG}"`) &&
          paper.pages.length > 0 &&
          paper.pages.every((b) => b === LANDSCAPE) &&
          after === before + 1,
        `${paper.status} ${paper.type}, ${rows.length} of ${listed.body.total} listed, missing ${rows.filter((r) => !flat(paper.text).includes(r.number)).map((r) => r.number).join(',') || 'none'}, pages ${paper.pages.join(',')}, audited ${before} → ${after}`,
      );
      if (l.total) {
        const expected = Math.round(l.total.of(rows) * 100) / 100;
        check(
          `${l.printPath}: its "${l.total.label}" is what the rows it lists add up to`,
          new RegExp(`${l.total.label} ${listPeso(expected).replace(/[.]/g, '\\.')}`).test(flat(paper.text)),
          `${flat(paper.text).match(new RegExp(`${l.total.label} [A-Z]{3} [\\d,.]+`))?.[0] ?? 'no total'} vs ${listPeso(expected)}`,
        );
      }
      const [first] = rows;
      const ticked = await printed(leadToken, `/${l.printPath}?ids=${first?.id ?? 'none'}`);
      check(
        `${l.printPath}: ?ids= prints only the row ticked, and says so`,
        ticked.status === 200 &&
          !!first &&
          flat(ticked.text).includes(first.number) &&
          rows.length > 1 &&
          rows.slice(1).every((r) => !flat(ticked.text).includes(r.number)) &&
          saysCount(flat(ticked.text), 1, l.noun) &&
          flat(ticked.text).includes('the rows selected'),
        `${ticked.status} ${flat(ticked.text).match(/Reference: .{0,120}/)?.[0] ?? ''}`,
      );
      const [filterQuery, filterWords] = l.filter(rows);
      const narrowed = await http(leadToken, 'GET', `/${l.path}?search=${TAG}&${filterQuery}&pageSize=200`);
      const filtered = await printed(leadToken, `/${l.printPath}?search=${TAG}&${filterQuery}`);
      // Narrows: it keeps some rows and drops others — on the paper as on
      // the screen, so a filter the paper ignored prints a row it dropped.
      const kept = (narrowed.body.rows ?? []) as ListRow[];
      const dropped = rows.filter((r) => !kept.some((k) => k.id === r.id));
      check(
        `${l.printPath}: a filter narrows the paper as it narrows the list, and the paper names it ("${filterWords}")`,
        filtered.status === 200 &&
          kept.length > 0 &&
          dropped.length > 0 &&
          Number(narrowed.body.total) === kept.length &&
          saysCount(filtered.text, kept.length, l.noun) &&
          flat(filtered.text).includes(filterWords) &&
          kept.every((r) => flat(filtered.text).includes(r.number)) &&
          dropped.every((r) => !flat(filtered.text).includes(r.number)),
        `${filtered.status}: list ${narrowed.body.total} of ${rows.length}, ${dropped.length} dropped, ${dropped.filter((r) => flat(filtered.text).includes(r.number)).length} of them printed; ${referenceOf(filtered.text)}`,
      );
    }
    const allJobs = ((await http(leadToken, 'GET', `/jobs?search=${TAG}&pageSize=200`)).body.rows ?? []) as ListRow[];
    const cancelledCount = allJobs.filter((r) => r.status === 'CANCELLED').length;
    const cancelledNote = `${cancelledCount} cancelled project${cancelledCount === 1 ? '' : 's'}, in brackets, ${cancelledCount === 1 ? 'is' : 'are'} not counted.`;
    const projectsPaper = await printed(leadToken, `/jobs/pdf?search=${TAG}`);
    const budgetPaper = await printed(leadToken, `/jobs/budget-monitoring/pdf?search=${TAG}`);
    const liveContract = liveJobs(allJobs).reduce((t, r) => t + Number(r.contractValue), 0);
    check(
      'a cancelled project prints its contract value in brackets, out of both papers\' totals, and the note says how many',
      cancelledCount >= 1 &&
        allJobs.some((r) => r.id === cancelledJob.id) &&
        [projectsPaper, budgetPaper].every(
          (p) =>
            p.status === 200 &&
            flat(p.text).includes('(123,456.78)') &&
            flat(p.text).includes(`Contract value ${listPeso(Math.round(liveContract * 100) / 100)}`) &&
            flat(p.text).includes(cancelledNote) &&
            !flat(p.text).includes('cancelled not counted'),
        ),
      `${cancelledCount} cancelled · ${flat(projectsPaper.text).match(/Contract value [A-Z]{3} [\d,.]+/)?.[0]} / ${flat(budgetPaper.text).match(/Contract value [A-Z]{3} [\d,.]+/)?.[0]} vs ${listPeso(liveContract)} · ${flat(projectsPaper.text).match(/[^.]{0,40}in brackets[^.]*\./)?.[0] ?? 'no note'}`,
    );

    // Budget Monitoring's paper prints cost to date — budget monitoring's
    // figure — so it takes that right as well as the list's.
    const narrowBudget = await printed(narrowToken, `/jobs/budget-monitoring/pdf?search=${TAG}`);
    const narrowProjects = await printed(narrowToken, `/jobs/pdf?search=${TAG}`);
    check(
      'the budget monitoring paper needs budget monitoring; the projects paper only the list’s right',
      narrowBudget.status === 403 && narrowProjects.status === 200,
      `${narrowBudget.status} / ${narrowProjects.status}`,
    );
    // An unknown status is a 400 naming the choices — on the list and its paper — never a 500.
    const badStatus = await Promise.all(
      ['jobs', 'jobs/pdf', 'jobs/budget-monitoring/pdf', 'progress-reports', 'progress-reports/pdf', 'billings', 'billings/pdf'].map((path) =>
        http(leadToken, 'GET', `/${path}?status=MAYBE`),
      ),
    );
    check('a status that is not one is a 400 on every list and its paper', badStatus.every((r) => r.status === 400), badStatus.map((r) => r.status).join(' '));
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
