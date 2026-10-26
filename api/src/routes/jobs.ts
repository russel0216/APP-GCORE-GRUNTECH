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
  deleteOrRefuse,
  type ListQuery,
} from '../http/kit';
import { deleteAttachmentsOf } from '../shared/attachments';
import { authenticate, require_, requireAny, currentUser } from '../auth/middleware';
import { canEditRecord, type ResolvedUser } from '../permissions/resolve';
import { audit } from '../shared/audit';
import { renderDocument, formatAmount, formatMoney, formatShortDate, statusLabel, companyCurrency, type PdfSection, type PdfRow, type PdfCell } from '../shared/pdf';
import { contentDisposition, paperFileName } from '../shared/paperName';
import { phasePctFromTasks } from '../shared/progressReport';
import { nextNumber } from '../shared/numbering';
import { notify } from '../shared/notifications';
import { addMonths, dayKey, planSchedule } from '../shared/aftermarket';
import { workingDayDate, workingDaysBetween } from '../shared/day';
import { planTasks } from '../shared/costingMath';
import { cleanCostingIds, costingIdsOf } from '../shared/costingSets';
import { LIST_CAP, listReference, totalLabel, bracketed, bracketNote, listNotes, listDay, namedInFilter, choice, sendListPdf } from '../shared/listPaper';
import { visibleOwners } from '../shared/team';
import { projectBudgetByLine } from './procurement';
import { adoptBudgetRequests } from '../shared/budgetRequestSources';

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
  // The Project Engineer is on the project too (2026-10-22).
  if (q.scope === 'mine') and.push({ OR: [{ projectManagerId: me.id }, { projectEngineerId: me.id }, { createdById: me.id }] });
  else if (onlyOwn) {
    // View Team reads the projects its team manages or opened (2026-10-19).
    const ids = visibleOwners(me, 'gops', 'projects');
    and.push({ OR: [{ projectManagerId: { in: ids } }, { projectEngineerId: { in: ids } }, { createdById: { in: ids } }] });
  }
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
  otherCostings: { select: { costing: { select: { totalCost: true } } } },
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
    // Every costing behind the project (2026-10-19), the first and the others.
    const estimatedCost = num(r.costing?.totalCost) + r.otherCostings.reduce((sum, o) => sum + num(o.costing.totalCost), 0);
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
  /** The first costing — one alone, as every caller before 2026-10-19 sent. */
  costingId: z.string().optional().nullable(),
  /** Several costings, the first first (2026-10-19); wins over `costingId`. */
  costingIds: z.array(z.string()).max(10, 'A project takes at most ten costings').optional().nullable(),
  name: z.string().trim().min(2, 'Name the job'),
  type: z.enum(['PROJECT', 'SERVICE_CONTRACT']).default('PROJECT'),
  customerId: z.string().min(1, 'Choose a customer'),
  siteId: z.string().optional().nullable(),
  contactId: z.string().optional().nullable(),
  projectManagerId: z.string().optional().nullable(),
  projectEngineerId: z.string().optional().nullable(),
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

type JobCosting = Prisma.CostingGetPayload<{ include: { lines: true; scopeSections: { include: { tasks: true } } } }>;

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
      scopeSections: { orderBy: { sortOrder: 'asc' }, include: { tasks: { orderBy: { sortOrder: 'asc' } } } },
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
      `${costing.number} has no scope of work. The scope sections become the schedule of values, which progress and billing are measured against.`,
    );
  }

  const scopeTotal = costing.scopeSections.reduce((s, x) => s + num(x.value), 0);
  const contractValue = num(costing.contractValue);
  if (Math.abs(scopeTotal - contractValue) > 0.01) {
    throw badRequest(
      `${costing.number}'s scope sections total ${scopeTotal.toFixed(2)} but its contract value is ${contractValue.toFixed(2)}. Reconcile them first — otherwise progress billing cannot add up.`,
    );
  }
  return costing;
}

/**
 * Several costings behind one project (2026-10-19, the owner's call:
 * "sometimes there will be 2 costings to generate the quotation or
 * project"): each checked by `costingForJob`, the first first. Each one's
 * scope adds up to its own contract value, so together they add up to the
 * project's — the schedule of values stays exact.
 */
export async function costingsForJob(costingIds: string[], customerId: string): Promise<JobCosting[]> {
  const ids = cleanCostingIds(costingIds);
  if (!ids.length) throw badRequest('A project needs a costing');
  const out: JobCosting[] = [];
  for (const id of ids) out.push(await costingForJob(id, customerId));
  return out;
}

/**
 * Whether the project's dates tally with its scope of work (2026-10-13):
 * the day its last scope item is planned to end, and the working days
 * (Mon–Sat) from the start to that day and to the target end. The overview
 * says so where the two differ — a target typed by hand is kept, never moved.
 */
export function scheduleTally(job: { startDate: Date | null; targetEndDate: Date | null; scopeItems: { plannedEnd: Date | null }[] }) {
  const ends = job.scopeItems.map((i) => i.plannedEnd).filter((d): d is Date => !!d);
  const planFinish = ends.length ? new Date(Math.max(...ends.map((d) => d.getTime()))) : null;
  const span = (to: Date | null) => (job.startDate && to ? workingDaysBetween(job.startDate, to) : null);
  return { planFinish, planDays: span(planFinish), targetDays: span(job.targetEndDate) };
}

export interface NewJobInput {
  name: string;
  type: 'PROJECT' | 'SERVICE_CONTRACT';
  customerId: string;
  siteId?: string | null;
  contactId?: string | null;
  projectManagerId?: string | null;
  /** The Project Engineer, who prepares the kick-off Gantt chart (2026-10-22). */
  projectEngineerId?: string | null;
  quotationRevisionId?: string | null;
  /**
   * The quotation the project comes from when no approved revision stands
   * behind it (a job order on a quotation under negotiation): its budget
   * requests, and its sales orders', move onto the project (2026-10-26).
   */
  fromQuotationId?: string | null;
  customerPoNumber?: string | null;
  customerPoDate?: Date | null;
  contractDate?: Date | null;
  /** Manila's day; the scope items are placed on the costing's plan from it, in working days. */
  startDate: Date;
  /** Given, the project's target end; else the day the costing's plan finishes. */
  targetEndDate?: Date | null;
  notes?: string | null;
  createdById: string;
}

/**
 * Where each scope item falls on the calendar (2026-10-13, the owner's call:
 * "Finished Date should tally on Total Date declared in the Scope of Work"):
 * the costing's own plan (`planTasks`, working days) put on real dates from
 * the start, Mon–Sat, both ends inclusive — so a plan of 85 working days
 * finishes 85 working days after the start, Sundays skipped. A phase the
 * costing left unplanned (no tasks, no duration) sits on the day the phase
 * before it ends and adds nothing; a costing with no plan at all gives every
 * phase one working day, back to back, so the S-curve still has a shape.
 */
export function scopeDates(
  sections: { durationDays: number; tasks: { startDay: number | null; durationDays: number }[] }[],
  start: Date,
): { items: { plannedStart: Date; plannedEnd: Date }[]; finish: Date } {
  const plan = planTasks(sections.map((s) => ({ durationDays: s.durationDays, tasks: s.tasks })));
  const planned = plan.totalDays > 0;
  let cursor = 1;
  const items = plan.sections.map((p) => {
    const from = planned ? p.start ?? Math.max(1, cursor - 1) : cursor;
    const to = planned ? p.end ?? from : cursor;
    if (planned && p.end) cursor = Math.max(cursor, p.end + 1);
    if (!planned) cursor++;
    return { plannedStart: workingDayDate(start, from), plannedEnd: workingDayDate(start, to) };
  });
  return { items, finish: workingDayDate(start, planned ? plan.totalDays : Math.max(1, cursor - 1)) };
}

/**
 * Writes the project in the caller's transaction: its number, the scope
 * items snapshotted from the costing (placed on the costing's plan from the
 * start date, `scopeDates`), the opening budget as BUDGETED ledger rows per
 * category, and the costing marked FINAL — a costing that has produced a job
 * is a commercial record.
 *
 * Given several costings (2026-10-19) the project is all of them: their
 * scope items one after another (each costing's own phases in its order),
 * each costing's plan running from the same start — they are separate
 * scopes of one job, worked side by side — and the target end the latest
 * finish; the contract value their sum; one opening budget row per costing
 * and category, so the ledger still says which costing each peso came from;
 * every one marked FINAL. The first stays `Job.costingId`, the others are
 * `JobCostingLink` rows.
 */
export async function createJobRecord(
  tx: Prisma.TransactionClient,
  costingOrCostings: JobCosting | JobCosting[],
  input: NewJobInput,
) {
  const costings = Array.isArray(costingOrCostings) ? costingOrCostings : [costingOrCostings];
  if (!costings.length) throw badRequest('A project needs a costing');
  const number = await nextNumber('project', tx);

  let finish: Date | null = null;
  const scopeData: Prisma.JobScopeItemCreateWithoutJobInput[] = [];
  for (const costing of costings) {
    const dates = scopeDates(costing.scopeSections, input.startDate);
    if (!finish || dates.finish.getTime() > finish.getTime()) finish = dates.finish;
    costing.scopeSections.forEach((s, i) => {
      const { plannedStart, plannedEnd } = dates.items[i];
      scopeData.push({
        sourceSectionId: s.id,
        kind: s.kind,
        name: s.name,
        description: s.description,
        value: s.value,
        durationDays: s.durationDays,
        plannedStart,
        plannedEnd,
        sortOrder: scopeData.length,
      });
    });
  }
  const contractValue = costings.reduce((sum, c) => sum.add(c.contractValue), new Prisma.Decimal(0));

  const created = await tx.job.create({
    data: {
      number,
      type: input.type,
      name: input.name,
      customerId: input.customerId,
      siteId: input.siteId || null,
      contactId: input.contactId || null,
      costingId: costings[0].id,
      quotationRevisionId: input.quotationRevisionId || null,
      projectManagerId: input.projectManagerId || null,
      projectEngineerId: input.projectEngineerId || null,
      createdById: input.createdById,
      contractValue,
      customerPoNumber: input.customerPoNumber || null,
      customerPoDate: input.customerPoDate ?? null,
      contractDate: input.contractDate ?? null,
      startDate: input.startDate,
      targetEndDate: input.targetEndDate ?? finish,
      notes: input.notes || null,
      scopeItems: { create: scopeData },
      ...(costings.length > 1
        ? { otherCostings: { create: costings.slice(1).map((c, i) => ({ costingId: c.id, sortOrder: i })) } }
        : {}),
    },
  });

  const budget: Prisma.JobCostEntryCreateManyInput[] = [];
  for (const costing of costings) {
    const byCategory = new Map<string, number>();
    for (const line of costing.lines) {
      byCategory.set(line.costCategoryId, (byCategory.get(line.costCategoryId) ?? 0) + num(line.amount));
    }
    for (const [costCategoryId, amount] of byCategory) {
      budget.push({
        jobId: created.id,
        costCategoryId,
        state: 'BUDGETED' as const,
        amount: d(amount),
        sourceType: 'costing',
        sourceId: costing.id,
        sourceNumber: costing.number,
        description: 'Opening budget from costing',
        createdById: input.createdById,
      });
    }
  }
  if (budget.length) await tx.jobCostEntry.createMany({ data: budget });

  for (const costing of costings) {
    if (costing.status !== 'FINAL') {
      await tx.costing.update({ where: { id: costing.id }, data: { status: 'FINAL', finalAt: new Date() } });
    }
  }

  // The budget requests raised on its costings, its quotation and that
  // quotation's sales orders now count on the project (2026-10-26).
  const quotationId =
    input.fromQuotationId ??
    (input.quotationRevisionId
      ? (await tx.quotationRevision.findUnique({ where: { id: input.quotationRevisionId }, select: { quotationId: true } }))?.quotationId ?? null
      : null);
  await adoptBudgetRequests(tx, created.id, { costingIds: costings.map((c) => c.id), quotationId });
  return created;
}

jobRoutes.post(
  '/',
  require_('gops.projects.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(createJobSchema, req.body);

    const costings = await costingsForJob(costingIdsOf(body) ?? [], body.customerId);
    const costing = costings[0];

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

    // The costing's planned start when the form names none (2026-10-13), else
    // Manila's date: a bare new Date() is stored as the UTC date, yesterday's until 08:00.
    const plannedStarts = costings.map((c) => c.plannedStart).filter((v): v is Date => !!v);
    const start =
      asDate(body.startDate) ??
      (plannedStarts.length ? new Date(Math.min(...plannedStarts.map((v) => v.getTime()))) : null) ??
      dayKey(new Date());

    const job = await prisma.$transaction(async (tx) => {
      const created = await createJobRecord(tx, costings, {
        name: body.name,
        type,
        customerId: body.customerId,
        siteId: body.siteId,
        contactId: body.contactId,
        projectManagerId: body.projectManagerId,
        projectEngineerId: body.projectEngineerId,
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
        summary: `Created ${job.number} — ${job.name} from costing${costings.length > 1 ? "s" : ""} ${costings.map((c) => c.number).join(", ")}`,
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
      projectEngineer: { select: { id: true, name: true } },
      createdBy: { select: { id: true, name: true } },
      costing: { select: { id: true, number: true, title: true, totalCost: true, contractValue: true } },
      otherCostings: {
        orderBy: { sortOrder: 'asc' },
        select: { costing: { select: { id: true, number: true, title: true, totalCost: true, contractValue: true } } },
      },
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
          // Which approved reports are still to bill (the tab's "+ New progress billing").
          billing: { select: { id: true } },
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
          // Beside each billing, its invoice and its latest invoice request
          // (2026-10-15 — the invoices moved here from the Finance tab).
          invoice: { select: { id: true, number: true, status: true } },
          invoiceRequests: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, number: true, status: true } },
        },
      },
      plans: { orderBy: { createdAt: 'desc' }, include: { uploadedBy: { select: { id: true, name: true } } } },
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
      // Every costing the project was built from, the first first (2026-10-19).
      costings: [job.costing, ...job.otherCostings.map((o) => o.costing)]
        .filter((c): c is NonNullable<typeof c> => !!c)
        .map((c) => ({ ...c, totalCost: num(c.totalCost), contractValue: num(c.contractValue) })),
      otherCostings: undefined,
      scopeItems: job.scopeItems.map((i) => ({ ...i, value: num(i.value) })),
      billings: job.billings.map((b) => ({
        ...b,
        grossAmount: num(b.grossAmount),
        netCollectible: num(b.netCollectible),
      })),
      budgetRequestCount: job._count.budgetRequests,
      installedAssetCount: job._count.installedAssets,
      schedule: scheduleTally(job),
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
  projectEngineerId: z.string().optional().nullable(),
  customerPoNumber: z.string().trim().optional().nullable(),
  customerPoDate: z.string().optional().nullable(),
  contractDate: z.string().optional().nullable(),
  startDate: z.string().optional().nullable(),
  targetEndDate: z.string().optional().nullable(),
  actualEndDate: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

/**
 * Deletes a CANCELLED project — the delete right, and the project's manager
 * or edit_all. Its scope, tasks, reports, billings, ledger and budget
 * requests cascade, so it is refused while money stands behind it: an
 * invoice, supplier bill, live PO, stock issue, claim or advance filed against
 * it, a purchase request still live (pending, approved, ordered) or with a
 * live order raised from it, or a budget request past draft that was not
 * cancelled or rejected. Its DRAFT, REJECTED and CANCELLED purchase requests
 * whose orders all go too, and its DRAFT and CANCELLED purchase orders with
 * no live incoming report and no bill (their cancelled reports too), go WITH it (2026-10-19, the owner's call,
 * clearing sample projects: "make delete remove its draft/cancelled PRs",
 * "also allow deleting a cancelled purchase order") — deleted in the
 * same transaction, each with its own DELETED row, their files and their
 * cancelled RFQs' quotation files after the commit, as the request's own
 * Delete does. Job orders and approved plans pointing at it keep their place
 * without it.
 */
jobRoutes.delete(
  '/:id',
  require_('gops.projects.delete'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const job = await prisma.job.findUnique({ where: { id: req.params.id }, select: { id: true, number: true, name: true, status: true, projectManagerId: true } });
    if (!job) throw notFound('Project not found');
    if (!canEditRecord(me, 'gops', 'projects', job.projectManagerId ?? '')) throw forbidden('Only the project’s manager can delete it');
    if (job.status !== 'CANCELLED') throw badRequest('Only a cancelled project can be deleted — cancel it first');
    const inJob = { jobId: job.id };
    // Orders that go with the project: a draft or cancelled one, nothing
    // received against it and no bill naming it (2026-10-19).
    const goingOrders = await prisma.purchaseOrder.findMany({
      where: { ...inJob, status: { in: ['DRAFT', 'CANCELLED'] }, receivings: { every: { status: 'CANCELLED' } }, bills: { none: {} } },
      select: { id: true, number: true, receivings: { select: { id: true } } },
    });
    const goingOrderIds = goingOrders.map((o) => o.id);
    // Requests that go with it: nothing live, and every order raised from it going too.
    const goingRequests = await prisma.purchaseRequest.findMany({
      where: { ...inJob, status: { in: ['DRAFT', 'REJECTED', 'CANCELLED'] }, orders: { every: { id: { in: goingOrderIds } } } },
      select: { id: true, number: true, rfqs: { select: { suppliers: { select: { id: true } } } } },
    });
    const counts: [string, number][] = [
      ['invoice', await prisma.invoice.count({ where: inJob })],
      ['supplier bill', await prisma.supplierBill.count({ where: inJob })],
      ['live purchase request', await prisma.purchaseRequest.count({ where: { ...inJob, id: { notIn: goingRequests.map((r) => r.id) } } })],
      ['live purchase order', await prisma.purchaseOrder.count({ where: { ...inJob, id: { notIn: goingOrderIds } } })],
      ['stock issue', await prisma.stockIssue.count({ where: inJob })],
      ['expense claim', await prisma.expenseClaim.count({ where: inJob })],
      ['cash advance', await prisma.cashAdvance.count({ where: inJob })],
      ['budget request with money behind it', await prisma.budgetRequest.count({ where: { ...inJob, status: { notIn: ['DRAFT', 'CANCELLED', 'REJECTED'] } } })],
    ];
    const blockers = counts.filter(([, n]) => n > 0);
    if (blockers.length) {
      throw badRequest(`${job.number} has ${blockers.map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`).join(', ')} filed against it — it is kept`);
    }
    const goingIds = goingRequests.map((r) => r.id);
    await deleteOrRefuse(job.number, () =>
      prisma.$transaction(async (tx) => {
        const goingReports = goingOrders.flatMap((o) => o.receivings.map((r) => r.id));
        if (goingReports.length) await tx.receiving.deleteMany({ where: { id: { in: goingReports }, status: 'CANCELLED' } });
        if (goingOrderIds.length) await tx.purchaseOrder.deleteMany({ where: { id: { in: goingOrderIds } } });
        if (goingIds.length) await tx.purchaseRequest.deleteMany({ where: { id: { in: goingIds } } });
        await tx.job.delete({ where: { id: job.id } });
      }),
    );
    await deleteAttachmentsOf('job', [job.id]);
    if (goingOrderIds.length) {
      await deleteAttachmentsOf('purchase_order', goingOrderIds);
      await deleteAttachmentsOf('receiving', goingOrders.flatMap((o) => o.receivings.map((r) => r.id)));
      for (const o of goingOrders) {
        await audit({ entityType: 'purchase_order', entityId: o.id, action: 'DELETED', summary: `Deleted ${o.number} with cancelled project ${job.number}` }, req);
      }
    }
    if (goingIds.length) {
      await deleteAttachmentsOf('purchase_request', goingIds);
      await deleteAttachmentsOf('rfq_supplier', goingRequests.flatMap((r) => r.rfqs.flatMap((q) => q.suppliers.map((sup) => sup.id))));
      for (const r of goingRequests) {
        await audit({ entityType: 'purchase_request', entityId: r.id, action: 'DELETED', summary: `Deleted ${r.number} with cancelled project ${job.number}` }, req);
      }
    }
    await audit(
      {
        entityType: 'job',
        entityId: job.id,
        action: 'DELETED',
        summary: `Deleted cancelled project ${job.number} — ${job.name}${goingOrders.length + goingRequests.length ? ` (and ${[...goingOrders, ...goingRequests].map((r) => r.number).join(', ')})` : ''}`,
      },
      req,
    );
    res.json({ ok: true });
  }),
);

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
    if (body.projectEngineerId !== undefined) {
      data.projectEngineer = body.projectEngineerId ? { connect: { id: body.projectEngineerId } } : { disconnect: true };
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

// ── Scope of Work paper ──────────────────────────────────────────────────────

/**
 * The project's Scope of Work on paper (2026-10-21, the owner's call: "make
 * the scope of work in the project printable"): the Scope of Work tab as it
 * stands — each phase with its dates, working days (Mon–Sat, holidays off),
 * value and progress, its tasks under it with whoever does them — the
 * contract value as the total, then the Gantt chart as a landscape appendix
 * dated from the project's earliest planned day. A plan, not a decision, so
 * no sign-offs. Behind the project's own read rule; audited.
 */
jobRoutes.get(
  '/:id/scope/pdf',
  requireAny('gops.projects.view_all', 'gops.projects.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const onlyOwn = !me.isSuperAdmin && !me.permissions.has('gops.projects.view_all');
    const ids = onlyOwn ? visibleOwners(me, 'gops', 'projects') : null;
    const job = await prisma.job.findFirst({
      where: { id: req.params.id, ...(ids ? { OR: [{ projectManagerId: { in: ids } }, { projectEngineerId: { in: ids } }, { createdById: { in: ids } }] } : {}) },
      include: {
        customer: { select: { name: true } },
        site: { select: { name: true } },
        projectManager: { select: { name: true } },
        scopeItems: { orderBy: { sortOrder: 'asc' } },
        tasks: {
          orderBy: [{ startDate: 'asc' }, { createdAt: 'asc' }],
          include: { assignedTo: { select: { name: true } } },
        },
      },
    });
    if (!job) throw notFound('Project not found');

    const currency = await companyCurrency();
    const days = (from: Date | null, to: Date | null) => (from && to && to >= from ? workingDaysBetween(from, to) : null);
    const span = (from: Date | null, to: Date | null) =>
      from && to ? `${formatShortDate(from)} – ${formatShortDate(to)}` : from ? `from ${formatShortDate(from)}` : to ? `to ${formatShortDate(to)}` : '—';
    const phases = job.scopeItems.map((s) => ({
      item: s,
      tasks: job.tasks.filter((t) => t.scopeItemId === s.id),
    }));
    const loose = job.tasks.filter((t) => !t.scopeItemId || !job.scopeItems.some((s) => s.id === t.scopeItemId));
    // A phase's own dates, else the span of its tasks.
    const phaseDates = (p: (typeof phases)[number]) => {
      const starts = [p.item.plannedStart, ...p.tasks.map((t) => t.startDate)].filter((d): d is Date => !!d);
      const ends = [p.item.plannedEnd, ...p.tasks.map((t) => t.dueDate)].filter((d): d is Date => !!d);
      return {
        from: p.item.plannedStart ?? (starts.length ? new Date(Math.min(...starts.map((d) => d.getTime()))) : null),
        to: p.item.plannedEnd ?? (ends.length ? new Date(Math.max(...ends.map((d) => d.getTime()))) : null),
      };
    };
    const taskRow = (t: (typeof job.tasks)[number]): PdfCell[] => [
      '',
      { title: `• ${t.name}`, body: [t.description, t.assignedTo?.name ? `By ${t.assignedTo.name}` : null].filter(Boolean).join(' — ') || undefined, plain: true },
      span(t.startDate, t.dueDate),
      String(days(t.startDate, t.dueDate) ?? '—'),
      '',
      `${t.progressPct}%`,
      statusLabel(t.status),
    ];
    const rows: PdfRow[] = [];
    phases.forEach((p, i) => {
      const d = phaseDates(p);
      rows.push([
        String(i + 1),
        { title: p.item.name, body: p.item.description ?? undefined },
        span(d.from, d.to),
        String(days(d.from, d.to) ?? (p.item.durationDays || '—')),
        formatAmount(num(p.item.value)),
        (() => { const pct = phasePctFromTasks(p.tasks); return pct == null ? '—' : `${Math.round(pct)}%`; })(),
        '',
      ]);
      for (const t of p.tasks) rows.push(taskRow(t));
    });
    if (loose.length) {
      rows.push({ heading: 'Not under a scope line' });
      for (const t of loose) rows.push(taskRow(t));
    }
    const total = job.scopeItems.reduce((s, i) => s + num(i.value), 0);

    // The Gantt chart, on working days from the earliest planned day.
    const allDates = [
      ...job.scopeItems.flatMap((s) => [s.plannedStart, s.plannedEnd]),
      ...job.tasks.flatMap((t) => [t.startDate, t.dueDate]),
      job.startDate,
    ].filter((d): d is Date => !!d);
    const origin = allDates.length ? new Date(Math.min(...allDates.map((d) => d.getTime()))) : null;
    const dayOf = (d: Date) => Math.max(1, workingDaysBetween(origin!, d));
    const bar = (from: Date | null, to: Date | null) =>
      from && origin ? { start: dayOf(from), days: Math.max(1, days(from, to ?? from) ?? 1) } : null;
    const groups = origin
      ? [
          ...phases.map((p) => {
            const d = phaseDates(p);
            const own = bar(d.from, d.to);
            return {
              name: p.item.name,
              ...(own ? { start: own.start, days: own.days } : {}),
              tasks: p.tasks.flatMap((t) => {
                const b = bar(t.startDate, t.dueDate);
                return b ? [{ name: t.name, ...b }] : [];
              }),
            };
          }),
          ...(loose.length
            ? [
                {
                  name: 'Not under a scope line',
                  tasks: loose.flatMap((t) => {
                    const b = bar(t.startDate, t.dueDate);
                    return b ? [{ name: t.name, ...b }] : [];
                  }),
                },
              ]
            : []),
        ].filter((g) => g.tasks.length || g.start)
      : [];

    const sections: PdfSection[] = [
      {
        kind: 'fields',
        title: 'Project',
        fields: [
          { label: 'Project', value: `${job.number} — ${job.name}` },
          { label: 'Customer', value: job.customer.name },
          { label: 'Site', value: job.site?.name ?? '' },
          { label: 'Technical Manager', value: job.projectManager?.name ?? '' },
          { label: 'Start', value: job.startDate ? formatShortDate(job.startDate) : '' },
          { label: 'Target end', value: job.targetEndDate ? formatShortDate(job.targetEndDate) : '' },
          { label: 'Status', value: statusLabel(job.status) },
        ].filter((f) => f.value),
      },
      {
        kind: 'table',
        title: 'Scope of work',
        head: ['No.', 'Phase / task', 'Dates', 'Days', `Value (${currency})`, 'Progress', 'Status'],
        widths: [0.7, 3.2, 1.9, 0.8, 1.4, 1.3, 1.3],
        align: ['left', 'left', 'left', 'right', 'right', 'right', 'left'],
        headingSpan: 2,
        rows,
      },
      { kind: 'totals', rows: [{ label: 'Contract value', value: formatMoney(total, currency), bold: true }] },
      ...(groups.length
        ? [
            {
              kind: 'gantt' as const,
              title: 'Schedule',
              landscape: true,
              startDate: origin!.toISOString().slice(0, 10),
              legend: 'Days are working days (Mon–Sat, holidays off), from the earliest planned day.',
              groups,
            },
          ]
        : []),
    ];
    const pdf = await renderDocument({
      title: 'Scope of Work',
      documentNumber: job.number,
      date: new Date(),
      reference: `${job.number} — ${job.name}`,
      sections,
    });
    await audit({ entityType: 'job', entityId: job.id, action: 'EXPORTED', summary: `Printed the scope of work of ${job.number}` }, req);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition(paperFileName({ kind: 'Scope of Work', number: job.number, author: me.name, date: new Date() })));
    res.send(pdf);
  }),
);

// ── Cost ledger ──────────────────────────────────────────────────────────────

/**
 * The project's cost ledger (2026-10-23, the owner's call: "cost ledger, by
 * category"). `?state=` and `?costCategoryId=` narrow it; `?group=category`
 * orders the rows under their budget line (the line's order, newest first
 * within it), so the card can head each line and subtotal it. Every answer
 * carries `byCategory` — `projectBudgetByLine()`, Budget Monitoring's own
 * figures, with CONSUMED beside them — so the card's totals and Budget
 * Monitoring can never disagree.
 */
function ledgerWhere(jobId: string, q: ReturnType<typeof listQuery>): Prisma.JobCostEntryWhereInput {
  const where: Prisma.JobCostEntryWhereInput = { jobId };
  const state = choice(q.filters.state, CostState, 'State');
  if (state) where.state = state;
  if (q.filters.costCategoryId) where.costCategoryId = q.filters.costCategoryId;
  return where;
}

const LEDGER_INCLUDE = {
  costCategory: { select: { id: true, code: true, name: true, sortOrder: true } },
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.JobCostEntryInclude;

function ledgerOrder(q: ReturnType<typeof listQuery>): Prisma.JobCostEntryOrderByWithRelationInput[] {
  return q.filters.group === 'category'
    ? [{ costCategory: { sortOrder: 'asc' } }, { costCategory: { name: 'asc' } }, { occurredAt: 'desc' }]
    : [{ occurredAt: 'desc' }];
}

jobRoutes.get(
  '/:id/ledger',
  require_('gops.budget_monitoring.view_all'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const where = ledgerWhere(req.params.id, q);

    const [rows, total, byCategory] = await Promise.all([
      prisma.jobCostEntry.findMany({
        where,
        include: LEDGER_INCLUDE,
        orderBy: ledgerOrder(q),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.jobCostEntry.count({ where }),
      projectBudgetByLine(req.params.id),
    ]);

    res.json({
      ...listResult(rows.map((r) => ({ ...r, amount: num(r.amount) })), total, q),
      // A line with nothing on the ledger stays off the card.
      byCategory: {
        lines: byCategory.lines.filter((l) => l.budgeted || l.committed || l.incurred || l.consumed),
        total: byCategory.total,
      },
    });
  }),
);

/**
 * The ledger on paper — the card's filters, the rows under their budget line
 * with each line's subtotal by state, then the project's totals (Budget
 * Monitoring's). Landscape, capped at the list cap, audited.
 */
jobRoutes.get(
  '/:id/ledger/pdf',
  require_('gops.budget_monitoring.view_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const job = await prisma.job.findUnique({ where: { id: req.params.id }, select: { id: true, number: true, name: true } });
    if (!job) throw notFound('Project not found');
    const where = ledgerWhere(job.id, q);
    const [rows, count, budget, currency, category] = await Promise.all([
      prisma.jobCostEntry.findMany({
        where,
        include: LEDGER_INCLUDE,
        orderBy: [{ costCategory: { sortOrder: 'asc' } }, { costCategory: { name: 'asc' } }, { occurredAt: 'desc' }],
        take: LIST_CAP,
      }),
      prisma.jobCostEntry.count({ where }),
      projectBudgetByLine(job.id),
      companyCurrency(),
      q.filters.costCategoryId ? prisma.costCategory.findUnique({ where: { id: q.filters.costCategoryId }, select: { name: true } }) : null,
    ]);
    const state = q.filters.state ? statusLabel(q.filters.state) : null;
    const reference = listReference(count, rows.length, ['ledger row', 'ledger rows'], [
      `${job.number} — ${job.name}`,
      category && `budget line ${category.name}`,
      state && `state ${state}`,
    ]);

    // The rows, a subheading per budget line and its subtotal by state.
    const body: PdfRow[] = [];
    const byLine = new Map<string, typeof rows>();
    for (const r of rows) byLine.set(r.costCategoryId, [...(byLine.get(r.costCategoryId) ?? []), r]);
    for (const [, list] of byLine) {
      body.push({ heading: `${list[0].costCategory.code} ${list[0].costCategory.name}` });
      for (const r of list) {
        body.push([
          formatShortDate(r.occurredAt),
          statusLabel(r.state),
          r.sourceNumber ? { title: r.sourceNumber, body: r.description ?? '' } : (r.description ?? ''),
          statusLabel(r.sourceType),
          r.createdBy?.name ?? '',
          formatAmount(num(r.amount)),
        ]);
      }
    }

    const shown = budget.lines.filter((l) => (category ? l.id === q.filters.costCategoryId : l.budgeted || l.committed || l.incurred || l.consumed));
    const sections: PdfSection[] = [
      {
        kind: 'table',
        title: 'By budget line',
        head: ['Budget line', `Budgeted (${currency})`, `Committed (${currency})`, `Incurred (${currency})`, `Consumed (${currency})`, `Available (${currency})`],
        align: ['left', 'right', 'right', 'right', 'right', 'right'],
        rows: shown.map((l) => [`${l.code} ${l.name}`, formatAmount(l.budgeted), formatAmount(l.committed), formatAmount(l.incurred), formatAmount(l.consumed), formatAmount(l.available)]),
      },
      {
        kind: 'totals',
        rows: [
          { label: 'Budgeted', value: formatMoney(budget.total.budgeted, currency) },
          { label: 'Less: committed', value: formatMoney(budget.total.committed, currency) },
          { label: 'Less: incurred', value: formatMoney(budget.total.incurred, currency) },
          { label: 'Available', value: formatMoney(budget.total.available, currency), bold: true },
        ],
      },
      {
        kind: 'table',
        title: 'Ledger',
        head: ['Date', 'State', 'Document and description', 'Source', 'By', `Amount (${currency})`],
        align: ['left', 'left', 'left', 'left', 'left', 'right'],
        rows: body,
      },
      ...listNotes(['Consumed is reported, never subtracted: stock issued to the project was already counted as incurred when it was received. A released commitment is a negative row.']),
    ];
    const pdf = await renderDocument({ title: 'Cost Ledger', date: new Date(), reference, landscape: true, sections });
    await audit({ entityType: 'job', entityId: job.id, action: 'EXPORTED', summary: `Printed the cost ledger of ${job.number} (${rows.length} row(s))` }, req);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition(paperFileName({ kind: 'Cost Ledger', number: job.number, author: me.name, date: new Date() })));
    res.send(pdf);
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
 * Written for the workspace's Service tab, which went on 2026-10-15 (the
 * owner's call); kept as the one read of a job's field record. Each section is `null` when the
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
