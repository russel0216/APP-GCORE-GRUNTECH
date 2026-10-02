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
 *   · The sheet (POST /costings, PUT /costings/:id/sheet) writes header, lines
 *     and scope in one transaction, keeps row ids, and stores exactly the
 *     figures the page showed — the web copy of costingMath is pinned to the
 *     server's here.
 *   · With a costing workflow active, FINAL is reached by approval only, and a
 *     costing under approval holds still.
 *   · Predictions and templates never become a window onto a colleague's
 *     unit costs.
 *
 * All of it is checked over HTTP, because the guards live in the routes.
 */

import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/prisma';
import { env } from '../src/env';
import { signToken } from '../src/auth/middleware';
import { nextNumber } from '../src/shared/numbering';
import { act } from '../src/shared/approvals';
import * as serverMath from '../src/shared/costingMath';
import * as webMath from '../../web/src/lib/costingMath';
// Registers the costing's onApprovalSettled subscriber in this process.
import '../src/routes/costing';

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
  // Approvals route to whoever really holds the role, so real people were told
  // about this script's documents too. Every such title carries TAG.
  await prisma.notification.deleteMany({ where: { title: { contains: TAG } } });
  // Jobs restrict their costing, so they go first; lines, sections and tasks
  // cascade from the costing.
  await prisma.job.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.costingTemplate.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.item.deleteMany({ where: { code: { startsWith: TAG } } });
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
  // The seeded workflow routes costings to the executive role; the approver
  // holds it, and nobody else here does.
  const executive = await prisma.role.findUnique({ where: { key: 'executive' } });
  if (!executive) throw new Error('Expected the seeded executive role');

  const estimator = await makeUser(`${TAG} Estimator`, `estimator${MAIL}`, [ownRole.id]);
  const colleague = await makeUser(`${TAG} Colleague`, `colleague${MAIL}`, [ownRole.id]);
  const manager = await makeUser(`${TAG} Manager`, `manager${MAIL}`, [allRole.id]);
  const reader = await makeUser(`${TAG} Reader`, `reader${MAIL}`, [readRole.id]);
  const approver = await makeUser(`${TAG} Approver`, `approver${MAIL}`, [executive.id]);

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
  // With the seeded costing workflow active, FINAL is the approver's word.
  const selfFinal = await api(tEstimator, 'PATCH', `/costings/${sourceId}`, { status: 'FINAL' });
  check('with a costing workflow active, the author cannot mark it final', selfFinal.status === 400, `status ${selfFinal.status}`);
  const submitted = await api(tEstimator, 'POST', `/costings/${sourceId}/submit`);
  check('POST /costings/:id/submit sends it for approval', submitted.status === 200 && submitted.body.status === 'PENDING_APPROVAL', JSON.stringify(submitted.body));
  const twice = await api(tEstimator, 'POST', `/costings/${sourceId}/submit`);
  check('a second submit is refused', twice.status === 400, `status ${twice.status}`);
  const pendingEdit = await api(tEstimator, 'PUT', `/costings/${sourceId}/sheet`, { title: `${TAG} changed under the approver` });
  check('a costing with the approver cannot be edited', pendingEdit.status === 400, `status ${pendingEdit.status}`);
  const pendingDelete = await api(tManager, 'DELETE', `/costings/${sourceId}`);
  check('nor deleted', pendingDelete.status === 400 || pendingDelete.status === 403, `status ${pendingDelete.status}`);
  const request = await prisma.approvalRequest.findFirst({ where: { documentType: 'costing', documentId: sourceId, status: 'PENDING' } });
  check('the approval request is raised in the author\'s name', request?.requesterId === estimator.id);
  await act({ requestId: request!.id, userId: approver.id, action: 'APPROVED' });
  const finalised = await api(tEstimator, 'GET', `/costings/${sourceId}`);
  check('the source costing is FINAL once approved', finalised.status === 200 && finalised.body.status === 'FINAL', String(finalised.body.status));
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

  // ══ The arithmetic: the page's copy is the server's ════════════════════════
  console.log('The arithmetic');

  let seed = 20260930;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  let mathAgree = true;
  let mathDetail = '';
  for (let n = 0; n < 400; n++) {
    const lines = Array.from({ length: 1 + Math.floor(rand() * 8) }, () => ({
      quantity: (Math.floor(rand() * 100000) / 1000).toString(),
      unitCost: (Math.floor(rand() * 10000000) / 100).toString(),
      isHeading: rand() < 0.1,
    }));
    const rates = {
      markupPct: (Math.floor(rand() * 20000) / 10000).toString(),
      contingencyPct: (Math.floor(rand() * 1000) / 10000).toString(),
      discountAmount: (Math.floor(rand() * 100000) / 100).toString(),
      vatRate: rand() < 0.3 ? '0' : '0.12',
    };
    const a = JSON.stringify(serverMath.costingFigures(lines, rates));
    const b = JSON.stringify(webMath.costingFigures(lines, rates));
    if (a !== b) {
      mathAgree = false;
      mathDetail = `${a} vs ${b}`;
      break;
    }
  }
  check('400 random sheets: web/src/lib/costingMath equals the server\'s to the centavo', mathAgree, mathDetail);
  const plansAgree =
    JSON.stringify(serverMath.planTasks([{ durationDays: 0, tasks: [{ durationDays: 2 }, { startDay: 9, durationDays: 3 }, { durationDays: 0 }] }])) ===
    JSON.stringify(webMath.planTasks([{ durationDays: 0, tasks: [{ durationDays: 2 }, { startDay: 9, durationDays: 3 }, { durationDays: 0 }] }]));
  check('and its plan is the server\'s plan', plansAgree);
  check('a line amount is exact where a float is not: 0.1 × 3 = 0.30', serverMath.lineAmount('3', '0.1') === 0.3);
  check('quantity to three places, cost to two: 1.005 × 99.99 = 100.49', serverMath.lineAmount('1.005', '99.99') === 100.49);
  const f = serverMath.costingFigures([{ quantity: 1, unitCost: 55471.43 }], { markupPct: 1.0925, contingencyPct: 0, discountAmount: 0, vatRate: 0.12 });
  check(
    'markup and VAT round once each, half away from zero',
    f.markupAmount === 60602.54 && f.contractValue === 116073.97 && f.vatAmount === 13928.88 && f.grandTotal === 130002.85,
    JSON.stringify(f),
  );
  check(
    'codes run 101, 102 in a bucket and restart at 201 in the next; a subheading has none',
    JSON.stringify(serverMath.lineCodes([{ rank: 1 }, { rank: 1, isHeading: true }, { rank: 1 }, { rank: 2 }])) === JSON.stringify(['101', null, '102', '201']),
  );

  // ══ The sheet: one save ═════════════════════════════════════════════════════
  console.log('The sheet');

  const allCats = await prisma.costCategory.findMany({ orderBy: { sortOrder: 'asc' } });
  const [mat, eqp, lab] = allCats;
  const costingCounter = async () =>
    (await prisma.numberSequence.findMany({ where: { documentType: 'costing' } })).reduce((n, r) => n + r.lastNumber, 0);

  const counterBefore = await costingCounter();
  const refused = await api(tEstimator, 'POST', '/costings', {
    title: `${TAG} refused sheet`,
    lines: [{ costCategoryId: 'no-such-category', name: 'Anything', quantity: 1, unitCost: 1 }],
  });
  check('a sheet naming a cost category that does not exist is refused', refused.status === 400, `status ${refused.status}`);
  check('and burns no number', (await costingCounter()) === counterBefore);
  const unnamed = await api(tEstimator, 'POST', '/costings', {
    title: `${TAG} refused sheet`,
    lines: [{ costCategoryId: mat.id, quantity: 1, unitCost: 1 }],
  });
  check('a line with neither name nor description is refused', unnamed.status === 400, `status ${unnamed.status}`);
  const oddVat = await api(tEstimator, 'POST', '/costings', { title: `${TAG} odd VAT`, vatRate: 0.05 });
  check('a VAT rate that is neither the company rate nor 0% is refused', oddVat.status === 400, `status ${oddVat.status}`);

  const sheet = {
    title: `${TAG} Booster VFD controller`,
    customerId: customer.id,
    siteId: site.id,
    systemUnit: `${TAG} Booster pump controller`,
    validUntil: '2026-10-30',
    markupPct: 0.5,
    contingencyPct: 0.05,
    discountAmount: 100,
    vatRate: 0,
    terms: `${TAG} terms: 50% down payment`,
    notes: 'Internal only',
    lines: [
      { costCategoryId: mat.id, isHeading: true, name: 'Panel' },
      { costCategoryId: mat.id, name: `${TAG} VFD 15KW`, description: 'Variable frequency drive', quantity: 2, unit: 'unit', unitCost: 45000.5 },
      { costCategoryId: mat.id, name: `${TAG} Consumables`, quantity: 1, unit: 'lot', unitCost: 3000 },
      { costCategoryId: lab.id, name: `${TAG} Assembly and programming`, quantity: 1, unit: 'lot', unitCost: 39400 },
    ],
    sections: [
      {
        kind: 'MAIN_WORK',
        name: 'Planning & mobilization',
        tasks: [
          { name: `${TAG} Kick-off`, durationDays: 1 },
          { name: `${TAG} Procurement`, startDay: 2, durationDays: 14 },
        ],
      },
      { kind: 'MAIN_WORK', name: 'Controller assembly', tasks: [{ name: `${TAG} Wiring`, durationDays: 3 }] },
      { kind: 'TURNOVER', name: 'Turnover', durationDays: 2, tasks: [] },
    ],
    spread: true,
  };
  const created = await api(tEstimator, 'POST', '/costings', sheet);
  check('POST /costings writes the header, lines and scope in one save', created.status === 201, `status ${created.status}: ${JSON.stringify(created.body).slice(0, 300)}`);
  const sheetId = created.body.id as string;
  const stored = await prisma.costing.findUnique({
    where: { id: sheetId },
    include: { lines: { orderBy: { sortOrder: 'asc' } }, scopeSections: { orderBy: { sortOrder: 'asc' }, include: { tasks: { orderBy: { sortOrder: 'asc' } } } } },
  });
  // 2 × 45,000.50 + 3,000 + 39,400 = 132,401 cost.
  const expected = serverMath.costingFigures(
    sheet.lines.map((l) => ({ quantity: l.quantity ?? 0, unitCost: l.unitCost ?? 0, isHeading: l.isHeading })),
    { markupPct: 0.5, contingencyPct: 0.05, discountAmount: 100, vatRate: 0 },
  );
  check('the stored cost is the sum of the lines', money(num(stored?.totalCost), 132401), String(num(stored?.totalCost)));
  check(
    'the contract value is cost + markup + contingency − discount, as the page computes it',
    money(num(stored?.contractValue), expected.contractValue) && money(expected.contractValue, 132401 + 66200.5 + 6620.05 - 100),
    `${num(stored?.contractValue)} vs ${expected.contractValue}`,
  );
  check('the header fields are kept (system / unit, valid until, contingency, VAT 0%)',
    stored?.systemUnit === sheet.systemUnit &&
      stored?.validUntil?.toISOString().slice(0, 10) === '2026-10-30' &&
      num(stored?.contingencyPct) === 0.05 &&
      num(stored?.vatRate) === 0,
  );
  check('the subheading is stored as a heading that costs nothing', stored?.lines[0].isHeading === true && num(stored?.lines[0].amount) === 0);
  check('a line typed as a name alone carries it as its description too', stored?.lines[2].description === `${TAG} Consumables` && stored?.lines[2].name === `${TAG} Consumables`);
  const createdLines = rows(created.body.lines);
  check(
    'the response codes the lines 101, 102 and 301 (Labor is the third bucket), the subheading none',
    JSON.stringify(createdLines.map((l) => l.code)) === JSON.stringify([null, '101', '102', '301']),
    JSON.stringify(createdLines.map((l) => l.code)),
  );
  check(
    'a task with no start day follows the one before it; one with a start day keeps it',
    stored?.scopeSections[0].tasks[0].startDay === null && stored?.scopeSections[0].tasks[1].startDay === 2,
  );
  const planned = rows(created.body.scopeSections);
  const plannedTasks = planned.map((s) => rows(s.tasks).map((t) => `${t.start}-${t.end}`).join(',')).join('|');
  check('the plan reads Day 1, Day 2–15, then Day 16–18', plannedTasks === '1-1,2-15|16-18|', plannedTasks);
  check(
    'a phase with tasks lasts as long as they do; one without keeps its typed duration',
    stored?.scopeSections[0].durationDays === 15 && stored?.scopeSections[1].durationDays === 3 && stored?.scopeSections[2].durationDays === 2,
    stored?.scopeSections.map((x) => x.durationDays).join(','),
  );
  check('the costing lasts as long as its plan (18 working days)', stored?.durationDays === 18, String(stored?.durationDays));
  check(
    'spread: the schedule of values adds up to the contract value exactly',
    money(stored!.scopeSections.reduce((n, x) => n + num(x.value), 0), num(stored?.contractValue)),
  );
  check('the created lead-less sheet belongs to its author', stored?.ownerId === estimator.id);

  // PUT: rows keep their ids, removed rows go, new rows arrive.
  const keepLine = stored!.lines[1];
  const put = await api(tEstimator, 'PUT', `/costings/${sheetId}/sheet`, {
    ...sheet,
    title: `${TAG} Booster VFD controller rev`,
    vatRate: 0.12,
    lines: [
      { id: keepLine.id, costCategoryId: mat.id, name: keepLine.name, description: 'Variable frequency drive, 15 kW', quantity: 3, unit: 'unit', unitCost: 45000.5 },
      { costCategoryId: eqp.id, name: `${TAG} Crane hire`, quantity: 1, unit: 'day', unitCost: 8000 },
    ],
    sections: [
      {
        id: stored!.scopeSections[0].id,
        kind: 'MAIN_WORK',
        name: 'Planning & mobilization',
        tasks: [{ id: stored!.scopeSections[0].tasks[0].id, name: `${TAG} Kick-off meeting`, durationDays: 2 }],
      },
    ],
  });
  check('PUT /costings/:id/sheet saves', put.status === 200, `status ${put.status}: ${JSON.stringify(put.body).slice(0, 200)}`);
  const afterPut = await prisma.costing.findUnique({
    where: { id: sheetId },
    include: { lines: { orderBy: { sortOrder: 'asc' } }, scopeSections: { include: { tasks: true } } },
  });
  check('a line sent with its id is updated in place, not recreated', afterPut?.lines[0].id === keepLine.id && num(afterPut?.lines[0].quantity) === 3);
  check('lines left out are removed and new ones created', afterPut?.lines.length === 2 && afterPut.lines[1].name === `${TAG} Crane hire`);
  check('phases and tasks likewise', afterPut?.scopeSections.length === 1 && afterPut.scopeSections[0].id === stored!.scopeSections[0].id && afterPut.scopeSections[0].tasks.length === 1 && afterPut.scopeSections[0].tasks[0].id === stored!.scopeSections[0].tasks[0].id);
  check('the totals follow: 3 × 45,000.50 + 8,000 = 143,001.50', money(num(afterPut?.totalCost), 143001.5), String(num(afterPut?.totalCost)));
  check('VAT switched on at the company rate', num(afterPut?.vatRate) > 0);
  const putBody = put.body;
  check(
    'the grand total is the contract value plus its VAT',
    money(Number(putBody.grandTotal), Number(putBody.contractValue) + Number(putBody.vatAmount)) && Number(putBody.vatAmount) > 0,
  );
  const colleaguePut = await api(tColleague, 'PUT', `/costings/${sheetId}/sheet`, { title: `${TAG} not mine` });
  check("a colleague with own-scope editing cannot save somebody else's sheet", colleaguePut.status === 403, `status ${colleaguePut.status}`);
  const audit = await prisma.auditLog.findFirst({ where: { entityType: 'costing', entityId: sheetId, action: 'UPDATED', actorId: estimator.id } });
  check('the save is audited', !!audit);

  // ══ Predictions ═════════════════════════════════════════════════════════════
  console.log('Predictions');

  await prisma.item.create({ data: { code: `${TAG}-ITEM1`, name: `${TAG} VFD Keypad`, unit: 'pc', standardCost: D(1500) } });
  const mine = await api(tEstimator, 'GET', `/costings/suggest?q=${encodeURIComponent(`${TAG} VFD`)}`);
  const mineRows = rows(mine.body);
  const fromHistory = mineRows.find((r) => r.source === 'history' && r.name === keepLine.name);
  check('typing a past line\'s name offers it, at its last unit cost and unit', !!fromHistory && fromHistory.unitCost === 45000.5 && fromHistory.unit === 'unit', JSON.stringify(mineRows).slice(0, 300));
  check('and items from the item master, at their standard cost', mineRows.some((r) => r.source === 'item' && r.name === `${TAG} VFD Keypad` && r.unitCost === 1500));
  const theirs = await api(tColleague, 'GET', `/costings/suggest?q=${encodeURIComponent(`${TAG} VFD`)}`);
  check(
    "own scope: a colleague is never offered somebody else's unit costs",
    !rows(theirs.body).some((r) => r.source === 'history') && rows(theirs.body).some((r) => r.source === 'item'),
  );
  const managerSees = await api(tManager, 'GET', `/costings/suggest?q=${encodeURIComponent(`${TAG} VFD`)}`);
  check('view_all: everyone\'s history is offered', rows(managerSees.body).some((r) => r.source === 'history'));
  const lists = await api(tEstimator, 'GET', '/costings/suggest/lists');
  check(
    'the lists offer used units, System / Unit names and task names, and your last terms',
    (lists.body.units as string[]).includes('unit') &&
      (lists.body.systemUnits as string[]).includes(sheet.systemUnit) &&
      (lists.body.tasks as string[]).includes(`${TAG} Kick-off meeting`) &&
      lists.body.terms === sheet.terms &&
      typeof lists.body.companyVatRate === 'number',
    JSON.stringify(lists.body).slice(0, 300),
  );
  check('a search under two characters answers nothing', rows((await api(tEstimator, 'GET', '/costings/suggest?q=Z')).body).length === 0);

  // ══ Templates ═══════════════════════════════════════════════════════════════
  console.log('Templates');

  const fromCosting = await api(tEstimator, 'POST', '/costings/templates', { name: `${TAG} VFD template`, costingId: sheetId, withPrices: false });
  check('a template is saved from a costing', fromCosting.status === 201, `status ${fromCosting.status}`);
  const tpl = await api(tColleague, 'GET', `/costings/templates/${fromCosting.body.id}`);
  check('anyone who reads costings can open it', tpl.status === 200);
  const tplLines = rows(tpl.body.lines);
  check('without prices, every unit cost is zero but the quantities stay', tplLines.length === 2 && tplLines.every((l) => l.unitCost === 0) && tplLines[0].quantity === 3);
  check('its lines come back with category ids resolved from their codes', tplLines[0].costCategoryId === mat.id && tplLines[1].costCategoryId === eqp.id);
  check('its phases and tasks come along', rows(tpl.body.sections).length === 1 && rows(rows(tpl.body.sections)[0].tasks).length === 1);
  const fromSheet = await api(tColleague, 'POST', '/costings/templates', {
    name: `${TAG} sheet template`,
    sheet: { markupPct: 0.3, lines: [{ costCategoryId: lab.id, name: 'Technician', quantity: 2, unit: 'day', unitCost: 1800 }], sections: [] },
  });
  check('a template is saved from an unsaved sheet', fromSheet.status === 201, `status ${fromSheet.status}`);
  const list = await api(tEstimator, 'GET', '/costings/templates');
  const listed = rows(list.body).filter((t) => (t.name as string).startsWith(TAG));
  check('the list shows both, with counts and who may change each', listed.length === 2 && listed.some((t) => t.canEdit === false) && listed.some((t) => t.canEdit === true && t.lineCount === 2));
  const notYours = await api(tEstimator, 'DELETE', `/costings/templates/${fromSheet.body.id}`);
  check("own scope: a template somebody else saved cannot be deleted", notYours.status === 403, `status ${notYours.status}`);
  const rename = await api(tEstimator, 'PATCH', `/costings/templates/${fromCosting.body.id}`, { name: `${TAG} VFD template v2` });
  check('the author renames their own', rename.status === 200 && rename.body.name === `${TAG} VFD template v2`);
  const readerSaves = await api(tReader, 'POST', '/costings/templates', { name: `${TAG} reader`, costingId: sheetId });
  check('without gops.costing.create no template is saved', readerSaves.status === 403, `status ${readerSaves.status}`);
  const gone = await api(tColleague, 'DELETE', `/costings/templates/${fromSheet.body.id}`);
  check('the author deletes their own', gone.status === 200 && !(await prisma.costingTemplate.findUnique({ where: { id: fromSheet.body.id as string } })));

  // ══ Approval both ways, and the printout ════════════════════════════════════
  console.log('Approval and the estimate');

  const empty = await api(tEstimator, 'POST', '/costings', { title: `${TAG} nothing in it` });
  const emptySubmit = await api(tEstimator, 'POST', `/costings/${empty.body.id}/submit`);
  check('a costing with no cost lines is not submitted', emptySubmit.status === 400, `status ${emptySubmit.status}`);
  check('and stays a draft', (await prisma.costing.findUnique({ where: { id: empty.body.id as string } }))?.status === 'DRAFT');

  await api(tEstimator, 'POST', `/costings/${sheetId}/submit`);
  const rejectReq = await prisma.approvalRequest.findFirst({ where: { documentType: 'costing', documentId: sheetId, status: 'PENDING' } });
  await act({ requestId: rejectReq!.id, userId: approver.id, action: 'REJECTED', comment: 'Recheck the crane' });
  check('a rejected costing comes back to draft to rework', (await prisma.costing.findUnique({ where: { id: sheetId } }))?.status === 'DRAFT');
  await api(tEstimator, 'POST', `/costings/${sheetId}/submit`);
  const approveReq = await prisma.approvalRequest.findFirst({ where: { documentType: 'costing', documentId: sheetId, status: 'PENDING' } });
  await act({ requestId: approveReq!.id, userId: approver.id, action: 'APPROVED' });
  check('resubmitted and approved, it is FINAL', (await prisma.costing.findUnique({ where: { id: sheetId } }))?.status === 'FINAL');
  const reopen = await api(tEstimator, 'PATCH', `/costings/${sheetId}`, { status: 'DRAFT' });
  check('the author can still reopen a final costing', reopen.status === 200 && reopen.body.status === 'DRAFT');
  await api(tEstimator, 'POST', `/costings/${sheetId}/submit`);
  const again = await prisma.approvalRequest.findFirst({ where: { documentType: 'costing', documentId: sheetId, status: 'PENDING' } });
  await act({ requestId: again!.id, userId: approver.id, action: 'APPROVED' });

  // The estimate: a PDF with the landscape Scope of Work page after it.
  await prisma.scopeTask.create({ data: { scopeSectionId: afterPut!.scopeSections[0].id, name: `${TAG} Long task`, startDay: 3, durationDays: 20, sortOrder: 5 } });
  const pdfRes = await fetch(`${BASE}/costings/${sheetId}/pdf`, { headers: { Authorization: `Bearer ${tEstimator}` } });
  const pdf = Buffer.from(await pdfRes.arrayBuffer());
  const pdfText = pdf.toString('latin1');
  check('GET /costings/:id/pdf renders a PDF', pdfRes.status === 200 && pdfRes.headers.get('content-type') === 'application/pdf' && pdfText.startsWith('%PDF'));
  const pages = (pdfText.match(/\/Type \/Page\b/g) ?? []).length;
  check('the estimate is followed by the Scope of Work on its own page', pages >= 2, `${pages} page(s)`);
  check('that page is landscape', /\/MediaBox \[0 0 841\.89 595\.28\]/.test(pdfText));
  const colleaguePdf = await fetch(`${BASE}/costings/${sheetId}/pdf`, { headers: { Authorization: `Bearer ${tColleague}` } });
  check("own scope: a colleague cannot print somebody else's estimate", colleaguePdf.status === 403, `status ${colleaguePdf.status}`);

  // Duplicate carries the sheet's new fields.
  const dupSheet = await api(tEstimator, 'POST', `/costings/${sheetId}/duplicate`);
  const dupStored = await prisma.costing.findUnique({ where: { id: dupSheet.body.id as string }, include: { scopeSections: { include: { tasks: true } }, lines: true } });
  check(
    'a duplicate keeps names, contingency, VAT, System / Unit and task start days — but not the validity date',
    dupStored?.lines.every((l) => !!l.name) === true &&
      num(dupStored?.contingencyPct) === 0.05 &&
      num(dupStored?.vatRate) > 0 &&
      dupStored?.systemUnit === sheet.systemUnit &&
      dupStored?.scopeSections[0].tasks.some((t) => t.startDay === 3) === true &&
      dupStored?.validUntil === null,
  );

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
