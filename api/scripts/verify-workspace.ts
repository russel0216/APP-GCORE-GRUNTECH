/**
 * Workspace verification — My Work, global search and the approval queue.
 *
 *   npx tsx scripts/verify-workspace.ts      (the API must be running)
 *
 * The workspace is a view over every other module's records, and a view that
 * quietly shows nothing is worse than a screen that fails: a project manager
 * with five jobs reading "Nothing assigned to you" believes it. So the checks
 * here are about completeness and reach —
 *
 *   · every row /my-work returns carries a link that starts with `/`, because
 *     the row contract (audits plan §3 item 7) is what lets Home and My Work
 *     render a module's work without knowing the module;
 *   · a planned activity for today reaches todaysSchedule through the
 *     registerSchedule() seam, and a colleague's does not;
 *   · a view_own user finds their own lead in Ctrl+K and not a colleague's;
 *   · a purchase order is findable by its number and its hit deep-links;
 *   · the approval queue names who raised each document.
 *
 * Everything is checked over HTTP as the user the screen serves, with roles
 * this script makes for itself — a seeded role's membership is the operator's
 * business, and a test that depends on it breaks the moment somebody is hired.
 */

import zlib from 'node:zlib';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/prisma';
import { env } from '../src/env';
import { signToken } from '../src/auth/middleware';
import { nextNumber } from '../src/shared/numbering';
import { submitForApproval } from '../src/shared/approvals';

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

const D = (v: number) => new Prisma.Decimal(v);

const TAG = 'ZZWS';
const BASE = `http://localhost:${env.port}/api`;
const MAIL = '@verifyws.local';

// ── Test fixtures ────────────────────────────────────────────────────────────

async function cleanup() {
  await prisma.approvalRequest.deleteMany({ where: { documentType: { startsWith: TAG } } });
  await prisma.approvalWorkflow.deleteMany({ where: { documentType: { startsWith: TAG } } });
  await prisma.salesActivity.deleteMany({ where: { subject: { startsWith: TAG } } });
  await prisma.jobOrder.deleteMany({ where: { title: { startsWith: TAG } } });
  await prisma.serviceVisit.deleteMany({ where: { customer: { name: { startsWith: TAG } } } });
  await prisma.cashAdvance.deleteMany({ where: { purpose: { startsWith: TAG } } });
  await prisma.expenseClaim.deleteMany({ where: { purpose: { startsWith: TAG } } });
  await prisma.purchaseOrder.deleteMany({ where: { notes: { startsWith: TAG } } });
  await prisma.purchaseRequest.deleteMany({ where: { purpose: { startsWith: TAG } } });
  await prisma.quotation.deleteMany({ where: { subject: { startsWith: TAG } } });
  await prisma.lead.deleteMany({ where: { companyName: { startsWith: TAG } } });
  await prisma.leaveRequest.deleteMany({ where: { reason: { startsWith: TAG } } });
  await prisma.employee.deleteMany({ where: { employeeNo: { startsWith: TAG } } });
  await prisma.leaveType.deleteMany({ where: { code: { startsWith: TAG } } });
  await prisma.job.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.costing.deleteMany({ where: { title: { startsWith: TAG } } });
  await prisma.supplier.deleteMany({ where: { code: { startsWith: TAG } } });
  await prisma.customer.deleteMany({ where: { name: { startsWith: TAG } } });

  const users = await prisma.user.findMany({
    where: { email: { endsWith: MAIL } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await prisma.approvalAction.deleteMany({ where: { approverId: { in: ids } } });
    await prisma.approvalRequest.deleteMany({ where: { requesterId: { in: ids } } });
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
    await prisma.user.updateMany({ where: { supervisorId: { in: ids } }, data: { supervisorId: null } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.role.deleteMany({ where: { key: { startsWith: 'zzws_' } } });
}

/** A role holding exactly the permissions named. */
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

async function makeUser(name: string, email: string, roleIds: string[], supervisorId?: string) {
  return prisma.user.create({
    data: {
      name,
      email,
      passwordHash: await bcrypt.hash('x', 10),
      supervisorId: supervisorId ?? null,
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

/**
 * Readable text out of a rendered PDF — the same reader verify-foundation
 * uses. PDFKit Flate-compresses its content streams and writes text as hex
 * runs split at kerning pairs, so each TJ array is joined back into one piece.
 */
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
}

async function apiReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

interface Hit {
  kind: string;
  id: string;
  title: string;
  link: string;
}

interface WorkRow {
  id: string;
  kind: string;
  title: string;
  subtitle?: string;
  when?: string | null;
  overdue?: boolean;
  link: string;
}

interface ScheduleRow {
  kind: string;
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  link: string;
  meetLink: string | null;
  sub?: string;
}

interface MyWork {
  awaitingMyApproval: { id: string; link: string | null; requester?: { name: string } }[];
  myPendingSubmissions: { id: string; link: string | null }[];
  assignedToMe: WorkRow[];
  todaysSchedule: ScheduleRow[];
  myDrafts: WorkRow[];
  renewals: { id: string; kind: string; link: string }[];
}

const dateOnly = (d: Date) => new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
const daysFromToday = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return dateOnly(d);
};

// ── The run ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nG-CORE workspace verification\n');
  await cleanup();

  if (!(await apiReachable())) {
    console.error(`  ✗ The API is not answering at ${BASE}. Start it (cd api && npm run dev) and run again.`);
    console.error('    Every case here is an HTTP case; nothing was checked.\n');
    process.exitCode = 1;
    return;
  }

  // ══ Fixtures ═════════════════════════════════════════════════════════════

  const ownRole = await makeRole('zzws_own', `${TAG} Own scope`, [
    'gops.leads.view_own',
    'gops.leads.create',
    'gops.quotations.view_own',
  ]);
  const poRole = await makeRole('zzws_po', `${TAG} Purchase orders`, ['gchain.purchase_orders.view_all']);
  const renewalRole = await makeRole('zzws_renewals', `${TAG} Renewals`, ['gops.service_contracts.view_all']);

  const supervisor = await makeUser('ZZ Supervisor', `sup${MAIL}`, []);
  const worker = await makeUser('ZZ Worker', `worker${MAIL}`, [ownRole.id, poRole.id], supervisor.id);
  const colleague = await makeUser('ZZ Colleague', `colleague${MAIL}`, [ownRole.id]);
  const seller = await makeUser('ZZ Seller', `seller${MAIL}`, [renewalRole.id]);

  const workerToken = signToken(worker.id, worker.email);
  const colleagueToken = signToken(colleague.id, colleague.email);
  const supervisorToken = signToken(supervisor.id, supervisor.email);
  const sellerToken = signToken(seller.id, seller.email);

  const customer = await prisma.customer.create({ data: { code: `${TAG}-C1`, name: `${TAG} Hospital` } });
  const supplier = await prisma.supplier.create({ data: { code: `${TAG}-S1`, name: `${TAG} Steel Supply` } });

  const costing = await prisma.costing.create({
    data: {
      number: `${TAG}-COST-1`,
      title: `${TAG} Plant`,
      ownerId: worker.id,
      customerId: customer.id,
      totalCost: D(200_000),
      contractValue: D(250_000),
    },
  });
  const job = await prisma.job.create({
    data: {
      number: `${TAG}-PRJ-1`,
      name: `${TAG} Plant`,
      status: 'IN_PROGRESS',
      customerId: customer.id,
      costingId: costing.id,
      createdById: worker.id,
      projectManagerId: worker.id,
      contractValue: D(250_000),
      targetEndDate: daysFromToday(30),
    },
  });

  // ══ Assigned to me ═══════════════════════════════════════════════════════
  console.log('Assigned to me');

  const myLead = await prisma.lead.create({
    data: {
      number: `${TAG}-LEAD-1`,
      companyName: `${TAG} Oxygen Buyer`,
      assignedToId: worker.id,
      createdById: worker.id,
      nextAction: 'Call back about the sizing',
      nextActionDate: daysFromToday(-2),
    },
  });
  const theirLead = await prisma.lead.create({
    data: {
      number: `${TAG}-LEAD-2`,
      companyName: `${TAG} Rival Buyer`,
      assignedToId: colleague.id,
      createdById: colleague.id,
    },
  });
  await prisma.lead.create({
    data: {
      number: `${TAG}-LEAD-3`,
      companyName: `${TAG} Closed Buyer`,
      status: 'LOST',
      assignedToId: worker.id,
      createdById: worker.id,
    },
  });
  const task = await prisma.jobTask.create({
    data: { jobId: job.id, name: `${TAG} Pressure test`, assignedToId: worker.id, dueDate: daysFromToday(3) },
  });
  await prisma.jobTask.create({
    data: { jobId: job.id, name: `${TAG} Done already`, assignedToId: worker.id, status: 'DONE' },
  });
  const visit = await prisma.serviceVisit.create({
    data: {
      number: await nextNumber('service_visit'),
      customerId: customer.id,
      assignedToId: worker.id,
      dueDate: daysFromToday(5),
    },
  });
  const jobOrder = await prisma.jobOrder.create({
    data: {
      number: `${TAG}-JO-1`,
      status: 'APPROVED',
      customerId: customer.id,
      title: `${TAG} Compressor call-out`,
      description: 'Noise from the second stage',
      requestedFor: daysFromToday(1),
      requestedById: colleague.id,
      assignedToId: worker.id,
    },
  });
  const slipped = await prisma.salesActivity.create({
    data: {
      subject: `${TAG} Slipped follow-up`,
      assignedToId: worker.id,
      leadId: myLead.id,
      startsAt: new Date(Date.now() - 3 * 86400000),
    },
  });

  const work = await api(workerToken, 'GET', '/my-work');
  check('GET /my-work answers for a plain user', work.status === 200, String(work.status));
  const mw = work.body as unknown as MyWork;

  const byKind = (kind: string, id: string) => mw.assignedToMe.find((r) => r.kind === kind && r.id === id);
  check('the lead I am working on is assigned to me', !!byKind('lead', myLead.id));
  check(
    'a lead whose next action slipped is flagged overdue',
    byKind('lead', myLead.id)?.overdue === true,
    JSON.stringify(byKind('lead', myLead.id)),
  );
  check("a colleague's lead is not on my plate", !mw.assignedToMe.some((r) => r.id === theirLead.id));
  check(
    'a lost lead is off my plate',
    !mw.assignedToMe.some((r) => r.kind === 'lead' && r.title === `${TAG} Closed Buyer`),
  );
  check('the job I manage is assigned to me, and not overdue', byKind('job', job.id)?.overdue === false);
  check('the open task on my name is assigned to me', !!byKind('task', task.id));
  check('a DONE task is not', !mw.assignedToMe.some((r) => r.kind === 'task' && r.title === `${TAG} Done already`));
  check(
    'the visit I am booked on deep-links to the schedule sheet',
    byKind('visit', visit.id)?.link === `/g-ops/visits?visit=${visit.id}`,
    byKind('visit', visit.id)?.link,
  );
  check(
    'the approved job order I am to attend is assigned to me',
    byKind('job_order', jobOrder.id)?.link === `/g-ops/job-orders/${jobOrder.id}`,
  );
  check(
    'a planned activity that slipped past its day is on my plate, overdue',
    byKind('activity', slipped.id)?.overdue === true &&
      byKind('activity', slipped.id)?.link === `/g-ops/calendar/activities/${slipped.id}`,
  );
  check(
    'overdue rows come first',
    mw.assignedToMe.length > 0 &&
      mw.assignedToMe.findIndex((r) => r.overdue) < mw.assignedToMe.findIndex((r) => !r.overdue),
    mw.assignedToMe.map((r) => `${r.kind}:${r.overdue ? 'late' : 'ok'}`).join(','),
  );

  // ══ Today ════════════════════════════════════════════════════════════════
  console.log('\nToday');

  const today = await prisma.salesActivity.create({
    data: {
      subject: `${TAG} Site walk today`,
      type: 'SITE_VISIT',
      assignedToId: worker.id,
      customerId: customer.id,
      startsAt: new Date(),
      durationMinutes: 90,
    },
  });
  await prisma.salesActivity.create({
    data: { subject: `${TAG} Done today`, status: 'DONE', assignedToId: worker.id, startsAt: new Date() },
  });
  await prisma.salesActivity.create({
    data: { subject: `${TAG} Their call today`, assignedToId: colleague.id, startsAt: new Date() },
  });

  const again = (await api(workerToken, 'GET', '/my-work')).body as unknown as MyWork;
  const mine = again.todaysSchedule.find((r) => r.id === today.id);
  check(
    "a PLANNED activity assigned to me appears in todaysSchedule with kind 'activity'",
    mine?.kind === 'activity',
    JSON.stringify(again.todaysSchedule.map((r) => [r.kind, r.title])),
  );
  check(
    "it runs for its duration and deep-links to the activity's page",
    !!mine &&
      new Date(mine.endsAt).getTime() - new Date(mine.startsAt).getTime() === 90 * 60_000 &&
      mine.link === `/g-ops/calendar/activities/${today.id}`,
    mine?.link,
  );
  check('its subtitle names the customer', mine?.sub?.includes(`${TAG} Hospital`) === true, mine?.sub);
  check(
    'a DONE activity is not on the schedule',
    !again.todaysSchedule.some((r) => r.title === `${TAG} Done today`),
  );
  check(
    "a colleague's activity is not on my schedule",
    !again.todaysSchedule.some((r) => r.title === `${TAG} Their call today`),
  );
  check(
    'the schedule is in time order',
    again.todaysSchedule.every(
      (r, i, all) => i === 0 || new Date(all[i - 1].startsAt).getTime() <= new Date(r.startsAt).getTime(),
    ),
  );

  // ══ My drafts ════════════════════════════════════════════════════════════
  console.log('\nMy drafts');

  const quotation = await prisma.quotation.create({
    data: {
      number: `${TAG}-QT-1`,
      customerId: customer.id,
      ownerId: worker.id,
      subject: `${TAG} Oxygen plant supply`,
      revisions: { create: [{ revision: 0, status: 'DRAFT', costingId: costing.id, vatRate: D(0.12) }] },
    },
  });
  await prisma.quotation.create({
    data: {
      number: `${TAG}-QT-2`,
      customerId: customer.id,
      ownerId: worker.id,
      subject: `${TAG} Approved already`,
      revisions: { create: [{ revision: 0, status: 'APPROVED', costingId: costing.id, vatRate: D(0.12) }] },
    },
  });
  const pr = await prisma.purchaseRequest.create({
    data: { number: `${TAG}-PR-1`, requestedById: worker.id, purpose: `${TAG} Fittings` },
  });
  const claim = await prisma.expenseClaim.create({
    data: { number: `${TAG}-EXP-1`, claimedById: worker.id, claimDate: dateOnly(new Date()), purpose: `${TAG} Taxi` },
  });
  const advance = await prisma.cashAdvance.create({
    data: {
      number: `${TAG}-CA-1`,
      requestedById: worker.id,
      requestDate: dateOnly(new Date()),
      purpose: `${TAG} Site cash`,
      amount: D(5000),
    },
  });
  const leaveType = await prisma.leaveType.create({ data: { code: `${TAG}VL`, name: `${TAG} Vacation` } });
  const employee = await prisma.employee.create({
    data: { employeeNo: `${TAG}-001`, firstName: 'Zeno', lastName: 'Worker', userId: worker.id },
  });
  const leave = await prisma.leaveRequest.create({
    data: {
      number: `${TAG}-LV-1`,
      employeeId: employee.id,
      leaveTypeId: leaveType.id,
      startDate: daysFromToday(10),
      endDate: daysFromToday(11),
      days: D(2),
      reason: `${TAG} Family day`,
    },
  });
  const draftOrder = await prisma.jobOrder.create({
    data: {
      number: `${TAG}-JO-2`,
      customerId: customer.id,
      title: `${TAG} Draft call-out`,
      description: 'Not sent yet',
      requestedFor: daysFromToday(4),
      requestedById: worker.id,
    },
  });

  const withDrafts = (await api(workerToken, 'GET', '/my-work')).body as unknown as MyWork;
  const draft = (kind: string, id: string) => withDrafts.myDrafts.find((r) => r.kind === kind && r.id === id);
  check(
    'a DRAFT quotation revision of mine is a draft, linked to the quotation',
    draft('quotation', quotation.id)?.link === `/g-ops/quotations/${quotation.id}`,
  );
  check(
    'a quotation whose revision is approved is not',
    !withDrafts.myDrafts.some((r) => r.title === `${TAG} Approved already`),
  );
  check('a DRAFT purchase request of mine is a draft', !!draft('purchase_request', pr.id));
  check('a DRAFT expense claim of mine is a draft', !!draft('expense_claim', claim.id));
  check('a DRAFT cash advance of mine is a draft', !!draft('cash_advance', advance.id));
  check(
    'a DRAFT leave request of mine is a draft, through my employee record',
    draft('leave_request', leave.id)?.link === `/g-hr/leave/${leave.id}`,
  );
  check('a DRAFT job order I raised is a draft', !!draft('job_order', draftOrder.id));
  check(
    "a colleague sees none of my drafts",
    ((await api(colleagueToken, 'GET', '/my-work')).body as unknown as MyWork).myDrafts.length === 0,
  );

  // ══ The row contract ═════════════════════════════════════════════════════
  console.log('\nThe row contract');

  const all: { link: string | null }[] = [
    ...withDrafts.assignedToMe,
    ...withDrafts.myDrafts,
    ...withDrafts.todaysSchedule,
    ...withDrafts.renewals,
  ];
  check(
    `every /my-work row link starts with "/" (${all.length} rows)`,
    all.length > 0 && all.every((r) => typeof r.link === 'string' && r.link.startsWith('/')),
    all.filter((r) => !r.link?.startsWith('/')).map((r) => String(r.link)).join(', '),
  );
  check(
    'every assigned row carries id, kind and title',
    withDrafts.assignedToMe.every((r) => r.id && r.kind && r.title),
  );

  // ══ Renewals ═════════════════════════════════════════════════════════════
  console.log('\nRenewals');

  check(
    'renewals are withheld from someone without gops.service_contracts.view_all',
    Array.isArray(withDrafts.renewals) && withDrafts.renewals.length === 0,
  );
  const sellerWork = (await api(sellerToken, 'GET', '/my-work')).body as unknown as MyWork;
  check(
    'a contract seller gets the renewal pipeline, every row linked',
    Array.isArray(sellerWork.renewals) &&
      sellerWork.renewals.every(
        (r) =>
          (r.kind === 'CONTRACT' && r.link === `/g-ops/service-contracts/${r.id}`) ||
          (r.kind === 'WARRANTY' && r.link === `/g-ops/installed-base/${r.id}`),
      ),
    JSON.stringify(sellerWork.renewals?.slice(0, 2)),
  );

  // ══ Global search ════════════════════════════════════════════════════════
  console.log('\nGlobal search');

  const ownHits = (await api(workerToken, 'GET', `/search?q=${encodeURIComponent(`${TAG} `)}`)).body as {
    hits: Hit[];
    kinds: { kind: string }[];
  };
  const leadHits = ownHits.hits.filter((h) => h.kind === 'lead');
  check(
    'a view_own user finds their own lead',
    leadHits.some((h) => h.id === myLead.id && h.link === `/g-ops/leads/${myLead.id}`),
    JSON.stringify(leadHits),
  );
  check("and not a colleague's", !leadHits.some((h) => h.id === theirLead.id));

  const po = await prisma.purchaseOrder.create({
    data: {
      number: await nextNumber('purchase_order'),
      kind: 'STOCK_REPLENISHMENT',
      supplierId: supplier.id,
      createdById: worker.id,
      notes: `${TAG} order`,
    },
  });
  const poSearch = (await api(workerToken, 'GET', `/search?q=${encodeURIComponent(po.number)}`)).body as {
    hits: Hit[];
    kinds: { kind: string }[];
  };
  const poRegistered = poSearch.kinds.some((k) => k.kind === 'purchase_order');
  if (!poRegistered) {
    console.log(
      '  ! no purchase_order search provider is registered on the running API — the procurement package\n' +
        '    registers it in src/routes/procurement.ts (registerSearch). Until it lands, this case fails:',
    );
  }
  const poHit = poSearch.hits.find((h) => h.kind === 'purchase_order' && h.id === po.id);
  check(
    'a purchase order is findable by its number and deep-links to the order',
    poHit?.link === `/g-chain/purchase-orders/${po.id}`,
    poRegistered ? JSON.stringify(poSearch.hits.slice(0, 3)) : 'provider not registered',
  );
  const noPo = (await api(colleagueToken, 'GET', `/search?q=${encodeURIComponent(po.number)}`)).body as {
    hits: Hit[];
  };
  check(
    'someone without gchain.purchase_orders.view_all does not find it',
    !noPo.hits.some((h) => h.kind === 'purchase_order'),
  );

  // ══ The approval queue ═══════════════════════════════════════════════════
  console.log('\nThe approval queue');

  await prisma.approvalWorkflow.create({
    data: {
      documentType: `${TAG}_doc`,
      name: `${TAG} — supervisor only`,
      steps: { create: [{ sequence: 1, name: 'Supervisor', approverType: 'SUPERVISOR' }] },
    },
  });
  await submitForApproval({
    documentType: `${TAG}_doc`,
    documentId: myLead.id,
    documentNumber: `${TAG}-DOC-1`,
    subject: `${TAG} Something to decide`,
    amount: 1234.5,
    link: `/g-ops/leads/${myLead.id}`,
    requesterId: worker.id,
  });

  const queue = (await api(supervisorToken, 'GET', '/approvals/pending')).body as unknown as {
    documentNumber: string;
    requester?: { name: string };
    amount: number | null;
    link: string | null;
  }[];
  const row = Array.isArray(queue) ? queue.find((r) => r.documentNumber === `${TAG}-DOC-1`) : undefined;
  check('the document reaches the supervisor\'s queue', !!row, JSON.stringify(queue).slice(0, 200));
  check('GET /approvals/pending rows carry requester.name', row?.requester?.name === 'ZZ Worker', JSON.stringify(row));
  check('the amount is a number and the link is the record', row?.amount === 1234.5 && row?.link === `/g-ops/leads/${myLead.id}`);

  const supWork = (await api(supervisorToken, 'GET', '/my-work')).body as unknown as MyWork;
  const supRow = supWork.awaitingMyApproval.find((a) => a.link === `/g-ops/leads/${myLead.id}`);
  check('/my-work awaitingMyApproval names the requester too', supRow?.requester?.name === 'ZZ Worker');
  const workerAgain = (await api(workerToken, 'GET', '/my-work')).body as unknown as MyWork;
  check(
    'the requester sees it in flight, never in their own queue',
    workerAgain.myPendingSubmissions.some((s) => s.link === `/g-ops/leads/${myLead.id}`) &&
      !workerAgain.awaitingMyApproval.some((a) => a.link === `/g-ops/leads/${myLead.id}`),
  );

  // ══ The document specimen ════════════════════════════════════════════════
  // The page an administrator prints to see Company Settings on paper. It
  // promises every section kind the engine draws, so it must draw every one —
  // and in the words every document uses: money with the company's currency,
  // a table's amounts bare under a head that names it, the money block as
  // totals (never a TOTAL row in the lines), a status through statusLabel,
  // and sign-offs both signed and Pending, each role in capitals.
  console.log('\nThe document specimen');
  const specimenRes = await fetch(`${BASE}/pdf/specimen`, { headers: { Authorization: `Bearer ${workerToken}` } });
  const specimen = Buffer.from(await specimenRes.arrayBuffer());
  const spec = specimenRes.ok ? pdfText(specimen) : '';
  const words = spec.replace(/[^A-Za-z0-9:().%]+/g, ' ');
  const company = await prisma.company.findUnique({ where: { id: 'company' }, select: { currency: true, vatRate: true, ewtRate: true } });
  const currency = company?.currency?.trim() || 'PHP';
  const pct = (rate: unknown) => `${+((Number(rate) || 0) * 100).toFixed(2)}%`;
  check('it prints', specimenRes.status === 200 && specimen.subarray(0, 4).toString() === '%PDF', String(specimenRes.status));
  check(
    'fields, text and a table with a subheading row and title-over-description cells',
    words.includes('HEADER FIELDS') &&
      words.includes('SCOPE OF WORK') &&
      words.includes('COST SUMMARY') &&
      /^Equipment and materials$/m.test(spec) &&
      /^Oxygen generator skid$/m.test(spec) &&
      spec.includes('Stainless steel interconnection'),
    spec.split('\n').slice(0, 40).join(' | ').slice(0, 300),
  );
  check(
    'the money is a totals block in the quotation\'s words — Subtotal, VAT, Total, Less: EWT, Net collectible — the table\'s heads naming the currency, and no TOTAL row',
    spec.includes('Subtotal') &&
      spec.includes(`VAT (${pct(company?.vatRate)})`) &&
      /^Total$/m.test(spec) &&
      spec.includes(`Less: EWT (${pct(company?.ewtRate)})`) &&
      spec.includes('Net collectible') &&
      words.includes(`AMOUNT (${currency})`) &&
      new RegExp(`^${currency} [\\d,]+\\.\\d{2}$`, 'm').test(spec) &&
      !spec.includes('TOTAL'),
    spec.split('\n').filter((l) => /Subtotal|VAT|Total|TOTAL|EWT|collectible|AMOUNT/.test(l)).join(' | ').slice(0, 300),
  );
  check(
    'a status prints as a word ("Pending approval"), and no "≠" turns into "=" — the note says "is not"',
    words.includes('Status: Pending approval') && spec.includes('invoiced is not collectible') && !spec.includes('PENDING_APPROVAL'),
  );
  check(
    'a Gantt appendix on a landscape page of its own',
    words.includes('SCHEDULE') && /^Site survey$/m.test(spec) && /^Day 1$/m.test(spec) && /\/MediaBox \[0 0 841\.89 595\.28\]/.test(specimen.toString('latin1')),
  );
  check(
    'a footer note, and sign-offs both signed (dated) and Pending — under a name and alone — each role in capitals',
    spec.includes('Specimen — the customer, figures and approvers on this page are samples.'.replace('—', '\x97')) &&
      ['PREPARED BY', 'TECHNICAL REVIEW', 'FINANCE APPROVAL', 'CEO APPROVAL'].every((r) => words.includes(r)) &&
      (spec.match(/^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M$/gm) ?? []).length === 2 &&
      (spec.match(/^Pending$/gm) ?? []).length === 2 &&
      spec.includes(worker.email),
  );
  const specimenRows = await prisma.auditLog.count({ where: { actorId: worker.id, entityType: 'pdf_specimen', action: 'EXPORTED' } });
  check('printing it is audited as EXPORTED, like every PDF', specimenRows === 1, String(specimenRows));

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
