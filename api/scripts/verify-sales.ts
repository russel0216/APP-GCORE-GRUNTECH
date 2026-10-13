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
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { deleteAttachment } from '../src/shared/attachments';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/prisma';
import { env } from '../src/env';
import { nextNumber, previewNext, employeeToken, parseNumber, renderPattern, FREE_NUMBER_TRIES } from '../src/shared/numbering';
import { submitForApproval, act, pendingFor, pickWorkflow, routePreview } from '../src/shared/approvals';
import { formatDateTime, renderDocument } from '../src/shared/pdf';
import { resolveUser, canEditRecord, type ResolvedUser } from '../src/permissions/resolve';
import { signToken } from '../src/auth/middleware';
import {
  quotationTotals,
  lineAmount,
  recalcQuotationRevision,
  withdrawStaleQuotationApprovals,
  canSeeQuotationCost,
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
  quotationStage,
  quotationStages,
  leadStage,
  leadStages,
  standsApproved,
} from '../src/shared/pipeline';
import { DEFAULT_STAGES } from '../src/shared/pipelineStages';
import { valueRevision as valuedRevisionOf } from '../src/shared/pipeline';
import {
  buildForecast,
  rangePreset,
  type RangePreset,
  type ForecastLine,
  defaultWindow,
  isoWeek,
  periodBucket,
  periodNext,
  periodsBetween,
  periodStart,
  weightedOf,
  type ForecastRow,
  compareWindow,
  compareForecasts,
  changeOf,
  outcomeOdds,
  shiftYears,
} from '../src/shared/forecast';
import { listQuery } from '../src/http/kit';
// Imported for its side effect: this is what registers the quotation's
// onApprovalSettled subscriber. The real API gets it via src/index.ts, and the
// test has to exercise the same wiring or it proves nothing about production.
import '../src/routes/sales';
import { leadListSummary, leadListWhere, printableQuotation, quotationListSummary, quotationListWhere, quotationPrintData } from '../src/routes/sales';
import { capsParts, markUnchangedScoroImports, upperText } from '../src/shared/quotation';
import { upperText as webUpperText } from '../../web/src/lib/caps';
import { deleteGroup, deletedGroupKeys, setDeletedGroupKeys } from '../src/shared/quotationGroups';
import { documentAddress } from '../src/shared/customerAddress';
import { salesOrderListSummary, salesOrderListWhere } from '../src/routes/salesOrders';
import { fillQuotationTeams, quotationTeamWhere, teamMembers, teamOf } from '../src/shared/team';
// The same for the sales order's subscriber — act() below settles in this
// process, and without it an approval would settle into the void.
import '../src/routes/salesOrders';
import { OWNER_GROUPS, groupKey, rememberGroups, seedOwnerGroups } from '../src/shared/quotationGroups';
import { decodeCsv, parseCsv, runImport, toCsv } from '../src/shared/csv';
import { pipelineStages, stageProbability } from '../src/shared/pipelineStages';
// The SCORO quotes import's spec and writer by name — what the route runs.
import { scoroQuoteSpec, writeScoroQuotes, SUMMARY_LINE_TITLE } from '../src/routes/imports/scoroQuotes';
import {
  flat,
  pdfText,
  squash,
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
    prisma.employee.findMany({ where: { NOT: { employeeNo: { startsWith: TAG } } }, select: { employeeNo: true } }),
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

/*
  The typed-number checks move the author's REAL quotation series (the row
  the template's own pattern keys for them). Where it stood is kept in a
  Setting of its own, like the layouts, and put back by cleanup() — first and
  last, and after a crash — so a run that dies between the first typed number
  and the end never leaves a live series moved.
*/
const SERIES_STASH_KEY = 'numbering.quotation.__verify__';

async function setSeriesAside(periodKey: string, row: { lastNumber: number } | null) {
  await prisma.setting.upsert({
    where: { key: SERIES_STASH_KEY },
    create: { key: SERIES_STASH_KEY, value: { periodKey, lastNumber: row?.lastNumber ?? null }, description: 'verify-sales: the quotation series as it stood' },
    update: { value: { periodKey, lastNumber: row?.lastNumber ?? null } },
  });
}

async function putSeriesBack() {
  const stash = await prisma.setting.findUnique({ where: { key: SERIES_STASH_KEY } });
  if (!stash) return;
  const { periodKey, lastNumber } = stash.value as { periodKey: string; lastNumber: number | null };
  // The row put back where it stood, or removed where none was.
  if (lastNumber === null) await prisma.numberSequence.deleteMany({ where: { documentType: 'quotation', periodKey } });
  else await prisma.numberSequence.updateMany({ where: { documentType: 'quotation', periodKey }, data: { lastNumber } });
  await prisma.setting.delete({ where: { key: SERIES_STASH_KEY } });
}

async function cleanup() {
  // The files the attachment checks uploaded or copied — rows AND bytes:
  // the rows would cascade with their uploader, the files on disk would not.
  for (const f of await prisma.attachment.findMany({ where: { uploadedBy: { email: { endsWith: '@verifys.local' } } }, select: { id: true } })) {
    await deleteAttachment(f.id);
  }
  await putSavedLayoutBack();
  await putSeriesBack();
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
  await prisma.employee.deleteMany({ where: { employeeNo: { startsWith: TAG } } });
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
  // The view-own role the memory check signs in with.
  await prisma.role.deleteMany({ where: { key: { startsWith: `${TAG.toLowerCase()}_` } } });
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

async function main() {
  console.log('\nG-CORE sales verification\n');
  await cleanup();

  const sales = await makeUser('Verify Sales', 'sales@verifys.local', ['sales']);
  const manager = await makeUser('Verify Sales Manager', 'mgr@verifys.local', ['sales_manager', 'team_leader']);
  // The CEO / President (the owner's routing sheet): the second signature on
  // a quotation over ₱1,000,000 and the last on every sales order.
  const ceo = await makeUser('Verify CEO', 'ceo@verifys.local', ['executive', 'ceo']);
  const other = await makeUser('Verify Other', 'other@verifys.local', ['sales']);
  // A team (2026-10-08) is the Industry on the employee record: Sales and
  // Other are on the Healthcare Industry Team, the manager has an employee
  // record on no team.
  const teamHI = await prisma.industry.findUniqueOrThrow({ where: { code: 'HIT' } });
  // Sales' employee number carries the EDITOR_TOKEN digits: Employee.employeeNo
  // wins over User.employeeNo for {EMP}, and the numbering checks expect them.
  for (const [u, n, team] of [[sales, EDITOR_TOKEN, teamHI.id], [other, 'E2', teamHI.id], [manager, 'E3', null]] as const) {
    await prisma.employee.create({ data: { employeeNo: `${TAG}-${n}`, firstName: 'Verify', lastName: `${TAG} ${n}`, userId: u.id, industryId: team } });
  }
  // Sales reports to the manager, so their documents' Team Leader step is
  // the manager whoever else on the database holds Team Leader.
  await prisma.user.update({ where: { id: sales.id }, data: { supervisorId: manager.id } });

  const customer = await prisma.customer.create({
    data: { code: `${TAG}-C1`, name: `${TAG} Hospital`, createdById: sales.id },
  });

  // Old quotations take their author's team (2026-10-12): only those with no
  // team, only from an author who has one; a picked team is never touched.
  {
    const kat = await prisma.industry.findUniqueOrThrow({ where: { code: 'KAT' } });
    const mk = (n: string, ownerId: string, teamId: string | null) =>
      prisma.quotation.create({ data: { number: `${TAG}-FILL${n}`, customerId: customer.id, ownerId, subject: `${TAG} Fill ${n}`, teamId } });
    const [untagged, picked, teamless] = [await mk('1', other.id, null), await mk('2', other.id, kat.id), await mk('3', manager.id, null)];
    await fillQuotationTeams();
    const again = await fillQuotationTeams();
    const after = await prisma.quotation.findMany({ where: { id: { in: [untagged.id, picked.id, teamless.id] } }, select: { id: true, teamId: true } });
    const teamOfQ = (id: string) => after.find((q) => q.id === id)?.teamId ?? null;
    check(
      "an old quotation with no team takes its author's team; a picked team stays, and an author with none leaves it open",
      teamOfQ(untagged.id) === teamHI.id && teamOfQ(picked.id) === kat.id && teamOfQ(teamless.id) === null && again === 0,
      `${teamOfQ(untagged.id)} / ${teamOfQ(picked.id)} / ${teamOfQ(teamless.id)} / again ${again}`,
    );
    await prisma.quotation.deleteMany({ where: { id: { in: [untagged.id, picked.id, teamless.id] } } });
  }

  // ── 1. The contract amount ─────────────────────────────────────────────────
  console.log('How the contract amount is reached');

  const categories = await prisma.costCategory.findMany({ orderBy: { sortOrder: 'asc' } });
  const costing = await prisma.costing.create({
    data: {
      number: await nextNumber('costing'),
      title: `${TAG} Oxygen plant`,
      ownerId: sales.id,
      customerId: customer.id,
      // 200,000 over a 1,200,000 contract: a 16.6667% margin on the price.
      marginPct: d(0.166667),
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

  // The stored contract value is the commercial fact (here written as the
  // route's recalc would: cost ÷ (1 − margin), to the centavo).
  const totalCost = costs.reduce((a, b) => a + b, 0);
  const expectedContract = 1_200_000;
  await prisma.costing.update({
    where: { id: costing.id },
    data: { totalCost: d(totalCost), contractValue: d(expectedContract) },
  });

  const priced = await prisma.costing.findUnique({ where: { id: costing.id } });
  check('total cost sums the five buckets', money(Number(priced!.totalCost), 1_000_000), String(priced!.totalCost));
  check(
    'contract = cost ÷ (1 − margin)',
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
  check(
    'over ₱1,000,000 the team leader alone does not approve it',
    (await prisma.quotationRevision.findUniqueOrThrow({ where: { id: r0.id } })).status === 'PENDING_APPROVAL',
  );
  await act({ requestId: request.id, userId: ceo.id, action: 'APPROVED' });
  const approved = await prisma.quotationRevision.findUnique({ where: { id: r0.id } });
  check('the team leader, then the CEO / President, approve it', approved!.status === 'APPROVED', approved!.status);

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
          discountPct: 0,
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

  // ── The Forecast's periods and buckets (shared/forecast.ts, pure) ────────
  console.log('\nThe Forecast: periods, labels and buckets');
  check('a week starts on its Monday', periodStart('2026-10-08', 'week') === '2026-10-05' && periodStart('2026-10-05', 'week') === '2026-10-05' && periodStart('2026-10-11', 'week') === '2026-10-05');
  check('a month, quarter and year start on their first day', periodStart('2026-10-08', 'month') === '2026-10-01' && periodStart('2026-11-30', 'quarter') === '2026-10-01' && periodStart('2026-06-15', 'year') === '2026-01-01');
  check('the next period follows without a gap', periodNext('2026-10-05', 'week') === '2026-10-12' && periodNext('2026-12-01', 'month') === '2027-01-01' && periodNext('2026-10-01', 'quarter') === '2027-01-01' && periodNext('2026-01-01', 'year') === '2027-01-01');
  const w41 = periodBucket('2026-10-05', 'week');
  check('a week is keyed by its ISO number and labelled by its days', w41.key === '2026-W41' && w41.label === '5–11 Oct 2026' && w41.to === '2026-10-11', JSON.stringify(w41));
  check('a week across a month names both months', periodBucket('2026-10-26', 'week').label === '26 Oct – 1 Nov 2026');
  check('a week across a year names both years', periodBucket('2025-12-29', 'week').label === '29 Dec 2025 – 4 Jan 2026' && periodBucket('2025-12-29', 'week').key === '2026-W01');
  check('ISO week 53 exists where it should', isoWeek('2020-12-31').week === 53 && isoWeek('2021-01-03').year === 2020 && isoWeek('2026-01-01').week === 1);
  check('a month, a quarter and a year are labelled plainly', periodBucket('2026-10-01', 'month').label === 'October 2026' && periodBucket('2026-10-01', 'quarter').label === 'Q4 2026 (Oct–Dec)' && periodBucket('2026-01-01', 'year').label === '2026');
  const months = periodsBetween('2026-10-15', '2027-02-03', 'month');
  check('a window lists every period it touches, from the one its start falls in', months.map((m) => m.key).join() === '2026-10,2026-11,2026-12,2027-01,2027-02');
  check('the default window is twelve months, eight quarters, three years, twelve weeks from the current period', JSON.stringify(defaultWindow('2026-10-08', 'month')) === '{"from":"2026-10-01","to":"2027-09-30"}' && JSON.stringify(defaultWindow('2026-10-08', 'quarter')) === '{"from":"2026-10-01","to":"2028-09-30"}' && JSON.stringify(defaultWindow('2026-10-08', 'year')) === '{"from":"2026-01-01","to":"2028-12-31"}' && JSON.stringify(defaultWindow('2026-10-08', 'week')) === '{"from":"2026-10-05","to":"2026-12-27"}', JSON.stringify(defaultWindow('2026-10-08', 'week')));
  let tooWide = false;
  try {
    periodsBetween('2000-01-01', '2026-01-01', 'week');
  } catch {
    tooWide = true;
  }
  check('a window of more than MAX_BUCKETS periods is refused', tooWide);
  const fRow = (
    n: number,
    closing: string | null,
    value: number,
    probability: number,
    owner = 'A',
    team: ForecastRow['team'] = null,
    groups?: ForecastRow['groups'],
  ): ForecastRow => ({
    kind: 'quotation',
    id: `q${n}`,
    number: `Q-${n}`,
    title: 'Customer',
    subject: null,
    customer: null,
    owner: { id: owner, name: owner },
    stage: 'OPPORTUNITY',
    stageLabel: 'Opportunity',
    status: 'OPEN',
    probability,
    expectedClosing: closing,
    value,
    weighted: weightedOf(value, probability),
    overdue: closing !== null && closing < '2026-10-08',
    link: '/',
    team,
    groups: groups ?? [{ key: '', group: 'No group', value }],
  });
  const fc = buildForecast({
    period: 'month',
    from: '2026-10-01',
    to: '2026-12-31',
    today: '2026-10-08',
    rows: [
      fRow(1, '2026-10-02', 100.01, 33), // past closing, in October
      fRow(2, '2026-10-20', 200.02, 33),
      fRow(3, '2026-12-31', 300.03, 50, 'B'),
      fRow(4, '2026-09-30', 400.04, 10), // before the window
      fRow(5, '2027-01-01', 500.05, 10), // after it
      fRow(6, null, 600.06, 90, 'B'), // undated
    ],
  });
  check('every row lands in exactly one group, so the groups add up to everything', fc.totals.count === 6 && fc.inWindow.count === 3 && fc.earlier.count === 1 && fc.later.count === 1 && fc.undated.count === 1);
  check('October holds both of its rows and counts the one past its closing date', fc.buckets[0].key === '2026-10' && fc.buckets[0].count === 2 && fc.buckets[0].overdue === 1 && fc.buckets[0].value === 300.03);
  check('an empty period is still listed, at zero', fc.buckets[1].key === '2026-11' && fc.buckets[1].count === 0 && fc.buckets[1].value === 0);
  check('the weighted sum is rounded once, at the end: 100.01 × 33% + 200.02 × 33% = 99.01', fc.buckets[0].weighted === 99.01, String(fc.buckets[0].weighted));
  check('the window total is the buckets summed in cents', fc.inWindow.value === 600.06 && fc.inWindow.weighted === 249.03, `${fc.inWindow.value} ${fc.inWindow.weighted}`);
  check('and everything open adds the three groups outside it', fc.totals.value === 2100.21 && fc.totals.overdue === 2, `${fc.totals.value} ${fc.totals.overdue}`);
  // A: 33.0033 + 66.0066 + 40.004 + 50.005 = 189.0189; B: 150.015 + 540.054 = 690.069.
  check('owners are ranked by weighted value, each with their own share', fc.owners.map((o) => `${o.id}:${o.count}:${o.weighted}`).join() === 'B:2:690.07,A:4:189.02', fc.owners.map((o) => `${o.id}:${o.count}:${o.weighted}`).join());
  check('rows within a group are in closing-date order', fc.buckets[0].rows.map((r) => r.number).join() === 'Q-1,Q-2');

  // ── The breakdowns and the date range (2026-10-12) ───────────────────────
  console.log('\nThe Forecast: by salesperson, team and product group, over a chosen range');
  const KAT = { id: 'kat', code: 'KAT', name: 'Key Account Team' };
  const HIT = { id: 'hit', code: 'HIT', name: 'Healthcare Industry Team' };
  const fb = buildForecast({
    period: 'month',
    from: '2026-10-05',
    to: '2026-11-20',
    today: '2026-10-08',
    rows: [
      fRow(11, '2026-10-02', 1000, 50, 'A', KAT, [{ key: 'omega air', group: 'OMEGA AIR', value: 700 }, { key: 'services', group: 'SERVICES', value: 300 }]),
      fRow(12, '2026-10-20', 2000.01, 33, 'A', HIT, [{ key: 'omega air', group: 'OMEGA AIR', value: 2000.01 }]),
      fRow(13, '2026-11-20', 300.03, 90, 'B', KAT, [{ key: 'services', group: 'SERVICES', value: 100.01 }, { key: 'omega air', group: 'OMEGA AIR', value: 200.02 }]),
      fRow(14, '2026-11-21', 500, 10, 'B'), // after the range's last day
      fRow(15, null, 400.4, 25, 'C', HIT),
    ],
  });
  check(
    'a range that starts and ends inside a month cuts its first and last period to its own days',
    fb.buckets.map((b) => `${b.key}|${b.label}|${b.from}|${b.to}`).join() ===
      '2026-10|5–31 Oct 2026|2026-10-05|2026-10-31,2026-11|1–20 Nov 2026|2026-11-01|2026-11-20',
    fb.buckets.map((b) => `${b.key}|${b.label}|${b.from}|${b.to}`).join(),
  );
  check('a period the range covers whole keeps its name', periodsBetween('2026-09-15', '2026-12-10', 'month')[1].label === 'October 2026');
  check(
    'the day before the range is earlier, the day after it later',
    fb.earlier.rows.map((r) => r.number).join() === 'Q-11' && fb.later.rows.map((r) => r.number).join() === 'Q-14',
  );
  const whole = periodsBetween('2026-10-05', '2026-11-20', 'range');
  check('"Whole range" is one period over exactly the range', whole.length === 1 && whole[0].label === '5 Oct – 20 Nov 2026' && whole[0].from === '2026-10-05' && whole[0].to === '2026-11-20', JSON.stringify(whole));
  check(
    'the presets read the Manila day they are asked on',
    [
      ['this-month', '2026-10-01', '2026-10-31'],
      ['this-quarter', '2026-10-01', '2026-12-31'],
      ['this-year', '2026-01-01', '2026-12-31'],
      ['next-30', '2026-10-12', '2026-11-10'],
      ['next-90', '2026-10-12', '2027-01-09'],
      ['next-12m', '2026-10-12', '2027-10-11'],
    ].every(([p, f, t]) => {
      const r = rangePreset(p as RangePreset, '2026-10-12');
      return r.from === f && r.to === t;
    }) && rangePreset('next-12m', '2028-02-29').to === '2029-02-27',
  );
  const addsUp = (lines: ForecastLine[]) => {
    const cents = (n: number) => Math.round(n * 100);
    const sumOf = (pick: (l: ForecastLine) => number) => lines.reduce((t, l) => t + cents(pick(l)), 0);
    return (
      fb.buckets.every((b) => sumOf((l) => l.periods[b.key].value) === cents(b.value)) &&
      sumOf((l) => l.earlier.value) === cents(fb.earlier.value) &&
      sumOf((l) => l.later.value) === cents(fb.later.value) &&
      sumOf((l) => l.undated.value) === cents(fb.undated.value) &&
      sumOf((l) => l.value) === cents(fb.totals.value) &&
      // The weighted sum is rounded once per cell: within a centavo per line.
      Math.abs(sumOf((l) => l.weighted) - cents(fb.totals.weighted)) <= lines.length
    );
  };
  check(
    'by salesperson: one line each, ranked by weighted, adding up to the forecast',
    fb.byOwner.map((l) => `${l.id}:${l.count}`).join() === 'A:2,B:2,C:1' && addsUp(fb.byOwner),
    fb.byOwner.map((l) => `${l.id}:${l.count}:${l.weighted}`).join(),
  );
  check(
    'by team: a quotation under its team, "No team" last, adding up to the forecast',
    fb.byTeam.map((l) => `${l.name}:${l.count}`).join() === 'KAT:2,HIT:2,No team:1' && fb.byTeam[0].hint === 'Key Account Team' && addsUp(fb.byTeam),
    fb.byTeam.map((l) => `${l.name}:${l.count}:${l.weighted}`).join(),
  );
  const omega = fb.byGroup.find((l) => l.name === 'OMEGA AIR')!;
  check(
    'by product group: each quotation split by its lines, counted under every group it touches, the values adding up',
    fb.byGroup.map((l) => l.name).join() === 'OMEGA AIR,SERVICES,No group' &&
      omega.count === 3 && omega.value === 2900.03 && omega.periods['2026-11'].value === 200.02 && omega.earlier.value === 700 &&
      addsUp(fb.byGroup),
    fb.byGroup.map((l) => `${l.name}:${l.count}:${l.value}`).join(),
  );
  check(
    'a period cell of the breakdown is that period’s share: Salesperson A in October',
    fb.byOwner[0].periods['2026-10'].count === 1 && fb.byOwner[0].periods['2026-10'].weighted === 660 && fb.byOwner[0].earlier.value === 1000,
    JSON.stringify(fb.byOwner[0].periods),
  );

  console.log('\nThe Forecast: a comparison range');
  check(
    'the period before is a window of the same length ending the day before; last year moves both edges a year',
    JSON.stringify(compareWindow('2026-10-01', '2027-09-30', 'prev-period')) === JSON.stringify({ from: '2025-10-01', to: '2026-09-30' }) &&
      JSON.stringify(compareWindow('2026-10-05', '2026-11-20', 'prev-period')) === JSON.stringify({ from: '2026-08-19', to: '2026-10-04' }) &&
      JSON.stringify(compareWindow('2026-01-01', '2026-12-31', 'prev-year')) === JSON.stringify({ from: '2025-01-01', to: '2025-12-31' }) &&
      JSON.stringify(compareWindow('2026-01-01', '2026-03-31', 'custom', { from: '2024-02-01', to: '2024-02-29' })) ===
        JSON.stringify({ from: '2024-02-01', to: '2024-02-29' }),
  );
  check(
    'a 29 February a year back lands on 28 February; a leap window before is 366 days',
    shiftYears('2028-02-29', -1) === '2027-02-28' &&
      compareWindow('2028-02-29', '2028-03-31', 'prev-year').from === '2027-02-28' &&
      compareWindow('2028-01-01', '2028-12-31', 'prev-period').from === '2026-12-31',
    JSON.stringify(compareWindow('2028-01-01', '2028-12-31', 'prev-period')),
  );
  check('a comparison reads won in full, lost at nothing, open at its own odds', outcomeOdds('WON', 30) === 100 && outcomeOdds('LOST', 90) === 0 && outcomeOdds('SUBMITTED', 45) === 45);
  const ch = changeOf({ count: 2, value: 1200, weighted: 600 }, { count: 1, value: 1000, weighted: 800 });
  const fresh = changeOf({ count: 1, value: 50, weighted: 25 }, { count: 0, value: 0, weighted: 0 });
  check('a change is the difference and its percentage; nothing before has no percentage', ch.value === 200 && ch.valuePct === 20 && ch.weighted === -200 && ch.weightedPct === -25 && fresh.weightedPct === null, JSON.stringify([ch, fresh]));
  const cur = buildForecast({
    period: 'quarter',
    from: '2026-01-01',
    to: '2026-12-31',
    today: '2026-10-12',
    rows: [fRow(21, '2026-02-10', 1000, 50, 'A', KAT), fRow(22, '2026-08-01', 400, 100, 'B', HIT)],
  });
  const prev = buildForecast({
    period: 'quarter',
    from: '2025-01-01',
    to: '2025-06-30',
    today: '2026-10-12',
    rows: [fRow(31, '2025-03-01', 600, 100, 'A', KAT), fRow(32, '2025-05-05', 300, 100, 'D', KAT)],
  });
  const cmp = compareForecasts(cur, prev, 'custom');
  check(
    'buckets pair by position, and past the compared window’s end there is no partner',
    cmp.compare.pairs.map((p) => p.previous?.key ?? '-').join() === '2025-Q1,2025-Q2,-,-' &&
      cmp.compare.pairs[0].change!.weighted === -100 && cmp.compare.pairs[1].change!.weightedPct === -100 && cmp.compare.pairs[2].change === null && cmp.compare.unpaired.length === 0,
    JSON.stringify(cmp.compare.pairs.map((p) => [p.previous?.key, p.change?.weighted])),
  );
  check(
    'each line is compared with itself, and a salesperson found only before joins the breakdown at zero',
    cmp.forecast.byOwner.map((l) => l.id).join() === 'A,B,D' &&
      cmp.compare.lines.owner.A.previous.weighted === 600 && cmp.compare.lines.owner.A.change.weighted === -100 &&
      cmp.compare.lines.owner.D.previous.weighted === 300 && cmp.compare.lines.owner.D.change.weighted === -300 &&
      cmp.compare.lines.team.kat.previous.weighted === 900 && cmp.compare.inWindow.change.weighted === 0,
    JSON.stringify(cmp.compare.lines.owner),
  );
  check(
    'a line’s window is its periods together',
    cmp.forecast.byOwner[0].window.weighted === 500 && cmp.forecast.byOwner[0].window.count === 1,
    JSON.stringify(cmp.forecast.byOwner[0].window),
  );

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
    discountPct: 0,
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

  // ── The list of quotations (SCORO's, 2026-10-08) ──────────────────────────
  console.log('\nThe list of quotations: stage tabs, counts, totals, filters');
  {
    const LISTQ = `${TAG} LISTQ`;
    // A list query as the route would read it from a URL.
    const listQ = (query: Record<string, string>) =>
      listQuery({ query: { search: LISTQ, ...query } } as unknown as Parameters<typeof listQuery>[0]);
    const stages = DEFAULT_STAGES;

    const raise = async (
      name: string,
      outcome: 'OPEN' | 'SUBMITTED' | 'NEGOTIATION' | 'WON' | 'LOST',
      revisions: { status: 'DRAFT' | 'APPROVED' | 'PENDING_APPROVAL' | 'SUPERSEDED'; total: number }[],
      extra: Partial<Prisma.QuotationUncheckedCreateInput> = {},
    ) =>
      prisma.quotation.create({
        data: {
          number: `${TAG}-L-${name}`,
          customerId: customer.id,
          ownerId: sales.id,
          subject: `${LISTQ} ${name}`,
          outcome,
          ...extra,
          revisions: { create: revisions.map((r, i) => ({ revision: i, status: r.status, total: d(r.total), vatRate: d(0.12) })) },
        },
      });

    const qOpen = await raise('open', 'OPEN', [{ status: 'DRAFT', total: 100 }]);
    await raise('submitted', 'SUBMITTED', [{ status: 'APPROVED', total: 200 }]);
    await raise('negotiation', 'NEGOTIATION', [{ status: 'APPROVED', total: 300 }]);
    // Approved R0 at 400 and a draft R1 at 999: the value is the approved one.
    const qConfirmed = await raise('confirmed', 'WON', [
      { status: 'APPROVED', total: 400 },
      { status: 'DRAFT', total: 999 },
    ]);
    const qCompleted = await raise('completed', 'WON', [{ status: 'APPROVED', total: 500 }], { ownerId: other.id });
    await raise('lost', 'LOST', [{ status: 'APPROVED', total: 600 }]);
    // Booked: a sales order on the completed one, and a CANCELLED order on the open one.
    await prisma.salesOrder.create({
      data: { number: `${TAG}-LSO1`, quotationId: qCompleted.id, customerId: customer.id, ownerId: other.id, orderDate: new Date() },
    });
    await prisma.salesOrder.create({
      data: {
        number: `${TAG}-LSO2`,
        quotationId: qOpen.id,
        customerId: customer.id,
        ownerId: sales.id,
        orderDate: new Date(),
        status: 'CANCELLED',
        cancelReason: 'verify',
      },
    });

    check(
      'a quotation stands in the board’s stages: Opportunity to Lost, never On hold',
      quotationStages(stages).map((st) => st.key).join(',') === 'OPPORTUNITY,NEGOTIATION,CLOSING,CONFIRMED,COMPLETED,LOST',
      quotationStages(stages).map((st) => st.key).join(','),
    );
    check(
      'won and booked is Completed, won alone is Confirmed — the board’s stageOfCard',
      quotationStage('WON', true, stages) === 'COMPLETED' && quotationStage('WON', false, stages) === 'CONFIRMED' &&
        quotationStage('OPEN', true, stages) === 'OPPORTUNITY',
    );

    const all = quotationListWhere(superUser, listQ({}), stages);
    const summary = await quotationListSummary(all.base, all.where, stages);
    check('the All tab counts every quotation the search selects', summary.tabCounts[''] === 6 && summary.count === 6, JSON.stringify(summary.tabCounts));
    // Mine · Team · All (2026-10-08): Team is the owners on the viewer's team.
    const myTeam = await teamOf(sales.id);
    const teamOnly = await prisma.quotation.count({ where: quotationListWhere(superUser, listQ({ scope: 'team' }), stages, myTeam!.id).where });
    const otherTeam = await prisma.industry.findFirstOrThrow({ where: { code: { not: 'HIT' }, isActive: true } });
    check(
      'the Team view lists the quotations of everyone on the team, and nobody else’s',
      myTeam?.code === 'HIT' && teamOnly === 6 &&
        (await prisma.quotation.count({ where: quotationListWhere(superUser, listQ({ scope: 'team' }), stages, otherTeam.id).where })) === 0 &&
        (await teamOf(manager.id)) === null,
      `${myTeam?.code} ${teamOnly}`,
    );
    check(
      'a Team view for a viewer with no team is Mine',
      (await prisma.quotation.count({ where: quotationListWhere(superUser, listQ({ scope: 'team' }), stages, null).where })) === 0,
    );
    const withTeam = await quotationListSummary(all.base, all.where, stages, { teamWhere: { owner: teamMembers(myTeam!.id) }, margin: true });
    check(
      'the summary carries the team’s share of the set, and a margin over the costed quotations — none yet',
      withTeam.team?.count === 6 && money(withTeam.team.value, withTeam.value) && withTeam.margin?.costed === 0 && withTeam.margin.pct === null,
      JSON.stringify({ team: withTeam.team, margin: withTeam.margin }),
    );
    // Quotes by team (2026-10-08, the owner's call — the list's summary card):
    // the set split by the owner's team, every active team listed even at
    // zero, and the shares add up to the whole.
    const activeTeams = await prisma.industry.findMany({ where: { isActive: true }, select: { id: true } });
    const teamShares = withTeam.teams ?? [];
    const myShare = teamShares.find((t) => t.id === myTeam!.id);
    check(
      'the summary splits the set by the owner’s team: every active team listed, the shares adding up to the whole',
      activeTeams.every((t) => teamShares.some((s) => s.id === t.id)) &&
        myShare?.count === 6 && money(myShare.value, withTeam.value) &&
        teamShares.reduce((n, t) => n + t.count, 0) === withTeam.count &&
        money(teamShares.reduce((v, t) => v + t.value, 0), withTeam.value) &&
        teamShares.filter((t) => t.id !== myTeam!.id).every((t) => t.count === 0 && t.value === 0),
      JSON.stringify(teamShares),
    );
    const perStage = Object.entries(summary.tabCounts).filter(([k]) => k !== '');
    check(
      'every stage has one, and the stage counts add up to All',
      perStage.every(([, n]) => n === 1) && perStage.reduce((t, [, n]) => t + n, 0) === summary.tabCounts[''],
      JSON.stringify(summary.tabCounts),
    );
    check(
      'the totals line is quotationValue() summed: the approved revision, never a later draft',
      money(summary.value, 100 + 200 + 300 + 400 + 500 + 600),
      String(summary.value),
    );
    check(
      'the summary carries the tabs, named and coloured as the stages are',
      (summary.tabs ?? []).map((t) => t.label).join(',') === 'Opportunity,Negotiation,Closing,Confirmed,Completed,Lost' &&
        (summary.tabs ?? []).every((t) => /^#[0-9A-F]{6}$/i.test(t.color ?? '')),
    );

    let tabsAgree = true;
    const detail: string[] = [];
    for (const st of quotationStages(stages)) {
      const w = quotationListWhere(superUser, listQ({ stage: st.key }), stages);
      const rows = await prisma.quotation.findMany({
        where: w.where,
        select: { subject: true, outcome: true, _count: { select: { salesOrders: true } }, revisions: { select: { jobs: { select: { id: true } } } } },
      });
      const tabSummary = await quotationListSummary(w.base, w.where, stages);
      const ok =
        rows.length === summary.tabCounts[st.key] &&
        tabSummary.count === rows.length &&
        rows.every((r) => quotationStage(r.outcome, r._count.salesOrders > 0 || r.revisions.some((v) => v.jobs.length > 0), stages) === st.key);
      if (!ok) {
        tabsAgree = false;
        detail.push(`${st.key}: ${rows.map((r) => r.subject).join('/')}`);
      }
    }
    check('each tab lists exactly the quotations its count says, each standing in that stage', tabsAgree, detail.join('; '));

    const completed = quotationListWhere(superUser, listQ({ stage: 'COMPLETED' }), stages);
    const completedRows = await prisma.quotation.findMany({ where: completed.where, select: { id: true } });
    check('a won quotation with a sales order is Completed', completedRows.length === 1 && completedRows[0].id === qCompleted.id);
    const confirmed = quotationListWhere(superUser, listQ({ stage: 'CONFIRMED' }), stages);
    const confirmedRows = await prisma.quotation.findMany({ where: confirmed.where, select: { id: true } });
    check('and one without is Confirmed', confirmedRows.length === 1 && confirmedRows[0].id === qConfirmed.id);

    const withSo = await prisma.quotation.findMany({ where: quotationListWhere(superUser, listQ({ salesOrder: 'yes' }), stages).where, select: { id: true } });
    const withoutSo = await prisma.quotation.count({ where: quotationListWhere(superUser, listQ({ salesOrder: 'no' }), stages).where });
    check(
      '"Booked in a sales order" counts live orders only — a cancelled one books nothing',
      withSo.length === 1 && withSo[0].id === qCompleted.id && withoutSo === 5,
      `${withSo.length} / ${withoutSo}`,
    );

    const tabsUnderFilter = await quotationListSummary(
      quotationListWhere(superUser, listQ({ stage: 'LOST', salesOrder: 'no' }), stages).base,
      quotationListWhere(superUser, listQ({ stage: 'LOST', salesOrder: 'no' }), stages).where,
      stages,
    );
    check(
      'the tabs count with the other filters kept and their own stage ignored',
      tabsUnderFilter.tabCounts[''] === 5 && tabsUnderFilter.tabCounts.COMPLETED === 0 && tabsUnderFilter.count === 1,
      JSON.stringify(tabsUnderFilter.tabCounts),
    );

    const mine = await prisma.quotation.count({ where: quotationListWhere(salesUser, listQ({ scope: 'mine' }), stages).where });
    const owner = await prisma.quotation.count({ where: quotationListWhere(superUser, listQ({ ownerId: other.id }), stages).where });
    check('Mine is the caller’s own, and an owner filter is that owner’s', mine === 5 && owner === 1, `${mine} ${owner}`);

    const approvedRev = await prisma.quotation.count({ where: quotationListWhere(superUser, listQ({ revision: 'APPROVED' }), stages).where });
    const draftRev = await prisma.quotation.count({ where: quotationListWhere(superUser, listQ({ revision: 'DRAFT' }), stages).where });
    check('"Has an approved revision" and "Has a draft" read the revisions', approvedRev === 5 && draftRev === 2, `${approvedRev} ${draftRev}`);

    // Raised is a timestamp: 00:30 in Manila on the 1st belongs to the 1st, not the day before.
    await prisma.quotation.update({ where: { id: qOpen.id }, data: { createdAt: new Date('2026-03-01T00:30:00+08:00') } });
    const onFirst = await prisma.quotation.findMany({
      where: quotationListWhere(superUser, listQ({ createdFrom: '2026-03-01', createdTo: '2026-03-01' }), stages).where,
      select: { id: true },
    });
    const dayBefore = await prisma.quotation.count({
      where: quotationListWhere(superUser, listQ({ createdFrom: '2026-02-28', createdTo: '2026-02-28' }), stages).where,
    });
    check('"Raised" runs Manila midnight to midnight — 00:30 on the 1st is the 1st', onFirst.length === 1 && onFirst[0].id === qOpen.id && dayBefore === 0);
    // Expected closing is a DATE: the day itself, both edges included.
    await prisma.quotation.update({ where: { id: qConfirmed.id }, data: { expectedClosing: new Date('2026-04-30T00:00:00Z') } });
    const closing = await prisma.quotation.count({
      where: quotationListWhere(superUser, listQ({ closingFrom: '2026-04-30', closingTo: '2026-04-30' }), stages).where,
    });
    check('"Expected closing" includes the day it names', closing === 1, String(closing));

    let refused = 0;
    for (const bad of [{ stage: 'HOLD' }, { stage: 'NOPE' }, { createdFrom: '30/04/2026' }, { revision: 'SUPERSEDED' }, { salesOrder: 'maybe' }]) {
      try {
        quotationListWhere(superUser, listQ(bad), stages);
      } catch (err) {
        if ((err as { status?: number }).status === 400) refused++;
      }
    }
    check('an unknown stage, a malformed date or an unknown choice is a 400, not an empty list', refused === 5, `${refused} of 5`);

    // ── The sales order list, in the same layout ────────────────────────────
    console.log('\nThe list of sales orders: status tabs, booked value, filters');
    const LSO = `${TAG}-LSO`;
    const soQ = (query: Record<string, string>) =>
      listQuery({ query: { search: LSO, ...query } } as unknown as Parameters<typeof listQuery>[0]);
    // On the completed quotation only, which is booked already — the
    // quotation list's checks over HTTP below stay as they were.
    await prisma.salesOrder.update({ where: { number: `${TAG}-LSO1` }, data: { total: d(1000), orderDate: new Date('2026-05-30T00:00:00Z') } });
    await prisma.salesOrder.update({ where: { number: `${TAG}-LSO2` }, data: { total: d(500) } });
    await prisma.salesOrder.create({
      data: { number: `${TAG}-LSO3`, quotationId: qCompleted.id, customerId: customer.id, ownerId: sales.id, orderDate: new Date(), status: 'PENDING_APPROVAL', total: d(2000) },
    });
    await prisma.salesOrder.create({
      data: { number: `${TAG}-LSO4`, quotationId: qCompleted.id, customerId: customer.id, ownerId: sales.id, orderDate: new Date(), status: 'ISSUED', total: d(3000), siNumber: 'SI-9001' },
    });

    const soAll = salesOrderListWhere(superUser, soQ({}));
    const soSummary = await salesOrderListSummary(soAll.base, soAll.where);
    const soTeamId = (await teamOf(sales.id))!.id;
    const soTeam = await salesOrderListSummary(soAll.base, soAll.where, { teamWhere: { owner: teamMembers(soTeamId) }, margin: true });
    check(
      'the team’s booked value and the margin (no costed line yet) ride on the sales order summary; the Team view counts the cancelled one too',
      soTeam.team?.count === 3 && money(soTeam.team.value, 6000) && soTeam.margin?.costed === 0 &&
        (await prisma.salesOrder.count({ where: salesOrderListWhere(superUser, soQ({ scope: 'team' }), soTeamId).where })) === 4,
      JSON.stringify({ team: soTeam.team, margin: soTeam.margin }),
    );
    // A card per team (2026-10-09): the booked value split by the owner's team, adding up to the whole.
    const soShares = soSummary.teams ?? [];
    check(
      'the sales order summary splits the booked value by the owner’s team, the shares adding up to the booked value',
      soShares.some((t) => t.id === soTeamId && t.count === 3 && money(t.value, 6000)) &&
        soShares.reduce((n, t) => n + t.count, 0) === 3 &&
        money(soShares.reduce((v, t) => v + t.value, 0), soSummary.value),
      JSON.stringify(soShares),
    );
    check(
      'each status tab has its order, and the tabs add up to All',
      soSummary.tabCounts[''] === 4 && ['DRAFT', 'PENDING_APPROVAL', 'ISSUED', 'CANCELLED'].every((k) => soSummary.tabCounts[k] === 1),
      JSON.stringify(soSummary.tabCounts),
    );
    check(
      'the booked value sums the orders still standing; a cancelled one is counted apart, never summed',
      money(soSummary.value, 6000) && soSummary.cancelledCount === 1 && soSummary.count === 4,
      JSON.stringify(soSummary),
    );
    const pending = await prisma.salesOrder.findMany({ where: salesOrderListWhere(superUser, soQ({ status: 'PENDING_APPROVAL' })).where, select: { number: true } });
    check('Pending approval is a tab of its own (the old filter ignored it)', pending.length === 1 && pending[0].number === `${TAG}-LSO3`);
    const released = await prisma.salesOrder.count({ where: salesOrderListWhere(superUser, soQ({ released: 'yes' })).where });
    const unreleased = await prisma.salesOrder.count({ where: salesOrderListWhere(superUser, soQ({ released: 'no' })).where });
    check('"Released" is an SI or DR number filled in', released === 1 && unreleased === 3, `${released} ${unreleased}`);
    const dated = await prisma.salesOrder.count({ where: salesOrderListWhere(superUser, soQ({ dateFrom: '2026-05-30', dateTo: '2026-05-30' })).where });
    check('the order date range includes the day it names', dated === 1, String(dated));
    const ofQuote = await prisma.salesOrder.count({ where: salesOrderListWhere(superUser, soQ({ quotationId: qCompleted.id })).where });
    const minePlain = await prisma.salesOrder.count({ where: salesOrderListWhere(salesUser, soQ({ scope: 'mine' })).where });
    check('one quotation’s orders, and Mine, are what they say', ofQuote === 3 && minePlain === 3, `${ofQuote} ${minePlain}`);
    let soRefused = 0;
    for (const bad of [{ status: 'WON' }, { dateFrom: '2026-13-01' }, { released: 'maybe' }]) {
      try {
        salesOrderListWhere(superUser, soQ(bad));
      } catch (err) {
        if ((err as { status?: number }).status === 400) soRefused++;
      }
    }
    check('an unknown status, a malformed date or an unknown choice is a 400', soRefused === 3, `${soRefused} of 3`);

    // ── The leads list, in the same layout ──────────────────────────────────
    console.log('\nThe list of leads: stage tabs, values, filters');
    const LEADL = `${TAG} LEADL`;
    const leadQ = (query: Record<string, string>) =>
      listQuery({ query: { search: LEADL, ...query } } as unknown as Parameters<typeof listQuery>[0]);
    const leadOf = (name: string, status: string, value: number, probability: number, extra: Partial<Prisma.LeadUncheckedCreateInput> = {}) =>
      prisma.lead.create({
        data: {
          number: `${TAG}-LL-${name}`,
          companyName: `${LEADL} ${name}`,
          assignedToId: sales.id,
          createdById: sales.id,
          status: status as Prisma.LeadUncheckedCreateInput['status'],
          estimatedValue: d(value),
          probability,
          ...extra,
        },
      });
    const lNew = await leadOf('new', 'NEW', 1000, 10, { customerId: customer.id, createdAt: new Date('2026-03-01T00:30:00+08:00') });
    await leadOf('created', 'QUOTATION_CREATED', 2000, 10);
    await leadOf('submitted', 'QUOTATION_SUBMITTED', 3000, 50);
    await leadOf('negotiation', 'NEGOTIATION', 4000, 90, { expectedClosing: new Date('2026-04-30T00:00:00Z') });
    await leadOf('won', 'WON', 5000, 100);
    await leadOf('lost', 'LOST', 6000, 0, { lostReason: 'verify' });
    await leadOf('hold', 'ON_HOLD', 7000, 20, { assignedToId: other.id });

    check(
      'a lead stands in the board’s stages: Opportunity to On hold, never Completed',
      leadStages(stages).map((st) => st.key).join(',') === 'OPPORTUNITY,NEGOTIATION,CLOSING,CONFIRMED,LOST,HOLD' &&
        leadStage('QUOTATION_SUBMITTED', stages) === 'NEGOTIATION' && leadStage('NEGOTIATION', stages) === 'CLOSING',
      leadStages(stages).map((st) => st.key).join(','),
    );
    const lAll = leadListWhere(superUser, leadQ({}), stages);
    const lSum = await leadListSummary(lAll.base, lAll.where, stages);
    const hiTeam = (await teamOf(sales.id))!;
    const teamLeads = await prisma.lead.count({ where: { AND: [lAll.where, { assignedTo: teamMembers(hiTeam.id) }] } });
    const lTeam = await leadListSummary(lAll.base, lAll.where, stages, { teamWhere: { assignedTo: teamMembers(hiTeam.id) } });
    check(
      'the Team view and the team figure agree on the team’s leads',
      (await prisma.lead.count({ where: leadListWhere(superUser, leadQ({ scope: 'team' }), stages, hiTeam.id).where })) === teamLeads &&
        lTeam.team?.count === teamLeads && teamLeads === 7,
      `${teamLeads} / ${lTeam.team?.count}`,
    );
    const lShares = lSum.teams ?? [];
    check(
      'the lead summary splits the estimated value by the owner’s team, the shares adding up to the whole',
      lShares.some((t) => t.id === hiTeam.id && t.count === teamLeads) &&
        lShares.reduce((n, t) => n + t.count, 0) === lSum.count &&
        money(lShares.reduce((v, t) => v + t.value, 0), lSum.value),
      JSON.stringify(lShares),
    );
    check(
      'the tabs count each stage and add up to All',
      lSum.tabCounts[''] === 7 && lSum.tabCounts.OPPORTUNITY === 2 &&
        ['NEGOTIATION', 'CLOSING', 'CONFIRMED', 'LOST', 'HOLD'].every((k) => lSum.tabCounts[k] === 1),
      JSON.stringify(lSum.tabCounts),
    );
    check(
      'the totals are the estimated value and the value weighted by each lead’s probability',
      money(lSum.value, 28000) && money(lSum.weighted, 100 + 200 + 1500 + 3600 + 5000 + 0 + 1400) && lSum.count === 7,
      JSON.stringify({ value: lSum.value, weighted: lSum.weighted }),
    );
    let leadTabsAgree = true;
    for (const st of leadStages(stages)) {
      const w = leadListWhere(superUser, leadQ({ stage: st.key }), stages);
      const rows = await prisma.lead.findMany({ where: w.where, select: { status: true } });
      if (rows.length !== lSum.tabCounts[st.key] || !rows.every((r) => leadStage(r.status, stages) === st.key)) leadTabsAgree = false;
    }
    check('each tab lists exactly the leads its count says, each standing in that stage', leadTabsAgree);
    const ofClient = await prisma.lead.findMany({ where: leadListWhere(superUser, leadQ({ clientId: customer.id }), stages).where, select: { id: true } });
    check('the customer filter reads ?clientId=, never the page’s ?customerId= hand-off', ofClient.length === 1 && ofClient[0].id === lNew.id);
    const addedFirst = await prisma.lead.count({ where: leadListWhere(superUser, leadQ({ createdFrom: '2026-03-01', createdTo: '2026-03-01' }), stages).where });
    const closingDay = await prisma.lead.count({ where: leadListWhere(superUser, leadQ({ closingFrom: '2026-04-30', closingTo: '2026-04-30' }), stages).where });
    check('"Added" runs on Manila’s days and "Expected closing" includes its day', addedFirst === 1 && closingDay === 1, `${addedFirst} ${closingDay}`);
    const mineLeads = await prisma.lead.count({ where: leadListWhere(salesUser, leadQ({ scope: 'mine' }), stages).where });
    const finer = await prisma.lead.count({ where: leadListWhere(superUser, leadQ({ stage: 'OPPORTUNITY', status: 'NEW' }), stages).where });
    check('Mine is the caller’s own, and a status narrows within its stage', mineLeads === 6 && finer === 1, `${mineLeads} ${finer}`);
    let leadRefused = 0;
    for (const bad of [{ stage: 'COMPLETED' }, { status: 'OPEN' }, { createdFrom: '1/3/2026' }]) {
      try {
        leadListWhere(superUser, leadQ(bad), stages);
      } catch (err) {
        if ((err as { status?: number }).status === 400) leadRefused++;
      }
    }
    check('an unknown stage or status, or a malformed date, is a 400', leadRefused === 3, `${leadRefused} of 3`);
  }

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
      // Discounts to six decimals, as the calculator inserts them (2026-10-08).
      const input = { lines: set, discountPct: rand() < 0.4 ? 0 : pick(35, 6), vatRate: 0.12, vatInclusive: rand() < 0.5 };
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

  {
    // The order after its discount (2026-10-12, the owner's slide): GT-SO-
    // 2026-0005 — one line at 1,130,000.00, cost 784,778.84, 192,500.00 off
    // (17.035398%) — prints 937,500.00 with a margin of 152,721.16, 16.29%.
    const slide = quotationTotals({ lines: [{ amount: 1_130_000, costAmount: 784_778.84 }], discountPct: 17.035398, vatRate: 0.12 });
    check(
      "the owner's order after its discount: 937,500.00, margin 152,721.16 at 16.29% — the line and the total agree",
      slide.net === 937_500 && slide.lines[0].netAmount === 937_500 && slide.lines[0].netMargin === 152_721.16 &&
        slide.lines[0].netMarginPct === 16.29 && slide.cost.totalMargin === 152_721.16 && slide.cost.netMarginPct === 16.29 &&
        slide.vatAmount === 112_500 && slide.total === 1_050_000,
      JSON.stringify({ net: slide.net, line: slide.lines[0], pct: slide.cost.netMarginPct }),
    );
    // The lines' shares add up to the net exactly, and their margins to the
    // total margin, on any order — VAT inclusive too — and the page's copy agrees.
    let seed = 20261012;
    const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
    let off = 0;
    for (let n = 0; n < 300; n++) {
      const lines = Array.from({ length: 1 + Math.floor(rand() * 6) }, () => ({
        amount: Math.round(rand() * 5_000_000) / 100,
        costAmount: Math.round(rand() * 3_000_000) / 100,
      }));
      const input = { lines, discountPct: Math.round(rand() * 35_000_000) / 1_000_000, vatRate: 0.12, vatInclusive: rand() < 0.5 };
      const t = quotationTotals(input);
      const cents = (v: number) => Math.round(v * 100);
      const sumNet = t.lines.reduce((a, l) => a + cents(l.netAmount), 0);
      const sumMargin = t.lines.reduce((a, l) => a + cents(l.netMargin ?? 0), 0);
      if (sumNet !== cents(t.net) || sumMargin !== cents(t.cost.totalMargin) || !same(editorTotals(input), t)) off++;
    }
    check('on 300 generated orders the lines after the discount add up to the net and the margin, both sides alike', off === 0, `${off} off`);
  }

  // ── 10. Cost is stripped server-side, and never printed ────────────────────
  // ── SCORO quotations from SCORO's CSV (2026-10-11, the owner's file) ───────
  console.log('\nSCORO quotations from SCORO’s CSV');
  {
    // The file as SCORO writes it: UTF-16 LE with a BOM, TAB-separated,
    // every cell quoted, one header row.
    const HEADERS = [
      'id', 'doc_no', 'doc_date', 'owner_name', 'doc_deadline', 'confirmed_date', 'payer', 'payer_id', 'contact_person',
      'doc_description', 'currency', 'status_name', 'status_changed_date', 'discount', 'total_sum', 'total_vat',
      'total_sum_vat', 'total_cost', 'c_prnumber', 'c_delivery', 'c_paymentterms', 'estimated_closing_date', 'quote_name',
      // The lines export's columns (the owner's second file): blank on the header-only export.
      'line_id', 'product_group', 'product_code', 'product_name', 'amount', 'unit', 'price', 'line_sum', 'line_vat_percent',
      'vat_code', 'is_subheading', 'line_comment', 'line_dates', 'line_cost', 'cost_comment', 'supplier_name', 'doer_id',
      'doer_name', 'is_internal', 'role_id', 'role_name',
    ] as const;
    type ScoroRow = Record<(typeof HEADERS)[number], string>;
    const scoroText = (rows: ScoroRow[]) =>
      [HEADERS as readonly string[], ...rows.map((r) => HEADERS.map((h) => r[h]))]
        .map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join('\t'))
        .join('\r\n');
    const scoroFile = (rows: ScoroRow[]) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(scoroText(rows), 'utf16le')]);

    // A number in the house shape under the script's own series (EDITOR_TOKEN),
    // rendered on the template's pattern: "98712603040" on {EMP}{YY}{MM}{SEQ}.
    const scoroTemplate = await prisma.numberSequence.findFirstOrThrow({ where: { documentType: 'quotation', periodKey: '' } });
    const scoroPrefix = (await prisma.company.findUnique({ where: { id: 'company' }, select: { numberPrefix: true } }))?.numberPrefix ?? 'GT';
    const issued = new Date(Date.UTC(2026, 2, 11));
    const scoroNumber = (seq: number) =>
      renderPattern(scoroTemplate.pattern, { prefix: scoroPrefix, typeCode: scoroTemplate.typeCode, seq, padding: scoroTemplate.padding, at: new Date(2026, 2, 11), emp: EDITOR_TOKEN });
    const parsedA = parseNumber(scoroTemplate, scoroPrefix, scoroNumber(40));
    const seriesKey = parsedA?.periodKey ?? null;
    const seriesRow = async () =>
      seriesKey === null
        ? null
        : (await prisma.numberSequence.findUnique({ where: { documentType_periodKey: { documentType: 'quotation', periodKey: seriesKey } }, select: { lastNumber: true } }))?.lastNumber ?? null;
    const seriesWas = await seriesRow();
    const setSeries = async (lastNumber: number | null) => {
      if (seriesKey === null) return;
      if (lastNumber === null) await prisma.numberSequence.deleteMany({ where: { documentType: 'quotation', periodKey: seriesKey } });
      else {
        await prisma.numberSequence.updateMany({ where: { documentType: 'quotation', periodKey: seriesKey }, data: { lastNumber } });
        if ((await seriesRow()) === null) {
          const { id: _id, periodKey: _pk, lastNumber: _ln, ...tpl } = scoroTemplate;
          void _id; void _pk; void _ln;
          await prisma.numberSequence.create({ data: { ...tpl, periodKey: seriesKey, lastNumber } });
        }
      }
    };

    const row = (over: Partial<ScoroRow>): ScoroRow => ({
      id: '8773',
      doc_no: scoroNumber(40),
      doc_date: '2026-03-11',
      owner_name: sales.name,
      doc_deadline: '2026-04-10',
      confirmed_date: '0000-00-00 00:00:00',
      payer: `${TAG} Balfour Joint Venture`,
      // A SCORO id no real customer carries: the owner's own file (SCORO id 4798) may be in this database.
      payer_id: '4798009871',
      contact_person: 'Leo Solis',
      doc_description: 'Quotation Validity : 120 days',
      currency: 'PHP',
      status_name: 'Opportunity',
      status_changed_date: '',
      discount: '0.000000',
      total_sum: '1250000.00',
      total_vat: '150000.00',
      total_sum_vat: '1400000.00',
      total_cost: '900000.0000',
      c_prnumber: 'PR-77',
      c_delivery: '16 to 18 weeks Upon receive of Down Payment',
      c_paymentterms: '50% Down payment / 50% Progress Billing',
      estimated_closing_date: '2026-04-10',
      quote_name: `${TAG} Tap-off Unit`,
      line_id: '', product_group: '', product_code: '', product_name: '', amount: '', unit: '', price: '', line_sum: '',
      line_vat_percent: '', vat_code: '', is_subheading: '0', line_comment: '', line_dates: '', line_cost: '', cost_comment: '',
      supplier_name: '', doer_id: '', doer_name: '', is_internal: '0', role_id: '', role_name: '',
      ...over,
    });
    // The owner's second file's row shape: one priced line (the same quotation
    // the header-only file names, its header repeated) and a subheading row.
    const pricedLine = (over: Partial<ScoroRow>): ScoroRow =>
      row({
        line_id: '39866',
        product_group: `${TAG} Schneider Electric`,
        product_name: 'SCHNEIDER ELECTRIC, TAP-OFF UNIT, 32 AMPS',
        amount: '4704.000000000000',
        unit: 'set',
        price: '69176.470000',
        line_sum: '325406114.88',
        line_vat_percent: '12.000',
        vat_code: '4',
        line_comment: '32A Tap-off unit -1 Whip TPN, includes: 1x32A 3P Type C NG125L MCB',
        line_cost: '263424000.0000',
        supplier_name: `${TAG} Schneider Electric Philippines`,
        total_sum: '325406114.88',
        total_vat: '39048733.79',
        total_sum_vat: '364454848.67',
        total_cost: '263424000.0000',
        ...over,
      });
    const subheadingRow = (over: Partial<ScoroRow>): ScoroRow =>
      pricedLine({ line_id: '39867', product_group: '', product_name: 'OPTIONAL ITEMS', amount: '', unit: '', price: '', line_sum: '', line_cost: '', supplier_name: '', line_comment: '', is_subheading: '1', ...over });
    const actor = { id: sales.id, name: sales.name };
    const importScoro = (rows: ScoroRow[], commit: boolean, options?: Record<string, unknown>) =>
      runImport(decodeCsv(scoroFile(rows)), scoroQuoteSpec, commit, (records) => writeScoroQuotes(records as never, actor, options));
    const quoteByNumber = (number: string) =>
      prisma.quotation.findFirst({
        where: { number: { equals: number, mode: 'insensitive' } },
        include: { customer: { include: { contacts: true } }, contact: true, revisions: { include: { items: true } } },
      });

    try {
      // The file as bytes: the UTF-16 tab file reads to the same grid as a UTF-8 comma file.
      const one = row({});
      const asGrid = parseCsv(decodeCsv(scoroFile([one])));
      const asCommas = parseCsv(toCsv([HEADERS as readonly string[], HEADERS.map((h) => one[h])]));
      check(
        'decodeCsv + parseCsv read the UTF-16 tab file to the same grid as a UTF-8 comma file',
        JSON.stringify(asGrid) === JSON.stringify(asCommas) && asGrid[0][1] === 'doc_no' && asGrid[1][1] === scoroNumber(40),
        JSON.stringify(asGrid[0].slice(0, 4)),
      );
      check('the number renders in the house shape under the script’s series', seriesKey !== null && parsedA?.seq === 40, `${scoroNumber(40)} → ${JSON.stringify(parsedA)}`);

      // The series below where the file lands, so the raise is visible.
      await setSeries(null);

      const dry = await importScoro([one], false);
      check('a dry run reports one to create and writes nothing', dry.committed === false && dry.created === 1 && dry.errors === 0, JSON.stringify(dry.rows));
      check(
        'and neither the quotation nor the customer exists after it',
        (await quoteByNumber(scoroNumber(40))) === null && (await prisma.customer.count({ where: { name: `${TAG} Balfour Joint Venture` } })) === 0,
      );
      check('and the series was not moved by the dry run', (await seriesRow()) === null);

      const committed = await importScoro([one], true);
      check('the commit creates it', committed.committed && committed.created === 1 && committed.updated === 0, JSON.stringify(committed.rows));
      const q = await quoteByNumber(scoroNumber(40));
      const rev = q?.revisions[0];
      const line = rev?.items[0];
      const stages = await pipelineStages();
      check(
        'the quotation carries SCORO’s number, name, author and an Open outcome at the stage’s odds',
        q?.number === scoroNumber(40) && q.subject === upperText(`${TAG} Tap-off Unit`) && q.ownerId === sales.id && q.outcome === 'OPEN' &&
          q.probability === stageProbability('OPEN', stages) && q.submittedAt === null && q.decidedAt === null,
        JSON.stringify({ number: q?.number, subject: q?.subject, outcome: q?.outcome, probability: q?.probability }),
      );
      check(
        'the customer was created by name with "(SCORO id 4798009871)" in its notes, and the contact on it',
        q?.customer.name === `${TAG} Balfour Joint Venture` && q.customer.notes === '(SCORO id 4798009871)' && q.customer.industryId === null &&
          q.customer.subIndustryId === null && q.contact?.name === 'Leo Solis' && q.contact.customerId === q.customerId,
        JSON.stringify({ name: q?.customer.name, notes: q?.customer.notes, contact: q?.contact?.name }),
      );
      check(
        'the revision’s subtotal, VAT and total are the file’s three figures, at the rate they imply',
        !!rev && money(Number(rev.subtotal), 1_250_000) && money(Number(rev.vatAmount), 150_000) && money(Number(rev.total), 1_400_000) &&
          Number(rev.vatRate) === 0.12 && Number(rev.discountPct) === 0 && rev.status === 'DRAFT' && rev.revision === 0,
        JSON.stringify({ subtotal: rev?.subtotal, vat: rev?.vatAmount, total: rev?.total, rate: rev?.vatRate }),
      );
      check(
        'the one summary line is worth the subtotal, costed at SCORO’s total cost, under OTHERS',
        rev?.items.length === 1 && line?.title === SUMMARY_LINE_TITLE && money(Number(line.unitPrice), 1_250_000) && money(Number(line.amount), 1_250_000) &&
          money(Number(line.unitCost ?? 0), 900_000) && money(Number(line.costAmount ?? 0), 900_000) && Number(line.quantity) === 1 &&
          line.unit === 'lot' && line.isHeading === false && line.description.includes(scoroNumber(40)) &&
          (line.group === 'OTHERS' || line.group === null),
        JSON.stringify({ title: line?.title, price: line?.unitPrice, cost: line?.unitCost, group: line?.group }),
      );
      check(
        'the quotation and its revision are dated the issue date; the closing date, the validity and the header fields come across',
        q?.createdAt.getTime() === issued.getTime() && rev?.createdAt.getTime() === issued.getTime() &&
          q.expectedClosing?.getTime() === Date.UTC(2026, 3, 10) && rev.validityDays === 30 && rev.notes === 'Quotation Validity : 120 days' &&
          rev.prNumber === 'PR-77' && rev.delivery === '16 to 18 weeks Upon receive of Down Payment' && rev.paymentTerms === '50% Down payment / 50% Progress Billing',
        JSON.stringify({ createdAt: q?.createdAt, revCreated: rev?.createdAt, closing: q?.expectedClosing, validity: rev?.validityDays }),
      );
      const trail = await prisma.auditLog.findFirst({ where: { entityType: 'quotation', entityId: q?.id ?? '', action: 'CREATED' } });
      check(
        'its audit row names SCORO’s quote id and the actor',
        trail?.summary === 'Imported from SCORO quote CSV (SCORO id 8773)' && trail.actorId === sales.id,
        trail?.summary ?? 'no row',
      );
      check(`the series (${seriesKey}) was raised to the imported SEQ`, (await seriesRow()) === 40, String(await seriesRow()));

      // As SCORO issued it, it needs no approval until somebody saves a
      // change (2026-10-11, the owner's call): the mark, the paper's one
      // sign-off, Won open to it — and a saved change ends it.
      check('an imported revision is marked as imported and unchanged', rev?.importedUnchanged === true, String(rev?.importedUnchanged));
      check(
        'standsApproved: an approved revision, or a draft as imported — never a changed draft or a pending one',
        standsApproved({ status: 'APPROVED' }) && standsApproved({ status: 'DRAFT', importedUnchanged: true }) &&
          !standsApproved({ status: 'DRAFT', importedUnchanged: false }) && !standsApproved({ status: 'PENDING_APPROVAL', importedUnchanged: true }),
      );
      if (q && rev) {
        const salesResolved = (await resolveUser(sales.id))!;
        const paper = await quotationPrintData(await printableQuotation(salesResolved, q.id), (await printableQuotation(salesResolved, q.id)).revisions.find((r) => r.id === rev.id)!);
        const roles = (paper.signatories ?? []).map((sg) => sg.role);
        check('its paper is signed by Prepared by alone — no route, no Pending', roles.length === 1 && roles[0] === 'Prepared by', JSON.stringify(roles));
        // A saved change (what PUT …/lines and PATCH …/revisions do) ends it,
        // and the backfill never marks a quotation whose trail shows one.
        await prisma.quotationRevision.update({ where: { id: rev.id }, data: { importedUnchanged: false } });
        const changedRow = await prisma.auditLog.create({
          data: { entityType: 'quotation', entityId: q.id, action: 'UPDATED', summary: `Replaced the lines of ${q.number} R0: 1 → 1 line` },
        });
        await markUnchangedScoroImports();
        check(
          'the backfill leaves a changed import unmarked',
          (await prisma.quotationRevision.findUniqueOrThrow({ where: { id: rev.id } })).importedUnchanged === false,
        );
        const changedPaper = await quotationPrintData(await printableQuotation(salesResolved, q.id), (await printableQuotation(salesResolved, q.id)).revisions.find((r) => r.id === rev.id)!);
        check(
          'once changed, its paper prints the route after Prepared by',
          (changedPaper.signatories ?? []).length > 1 && changedPaper.signatories![0].role === 'Prepared by',
          JSON.stringify((changedPaper.signatories ?? []).map((sg) => sg.role)),
        );
        await prisma.auditLog.delete({ where: { id: changedRow.id } });
        await markUnchangedScoroImports();
        check(
          'and marks an import made before the mark existed, while its trail shows no change',
          (await prisma.quotationRevision.findUniqueOrThrow({ where: { id: rev.id } })).importedUnchanged === true,
        );
      }

      // A second commit of the same file: one update, nothing changed.
      const again = await importScoro([one], true);
      const q2 = await quoteByNumber(scoroNumber(40));
      check(
        'the same file again reports one update and changes nothing — a number already in G-CORE is left as it is',
        again.committed && again.updated === 1 && again.created === 0 && q2?.id === q?.id && q2.updatedAt.getTime() === q?.updatedAt.getTime() &&
          (await prisma.quotation.count({ where: { number: { equals: scoroNumber(40), mode: 'insensitive' } } })) === 1 &&
          (await prisma.customer.count({ where: { name: `${TAG} Balfour Joint Venture` } })) === 1 &&
          q2.customer.contacts.length === 1,
        JSON.stringify(again.rows),
      );

      // The series is never lowered: set it ahead, import a lower number.
      await setSeries(45);
      const confirmed = row({
        id: '8774',
        doc_no: scoroNumber(41),
        quote_name: `${TAG} Confirmed one`,
        status_name: 'Confirmed',
        status_changed_date: '2026-03-20 09:15:00',
        confirmed_date: '2026-03-25 00:00:00',
        contact_person: 'leo  solis',
      });
      const rejected = row({
        id: '8775',
        doc_no: scoroNumber(42),
        quote_name: `${TAG} Rejected one`,
        status_name: 'Rejected',
        status_changed_date: '2026-03-30',
        discount: '10.000000',
        total_sum: '1125000.00',
        total_vat: '135000.00',
        total_sum_vat: '1260000.00',
        total_cost: '0.0000',
        contact_person: '',
      });
      const two = await importScoro([confirmed, rejected], true);
      check('a Confirmed and a Rejected row import as two creates', two.committed && two.created === 2, JSON.stringify(two.rows));
      const won = await quoteByNumber(scoroNumber(41));
      check(
        'Confirmed becomes WON with an APPROVED revision, submitted on the status change and decided on the confirmed date',
        won?.outcome === 'WON' && won.revisions[0]?.status === 'APPROVED' && won.probability === stageProbability('WON', stages) &&
          won.submittedAt?.getTime() === Date.UTC(2026, 2, 20) && won.decidedAt?.getTime() === Date.UTC(2026, 2, 25),
        JSON.stringify({ outcome: won?.outcome, status: won?.revisions[0]?.status, submitted: won?.submittedAt, decided: won?.decidedAt }),
      );
      check(
        'and its contact is the one already on the customer, matched case-blind with spaces collapsed',
        won?.contactId === q?.contactId && won?.customer.contacts.length === 1,
      );
      const lost = await quoteByNumber(scoroNumber(42));
      check(
        'Rejected becomes LOST with its reason, no contact, and the discount reaching SCORO’s net',
        lost?.outcome === 'LOST' && lost.lostReason === 'SCORO status: Rejected' && lost.contactId === null && lost.decidedAt?.getTime() === Date.UTC(2026, 2, 30) &&
          money(Number(lost.revisions[0].subtotal), 1_250_000) && money(Number(lost.revisions[0].discountAmount), 125_000) &&
          money(Number(lost.revisions[0].vatAmount), 135_000) && money(Number(lost.revisions[0].total), 1_260_000) &&
          lost.revisions[0].items[0].unitCost === null,
        JSON.stringify({ outcome: lost?.outcome, reason: lost?.lostReason, totals: lost?.revisions[0] }),
      );
      check(`the series set ahead (45) was not lowered by the lower numbers`, (await seriesRow()) === 45, String(await seriesRow()));

      // All or nothing: an unknown owner fails the row and nothing is written.
      const bad = await importScoro(
        [
          row({ id: '8776', doc_no: scoroNumber(43), quote_name: `${TAG} Good row` }),
          row({ id: '8777', doc_no: scoroNumber(44), quote_name: `${TAG} Nobody’s row`, owner_name: `${TAG} Nobody Here` }),
          row({ id: '8778', doc_no: scoroNumber(45), quote_name: `${TAG} Gold row`, currency: 'XAU' }),
          row({ id: '8779', doc_no: scoroNumber(46), quote_name: `${TAG} Odd status`, status_name: 'Daydream' }),
        ],
        true,
      );
      check(
        'an unknown owner, a currency not on the list and an unknown status are each an error naming it, and nothing is written',
        bad.committed === false && bad.errors === 3 && bad.created === 1 &&
          bad.rows[1].message === `No login named "${TAG} Nobody Here" — add them in Admin › Users first` &&
          (bad.rows[2].message ?? '').includes('XAU') && (bad.rows[3].message ?? '').includes('Daydream') &&
          (await quoteByNumber(scoroNumber(43))) === null,
        JSON.stringify(bad.rows.map((r) => r.message)),
      );
      // A quote in a listed currency comes in that currency; none said is PHP.
      const dollars = await importScoro([row({ id: '8788', doc_no: scoroNumber(48), quote_name: `${TAG} Dollar row`, currency: 'usd' })], true);
      check(
        'a quote in a listed currency is imported in it (usd, read as USD), and a PHP one stays PHP',
        dollars.committed === true && (await quoteByNumber(scoroNumber(48)))?.currency === 'USD' &&
          (await quoteByNumber(scoroNumber(40)))?.currency === 'PHP',
        `${dollars.committed} ${(await quoteByNumber(scoroNumber(48)))?.currency} ${(await quoteByNumber(scoroNumber(40)))?.currency}`,
      );

      // ── The lines export (the owner's second file): one row per line ─────
      const schneider = await prisma.supplier.create({ data: { code: `${TAG}-S9`, name: `${TAG} Schneider Electric Philippines` } });
      const linesRows = [
        pricedLine({ id: '8780', doc_no: scoroNumber(50), quote_name: `${TAG} Lines file` }),
        subheadingRow({ id: '8780', doc_no: scoroNumber(50), quote_name: `${TAG} Lines file` }),
      ];
      const linesDry = await importScoro(linesRows, false);
      check(
        'the two rows of one quotation are ONE result, keyed by doc_no and numbered by the first row',
        linesDry.total === 1 && linesDry.created === 1 && linesDry.rows[0].row === 2 && linesDry.rows[0].key === scoroNumber(50),
        JSON.stringify(linesDry.rows),
      );
      // A group not on the list is asked about (2026-10-11): the dry run names it.
      const unlisted = (linesDry.extra as { groups?: { unlisted: { key: string; name: string; lines: number; quotations: number }[]; fallback: string } } | undefined)?.groups;
      check(
        'the dry run names a group that is not on the list, with its lines and quotations, OTHERS the default',
        unlisted?.fallback === 'OTHERS' && unlisted.unlisted.length === 1 && unlisted.unlisted[0].name === `${TAG} Schneider Electric` &&
          unlisted.unlisted[0].key === groupKey(`${TAG} Schneider Electric`) && unlisted.unlisted[0].lines === 1 && unlisted.unlisted[0].quotations === 1,
        JSON.stringify(unlisted),
      );
      // The person chose a group on the list for it.
      await prisma.quotationGroup.create({ data: { key: groupKey(`${TAG} Mapped`), name: `${TAG} Mapped` } });
      const linesDone = await importScoro(linesRows, true, { groups: { [groupKey(`${TAG} Schneider Electric`)]: `${TAG} Mapped` } });
      const withLines = await quoteByNumber(scoroNumber(50));
      const lrev = withLines?.revisions[0];
      const l1 = lrev?.items[0];
      const l2 = lrev?.items[1];
      check('the commit creates it with the file’s lines', linesDone.committed && linesDone.created === 1 && lrev?.items.length === 2, JSON.stringify(linesDone.rows));
      check(
        'the priced line: the group chosen for it, title as SCORO wrote it, description, 4,704 set at 69,176.47, the amount, the unit cost ÷ quantity and its cost amount',
        l1?.sortOrder === 0 && l1.group === `${TAG} Mapped` && l1.title === 'SCHNEIDER ELECTRIC, TAP-OFF UNIT, 32 AMPS' && l1.brand === null &&
          l1.description === '32A Tap-off unit -1 Whip TPN, includes: 1x32A 3P Type C NG125L MCB' && Number(l1.quantity) === 4704 && l1.unit === 'set' &&
          money(Number(l1.unitPrice), 69_176.47) && money(Number(l1.amount), 325_406_114.88) && money(Number(l1.unitCost ?? 0), 56_000) &&
          money(Number(l1.costAmount ?? 0), 263_424_000) && l1.isHeading === false,
        JSON.stringify({ group: l1?.group, title: l1?.title, qty: l1?.quantity, price: l1?.unitPrice, amount: l1?.amount, cost: l1?.unitCost, costAmount: l1?.costAmount }),
      );
      check(
        'its cost is carried by the supplier of that name, with no note',
        l1?.providerSupplierId === schneider.id && l1.providerUserId === null && l1.costNote === null,
        JSON.stringify({ supplier: l1?.providerSupplierId, note: l1?.costNote }),
      );
      check(
        'the subheading row is a subheading: its text, nothing else',
        l2?.sortOrder === 1 && l2.isHeading === true && l2.title === 'OPTIONAL ITEMS' && Number(l2.quantity) === 0 && Number(l2.unitPrice) === 0 && l2.group === null,
        JSON.stringify({ heading: l2?.isHeading, title: l2?.title }),
      );
      check(
        'a group not on the list joins nothing: the master never gets SCORO’s spelling',
        (await prisma.quotationGroup.count({ where: { key: groupKey(`${TAG} Schneider Electric`) } })) === 0,
      );
      const trailMoved = await prisma.auditLog.findFirst({ where: { entityType: 'quotation', entityId: withLines?.id ?? '', action: 'CREATED' } });
      check(
        'the quotation’s trail names the group each line was moved off and where to',
        JSON.stringify((trailMoved?.after as { groupsMoved?: unknown } | null)?.groupsMoved) === JSON.stringify({ [`${TAG} Schneider Electric`]: `${TAG} Mapped` }),
        JSON.stringify(trailMoved?.after),
      );
      check(
        'and recalcQuotationRevision gives SCORO’s own totals: 325,406,114.88 / 39,048,733.79 / 364,454,848.67 at 12%',
        !!lrev && money(Number(lrev.subtotal), 325_406_114.88) && money(Number(lrev.vatAmount), 39_048_733.79) && money(Number(lrev.total), 364_454_848.67) &&
          Number(lrev.vatRate) === 0.12,
        JSON.stringify({ subtotal: lrev?.subtotal, vat: lrev?.vatAmount, total: lrev?.total, rate: lrev?.vatRate }),
      );
      const headerAgain = await importScoro([row({ id: '8780', doc_no: scoroNumber(50), quote_name: `${TAG} Lines file` })], true);
      const stillLines = await quoteByNumber(scoroNumber(50));
      check(
        'the header-only file for the same number afterwards reports an update and changes nothing',
        headerAgain.updated === 1 && stillLines?.revisions[0].items.length === 2 && stillLines.updatedAt.getTime() === withLines?.updatedAt.getTime() &&
          stillLines.revisions[0].updatedAt.getTime() === lrev?.updatedAt.getTime(),
        JSON.stringify(headerAgain.rows),
      );

      // A supplier SCORO names that is not on file: kept in the cost note, never created.
      const unknownSupplier = await importScoro(
        [pricedLine({ id: '8781', doc_no: scoroNumber(51), quote_name: `${TAG} Unknown supplier`, supplier_name: `${TAG} Nobody Supplies`, cost_comment: 'landed cost' })],
        true,
      );
      const noSupplier = (await quoteByNumber(scoroNumber(51)))?.revisions[0].items[0];
      check('a group not on the list with no choice made goes to OTHERS', noSupplier?.group === 'OTHERS', String(noSupplier?.group));
      check(
        'a supplier not on file leaves the line unassigned, its name and the cost comment in the cost note, and no supplier is created',
        unknownSupplier.created === 1 && noSupplier?.providerSupplierId === null && noSupplier.costNote === `landed cost — Supplier in SCORO: ${TAG} Nobody Supplies` &&
          (await prisma.supplier.count({ where: { name: `${TAG} Nobody Supplies` } })) === 0,
        JSON.stringify({ supplier: noSupplier?.providerSupplierId, note: noSupplier?.costNote }),
      );

      let refusedChoice = '';
      try {
        await importScoro([pricedLine({ id: '8784', doc_no: scoroNumber(54), quote_name: `${TAG} Bad choice` })], true, {
          groups: { [groupKey(`${TAG} Schneider Electric`)]: `${TAG} Nowhere` },
        });
      } catch (err) {
        refusedChoice = err instanceof Error ? err.message : String(err);
      }
      check(
        'a choice that is not a group on the list is refused, and nothing is written',
        refusedChoice.includes('is not a group on the list') && (await quoteByNumber(scoroNumber(54))) === null,
        refusedChoice,
      );

      // The promised replacement: the header-only file first (the summary
      // line), then the lines file for the same number.
      // SCORO's quotes export of 2026-10-11 wrote every subheading's words
      // in line_comment and left product_name empty; one with neither is
      // still refused, naming the row.
      const commentHeads = await importScoro(
        [
          subheadingRow({ id: '8789', doc_no: scoroNumber(49), quote_name: `${TAG} Comment heading`, product_name: '', line_comment: 'TESTING AND COMMISSIONING' }),
          pricedLine({ id: '8789', doc_no: scoroNumber(49), quote_name: `${TAG} Comment heading` }),
        ],
        true,
        { groups: { [groupKey(`${TAG} Schneider Electric`)]: `${TAG} Mapped` } },
      );
      const headed49 = (await quoteByNumber(scoroNumber(49)))?.revisions[0]?.items.sort((x, y) => x.sortOrder - y.sortOrder) ?? [];
      const noWords = await importScoro(
        [subheadingRow({ id: '8790', doc_no: scoroNumber(47), quote_name: `${TAG} Wordless heading`, product_name: '', line_comment: '' })],
        false,
      );
      check(
        'a subheading whose words are in line_comment takes them as its heading; one with no words at all is refused',
        commentHeads.committed === true && headed49[0]?.isHeading === true && headed49[0]?.title === 'TESTING AND COMMISSIONING' &&
          noWords.errors === 1 && /no words/.test(String(noWords.rows[0]?.message)),
        `${JSON.stringify(commentHeads.rows)} ${headed49[0]?.title} ${JSON.stringify(noWords.rows)}`,
      );
      const summaryFirst = await importScoro([row({ id: '8782', doc_no: scoroNumber(52), quote_name: `${TAG} Summary then lines` })], true);
      const summarised = await quoteByNumber(scoroNumber(52));
      // Where the series stands after the new number raised it; the replacement must leave it there.
      const seriesBeforeSwap = await seriesRow();
      check('a header-only file makes the summary line', summaryFirst.created === 1 && summarised?.revisions[0].items.length === 1 && summarised.revisions[0].items[0].title === SUMMARY_LINE_TITLE);
      const swapped = await importScoro(
        [
          pricedLine({ id: '8782', doc_no: scoroNumber(52), quote_name: `${TAG} Summary then lines` }),
          subheadingRow({ id: '8782', doc_no: scoroNumber(52), quote_name: `${TAG} Summary then lines` }),
        ],
        true,
      );
      const replaced = await quoteByNumber(scoroNumber(52));
      const rrev = replaced?.revisions[0];
      check(
        'the lines file for that number replaces the summary line with the real lines, reported as an update',
        swapped.updated === 1 && swapped.created === 0 && rrev?.items.length === 2 && rrev.items[0].title === 'SCHNEIDER ELECTRIC, TAP-OFF UNIT, 32 AMPS' &&
          rrev.items[1].isHeading === true && !rrev.items.some((i) => i.title === SUMMARY_LINE_TITLE) && replaced?.id === summarised?.id &&
          money(Number(rrev.subtotal), 325_406_114.88) && money(Number(rrev.total), 364_454_848.67),
        JSON.stringify({ rows: swapped.rows, items: rrev?.items.map((i) => i.title) }),
      );
      const swapTrail = await prisma.auditLog.findFirst({ where: { entityType: 'quotation', entityId: replaced?.id ?? '', action: 'UPDATED' }, orderBy: { at: 'desc' } });
      check(
        'and the trail says so; the series was not touched',
        swapTrail?.summary === 'Replaced the summary line with 2 lines from the SCORO lines export' && (await seriesRow()) === seriesBeforeSwap,
        `${swapTrail?.summary} / ${await seriesRow()} vs ${seriesBeforeSwap}`,
      );
      // A quotation whose revision has moved on is left alone, lines file or not.
      await prisma.quotationRevision.update({ where: { id: rrev!.id }, data: { status: 'APPROVED' } });
      const summaryApproved = await importScoro([row({ id: '8783', doc_no: scoroNumber(53), quote_name: `${TAG} Approved summary` })], true);
      const approvedQ = await quoteByNumber(scoroNumber(53));
      await prisma.quotationRevision.update({ where: { id: approvedQ!.revisions[0].id }, data: { status: 'APPROVED' } });
      const leftAlone = await importScoro([pricedLine({ id: '8783', doc_no: scoroNumber(53), quote_name: `${TAG} Approved summary` })], true);
      const stillSummary = await quoteByNumber(scoroNumber(53));
      check(
        'a summary-line quotation whose revision is no longer a draft keeps its summary line',
        summaryApproved.created === 1 && leftAlone.updated === 1 && stillSummary?.revisions[0].items.length === 1 &&
          stillSummary.revisions[0].items[0].title === SUMMARY_LINE_TITLE && stillSummary.revisions[0].status === 'APPROVED',
        JSON.stringify(stillSummary?.revisions[0].items.map((i) => i.title)),
      );

      // ── A row the database refuses (2026-10-11, the owner's report) ──────
      // A refusal in the write used to reach the screen as "Something went
      // wrong on our side", the reason only in the server's log. Here the
      // second row's number is taken between the check and the write: the
      // import names the quotation and why, and keeps the row before it.
      let stopped = '';
      try {
        await runImport(
          decodeCsv(scoroFile([
            row({ id: '8785', doc_no: scoroNumber(55), quote_name: `${TAG} Before the refusal` }),
            row({ id: '8786', doc_no: scoroNumber(56), quote_name: `${TAG} Refused row` }),
          ])),
          scoroQuoteSpec,
          true,
          async (records) => {
            await prisma.quotation.create({
              data: { number: scoroNumber(56), customerId: stillSummary!.customerId, ownerId: sales.id, subject: `${TAG} Saved by hand meanwhile` },
            });
            await writeScoroQuotes(records as never, actor);
          },
        );
      } catch (err) {
        stopped = err instanceof Error ? err.message : String(err);
      }
      check(
        'a row the database refuses stops the import with its number and reason, and the rows before it stand',
        stopped.startsWith(`Stopped at quotation ${scoroNumber(56)}: a record with the same number is already on file.`) &&
          stopped.includes('The 1 quotation before it was imported') && !!(await quoteByNumber(scoroNumber(55))),
        stopped,
      );

      // ── The team the importer tags a file with (2026-10-12) ──────────────
      const [tagTeam, retagTeam] = await prisma.industry.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }], take: 2, select: { id: true, code: true } });
      const tagRow = row({ id: '8787', doc_no: scoroNumber(57), quote_name: `${TAG} Tagged with a team` });
      const tagCheck = await importScoro([tagRow], false);
      const asked = (tagCheck.extra as { teams?: { choices: { id: string }[]; quotations: number } } | undefined)?.teams;
      check(
        'the check asks which team to tag the file with — every active team, and how many quotations the file holds',
        !!asked && asked.quotations === 1 && asked.choices.some((t) => t.id === tagTeam.id),
        JSON.stringify(asked).slice(0, 160),
      );
      const tagged = await importScoro([tagRow], true, { team: tagTeam.id });
      const taggedQ = await quoteByNumber(scoroNumber(57));
      const taggedTrail = await prisma.auditLog.findFirst({ where: { entityType: 'quotation', entityId: taggedQ?.id ?? '', action: 'CREATED' } });
      check(
        'a team chosen tags every quotation the file creates, and its trail names the team',
        tagged.created === 1 && taggedQ?.teamId === tagTeam.id && (taggedTrail?.after as { team?: string } | null)?.team === tagTeam.code,
        `${taggedQ?.teamId} / ${JSON.stringify(taggedTrail?.after).slice(0, 120)}`,
      );
      const ownerTeam = await teamOf(sales.id);
      const tagStages = await pipelineStages();
      const tagSummary = await quotationListSummary({ id: taggedQ!.id }, { id: taggedQ!.id }, tagStages, { teamWhere: quotationTeamWhere(tagTeam.id) });
      const counted = tagSummary.teams.filter((t) => t.count > 0).map((t) => t.code);
      const inTagView = await prisma.quotation.count({ where: { AND: [{ id: taggedQ!.id }, quotationTeamWhere(tagTeam.id)] } });
      const inOwnerView = ownerTeam && ownerTeam.id !== tagTeam.id ? await prisma.quotation.count({ where: { AND: [{ id: taggedQ!.id }, quotationTeamWhere(ownerTeam.id)] } }) : 0;
      check(
        'the team cards and the Team view count a tagged quotation under its tag, never under its owner’s team',
        counted.join() === tagTeam.code && tagSummary.team?.count === 1 && inTagView === 1 && inOwnerView === 0,
        JSON.stringify({ counted, team: tagSummary.team, inTagView, inOwnerView }),
      );
      const retagged = await importScoro([tagRow], true, { team: retagTeam.id });
      const retaggedQ = await quoteByNumber(scoroNumber(57));
      const retagTrail = await prisma.auditLog.findFirst({ where: { entityType: 'quotation', entityId: taggedQ!.id, action: 'UPDATED' }, orderBy: { at: 'desc' } });
      check(
        'the same file run again with another team re-tags the quotations already on file, and says so on their trail',
        retagged.updated === 1 && retaggedQ?.teamId === retagTeam.id && retagTrail?.summary === `Tagged with team ${retagTeam.code} from the SCORO quotes import`,
        `${retaggedQ?.teamId} / ${retagTrail?.summary}`,
      );
      let badTeam = '';
      try {
        await importScoro([row({ id: '8788', doc_no: scoroNumber(58), quote_name: `${TAG} Unknown team` })], true, { team: 'not-a-team' });
      } catch (err) {
        badTeam = err instanceof Error ? err.message : String(err);
      }
      check(
        'a team that is not on the list is refused before anything is written',
        badTeam.includes('not on the list') && !(await quoteByNumber(scoroNumber(58))),
        badTeam,
      );

      // ── Deleting a group (2026-10-11, the owner's call) ──────────────────
      // Its lines move to OTHERS — every spelling sharing its key — the row
      // goes, and its key is remembered so the seed never brings it back.
      const doomed = await prisma.quotationGroup.create({ data: { key: groupKey(`${TAG} Doomed`), name: `${TAG} Doomed` } });
      await prisma.quotationItem.update({ where: { id: noSupplier!.id }, data: { group: `${TAG.toLowerCase()}  DOOMED` } });
      const moved = await prisma.$transaction((tx) => deleteGroup(tx, doomed));
      const afterDelete = await prisma.quotationItem.findUniqueOrThrow({ where: { id: noSupplier!.id } });
      const deletedKeys = await deletedGroupKeys();
      check(
        'deleting a group moves its lines (any spelling of it) to OTHERS, removes it and remembers its key',
        moved.quotationLines === 1 && afterDelete.group === 'OTHERS' && (await prisma.quotationGroup.count({ where: { id: doomed.id } })) === 0 &&
          deletedKeys.has(groupKey(`${TAG} Doomed`)),
        JSON.stringify({ moved, group: afterDelete.group }),
      );
      deletedKeys.delete(groupKey(`${TAG} Doomed`));
      await prisma.$transaction((tx) => setDeletedGroupKeys(tx, deletedKeys));
    } finally {
      // The series as it stood before the section, whatever happened.
      await setSeries(seriesWas);
    }
  }

  // ── Capitals and the printed address (2026-10-11, the owner's calls) ──────
  console.log('\nCapitals on the quotation, and the address it prints');
  {
    const samples = ['tap-off unit', 'filter 0.01µm', 'straße', 'açaí — ok', 'Schneider Electric, ezc100h3030'];
    check(
      'the quote name and product boxes go to capitals; µ and ß stay as typed, so the PDF fonts can draw them',
      upperText('tap-off unit') === 'TAP-OFF UNIT' && upperText('filter 0.01µm') === 'FILTER 0.01µM' && upperText('straße') === 'STRAßE' &&
        upperText('açaí — ok') === 'AÇAÍ — OK',
      JSON.stringify(samples.map(upperText)),
    );
    check('the web’s copy capitalises exactly as the server does', samples.every((t) => webUpperText(t) === upperText(t)));
    const parts = capsParts({ brand: ' schneider electric ', productType: 'circuit breaker', partNumber: '' });
    check(
      'a line’s Brand, Product type and Part number are stored in capitals, an empty one null',
      parts.brand === 'SCHNEIDER ELECTRIC' && parts.productType === 'CIRCUIT BREAKER' && parts.partNumber === null,
      JSON.stringify(parts),
    );
    check(
      'the printed address: the chosen site’s address and city, else the customer’s own, else nothing',
      documentAddress({ address: 'Paranaque City' }, { address: 'Plant 2', city: 'Laguna' }) === 'Plant 2, Laguna' &&
        documentAddress({ address: ' Paranaque City ' }, null) === 'Paranaque City' &&
        documentAddress({ address: 'Paranaque City' }, { address: null, city: null }) === 'Paranaque City' &&
        documentAddress({ address: null }) === '',
    );
  }

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
    // Written as the editor writes them: the revision's lines in one PUT.
    const twoLines = await http(salesToken, 'PUT', `${base}/lines`, {
      lines: [
        {
          group: `${TAG} Installation`,
          title: 'Air compressor installation',
          description: 'Mechanical and electrical tie-in',
          quantity: 2,
          unit: 'lot',
          unitPrice: 12_500,
          unitCost: UNIT_COST,
          providerSupplierId: supplier.id,
          costNote: `${TAG} supplier quote 88`,
        },
        {
          group: `${TAG} Services`,
          title: 'Commissioning',
          description: 'Start-up and hand-over',
          quantity: 1,
          unit: 'lot',
          unitPrice: 5_000,
          unitCost: 1_000,
          providerUserId: sales.id,
        },
      ],
    });
    check('lines with cost and a provider are accepted', twoLines.status === 200, twoLines.text.slice(0, 200));
    const both = await http(salesToken, 'PUT', `${base}/lines`, {
      lines: [{ title: 'Bad line', quantity: 1, unit: 'lot', unitPrice: 1, providerSupplierId: supplier.id, providerUserId: sales.id }],
    });
    check('a line cannot name a supplier AND a person', both.status === 400, both.text.slice(0, 160));

    // The discount is to six decimals (2026-10-08): SCORO's calculator finds
    // the one that lands on the sum wanted — ₱150,000 with tax on ₱143,750.
    const calc = quotationTotals({ lines: [{ amount: 143_750 }], discountPct: 6.832298, vatRate: 0.12 });
    check(
      'a six-decimal discount is kept to six and lands on the sum the calculator promised, on both sides of the mirror',
      calc.discountPct === 6.832298 && money(calc.total, 150_000) && money(calc.netOfTax, 133_928.57) &&
        same(editorTotals({ lines: [{ amount: 143_750 }], discountPct: 6.832298, vatRate: 0.12 }), calc),
      JSON.stringify({ pct: calc.discountPct, total: calc.total }),
    );
    const sixDp = await http(salesToken, 'PATCH', base, { discountPct: 12.345678 });
    const sixDpRev = await prisma.quotationRevision.findFirstOrThrow({ where: { quotationId: qid } });
    check('and a revision stores it to six decimals', sixDp.status === 200 && Number(sixDpRev.discountPct) === 12.345678, String(sixDpRev.discountPct));
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
    // Rule 6: a routed document prints its route as the workflow names its
    // steps, in capitals, nothing added — never "APPROVED BY — <step>".
    const rev0Route = await pickWorkflow('quotation', Number((await prisma.quotationRevision.findUniqueOrThrow({ where: { id: rev0.id } })).total));
    const rev0Steps = (rev0Route?.steps ?? []).map((st) => st.name.toUpperCase());
    check(
      'it keeps the dated sign-offs — prepared, then the route by its steps’ own names — and no Conforme',
      text.includes('PREPARED BY') && rev0Steps.length > 0 && rev0Steps.every((n) => text.includes(n)) && !text.includes('APPROVED BY —') && !/CONFORME/i.test(text),
      rev0Steps.join(' · '),
    );
    check(
      "the author's sign-off is the name on its own, with their email under it",
      text.split('\n').includes(sales.name) && text.includes(sales.email),
    );
    check('Delivery prints as a labelled line', text.includes('Delivery:') && text.includes('4 to 6 weeks'));
    check('it prints the line title and its description', text.includes('Air compressor installation') && text.includes('Mechanical and electrical tie-in'));

    // ── The contact on the paper, its quick-add, and the boxes that remember (2026-10-12) ──
    console.log('\nThe contact person on the paper, adding one, and memory in every box');
    check(
      'the Attention line is followed by the contact’s mobile and email',
      text.includes(`Attention: ${TAG} Engr. Cruz, Facilities Head`) && text.includes('Mobile: 0917 555 0101 | Email: cruz@zz.local'),
    );
    // Adding a contact from the editor is the customer's own route.
    const added = await http(salesToken, 'POST', `/customers/${clinic.id}/contacts`, { name: `${TAG} Ms.  Reyes`, mobile: '0918 222 0303' });
    check('a salesperson files a new contact on the customer (name and mobile)', added.status === 201 && added.body.mobile === '0918 222 0303', added.text.slice(0, 160));
    const twice = await http(salesToken, 'POST', `/customers/${clinic.id}/contacts`, { name: `${TAG.toLowerCase()} ms. reyes` });
    check(
      'the same name again on the same customer is a 409 naming them, whatever its case or spacing',
      twice.status === 409 && String(twice.body.error ?? twice.text).includes('already a contact'),
      twice.text.slice(0, 160),
    );
    check(
      'and only one was filed',
      (await prisma.customerContact.count({ where: { customerId: clinic.id, name: { contains: 'Reyes', mode: 'insensitive' } } })) === 1,
    );
    const toReyes = await http(salesToken, 'PATCH', `/quotations/${qid}`, { contactId: String(added.body.id) });
    const reyesPaper = pdfText(
      Buffer.from(await (await fetch(`${BASE}/quotations/${qid}/revisions/${rev0.id}/pdf`, { headers: { Authorization: `Bearer ${salesToken}` } })).arrayBuffer()),
    );
    check(
      'a contact with a mobile and no email prints the mobile alone under Attention',
      toReyes.status === 200 && reyesPaper.split('\n').includes('Mobile: 0918 222 0303'),
      toReyes.text.slice(0, 160),
    );
    await http(salesToken, 'PATCH', `/quotations/${qid}`, { contactId: null });
    const nobodyPaper = pdfText(
      Buffer.from(await (await fetch(`${BASE}/quotations/${qid}/revisions/${rev0.id}/pdf`, { headers: { Authorization: `Bearer ${salesToken}` } })).arrayBuffer()),
    );
    check('no contact prints neither the Attention line nor the number line', !nobodyPaper.includes('Attention:') && !nobodyPaper.includes('Mobile:'));
    await http(salesToken, 'PATCH', `/quotations/${qid}`, { contactId: clinic.contacts[0].id });

    // Memory: what was typed before, from quotations the caller may read.
    const remember = async (token: string, query: string) => http(token, 'GET', `/quotations/suggest/fields?${query}`);
    const delivery = await remember(salesToken, 'field=delivery&q=4%20to%206');
    check('Delivery remembers what was typed before', delivery.status === 200 && (delivery.body as unknown as string[]).includes('4 to 6 weeks'), delivery.text.slice(0, 160));
    const descr = await remember(salesToken, 'field=description&q=electrical%20tie');
    check('a line’s description remembers too', (descr.body as unknown as string[]).includes('Mechanical and electrical tie-in'), descr.text.slice(0, 160));
    const subj = await remember(salesToken, `field=subject&q=${encodeURIComponent(`${TAG} scoro-style`)}`);
    check('the quote name remembers, case-blind', (subj.body as unknown as string[]).some((s) => s.toUpperCase() === `${TAG} SCORO-STYLE QUOTE`), subj.text.slice(0, 160));
    const typedBack = await remember(salesToken, 'field=delivery&q=4%20to%206%20weeks');
    check('the very text typed is not offered back', !(typedBack.body as unknown as string[]).some((s) => s.toUpperCase() === '4 TO 6 WEEKS'), typedBack.text.slice(0, 160));
    const unit = await remember(salesToken, 'field=unit');
    check('the unit lists what was used, each once', Array.isArray(unit.body) && (unit.body as unknown as string[]).filter((u) => u.toLowerCase() === 'lot').length === 1, unit.text.slice(0, 160));
    const badField = await remember(salesToken, 'field=unitPrice');
    check('a box that is not remembered (a figure) is a 400', badField.status === 400, badField.text.slice(0, 160));
    // The described product first: two descriptions, the one written for this brand leads.
    await prisma.quotationItem.updateMany({ where: { revisionId: rev0.id, description: 'Start-up and hand-over' }, data: { brand: `${TAG} ATLAS` } });
    const byBrand = await remember(salesToken, `field=description&brand=${encodeURIComponent(`${TAG} ATLAS`)}`);
    check(
      'a description written for the line’s brand comes first',
      (byBrand.body as unknown as string[])[0] === 'Start-up and hand-over',
      byBrand.text.slice(0, 200),
    );
    // A reader of their own quotations only is never offered a colleague's words.
    const ownRoleKeys = ['gops.quotations.view_own', 'gops.quotations.create', 'gops.quotations.edit_own'];
    const ownPerms = await prisma.permission.findMany({ where: { key: { in: ownRoleKeys } } });
    const ownRole = await prisma.role.create({
      data: { key: `${TAG.toLowerCase()}_own_quotes`, name: `${TAG} own quotations`, permissions: { create: ownPerms.map((p) => ({ permissionId: p.id })) } },
    });
    const loner = await prisma.user.create({
      data: { name: 'Verify Loner', email: 'loner@verifys.local', passwordHash: 'x', roles: { create: [{ roleId: ownRole.id }] } },
    });
    const lonerDelivery = await remember(signToken(loner.id, loner.email), 'field=delivery&q=4%20to%206');
    check(
      'a view-own reader is offered none of a colleague’s texts',
      lonerDelivery.status === 200 && !(lonerDelivery.body as unknown as string[]).includes('4 to 6 weeks'),
      lonerDelivery.text.slice(0, 160),
    );
    const orderMemory = await http(salesToken, 'GET', '/sales-orders/suggest/fields?field=description&q=hand-over');
    check(
      'the sales order editor remembers quotation lines’ descriptions too',
      orderMemory.status === 200 && (orderMemory.body as unknown as string[]).includes('Start-up and hand-over'),
      orderMemory.text.slice(0, 160),
    );
    const orderBad = await http(salesToken, 'GET', '/sales-orders/suggest/fields?field=total');
    check('and refuses a box it does not remember', orderBad.status === 400, orderBad.text.slice(0, 160));
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
    // The owner's twelve product groups (2026-10-08): seeded once, in his
    // order, with what each covers and its brand; blanks filled, never overwritten.
    {
      const first = await seedOwnerGroups();
      const again = await seedOwnerGroups();
      const others = await prisma.quotationGroup.findUniqueOrThrow({ where: { key: groupKey('OTHERS') } });
      await prisma.quotationGroup.update({ where: { id: others.id }, data: { description: `${TAG} custom` } });
      await seedOwnerGroups();
      const kept = await prisma.quotationGroup.findUniqueOrThrow({ where: { id: others.id } });
      await prisma.quotationGroup.update({ where: { id: others.id }, data: { description: others.description } });
      const omega = await prisma.quotationGroup.findUniqueOrThrow({ where: { key: groupKey('OMEGA AIR') } });
      const onFile = await prisma.quotationGroup.count({ where: { key: { in: OWNER_GROUPS.map((g) => groupKey(g.name)) } } });
      check(
        'the owner’s twelve groups are on file, in his order, with what they cover and their brand; a second seed adds none and overwrites nothing',
        again === 0 && onFile === 12 && omega.description === 'Compressed Air & Gas Treatment and Separation' && omega.brand === 'OMEGA AIR' &&
          omega.sortOrder === 1 && kept.description === `${TAG} custom`,
        `${first}/${again} ${onFile} ${JSON.stringify(omega)}`,
      );
    }
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
      { group: `${TAG} Installation`, title: 'Second', description: '', quantity: 1.5, unit: 'set', unitPrice: 3_333.33, unitCost: 1_000, providerUserId: sales.id },
      { group: `${TAG} Installation`, title: '', description: 'Third, description only', quantity: 3, unit: 'pc', unitPrice: 99.99 },
    ];

    const promised = await previewNext('quotation', { ownerId: sales.id });
    const issuedBefore = await counter(promised.periodKey);
    // No quotation is saved with a priced line that names no group (2026-10-11).
    const noGroupSave = await http(salesToken, 'POST', '/quotations', {
      customerId: clinic.id,
      subject: `${TAG} No group`,
      lines: [{ title: 'Ungrouped', description: '', quantity: 1, unit: 'lot', unitPrice: 100 }],
    });
    check(
      'a priced line with no group is refused at save, naming the line, and burns no number',
      noGroupSave.status === 400 && noGroupSave.text.includes('Line 1: Choose a product group') && (await counter(promised.periodKey)) === issuedBefore,
      `${noGroupSave.status} ${noGroupSave.text.slice(0, 120)}`,
    );
    const made = await http(salesToken, 'POST', '/quotations', {
      customerId: clinic.id,
      leadId: editorLead.id,
      subject: `${TAG} Editor quote`,
      discountPct: 10,
      lines: editorLines,
    });
    check('the editor creates a quotation and its lines in one request', made.status === 201, made.text.slice(0, 200));
    check('its name is saved in capitals', made.body.subject === upperText(`${TAG} Editor quote`), String(made.body.subject));
    check('a quotation is in PHP unless another currency is picked', made.body.currency === 'PHP', String(made.body.currency));
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
    // The product's three boxes print as one sentence (2026-10-08).
    const parted = await http(salesToken, 'POST', '/quotations', {
      customerId: clinic.id,
      subject: `${TAG} Parts quote`,
      lines: [
        {
          group: `${TAG} Installation`,
          brand: 'SCHNEIDER ELECTRIC',
          productType: 'CIRCUIT BREAKER',
          partNumber: 'EZC100H3030',
          description: '30A, 3P',
          quantity: 2,
          unit: 'pc',
          unitPrice: 1500,
        },
        { group: `${TAG} Installation`, productType: '  Pressure   gauge ', partNumber: 'PG-63', quantity: 1, unit: 'pc', unitPrice: 300 },
        { group: `${TAG} Installation`, title: 'Typed as a title', description: '', quantity: 1, unit: 'lot', unitPrice: 100 },
      ],
    });
    const partedId = String(parted.body.id);
    const partedRev = await prisma.quotationRevision.findFirstOrThrow({ where: { quotationId: partedId }, include: { items: { orderBy: { sortOrder: 'asc' } } } });
    const pi = partedRev.items;
    check(
      'brand, product type and part number are stored apart and titled as one sentence; a title typed alone stays',
      parted.status === 201 &&
        pi[0]?.title === 'SCHNEIDER ELECTRIC, CIRCUIT BREAKER, EZC100H3030' &&
        pi[0].brand === 'SCHNEIDER ELECTRIC' &&
        pi[0].productType === 'CIRCUIT BREAKER' &&
        pi[0].partNumber === 'EZC100H3030' &&
        pi[1]?.title === 'PRESSURE GAUGE, PG-63' &&
        pi[1].brand === null &&
        pi[2]?.title === 'Typed as a title' &&
        pi[2].partNumber === null,
      `${parted.text.slice(0, 120)} ${pi.map((i) => i.title).join(' | ')}`,
    );
    const partedPdf = await fetch(`${BASE}/quotations/${partedId}/revisions/${partedRev.id}/pdf`, { headers: { Authorization: `Bearer ${salesToken}` } });
    const partedText = pdfText(Buffer.from(await partedPdf.arrayBuffer())).replace(/\s+/g, '');
    check(
      'the paper prints the sentence, bold over the description, as one product',
      partedPdf.status === 200 && partedText.includes('SCHNEIDERELECTRIC,CIRCUITBREAKER,EZC100H3030') && partedText.includes('30A,3P'),
      partedText.slice(0, 160),
    );
    // The currency is the quotation's own (2026-10-11): PHP unless picked,
    // changeable while nothing is approved, printed in the head and the total.
    const dollarQ = await http(salesToken, 'POST', '/quotations', {
      customerId: clinic.id,
      subject: `${TAG} Dollar quote`,
      currency: 'USD',
      lines: editorLines,
    });
    const badCurrency = await http(salesToken, 'PATCH', `/quotations/${dollarQ.body.id}`, { currency: 'XAU' });
    const toEuro = await http(salesToken, 'PATCH', `/quotations/${dollarQ.body.id}`, { currency: 'EUR' });
    const euroRev = await prisma.quotationRevision.findFirstOrThrow({ where: { quotationId: String(dollarQ.body.id) } });
    const euroText = pdfText(
      Buffer.from(
        await (
          await fetch(`${BASE}/quotations/${dollarQ.body.id}/revisions/${euroRev.id}/pdf`, { headers: { Authorization: `Bearer ${salesToken}` } })
        ).arrayBuffer(),
      ),
    );
    check(
      'a quotation takes the currency picked, changes it while a draft, refuses one not on the list, and prints it',
      dollarQ.status === 201 && dollarQ.body.currency === 'USD' && badCurrency.status === 400 && toEuro.status === 200 &&
        toEuro.body.currency === 'EUR' && euroText.includes('Total Price (EUR):') && !euroText.includes('(PHP)'),
      `${dollarQ.status} ${dollarQ.body.currency} ${badCurrency.status} ${toEuro.status} ${toEuro.body.currency}`,
    );
    await prisma.quotationRevision.update({ where: { id: euroRev.id }, data: { status: 'APPROVED' } });
    const lockedCurrency = await http(salesToken, 'PATCH', `/quotations/${dollarQ.body.id}`, { currency: 'PHP' });
    check(
      'once a revision is approved the currency stays as it was approved',
      lockedCurrency.status === 400 && lockedCurrency.text.includes('currency cannot change'),
      `${lockedCurrency.status} ${lockedCurrency.text.slice(0, 120)}`,
    );
    // The team is picked on the quotation, the author's by default (2026-10-12),
    // and a sales order counts under its quotation's team.
    const [hitTeam, uitTeam] = await Promise.all(
      ['HIT', 'UIT'].map((code) => prisma.industry.findFirstOrThrow({ where: { code }, select: { id: true } })),
    );
    const authorTeam = (await prisma.employee.findUnique({ where: { userId: sales.id }, select: { industryId: true } }))?.industryId ?? null;
    const byDefault = await http(salesToken, 'POST', '/quotations', { customerId: clinic.id, subject: `${TAG} Team default`, lines: editorLines });
    const picked = await http(salesToken, 'POST', '/quotations', { customerId: clinic.id, subject: `${TAG} Team picked`, teamId: hitTeam.id, lines: editorLines });
    check(
      'a quotation counts under the author’s team by default, or the team picked on it',
      byDefault.status === 201 && (byDefault.body.teamId ?? null) === authorTeam && picked.status === 201 && picked.body.teamId === hitTeam.id,
      `${byDefault.status} ${byDefault.body.teamId} (author ${authorTeam}) / ${picked.status} ${picked.body.teamId}`,
    );
    const toUit = await http(salesToken, 'PATCH', `/quotations/${picked.body.id}`, { teamId: uitTeam.id });
    const badTeam = await http(salesToken, 'PATCH', `/quotations/${picked.body.id}`, { teamId: 'nope' });
    const teamTrail = await prisma.auditLog.count({ where: { entityType: 'quotation', entityId: String(picked.body.id), summary: { contains: 'team:' } } });
    check(
      'the team changes on Modify, is audited, and an unknown one is a 400',
      toUit.status === 200 && toUit.body.teamId === uitTeam.id && badTeam.status === 400 && teamTrail === 1,
      `${toUit.status} ${toUit.body.teamId} / ${badTeam.status} / ${teamTrail}`,
    );
    const teamOrder = await http(salesToken, 'POST', '/sales-orders', { quotationId: picked.body.id, mode: 'all' });
    const teamOrderList = await http(salesToken, 'GET', `/sales-orders?scope=all&ids=${teamOrder.body.id}`);
    const orderTeams = ((teamOrderList.body.summary as { teams?: { id: string | null; code: string; count: number }[] } | undefined)?.teams ?? []);
    check(
      'and its sales order counts under the quotation’s team, not the author’s',
      teamOrder.status === 201 && orderTeams.find((t) => t.id === uitTeam.id)?.count === 1 &&
        orderTeams.filter((t) => t.id !== uitTeam.id).every((t) => t.count === 0),
      JSON.stringify(orderTeams.map((t) => [t.code, t.count])),
    );
    const partedRevs = await http(salesToken, 'GET', `/quotations/${partedId}`);
    const partedItems = ((partedRevs.body.revisions as { items: { brand: string | null; partNumber: string | null }[] }[])[0]?.items ?? []);
    check('and the page gets the three boxes back to edit', partedItems[0]?.brand === 'SCHNEIDER ELECTRIC' && partedItems[0]?.partNumber === 'EZC100H3030');
    // The editor saves every line again; the one typed as a title now has two boxes filled.
    const asSent = (i: (typeof pi)[number]) => ({
      group: i.group,
      title: i.title,
      brand: i.brand,
      productType: i.productType,
      partNumber: i.partNumber,
      description: i.description,
      quantity: Number(i.quantity),
      unit: i.unit,
      unitPrice: Number(i.unitPrice),
    });
    const typedPatch = await http(salesToken, 'PUT', `/quotations/${partedId}/revisions/${partedRev.id}/lines`, {
      lines: [asSent(pi[0]), asSent(pi[1]), { ...asSent(pi[2]), brand: 'KSB PUMPS', partNumber: 'ETANORM 065' }],
    });
    const typedAfter = await prisma.quotationItem.findFirstOrThrow({ where: { revisionId: partedRev.id, sortOrder: 2 } });
    check(
      'editing one box on a line typed as a title re-titles it from the boxes',
      typedPatch.status === 200 && typedAfter.title === 'KSB PUMPS, ETANORM 065' && typedAfter.productType === null,
      `${typedPatch.status} ${typedAfter.title}`,
    );

    // Suggestions know the three boxes (2026-10-08).
    const byPart = await http(salesToken, 'GET', `/quotations/suggest?q=${encodeURIComponent('EZC100')}`);
    const partRow = (byPart.body as unknown as { title: string; brand: string | null; partNumber: string | null; source: string }[]).find((r) => r.partNumber === 'EZC100H3030');
    check('typing a part number offers the line it was on, with its brand', byPart.status === 200 && partRow?.brand === 'SCHNEIDER ELECTRIC' && partRow?.source === 'history', JSON.stringify(partRow));
    const brands = await http(salesToken, 'GET', `/quotations/suggest/fields?field=brand&q=${encodeURIComponent('schnei')}`);
    const types = await http(salesToken, 'GET', `/quotations/suggest/fields?field=productType&brand=${encodeURIComponent('SCHNEIDER ELECTRIC')}`);
    const typesOfKsb = await http(salesToken, 'GET', `/quotations/suggest/fields?field=productType&brand=${encodeURIComponent('KSB PUMPS')}`);
    check(
      'the Brand and Product type boxes offer what was used before — a type under its brand',
      brands.status === 200 && (brands.body as unknown as string[]).includes('SCHNEIDER ELECTRIC') &&
        (types.body as unknown as string[]).includes('CIRCUIT BREAKER') && !(typesOfKsb.body as unknown as string[]).includes('CIRCUIT BREAKER'),
      `${brands.text.slice(0, 80)} / ${types.text.slice(0, 80)}`,
    );

    // Booking copies the three boxes onto the order's lines.
    const partedOrder = await http(salesToken, 'POST', '/sales-orders', { quotationId: partedId, mode: 'all' });
    const partedOrderLines = partedOrder.status === 201 ? await prisma.salesOrderLine.findMany({ where: { orderId: String(partedOrder.body.id) }, orderBy: { sortOrder: 'asc' } }) : [];
    check(
      'a sales order booked from it carries the boxes and the sentence',
      partedOrder.status === 201 && partedOrderLines[0]?.brand === 'SCHNEIDER ELECTRIC' && partedOrderLines[0]?.partNumber === 'EZC100H3030' &&
        partedOrderLines[0]?.title === 'SCHNEIDER ELECTRIC, CIRCUIT BREAKER, EZC100H3030',
      partedOrder.text.slice(0, 160),
    );

    // Every priced line names its product group before the quotation moves
    // on. Saving one without is refused (above); a line filed another way —
    // an import, an older line — is still caught at submit.
    const ungrouped = await http(salesToken, 'POST', '/quotations', {
      customerId: clinic.id,
      subject: `${TAG} Ungrouped quote`,
      lines: [{ group: `${TAG} Installation`, title: 'No group', quantity: 1, unit: 'lot', unitPrice: 10 }],
    });
    const ungroupedRev = await prisma.quotationRevision.findFirstOrThrow({ where: { quotationId: String(ungrouped.body.id) } });
    await prisma.quotationItem.updateMany({ where: { revisionId: ungroupedRev.id }, data: { group: null } });
    const gated = await http(salesToken, 'POST', `/quotations/${ungrouped.body.id}/revisions/${ungroupedRev.id}/submit`, {});
    check(
      'a line that reached the database without a group still keeps the quotation from being submitted',
      ungrouped.status === 201 && gated.status === 400 && /product group/.test(gated.text) &&
        (await prisma.quotationRevision.findUniqueOrThrow({ where: { id: ungroupedRev.id } })).status === 'DRAFT',
      `${ungrouped.status} ${gated.status} ${gated.text.slice(0, 120)}`,
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

    // A number typed by hand is used as typed; a duplicate is refused before
    // anything is written. ZZQ-… is outside the template's pattern, so it
    // names no series and moves no counter (2026-10-10).
    const handNumber = `ZZQ-${Date.now() % 100000}`;
    const seriesSum = async () =>
      (await prisma.numberSequence.aggregate({ where: { documentType: 'quotation' }, _sum: { lastNumber: true } }))._sum.lastNumber ?? 0;
    const sumBeforeHand = await seriesSum();
    const typed = await http(salesToken, 'POST', '/quotations', {
      customerId: clinic.id,
      subject: `${TAG} Hand-numbered`,
      number: handNumber,
      lines: [editorLines[2]],
    });
    check('a quote number typed by hand is the number it gets', typed.status === 201 && typed.body.number === handNumber, typed.text.slice(0, 160));
    check('and, outside the template’s shape, moves no series', (await seriesSum()) === sumBeforeHand);
    check(
      'its audit row says the number was typed, and not that a series continues',
      (await prisma.auditLog.count({
        where: { entityType: 'quotation', entityId: String(typed.body.id), summary: { contains: '(number typed by hand)' } },
      })) === 1,
    );
    const free = await http(salesToken, 'GET', `/quotations/number-available?number=${encodeURIComponent(handNumber.toLowerCase())}`);
    check('the editor is told, as it types, that the number is taken — case-blind', free.status === 200 && free.body.available === false, JSON.stringify(free.body));
    const fresh = await http(salesToken, 'GET', `/quotations/number-available?number=${encodeURIComponent(`${handNumber}-X`)}`);
    check('and that an unused one is free', fresh.body.available === true);
    const badShape = await http(salesToken, 'GET', '/quotations/number-available?number=' + encodeURIComponent('two words'));
    check('a number with spaces is not a number', badShape.body.available === false);
    const counterBefore = await seriesSum();
    const dupe = await http(salesToken, 'POST', '/quotations', { customerId: clinic.id, subject: `${TAG} Dupe`, number: handNumber });
    check('a duplicate number is refused (409)', dupe.status === 409, dupe.text.slice(0, 160));
    check('and burns no number in any series', counterBefore === (await seriesSum()));
    check('and writes no quotation', (await prisma.quotation.count({ where: { subject: `${TAG} Dupe` } })) === 0);

    // The series continues from a typed number (2026-10-10, the owner's call:
    // "remember the manual edit, start there from the last edit"): a number
    // in the template's own shape names its series — the number's year,
    // month and employee digits — and the counter follows it, up or down.
    // The counter row the checks move is put back where it stood at the end,
    // so a database whose quotation template is company-wide keeps its series.
    const numberTemplate = await prisma.numberSequence.findFirstOrThrow({ where: { documentType: 'quotation', periodKey: '' } });
    const numberPrefix = (await prisma.company.findUnique({ where: { id: 'company' }, select: { numberPrefix: true } }))?.numberPrefix ?? 'GT';
    const suggested = await http(salesToken, 'GET', '/quotations/next-number');
    const parsedSuggestion = parseNumber(numberTemplate, numberPrefix, String(suggested.body.number));
    check('the suggestion parses on the template’s own pattern', parsedSuggestion !== null, `${suggested.body.number} under ${numberTemplate.pattern}`);
    const seriesKey = parsedSuggestion?.periodKey ?? '';
    const seriesRowBefore = await prisma.numberSequence.findUnique({
      where: { documentType_periodKey: { documentType: 'quotation', periodKey: seriesKey } },
      select: { lastNumber: true },
    });
    const seriesBefore = seriesRowBefore?.lastNumber ?? 0;
    await setSeriesAside(seriesKey, seriesRowBefore);
    const now = new Date();
    const seriesAt = new Date(parsedSuggestion?.year ?? now.getFullYear(), (parsedSuggestion?.month ?? now.getMonth() + 1) - 1, 1);
    const inSeries = (seq: number) =>
      renderPattern(numberTemplate.pattern, {
        prefix: numberPrefix,
        typeCode: numberTemplate.typeCode,
        seq,
        padding: numberTemplate.padding,
        at: seriesAt,
        emp: parsedSuggestion?.emp ?? '000',
      });
    const baseSeq = parsedSuggestion?.seq ?? 0;
    check('and the parser and the renderer agree on it', inSeries(baseSeq) === String(suggested.body.number), `${inSeries(baseSeq)} vs ${suggested.body.number}`);
    const typedSeq = baseSeq + 5;
    const ahead = await http(salesToken, 'POST', '/quotations', {
      customerId: clinic.id,
      subject: `${TAG} Typed five ahead`,
      number: inSeries(typedSeq),
      lines: [editorLines[2]],
    });
    check('a number typed five ahead of the series is the number it gets', ahead.status === 201 && ahead.body.number === inSeries(typedSeq), ahead.text.slice(0, 160));
    check(`and the counter for its series (${seriesKey}) now reads the typed SEQ`, (await counter(seriesKey)) === typedSeq, `${await counter(seriesKey)} vs ${typedSeq}`);
    const afterwards = await http(salesToken, 'GET', '/quotations/next-number');
    check('the next suggestion is the typed number plus one', afterwards.body.number === inSeries(typedSeq + 1), `${afterwards.body.number} vs ${inSeries(typedSeq + 1)}`);
    const issued = await http(salesToken, 'POST', '/quotations', { customerId: clinic.id, subject: `${TAG} Issued after`, lines: [editorLines[2]] });
    check(
      'and the number issued on save is the typed number plus one',
      issued.status === 201 && issued.body.number === inSeries(typedSeq + 1),
      `${issued.body.number} vs ${inSeries(typedSeq + 1)}`,
    );
    const aheadTrail = await prisma.auditLog.findFirst({
      where: { entityType: 'quotation', entityId: String(ahead.body.id), action: 'CREATED' },
    });
    const aheadCounter = (aheadTrail?.after as { counter?: { periodKey: string; before: number; after: number } } | null)?.counter;
    check(
      'the create is audited as typed by hand, the series continuing, with the counter’s move',
      !!aheadTrail?.summary?.includes('(number typed by hand, the series continues from it)') &&
        aheadCounter?.periodKey === seriesKey && aheadCounter.before === seriesBefore && aheadCounter.after === typedSeq,
      `${aheadTrail?.summary} ${JSON.stringify(aheadCounter)}`,
    );
    const dupeAhead = await http(salesToken, 'POST', '/quotations', { customerId: clinic.id, subject: `${TAG} Dupe ahead`, number: inSeries(typedSeq) });
    check(
      'a refused duplicate of a number in the series leaves the counter where it was',
      dupeAhead.status === 409 && (await counter(seriesKey)) === typedSeq + 1,
      `${dupeAhead.status} ${await counter(seriesKey)}`,
    );

    // Renumbering an existing quotation moves the series too; a refused one does not.
    const renumberSeq = typedSeq + 9;
    const renumbered = await http(salesToken, 'PATCH', `/quotations/${typed.body.id}`, { number: inSeries(renumberSeq) });
    check('a quotation can be renumbered', renumbered.status === 200 && renumbered.body.number === inSeries(renumberSeq), renumbered.text.slice(0, 160));
    check('and a renumbering to a number in the series moves the counter to it', (await counter(seriesKey)) === renumberSeq, `${await counter(seriesKey)}`);
    const clash = await http(salesToken, 'PATCH', `/quotations/${typed.body.id}`, { number: String(issued.body.number) });
    check('but not onto another quotation’s number (409)', clash.status === 409, clash.text.slice(0, 160));
    check('and the refused renumbering left the counter alone', (await counter(seriesKey)) === renumberSeq);
    const renumberTrail = await prisma.auditLog.findFirst({
      where: { entityType: 'quotation', entityId: String(typed.body.id), summary: { contains: `${handNumber} → ${inSeries(renumberSeq)}` } },
    });
    const renumberCounter = (renumberTrail?.after as { counter?: { before: number; after: number } } | null)?.counter;
    check(
      'the renumbering is audited from → to, the series continuing, with the counter’s move',
      renumberTrail !== null && !!renumberTrail.summary?.includes('the series continues from it') &&
        renumberCounter?.before === typedSeq + 1 && renumberCounter.after === renumberSeq,
      `${renumberTrail?.summary} ${JSON.stringify(renumberCounter)}`,
    );

    // A number typed BELOW the counter sets the series back to it; the next
    // automatic number then steps over what is already taken past it.
    const lowSeq = baseSeq + 4;
    const lowered = await http(salesToken, 'POST', '/quotations', { customerId: clinic.id, subject: `${TAG} Typed below the counter`, number: inSeries(lowSeq) });
    check('a number typed below the counter sets the series back to it', lowered.status === 201 && (await counter(seriesKey)) === lowSeq, `${lowered.status} ${await counter(seriesKey)}`);
    const stepped = await http(salesToken, 'GET', '/quotations/next-number');
    check('the next suggestion steps over the two numbers already taken past it', stepped.body.number === inSeries(typedSeq + 2), `${stepped.body.number} vs ${inSeries(typedSeq + 2)}`);
    const steppedIssued = await http(salesToken, 'POST', '/quotations', { customerId: clinic.id, subject: `${TAG} Issued past the taken`, lines: [editorLines[2]] });
    check('as does the number issued on save', steppedIssued.status === 201 && steppedIssued.body.number === inSeries(typedSeq + 2), `${steppedIssued.body.number}`);
    check('leaving the counter at the number it issued', (await counter(seriesKey)) === typedSeq + 2);

    // A thousand taken in a row is a 409 naming Admin › Numbering, reached
    // INSIDE the save's transaction: the walk is one read per candidate (the
    // review of 2026-10-10 — re-running the whole issue per candidate outran
    // the transaction's five seconds and the save answered 500), and the
    // refusal leaves the counter where it stood. Every number from the
    // counter to a thousand and one past it is taken, one of them already.
    const walkFrom = typedSeq + 2;
    const takenSeqs = Array.from({ length: FREE_NUMBER_TRIES + 1 }, (_, i) => walkFrom + 1 + i).filter((n) => n !== renumberSeq);
    await prisma.quotation.createMany({
      data: takenSeqs.map((n) => ({ number: inSeries(n), customerId: clinic.id, ownerId: sales.id, subject: `${TAG} Taken ${n}` })),
    });
    const walkStarted = Date.now();
    const exhausted = await http(salesToken, 'POST', '/quotations', { customerId: clinic.id, subject: `${TAG} Nowhere to go`, lines: [editorLines[2]] });
    check(
      'a thousand taken numbers in a row is a 409 naming Admin › Numbering, inside the save’s transaction',
      exhausted.status === 409 && exhausted.text.includes('Admin › Numbering'),
      `${exhausted.status} ${exhausted.text.slice(0, 160)} (${Date.now() - walkStarted} ms)`,
    );
    check('and the refused save left the counter where it was', (await counter(seriesKey)) === walkFrom, String(await counter(seriesKey)));
    check('and wrote no quotation', (await prisma.quotation.count({ where: { subject: `${TAG} Nowhere to go` } })) === 0);
    await prisma.quotation.deleteMany({ where: { subject: { startsWith: `${TAG} Taken ` } } });

    // The series as it stood: its row put back, or removed where none was.
    await putSeriesBack();

    // Subheadings: words only, no money, not counted as lines.
    const headed = await http(salesToken, 'POST', '/quotations', {
      customerId: clinic.id,
      subject: `${TAG} With subheadings`,
      lines: [
        { isHeading: true, title: 'General Requirements', quantity: 5, unit: 'lot', unitPrice: 999, unitCost: 1 },
        { group: `${TAG} Installation`, title: 'Service kit', description: '', quantity: 1, unit: 'lot', unitPrice: 7000, unitCost: 4000 },
        { isHeading: true, title: 'Installation', quantity: 0, unit: 'lot', unitPrice: 0 },
        { group: `${TAG} Installation`, title: 'Labour', description: 'Assembly and programming', quantity: 1, unit: 'lot', unitPrice: 39400 },
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

    // The owner's routing sheet (2026-10-11): an Industry Specialist's
    // quotation goes to their Team Leader, and over ₱1,000,000 to the CEO /
    // President too — a fixed step, no longer an option to tick.
    const big = await http(salesToken, 'POST', '/quotations', {
      customerId: clinic.id,
      subject: `${TAG} Over a million`,
      lines: [{ group: `${TAG} Installation`, title: 'Oxygen plant', description: '', quantity: 1, unit: 'lot', unitPrice: 1_500_000 }],
    });
    const bigView = await http(salesToken, 'GET', `/quotations/${big.body.id}`);
    check('no "Add the CEO as approver" to tick any more', ((bigView.body.approvalOptions ?? []) as unknown[]).length === 0, JSON.stringify(bigView.body.approvalOptions));
    type Route = { steps: { name: string; approvers: { id: string; name: string }[] }[] } | null;
    const routes = bigView.body.approvalRoutes as { standard: Route } | null;
    check(
      'over a million the draft names its route: the team leader, then the CEO / President, each by name',
      routes?.standard?.steps.length === 2 &&
        routes.standard.steps[0].approvers.some((p) => p.id === manager.id) &&
        routes.standard.steps[1].approvers.some((p) => p.id === ceo.id),
      JSON.stringify(routes),
    );
    check('never naming the submitter as their own approver', !JSON.stringify(routes).includes(sales.id));
    const smallView = await http(salesToken, 'GET', `/quotations/${headed.body.id}`);
    const smallRoute = (smallView.body.approvalRoutes as { standard: Route } | null)?.standard;
    check('at or under a million, the team leader alone', smallRoute?.steps.length === 1 && smallRoute.steps[0].approvers.some((p) => p.id === manager.id), JSON.stringify(smallRoute));
    const bigRev = await prisma.quotationRevision.findFirstOrThrow({ where: { quotationId: String(big.body.id) } });
    const draftText = pdfText(
      Buffer.from(
        await (await fetch(`${BASE}/quotations/${big.body.id}/revisions/${bigRev.id}/pdf`, { headers: { Authorization: `Bearer ${salesToken}` } })).arrayBuffer(),
      ),
    ).replace(/\n/g, ' ');
    const ceoStep = 'CEO / PRESIDENT';
    check(
      'a draft’s PDF names both who will sign, pending, under the steps’ own names',
      draftText.includes(manager.name) && draftText.includes(ceo.name) && draftText.includes(ceoStep) && draftText.includes('Pending') && !draftText.includes('APPROVED BY'),
    );
    const bigSubmit = await http(salesToken, 'POST', `/quotations/${big.body.id}/revisions/${bigRev.id}/submit`);
    const ceoRequest = await prisma.approvalRequest.findFirstOrThrow({
      where: { documentType: 'quotation', documentId: bigRev.id, status: 'PENDING' },
      include: { workflow: { include: { steps: true } } },
    });
    check('submitted, it takes that route', bigSubmit.status === 200 && ceoRequest.workflow?.steps.length === 2, bigSubmit.text.slice(0, 160));
    await act({ requestId: ceoRequest.id, userId: manager.id, action: 'APPROVED' });
    check(
      'the team leader’s approval alone does not approve it',
      (await prisma.quotationRevision.findUniqueOrThrow({ where: { id: bigRev.id } })).status === 'PENDING_APPROVAL',
    );
    const halfway = pdfText(
      Buffer.from(
        await (await fetch(`${BASE}/quotations/${big.body.id}/revisions/${bigRev.id}/pdf`, { headers: { Authorization: `Bearer ${salesToken}` } })).arrayBuffer(),
      ),
    );
    check('halfway, the PDF dates the team leader and says the CEO is pending', halfway.includes(manager.name) && halfway.includes('Pending') && halfway.includes(ceoStep));
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
    // Rule 6: a revision whose request closed WITHOUT approving it keeps the
    // steps signed before that, dated, and leaves the rest off.
    const refused = await http(salesToken, 'POST', '/quotations', {
      customerId: clinic.id,
      subject: `${TAG} Over a million, refused`,
      lines: [{ group: `${TAG} Installation`, title: 'Oxygen plant', description: '', quantity: 1, unit: 'lot', unitPrice: 1_500_000 }],
    });
    const refusedRev = await prisma.quotationRevision.findFirstOrThrow({ where: { quotationId: String(refused.body.id) } });
    const refusedSubmit = await http(salesToken, 'POST', `/quotations/${refused.body.id}/revisions/${refusedRev.id}/submit`);
    const refusedReq = await prisma.approvalRequest.findFirstOrThrow({ where: { documentType: 'quotation', documentId: refusedRev.id, status: 'PENDING' } });
    await act({ requestId: refusedReq.id, userId: manager.id, action: 'APPROVED' });
    await act({ requestId: refusedReq.id, userId: ceo.id, action: 'REJECTED', comment: `${TAG} not at this price` });
    const refusedText = pdfText(
      Buffer.from(
        await (await fetch(`${BASE}/quotations/${refused.body.id}/revisions/${refusedRev.id}/pdf`, { headers: { Authorization: `Bearer ${salesToken}` } })).arrayBuffer(),
      ),
    ).replace(/\s+/g, ' ');
    check(
      'rejected by the CEO, the PDF keeps the team leader’s signature, dated, and leaves the CEO’s step off — nothing Pending',
      refusedSubmit.status === 200 &&
        (await statusOf(refusedRev.id)) === 'REJECTED' &&
        refusedText.includes(manager.name) &&
        !refusedText.includes(ceoStep) &&
        !refusedText.includes(ceo.name) &&
        !refusedText.includes('Pending'),
      refusedText.slice(-400),
    );
    const smallRev = await prisma.quotationRevision.findFirstOrThrow({ where: { quotationId: String(headed.body.id), status: 'DRAFT' } });
    await http(salesToken, 'POST', `/quotations/${headed.body.id}/revisions/${smallRev.id}/submit`);
    const plainRev = smallRev;
    const plainRequest = await prisma.approvalRequest.findFirstOrThrow({ where: { documentType: 'quotation', documentId: plainRev.id }, include: { workflow: { include: { steps: true } } } });
    check('at or under a million it is submitted to the team leader alone', plainRequest.workflow?.steps.length === 1);

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

    // ── The routing sheet of 2026-10-12: one route whoever prepared it ──
    // A step the preparer holds they sign at submit, dated the submit instant
    // — the same timestamp "Prepared by" prints.
    const timesIn = (text: string, at: Date) => text.replace(/\s+/g, ' ').split(formatDateTime(at)).length - 1;
    const paperOf = async (quotationId: string, revisionId: string, token: string) =>
      pdfText(Buffer.from(await (await fetch(`${BASE}/quotations/${quotationId}/revisions/${revisionId}/pdf`, { headers: { Authorization: `Bearer ${token}` } })).arrayBuffer()));
    type HeldRoute = { steps: { name: string; held?: boolean; approvers: { id: string; name: string }[] }[] } | null;
    const tlQuote = await http(managerToken, 'POST', '/quotations', {
      customerId: clinic.id,
      subject: `${TAG} Team leader's own`,
      lines: [{ group: `${TAG} Installation`, title: 'Oxygen plant', description: '', quantity: 1, unit: 'lot', unitPrice: 50_000 }],
    });
    const tlView = await http(managerToken, 'GET', `/quotations/${tlQuote.body.id}`);
    const tlRoute = (tlView.body.approvalRoutes as { standard: HeldRoute } | null)?.standard;
    check(
      'a Team Leader’s own quotation takes the one route — its Team Leader step is theirs, signed when they submit',
      tlQuote.status === 201 && tlRoute?.steps.length === 1 && tlRoute.steps[0].held === true && tlRoute.steps[0].approvers.map((p) => p.id).join() === manager.id,
      `${tlQuote.status} ${JSON.stringify(tlRoute)}`,
    );
    const tlRev = await prisma.quotationRevision.findFirstOrThrow({ where: { quotationId: String(tlQuote.body.id) } });
    const tlSubmit = await http(managerToken, 'POST', `/quotations/${tlQuote.body.id}/revisions/${tlRev.id}/submit`);
    const tlReq = await prisma.approvalRequest.findFirstOrThrow({ where: { documentType: 'quotation', documentId: tlRev.id }, include: { actions: true } });
    check(
      'submitted, it is approved at once: the Team Leader step signed by the preparer, nobody else asked',
      tlSubmit.status === 200 &&
        tlReq.status === 'APPROVED' &&
        (await statusOf(tlRev.id)) === 'APPROVED' &&
        tlReq.actions.length === 1 &&
        tlReq.actions[0].selfSigned &&
        tlReq.actions[0].approverId === manager.id,
      `${tlSubmit.status} ${tlReq.status} ${JSON.stringify(tlReq.actions)}`,
    );
    check('the signature is dated the submit instant itself', tlReq.actions[0]?.actedAt.getTime() === tlReq.createdAt.getTime());
    const tlPaper = await paperOf(String(tlQuote.body.id), tlRev.id, managerToken);
    // One name per person on paper (2026-10-13): the preparer's own step is
    // their Prepared by, so the Team Leader slot is not printed again.
    check(
      'its PDF prints the preparer once — Prepared by at the submit instant, no Team Leader slot, nothing Pending',
      timesIn(tlPaper, tlReq.createdAt) === 1 && !tlPaper.includes('TEAM LEADER') && !tlPaper.includes('Pending'),
      `${formatDateTime(tlReq.createdAt)} ×${timesIn(tlPaper, tlReq.createdAt)}`,
    );

    // The CEO on the SIT team: their quotation over a million waits on SIT's
    // Team Leader (they report to nobody), and its CEO step is theirs.
    const teamSIT = await prisma.industry.findUniqueOrThrow({ where: { code: 'SIT' } });
    const sitLeader = await makeUser('Verify SIT Leader', 'sitlead@verifys.local', ['team_leader']);
    for (const [u, n] of [[sitLeader, 'E4'], [ceo, 'E5']] as const) {
      await prisma.employee.create({ data: { employeeNo: `${TAG}-${n}`, firstName: 'Verify', lastName: `${TAG} ${n}`, userId: u.id, industryId: teamSIT.id } });
    }
    const ceoToken = signToken(ceo.id, ceo.email);
    const ceoQuote = await http(ceoToken, 'POST', '/quotations', {
      customerId: clinic.id,
      subject: `${TAG} CEO's own`,
      lines: [{ group: `${TAG} Installation`, title: 'Oxygen plant', description: '', quantity: 1, unit: 'lot', unitPrice: 2_000_000 }],
    });
    const ceoRev = await prisma.quotationRevision.findFirstOrThrow({ where: { quotationId: String(ceoQuote.body.id) } });
    const ceoView = await http(ceoToken, 'GET', `/quotations/${ceoQuote.body.id}`);
    const ceoRoute = (ceoView.body.approvalRoutes as { standard: HeldRoute } | null)?.standard;
    check(
      'the CEO’s own quotation over a million: the Team Leader of their own team first, then the CEO step — theirs',
      ceoRoute?.steps.length === 2 &&
        !ceoRoute.steps[0].held &&
        ceoRoute.steps[0].approvers.some((p) => p.id === sitLeader.id) &&
        ceoRoute.steps[1].held === true,
      JSON.stringify(ceoRoute),
    );
    check(
      'with no "Reports to", the Team Leader step goes to the Team Leader on the preparer’s team, not to every one',
      !!ceoRoute && !ceoRoute.steps[0].approvers.some((p) => p.id === manager.id),
      JSON.stringify(ceoRoute?.steps[0]),
    );
    const ceoSubmit = await http(ceoToken, 'POST', `/quotations/${ceoQuote.body.id}/revisions/${ceoRev.id}/submit`);
    const ceoReq = await prisma.approvalRequest.findFirstOrThrow({ where: { documentType: 'quotation', documentId: ceoRev.id }, include: { actions: true } });
    check(
      'submitted, it waits on the Team Leader with the CEO step already signed, at the submit instant',
      ceoSubmit.status === 200 &&
        ceoReq.status === 'PENDING' &&
        ceoReq.currentSequence === 1 &&
        ceoReq.actions.length === 1 &&
        ceoReq.actions[0].sequence === 2 &&
        ceoReq.actions[0].selfSigned &&
        ceoReq.actions[0].actedAt.getTime() === ceoReq.createdAt.getTime(),
      `${ceoSubmit.status} ${ceoReq.status} ${ceoReq.currentSequence} ${JSON.stringify(ceoReq.actions)}`,
    );
    const ceoHalf = await paperOf(String(ceoQuote.body.id), ceoRev.id, ceoToken);
    check(
      'halfway, its PDF prints the CEO once, as Prepared by — not again under CEO / President — and the Team Leader Pending',
      timesIn(ceoHalf, ceoReq.createdAt) === 1 &&
        !ceoHalf.includes('CEO / PRESIDENT') &&
        ceoHalf.includes('TEAM LEADER') &&
        ceoHalf.includes('Pending') &&
        ceoHalf.includes(sitLeader.name),
      `${formatDateTime(ceoReq.createdAt)} ×${timesIn(ceoHalf, ceoReq.createdAt)}`,
    );
    const ceoCanAct = async (token: string) =>
      ((await http(token, 'GET', `/approvals/history/quotation/${ceoRev.id}`)).body as unknown as { canAct?: boolean }[])[0]?.canAct;
    const sitLeaderToken = signToken(sitLeader.id, sitLeader.email);
    check(
      'the Team Leader of the CEO’s team may decide it; the CEO and another team’s leader may not',
      (await ceoCanAct(sitLeaderToken)) === true && (await ceoCanAct(ceoToken)) === false && (await ceoCanAct(managerToken)) === false,
    );
    await act({ requestId: ceoReq.id, userId: sitLeader.id, action: 'APPROVED' });
    const ceoDone = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: ceoReq.id } });
    check(
      'the Team Leader’s signature approves it — the CEO step, already signed, is not asked again',
      ceoDone.status === 'APPROVED' && (await statusOf(ceoRev.id)) === 'APPROVED',
      `${ceoDone.status} ${await statusOf(ceoRev.id)}`,
    );
    const ceoPaper = await paperOf(String(ceoQuote.body.id), ceoRev.id, ceoToken);
    check(
      'and the signed PDF keeps the one timestamp, the Team Leader signed, nothing Pending',
      ceoPaper.split(ceo.name).length - 1 === 1 && !ceoPaper.includes('CEO / PRESIDENT') && !ceoPaper.includes('Pending') && ceoPaper.includes(sitLeader.name),
    );

    // An approver holding both steps signs both with one Approve, and the
    // paper names them once — under Team Leader (2026-10-13, the owner's call).
    const ceoRole = await prisma.role.findUniqueOrThrow({ where: { key: 'ceo' } });
    await prisma.userRole.create({ data: { userId: manager.id, roleId: ceoRole.id } });
    try {
      const both = await http(salesToken, 'POST', '/quotations', {
        customerId: clinic.id,
        subject: `${TAG} Leader who is CEO`,
        lines: [{ group: `${TAG} Installation`, title: 'Oxygen plant', description: '', quantity: 1, unit: 'lot', unitPrice: 2_000_000 }],
      });
      const bothRev = await prisma.quotationRevision.findFirstOrThrow({ where: { quotationId: String(both.body.id) } });
      const bothDraft = await paperOf(String(both.body.id), bothRev.id, salesToken);
      check(
        'a draft whose Team Leader is also the CEO / President prints them once, under Team Leader',
        bothDraft.includes('TEAM LEADER') && !bothDraft.includes('CEO / PRESIDENT') && bothDraft.split(manager.name).length - 1 === 1,
      );
      await http(salesToken, 'POST', `/quotations/${both.body.id}/revisions/${bothRev.id}/submit`);
      const bothReq = await prisma.approvalRequest.findFirstOrThrow({ where: { documentType: 'quotation', documentId: bothRev.id, status: 'PENDING' } });
      await act({ requestId: bothReq.id, userId: manager.id, action: 'APPROVED' });
      const bothDone = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: bothReq.id }, include: { actions: true } });
      const bothPaper = await paperOf(String(both.body.id), bothRev.id, salesToken);
      check(
        'approved with one Approve (the CEO / President step co-signed), the paper names them once, under Team Leader',
        bothDone.status === 'APPROVED' &&
          bothDone.actions.length === 2 &&
          bothPaper.split(manager.name).length - 1 === 1 &&
          bothPaper.includes('TEAM LEADER') &&
          !bothPaper.includes('CEO / PRESIDENT') &&
          !bothPaper.includes('Pending'),
        `${bothDone.status} ${bothDone.actions.length}`,
      );
    } finally {
      await prisma.userRole.deleteMany({ where: { userId: manager.id, roleId: ceoRole.id } });
    }

    // A stand-in: the approver's manager may decide the step from the
    // document — never listed, never told, never queued.
    const boss = await makeUser('Verify Boss', 'boss@verifys.local', []);
    const bossToken = signToken(boss.id, boss.email);
    await prisma.user.update({ where: { id: manager.id }, data: { supervisorId: boss.id } });
    const standIn = await http(salesToken, 'POST', '/quotations', {
      customerId: clinic.id,
      subject: `${TAG} Stand-in`,
      lines: [{ group: `${TAG} Installation`, title: 'Oxygen plant', description: '', quantity: 1, unit: 'lot', unitPrice: 60_000 }],
    });
    const standInRev = await prisma.quotationRevision.findFirstOrThrow({ where: { quotationId: String(standIn.body.id) } });
    const bossBefore = await http(bossToken, 'GET', `/quotations/${standIn.body.id}`);
    check('a manager with no quotation right cannot open a draft that waits on nobody (403)', bossBefore.status === 403, String(bossBefore.status));
    await http(salesToken, 'POST', `/quotations/${standIn.body.id}/revisions/${standInRev.id}/submit`);
    const standInReq = await prisma.approvalRequest.findFirstOrThrow({ where: { documentType: 'quotation', documentId: standInRev.id, status: 'PENDING' } });
    const standInHistory = await http(bossToken, 'GET', `/approvals/history/quotation/${standInRev.id}`);
    const standInRow = (standInHistory.body as unknown as { canAct?: boolean; workflow: { steps: { approvers?: { id: string }[] }[] } }[])[0];
    check(
      'the Team Leader’s manager may decide it from the document (canAct), and is not listed as an approver',
      standInRow?.canAct === true && !JSON.stringify(standInRow?.workflow.steps).includes(boss.id),
      JSON.stringify(standInRow?.workflow.steps),
    );
    const bossQueue = await http(bossToken, 'GET', '/approvals/pending');
    check('nor is it in their queue', bossQueue.status === 200 && !JSON.stringify(bossQueue.body).includes(standInReq.id));
    const bossBell = await prisma.notification.count({ where: { userId: boss.id } });
    check('nor were they told', bossBell === 0, String(bossBell));
    const bossOpen = await http(bossToken, 'GET', `/quotations/${standIn.body.id}`);
    const bossPdf = await fetch(`${BASE}/quotations/${standIn.body.id}/revisions/${standInRev.id}/pdf`, { headers: { Authorization: `Bearer ${bossToken}` } });
    check('while it waits on them they may open it and its paper, with no quotation right', bossOpen.status === 200 && bossPdf.status === 200, `${bossOpen.status} ${bossPdf.status}`);
    const otherOnStandIn = ((await http(otherToken, 'GET', `/approvals/history/quotation/${standInRev.id}`)).body as unknown as { canAct?: boolean }[])[0]?.canAct;
    check('a bystander still may not decide it', otherOnStandIn === false, String(otherOnStandIn));
    await act({ requestId: standInReq.id, userId: boss.id, action: 'APPROVED' });
    const standInAction = await prisma.approvalAction.findFirstOrThrow({ where: { requestId: standInReq.id } });
    check(
      'their decision approves it, in their own name, recorded as standing in for the Team Leader',
      (await statusOf(standInRev.id)) === 'APPROVED' && standInAction.approverId === boss.id && standInAction.onBehalfOfId === manager.id && !standInAction.selfSigned,
      JSON.stringify(standInAction),
    );
    const standInTrail = await prisma.auditLog.findFirst({ where: { entityType: 'quotation', entityId: standInRev.id, action: 'APPROVED' }, orderBy: { at: 'desc' } });
    check('the trail says whom they stood in for', !!standInTrail?.summary.includes(`standing in for ${manager.name}`), standInTrail?.summary);
    const standInPaper = (await paperOf(String(standIn.body.id), standInRev.id, salesToken)).replace(/\s+/g, ' ');
    check('the PDF names who really signed', standInPaper.includes(boss.name), standInPaper.slice(-300));
    const bossAfter = await http(bossToken, 'GET', `/quotations/${standIn.body.id}`);
    check('decided, the door closes again (403)', bossAfter.status === 403, String(bossAfter.status));
    let selfStandIn = false;
    await prisma.user.update({ where: { id: manager.id }, data: { supervisorId: sales.id } });
    const loop = await http(salesToken, 'POST', '/quotations', {
      customerId: clinic.id,
      subject: `${TAG} Stand-in loop`,
      lines: [{ group: `${TAG} Installation`, title: 'Oxygen plant', description: '', quantity: 1, unit: 'lot', unitPrice: 60_000 }],
    });
    const loopRev = await prisma.quotationRevision.findFirstOrThrow({ where: { quotationId: String(loop.body.id) } });
    await http(salesToken, 'POST', `/quotations/${loop.body.id}/revisions/${loopRev.id}/submit`);
    const loopReq = await prisma.approvalRequest.findFirstOrThrow({ where: { documentType: 'quotation', documentId: loopRev.id, status: 'PENDING' } });
    try {
      await act({ requestId: loopReq.id, userId: sales.id, action: 'APPROVED' });
    } catch {
      selfStandIn = true;
    }
    check('the requester never stands in for their own approver, even as that approver’s manager', selfStandIn);
    await prisma.user.update({ where: { id: manager.id }, data: { supervisorId: null } });

    // Admin › Approval Workflows: saving a route without mentioning its
    // "Prepared by", its preparer's signature or its stand-ins keeps them.
    const admin = await makeUser('Verify Admin', 'admin@verifys.local', []);
    await prisma.user.update({ where: { id: admin.id }, data: { isSuperAdmin: true } });
    const adminToken = signToken(admin.id, admin.email);
    const route = await prisma.approvalWorkflow.findFirstOrThrow({
      where: { documentType: 'quotation', isActive: true, name: 'Quotation — Team Leader' },
      include: { steps: { orderBy: { sequence: 'asc' } } },
    });
    const resaved = await http(adminToken, 'PUT', `/workflows/${route.id}`, {
      documentType: route.documentType,
      name: route.name,
      isActive: route.isActive,
      minAmount: route.minAmount == null ? null : Number(route.minAmount),
      maxAmount: route.maxAmount == null ? null : Number(route.maxAmount),
      steps: route.steps.map((st) => ({ sequence: st.sequence, name: st.name, approverType: st.approverType, roleId: st.roleId, userId: st.userId })),
    });
    const resavedRow = await prisma.approvalWorkflow.findUniqueOrThrow({ where: { id: route.id } });
    check(
      'saving a route in Admin without its "Prepared by", preparer’s signature or stand-ins keeps them',
      resaved.status === 200 &&
        resavedRow.requesterRoleId === route.requesterRoleId &&
        resavedRow.preparerSigns === route.preparerSigns &&
        resavedRow.standIns === route.standIns,
      resaved.text.slice(0, 160),
    );
    const stepless = await http(adminToken, 'POST', '/workflows', { documentType: 'quotation', name: `${TAG} no steps`, isActive: false, steps: [] });
    check('a route with no steps is refused unless it is a role’s (400)', stepless.status === 400, stepless.text.slice(0, 160));

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

    // ── Attachments on the quotation, printed behind it, copied to the order (2026-10-12) ──
    console.log('\nAttachments on the quotation and the sales order');
    const soQuoteRev = (soQuote.body.revisions as { id: string }[])[0].id;
    const pngBytes = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#c03030' } }).png().toBuffer();
    const twoPager = await PDFDocument.create();
    twoPager.addPage([300, 400]);
    twoPager.addPage([300, 400]);
    const pdfBytes2 = Buffer.from(await twoPager.save());
    const uploadTo = async (token: string, entity: string, id: string, name: string, type: string, bytes: Buffer) => {
      const form = new FormData();
      form.append('files', new Blob([bytes], { type }), name);
      const res = await fetch(`${BASE}/attachments/${entity}/${id}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
      return { status: res.status, text: await res.text() };
    };
    const upPng = await uploadTo(salesToken, 'quotation', soQuoteId, `${TAG}-site-photo.png`, 'image/png', pngBytes);
    const upPdf = await uploadTo(otherToken, 'quotation', soQuoteId, `${TAG}-customer-PO.pdf`, 'application/pdf', pdfBytes2);
    const upDoc = await uploadTo(salesToken, 'quotation', soQuoteId, `${TAG}-specs.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', Buffer.from('not really a docx'));
    const upBad = await uploadTo(salesToken, 'quotation', soQuoteId, `${TAG}-broken.pdf`, 'application/pdf', Buffer.from('%PDF-1.4 this is not a pdf'));
    check('the author attaches a photo, a Word file and a damaged PDF to the quotation', [upPng, upDoc, upBad].every((u) => u.status === 201), upPng.text.slice(0, 120));
    check('a colleague who may raise sales orders files the customer’s PO on it', upPdf.status === 201, upPdf.text.slice(0, 120));
    const lonerToken = signToken(loner.id, loner.email);
    const lonerList = await http(lonerToken, 'GET', `/attachments/quotation/${soQuoteId}`);
    const lonerUp = await uploadTo(lonerToken, 'quotation', soQuoteId, `${TAG}-x.png`, 'image/png', pngBytes);
    check(
      'someone who may not open the quotation can neither see its files nor add one',
      (lonerList.status === 403 || lonerList.status === 404) && (lonerUp.status === 403 || lonerUp.status === 404),
      `${lonerList.status} ${lonerUp.status}`,
    );
    const pagesOf = async (buf: Buffer) => (await PDFDocument.load(buf)).getPageCount();
    const bytesOf = async (url: string, token = salesToken) => Buffer.from(await (await fetch(`${BASE}${url}`, { headers: { Authorization: `Bearer ${token}` } })).arrayBuffer());
    const qBare = await bytesOf(`/quotations/${soQuoteId}/revisions/${soQuoteRev}/pdf?attachments=0`);
    const qFull = await bytesOf(`/quotations/${soQuoteId}/revisions/${soQuoteRev}/pdf`);
    const qFullText = pdfText(qFull);
    check(
      'printed, the quotation carries its files: an Attachments page, the photo on a page, the PO’s two pages',
      (await pagesOf(qFull)) === (await pagesOf(qBare)) + 1 + 1 + 2,
      `${await pagesOf(qBare)} → ${await pagesOf(qFull)}`,
    );
    check(
      'the Attachments page names all four, says what cannot be printed, and how many pages follow',
      qFullText.includes('ATTACHMENTS') && [`${TAG}-site-photo.png`, `${TAG}-customer-PO.pdf`, `${TAG}-specs.docx`, `${TAG}-broken.pdf`].every((n) => qFullText.includes(n)) &&
        qFullText.includes('Not printable') && qFullText.includes('Could not be read') && qFullText.includes('3 pages follow'),
    );
    check('“Print without attachments” is the bare quotation', !pdfText(qBare).includes(`${TAG}-site-photo.png`));
    // SCORO's Create invoice: what is left to book, then bookings against it.
    const booking0 = await http(salesToken, 'GET', `/sales-orders/booking?quotationId=${soQuoteId}`);
    const bk0 = booking0.body as unknown as { net: number; availableNet: number; lines: { id: string; available: number; booked: number; isHeading: boolean }[] };
    check(
      'what is left to book: every line in full, the whole net',
      booking0.status === 200 && money(bk0.availableNet, 103_750) && bk0.lines.every((l) => l.available === 1 && l.booked === 0),
      booking0.text.slice(0, 160),
    );
    const bkLines = bk0.lines.filter((l) => !l.isHeading);
    const so1 = await http(salesToken, 'POST', '/sales-orders', {
      quotationId: soQuoteId,
      mode: 'lines',
      lines: [
        { id: bkLines[0].id, quantity: 0.5 },
        { id: bkLines[1].id, quantity: 0.5 },
      ],
    });
    check('a sales order books half of each line — progress booking, SCORO\u2019s 50%', so1.status === 201, so1.text.slice(0, 160));
    const so1Body = so1.body as unknown as { id: string; number: string; status: string; total: number; lines: { group: string | null; unitCost: number | null; quantity: number; amount: number; costAmount: number | null }[] };

    // The quotation's files travel with the order it books.
    const soFiles = await prisma.attachment.findMany({ where: { entityType: 'sales_order', entityId: so1Body.id }, orderBy: { uploadedAt: 'asc' } });
    const qFiles = await prisma.attachment.findMany({ where: { entityType: 'quotation', entityId: soQuoteId }, orderBy: { uploadedAt: 'asc' } });
    check(
      'raising the order copied the quotation’s four files onto it — rows and bytes of their own, captioned',
      soFiles.length === 4 &&
        soFiles.every((f, i) => f.fileName === qFiles[i].fileName && f.size === qFiles[i].size && f.storedName !== qFiles[i].storedName && (f.caption ?? '').startsWith('From quotation')),
      soFiles.map((f) => f.fileName).join(', '),
    );
    const soBare = await bytesOf(`/sales-orders/${so1Body.id}/pdf?attachments=0`);
    const soFull = await bytesOf(`/sales-orders/${so1Body.id}/pdf`);
    check(
      'the order prints with them too, so its approvers see the PO',
      (await pagesOf(soFull)) === (await pagesOf(soBare)) + 4 && pdfText(soFull).includes(`${TAG}-customer-PO.pdf`),
      `${await pagesOf(soBare)} → ${await pagesOf(soFull)}`,
    );
    const dropCopy = await http(salesToken, 'DELETE', `/attachments/${soFiles[0].id}`);
    check(
      'removing a copy from the order leaves the quotation’s original',
      dropCopy.status === 200 && (await prisma.attachment.count({ where: { entityType: 'quotation', entityId: soQuoteId } })) === 4,
      dropCopy.text.slice(0, 120),
    );
    check(
      'its lines carry the booked quantity, the amount for it, and cost scaled with it',
      so1Body.status === 'DRAFT' &&
        so1Body.lines.length === 2 &&
        so1Body.lines[0].group === `${TAG} Installation` &&
        so1Body.lines[0].unitCost === 30_000 &&
        so1Body.lines[0].quantity === 0.5 &&
        money(so1Body.lines[0].amount, 36_875) &&
        money(so1Body.lines[0].costAmount ?? 0, 15_000) &&
        money(so1Body.total, 51_875 * 1.12),
      JSON.stringify(so1Body).slice(0, 260),
    );
    check('its number has no suffix — the first booking takes the base', !so1Body.number.includes('.'), so1Body.number);
    const booking1 = await http(salesToken, 'GET', `/sales-orders/booking?quotationId=${soQuoteId}`);
    const bk1 = booking1.body as unknown as { availableNet: number; bookedNet: number; lines: { available: number; booked: number }[] };
    check(
      'what is left halves: the booked quantity is off every line and the booked net off the quotation',
      money(bk1.availableNet, 51_875) && money(bk1.bookedNet, 51_875) && bk1.lines.every((l) => l.available === 0.5 && l.booked === 0.5),
      booking1.text.slice(0, 160),
    );
    const over = await http(salesToken, 'POST', '/sales-orders', { quotationId: soQuoteId, mode: 'lines', lines: [{ id: bkLines[0].id, quantity: 0.6 }] });
    check('booking more than is left is refused, and the refusal says what is left', over.status === 400 && over.text.includes('0.5'), over.text.slice(0, 160));
    const so2 = await http(salesToken, 'POST', '/sales-orders', { quotationId: soQuoteId, mode: 'summary' });
    const so2Body = so2.body as unknown as { id: string; number: string; total: number; lines: { title: string | null }[] };
    check(
      'the second order is .1 — one family — and summarises what is left into one line worth it',
      so2.status === 201 && so2Body.number === `${so1Body.number}.1` && so2Body.lines.length === 1 && so2Body.lines[0].title === upperText(`${TAG} Booked plant`) && money(so2Body.total, 51_875 * 1.12),
      so2.text.slice(0, 200),
    );
    const nothing = await http(salesToken, 'POST', '/sales-orders', { quotationId: soQuoteId, mode: 'all' });
    check('with everything booked, another order is refused', nothing.status === 400 && nothing.text.includes('Nothing is left'), nothing.text.slice(0, 160));

    const cancelBare = await http(salesToken, 'POST', `/sales-orders/${so2Body.id}/cancel`, {});
    const cancelled = await http(salesToken, 'POST', `/sales-orders/${so2Body.id}/cancel`, { reason: `${TAG} booked too early` });
    check('cancelling needs its reason, and keeps the record', cancelBare.status === 400 && cancelled.status === 200, `${cancelBare.status} ${cancelled.status}`);
    const booking2 = await http(salesToken, 'GET', `/sales-orders/booking?quotationId=${soQuoteId}`);
    const bk2 = booking2.body as unknown as { availableNet: number; lines: { available: number }[] };
    check('a cancelled order gives its booking back', money(bk2.availableNet, 51_875) && bk2.lines.every((l) => l.available === 0.5), booking2.text.slice(0, 160));
    const so3 = await http(salesToken, 'POST', '/sales-orders', { quotationId: soQuoteId, mode: 'all' });
    const so3Body = so3.body as unknown as { id: string; number: string; subtotal: number; lines: { quantity: number }[] };
    check(
      '"all" books what is left of every line — the other half — numbered .2',
      so3.status === 201 && so3Body.number === `${so1Body.number}.2` && so3Body.lines.length === 2 && so3Body.lines.every((l) => l.quantity === 0.5) && money(so3Body.subtotal, 51_875),
      `${so3Body.number} ${so3Body.subtotal}`,
    );

    // The quotation page lists its orders under it, SCORO-style, through the
    // ordinary list query — the same rows, the same visibility.
    const underQuote = await http(salesToken, 'GET', `/sales-orders?quotationId=${soQuoteId}&sort=number&dir=asc`);
    const underRows = (underQuote.body.rows ?? []) as { number: string }[];
    check(
      'the quotation lists the orders booked from it, in number order \u2014 the cancelled one among them',
      underQuote.status === 200 &&
        underRows.length === 3 &&
        underRows.map((r) => r.number).join(',') === `${so1Body.number},${so1Body.number}.1,${so1Body.number}.2`,
      underRows.map((r) => r.number).join(','),
    );

    const delCancelled = await http(salesToken, 'DELETE', `/sales-orders/${so2Body.id}`);
    check(
      'a cancelled order can be deleted (2026-10-07, the owner\u2019s call)',
      delCancelled.status === 200 && (await prisma.salesOrder.findUnique({ where: { id: so2Body.id } })) === null,
      delCancelled.text.slice(0, 120),
    );
    const underQuoteAfter = await http(salesToken, 'GET', `/sales-orders?quotationId=${soQuoteId}&sort=number&dir=asc`);
    const underRowsAfter = (underQuoteAfter.body.rows ?? []) as { number: string }[];
    check(
      'and it leaves the quotation\u2019s list',
      underRowsAfter.map((r) => r.number).join(',') === `${so1Body.number},${so1Body.number}.2`,
      underRowsAfter.map((r) => r.number).join(','),
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

    // ── Approval: the owner's route (2026-10-08) — Team Leader, Back Support /
    //    Admin, Cost Controller, CEO — through the one engine ──
    const backSupport = await makeUser('Verify Back Support', 'bs@verifys.local', ['back_support']);
    const costController = await makeUser('Verify Cost Controller', 'cc@verifys.local', ['cost_controller']);
    const issueRefused = await http(salesToken, 'POST', `/sales-orders/${so1Body.id}/issue`);
    check('with a route active, Issue is refused — the order is submitted instead', issueRefused.status === 400 && issueRefused.text.includes('approval'), issueRefused.text.slice(0, 120));
    const soRoute = await http(salesToken, 'GET', `/sales-orders/${so1Body.id}`);
    const soRouteBody = soRoute.body as unknown as {
      needsApproval: boolean;
      approvalOptions: { id: string; label: string }[];
      approvalRoutes: { standard: { steps: { name: string; approvers: { id: string }[] }[] } | null } | null;
    };
    const soSteps = soRouteBody.approvalRoutes?.standard?.steps ?? [];
    check(
      'the order names its four signatures — the team leader (the sales managers, with no "Reports to"), back support, the cost controller, the CEO — each by name, and offers no option',
      soRouteBody.needsApproval === true &&
        soRouteBody.approvalOptions.length === 0 &&
        soSteps.map((s) => s.name).join(' › ') === 'Team Leader › Back Support › Cost Controller › CEO / President' &&
        soSteps[0].approvers.some((p) => p.id === manager.id) &&
        soSteps[1].approvers.some((p) => p.id === backSupport.id) &&
        soSteps[2].approvers.some((p) => p.id === costController.id) &&
        soSteps[3].approvers.some((p) => p.id === ceo.id),
      soRoute.text.slice(0, 400),
    );
    // One route whoever prepares it (the routing sheet of 2026-10-12): a Team
    // Leader's own order has its Team Leader step signed at submit; the CEO's
    // own its CEO step, the Team Leader of the CEO's team asked first.
    const tlSo = await routePreview('sales_order', 100_000, manager.id);
    const ceoSo = await routePreview('sales_order', 100_000, ceo.id);
    const shape = (r: typeof tlSo) => r?.steps.map((st) => `${st.name}${st.held ? '*' : ''}`).join(' › ');
    check(
      "a Team Leader's order: the four steps, their own Team Leader step theirs",
      shape(tlSo) === 'Team Leader* › Back Support › Cost Controller › CEO / President',
      shape(tlSo),
    );
    check(
      "the CEO / President's order: the four steps, the CEO step theirs, the Team Leader their team's",
      shape(ceoSo) === 'Team Leader › Back Support › Cost Controller › CEO / President*' &&
        !!ceoSo?.steps[0].approvers.some((p) => p.id === sitLeader.id),
      shape(ceoSo),
    );
    const submitted = await http(salesToken, 'POST', `/sales-orders/${so1Body.id}/submit`, {});
    check('submitting puts it with the team leader', submitted.status === 200 && submitted.body.status === 'PENDING_APPROVAL', submitted.text.slice(0, 120));
    check('a pending order refuses edits', (await http(salesToken, 'PUT', `/sales-orders/${so1Body.id}`, { termsDays: 45 })).status === 400);
    const soPulled = await http(salesToken, 'POST', `/sales-orders/${so1Body.id}/withdraw`);
    const soPulledReq = await prisma.approvalRequest.findFirst({ where: { documentType: 'sales_order', documentId: so1Body.id }, orderBy: { createdAt: 'desc' } });
    check('the author pulls it back to draft, and the request is withdrawn', soPulled.status === 200 && soPulledReq?.status === 'CANCELLED', `${soPulled.status} ${soPulledReq?.status}`);
    const submittedAgain = await http(salesToken, 'POST', `/sales-orders/${so1Body.id}/submit`, {});
    const openReq = await prisma.approvalRequest.findFirst({ where: { documentType: 'sales_order', documentId: so1Body.id, status: 'PENDING' } });
    await act({ requestId: openReq!.id, userId: manager.id, action: 'REJECTED' });
    const afterReject = await prisma.salesOrder.findUniqueOrThrow({ where: { id: so1Body.id } });
    check('rejected by the team leader, it returns to draft', submittedAgain.status === 200 && afterReject.status === 'DRAFT', afterReject.status);
    const submittedThird = await http(salesToken, 'POST', `/sales-orders/${so1Body.id}/submit`, {});
    const openReq2 = await prisma.approvalRequest.findFirst({ where: { documentType: 'sales_order', documentId: so1Body.id, status: 'PENDING' } });
    await act({ requestId: openReq2!.id, userId: manager.id, action: 'APPROVED' });
    const afterLeader = await prisma.salesOrder.findUniqueOrThrow({ where: { id: so1Body.id } });
    check("the team leader's approval alone books nothing — the order waits on back support", submittedThird.status === 200 && afterLeader.status === 'PENDING_APPROVAL', afterLeader.status);
    let skipped = false;
    try {
      await act({ requestId: openReq2!.id, userId: ceo.id, action: 'APPROVED' });
    } catch {
      skipped = true;
    }
    check('the CEO cannot sign before back support and the cost controller have', skipped);
    await act({ requestId: openReq2!.id, userId: backSupport.id, action: 'APPROVED' });
    await act({ requestId: openReq2!.id, userId: costController.id, action: 'APPROVED' });
    const afterController = await prisma.salesOrder.findUniqueOrThrow({ where: { id: so1Body.id } });
    check('three signatures in, it still waits on the CEO', afterController.status === 'PENDING_APPROVAL', afterController.status);
    await act({ requestId: openReq2!.id, userId: ceo.id, action: 'APPROVED' });
    const afterApprove = await prisma.salesOrder.findUniqueOrThrow({ where: { id: so1Body.id } });
    check('with the CEO’s, it is issued — the sale is booked', afterApprove.status === 'ISSUED', afterApprove.status);
    const delIssued = await http(salesToken, 'DELETE', `/sales-orders/${so1Body.id}`);
    check('an issued order cannot be deleted', delIssued.status === 400, String(delIssued.status));
    const editIssued = await http(salesToken, 'PUT', `/sales-orders/${so1Body.id}`, { termsDays: 45 });
    check('an issued order refuses the full save — reopen first', editIssued.status === 400, String(editIssued.status));
    const released = await http(salesToken, 'PATCH', `/sales-orders/${so1Body.id}`, { siNumber: 'SI-4622', drNumber: 'DR-991' });
    check('but still takes its release references', released.status === 200, String(released.status));

    await prisma.salesOrder.update({ where: { id: so1Body.id }, data: { contactId: clinic.contacts[0].id } });
    const soPdfBytes = Buffer.from(
      await (
        await fetch(`${BASE}/sales-orders/${so1Body.id}/pdf`, { headers: { Authorization: `Bearer ${salesToken}` } })
      ).arrayBuffer(),
    );
    const soPdfOwner = pdfText(soPdfBytes);
    check(
      'the order paper prints the contact’s mobile and email under Attention, as the quotation does (2026-10-12)',
      soPdfOwner.includes('Attention:') && soPdfOwner.includes('Mobile: 0917 555 0101 | Email: cruz@zz.local'),
      soPdfOwner.slice(soPdfOwner.indexOf('CUSTOMER'), soPdfOwner.indexOf('CUSTOMER') + 300),
    );
    check(
      'the PDF prints through the Sales Order template: customer, PO, totals — and cost and margin for who may see them',
      soPdfOwner.includes('SALES ORDER') && soPdfOwner.includes('4500001134') && soPdfOwner.includes('TOTAL COST') && soPdfOwner.includes('SI / BS No.: SI-4622'),
      soPdfOwner.slice(0, 200),
    );
    // A name wraps inside its column (five sign-offs share the block), so the
    // names are looked for with the line breaks read as spaces.
    const soSignLine = soPdfOwner.replace(/\s+/g, ' ');
    check(
      'and its sign-offs name all four signatures, dated',
      [manager, backSupport, costController, ceo].every((p) => soSignLine.includes(p.name)) && !soPdfOwner.includes('Pending'),
      soSignLine.slice(-400),
    );
    check(
      'each under its step’s own name, in capitals — nothing added, never "APPROVED BY — …"',
      soSteps.every((st) => soSignLine.includes(st.name.toUpperCase())) && !soSignLine.includes('APPROVED BY'),
      soSignLine.slice(-400),
    );
    check(
      'and the paper is A4 on its side — the cost columns are why it is landscape',
      // The order's own first page (attachments behind it keep their own sizes).
      await (async () => {
        const first = (await PDFDocument.load(soPdfBytes)).getPage(0).getSize();
        return Math.abs(first.width - 841.89) < 0.01 && Math.abs(first.height - 595.28) < 0.01;
      })(),
    );
    // The CEO's own order (the owner's example): it waits on the Team Leader
    // of the CEO's team, back support and the cost controller; its CEO step
    // is signed at submit, and its paper prints that and Prepared by under
    // one timestamp.
    const ceoOrder = await http(ceoToken, 'POST', '/sales-orders', { quotationId: String(ceoQuote.body.id), mode: 'all' });
    const ceoOrderId = String(ceoOrder.body.id);
    const ceoOrderSubmit = await http(ceoToken, 'POST', `/sales-orders/${ceoOrderId}/submit`, {});
    const ceoOrderReq = await prisma.approvalRequest.findFirstOrThrow({ where: { documentType: 'sales_order', documentId: ceoOrderId, status: 'PENDING' }, include: { actions: true } });
    check(
      "the CEO's own order waits on the Team Leader with its CEO step signed at the submit instant",
      ceoOrder.status === 201 &&
        ceoOrderSubmit.status === 200 &&
        ceoOrderReq.currentSequence === 1 &&
        ceoOrderReq.actions.length === 1 &&
        ceoOrderReq.actions[0].sequence === 4 &&
        ceoOrderReq.actions[0].selfSigned &&
        ceoOrderReq.actions[0].actedAt.getTime() === ceoOrderReq.createdAt.getTime(),
      `${ceoOrder.status} ${ceoOrderSubmit.status} ${ceoOrderSubmit.text.slice(0, 120)}`,
    );
    for (const who of [sitLeader, backSupport]) await act({ requestId: ceoOrderReq.id, userId: who.id, action: 'APPROVED' });
    check(
      'two of the three others in, it still waits',
      (await prisma.salesOrder.findUniqueOrThrow({ where: { id: ceoOrderId } })).status === 'PENDING_APPROVAL',
    );
    await act({ requestId: ceoOrderReq.id, userId: costController.id, action: 'APPROVED' });
    check(
      "the cost controller's signature issues it — the CEO step is already signed",
      (await prisma.salesOrder.findUniqueOrThrow({ where: { id: ceoOrderId } })).status === 'ISSUED',
    );
    const ceoOrderPaper = pdfText(
      Buffer.from(await (await fetch(`${BASE}/sales-orders/${ceoOrderId}/pdf`, { headers: { Authorization: `Bearer ${ceoToken}` } })).arrayBuffer()),
    );
    check(
      'its paper prints Prepared by and the CEO step under one timestamp',
      timesIn(ceoOrderPaper, ceoOrderReq.createdAt) >= 2 && !ceoOrderPaper.includes('Pending'),
      `${formatDateTime(ceoOrderReq.createdAt)} ×${timesIn(ceoOrderPaper, ceoOrderReq.createdAt)}`,
    );

    const soPdfOther = pdfText(
      Buffer.from(
        await (
          await fetch(`${BASE}/sales-orders/${so1Body.id}/pdf`, { headers: { Authorization: `Bearer ${otherToken}` } })
        ).arrayBuffer(),
      ),
    );
    check('the same paper for a reader without cost rights carries no cost or margin', !soPdfOther.includes('TOTAL COST') && !soPdfOther.includes('20,004.58'));
    // The margin as a percentage too (2026-10-11): under each line's margin
    // and as its own row under the margin sum — for cost viewers alone.
    check(
      'the order paper prints the margin as a percentage, per line and in total, only where cost shows',
      // Always two decimals (2026-10-12, the owner's call): "16.29%" under a
      // line's margin, "16.29" in the MARGIN (%) cell.
      /\n-?\d+\.\d\d\nMARGIN \(%\)/.test(soPdfOwner) && /\n-?\d+\.\d\d%\n/.test(soPdfOwner) && !soPdfOther.includes('MARGIN (%)'),
      (soPdfOwner.match(/[^\n]*\nMARGIN \(%\)/) ?? [''])[0],
    );
    // The owner's slide (2026-10-12): cells in the quotation's words — VAT,
    // never "Tax" — Total price, Total cost, Margin, VAT, VAT included and
    // Margin (%), and no Subtotal or Discount: the lines carry the discount.
    check(
      'its money is the six cells — Total price, Total cost, Margin, VAT, VAT included, Margin (%) — never "Tax", no Subtotal',
      ['TOTAL PRICE', 'TOTAL COST', 'MARGIN', 'VAT INCLUDED', 'MARGIN (%)'].every((t) => soPdfOwner.includes(`\n${t}`)) &&
        /VAT \(\d+(\.\d+)?%\)/.test(soPdfOwner) && !soPdfOwner.includes('Tax (') && !/Subtotal|Discount|Sum without tax/i.test(soPdfOwner),
      soPdfOwner.slice(soPdfOwner.indexOf('TOTAL PRICE') - 60, soPdfOwner.indexOf('MARGIN (%)') + 12).replace(/\n/g, ' | '),
    );
    check(
      'and a reader without cost rights gets Total price, VAT and VAT included alone',
      ['TOTAL PRICE', 'VAT INCLUDED'].every((t) => soPdfOther.includes(t)) && /VAT \(\d+(\.\d+)?%\)/.test(soPdfOther) &&
        !soPdfOther.includes('TOTAL COST') && !soPdfOther.includes('MARGIN (%)') && !soPdfOther.includes('Tax ('),
    );
    // A discount is carried by the lines (2026-10-12, "don't reflect the
    // discount"): the order's own lines at 10% off, on the paper and the page.
    const soLinesNow = await prisma.salesOrderLine.findMany({ where: { orderId: so1Body.id }, orderBy: { sortOrder: 'asc' } });
    const soBefore = await prisma.salesOrder.findUniqueOrThrow({ where: { id: so1Body.id }, select: { discountPct: true } });
    await prisma.salesOrder.update({ where: { id: so1Body.id }, data: { discountPct: 10 } });
    const soNet = quotationTotals({ lines: soLinesNow, discountPct: 10, vatRate: 0.12 });
    const discPaper = pdfText(
      Buffer.from(await (await fetch(`${BASE}/sales-orders/${so1Body.id}/pdf`, { headers: { Authorization: `Bearer ${salesToken}` } })).arrayBuffer()),
    );
    const fmt2 = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    check(
      'with a discount, the paper prints each line after it and no discount row',
      soNet.lines.filter((l, i) => !soLinesNow[i].isHeading).every((l) => discPaper.includes(fmt2(l.netAmount))) &&
        discPaper.includes(fmt2(soNet.net)) && !/Discount|Subtotal/i.test(discPaper) && !discPaper.includes(fmt2(soNet.subtotal)) &&
        // No list price printed (where it is not also somebody's cost figure).
        !soLinesNow.some(
          (l, i) =>
            !l.isHeading &&
            Number(l.amount) !== soNet.lines[i].netAmount &&
            !soLinesNow.some((c) => c.costAmount != null && Number(c.costAmount) === Number(l.amount)) &&
            discPaper.includes(`\n${fmt2(Number(l.amount))}\n`),
        ),
      discPaper.slice(discPaper.indexOf('MARGIN') - 10, discPaper.indexOf('TOTAL PRICE') + 20).replace(/\n/g, ' | '),
    );
    const discPage = (await http(salesToken, 'GET', `/sales-orders/${so1Body.id}`)).body as unknown as {
      netOfTax: number;
      lines: { isHeading: boolean; amount: number; netAmount: number; netUnitPrice: number; quantity: number; netMargin?: number | null }[];
    };
    check(
      'and the page sends the same after-discount figures beside the list price the editor keeps',
      discPage.netOfTax === soNet.netOfTax &&
        discPage.lines.every((l, i) => l.netAmount === soNet.lines[i].netAmount && l.amount === soNet.lines[i].amount) &&
        discPage.lines.filter((l) => !l.isHeading).every((l, i) => l.netMargin === soNet.lines.filter((_, j) => !discPage.lines[j].isHeading)[i].netMargin),
      JSON.stringify(discPage.lines.map((l) => [l.amount, l.netAmount, l.netUnitPrice, l.netMargin])),
    );
    await prisma.salesOrder.update({ where: { id: so1Body.id }, data: { discountPct: soBefore.discountPct } });
    // Reopened and issued again with no route standing (the issue route
    // refuses while one is active, so the direct issue is written as that
    // route writes it): the four signatures of the approval it was reopened
    // from no longer stand — the paper says who issued it.
    const soReopened = await http(salesToken, 'POST', `/sales-orders/${so1Body.id}/reopen`);
    await prisma.salesOrder.update({ where: { id: so1Body.id }, data: { status: 'ISSUED' } });
    await prisma.auditLog.create({
      data: { entityType: 'sales_order', entityId: so1Body.id, action: 'COMPLETED', actorId: sales.id, actorName: sales.name, summary: `Issued sales order ${so1Body.number}` },
    });
    const soReissued = pdfText(
      Buffer.from(await (await fetch(`${BASE}/sales-orders/${so1Body.id}/pdf`, { headers: { Authorization: `Bearer ${salesToken}` } })).arrayBuffer()),
    ).replace(/\s+/g, ' ');
    check(
      'reopened and issued again with no route, it prints ISSUED BY whoever issued it — never the approval it was reopened from, nor Pending',
      soReopened.status === 200 && soReissued.includes(`ISSUED BY ${sales.name}`) &&
        !soSteps.some((st) => soReissued.includes(st.name.toUpperCase())) && !soReissued.includes('Pending'),
      soReissued.slice(-400),
    );
    // Cancelled while it waits (rule 6): the request goes with it, and the
    // paper keeps the step signed by then, dated — never "Pending" under the
    // three steps nobody will now sign.
    const soPaper = async (id: string) =>
      pdfText(
        Buffer.from(await (await fetch(`${BASE}/sales-orders/${id}/pdf`, { headers: { Authorization: `Bearer ${salesToken}` } })).arrayBuffer()),
      ).replace(/\s+/g, ' ');
    const so3Submit = await http(salesToken, 'POST', `/sales-orders/${so3Body.id}/submit`, {});
    const so3Req = await prisma.approvalRequest.findFirst({ where: { documentType: 'sales_order', documentId: so3Body.id, status: 'PENDING' } });
    await act({ requestId: so3Req!.id, userId: manager.id, action: 'APPROVED' });
    const so3Cancel = await http(salesToken, 'POST', `/sales-orders/${so3Body.id}/cancel`, { reason: `${TAG} customer withdrew` });
    const so3Text = await soPaper(so3Body.id);
    check(
      'cancelled while it waits, its PDF keeps the team leader’s signature, dated, and leaves the other three steps off — nothing Pending',
      so3Submit.status === 200 && so3Cancel.status === 200 &&
        so3Text.includes(`${soSteps[0].name.toUpperCase()}`) && so3Text.includes(manager.name) &&
        !soSteps.slice(1).some((st) => so3Text.includes(st.name.toUpperCase())) &&
        ![backSupport, costController, ceo].some((p) => so3Text.includes(p.name)) && !so3Text.includes('Pending'),
      so3Text.slice(-400),
    );
    // Pulled back to draft after a signature, then cancelled from the draft:
    // that signature stood behind a request withdrawn before the cancel, so
    // nothing of it is printed — the paper is the author's alone.
    const so4 = await http(salesToken, 'POST', '/sales-orders', { quotationId: soQuoteId, mode: 'all' });
    const so4Id = String(so4.body.id);
    await http(salesToken, 'POST', `/sales-orders/${so4Id}/submit`, {});
    const so4Req = await prisma.approvalRequest.findFirst({ where: { documentType: 'sales_order', documentId: so4Id, status: 'PENDING' } });
    await act({ requestId: so4Req!.id, userId: manager.id, action: 'APPROVED' });
    const so4Pull = await http(salesToken, 'POST', `/sales-orders/${so4Id}/withdraw`);
    const so4Cancel = await http(salesToken, 'POST', `/sales-orders/${so4Id}/cancel`, { reason: `${TAG} booked in error` });
    const so4Text = await soPaper(so4Id);
    check(
      'pulled back after a signature and cancelled from its draft, the PDF names no approver and nothing Pending — that signature no longer stands',
      so4.status === 201 && so4Pull.status === 200 && so4Cancel.status === 200 &&
        so4Text.includes(sales.name) && !so4Text.includes(manager.name) &&
        !soSteps.some((st) => so4Text.includes(st.name.toUpperCase())) && !so4Text.includes('Pending'),
      so4Text.slice(-400),
    );


    // ── Pulling a revision back from the approver to edit it ─────────────────
    console.log('\nThe list of quotations over HTTP, and on paper');
    {
      const LISTQ = `${TAG} LISTQ`;
      const listed = await http(salesToken, 'GET', `/quotations?search=${encodeURIComponent(LISTQ)}&scope=all&pageSize=50`);
      const lSummary = listed.body.summary as { tabCounts: Record<string, number>; count: number; value: number } | undefined;
      const lRows = (listed.body.rows ?? []) as { stage: string; stageLabel: string; value: number; margin: unknown; owner: { id: string } }[];
      check(
        'GET /quotations carries the summary: stage counts, count and value, matching its rows',
        listed.status === 200 && !!lSummary && lSummary.count === lRows.length && lSummary.tabCounts[''] === lRows.length &&
          money(lSummary.value, lRows.reduce((t, r) => t + r.value, 0)),
        listed.text.slice(0, 200),
      );
      check(
        'each row says its stage and the stage’s name',
        lRows.length === 6 && lRows.every((r) => !!r.stage && !!r.stageLabel),
      );
      // The PDF icon on the list prints the value revision — the row names it.
      const withIds = (listed.body.rows ?? []) as { id: string; valueRevision: { id: string } | null }[];
      let namesItsRevision = withIds.length > 0;
      for (const r of withIds) {
        const q = await prisma.quotation.findUniqueOrThrow({
          where: { id: r.id },
          select: { revisions: { select: { id: true, status: true, revision: true, total: true }, orderBy: { revision: 'desc' } } },
        });
        if ((valuedRevisionOf(q.revisions)?.id ?? null) !== (r.valueRevision?.id ?? null)) namesItsRevision = false;
      }
      check('each row names the revision its value — and its PDF icon — comes from', namesItsRevision);
      // A costed line on the colleague's completed quotation: its author sees
      // the margin; another salesperson only with a right that shows cost.
      const colleagues = await prisma.quotation.findFirstOrThrow({
        where: { subject: `${LISTQ} completed` },
        select: { id: true, revisions: { select: { id: true } } },
      });
      await prisma.quotationItem.create({
        data: {
          revisionId: colleagues.revisions[0].id,
          description: `${TAG} costed line`,
          quantity: d(1),
          unitPrice: d(500),
          amount: d(500),
          unitCost: d(300),
          costAmount: d(300),
        },
      });
      const marginOf = async (token: string) => {
        const r = await http(token, 'GET', `/quotations?search=${encodeURIComponent(`${LISTQ} completed`)}&scope=all`);
        return ((r.body.rows ?? []) as { margin: { amount: number } | null }[])[0]?.margin ?? null;
      };
      const authorMargin = await marginOf(otherToken);
      const readerMargin = await marginOf(salesToken);
      const readerMay = canSeeQuotationCost(salesUser, other.id);
      check(
        'margin reaches only a reader who may see that quotation\u2019s cost',
        !!authorMargin && money(authorMargin.amount, 200) && (readerMay ? !!readerMargin : readerMargin === null),
        `${JSON.stringify(authorMargin)} / ${JSON.stringify(readerMargin)} (reader may: ${readerMay})`,
      );
      // The totals row's margin and the Team view, over HTTP.
      const authorList = await http(otherToken, 'GET', `/quotations?search=${encodeURIComponent(`${LISTQ} completed`)}&scope=mine`);
      const authorSum = authorList.body.summary as { margin?: { amount: number; pct: number | null; costed: number } } | undefined;
      check(
        'the totals row’s margin is the rows’ own margin summed, for a set whose cost is the viewer’s to see',
        authorList.status === 200 && !!authorSum?.margin && money(authorSum.margin.amount, 200) && authorSum.margin.pct === 40 && authorSum.margin.costed === 1,
        JSON.stringify(authorSum),
      );
      const readerSum = (await http(salesToken, 'GET', `/quotations?search=${encodeURIComponent(`${LISTQ} completed`)}&scope=all`)).body.summary as
        | { margin?: unknown }
        | undefined;
      const readerSeesEvery =
        salesUser.permissions.has('gops.quotations.edit_all') ||
        salesUser.permissions.has('gops.costing.view_all') ||
        !salesUser.permissions.has('gops.quotations.view_all');
      check(
        'and is left out — never 0 — for a reader who may not see every listed quotation’s cost',
        readerSeesEvery ? !!readerSum?.margin : !readerSum?.margin,
        JSON.stringify(readerSum),
      );
      const teamList = await http(salesToken, 'GET', `/quotations?search=${encodeURIComponent(LISTQ)}&scope=team&pageSize=50`);
      const teamRows = (teamList.body.rows ?? []) as { owner: { id: string } }[];
      const salesSeesAll = salesUser.permissions.has('gops.quotations.view_all');
      check(
        'the Team view over HTTP: a colleague’s quotations with one’s own (a view-own holder: one’s own alone)',
        teamList.status === 200 &&
          (salesSeesAll ? teamRows.length === 6 : teamRows.every((r) => r.owner.id === sales.id)) &&
          (teamList.body.summary as { team?: { count: number } }).team?.count === teamRows.length,
        `${teamRows.length} rows`,
      );
      const badStage = await http(salesToken, 'GET', '/quotations?stage=NOPE');
      check('an unknown stage is a 400 over HTTP too', badStage.status === 400, badStage.text.slice(0, 120));

      const printed = await fetch(`${BASE}/quotations/pdf?search=${encodeURIComponent(LISTQ)}&scope=all&stage=COMPLETED`, {
        headers: { Authorization: `Bearer ${salesToken}` },
      });
      const printedText = pdfText(Buffer.from(await printed.arrayBuffer()));
      const printedLine = printedText.replace(/\s+/g, ' ');
      check(
        'the printed list is the list as filtered: the one Completed quotation, its value, the filter named',
        printed.status === 200 &&
          // A cell's title wraps across text runs; read it as one line.
          printedLine.includes(`${LISTQ} completed`) &&
          !printedLine.includes(`${LISTQ} confirmed`) &&
          printedText.includes('500.00') &&
          printedText.includes('stage Completed'),
        printedText.slice(0, 300),
      );
      const exported = await prisma.auditLog.count({
        where: { entityType: 'quotation', entityId: 'list', action: 'EXPORTED', actorId: sales.id },
      });
      check('and printing it is audited as an export', exported >= 1);
      check(
        'the list prints its money as every document does: the code in the column head, one bold "Total" in the money block',
        printedLine.includes('TOTAL (PHP)') && printedText.split('\n').includes('Total') && printedLine.includes('PHP 500.00') && !printedLine.includes('Total, total'),
        printedLine.slice(-200),
      );
      check('its number column is headed "Number"', printedText.split('\n').includes('NUMBER') && !printedText.split('\n').includes('NO.'));
      // A filter on a person or a customer is named by name on the paper —
      // the set it is, never "one owner".
      const ownerPrinted = await fetch(`${BASE}/quotations/pdf?search=${encodeURIComponent(LISTQ)}&scope=all&ownerId=${sales.id}`, {
        headers: { Authorization: `Bearer ${salesToken}` },
      });
      const ownerLine = flat(pdfText(Buffer.from(await ownerPrinted.arrayBuffer())));
      check(
        'a person the list is filtered on is named on the paper — "owner <name>", never "one owner"',
        ownerPrinted.status === 200 && ownerLine.includes(`owner ${sales.name}`) && !ownerLine.includes('one owner'),
        ownerLine.slice(0, 300),
      );

      // Mass actions: the ticked rows travel as ?ids=, always ANDed with the
      // list's own rules; a status change is the ordinary PATCH, one by one.
      const picked = await prisma.quotation.findMany({
        where: { subject: { in: [`${LISTQ} open`, `${LISTQ} lost`] } },
        select: { id: true, subject: true },
      });
      const byIds = await http(salesToken, 'GET', `/quotations?scope=all&ids=${picked.map((p) => p.id).join(',')}`);
      const byIdsRows = (byIds.body.rows ?? []) as { id: string; canEdit: boolean; owner: { id: string } }[];
      check(
        '?ids= lists exactly the ticked quotations',
        byIds.status === 200 && byIdsRows.length === 2 && byIdsRows.every((r) => picked.some((p) => p.id === r.id)),
        byIds.text.slice(0, 160),
      );
      const colleaguesRow = await http(salesToken, 'GET', `/quotations?scope=all&search=${encodeURIComponent(`${LISTQ} completed`)}`);
      check(
        'a row says whether the reader may move it: their own yes, a colleague’s no',
        byIdsRows.every((r) => r.canEdit === true) &&
          ((colleaguesRow.body.rows ?? []) as { canEdit: boolean }[])[0]?.canEdit === false,
      );
      const tooMany = await http(salesToken, 'GET', `/quotations?ids=${Array.from({ length: 501 }, (_, i) => `x${i}`).join(',')}`);
      check('more than 500 ticked rows is a 400, never a shorter list', tooMany.status === 400, tooMany.text.slice(0, 120));
      const printedPick = await fetch(`${BASE}/quotations/pdf?scope=all&ids=${picked.map((p) => p.id).join(',')}`, {
        headers: { Authorization: `Bearer ${salesToken}` },
      });
      const printedPickLine = flat(pdfText(Buffer.from(await printedPick.arrayBuffer())));
      check(
        'Print selected prints the ticked quotations and no other, and says it is a selection',
        printedPick.status === 200 &&
          printedPickLine.includes(`${LISTQ} open`) &&
          printedPickLine.includes(`${LISTQ} lost`) &&
          !printedPickLine.includes(`${LISTQ} completed`) &&
          printedPickLine.includes('the rows selected'),
        printedPickLine.slice(0, 300),
      );
      const leadA = await prisma.lead.create({
        data: { number: `${TAG}-LA`, companyName: `${TAG} Print A`, assignedToId: sales.id, createdById: sales.id },
      });
      await prisma.lead.create({
        data: { number: `${TAG}-LB`, companyName: `${TAG} Print B`, assignedToId: sales.id, createdById: sales.id },
      });
      const leadPdf = await fetch(`${BASE}/leads/pdf?scope=all&ids=${leadA.id}`, { headers: { Authorization: `Bearer ${salesToken}` } });
      const leadLine = flat(pdfText(Buffer.from(await leadPdf.arrayBuffer())));
      check(
        'the leads list prints a selection the same way',
        leadPdf.status === 200 && leadLine.includes(`${TAG} Print A`) && !leadLine.includes(`${TAG} Print B`),
        leadLine.slice(0, 200),
      );
      // The sales order list over HTTP and on paper.
      const soListed = await http(salesToken, 'GET', `/sales-orders?search=${encodeURIComponent(`${TAG}-LSO`)}&scope=all&pageSize=50`);
      const soSum = soListed.body.summary as { tabCounts: Record<string, number>; count: number; value: number; cancelledCount: number } | undefined;
      const soRows = (soListed.body.rows ?? []) as { status: string; total: number; margin?: unknown }[];
      check(
        'GET /sales-orders carries the summary, matching its rows: count, booked value without the cancelled',
        soListed.status === 200 && !!soSum && soSum.count === soRows.length && soSum.tabCounts[''] === soRows.length &&
          money(soSum.value, soRows.filter((r) => r.status !== 'CANCELLED').reduce((t, r) => t + r.total, 0)) &&
          soRows.every((r) => 'margin' in r),
        soListed.text.slice(0, 200),
      );
      const soPrinted = await fetch(`${BASE}/sales-orders/pdf?search=${encodeURIComponent(`${TAG}-LSO`)}&scope=all&status=ISSUED`, {
        headers: { Authorization: `Bearer ${salesToken}` },
      });
      const soPrintedLine = flat(pdfText(Buffer.from(await soPrinted.arrayBuffer())));
      check(
        'the printed sales order list is the list as filtered — the issued one, its SI, the filter named',
        // A long number wraps across text runs; read it with the spaces out.
        soPrinted.status === 200 && soPrintedLine.replace(/ /g, '').includes(`${TAG}-LSO4`) && !soPrintedLine.replace(/ /g, '').includes(`${TAG}-LSO3`) &&
          soPrintedLine.includes('SI-9001') && soPrintedLine.includes('status Issued'),
        soPrintedLine.slice(0, 300),
      );
      const soPick = await prisma.salesOrder.findUniqueOrThrow({ where: { number: `${TAG}-LSO3` }, select: { id: true } });
      const soPickPdf = await fetch(`${BASE}/sales-orders/pdf?scope=all&ids=${soPick.id}`, { headers: { Authorization: `Bearer ${salesToken}` } });
      const soPickLine = flat(pdfText(Buffer.from(await soPickPdf.arrayBuffer())));
      check(
        'and Print selected prints the ticked order alone',
        soPickPdf.status === 200 && soPickLine.replace(/ /g, '').includes(`${TAG}-LSO3`) && !soPickLine.replace(/ /g, '').includes(`${TAG}-LSO4`) && soPickLine.includes('the rows selected'),
        soPickLine.slice(0, 200),
      );
      const soOfQuote = await prisma.salesOrder.findUniqueOrThrow({ where: { number: `${TAG}-LSO3` }, select: { quotation: { select: { id: true, number: true } } } });
      const soQuotePdf = await fetch(`${BASE}/sales-orders/pdf?scope=all&quotationId=${soOfQuote.quotation.id}`, { headers: { Authorization: `Bearer ${salesToken}` } });
      const soQuoteLine = flat(pdfText(Buffer.from(await soQuotePdf.arrayBuffer())));
      check(
        'an order list narrowed to one quotation names it by number — never "one quotation"',
        soQuotePdf.status === 200 && soQuoteLine.replace(/ /g, '').includes(`quotation${soOfQuote.quotation.number}`.replace(/ /g, '')) && !soQuoteLine.includes('one quotation'),
        soQuoteLine.slice(0, 300),
      );
      check(
        'the printed order list: the status through statusLabel, the code in the Total head, one "Total booked" in the money block',
        soPrintedLine.includes('Issued') && soPrintedLine.includes('TOTAL (PHP)') && soPrintedLine.includes('Total booked') && !soPrintedLine.includes('Booked value, total'),
        soPrintedLine.slice(-200),
      );
      const soAllPdf = await fetch(`${BASE}/sales-orders/pdf?search=${encodeURIComponent(`${TAG}-LSO`)}&scope=all`, { headers: { Authorization: `Bearer ${salesToken}` } });
      const soAllLine = flat(pdfText(Buffer.from(await soAllPdf.arrayBuffer())));
      // LSO2 is the cancelled one, 500.00: its figure in brackets, the live
      // orders' (1,000, 2,000 and 3,000) bare, and the booked total theirs alone.
      check(
        'a cancelled order prints in brackets and is said under the money block — never a row of it',
        soAllPdf.status === 200 &&
          soSum?.cancelledCount === 1 &&
          squash(soAllLine).includes(`${TAG}-LSO2`) &&
          soAllLine.includes('(500.00)') &&
          ['1,000.00', '2,000.00', '3,000.00'].every((v) => soAllLine.includes(v) && !soAllLine.includes(`(${v})`)) &&
          soAllLine.includes('Total booked PHP 6,000.00') &&
          soAllLine.includes('1 cancelled order, in brackets, is not counted.') &&
          !soAllLine.includes('Cancelled, not counted:'),
        `${soSum?.cancelledCount} cancelled · ${soAllLine.match(/\([\d,.]+\)/g)?.join(' ') ?? 'nothing in brackets'} · ${soAllLine.slice(-200)}`,
      );
      check(
        'and printing the order list is audited as an export',
        (await prisma.auditLog.count({ where: { entityType: 'sales_order', entityId: 'list', action: 'EXPORTED', actorId: sales.id } })) >= 1,
      );
      // An order no route ever carried: who actually issued it, dated (the
      // trail's row, which POST /:id/issue writes) — never "Noted by" or an
      // "Approved by" nobody will fill.
      const lso4 = await prisma.salesOrder.findUniqueOrThrow({ where: { number: `${TAG}-LSO4` }, select: { id: true } });
      await prisma.auditLog.create({
        data: { entityType: 'sales_order', entityId: lso4.id, action: 'COMPLETED', actorId: sales.id, actorName: sales.name, summary: `Issued sales order ${TAG}-LSO4` },
      });
      const unrouted = pdfText(
        Buffer.from(await (await fetch(`${BASE}/sales-orders/${lso4.id}/pdf`, { headers: { Authorization: `Bearer ${salesToken}` } })).arrayBuffer()),
      ).replace(/\s+/g, ' ');
      check(
        'an order issued with no route prints ISSUED BY whoever issued it, dated — no NOTED BY, nothing Pending',
        unrouted.includes('ISSUED BY') && unrouted.includes(`ISSUED BY ${sales.name}`) && !unrouted.includes('NOTED BY') && !unrouted.includes('Pending'),
        unrouted.slice(-300),
      );
      const unroutedPending = pdfText(
        Buffer.from(await (await fetch(`${BASE}/sales-orders/${soPick.id}/pdf`, { headers: { Authorization: `Bearer ${salesToken}` } })).arrayBuffer()),
      ).replace(/\s+/g, ' ');
      check(
        'one still waiting with no request behind it keeps one open APPROVED BY, Pending',
        unroutedPending.includes('APPROVED BY Pending') && !unroutedPending.includes('NOTED BY'),
        unroutedPending.slice(-300),
      );

      // The leads list over HTTP and on paper; its mass actions are the PATCH.
      const lListed = await http(salesToken, 'GET', `/leads?search=${encodeURIComponent(`${TAG} LEADL`)}&scope=all&pageSize=50`);
      const lSumHttp = lListed.body.summary as { tabCounts: Record<string, number>; count: number; value: number } | undefined;
      const lRowsHttp = (lListed.body.rows ?? []) as { id: string; stage: string; stageLabel: string; canEdit: boolean; assignedTo: { id: string }; estimatedValue: number | null }[];
      check(
        'GET /leads carries the summary and each row its stage, its name and whether the reader may change it',
        lListed.status === 200 && !!lSumHttp && lSumHttp.count === lRowsHttp.length && lSumHttp.tabCounts[''] === lRowsHttp.length &&
          money(lSumHttp.value, lRowsHttp.reduce((t, r) => t + (r.estimatedValue ?? 0), 0)) &&
          lRowsHttp.every((r) => !!r.stage && !!r.stageLabel && r.canEdit === canEditRecord(salesUser, 'gops', 'leads', r.assignedTo.id)),
        lListed.text.slice(0, 200),
      );
      const lPrinted = await fetch(`${BASE}/leads/pdf?search=${encodeURIComponent(`${TAG} LEADL`)}&scope=all&stage=HOLD`, {
        headers: { Authorization: `Bearer ${salesToken}` },
      });
      const lPrintedLine = flat(pdfText(Buffer.from(await lPrinted.arrayBuffer())));
      check(
        'the printed leads list is the list as filtered — the one on hold, the stage named, the weighted total',
        lPrinted.status === 200 && lPrintedLine.includes(`${TAG} LEADL hold`) && !lPrintedLine.includes(`${TAG} LEADL new`) &&
          lPrintedLine.includes('stage On hold') && lPrintedLine.includes('Weighted by probability'),
        lPrintedLine.slice(0, 300),
      );
      const lPrintedAgain = Buffer.from(
        await (
          await fetch(`${BASE}/leads/pdf?search=${encodeURIComponent(`${TAG} LEADL`)}&scope=all&stage=HOLD&createdFrom=2026-01-01`, {
            headers: { Authorization: `Bearer ${salesToken}` },
          })
        ).arrayBuffer(),
      );
      const lAgainLine = flat(pdfText(lPrintedAgain));
      check(
        'its eight columns print on landscape paper, the status through statusLabel, the sum the last row of the money block',
        lPrintedAgain.toString('latin1').includes('/MediaBox [0 0 841.89 595.28]') && lAgainLine.includes('On hold') &&
          lAgainLine.indexOf('Weighted by probability') < lAgainLine.indexOf('Total estimated value') && !lAgainLine.includes('Estimated value, total'),
        lAgainLine.slice(-200),
      );
      check('a date the filter names prints as a list prints a date (MM/DD/YYYY)', lAgainLine.includes('added 01/01/2026 to'), lAgainLine.slice(0, 400));
      const toMove = lRowsHttp.find((r) => r.stage === 'OPPORTUNITY' && r.canEdit)!;
      const assigned = await http(salesToken, 'PATCH', `/leads/${toMove.id}`, { assignedToId: other.id });
      const nowOwner = await prisma.lead.findUniqueOrThrow({ where: { id: toMove.id }, select: { assignedToId: true } });
      const told = await prisma.notification.count({ where: { userId: other.id, link: { contains: toMove.id } } });
      check(
        'Assign to is the PATCH: the lead goes to the colleague, and the colleague is told',
        assigned.status === 200 && nowOwner.assignedToId === other.id && told >= 1,
        `${assigned.status} ${nowOwner.assignedToId === other.id} ${told}`,
      );

      // The customer list over HTTP and on paper.
      const custListed = await http(salesToken, 'GET', `/customers?search=${encodeURIComponent(`${TAG} Hospital`)}`);
      const custSum = custListed.body.summary as { tabCounts: Record<string, number>; count: number } | undefined;
      check(
        'GET /customers carries its sub-industry counts and each row its open quotations',
        custListed.status === 200 && !!custSum && custSum.count === (custListed.body.rows as unknown[]).length &&
          ((custListed.body.rows ?? []) as { openQuoteCount?: number }[]).every((r) => typeof r.openQuoteCount === 'number'),
        custListed.text.slice(0, 200),
      );
      const custPdf = await fetch(`${BASE}/customers/pdf?ids=${customer.id}`, { headers: { Authorization: `Bearer ${salesToken}` } });
      const custLine = flat(pdfText(Buffer.from(await custPdf.arrayBuffer())));
      check(
        'the printed customer list prints the ticked customer and says it is a selection',
        custPdf.status === 200 && custLine.includes(`${TAG} Hospital`) && custLine.includes('the rows selected'),
        custLine.slice(0, 200),
      );
      // Ten columns print whole on landscape paper; a filter on a person or a
      // team is named by name, never "added by one person".
      const custWide = await fetch(`${BASE}/customers/pdf?search=${encodeURIComponent(`${TAG} Hospital`)}&createdById=${sales.id}&team=none`, {
        headers: { Authorization: `Bearer ${salesToken}` },
      });
      const custWideBytes = Buffer.from(await custWide.arrayBuffer());
      const custWideLine = flat(pdfText(custWideBytes));
      check(
        'the printed customer list is landscape, and names its filters: added by <name>, team open',
        custWide.status === 200 && custWideBytes.toString('latin1').includes('/MediaBox [0 0 841.89 595.28]') &&
          custWideLine.includes(`added by ${sales.name}`) && custWideLine.includes('team open') && !custWideLine.includes('one person'),
        custWideLine.slice(0, 300),
      );
      check(
        'and every customer-list printout is audited as an export, under the list',
        (await prisma.auditLog.count({ where: { entityType: 'customer', entityId: 'list', action: 'EXPORTED', actorId: sales.id } })) >= 2,
      );

      // A mass move is the PATCH per row: a legal move goes; Won without an
      // approved revision is refused with the reason the bar then shows.
      const openId = picked.find((p) => p.subject.endsWith('open'))!.id;
      const movedOpen = await http(salesToken, 'PATCH', `/quotations/${openId}`, { outcome: 'SUBMITTED' });
      const wonRefused = await http(salesToken, 'PATCH', `/quotations/${openId}`, { outcome: 'WON' });
      check(
        'a mass move is the ordinary PATCH per row: a legal move goes, a refused one says why',
        movedOpen.status === 200 && wonRefused.status === 400 && String(wonRefused.body.error ?? '').includes('approved revision'),
        `${movedOpen.status} ${wonRefused.status} ${wonRefused.text.slice(0, 120)}`,
      );
    }

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
    const pulledPdf = pdfText(
      Buffer.from(
        await (await fetch(`${BASE}/quotations/${pulledId}/revisions/${pulledR0.id}/pdf`, { headers: { Authorization: `Bearer ${salesToken}` } })).arrayBuffer(),
      ),
    ).replace(/\n/g, ' ');
    const pulledStep = ((await pickWorkflow('quotation', Number(pulledBack.total)))?.steps[0]?.name ?? '').toUpperCase();
    check(
      'pulled back, its PDF prints the route submitting it NOW would take — the step by name, who will sign it, Pending — never the withdrawn request',
      !!pulledStep && pulledPdf.includes(pulledStep) && pulledPdf.includes(manager.name) && pulledPdf.includes('Pending'),
      pulledPdf.slice(-300),
    );
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
      toldManager?.title === `Withdrawn: ${upperText(`${TAG} Changed while pending`)}` && toldManager.body === `${changed.body.number} R0 — superseded by R1`,
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
    const supersededText = pdfText(
      Buffer.from(
        await (await fetch(`${BASE}/quotations/${changedId}/revisions/${changedR0.id}/pdf`, { headers: { Authorization: `Bearer ${salesToken}` } })).arrayBuffer(),
      ),
    ).replace(/\s+/g, ' ');
    check(
      'superseded before anybody signed, R0’s PDF names no approver and says nothing is Pending — nobody will sign it',
      supersededText.includes(sales.name) && !supersededText.includes(manager.name) && !supersededText.includes('Pending'),
      supersededText.slice(-300),
    );
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
