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
import { migrateCostingMargins } from '../src/shared/costingLegacy';
// Registers the costing's onApprovalSettled subscriber in this process.
import '../src/routes/costing';
import {
  flat,
  LANDSCAPE,
  pdfPieces,
  printed,
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

const money = (a: number, b: number) => Math.abs(a - b) < 0.005;

/** The sign-off block's text — from PREPARED BY to the strapline — one line, a wrapped name read whole. */
function signoffs(runs: string[]): string {
  const from = runs.indexOf('PREPARED BY');
  if (from < 0) return '';
  const tail = runs.slice(from);
  const end = tail.findIndex((r) => /WWW\.|^Page \d/.test(r));
  return (end < 0 ? tail : tail.slice(0, end)).join(' ').replace(/\s+/g, ' ').trim();
}
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
  // The seeded costing route (2026-10-09, the owner's call): the Technical
  // Manager reviews, the author's Team Leader ("Reports to") approves, CTG
  // gives the second approval. The signers hold the seeded roles; the team
  // leader is whoever the estimator reports to.
  const roleByKey = async (key: string) => {
    const role = await prisma.role.findUnique({ where: { key } });
    if (!role) throw new Error(`Expected the seeded ${key} role`);
    return role;
  };
  const technicalManagerRole = await roleByKey('technical_manager');
  // CTG is the CEO (Carter T. Gasiong): the executive role, as on every CEO step.
  const ctgRole = await roleByKey('executive');

  const estimator = await makeUser(`${TAG} Estimator`, `estimator${MAIL}`, [ownRole.id]);
  const colleague = await makeUser(`${TAG} Colleague`, `colleague${MAIL}`, [ownRole.id]);
  const manager = await makeUser(`${TAG} Manager`, `manager${MAIL}`, [allRole.id]);
  const reader = await makeUser(`${TAG} Reader`, `reader${MAIL}`, [readRole.id]);
  const reviewer = await makeUser(`${TAG} Technical Manager`, `techmgr${MAIL}`, [technicalManagerRole.id]);
  const teamLeader = await makeUser(`${TAG} Team Leader`, `teamleader${MAIL}`, [allRole.id]);
  const ctg = await makeUser(`${TAG} CEO`, `ctg${MAIL}`, [ctgRole.id]);
  await prisma.user.update({ where: { id: estimator.id }, data: { supervisorId: teamLeader.id } });

  /** The route's signatures, in the order given — each on the request still open. */
  async function signCosting(costingId: string, signers: { id: string; name: string }[]) {
    for (const signer of signers) {
      const request = await prisma.approvalRequest.findFirst({ where: { documentType: 'costing', documentId: costingId, status: 'PENDING' } });
      if (!request) throw new Error(`No open approval request on ${costingId} for ${signer.name} to sign`);
      await act({ requestId: request.id, userId: signer.id, action: 'APPROVED' });
    }
  }

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
    marginPct: 0.2,
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

  // ══ Assign costing from a lead ══════════════════════════════════════════════
  console.log('Assign costing from a lead');

  // A salesperson who works the lead but does not cost: they hand it over.
  const sellRole = await makeRole('zzcost_sell', `${TAG} salesperson`, ['gops.leads.view_own', 'gops.leads.edit_own']);
  const seller = await makeUser(`${TAG} Seller`, `seller${MAIL}`, [sellRole.id]);
  const tSeller = signToken(seller.id, seller.email);
  const sellersLead = await prisma.lead.create({
    data: {
      number: await nextNumber('lead'),
      status: 'QUALIFIED',
      companyName: `${TAG} assigned lead`,
      customerId: customer.id,
      siteId: site.id,
      description: 'Nitrogen generator\nsecond line',
      assignedToId: seller.id,
      createdById: seller.id,
    },
  });
  const costingsBefore = await prisma.costing.count();
  const toReader = await api(tSeller, 'POST', '/costings/assign', { leadId: sellersLead.id, assigneeId: reader.id });
  check(
    'assigning to someone who cannot make costings is refused, and names them',
    toReader.status === 400 && String(toReader.body.error ?? '').includes(reader.name) && (await prisma.costing.count()) === costingsBefore,
    `${toReader.status} ${JSON.stringify(toReader.body)}`,
  );
  const notTheirs = await api(tColleague, 'POST', '/costings/assign', { leadId: sellersLead.id, assigneeId: estimator.id });
  check('somebody who cannot edit the lead cannot assign its costing', notTheirs.status === 403, `status ${notTheirs.status}`);
  const assigned = await api(tSeller, 'POST', '/costings/assign', {
    leadId: sellersLead.id,
    assigneeId: estimator.id,
    note: 'Two units, need it by Friday',
  });
  check('the lead owner assigns a costing without the right to cost', assigned.status === 201, `${assigned.status} ${JSON.stringify(assigned.body)}`);
  const made = await prisma.costing.findUnique({ where: { id: String(assigned.body.id) } });
  check(
    "it is a DRAFT in the assignee's name, carrying the lead, its customer and site",
    made?.status === 'DRAFT' && made.ownerId === estimator.id && made.leadId === sellersLead.id && made.customerId === customer.id && made.siteId === site.id,
    JSON.stringify(made),
  );
  check(
    'it records who assigned it, when, and the note; the title is the company and the enquiry',
    made?.assignedById === seller.id && !!made.assignedAt && made.assignmentNote === 'Two units, need it by Friday' && made.title === `${TAG} assigned lead — Nitrogen generator`,
    `${made?.assignedById} ${made?.title}`,
  );
  const assignedLead = await prisma.lead.findUnique({ where: { id: sellersLead.id } });
  check('the lead moves to COSTING', assignedLead?.status === 'COSTING', assignedLead?.status);
  const toldEstimator = await prisma.notification.findFirst({ where: { userId: estimator.id, link: `/g-ops/costing/${made?.id}` } });
  check('the assignee is told, with the note', !!toldEstimator && (toldEstimator.body ?? '').includes('need it by Friday'), toldEstimator?.body ?? 'none');
  const assignAudit = await prisma.auditLog.findFirst({ where: { entityType: 'costing', entityId: made?.id, action: 'CREATED' } });
  check('and it is audited', !!assignAudit && (assignAudit.summary ?? '').includes(`to ${estimator.name}`), assignAudit?.summary ?? 'none');
  const leadPage = await api(tSeller, 'GET', `/leads/${sellersLead.id}`);
  const leadCosting = rows(leadPage.body.costings).find((c) => c.id === made?.id);
  check(
    'the lead page says whose it is and who assigned it',
    (leadCosting?.owner as Row | undefined)?.name === estimator.name && (leadCosting?.assignedBy as Row | undefined)?.name === seller.name && !!leadCosting?.assignedAt,
    JSON.stringify(leadCosting),
  );
  const estimatorSees = await api(tEstimator, 'GET', `/costings/${made?.id}`);
  check('the assignee can open and own it', estimatorSees.status === 200 && estimatorSees.body.canEdit === true, `status ${estimatorSees.status}`);
  await prisma.lead.update({ where: { id: sellersLead.id }, data: { status: 'LOST', lostReason: 'verify' } });
  const onLost = await api(tSeller, 'POST', '/costings/assign', { leadId: sellersLead.id, assigneeId: estimator.id });
  check('a lost lead takes no new costing', onLost.status === 400, `status ${onLost.status}`);

  // ══ Where it goes next: jobs on the costing ═════════════════════════════════
  console.log('Where it goes next');

  const categories = await prisma.costCategory.findMany({ orderBy: { sortOrder: 'asc' }, take: 2 });
  if (categories.length < 2) throw new Error('Expected the seeded cost categories');

  // A priced, FINAL costing with lines, sections and tasks — the source for
  // both the job link and the duplicate.
  const sourceId = fromNew.body.id as string;
  // Written the way the sheet editor writes it — one PUT, header, lines and
  // scope together (the per-line and per-section routes are gone). The tasks
  // fill their phases: 3 × 10 working days is the first phase's 30, the
  // purity test the second's 5.
  const sourceSheet = await api(tEstimator, 'PUT', `/costings/${sourceId}/sheet`, {
    title: fromNew.body.title,
    lines: [
      { costCategoryId: categories[0].id, description: 'Compressor', quantity: 2, unit: 'unit', unitCost: 150000 },
      { costCategoryId: categories[1].id, description: 'Installation crew', quantity: 12, unit: 'day', unitCost: 2500 },
    ],
    sections: [
      {
        kind: 'MAIN_WORK',
        name: 'Fabrication and installation',
        durationDays: 30,
        value: 300000,
        tasks: ['Foundation', 'Piping', 'Controls'].map((name) => ({ name, durationDays: 10 })),
      },
      {
        kind: 'TESTING_COMMISSIONING',
        name: 'Testing and commissioning',
        durationDays: 5,
        value: 96000,
        tasks: [{ name: 'Purity test', durationDays: 5 }],
      },
    ],
  });
  if (sourceSheet.status !== 200) throw new Error(`sheet save failed: ${JSON.stringify(sourceSheet.body)}`);
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
  let outOfTurn = false;
  try {
    await act({ requestId: request!.id, userId: ctg.id, action: 'APPROVED' });
  } catch {
    outOfTurn = true;
  }
  check('CTG cannot sign before the technical manager — the route runs in order', outOfTurn);
  await signCosting(sourceId, [reviewer, teamLeader]);
  check(
    'after the technical manager and the team leader it is still pending — FINAL takes every signature',
    (await prisma.costing.findUnique({ where: { id: sourceId } }))?.status === 'PENDING_APPROVAL',
  );
  const history = await api(tEstimator, 'GET', `/approvals/history/costing/${sourceId}`);
  const historyText = JSON.stringify(history.body);
  check(
    "the route is Technical Manager › Team Leader (the author's supervisor) › CTG, and the open step waits on CTG by name",
    history.status === 200 && historyText.includes('Technical Manager') && historyText.includes('Team Leader') && historyText.includes('CTG') && historyText.includes(ctg.name),
    historyText.slice(0, 400),
  );
  await signCosting(sourceId, [ctg]);
  const finalised = await api(tEstimator, 'GET', `/costings/${sourceId}`);
  check('the source costing is FINAL once approved', finalised.status === 200 && finalised.body.status === 'FINAL', String(finalised.body.status));
  // 2×150,000 + 12×2,500 = 330,000 cost; ÷ (1 − 0.2) = 412,500 contract.
  check('its contract value is cost ÷ (1 − margin)', money(Number(finalised.body.contractValue), 412500), String(finalised.body.contractValue));
  check('and the margin it reads is the 20% of the price it was given', Number(finalised.body.marginAmount) === 82500 && money(Number(finalised.body.grossMarginPct), 0.2), `${finalised.body.marginAmount} / ${finalised.body.grossMarginPct}`);
  const finalRow = await prisma.costing.findUnique({ where: { id: sourceId }, select: { finalAt: true } });
  check('approval dates it final (finalAt)', !!finalRow?.finalAt && Date.now() - finalRow.finalAt.getTime() < 60_000);

  // The Costing page's tiles: each is the total of the list it opens.
  const tiles = await api(tEstimator, 'GET', '/costings/summary');
  const listTotal = async (query: string) => Number((await api(tEstimator, 'GET', `/costings?${query}`)).body.total);
  const [draftTotal, pendingTotal, finalTotal] = await Promise.all([
    listTotal('status=DRAFT'),
    listTotal('status=PENDING_APPROVAL'),
    listTotal('finalised=this-month'),
  ]);
  check(
    'GET /costings/summary: each tile equals the total of the list it links to',
    tiles.status === 200 &&
      tiles.body.draft === draftTotal &&
      tiles.body.pending === pendingTotal &&
      tiles.body.finalThisMonth === finalTotal,
    `${JSON.stringify(tiles.body)} vs ${draftTotal}/${pendingTotal}/${finalTotal}`,
  );
  check(
    'the approved costing is final this month, and the draft is being costed',
    finalTotal >= 1 && draftTotal >= 1,
    `${finalTotal} final, ${draftTotal} draft`,
  );
  const colleagueTiles = await api(tColleague, 'GET', '/costings/summary');
  check(
    "an own-scope colleague's tiles count none of the estimator's costings",
    colleagueTiles.body.finalThisMonth === 0 && colleagueTiles.body.draft === 0,
    JSON.stringify(colleagueTiles.body),
  );

  // ── The printed list (rule 6, A5): GET /costings/pdf ────────────────────
  // The list's own query (`costingListWhere`), so the paper is the screen it
  // was printed off: the same set, the filters named, ?ids= ANDed with the
  // visibility rule, eight columns on landscape paper, audited.
  console.log('The printed costing list');
  const printList = async (token: string, query: string) => {
    const paper = await printed(token, `/costings/pdf?${query}`);
    const line = flat(paper.text);
    return { ...paper, line, flat: squash(line) };
  };
  const printedMine = await prisma.costing.findMany({
    where: { ownerId: estimator.id, title: { startsWith: TAG } },
    select: { id: true, number: true, title: true, contractValue: true, status: true },
  });
  const listedTotal = Number((await api(tEstimator, 'GET', `/costings?search=${encodeURIComponent(TAG)}&scope=all`)).body.total);
  const paper = await printList(tEstimator, `search=${encodeURIComponent(TAG)}&scope=all`);
  check(
    'GET /costings/pdf answers a PDF, on landscape paper — eight columns, the number column headed "Number"',
    paper.status === 200 && paper.type.startsWith('application/pdf') && paper.pages.length > 0 && paper.pages.every((pg) => pg === LANDSCAPE) &&
      paper.line.includes('NUMBER') && !paper.line.includes('NO.'),
    `${paper.status} ${paper.type}`,
  );
  check(
    'it prints the list as filtered: the count the list totals, every costing of the estimator’s, the search and the own scope named',
    printedMine.length >= 2 && listedTotal === printedMine.length && paper.line.includes(`${listedTotal} costings`) &&
      printedMine.every((c) => paper.flat.includes(c.number.replace(/ /g, ''))) &&
      paper.line.includes(`search "${TAG}"`) && paper.line.includes('mine only'),
    paper.line.slice(0, 400),
  );
  const listSum = printedMine.reduce((t, c) => t + Number(c.contractValue), 0);
  check(
    'its money names the code in the head, and its total is the contract values summed, the bold row last',
    paper.line.includes('CONTRACT VALUE (PHP)') && paper.line.includes('BUDGETED COST (PHP)') &&
      paper.line.includes(`Total contract value PHP ${listSum.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`),
    paper.line.slice(-300),
  );
  const finalOne = printedMine.find((c) => c.id === sourceId)!;
  const draftOne = printedMine.find((c) => c.status === 'DRAFT')!;
  const filtered = await printList(tEstimator, `search=${encodeURIComponent(TAG)}&status=FINAL`);
  check(
    'a filter narrows the paper as it narrows the list, and is named: status Final',
    filtered.status === 200 && filtered.line.includes('status Final') && filtered.flat.includes(finalOne.number) && !filtered.flat.includes(draftOne.number),
    filtered.line.slice(0, 300),
  );
  const picked = await printList(tEstimator, `ids=${finalOne.id}`);
  check(
    '?ids= prints the ticked costing alone, and says so',
    picked.status === 200 && picked.line.includes('1 costing') && picked.flat.includes(finalOne.number) && !picked.flat.includes(draftOne.number) &&
      picked.line.includes('the rows selected'),
    picked.line.slice(0, 300),
  );
  const pickedByColleague = await printList(tColleague, `ids=${finalOne.id}&scope=all`);
  check(
    '?ids= is ANDed with the visibility rule: an own-scope colleague ticking the estimator’s costing prints none of it',
    pickedByColleague.status === 200 && pickedByColleague.line.includes('0 costings') && !pickedByColleague.flat.includes(finalOne.number),
    pickedByColleague.line.slice(0, 300),
  );
  const badType = await fetch(`${BASE}/costings/pdf?jobType=NOPE`, { headers: { Authorization: `Bearer ${tEstimator}` } });
  check('an unknown project type is a 400, never a 500 from the database', badType.status === 400, String(badType.status));
  check(
    'printing the list is audited as an export, under the list',
    (await prisma.auditLog.count({ where: { entityType: 'costing', entityId: 'list', action: 'EXPORTED', actorId: estimator.id } })) >= 3,
  );

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
  check('the copy keeps the title, customer, site, margin and duration',
    copy?.title === source!.title &&
      copy?.customerId === source!.customerId &&
      copy?.siteId === source!.siteId &&
      num(copy?.marginPct) === num(source!.marginPct) &&
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
    money(num(copy?.totalCost), 330000) && money(num(copy?.contractValue), 412500),
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
      // A margin anywhere the API allows, −95% to 95%, to six decimals.
      marginPct: ((Math.floor(rand() * 1_900_000) - 950_000) / 1_000_000).toString(),
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
  const planSample = [
    { durationDays: 0, tasks: [{ durationDays: 2 }, { startDay: 9, durationDays: 3 }, { durationDays: 0 }] },
    { durationDays: 4, tasks: [] },
    { durationDays: 0, tasks: [] },
    { durationDays: 1, tasks: [{ durationDays: 5 }] },
  ];
  const serverPlan = serverMath.planTasks(planSample);
  const plansAgree = JSON.stringify(serverPlan) === JSON.stringify(webMath.planTasks(planSample));
  check('and its plan is the server\'s plan', plansAgree);
  check(
    'a phase with no tasks but a duration takes its place in the sequence; one with neither is unplanned and moves nothing',
    serverPlan.sections[1].start === 13 &&
      serverPlan.sections[1].end === 16 &&
      serverPlan.sections[2].start === null &&
      serverPlan.sections[2].days === 0 &&
      serverPlan.sections[3].start === 17 &&
      serverPlan.sections[3].end === 21 &&
      serverPlan.totalDays === 21,
    JSON.stringify(serverPlan),
  );
  check('a line amount is exact where a float is not: 0.1 × 3 = 0.30', serverMath.lineAmount('3', '0.1') === 0.3);
  check('quantity to three places, cost to two: 1.005 × 99.99 = 100.49', serverMath.lineAmount('1.005', '99.99') === 100.49);
  const f = serverMath.costingFigures([{ quantity: 1, unitCost: 55471.43 }], { marginPct: 0.522, vatRate: 0.12 });
  check(
    'the contract value (cost ÷ (1 − margin)) and VAT round once each, half away from zero',
    f.contractValue === 116049.02 && f.marginAmount === 60577.59 && f.vatAmount === 13925.88 && f.grandTotal === 129974.9,
    JSON.stringify(f),
  );
  check(
    'a 25% margin on 75,000 prices at 100,000; a negative margin prices below cost; 100% prices at cost rather than at infinity',
    serverMath.costingFigures([{ quantity: 1, unitCost: 75000 }], { marginPct: 0.25 }).contractValue === 100000 &&
      serverMath.costingFigures([{ quantity: 1, unitCost: 100 }], { marginPct: -0.25 }).contractValue === 80 &&
      serverMath.costingFigures([{ quantity: 1, unitCost: 100 }], { marginPct: 1 }).contractValue === 100,
  );
  check('vatOn() is VAT on a stored amount, rounded once', serverMath.vatOn('116049.02', '0.12') === 13925.88 && webMath.vatOn('116049.02', '0.12') === 13925.88);
  check('a 25% markup on cost is a 20% margin on the price', serverMath.marginOfMarkup(0.25) === 0.2 && webMath.marginOfMarkup(0.25) === 0.2);
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
    marginPct: 0.35,
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
    { marginPct: 0.35, vatRate: 0 },
  );
  check('the stored cost is the sum of the lines', money(num(stored?.totalCost), 132401), String(num(stored?.totalCost)));
  check(
    'the contract value is cost ÷ (1 − margin), as the page computes it: 132,401 ÷ 0.65',
    money(num(stored?.contractValue), expected.contractValue) && money(expected.contractValue, 203693.85),
    `${num(stored?.contractValue)} vs ${expected.contractValue}`,
  );
  check('the header fields are kept (system / unit, valid until, margin, VAT 0%)',
    stored?.systemUnit === sheet.systemUnit &&
      stored?.validUntil?.toISOString().slice(0, 10) === '2026-10-30' &&
      num(stored?.marginPct) === 0.35 &&
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
  check(
    'the taskless third phase is planned after the second, Day 19–20',
    planned[2]?.startDay === 19 && planned[2]?.endDay === 20 && planned[2]?.planDays === 2,
    JSON.stringify(planned[2]),
  );
  check('the costing lasts as long as its plan (20 working days, the taskless phase included)', stored?.durationDays === 20, String(stored?.durationDays));
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
    sheet: { marginPct: 0.3, lines: [{ costCategoryId: lab.id, name: 'Technician', quantity: 2, unit: 'day', unitCost: 1800 }], sections: [] },
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
  await act({ requestId: rejectReq!.id, userId: reviewer.id, action: 'REJECTED', comment: 'Recheck the crane' });
  check('a costing the technical manager rejects comes back to draft to rework', (await prisma.costing.findUnique({ where: { id: sheetId } }))?.status === 'DRAFT');
  await api(tEstimator, 'POST', `/costings/${sheetId}/submit`);
  await signCosting(sheetId, [reviewer, teamLeader, ctg]);
  check('resubmitted and signed by all three, it is FINAL', (await prisma.costing.findUnique({ where: { id: sheetId } }))?.status === 'FINAL');
  const reopen = await api(tEstimator, 'PATCH', `/costings/${sheetId}`, { status: 'DRAFT' });
  check('the author can still reopen a final costing', reopen.status === 200 && reopen.body.status === 'DRAFT');
  // Reopened, its last request (approved) is no longer its approval: the
  // paper prints the route submitting it now would take, every step open.
  const reopened = signoffs(pdfPieces(Buffer.from(await (await fetch(`${BASE}/costings/${sheetId}/pdf`, { headers: { Authorization: `Bearer ${tEstimator}` } })).arrayBuffer())));
  check(
    'a reopened costing prints the route anew — all three steps Pending, none of the old signatures dated',
    (reopened.match(/Pending/g) ?? []).length === 3 && reopened.includes(`TECHNICAL MANAGER ${reviewer.name}`),
    reopened,
  );
  await api(tEstimator, 'POST', `/costings/${sheetId}/submit`);
  await signCosting(sheetId, [reviewer, teamLeader, ctg]);

  // The estimate: a PDF with the landscape Scope of Work page after it.
  await prisma.scopeTask.create({ data: { scopeSectionId: afterPut!.scopeSections[0].id, name: `${TAG} Long task`, startDay: 3, durationDays: 20, sortOrder: 5 } });
  const pdfRes = await fetch(`${BASE}/costings/${sheetId}/pdf`, { headers: { Authorization: `Bearer ${tEstimator}` } });
  const pdf = Buffer.from(await pdfRes.arrayBuffer());
  const pdfRaw = pdf.toString('latin1');
  check('GET /costings/:id/pdf renders a PDF', pdfRes.status === 200 && pdfRes.headers.get('content-type') === 'application/pdf' && pdfRaw.startsWith('%PDF'));
  const pages = (pdfRaw.match(/\/Type \/Page\b/g) ?? []).length;
  check('the estimate is followed by the Scope of Work on its own page', pages >= 2, `${pages} page(s)`);
  check('that page is landscape', /\/MediaBox \[0 0 841\.89 595\.28\]/.test(pdfRaw));
  const colleaguePdf = await fetch(`${BASE}/costings/${sheetId}/pdf`, { headers: { Authorization: `Bearer ${tColleague}` } });
  check("own scope: a colleague cannot print somebody else's estimate", colleaguePdf.status === 403, `status ${colleaguePdf.status}`);

  // Rule 6: the sign-offs are the route as the workflow names its steps —
  // in capitals, nothing added — each under who signed it; the author only
  // ever as PREPARED BY, never as an approver.
  const runs = pdfPieces(pdf);
  const signed = signoffs(runs);
  check(
    'the estimate signs off PREPARED BY the author, then TECHNICAL MANAGER, TEAM LEADER and CEO (CTG) by their steps’ names',
    signed.startsWith(`PREPARED BY ${estimator.name} `) &&
      signed.includes(`TECHNICAL MANAGER ${reviewer.name} `) &&
      signed.includes(`TEAM LEADER ${teamLeader.name} `) &&
      signed.includes(`CEO (CTG) ${ctg.name} `) &&
      !signed.includes('APPROVED BY') &&
      !signed.includes('Pending'),
    signed,
  );
  check(
    'each signer with how to reach them, the author too',
    runs.includes(estimator.email) && runs.includes(reviewer.email) && runs.includes(ctg.email),
  );
  check(
    'its money block reads as the quotation’s — Subtotal, VAT (12%), Total, the bold row last — and no GRAND TOTAL',
    runs.includes('Subtotal') && runs.some((r) => /^VAT \(\d+(\.\d+)?%\)$/.test(r)) && runs.includes('Total') && !runs.includes('GRAND TOTAL') &&
      runs.indexOf('Total') > runs.indexOf('Subtotal'),
    runs.filter((r) => /total|VAT|Margin|cost/i.test(r)).join(' | '),
  );
  check('its money columns name the code in the head', runs.includes('AMOUNT (PHP)') || runs.join(' ').includes('AMOUNT (PHP)'));
  check('the validity prints as a record’s date (October 30, 2026)', runs.some((r) => r.includes('Valid until: October 30, 2026')), runs.filter((r) => r.includes('Valid')).join(' | '));
  check(
    'printing the estimate is audited as an export',
    !!(await prisma.auditLog.findFirst({ where: { entityType: 'costing', entityId: sheetId, action: 'EXPORTED', actorId: estimator.id } })),
  );
  // A draft names who will sign each step, "Pending" under them.
  const drafted = signoffs(pdfPieces(Buffer.from(await (await fetch(`${BASE}/costings/${empty.body.id}/pdf`, { headers: { Authorization: `Bearer ${tEstimator}` } })).arrayBuffer())));
  check(
    'a draft prints the route it would take: each step by name, who is assigned, Pending under them — never the author',
    drafted.includes(`TECHNICAL MANAGER ${reviewer.name}`) && (drafted.match(/Pending/g) ?? []).length === 3 && !drafted.includes(`TECHNICAL MANAGER ${estimator.name}`),
    drafted,
  );

  // Duplicate carries the sheet's new fields.
  const dupSheet = await api(tEstimator, 'POST', `/costings/${sheetId}/duplicate`);
  const dupStored = await prisma.costing.findUnique({ where: { id: dupSheet.body.id as string }, include: { scopeSections: { include: { tasks: true } }, lines: true } });
  check(
    'a duplicate keeps names, margin, VAT, System / Unit and task start days — but not the validity date',
    dupStored?.lines.every((l) => !!l.name) === true &&
      num(dupStored?.marginPct) === 0.35 &&
      num(dupStored?.vatRate) > 0 &&
      dupStored?.systemUnit === sheet.systemUnit &&
      dupStored?.scopeSections[0].tasks.some((t) => t.startDay === 3) === true &&
      dupStored?.validUntil === null,
  );

  // A FINAL costing prints the approval that made it final — and none when
  // none stands behind it: reopened and made final again with no route (a
  // project built on the draft, written here as `costingForJob` writes it),
  // or returned by the approver and then made final that way. Nobody will
  // ever sign that route, so neither the old signatures nor "Pending" print.
  const finalSignoffs = async (id: string) =>
    signoffs(pdfPieces(Buffer.from(await (await fetch(`${BASE}/costings/${id}/pdf`, { headers: { Authorization: `Bearer ${tEstimator}` } })).arrayBuffer())));
  const noRoute = (s: string) => s.startsWith(`PREPARED BY ${estimator.name}`) && !/TECHNICAL MANAGER|TEAM LEADER|CEO \(CTG\)|APPROVED BY|Pending/.test(s);
  const reopenAgain = await api(tEstimator, 'PATCH', `/costings/${sheetId}`, { status: 'DRAFT' });
  await prisma.costing.update({ where: { id: sheetId }, data: { status: 'FINAL', finalAt: new Date() } });
  const staleFinal = await finalSignoffs(sheetId);
  check(
    'reopened and made final again with no route behind it, it prints PREPARED BY alone — never the signatures it was reopened from',
    reopenAgain.status === 200 && noRoute(staleFinal),
    staleFinal,
  );
  const returned = await api(tEstimator, 'POST', '/costings', {
    title: `${TAG} returned then built on`,
    lines: [{ costCategoryId: mat.id, name: `${TAG} Returned line`, quantity: 1, unit: 'lot', unitCost: 1000 }],
  });
  await api(tEstimator, 'POST', `/costings/${returned.body.id}/submit`);
  await signCosting(returned.body.id as string, [reviewer]);
  const returnReq = await prisma.approvalRequest.findFirst({ where: { documentType: 'costing', documentId: returned.body.id as string, status: 'PENDING' } });
  await act({ requestId: returnReq!.id, userId: teamLeader.id, action: 'REJECTED', comment: 'Not this one' });
  await prisma.costing.update({ where: { id: returned.body.id as string }, data: { status: 'FINAL', finalAt: new Date() } });
  const returnedFinal = await finalSignoffs(returned.body.id as string);
  check(
    'returned by the team leader and then made final by a project, it prints no step of the returned request — signed or Pending',
    returned.status === 201 && !!returnReq && noRoute(returnedFinal),
    returnedFinal,
  );

  // ══ The margin rule, the sixth bucket and the carry-over ═══════════════════
  console.log('Margin, Contingency and the carry-over from the markup rule');

  const con = await prisma.costCategory.findUnique({ where: { code: 'CON' } });
  check('Contingency is the sixth system bucket', !!con && con.isSystem && con.sortOrder === 5, JSON.stringify(con));
  const tooMuch = await api(tEstimator, 'POST', '/costings', { title: `${TAG} no price`, marginPct: 0.95 });
  check('a margin of 95% or more is refused — at 100% there is no price', tooMuch.status === 400, `status ${tooMuch.status}`);
  const belowCost = await api(tEstimator, 'POST', '/costings', {
    title: `${TAG} below cost`,
    marginPct: -0.25,
    lines: [{ costCategoryId: mat.id, name: `${TAG} Loss leader`, quantity: 1, unit: 'lot', unitCost: 100 }],
  });
  check('a negative margin is a loss-making bid, priced below cost: −25% on 100 is 80', belowCost.status === 201 && belowCost.body.contractValue === 80, `${belowCost.status} ${belowCost.body.contractValue}`);

  // A costing priced under the markup rule: 100,000 cost, 20% markup, 5%
  // contingency, 1,000 discount → 124,000 contract (the stored fact).
  const legacy = await prisma.costing.create({
    data: {
      number: `${TAG}-LEGACY`,
      title: `${TAG} priced under the markup rule`,
      ownerId: estimator.id,
      markupPct: 0.2,
      contingencyPct: 0.05,
      discountAmount: 1000,
      totalCost: 100000,
      contractValue: 124000,
      lines: { create: [{ costCategoryId: mat.id, description: `${TAG} old line`, quantity: 1, unit: 'lot', unitCost: 100000, amount: 100000, sortOrder: 0 }] },
    },
  });
  const carried = await migrateCostingMargins({ ids: [legacy.id] });
  const after = await prisma.costing.findUnique({ where: { id: legacy.id }, include: { lines: { orderBy: { sortOrder: 'asc' } } } });
  const conLine = after?.lines.find((l) => l.costCategoryId === con?.id);
  check(
    'the carry-over writes the 5% contingency as a 5,000 line in the Contingency bucket',
    carried.costings === 1 && carried.contingencyLines === 1 && !!conLine && num(conLine.amount) === 5000 && conLine.sortOrder === 1 && conLine.name === 'Contingency',
    JSON.stringify({ carried, conLine }),
  );
  check('the cost now includes it and the contract value has not moved', num(after?.totalCost) === 105000 && num(after?.contractValue) === 124000, `${after?.totalCost} / ${after?.contractValue}`);
  check('the margin is derived from the stored contract value, to six decimals: 19,000 ÷ 124,000', num(after?.marginPct) === 0.153226, String(after?.marginPct));
  check('the legacy columns are zeroed', num(after?.markupPct) === 0 && num(after?.contingencyPct) === 0 && num(after?.discountAmount) === 0);
  const carriedAgain = await migrateCostingMargins({ ids: [legacy.id] });
  const afterAgain = await prisma.costing.findUnique({ where: { id: legacy.id }, include: { lines: true } });
  check('a second run finds nothing to carry over', carriedAgain.costings === 0 && afterAgain?.lines.length === 2 && num(afterAgain?.marginPct) === 0.153226);
  const viewed = await api(tEstimator, 'GET', `/costings/${legacy.id}`);
  check(
    'the carried-over costing reads its STORED figures — margin 19,000 on 124,000 — never a re-derivation from the rate',
    viewed.status === 200 && viewed.body.marginAmount === 19000 && viewed.body.contractValue === 124000 && viewed.body.totalCost === 105000 && viewed.body.grandTotal === 138880,
    JSON.stringify({ m: viewed.body.marginAmount, c: viewed.body.contractValue, t: viewed.body.totalCost, g: viewed.body.grandTotal }),
  );
  const oldTemplate = await prisma.costingTemplate.create({
    data: { name: `${TAG} old template`, body: { markupPct: 0.25, lines: [], sections: [] }, createdById: estimator.id },
  });
  const readOld = await api(tEstimator, 'GET', `/costings/templates/${oldTemplate.id}`);
  check('a template saved with a 25% markup reads as the 20% margin it amounts to', readOld.status === 200 && readOld.body.marginPct === 0.2, String(readOld.body.marginPct));

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
