/**
 * Costing handoffs and duplication — verification.
 *
 *   npx tsx scripts/verify-costing.ts      (the API must be running)
 *
 * Three things here are cheap to get wrong and expensive to notice late:
 *
 *   · "Start costing" from a lead must move the lead to COSTING — but only
 *     forwards. A lead in NEGOTIATION that gets re-costed must not be dragged
 *     back to the start of the pipeline.
 *   · A duplicate must be a faithful copy of the numbers (lines, sections,
 *     tasks, totals) and NOT a copy of the history (lead link, quotations,
 *     jobs, FINAL status). A renewal is built on this, at last year's prices.
 *   · The lookup's `?status=` filter is what keeps DRAFT costings out of the
 *     project picker. If it silently returned everything, a project could be
 *     built on a budget that is still moving.
 *
 * All of it is checked over HTTP, because the guards live in the routes.
 */

import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/prisma';
import { env } from '../src/env';
import { signToken } from '../src/auth/middleware';
import { nextNumber } from '../src/shared/numbering';

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
const D = (v: number) => new Prisma.Decimal(v);
const num = (v: Prisma.Decimal | null | undefined) => (v == null ? 0 : Number(v));

const TAG = 'ZZCOST';
const MAIL = '@verifycosting.local';
const BASE = `http://localhost:${env.port}/api`;

// ── Fixtures ─────────────────────────────────────────────────────────────────

async function cleanup() {
  // Jobs restrict their costing, so they go first; lines, sections and tasks
  // cascade from the costing.
  await prisma.job.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.costing.deleteMany({ where: { title: { startsWith: TAG } } });
  await prisma.lead.deleteMany({ where: { companyName: { startsWith: TAG } } });
  await prisma.customer.deleteMany({ where: { name: { startsWith: TAG } } });

  const users = await prisma.user.findMany({
    where: { email: { endsWith: MAIL } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.role.deleteMany({ where: { key: { startsWith: 'zzcost_' } } });
}

/**
 * A role holding exactly the permissions named — the seeded roles belong to
 * the operator, and a test that borrows one breaks the day it is edited.
 */
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
    data: {
      key,
      name,
      permissions: { create: permissions.map((p) => ({ permissionId: p.id })) },
    },
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
}

async function api(token: string, method: string, path: string, body?: unknown): Promise<HttpResult> {
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

type Row = Record<string, unknown>;
const rows = (v: unknown) => (Array.isArray(v) ? (v as Row[]) : []);

// ── The run ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nG-CORE costing verification\n');

  if (!(await apiReachable())) {
    console.error(`The API is not answering at ${BASE}. Start it (cd api && npm run dev) and run again.`);
    process.exit(1);
  }

  await cleanup();

  const ownRole = await makeRole('zzcost_own', `${TAG} own-scope costing`, [
    'gops.costing.view_own',
    'gops.costing.create',
    'gops.costing.edit_own',
  ]);
  const allRole = await makeRole('zzcost_all', `${TAG} all-scope costing`, [
    'gops.costing.view_all',
    'gops.costing.view_own',
    'gops.costing.create',
    'gops.costing.edit_own',
  ]);
  const readRole = await makeRole('zzcost_read', `${TAG} read-only costing`, ['gops.costing.view_all']);

  const estimator = await makeUser(`${TAG} Estimator`, `estimator${MAIL}`, [ownRole.id]);
  const colleague = await makeUser(`${TAG} Colleague`, `colleague${MAIL}`, [ownRole.id]);
  const manager = await makeUser(`${TAG} Manager`, `manager${MAIL}`, [allRole.id]);
  const reader = await makeUser(`${TAG} Reader`, `reader${MAIL}`, [readRole.id]);

  const tEstimator = signToken(estimator.id, estimator.email);
  const tColleague = signToken(colleague.id, colleague.email);
  const tManager = signToken(manager.id, manager.email);
  const tReader = signToken(reader.id, reader.email);

  const customer = await prisma.customer.create({
    data: {
      code: `${TAG}-C1`,
      name: `${TAG} Hospital`,
      createdById: manager.id,
      sites: { create: [{ name: `${TAG} Main plant` }] },
    },
    include: { sites: true },
  });
  const site = customer.sites[0];

  const makeLead = async (status: 'NEW' | 'NEGOTIATION', withCustomer = true) =>
    prisma.lead.create({
      data: {
        number: await nextNumber('lead'),
        status,
        companyName: `${TAG} ${status} lead`,
        customerId: withCustomer ? customer.id : null,
        siteId: withCustomer ? site.id : null,
        description: `Oxygen plant expansion, Phase 2\nSecond line the title must not carry`,
        assignedToId: estimator.id,
        createdById: estimator.id,
      },
    });

  // ══ Start costing from a lead ═══════════════════════════════════════════════
  console.log('Start costing from a lead');

  const newLead = await makeLead('NEW');
  const fromNew = await api(tEstimator, 'POST', '/costings', {
    title: `${TAG} from a new lead`,
    leadId: newLead.id,
    markupPct: 0.2,
  });
  check('a costing is created from a NEW lead', fromNew.status === 201, `status ${fromNew.status}`);
  check('it carries the lead', fromNew.body.leadId === newLead.id);
  check(
    "it takes the lead's customer and site when the body names none",
    fromNew.body.customerId === customer.id && fromNew.body.siteId === site.id,
  );
  const newLeadAfter = await prisma.lead.findUnique({ where: { id: newLead.id } });
  check('the lead moves to COSTING', newLeadAfter?.status === 'COSTING', newLeadAfter?.status);

  const negotiating = await makeLead('NEGOTIATION');
  const fromNeg = await api(tEstimator, 'POST', '/costings', {
    title: `${TAG} from a negotiating lead`,
    leadId: negotiating.id,
  });
  check('a lead in NEGOTIATION can still be costed', fromNeg.status === 201, `status ${fromNeg.status}`);
  const negAfter = await prisma.lead.findUnique({ where: { id: negotiating.id } });
  check(
    'but it is NOT dragged back to COSTING',
    negAfter?.status === 'NEGOTIATION',
    negAfter?.status,
  );

  const bogus = await api(tEstimator, 'POST', '/costings', {
    title: `${TAG} from a lead that does not exist`,
    leadId: 'no-such-lead',
  });
  check('an unknown lead is a 404', bogus.status === 404, `status ${bogus.status}`);
  const orphanCount = await prisma.costing.count({
    where: { title: `${TAG} from a lead that does not exist` },
  });
  check('and no costing was written — the number was not burned either', orphanCount === 0);

  // The GET carries the lead, so the page can link back.
  const detail = await api(tEstimator, 'GET', `/costings/${fromNew.body.id}`);
  const detailLead = detail.body.lead as Row | null;
  check(
    'GET /costings/:id returns the lead {id, number, companyName, status}',
    detailLead?.id === newLead.id && detailLead?.number === newLead.number && detailLead?.status === 'COSTING',
  );
  check('GET /costings/:id returns jobs as an (empty) array', Array.isArray(detail.body.jobs) && rows(detail.body.jobs).length === 0);

  // Re-linking on PATCH is a correction, not a handoff.
  const spareLead = await makeLead('NEW');
  const relink = await api(tEstimator, 'PATCH', `/costings/${fromNeg.body.id}`, { leadId: spareLead.id });
  const spareAfter = await prisma.lead.findUnique({ where: { id: spareLead.id } });
  check(
    'PATCH { leadId } re-links without moving the lead',
    relink.status === 200 && relink.body.leadId === spareLead.id && spareAfter?.status === 'NEW',
    `status ${relink.status}, lead ${spareAfter?.status}`,
  );

  // ══ Where it goes next: jobs on the costing ═════════════════════════════════
  console.log('Where it goes next');

  const categories = await prisma.costCategory.findMany({ orderBy: { sortOrder: 'asc' }, take: 2 });
  if (categories.length < 2) throw new Error('Expected the seeded cost categories');

  // A priced, FINAL costing with lines, sections and tasks — the source for
  // both the job link and the duplicate.
  const sourceId = fromNew.body.id as string;
  for (const [i, line] of [
    { cat: categories[0].id, description: 'Compressor', quantity: 2, unitCost: 150000 },
    { cat: categories[1].id, description: 'Installation crew', quantity: 12, unitCost: 2500 },
  ].entries()) {
    const r = await api(tEstimator, 'POST', `/costings/${sourceId}/lines`, {
      costCategoryId: line.cat,
      description: line.description,
      quantity: line.quantity,
      unit: i === 0 ? 'unit' : 'day',
      unitCost: line.unitCost,
      sortOrder: i,
    });
    if (r.status !== 201) throw new Error(`line create failed: ${JSON.stringify(r.body)}`);
  }
  const sec1 = await api(tEstimator, 'POST', `/costings/${sourceId}/sections`, {
    kind: 'MAIN_WORK',
    name: 'Fabrication and installation',
    durationDays: 30,
    value: 300000,
    sortOrder: 0,
  });
  const sec2 = await api(tEstimator, 'POST', `/costings/${sourceId}/sections`, {
    kind: 'TESTING_COMMISSIONING',
    name: 'Testing and commissioning',
    durationDays: 5,
    value: 96000,
    sortOrder: 1,
  });
  for (const name of ['Foundation', 'Piping', 'Controls']) {
    await api(tEstimator, 'POST', `/costings/${sourceId}/sections/${sec1.body.id}/tasks`, { name, durationDays: 0 });
  }
  await api(tEstimator, 'POST', `/costings/${sourceId}/sections/${sec2.body.id}/tasks`, {
    name: 'Purity test',
    durationDays: 0,
  });
  const finalised = await api(tEstimator, 'PATCH', `/costings/${sourceId}`, { status: 'FINAL' });
  check('the source costing is FINAL', finalised.status === 200 && finalised.body.status === 'FINAL');
  // 2×150,000 + 12×2,500 = 330,000 cost; ×1.2 = 396,000 contract.
  check('its contract value is cost × (1 + markup)', money(Number(finalised.body.contractValue), 396000));

  const job = await prisma.job.create({
    data: {
      number: await nextNumber('project'),
      name: `${TAG} Expansion project`,
      customerId: customer.id,
      costingId: sourceId,
      createdById: manager.id,
      contractValue: D(396000),
    },
  });
  const withJob = await api(tEstimator, 'GET', `/costings/${sourceId}`);
  const jobRows = rows(withJob.body.jobs);
  check(
    'GET /costings/:id lists the job built on it {id, number, name, status, type}',
    jobRows.length === 1 &&
      jobRows[0].id === job.id &&
      jobRows[0].number === job.number &&
      jobRows[0].status === 'PLANNING' &&
      jobRows[0].type === 'PROJECT',
    JSON.stringify(jobRows),
  );

  // ══ Lookup: status and q ════════════════════════════════════════════════════
  console.log('Lookup');

  const draftTitle = fromNeg.body.title as string;
  const onlyFinal = await api(tEstimator, 'GET', '/costings/lookup?status=FINAL');
  const finalIds = rows(onlyFinal.body).map((r) => r.id);
  check(
    '?status=FINAL returns the final costing and not the draft',
    finalIds.includes(sourceId) && !finalIds.includes(fromNeg.body.id as string),
  );
  const both = await api(tEstimator, 'GET', '/costings/lookup?status=DRAFT,FINAL');
  const bothIds = rows(both.body).map((r) => r.id);
  check('?status=DRAFT,FINAL returns both', bothIds.includes(sourceId) && bothIds.includes(fromNeg.body.id as string));
  const byQ = await api(tEstimator, 'GET', `/costings/lookup?q=${encodeURIComponent('negotiating lead')}`);
  const qIds = rows(byQ.body).map((r) => r.id);
  check(
    '?q= narrows by title',
    qIds.length >= 1 && qIds.includes(fromNeg.body.id as string) && !qIds.includes(sourceId),
    `${qIds.length} row(s)`,
  );
  const byCustomer = await api(tEstimator, 'GET', `/costings/lookup?q=${encodeURIComponent(`${TAG} Hospital`)}`);
  check('?q= also matches the customer name', rows(byCustomer.body).some((r) => r.id === sourceId));
  const lookupRow = rows(onlyFinal.body).find((r) => r.id === sourceId);
  check(
    'lookup rows carry status, a numeric contract value and the customer',
    lookupRow?.status === 'FINAL' &&
      typeof lookupRow?.contractValue === 'number' &&
      (lookupRow?.customer as Row | null)?.id === customer.id,
  );
  check(
    "a draft the colleague cannot see is not in their lookup (own scope)",
    !rows((await api(tColleague, 'GET', '/costings/lookup')).body).some((r) => r.id === sourceId),
  );
  check(
    'a bad status value is ignored rather than refused',
    (await api(tEstimator, 'GET', '/costings/lookup?status=BOGUS')).status === 200,
  );

  // ══ Duplicate ═══════════════════════════════════════════════════════════════
  console.log('Duplicate');

  const dup = await api(tManager, 'POST', `/costings/${sourceId}/duplicate`);
  check('POST /costings/:id/duplicate answers 201', dup.status === 201, `status ${dup.status}: ${JSON.stringify(dup.body)}`);
  const copy = await prisma.costing.findUnique({
    where: { id: dup.body.id as string },
    include: {
      lines: { orderBy: { sortOrder: 'asc' } },
      scopeSections: { orderBy: { sortOrder: 'asc' }, include: { tasks: { orderBy: { sortOrder: 'asc' } } } },
      quotationRevisions: true,
      jobs: true,
    },
  });
  const source = await prisma.costing.findUnique({
    where: { id: sourceId },
    include: { lines: { orderBy: { sortOrder: 'asc' } } },
  });
  check('the copy has a new number', !!copy && copy.number !== source!.number && /^GT-COST-/.test(copy.number), copy?.number);
  check('the copy is a DRAFT even though the source is FINAL', copy?.status === 'DRAFT', copy?.status);
  check('the copy belongs to whoever copied it', copy?.ownerId === manager.id);
  check('the copy keeps the title, customer, site, markup and duration',
    copy?.title === source!.title &&
      copy?.customerId === source!.customerId &&
      copy?.siteId === source!.siteId &&
      num(copy?.markupPct) === num(source!.markupPct) &&
      copy?.durationDays === source!.durationDays,
  );
  check('the copy answers no lead', copy?.leadId === null);
  check(
    'every cost line is copied with its quantity, unit cost and amount',
    copy?.lines.length === 2 &&
      copy.lines.every(
        (l, i) =>
          l.description === source!.lines[i].description &&
          l.costCategoryId === source!.lines[i].costCategoryId &&
          money(num(l.quantity), num(source!.lines[i].quantity)) &&
          money(num(l.unitCost), num(source!.lines[i].unitCost)) &&
          money(num(l.amount), num(source!.lines[i].amount)),
      ),
  );
  check(
    'both scope sections are copied with their values and durations',
    copy?.scopeSections.length === 2 &&
      money(num(copy.scopeSections[0].value), 300000) &&
      copy.scopeSections[0].durationDays === 30 &&
      copy.scopeSections[1].kind === 'TESTING_COMMISSIONING',
  );
  check(
    'the tasks come with their sections',
    copy?.scopeSections[0].tasks.map((t) => t.name).join(',') === 'Foundation,Piping,Controls' &&
      copy?.scopeSections[1].tasks.length === 1,
  );
  check(
    'the totals are recomputed from the copied lines and match the source',
    money(num(copy?.totalCost), 330000) && money(num(copy?.contractValue), 396000),
    `${num(copy?.totalCost)} / ${num(copy?.contractValue)}`,
  );
  check('the copy carries no quotation revisions and no jobs', copy?.quotationRevisions.length === 0 && copy?.jobs.length === 0);
  check(
    'the response names what it was copied from',
    (dup.body.duplicatedFrom as Row | undefined)?.id === sourceId && dup.body.canEdit === true,
  );
  const sourceAfter = await prisma.costing.findUnique({ where: { id: sourceId }, include: { _count: { select: { lines: true } } } });
  check('the source is untouched — still FINAL with its two lines', sourceAfter?.status === 'FINAL' && sourceAfter._count.lines === 2);

  const renamed = await api(tManager, 'POST', `/costings/${sourceId}/duplicate`, { title: `${TAG} renewal 2027` });
  check('an optional title renames the copy', renamed.status === 201 && renamed.body.title === `${TAG} renewal 2027`);

  const audited = await prisma.auditLog.findFirst({
    where: { actorId: manager.id, entityType: 'costing', entityId: dup.body.id as string, action: 'CREATED' },
  });
  check('the duplicate is audited as CREATED naming the source', !!audited && audited.summary!.includes(source!.number));

  // Guards.
  const asColleague = await api(tColleague, 'POST', `/costings/${sourceId}/duplicate`);
  check("own-scope: a colleague cannot copy somebody else's costing", asColleague.status === 403, `status ${asColleague.status}`);
  const asOwner = await api(tEstimator, 'POST', `/costings/${sourceId}/duplicate`);
  check('own-scope: the author can copy their own', asOwner.status === 201, `status ${asOwner.status}`);
  const asReader = await api(tReader, 'POST', `/costings/${sourceId}/duplicate`);
  check('without gops.costing.create the duplicate is refused', asReader.status === 403, `status ${asReader.status}`);
  const missing = await api(tManager, 'POST', '/costings/no-such-costing/duplicate');
  check('duplicating a costing that does not exist is a 404', missing.status === 404, `status ${missing.status}`);

  // ── Done ──────────────────────────────────────────────────────────────────
  await cleanup();

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main()
  .catch(async (err) => {
    console.error(err);
    try {
      await cleanup();
    } catch {
      /* leave the evidence */
    }
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
