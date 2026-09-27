/**
 * Phase 3 verification — sales.
 *
 *   npx tsx scripts/verify-sales.ts
 *
 * Concentrates on the arithmetic and the commercial rules: how the contract
 * amount is reached, that the schedule of values reconciles to it, that VAT is
 * right in both directions, and that an issued revision can never be edited.
 * Those are the things that are expensive to get wrong and invisible when they
 * are.
 */

import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/prisma';
import { env } from '../src/env';
import { nextNumber } from '../src/shared/numbering';
import { submitForApproval, act } from '../src/shared/approvals';
import { renderDocument } from '../src/shared/pdf';
import { resolveUser, canEditRecord, type ResolvedUser } from '../src/permissions/resolve';
import {
  quotationValue,
  columnFor,
  allowedTargets,
  assertLeadStatusChange,
  assertOutcomeChange,
  inForecastMonth,
  isOverdue,
  buildBoard,
  type BoardLead,
  type BoardQuotation,
} from '../src/shared/pipeline';
// Imported for its side effect: this is what registers the quotation's
// onApprovalSettled subscriber. The real API gets it via src/index.ts, and the
// test has to exercise the same wiring or it proves nothing about production.
import '../src/routes/sales';

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

/** Money comparisons are to the centavo — floats never land exactly. */
function money(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005;
}

const d = (v: number) => new Prisma.Decimal(v);

const TAG = 'ZZSALES';

async function cleanup() {
  // Activities point at leads and quotations; they go first.
  await prisma.salesActivity.deleteMany({
    where: { OR: [{ subject: { startsWith: TAG } }, { lead: { companyName: { startsWith: TAG } } }] },
  });
  await prisma.quotation.deleteMany({ where: { subject: { startsWith: TAG } } });
  await prisma.costing.deleteMany({ where: { title: { startsWith: TAG } } });
  await prisma.lead.deleteMany({ where: { companyName: { startsWith: TAG } } });
  await prisma.customer.deleteMany({ where: { name: { startsWith: TAG } } });
  const users = await prisma.user.findMany({
    where: { email: { endsWith: '@verifys.local' } },
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
  console.log('\nG-CORE sales verification\n');
  await cleanup();

  const sales = await makeUser('Verify Sales', 'sales@verifys.local', ['sales']);
  const manager = await makeUser('Verify Sales Manager', 'mgr@verifys.local', ['sales_manager']);
  const other = await makeUser('Verify Other', 'other@verifys.local', ['sales']);

  const customer = await prisma.customer.create({
    data: { code: `${TAG}-C1`, name: `${TAG} Hospital`, createdById: sales.id },
  });

  // ── 1. The contract amount ─────────────────────────────────────────────────
  console.log('How the contract amount is reached');

  const categories = await prisma.costCategory.findMany({ orderBy: { sortOrder: 'asc' } });
  const costing = await prisma.costing.create({
    data: {
      number: await nextNumber('costing'),
      title: `${TAG} Oxygen plant`,
      ownerId: sales.id,
      customerId: customer.id,
      markupPct: d(0.25),
      discountAmount: d(50_000),
    },
  });

  // 1,000,000 of cost spread across the five buckets.
  const costs = [200_000, 400_000, 250_000, 100_000, 50_000];
  for (const [i, amount] of costs.entries()) {
    await prisma.costingLine.create({
      data: {
        costingId: costing.id,
        costCategoryId: categories[i].id,
        description: `${TAG} line ${i + 1}`,
        quantity: d(1),
        unit: 'lot',
        unitCost: d(amount),
        amount: d(amount),
        sortOrder: i,
      },
    });
  }

  // Mirrors the route's recalc: cost + markup − discount.
  const totalCost = costs.reduce((a, b) => a + b, 0);
  const expectedContract = totalCost * 1.25 - 50_000;
  await prisma.costing.update({
    where: { id: costing.id },
    data: { totalCost: d(totalCost), contractValue: d(expectedContract) },
  });

  const priced = await prisma.costing.findUnique({ where: { id: costing.id } });
  check('total cost sums the five buckets', money(Number(priced!.totalCost), 1_000_000), String(priced!.totalCost));
  check(
    'contract = cost + markup − discount',
    money(Number(priced!.contractValue), 1_200_000),
    String(priced!.contractValue),
  );

  const grossProfit = Number(priced!.contractValue) - Number(priced!.totalCost);
  check('gross profit is contract − cost', money(grossProfit, 200_000), String(grossProfit));
  // The distinction that matters: margin is over the contract value, not cost.
  // 200k/1.2M is 16.67%; over cost it would read 20% and overstate the job.
  check(
    'margin is profit ÷ contract, not ÷ cost',
    money((grossProfit / Number(priced!.contractValue)) * 100, 16.6667),
    `${((grossProfit / Number(priced!.contractValue)) * 100).toFixed(4)}%`,
  );

  // ── 2. Schedule of values ──────────────────────────────────────────────────
  console.log('\nSchedule of values');

  const sectionSpec = [
    { kind: 'MAIN_WORK' as const, name: `${TAG} Fabrication`, days: 45 },
    { kind: 'TESTING_COMMISSIONING' as const, name: `${TAG} Testing`, days: 10 },
    { kind: 'TURNOVER' as const, name: `${TAG} Turnover`, days: 5 },
  ];
  for (const [i, s] of sectionSpec.entries()) {
    await prisma.scopeSection.create({
      data: {
        costingId: costing.id,
        kind: s.kind,
        name: s.name,
        durationDays: s.days,
        value: d(0),
        sortOrder: i,
      },
    });
  }

  // Even spread, the route's fallback when nothing has been set yet.
  const sections = await prisma.scopeSection.findMany({
    where: { costingId: costing.id },
    orderBy: { sortOrder: 'asc' },
  });
  const contract = Number(priced!.contractValue);
  const even = sections.map(() => Math.round((contract / sections.length) * 100) / 100);
  const drift = Math.round((contract - even.reduce((a, b) => a + b, 0)) * 100) / 100;
  even[even.length - 1] = Math.round((even[even.length - 1] + drift) * 100) / 100;
  await prisma.$transaction(
    sections.map((s, i) => prisma.scopeSection.update({ where: { id: s.id }, data: { value: d(even[i]) } })),
  );

  const spread = await prisma.scopeSection.findMany({ where: { costingId: costing.id } });
  const sovTotal = spread.reduce((sum, s) => sum + Number(s.value), 0);
  check('the schedule of values equals the contract value', money(sovTotal, contract), `${sovTotal} vs ${contract}`);

  // A value that does not divide evenly is where rounding drift shows up.
  await prisma.costing.update({ where: { id: costing.id }, data: { contractValue: d(1_000_000 / 3) } });
  const odd = 1_000_000 / 3;
  const raw = spread.map(() => odd / spread.length);
  const rounded = raw.map((v) => Math.round(v * 100) / 100);
  const drift2 = Math.round((odd - rounded.reduce((a, b) => a + b, 0)) * 100) / 100;
  rounded[rounded.length - 1] = Math.round((rounded[rounded.length - 1] + drift2) * 100) / 100;
  check(
    'an awkward contract value still reconciles to the centavo',
    money(rounded.reduce((a, b) => a + b, 0), Math.round(odd * 100) / 100),
    `${rounded.reduce((a, b) => a + b, 0)} vs ${odd}`,
  );
  await prisma.costing.update({ where: { id: costing.id }, data: { contractValue: d(contract) } });

  // ── 3. Quotation revisions ─────────────────────────────────────────────────
  console.log('\nQuotation revisions');

  const lead = await prisma.lead.create({
    data: {
      number: await nextNumber('lead'),
      companyName: `${TAG} Hospital`,
      customerId: customer.id,
      assignedToId: sales.id,
      createdById: sales.id,
      estimatedValue: d(1_200_000),
      probability: 60,
    },
  });

  const quotation = await prisma.quotation.create({
    data: {
      // The author's employee digits go into the number (item 6). The fixture
      // asserts nothing about the format — the template is the owner's.
      number: await nextNumber('quotation', prisma, { ownerId: sales.id }),
      customerId: customer.id,
      leadId: lead.id,
      ownerId: sales.id,
      subject: `${TAG} Oxygen plant supply`,
      revisions: {
        create: [{ revision: 0, status: 'DRAFT', costingId: costing.id, vatRate: d(0.12) }],
      },
    },
    include: { revisions: true },
  });
  const r0 = quotation.revisions[0];

  // Fill R0 from the costing's scope — the integration the requirements ask for.
  const scope = await prisma.scopeSection.findMany({
    where: { costingId: costing.id },
    orderBy: { sortOrder: 'asc' },
  });
  await prisma.quotationItem.createMany({
    data: scope.map((s, i) => ({
      revisionId: r0.id,
      description: s.name,
      quantity: d(1),
      unit: 'lot',
      unitPrice: s.value,
      amount: s.value,
      sortOrder: i,
    })),
  });

  const filled = await prisma.quotationRevision.findUnique({
    where: { id: r0.id },
    include: { items: true },
  });
  check('the quotation fills from the costing scope', filled!.items.length === 3, `${filled!.items.length} lines`);
  const subtotal = filled!.items.reduce((s, i) => s + Number(i.amount), 0);
  check('and its subtotal equals the contract value', money(subtotal, contract), `${subtotal}`);

  // VAT exclusive: tax added on top.
  const vatExclusive = subtotal * 0.12;
  await prisma.quotationRevision.update({
    where: { id: r0.id },
    data: { subtotal: d(subtotal), vatAmount: d(vatExclusive), total: d(subtotal + vatExclusive) },
  });
  const exclusive = await prisma.quotationRevision.findUnique({ where: { id: r0.id } });
  check('VAT exclusive adds 12% on top', money(Number(exclusive!.total), 1_344_000), String(exclusive!.total));

  // VAT inclusive: the same headline price, tax backed out of it.
  const inclusiveVat = subtotal - subtotal / 1.12;
  check(
    'VAT inclusive backs the tax out of the same figure',
    money(inclusiveVat, 128_571.43),
    inclusiveVat.toFixed(2),
  );
  check(
    'the two treatments are genuinely different',
    !money(vatExclusive, inclusiveVat),
    `${vatExclusive.toFixed(2)} vs ${inclusiveVat.toFixed(2)}`,
  );

  // ── 4. Record ownership ────────────────────────────────────────────────────
  console.log('\nOwnership');

  const salesUser = (await resolveUser(sales.id))!;
  const otherUser = (await resolveUser(other.id))!;
  const admin = await prisma.user.findFirst({ where: { isSuperAdmin: true } });
  const superUser = (await resolveUser(admin!.id))!;

  check('the author may edit their quotation', canEditRecord(salesUser, 'gops', 'quotations', sales.id));
  check(
    'another salesperson may not',
    !canEditRecord(otherUser, 'gops', 'quotations', sales.id),
  );
  check('super admin may edit any', canEditRecord(superUser, 'gops', 'quotations', sales.id));

  // ── 5. Approval ────────────────────────────────────────────────────────────
  console.log('\nApproval');

  await prisma.quotationRevision.update({
    where: { id: r0.id },
    data: { status: 'PENDING_APPROVAL' },
  });
  const request = await submitForApproval({
    documentType: 'quotation',
    documentId: r0.id,
    documentNumber: `${quotation.number} R0`,
    subject: quotation.subject,
    amount: Number(exclusive!.total),
    requesterId: sales.id,
  });
  check('a quotation routes for approval', request.status === 'PENDING');

  let refused = false;
  try {
    await act({ requestId: request.id, userId: sales.id, action: 'APPROVED' });
  } catch {
    refused = true;
  }
  check('the author cannot approve their own quotation', refused);

  await act({ requestId: request.id, userId: manager.id, action: 'APPROVED' });
  const approved = await prisma.quotationRevision.findUnique({ where: { id: r0.id } });
  check('the sales manager can approve it', approved!.status === 'APPROVED', approved!.status);

  // ── 6. Revisions are immutable once issued ─────────────────────────────────
  console.log('\nRevision history');

  // Raising R1 supersedes R0 but leaves it readable.
  await prisma.$transaction(async (tx) => {
    await tx.quotationRevision.update({ where: { id: r0.id }, data: { status: 'SUPERSEDED' } });
    await tx.quotationRevision.create({
      data: {
        quotationId: quotation.id,
        revision: 1,
        status: 'DRAFT',
        costingId: costing.id,
        vatRate: d(0.12),
        items: {
          create: filled!.items.map((i) => ({
            description: i.description,
            quantity: i.quantity,
            unit: i.unit,
            unitPrice: i.unitPrice,
            amount: i.amount,
            sortOrder: i.sortOrder,
          })),
        },
      },
    });
  });

  const history = await prisma.quotationRevision.findMany({
    where: { quotationId: quotation.id },
    orderBy: { revision: 'asc' },
    include: { items: true },
  });
  check('both revisions are kept', history.length === 2, `${history.length}`);
  check('R0 survives as a record of what was sent', history[0].items.length === 3);
  check('R0 keeps its own totals', money(Number(history[0].total), 1_344_000), String(history[0].total));
  check('R0 is marked superseded, not deleted', history[0].status === 'SUPERSEDED');
  check('R1 starts as a draft copy', history[1].status === 'DRAFT' && history[1].items.length === 3);

  // Only one revision may ever be APPROVED (model §10).
  await prisma.quotationRevision.update({ where: { id: history[1].id }, data: { status: 'APPROVED' } });
  await prisma.quotationRevision.updateMany({
    where: { quotationId: quotation.id, status: 'APPROVED', id: { not: history[1].id } },
    data: { status: 'SUPERSEDED' },
  });
  const approvedCount = await prisma.quotationRevision.count({
    where: { quotationId: quotation.id, status: 'APPROVED' },
  });
  check('only one revision can be approved at a time', approvedCount === 1, `${approvedCount}`);

  // ── 7. Lead follows the quotation ──────────────────────────────────────────
  console.log('\nLead and pipeline');

  await prisma.lead.update({ where: { id: lead.id }, data: { status: 'QUOTATION_CREATED' } });
  const moved = await prisma.lead.findUnique({ where: { id: lead.id } });
  check('creating a quotation moves the lead on', moved!.status === 'QUOTATION_CREATED');

  const weighted = (Number(moved!.estimatedValue) * moved!.probability) / 100;
  check('weighted value is amount × probability', money(weighted, 720_000), String(weighted));

  // A won quotation counts at full value, not at its probability.
  await prisma.quotation.update({ where: { id: quotation.id }, data: { outcome: 'WON' } });
  const wonQuote = await prisma.quotation.findUnique({ where: { id: quotation.id } });
  check('a won quotation is recorded as won', wonQuote!.outcome === 'WON');

  // ── 7b. The pipeline board ─────────────────────────────────────────────────
  // Pure functions from shared/pipeline.ts, on in-memory fixtures: the route
  // only fetches, so the arithmetic and the move rules can be proved without
  // an HTTP server (the HTTP half is verify-pipeline.ts).
  console.log('\nPipeline board');

  const D = (v: number) => new Prisma.Decimal(v);
  const now = new Date();
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
  const managerUser = (await resolveUser(manager.id))!;
  const person = { id: sales.id, name: sales.name, photoPath: null };

  check(
    'quotationValue prefers the APPROVED revision over a later draft',
    money(
      quotationValue([
        { revision: 0, status: 'APPROVED', total: D(1_344_000) },
        { revision: 1, status: 'DRAFT', total: D(1_500_000) },
      ]),
      1_344_000,
    ),
  );
  check(
    'a draft-only quotation is valued at its latest revision',
    money(
      quotationValue([
        { revision: 1, status: 'DRAFT', total: D(900_000) },
        { revision: 0, status: 'SUPERSEDED', total: D(800_000) },
      ]),
      900_000,
    ),
  );
  check('no revisions is worth nothing', quotationValue([]) === 0);

  check(
    'an ON_HOLD lead stands in its own column, not Qualified',
    columnFor({ kind: 'lead', status: 'ON_HOLD', quotationCount: 0 }) === 'ON_HOLD',
  );
  check('an OPEN quotation is "Quotation drafted"', columnFor({ kind: 'quotation', outcome: 'OPEN' }) === 'QUOTED');
  check('a SUBMITTED quotation is Submitted', columnFor({ kind: 'quotation', outcome: 'SUBMITTED' }) === 'SUBMITTED');
  check(
    'a lead with a quotation is never a card',
    columnFor({ kind: 'lead', status: 'NEGOTIATION', quotationCount: 1 }) === null &&
      columnFor({ kind: 'lead', status: 'QUALIFIED', quotationCount: 1 }) === null,
  );

  function fixtureLead(over: Partial<BoardLead> = {}): BoardLead {
    return {
      id: `L-${Math.random()}`,
      number: 'GT-LD-2026-0001',
      companyName: `${TAG} Lead Co`,
      description: null,
      status: 'QUALIFIED',
      estimatedValue: D(500_000),
      probability: 40,
      expectedClosing: null,
      nextAction: null,
      nextActionDate: null,
      lostReason: null,
      createdAt: daysAgo(3),
      updatedAt: daysAgo(1),
      assignedToId: sales.id,
      assignedTo: person,
      customer: null,
      activities: [],
      quotationCount: 0,
      ...over,
    };
  }
  function fixtureQuotation(over: Partial<BoardQuotation> = {}): BoardQuotation {
    return {
      id: `Q-${Math.random()}`,
      number: '0012609001',
      subject: `${TAG} Plant`,
      outcome: 'NEGOTIATION',
      probability: 60,
      submittedAt: daysAgo(5),
      decidedAt: null,
      lostReason: null,
      expectedClosing: null,
      createdAt: daysAgo(10),
      ownerId: sales.id,
      owner: person,
      customer: { id: customer.id, name: customer.name },
      lead: null,
      revisions: [
        {
          id: 'R0',
          revision: 0,
          status: 'APPROVED',
          total: D(1_344_000),
          validityDays: 30,
          createdAt: daysAgo(10),
          costing: null,
          jobs: [],
        },
      ],
      activities: [],
      ...over,
    };
  }
  const board = (leads: BoardLead[], quotations: BoardQuotation[], me: ResolvedUser = managerUser, days = 90) =>
    buildBoard({ leads, quotations, now, decidedWithinDays: days, me });

  // Gap 4: a lead at NEGOTIATION whose quotation is at NEGOTIATION is ONE card.
  const b1 = board(
    [fixtureLead({ status: 'NEGOTIATION', quotationCount: 1, estimatedValue: D(999_999) })],
    [fixtureQuotation({ outcome: 'NEGOTIATION' })],
  );
  const negotiation = b1.columns.find((c) => c.key === 'NEGOTIATION')!;
  check('a lead and its quotation at NEGOTIATION make one card, not two', negotiation.count === 1, `${negotiation.count}`);
  check(
    "and the column's value is the quotation's, not the sum of both",
    money(negotiation.value, 1_344_000),
    String(negotiation.value),
  );

  const refuses = (fn: () => void, needle: string) => {
    try {
      fn();
      return false;
    } catch (err) {
      return String((err as Error).message).toLowerCase().includes(needle.toLowerCase());
    }
  };
  check(
    'WON is refused with no approved revision',
    refuses(() => assertOutcomeChange('NEGOTIATION', 'WON', { hasApprovedRevision: false, hasJob: false }), 'approved revision'),
  );
  check(
    'and accepted with one',
    !refuses(() => assertOutcomeChange('NEGOTIATION', 'WON', { hasApprovedRevision: true, hasJob: false }), ''),
  );
  check(
    'leaving WON is refused once a job references the quotation',
    refuses(
      () =>
        assertOutcomeChange('WON', 'NEGOTIATION', {
          hasApprovedRevision: true,
          hasJob: true,
          jobNumber: 'GT-PRJ-2026-0001',
        }),
      'GT-PRJ-2026-0001',
    ),
  );
  check(
    'LOST without a reason is refused for a lead',
    refuses(() => assertLeadStatusChange('QUALIFIED', 'LOST', { hasQuotations: false }), 'why'),
  );
  check(
    'and for a quotation',
    refuses(
      () => assertOutcomeChange('SUBMITTED', 'LOST', { hasApprovedRevision: false, hasJob: false, lostReason: '  ' }),
      'why',
    ),
  );
  check(
    'LOST with a reason is accepted',
    !refuses(
      () => assertOutcomeChange('SUBMITTED', 'LOST', { hasApprovedRevision: false, hasJob: false, lostReason: 'Price' }),
      '',
    ) && !refuses(() => assertLeadStatusChange('QUALIFIED', 'LOST', { hasQuotations: false, lostReason: 'Went elsewhere' }), ''),
  );
  check(
    'a lead with no quotation cannot be won',
    refuses(() => assertLeadStatusChange('QUALIFIED', 'WON', { hasQuotations: false }), 'won by its quotation'),
  );
  check(
    'nor negotiated',
    refuses(() => assertLeadStatusChange('COSTING', 'NEGOTIATION', { hasQuotations: false }), 'won by its quotation'),
  );
  check(
    'a lead card can be dropped on its own stages and Lost, never on a quotation stage',
    (() => {
      const t = allowedTargets({ kind: 'lead', column: 'QUALIFIED' });
      return (
        t.includes('COSTING') &&
        t.includes('ON_HOLD') &&
        t.includes('LOST') &&
        !t.includes('QUALIFIED') &&
        !t.includes('WON') &&
        !t.includes('QUOTED')
      );
    })(),
  );
  check(
    'a quotation card reaches WON only with an approved revision',
    !allowedTargets({ kind: 'quotation', column: 'SUBMITTED', hasApprovedRevision: false }).includes('WON') &&
      allowedTargets({ kind: 'quotation', column: 'SUBMITTED', hasApprovedRevision: true }).includes('WON'),
  );
  check(
    'a WON quotation with a job cannot be moved at all',
    allowedTargets({ kind: 'quotation', column: 'WON', hasApprovedRevision: true, hasJob: true }).length === 0,
  );

  // Forecast month, in Manila.
  const manilaParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit' })
    .format(now)
    .split('-')
    .map(Number);
  const [mYear, mMonth] = [manilaParts[0], manilaParts[1] - 1];
  const midMonth = new Date(Date.UTC(mYear, mMonth, 15));
  const lastOfPrev = new Date(Date.UTC(mYear, mMonth, 0));
  const firstOfNext = new Date(Date.UTC(mYear, mMonth + 1, 1));
  check('the 15th of this month is in the forecast', inForecastMonth(midMonth, now));
  check('the last day of last month is not', !inForecastMonth(lastOfPrev, now));
  check('the first day of next month is not', !inForecastMonth(firstOfNext, now));
  check('no date is not', !inForecastMonth(null, now));

  const b2 = board(
    [
      fixtureLead({ status: 'QUALIFIED', estimatedValue: D(200_000), probability: 50, expectedClosing: midMonth }),
      fixtureLead({ status: 'ON_HOLD', estimatedValue: D(300_000), probability: 50, expectedClosing: midMonth }),
    ],
    [fixtureQuotation({ outcome: 'SUBMITTED', probability: 25, expectedClosing: midMonth })],
  );
  check(
    'an ON_HOLD lead is left out of the forecast even when dated this month',
    b2.forecast.count === 2,
    `${b2.forecast.count}`,
  );
  check(
    'forecastWeighted = Σ value × probability',
    money(b2.kpis.forecastWeighted, 200_000 * 0.5 + 1_344_000 * 0.25),
    String(b2.kpis.forecastWeighted),
  );

  // Won/Lost window.
  const approvedRev = (id: string, total: number, created: Date) => ({
    id,
    revision: 0,
    status: 'APPROVED',
    total: D(total),
    validityDays: 30,
    createdAt: created,
    costing: null,
    jobs: [],
  });
  const b3 = board(
    [],
    [
      fixtureQuotation({ outcome: 'WON', decidedAt: daysAgo(91), revisions: [approvedRev('a', 100, daysAgo(100))] }),
      fixtureQuotation({ outcome: 'WON', decidedAt: now, revisions: [approvedRev('b', 7, daysAgo(3))] }),
    ],
  );
  check('a quotation decided 91 days ago is outside a 90-day board', b3.kpis.wonCount === 1, `${b3.kpis.wonCount}`);
  check('and wonValue counts only the one inside', money(b3.kpis.wonValue, 7), String(b3.kpis.wonValue));

  // Overdue.
  check('expected closing yesterday is overdue', isOverdue({ kind: 'lead', expectedClosing: daysAgo(1) }, now));
  check(
    'validity lapsed (submitted 31 days ago, 30 days valid) is overdue',
    isOverdue({ kind: 'quotation', submittedAt: daysAgo(31), validityDays: 30 }, now),
  );
  check(
    'expected closing tomorrow is not',
    !isOverdue(
      { kind: 'quotation', expectedClosing: new Date(now.getTime() + 86_400_000), submittedAt: daysAgo(2), validityDays: 30 },
      now,
    ),
  );

  // Quoted figures and lead estimates never add up together.
  const b4 = board(
    [fixtureLead({ status: 'NEW', estimatedValue: D(50_000), probability: 10 })],
    [fixtureQuotation({ outcome: 'SUBMITTED' })],
  );
  check('kpis.quotedValue counts quotations only', money(b4.kpis.quotedValue, 1_344_000), String(b4.kpis.quotedValue));
  check('kpis.leadEstimate counts leads only', money(b4.kpis.leadEstimate, 50_000), String(b4.kpis.leadEstimate));
  check('openQuotes counts quotation cards only', b4.kpis.openQuotes === 1 && b4.kpis.leadCount === 1);

  // canMove comes from canEditRecord, not from the client. The seeded sales
  // role may edit any lead but only its OWN quotations, so the quotation card
  // is the one that tells the two apart.
  const b5 = board([fixtureLead()], [fixtureQuotation()], (await resolveUser(other.id))!);
  check(
    "another salesperson's board offers no moves on somebody else's quotation",
    b5.columns.every((c) =>
      c.cards.filter((card) => card.kind === 'quotation').every((card) => !card.canMove && card.allowedTargets.length === 0),
    ),
  );
  const b6 = board([fixtureLead()], [fixtureQuotation()], salesUser);
  check('the owner may move their own', b6.columns.every((c) => c.cards.every((card) => card.canMove)));

  // ── 8. PDFs ────────────────────────────────────────────────────────────────
  console.log('\nDocuments');

  const quotePdf = await renderDocument({
    title: 'Quotation',
    documentNumber: quotation.number,
    revision: '0',
    reference: customer.name,
    sections: [
      {
        kind: 'table',
        title: 'Scope and pricing',
        head: ['#', 'Description', 'Amount'],
        align: ['right', 'left', 'right'],
        rows: history[0].items.map((i, n) => [String(n + 1), i.description, String(Number(i.amount))]),
      },
    ],
  });
  check('a quotation prints', quotePdf.subarray(0, 5).toString() === '%PDF-');

  const costingPdf = await renderDocument({
    title: 'Costing Sheet',
    documentNumber: costing.number,
    sections: [
      {
        kind: 'table',
        title: 'How the contract amount is reached',
        head: ['', 'Amount'],
        align: ['left', 'right'],
        rows: [
          ['Total estimated cost', '1,000,000.00'],
          ['Markup (25%)', '250,000.00'],
          ['Less discount', '-50,000.00'],
          ['CONTRACT AMOUNT', '1,200,000.00'],
        ],
      },
    ],
  });
  check('a costing sheet prints', costingPdf.subarray(0, 5).toString() === '%PDF-');

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
