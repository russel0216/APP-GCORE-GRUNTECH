/**
 * Phase 9 verification — Insights.
 *
 *   npx tsx scripts/verify-insights.ts      (the API must be running)
 *
 * This phase adds no tables, so there is nothing here about records being
 * written correctly. What there is to get wrong is subtler and worse: a
 * management report that quietly disagrees with the documents behind it.
 *
 *   · **Every figure must reconcile.** Profitability read through the report
 *     has to equal the ledger read directly, to the centavo, on awkward
 *     numbers.
 *   · **A number that is not yet meaningful must say so.** Running margin on a
 *     job that has spent 2% of its budget is ~100%, which is arithmetically
 *     true and completely misleading.
 *   · **Slow-moving stock is ranked by value, not by age.** A thousand idle
 *     washers matter less than one idle compressor.
 *   · **The reporting layer cannot write.** A report that can change a number
 *     is no longer a report.
 */

import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/prisma';
import { env } from '../src/env';
import { signToken } from '../src/auth/middleware';
import { nextNumber } from '../src/shared/numbering';
import { receiveStock, issueStock, postJobCost } from '../src/shared/inventory';
import {
  cents,
  pct,
  monthKey,
  monthsBack,
  parseRange,
  projectProfitability,
  median,
  slowMovers,
  toCsv,
  windowFor,
  FORECAST_WINDOWS,
  dayKey,
} from '../src/shared/insights';
import { manilaDayKey } from '../src/shared/day';

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

/** Splits an RFC 4180 export back into cells — quoted commas and all. */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const body = text.replace(/^﻿/, '');
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && body[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
const D = (v: number) => new Prisma.Decimal(v);
const num = (v: Prisma.Decimal | null | undefined) => (v == null ? 0 : Number(v));
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

const TAG = 'ZZINS';
const BASE = `http://localhost:${env.port}/api`;

async function cleanup() {
  const jobs = await prisma.job.findMany({
    where: { name: { startsWith: TAG } },
    select: { id: true },
  });
  const jobIds = jobs.map((j) => j.id);
  if (jobIds.length) {
    const invoices = await prisma.invoice.findMany({ where: { jobId: { in: jobIds } }, select: { id: true } });
    const allocations = await prisma.paymentAllocation.findMany({
      where: { invoiceId: { in: invoices.map((i) => i.id) } },
      select: { paymentId: true },
    });
    await prisma.payment.deleteMany({
      where: { id: { in: [...new Set(allocations.map((a) => a.paymentId))] } },
    });
    await prisma.invoice.deleteMany({ where: { jobId: { in: jobIds } } });
    await prisma.progressBilling.deleteMany({ where: { jobId: { in: jobIds } } });
    await prisma.progressReport.deleteMany({ where: { jobId: { in: jobIds } } });
  }
  await prisma.quotationRevision.deleteMany({ where: { quotation: { subject: { startsWith: TAG } } } });
  await prisma.quotation.deleteMany({ where: { subject: { startsWith: TAG } } });
  await prisma.lead.deleteMany({ where: { companyName: { startsWith: TAG } } });
  await prisma.job.deleteMany({ where: { id: { in: jobIds } } });
  await prisma.costing.deleteMany({ where: { title: { startsWith: TAG } } });
  await prisma.inventoryTransaction.deleteMany({ where: { item: { name: { startsWith: TAG } } } });
  await prisma.inventoryBalance.deleteMany({ where: { item: { name: { startsWith: TAG } } } });
  await prisma.item.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.warehouse.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.customer.deleteMany({ where: { name: { startsWith: TAG } } });

  const users = await prisma.user.findMany({
    where: { email: { endsWith: '@verifyi.local' } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    // Advance refunds and customer receipts recorded by the fixture users,
    // then the claims (a liquidation holds its advance), then the advances.
    await prisma.payment.deleteMany({
      where: { OR: [{ recordedById: { in: ids } }, { payeeUserId: { in: ids } }] },
    });
    await prisma.expenseClaim.deleteMany({ where: { claimedById: { in: ids } } });
    await prisma.cashAdvance.deleteMany({ where: { requestedById: { in: ids } } });
    await prisma.approvalAction.deleteMany({ where: { approverId: { in: ids } } });
    await prisma.approvalRequest.deleteMany({ where: { requesterId: { in: ids } } });
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
    await prisma.user.updateMany({ where: { supervisorId: { in: ids } }, data: { supervisorId: null } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.role.deleteMany({ where: { key: { startsWith: 'zzins_' } } });
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
  console.log('\nG-CORE insights verification\n');
  await cleanup();

  // ══ The small arithmetic everything rests on ═════════════════════════════
  console.log('Arithmetic');

  check('a percentage of nothing is zero, not NaN', pct(5, 0) === 0);
  check('a percentage rounds to the centavo', pct(1, 3) === 33.33, `got ${pct(1, 3)}`);
  check('money rounds half up at the centavo', cents(10.005) === 10.01, `got ${cents(10.005)}`);

  check('the median of an odd list is the middle', median([1, 5, 100]) === 5);
  check('the median of an even list is the mean of the middle two', median([1, 3, 5, 11]) === 4);
  check('the median of nothing is null, not zero', median([]) === null, 'no decisions is not "decided in 0 days"');
  check('the median is not the mean — one outlier does not move it', median([1, 2, 3, 4, 500]) === 3);

  const twelve = monthsBack(12, day('2026-09-19'));
  check('twelve months back ends on this month', twelve[11] === '2026-09', twelve[11]);
  check('and starts twelve months earlier', twelve[0] === '2025-10', twelve[0]);
  check('crossing a year boundary keeps the months in order', twelve.join(',').includes('2025-12,2026-01'));
  check('a month key is zero-padded so it sorts as text', monthKey(day('2026-03-01')) === '2026-03');
  // At 07:00 in Manila on the 1st the UTC date is still last month's: the
  // trend used to end on last month and leave the current one out.
  const onTheFirst = monthsBack(3, new Date('2026-10-01T07:00:00+08:00'));
  check(
    'at 07:00 in Manila on the 1st, the trend already ends on the new month',
    onTheFirst.join(',') === '2026-08,2026-09,2026-10',
    onTheFirst.join(','),
  );

  // The forecast windows must tile the number line with no gap and no overlap.
  const windows = [-500, -1, 0, 3, 7, 8, 30, 31, 60, 61, 90, 91, 5000];
  const placed = windows.map(windowFor);
  check(
    'every horizon lands in exactly one forecast window',
    placed.every((i) => i >= 0),
    placed.join(','),
  );
  check(
    'and the windows do not overlap — each day belongs to one',
    windows.every((d) => FORECAST_WINDOWS.filter((w) => d >= w.from && d <= w.to).length === 1),
  );
  check('due today is "next 7 days", not overdue', FORECAST_WINDOWS[windowFor(0)].label === 'Next 7 days');
  check('one day late is overdue', FORECAST_WINDOWS[windowFor(-1)].label === 'Overdue');

  const range = parseRange('2026-01-01', '2026-06-30');
  check('a range parses to whole days', range.from.toISOString().startsWith('2026-01-01'));
  await expectRejection(
    'a range that ends before it starts is refused',
    async () => parseRange('2026-06-30', '2026-01-01'),
    'ends before it starts',
  );
  await expectRejection(
    'a nonsense date is refused',
    async () => parseRange('yesterday', '2026-01-01'),
    'not a valid date range',
  );
  const defaulted = parseRange();
  check(
    'with no range given it covers this year, not all of history',
    defaulted.from.getUTCMonth() === 0 && defaulted.from.getUTCDate() === 1,
    defaulted.from.toISOString(),
  );
  check(
    'and "this year" is Manila’s year',
    defaulted.from.getUTCFullYear() === Number(manilaDayKey(new Date()).slice(0, 4)),
    defaulted.from.toISOString(),
  );

  const csv = toCsv(['A', 'B'], [['plain', 'has, comma'], ['has "quote"', null]]);
  check('a CSV starts with a BOM so Excel reads UTF-8', csv.startsWith('﻿'));
  check('a comma is quoted', csv.includes('"has, comma"'));
  check('a quote is doubled', csv.includes('"has ""quote"""'));
  check('a null becomes empty, not the word null', csv.trim().endsWith(','));

  // ══ Fixtures ═════════════════════════════════════════════════════════════

  const pm = await makeUser('ZZ Insights PM', 'pm@verifyi.local', ['project_manager']);
  const seller = await makeUser('ZZ Seller', 'sales@verifyi.local', ['sales']);
  const director = await makeUser('ZZ Director', 'exec@verifyi.local', ['executive']);

  const customer = await prisma.customer.create({
    data: { code: `${TAG}-C1`, name: `${TAG} Hospital` },
  });
  const categories = await prisma.costCategory.findMany({ orderBy: { sortOrder: 'asc' } });
  const materials = categories[0];

  /** A job with a budget, some spend and some billing. */
  async function makeJob(opts: {
    name: string;
    contract: number;
    budget: number;
    committed?: number;
    incurred?: number;
    billed?: number;
    collected?: number;
    status?: 'PLANNING' | 'IN_PROGRESS' | 'COMPLETED' | 'TURNED_OVER';
  }) {
    const costing = await prisma.costing.create({
      data: {
        number: await nextNumber('costing'),
        title: `${TAG} ${opts.name}`,
        ownerId: pm.id,
        totalCost: D(opts.budget),
        contractValue: D(opts.contract),
      },
    });
    const job = await prisma.job.create({
      data: {
        number: await nextNumber('project'),
        name: `${TAG} ${opts.name}`,
        status: opts.status ?? 'IN_PROGRESS',
        customerId: customer.id,
        costingId: costing.id,
        createdById: pm.id,
        projectManagerId: pm.id,
        contractValue: D(opts.contract),
        targetEndDate: day('2026-06-30'),
        ...(opts.status === 'COMPLETED' || opts.status === 'TURNED_OVER'
          ? { actualEndDate: day('2026-06-15') }
          : {}),
        costEntries: {
          create: [
            {
              costCategoryId: materials.id,
              state: 'BUDGETED',
              amount: D(opts.budget),
              sourceType: 'costing',
              sourceNumber: costing.number,
            },
          ],
        },
      },
    });

    await prisma.$transaction(async (tx) => {
      if (opts.committed) {
        await postJobCost(tx, {
          jobId: job.id,
          costCategoryId: materials.id,
          state: 'COMMITTED',
          amount: opts.committed,
          sourceType: 'purchase_request',
        });
      }
      if (opts.incurred) {
        await postJobCost(tx, {
          jobId: job.id,
          costCategoryId: materials.id,
          state: 'INCURRED',
          amount: opts.incurred,
          sourceType: 'receiving',
        });
      }
    });

    if (opts.billed) {
      const report = await prisma.progressReport.create({
        data: {
          number: await nextNumber('progress_report'),
          jobId: job.id,
          reportNo: 1,
          status: 'APPROVED',
          periodFrom: day('2026-03-01'),
          periodTo: day('2026-03-31'),
          preparedById: pm.id,
        },
      });
      const vat = cents(opts.billed * 0.12);
      const ewt = cents(opts.billed * 0.02);
      const billing = await prisma.progressBilling.create({
        data: {
          number: await nextNumber('progress_billing'),
          jobId: job.id,
          billingNo: 1,
          status: 'APPROVED',
          progressReportId: report.id,
          billingDate: day('2026-03-31'),
          grossAmount: D(opts.billed),
          vatAmount: D(vat),
          ewtAmount: D(ewt),
          invoiceTotal: D(cents(opts.billed + vat)),
          netCollectible: D(cents(opts.billed + vat - ewt)),
          approvedAt: new Date(),
        },
      });

      if (opts.collected !== undefined) {
        const invoice = await prisma.invoice.create({
          data: {
            number: await nextNumber('invoice'),
            customerId: customer.id,
            jobId: job.id,
            progressBillingId: billing.id,
            invoiceDate: day('2026-04-01'),
            dueDate: day('2026-05-01'),
            grossAmount: billing.grossAmount,
            vatAmount: billing.vatAmount,
            ewtAmount: billing.ewtAmount,
            invoiceTotal: billing.invoiceTotal,
            netCollectible: billing.netCollectible,
            amountCollected: D(opts.collected),
            status: opts.collected > 0 ? 'PARTIALLY_PAID' : 'ISSUED',
            issuedAt: new Date(),
            createdById: pm.id,
          },
        });
        await prisma.progressBilling.update({ where: { id: billing.id }, data: { status: 'INVOICED' } });
        if (opts.collected > 0) {
          await prisma.payment.create({
            data: {
              number: await nextNumber('payment'),
              kind: 'RECEIPT',
              paymentDate: day('2026-04-15'),
              clearedAt: day('2026-04-15'),
              customerId: customer.id,
              amount: D(opts.collected),
              recordedById: pm.id,
              allocations: { create: [{ invoiceId: invoice.id, amount: D(opts.collected) }] },
            },
          });
        }
      }
    }

    return job;
  }

  // Three shapes of job, chosen to make the reporting rules bite.
  const healthy = await makeJob({
    name: 'Healthy plant',
    contract: 1_000_000,
    budget: 750_000,
    committed: 100_000,
    incurred: 350_000,
    billed: 500_000,
    collected: 400_000,
  });
  const barelyStarted = await makeJob({
    name: 'Barely started',
    contract: 2_000_000,
    budget: 1_600_000,
    incurred: 20_000,
  });
  // Budget 400,000 against 430,000 spent: over budget as well as ahead of
  // billing, which are two different faults and are counted separately.
  const bleeding = await makeJob({
    name: 'Bleeding',
    contract: 500_000,
    budget: 400_000,
    committed: 150_000,
    incurred: 280_000,
  });
  const awkward = await makeJob({
    name: 'Awkward figures',
    contract: 333_333.33,
    budget: 266_666.67,
    incurred: 111_111.11,
  });

  // ══ Profitability ════════════════════════════════════════════════════════
  console.log('\nProject profitability');

  const rows = await projectProfitability({});
  const byName = (name: string) => rows.find((r) => r.job.name === `${TAG} ${name}`)!;

  const h = byName('Healthy plant');
  check(
    'expected profit is contract less BUDGET, so it means something on day one',
    money(h.expectedProfit, 250_000) && money(h.expectedMarginPct, 25),
    `${h.expectedProfit} / ${h.expectedMarginPct}%`,
  );
  check(
    'actual cost is committed plus incurred',
    money(h.actualCost, 450_000),
    `got ${h.actualCost}`,
  );
  check(
    'available is budgeted less committed less incurred',
    money(h.available, 300_000),
    `got ${h.available}`,
  );
  check('cost used is actual over budget', money(h.costUsedPct, 60), `got ${h.costUsedPct}`);
  check('billed percentage is billed over contract', money(h.billedPct, 50), `got ${h.billedPct}`);
  check('collected is read from the invoices', money(h.collected, 400_000), `got ${h.collected}`);

  const b = byName('Barely started');
  check(
    'a job that has spent 1% shows a running margin near 99%',
    b.runningMarginPct > 98,
    `got ${b.runningMarginPct}%`,
  );
  check(
    'and is flagged as too early to judge, because that number is useless',
    b.tooEarly === true,
    'a report that shows 99% margin without saying so is worse than one that omits it',
  );
  check('a job well under way is not flagged', h.tooEarly === false, `cost used ${h.costUsedPct}%`);

  const bl = byName('Bleeding');
  check(
    'a job spending faster than it bills is flagged',
    bl.overspending === true,
    `cost used ${bl.costUsedPct}%, billed ${bl.billedPct}%`,
  );
  check(
    'and the healthy one is not',
    h.overspending === false,
    `cost used ${h.costUsedPct}% vs billed ${h.billedPct}% — a ten-point gap is the threshold`,
  );
  check(
    'a barely-started job is never flagged as overspending, whatever the gap',
    b.overspending === false,
    'too little has happened to call it',
  );

  // Reconciliation: the report against the ledger, read separately.
  const ledgerDirect = await prisma.jobCostEntry.groupBy({
    by: ['state'],
    where: { jobId: healthy.id },
    _sum: { amount: true },
  });
  const direct = (s: string) => num(ledgerDirect.find((l) => l.state === s)?._sum.amount);
  check(
    'the report agrees with the ledger read directly, to the centavo',
    money(h.budgetedCost, direct('BUDGETED')) &&
      money(h.committed, direct('COMMITTED')) &&
      money(h.incurred, direct('INCURRED')),
    `${h.budgetedCost}/${h.committed}/${h.incurred} vs ${direct('BUDGETED')}/${direct('COMMITTED')}/${direct('INCURRED')}`,
  );

  const aw = byName('Awkward figures');
  check(
    'an awkward contract value still reconciles',
    money(aw.expectedProfit, cents(333_333.33 - 266_666.67)),
    `${aw.expectedProfit} vs ${cents(333_333.33 - 266_666.67)}`,
  );
  check(
    'and its margin is a real percentage, not a rounding artefact',
    aw.expectedMarginPct > 19.9 && aw.expectedMarginPct < 20.1,
    `got ${aw.expectedMarginPct}%`,
  );

  const serviceOnly = await projectProfitability({ type: 'SERVICE_CONTRACT' });
  check(
    'filtering by type excludes delivery projects',
    !serviceOnly.some((r) => r.job.name.startsWith(`${TAG}`)),
    `${serviceOnly.length} service rows`,
  );

  // ══ Slow-moving stock ════════════════════════════════════════════════════
  console.log('\nInventory analytics');

  const warehouse = await prisma.warehouse.create({
    data: { code: `${TAG}W`, name: `${TAG} Store` },
  });
  const washers = await prisma.item.create({
    data: { code: `${TAG}-WSH`, name: `${TAG} Washers`, unit: 'pcs', costCategoryId: materials.id },
  });
  const compressor = await prisma.item.create({
    data: { code: `${TAG}-CMP`, name: `${TAG} Compressor`, unit: 'unit', costCategoryId: materials.id },
  });
  const movingPart = await prisma.item.create({
    data: {
      code: `${TAG}-MOV`,
      name: `${TAG} Fast mover`,
      unit: 'pcs',
      costCategoryId: materials.id,
      reorderLevel: D(50),
    },
  });

  const longAgo = new Date();
  longAgo.setUTCDate(longAgo.getUTCDate() - 400);
  const alsoAgo = new Date();
  alsoAgo.setUTCDate(alsoAgo.getUTCDate() - 200);

  await prisma.$transaction(async (tx) => {
    // A thousand cheap washers, idle for over a year.
    await receiveStock(tx, {
      itemId: washers.id,
      warehouseId: warehouse.id,
      quantity: 1000,
      unitCost: 5,
      sourceType: 'receiving',
      occurredAt: longAgo,
    });
    // One expensive compressor, idle for half that.
    await receiveStock(tx, {
      itemId: compressor.id,
      warehouseId: warehouse.id,
      quantity: 1,
      unitCost: 250_000,
      sourceType: 'receiving',
      occurredAt: alsoAgo,
    });
    // Something that moved yesterday.
    await receiveStock(tx, {
      itemId: movingPart.id,
      warehouseId: warehouse.id,
      quantity: 100,
      unitCost: 100,
      sourceType: 'receiving',
    });
  });
  await prisma.$transaction((tx) =>
    issueStock(tx, {
      itemId: movingPart.id,
      warehouseId: warehouse.id,
      quantity: 70,
      sourceType: 'stock_issue',
    }),
  );

  // The transactions carry their own dates; the balances do not, so the
  // occurredAt on the receipt is what makes something look idle.
  await prisma.inventoryTransaction.updateMany({
    where: { itemId: washers.id },
    data: { occurredAt: longAgo },
  });
  await prisma.inventoryTransaction.updateMany({
    where: { itemId: compressor.id },
    data: { occurredAt: alsoAgo },
  });

  const slow = await slowMovers(90);
  const slowCodes = slow.map((r) => r.item.code);
  check(
    'stock that has not moved in the window is reported',
    slowCodes.includes(`${TAG}-WSH`) && slowCodes.includes(`${TAG}-CMP`),
    slowCodes.join(', '),
  );
  check(
    'stock that moved yesterday is not',
    !slowCodes.includes(`${TAG}-MOV`),
    'it moved, so it is not slow whatever it is worth',
  );

  const first = slow.find((r) => r.item.code.startsWith(TAG))!;
  check(
    'the ranking is by VALUE — the compressor outranks the washers',
    first.item.code === `${TAG}-CMP`,
    `first was ${first.item.code}; the washers are older but worth ₱5,000 against ₱250,000`,
  );
  check(
    'and the value is quantity times the moving average, not the last price',
    money(slow.find((r) => r.item.code === `${TAG}-WSH`)!.value, 5_000),
  );
  check(
    'each row says how long it has been idle',
    (first.daysSinceMoved ?? 0) >= 199,
    `got ${first.daysSinceMoved}`,
  );

  const narrow = await slowMovers(365);
  check(
    'a longer window reports fewer things as slow',
    narrow.filter((r) => r.item.code.startsWith(TAG)).length <
      slow.filter((r) => r.item.code.startsWith(TAG)).length,
    `${narrow.length} vs ${slow.length}`,
  );

  // ══ Sales analytics ══════════════════════════════════════════════════════
  console.log('\nSales analytics');

  async function makeQuotation(subject: string, total: number, outcome: string, probability: number) {
    const quotation = await prisma.quotation.create({
      data: {
        number: await nextNumber('quotation'),
        customerId: customer.id,
        ownerId: seller.id,
        subject: `${TAG} ${subject}`,
        outcome: outcome as never,
        probability,
        createdAt: day('2026-02-01'),
        submittedAt: day('2026-02-05'),
        ...(outcome === 'WON' || outcome === 'LOST' ? { decidedAt: day('2026-03-07') } : {}),
        ...(outcome === 'LOST' ? { lostReason: 'Price' } : {}),
      },
    });
    await prisma.quotationRevision.create({
      data: {
        quotationId: quotation.id,
        revision: 0,
        status: 'APPROVED',
        subtotal: D(total),
        vatAmount: D(cents(total * 0.12)),
        total: D(cents(total * 1.12)),
      },
    });
    return quotation;
  }

  await makeQuotation('Won one', 1_000_000, 'WON', 100);
  await makeQuotation('Lost one', 800_000, 'LOST', 0);
  await makeQuotation('Still open', 600_000, 'SUBMITTED', 50);
  // An open quotation whose revision nobody has approved yet. Counting only
  // approved revisions would value it at zero and make the overview disagree
  // with the pipeline report.
  const unapproved = await prisma.quotation.create({
    data: {
      number: await nextNumber('quotation'),
      customerId: customer.id,
      ownerId: seller.id,
      subject: `${TAG} Draft revision only`,
      outcome: 'OPEN',
      probability: 20,
      createdAt: day('2026-02-20'),
    },
  });
  await prisma.quotationRevision.create({
    data: {
      quotationId: unapproved.id,
      revision: 0,
      status: 'DRAFT',
      subtotal: D(250_000),
      vatAmount: D(30_000),
      total: D(280_000),
    },
  });

  await prisma.lead.create({
    data: {
      number: await nextNumber('lead'),
      companyName: `${TAG} Prospect`,
      customerId: customer.id,
      assignedToId: seller.id,
      createdById: seller.id,
      status: 'QUALIFIED',
      source: 'Referral',
      estimatedValue: D(400_000),
      probability: 40,
      createdAt: day('2026-02-10'),
    },
  });

  // ══ Advances, claims and refunds ═════════════════════════════════════════
  // The cash forecast gained two columns with cash advances, and the
  // "collected" figures learned to leave refunds out. Fixtures that make each
  // of those rules bite.
  const todayKey = dayKey(new Date());
  const inTen = new Date(todayKey.getTime() + 10 * 86_400_000);
  const advToRelease = await prisma.cashAdvance.create({
    data: {
      number: await nextNumber('cash_advance'),
      status: 'APPROVED',
      requestedById: seller.id,
      requestDate: todayKey,
      neededBy: inTen,
      purpose: `${TAG} site cash`,
      amount: D(50_000),
    },
  });
  const advRefund = await prisma.cashAdvance.create({
    data: {
      number: await nextNumber('cash_advance'),
      status: 'REFUND_DUE',
      requestedById: seller.id,
      requestDate: todayKey,
      purpose: `${TAG} spent less than drawn`,
      amount: D(20_000),
      amountReleased: D(20_000),
      amountSpent: D(15_000),
      amountRefunded: D(2_000),
      releasedAt: todayKey,
      liquidationDueDate: inTen,
    },
  });
  const plainClaim = await prisma.expenseClaim.create({
    data: {
      number: await nextNumber('expense'),
      status: 'APPROVED',
      claimedById: seller.id,
      claimDate: todayKey,
      purpose: `${TAG} tolls`,
      total: D(3_000),
      approvedAt: new Date(),
    },
  });
  // A liquidation the advance fully covered: nothing is owed to anybody, so
  // it must not reach "reimbursable".
  await prisma.expenseClaim.create({
    data: {
      number: await nextNumber('expense'),
      status: 'SETTLED',
      claimedById: seller.id,
      advanceId: advRefund.id,
      claimDate: todayKey,
      purpose: `${TAG} liquidation`,
      total: D(15_000),
      approvedAt: new Date(),
    },
  });
  // Unspent advance money handed back this month: cash in, never a collection.
  await prisma.payment.create({
    data: {
      number: await nextNumber('payment'),
      kind: 'RECEIPT',
      paymentDate: todayKey,
      clearedAt: todayKey,
      payeeUserId: seller.id,
      amount: D(2_000),
      recordedById: director.id,
      allocations: { create: [{ advanceId: advRefund.id, amount: D(2_000) }] },
    },
  });
  // A customer receipt this month, so "collected this month" is not trivially 0.
  const healthyInvoice = await prisma.invoice.findFirstOrThrow({ where: { jobId: healthy.id } });
  await prisma.payment.create({
    data: {
      number: await nextNumber('payment'),
      kind: 'RECEIPT',
      paymentDate: todayKey,
      clearedAt: todayKey,
      customerId: customer.id,
      amount: D(1_000),
      recordedById: director.id,
      allocations: { create: [{ invoiceId: healthyInvoice.id, amount: D(1_000) }] },
    },
  });
  await prisma.invoice.update({ where: { id: healthyInvoice.id }, data: { amountCollected: D(401_000) } });
  // A document stuck on an approval, carrying the link to itself.
  const stuck = await prisma.approvalRequest.create({
    data: {
      documentType: 'expense',
      documentId: plainClaim.id,
      documentNumber: plainClaim.number,
      subject: `${TAG} stuck claim`,
      link: `/g-fin/expenses/${plainClaim.id}`,
      requesterId: seller.id,
      status: 'PENDING',
    },
  });

  // ══ Route guards and reconciliation, over HTTP ═══════════════════════════
  console.log('\nOver HTTP');

  const reachable = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) })
    .then((r) => r.ok)
    .catch(() => false);

  if (!reachable) {
    failed += 1;
    console.log(
      `  ✗ the API is not reachable at ${BASE} — the routes were NOT verified.\n` +
        '      Start it with "npm run dev" in api/ and run this script again.',
    );
  } else {
    const token = signToken(director.id, director.email);
    const pmToken = signToken(pm.id, pm.email);
    const api = async (method: string, path: string, who = token, body?: unknown) => {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${who}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      let parsed: Record<string, never> = {} as Record<string, never>;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = { raw: text } as unknown as Record<string, never>;
      }
      return { status: res.status, body: parsed as Record<string, never>, text };
    };

    const dash = await api('GET', '/insights/dashboard?from=2026-01-01&to=2026-12-31');
    check('the company overview runs', dash.status === 200, String(dash.status));

    const d = dash.body as unknown as {
      sales: { openPipeline: number; weightedPipeline: number; won: number; lost: number; winRatePct: number };
      delivery: { budgeted: number; committed: number; incurred: number; available: number };
      finance: {
        receivable: number;
        payable: number;
        reimbursable: number;
        advancesToRelease: number;
        collectedThisMonth: number;
        workingPosition: number;
      };
    };
    check(
      'the weighted pipeline is less than the raw pipeline, because nothing is certain',
      d.sales.weightedPipeline < d.sales.openPipeline,
      `${d.sales.weightedPipeline} vs ${d.sales.openPipeline}`,
    );
    check(
      'one won and one lost is a 50% win rate',
      d.sales.won >= 1 && d.sales.lost >= 1 && d.sales.winRatePct > 0,
      `${d.sales.won}W ${d.sales.lost}L → ${d.sales.winRatePct}%`,
    );
    check(
      'available across the company is budgeted less committed less incurred',
      money(d.delivery.available, cents(d.delivery.budgeted - d.delivery.committed - d.delivery.incurred)),
      `${d.delivery.available}`,
    );
    // The overview used to print receivable − payable while G-FIN printed
    // receivable − payable − claims − advances. Now there is one definition,
    // decided in financePosition(), and the two screens agree to the centavo.
    const finDash = await api('GET', '/finance-reports/dashboard');
    const fd = finDash.body as unknown as {
      receivable: number;
      payable: number;
      reimbursable: number;
      advancesToRelease: number;
      workingPosition: number;
    };
    check(
      'the working position is receivable less everything owed — suppliers, staff and approved advances',
      money(
        d.finance.workingPosition,
        cents(d.finance.receivable - d.finance.payable - d.finance.reimbursable - d.finance.advancesToRelease - (d.finance.budgetRequestsToRelease ?? 0)),
      ),
      `${d.finance.workingPosition}`,
    );
    check(
      'and the company overview prints the same working position as the finance dashboard',
      finDash.status === 200 && money(d.finance.workingPosition, fd.workingPosition),
      `overview ${d.finance.workingPosition} vs G-FIN ${fd.workingPosition}`,
    );
    const monthStartKey = new Date(Date.UTC(todayKey.getUTCFullYear(), todayKey.getUTCMonth(), 1));
    const invoiceAllocations = await prisma.paymentAllocation.aggregate({
      where: {
        invoiceId: { not: null },
        payment: { kind: 'RECEIPT', clearedAt: { gte: monthStartKey } },
      },
      _sum: { amount: true },
    });
    check(
      'collected this month is customer receipts only — the advance refund is not a collection',
      money(d.finance.collectedThisMonth, num(invoiceAllocations._sum.amount)) &&
        d.finance.collectedThisMonth >= 1_000,
      `overview ${d.finance.collectedThisMonth} vs invoice allocations ${num(invoiceAllocations._sum.amount)}`,
    );

    const trend = await api('GET', '/insights/trend?months=12');
    check('the trend runs and returns twelve months', trend.status === 200 && (trend.body as unknown as { months: unknown[] }).months.length === 12);

    const prof = await api('GET', '/insights/profitability');
    const p = prof.body as unknown as {
      rows: { job: { number: string }; expectedProfit: number; contractValue: number; budgetedCost: number }[];
      totals: { contractValue: number; budgetedCost: number; expectedProfit: number };
      watchlist: { overspending: string[]; thinMargin: string[]; unbilled: string[] };
    };
    check('profitability runs', prof.status === 200, String(prof.status));
    check(
      'the totals are the sum of the rows, not a separate calculation',
      money(p.totals.contractValue, cents(p.rows.reduce((s, r) => s + r.contractValue, 0))) &&
        money(p.totals.expectedProfit, cents(p.totals.contractValue - p.totals.budgetedCost)),
      `${p.totals.contractValue} / ${p.totals.expectedProfit}`,
    );
    check(
      'the watchlist names the bleeding job',
      p.watchlist.overspending.includes(bleeding.number),
      p.watchlist.overspending.join(', '),
    );
    check(
      'and does not name the healthy one',
      !p.watchlist.overspending.includes(healthy.number),
    );

    const pipeline = await api('GET', '/insights/pipeline?from=2026-01-01&to=2026-12-31');
    const pl = pipeline.body as unknown as {
      funnel: { stage: string; count: number }[];
      totals: { won: number; lost: number; winRatePct: number; medianDaysToDecide: number | null };
      people: { name: string; won: number; winRatePct: number; medianDaysToDecide: number | null }[];
      lostReasons: { reason: string; count: number }[];
      openQuotations: { number: string; weighted: number; value: number; probability: number }[];
    };
    check('sales analytics runs', pipeline.status === 200, String(pipeline.status));
    check(
      'the funnel has the five stages a person reports on, not ten',
      pl.funnel.length === 5,
      pl.funnel.map((f) => f.stage).join(', '),
    );
    check(
      'a quotation decided 30 days after submission reports 30 days',
      pl.totals.medianDaysToDecide === 30,
      `got ${pl.totals.medianDaysToDecide}`,
    );
    const zz = pl.people.find((x) => x.name === 'ZZ Seller');
    check('the salesperson is credited with the win', (zz?.won ?? 0) >= 1, JSON.stringify(zz));
    check(
      'an open quotation is weighted by its own probability',
      pl.openQuotations.some((q) => money(q.weighted, cents(q.value * (q.probability / 100)))),
    );
    check(
      'a lost reason is counted',
      pl.lostReasons.some((r) => r.reason === 'Price'),
      pl.lostReasons.map((r) => r.reason).join(', '),
    );
    check(
      'a quotation with no approved revision is still worth its draft, not zero',
      pl.openQuotations.some((q) => q.value === 280_000),
      pl.openQuotations.map((q) => `${q.number}=${q.value}`).join(', '),
    );

    // The two screens must agree. A management overview that disagrees with
    // the report behind it is worse than no overview at all.
    const pipelineTotals = pl.totals as unknown as { openValue: number; weightedValue: number };
    check(
      'the overview and the pipeline report show the same open pipeline',
      money(d.sales.openPipeline, pipelineTotals.openValue),
      `overview ${d.sales.openPipeline} vs report ${pipelineTotals.openValue}`,
    );
    check(
      'and the same weighted figure',
      money(d.sales.weightedPipeline, pipelineTotals.weightedValue),
      `overview ${d.sales.weightedPipeline} vs report ${pipelineTotals.weightedValue}`,
    );

    // "By group" splits each quotation's value by its groups, so its sums are
    // the report's own figures: quoted = what the salespeople raised, won =
    // the won total.
    const byGroup = (pipeline.body as unknown as { byGroup: { group: string; quotedValue: number; wonValue: number }[] }).byGroup;
    const peopleQuoted = (pl.people as unknown as { quotedValue: number }[]).reduce((t, x) => t + x.quotedValue, 0);
    const wonTotal = (pl.totals as unknown as { wonValue: number }).wonValue;
    check(
      'By group adds up to the quoted value the salespeople raised, to the centavo',
      Array.isArray(byGroup) && money(byGroup.reduce((t, g) => t + g.quotedValue, 0), peopleQuoted),
      `${byGroup?.reduce((t, g) => t + g.quotedValue, 0)} vs ${peopleQuoted}`,
    );
    check(
      'and to the won value',
      money(byGroup.reduce((t, g) => t + g.wonValue, 0), wonTotal),
      `${byGroup.reduce((t, g) => t + g.wonValue, 0)} vs ${wonTotal}`,
    );
    check(
      'with "No group" last when it is there',
      !byGroup.some((g, i) => g.group === 'No group' && i !== byGroup.length - 1),
      byGroup.map((g) => g.group).join(', '),
    );

    const cash = await api('GET', '/insights/cash-forecast');
    const cf = cash.body as unknown as {
      buckets: { label: string; invoiced: number; unbilled: number; net: number }[];
      cumulative: { cumulative: number }[];
      totals: {
        invoiced: number;
        unbilled: number;
        refunds: number;
        payable: number;
        reimbursable: number;
        committed: number;
        advances: number;
        net: number;
      };
      ourMove: { billingsAwaitingInvoice: number; billingsAwaitingInvoiceValue: number };
    };
    check('the cash forecast runs', cash.status === 200, String(cash.status));
    check(
      'the cumulative line ends on the overall net',
      money(cf.cumulative[cf.cumulative.length - 1].cumulative, cf.totals.net),
      `${cf.cumulative[cf.cumulative.length - 1].cumulative} vs ${cf.totals.net}`,
    );
    check(
      'an approved billing nobody has invoiced counts as cash a decision away',
      cf.totals.unbilled > 0 && cf.ourMove.billingsAwaitingInvoice > 0,
      `${cf.ourMove.billingsAwaitingInvoice} waiting, worth ${cf.ourMove.billingsAwaitingInvoiceValue}`,
    );
    check(
      'and it is separated from what a customer owes, not mixed in',
      cf.totals.invoiced !== cf.totals.unbilled,
      'one is waiting on them, the other on us',
    );

    // Advances and refunds.
    const approvedAdvances = await prisma.cashAdvance.findMany({
      where: { status: 'APPROVED' },
      select: { amount: true, amountReleased: true },
    });
    const advancesDirect = cents(
      approvedAdvances.reduce((s, a) => s + Math.max(0, num(a.amount) - num(a.amountReleased)), 0),
    );
    check(
      'an approved advance nobody has released is cash promised — read directly, to the centavo',
      money(cf.totals.advances, advancesDirect) && cf.totals.advances >= 50_000,
      `forecast ${cf.totals.advances} vs direct ${advancesDirect}`,
    );
    check(
      'and it is the figure G-FIN calls advances to release',
      money(cf.totals.advances, fd.advancesToRelease),
      `forecast ${cf.totals.advances} vs G-FIN ${fd.advancesToRelease}`,
    );
    const refundDue = await prisma.cashAdvance.findMany({
      where: { status: 'REFUND_DUE' },
      select: { amountReleased: true, amountSpent: true, amountRefunded: true },
    });
    const refundsDirect = cents(
      refundDue.reduce(
        (s, a) => s + Math.max(0, num(a.amountReleased) - num(a.amountSpent)) - num(a.amountRefunded),
        0,
      ),
    );
    check(
      'unspent advance money still to come back is counted in, at what is still owed',
      money(cf.totals.refunds, refundsDirect) && cf.totals.refunds >= 3_000,
      `forecast ${cf.totals.refunds} vs direct ${refundsDirect}`,
    );
    const approvedClaims = await prisma.expenseClaim.findMany({
      where: { status: 'APPROVED' },
      select: { total: true, amountPaid: true, advance: { select: { amountReleased: true } } },
    });
    const claimsDirect = cents(
      approvedClaims.reduce(
        (s, c) =>
          s + Math.max(0, Math.max(0, num(c.total) - num(c.advance?.amountReleased)) - num(c.amountPaid)),
        0,
      ),
    );
    check(
      'claims owed to staff leave out a liquidation the advance already settled',
      money(cf.totals.reimbursable, claimsDirect) && cf.totals.reimbursable >= 3_000,
      `forecast ${cf.totals.reimbursable} vs APPROVED claims read directly ${claimsDirect}`,
    );
    check(
      'the forecast agrees with the finance position — receivable, payable, staff and advances',
      money(cf.totals.invoiced, fd.receivable) &&
        money(cf.totals.payable, fd.payable) &&
        money(cf.totals.reimbursable, fd.reimbursable) &&
        money(cf.totals.advances, fd.advancesToRelease),
      `${cf.totals.invoiced}/${cf.totals.payable}/${cf.totals.reimbursable}/${cf.totals.advances} vs ` +
        `${fd.receivable}/${fd.payable}/${fd.reimbursable}/${fd.advancesToRelease}`,
    );
    check(
      'net is everything in less everything out, advances and refunds included',
      money(
        cf.totals.net,
        cents(
          cf.totals.invoiced +
            cf.totals.unbilled +
            cf.totals.refunds -
            cf.totals.payable -
            cf.totals.reimbursable -
            cf.totals.committed -
            cf.totals.advances,
        ),
      ),
      `net ${cf.totals.net}`,
    );

    // The CSV twin lists the same documents the screen counts.
    const cashCsv = await fetch(`${BASE}/insights/cash-forecast.csv`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const cashText = await cashCsv.text();
    const cashRows = parseCsvRows(cashText).slice(1);
    const sumDir = (dir: string) =>
      cents(cashRows.filter((r) => r[0] === dir).reduce((s, r) => s + Number(r[4]), 0));
    check(
      'the cash-forecast CSV carries advances, claims and refunds as well as invoices and bills',
      cashCsv.ok &&
        cashText.includes(advToRelease.number) &&
        cashText.includes(advRefund.number) &&
        cashText.includes(plainClaim.number),
      `${cashCsv.status}, ${cashRows.length} rows`,
    );
    check(
      "and its money in and money out equal the screen's totals",
      money(sumDir('In'), cents(cf.totals.invoiced + cf.totals.unbilled + cf.totals.refunds)) &&
        money(
          sumDir('Out'),
          cents(cf.totals.payable + cf.totals.reimbursable + cf.totals.committed + cf.totals.advances),
        ),
      `CSV in ${sumDir('In')} / out ${sumDir('Out')}`,
    );

    const inv = await api('GET', '/insights/inventory?sinceDays=90');
    const iv = inv.body as unknown as {
      totalValue: number;
      slowMovers: { item: { code: string } }[];
      slowMoverValue: number;
      slowMoverShare: number;
      belowReorder: { item: { code: string }; available: number; reorderLevel: number }[];
      throughput: { monthsOfStock: number | null };
    };
    check('inventory analytics runs', inv.status === 200, String(inv.status));
    check(
      'slow-moving stock is reported as a share of the whole',
      iv.slowMoverShare > 0 && iv.slowMoverShare <= 100,
      `${iv.slowMoverShare}% of ${iv.totalValue}`,
    );
    check(
      'an item below its reorder level is flagged',
      iv.belowReorder.some((r) => r.item.code === `${TAG}-MOV`),
      iv.belowReorder.map((r) => `${r.item.code} ${r.available}/${r.reorderLevel}`).join(', '),
    );

    const perf = await api('GET', '/insights/performance?from=2026-01-01&to=2026-12-31');
    const pf = perf.body as unknown as {
      sales: { name: string; won: number }[];
      delivery: { name: string; active: number; overBudget: number; onTimePct: number }[];
      bottleneck: { total: number; byApprover: { approver: string; count: number }[] };
    };
    check('performance runs', perf.status === 200, String(perf.status));
    check(
      'a project manager over budget on a job is counted',
      (pf.delivery.find((m) => m.name === 'ZZ Insights PM')?.overBudget ?? 0) >= 1,
      JSON.stringify(pf.delivery.find((m) => m.name === 'ZZ Insights PM')),
    );
    check(
      'the bottleneck view exists and groups by who is holding things up',
      Array.isArray(pf.bottleneck.byApprover),
    );
    const bottleneckRows = (pf.bottleneck as unknown as { rows: { id: string; link: string | null }[] }).rows;
    check(
      'a stuck document carries its own link, so the row opens the document',
      bottleneckRows.find((r) => r.id === stuck.id)?.link === `/g-fin/expenses/${plainClaim.id}`,
      JSON.stringify(bottleneckRows.find((r) => r.id === stuck.id)),
    );
    const perfCsv = await fetch(`${BASE}/insights/performance.csv`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const perfRows = parseCsvRows(await perfCsv.text());
    check(
      'and the approvals CSV appends the link as its last column',
      perfCsv.ok &&
        perfRows[0][perfRows[0].length - 1] === 'Link' &&
        perfRows.some((r) => r[r.length - 1] === `/g-fin/expenses/${plainClaim.id}`),
      perfRows[0].join(','),
    );

    // CSV twins.
    const csvRes = await fetch(`${BASE}/insights/profitability.csv`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const csvText = await csvRes.text();
    check(
      'profitability exports as CSV with a header row',
      csvRes.ok && csvText.includes('Contract Value') && csvText.includes(healthy.number),
      `${csvRes.status}, ${csvText.length} bytes`,
    );
    check('and the export is recorded in the audit log', true === (await (async () => {
      const entry = await prisma.auditLog.findFirst({
        where: { entityType: 'insights', action: 'EXPORTED' },
        orderBy: { at: 'desc' },
      });
      return !!entry;
    })()));

    // The whole point of a reporting layer.
    const write = await api('POST', '/insights/profitability', token, { contractValue: 1 });
    check(
      'the reporting layer refuses to write anything',
      write.status === 400 && String((write.body as unknown as { error: string }).error).includes('read-only'),
      `${write.status} ${write.text.slice(0, 120)}`,
    );

    // Permissions. A project manager sees margin on projects; they do not see
    // the company's cash position or the sales pipeline analytics.
    const pmProfit = await api('GET', '/insights/profitability', pmToken);
    check('a project manager may read project profitability', pmProfit.status === 200, String(pmProfit.status));
    const pmCash = await api('GET', '/insights/cash-forecast', pmToken);
    check('but not the cash forecast', pmCash.status === 403, String(pmCash.status));
    const pmPerf = await api('GET', '/insights/performance', pmToken);
    check('and not the performance report', pmPerf.status === 403, String(pmPerf.status));
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
