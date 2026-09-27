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
import { Prisma } from '@prisma/client';
import { prisma } from '../src/prisma';
import { env } from '../src/env';
import { signToken } from '../src/auth/middleware';
import { nextNumber, previewNext } from '../src/shared/numbering';

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
  await prisma.quotation.deleteMany({ where: { subject: { startsWith: TAG } } });
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
  canMove: boolean;
  allowedTargets: string[];
}
interface BoardBody {
  kpis: { openQuotes: number; quotedValue: number; weightedValue: number };
  window: { decidedWithinDays: number };
  columns: { key: string; count: number; value: number; cards: BoardCard[] }[];
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
    'gops.leads.view_all',
    'gops.leads.edit_all',
    'gops.leads.edit_own',
    'gops.quotations.view_all',
    'gops.quotations.edit_all',
    'gops.quotations.edit_own',
    'gops.quotations.create',
    'gops.calendar.view_all',
    'insights.pipeline.view_all',
  ]);
  const plainRole = await makeRole('zzpipe_plain', 'Verify salesperson without the board', [
    'gops.quotations.view_own',
    'gops.quotations.edit_own',
    'gops.quotations.create',
  ]);
  const manager = await makeUser('Verify Board Manager', 'board@verifyp.local', [boardRole.id]);
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
    where: { userId: seller.id, title: { contains: 'moved to Submitted' } },
  });
  check('and the salesperson is told who moved it', !!told && told.title.includes(manager.name), told?.title);
  const notMine = await http(sellerToken, 'PATCH', `/quotations/${draftOnly.id}`, { outcome: 'NEGOTIATION' });
  check("a salesperson cannot move someone else's quotation", notMine.status === 403, `${notMine.status}`);

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
  check(
    'the assignee is sent to the activity itself, on its Manila day',
    !!note?.link?.startsWith(`/g-ops/calendar?activity=${activityId}`) && note.link.includes('date=2026-10-03'),
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
