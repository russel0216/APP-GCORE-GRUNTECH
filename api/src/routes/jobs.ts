import { Router } from 'express';
import { z } from 'zod';
import { Prisma, JobStatus, JobType, CostState } from '@prisma/client';
import { prisma } from '../prisma';
import {
  handler,
  parseBody,
  listQuery,
  listResult,
  orderBy,
  idsFilter,
  notFound,
  badRequest,
  forbidden,
  type ListQuery,
} from '../http/kit';
import { authenticate, require_, requireAny, currentUser } from '../auth/middleware';
import type { ResolvedUser } from '../permissions/resolve';
import { audit } from '../shared/audit';
import { renderDocument, formatAmount, formatMoney, formatShortDate, statusLabel, companyCurrency, type PdfSection } from '../shared/pdf';
import { nextNumber } from '../shared/numbering';
import { notify } from '../shared/notifications';
import { addMonths, dayKey, planSchedule } from '../shared/aftermarket';
import { addDays } from '../shared/day';
import { LIST_CAP, listReference, totalLabel, bracketed, bracketNote, listNotes, listDay, namedInFilter, choice, sendListPdf } from '../shared/listPaper';

const d = (v: number | string | null | undefined) =>
  v === null || v === undefined ? new Prisma.Decimal(0) : new Prisma.Decimal(v);
const num = (v: Prisma.Decimal | null | undefined) => (v == null ? 0 : Number(v));

/** Rounds to centavos — every money figure crossing the API boundary. */
const cents = (n: number) => Math.round(n * 100) / 100;

export const jobRoutes = Router();
jobRoutes.use(authenticate);

// ════════════════════════════════════════════════════════════════════
//  BUDGET MONITORING — the four-state view over the cost ledger
// ════════════════════════════════════════════════════════════════════

export interface CategoryPosition {
  costCategoryId: string;
  code: string;
  name: string;
  sortOrder: number;
  budgeted: number;
  committed: number;
  incurred: number;
  consumed: number;
  available: number;
  usedPct: number;
}

/**
 * Budget Monitoring (model §5.1).
 *
 * Available = Budgeted − Committed − Incurred.
 *
 * CONSUMED is reported but deliberately NOT subtracted: stock issued to a job
 * was already counted as Incurred when it was received. Subtracting both would
 * charge the same peso twice. Consumed answers a different question — how much
 * of what we bought is actually in the work.
 */
export async function budgetPosition(jobId: string): Promise<CategoryPosition[]> {
  const [categories, entries] = await Promise.all([
    prisma.costCategory.findMany({ orderBy: { sortOrder: 'asc' } }),
    prisma.jobCostEntry.groupBy({
      by: ['costCategoryId', 'state'],
      where: { jobId },
      _sum: { amount: true },
    }),
  ]);

  const key = (categoryId: string, state: string) => `${categoryId}:${state}`;
  const sums = new Map<string, number>();
  for (const row of entries) {
    sums.set(key(row.costCategoryId, row.state), num(row._sum.amount));
  }

  return categories.map((c) => {
    const budgeted = sums.get(key(c.id, 'BUDGETED')) ?? 0;
    const committed = sums.get(key(c.id, 'COMMITTED')) ?? 0;
    const incurred = sums.get(key(c.id, 'INCURRED')) ?? 0;
    const consumed = sums.get(key(c.id, 'CONSUMED')) ?? 0;
    const available = cents(budgeted - committed - incurred);
    return {
      costCategoryId: c.id,
      code: c.code,
      name: c.name,
      sortOrder: c.sortOrder,
      budgeted: cents(budgeted),
      committed: cents(committed),
      incurred: cents(incurred),
      consumed: cents(consumed),
      available,
      usedPct: budgeted > 0 ? cents(((committed + incurred) / budgeted) * 100) : 0,
    };
  });
}

// ════════════════════════════════════════════════════════════════════
//  S-CURVE — planned vs actual vs billed (model §5.3)
// ════════════════════════════════════════════════════════════════════

interface CurvePoint {
  date: string;
  planned: number;
  actual: number | null;
  billed: number | null;
}

/**
 * Three curves, one chart.
 *
 * PLANNED comes from the scope items' scheduled dates and values — value
 * accrues linearly across each item's planned window. ACTUAL comes from
 * approved progress reports. BILLED comes from progress billings.
 *
 * The gap between actual and billed is work done but not yet invoiced: cash
 * you are owed and have not asked for. The gap between planned and actual is
 * schedule slip. Neither is visible from a single curve, which is why there
 * are three.
 */
export async function sCurve(jobId: string): Promise<CurvePoint[]> {
  const [job, scopeItems, reports, billings] = await Promise.all([
    prisma.job.findUnique({ where: { id: jobId } }),
    prisma.jobScopeItem.findMany({ where: { jobId }, orderBy: { sortOrder: 'asc' } }),
    prisma.progressReport.findMany({
      where: { jobId, status: 'APPROVED' },
      include: { lines: true },
      orderBy: { periodTo: 'asc' },
    }),
    // Plotted against the PERIOD the billing covers, not the date it was
    // raised. The three curves have to share a time basis or comparing them is
    // meaningless — and the comparison is the entire point: the gap between
    // actual and billed is work done but not yet invoiced.
    prisma.progressBilling.findMany({
      where: { jobId, status: { in: ['APPROVED', 'INVOICED'] } },
      include: { progressReport: { select: { periodTo: true } } },
      orderBy: { billingNo: 'asc' },
    }),
  ]);
  if (!job || !scopeItems.length) return [];

  const contractValue = scopeItems.reduce((s, i) => s + num(i.value), 0);
  if (contractValue <= 0) return [];

  // Collect every date the curves could change at.
  const dates = new Set<string>();
  const iso = (dt: Date) => dt.toISOString().slice(0, 10);

  for (const item of scopeItems) {
    if (item.plannedStart) dates.add(iso(item.plannedStart));
    if (item.plannedEnd) dates.add(iso(item.plannedEnd));
  }
  for (const r of reports) dates.add(iso(r.periodTo));
  for (const b of billings) dates.add(iso(b.progressReport.periodTo));
  if (job.startDate) dates.add(iso(job.startDate));

  const ordered = [...dates].sort();
  if (!ordered.length) return [];

  const lastReportDate = reports.length ? iso(reports[reports.length - 1].periodTo) : null;
  const lastBillingDate = billings.length
    ? iso(billings[billings.length - 1].progressReport.periodTo)
    : null;

  return ordered.map((date) => {
    const at = new Date(`${date}T23:59:59`);

    // Planned: each scope item accrues its value linearly across its window.
    let planned = 0;
    for (const item of scopeItems) {
      const value = num(item.value);
      if (!item.plannedStart || !item.plannedEnd) continue;
      if (at < item.plannedStart) continue;
      if (at >= item.plannedEnd) {
        planned += value;
        continue;
      }
      const span = item.plannedEnd.getTime() - item.plannedStart.getTime();
      const done = at.getTime() - item.plannedStart.getTime();
      planned += span > 0 ? (value * done) / span : value;
    }

    // Actual: the latest approved report on or before this date.
    let actual: number | null = null;
    const upto = reports.filter((r) => iso(r.periodTo) <= date);
    if (upto.length) {
      const latest = upto[upto.length - 1];
      const byItem = new Map(latest.lines.map((l) => [l.scopeItemId, num(l.toDatePct)]));
      actual = scopeItems.reduce(
        (sum, item) => sum + (num(item.value) * (byItem.get(item.id) ?? 0)) / 100,
        0,
      );
    }

    const billedSoFar = billings
      .filter((b) => iso(b.progressReport.periodTo) <= date)
      .reduce((sum, b) => sum + num(b.grossAmount), 0);

    return {
      date,
      planned: cents((planned / contractValue) * 100),
      // Null past the last data point, so the line stops rather than
      // flat-lining and implying nothing happened since.
      actual:
        actual !== null && lastReportDate && date <= lastReportDate
          ? cents((actual / contractValue) * 100)
          : null,
      billed:
        lastBillingDate && date <= lastBillingDate
          ? cents((billedSoFar / contractValue) * 100)
          : null,
    };
  });
}

// ════════════════════════════════════════════════════════════════════
//  JOBS
// ════════════════════════════════════════════════════════════════════

const JOB_STATUSES = [
  'PLANNING',
  'IN_PROGRESS',
  'ON_HOLD',
  'COMPLETED',
  'TURNED_OVER',
  'CANCELLED',
] as const;

// ── The list, and its two printed twins ───────────────────────────────────────

const JOB_SORTS = ['number', 'name', 'contractValue', 'startDate', 'createdAt'];

/**
 * Which projects a list query means — one rule for the Projects list, the
 * Budget Monitoring list (the same endpoint) and both printed twins, so the
 * paper never shows a different set from the screen it was printed off.
 * `?ids=` (the rows ticked) is ANDed with the visibility rule.
 */
export function jobListWhere(me: ResolvedUser, q: ListQuery): Prisma.JobWhereInput {
  const and: Prisma.JobWhereInput[] = [];
  const onlyOwn = !me.isSuperAdmin && !me.permissions.has('gops.projects.view_all');
  if (onlyOwn || q.scope === 'mine') and.push({ OR: [{ projectManagerId: me.id }, { createdById: me.id }] });
  if (q.search) {
    const term = q.search;
    and.push({
      OR: [
        { name: { contains: term, mode: 'insensitive' } },
        { number: { contains: term, mode: 'insensitive' } },
        { customerPoNumber: { contains: term, mode: 'insensitive' } },
        { customer: { name: { contains: term, mode: 'insensitive' } } },
      ],
    });
  }
  const ids = idsFilter(q.filters.ids);
  if (ids) and.push({ id: { in: ids } });
  const status = choice(q.filters.status, JobStatus, 'Status');
  if (status) and.push({ status });
  const type = choice(q.filters.type, JobType, 'Type');
  if (type) and.push({ type });
  if (q.filters.customerId) and.push({ customerId: q.filters.customerId });
  return and.length ? { AND: and } : {};
}

/** What the filter line says for the projects' own filters. */
async function jobFilterLine(q: ListQuery): Promise<(string | null)[]> {
  const f = q.filters;
  const named = await namedInFilter({ customerId: f.customerId });
  return [
    q.search ? `search "${q.search}"` : null,
    f.status ? `status ${statusLabel(f.status)}` : null,
    f.type ? `type ${statusLabel(f.type)}` : null,
    named.customer ? `customer ${named.customer}` : null,
    q.scope === 'mine' ? 'managed or created by me' : null,
    f.ids ? 'the rows selected' : null,
  ];
}

const jobListInclude = {
  customer: { select: { id: true, name: true } },
  site: { select: { id: true, name: true } },
  projectManager: { select: { id: true, name: true } },
  costing: { select: { id: true, number: true, totalCost: true } },
  progressReports: {
    where: { status: 'APPROVED' },
    orderBy: { reportNo: 'desc' },
    take: 1,
    include: { lines: true },
  },
  scopeItems: { select: { id: true, value: true } },
} satisfies Prisma.JobInclude;

/**
 * A list row as the screens show it: progress from the latest approved
 * report against the schedule of values, billed and spent from two grouped
 * queries rather than one per row, and the EXPECTED margin from the costing —
 * margin from spend-so-far reads 100% on a job that has barely started.
 */
async function presentJobRows(rows: Prisma.JobGetPayload<{ include: typeof jobListInclude }>[]) {
  const jobIds = rows.map((r) => r.id);
  const [billed, incurred] = await Promise.all([
    prisma.progressBilling.groupBy({
      by: ['jobId'],
      where: { jobId: { in: jobIds }, status: { in: ['APPROVED', 'INVOICED'] } },
      _sum: { grossAmount: true },
    }),
    prisma.jobCostEntry.groupBy({
      by: ['jobId'],
      where: { jobId: { in: jobIds }, state: { in: ['INCURRED', 'COMMITTED'] } },
      _sum: { amount: true },
    }),
  ]);
  const billedBy = new Map(billed.map((b) => [b.jobId, num(b._sum.grossAmount)]));
  const spentBy = new Map(incurred.map((b) => [b.jobId, num(b._sum.amount)]));

  return rows.map((r) => {
    const contractValue = num(r.contractValue);
    const scopeTotal = r.scopeItems.reduce((s, i) => s + num(i.value), 0);
    const latest = r.progressReports[0];
    let progressPct = 0;
    if (latest && scopeTotal > 0) {
      const byItem = new Map(latest.lines.map((l) => [l.scopeItemId, num(l.toDatePct)]));
      const earned = r.scopeItems.reduce((sum, i) => sum + (num(i.value) * (byItem.get(i.id) ?? 0)) / 100, 0);
      progressPct = cents((earned / scopeTotal) * 100);
    }
    const spent = spentBy.get(r.id) ?? 0;
    const estimatedCost = num(r.costing?.totalCost);
    return {
      id: r.id,
      number: r.number,
      type: r.type,
      status: r.status,
      name: r.name,
      customer: r.customer,
      site: r.site,
      projectManager: r.projectManager,
      contractValue,
      actualCost: cents(spent),
      expectedMarginPct: contractValue > 0 ? cents(((contractValue - estimatedCost) / contractValue) * 100) : 0,
      grossProfit: cents(contractValue - spent),
      grossMarginPct: contractValue > 0 ? cents(((contractValue - spent) / contractValue) * 100) : 0,
      billed: cents(billedBy.get(r.id) ?? 0),
      progressPct,
      startDate: r.startDate,
      targetEndDate: r.targetEndDate,
      createdAt: r.createdAt,
    };
  });
}

jobRoutes.get(
  '/',
  requireAny('gops.projects.view_all', 'gops.projects.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const where = jobListWhere(me, q);

    const [rows, total] = await Promise.all([
      prisma.job.findMany({
        where,
        include: jobListInclude,
        orderBy: orderBy(q, JOB_SORTS, { createdAt: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.job.count({ where }),
    ]);

    res.json(listResult(await presentJobRows(rows), total, q));
  }),
);

/**
 * The rows a printed twin covers — the list's own where and sort, at most
 * LIST_CAP — and the money the WHOLE set adds up to, read off the records
 * (not the printed rows), so a cut list's totals still cover every row.
 *
 * A cancelled project is listed but not counted — the job orders' and the
 * service contracts' rule, and G-FIN's: its figures print in brackets, the
 * totals leave it out, and `cancelled` is how many the note under them says
 * were left out. Its contract value is work that will not be done.
 */
async function printedJobs(me: ResolvedUser, q: ListQuery) {
  const where = jobListWhere(me, q);
  const counted: Prisma.JobWhereInput = { AND: [where, { status: { not: 'CANCELLED' } }] };
  const [rows, count, cancelled, contract, billed, spent] = await Promise.all([
    prisma.job.findMany({ where, include: jobListInclude, orderBy: orderBy(q, JOB_SORTS, { createdAt: 'desc' }), take: LIST_CAP }),
    prisma.job.count({ where }),
    prisma.job.count({ where: { AND: [where, { status: 'CANCELLED' }] } }),
    prisma.job.aggregate({ where: counted, _sum: { contractValue: true } }),
    prisma.progressBilling.aggregate({ where: { job: counted, status: { in: ['APPROVED', 'INVOICED'] } }, _sum: { grossAmount: true } }),
    prisma.jobCostEntry.aggregate({ where: { job: counted, state: { in: ['INCURRED', 'COMMITTED'] } }, _sum: { amount: true } }),
  ]);
  return {
    rows: await presentJobRows(rows),
    count,
    cancelled,
    sums: { contract: num(contract._sum.contractValue), billed: num(billed._sum.grossAmount), spent: num(spent._sum.amount) },
  };
}

/** A project's figure on a printed list: in brackets, and so not in the totals, when the project is cancelled. */
const jobAmount = (j: { status: string }, value: number) => bracketed(formatAmount(value), j.status !== 'CANCELLED');

/** "18.5%" — a list's percentage, one decimal, as the screen shows it. */
const pct1 = (v: number) => `${v.toFixed(1)}%`;

/**
 * The Projects list on paper (rule 6, A5): the screen's own columns — number,
 * project and customer, manager, progress, contract, billed, expected margin,
 * target end, status — on landscape pages, money as amounts with the code in
 * the head and the sums in the totals block. Declared above `/:id`.
 */
jobRoutes.get(
  '/pdf',
  requireAny('gops.projects.view_all', 'gops.projects.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const [{ rows, count, cancelled, sums }, filters, currency] = await Promise.all([printedJobs(me, q), jobFilterLine(q), companyCurrency()]);

    const pdf = await renderDocument({
      title: 'Projects',
      date: new Date(),
      reference: listReference(count, rows.length, ['project', 'projects'], filters),
      landscape: true,
      sections: [
        {
          kind: 'table',
          head: ['Number', 'Project and customer', 'Manager', 'Progress', `Contract (${currency})`, `Billed (${currency})`, 'Expected margin', 'Target end', 'Status'],
          align: ['left', 'left', 'left', 'right', 'right', 'right', 'right', 'left', 'left'],
          rows: rows.map((j) => [
            j.number,
            { title: j.name, body: [j.customer.name, j.site?.name].filter(Boolean).join(' · ') },
            j.projectManager?.name ?? 'Unassigned',
            pct1(j.progressPct),
            jobAmount(j, j.contractValue),
            jobAmount(j, j.billed),
            pct1(j.expectedMarginPct),
            j.targetEndDate ? formatShortDate(j.targetEndDate) : '',
            statusLabel(j.status),
          ]),
        },
        {
          kind: 'totals',
          rows: [
            { label: totalLabel('Billed', count, rows.length), value: formatMoney(sums.billed, currency) },
            { label: totalLabel('Contract value', count, rows.length), value: formatMoney(sums.contract, currency), bold: true },
          ],
        },
        ...listNotes([bracketNote(cancelled, ['cancelled project', 'cancelled projects'])]),
      ],
    });

    await audit(
      { entityType: 'job', entityId: 'list', action: 'EXPORTED', summary: `Exported the projects list as PDF (${listReference(count, rows.length, ['project', 'projects'], [])})` },
      req,
    );
    sendListPdf(res, pdf, 'projects.pdf');
  }),
);

/**
 * Budget Monitoring on paper: the same projects as the Projects list (the
 * screen reads `/jobs`), in the budget view's columns — progress, contract,
 * cost to date, billed, unbilled (earned to date less billed) and the
 * expected margin. Cost to date is budget monitoring's figure, so the paper
 * takes that right as well as the list's. Declared above `/:id`.
 */
jobRoutes.get(
  '/budget-monitoring/pdf',
  requireAny('gops.projects.view_all', 'gops.projects.view_own'),
  require_('gops.budget_monitoring.view_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const [{ rows, count, cancelled, sums }, filters, currency] = await Promise.all([printedJobs(me, q), jobFilterLine(q), companyCurrency()]);
    const unbilled = (j: (typeof rows)[number]) => cents((j.contractValue * j.progressPct) / 100 - j.billed);

    const pdf = await renderDocument({
      title: 'Budget Monitoring',
      date: new Date(),
      reference: listReference(count, rows.length, ['project', 'projects'], filters),
      landscape: true,
      sections: [
        {
          kind: 'table',
          head: ['Number', 'Project and customer', 'Progress', `Contract (${currency})`, `Cost to date (${currency})`, `Billed (${currency})`, `Unbilled (${currency})`, 'Expected margin'],
          // Sized here: the engine sizes a column from its cells, and four
          // short figures would stack each head a word to a line.
          widths: [1.6, 2.8, 1.1, 1.3, 1.3, 1.3, 1.3, 1.1],
          align: ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right'],
          rows: rows.map((j) => [
            j.number,
            { title: j.name, body: j.customer.name },
            pct1(j.progressPct),
            jobAmount(j, j.contractValue),
            jobAmount(j, j.actualCost),
            jobAmount(j, j.billed),
            jobAmount(j, unbilled(j)),
            pct1(j.expectedMarginPct),
          ]),
        },
        {
          kind: 'totals',
          rows: [
            { label: totalLabel('Cost to date', count, rows.length), value: formatMoney(sums.spent, currency) },
            { label: totalLabel('Billed', count, rows.length), value: formatMoney(sums.billed, currency) },
            // Earned less billed is a per-project figure; summed only where
            // every project is on the page, and — as every total here — over
            // the projects not cancelled.
            ...(count > rows.length
              ? []
              : [
                  {
                    label: 'Unbilled',
                    value: formatMoney(cents(rows.filter((j) => j.status !== 'CANCELLED').reduce((t, j) => t + unbilled(j), 0)), currency),
                  },
                ]),
            { label: totalLabel('Contract value', count, rows.length), value: formatMoney(sums.contract, currency), bold: true },
          ],
        },
        ...listNotes([bracketNote(cancelled, ['cancelled project', 'cancelled projects'])]),
      ],
    });

    await audit(
      {
        entityType: 'job',
        entityId: 'list',
        action: 'EXPORTED',
        summary: `Exported the budget monitoring list as PDF (${listReference(count, rows.length, ['project', 'projects'], [])})`,
      },
      req,
    );
    sendListPdf(res, pdf, 'budget-monitoring.pdf');
  }),
);

/**
 * The job picker every other module uses.
 *
 * Open work only by default: a purchase request, a stock issue or a supplier
 * bill for a project that is finished is almost always a mis-pick, and a list
 * that offers two years of closed jobs makes the mis-pick likely. A screen that
 * legitimately needs closed ones — registering equipment at turnover, a late
 * supplier bill — passes `?includeClosed=true`. CANCELLED is never offered.
 * `?q=` narrows by number, name or customer.
 */
jobRoutes.get(
  '/lookup',
  requireAny('gops.projects.view_all', 'gops.projects.view_own'),
  handler(async (req, res) => {
    const includeClosed = req.query.includeClosed === 'true';
    const term = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const where: Prisma.JobWhereInput = {
      status: { notIn: includeClosed ? ['CANCELLED'] : ['CANCELLED', 'COMPLETED', 'TURNED_OVER'] },
    };
    if (term) {
      where.OR = [
        { number: { contains: term, mode: 'insensitive' } },
        { name: { contains: term, mode: 'insensitive' } },
        { customer: { name: { contains: term, mode: 'insensitive' } } },
      ];
    }
    res.json(
      await prisma.job.findMany({
        where,
        select: { id: true, number: true, name: true, status: true },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    );
  }),
);

/**
 * Creating a job from an approved quotation revision.
 *
 * The costing carries across the budget AND the schedule of values, snapshotted
 * so later edits to the costing cannot move the ground under reported progress.
 */
const createJobSchema = z.object({
  quotationRevisionId: z.string().optional().nullable(),
  costingId: z.string().min(1, 'A job needs a costing'),
  name: z.string().trim().min(2, 'Name the job'),
  type: z.enum(['PROJECT', 'SERVICE_CONTRACT']).default('PROJECT'),
  customerId: z.string().min(1, 'Choose a customer'),
  siteId: z.string().optional().nullable(),
  contactId: z.string().optional().nullable(),
  projectManagerId: z.string().optional().nullable(),
  customerPoNumber: z.string().trim().optional().nullable(),
  customerPoDate: z.string().optional().nullable(),
  contractDate: z.string().optional().nullable(),
  startDate: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  /**
   * Renewing an expiring service contract. The new job is forced to
   * SERVICE_CONTRACT and its DRAFT coverage terms are written in the same
   * transaction, so a renewal can never exist as a job with no contract.
   */
  renewedFromContractId: z.string().optional().nullable(),
});

const DAY_MS = 86_400_000;

/**
 * The renewal's term, the same length as the one it replaces.
 *
 * Contracts are written in whole months far more often than in days, so a term
 * that runs exactly N months (1 Oct – 30 Sep) renews as N months — otherwise a
 * leap year would shift every later renewal by a day. Anything else keeps its
 * length in days.
 */
export function renewalTerm(old: { startsAt: Date; endsAt: Date }): { startsAt: Date; endsAt: Date } {
  const oldStart = dayKey(old.startsAt);
  const oldEnd = dayKey(old.endsAt);
  const startsAt = new Date(oldEnd.getTime() + DAY_MS);

  const months =
    (startsAt.getUTCFullYear() - oldStart.getUTCFullYear()) * 12 +
    (startsAt.getUTCMonth() - oldStart.getUTCMonth());
  if (months > 0 && addMonths(oldStart, months).getTime() === startsAt.getTime()) {
    return { startsAt, endsAt: new Date(addMonths(startsAt, months).getTime() - DAY_MS) };
  }
  return { startsAt, endsAt: new Date(startsAt.getTime() + (oldEnd.getTime() - oldStart.getTime())) };
}

function asDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const date = new Date(v);
  if (Number.isNaN(date.getTime())) throw badRequest(`"${v}" is not a valid date`);
  return date;
}

type JobCosting = Prisma.CostingGetPayload<{ include: { lines: true; scopeSections: true } }>;

/**
 * The costing a project is built on, checked: decided (not with the
 * approver), the project's customer, with a scope of work that adds up to the
 * contract value. The one rule for POST /jobs and for a job order's approval
 * (2026-10-09), which builds the project itself.
 */
export async function costingForJob(costingId: string, customerId: string): Promise<JobCosting> {
  const costing = await prisma.costing.findUnique({
    where: { id: costingId },
    include: {
      lines: true,
      scopeSections: { orderBy: { sortOrder: 'asc' } },
    },
  });
  if (!costing) throw notFound('Costing not found');
  // A costing with the approver is still being decided; building on it would
  // finalise it underneath them.
  if (costing.status === 'PENDING_APPROVAL') {
    throw badRequest(`${costing.number} is awaiting approval. Build the project once it is decided.`);
  }
  // The job's customer is the costing's customer. The screen locks it; this
  // is the half that makes it true for any caller.
  if (costing.customerId && costing.customerId !== customerId) {
    throw badRequest(
      `${costing.number} was costed for a different customer. A project takes its customer from its costing.`,
    );
  }
  if (!costing.scopeSections.length) {
    throw badRequest(
      'That costing has no scope of work. The scope sections become the schedule of values, which progress and billing are measured against.',
    );
  }

  const scopeTotal = costing.scopeSections.reduce((s, x) => s + num(x.value), 0);
  const contractValue = num(costing.contractValue);
  if (Math.abs(scopeTotal - contractValue) > 0.01) {
    throw badRequest(
      `The costing's scope sections total ${scopeTotal.toFixed(2)} but its contract value is ${contractValue.toFixed(2)}. Reconcile them first — otherwise progress billing cannot add up.`,
    );
  }
  return costing;
}

export interface NewJobInput {
  name: string;
  type: 'PROJECT' | 'SERVICE_CONTRACT';
  customerId: string;
  siteId?: string | null;
  contactId?: string | null;
  projectManagerId?: string | null;
  quotationRevisionId?: string | null;
  customerPoNumber?: string | null;
  customerPoDate?: Date | null;
  contractDate?: Date | null;
  /** Manila's day; the scope items are scheduled back to back from it. */
  startDate: Date;
  /** Given, the project's target end; else the day the last scope item ends. */
  targetEndDate?: Date | null;
  notes?: string | null;
  createdById: string;
}

/**
 * Writes the project in the caller's transaction: its number, the scope
 * items snapshotted from the costing (back to back from the start date — a
 * sensible default, not a claim about the plan), the opening budget as
 * BUDGETED ledger rows per category, and the costing marked FINAL — a costing
 * that has produced a job is a commercial record.
 */
export async function createJobRecord(tx: Prisma.TransactionClient, costing: JobCosting, input: NewJobInput) {
  const number = await nextNumber('project', tx);
  let cursor = new Date(input.startDate);
  const scopeData = costing.scopeSections.map((s, i) => {
    const plannedStart = new Date(cursor);
    const plannedEnd = addDays(cursor, Math.max(s.durationDays, 1));
    cursor = plannedEnd;
    return {
      sourceSectionId: s.id,
      kind: s.kind,
      name: s.name,
      description: s.description,
      value: s.value,
      durationDays: s.durationDays,
      plannedStart,
      plannedEnd,
      sortOrder: i,
    };
  });

  const created = await tx.job.create({
    data: {
      number,
      type: input.type,
      name: input.name,
      customerId: input.customerId,
      siteId: input.siteId || null,
      contactId: input.contactId || null,
      costingId: costing.id,
      quotationRevisionId: input.quotationRevisionId || null,
      projectManagerId: input.projectManagerId || null,
      createdById: input.createdById,
      contractValue: costing.contractValue,
      customerPoNumber: input.customerPoNumber || null,
      customerPoDate: input.customerPoDate ?? null,
      contractDate: input.contractDate ?? null,
      startDate: input.startDate,
      targetEndDate: input.targetEndDate ?? cursor,
      notes: input.notes || null,
      scopeItems: { create: scopeData },
    },
  });

  const byCategory = new Map<string, number>();
  for (const line of costing.lines) {
    byCategory.set(line.costCategoryId, (byCategory.get(line.costCategoryId) ?? 0) + num(line.amount));
  }
  if (byCategory.size) {
    await tx.jobCostEntry.createMany({
      data: [...byCategory.entries()].map(([costCategoryId, amount]) => ({
        jobId: created.id,
        costCategoryId,
        state: 'BUDGETED' as const,
        amount: d(amount),
        sourceType: 'costing',
        sourceId: costing.id,
        sourceNumber: costing.number,
        description: 'Opening budget from costing',
        createdById: input.createdById,
      })),
    });
  }

  if (costing.status !== 'FINAL') {
    await tx.costing.update({ where: { id: costing.id }, data: { status: 'FINAL', finalAt: new Date() } });
  }
  return created;
}

jobRoutes.post(
  '/',
  require_('gops.projects.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(createJobSchema, req.body);

    const costing = await costingForJob(body.costingId, body.customerId);

    if (body.quotationRevisionId) {
      const revision = await prisma.quotationRevision.findUnique({
        where: { id: body.quotationRevisionId },
      });
      if (!revision) throw notFound('Quotation revision not found');
      if (revision.status !== 'APPROVED') {
        throw badRequest('Only an approved quotation revision can become a job');
      }
    }

    // A renewal: load the contract it replaces and refuse anything that would
    // leave the renewal chain ambiguous.
    const renewing = body.renewedFromContractId
      ? await prisma.serviceContract.findUnique({
          where: { id: body.renewedFromContractId },
          include: {
            job: { select: { customerId: true } },
            renewedTo: { select: { number: true } },
            assets: { select: { assetId: true } },
          },
        })
      : null;
    if (body.renewedFromContractId) {
      if (!renewing) throw notFound('The contract being renewed was not found');
      if (!me.isSuperAdmin && !me.permissions.has('gops.service_contracts.create')) {
        throw forbidden(
          'Renewing a contract writes new coverage terms — that needs "gops.service_contracts.create"',
        );
      }
      if (renewing.renewedTo) {
        throw badRequest(`${renewing.number} has already been renewed as ${renewing.renewedTo.number}`);
      }
      if (renewing.status === 'DRAFT' || renewing.status === 'CANCELLED') {
        throw badRequest(
          `${renewing.number} is ${renewing.status.toLowerCase()} — only a contract that ran can be renewed`,
        );
      }
      if (renewing.job.customerId !== body.customerId) {
        throw badRequest(`${renewing.number} covers a different customer's equipment`);
      }
    }
    const type = renewing ? ('SERVICE_CONTRACT' as const) : body.type;

    // Manila's date: a bare new Date() is stored as the UTC date, yesterday's until 08:00.
    const start = asDate(body.startDate) ?? dayKey(new Date());

    const job = await prisma.$transaction(async (tx) => {
      const created = await createJobRecord(tx, costing, {
        name: body.name,
        type,
        customerId: body.customerId,
        siteId: body.siteId,
        contactId: body.contactId,
        projectManagerId: body.projectManagerId,
        quotationRevisionId: body.quotationRevisionId,
        customerPoNumber: body.customerPoNumber,
        customerPoDate: asDate(body.customerPoDate),
        contractDate: asDate(body.contractDate),
        startDate: start,
        notes: body.notes,
        createdById: me.id,
      });

      // The renewal's coverage terms: a DRAFT, so nothing is scheduled until
      // somebody activates it — the same rule as any new contract. Same term
      // length, same frequency and wording, the same equipment; it starts the
      // day after the old one ends.
      let serviceContract: { id: string; number: string } | null = null;
      if (renewing) {
        const term = renewalTerm(renewing);
        const planned = planSchedule(term.startsAt, term.endsAt, renewing.frequencyMonths);
        serviceContract = await tx.serviceContract.create({
          data: {
            number: await nextNumber('service_contract', tx),
            jobId: created.id,
            startsAt: term.startsAt,
            endsAt: term.endsAt,
            frequencyMonths: renewing.frequencyMonths,
            plannedVisits: planned.length,
            responseTime: renewing.responseTime,
            exclusions: renewing.exclusions,
            coverageNotes: renewing.coverageNotes,
            renewedFromId: renewing.id,
            createdById: me.id,
            assets: { create: renewing.assets.map((a) => ({ assetId: a.assetId })) },
          },
          select: { id: true, number: true },
        });
      }
      return { ...created, serviceContract };
    });

    if (body.projectManagerId && body.projectManagerId !== me.id) {
      await notify({
        userId: body.projectManagerId,
        type: 'system',
        title: `Project assigned to you: ${job.name}`,
        body: job.number,
        link: `/g-ops/projects/${job.id}`,
      });
    }

    await audit(
      {
        entityType: 'job',
        entityId: job.id,
        action: 'CONVERTED',
        summary: `Created ${job.number} — ${job.name} from costing ${costing.number}`,
      },
      req,
    );
    if (job.serviceContract && renewing) {
      await audit(
        {
          entityType: 'service_contract',
          entityId: job.serviceContract.id,
          action: 'CREATED',
          summary: `${job.serviceContract.number} drafted as the renewal of ${renewing.number}, under ${job.number}`,
        },
        req,
      );
    }

    const { serviceContract, ...created } = job;
    res.status(201).json({
      ...created,
      contractValue: num(job.contractValue),
      serviceContractId: serviceContract?.id ?? null,
    });
  }),
);

async function loadJob(id: string) {
  return prisma.job.findUnique({
    where: { id },
    include: {
      customer: { select: { id: true, code: true, name: true } },
      site: { select: { id: true, name: true, address: true, city: true } },
      contact: { select: { id: true, name: true } },
      projectManager: { select: { id: true, name: true } },
      createdBy: { select: { id: true, name: true } },
      costing: { select: { id: true, number: true, title: true, totalCost: true, contractValue: true } },
      quotationRevision: {
        select: {
          id: true,
          revision: true,
          quotation: { select: { id: true, number: true, subject: true } },
        },
      },
      scopeItems: { orderBy: { sortOrder: 'asc' } },
      progressReports: {
        orderBy: { reportNo: 'desc' },
        select: {
          id: true,
          number: true,
          reportNo: true,
          status: true,
          periodFrom: true,
          periodTo: true,
        },
      },
      billings: {
        orderBy: { billingNo: 'desc' },
        select: {
          id: true,
          number: true,
          billingNo: true,
          status: true,
          billingDate: true,
          grossAmount: true,
          netCollectible: true,
        },
      },
      plans: { orderBy: { createdAt: 'desc' } },
      tasks: {
        orderBy: { sortOrder: 'asc' },
        include: { assignedTo: { select: { id: true, name: true } } },
      },
      serviceContract: { select: { id: true, number: true, status: true } },
      _count: { select: { budgetRequests: true, installedAssets: true } },
    },
  });
}

jobRoutes.get(
  '/:id',
  requireAny('gops.projects.view_all', 'gops.projects.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const job = await loadJob(req.params.id);
    if (!job) throw notFound('Job not found');

    const [position, curve] = await Promise.all([budgetPosition(job.id), sCurve(job.id)]);

    const scopeTotal = job.scopeItems.reduce((s, i) => s + num(i.value), 0);
    const latestApproved = await prisma.progressReport.findFirst({
      where: { jobId: job.id, status: 'APPROVED' },
      orderBy: { reportNo: 'desc' },
      include: { lines: true },
    });

    let progressPct = 0;
    if (latestApproved && scopeTotal > 0) {
      const byItem = new Map(latestApproved.lines.map((l) => [l.scopeItemId, num(l.toDatePct)]));
      const earned = job.scopeItems.reduce(
        (sum, i) => sum + (num(i.value) * (byItem.get(i.id) ?? 0)) / 100,
        0,
      );
      progressPct = cents((earned / scopeTotal) * 100);
    }

    const budgeted = position.reduce((s, p) => s + p.budgeted, 0);
    const committed = position.reduce((s, p) => s + p.committed, 0);
    const incurred = position.reduce((s, p) => s + p.incurred, 0);
    const billed = job.billings
      .filter((b) => b.status === 'APPROVED' || b.status === 'INVOICED')
      .reduce((s, b) => s + num(b.grossAmount), 0);

    const contractValue = num(job.contractValue);
    const actualCost = cents(committed + incurred);

    res.json({
      ...job,
      contractValue,
      downpaymentPct: job.downpaymentPct ? num(job.downpaymentPct) : null,
      retentionPct: job.retentionPct ? num(job.retentionPct) : null,
      costing: job.costing
        ? {
            ...job.costing,
            totalCost: num(job.costing.totalCost),
            contractValue: num(job.costing.contractValue),
          }
        : null,
      scopeItems: job.scopeItems.map((i) => ({ ...i, value: num(i.value) })),
      billings: job.billings.map((b) => ({
        ...b,
        grossAmount: num(b.grossAmount),
        netCollectible: num(b.netCollectible),
      })),
      budgetRequestCount: job._count.budgetRequests,
      installedAssetCount: job._count.installedAssets,
      position,
      curve,
      summary: {
        contractValue,
        budgeted: cents(budgeted),
        committed: cents(committed),
        incurred: cents(incurred),
        available: cents(budgeted - committed - incurred),
        actualCost,

        // Margin needs two figures, not one.
        //
        // EXPECTED margin comes from the budget and is meaningful from day one:
        // this is the job we agreed to do for this money. Margin computed from
        // cost-so-far reads 100% on a project that has not spent anything yet,
        // which is true and useless — it tells a project manager nothing and
        // invites them to believe a job is healthier than it is.
        expectedProfit: cents(contractValue - budgeted),
        expectedMarginPct: contractValue > 0 ? cents(((contractValue - budgeted) / contractValue) * 100) : 0,

        // Where the money has actually gone, against what was allowed.
        costUsedPct: budgeted > 0 ? cents((actualCost / budgeted) * 100) : 0,
        // Only meaningful once the job is substantially done; the UI says so.
        grossProfit: cents(contractValue - actualCost),
        grossMarginPct: contractValue > 0 ? cents(((contractValue - actualCost) / contractValue) * 100) : 0,
        progressPct,
        earnedValue: cents((contractValue * progressPct) / 100),
        billed: cents(billed),
        // Work done but not yet invoiced — cash you are owed and have not
        // asked for. The single most useful number on this page.
        unbilled: cents((contractValue * progressPct) / 100 - billed),
        billedPct: contractValue > 0 ? cents((billed / contractValue) * 100) : 0,
      },
    });
  }),
);

const updateJobSchema = z.object({
  name: z.string().trim().min(2).optional(),
  status: z.enum(JOB_STATUSES).optional(),
  siteId: z.string().optional().nullable(),
  contactId: z.string().optional().nullable(),
  projectManagerId: z.string().optional().nullable(),
  customerPoNumber: z.string().trim().optional().nullable(),
  customerPoDate: z.string().optional().nullable(),
  contractDate: z.string().optional().nullable(),
  startDate: z.string().optional().nullable(),
  targetEndDate: z.string().optional().nullable(),
  actualEndDate: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

jobRoutes.patch(
  '/:id',
  require_('gops.projects.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(updateJobSchema, req.body);
    const before = await prisma.job.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound('Job not found');

    const data: Prisma.JobUpdateInput = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.status !== undefined) data.status = body.status;
    if (body.notes !== undefined) data.notes = body.notes || null;
    if (body.customerPoNumber !== undefined) data.customerPoNumber = body.customerPoNumber || null;
    for (const f of ['customerPoDate', 'contractDate', 'startDate', 'targetEndDate', 'actualEndDate'] as const) {
      if (body[f] !== undefined) (data as Record<string, unknown>)[f] = asDate(body[f]);
    }
    if (body.siteId !== undefined) {
      data.site = body.siteId ? { connect: { id: body.siteId } } : { disconnect: true };
    }
    if (body.contactId !== undefined) {
      data.contact = body.contactId ? { connect: { id: body.contactId } } : { disconnect: true };
    }
    if (body.projectManagerId !== undefined) {
      data.projectManager = body.projectManagerId
        ? { connect: { id: body.projectManagerId } }
        : { disconnect: true };
    }

    const job = await prisma.job.update({ where: { id: req.params.id }, data });

    if (body.projectManagerId && body.projectManagerId !== before.projectManagerId) {
      await notify({
        userId: body.projectManagerId,
        type: 'system',
        title: `Project assigned to you: ${job.name}`,
        body: job.number,
        link: `/g-ops/projects/${job.id}`,
      });
    }

    await audit(
      {
        entityType: 'job',
        entityId: job.id,
        action: body.status === 'COMPLETED' ? 'COMPLETED' : 'UPDATED',
        summary:
          body.status && body.status !== before.status
            ? `${job.number}: ${before.status} → ${body.status}`
            : `Updated ${job.number}`,
      },
      req,
    );
    res.json({ ...job, contractValue: num(job.contractValue) });
  }),
);

// ── Cost ledger ──────────────────────────────────────────────────────────────

jobRoutes.get(
  '/:id/ledger',
  require_('gops.budget_monitoring.view_all'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const where: Prisma.JobCostEntryWhereInput = { jobId: req.params.id };
    const state = choice(q.filters.state, CostState, 'State');
    if (state) where.state = state;
    if (q.filters.costCategoryId) where.costCategoryId = q.filters.costCategoryId;

    const [rows, total] = await Promise.all([
      prisma.jobCostEntry.findMany({
        where,
        include: {
          costCategory: { select: { id: true, code: true, name: true } },
          createdBy: { select: { id: true, name: true } },
        },
        orderBy: { occurredAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.jobCostEntry.count({ where }),
    ]);

    res.json(listResult(rows.map((r) => ({ ...r, amount: num(r.amount) })), total, q));
  }),
);

// ── Aftermarket, seen from the job ───────────────────────────────────────────

const REPORT_KEY: Record<string, string> = {
  COMMISSIONING: 'gops.commissioning_reports.view_all',
  PREVENTIVE_MAINTENANCE: 'gops.pm_reports.view_all',
  INSPECTION: 'gops.inspection_reports.view_all',
  CORRECTIVE: 'gops.inspection_reports.view_all',
};

/**
 * What this job left behind in the field: the equipment it installed, the
 * contract that covers it (a service job's own terms), the reports written
 * against either, and job orders charged to it.
 *
 * One read for the workspace's Service tab. Each section is `null` when the
 * caller does not hold that register's `view_all` — the tab then hides the card
 * rather than showing an empty one, which would read as "nothing installed".
 * Numbers, names, dates and statuses only; no money.
 */
jobRoutes.get(
  '/:id/service',
  requireAny('gops.projects.view_all', 'gops.projects.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const can = (key: string) => me.isSuperAdmin || me.permissions.has(key);
    const job = await prisma.job.findUnique({
      where: { id: req.params.id },
      select: { id: true, serviceContract: { select: { id: true } } },
    });
    if (!job) throw notFound('Job not found');

    const [assets, contract, jobOrders] = await Promise.all([
      can('gops.installed_base.view_all')
        ? prisma.installedAsset.findMany({
            where: { jobId: job.id },
            select: {
              id: true,
              code: true,
              name: true,
              manufacturer: true,
              model: true,
              serialNo: true,
              location: true,
              status: true,
              installedAt: true,
              warrantyEndsAt: true,
            },
            orderBy: { code: 'asc' },
          })
        : null,
      can('gops.service_contracts.view_all') && job.serviceContract
        ? prisma.serviceContract.findUnique({
            where: { id: job.serviceContract.id },
            select: {
              id: true,
              number: true,
              status: true,
              startsAt: true,
              endsAt: true,
              frequencyMonths: true,
              plannedVisits: true,
              renewedFrom: { select: { id: true, number: true } },
              renewedTo: { select: { id: true, number: true } },
              _count: { select: { assets: true } },
            },
          })
        : null,
      can('gops.job_orders.view_all')
        ? prisma.jobOrder.findMany({
            where: { jobId: job.id },
            select: { id: true, number: true, title: true, projectName: true, status: true, kind: true, requestedFor: true, targetFinish: true },
            orderBy: { requestedFor: 'desc' },
            take: 50,
          })
        : null,
    ]);

    // Reports: written against the job, its contract, or anything it installed.
    const kinds = Object.keys(REPORT_KEY).filter((k) => can(REPORT_KEY[k]));
    let reports = null;
    if (kinds.length) {
      const assetIds = assets
        ? assets.map((a) => a.id)
        : (await prisma.installedAsset.findMany({ where: { jobId: job.id }, select: { id: true } })).map(
            (a) => a.id,
          );
      const or: Prisma.ServiceReportWhereInput[] = [{ jobId: job.id }];
      if (job.serviceContract) or.push({ contractId: job.serviceContract.id });
      if (assetIds.length) or.push({ assetId: { in: assetIds } });
      reports = await prisma.serviceReport.findMany({
        where: { OR: or, kind: { in: kinds as Prisma.EnumServiceKindFilter['in'] } },
        select: {
          id: true,
          number: true,
          kind: true,
          status: true,
          performedAt: true,
          billable: true,
          asset: { select: { id: true, code: true, name: true } },
          performedBy: { select: { id: true, name: true } },
        },
        orderBy: { performedAt: 'desc' },
        take: 50,
      });
    }

    res.json({
      assets,
      // `contractVisible` separates "no contract" from "not yours to see".
      contract: contract ? { ...contract, assetCount: contract._count.assets, _count: undefined } : null,
      contractVisible: can('gops.service_contracts.view_all'),
      reports,
      jobOrders,
    });
  }),
);
