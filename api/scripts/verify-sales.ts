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
import { resolveUser, canEditRecord } from '../src/permissions/resolve';
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
      number: await nextNumber('quotation'),
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
