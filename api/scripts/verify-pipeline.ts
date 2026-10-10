/**
 * Sales board verification — the HTTP half.
 *
 *   npx tsx scripts/verify-pipeline.ts      (the API must be running)
 *
 * The board's arithmetic and move rules are pure functions in
 * src/shared/pipeline.ts and are proved in verify-sales.ts without a server.
 * What only HTTP can prove lives here:
 *
 *   · The board reconciles with Sales Analytics to the centavo. Two screens
 *     disagreeing about the pipeline is the bug Phase 9 warns about.
 *   · The move rules are on the ROUTES, not only in the board — a draft-only
 *     quotation cannot be PATCHed to WON from anywhere.
 *   · A lead with a quotation is one card, not two.
 *   · The CSV twin is audited before the bytes go out, and both reads are
 *     guarded by gops.pipeline.*.
 *   · The lead → quotation hand-off takes the lead's customer, and the number
 *     preview is the number the author's next quotation will actually get.
 *
 * Fixtures are tagged ZZPIPE and removed at the start and the end.
 */

import bcrypt from 'bcryptjs';
import zlib from 'node:zlib';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/prisma';
import { env } from '../src/env';
import { signToken } from '../src/auth/middleware';
import { nextNumber, previewNext } from '../src/shared/numbering';
import { probabilityAfterMove, stageProbability } from '../src/shared/pipeline';

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

const TAG = 'ZZPIPE';
const BASE = `http://localhost:${env.port}/api`;
const D = (v: number) => new Prisma.Decimal(v);
const cents = (a: number, b: number) => Math.abs(a - b) < 0.005;

// ── Fixtures ─────────────────────────────────────────────────────────────────

async function cleanup() {
  await prisma.salesActivity.deleteMany({
    where: {
      OR: [
        { subject: { startsWith: TAG } },
        { lead: { companyName: { startsWith: TAG } } },
        { quotation: { subject: { startsWith: TAG } } },
      ],
    },
  });
  await prisma.salesOrder.deleteMany({ where: { quotation: { subject: { startsWith: TAG } } } });
  await prisma.quotation.deleteMany({ where: { subject: { startsWith: TAG } } });
  await putStagesBack();
  await prisma.costing.deleteMany({ where: { title: { startsWith: TAG } } });
  await prisma.lead.deleteMany({ where: { companyName: { startsWith: TAG } } });
  await prisma.customer.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.employee.deleteMany({ where: { employeeNo: { startsWith: TAG } } });
  await prisma.numberSequence.deleteMany({ where: { documentType: { startsWith: TAG } } });

  const users = await prisma.user.findMany({
    where: { email: { endsWith: '@verifyp.local' } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await prisma.approvalAction.deleteMany({ where: { approverId: { in: ids } } });
    await prisma.approvalRequest.deleteMany({ where: { requesterId: { in: ids } } });
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
    await prisma.savedFilter.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.role.deleteMany({ where: { key: { startsWith: 'zzpipe_' } } });
}

/** A role holding exactly the permissions named (the verify-hr.ts pattern). */
async function makeRole(key: string, name: string, permissionKeys: string[]) {
  const permissions = await prisma.permission.findMany({
    where: { key: { in: permissionKeys } },
    select: { id: true, key: true },
  });
  if (permissions.length !== permissionKeys.length) {
    const found = new Set(permissions.map((p) => p.key));
    throw new Error(`Unknown permission(s): ${permissionKeys.filter((k) => !found.has(k)).join(', ')}`);
  }
  return prisma.role.create({
    data: { key, name, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } },
  });
}

async function makeUser(name: string, email: string, roleIds: string[]) {
  return prisma.user.create({
    data: {
      name,
      email,
      passwordHash: await bcrypt.hash('x', 10),
      roles: { create: roleIds.map((roleId) => ({ roleId })) },
    },
  });
}

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
  text: string;
  contentType: string;
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
  return { status: res.status, body: parsed, text, contentType: res.headers.get('content-type') ?? '' };
}

async function apiReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

const errorOf = (r: HttpResult) => String(r.body.error ?? r.text).toLowerCase();

interface BoardCard {
  ref: string;
  kind: string;
  id: string;
  column: string;
  stage: string;
  canMove: boolean;
  allowedTargets: string[];
}
interface BoardBody {
  kpis: { openQuotes: number; quotedValue: number; weightedValue: number };
  window: { decidedWithinDays: number };
  stages: { key: string; label: string; probability: number | null; inActiveList: boolean; color: string }[];
  columns: { key: string; count: number; value: number; cards: BoardCard[] }[];
}

/*
  An administrator's stage settings (Admin › Pipeline Stages) are set aside
  for the run and put back by cleanup(), which also runs first.
*/
const STAGES_KEY = 'pipeline.stages';
const STAGES_STASH = `${STAGES_KEY}.__verify__`;

async function setStagesAside() {
  const row = await prisma.setting.findUnique({ where: { key: STAGES_KEY } });
  if (!row) return;
  await prisma.$transaction([
    prisma.setting.upsert({
      where: { key: STAGES_STASH },
      create: { key: STAGES_STASH, value: row.value as Prisma.InputJsonValue, description: row.description },
      update: { value: row.value as Prisma.InputJsonValue, description: row.description },
    }),
    prisma.setting.delete({ where: { key: STAGES_KEY } }),
  ]);
}

async function putStagesBack() {
  const stash = await prisma.setting.findUnique({ where: { key: STAGES_STASH } });
  if (!stash) {
    return;
  }
  await prisma.$transaction([
    prisma.setting.upsert({
      where: { key: STAGES_KEY },
      create: { key: STAGES_KEY, value: stash.value as Prisma.InputJsonValue, description: stash.description },
      update: { value: stash.value as Prisma.InputJsonValue, description: stash.description },
    }),
    prisma.setting.delete({ where: { key: STAGES_STASH } }),
  ]);
}

// ── The run ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nG-CORE sales board verification\n');
  await cleanup();

  if (!(await apiReachable())) {
    failed += 1;
    console.log(
      `  ✗ the API is not reachable at ${BASE} — the board was NOT verified.\n` +
        '      Start it with "npm run dev" in api/ and run this script again.',
    );
    await cleanup();
    return;
  }

  const boardRole = await makeRole('zzpipe_board', 'Verify board manager', [
    'gops.pipeline.view_all',
    'gops.pipeline.export',
    'gops.forecast.view_all',
    'gops.forecast.export',
    'gops.leads.view_all',
    'gops.leads.edit_all',
    'gops.leads.edit_own',
    'gops.quotations.view_all',
    'gops.quotations.edit_all',
    'gops.quotations.edit_own',
    'gops.quotations.create',
    'gops.calendar.view_all',
    'insights.pipeline.view_all',
    'gops.sales_orders.create',
    'gops.sales_orders.view_own',
  ]);
  const stageAdminRole = await makeRole('zzpipe_admin', 'Verify stage administrator', ['admin.pipeline_stages.view_all', 'admin.pipeline_stages.edit_all']);
  await setStagesAside();
  const plainRole = await makeRole('zzpipe_plain', 'Verify salesperson without the board', [
    'gops.quotations.view_own',
    'gops.quotations.edit_own',
    'gops.quotations.create',
  ]);
  const manager = await makeUser('Verify Board Manager', 'board@verifyp.local', [boardRole.id]);
  const stageAdmin = await makeUser('Verify Stage Admin', 'stages@verifyp.local', [stageAdminRole.id]);
  const stageAdminToken = signToken(stageAdmin.id, stageAdmin.email);
  const seller = await makeUser('Verify Plain Seller', 'plain@verifyp.local', [plainRole.id]);
  await prisma.employee.create({
    data: { employeeNo: `${TAG}-EMP-2026-0007`, firstName: 'Verify', lastName: `${TAG} Manager`, userId: manager.id },
  });
  const managerToken = signToken(manager.id, manager.email);
  const sellerToken = signToken(seller.id, seller.email);

  const customer = await prisma.customer.create({
    data: { code: `${TAG}-C1`, name: `${TAG} Medical Centre`, createdById: manager.id },
  });
  const site = await prisma.customerSite.create({
    data: { customerId: customer.id, name: `${TAG} Main campus` },
  });

  const newQuotation = async (
    subject: string,
    outcome: 'OPEN' | 'SUBMITTED' | 'NEGOTIATION',
    revisions: { revision: number; status: 'DRAFT' | 'APPROVED'; total: number }[],
    extra: { ownerId?: string; leadId?: string; probability?: number } = {},
  ) =>
    prisma.quotation.create({
      data: {
        number: await nextNumber('quotation', prisma, { ownerId: extra.ownerId ?? manager.id }),
        customerId: customer.id,
        leadId: extra.leadId ?? null,
        ownerId: extra.ownerId ?? manager.id,
        subject: `${TAG} ${subject}`,
        outcome,
        probability: extra.probability ?? 40,
        revisions: {
          create: revisions.map((r) => ({
            revision: r.revision,
            status: r.status,
            vatRate: D(0.12),
            subtotal: D(r.total),
            total: D(r.total),
          })),
        },
      },
    });

  // A lead at NEGOTIATION whose quotation is at NEGOTIATION — ONE card.
  const quotedLead = await prisma.lead.create({
    data: {
      number: await nextNumber('lead'),
      companyName: `${TAG} Medical Centre`,
      customerId: customer.id,
      siteId: site.id,
      status: 'NEGOTIATION',
      assignedToId: manager.id,
      createdById: manager.id,
      estimatedValue: D(9_999_999),
      probability: 70,
      expectedClosing: new Date('2026-12-15'),
    },
  });
  const negotiating = await newQuotation(
    'Negotiated plant',
    'NEGOTIATION',
    [
      { revision: 0, status: 'APPROVED', total: 1_344_000.37 },
      { revision: 1, status: 'DRAFT', total: 1_500_000 },
    ],
    { leadId: quotedLead.id, probability: 33 },
  );
  const draftOnly = await newQuotation('Draft only', 'SUBMITTED', [{ revision: 0, status: 'DRAFT', total: 250_000.11 }], {
    probability: 17,
  });
  const sellersOwn = await newQuotation('Seller owned', 'OPEN', [{ revision: 0, status: 'DRAFT', total: 77_777.77 }], {
    ownerId: seller.id,
  });

  // A lead with no quotation, and one with no customer on file.
  const bareLead = await prisma.lead.create({
    data: {
      number: await nextNumber('lead'),
      companyName: `${TAG} Bare Lead`,
      customerId: customer.id,
      siteId: site.id,
      status: 'QUALIFIED',
      assignedToId: manager.id,
      createdById: manager.id,
      estimatedValue: D(400_000),
      probability: 20,
      expectedClosing: new Date('2026-11-20'),
      description: 'Two PSA oxygen generators\nwith manifold',
    },
  });
  const unlinkedLead = await prisma.lead.create({
    data: {
      number: await nextNumber('lead'),
      companyName: `${TAG} Not On File`,
      status: 'NEW',
      assignedToId: manager.id,
      createdById: manager.id,
    },
  });

  // ── 1. The board reconciles with Sales Analytics ────────────────────────
  console.log('The board and Sales Analytics agree');

  /*
    Other verify scripts may be creating quotations at the same moment, so the
    two reads are taken together and retried a couple of times before a
    difference is called a failure.
  */
  let board: HttpResult | null = null;
  let insights: HttpResult | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    [board, insights] = await Promise.all([
      http(managerToken, 'GET', '/pipeline'),
      http(managerToken, 'GET', '/insights/pipeline'),
    ]);
    const k = (board.body as unknown as BoardBody).kpis;
    const t = insights.body.totals as { openQuotations: number; openValue: number; weightedValue: number } | undefined;
    if (k && t && k.openQuotes === t.openQuotations && cents(k.quotedValue, t.openValue) && cents(k.weightedValue, t.weightedValue)) break;
  }
  check('GET /pipeline answers the board manager', board!.status === 200, `${board!.status} ${board!.text.slice(0, 120)}`);
  check('GET /insights/pipeline answers too', insights!.status === 200, `${insights!.status}`);
  const kpis = (board!.body as unknown as BoardBody).kpis;
  const totals = insights!.body.totals as { openQuotations: number; openValue: number; weightedValue: number };
  check(
    'open quotes on the board = open quotations in Sales Analytics',
    kpis.openQuotes === totals.openQuotations,
    `${kpis.openQuotes} vs ${totals.openQuotations}`,
  );
  check(
    'quoted value on the board = open value in Sales Analytics, to the centavo',
    cents(kpis.quotedValue, totals.openValue),
    `${kpis.quotedValue} vs ${totals.openValue}`,
  );
  check(
    'weighted value on the board = weighted value in Sales Analytics, to the centavo',
    cents(kpis.weightedValue, totals.weightedValue),
    `${kpis.weightedValue} vs ${totals.weightedValue}`,
  );

  // ── 2. One card per deal ─────────────────────────────────────────────────
  console.log('\nWhat is a card');
  const searched = await http(managerToken, 'GET', `/pipeline?search=${encodeURIComponent(TAG)}`);
  const sb = searched.body as unknown as BoardBody;
  const cards = sb.columns.flatMap((c) => c.cards);
  check(
    'a lead with a quotation is not a card',
    !cards.some((c) => c.ref === `lead:${quotedLead.id}`),
  );
  const negCard = cards.find((c) => c.ref === `quotation:${negotiating.id}`);
  check('its quotation is, in Negotiation', negCard?.column === 'NEGOTIATION', negCard?.column);
  const negColumn = sb.columns.find((c) => c.key === 'NEGOTIATION')!;
  check(
    "the column is valued at the APPROVED revision, not the lead's estimate or the later draft",
    cents(negColumn.value, 1_344_000.37),
    String(negColumn.value),
  );
  const bareCard = cards.find((c) => c.ref === `lead:${bareLead.id}`);
  check('a lead with no quotation is a card in its own stage', bareCard?.column === 'QUALIFIED', bareCard?.column);
  check(
    'the manager may move it, and never onto a quotation stage',
    !!bareCard?.canMove && !bareCard.allowedTargets.includes('WON') && !bareCard.allowedTargets.includes('NEGOTIATION'),
    JSON.stringify(bareCard?.allowedTargets),
  );
  const draftCard = cards.find((c) => c.ref === `quotation:${draftOnly.id}`);
  check(
    'a draft-only quotation is not offered WON',
    !!draftCard && !draftCard.allowedTargets.includes('WON'),
    JSON.stringify(draftCard?.allowedTargets),
  );
  const clamped = await http(managerToken, 'GET', '/pipeline?decidedWithinDays=5000');
  check(
    'the Won/Lost window is clamped to two years',
    (clamped.body as unknown as BoardBody).window?.decidedWithinDays === 730,
    JSON.stringify(clamped.body.window),
  );

  // ── 3. The CSV twin and the guards ───────────────────────────────────────
  console.log('\nExport and guards');
  const since = new Date();
  const csv = await http(managerToken, 'GET', `/pipeline/board.csv?search=${encodeURIComponent(TAG)}`);
  check('the CSV twin answers 200 text/csv', csv.status === 200 && csv.contentType.startsWith('text/csv'), `${csv.status} ${csv.contentType}`);
  check('it carries the header row and the tagged cards', csv.text.startsWith('Column,Kind,Number') && csv.text.includes(negotiating.number));
  const exported = await prisma.auditLog.findFirst({
    where: { entityType: 'pipeline', action: 'EXPORTED', actorId: manager.id, at: { gte: since } },
  });
  check('the export left an audit row', !!exported);

  const denied = await http(sellerToken, 'GET', '/pipeline');
  check('GET /pipeline without gops.pipeline.view_all is 403', denied.status === 403, `${denied.status}`);
  const deniedCsv = await http(sellerToken, 'GET', '/pipeline/board.csv');
  check('and the CSV without gops.pipeline.export is 403', deniedCsv.status === 403, `${deniedCsv.status}`);

  // ── 3b. The Forecast reconciles with the quotation list ──────────────────
  console.log('\nThe Forecast');
  await prisma.quotation.update({ where: { id: negotiating.id }, data: { expectedClosing: new Date('2026-12-15T00:00:00Z') } });
  await prisma.quotation.update({ where: { id: draftOnly.id }, data: { expectedClosing: new Date('2026-11-03T00:00:00Z') } });
  // The manager's own deals only, so other people's quotations on this
  // database never enter the arithmetic. bareLead closes 2026-11-20 at 400,000 × 20%.
  const fcQuery = `period=month&from=2026-11-01&to=2026-12-31&scope=all&ownerId=${manager.id}`;
  const fc = await http(managerToken, 'GET', `/pipeline/forecast?${fcQuery}`);
  interface FcBucket { key: string; count: number; value: number; weighted: number; overdue: number; rows: { number: string; kind: string }[] }
  interface FcBody { buckets: FcBucket[]; inWindow: { count: number; value: number; weighted: number }; totals: { count: number }; undated: { count: number }; people: { id: string }[] }
  const fcBody = fc.body as unknown as FcBody;
  check('GET /pipeline/forecast answers the board manager', fc.status === 200, `${fc.status} ${fc.text.slice(0, 120)}`);
  check('November and December are its two buckets', fcBody.buckets?.map((b) => b.key).join() === '2026-11,2026-12', fcBody.buckets?.map((b) => b.key).join());
  const nov = fcBody.buckets?.find((b) => b.key === '2026-11');
  const dec = fcBody.buckets?.find((b) => b.key === '2026-12');
  check(
    'the draft-only quotation closes in November at its draft total × 17%',
    nov?.count === 1 && nov.rows[0].number === draftOnly.number && cents(nov.value, 250_000.11) && cents(nov.weighted, 42_500.02),
    JSON.stringify(nov),
  );
  check(
    'the negotiated plant closes in December at its APPROVED revision × 33%',
    dec?.count === 1 && cents(dec.value, 1_344_000.37) && cents(dec.weighted, 443_520.12),
    JSON.stringify(dec),
  );
  // Reconciliation: a bucket's value is what the quotation list says for the
  // same closing dates — the three open outcomes, summed.
  let listCount = 0;
  let listCents = 0;
  for (const outcome of ['OPEN', 'SUBMITTED', 'NEGOTIATION']) {
    const l = await http(managerToken, 'GET', `/quotations?closingFrom=2026-11-01&closingTo=2026-11-30&scope=all&ownerId=${manager.id}&outcome=${outcome}`);
    const s = l.body.summary as { count: number; value: number };
    listCount += s.count;
    listCents += Math.round(s.value * 100);
  }
  check('November reconciles with the quotation list filtered to the same closing dates', nov?.count === listCount && Math.round((nov?.value ?? 0) * 100) === listCents, `${nov?.count}/${nov?.value} vs ${listCount}/${listCents / 100}`);
  const fcLeads = await http(managerToken, 'GET', `/pipeline/forecast?${fcQuery}&leads=true`);
  const novLeads = (fcLeads.body as unknown as FcBody).buckets.find((b) => b.key === '2026-11');
  check(
    'with leads included, the bare lead joins November at its estimate × 20%',
    novLeads?.count === 2 && novLeads.rows.some((r) => r.kind === 'lead' && r.number === bareLead.number) && cents(novLeads.value, 650_000.11) && cents(novLeads.weighted, 122_500.02),
    JSON.stringify(novLeads),
  );
  const fcCsv = await http(managerToken, 'GET', `/pipeline/forecast.csv?${fcQuery}`);
  check('the CSV twin answers text/csv with a Period column first', fcCsv.status === 200 && fcCsv.contentType.startsWith('text/csv') && fcCsv.text.includes('Period,Kind,Number') && fcCsv.text.includes(draftOnly.number), `${fcCsv.status}`);
  const fcExported = await prisma.auditLog.findFirst({ where: { entityType: 'pipeline', entityId: 'forecast', action: 'EXPORTED', actorId: manager.id, at: { gte: since } } });
  check('and is audited before the bytes go out', !!fcExported);
  const fcPdf = await http(managerToken, 'GET', `/pipeline/forecast.pdf?${fcQuery}`);
  check('the Forecast prints', fcPdf.status === 200 && fcPdf.contentType.startsWith('application/pdf'), `${fcPdf.status} ${fcPdf.contentType}`);
  const fcBad = await http(managerToken, 'GET', '/pipeline/forecast?period=daily');
  check('an unknown period is a 400', fcBad.status === 400 && errorOf(fcBad).includes('week, month, quarter or year'), `${fcBad.status}`);
  const fcBadDay = await http(managerToken, 'GET', '/pipeline/forecast?period=month&from=2026-13-01');
  check('a malformed date is a 400', fcBadDay.status === 400, `${fcBadDay.status}`);
  const fcDenied = await http(sellerToken, 'GET', '/pipeline/forecast');
  check('GET /pipeline/forecast without gops.forecast.view_all is 403', fcDenied.status === 403, `${fcDenied.status}`);

  // ── 4. The move rules are on the routes ──────────────────────────────────
  console.log('\nMove rules, over HTTP');
  const wonDraft = await http(managerToken, 'PATCH', `/quotations/${draftOnly.id}`, { outcome: 'WON' });
  check(
    'PATCH WON on a draft-only quotation is 400 and says why',
    wonDraft.status === 400 && errorOf(wonDraft).includes('approved revision'),
    `${wonDraft.status} ${errorOf(wonDraft)}`,
  );
  const lostBare = await http(managerToken, 'PATCH', `/quotations/${draftOnly.id}`, { outcome: 'LOST' });
  check(
    'PATCH LOST with no reason is 400',
    lostBare.status === 400 && errorOf(lostBare).includes('why it was lost'),
    `${lostBare.status} ${errorOf(lostBare)}`,
  );
  const wonLead = await http(managerToken, 'PATCH', `/leads/${bareLead.id}`, { status: 'WON' });
  check(
    'a lead with no quotation cannot be PATCHed to WON',
    wonLead.status === 400 && errorOf(wonLead).includes('won by its quotation'),
    `${wonLead.status} ${errorOf(wonLead)}`,
  );
  const lostLead = await http(managerToken, 'PATCH', `/leads/${bareLead.id}`, { status: 'LOST' });
  check('nor LOST without a reason', lostLead.status === 400, `${lostLead.status}`);

  const lostQuote = await http(managerToken, 'PATCH', `/quotations/${negotiating.id}`, {
    outcome: 'LOST',
    lostReason: `${TAG} price`,
  });
  check('LOST with a reason is accepted', lostQuote.status === 200, `${lostQuote.status} ${errorOf(lostQuote)}`);
  const leadAfter = await prisma.lead.findUnique({ where: { id: quotedLead.id } });
  check(
    'and the lead follows, carrying the reason',
    leadAfter?.status === 'LOST' && leadAfter.lostReason === `${TAG} price`,
    `${leadAfter?.status} / ${leadAfter?.lostReason}`,
  );
  const reopened = await http(managerToken, 'PATCH', `/quotations/${negotiating.id}`, { outcome: 'NEGOTIATION' });
  check('a lost quotation can be reopened', reopened.status === 200, `${reopened.status}`);
  const won = await http(managerToken, 'PATCH', `/quotations/${negotiating.id}`, { outcome: 'WON' });
  check('a quotation with an approved revision can be won', won.status === 200, `${won.status} ${errorOf(won)}`);

  // A manager moving somebody else's card tells them.
  const moved = await http(managerToken, 'PATCH', `/quotations/${sellersOwn.id}`, { outcome: 'SUBMITTED' });
  check("the manager may move a salesperson's quotation", moved.status === 200, `${moved.status}`);
  const told = await prisma.notification.findFirst({
    where: { userId: seller.id, title: { contains: 'moved to Negotiation (submitted)' } },
  });
  check('and the salesperson is told who moved it, by the stage the board shows, with the step after it', !!told && told.title.includes(manager.name), told?.title);
  const notMine = await http(sellerToken, 'PATCH', `/quotations/${draftOnly.id}`, { outcome: 'NEGOTIATION' });
  check("a salesperson cannot move someone else's quotation", notMine.status === 403, `${notMine.status}`);

  // ── 4b. The board, the list and the quotation page say the same word ─────
  // (2026-10-08, the owner's call: "if dragged to another column, the
  // quotation also changes the status" — it always did, but the page printed
  // the fine step, Submitted, where the board printed its stage, Negotiation.)
  console.log('\nThe stage, on every screen');
  const pageAfterMove = await http(managerToken, 'GET', `/quotations/${sellersOwn.id}`);
  const pageBody = pageAfterMove.body as unknown as {
    outcome: string;
    stage: string;
    stageLabel: string;
    quotationStages: { key: string; label: string; outcomes: string[] }[];
  };
  check(
    'moved to Submitted on the board, the quotation page says Negotiation — the stage, as the board does',
    pageBody.outcome === 'SUBMITTED' && pageBody.stage === 'NEGOTIATION' && pageBody.stageLabel === 'Negotiation',
    JSON.stringify({ outcome: pageBody.outcome, stage: pageBody.stage, label: pageBody.stageLabel }),
  );
  const stagesSeen = pageBody.quotationStages?.map((s) => `${s.key}:${s.outcomes.join('+')}`).join();
  check(
    'and it names every stage a quotation can stand in, with the outcome each gathers',
    stagesSeen === 'OPPORTUNITY:OPEN,NEGOTIATION:SUBMITTED,CLOSING:NEGOTIATION,CONFIRMED:WON,COMPLETED:,LOST:LOST',
    stagesSeen,
  );
  // A drop on Closing is a PATCH to NEGOTIATION — the board's own move.
  const dropped = await http(managerToken, 'PATCH', `/quotations/${sellersOwn.id}`, { outcome: 'NEGOTIATION' });
  const boardNow = await http(managerToken, 'GET', `/pipeline?search=${encodeURIComponent(TAG)}`);
  const cardNow = (boardNow.body as unknown as BoardBody).columns.flatMap((c) => c.cards).find((c) => c.ref === `quotation:${sellersOwn.id}`);
  const listNow = await http(managerToken, 'GET', `/quotations?search=${encodeURIComponent(`${TAG} Seller owned`)}&scope=all`);
  const rowNow = ((listNow.body.rows ?? []) as { id: string; stage: string }[]).find((r) => r.id === sellersOwn.id);
  const pageNow = (await http(managerToken, 'GET', `/quotations/${sellersOwn.id}`)).body as unknown as { stage: string; outcome: string };
  check(
    'dropped on Closing: the board card, the list row and the quotation page all say CLOSING',
    dropped.status === 200 && cardNow?.stage === 'CLOSING' && rowNow?.stage === 'CLOSING' && pageNow.stage === 'CLOSING' && pageNow.outcome === 'NEGOTIATION',
    `${dropped.status} card ${cardNow?.stage} row ${rowNow?.stage} page ${pageNow.stage}`,
  );

  // ── 5. Lead → quotation hand-off ─────────────────────────────────────────
  console.log('\nLead to quotation');
  const fromLead = await http(managerToken, 'POST', '/quotations', {
    leadId: bareLead.id,
    subject: `${TAG} From the lead`,
  });
  check('POST /quotations with a lead and no customer is accepted', fromLead.status === 201, `${fromLead.status} ${errorOf(fromLead)}`);
  const created = fromLead.status === 201
    ? await prisma.quotation.findUnique({ where: { id: String(fromLead.body.id) } })
    : null;
  check(
    "it takes the lead's customer, site and expected close",
    created?.customerId === customer.id &&
      created?.siteId === site.id &&
      created?.expectedClosing?.toISOString().slice(0, 10) === '2026-11-20',
    `${created?.customerId} ${created?.siteId} ${created?.expectedClosing?.toISOString()}`,
  );
  const noCustomer = await http(managerToken, 'POST', '/quotations', {
    leadId: unlinkedLead.id,
    subject: `${TAG} Nobody on file`,
  });
  check(
    'a lead with no customer on file is refused with what to do',
    noCustomer.status === 400 && errorOf(noCustomer).includes('link the lead to a customer'),
    `${noCustomer.status} ${errorOf(noCustomer)}`,
  );

  const costing = await prisma.costing.create({
    data: {
      number: await nextNumber('costing'),
      title: `${TAG} Priced for the lead`,
      ownerId: manager.id,
      customerId: customer.id,
      leadId: unlinkedLead.id,
    },
  });
  const leadRead = await http(managerToken, 'GET', `/leads/${unlinkedLead.id}`);
  const leadCostings = (leadRead.body.costings ?? []) as { id: string }[];
  check('GET /leads/:id lists the costings raised for it', leadCostings.some((c) => c.id === costing.id));

  // "Added by" on the list: who recorded the enquiry, and a filter on it.
  const addedBy = await http(managerToken, 'GET', `/leads?search=${encodeURIComponent(TAG)}&createdById=${manager.id}`);
  const addedRows = (addedBy.body.rows ?? []) as { id: string; createdBy?: { name: string } }[];
  check(
    'GET /leads names who added each lead',
    addedRows.length >= 3 && addedRows.every((r) => r.createdBy?.name === manager.name),
    JSON.stringify(addedRows.map((r) => r.createdBy)),
  );
  const addedBySeller = await http(managerToken, 'GET', `/leads?search=${encodeURIComponent(TAG)}&createdById=${seller.id}`);
  check(
    'and ?createdById= filters on it',
    addedBySeller.status === 200 && (addedBySeller.body.rows as unknown[]).length === 0,
    `${addedBySeller.status} ${(addedBySeller.body.rows as unknown[] | undefined)?.length}`,
  );

  const detail = await http(managerToken, 'GET', `/quotations/${negotiating.id}`);
  const revs = (detail.body.revisions ?? []) as { jobs?: unknown }[];
  check('GET /quotations/:id says which project each revision became', revs.length > 0 && revs.every((r) => Array.isArray(r.jobs)));
  const expected = await http(managerToken, 'PATCH', `/quotations/${negotiating.id}`, { expectedClosing: '2026-10-31' });
  const afterClose = await prisma.quotation.findUnique({ where: { id: negotiating.id } });
  check(
    'expected closing is editable on the quotation',
    expected.status === 200 && afterClose?.expectedClosing?.toISOString().slice(0, 10) === '2026-10-31',
    `${expected.status}`,
  );

  // ── Leads on paper ───────────────────────────────────────────────────────
  console.log('\nLeads as PDF');
  const pdfText = (pdf: Buffer): string => {
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
          piece += part[1] ? Buffer.from(part[1], 'hex').toString('latin1') : part[2].replace(/\\([()\\])/g, '$1');
        }
        if (piece) out.push(piece);
      }
    }
    return out.join('\n');
  };
  const fetchPdf = async (token: string, path: string) => {
    const r = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()) };
  };

  const leadPdf = await fetchPdf(managerToken, `/leads/${bareLead.id}/pdf`);
  const leadPdfText = pdfText(leadPdf.bytes);
  check(
    'GET /leads/:id/pdf renders the lead: number, company, who added it',
    leadPdf.status === 200 &&
      leadPdf.bytes.subarray(0, 5).toString() === '%PDF-' &&
      leadPdfText.includes(bareLead.number) &&
      leadPdfText.includes(`${TAG} Bare Lead`) &&
      leadPdfText.includes(manager.name),
    `${leadPdf.status}`,
  );
  check('its enquiry prints in full, both lines', leadPdfText.includes('Two PSA oxygen generators') && leadPdfText.includes('with manifold'));
  const leadLines = leadPdfText.split('\n');
  check(
    'a lead has no route: it prints the one person who acted — ADDED BY, the name — and no approval slot nobody fills',
    leadLines.includes('ADDED BY') && leadLines.includes(manager.name) && !leadPdfText.includes('APPROVED BY') && !leadPdfText.includes('Added by:'),
    leadLines.slice(-8).join(' | '),
  );
  // The lead has moved on by now (its quotation): read the status it stands in.
  const bareStatus = (await prisma.lead.findUniqueOrThrow({ where: { id: bareLead.id }, select: { status: true } })).status;
  const bareWords = bareStatus.toLowerCase().replace(/_/g, ' ');
  check(
    'its words and dates as every record prints them: the status through statusLabel, the closing date long, the money with its code',
    leadPdfText.includes(`Status: ${bareWords.charAt(0).toUpperCase()}${bareWords.slice(1)}`) && !/Status: [A-Z_]{3,}\b/.test(leadPdfText) &&
      leadPdfText.includes('Expected closing: November 20, 2026') && leadPdfText.includes('Estimated value: PHP 400,000.00'),
    leadLines.filter((l) => /Status|closing|value/i.test(l)).join(' | '),
  );
  check(
    'printing the lead is audited as an export',
    !!(await prisma.auditLog.findFirst({ where: { entityType: 'lead', entityId: bareLead.id, action: 'EXPORTED', actorId: manager.id } })),
  );
  const deniedPdf = await fetchPdf(sellerToken, `/leads/${bareLead.id}/pdf`);
  check("someone else's lead is refused on paper exactly as on screen", deniedPdf.status === 403, `${deniedPdf.status}`);

  const listPdf = await fetchPdf(managerToken, `/leads/pdf?search=${encodeURIComponent(TAG)}`);
  const listPdfText = pdfText(listPdf.bytes);
  check(
    'GET /leads/pdf prints the filtered list — every tagged lead, and the total',
    listPdf.status === 200 && listPdfText.includes(`${TAG} Bare Lead`) && listPdfText.includes(`${TAG} Not On File`) && listPdfText.includes('Total estimated value'),
    `${listPdf.status}`,
  );
  const narrowedPdf = pdfText((await fetchPdf(managerToken, `/leads/pdf?search=${encodeURIComponent(TAG)}&status=NEW`)).bytes);
  check('and obeys the list’s own filters', narrowedPdf.includes(`${TAG} Not On File`) && !narrowedPdf.includes(`${TAG} Bare Lead`));
  const exportedPdf = await prisma.auditLog.findFirst({
    where: { entityType: 'lead', entityId: 'list', action: 'EXPORTED', actorId: manager.id },
  });
  check('the list export left an audit row', !!exportedPdf);

  // ── The Forecast on paper: one money block, one bold row ─────────────────
  /** Each text run with whether its font is the bold one (the resource map read off the file). */
  const pdfRuns = (pdf: Buffer): { text: string; bold: boolean }[] => {
    const raw = pdf.toString('latin1');
    const fonts = new Map([...raw.matchAll(/(\d+) 0 obj\s*<<\s*\/Type \/Font\s*\/BaseFont \/([\w-]+)/g)].map((m) => [m[1], m[2]]));
    const names = new Map([...raw.matchAll(/\/(F\d+) (\d+) 0 R/g)].map((m) => [m[1], fonts.get(m[2]) ?? '']));
    const out: { text: string; bold: boolean }[] = [];
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
      let font = '';
      for (const op of body.matchAll(/\/(F\d+)\s+[\d.]+\s+Tf|\[([^\]]*)\]\s*TJ/g)) {
        if (op[1]) {
          font = names.get(op[1]) ?? '';
          continue;
        }
        let piece = '';
        for (const part of op[2].matchAll(/<([0-9A-Fa-f]*)>|\(((?:\\.|[^\\()])*)\)/g)) {
          piece += part[1] ? Buffer.from(part[1], 'hex').toString('latin1') : part[2].replace(/\\([()\\])/g, '$1');
        }
        if (piece) out.push({ text: piece, bold: font.endsWith('-Bold') });
      }
    }
    return out;
  };
  const fcSince = new Date();
  const fcPaper = await fetchPdf(managerToken, `/pipeline/forecast.pdf?${fcQuery}`);
  const fcRuns = pdfRuns(fcPaper.bytes);
  const fcPaperText = fcRuns.map((r) => r.text).join('\n');
  const moneyLabels = fcRuns.filter((r) => /^(In the window|Everything open)/.test(r.text));
  check(
    'the Forecast prints its money block once — the window, then everything open — and only the grand total, last, is bold',
    fcPaper.status === 200 &&
      moneyLabels.length === 4 &&
      moneyLabels.filter((r) => r.bold).length === 1 &&
      moneyLabels[3].bold &&
      /^Everything open \(\d+\)$/.test(moneyLabels[3].text),
    moneyLabels.map((r) => `${r.text}${r.bold ? ' [bold]' : ''}`).join(' | '),
  );
  check(
    'its money columns name the code in the head, and its dates are a list’s (MM/DD/YYYY), the window’s edges too',
    fcPaperText.includes('VALUE (PHP)') && fcPaperText.includes('WEIGHTED (PHP)') && fcPaperText.replace(/\s+/g, ' ').includes('11/01/2026 to 12/31/2026') && fcPaperText.includes('11/03/2026'),
    fcPaperText.slice(0, 400).replace(/\n/g, ' | '),
  );
  check(
    'and printing it is audited as an export',
    !!(await prisma.auditLog.findFirst({ where: { entityType: 'pipeline', entityId: 'forecast', action: 'EXPORTED', actorId: manager.id, at: { gte: fcSince }, summary: { startsWith: 'Sales forecast printed' } } })),
  );

  // ── SCORO's ladder: the stage sets the odds ──────────────────────────────
  console.log('\nStage odds (SCORO\u2019s ladder)');
  check(
    "the ladder: opportunity stages 10, submitted 50, negotiation 90, won 100, lost 0, on hold says nothing",
    stageProbability('NEW') === 10 &&
      stageProbability('COSTING') === 10 &&
      stageProbability('OPEN') === 10 &&
      stageProbability('SUBMITTED') === 50 &&
      stageProbability('NEGOTIATION') === 90 &&
      stageProbability('WON') === 100 &&
      stageProbability('LOST') === 0 &&
      stageProbability('ON_HOLD') === null,
  );
  check(
    'typed odds survive a move within the same band, and On hold never touches them',
    probabilityAfterMove('NEW', 'CONTACTED', 35) === 35 &&
      probabilityAfterMove('CONTACTED', 'ON_HOLD', 35) === 35 &&
      probabilityAfterMove('SUBMITTED', 'NEGOTIATION', 65) === 90,
  );

  const laddered = await prisma.quotation.create({
    data: {
      number: await nextNumber('quotation', prisma, { ownerId: manager.id }),
      customerId: customer.id,
      ownerId: manager.id,
      subject: `${TAG} Ladder quote`,
      outcome: 'OPEN',
      probability: 25,
      revisions: { create: [{ revision: 0, status: 'APPROVED', vatRate: D(0.12), subtotal: D(500_000), total: D(560_000) }] },
    },
  });
  await http(managerToken, 'PATCH', `/quotations/${laddered.id}`, { outcome: 'SUBMITTED' });
  const atSubmitted = await prisma.quotation.findUniqueOrThrow({ where: { id: laddered.id } });
  check('moving a quotation to Submitted sets its odds to 50', atSubmitted.probability === 50, String(atSubmitted.probability));
  await http(managerToken, 'PATCH', `/quotations/${laddered.id}`, { outcome: 'NEGOTIATION', probability: 65 });
  const typedWins = await prisma.quotation.findUniqueOrThrow({ where: { id: laddered.id } });
  check('a probability typed in the same move wins over the stage', typedWins.probability === 65, String(typedWins.probability));
  await http(managerToken, 'PATCH', `/quotations/${laddered.id}`, { outcome: 'WON' });
  const atWon = await prisma.quotation.findUniqueOrThrow({ where: { id: laddered.id } });
  check('won is 100', atWon.probability === 100, String(atWon.probability));

  const ladderLead = await prisma.lead.create({
    data: {
      number: await nextNumber('lead'),
      companyName: `${TAG} Ladder lead`,
      status: 'NEW',
      assignedToId: manager.id,
      createdById: manager.id,
      probability: 20,
    },
  });
  await http(managerToken, 'PATCH', `/leads/${ladderLead.id}`, { status: 'CONTACTED' });
  const sameBand = await prisma.lead.findUniqueOrThrow({ where: { id: ladderLead.id } });
  check('a lead moved within the opportunity band keeps its typed odds', sameBand.probability === 20, String(sameBand.probability));
  await http(managerToken, 'PATCH', `/leads/${ladderLead.id}`, { status: 'LOST', lostReason: `${TAG} ladder` });
  const atLost = await prisma.lead.findUniqueOrThrow({ where: { id: ladderLead.id } });
  check('lost zeroes it', atLost.probability === 0, String(atLost.probability));

  const followLead = await prisma.lead.create({
    data: {
      number: await nextNumber('lead'),
      companyName: `${TAG} Follow lead`,
      status: 'QUOTATION_CREATED',
      assignedToId: manager.id,
      createdById: manager.id,
      probability: 30,
    },
  });
  const followQuote = await newQuotation('Follows the ladder', 'OPEN', [{ revision: 0, status: 'APPROVED', total: 100_000 }], {
    leadId: followLead.id,
    probability: 30,
  });
  await http(managerToken, 'PATCH', `/quotations/${followQuote.id}`, { outcome: 'SUBMITTED' });
  const followed = await prisma.lead.findUniqueOrThrow({ where: { id: followLead.id } });
  check(
    'the lead that follows a submitted quotation takes the stage and its odds',
    followed.status === 'QUOTATION_SUBMITTED' && followed.probability === 50,
    `${followed.status} ${followed.probability}`,
  );

  // ── SCORO's statuses as data: the stages, their odds, the board's bands ──
  console.log('\nStages (SCORO\u2019s statuses as data)');
  const withStages = (await http(managerToken, 'GET', `/pipeline?search=${encodeURIComponent(TAG)}`)).body as unknown as BoardBody;
  const activeKeys = (withStages.stages ?? []).filter((st) => st.inActiveList).map((st) => st.key);
  check(
    'the board carries the stages: SCORO\u2019s five on the active board, Lost and On hold off it',
    withStages.stages?.length === 7 && activeKeys.join(',') === 'OPPORTUNITY,NEGOTIATION,CLOSING,CONFIRMED,COMPLETED',
    JSON.stringify(activeKeys),
  );
  const stageQuote = await newQuotation('Stage quote', 'OPEN', [{ revision: 0, status: 'APPROVED', total: 100_000 }], { probability: 25 });
  const stageRev = await prisma.quotationRevision.findFirstOrThrow({ where: { quotationId: stageQuote.id } });
  await prisma.quotationItem.create({
    data: { revisionId: stageRev.id, title: `${TAG} Stage line`, description: 'One lot', quantity: 1, unit: 'lot', unitPrice: 100_000, amount: 100_000, sortOrder: 0 },
  });
  await http(managerToken, 'PATCH', `/quotations/${stageQuote.id}`, { outcome: 'WON' });
  const cardStage = async () =>
    ((await http(managerToken, 'GET', `/pipeline?search=${encodeURIComponent(`${TAG} Stage quote`)}`)).body as unknown as BoardBody).columns
      .flatMap((c) => c.cards)
      .find((c) => c.id === stageQuote.id) as (BoardCard & { stage?: string; booked?: boolean }) | undefined;
  const confirmed = await cardStage();
  check('a won quotation with no sales order stands in Confirmed', confirmed?.stage === 'CONFIRMED' && confirmed?.booked === false, JSON.stringify(confirmed?.stage));
  const booked = await http(managerToken, 'POST', '/sales-orders', { quotationId: stageQuote.id, mode: 'all' });
  const completed = await cardStage();
  check(
    'and once a sales order is created from it, in Completed — worked out, never set by hand',
    booked.status === 201 && completed?.stage === 'COMPLETED' && completed?.booked === true,
    `${booked.status} ${completed?.stage}`,
  );

  check('a salesperson without the board cannot read the stages', (await http(sellerToken, 'GET', '/pipeline/stages')).status === 403);
  check('the board manager reads them but cannot change them', (await http(managerToken, 'GET', '/pipeline/stages')).status === 200 && (await http(managerToken, 'PUT', '/pipeline/stages', {})).status === 403);
  const renamed = await http(stageAdminToken, 'PUT', '/pipeline/stages', {
    NEGOTIATION: { label: 'Proposal sent', probability: 40, color: '#123456' },
    CONFIRMED: { probability: 55 },
    LOST: { inActiveList: true },
  });
  const renamedStages = (renamed.body.stages ?? []) as BoardBody['stages'];
  const neg = renamedStages.find((st) => st.key === 'NEGOTIATION');
  const conf = renamedStages.find((st) => st.key === 'CONFIRMED');
  check(
    'an administrator renames a stage, sets its odds and colour, and lists Lost on the board — Confirmed stays 100',
    renamed.status === 200 && neg?.label === 'Proposal sent' && neg?.probability === 40 && neg?.color === '#123456' && conf?.probability === 100 && renamedStages.find((st) => st.key === 'LOST')?.inActiveList === true,
    renamed.text.slice(0, 200),
  );
  const oddsQuote = await newQuotation('Odds quote', 'OPEN', [{ revision: 0, status: 'APPROVED', total: 50_000 }], { probability: 25 });
  await http(managerToken, 'PATCH', `/quotations/${oddsQuote.id}`, { outcome: 'SUBMITTED' });
  const atForty = await prisma.quotation.findUniqueOrThrow({ where: { id: oddsQuote.id } });
  check('a move now takes the odds the setting gives the stage', atForty.probability === 40, String(atForty.probability));
  const boardRenamed = (await http(managerToken, 'GET', '/pipeline')).body as unknown as BoardBody;
  check(
    'the board carries the renamed stage, and Lost joins the active board',
    boardRenamed.stages.find((st) => st.key === 'NEGOTIATION')?.label === 'Proposal sent' && boardRenamed.stages.find((st) => st.key === 'LOST')?.inActiveList === true,
  );
  check(
    'the change is audited',
    (await prisma.auditLog.count({ where: { entityType: 'setting', entityId: STAGES_KEY, actorId: stageAdmin.id, action: 'UPDATED' } })) === 1,
  );
  const restored = await http(stageAdminToken, 'DELETE', '/pipeline/stages');
  const oddsQuote2 = await newQuotation('Odds quote two', 'OPEN', [{ revision: 0, status: 'APPROVED', total: 50_000 }], { probability: 25 });
  await http(managerToken, 'PATCH', `/quotations/${oddsQuote2.id}`, { outcome: 'SUBMITTED' });
  const atFifty = await prisma.quotation.findUniqueOrThrow({ where: { id: oddsQuote2.id } });
  check('"SCORO\u2019s defaults" puts the ladder back: Negotiation is 50 again', restored.status === 200 && atFifty.probability === 50, String(atFifty.probability));
  const csvRes = await fetch(`${BASE}/pipeline/board.csv`, { headers: { Authorization: `Bearer ${managerToken}` } });
  const csvHead = (await csvRes.text()).split('\n')[0];
  check('the CSV twin appends a Stage column', csvRes.status === 200 && csvHead.trim().endsWith('Stage'), csvHead);

  // ── 6. The number preview ────────────────────────────────────────────────
  console.log('\nThe next quotation number');
  const nextNo = await http(managerToken, 'GET', '/quotations/next-number');
  const direct = await previewNext('quotation', { ownerId: manager.id });
  check(
    "GET /quotations/next-number is previewNext for the caller's own counter",
    nextNo.status === 200 && nextNo.body.number === direct.number,
    `${String(nextNo.body.number)} vs ${direct.number}`,
  );
  check(
    'and says the account is linked to an employee',
    nextNo.body.linked === true &&
      nextNo.body.employeeNo === `${TAG}-EMP-2026-0007` &&
      typeof nextNo.body.usesEmployeeDigits === 'boolean',
    JSON.stringify(nextNo.body),
  );
  const unlinked = await http(sellerToken, 'GET', '/quotations/next-number');
  check('an unlinked account is told so', unlinked.status === 200 && unlinked.body.linked === false, JSON.stringify(unlinked.body));

  // The sales default, on a throwaway type so the real template is untouched.
  await prisma.numberSequence.create({
    data: {
      documentType: `${TAG}_qt`,
      label: 'Verify — the quotation default',
      pattern: '{EMP}{YY}{MM}{SEQ}',
      typeCode: 'QT',
      period: 'MONTH',
      scope: 'OWNER',
      padding: 3,
    },
  });
  const sample = await previewNext(`${TAG}_qt`, { ownerId: manager.id });
  check(
    'the sales default previews as employee 007 · YY · MM · 001',
    /^007\d{2}\d{2}001$/.test(sample.number),
    sample.number,
  );
  const issued = await nextNumber(`${TAG}_qt`, prisma, { ownerId: manager.id });
  check('and the number then issued is the one previewed', issued === sample.number, `${issued} vs ${sample.number}`);

  // ── 7. Activities ────────────────────────────────────────────────────────
  console.log('\nActivities');
  const startsAt = '2026-10-02T16:30:00.000Z'; // 00:30 on the 3rd in Manila
  const scheduled = await http(managerToken, 'POST', '/activities', {
    type: 'SITE_VISIT',
    subject: `${TAG} Survey the plant room`,
    startsAt,
    assignedToId: seller.id,
    quotationId: sellersOwn.id,
  });
  check('an activity can be scheduled for a colleague', scheduled.status === 201, `${scheduled.status} ${errorOf(scheduled)}`);
  const activityId = String(scheduled.body.id);
  const one = await http(managerToken, 'GET', `/activities/${activityId}`);
  check('GET /activities/:id reads it back', one.status === 200 && one.body.id === activityId, `${one.status}`);
  const note = await prisma.notification.findFirst({
    where: { userId: seller.id, title: { contains: 'Survey the plant room' } },
  });
  // Since 2026-10-08 an activity has a page of its own, and every bell about
  // it lands there (`activityLink()`); the page shows its day.
  check(
    "the assignee is sent to the activity's own page",
    note?.link === `/g-ops/calendar/activities/${activityId}`,
    note?.link ?? 'no notification',
  );
  const forQuote = await http(managerToken, 'GET', `/activities?quotationId=${sellersOwn.id}`);
  check(
    "a quotation's activity log finds it",
    Array.isArray(forQuote.body) && (forQuote.body as unknown as { id: string }[]).some((a) => a.id === activityId),
  );
  const logged = await prisma.auditLog.findFirst({
    where: { entityType: 'sales_activity', entityId: activityId, action: 'CREATED' },
  });
  check('scheduling it is audited', !!logged);
}

main()
  .then(async () => {
    await cleanup();
    console.log(`\n${passed} passed, ${failed} failed`);
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  })
  .catch(async (err) => {
    console.error(err);
    try {
      await cleanup();
    } catch {
      /* leave the tagged rows for the next run's cleanup */
    }
    await prisma.$disconnect();
    process.exit(1);
  });
