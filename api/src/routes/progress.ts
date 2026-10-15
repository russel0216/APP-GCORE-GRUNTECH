import { Router } from 'express';
import { mayRequestInvoice } from './invoiceRequests';
import { z } from 'zod';
import { Prisma, ProgressStatus, BillingStatus } from '@prisma/client';
import { prisma } from '../prisma';
import {
  handler,
  parseBody,
  listQuery,
  listResult,
  orderBy,
  notFound,
  badRequest,
  forbidden,
  idsFilter,
  type ListQuery,
} from '../http/kit';
import { authenticate, require_, requireAny, requireAnyOrDecider, currentUser } from '../auth/middleware';
import { can, canEditRecord, type ResolvedUser } from '../permissions/resolve';
import { audit } from '../shared/audit';
import fs from 'fs';
import sharp from 'sharp';
import { registerAttachmentGuard, deleteAttachmentsOf, attachmentPath } from '../shared/attachments';
import {
  PROGRESS_OVERALL,
  billingNumber,
  overallStatusLabel,
  phasePctFromTasks,
  reportNumber,
  weighOf,
} from '../shared/progressReport';
import {
  renderDocument,
  formatMoney,
  formatAmount,
  formatDate,
  formatShortDate,
  statusLabel,
  companyCurrency,
  type PdfSection,
  type PdfTotal,
  type Signatory,
} from '../shared/pdf';
import {
  approvalSlots,
  cancelOpenRequest,
  contactsOf,
  mayDecide,
  onApprovalSettled,
  preparedAt,
  routeBrief,
  slotSignatories,
  submitForApproval,
  type ApprovalOutcome,
} from '../shared/approvals';
import type { ApprovalRequest } from '@prisma/client';
import { manilaDate, workingDayDate } from '../shared/day';
import { planTasks } from '../shared/costingMath';
import { LIST_CAP, listReference, totalLabel, namedInFilter, choice, bracketed, bracketNote, listNotes, sendListPdf, ratePct } from '../shared/listPaper';
import { contentDisposition, paperFileName } from '../shared/paperName';

const d = (v: number | string | null | undefined) =>
  v === null || v === undefined ? new Prisma.Decimal(0) : new Prisma.Decimal(v);
const num = (v: Prisma.Decimal | null | undefined) => (v == null ? 0 : Number(v));
const cents = (n: number) => Math.round(n * 100) / 100;

/** A rate as a document prints it: 0.12 → "12%", 0.075 → "7.5%". */

function asDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const date = new Date(v);
  if (Number.isNaN(date.getTime())) throw badRequest(`"${v}" is not a valid date`);
  return date;
}

// ════════════════════════════════════════════════════════════════════
//  PROGRESS REPORTS
// ════════════════════════════════════════════════════════════════════

export const progressRoutes = Router();
progressRoutes.use(authenticate);

const REPORT_SORTS = ['number', 'periodTo', 'createdAt'];

/**
 * Which progress reports a list query means — one rule for the list and its
 * printed twin. A `view_own` holder sees the reports they prepared; `?ids=`
 * (the rows ticked) is ANDed with that.
 */
function reportListWhere(me: ResolvedUser, q: ListQuery): Prisma.ProgressReportWhereInput {
  const and: Prisma.ProgressReportWhereInput[] = [];
  const onlyOwn = !me.isSuperAdmin && !me.permissions.has('gops.progress_billing.view_all');
  if (onlyOwn || q.scope === 'mine') and.push({ preparedById: me.id });
  if (q.filters.jobId) and.push({ jobId: q.filters.jobId });
  const status = choice(q.filters.status, ProgressStatus, 'Status');
  if (status) and.push({ status });
  const ids = idsFilter(q.filters.ids);
  if (ids) and.push({ id: { in: ids } });
  if (q.search) {
    and.push({
      OR: [
        { number: { contains: q.search, mode: 'insensitive' } },
        { job: { name: { contains: q.search, mode: 'insensitive' } } },
        { job: { number: { contains: q.search, mode: 'insensitive' } } },
      ],
    });
  }
  return and.length ? { AND: and } : {};
}

const reportListInclude = {
  job: { select: { id: true, number: true, name: true, contractValue: true } },
  preparedBy: { select: { id: true, name: true } },
  lines: { select: { scopeItemId: true, toDatePct: true } },
  billing: { select: { id: true, number: true, status: true } },
} satisfies Prisma.ProgressReportInclude;

/** A report's row: its overall to-date % and earned value, weighted by scope value. */
async function presentReportRows(rows: Prisma.ProgressReportGetPayload<{ include: typeof reportListInclude }>[]) {
  const jobIds = [...new Set(rows.map((r) => r.jobId))];
  const scopeItems = await prisma.jobScopeItem.findMany({
    where: { jobId: { in: jobIds } },
    select: { id: true, jobId: true, value: true },
  });
  const byJob = new Map<string, { id: string; value: number }[]>();
  for (const item of scopeItems) {
    const list = byJob.get(item.jobId) ?? [];
    list.push({ id: item.id, value: num(item.value) });
    byJob.set(item.jobId, list);
  }
  return rows.map((r) => {
    const items = byJob.get(r.jobId) ?? [];
    const totalValue = items.reduce((s, i) => s + i.value, 0);
    const pctBy = new Map(r.lines.map((l) => [l.scopeItemId, num(l.toDatePct)]));
    const earned = items.reduce((s, i) => s + (i.value * (pctBy.get(i.id) ?? 0)) / 100, 0);
    return {
      id: r.id,
      number: r.number,
      reportNo: r.reportNo,
      status: r.status,
      periodFrom: r.periodFrom,
      periodTo: r.periodTo,
      job: { ...r.job, contractValue: num(r.job.contractValue) },
      preparedBy: r.preparedBy,
      billing: r.billing,
      toDatePct: totalValue > 0 ? cents((earned / totalValue) * 100) : 0,
      earnedValue: cents(earned),
    };
  });
}

progressRoutes.get(
  '/',
  requireAny('gops.progress_billing.view_all', 'gops.progress_billing.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const where = reportListWhere(me, q);

    const [rows, total] = await Promise.all([
      prisma.progressReport.findMany({
        where,
        include: reportListInclude,
        orderBy: orderBy(q, REPORT_SORTS, { createdAt: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.progressReport.count({ where }),
    ]);

    res.json(listResult(await presentReportRows(rows), total, q));
  }),
);

/**
 * The progress reports list on paper (rule 6, A5): the list's own query and
 * sort — or, with `?ids=`, the rows ticked — on landscape pages. No totals
 * block: each report's earned value is a running total of its own project,
 * so summing reports would count the same work twice. Above `/:id`.
 */
progressRoutes.get(
  '/pdf',
  requireAny('gops.progress_billing.view_all', 'gops.progress_billing.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const where = reportListWhere(me, q);
    const [rows, count, currency, named] = await Promise.all([
      prisma.progressReport.findMany({ where, include: reportListInclude, orderBy: orderBy(q, REPORT_SORTS, { createdAt: 'desc' }), take: LIST_CAP }),
      prisma.progressReport.count({ where }),
      companyCurrency(),
      namedInFilter({ jobId: q.filters.jobId }),
    ]);
    const printed = await presentReportRows(rows);
    const reference = listReference(count, printed.length, ['progress report', 'progress reports'], [
      q.search ? `search "${q.search}"` : null,
      q.filters.status ? `status ${statusLabel(q.filters.status)}` : null,
      named.project ? `project ${named.project}` : null,
      q.scope === 'mine' ? 'prepared by me' : null,
      q.filters.ids ? 'the rows selected' : null,
    ]);

    const pdf = await renderDocument({
      title: 'Progress Reports',
      date: new Date(),
      reference,
      landscape: true,
      sections: [
        {
          kind: 'table',
          head: ['Number', 'Project', 'Report no.', 'Period', 'To date', `Earned value (${currency})`, 'Prepared by', 'Billing', 'Status'],
          align: ['left', 'left', 'right', 'left', 'right', 'right', 'left', 'left', 'left'],
          rows: printed.map((r) => [
            r.number,
            { title: r.job.name, body: r.job.number },
            String(r.reportNo),
            `${formatShortDate(r.periodFrom)} – ${formatShortDate(r.periodTo)}`,
            `${r.toDatePct.toFixed(2)}%`,
            formatAmount(r.earnedValue),
            r.preparedBy.name,
            r.billing?.number ?? 'Not yet',
            statusLabel(r.status),
          ]),
        },
      ],
    });

    await audit(
      { entityType: 'progress_report', entityId: 'list', action: 'EXPORTED', summary: `Exported the progress reports list as PDF (${listReference(count, printed.length, ['progress report', 'progress reports'], [])})` },
      req,
    );
    sendListPdf(res, pdf, 'progress-reports.pdf');
  }),
);

async function loadReport(id: string) {
  return prisma.progressReport.findUnique({
    where: { id },
    include: {
      job: {
        select: {
          id: true,
          number: true,
          name: true,
          contractValue: true,
          customer: { select: { id: true, name: true } },
          site: { select: { id: true, name: true, address: true, city: true } },
          projectManager: { select: { id: true, name: true } },
          startDate: true,
          targetEndDate: true,
          actualEndDate: true,
          status: true,
        },
      },
      days: { orderBy: [{ workDate: 'asc' }, { sortOrder: 'asc' }] },
      preparedBy: { select: { id: true, name: true, position: true } },
      approvedBy: { select: { id: true, name: true } },
      previousReport: { select: { id: true, number: true, reportNo: true } },
      nextReport: { select: { id: true, number: true, reportNo: true } },
      billing: { select: { id: true, number: true, status: true, grossAmount: true } },
      lines: {
        include: { scopeItem: true },
        orderBy: { scopeItem: { sortOrder: 'asc' } },
      },
    },
  });
}

function presentReport(
  report: NonNullable<Awaited<ReturnType<typeof loadReport>>>,
  tasks: { scopeItemId: string | null; name: string; status: string; progressPct: number; weight: Prisma.Decimal | null }[] = [],
) {
  const scheduleTotal = report.lines.reduce((s, l) => s + num(l.scopeItem.value), 0);
  const lines = report.lines.map((l) => ({
    ...l,
    // The line's share of the schedule, and what it adds to the project's
    // percentage at its to-date figure — the sum of these IS the headline.
    weightPct: cents(weighOf(num(l.scopeItem.value), scheduleTotal) * 100),
    weightedPct: cents(weighOf(num(l.scopeItem.value), scheduleTotal) * num(l.toDatePct)),
    tasks: tasks
      .filter((t) => t.scopeItemId === l.scopeItemId)
      .map((t) => ({ name: t.name, status: t.status, progressPct: t.progressPct, weight: t.weight == null ? null : Number(t.weight) })),
    fromTasksPct: phasePctFromTasks(tasks.filter((t) => t.scopeItemId === l.scopeItemId)),
    previousPct: num(l.previousPct),
    thisPeriodPct: num(l.thisPeriodPct),
    toDatePct: num(l.toDatePct),
    scopeItem: { ...l.scopeItem, value: num(l.scopeItem.value) },
    previousAmount: cents((num(l.scopeItem.value) * num(l.previousPct)) / 100),
    thisPeriodAmount: cents((num(l.scopeItem.value) * num(l.thisPeriodPct)) / 100),
    toDateAmount: cents((num(l.scopeItem.value) * num(l.toDatePct)) / 100),
  }));

  const totalValue = lines.reduce((s, l) => s + l.scopeItem.value, 0);
  const earned = lines.reduce((s, l) => s + l.toDateAmount, 0);
  const thisPeriod = lines.reduce((s, l) => s + l.thisPeriodAmount, 0);

  return {
    ...report,
    overallStatusText: overallStatusLabel(report.overallStatus, report.overallStatusNote),
    job: { ...report.job, contractValue: num(report.job.contractValue) },
    billing: report.billing
      ? { ...report.billing, grossAmount: num(report.billing.grossAmount) }
      : null,
    lines,
    totals: {
      contractValue: totalValue,
      earnedValue: cents(earned),
      thisPeriodValue: cents(thisPeriod),
      toDatePct: totalValue > 0 ? cents((earned / totalValue) * 100) : 0,
      thisPeriodPct: totalValue > 0 ? cents((thisPeriod / totalValue) * 100) : 0,
    },
  };
}

const DOC = 'progress_report';
const BILL_DOC = 'progress_billing';
const VIEW = ['gops.progress_billing.view_all', 'gops.progress_billing.view_own'];
export const REPORT_LINK = (id: string) => `/g-ops/progress/${id}`;
export const BILLING_LINK = (id: string) => `/g-ops/billings/${id}`;

/**
 * Who reads one report: view_all, the person who prepared it, or — through
 * `requireAnyOrDecider` — whoever may decide its open request (a Technical
 * Manager or Team Leader with no right to the module). Anyone else is a 404.
 */
async function readableReport(me: ResolvedUser, id: string, deciderOnly: boolean) {
  const report = await loadReport(id);
  if (!report) throw notFound('Progress report not found');
  const reads =
    !deciderOnly &&
    (me.isSuperAdmin || can(me, 'gops.progress_billing.view_all') || (report.preparedById === me.id && can(me, 'gops.progress_billing.view_own')));
  if (!reads && !(await mayDecide(me.id, DOC, [report.id]))) throw notFound('Progress report not found');
  return report;
}

const mayEditReport = (me: ResolvedUser, report: { preparedById: string }) => canEditRecord(me, 'gops', 'progress_billing', report.preparedById);

async function reportTasks(jobId: string) {
  return prisma.jobTask.findMany({
    where: { jobId, scopeItemId: { not: null } },
    select: { scopeItemId: true, name: true, status: true, progressPct: true, weight: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
}

async function reportView(me: ResolvedUser, report: NonNullable<Awaited<ReturnType<typeof loadReport>>>) {
  const editor = mayEditReport(me, report);
  const draft = report.status === 'DRAFT';
  const [tasks, pictures] = await Promise.all([
    reportTasks(report.jobId),
    prisma.attachment.groupBy({
      by: ['entityId'],
      where: { entityType: 'progress_report_day', entityId: { in: report.days.map((d) => d.id) } },
      _count: { _all: true },
    }),
  ]);
  const picturesOf = new Map(pictures.map((p) => [p.entityId, p._count._all]));
  return {
    ...presentReport(report, tasks),
    days: report.days.map((d) => ({ ...d, pictures: picturesOf.get(d.id) ?? 0 })),
    overallChoices: PROGRESS_OVERALL,
    canEdit: draft && editor,
    canSubmit: draft && editor,
    canWithdraw: report.status === 'PENDING_APPROVAL' && editor,
    canDelete: draft && (me.isSuperAdmin || (can(me, 'gops.progress_billing.delete') && editor)),
    approvalRoute: draft ? await routeBrief(DOC, num(report.job.contractValue), report.preparedById, null, { jobId: report.jobId }) : null,
  };
}

progressRoutes.get(
  '/:id',
  requireAnyOrDecider(...VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    const report = await readableReport(me, req.params.id, res.locals.deciderOnly === true);
    res.json(await reportView(me, report));
  }),
);

/**
 * Creating a report carries the previous report's to-date percentages forward
 * as this report's opening position, and links the chain.
 *
 * That carry-forward is what makes a report a PERIOD statement — "previous /
 * this period / to date" — rather than a running total someone has to work out
 * by hand from the last one.
 */
const createReportSchema = z.object({
  jobId: z.string().min(1),
  periodFrom: z.string().min(1, 'Period start is required'),
  periodTo: z.string().min(1, 'Period end is required'),
});

progressRoutes.post(
  '/',
  require_('gops.progress_billing.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(createReportSchema, req.body);

    const job = await prisma.job.findUnique({
      where: { id: body.jobId },
      include: { scopeItems: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!job) throw notFound('Job not found');
    if (!job.scopeItems.length) throw badRequest('This job has no schedule of values');
    if (job.status === 'CANCELLED') throw badRequest(`${job.number} is cancelled`);

    const open = await prisma.progressReport.findFirst({
      where: { jobId: body.jobId, status: { in: ['DRAFT', 'SUBMITTED', 'PENDING_APPROVAL'] } },
    });
    if (open) {
      throw badRequest(
        `Report ${open.number} is still open. Finish it before starting the next one — reports are a chain, not parallel drafts.`,
      );
    }

    const previous = await prisma.progressReport.findFirst({
      where: { jobId: body.jobId, status: 'APPROVED' },
      orderBy: { reportNo: 'desc' },
      include: { lines: true },
    });
    // A report started from the project page may be made by sales too — the
    // owner's call: "creator (Project Engineer) or Sales".
    const carried = new Map(previous?.lines.map((l) => [l.scopeItemId, num(l.toDatePct)]) ?? []);

    // PERSONNEL PRESENT starts from the previous report, else from the job
    // order the project was built from (its PM or lead in charge, its
    // engineer and support beside them), else the project's manager.
    const personnel = await personnelFor(job.id, job.projectManagerId, previous);

    const report = await prisma.$transaction(async (tx) => {
      const last = await tx.progressReport.findFirst({
        where: { jobId: body.jobId },
        orderBy: { reportNo: 'desc' },
        select: { reportNo: true },
      });
      const reportNo = (last?.reportNo ?? 0) + 1;

      return tx.progressReport.create({
        data: {
          number: reportNumber(job.number, reportNo),
          reportNo,
          personnelInCharge: personnel.inCharge,
          personnelSupport: personnel.support,
          overallStatus: previous?.overallStatus ?? 'ON_SCHEDULE',
          jobId: body.jobId,
          previousReportId: previous?.id ?? null,
          periodFrom: new Date(body.periodFrom),
          periodTo: new Date(body.periodTo),
          preparedById: me.id,
          lines: {
            create: job.scopeItems.map((item) => {
              const prev = carried.get(item.id) ?? 0;
              return {
                scopeItemId: item.id,
                previousPct: d(prev),
                thisPeriodPct: d(0),
                toDatePct: d(prev),
              };
            }),
          },
        },
      });
    });

    await audit(
      {
        entityType: 'progress_report',
        entityId: report.id,
        action: 'CREATED',
        summary: `Started ${report.number} (report #${report.reportNo}) for ${job.number}`,
      },
      req,
    );
    res.status(201).json(report);
  }),
);

async function personnelFor(
  jobId: string,
  projectManagerId: string | null,
  previous: { personnelInCharge: string | null; personnelSupport: string[] } | null,
): Promise<{ inCharge: string | null; support: string[] }> {
  if (previous?.personnelInCharge || previous?.personnelSupport.length) {
    return { inCharge: previous.personnelInCharge, support: previous.personnelSupport };
  }
  const order = await prisma.jobOrder.findFirst({
    where: { jobId, status: { not: 'CANCELLED' } },
    orderBy: { createdAt: 'asc' },
    select: {
      projectManager: { select: { name: true } },
      projectEngineer: { select: { name: true } },
      projectLead: { select: { name: true } },
      support: { select: { user: { select: { name: true } } } },
    },
  });
  if (order) {
    const inCharge = order.projectLead?.name ?? order.projectEngineer?.name ?? order.projectManager?.name ?? null;
    const support = [order.projectEngineer?.name, ...order.support.map((s) => s.user.name)].filter(
      (n): n is string => !!n && n !== inCharge,
    );
    return { inCharge, support: [...new Set(support)] };
  }
  const pm = projectManagerId ? await prisma.user.findUnique({ where: { id: projectManagerId }, select: { name: true } }) : null;
  return { inCharge: pm?.name ?? null, support: [] };
}

async function reportForEdit(req: Parameters<typeof currentUser>[0], id: string) {
  const me = currentUser(req);
  const report = await prisma.progressReport.findUnique({ where: { id } });
  if (!report) throw notFound('Progress report not found');
  if (report.status !== 'DRAFT') {
    throw badRequest(
      `Report ${report.number} is ${report.status.toLowerCase()} and cannot be changed — it is the record of what was reported.`,
    );
  }
  const mayEdit =
    me.isSuperAdmin ||
    me.permissions.has('gops.progress_billing.edit_all') ||
    (report.preparedById === me.id && me.permissions.has('gops.progress_billing.edit_own'));
  if (!mayEdit) throw forbidden('This report belongs to someone else');
  return report;
}

progressRoutes.patch(
  '/:id',
  requireAny('gops.progress_billing.edit_own', 'gops.progress_billing.edit_all'),
  handler(async (req, res) => {
    await reportForEdit(req, req.params.id);
    const body = parseBody(
      z.object({
        periodFrom: z.string().optional(),
        periodTo: z.string().optional(),
        weather: z.string().optional().nullable(),
        manpower: z.string().optional().nullable(),
        equipment: z.string().optional().nullable(),
        accomplishment: z.string().optional().nullable(),
        issues: z.string().optional().nullable(),
        nextPeriodPlan: z.string().optional().nullable(),
        milestones: z.string().optional().nullable(),
        overallStatus: z.string().trim().max(80).optional().nullable(),
        overallStatusNote: z.string().trim().max(200).optional().nullable(),
        personnelInCharge: z.string().trim().max(120).optional().nullable(),
        personnelSupport: z.array(z.string().trim().min(1).max(120)).max(40).optional(),
      }),
      req.body,
    );

    const data: Prisma.ProgressReportUpdateInput = {};
    for (const f of [
      'weather',
      'manpower',
      'equipment',
      'accomplishment',
      'issues',
      'nextPeriodPlan',
      'milestones',
      'overallStatus',
      'overallStatusNote',
      'personnelInCharge',
    ] as const) {
      if (body[f] !== undefined) (data as Record<string, unknown>)[f] = body[f] || null;
    }
    if (body.personnelSupport) data.personnelSupport = [...new Set(body.personnelSupport)];
    if (body.periodFrom) data.periodFrom = new Date(body.periodFrom);
    if (body.periodTo) data.periodTo = new Date(body.periodTo);
    const from = (data.periodFrom as Date | undefined) ?? undefined;
    const to = (data.periodTo as Date | undefined) ?? undefined;
    if (from && to && to < from) throw badRequest('The period ends before it starts');

    await prisma.progressReport.update({ where: { id: req.params.id }, data });
    const report = await loadReport(req.params.id);
    res.json(await reportView(currentUser(req), report!));
  }),
);

/** Sets this period's percentage on one scope line. */
progressRoutes.patch(
  '/:id/lines/:lineId',
  requireAny('gops.progress_billing.edit_own', 'gops.progress_billing.edit_all'),
  handler(async (req, res) => {
    await reportForEdit(req, req.params.id);
    const body = parseBody(
      z.object({
        thisPeriodPct: z.number().min(0).max(100).optional(),
        toDatePct: z.number().min(0).max(100).optional(),
        remarks: z.string().optional().nullable(),
      }),
      req.body,
    );

    const line = await prisma.progressReportLine.findFirst({
      where: { id: req.params.lineId, reportId: req.params.id },
    });
    if (!line) throw notFound('Line not found');

    const previous = num(line.previousPct);
    let thisPeriod = body.thisPeriodPct ?? num(line.thisPeriodPct);

    // Either figure can be entered; the other follows. Site engineers think in
    // "we did 20% more this month", quantity surveyors think in "we're at 70%".
    if (body.toDatePct !== undefined) thisPeriod = cents(body.toDatePct - previous);

    if (thisPeriod < 0) {
      throw badRequest(
        `That would put this line below the ${previous}% already reported. Progress cannot go backwards — raise a variation instead.`,
      );
    }
    const toDate = cents(previous + thisPeriod);
    if (toDate > 100) {
      throw badRequest(`That would put this line at ${toDate}%. A scope line cannot exceed 100%.`);
    }

    await prisma.progressReportLine.update({
      where: { id: req.params.lineId },
      data: {
        thisPeriodPct: d(thisPeriod),
        toDatePct: d(toDate),
        ...(body.remarks !== undefined ? { remarks: body.remarks || null } : {}),
      },
    });

    const report = await loadReport(req.params.id);
    res.json(await reportView(currentUser(req), report!));
  }),
);

/**
 * A phase's percentage worked out from its tasks on the Scope of Work: each
 * task's weight (equal when none is typed) times its own progress, a DONE
 * task 100. Sets the line's to-date figure — never below what was already
 * reported, the line's own rule.
 */
progressRoutes.post(
  '/:id/lines/:lineId/from-tasks',
  requireAny('gops.progress_billing.edit_own', 'gops.progress_billing.edit_all'),
  handler(async (req, res) => {
    const report = await reportForEdit(req, req.params.id);
    const line = await prisma.progressReportLine.findFirst({ where: { id: req.params.lineId, reportId: report.id } });
    if (!line) throw notFound('Line not found');
    const tasks = await prisma.jobTask.findMany({
      where: { jobId: report.jobId, scopeItemId: line.scopeItemId },
      select: { status: true, progressPct: true, weight: true },
    });
    const pct = phasePctFromTasks(tasks);
    if (pct === null) throw badRequest('This phase has no tasks on the Scope of Work to go by');
    const previous = num(line.previousPct);
    if (pct < previous) {
      throw badRequest(`Its tasks come to ${pct}%, below the ${previous}% already reported — progress cannot go backwards`);
    }
    await prisma.progressReportLine.update({
      where: { id: line.id },
      data: { toDatePct: d(pct), thisPeriodPct: d(cents(pct - previous)) },
    });
    res.json(await reportView(currentUser(req), (await loadReport(report.id))!));
  }),
);

// ── Daily accomplishments ────────────────────────────────────────────────────

const daySchema = z.object({
  workDate: z.string().min(1, 'Which day?'),
  actions: z.string().trim().min(1, 'Say what was done'),
  findings: z.string().trim().max(4000).optional().nullable(),
  recommendation: z.string().trim().max(4000).optional().nullable(),
  remarks: z.string().trim().max(4000).optional().nullable(),
  headcount: z.number().int().min(0).max(999).optional().nullable(),
});

function dayData(body: z.infer<typeof daySchema>, report: { periodFrom: Date; periodTo: Date }) {
  const workDate = asDate(body.workDate)!;
  const day = workDate.toISOString().slice(0, 10);
  if (day < report.periodFrom.toISOString().slice(0, 10) || day > report.periodTo.toISOString().slice(0, 10)) {
    throw badRequest('That day is outside the report’s period');
  }
  return {
    workDate: new Date(`${day}T00:00:00Z`),
    actions: body.actions,
    findings: body.findings || null,
    recommendation: body.recommendation || null,
    remarks: body.remarks || null,
    headcount: body.headcount ?? null,
  };
}

progressRoutes.post(
  '/:id/days',
  requireAny('gops.progress_billing.edit_own', 'gops.progress_billing.edit_all'),
  handler(async (req, res) => {
    const report = await reportForEdit(req, req.params.id);
    const body = parseBody(daySchema, req.body);
    const count = await prisma.progressReportDay.count({ where: { reportId: report.id } });
    const day = await prisma.progressReportDay.create({ data: { reportId: report.id, sortOrder: count, ...dayData(body, report) } });
    await audit({ entityType: 'progress_report', entityId: report.id, action: 'UPDATED', summary: `${report.number}: added ${day.workDate.toISOString().slice(0, 10)}` }, req);
    res.status(201).json(await reportView(currentUser(req), (await loadReport(report.id))!));
  }),
);

progressRoutes.put(
  '/:id/days/:dayId',
  requireAny('gops.progress_billing.edit_own', 'gops.progress_billing.edit_all'),
  handler(async (req, res) => {
    const report = await reportForEdit(req, req.params.id);
    const body = parseBody(daySchema, req.body);
    const day = await prisma.progressReportDay.findFirst({ where: { id: req.params.dayId, reportId: report.id } });
    if (!day) throw notFound('Day not found');
    await prisma.progressReportDay.update({ where: { id: day.id }, data: dayData(body, report) });
    res.json(await reportView(currentUser(req), (await loadReport(report.id))!));
  }),
);

progressRoutes.delete(
  '/:id/days/:dayId',
  requireAny('gops.progress_billing.edit_own', 'gops.progress_billing.edit_all'),
  handler(async (req, res) => {
    const report = await reportForEdit(req, req.params.id);
    const day = await prisma.progressReportDay.findFirst({ where: { id: req.params.dayId, reportId: report.id } });
    if (!day) throw notFound('Day not found');
    await prisma.progressReportDay.delete({ where: { id: day.id } });
    await deleteAttachmentsOf('progress_report_day', [day.id]);
    await audit({ entityType: 'progress_report', entityId: report.id, action: 'UPDATED', summary: `${report.number}: removed ${day.workDate.toISOString().slice(0, 10)}` }, req);
    res.json(await reportView(currentUser(req), (await loadReport(report.id))!));
  }),
);

/**
 * A day's pictures are the report's: read by whoever reads the report (its
 * deciders included), added and removed only while it is a draft, by whoever
 * may edit it — what the approvers decide on is what they were sent.
 */
registerAttachmentGuard(
  'progress_report_day',
  async (user, dayId) => {
    const day = await prisma.progressReportDay.findUnique({ where: { id: dayId }, select: { report: { select: { id: true, preparedById: true } } } });
    if (!day) return false;
    if (user.isSuperAdmin || can(user, 'gops.progress_billing.view_all') || day.report.preparedById === user.id) return true;
    return mayDecide(user.id, DOC, [day.report.id]);
  },
  {
    write: async (user, dayId) => {
      const day = await prisma.progressReportDay.findUnique({ where: { id: dayId }, select: { report: { select: { status: true, preparedById: true } } } });
      return !!day && day.report.status === 'DRAFT' && mayEditReport(user, day.report);
    },
  },
);
registerAttachmentGuard(
  'progress_report',
  async (user, id) => {
    const report = await prisma.progressReport.findUnique({ where: { id }, select: { preparedById: true } });
    if (!report) return false;
    if (user.isSuperAdmin || can(user, 'gops.progress_billing.view_all') || report.preparedById === user.id) return true;
    return mayDecide(user.id, DOC, [id]);
  },
  {
    write: async (user, id) => {
      const report = await prisma.progressReport.findUnique({ where: { id }, select: { status: true, preparedById: true } });
      return !!report && report.status === 'DRAFT' && mayEditReport(user, report);
    },
  },
);

// ── The approval route (2026-10-15): Technical Manager › Team Leader ─────────

progressRoutes.post(
  '/:id/submit',
  requireAny('gops.progress_billing.create', 'gops.progress_billing.edit_own', 'gops.progress_billing.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const report = await reportForEdit(req, req.params.id);
    const full = (await loadReport(report.id))!;
    const view = presentReport(full);
    if (!full.days.length && !full.accomplishment?.trim()) {
      throw badRequest('Write the summary or at least one day’s accomplishments before sending it');
    }
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.progressReport.updateMany({
        where: { id: report.id, status: 'DRAFT', updatedAt: report.updatedAt },
        data: { status: 'PENDING_APPROVAL' },
      });
      if (!claimed.count) throw badRequest('It changed a moment ago — reload to see where it stands');
    });
    try {
      await submitForApproval({
        documentType: DOC,
        documentId: report.id,
        documentNumber: report.number,
        subject: `${full.job.number} — Accomplishment Report #${report.reportNo} (${view.totals.toDatePct.toFixed(2)}% to date)`,
        amount: num(full.job.contractValue),
        link: REPORT_LINK(report.id),
        // In the name of whoever prepared it, whoever pressed the button.
        requesterId: report.preparedById,
        jobId: report.jobId,
      });
    } catch (err) {
      await prisma.progressReport.updateMany({ where: { id: report.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
      throw err;
    }
    await audit({ entityType: 'progress_report', entityId: report.id, action: 'SUBMITTED', summary: `${report.number} sent for approval` }, req);
    res.json(await reportView(me, (await loadReport(report.id))!));
  }),
);

progressRoutes.post(
  '/:id/withdraw',
  requireAny('gops.progress_billing.create', 'gops.progress_billing.edit_own', 'gops.progress_billing.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const report = await prisma.progressReport.findUnique({ where: { id: req.params.id } });
    if (!report) throw notFound('Progress report not found');
    if (!mayEditReport(me, report)) throw forbidden('Only the person who prepared it can pull it back');
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.progressReport.updateMany({ where: { id: report.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
      if (!claimed.count) throw badRequest('It was decided a moment ago — the decision stands');
      await cancelOpenRequest(DOC, report.id, tx, `pulled back by ${me.name}`, me.id);
    });
    await audit({ entityType: 'progress_report', entityId: report.id, action: 'UPDATED', summary: `${report.number} pulled back to draft` }, req);
    res.json(await reportView(me, (await loadReport(report.id))!));
  }),
);

/**
 * The route's outcome: approved — dated, signed by its last approver — the
 * report becomes the record and can be billed; returned or rejected, it is a
 * draft again. A decision that lands after a pull-back changes nothing.
 */
export async function settleProgressReport(approval: ApprovalRequest, outcome: ApprovalOutcome) {
  const report = await prisma.progressReport.findUnique({ where: { id: approval.documentId } });
  if (!report) return;
  const last = await prisma.approvalAction.findFirst({ where: { requestId: approval.id, action: 'APPROVED' }, orderBy: { actedAt: 'desc' } });
  const claimed = await prisma.progressReport.updateMany({
    where: { id: report.id, status: 'PENDING_APPROVAL' },
    data: outcome === 'APPROVED' ? { status: 'APPROVED', approvedAt: new Date(), approvedById: last?.approverId ?? null } : { status: 'DRAFT' },
  });
  await audit({
    entityType: 'progress_report',
    entityId: report.id,
    action: outcome,
    summary: claimed.count
      ? outcome === 'APPROVED'
        ? `${report.number} approved — it can now be billed`
        : `${report.number} returned to draft`
      : `${report.number} ${outcome.toLowerCase()} after it was ${statusLabel(report.status).toLowerCase()} — not applied`,
  });
}
onApprovalSettled(DOC, settleProgressReport);

progressRoutes.delete(
  '/:id',
  require_('gops.progress_billing.delete'),
  handler(async (req, res) => {
    const report = await prisma.progressReport.findUnique({
      where: { id: req.params.id },
      include: { billing: true, nextReport: true },
    });
    if (!report) throw notFound('Progress report not found');
    if (report.status === 'APPROVED') {
      throw badRequest('An approved report is the record of what was reported and cannot be deleted');
    }
    if (report.status === 'PENDING_APPROVAL') throw badRequest('Pull it back from its approvers first');
    if (report.billing) throw badRequest('A billing was raised from this report');
    if (report.nextReport) throw badRequest('A later report is chained to this one');
    if (!mayEditReport(currentUser(req), report)) throw forbidden('This report belongs to someone else');

    const days = await prisma.progressReportDay.findMany({ where: { reportId: report.id }, select: { id: true } });
    await prisma.progressReport.delete({ where: { id: req.params.id } });
    await deleteAttachmentsOf('progress_report_day', days.map((x) => x.id));
    await deleteAttachmentsOf('progress_report', [report.id]);
    await audit(
      { entityType: 'progress_report', entityId: req.params.id, action: 'DELETED', summary: `Deleted ${report.number}` },
      req,
    );
    res.json({ ok: true });
  }),
);

// ── Progress report PDF ──────────────────────────────────────────────────────

progressRoutes.get(
  '/:id/pdf',
  requireAnyOrDecider(...VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    const report = await readableReport(me, req.params.id, res.locals.deciderOnly === true);
    const view = presentReport(report, await reportTasks(report.jobId));
    const currency = await companyCurrency();
    const job = report.job;
    const site = [job.site?.address, job.site?.city].filter(Boolean).join(', ') || job.site?.name || '—';

    // The owner's Accomplishment Report (2026-10-15): the project, the
    // personnel, the schedule of values weighed line by line, the summary,
    // the milestones and the works remaining, then each day's actions with
    // their pictures — and the route's sign-offs.
    const sections: PdfSection[] = [
      {
        kind: 'fields',
        title: 'Project',
        columns: 2,
        fields: [
          { label: 'Project', value: `${job.number} — ${job.name}` },
          { label: 'Customer', value: job.customer.name },
          { label: 'Location', value: site },
          { label: 'Reporting period', value: `${formatDate(report.periodFrom)} to ${formatDate(report.periodTo)}` },
          { label: 'Project start', value: job.startDate ? formatDate(job.startDate) : '—' },
          { label: 'Target completion', value: job.targetEndDate ? formatDate(job.targetEndDate) : '—' },
          { label: 'Overall status', value: view.overallStatusText ?? '—' },
          { label: 'Overall progress', value: `${view.totals.toDatePct.toFixed(2)}% (this period ${view.totals.thisPeriodPct.toFixed(2)}%)` },
        ],
      },
    ];
    if (report.personnelInCharge || report.personnelSupport.length) {
      sections.push({
        kind: 'fields',
        title: 'Personnel present',
        columns: 2,
        fields: [
          { label: 'Project in charge', value: report.personnelInCharge ?? '—' },
          { label: 'Project support', value: report.personnelSupport.join(', ') || '—' },
        ],
      });
    }
    sections.push(
      {
        kind: 'table',
        title: 'Accomplishment against the schedule of values',
        head: ['Scope of work', `Value (${currency})`, 'Weight', 'Prev %', 'This %', 'To date %', 'Weighted %'],
        widths: [29, 15, 11, 11, 10, 11, 13],
        align: ['left', 'right', 'right', 'right', 'right', 'right', 'right'],
        rows: view.lines.map((l) => [
          l.scopeItem.name,
          formatAmount(l.scopeItem.value),
          `${l.weightPct.toFixed(2)}%`,
          `${l.previousPct.toFixed(2)}%`,
          `${l.thisPeriodPct.toFixed(2)}%`,
          `${l.toDatePct.toFixed(2)}%`,
          `${l.weightedPct.toFixed(2)}%`,
        ]),
      },
      {
        kind: 'totals',
        rows: [
          { label: 'Contract value', value: formatMoney(view.totals.contractValue, currency) },
          { label: `Earned this period (${view.totals.thisPeriodPct.toFixed(2)}%)`, value: formatMoney(view.totals.thisPeriodValue, currency) },
          { label: `Earned to date (${view.totals.toDatePct.toFixed(2)}%)`, value: formatMoney(view.totals.earnedValue, currency), bold: true },
        ],
      },
    );
    if (report.accomplishment) sections.push({ kind: 'text', title: 'Summary', body: report.accomplishment });
    if (report.milestones) sections.push({ kind: 'text', title: 'Key milestones achieved', body: report.milestones });
    if (report.nextPeriodPlan) sections.push({ kind: 'text', title: 'Remaining works', body: report.nextPeriodPlan });
    if (report.issues) sections.push({ kind: 'text', title: 'Issues and concerns', body: report.issues });
    if (report.manpower || report.equipment || report.weather) {
      sections.push({
        kind: 'fields',
        title: 'Resources and conditions',
        columns: 3,
        fields: [
          { label: 'Manpower', value: report.manpower ?? '—' },
          { label: 'Equipment', value: report.equipment ?? '—' },
          { label: 'Weather / delays', value: report.weather ?? '—' },
        ],
      });
    }

    // Each day's entry, its pictures under it — three to a row, captioned.
    const pictures = report.days.length
      ? await prisma.attachment.findMany({
          where: { entityType: 'progress_report_day', entityId: { in: report.days.map((x) => x.id) } },
          orderBy: { uploadedAt: 'asc' },
        })
      : [];
    for (const day of report.days) {
      const lines = [day.actions];
      if (day.findings) lines.push(`Findings: ${day.findings}`);
      if (day.recommendation) lines.push(`Recommendation: ${day.recommendation}`);
      if (day.remarks) lines.push(`Remarks: ${day.remarks}`);
      if (day.headcount != null) lines.push(`Personnel on site: ${day.headcount}`);
      sections.push({ kind: 'text', title: `Daily accomplishment — ${formatDate(day.workDate)}`, body: lines.join('\n') });
      const photos = await picturesFor(pictures.filter((p) => p.entityId === day.id));
      if (photos.length) sections.push({ kind: 'photos', photos });
    }
    // Pictures attached to the report itself (before the days existed).
    const general = await picturesFor(
      await prisma.attachment.findMany({ where: { entityType: DOC, entityId: report.id }, orderBy: { uploadedAt: 'asc' } }),
    );
    if (general.length) sections.push({ kind: 'photos', title: 'Photographs', photos: general });

    const slots =
      report.status === 'DRAFT'
        ? await approvalSlots(DOC, report.id, { amount: num(job.contractValue), requesterId: report.preparedById, jobId: report.jobId })
        : await approvalSlots(DOC, report.id);
    const people = await contactsOf([report.preparedById, report.approvedById]);
    const preparer = people.get(report.preparedById);
    const signatories: Signatory[] = [
      { role: 'Prepared by', name: report.preparedBy.name, phone: preparer?.phone, email: preparer?.email, at: preparedAt(slots) ?? report.createdAt },
      ...slotSignatories(slots),
    ];
    // A report approved by hand before the route (2026-10-15) has no request:
    // it prints who approved it, from the record.
    if (!slots.length && report.approvedBy) {
      const who = people.get(report.approvedBy.id);
      signatories.push({ role: 'Approved by', name: report.approvedBy.name, phone: who?.phone, email: who?.email, at: report.approvedAt });
    }

    const pdf = await renderDocument({
      title: 'Accomplishment Report',
      documentNumber: report.number,
      date: report.periodTo,
      reference: `${job.number} — ${job.name}  ·  Report #${report.reportNo}`,
      sections,
      signatories,
      footerNote: report.status === 'APPROVED' ? undefined : report.status === 'PENDING_APPROVAL' ? 'PENDING APPROVAL.' : 'DRAFT — NOT YET APPROVED.',
    });

    await audit({ entityType: DOC, entityId: report.id, action: 'EXPORTED', summary: `Printed ${report.number}` }, req);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      contentDisposition(paperFileName({ kind: 'Accomplishment Report', number: report.number, author: report.preparedBy.name, date: report.periodTo })),
    );
    res.send(pdf);
  }),
);

/** Attached pictures as the PDF engine takes them: JPEG, EXIF-turned, at most 1200 px; anything not a picture is skipped. */
async function picturesFor(files: { storedName: string; mimeType: string; caption: string | null; fileName: string }[]) {
  const out: { data: Buffer; caption?: string }[] = [];
  for (const f of files) {
    if (!f.mimeType.startsWith('image/')) continue;
    try {
      const data = await sharp(fs.readFileSync(attachmentPath(f.storedName)))
        .rotate()
        .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 78 })
        .toBuffer();
      out.push({ data, caption: f.caption ?? undefined });
    } catch {
      // A missing or unreadable file is left out; the paper still prints.
    }
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════
//  PROGRESS BILLING
// ════════════════════════════════════════════════════════════════════

export const billingRoutes = Router();
billingRoutes.use(authenticate);

const BILLING_SORTS = ['number', 'billingDate', 'grossAmount'];

/**
 * Which billings a list query means — one rule for the list and its printed
 * twin; `?ids=` (the rows ticked) is ANDed with the rest.
 */
function billingListWhere(q: ListQuery): Prisma.ProgressBillingWhereInput {
  const and: Prisma.ProgressBillingWhereInput[] = [];
  if (q.filters.jobId) and.push({ jobId: q.filters.jobId });
  const status = choice(q.filters.status, BillingStatus, 'Status');
  if (status) and.push({ status });
  const ids = idsFilter(q.filters.ids);
  if (ids) and.push({ id: { in: ids } });
  if (q.search) {
    and.push({
      OR: [
        { number: { contains: q.search, mode: 'insensitive' } },
        { job: { name: { contains: q.search, mode: 'insensitive' } } },
        { job: { number: { contains: q.search, mode: 'insensitive' } } },
      ],
    });
  }
  return and.length ? { AND: and } : {};
}

const billingListInclude = {
  job: { select: { id: true, number: true, name: true, customer: { select: { name: true } } } },
  progressReport: { select: { id: true, number: true, reportNo: true } },
} satisfies Prisma.ProgressBillingInclude;

billingRoutes.get(
  '/',
  requireAny('gops.progress_billing.view_all', 'gops.progress_billing.view_own'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const where = billingListWhere(q);

    const [rows, total] = await Promise.all([
      prisma.progressBilling.findMany({
        where,
        include: billingListInclude,
        orderBy: orderBy(q, BILLING_SORTS, { billingDate: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.progressBilling.count({ where }),
    ]);

    res.json(
      listResult(
        rows.map((r) => ({
          ...r,
          grossAmount: num(r.grossAmount),
          vatAmount: num(r.vatAmount),
          ewtAmount: num(r.ewtAmount),
          invoiceTotal: num(r.invoiceTotal),
          netCollectible: num(r.netCollectible),
        })),
        total,
        q,
      ),
    );
  }),
);

/**
 * A billing counts toward what is billed and collectible once it is approved
 * — APPROVED or INVOICED, the projects list's "Billed" rule. A draft or one
 * awaiting approval is a figure nobody has agreed yet: listed, never summed.
 */
const BILLING_COUNTED: BillingStatus[] = ['APPROVED', 'INVOICED'];

/**
 * The billings list on paper (rule 6, A5): the list's own query and sort —
 * or the rows ticked — on landscape pages, gross and net collectible as
 * amounts with the code in the head, and what the WHOLE set adds up to in the
 * totals block (net collectible bold: invoiced is not collectible, EWT is
 * withheld at source). A billing not yet approved prints its figures in
 * brackets and is left out of the totals, and the note under them says how
 * many — finance's words for its drafts. Declared above `/:id`.
 */
billingRoutes.get(
  '/pdf',
  requireAny('gops.progress_billing.view_all', 'gops.progress_billing.view_own'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const where = billingListWhere(q);
    const [rows, count, sums, unapproved, currency, named] = await Promise.all([
      prisma.progressBilling.findMany({ where, include: billingListInclude, orderBy: orderBy(q, BILLING_SORTS, { billingDate: 'desc' }), take: LIST_CAP }),
      prisma.progressBilling.count({ where }),
      prisma.progressBilling.aggregate({
        where: { AND: [where, { status: { in: BILLING_COUNTED } }] },
        _sum: { grossAmount: true, netCollectible: true },
      }),
      prisma.progressBilling.count({ where: { AND: [where, { status: { notIn: BILLING_COUNTED } }] } }),
      companyCurrency(),
      namedInFilter({ jobId: q.filters.jobId }),
    ]);
    const reference = listReference(count, rows.length, ['billing', 'billings'], [
      q.search ? `search "${q.search}"` : null,
      q.filters.status ? `status ${statusLabel(q.filters.status)}` : null,
      named.project ? `project ${named.project}` : null,
      q.filters.ids ? 'the rows selected' : null,
    ]);

    const pdf = await renderDocument({
      title: 'Progress Billings',
      date: new Date(),
      reference,
      landscape: true,
      sections: [
        {
          kind: 'table',
          head: ['Number', 'Project and customer', 'Billing no.', 'Date', 'Progress report', `Gross (${currency})`, `Net collectible (${currency})`, 'Status'],
          align: ['left', 'left', 'right', 'left', 'left', 'right', 'right', 'left'],
          rows: rows.map((b) => {
            const inSum = BILLING_COUNTED.includes(b.status);
            return [
              b.number,
              { title: b.job.name, body: `${b.job.number} · ${b.job.customer.name}` },
              String(b.billingNo),
              formatShortDate(b.billingDate),
              b.progressReport?.number ?? '',
              bracketed(formatAmount(num(b.grossAmount)), inSum),
              bracketed(formatAmount(num(b.netCollectible)), inSum),
              statusLabel(b.status),
            ];
          }),
        },
        {
          kind: 'totals',
          rows: [
            { label: totalLabel('Gross amount', count, rows.length), value: formatMoney(num(sums._sum.grossAmount), currency) },
            { label: totalLabel('Net collectible', count, rows.length), value: formatMoney(num(sums._sum.netCollectible), currency), bold: true },
          ],
        },
        ...listNotes([bracketNote(unapproved, ['billing not yet approved', 'billings not yet approved'])]),
      ],
    });

    await audit(
      { entityType: 'progress_billing', entityId: 'list', action: 'EXPORTED', summary: `Exported the billings list as PDF (${listReference(count, rows.length, ['billing', 'billings'], [])})` },
      req,
    );
    sendListPdf(res, pdf, 'billings.pdf');
  }),
);

/**
 * Raising a billing from an approved progress report.
 *
 * The amount is computed here, from the schedule of values and what has already
 * been billed — never typed. "Progress Billing — generated from the % complete
 * of the progress report against the Schedule of Values. Never keyed
 * independently" (model §4.2).
 */
billingRoutes.post(
  '/',
  require_('gops.progress_billing.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(z.object({ progressReportId: z.string().min(1) }), req.body);

    const report = await prisma.progressReport.findUnique({
      where: { id: body.progressReportId },
      include: { lines: { include: { scopeItem: true } }, job: true, billing: true },
    });
    if (!report) throw notFound('Progress report not found');
    if (report.status !== 'APPROVED') {
      throw badRequest('Only an approved progress report can be billed');
    }
    if (report.billing) throw badRequest(`Already billed as ${report.billing.number}`);

    // What has already been billed, per scope line. The new billing covers only
    // the difference, so re-billing the same work is arithmetically impossible.
    const priorLines = await prisma.progressBillingLine.findMany({
      where: {
        billing: { jobId: report.jobId, status: { in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'INVOICED'] } },
      },
      orderBy: { billing: { billingNo: 'desc' } },
      include: { billing: { select: { billingNo: true } } },
    });
    const billedPct = new Map<string, number>();
    for (const line of priorLines) {
      const current = billedPct.get(line.scopeItemId) ?? 0;
      billedPct.set(line.scopeItemId, Math.max(current, num(line.toDatePct)));
    }

    const company = await prisma.company.findUnique({ where: { id: 'company' } });
    const vatRate = num(company?.vatRate ?? d(0.12));
    const ewtRate = num(company?.ewtRate ?? d(0.02));

    const lines = report.lines.map((l) => {
      const scopeValue = num(l.scopeItem.value);
      const previousPct = billedPct.get(l.scopeItemId) ?? 0;
      const toDatePct = num(l.toDatePct);
      const previousAmount = cents((scopeValue * previousPct) / 100);
      const toDateAmount = cents((scopeValue * toDatePct) / 100);
      return {
        scopeItemId: l.scopeItemId,
        scopeValue: d(scopeValue),
        previousPct: d(previousPct),
        toDatePct: d(toDatePct),
        previousAmount: d(previousAmount),
        thisPeriodAmount: d(cents(toDateAmount - previousAmount)),
      };
    });

    const gross = cents(lines.reduce((s, l) => s + num(l.thisPeriodAmount), 0));
    if (gross <= 0) {
      throw badRequest(
        'There is nothing new to bill — every scope line has already been billed to its reported percentage.',
      );
    }

    const vatAmount = cents(gross * vatRate);
    const invoiceTotal = cents(gross + vatAmount);
    // EWT is withheld by the customer on the gross, NOT on the VAT. It comes
    // back as a tax certificate, not as cash — so net collectible is lower than
    // the invoice total without the customer being late.
    const ewtAmount = cents(gross * ewtRate);
    const netCollectible = cents(invoiceTotal - ewtAmount);

    const billing = await prisma.$transaction(async (tx) => {
      const last = await tx.progressBilling.findFirst({
        where: { jobId: report.jobId },
        orderBy: { billingNo: 'desc' },
        select: { billingNo: true },
      });
      const billingNo = (last?.billingNo ?? 0) + 1;
      return tx.progressBilling.create({
        data: {
          // Under its project, as the report is: GT-PRJ-2026-0112-PB-01.
          number: billingNumber(report.job.number, billingNo),
          billingNo,
          preparedById: me.id,
          // Set here rather than left to the column's now(), which the
          // database takes in UTC — yesterday's date until 08:00 Manila.
          billingDate: manilaDate(new Date()),
          jobId: report.jobId,
          progressReportId: report.id,
          grossAmount: d(gross),
          vatRate: d(vatRate),
          vatAmount: d(vatAmount),
          ewtRate: d(ewtRate),
          ewtAmount: d(ewtAmount),
          invoiceTotal: d(invoiceTotal),
          netCollectible: d(netCollectible),
          lines: { create: lines },
        },
      });
    });

    await audit(
      {
        entityType: 'progress_billing',
        entityId: billing.id,
        action: 'CREATED',
        summary: `Raised ${billing.number} from ${report.number} — ${formatMoney(gross)}`,
        actorId: me.id,
      },
      req,
    );

    res.status(201).json({ ...billing, grossAmount: gross });
  }),
);

async function loadBilling(id: string) {
  return prisma.progressBilling.findUnique({
    where: { id },
    include: {
      job: {
        select: {
          id: true,
          number: true,
          name: true,
          contractValue: true,
          customerPoNumber: true,
          customer: { select: { id: true, name: true } },
          site: { select: { id: true, name: true } },
          projectManager: { select: { id: true, name: true } },
        },
      },
      progressReport: { select: { id: true, number: true, reportNo: true, periodFrom: true, periodTo: true } },
      preparedBy: { select: { id: true, name: true } },
      lines: { include: { scopeItem: true }, orderBy: { scopeItem: { sortOrder: 'asc' } } },
      // The billing's onward link. Numbers and status only — the invoice's
      // money is Finance's to show, and it was copied from this billing anyway.
      invoice: { select: { id: true, number: true, status: true } },
    },
  });
}

function presentBilling(b: NonNullable<Awaited<ReturnType<typeof loadBilling>>>) {
  return {
    ...b,
    grossAmount: num(b.grossAmount),
    vatRate: num(b.vatRate),
    vatAmount: num(b.vatAmount),
    ewtRate: num(b.ewtRate),
    ewtAmount: num(b.ewtAmount),
    invoiceTotal: num(b.invoiceTotal),
    netCollectible: num(b.netCollectible),
    downpaymentRecouped: b.downpaymentRecouped ? num(b.downpaymentRecouped) : null,
    retentionWithheld: b.retentionWithheld ? num(b.retentionWithheld) : null,
    job: { ...b.job, contractValue: num(b.job.contractValue) },
    lines: b.lines.map((l) => ({
      ...l,
      scopeValue: num(l.scopeValue),
      previousPct: num(l.previousPct),
      toDatePct: num(l.toDatePct),
      previousAmount: num(l.previousAmount),
      thisPeriodAmount: num(l.thisPeriodAmount),
      scopeItem: { ...l.scopeItem, value: num(l.scopeItem.value) },
    })),
  };
}

const mayEditBilling = (me: ResolvedUser, preparerId: string | null | undefined) =>
  !!preparerId && canEditRecord(me, 'gops', 'progress_billing', preparerId);

/** The billing's preparer: its column, else (raised before 2026-10-15) its trail's CREATED row. */
async function billingPreparer(billing: { id: string; preparedById: string | null }): Promise<string | null> {
  if (billing.preparedById) return billing.preparedById;
  const { raised } = await billingTrail(billing.id);
  return raised?.actorId ?? null;
}

billingRoutes.get(
  '/:id',
  requireAnyOrDecider(...VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    const billing = await loadBilling(req.params.id);
    if (!billing) throw notFound('Billing not found');
    if (res.locals.deciderOnly === true && !(await mayDecide(me.id, BILL_DOC, [billing.id]))) throw notFound('Billing not found');
    const preparer = await billingPreparer(billing);
    const editor = mayEditBilling(me, preparer);
    const invoiceRequests = await prisma.invoiceRequest.findMany({
      where: { progressBillingId: billing.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, number: true, status: true, createdAt: true, requestedBy: { select: { name: true } } },
    });
    const live = invoiceRequests.find((r) => r.status === 'DRAFT' || r.status === 'PENDING_APPROVAL');
    res.json({
      ...presentBilling(billing),
      invoiceRequests,
      // The salesperson or Team Leader holding the project asks for the
      // invoice (2026-10-15); one live request at a time.
      canRequestInvoice: billing.status === 'APPROVED' && !billing.invoice && !live && (await mayRequestInvoice(me, billing.jobId)),
      canSubmit: billing.status === 'DRAFT' && editor,
      canWithdraw: billing.status === 'PENDING_APPROVAL' && editor,
      approvalRoute:
        billing.status === 'DRAFT' && preparer
          ? await routeBrief(BILL_DOC, num(billing.grossAmount), preparer, null, { jobId: billing.jobId })
          : null,
    });
  }),
);

/**
 * Who raised a billing and who approved it, from its trail. A billing keeps
 * no preparer column, so the trail's CREATED row IS who raised it — the one
 * rule the approve route refuses by and the paper prints as "Prepared by" —
 * and the last APPROVED row is who approved it. A row with no actor (a
 * billing written outside the routes) names nobody.
 */
async function billingTrail(billingId: string) {
  const rows = await prisma.auditLog.findMany({
    where: { entityType: 'progress_billing', entityId: billingId, action: { in: ['CREATED', 'APPROVED'] } },
    orderBy: { at: 'asc' },
    select: { action: true, actorId: true, actorName: true, at: true },
  });
  const named = rows.filter((r) => r.actorName || r.actorId);
  return {
    raised: named.find((r) => r.action === 'CREATED'),
    approved: named.filter((r) => r.action === 'APPROVED').pop(),
  };
}

billingRoutes.post(
  '/:id/submit',
  requireAny('gops.progress_billing.create', 'gops.progress_billing.edit_own', 'gops.progress_billing.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const billing = await prisma.progressBilling.findUnique({ where: { id: req.params.id }, include: { job: { select: { number: true, name: true } } } });
    if (!billing) throw notFound('Billing not found');
    const preparer = await billingPreparer(billing);
    if (!mayEditBilling(me, preparer)) throw forbidden('Only the person who raised this billing can submit it');
    if (billing.status !== 'DRAFT') throw badRequest('This billing has already been submitted');
    const claimed = await prisma.progressBilling.updateMany({ where: { id: billing.id, status: 'DRAFT' }, data: { status: 'PENDING_APPROVAL', preparedById: preparer } });
    if (!claimed.count) throw badRequest('It changed a moment ago — reload to see where it stands');
    try {
      await submitForApproval({
        documentType: BILL_DOC,
        documentId: billing.id,
        documentNumber: billing.number,
        subject: `${billing.job.number} — Progress Billing #${billing.billingNo} (${formatMoney(num(billing.grossAmount))})`,
        amount: num(billing.grossAmount),
        link: BILLING_LINK(billing.id),
        requesterId: preparer!,
        jobId: billing.jobId,
      });
    } catch (err) {
      await prisma.progressBilling.updateMany({ where: { id: billing.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
      throw err;
    }
    await audit({ entityType: 'progress_billing', entityId: billing.id, action: 'SUBMITTED', summary: `${billing.number} sent for approval` }, req);
    res.json({ ok: true });
  }),
);

billingRoutes.post(
  '/:id/withdraw',
  requireAny('gops.progress_billing.create', 'gops.progress_billing.edit_own', 'gops.progress_billing.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const billing = await prisma.progressBilling.findUnique({ where: { id: req.params.id } });
    if (!billing) throw notFound('Billing not found');
    if (!mayEditBilling(me, await billingPreparer(billing))) throw forbidden('Only the person who raised this billing can pull it back');
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.progressBilling.updateMany({ where: { id: billing.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
      if (!claimed.count) throw badRequest('It was decided a moment ago — the decision stands');
      await cancelOpenRequest(BILL_DOC, billing.id, tx, `pulled back by ${me.name}`, me.id);
    });
    await audit({ entityType: 'progress_billing', entityId: billing.id, action: 'UPDATED', summary: `${billing.number} pulled back to draft` }, req);
    res.json({ ok: true });
  }),
);

/** Approved by every step it can be invoiced; returned or rejected it is a draft again. */
export async function settleProgressBilling(approval: ApprovalRequest, outcome: ApprovalOutcome) {
  const billing = await prisma.progressBilling.findUnique({ where: { id: approval.documentId } });
  if (!billing) return;
  const claimed = await prisma.progressBilling.updateMany({
    where: { id: billing.id, status: 'PENDING_APPROVAL' },
    data: outcome === 'APPROVED' ? { status: 'APPROVED', approvedAt: new Date() } : { status: 'DRAFT' },
  });
  await audit({
    entityType: 'progress_billing',
    entityId: billing.id,
    action: outcome,
    summary: claimed.count
      ? outcome === 'APPROVED'
        ? `${billing.number} approved — it can now be invoiced`
        : `${billing.number} returned to draft`
      : `${billing.number} ${outcome.toLowerCase()} after it was ${statusLabel(billing.status).toLowerCase()} — not applied`,
  });
}
onApprovalSettled(BILL_DOC, settleProgressBilling);

billingRoutes.delete(
  '/:id',
  require_('gops.progress_billing.delete'),
  handler(async (req, res) => {
    const billing = await prisma.progressBilling.findUnique({ where: { id: req.params.id } });
    if (!billing) throw notFound('Billing not found');
    if (billing.status === 'APPROVED' || billing.status === 'INVOICED') {
      throw badRequest('An approved billing cannot be deleted');
    }
    if (billing.status === 'PENDING_APPROVAL') throw badRequest('Pull it back from its approvers first');
    await prisma.progressBilling.delete({ where: { id: req.params.id } });
    await audit(
      { entityType: 'progress_billing', entityId: req.params.id, action: 'DELETED', summary: `Deleted ${billing.number}` },
      req,
    );
    res.json({ ok: true });
  }),
);

billingRoutes.get(
  '/:id/pdf',
  requireAnyOrDecider(...VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    const billing = await loadBilling(req.params.id);
    if (!billing) throw notFound('Billing not found');
    if (res.locals.deciderOnly === true && !(await mayDecide(me.id, BILL_DOC, [billing.id]))) throw notFound('Billing not found');

    const view = presentBilling(billing);
    const currency = await companyCurrency();

    // The money block: a "Less:" row names its own sign, so the figure
    // prints as the amount taken off; the bold row is the one that matters.
    const totals: PdfTotal[] = [{ label: 'Gross amount', value: formatMoney(view.grossAmount, currency) }];
    if (view.downpaymentRecouped) {
      totals.push({ label: 'Less: downpayment recouped', value: formatMoney(view.downpaymentRecouped, currency) });
    }
    if (view.retentionWithheld) {
      totals.push({ label: 'Less: retention withheld', value: formatMoney(view.retentionWithheld, currency) });
    }
    totals.push(
      { label: `VAT (${ratePct(view.vatRate)})`, value: formatMoney(view.vatAmount, currency) },
      { label: 'Invoice total', value: formatMoney(view.invoiceTotal, currency) },
      { label: `Less: EWT (${ratePct(view.ewtRate)})`, value: formatMoney(view.ewtAmount, currency) },
      { label: 'Net collectible', value: formatMoney(view.netCollectible, currency), bold: true },
    );

    // Prepared by, then one slot per step of the route (2026-10-15): a draft
    // prints the route submitting would take; a billing approved by hand
    // before the route existed prints who approved it, from its trail.
    const preparerId = await billingPreparer(billing);
    const slots =
      billing.status === 'DRAFT' && preparerId
        ? await approvalSlots(BILL_DOC, billing.id, { amount: num(billing.grossAmount), requesterId: preparerId, jobId: billing.jobId })
        : await approvalSlots(BILL_DOC, billing.id);
    const { raised, approved: approvedRow } = await billingTrail(billing.id);
    const people = await contactsOf([preparerId, approvedRow?.actorId]);
    const signatories: Signatory[] = [];
    if (preparerId) {
      const who = people.get(preparerId);
      const name = billing.preparedBy?.name ?? raised?.actorName ?? who?.name;
      signatories.push({ role: 'Prepared by', name, phone: who?.phone, email: who?.email, at: preparedAt(slots) ?? raised?.at ?? billing.createdAt });
    }
    if (slots.length) signatories.push(...slotSignatories(slots));
    else if (approvedRow && (billing.status === 'APPROVED' || billing.status === 'INVOICED')) {
      const who = approvedRow.actorId ? people.get(approvedRow.actorId) : undefined;
      signatories.push({ role: 'Approved by', name: approvedRow.actorName ?? who?.name, phone: who?.phone, email: who?.email, at: billing.approvedAt ?? approvedRow.at });
    }

    const pdf = await renderDocument({
      title: 'Progress Billing',
      documentNumber: billing.number,
      date: billing.billingDate,
      reference: `${billing.job.number} — ${billing.job.name}  ·  Billing #${billing.billingNo}`,
      sections: [
        {
          kind: 'fields',
          columns: 3,
          fields: [
            { label: 'Customer', value: billing.job.customer.name },
            { label: 'Site', value: billing.job.site?.name ?? '—' },
            { label: 'Customer P.O.', value: billing.job.customerPoNumber ?? '—' },
            { label: 'Progress report', value: billing.progressReport.number },
            {
              label: 'Period covered',
              value: `${formatDate(billing.progressReport.periodFrom)} to ${formatDate(billing.progressReport.periodTo)}`,
            },
            { label: 'Contract value', value: formatMoney(view.job.contractValue, currency) },
          ],
        },
        {
          kind: 'table',
          title: 'Billing against the schedule of values',
          // The screen's words: what was billed BEFORE this billing is
          // "Previously billed", never "billed to date", which it is not.
          head: ['Scope', `Contract value (${currency})`, 'Previously billed %', 'To date %', `Previously billed (${currency})`, `This billing (${currency})`],
          align: ['left', 'right', 'right', 'right', 'right', 'right'],
          rows: view.lines.map((l) => [
            l.scopeItem.name,
            formatAmount(l.scopeValue),
            `${l.previousPct.toFixed(2)}%`,
            `${l.toDatePct.toFixed(2)}%`,
            formatAmount(l.previousAmount),
            formatAmount(l.thisPeriodAmount),
          ]),
        },
        { kind: 'totals', rows: totals },
        {
          kind: 'text',
          body:
            'The EWT above is withheld at source by the customer and remitted to the BIR on our ' +
            'behalf. It is supported by BIR Form 2307 and is not an unpaid balance.',
        },
      ],
      signatories,
    });

    await audit(
      { entityType: 'progress_billing', entityId: billing.id, action: 'EXPORTED', summary: `Printed ${billing.number}` },
      req,
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition(paperFileName({ kind: 'Progress Billing', number: billing.number, author: raised?.actorName, date: billing.billingDate })));
    res.send(pdf);
  }),
);

// ════════════════════════════════════════════════════════════════════
//  TASKS (a project's Requests for Approval live in routes/planApprovals.ts)
// ════════════════════════════════════════════════════════════════════

export const planRoutes = Router();
planRoutes.use(authenticate);

// The project's drawings are Requests for Approval since 2026-10-13
// (`routes/planApprovals.ts`, `/api/plans`): raised, submitted and decided
// through the approval engine — never approved here by hand.

// ── Tasks ────────────────────────────────────────────────────────────────────

planRoutes.post(
  '/:jobId/tasks',
  require_('gops.projects.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(
      z.object({
        name: z.string().trim().min(2),
        description: z.string().optional().nullable(),
        scopeItemId: z.string().optional().nullable(),
        assignedToId: z.string().optional().nullable(),
        startDate: z.string().optional().nullable(),
        dueDate: z.string().optional().nullable(),
        weight: z.number().min(0).max(9999).optional().nullable(),
      }),
      req.body,
    );
    const task = await prisma.jobTask.create({
      data: {
        jobId: req.params.jobId,
        name: body.name,
        description: body.description || null,
        scopeItemId: body.scopeItemId || null,
        assignedToId: body.assignedToId || null,
        startDate: asDate(body.startDate),
        dueDate: asDate(body.dueDate),
        weight: body.weight ?? null,
      },
    });
    res.status(201).json(task);
  }),
);

planRoutes.patch(
  '/:jobId/tasks/:taskId',
  require_('gops.projects.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(
      z.object({
        name: z.string().trim().min(2).optional(),
        status: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'BLOCKED', 'DONE']).optional(),
        progressPct: z.number().int().min(0).max(100).optional(),
        assignedToId: z.string().optional().nullable(),
        scopeItemId: z.string().optional().nullable(),
        startDate: z.string().optional().nullable(),
        dueDate: z.string().optional().nullable(),
        // A task's weight in its phase (2026-10-15): the phase's % from its
        // tasks is Σ weight × progress ÷ Σ weight; none counts as 1.
        weight: z.number().min(0).max(9999).optional().nullable(),
      }),
      req.body,
    );
    const task = await prisma.jobTask.findFirst({
      where: { id: req.params.taskId, jobId: req.params.jobId },
    });
    if (!task) throw notFound('Task not found');
    if (body.scopeItemId) {
      const item = await prisma.jobScopeItem.findFirst({
        where: { id: body.scopeItemId, jobId: req.params.jobId },
        select: { id: true },
      });
      if (!item) throw badRequest('That scope line is not on this project');
    }

    res.json(
      await prisma.jobTask.update({
        where: { id: task.id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.status !== undefined
            ? {
                status: body.status,
                progressPct: body.status === 'DONE' ? 100 : (body.progressPct ?? task.progressPct),
                doneAt: body.status === 'DONE' ? new Date() : null,
              }
            : {}),
          ...(body.progressPct !== undefined && body.status === undefined
            ? { progressPct: body.progressPct }
            : {}),
          ...(body.assignedToId !== undefined ? { assignedToId: body.assignedToId || null } : {}),
          ...(body.scopeItemId !== undefined ? { scopeItemId: body.scopeItemId || null } : {}),
          ...(body.startDate !== undefined ? { startDate: asDate(body.startDate) } : {}),
          ...(body.dueDate !== undefined ? { dueDate: asDate(body.dueDate) } : {}),
          ...(body.weight !== undefined ? { weight: body.weight } : {}),
        },
      }),
    );
  }),
);

/**
 * The costing's scope of work as this project's tasks (2026-10-06).
 *
 * A costing plans each phase's tasks on working days (Mon–Sat, day 1 = the
 * first); the project's Scope of Work tab draws them as a Gantt chart on real
 * dates. This writes them down once, from the project's start date, for every
 * scope line that still has no task — a line somebody has already planned by
 * hand is left alone, so running it again never overwrites that work. Each
 * scope line's planned dates become its tasks' span, which is also what the
 * planned S-curve reads.
 */
planRoutes.post(
  '/:jobId/tasks/from-costing',
  require_('gops.projects.edit_all'),
  handler(async (req, res) => {
    const job = await prisma.job.findUnique({
      where: { id: req.params.jobId },
      select: {
        id: true,
        number: true,
        startDate: true,
        scopeItems: {
          orderBy: { sortOrder: 'asc' },
          select: { id: true, sourceSectionId: true, _count: { select: { tasks: true } } },
        },
      },
    });
    if (!job) throw notFound('Job not found');
    const start = job.startDate;
    if (!start) throw badRequest('Give the project a start date first - the plan counts working days from it');

    const sectionIds = job.scopeItems.map((s) => s.sourceSectionId).filter((id): id is string => !!id);
    const sections = await prisma.scopeSection.findMany({
      where: { id: { in: sectionIds } },
      select: { id: true, durationDays: true, tasks: { orderBy: { sortOrder: 'asc' } } },
    });
    const plan = planTasks(sections.map((s) => ({ durationDays: s.durationDays, tasks: s.tasks })));
    const bySection = new Map(sections.map((s, i) => [s.id, { tasks: s.tasks, planned: plan.sections[i] }]));

    let created = 0;
    let skipped = 0;
    await prisma.$transaction(async (tx) => {
      for (const item of job.scopeItems) {
        const source = item.sourceSectionId ? bySection.get(item.sourceSectionId) : undefined;
        if (!source || !source.tasks.length) continue;
        if (item._count.tasks > 0) {
          skipped++;
          continue;
        }
        await tx.jobTask.createMany({
          data: source.tasks.map((t, i) => ({
            jobId: job.id,
            scopeItemId: item.id,
            name: t.name,
            startDate: workingDayDate(start, source.planned.tasks[i].start),
            dueDate: workingDayDate(start, source.planned.tasks[i].end),
            sortOrder: i,
          })),
        });
        if (source.planned.start !== null && source.planned.end !== null) {
          await tx.jobScopeItem.update({
            where: { id: item.id },
            data: {
              plannedStart: workingDayDate(start, source.planned.start),
              plannedEnd: workingDayDate(start, source.planned.end),
            },
          });
        }
        created += source.tasks.length;
      }
    });

    if (created) {
      await audit(
        {
          entityType: 'job',
          entityId: job.id,
          action: 'UPDATED',
          summary: `${job.number}: ${created} task${created === 1 ? '' : 's'} planned from the costing's scope of work`,
        },
        req,
      );
    }
    res.json({ created, skipped });
  }),
);

planRoutes.delete(
  '/:jobId/tasks/:taskId',
  require_('gops.projects.edit_all'),
  handler(async (req, res) => {
    const task = await prisma.jobTask.findFirst({
      where: { id: req.params.taskId, jobId: req.params.jobId },
    });
    if (!task) throw notFound('Task not found');
    await prisma.jobTask.delete({ where: { id: task.id } });
    res.json({ ok: true });
  }),
);
