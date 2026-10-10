import { Router } from 'express';
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
import { authenticate, require_, requireAny, currentUser } from '../auth/middleware';
import { can, type ResolvedUser } from '../permissions/resolve';
import { audit } from '../shared/audit';
import { nextNumber } from '../shared/numbering';
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
import { contactPhone } from '../shared/approvals';
import { manilaDate, workingDayDate } from '../shared/day';
import { planTasks } from '../shared/costingMath';
import { LIST_CAP, listReference, totalLabel, namedInFilter, choice, bracketed, bracketNote, listNotes } from './jobs';

const d = (v: number | string | null | undefined) =>
  v === null || v === undefined ? new Prisma.Decimal(0) : new Prisma.Decimal(v);
const num = (v: Prisma.Decimal | null | undefined) => (v == null ? 0 : Number(v));
const cents = (n: number) => Math.round(n * 100) / 100;

/** A rate as a document prints it: 0.12 → "12%", 0.075 → "7.5%". */
const pct = (rate: number) => `${+(rate * 100).toFixed(2)}%`;

/**
 * The contact lines a sign-off prints under a name — read for the PAPER
 * only, never sent with the record (the quotation's rule: `GET …/:id`
 * carries no mobile). `contactPhone` is the one reading of a person's number.
 */
async function printContacts(ids: (string | null | undefined)[]) {
  const wanted = [...new Set(ids.filter((v): v is string => !!v))];
  const rows = wanted.length
    ? await prisma.user.findMany({
        where: { id: { in: wanted } },
        select: { id: true, name: true, email: true, phone: true, employee: { select: { mobile: true } } },
      })
    : [];
  return new Map(rows.map((u) => [u.id, { name: u.name, phone: contactPhone(u), email: u.email }]));
}

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
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="progress-reports.pdf"');
    res.send(pdf);
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
          site: { select: { id: true, name: true } },
          projectManager: { select: { id: true, name: true } },
        },
      },
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

function presentReport(report: NonNullable<Awaited<ReturnType<typeof loadReport>>>) {
  const lines = report.lines.map((l) => ({
    ...l,
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

progressRoutes.get(
  '/:id',
  requireAny('gops.progress_billing.view_all', 'gops.progress_billing.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const report = await loadReport(req.params.id);
    if (!report) throw notFound('Progress report not found');

    res.json({
      ...presentReport(report),
      canEdit:
        report.status === 'DRAFT' &&
        (me.isSuperAdmin ||
          me.permissions.has('gops.progress_billing.edit_all') ||
          (report.preparedById === me.id && me.permissions.has('gops.progress_billing.edit_own'))),
      // The approve route's own checks, so the page never offers a button the
      // route refuses: still open, the right held, and not the person who
      // prepared it — a super admin included (rule 3).
      canApprove: report.status !== 'APPROVED' && can(me, 'gops.progress_billing.approve') && report.preparedById !== me.id,
    });
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

    const open = await prisma.progressReport.findFirst({
      where: { jobId: body.jobId, status: { in: ['DRAFT', 'SUBMITTED'] } },
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
    const carried = new Map(previous?.lines.map((l) => [l.scopeItemId, num(l.toDatePct)]) ?? []);

    const report = await prisma.$transaction(async (tx) => {
      const number = await nextNumber('progress_report', tx);
      const last = await tx.progressReport.findFirst({
        where: { jobId: body.jobId },
        orderBy: { reportNo: 'desc' },
        select: { reportNo: true },
      });

      return tx.progressReport.create({
        data: {
          number,
          reportNo: (last?.reportNo ?? 0) + 1,
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
  require_('gops.progress_billing.edit_own'),
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
      }),
      req.body,
    );

    const data: Prisma.ProgressReportUpdateInput = {};
    for (const f of ['weather', 'manpower', 'equipment', 'accomplishment', 'issues', 'nextPeriodPlan'] as const) {
      if (body[f] !== undefined) (data as Record<string, unknown>)[f] = body[f] || null;
    }
    if (body.periodFrom) data.periodFrom = new Date(body.periodFrom);
    if (body.periodTo) data.periodTo = new Date(body.periodTo);

    await prisma.progressReport.update({ where: { id: req.params.id }, data });
    const report = await loadReport(req.params.id);
    res.json(presentReport(report!));
  }),
);

/** Sets this period's percentage on one scope line. */
progressRoutes.patch(
  '/:id/lines/:lineId',
  require_('gops.progress_billing.edit_own'),
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
    res.json(presentReport(report!));
  }),
);

progressRoutes.post(
  '/:id/approve',
  require_('gops.progress_billing.approve'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const report = await prisma.progressReport.findUnique({
      where: { id: req.params.id },
      include: { job: true },
    });
    if (!report) throw notFound('Progress report not found');
    if (report.status === 'APPROVED') throw badRequest('This report has already been approved');

    // Rule 3: whoever prepared the report never approves it — a super admin
    // included, as the approval engine refuses one (and as the billing's
    // route does). Otherwise the paper would print one person as both
    // Prepared by and Approved by.
    if (report.preparedById === me.id) {
      throw forbidden('You cannot approve a report you prepared yourself');
    }

    // Claimed as read: two approvers pressing at once approve it once, and
    // the second never writes their name over the first's.
    const claimed = await prisma.progressReport.updateMany({
      where: { id: report.id, status: { not: 'APPROVED' } },
      data: { status: 'APPROVED', approvedById: me.id, approvedAt: new Date() },
    });
    if (!claimed.count) throw badRequest('This report has already been approved');

    await audit(
      {
        entityType: 'progress_report',
        entityId: report.id,
        action: 'APPROVED',
        summary: `Approved ${report.number} for ${report.job.number}`,
      },
      req,
    );
    res.json({ ok: true });
  }),
);

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
    if (report.billing) throw badRequest('A billing was raised from this report');
    if (report.nextReport) throw badRequest('A later report is chained to this one');

    await prisma.progressReport.delete({ where: { id: req.params.id } });
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
  requireAny('gops.progress_billing.view_all', 'gops.progress_billing.view_own'),
  handler(async (req, res) => {
    const report = await loadReport(req.params.id);
    if (!report) throw notFound('Progress report not found');

    const view = presentReport(report);
    const currency = await companyCurrency();
    const people = await printContacts([report.preparedById, report.approvedById]);

    const photos = await prisma.attachment.findMany({
      where: { entityType: 'progress_report', entityId: report.id },
      orderBy: { uploadedAt: 'asc' },
    });

    const sections: PdfSection[] = [
      {
        kind: 'fields',
        columns: 3,
        fields: [
          { label: 'Project', value: `${report.job.number} — ${report.job.name}` },
          { label: 'Customer', value: report.job.customer.name },
          { label: 'Site', value: report.job.site?.name ?? '—' },
          { label: 'Report no.', value: String(report.reportNo) },
          {
            label: 'Period covered',
            value: `${formatDate(report.periodFrom)} to ${formatDate(report.periodTo)}`,
          },
          { label: 'Previous report', value: report.previousReport?.number ?? 'None — first report' },
        ],
      },
      {
        kind: 'table',
        title: 'Accomplishment against the schedule of values',
        head: ['Scope', `Value (${currency})`, 'Prev %', 'This %', 'To date %', `Earned to date (${currency})`],
        align: ['left', 'right', 'right', 'right', 'right', 'right'],
        rows: view.lines.map((l) => [
          l.scopeItem.name,
          formatAmount(l.scopeItem.value),
          `${l.previousPct.toFixed(2)}%`,
          `${l.thisPeriodPct.toFixed(2)}%`,
          `${l.toDatePct.toFixed(2)}%`,
          formatAmount(l.toDateAmount),
        ]),
      },
      // The money block, as every document prints it: the figures the lines
      // add up to, each percentage in its label as the VAT's rate is, the
      // bold row the one that matters — never a TOTAL row inside the table.
      {
        kind: 'totals',
        rows: [
          { label: 'Contract value', value: formatMoney(view.totals.contractValue, currency) },
          {
            label: `Earned this period (${view.totals.thisPeriodPct.toFixed(2)}%)`,
            value: formatMoney(view.totals.thisPeriodValue, currency),
          },
          {
            label: `Earned to date (${view.totals.toDatePct.toFixed(2)}%)`,
            value: formatMoney(view.totals.earnedValue, currency),
            bold: true,
          },
        ],
      },
    ];

    if (report.accomplishment) {
      sections.push({ kind: 'text', title: 'Work accomplished this period', body: report.accomplishment });
    }
    if (report.manpower || report.equipment) {
      sections.push({
        kind: 'fields',
        title: 'Resources deployed',
        columns: 2,
        fields: [
          { label: 'Manpower', value: report.manpower ?? '—' },
          { label: 'Equipment', value: report.equipment ?? '—' },
        ],
      });
    }
    if (report.weather) sections.push({ kind: 'text', title: 'Weather and delays', body: report.weather });
    if (report.issues) sections.push({ kind: 'text', title: 'Issues', body: report.issues });
    if (report.nextPeriodPlan) {
      sections.push({ kind: 'text', title: 'Plan for next period', body: report.nextPeriodPlan });
    }
    if (photos.length) {
      sections.push({
        kind: 'table',
        title: `Photographs (${photos.length})`,
        head: ['No.', 'Caption', 'Taken'],
        widths: [8, 62, 30],
        align: ['right', 'left', 'left'],
        rows: photos.map((p, i) => [
          String(i + 1),
          p.caption ?? p.fileName,
          // A timestamp: Manila's day of it, as a DATE column holds one, so
          // a photo taken before 08:00 is not dated the day before.
          formatDate(manilaDate(p.capturedAt ?? p.uploadedAt)),
        ]),
      });
    }

    // No route: the people who actually acted, each dated. Prepared by the
    // author; approved on the record by one person (not through the engine),
    // open — "Pending" — until somebody does. Nobody "checks" a report in
    // the app, so no such slot is printed.
    const preparer = people.get(report.preparedById);
    const approver = report.approvedById ? people.get(report.approvedById) : undefined;
    const signatories: Signatory[] = [
      { role: 'Prepared by', name: report.preparedBy.name, phone: preparer?.phone, email: preparer?.email, at: report.createdAt },
      { role: 'Approved by', name: report.approvedBy?.name, phone: approver?.phone, email: approver?.email, at: report.approvedAt },
    ];

    const pdf = await renderDocument({
      title: 'Progress Report',
      documentNumber: report.number,
      date: report.periodTo,
      reference: `${report.job.number} — ${report.job.name}  ·  Report #${report.reportNo}`,
      sections,
      signatories,
    });

    await audit(
      { entityType: 'progress_report', entityId: report.id, action: 'EXPORTED', summary: `Printed ${report.number}` },
      req,
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${report.number}.pdf"`);
    res.send(pdf);
  }),
);

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
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="billings.pdf"');
    res.send(pdf);
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
      const number = await nextNumber('progress_billing', tx);
      const last = await tx.progressBilling.findFirst({
        where: { jobId: report.jobId },
        orderBy: { billingNo: 'desc' },
        select: { billingNo: true },
      });
      return tx.progressBilling.create({
        data: {
          number,
          billingNo: (last?.billingNo ?? 0) + 1,
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

billingRoutes.get(
  '/:id',
  requireAny('gops.progress_billing.view_all', 'gops.progress_billing.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const billing = await loadBilling(req.params.id);
    if (!billing) throw notFound('Billing not found');
    // The approve route's own checks, so the page never offers a button the
    // route refuses — the person who raised it never approves it.
    const { raised } = await billingTrail(billing.id);
    res.json({
      ...presentBilling(billing),
      canApprove:
        (billing.status === 'DRAFT' || billing.status === 'PENDING_APPROVAL') &&
        can(me, 'gops.progress_billing.approve') &&
        raised?.actorId !== me.id,
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
  '/:id/approve',
  require_('gops.progress_billing.approve'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const billing = await prisma.progressBilling.findUnique({ where: { id: req.params.id } });
    if (!billing) throw notFound('Billing not found');
    if (billing.status !== 'DRAFT' && billing.status !== 'PENDING_APPROVAL') {
      throw badRequest('This billing has already been approved');
    }

    // Rule 3: whoever raised the billing never approves it — a super admin
    // included, as the approval engine refuses one. Otherwise the paper would
    // print one person as both Prepared by and Approved by.
    const { raised } = await billingTrail(billing.id);
    if (raised?.actorId === me.id) {
      throw forbidden('You cannot approve a billing you raised yourself');
    }

    // Claimed as read: two approvers pressing at once approve it once.
    const claimed = await prisma.progressBilling.updateMany({
      where: { id: billing.id, status: { in: ['DRAFT', 'PENDING_APPROVAL'] } },
      data: { status: 'APPROVED', approvedAt: new Date() },
    });
    if (!claimed.count) throw badRequest('This billing has already been approved');
    await audit(
      {
        entityType: 'progress_billing',
        entityId: billing.id,
        action: 'APPROVED',
        summary: `Approved ${billing.number}`,
      },
      req,
    );
    res.json({ ok: true });
  }),
);

billingRoutes.delete(
  '/:id',
  require_('gops.progress_billing.delete'),
  handler(async (req, res) => {
    const billing = await prisma.progressBilling.findUnique({ where: { id: req.params.id } });
    if (!billing) throw notFound('Billing not found');
    if (billing.status === 'APPROVED' || billing.status === 'INVOICED') {
      throw badRequest('An approved billing cannot be deleted');
    }
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
  requireAny('gops.progress_billing.view_all', 'gops.progress_billing.view_own'),
  handler(async (req, res) => {
    const billing = await loadBilling(req.params.id);
    if (!billing) throw notFound('Billing not found');

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
      { label: `VAT (${pct(view.vatRate)})`, value: formatMoney(view.vatAmount, currency) },
      { label: 'Invoice total', value: formatMoney(view.invoiceTotal, currency) },
      { label: `Less: EWT (${pct(view.ewtRate)})`, value: formatMoney(view.ewtAmount, currency) },
      { label: 'Net collectible', value: formatMoney(view.netCollectible, currency), bold: true },
    );

    // No route, and no preparer column on the billing: who raised it and
    // who approved it are the trail's own CREATED and APPROVED rows, each
    // dated. "Approved by" stays open — "Pending" — until somebody approves
    // it; a person the trail cannot name (a billing made outside the routes)
    // is left out rather than guessed, and nobody signs a Conforme in the
    // app, so no such slot is printed.
    const { raised, approved: approvedRow } = await billingTrail(billing.id);
    const people = await printContacts([raised?.actorId, approvedRow?.actorId]);
    const isApproved = billing.status === 'APPROVED' || billing.status === 'INVOICED';
    const signatories: Signatory[] = [];
    if (raised) {
      const who = raised.actorId ? people.get(raised.actorId) : undefined;
      signatories.push({ role: 'Prepared by', name: raised.actorName ?? who?.name, phone: who?.phone, email: who?.email, at: raised.at });
    }
    if (!isApproved) {
      signatories.push({ role: 'Approved by' });
    } else if (approvedRow) {
      const who = approvedRow.actorId ? people.get(approvedRow.actorId) : undefined;
      signatories.push({
        role: 'Approved by',
        name: approvedRow.actorName ?? who?.name,
        phone: who?.phone,
        email: who?.email,
        at: billing.approvedAt ?? approvedRow.at,
      });
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
    res.setHeader('Content-Disposition', `inline; filename="${billing.number}.pdf"`);
    res.send(pdf);
  }),
);

// ════════════════════════════════════════════════════════════════════
//  APPROVED PLANS  &  TASKS
// ════════════════════════════════════════════════════════════════════

export const planRoutes = Router();
planRoutes.use(authenticate);

planRoutes.post(
  '/:jobId/plans',
  require_('gops.plans.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(
      z.object({
        title: z.string().trim().min(2),
        drawingNo: z.string().trim().optional().nullable(),
        revision: z.string().trim().default('0'),
        discipline: z.string().trim().optional().nullable(),
        notes: z.string().optional().nullable(),
      }),
      req.body,
    );

    const plan = await prisma.approvedPlan.create({
      data: {
        jobId: req.params.jobId,
        title: body.title,
        drawingNo: body.drawingNo || null,
        revision: body.revision,
        discipline: body.discipline || null,
        notes: body.notes || null,
        uploadedById: me.id,
        submittedAt: new Date(),
      },
    });
    await audit(
      { entityType: 'job', entityId: req.params.jobId, action: 'UPDATED', summary: `Added plan ${plan.title}` },
      req,
    );
    res.status(201).json(plan);
  }),
);

planRoutes.patch(
  '/:jobId/plans/:planId',
  require_('gops.plans.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(
      z.object({
        status: z.enum(['FOR_APPROVAL', 'APPROVED', 'SUPERSEDED', 'REJECTED']).optional(),
        notes: z.string().optional().nullable(),
      }),
      req.body,
    );
    const plan = await prisma.approvedPlan.findFirst({
      where: { id: req.params.planId, jobId: req.params.jobId },
    });
    if (!plan) throw notFound('Plan not found');

    const updated = await prisma.approvedPlan.update({
      where: { id: plan.id },
      data: {
        ...(body.status !== undefined
          ? {
              status: body.status,
              approvedAt: body.status === 'APPROVED' ? new Date() : null,
              approvedBy: body.status === 'APPROVED' ? me.name : null,
            }
          : {}),
        ...(body.notes !== undefined ? { notes: body.notes || null } : {}),
      },
    });
    await audit(
      {
        entityType: 'job',
        entityId: req.params.jobId,
        action: body.status === 'APPROVED' ? 'APPROVED' : 'UPDATED',
        summary: `Plan ${updated.title} — ${updated.status}`,
      },
      req,
    );
    res.json(updated);
  }),
);

planRoutes.delete(
  '/:jobId/plans/:planId',
  require_('gops.plans.delete'),
  handler(async (req, res) => {
    const plan = await prisma.approvedPlan.findFirst({
      where: { id: req.params.planId, jobId: req.params.jobId },
    });
    if (!plan) throw notFound('Plan not found');
    if (plan.status === 'APPROVED') {
      throw badRequest('An approved plan is a record — supersede it instead of deleting it');
    }
    await prisma.approvedPlan.delete({ where: { id: plan.id } });
    res.json({ ok: true });
  }),
);

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
        },
      }),
    );
  }),
);

/**
 * The costing's scope of work as this project's tasks (2026-10-06).
 *
 * A costing plans each phase's tasks on working days (Mon–Fri, day 1 = the
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
