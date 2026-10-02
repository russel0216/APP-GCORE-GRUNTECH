/**
 * The company at a glance — verification of the Insights brief.
 *
 *   npx tsx scripts/verify-insights-brief.ts      (the API must be running)
 *
 * The brief is one line per division at the top of Insights › Company
 * Overview. Its whole promise is that every figure on it is the SAME number
 * the division's own dashboard prints, because it is read through the same
 * function. So this script is almost entirely reconciliation:
 *
 *   · G-OPS against `/gops/overview`, G-CHAIN against `/gchain/overview`,
 *     G-HR against `/attendance/dashboard`, G-FIN against
 *     `/finance-reports/dashboard` — figure by figure, to the centavo.
 *   · Who sees a line is that module's dashboard permission, decided on the
 *     server. Holding the overview is not holding the counts.
 *   · The G-HR line carries counts, never a person.
 *   · The CSV twin is audited, and a module's rows need that module's export.
 *   · The last day of a range is inside it.
 *   · Sales Analytics' industry table sums to its own totals.
 *
 * Its fixtures carry the ZZINB tag (users @verifyib.local, roles zzinb_) so
 * this script and verify-insights.ts never clean up each other's records.
 */

import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/prisma';
import { env } from '../src/env';
import { signToken } from '../src/auth/middleware';
import { nextNumber } from '../src/shared/numbering';
import { receiveStock } from '../src/shared/inventory';
import { quotationValue } from '../src/shared/pipeline';
import { cents, parseRange, SUMMARY_FIGURES } from '../src/shared/insights';
import { periodWhere } from '../src/shared/gops';
import { manilaDayEnd, manilaDayKey, manilaDayStart } from '../src/shared/day';
// HR's day key is the LOCAL date (the same convention as web/src/lib/day.ts's
// todayLocal), never the UTC one. An attendance fixture keyed by the UTC day
// would land on yesterday for eight hours of every Manila morning.
import { dayKey as hrDayKey } from '../src/shared/hr';

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

const TAG = 'ZZINB';
const MAIL = '@verifyib.local';
const BASE = `http://localhost:${env.port}/api`;

/**
 * The day the screens send as `to`: todayLocal() in a browser in Manila. Not
 * the UTC date. G-OPS ends `to` at 23:59:59.999 in Manila (periodWhere), so
 * for the eight hours after Manila midnight a UTC `to` closed the window at
 * the end of yesterday and dropped everything since.
 */
const screenDay = (at: Date) => manilaDayKey(at);

// ── Fixtures ─────────────────────────────────────────────────────────────────

async function cleanup() {
  await prisma.serviceVisit.deleteMany({ where: { customer: { name: { startsWith: TAG } } } });
  await prisma.serviceContract.deleteMany({ where: { job: { name: { startsWith: TAG } } } });
  await prisma.quotationRevision.deleteMany({ where: { quotation: { subject: { startsWith: TAG } } } });
  await prisma.quotation.deleteMany({ where: { subject: { startsWith: TAG } } });
  await prisma.lead.deleteMany({ where: { companyName: { startsWith: TAG } } });
  await prisma.job.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.costing.deleteMany({ where: { title: { startsWith: TAG } } });
  await prisma.inventoryTransaction.deleteMany({ where: { item: { name: { startsWith: TAG } } } });
  await prisma.inventoryBalance.deleteMany({ where: { item: { name: { startsWith: TAG } } } });
  await prisma.item.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.warehouse.deleteMany({ where: { name: { startsWith: TAG } } });
  // Attendance cascades with the employee.
  await prisma.employee.deleteMany({ where: { employeeNo: { startsWith: TAG } } });
  await prisma.customer.deleteMany({ where: { name: { startsWith: TAG } } });

  const users = await prisma.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await prisma.approvalAction.deleteMany({ where: { approverId: { in: ids } } });
    await prisma.approvalRequest.deleteMany({ where: { requesterId: { in: ids } } });
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
    await prisma.user.updateMany({ where: { supervisorId: { in: ids } }, data: { supervisorId: null } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.role.deleteMany({ where: { key: { startsWith: 'zzinb_' } } });
}

/**
 * A role holding exactly the permissions named (the verify-hr.ts pattern).
 * A seeded role's membership is the operator's business; a test that leans
 * on it breaks the moment somebody is hired.
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
    data: { key, name, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } },
  });
}

async function makeUser(name: string, email: string, opts: { roleKeys?: string[]; roleIds?: string[] }) {
  const seeded = opts.roleKeys?.length
    ? await prisma.role.findMany({ where: { key: { in: opts.roleKeys } }, select: { id: true } })
    : [];
  const roleIds = [...seeded.map((r) => r.id), ...(opts.roleIds ?? [])];
  return prisma.user.create({
    data: {
      name,
      email,
      passwordHash: await bcrypt.hash('x', 10),
      roles: { create: roleIds.map((roleId) => ({ roleId })) },
    },
  });
}

// ── The shapes the API returns ───────────────────────────────────────────────

interface Figure {
  key: string;
  label: string;
  value: number;
  kind: 'count' | 'money' | 'hours';
  basis: 'live' | 'range';
  scope?: 'all' | 'mine';
  to: string;
}
interface Line {
  module: string;
  label: string;
  to: string;
  asOf?: string;
  day?: string;
  figures: Figure[];
}
interface Summary {
  range: { from: string; to: string };
  asOf: string;
  lines: { gops: Line | null; gchain: Line | null; ghr: Line | null; gfin: Line | null };
}

const fig = (l: Line | null, key: string) => l?.figures.find((f) => f.key === key);
const val = (l: Line | null, key: string) => fig(l, key)?.value;

async function main() {
  console.log('\nG-CORE insights brief verification\n');
  await cleanup();

  // ══ Arithmetic ═══════════════════════════════════════════════════════════
  console.log('The range');

  const r = parseRange('2026-01-01', '2026-06-30');
  check(
    'the last day of a range is inside it — the range ends at 23:59:59.999 on that day',
    r.to.toISOString() === '2026-06-30T23:59:59.999Z',
    r.to.toISOString(),
  );
  check('and it still starts at the first instant of its first day', r.from.toISOString() === '2026-01-01T00:00:00.000Z');

  // Pinned at both ends of a Manila day rather than at whatever hour this
  // runs: at 00:30 and 07:59 the UTC date is still the 1st.
  const sameDay = ['00:30', '07:59', '23:59'].map((hhmm) => new Date(`2026-10-02T${hhmm}:00+08:00`));
  const missed = sameDay.filter((at) => {
    const end = (periodWhere({ query: { to: screenDay(at) } }) as { createdAt?: { lte?: Date } }).createdAt?.lte;
    return !end || end.getTime() < at.getTime();
  });
  check(
    'a G-OPS window to "today" holds every hour of the Manila day, the ones before 08:00 included',
    missed.length === 0,
    `outside it: ${missed.map((at) => at.toISOString()).join(', ')}`,
  );
  // And from the other end: a window that STARTS today used to open at 08:00
  // (UTC midnight), leaving out whatever was raised before it.
  const notYetOpen = sameDay.filter((at) => {
    const w = (periodWhere({ query: { from: screenDay(at), to: screenDay(at) } }) as {
      createdAt?: { gte?: Date; lte?: Date };
    }).createdAt;
    return !w?.gte || !w.lte || w.gte.getTime() > at.getTime() || w.lte.getTime() < at.getTime();
  });
  check(
    'a G-OPS window from "today" holds every hour of it too, from Manila midnight',
    notYetOpen.length === 0,
    `outside it: ${notYetOpen.map((at) => at.toISOString()).join(', ')}`,
  );
  const performed = (periodWhere({ query: { from: '2026-10-02', to: '2026-10-02' } }, 'performedAt') as {
    performedAt: { gte: Date; lte: Date };
  }).performedAt;
  check(
    'work performed, a DATE, still starts at UTC midnight — Manila midnight would read as the day before',
    performed.gte.toISOString() === '2026-10-02T00:00:00.000Z' &&
      performed.lte.toISOString().slice(0, 10) === '2026-10-02',
    `${performed.gte.toISOString()} → ${performed.lte.toISOString()}`,
  );
  check(
    'an Insights range over a timestamp runs from Manila midnight of its first day',
    r.fromAt.toISOString() === '2025-12-31T16:00:00.000Z',
    r.fromAt.toISOString(),
  );
  check(
    'to the last instant of its last day in Manila',
    r.toAt.toISOString() === '2026-06-30T15:59:59.999Z',
    r.toAt.toISOString(),
  );

  const badLinks = Object.entries(SUMMARY_FIGURES).filter(([, f]) => !f.to.startsWith('/'));
  check('every brief figure opens an app path', badLinks.length === 0, badLinks.map(([k]) => k).join(', '));

  // ══ Fixtures ═════════════════════════════════════════════════════════════

  const overviewRole = await makeRole('zzinb_overview', 'ZZINB overview only', ['insights.dashboard.view_all']);
  const ownQuotesRole = await makeRole('zzinb_own_quotes', 'ZZINB own quotations', [
    'insights.dashboard.view_all',
    'gops.dashboard.view_all',
    'gops.quotations.view_own',
  ]);
  const noFinExportRole = await makeRole('zzinb_no_fin_export', 'ZZINB export without G-FIN export', [
    'insights.dashboard.view_all',
    'insights.dashboard.export',
    'gops.dashboard.view_all',
    'gops.dashboard.export',
    'gops.leads.view_all',
    'gfin.dashboard.view_all',
  ]);

  const director = await makeUser('ZZINB Director', `exec${MAIL}`, { roleKeys: ['executive'] });
  const pm = await makeUser('ZZINB PM', `pm${MAIL}`, { roleKeys: ['project_manager'] });
  const finUser = await makeUser('ZZINB Finance', `fin${MAIL}`, { roleKeys: ['finance'] });
  const overviewUser = await makeUser('ZZINB Overview', `overview${MAIL}`, { roleIds: [overviewRole.id] });
  const ownQuotesUser = await makeUser('ZZINB Seller', `seller${MAIL}`, { roleIds: [ownQuotesRole.id] });
  const noFinExportUser = await makeUser('ZZINB Analyst', `analyst${MAIL}`, { roleIds: [noFinExportRole.id] });

  const healthcare = await prisma.industry.findUnique({ where: { code: 'HI' } });
  if (!healthcare) throw new Error('The seeded HI industry is missing — run npm run seed');

  const hospital = await prisma.customer.create({
    data: { code: `${TAG}-C1`, name: `${TAG} Hospital`, industryId: healthcare.id },
  });

  const now = new Date();
  const today = screenDay(now);
  // Finance counts "collected this year" from 1 January of Manila's year, so
  // the window starts there too.
  const thisYear = Number(today.slice(0, 4));
  const yearStart = `${thisYear}-01-01`;

  // Sales: a qualified lead on a hospital, a lead with no customer yet, a
  // quotation out, and one won THIS MORNING (10:00 in Manila) — the case the
  // old midnight range end silently dropped.
  await prisma.lead.create({
    data: {
      number: await nextNumber('lead'),
      companyName: `${TAG} Hospital enquiry`,
      customerId: hospital.id,
      assignedToId: director.id,
      createdById: director.id,
      status: 'QUALIFIED',
      estimatedValue: D(500_000),
      probability: 40,
    },
  });
  await prisma.lead.create({
    data: {
      number: await nextNumber('lead'),
      companyName: `${TAG} Walk-in with no customer`,
      assignedToId: director.id,
      createdById: director.id,
      status: 'NEW',
    },
  });
  async function quotation(subject: string, outcome: 'SUBMITTED' | 'WON', total: number, decidedAt?: Date) {
    const q = await prisma.quotation.create({
      data: {
        number: await nextNumber('quotation', prisma, { ownerId: director.id }),
        customerId: hospital.id,
        ownerId: director.id,
        subject: `${TAG} ${subject}`,
        outcome,
        probability: outcome === 'WON' ? 100 : 60,
        submittedAt: now,
        ...(decidedAt ? { decidedAt } : {}),
      },
    });
    await prisma.quotationRevision.create({
      data: {
        quotationId: q.id,
        revision: 0,
        status: 'APPROVED',
        subtotal: D(total),
        vatAmount: D(cents(total * 0.12)),
        total: D(cents(total * 1.12)),
      },
    });
    return q;
  }
  await quotation('Oxygen plant', 'SUBMITTED', 1_200_000);
  const wonThisMorning = await quotation('Won this morning', 'WON', 300_000, new Date(`${today}T10:00:00.000+08:00`));
  // Raised and won at 00:30 in Manila on a day long past. A range that
  // started at UTC midnight (08:00 here) left it out of its own day.
  const dawnDay = '2019-09-12';
  const dawn = new Date(`${dawnDay}T00:30:00.000+08:00`);
  const wonBeforeDawn = await prisma.quotation.create({
    data: {
      number: await nextNumber('quotation', prisma, { ownerId: director.id }),
      customerId: hospital.id,
      ownerId: director.id,
      subject: `${TAG} Won before dawn`,
      outcome: 'WON',
      probability: 100,
      submittedAt: dawn,
      decidedAt: dawn,
      createdAt: dawn,
    },
  });

  // Delivery: a project in progress, and a running service contract with a
  // PM visit done today.
  const costing = await prisma.costing.create({
    data: {
      number: await nextNumber('costing'),
      title: `${TAG} Costing`,
      ownerId: director.id,
      totalCost: D(100_000),
      contractValue: D(150_000),
    },
  });
  await prisma.job.create({
    data: {
      number: await nextNumber('project'),
      name: `${TAG} Plant install`,
      status: 'IN_PROGRESS',
      customerId: hospital.id,
      costingId: costing.id,
      createdById: director.id,
      contractValue: D(150_000),
    },
  });
  const contractJob = await prisma.job.create({
    data: {
      number: await nextNumber('project'),
      type: 'SERVICE_CONTRACT',
      name: `${TAG} Service cover`,
      status: 'IN_PROGRESS',
      customerId: hospital.id,
      costingId: costing.id,
      createdById: director.id,
      contractValue: D(60_000),
    },
  });
  const contract = await prisma.serviceContract.create({
    data: {
      number: await nextNumber('service_contract'),
      status: 'ACTIVE',
      jobId: contractJob.id,
      startsAt: new Date(`${yearStart}T00:00:00.000Z`),
      endsAt: new Date(Date.UTC(thisYear + 1, 11, 31)),
      frequencyMonths: 3,
      createdById: director.id,
    },
  });
  await prisma.serviceVisit.create({
    data: {
      number: await nextNumber('service_visit'),
      kind: 'PREVENTIVE_MAINTENANCE',
      status: 'COMPLETED',
      contractId: contract.id,
      customerId: hospital.id,
      dueDate: new Date(`${today}T00:00:00.000Z`),
      performedAt: new Date(`${today}T00:00:00.000Z`),
    },
  });

  // Stock on hand, so the three stock figures reconcile on something real.
  const categories = await prisma.costCategory.findMany({ orderBy: { sortOrder: 'asc' } });
  const warehouse = await prisma.warehouse.create({ data: { code: `${TAG}W`, name: `${TAG} Store` } });
  const valve = await prisma.item.create({
    data: { code: `${TAG}-VLV`, name: `${TAG} Valve`, unit: 'pcs', costCategoryId: categories[0].id },
  });
  await prisma.$transaction((tx) =>
    receiveStock(tx, { itemId: valve.id, warehouseId: warehouse.id, quantity: 3, unitCost: 1_234.56, sourceType: 'receiving' }),
  );

  // People: one clerk who clocked in late today — on HR's day, not UTC's.
  const clerk = await prisma.employee.create({
    data: { employeeNo: `${TAG}-E1`, firstName: TAG, lastName: 'Clerk', isActive: true },
  });
  await prisma.attendance.create({
    data: {
      employeeId: clerk.id,
      date: hrDayKey(new Date()),
      timeIn: new Date(),
      status: 'LATE',
      lateMinutes: 12,
    },
  });

  // ══ Over HTTP ════════════════════════════════════════════════════════════
  console.log('\nOver HTTP');

  const reachable = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) })
    .then((res) => res.ok)
    .catch(() => false);

  if (!reachable) {
    failed += 1;
    console.log(
      `  ✗ the API is not reachable at ${BASE} — the brief was NOT verified.\n` +
        '      Start it with "npm run dev" in api/ and run this script again.',
    );
  } else {
    const token = signToken(director.id, director.email);
    const as = (u: { id: string; email: string }) => signToken(u.id, u.email);
    const api = async <T = Record<string, unknown>>(method: string, path: string, who = token) => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { Authorization: `Bearer ${who}` } });
      const text = await res.text();
      let body: unknown = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = { raw: text };
      }
      return { status: res.status, body: body as T, text };
    };

    const window = `from=${yearStart}&to=${today}`;
    const dash = await api<{ summary: Summary; sales: { won: number } }>('GET', `/insights/dashboard?${window}`);
    const S = dash.body.summary;
    check('the company overview carries the brief', dash.status === 200 && !!S, String(dash.status));
    check(
      'an executive sees all four lines',
      !!S?.lines.gops && !!S?.lines.gchain && !!S?.lines.ghr && !!S?.lines.gfin,
      JSON.stringify(Object.fromEntries(Object.entries(S?.lines ?? {}).map(([k, v]) => [k, !!v]))),
    );

    // ── G-OPS ──────────────────────────────────────────────────────────────
    const ops = await api<{
      sales: { leads: Record<string, number> | null; quotations: Record<string, number> | null } | null;
      delivery: { jobs: Record<string, number> | null; reportsAwaitingApproval: number | null } | null;
      aftermarket: { activeContracts: number | null; pmAccomplished: number | null } | null;
    }>('GET', `/gops/overview?${window}`);
    const o = ops.body;
    const g = S.lines.gops;
    const leads = o.sales?.leads ?? {};
    check(
      'G-OPS: enquiries in play are the dashboard\'s new, contacted, qualified and site-visit leads',
      val(g, 'enquiriesInPlay') === ['NEW', 'CONTACTED', 'QUALIFIED', 'SITE_VISIT'].reduce((s, k) => s + (leads[k] ?? 0), 0) &&
        (val(g, 'enquiriesInPlay') ?? 0) >= 2,
      `brief ${val(g, 'enquiriesInPlay')} vs ${JSON.stringify(leads)}`,
    );
    check(
      'quotations out and in negotiation match the dashboard',
      val(g, 'quotationsOut') === (o.sales?.quotations?.SUBMITTED ?? 0) &&
        val(g, 'quotationsNegotiating') === (o.sales?.quotations?.NEGOTIATION ?? 0) &&
        (val(g, 'quotationsOut') ?? 0) >= 1,
      `${val(g, 'quotationsOut')}/${val(g, 'quotationsNegotiating')} vs ${JSON.stringify(o.sales?.quotations)}`,
    );
    check(
      'projects in progress and on hold match',
      val(g, 'projectsInProgress') === (o.delivery?.jobs?.IN_PROGRESS ?? 0) &&
        val(g, 'projectsOnHold') === (o.delivery?.jobs?.ON_HOLD ?? 0) &&
        (val(g, 'projectsInProgress') ?? 0) >= 1,
      `${val(g, 'projectsInProgress')}/${val(g, 'projectsOnHold')} vs ${JSON.stringify(o.delivery?.jobs)}`,
    );
    check(
      'progress reports awaiting approval match',
      val(g, 'reportsAwaitingApproval') === o.delivery?.reportsAwaitingApproval,
    );
    check(
      'contracts running and PM visits done match — and neither is trivially zero',
      val(g, 'contractsRunning') === o.aftermarket?.activeContracts &&
        val(g, 'pmAccomplished') === o.aftermarket?.pmAccomplished &&
        (val(g, 'contractsRunning') ?? 0) >= 1 &&
        (val(g, 'pmAccomplished') ?? 0) >= 1,
      `${val(g, 'contractsRunning')}/${val(g, 'pmAccomplished')} vs ${JSON.stringify(o.aftermarket)}`,
    );
    check(
      '/gops/overview did not grow a key — the scope marker is for the brief only',
      !('_scope' in (o as Record<string, unknown>)),
      Object.keys(o).join(', '),
    );

    // ── G-CHAIN ────────────────────────────────────────────────────────────
    const chain = await api<{
      requestsAwaitingApproval: number | null;
      ordersAwaitingDelivery: number | null;
      borrowSlipsOverdue: number | null;
      stock: { value: number; lines: number } | null;
    }>('GET', '/gchain/overview');
    const c = S.lines.gchain;
    check(
      'G-CHAIN: the four figures are the G-CHAIN dashboard\'s own',
      chain.status === 200 &&
        val(c, 'requestsAwaitingApproval') === chain.body.requestsAwaitingApproval &&
        val(c, 'ordersAwaitingDelivery') === chain.body.ordersAwaitingDelivery &&
        val(c, 'borrowSlipsOverdue') === chain.body.borrowSlipsOverdue &&
        money(val(c, 'stockValue') ?? -1, chain.body.stock?.value ?? -2),
      `${JSON.stringify(c?.figures.map((f) => [f.key, f.value]))} vs ${JSON.stringify(chain.body)}`,
    );
    const invSummary = await api<{ totalValue: number }>('GET', '/inventory/reports/summary');
    const invAnalytics = await api<{ totalValue: number }>('GET', '/insights/inventory');
    check(
      'stock on hand is one figure on three screens',
      money(val(c, 'stockValue') ?? -1, invSummary.body.totalValue) &&
        money(val(c, 'stockValue') ?? -1, invAnalytics.body.totalValue) &&
        (val(c, 'stockValue') ?? 0) >= cents(3 * 1_234.56),
      `brief ${val(c, 'stockValue')}, summary ${invSummary.body.totalValue}, analytics ${invAnalytics.body.totalValue}`,
    );
    check(
      'the G-CHAIN line carries only the figures its dashboard has a twin for',
      (c?.figures ?? []).every((f) =>
        ['requestsAwaitingApproval', 'ordersAwaitingDelivery', 'borrowSlipsOverdue', 'stockValue'].includes(f.key),
      ),
      c?.figures.map((f) => f.key).join(', '),
    );

    // ── G-HR ───────────────────────────────────────────────────────────────
    const hr = await api<{
      headcount: number;
      summary: { present: number; late: number; onLeave: number; absent: number; pendingApprovals: number };
    }>('GET', '/attendance/dashboard');
    const h = S.lines.ghr;
    check(
      'G-HR: headcount, present, late, on leave, absent and approvals are the HR dashboard\'s',
      hr.status === 200 &&
        val(h, 'headcount') === hr.body.headcount &&
        val(h, 'present') === hr.body.summary.present &&
        val(h, 'late') === hr.body.summary.late &&
        val(h, 'onLeave') === hr.body.summary.onLeave &&
        val(h, 'absent') === hr.body.summary.absent &&
        val(h, 'pendingApprovals') === hr.body.summary.pendingApprovals,
      `${JSON.stringify(h?.figures.map((f) => [f.key, f.value]))} vs ${JSON.stringify(hr.body.summary)} / ${hr.body.headcount}`,
    );
    check('the clerk who clocked in late today is counted', (val(h, 'late') ?? 0) >= 1, `late ${val(h, 'late')}`);
    const ghrText = JSON.stringify(h);
    check(
      'the G-HR line carries counts, never a person',
      !ghrText.includes('Clerk') && !ghrText.includes(`${TAG}-E1`),
      'a name or employee number reached the brief',
    );
    const ot = await api<{ totalHours: number; totalAmount: number }>('GET', `/hr-reports/overtime-by-project?${window}`);
    check(
      'overtime approved in range equals the HR overtime report, hours and pesos',
      ot.status === 200 &&
        val(h, 'overtimeHours') === ot.body.totalHours &&
        money(val(h, 'overtimeAmount') ?? -1, ot.body.totalAmount),
      `${val(h, 'overtimeHours')}h / ${val(h, 'overtimeAmount')} vs ${ot.body.totalHours}h / ${ot.body.totalAmount}`,
    );
    check('the HR line says when it was read', !!h?.asOf && !!h?.day, `${h?.asOf} ${h?.day}`);

    // ── G-FIN ──────────────────────────────────────────────────────────────
    const fin = await api<{
      receivable: number;
      receivableOverdue: number;
      payable: number;
      payableOverdue: number;
      reimbursable: number;
      advancesToRelease: number;
      workingPosition: number;
      collectedThisYear: number;
      queue: { billingsAwaitingInvoice: number };
    }>('GET', '/finance-reports/dashboard');
    const f = S.lines.gfin;
    const fd = fin.body;
    const sixMatch = (['receivable', 'receivableOverdue', 'payable', 'payableOverdue', 'reimbursable', 'workingPosition'] as const)
      .map((k) => [k, val(f, k), fd[k]] as const);
    check(
      'G-FIN: receivable, payable, both overdue, claims and working position match the finance dashboard',
      fin.status === 200 && sixMatch.every(([, a, b]) => a !== undefined && money(a, b)),
      JSON.stringify(sixMatch),
    );
    check(
      'the working position is receivable less payable, claims and approved advances — G-FIN\'s definition',
      money(
        val(f, 'workingPosition') ?? NaN,
        cents(
          (val(f, 'receivable') ?? 0) -
            (val(f, 'payable') ?? 0) -
            (val(f, 'reimbursable') ?? 0) -
            (val(f, 'advancesToRelease') ?? 0),
        ),
      ) && money(val(f, 'advancesToRelease') ?? NaN, fd.advancesToRelease),
    );
    const cash = await api<{ totals: { invoiced: number; payable: number; reimbursable: number; advances: number } }>(
      'GET',
      '/insights/cash-forecast',
    );
    check(
      'the cash forecast totals are the same position — invoiced, payable, claims, advances',
      money(cash.body.totals.invoiced, val(f, 'receivable') ?? NaN) &&
        money(cash.body.totals.payable, val(f, 'payable') ?? NaN) &&
        money(cash.body.totals.reimbursable, val(f, 'reimbursable') ?? NaN) &&
        money(cash.body.totals.advances, val(f, 'advancesToRelease') ?? NaN),
      JSON.stringify(cash.body.totals),
    );
    const range = parseRange(yearStart, today);
    const collectedDirect = await prisma.payment.aggregate({
      where: { kind: 'RECEIPT', customerId: { not: null }, clearedAt: { gte: range.from, lte: range.to } },
      _sum: { amount: true },
    });
    check(
      'collected in range is customer receipts cleared in range, read directly',
      money(val(f, 'collectedInRange') ?? NaN, num(collectedDirect._sum.amount)),
      `${val(f, 'collectedInRange')} vs ${num(collectedDirect._sum.amount)}`,
    );
    check(
      'and from 1 January to today it is what finance calls collected this year',
      money(val(f, 'collectedInRange') ?? NaN, fd.collectedThisYear),
      `${val(f, 'collectedInRange')} vs ${fd.collectedThisYear}`,
    );
    check(
      'approved billings not yet invoiced is finance\'s own queue count',
      val(f, 'billingsAwaitingInvoice') === fd.queue.billingsAwaitingInvoice,
    );

    // ── A range is Manila's days, first to last ─────────────────────────────
    const todayOnly = await api<{ sales: { won: number } }>('GET', `/insights/dashboard?from=${today}&to=${today}`);
    const wonToday = await prisma.quotation.count({
      where: { outcome: 'WON', decidedAt: { gte: manilaDayStart(today), lte: manilaDayEnd(today) } },
    });
    check(
      'a quotation won at 10:00 today is counted in a range that ends today',
      todayOnly.body.sales.won === wonToday && wonToday >= 1,
      `won ${todayOnly.body.sales.won}, decided today ${wonToday} (fixture ${wonThisMorning.number})`,
    );
    const [dawnInsights, dawnGops, wonThatDay, raisedThatDay] = await Promise.all([
      api<{ sales: { won: number } }>('GET', `/insights/dashboard?from=${dawnDay}&to=${dawnDay}`),
      api<{ sales: { quotations: Record<string, number> | null } | null }>(
        'GET',
        `/gops/overview?from=${dawnDay}&to=${dawnDay}`,
      ),
      prisma.quotation.count({
        where: { outcome: 'WON', decidedAt: { gte: manilaDayStart(dawnDay), lte: manilaDayEnd(dawnDay) } },
      }),
      prisma.quotation.count({ where: { createdAt: { gte: manilaDayStart(dawnDay), lte: manilaDayEnd(dawnDay) } } }),
    ]);
    check(
      'a quotation won at 00:30 counts on its own day in Insights, not the day before',
      dawnInsights.body.sales.won === wonThatDay && wonThatDay >= 1,
      `won ${dawnInsights.body.sales.won}, decided that Manila day ${wonThatDay} (fixture ${wonBeforeDawn.number})`,
    );
    const raisedOnGops = Object.values(dawnGops.body.sales?.quotations ?? {}).reduce((s, n) => s + n, 0);
    check(
      'and one raised at 00:30 counts on its own day on the G-OPS dashboard',
      raisedOnGops === raisedThatDay && raisedThatDay >= 1,
      `G-OPS ${raisedOnGops}, raised that Manila day ${raisedThatDay}`,
    );

    // ── Who sees what ──────────────────────────────────────────────────────
    const pmDash = await api('GET', `/insights/dashboard?${window}`, as(pm));
    check(
      'a project manager sees margin on projects, not the company brief',
      pmDash.status === 403,
      String(pmDash.status),
    );
    const ov = await api<{ summary: Summary }>('GET', `/insights/dashboard?${window}`, as(overviewUser));
    check(
      'holding the overview is not holding the counts — all four lines are withheld',
      ov.status === 200 &&
        ov.body.summary.lines.gops === null &&
        ov.body.summary.lines.gchain === null &&
        ov.body.summary.lines.ghr === null &&
        ov.body.summary.lines.gfin === null,
      `${ov.status} ${JSON.stringify(ov.body.summary?.lines)}`.slice(0, 200),
    );
    const fn = await api<{ summary: Summary }>('GET', `/insights/dashboard?${window}`, as(finUser));
    check(
      'finance sees the G-FIN line, and attendance stays behind HR\'s permissions',
      fn.status === 200 && !!fn.body.summary.lines.gfin && fn.body.summary.lines.ghr === null,
      `${fn.status} gfin=${!!fn.body.summary?.lines.gfin} ghr=${JSON.stringify(fn.body.summary?.lines.ghr)}`,
    );
    const own = await api<{ summary: Summary }>('GET', `/insights/dashboard?${window}`, as(ownQuotesUser));
    const ownOps = await api<{ sales: { quotations: Record<string, number> | null } | null }>(
      'GET',
      `/gops/overview?${window}`,
      as(ownQuotesUser),
    );
    const ownOut = fig(own.body.summary?.lines.gops ?? null, 'quotationsOut');
    check(
      'someone who sees only their own quotations gets their own count, marked as theirs',
      own.status === 200 &&
        ownOut?.scope === 'mine' &&
        ownOut.value === (ownOps.body.sales?.quotations?.SUBMITTED ?? 0),
      `${JSON.stringify(ownOut)} vs ${JSON.stringify(ownOps.body.sales?.quotations)}`,
    );
    check(
      'and a figure they cannot open at all is omitted, not sent as zero',
      !fig(own.body.summary?.lines.gops ?? null, 'enquiriesInPlay') &&
        !fig(own.body.summary?.lines.gops ?? null, 'projectsInProgress'),
      own.body.summary?.lines.gops?.figures.map((x) => x.key).join(', '),
    );

    // ── The CSV twin ───────────────────────────────────────────────────────
    const before = new Date();
    const csv = await api('GET', `/insights/summary.csv?${window}`);
    const header = csv.text.replace(/^﻿/, '').split('\r\n')[0];
    check(
      'the brief exports as CSV — module, figure, basis, scope and the screen it opens',
      csv.status === 200 &&
        header === 'Module,Figure,Value,Basis,Scope,From,To,Opens' &&
        csv.text.includes('G-FIN') &&
        csv.text.includes('Working position'),
      `${csv.status} ${header}`,
    );
    const figures = Object.values(S.lines).reduce((n, l) => n + (l?.figures.length ?? 0), 0);
    check(
      'one row per figure the director can see',
      csv.text.replace(/^﻿/, '').split('\r\n').length - 1 === figures,
      `${csv.text.split('\r\n').length - 1} rows vs ${figures} figures`,
    );
    const hoursRow = csv.text.split('\r\n').find((l) => l.includes('Overtime approved'));
    check('hours print to two decimals', !!hoursRow && /,\d+\.\d{2},range,/.test(hoursRow), hoursRow);
    const logged = await prisma.auditLog.findFirst({
      where: { entityType: 'insights', entityId: 'company-summary', action: 'EXPORTED', at: { gte: new Date(before.getTime() - 1000) } },
    });
    check('and the export is in the audit log before the bytes left', !!logged);
    const ovCsv = await api('GET', `/insights/summary.csv?${window}`, as(overviewUser));
    check('someone without the overview export cannot take the file', ovCsv.status === 403, String(ovCsv.status));
    const partial = await api('GET', `/insights/summary.csv?${window}`, as(noFinExportUser));
    const partialJson = await api<{ summary: Summary }>('GET', `/insights/dashboard?${window}`, as(noFinExportUser));
    check(
      'a module\'s rows need that module\'s own export — G-FIN seen on screen, but not in the file',
      partial.status === 200 &&
        !!partialJson.body.summary.lines.gfin &&
        !partial.text.includes('G-FIN') &&
        partial.text.includes('G-OPS'),
      `${partial.status} ${partial.text.slice(0, 160)}`,
    );

    // ── Read-only ──────────────────────────────────────────────────────────
    const post = await api('POST', '/insights/summary.csv');
    check(
      'the reporting layer still refuses to write',
      post.status === 400 && post.text.includes('read-only'),
      `${post.status} ${post.text.slice(0, 100)}`,
    );

    // ── Sales Analytics by industry ────────────────────────────────────────
    console.log('\nSales analytics by industry');
    type IndustryRow = {
      code: string;
      name: string;
      leads: number;
      won: number;
      wonValue: number;
      lost: number;
      openValue: number;
      weightedValue: number;
    };
    const pl = await api<{
      totals: { leads: number; won: number; wonValue: number; lost: number; openValue: number; weightedValue: number };
      industries: IndustryRow[];
    }>('GET', `/insights/pipeline?${window}`);
    const inds = pl.body.industries ?? [];
    const sum = (k: keyof Omit<IndustryRow, 'code' | 'name'>) => cents(inds.reduce((s, x) => s + x[k], 0));
    check(
      'the industry table sums to the report\'s own totals',
      pl.status === 200 &&
        sum('leads') === pl.body.totals.leads &&
        sum('won') === pl.body.totals.won &&
        sum('lost') === pl.body.totals.lost &&
        money(sum('wonValue'), pl.body.totals.wonValue) &&
        money(sum('openValue'), pl.body.totals.openValue) &&
        money(sum('weightedValue'), pl.body.totals.weightedValue),
      JSON.stringify({
        leads: [sum('leads'), pl.body.totals.leads],
        won: [sum('wonValue'), pl.body.totals.wonValue],
        open: [sum('openValue'), pl.body.totals.openValue],
      }),
    );
    const activeCodes = (await prisma.industry.findMany({ where: { isActive: true }, select: { code: true } })).map((x) => x.code);
    check(
      'every active industry is listed, even at zero, and Unclassified comes last',
      activeCodes.every((code) => inds.some((x) => x.code === code)) && inds[inds.length - 1]?.code === 'UNCLASSIFIED',
      inds.map((x) => x.code).join(', '),
    );
    const hi = inds.find((x) => x.code === 'HI');
    const openHi = await prisma.quotation.findMany({
      where: { outcome: { in: ['OPEN', 'SUBMITTED', 'NEGOTIATION'] }, customer: { industry: { code: 'HI' } } },
      select: { revisions: { select: { total: true, status: true, revision: true } } },
    });
    const hiLeads = await prisma.lead.count({
      where: { createdAt: { gte: range.from, lte: range.to }, customer: { industry: { code: 'HI' } } },
    });
    check(
      'the healthcare row equals the records read directly',
      !!hi &&
        hi.leads === hiLeads &&
        money(hi.openValue, cents(openHi.reduce((s, q) => s + quotationValue(q.revisions), 0))) &&
        hi.won >= 1,
      `${JSON.stringify(hi)} vs leads ${hiLeads}, ${openHi.length} open`,
    );
    const unclassified = inds.find((x) => x.code === 'UNCLASSIFIED');
    const unlinkedLeads = await prisma.lead.count({
      where: {
        createdAt: { gte: range.from, lte: range.to },
        OR: [{ customerId: null }, { customer: { industryId: null } }],
      },
    });
    check(
      'a lead with no customer lands in Unclassified',
      !!unclassified && unclassified.leads === unlinkedLeads && unclassified.leads >= 1,
      `${JSON.stringify(unclassified)} vs ${unlinkedLeads}`,
    );
    const plCsv = await api('GET', `/insights/pipeline.csv?${window}`);
    const plHeader = plCsv.text.replace(/^﻿/, '').split('\r\n')[0];
    check(
      'the pipeline CSV appends an Industry column',
      plCsv.status === 200 && plHeader.endsWith(',Industry') && plCsv.text.includes('HI '),
      plHeader,
    );
  }

  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch(async (err) => {
    console.error(err);
    process.exitCode = 1;
    await cleanup().catch(() => undefined);
  })
  .finally(() => prisma.$disconnect());
