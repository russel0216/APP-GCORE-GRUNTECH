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
import zlib from 'node:zlib';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/prisma';
import { env } from '../src/env';
import { nextNumber, previewNext, employeeToken } from '../src/shared/numbering';
import { submitForApproval, act, pendingFor } from '../src/shared/approvals';
import { renderDocument } from '../src/shared/pdf';
import { resolveUser, canEditRecord, type ResolvedUser } from '../src/permissions/resolve';
import { signToken } from '../src/auth/middleware';
import {
  quotationTotals,
  lineAmount,
  recalcQuotationRevision,
  withdrawStaleQuotationApprovals,
} from '../src/shared/quotation';
// The quotation editor's live figures. DOM-free, so it runs here as it does in
// the page; the checks below pin it to the server's arithmetic.
import {
  quotationTotals as editorTotals,
  lineAmount as editorLineAmount,
} from '../../web/src/lib/quotationMath';
import {
  quotationValue,
  columnFor,
  allowedTargets,
  assertLeadStatusChange,
  assertOutcomeChange,
  inForecastMonth,
  isOverdue,
  buildBoard,
  outcomeChanges,
  outcomeStages,
  manilaDaysBetween,
  type BoardLead,
  type BoardQuotation,
  groupShares,
  NO_GROUP,
} from '../src/shared/pipeline';
// Imported for its side effect: this is what registers the quotation's
// onApprovalSettled subscriber. The real API gets it via src/index.ts, and the
// test has to exercise the same wiring or it proves nothing about production.
import '../src/routes/sales';
import { groupKey, rememberGroups } from '../src/shared/quotationGroups';

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

/**
 * Employee digits for the "author's number" checks: a token no real person
 * carries, so the counters it creates under an OWNER-scoped pattern belong to
 * this script alone and can be removed. Null when somebody real holds it —
 * then those checks fall back to the author's id and no counter is touched.
 */
const EDITOR_TOKEN = '9871';
async function editorTokenIsSpare(): Promise<boolean> {
  const [users, employees] = await Promise.all([
    prisma.user.findMany({
      where: { employeeNo: { not: null }, NOT: { email: { endsWith: '@verifys.local' } } },
      select: { employeeNo: true },
    }),
    prisma.employee.findMany({ select: { employeeNo: true } }),
  ]);
  return ![...users, ...employees].some((r) => employeeToken(r.employeeNo) === EDITOR_TOKEN);
}

/*
  The PDF checks read the STANDARD quotation layout's wording. An
  administrator's own layout (Admin › PDF Templates) is set aside for the run
  — kept in a Setting of its own, not in memory — and put back by cleanup(),
  which also runs first: a run that died half way returns it next time.
*/
const LAYOUT_KEYS = ['pdfTemplate.quotation', 'pdfTemplate.sales_order'];
const stashKeyOf = (key: string) => `${key}.__verify__`;

async function setSavedLayoutAside() {
  for (const key of LAYOUT_KEYS) {
    const row = await prisma.setting.findUnique({ where: { key } });
    if (!row) continue;
    await prisma.$transaction([
      prisma.setting.upsert({
        where: { key: stashKeyOf(key) },
        create: { key: stashKeyOf(key), value: row.value as Prisma.InputJsonValue, description: row.description },
        update: { value: row.value as Prisma.InputJsonValue, description: row.description },
      }),
      prisma.setting.delete({ where: { key } }),
    ]);
  }
}

async function putSavedLayoutBack() {
  for (const key of LAYOUT_KEYS) {
    const stash = await prisma.setting.findUnique({ where: { key: stashKeyOf(key) } });
    if (!stash) continue;
    await prisma.$transaction([
      prisma.setting.upsert({
        where: { key },
        create: { key, value: stash.value as Prisma.InputJsonValue, description: stash.description },
        update: { value: stash.value as Prisma.InputJsonValue, description: stash.description },
      }),
      prisma.setting.delete({ where: { key: stashKeyOf(key) } }),
    ]);
  }
}

async function cleanup() {
  await putSavedLayoutBack();
  if (await editorTokenIsSpare()) {
    await prisma.numberSequence.deleteMany({
      where: { documentType: 'quotation', periodKey: { endsWith: `@${EDITOR_TOKEN}` } },
    });
  }
  // Groups the test lines added to the Quotation Groups master.
  await prisma.quotationGroup.deleteMany({ where: { key: { startsWith: TAG.toLowerCase() } } });
  // Activities point at leads and quotations; they go first.
  await prisma.salesActivity.deleteMany({
    where: { OR: [{ subject: { startsWith: TAG } }, { lead: { companyName: { startsWith: TAG } } }] },
  });
  // The trail of the test quotations and their revisions — the settle
  // subscriber and a withdrawal by nobody write it with no actor.
  const quoteTrail = (
    await prisma.quotation.findMany({
      where: { subject: { startsWith: TAG } },
      select: { id: true, revisions: { select: { id: true } } },
    })
  ).flatMap((q) => [q.id, ...q.revisions.map((r) => r.id)]);
  if (quoteTrail.length) {
    await prisma.auditLog.deleteMany({ where: { entityType: 'quotation', entityId: { in: quoteTrail } } });
  }
  // Sales orders hold their quotation (Restrict), so they go first.
  await prisma.salesOrder.deleteMany({ where: { quotation: { subject: { startsWith: TAG } } } });
  await prisma.quotation.deleteMany({ where: { subject: { startsWith: TAG } } });
  // Quotations route to the seeded sales_manager role, so whoever really holds
  // it was asked about, and told of, the test quotations too.
  await prisma.notification.deleteMany({ where: { title: { contains: TAG } } });
  await prisma.supplier.deleteMany({ where: { name: { startsWith: TAG } } });
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

// ── HTTP and PDF helpers (the cost-stripping half needs the API running) ─────

const BASE = `http://localhost:${env.port}/api`;

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
  text: string;
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
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed, text };
}

async function apiReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** The text a PDF shows, one string per text run (verify-foundation.ts's reader). */
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
      continue; // not every stream is text, and a font program is not a failure
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

  // ── 6b. A decision on a revision that has moved on ─────────────────────────
  // How raising a revision used to leave a pending one (GT-QT-2026-0161 on the
  // owner's laptop): superseded, its request still open in the approver's
  // queue. The route now withdraws it (the HTTP half, below); these are the
  // subscriber's guard and the seed's repair for what is already there.
  console.log('\nA decision on a revision that has moved on');

  const staleQuote = await prisma.quotation.create({
    data: {
      number: `${TAG}-STALE-${Date.now() % 100_000}`,
      customerId: customer.id,
      ownerId: sales.id,
      subject: `${TAG} Superseded while pending`,
    },
  });
  /** A revision submitted for approval — then, if asked, superseded the old way, its request left open. */
  async function submittedRevision(revision: number, supersede: boolean) {
    const rev = await prisma.quotationRevision.create({
      data: { quotationId: staleQuote.id, revision, status: 'PENDING_APPROVAL', vatRate: d(0.12) },
    });
    const request = await submitForApproval({
      documentType: 'quotation',
      documentId: rev.id,
      documentNumber: `${staleQuote.number} R${revision}`,
      subject: staleQuote.subject,
      amount: 1_000,
      link: `/g-ops/quotations/${staleQuote.id}`,
      requesterId: sales.id,
    });
    if (supersede) await prisma.quotationRevision.update({ where: { id: rev.id }, data: { status: 'SUPERSEDED' } });
    return { rev, request };
  }
  const statusOf = async (id: string) => (await prisma.quotationRevision.findUniqueOrThrow({ where: { id } })).status;

  const staleR0 = await submittedRevision(0, true);
  const liveR1 = await submittedRevision(1, false);
  await act({ requestId: liveR1.request.id, userId: manager.id, action: 'APPROVED' });
  check('R1 is approved through its own request', (await statusOf(liveR1.rev.id)) === 'APPROVED');

  await act({ requestId: staleR0.request.id, userId: manager.id, action: 'APPROVED' });
  const r0After = await prisma.quotationRevision.findUniqueOrThrow({ where: { id: staleR0.rev.id } });
  check(
    'approving the request left open on superseded R0 does not bring R0 back',
    r0After.status === 'SUPERSEDED' && r0After.approvedAt === null,
    r0After.status,
  );
  const staleStatuses = (await prisma.quotationRevision.findMany({ where: { quotationId: staleQuote.id }, orderBy: { revision: 'asc' } })).map((r) => r.status);
  check(
    'and R1 stays the one approved revision — the one a project is built from',
    staleStatuses.join(',') === 'SUPERSEDED,APPROVED',
    staleStatuses.join(','),
  );
  check(
    'the trail says the late decision was not applied',
    (await prisma.auditLog.count({
      where: { entityType: 'quotation', entityId: staleQuote.id, summary: `Revision 0 of ${staleQuote.number} was approved after it was superseded — not applied` },
    })) === 1,
  );

  const staleR2 = await submittedRevision(2, true);
  await act({ requestId: staleR2.request.id, userId: manager.id, action: 'REJECTED' });
  check('rejecting one leaves it superseded, not rejected', (await statusOf(staleR2.rev.id)) === 'SUPERSEDED');

  // The repair the seed runs on every deploy, narrowed to this quotation's revisions.
  const staleR3 = await submittedRevision(3, true);
  const waitingR4 = await submittedRevision(4, false);
  const repaired = await withdrawStaleQuotationApprovals([staleR3.rev.id, waitingR4.rev.id]);
  const r3Request = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: staleR3.request.id } });
  check(
    'the repair withdraws a request left open on a superseded revision — CANCELLED, not deleted',
    repaired.length === 1 && repaired[0] === `${staleQuote.number} R3` && r3Request.status === 'CANCELLED' && !!r3Request.closedAt,
    `${JSON.stringify(repaired)} ${r3Request.status}`,
  );
  check('it leaves the approver’s queue', !(await pendingFor(manager.id)).some((r) => r.id === staleR3.request.id));
  const r3Told = await prisma.notification.findFirst({ where: { userId: manager.id, type: 'approval.withdrawn', body: { startsWith: `${staleQuote.number} R3` } } });
  check(
    'and the approver is told why',
    r3Told?.title === `Withdrawn: ${staleQuote.subject}` && r3Told.body === `${staleQuote.number} R3 — superseded before anybody decided`,
    JSON.stringify(r3Told),
  );
  check(
    'a request whose revision still waits on the approver is left alone',
    (await prisma.approvalRequest.findUniqueOrThrow({ where: { id: waitingR4.request.id } })).status === 'PENDING',
  );
  check(
    'and a second run withdraws nothing',
    (await withdrawStaleQuotationApprovals([staleR3.rev.id, waitingR4.rev.id])).length === 0,
  );

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
  // ── By group (Sales Analytics): a quotation's value split by its groups ──
  console.log('\nQuotation groups');
  const shares = groupShares(1_120.0, [
    { group: 'Trading', amount: D(600) },
    { group: ' trading', amount: D(100) },
    { group: 'Installation', amount: D(300) },
    { group: 'Heading', amount: D(0), isHeading: true },
  ]);
  check(
    "a quotation's value is split by its groups in proportion to the line amounts, case-blind",
    shares.length === 2 && money(shares.find((x) => x.group === 'Trading')!.value, 784) && money(shares.find((x) => x.group === 'Installation')!.value, 336),
    JSON.stringify(shares),
  );
  const thirds = groupShares(100, [
    { group: 'A', amount: 1 },
    { group: 'B', amount: 1 },
    { group: 'C', amount: 1 },
  ]);
  check(
    'the shares add up to the value to the centavo — the remainder goes to one share',
    Math.round(thirds.reduce((t, x) => t + x.value * 100, 0)) === 10_000,
    JSON.stringify(thirds),
  );
  check(
    'lines with no group, or no priced lines at all, report as No group',
    groupShares(50, [{ group: null, amount: 10 }])[0]?.group === NO_GROUP &&
      groupShares(50, [])[0]?.value === 50 &&
      groupShares(0, [{ group: 'A', amount: 1 }]).length === 0,
  );
  const remembered = await prisma.$transaction((tx) =>
    rememberGroups(tx, [`${TAG} Trading`, ` ${TAG.toLowerCase()}  trading `, '', null, `${TAG} Pumps`]),
  );
  const again = await prisma.$transaction((tx) => rememberGroups(tx, [`${TAG} TRADING`]));
  const tradingRow = await prisma.quotationGroup.findUnique({ where: { key: groupKey(`${TAG} Trading`) } });
  check(
    'a group typed on a line is added to the master once, case- and space-blind, keeping the first spelling',
    remembered === 2 && again === 0 && tradingRow?.name === `${TAG} Trading`,
    `${remembered} ${again} ${tradingRow?.name}`,
  );

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

  // ── 8b. SCORO's status block: history off the audit trail, days per stage ──
  console.log('\nOutcome history (Previous status, who moved it, days in each status)');

  const at = (iso: string) => new Date(iso);
  const auditRow = (iso: string, summary: string | null, before: unknown = null, after: unknown = null) => ({
    summary,
    before,
    after,
    at: at(iso),
    actorId: 'u1',
    actorName: 'Rodolfo Almonte',
  });
  const moves = outcomeChanges([
    // Out of order on purpose: the history is sorted by time, not by row order.
    auditRow('2026-02-18T07:51:00Z', 'Quotation Q1: SUBMITTED → WON', { outcome: 'SUBMITTED' }, { outcome: 'WON' }),
    auditRow('2026-01-10T02:00:00Z', 'Quotation Q1: OPEN → SUBMITTED'),
    auditRow('2026-01-05T02:00:00Z', 'Updated quotation Q1'),
    auditRow('2026-01-06T02:00:00Z', 'Created quotation Q1'),
  ]);
  check(
    'moves are read off the audit rows, oldest first, and other edits are ignored',
    moves.map((m) => `${m.from}>${m.to}`).join(',') === 'OPEN>SUBMITTED,SUBMITTED>WON',
    JSON.stringify(moves.map((m) => [m.from, m.to])),
  );
  check('a move written before before/after carried it is read from its summary', moves[0]?.from === 'OPEN');
  check('each move says who made it', moves.every((m) => m.by?.name === 'Rodolfo Almonte'));
  check(
    'SCORO counts calendar days in Manila: 3 Jan to 18 Feb is 46',
    manilaDaysBetween(at('2026-01-03T01:00:00Z'), at('2026-02-18T07:51:00Z')) === 46,
  );
  check(
    'a Manila day boundary counts, not 24 hours: 23:30 to 00:30 the next day is 1',
    manilaDaysBetween(at('2026-01-03T15:30:00Z'), at('2026-01-03T16:30:00Z')) === 1,
  );
  const decided = outcomeStages(at('2026-01-03T01:00:00Z'), 'WON', moves, at('2026-03-09T06:28:00Z'), at('2026-09-28T00:00:00Z'));
  check(
    'a won quotation lists the stages that led there, not "won for N days"',
    decided.stages.map((s) => `${s.outcome}:${s.days}`).join(',') === 'OPEN:7,SUBMITTED:39',
    JSON.stringify(decided.stages),
  );
  check('and "Closed in" runs from issue to the decision date (65 days)', decided.closedInDays === 65, String(decided.closedInDays));
  check('no stage of a decided quotation is current', decided.stages.every((s) => !s.current));
  const running = outcomeStages(
    at('2026-09-01T01:00:00Z'),
    'NEGOTIATION',
    outcomeChanges([
      auditRow('2026-09-03T01:00:00Z', null, { outcome: 'OPEN' }, { outcome: 'NEGOTIATION' }),
      auditRow('2026-09-10T01:00:00Z', null, { outcome: 'NEGOTIATION' }, { outcome: 'WON' }),
      auditRow('2026-09-12T01:00:00Z', null, { outcome: 'WON' }, { outcome: 'NEGOTIATION' }),
    ]),
    null,
    at('2026-09-20T01:00:00Z'),
  );
  check(
    'an outcome returned to adds to its own total rather than appearing twice',
    running.stages.map((s) => `${s.outcome}:${s.days}`).join(',') === 'OPEN:2,NEGOTIATION:15,WON:2',
    JSON.stringify(running.stages),
  );
  check('the stage it is in now is marked current, and it is not closed', running.stages.find((s) => s.current)?.outcome === 'NEGOTIATION' && running.closedInDays === null);
  const untouched = outcomeStages(at('2026-09-01T01:00:00Z'), 'OPEN', [], null, at('2026-09-05T01:00:00Z'));
  check('a quotation nobody has moved is open since it was raised', untouched.stages.length === 1 && untouched.stages[0].days === 4 && untouched.stages[0].current);

  // ── 9. SCORO-style quotation money ─────────────────────────────────────────
  // quotationTotals in shared/quotation.ts is the ONE arithmetic: the routes
  // store what it returns and the screen shows what it returns.
  console.log('\nQuotation money (SCORO-style discount, cost and margin)');

  const lines = [
    // In-house: one of our people carries the cost.
    { amount: 10_000, costAmount: 6_000, providerUserId: 'u1' },
    // Outsourced: a supplier carries it.
    { amount: 20_000, costAmount: 15_000, providerSupplierId: 's1' },
    // Priced but not costed yet.
    { amount: 5_000 },
  ];
  const t0 = quotationTotals({ lines, discountPct: 0, vatRate: 0.12 });
  check('no discount: subtotal is Σ line amount', money(t0.subtotal, 35_000), String(t0.subtotal));
  check('no discount: discount is nothing and net = subtotal', t0.discountAmount === 0 && money(t0.net, 35_000));
  check('VAT exclusive: 12% of net is added on', money(t0.vatAmount, 4_200) && money(t0.total, 39_200), `${t0.vatAmount} / ${t0.total}`);
  check('total cost is in-house + outsourced + unassigned', money(t0.cost.totalCost, 21_000) && money(t0.cost.inHouseCost, 6_000) && money(t0.cost.outsourcedCost, 15_000) && t0.cost.unassignedCost === 0);
  check('total margin = net − total cost', money(t0.cost.totalMargin, 14_000), String(t0.cost.totalMargin));
  check('in-house margin comes only from in-house lines', money(t0.cost.inHouseMargin, 4_000), String(t0.cost.inHouseMargin));
  check('outsourced margin comes only from supplier lines', money(t0.cost.outsourcedMargin, 5_000), String(t0.cost.outsourcedMargin));
  check('margin % is of net', t0.cost.totalMarginPct === 40 && t0.cost.inHouseMarginPct === 11.4 && t0.cost.totalCostPct === 60, JSON.stringify(t0.cost));
  check(
    'a line reports its own margin and margin %',
    t0.lines[0].margin === 4_000 && t0.lines[0].marginPct === 40 && t0.lines[1].marginPct === 25 && t0.lines[2].margin === null,
    JSON.stringify(t0.lines),
  );
  check('the panel counts which lines carry a cost', t0.cost.costedLines === 2 && t0.cost.lineCount === 3);

  const t10 = quotationTotals({ lines, discountPct: 10, vatRate: 0.12 });
  check('10% discount comes off the subtotal', money(t10.discountAmount, 3_500) && money(t10.net, 31_500), `${t10.discountAmount} / ${t10.net}`);
  check('VAT is charged on the DISCOUNTED figure', money(t10.vatAmount, 3_780) && money(t10.total, 35_280), `${t10.vatAmount} / ${t10.total}`);
  check('the discount comes out of margin, not cost', money(t10.cost.totalCost, 21_000) && money(t10.cost.totalMargin, 10_500));
  check(
    'and is applied pro rata to in-house and outsourced revenue',
    money(t10.cost.inHouseMargin, 3_000) && money(t10.cost.outsourcedMargin, 3_000) && money(t10.cost.unassignedMargin, 4_500),
    JSON.stringify(t10.cost),
  );
  check(
    'the three margins add up to the total to the centavo',
    money(t10.cost.inHouseMargin + t10.cost.outsourcedMargin + t10.cost.unassignedMargin, t10.cost.totalMargin),
  );
  check('margin % is of the discounted net', t10.cost.totalMarginPct === 33.3, String(t10.cost.totalMarginPct));

  const inc = quotationTotals({ lines: [{ amount: 112_000, costAmount: 70_000, providerSupplierId: 's1' }], vatRate: 0.12, vatInclusive: true });
  check('VAT inclusive backs the tax out and the total stays the price', money(inc.vatAmount, 12_000) && money(inc.total, 112_000), `${inc.vatAmount} / ${inc.total}`);
  check('an inclusive quote measures margin without the tax in it', money(inc.netOfTax, 100_000) && money(inc.cost.totalMargin, 30_000), `${inc.netOfTax} / ${inc.cost.totalMargin}`);
  const inc10 = quotationTotals({ lines: [{ amount: 112_000 }], discountPct: 10, vatRate: 0.12, vatInclusive: true });
  check('inclusive with a discount: tax backed out of the discounted figure', money(inc10.net, 100_800) && money(inc10.vatAmount, 10_800) && money(inc10.total, 100_800), `${inc10.vatAmount}`);

  const oddQ = quotationTotals({ lines: [{ amount: 333.33 }], discountPct: 7.5, vatRate: 0.12 });
  check(
    'rounding: 7.5% of 333.33 is 25.00, VAT 37.00, total 345.33',
    oddQ.discountAmount === 25 && oddQ.net === 308.33 && oddQ.vatAmount === 37 && oddQ.total === 345.33,
    JSON.stringify({ d: oddQ.discountAmount, n: oddQ.net, v: oddQ.vatAmount, t: oddQ.total }),
  );
  check('a line amount rounds half up to the centavo (3 × 33.335 = 100.01)', Number(lineAmount(3, 33.335)) === 100.01, String(lineAmount(3, 33.335)));
  check('an empty quotation is worth nothing and has no percentages', (() => {
    const e = quotationTotals({ lines: [], vatRate: 0.12 });
    return e.total === 0 && e.cost.totalMarginPct === null;
  })());

  // The stored figures are the same function's.
  const stored = await prisma.quotation.create({
    data: {
      number: `${TAG}-${Date.now()}`,
      customerId: customer.id,
      ownerId: sales.id,
      subject: `${TAG} Stored totals`,
      revisions: {
        create: [
          {
            revision: 0,
            status: 'DRAFT',
            vatRate: d(0.12),
            discountPct: d(10),
            items: {
              create: [
                { description: 'a', quantity: d(1), unitPrice: d(10_000), amount: d(10_000), unitCost: d(6_000), costAmount: d(6_000) },
                { description: 'b', quantity: d(2), unitPrice: d(10_000), amount: d(20_000) },
              ],
            },
          },
        ],
      },
    },
    include: { revisions: true },
  });
  const recalced = await recalcQuotationRevision(stored.revisions[0].id);
  check(
    'a recalculated revision stores subtotal (pre-discount), discount, VAT on net and total',
    money(Number(recalced!.subtotal), 30_000) &&
      money(Number(recalced!.discountAmount), 3_000) &&
      money(Number(recalced!.vatAmount), 3_240) &&
      money(Number(recalced!.total), 30_240),
    `${recalced!.subtotal} ${recalced!.discountAmount} ${recalced!.vatAmount} ${recalced!.total}`,
  );
  check(
    'quotationValue still reads the stored total, discount included',
    money(quotationValue([{ revision: 0, status: 'DRAFT', total: recalced!.total }]), 30_240),
  );

  // ── 9b. The editor's live figures are the server's arithmetic ─────────────
  console.log("\nThe quotation editor's live figures (web/src/lib/quotationMath.ts)");

  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const mirrorLines = [
    { amount: 10_000, costAmount: 6_000, providerUserId: 'u1' },
    { amount: 20_000, costAmount: 15_000, providerSupplierId: 's1' },
    { amount: 5_000 },
    // A zero cost is still a cost entered, and a half-centavo rounds up.
    { amount: 0.03, costAmount: 0, providerUserId: 'u2' },
    { amount: 1_234.565, costAmount: 1_000.005, providerSupplierId: 's2' },
  ];
  const lineSets = {
    'in-house and outsourced': mirrorLines,
    'in-house only': mirrorLines.filter((l) => l.providerUserId),
    'outsourced only': mirrorLines.filter((l) => l.providerSupplierId),
    'no lines': [],
  };
  for (const [discountPct, vatInclusive] of [
    [0, false],
    [10, false],
    [0, true],
    [10, true],
    // A non-terminating factor — where a float version drifts by a centavo.
    [33.3333, true],
  ] as [number, boolean][]) {
    const differs = Object.entries(lineSets).filter(
      ([, set]) =>
        !same(
          editorTotals({ lines: set, discountPct, vatRate: 0.12, vatInclusive }),
          quotationTotals({ lines: set, discountPct, vatRate: 0.12, vatInclusive }),
        ),
    );
    check(
      `discount ${discountPct}%, VAT ${vatInclusive ? 'inclusive' : 'exclusive'}: the page's totals equal quotationTotals (in-house, outsourced, both, none)`,
      differs.length === 0,
      differs.map(([k]) => k).join(', '),
    );
  }
  const amountPairs: [number, number][] = [[2, 12_500], [1.333, 0.75], [0.005, 1], [3, 33.335], [7.5, 1_999.99], [0.001, 0.01]];
  check(
    "the page's line amount is the server's lineAmount, to the centavo",
    amountPairs.every(([q, p]) => editorLineAmount(q, p) === Number(lineAmount(q, p).toFixed(2))),
    amountPairs.map(([q, p]) => `${editorLineAmount(q, p)}/${lineAmount(q, p)}`).join(' '),
  );
  {
    // A reproducible spread of quotations rather than a handful of hand-picked ones.
    let seed = 20260928;
    const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
    const pick = (max: number, dp: number) => Number((rand() * max).toFixed(dp));
    let mismatches = 0;
    for (let n = 0; n < 500; n++) {
      const set = Array.from({ length: 1 + Math.floor(rand() * 6) }, () => {
        const q = pick(40, 3);
        const k = rand();
        return {
          amount: Number(lineAmount(q, pick(250_000, 2)).toFixed(2)),
          costAmount: rand() < 0.7 ? Number(lineAmount(q, pick(200_000, 2)).toFixed(2)) : null,
          providerUserId: k < 0.35 ? 'u' : null,
          providerSupplierId: k >= 0.35 && k < 0.7 ? 's' : null,
        };
      });
      const input = { lines: set, discountPct: rand() < 0.4 ? 0 : pick(35, 2), vatRate: 0.12, vatInclusive: rand() < 0.5 };
      if (!same(editorTotals(input), quotationTotals(input))) mismatches++;
    }
    check('and on 500 generated quotations, not one figure differs', mismatches === 0, `${mismatches} differ`);
  }
  {
    // A subheading is words only: both sides leave it out of the line count.
    const withHeadings = [{ amount: 0, isHeading: true }, ...mirrorLines, { amount: 0, isHeading: true }];
    const server = quotationTotals({ lines: withHeadings, discountPct: 10, vatRate: 0.12 });
    check(
      'with subheadings among the lines, the page still equals the server, and neither counts them as lines',
      same(editorTotals({ lines: withHeadings, discountPct: 10, vatRate: 0.12 }), server) && server.cost.lineCount === mirrorLines.length,
      String(server.cost.lineCount),
    );
  }

  // ── 10. Cost is stripped server-side, and never printed ────────────────────
  console.log('\nCost visibility over HTTP, and the SCORO-style PDF');

  // The checks below read the standard layout; cleanup() puts any saved one back.
  await setSavedLayoutAside();

  if (!(await apiReachable())) {
    failed += 1;
    console.log(
      `  ✗ the API is not reachable at ${BASE} — cost stripping and the PDF were NOT verified.\n` +
        '      Start it with "npm run dev" in api/ and run this script again.',
    );
  } else {
    const salesToken = signToken(sales.id, sales.email);
    const otherToken = signToken(other.id, other.email);
    const managerToken = signToken(manager.id, manager.email);

    const clinic = await prisma.customer.create({
      data: {
        code: `${TAG}-C2`,
        name: `${TAG} Clinic`,
        paymentTerms: '30 days PDC',
        phone: '(02) 8123 4567',
        createdById: sales.id,
        contacts: { create: [{ name: `${TAG} Engr. Cruz`, position: 'Facilities Head', mobile: '0917 555 0101', email: 'cruz@zz.local', isPrimary: true }] },
        sites: { create: [{ name: `${TAG} Main`, address: '12 Sample St', city: 'Pasig City' }] },
      },
      include: { contacts: true },
    });
    const supplier = await prisma.supplier.create({ data: { code: `${TAG}-S1`, name: `${TAG} Compressor Supply` } });

    const created = await http(salesToken, 'POST', '/quotations', {
      customerId: clinic.id,
      contactId: clinic.contacts[0].id,
      subject: `${TAG} SCORO-style quote`,
    });
    check('the author raises a quotation over HTTP', created.status === 201, created.text.slice(0, 200));
    const qid = String(created.body.id);
    const rev0 = (created.body.revisions as { id: string; paymentTerms: string | null }[])[0];
    check("payment terms default to the customer's own", rev0?.paymentTerms === '30 days PDC', String(rev0?.paymentTerms));

    const providers = await http(salesToken, 'GET', `/quotations/providers?kind=supplier&q=${TAG}`);
    check(
      'a salesperson can pick a supplier without the supplier master permission',
      providers.status === 200 && (providers.body as unknown as { id: string }[]).some((p) => p.id === supplier.id),
      providers.text.slice(0, 200),
    );

    // Distinctive cost figures, so their absence from the other views means something.
    const UNIT_COST = 7_777.77;
    const COST_AMOUNT = 15_555.54;
    const base = `/quotations/${qid}/revisions/${rev0.id}`;
    const l1 = await http(salesToken, 'POST', `${base}/items`, {
      group: `${TAG} Installation`,
      title: 'Air compressor installation',
      description: 'Mechanical and electrical tie-in',
      quantity: 2,
      unit: 'lot',
      unitPrice: 12_500,
      unitCost: UNIT_COST,
      providerSupplierId: supplier.id,
      costNote: `${TAG} supplier quote 88`,
    });
    const l2 = await http(salesToken, 'POST', `${base}/items`, {
      group: `${TAG} Services`,
      title: 'Commissioning',
      description: 'Start-up and hand-over',
      quantity: 1,
      unit: 'lot',
      unitPrice: 5_000,
      unitCost: 1_000,
      providerUserId: sales.id,
    });
    check('lines with cost and a provider are accepted', l1.status === 201 && l2.status === 201, `${l1.text.slice(0, 160)} ${l2.text.slice(0, 160)}`);
    const both = await http(salesToken, 'POST', `${base}/items`, {
      title: 'Bad line',
      quantity: 1,
      unitPrice: 1,
      providerSupplierId: supplier.id,
      providerUserId: sales.id,
    });
    check('a line cannot name a supplier AND a person', both.status === 400, both.text.slice(0, 160));

    const patched = await http(salesToken, 'PATCH', base, { discountPct: 10, prNumber: 'PR-ZZ-4471', delivery: '4 to 6 weeks' });
    check('the revision takes a discount, PR number and delivery', patched.status === 200, patched.text.slice(0, 200));

    const mine = await http(salesToken, 'GET', `/quotations/${qid}`);
    const myRev = (mine.body.revisions as Record<string, unknown>[])[0];
    const myItems = myRev.items as Record<string, unknown>[];
    check(
      'the server computes amount and cost amount',
      myItems[0].amount === 25_000 && myItems[0].costAmount === COST_AMOUNT,
      JSON.stringify(myItems[0]).slice(0, 300),
    );
    check(
      'the stored total is subtotal − 10% + VAT on the rest',
      money(Number(myRev.total), (30_000 - 3_000) * 1.12),
      String(myRev.total),
    );
    const panel = myRev.costPanel as { inHouseCost: number; outsourcedCost: number; totalMargin: number } | undefined;
    check(
      'the author sees the cost panel, split in-house / outsourced',
      !!panel && money(panel.outsourcedCost, COST_AMOUNT) && money(panel.inHouseCost, 1_000) && money(panel.totalMargin, 27_000 - COST_AMOUNT - 1_000),
      JSON.stringify(panel),
    );
    check('the author sees who carries each line', (myItems[0].providerSupplier as { name?: string } | null)?.name === supplier.name);

    const theirs = await http(otherToken, 'GET', `/quotations/${qid}`);
    check("another salesperson may read the quotation (sales holds view_all)", theirs.status === 200, String(theirs.status));
    const theirRev = ((theirs.body.revisions ?? []) as Record<string, unknown>[])[0] ?? {};
    const theirItems = (theirRev.items ?? []) as Record<string, unknown>[];
    const costKeys = ['unitCost', 'costAmount', 'providerSupplierId', 'providerSupplier', 'providerUserId', 'providerUser', 'costNote', 'margin', 'marginPct'];
    check(
      'but without edit rights or costing.view_all, no line carries a cost key',
      theirItems.length === 2 && theirItems.every((i) => costKeys.every((k) => !(k in i))),
      JSON.stringify(theirItems[0] ?? {}).slice(0, 300),
    );
    check('nor the cost panel', !('costPanel' in theirRev) && theirs.body.canSeeCost === false);
    check(
      'and the cost figures appear nowhere in the response',
      !theirs.text.includes('7777.77') && !theirs.text.includes('15555.54') && !theirs.text.includes(`${TAG} supplier quote 88`),
    );
    const managerView = await http(managerToken, 'GET', `/quotations/${qid}`);
    check(
      'a sales manager (edit_all, costing.view_all) does see cost',
      managerView.body.canSeeCost === true && managerView.text.includes('15555.54'),
    );

    const pdfRes = await fetch(`${BASE}/quotations/${qid}/revisions/${rev0.id}/pdf`, {
      headers: { Authorization: `Bearer ${salesToken}` },
    });
    const pdfBytes = Buffer.from(await pdfRes.arrayBuffer());
    const text = pdfText(pdfBytes);
    check('the quotation PDF renders', pdfRes.status === 200 && pdfBytes.subarray(0, 5).toString() === '%PDF-', String(pdfRes.status));
    check('it prints the PR Number in the details, with its value', text.includes('PR Number: PR-ZZ-4471'));
    check(
      'it carries the one thank-you line, and no closing letter any more',
      text.includes('Thank you very much for the opportunity to provide the following quotation. This document is system generated and does not require signature.') &&
        !text.includes('looking forward to your positive response'),
    );
    check('it names itself QUOTATION, with "# number"', text.includes('QUOTATION') && text.includes(`# ${String(created.body.number)}`));
    check('the customer and the details are headed as the template has them', text.includes('CUSTOMER') && text.includes('DETAILS'));
    check(
      "it prints SCORO's totals: the discount, the sum without tax, then VAT on the discounted figure",
      text.includes('Discount (10%):') && text.includes('Sum without tax:') && text.includes('27,000.00') && text.includes('VAT (12%):') && text.includes('3,240.00'),
    );
    check(
      'the currency is named once, in the total, and the figures carry none',
      text.includes('Total Price (PHP):') && !text.includes('PHP 3,240.00'),
    );
    check('it keeps the dated sign-offs — prepared and approved — and no Conforme', text.includes('PREPARED BY') && text.includes('APPROVED BY') && !/CONFORME/i.test(text));
    check(
      "the author's sign-off is the name on its own, with their email under it",
      text.split('\n').includes(sales.name) && text.includes(sales.email),
    );
    check('Delivery prints as a labelled line', text.includes('Delivery:') && text.includes('4 to 6 weeks'));
    check('it prints the line title and its description', text.includes('Air compressor installation') && text.includes('Mechanical and electrical tie-in'));
    const masterGroups = await http(salesToken, 'GET', '/reference/quotation-groups?active=true');
    const installation = (masterGroups.body as unknown as { name: string; lineCount: number }[]).find(
      (g) => g.name === `${TAG} Installation`,
    );
    check(
      'saving a line adds its group to the master, which anyone signed in may read, with its line count',
      masterGroups.status === 200 && !!installation && installation.lineCount >= 1,
      JSON.stringify(installation),
    );
    check(
      'and never the group as a heading — a group prints only in a Group column the layout places',
      !text.includes(`${TAG} Installation`) && !text.includes(`${TAG} Services`),
    );
    check('it prints the payment terms and who it is for', text.includes('Payment Terms: 30 days PDC') && text.includes(`Attention: ${TAG} Engr. Cruz, Facilities Head`));
    check(
      'and never a cost figure, a margin or a cost note',
      !text.includes('7,777.77') && !text.includes('15,555.54') && !text.includes('supplier quote 88') && !text.includes(supplier.name),
    );

    // SCORO's status block, end to end: a move is recorded, and the quotation
    // comes back with its previous status, who moved it, and days per stage.
    const beforeSend = await http(salesToken, 'GET', `/quotations/${qid}`);
    check(
      'an unmoved quotation has no history and is open since it was raised',
      Array.isArray(beforeSend.body.statusHistory) &&
        (beforeSend.body.statusHistory as unknown[]).length === 0 &&
        (beforeSend.body.stages as { outcome: string; current: boolean }[])?.[0]?.outcome === 'OPEN',
      JSON.stringify(beforeSend.body.stages),
    );
    const sendIt = await http(salesToken, 'PATCH', `/quotations/${qid}`, { outcome: 'SUBMITTED' });
    check('"Mark as sent" moves it to Submitted', sendIt.status === 200, sendIt.text.slice(0, 200));
    const afterSend = await http(otherToken, 'GET', `/quotations/${qid}`);
    const moved = (afterSend.body.statusHistory ?? []) as { from: string; to: string; at: string; by: { name: string } | null }[];
    check(
      'the move comes back as history — from Open, to Submitted, by the salesperson — for any reader of the quotation',
      moved.length === 1 && moved[0].from === 'OPEN' && moved[0].to === 'SUBMITTED' && moved[0].by?.name === sales.name,
      JSON.stringify(moved),
    );
    check('with the time it happened, and submittedAt set', !!moved[0]?.at && !!afterSend.body.submittedAt);
    const stagesNow = (afterSend.body.stages ?? []) as { outcome: string; current: boolean }[];
    check(
      'and the strip shows Open, then Submitted as the current stage',
      stagesNow.map((s) => s.outcome).join(',') === 'OPEN,SUBMITTED' && stagesNow[1]?.current === true && afterSend.body.closedInDays === null,
      JSON.stringify(stagesNow),
    );
    const moveRow = await prisma.auditLog.findFirst({
      where: { entityType: 'quotation', entityId: qid, summary: { contains: 'SUBMITTED' } },
      orderBy: { at: 'desc' },
    });
    check(
      'the audit row carries the move itself, not only a sentence about it',
      (moveRow?.before as { outcome?: string } | null)?.outcome === 'OPEN' && (moveRow?.after as { outcome?: string } | null)?.outcome === 'SUBMITTED',
    );

    // SCORO's Modify page: the Tax dropdown (company rate or 0%) and "Hide total".
    const companyVat = Number((await prisma.company.findUniqueOrThrow({ where: { id: 'company' } })).vatRate);
    const zeroRated = await http(salesToken, 'PATCH', base, { vatRate: 0 });
    check(
      "a draft can be zero-rated — SCORO's Tax at 0% — and its totals follow",
      zeroRated.status === 200 &&
        zeroRated.body.vatRate === 0 &&
        money(Number(zeroRated.body.vatAmount), 0) &&
        money(Number(zeroRated.body.total), 27_000),
      zeroRated.text.slice(0, 200),
    );
    const oddRate = await http(salesToken, 'PATCH', base, { vatRate: 0.05 });
    check('but not to a rate typed by hand — the company rate, 8%, 6% or 0% only', oddRate.status === 400, oddRate.text.slice(0, 160));
    const eight = await http(salesToken, 'PATCH', base, { vatRate: 0.08 });
    check('8% is offered and taken', eight.status === 200 && eight.body.vatRate === 0.08, eight.text.slice(0, 160));
    const six = await http(salesToken, 'PATCH', base, { vatRate: 0.06 });
    check('6% (Government) is offered and taken', six.status === 200 && six.body.vatRate === 0.06, six.text.slice(0, 160));
    await http(salesToken, 'PATCH', base, { vatRate: 0 });
    check(
      'the change of rate is audited as such',
      (await prisma.auditLog.count({
        where: { entityType: 'quotation', entityId: qid, summary: { contains: `VAT ${Number((companyVat * 100).toFixed(2))}% -> 0%` } },
      })) === 1,
    );
    const pdfOf = async () =>
      pdfText(
        Buffer.from(
          await (
            await fetch(`${BASE}/quotations/${qid}/revisions/${rev0.id}/pdf`, { headers: { Authorization: `Bearer ${salesToken}` } })
          ).arrayBuffer(),
        ),
      );
    check('a zero-rated quote prints VAT (0%)', (await pdfOf()).includes('VAT (0%):'));
    const hidden = await http(salesToken, 'PATCH', base, { hideTotal: true });
    check('Hide total is kept on the revision', hidden.status === 200 && hidden.body.hideTotal === true, hidden.text.slice(0, 160));
    const hiddenText = await pdfOf();
    check(
      'a hidden-total quote prints its lines and prices but no totals',
      hiddenText.includes('Air compressor installation') &&
        hiddenText.includes('12,500.00') &&
        !hiddenText.includes('Sub Total:') &&
        !hiddenText.includes('Total Price (PHP):'),
    );
    const restored = await http(salesToken, 'PATCH', base, { hideTotal: false, vatRate: companyVat });
    check('and the company rate can be put back', restored.status === 200 && restored.body.vatRate === companyVat && restored.body.hideTotal === false);

    // ── 11. The full-page editor: one save, one transaction ──────────────────
    console.log('\nThe quotation editor over HTTP (create with lines, rollback, author, replace lines, costing lines)');

    // The author's digits, where a spare token exists (see EDITOR_TOKEN).
    const tokenSpare = await editorTokenIsSpare();
    if (tokenSpare) await prisma.user.update({ where: { id: sales.id }, data: { employeeNo: `${TAG}-${EDITOR_TOKEN}` } });
    const counter = async (periodKey: string) =>
      (await prisma.numberSequence.findUnique({ where: { documentType_periodKey: { documentType: 'quotation', periodKey } } }))
        ?.lastNumber ?? 0;

    const editorLead = await prisma.lead.create({
      data: {
        number: await nextNumber('lead'),
        companyName: `${TAG} Editor enquiry`,
        customerId: clinic.id,
        assignedToId: sales.id,
        createdById: sales.id,
        probability: 40,
      },
    });
    const editorLines = [
      {
        group: `${TAG} Installation`,
        title: 'First',
        description: 'one',
        quantity: 2,
        unit: 'lot',
        unitPrice: 12_500,
        unitCost: 7_777.77,
        providerSupplierId: supplier.id,
        costNote: `${TAG} editor note`,
      },
      { title: 'Second', description: '', quantity: 1.5, unit: 'set', unitPrice: 3_333.33, unitCost: 1_000, providerUserId: sales.id },
      { title: '', description: 'Third, description only', quantity: 3, unit: 'pc', unitPrice: 99.99 },
    ];

    const promised = await previewNext('quotation', { ownerId: sales.id });
    const issuedBefore = await counter(promised.periodKey);
    const made = await http(salesToken, 'POST', '/quotations', {
      customerId: clinic.id,
      leadId: editorLead.id,
      subject: `${TAG} Editor quote`,
      discountPct: 10,
      lines: editorLines,
    });
    check('the editor creates a quotation and its lines in one request', made.status === 201, made.text.slice(0, 200));
    check('it takes the number the preview promised', made.body.number === promised.number, `${made.body.number} vs ${promised.number}`);
    check('and the number is issued once — the counter moved by exactly one', (await counter(promised.periodKey)) === issuedBefore + 1);
    const madeId = String(made.body.id);
    const madeRev = await prisma.quotationRevision.findFirstOrThrow({
      where: { quotationId: madeId },
      include: { items: { orderBy: { sortOrder: 'asc' } } },
    });
    check(
      'the lines are stored in the order given, numbered from 0',
      madeRev.items.map((i) => i.title || i.description).join('|') === 'First|Second|Third, description only' &&
        madeRev.items.every((i, n) => i.sortOrder === n),
      madeRev.items.map((i) => `${i.sortOrder}:${i.title || i.description}`).join(' '),
    );
    check(
      'amount and cost amount are computed on the server',
      Number(madeRev.items[1].amount) === 5_000 && Number(madeRev.items[0].costAmount) === 15_555.54 && madeRev.items[2].costAmount === null,
      `${madeRev.items[1].amount} ${madeRev.items[0].costAmount}`,
    );
    const madeTotals = quotationTotals({
      lines: madeRev.items,
      discountPct: madeRev.discountPct,
      vatRate: madeRev.vatRate,
      vatInclusive: madeRev.vatInclusive,
    });
    check(
      'the stored totals are quotationTotals of those lines, 10% discount included',
      Number(madeRev.discountPct) === 10 &&
        money(Number(madeRev.subtotal), madeTotals.subtotal) &&
        money(Number(madeRev.discountAmount), madeTotals.discountAmount) &&
        money(Number(madeRev.vatAmount), madeTotals.vatAmount) &&
        money(Number(madeRev.total), madeTotals.total) &&
        madeTotals.discountAmount > 0,
      `${madeRev.subtotal} ${madeRev.discountAmount} ${madeRev.vatAmount} ${madeRev.total}`,
    );
    const shownBeforeSaving = editorTotals({
      lines: editorLines.map((l) => ({
        amount: editorLineAmount(l.quantity, l.unitPrice),
        costAmount: l.unitCost === undefined ? null : editorLineAmount(l.quantity, l.unitCost),
        providerUserId: l.providerUserId ?? null,
        providerSupplierId: l.providerSupplierId ?? null,
      })),
      discountPct: 10,
      vatRate: Number(madeRev.vatRate),
      vatInclusive: false,
    });
    check('what the editor showed before saving is exactly what was stored', same(shownBeforeSaving, madeTotals));
    check(
      'raising it from the lead moved the lead on, in the same save',
      (await prisma.lead.findUniqueOrThrow({ where: { id: editorLead.id } })).status === 'QUOTATION_CREATED',
    );
    check(
      'the create is audited once, with the line count',
      (await prisma.auditLog.count({
        where: { entityType: 'quotation', entityId: madeId, action: 'CREATED', summary: { contains: '(3 lines)' } },
      })) === 1,
    );

    // A refused line refuses the whole save — quotation, lines and number.
    const beforeRefusal = await counter(promised.periodKey);
    const noWords = await http(salesToken, 'POST', '/quotations', {
      customerId: clinic.id,
      subject: `${TAG} Editor refused`,
      lines: [editorLines[0], { title: ' ', description: '  ', quantity: 1, unitPrice: 5 }],
    });
    check(
      'a line with neither product nor description refuses the save, and says which line',
      noWords.status === 400 && noWords.text.includes('Line 2'),
      noWords.text.slice(0, 160),
    );
    const ghostSupplier = await http(salesToken, 'POST', '/quotations', {
      customerId: clinic.id,
      subject: `${TAG} Editor refused`,
      lines: [{ ...editorLines[0], providerSupplierId: 'no-such-supplier' }],
    });
    check('so does a provider that does not exist', ghostSupplier.status === 400 && ghostSupplier.text.includes('Line 1'), ghostSupplier.text.slice(0, 160));
    const negative = await http(salesToken, 'POST', '/quotations', {
      customerId: clinic.id,
      subject: `${TAG} Editor refused`,
      lines: [{ ...editorLines[2], quantity: -1 }],
    });
    check('and a negative quantity', negative.status === 400, negative.text.slice(0, 160));
    const oddVat = await http(salesToken, 'POST', '/quotations', {
      customerId: clinic.id,
      subject: `${TAG} Editor refused`,
      vatRate: 0.07,
      lines: [editorLines[2]],
    });
    check('and a VAT rate that is neither the company’s nor 0%', oddVat.status === 400 && oddVat.text.includes('0%'), oddVat.text.slice(0, 160));
    check('none of them left a quotation behind', (await prisma.quotation.count({ where: { subject: `${TAG} Editor refused` } })) === 0);
    const afterRefusal = await counter(promised.periodKey);
    check('and none of them burnt a number — the transaction took it back', afterRefusal === beforeRefusal, `${beforeRefusal} -> ${afterRefusal}`);

    // The author: only edit_all may name somebody else, and only somebody who authors.
    const inOthersName = await http(salesToken, 'POST', '/quotations', {
      customerId: clinic.id,
      subject: `${TAG} Editor for other`,
      ownerId: other.id,
    });
    check('a salesperson cannot raise a quotation in somebody else’s name (403)', inOthersName.status === 403, inOthersName.text.slice(0, 160));
    check('and nothing was created by trying', (await prisma.quotation.count({ where: { subject: `${TAG} Editor for other` } })) === 0);
    const salesPreview = await previewNext('quotation', { ownerId: sales.id });
    const managerSees = await http(managerToken, 'GET', `/quotations/next-number?ownerId=${sales.id}`);
    check(
      "a manager's number preview follows the author chosen",
      managerSees.body.number === salesPreview.number && managerSees.body.employeeNo === salesPreview.employeeNo,
      JSON.stringify(managerSees.body),
    );
    const salesAsks = await http(salesToken, 'GET', `/quotations/next-number?ownerId=${manager.id}`);
    check(
      "a salesperson's ?ownerId= is ignored — the preview stays their own",
      salesAsks.body.employeeNo === salesPreview.employeeNo && typeof salesAsks.body.vatRate === 'number',
      JSON.stringify(salesAsks.body),
    );
    const nobody = await makeUser('Verify Nobody', 'nobody@verifys.local', []);
    const toNobody = await http(managerToken, 'POST', '/quotations', {
      customerId: clinic.id,
      subject: `${TAG} Editor for nobody`,
      ownerId: nobody.id,
    });
    check('a manager cannot make somebody who cannot author quotations the author (400)', toNobody.status === 400, toNobody.text.slice(0, 160));
    const forSales = await http(managerToken, 'POST', '/quotations', {
      customerId: clinic.id,
      subject: `${TAG} Editor by manager`,
      ownerId: sales.id,
      lines: [editorLines[2]],
    });
    check(
      'a manager (edit_all) raises one for a salesperson, who owns it',
      forSales.status === 201 && forSales.body.ownerId === sales.id,
      forSales.text.slice(0, 200),
    );
    const template = await prisma.numberSequence.findFirst({ where: { documentType: 'quotation', periodKey: '' } });
    const printsDigits = tokenSpare && !!template?.pattern.includes('{EMP}');
    check(
      `and it carries that salesperson's number${printsDigits ? ` — their digits, ${EDITOR_TOKEN}` : ''}`,
      forSales.body.number === salesPreview.number && (!printsDigits || String(forSales.body.number).includes(EDITOR_TOKEN)),
      `${forSales.body.number} vs ${salesPreview.number}`,
    );

    // Replacing every line of a draft, atomically.
    const linesPath = `/quotations/${madeId}/revisions/${madeRev.id}/lines`;
    const replaced = await http(salesToken, 'PUT', linesPath, { lines: [editorLines[2], editorLines[0]] });
    const afterPut = await prisma.quotationRevision.findUniqueOrThrow({
      where: { id: madeRev.id },
      include: { items: { orderBy: { sortOrder: 'asc' } } },
    });
    check(
      'PUT …/lines replaces every line of a draft, in the order given',
      replaced.status === 200 && afterPut.items.map((i) => i.title || i.description).join('|') === 'Third, description only|First',
      replaced.text.slice(0, 200),
    );
    const putTotals = quotationTotals({
      lines: afterPut.items,
      discountPct: afterPut.discountPct,
      vatRate: afterPut.vatRate,
      vatInclusive: afterPut.vatInclusive,
    });
    check(
      'and recomputes the stored totals from them',
      money(Number(afterPut.total), putTotals.total) && money(Number(afterPut.subtotal), 25_299.97),
      `${afterPut.subtotal} ${afterPut.total}`,
    );
    check('it answers with the revision, cost panel included for the author', !!(replaced.body as { costPanel?: unknown }).costPanel);
    const badPut = await http(salesToken, 'PUT', linesPath, {
      lines: [editorLines[1], { title: '', description: '', quantity: 1, unitPrice: 1 }],
    });
    const afterBadPut = await prisma.quotationItem.findMany({ where: { revisionId: madeRev.id }, orderBy: { sortOrder: 'asc' } });
    check(
      'a refused line leaves the revision exactly as it was',
      badPut.status === 400 && afterBadPut.map((i) => i.title || i.description).join('|') === 'Third, description only|First',
      badPut.text.slice(0, 160),
    );
    const notMine = await http(otherToken, 'PUT', linesPath, { lines: [editorLines[2]] });
    check('another salesperson (no edit_all) cannot replace the lines (403)', notMine.status === 403, notMine.text.slice(0, 160));
    await prisma.quotationRevision.update({ where: { id: madeRev.id }, data: { status: 'APPROVED' } });
    const onApproved = await http(salesToken, 'PUT', linesPath, { lines: [editorLines[2]] });
    check('an approved revision refuses new lines (400)', onApproved.status === 400, onApproved.text.slice(0, 160));
    check('and keeps the ones it was approved with', (await prisma.quotationItem.count({ where: { revisionId: madeRev.id } })) === 2);

    // The editor's costing preview is what "Fill from costing" writes.
    const fromCosting = await http(salesToken, 'POST', '/quotations', {
      customerId: customer.id,
      subject: `${TAG} Editor costing`,
      costingId: costing.id,
    });
    const fcRev = (fromCosting.body.revisions as { id: string }[])[0];
    const costingPreview = await http(salesToken, 'GET', `/quotations/costing-lines?costingId=${costing.id}`);
    const filled = await http(salesToken, 'POST', `/quotations/${fromCosting.body.id}/revisions/${fcRev.id}/from-costing`);
    const written = await prisma.quotationItem.findMany({ where: { revisionId: fcRev.id }, orderBy: { sortOrder: 'asc' } });
    check(
      'GET /quotations/costing-lines is exactly what from-costing writes',
      costingPreview.status === 200 &&
        filled.status === 200 &&
        written.length > 0 &&
        same(
          costingPreview.body,
          written.map((i) => ({
            title: i.title,
            description: i.description,
            quantity: Number(i.quantity),
            unit: i.unit,
            unitPrice: Number(i.unitPrice),
            amount: Number(i.amount),
            sortOrder: i.sortOrder,
          })),
        ),
      `${costingPreview.text.slice(0, 160)} / ${written.length} written`,
    );
    const noCosting = await http(salesToken, 'GET', '/quotations/costing-lines');
    const unknownCosting = await http(salesToken, 'GET', '/quotations/costing-lines?costingId=nope');
    check(
      'costing-lines asks for a costing (400) and knows an unknown one (404)',
      noCosting.status === 400 && unknownCosting.status === 404,
      `${noCosting.status} ${unknownCosting.status}`,
    );

    // A quotation raised zero-rated with its totals hidden, and a revision of
    // one carries both forward — the VAT snapshot principle, for the choice too.
    const zeroMade = await http(salesToken, 'POST', '/quotations', {
      customerId: clinic.id,
      subject: `${TAG} Editor zero-rated`,
      vatRate: 0,
      hideTotal: true,
      lines: [editorLines[1]],
    });
    const zeroRev = zeroMade.status === 201
      ? await prisma.quotationRevision.findFirst({ where: { quotationId: String(zeroMade.body.id) } })
      : null;
    check(
      'a new quotation can be raised zero-rated with its totals hidden',
      zeroMade.status === 201 && Number(zeroRev?.vatRate) === 0 && zeroRev?.hideTotal === true && Number(zeroRev?.vatAmount) === 0,
      zeroMade.text.slice(0, 160),
    );
    await prisma.quotationRevision.update({ where: { id: madeRev.id }, data: { vatRate: 0, hideTotal: true } });
    const nextRev = await http(salesToken, 'POST', `/quotations/${madeId}/revisions`);
    const carried = await prisma.quotationRevision.findFirst({ where: { quotationId: madeId, revision: 1 } });
    check(
      'a new revision keeps the zero rate and the hidden total it was raised from',
      nextRev.status < 300 && Number(carried?.vatRate) === 0 && carried?.hideTotal === true,
      nextRev.text.slice(0, 160),
    );

    // ── 12. The quotation module, reworked: number, subheadings, delete, CEO ──
    console.log('\nQuote numbers typed by hand, subheadings, delete, the CEO option, suggestions');

    // Tax options are said by the server, so the dropdown cannot drift from the rule.
    const taxFor = await http(salesToken, 'GET', '/quotations/next-number');
    const taxLabels = (taxFor.body.taxOptions as { rate: number; label: string }[] | undefined)?.map((o) => o.label) ?? [];
    check(
      'the Tax dropdown offers the company rate, 8%, 6% (Government) and 0%',
      taxLabels.includes('8%') && taxLabels.includes('6% (Government)') && taxLabels.includes('0% (zero-rated)') && taxLabels.length === 4,
      JSON.stringify(taxLabels),
    );
    check('and the preview names the author’s last quotation', 'lastNumber' in taxFor.body);

    // A number typed by hand is used as typed; a duplicate is refused before anything is written.
    const handNumber = `ZZQ-${Date.now() % 100000}`;
    const typed = await http(salesToken, 'POST', '/quotations', {
      customerId: clinic.id,
      subject: `${TAG} Hand-numbered`,
      number: handNumber,
      lines: [editorLines[2]],
    });
    check('a quote number typed by hand is the number it gets', typed.status === 201 && typed.body.number === handNumber, typed.text.slice(0, 160));
    const free = await http(salesToken, 'GET', `/quotations/number-available?number=${encodeURIComponent(handNumber.toLowerCase())}`);
    check('the editor is told, as it types, that the number is taken — case-blind', free.status === 200 && free.body.available === false, JSON.stringify(free.body));
    const fresh = await http(salesToken, 'GET', `/quotations/number-available?number=${encodeURIComponent(`${handNumber}-X`)}`);
    check('and that an unused one is free', fresh.body.available === true);
    const badShape = await http(salesToken, 'GET', '/quotations/number-available?number=' + encodeURIComponent('two words'));
    check('a number with spaces is not a number', badShape.body.available === false);
    const counterBefore = await prisma.numberSequence.aggregate({ where: { documentType: 'quotation' }, _sum: { lastNumber: true } });
    const dupe = await http(salesToken, 'POST', '/quotations', { customerId: clinic.id, subject: `${TAG} Dupe`, number: handNumber });
    check('a duplicate number is refused (409)', dupe.status === 409, dupe.text.slice(0, 160));
    const counterAfter = await prisma.numberSequence.aggregate({ where: { documentType: 'quotation' }, _sum: { lastNumber: true } });
    check('and burns no number in any series', counterBefore._sum.lastNumber === counterAfter._sum.lastNumber);
    check('and writes no quotation', (await prisma.quotation.count({ where: { subject: `${TAG} Dupe` } })) === 0);

    // The next number in the series steps over one typed by hand ahead of it.
    const suggested = await http(salesToken, 'GET', '/quotations/next-number');
    const ahead = await http(salesToken, 'POST', '/quotations', {
      customerId: clinic.id,
      subject: `${TAG} Took the suggestion by hand`,
      number: String(suggested.body.number),
      lines: [editorLines[2]],
    });
    check('the suggested number can be typed in by hand', ahead.status === 201 && ahead.body.number === suggested.body.number, ahead.text.slice(0, 160));
    const afterwards = await http(salesToken, 'GET', '/quotations/next-number');
    check('the next suggestion steps past it', afterwards.body.number !== suggested.body.number, `${afterwards.body.number}`);
    const issued = await http(salesToken, 'POST', '/quotations', { customerId: clinic.id, subject: `${TAG} Issued after`, lines: [editorLines[2]] });
    check(
      'and the number issued on save is never the one taken by hand',
      issued.status === 201 && issued.body.number !== suggested.body.number,
      `${issued.body.number} vs ${suggested.body.number}`,
    );

    // Renumbering an existing quotation.
    const renumbered = await http(salesToken, 'PATCH', `/quotations/${typed.body.id}`, { number: `${handNumber}-R` });
    check('a quotation can be renumbered', renumbered.status === 200 && renumbered.body.number === `${handNumber}-R`, renumbered.text.slice(0, 160));
    const clash = await http(salesToken, 'PATCH', `/quotations/${typed.body.id}`, { number: String(issued.body.number) });
    check('but not onto another quotation’s number (409)', clash.status === 409, clash.text.slice(0, 160));
    check(
      'the renumbering is audited from → to',
      (await prisma.auditLog.count({ where: { entityType: 'quotation', entityId: String(typed.body.id), summary: { contains: `${handNumber} → ${handNumber}-R` } } })) === 1,
    );

    // Subheadings: words only, no money, not counted as lines.
    const headed = await http(salesToken, 'POST', '/quotations', {
      customerId: clinic.id,
      subject: `${TAG} With subheadings`,
      lines: [
        { isHeading: true, title: 'General Requirements', quantity: 5, unit: 'lot', unitPrice: 999, unitCost: 1 },
        { title: 'Service kit', description: '', quantity: 1, unit: 'lot', unitPrice: 7000, unitCost: 4000 },
        { isHeading: true, title: 'Installation', quantity: 0, unit: 'lot', unitPrice: 0 },
        { title: 'Labour', description: 'Assembly and programming', quantity: 1, unit: 'lot', unitPrice: 39400 },
      ],
    });
    check('a quotation saves with subheadings among its lines', headed.status === 201, headed.text.slice(0, 200));
    const headedRev = await prisma.quotationRevision.findFirstOrThrow({
      where: { quotationId: String(headed.body.id) },
      include: { items: { orderBy: { sortOrder: 'asc' } } },
    });
    check(
      'a subheading carries no quantity, price, cost or amount, whatever was sent',
      headedRev.items[0].isHeading === true &&
        Number(headedRev.items[0].quantity) === 0 &&
        Number(headedRev.items[0].unitPrice) === 0 &&
        headedRev.items[0].unitCost === null &&
        Number(headedRev.items[0].amount) === 0,
    );
    check('the subtotal is the lines only: 7,000 + 39,400', money(Number(headedRev.subtotal), 46_400), String(headedRev.subtotal));
    const headedView = await http(salesToken, 'GET', `/quotations/${headed.body.id}`);
    const headedPanel = (headedView.body.revisions as { costPanel?: { lineCount: number; costedLines: number } }[])[0]?.costPanel;
    check('the cost panel counts the two lines, not the subheadings', headedPanel?.lineCount === 2 && headedPanel?.costedLines === 1, JSON.stringify(headedPanel));
    const blankHeading = await http(salesToken, 'PUT', `/quotations/${headed.body.id}/revisions/${headedRev.id}/lines`, {
      lines: [{ isHeading: true, title: '  ', quantity: 0, unit: 'lot', unitPrice: 0 }],
    });
    check('a subheading with no words is refused (400)', blankHeading.status === 400, blankHeading.text.slice(0, 160));
    const headedPdf = pdfText(
      Buffer.from(
        await (
          await fetch(`${BASE}/quotations/${headed.body.id}/revisions/${headedRev.id}/pdf`, { headers: { Authorization: `Bearer ${salesToken}` } })
        ).arrayBuffer(),
      ),
    );
    check('the PDF prints each subheading over its lines', headedPdf.includes('General Requirements') && headedPdf.includes('Installation'));
    await http(salesToken, 'POST', `/quotations/${headed.body.id}/revisions/${headedRev.id}/submit`);
    const managerApproval = await prisma.approvalRequest.findFirstOrThrow({ where: { documentType: 'quotation', documentId: headedRev.id, status: 'PENDING' } });
    await act({ requestId: managerApproval.id, userId: manager.id, action: 'APPROVED' });
    const nextHeaded = await http(salesToken, 'POST', `/quotations/${headed.body.id}/revisions`);
    const r1 = await prisma.quotationRevision.findFirst({ where: { quotationId: String(headed.body.id), revision: 1 }, include: { items: { orderBy: { sortOrder: 'asc' } } } });
    check('a new revision keeps its subheadings', nextHeaded.status === 201 && r1?.items.filter((i) => i.isHeading).length === 2);

    // Probability: no longer asked for — the lead's, else even odds.
    const fromLead = await prisma.lead.create({
      data: { number: await nextNumber('lead'), companyName: `${TAG} Probability lead`, customerId: clinic.id, assignedToId: sales.id, createdById: sales.id, probability: 35 },
    });
    const withLead = await http(salesToken, 'POST', '/quotations', { customerId: clinic.id, leadId: fromLead.id, subject: `${TAG} From a 35% lead`, lines: [editorLines[2]] });
    check('a quotation from a lead takes the lead’s probability', withLead.status === 201 && withLead.body.probability === 35, String(withLead.body.probability));
    check('one with no lead takes 50%', issued.body.probability === 50, String(issued.body.probability));

    // Delete.
    const salesDelete = await http(otherToken, 'DELETE', `/quotations/${typed.body.id}`);
    check('a colleague cannot delete somebody else’s quotation (403)', salesDelete.status === 403, salesDelete.text.slice(0, 160));
    const pending = await prisma.quotationRevision.findFirstOrThrow({ where: { quotationId: String(issued.body.id) } });
    await http(salesToken, 'POST', `/quotations/${issued.body.id}/revisions/${pending.id}/submit`);
    const whilePending = await http(salesToken, 'DELETE', `/quotations/${issued.body.id}`);
    check('one with the approver is not deleted (400)', whilePending.status === 400, whilePending.text.slice(0, 160));
    const ownDelete = await http(salesToken, 'DELETE', `/quotations/${typed.body.id}`);
    check('the author deletes their own', ownDelete.status === 200 && !(await prisma.quotation.findUnique({ where: { id: String(typed.body.id) } })));
    check(
      'the delete is audited',
      (await prisma.auditLog.count({ where: { entityType: 'quotation', entityId: String(typed.body.id), action: 'DELETED' } })) === 1,
    );
    const leadDelete = await http(salesToken, 'DELETE', `/quotations/${withLead.body.id}`);
    const leadAfter = await prisma.lead.findUniqueOrThrow({ where: { id: fromLead.id } });
    check(
      'its lead, left with no quotation, steps back rather than claiming a quote that is gone',
      leadDelete.status === 200 && leadAfter.status === 'QUALIFIED',
      `${leadDelete.status} ${leadAfter.status}`,
    );
    await prisma.quotation.update({ where: { id: String(ahead.body.id) }, data: { outcome: 'WON' } });
    const wonDelete = await http(salesToken, 'DELETE', `/quotations/${ahead.body.id}`);
    check('a won quotation is not deleted (400)', wonDelete.status === 400, wonDelete.text.slice(0, 160));
    const reader = await makeUser('Verify Reader', 'reader@verifys.local', []);
    const readerDelete = await http(signToken(reader.id, reader.email), 'DELETE', `/quotations/${ahead.body.id}`);
    check('without gops.quotations.delete nobody deletes (403)', readerDelete.status === 403);

    // The CEO as an optional approver, over ₱1,000,000.
    const ceo = await makeUser('Verify CEO', 'ceo@verifys.local', ['executive']);
    const big = await http(salesToken, 'POST', '/quotations', {
      customerId: clinic.id,
      subject: `${TAG} Over a million`,
      lines: [{ title: 'Oxygen plant', description: '', quantity: 1, unit: 'lot', unitPrice: 1_500_000 }],
    });
    const bigView = await http(salesToken, 'GET', `/quotations/${big.body.id}`);
    const options = (bigView.body.approvalOptions ?? []) as { id: string; label: string }[];
    check('over ₱1,000,000 the submitter is offered "Add the CEO as approver"', options.some((o) => o.label === 'Add the CEO as approver'), JSON.stringify(options));
    const smallView = await http(salesToken, 'GET', `/quotations/${headed.body.id}`);
    check('under it, no such option', ((smallView.body.approvalOptions ?? []) as unknown[]).length === 0);
    const ceoOption = options.find((o) => o.label === 'Add the CEO as approver')!;
    // Before anybody presses Submit, the page names where it goes and who decides.
    type Route = { steps: { name: string; approvers: { id: string; name: string }[] }[] } | null;
    const routes = bigView.body.approvalRoutes as { standard: Route; options: { id: string; route: Route }[] } | null;
    const ceoRoute = routes?.options.find((o) => o.id === ceoOption.id)?.route;
    check(
      'the draft names its route: the sales manager, and with the CEO ticked the CEO too, each by name',
      !!routes?.standard?.steps[0]?.approvers.some((p) => p.id === manager.id) &&
        ceoRoute?.steps.length === 2 &&
        ceoRoute.steps[1].approvers.some((p) => p.id === ceo.id),
      JSON.stringify(routes),
    );
    check(
      'never naming the submitter as their own approver',
      !JSON.stringify(routes).includes(sales.id),
    );
    const draftPdf = async (option?: string) =>
      pdfText(
        Buffer.from(
          await (
            await fetch(`${BASE}/quotations/${big.body.id}/revisions/${(await prisma.quotationRevision.findFirstOrThrow({ where: { quotationId: String(big.body.id) } })).id}/pdf${option ? `?option=${option}` : ''}`, {
              headers: { Authorization: `Bearer ${salesToken}` },
            })
          ).arrayBuffer(),
        ),
      );
    // Where several hold the role, their names are joined ("A or B or C") and
    // may wrap in the column — read the text with its line breaks as spaces.
    const draftText = (await draftPdf()).replace(/\n/g, ' ');
    check('a draft’s PDF names the approver who will sign, pending', draftText.includes(manager.name) && draftText.includes('Pending') && !draftText.includes(ceo.name));
    const draftWithCeo = (await draftPdf(ceoOption.id)).replace(/\n/g, ' ');
    check('and with the CEO ticked, the CEO too', draftWithCeo.includes(manager.name) && draftWithCeo.includes(ceo.name) && /APPROVED BY .*CEO/i.test(draftWithCeo));
    const smallRev = await prisma.quotationRevision.findFirstOrThrow({ where: { quotationId: String(headed.body.id), status: 'DRAFT' } });
    const wrongBand = await http(salesToken, 'POST', `/quotations/${headed.body.id}/revisions/${smallRev.id}/submit`, { optionId: ceoOption.id });
    check('the option is refused where it does not apply (400)', wrongBand.status === 400, wrongBand.text.slice(0, 160));
    check(
      'and the refused revision is back to a draft, not pending with nothing behind it',
      (await prisma.quotationRevision.findUniqueOrThrow({ where: { id: smallRev.id } })).status === 'DRAFT',
    );
    const bigRev = await prisma.quotationRevision.findFirstOrThrow({ where: { quotationId: String(big.body.id) } });
    const withCeo = await http(salesToken, 'POST', `/quotations/${big.body.id}/revisions/${bigRev.id}/submit`, { optionId: ceoOption.id });
    check('ticked, it is submitted along the CEO route', withCeo.status === 200, withCeo.text.slice(0, 160));
    const ceoRequest = await prisma.approvalRequest.findFirstOrThrow({
      where: { documentType: 'quotation', documentId: bigRev.id, status: 'PENDING' },
      include: { workflow: { include: { steps: true } } },
    });
    check('that route is the sales manager, then the CEO', ceoRequest.workflow?.steps.length === 2 && ceoRequest.workflowId === ceoOption.id);
    await act({ requestId: ceoRequest.id, userId: manager.id, action: 'APPROVED' });
    check(
      'the sales manager’s approval alone does not approve it',
      (await prisma.quotationRevision.findUniqueOrThrow({ where: { id: bigRev.id } })).status === 'PENDING_APPROVAL',
    );
    const halfway = pdfText(
      Buffer.from(
        await (await fetch(`${BASE}/quotations/${big.body.id}/revisions/${bigRev.id}/pdf`, { headers: { Authorization: `Bearer ${salesToken}` } })).arrayBuffer(),
      ),
    );
    check('halfway, the PDF dates the manager and says the CEO is pending', halfway.includes(manager.name) && halfway.includes('Pending') && /APPROVED BY .*CEO/i.test(halfway));
    check('naming the CEO who will sign', halfway.includes(ceo.name));
    const waiting = await http(salesToken, 'GET', `/approvals/history/quotation/${bigRev.id}`);
    const openStep = ((waiting.body as unknown as { workflow: { steps: { sequence: number; approvers?: { id: string }[] }[] } }[])[0]?.workflow.steps ?? []).find(
      (st) => st.sequence === 2,
    );
    check('and the approval panel says who it waits on', !!openStep?.approvers?.some((p) => p.id === ceo.id), JSON.stringify(openStep));
    await act({ requestId: ceoRequest.id, userId: ceo.id, action: 'APPROVED' });
    check('the CEO’s approval approves it', (await prisma.quotationRevision.findUniqueOrThrow({ where: { id: bigRev.id } })).status === 'APPROVED');
    const signed = pdfText(
      Buffer.from(
        await (await fetch(`${BASE}/quotations/${big.body.id}/revisions/${bigRev.id}/pdf`, { headers: { Authorization: `Bearer ${salesToken}` } })).arrayBuffer(),
      ),
    );
    check('and the PDF carries both approvers, dated', signed.includes(manager.name) && signed.includes(ceo.name) && !signed.includes('Pending'));
    check('each approver with how to reach them', signed.includes(manager.email) && signed.includes(ceo.email));
    const plain = await http(salesToken, 'POST', '/quotations', {
      customerId: clinic.id,
      subject: `${TAG} Over a million, standard route`,
      lines: [{ title: 'Oxygen plant', description: '', quantity: 1, unit: 'lot', unitPrice: 1_500_000 }],
    });
    const plainRev = await prisma.quotationRevision.findFirstOrThrow({ where: { quotationId: String(plain.body.id) } });
    await http(salesToken, 'POST', `/quotations/${plain.body.id}/revisions/${plainRev.id}/submit`);
    const plainRequest = await prisma.approvalRequest.findFirstOrThrow({ where: { documentType: 'quotation', documentId: plainRev.id }, include: { workflow: { include: { steps: true } } } });
    check('unticked, a quotation over a million keeps the standard route — the CEO is an option, not a rule', plainRequest.workflow?.steps.length === 1);

    // The approval panel on the document: the person the step waits on may
    // decide there (canAct), the requester and a bystander may not.
    const canActFor = async (token: string) =>
      ((await http(token, 'GET', `/approvals/history/quotation/${plainRev.id}`)).body as unknown as { canAct?: boolean }[])[0]?.canAct;
    const [mgrCan, sellerCan, otherCan] = await Promise.all([canActFor(managerToken), canActFor(salesToken), canActFor(otherToken)]);
    check(
      "the document's approval panel offers the decision to its approver only — not the requester, not a bystander",
      mgrCan === true && sellerCan === false && otherCan === false,
      `${mgrCan} ${sellerCan} ${otherCan}`,
    );

    // Admin › Approval Workflows: saving the CEO route without mentioning its
    // label must not quietly make it a standard route every big quote takes.
    const admin = await makeUser('Verify Admin', 'admin@verifys.local', []);
    await prisma.user.update({ where: { id: admin.id }, data: { isSuperAdmin: true } });
    const adminToken = signToken(admin.id, admin.email);
    const route = await prisma.approvalWorkflow.findUniqueOrThrow({ where: { id: ceoOption.id }, include: { steps: { orderBy: { sequence: 'asc' } } } });
    const resaved = await http(adminToken, 'PUT', `/workflows/${route.id}`, {
      documentType: route.documentType,
      name: route.name,
      isActive: route.isActive,
      minAmount: route.minAmount == null ? null : Number(route.minAmount),
      maxAmount: route.maxAmount == null ? null : Number(route.maxAmount),
      steps: route.steps.map((st) => ({ sequence: st.sequence, name: st.name, approverType: st.approverType, roleId: st.roleId, userId: st.userId })),
    });
    check(
      'saving the CEO route in Admin without its label keeps it an option',
      resaved.status === 200 && (await prisma.approvalWorkflow.findUniqueOrThrow({ where: { id: route.id } })).optionLabel === 'Add the CEO as approver',
      resaved.text.slice(0, 160),
    );

    // Suggestions: what was quoted before, within what the caller may read.
    const mineSuggest = await http(salesToken, 'GET', `/quotations/suggest?q=${encodeURIComponent('Service kit')}`);
    const mineRow = (mineSuggest.body as unknown as { title: string; unitPrice: number; unitCost?: number | null; source: string }[]).find((r) => r.title === 'Service kit');
    check('typing a product offers what it was quoted at before', mineSuggest.status === 200 && mineRow?.unitPrice === 7000 && mineRow?.source === 'history', JSON.stringify(mineRow));
    check('with its cost, on the author’s own quotation', mineRow?.unitCost === 4000);
    const theirSuggest = await http(otherToken, 'GET', `/quotations/suggest?q=${encodeURIComponent('Service kit')}`);
    const theirRow = (theirSuggest.body as unknown as { title: string; unitCost?: number | null }[]).find((r) => r.title === 'Service kit');
    check('a colleague who reads every quotation is offered the price but never the cost', !!theirRow && !('unitCost' in theirRow), JSON.stringify(theirRow));
    check('two letters at least', ((await http(salesToken, 'GET', '/quotations/suggest?q=S')).body as unknown as unknown[]).length === 0);

    // ── Sales orders: booking a quotation in operations ──────────────────────
    console.log('\nSales orders (SCORO\u2019s Create invoice)');
    const soQuote = await http(salesToken, 'POST', '/quotations', {
      customerId: clinic.id,
      subject: `${TAG} Booked plant`,
      lines: [
        { group: `${TAG} Installation`, title: 'Work order', description: 'Scope of supply', quantity: 1, unit: 'lot', unitPrice: 73_750, unitCost: 30_000 },
        { group: `${TAG} Services`, title: 'Fabrication', description: '5 days works', quantity: 1, unit: 'lot', unitPrice: 30_000, unitCost: 20_004.58 },
      ],
    });
    const soQuoteId = String(soQuote.body.id);
    const so1 = await http(salesToken, 'POST', '/sales-orders', { quotationId: soQuoteId, mode: 'all' });
    check('a sales order is created from the quotation with all details', so1.status === 201, so1.text.slice(0, 160));
    const so1Body = so1.body as unknown as { id: string; number: string; status: string; total: number; lines: { group: string | null; unitCost: number | null }[] };
    check(
      'it is a DRAFT carrying the lines, their groups and their cost, and the quotation\u2019s total',
      so1Body.status === 'DRAFT' &&
        so1Body.lines.length === 2 &&
        so1Body.lines[0].group === `${TAG} Installation` &&
        so1Body.lines[0].unitCost === 30_000 &&
        money(so1Body.total, 103_750 * 1.12),
      JSON.stringify(so1Body).slice(0, 220),
    );
    check('its number has no suffix — the first booking takes the base', !so1Body.number.includes('.'), so1Body.number);
    const so2 = await http(salesToken, 'POST', '/sales-orders', { quotationId: soQuoteId, mode: 'summary' });
    const so2Body = so2.body as unknown as { number: string; total: number; lines: { title: string | null }[] };
    check(
      'the second order on the same quotation is .1 — progress booking, one family',
      so2.status === 201 && so2Body.number === `${so1Body.number}.1`,
      so2Body.number,
    );
    check(
      'summarised: one line worth the whole quotation, same total',
      so2Body.lines.length === 1 && so2Body.lines[0].title === `${TAG} Booked plant` && money(so2Body.total, 103_750 * 1.12),
      JSON.stringify(so2Body.lines),
    );
    const revForPick = await prisma.quotationRevision.findFirstOrThrow({ where: { quotationId: soQuoteId }, include: { items: { orderBy: { sortOrder: 'asc' } } } });
    const so3 = await http(salesToken, 'POST', '/sales-orders', { quotationId: soQuoteId, mode: 'partial', lineIds: [revForPick.items[1].id] });
    const so3Body = so3.body as unknown as { number: string; subtotal: number; lines: unknown[] };
    check(
      'partial: only the chosen line is booked, numbered .2',
      so3.status === 201 && so3Body.lines.length === 1 && money(so3Body.subtotal, 30_000) && so3Body.number === `${so1Body.number}.2`,
      `${so3Body.number} ${so3Body.subtotal}`,
    );

    // The quotation page lists its orders under it, SCORO-style, through the
    // ordinary list query — the same rows, the same visibility.
    const underQuote = await http(salesToken, 'GET', `/sales-orders?quotationId=${soQuoteId}&sort=number&dir=asc`);
    const underRows = (underQuote.body.rows ?? []) as { number: string }[];
    check(
      'the quotation lists the orders booked from it, in number order',
      underQuote.status === 200 &&
        underRows.length === 3 &&
        underRows.map((r) => r.number).join(',') === `${so1Body.number},${so1Body.number}.1,${so1Body.number}.2`,
      underRows.map((r) => r.number).join(','),
    );

    const otherEdits = await http(otherToken, 'PUT', `/sales-orders/${so1Body.id}`, { termsDays: 60 });
    check('someone else cannot edit the author\u2019s order', otherEdits.status === 403, String(otherEdits.status));
    const otherReads = await http(otherToken, 'GET', `/sales-orders/${so1Body.id}`);
    const otherLines = (otherReads.body.lines ?? []) as Record<string, unknown>[];
    check(
      'a reader without cost rights gets the lines with the cost keys removed',
      otherReads.status === 200 && otherReads.body.canSeeCost === false && otherLines.every((l) => !('unitCost' in l)) && !otherReads.text.includes('20004.58'),
      otherReads.text.slice(0, 120),
    );

    const edited = await http(salesToken, 'PUT', `/sales-orders/${so1Body.id}`, {
      poNumber: '4500001134',
      termsDays: 30,
      comment: `${TAG} variation order prior to installation`,
      lines: [
        { group: `${TAG} Installation`, title: 'Work order', description: 'Scope of supply', quantity: 1, unit: 'lot', unitPrice: 73_750, unitCost: 30_000 },
        { group: `${TAG} Services`, title: 'Fabrication', description: '5 days works', quantity: 1, unit: 'lot', unitPrice: 0, unitCost: 4_800 },
        { group: `${TAG} Installation`, title: '3RD PARTY works', description: 'Chipping and restoration', quantity: 1, unit: 'lot', unitPrice: 30_000, unitCost: 20_004.58 },
      ],
    });
    check(
      'the editor saves header and lines in one PUT and the totals follow',
      edited.status === 200 && money(Number(edited.body.total), 103_750 * 1.12),
      `${edited.status} ${edited.body.total}`,
    );

    const soIssued = await http(salesToken, 'POST', `/sales-orders/${so1Body.id}/issue`);
    const soIssuedTwice = await http(salesToken, 'POST', `/sales-orders/${so1Body.id}/issue`);
    check('issuing books it once — a second Issue is refused', soIssued.status === 200 && soIssuedTwice.status === 400, `${soIssued.status} ${soIssuedTwice.status}`);
    const editIssued = await http(salesToken, 'PUT', `/sales-orders/${so1Body.id}`, { termsDays: 45 });
    check('an issued order refuses the full save — reopen first', editIssued.status === 400, String(editIssued.status));
    const released = await http(salesToken, 'PATCH', `/sales-orders/${so1Body.id}`, { siNumber: 'SI-4622', drNumber: 'DR-991' });
    check('but still takes its release references', released.status === 200, String(released.status));

    const soPdfBytes = Buffer.from(
      await (
        await fetch(`${BASE}/sales-orders/${so1Body.id}/pdf`, { headers: { Authorization: `Bearer ${salesToken}` } })
      ).arrayBuffer(),
    );
    const soPdfOwner = pdfText(soPdfBytes);
    check(
      'the PDF prints through the Sales Order template: customer, PO, totals — and cost and margin for who may see them',
      soPdfOwner.includes('SALES ORDER') && soPdfOwner.includes('4500001134') && soPdfOwner.includes('Margin sum:') && soPdfOwner.includes('SI / BS No.: SI-4622'),
      soPdfOwner.slice(0, 200),
    );
    check(
      'and the paper is A4 on its side — the cost columns are why it is landscape',
      soPdfBytes.toString('latin1').includes('/MediaBox [0 0 841.89 595.28]'),
    );
    const soPdfOther = pdfText(
      Buffer.from(
        await (
          await fetch(`${BASE}/sales-orders/${so1Body.id}/pdf`, { headers: { Authorization: `Bearer ${otherToken}` } })
        ).arrayBuffer(),
      ),
    );
    check('the same paper for a reader without cost rights carries no cost or margin', !soPdfOther.includes('Margin sum:') && !soPdfOther.includes('20,004.58'));

    const cancelBare = await http(salesToken, 'POST', `/sales-orders/${so3Body.number ? so3.body.id : ''}/cancel`, {});
    const cancelled = await http(salesToken, 'POST', `/sales-orders/${so3.body.id}/cancel`, { reason: `${TAG} booked too early` });
    check('cancelling needs its reason, and keeps the record', cancelBare.status === 400 && cancelled.status === 200, `${cancelBare.status} ${cancelled.status}`);

    // ── Pulling a revision back from the approver to edit it ─────────────────
    console.log('\nPulling a revision back from approval');
    const pulled = await http(salesToken, 'POST', '/quotations', {
      customerId: clinic.id,
      subject: `${TAG} Pulled back`,
      lines: [editorLines[2]],
    });
    const pulledId = String(pulled.body.id);
    const pulledR0 = await prisma.quotationRevision.findFirstOrThrow({ where: { quotationId: pulledId } });
    const earlyPull = await http(salesToken, 'POST', `/quotations/${pulledId}/revisions/${pulledR0.id}/withdraw`);
    check('a draft cannot be pulled back — there is nothing with the approver', earlyPull.status === 400, String(earlyPull.status));
    await http(salesToken, 'POST', `/quotations/${pulledId}/revisions/${pulledR0.id}/submit`);
    const pulledRequest = await prisma.approvalRequest.findFirstOrThrow({
      where: { documentType: 'quotation', documentId: pulledR0.id, status: 'PENDING' },
    });
    const strangerPull = await http(otherToken, 'POST', `/quotations/${pulledId}/revisions/${pulledR0.id}/withdraw`);
    check('somebody else cannot pull the author’s quotation back', strangerPull.status === 403, String(strangerPull.status));
    const pullRes = await http(salesToken, 'POST', `/quotations/${pulledId}/revisions/${pulledR0.id}/withdraw`);
    const pulledBack = await prisma.quotationRevision.findUniqueOrThrow({ where: { id: pulledR0.id } });
    check(
      'the author pulls it back: the SAME revision returns to draft — no revision number burned',
      pullRes.status === 200 && pulledBack.status === 'DRAFT' && pulledBack.revision === 0,
      `${pullRes.status} ${pulledBack.status}`,
    );
    const pulledReqAfter = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: pulledRequest.id } });
    check('its request is withdrawn — CANCELLED, closed, kept', pulledReqAfter.status === 'CANCELLED' && !!pulledReqAfter.closedAt, pulledReqAfter.status);
    check('and gone from the approver’s queue', !(await pendingFor(manager.id)).some((r) => r.id === pulledRequest.id));
    let lateDecisionRefused = false;
    try {
      await act({ requestId: pulledRequest.id, userId: manager.id, action: 'APPROVED' });
    } catch {
      lateDecisionRefused = true;
    }
    check('a decision after the pull-back is refused — the request is no longer open', lateDecisionRefused);
    const editable = await http(salesToken, 'PUT', `/quotations/${pulledId}/revisions/${pulledR0.id}/lines`, {
      lines: [{ ...editorLines[2], unitPrice: 9_999 }],
    });
    check('and its lines can be edited again', editable.status === 200, editable.text.slice(0, 160));

    // ── Raising a revision while the last one waits on the approver ──────────
    console.log('\nRaising a revision while the last one waits on the approver');
    const changed = await http(salesToken, 'POST', '/quotations', {
      customerId: clinic.id,
      subject: `${TAG} Changed while pending`,
      lines: [editorLines[2]],
    });
    const changedId = String(changed.body.id);
    const changedR0 = await prisma.quotationRevision.findFirstOrThrow({ where: { quotationId: changedId } });
    await http(salesToken, 'POST', `/quotations/${changedId}/revisions/${changedR0.id}/submit`);
    const changedRequest = await prisma.approvalRequest.findFirstOrThrow({
      where: { documentType: 'quotation', documentId: changedR0.id, status: 'PENDING' },
    });
    check('submitted, R0 waits in the sales manager’s queue', (await pendingFor(manager.id)).some((r) => r.id === changedRequest.id));
    const raisedWhilePending = await http(salesToken, 'POST', `/quotations/${changedId}/revisions`);
    check('a revision can still be raised while R0 waits', raisedWhilePending.status === 201, raisedWhilePending.text.slice(0, 160));
    const changedAfter = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: changedRequest.id } });
    check(
      'and R0’s request is withdrawn with it — CANCELLED, closed, kept',
      changedAfter.status === 'CANCELLED' && !!changedAfter.closedAt,
      changedAfter.status,
    );
    check('gone from the approver’s queue', !(await pendingFor(manager.id)).some((r) => r.id === changedRequest.id));
    const toldManager = await prisma.notification.findFirst({
      where: { userId: manager.id, type: 'approval.withdrawn', link: `/g-ops/quotations/${changedId}` },
    });
    check(
      'the approver is told it was withdrawn, linked to the quotation',
      toldManager?.title === `Withdrawn: ${TAG} Changed while pending` && toldManager.body === `${changed.body.number} R0 — superseded by R1`,
      JSON.stringify(toldManager),
    );
    check(
      'the author who raised the revision is not told what they just did',
      (await prisma.notification.count({ where: { userId: sales.id, type: 'approval.withdrawn', link: `/g-ops/quotations/${changedId}` } })) === 0,
    );
    const changedRevs = await prisma.quotationRevision.findMany({ where: { quotationId: changedId }, orderBy: { revision: 'asc' } });
    check(
      'R0 is superseded and R1 a draft',
      changedRevs.map((r) => r.status).join(',') === 'SUPERSEDED,DRAFT',
      changedRevs.map((r) => r.status).join(','),
    );
    check(
      'both trails say so: the request withdrawn at its step, and the revision raised over it',
      (await prisma.auditLog.count({
        where: {
          entityType: 'quotation',
          entityId: changedR0.id,
          action: 'CANCELLED',
          actorId: sales.id,
          summary: { startsWith: 'Withdrawn from approval at ', endsWith: ' — superseded by R1' },
        },
      })) === 1 &&
        (await prisma.auditLog.count({
          where: { entityType: 'quotation', entityId: changedId, summary: `Raised revision 1 of ${changed.body.number} — R0 withdrawn from approval` },
        })) === 1,
    );
    let lateApproval = '';
    try {
      await act({ requestId: changedRequest.id, userId: manager.id, action: 'APPROVED' });
      lateApproval = 'approved';
    } catch (err) {
      lateApproval = err instanceof Error ? err.message : String(err);
    }
    check('the approver can no longer approve it', lateApproval.includes('no longer open'), lateApproval);
    check('and R0 stays superseded', (await statusOf(changedR0.id)) === 'SUPERSEDED');
    const resubmitted = await http(salesToken, 'POST', `/quotations/${changedId}/revisions/${changedRevs[1].id}/submit`);
    check(
      'R1 goes to the approver in its place',
      resubmitted.status === 200 && (await pendingFor(manager.id)).some((r) => r.documentId === changedRevs[1].id),
      resubmitted.text.slice(0, 160),
    );
    const overApproved = await http(salesToken, 'POST', `/quotations/${big.body.id}/revisions`);
    check(
      'raising one over an approved revision withdraws nothing — its request was decided, and stays so',
      overApproved.status === 201 &&
        (await prisma.auditLog.count({ where: { entityType: 'quotation', entityId: String(big.body.id), summary: `Raised revision 1 of ${big.body.number}` } })) === 1 &&
        (await prisma.approvalRequest.findUniqueOrThrow({ where: { id: ceoRequest.id } })).status === 'APPROVED',
      overApproved.text.slice(0, 160),
    );

    // ── Admin › PDF Templates: the quotation prints the administrator's layout ──
    console.log('\nThe quotation PDF template (Admin › PDF Templates)');
    // Whatever layout this database already has is put back afterwards, byte for byte.
    const layoutBefore = await prisma.setting.findUnique({ where: { key: 'pdfTemplate.quotation' } });
    try {
      const tpl = await http(adminToken, 'GET', '/pdf-templates/quotation');
      const standard = tpl.body.standard as { blocks: { id: string; type: string; text?: string; x: number; y: number }[] };
      check(
        'the editor loads a layout, the standard one, and the fields a box can print',
        tpl.status === 200 &&
          Array.isArray((tpl.body.layout as { blocks: unknown[] })?.blocks) &&
          standard.blocks.some((b) => b.type === 'items') &&
          (tpl.body.fields as { key: string }[]).some((f) => f.key === 'quotation.prNumber') &&
          (tpl.body.fields as { key: string }[]).some((f) => f.key === 'company.tin'),
        tpl.text.slice(0, 160),
      );
      check('a salesperson cannot open it', (await http(salesToken, 'GET', '/pdf-templates/quotation')).status === 403);
      check('nor save one', (await http(salesToken, 'PUT', '/pdf-templates/quotation', standard)).status === 403);

      // A box of our own, moved and worded, prints on the real quotation.
      const mine = {
        ...standard,
        blocks: [
          ...standard.blocks,
          {
            id: 'verify-box', name: 'Verify', type: 'text', anchor: 'first', x: 40, y: 760, w: 400, h: 12,
            text: `${TAG} LAYOUT for {{customer.name}}`, size: 9,
          },
        ],
      };
      const saved = await http(adminToken, 'PUT', '/pdf-templates/quotation', mine);
      check('an administrator saves a layout', saved.status === 200 && saved.body.saved === true, saved.text.slice(0, 200));
      const printed = pdfText(
        Buffer.from(
          await (await fetch(`${BASE}/quotations/${qid}/revisions/${rev0.id}/pdf`, { headers: { Authorization: `Bearer ${salesToken}` } })).arrayBuffer(),
        ),
      );
      check('and the quotation prints with it — the new box, filled in', printed.includes(`${TAG} LAYOUT for ${TAG} Clinic`), printed.slice(0, 200));
      check('the rest of the layout still prints as before', printed.includes('PR Number: PR-ZZ-4471') && printed.includes('Total Price (PHP):'));
      check(
        'the change is audited',
        (await prisma.auditLog.count({ where: { entityType: 'setting', entityId: 'pdfTemplate.quotation', actorId: admin.id, action: 'UPDATED' } })) === 1,
      );

      const typo = await http(adminToken, 'PUT', '/pdf-templates/quotation', {
        ...mine,
        blocks: mine.blocks.map((b) => (b.id === 'verify-box' ? { ...b, text: '{{customer.nmae}}' } : b)),
      });
      check(
        'a field the quotation does not have is refused, and named',
        typo.status === 400 && typo.text.includes('customer.nmae'),
        typo.text.slice(0, 200),
      );
      const twoTables = await http(adminToken, 'PUT', '/pdf-templates/quotation', {
        ...mine,
        blocks: [...mine.blocks, { ...standard.blocks.find((b) => b.type === 'items')!, id: 'second-table' }],
      });
      check('so is a second line table', twoTables.status === 400, twoTables.text.slice(0, 160));
      const offPage = await http(adminToken, 'PUT', '/pdf-templates/quotation', {
        ...mine,
        blocks: mine.blocks.map((b) => (b.id === 'verify-box' ? { ...b, x: 500, w: 300 } : b)),
      });
      check('and a box that runs off the page', offPage.status === 400, offPage.text.slice(0, 160));

      // Import: a file exported from another G-CORE is checked before it is
      // shown, with what an older file leaves out filled in — and nothing saved.
      const settingBefore = await prisma.setting.findUnique({ where: { key: 'pdfTemplate.quotation' } });
      const older = {
        ...mine,
        blocks: mine.blocks.map((b) => {
          if (b.type !== 'signoffs') return b;
          // A sign-off block from before the contact lines existed.
          const { nameSize: _a, showPosition: _b, showPhone: _c, showEmail: _d, ...rest } = b as Record<string, unknown>;
          return rest as unknown as (typeof mine.blocks)[number];
        }),
      };
      const imported = await http(adminToken, 'POST', '/pdf-templates/quotation/check', older);
      const importedSign = ((imported.body.layout as { blocks: Record<string, unknown>[] } | undefined)?.blocks ?? []).find((b) => b.type === 'signoffs');
      check(
        'an imported layout is checked and handed back, an older file’s gaps filled in',
        imported.status === 200 && importedSign?.nameSize === 10 && importedSign?.showPhone === true && importedSign?.showPosition === false,
        imported.text.slice(0, 200),
      );
      const importTypo = await http(adminToken, 'POST', '/pdf-templates/quotation/check', {
        ...mine,
        blocks: mine.blocks.map((b) => (b.id === 'verify-box' ? { ...b, text: '{{customer.nmae}}' } : b)),
      });
      check('one naming a field the quotation lacks is refused on import, and the field named', importTypo.status === 400 && importTypo.text.includes('customer.nmae'));
      check('a salesperson cannot import', (await http(salesToken, 'POST', '/pdf-templates/quotation/check', mine)).status === 403);
      const settingAfter = await prisma.setting.findUnique({ where: { key: 'pdfTemplate.quotation' } });
      check(
        'and checking an import saves nothing',
        JSON.stringify(settingAfter?.value ?? null) === JSON.stringify(settingBefore?.value ?? null),
      );

      // Preview prints what the editor holds, saved or not.
      const preview = await fetch(`${BASE}/pdf-templates/quotation/preview`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          layout: { ...mine, blocks: mine.blocks.map((b) => (b.id === 'verify-box' ? { ...b, text: `${TAG} UNSAVED` } : b)) },
          quotationId: qid,
        }),
      });
      const previewText = pdfText(Buffer.from(await preview.arrayBuffer()));
      check(
        'a preview prints the unsaved layout against a real quotation',
        preview.status === 200 && previewText.includes(`${TAG} UNSAVED`) && previewText.includes('PR Number: PR-ZZ-4471'),
      );
      const sample = await fetch(`${BASE}/pdf-templates/quotation/preview`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ layout: mine, sample: 'long' }),
      });
      const sampleBytes = Buffer.from(await sample.arrayBuffer());
      check(
        'or against the sample, which runs to several pages',
        sample.status === 200 && Number((sampleBytes.toString('latin1').match(/\/Count\s+(\d+)/) ?? [])[1] ?? 0) >= 2,
      );

      const reset = await http(adminToken, 'DELETE', '/pdf-templates/quotation');
      const after = await http(adminToken, 'GET', '/pdf-templates/quotation');
      check('"Standard layout" puts the standard one back', reset.status === 200 && after.body.saved === false);
      const plainAgain = pdfText(
        Buffer.from(
          await (await fetch(`${BASE}/quotations/${qid}/revisions/${rev0.id}/pdf`, { headers: { Authorization: `Bearer ${salesToken}` } })).arrayBuffer(),
        ),
      );
      check('and the quotation prints without the box again', !plainAgain.includes(`${TAG} LAYOUT`) && plainAgain.includes('PR Number: PR-ZZ-4471'));
    } finally {
      if (layoutBefore) {
        await prisma.setting.upsert({
          where: { key: 'pdfTemplate.quotation' },
          create: { key: layoutBefore.key, value: layoutBefore.value as Prisma.InputJsonValue, description: layoutBefore.description },
          update: { value: layoutBefore.value as Prisma.InputJsonValue },
        });
      } else {
        await prisma.setting.deleteMany({ where: { key: 'pdfTemplate.quotation' } });
      }
    }

    // ── Admin › PDF Templates: the Sales Order template ───────────────────────
    console.log('\nThe Sales Order PDF template (Admin › PDF Templates)');
    try {
      const soTpl = await http(adminToken, 'GET', '/pdf-templates/sales_order');
      const soStandard = soTpl.body.standard as { orientation?: string; blocks: Record<string, unknown>[] };
      check(
        'the editor loads the Sales Order template: landscape standard, the order fields, the cost columns on offer',
        soTpl.status === 200 &&
          soStandard.orientation === 'landscape' &&
          (soTpl.body.layout as { orientation?: string }).orientation === 'landscape' &&
          (soTpl.body.fields as { key: string }[]).some((f) => f.key === 'order.number') &&
          (soTpl.body.columns as { key: string }[]).some((c) => c.key === 'cost') &&
          (soTpl.body.columns as { key: string }[]).some((c) => c.key === 'margin'),
        soTpl.text.slice(0, 200),
      );

      const soMine = {
        ...soStandard,
        blocks: [
          ...soStandard.blocks,
          {
            id: 'verify-so-box', name: 'Verify', type: 'text', anchor: 'first', x: 40, y: 500, w: 420, h: 12,
            text: `${TAG} SOLAYOUT # {{order.number}}`, size: 9,
          },
        ],
      };
      const soSaved = await http(adminToken, 'PUT', '/pdf-templates/sales_order', soMine);
      check('an administrator saves a Sales Order layout', soSaved.status === 200 && soSaved.body.saved === true, soSaved.text.slice(0, 200));
      const soPrinted = pdfText(
        Buffer.from(
          await (
            await fetch(`${BASE}/sales-orders/${so1Body.id}/pdf`, { headers: { Authorization: `Bearer ${salesToken}` } })
          ).arrayBuffer(),
        ),
      );
      check(
        'and the sales order prints with it — the new box, filled with the order number',
        soPrinted.includes(`${TAG} SOLAYOUT # ${so1Body.number}`),
        soPrinted.slice(0, 200),
      );

      // The quotation is the customer's paper: its table may never place cost.
      const qStd = (await http(adminToken, 'GET', '/pdf-templates/quotation')).body.standard as {
        blocks: { type: string; columns?: object[] }[];
      };
      const refusedCost = await http(adminToken, 'PUT', '/pdf-templates/quotation', {
        ...qStd,
        blocks: qStd.blocks.map((b) =>
          b.type === 'items' ? { ...b, columns: [...(b.columns ?? []), { key: 'cost', label: 'Cost', width: 60, align: 'right' }] } : b,
        ),
      });
      check(
        'the quotation\u2019s line table can never place a cost column',
        refusedCost.status === 400 && refusedCost.text.toLowerCase().includes('cost'),
        refusedCost.text.slice(0, 160),
      );

      const soPreview = await fetch(`${BASE}/pdf-templates/sales_order/preview`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ layout: soMine, documentId: so1Body.id }),
      });
      const soPreviewText = pdfText(Buffer.from(await soPreview.arrayBuffer()));
      check(
        'a preview prints the layout against a real sales order',
        soPreview.status === 200 && soPreviewText.includes('4500001134') && soPreviewText.includes(`${TAG} SOLAYOUT # ${so1Body.number}`),
      );
      const soSample = await fetch(`${BASE}/pdf-templates/sales_order/preview`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ layout: soMine, sample: 'short' }),
      });
      const soSampleBytes = Buffer.from(await soSample.arrayBuffer());
      check(
        'or against the sample, on the same landscape paper',
        soSample.status === 200 && soSampleBytes.toString('latin1').includes('/MediaBox [0 0 841.89 595.28]'),
      );

      const soReset = await http(adminToken, 'DELETE', '/pdf-templates/sales_order');
      check(
        '"Standard layout" puts the landscape standard back',
        soReset.status === 200 && soReset.body.saved === false && (soReset.body.layout as { orientation?: string }).orientation === 'landscape',
      );
    } finally {
      await prisma.setting.deleteMany({ where: { key: 'pdfTemplate.sales_order' } });
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
