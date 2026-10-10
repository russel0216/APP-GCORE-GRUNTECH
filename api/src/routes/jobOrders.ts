import { Router } from 'express';
import { z } from 'zod';
import { Prisma, JobOrderStatus } from '@prisma/client';
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
import { can, canEditRecord, type ResolvedUser } from '../permissions/resolve';
import { audit } from '../shared/audit';
import { nextNumber } from '../shared/numbering';
import { notify } from '../shared/notifications';
import {
  submitForApproval,
  onApprovalSettled,
  approvalSlots,
  slotSignatories,
  routePreview,
  contactPhone,
  type ApprovalOutcome,
  type ApprovalSlot,
} from '../shared/approvals';
import {
  renderDocument,
  formatDate,
  formatMoney,
  formatAmount,
  formatShortDate,
  statusLabel,
  companyCurrency,
  type PdfSection,
  type Signatory,
} from '../shared/pdf';
import { registerSearch } from '../shared/search';
import { dayKey } from '../shared/aftermarket';
import { workingDaysBetween } from '../shared/day';
import { valueRevision } from '../shared/pipeline';
import {
  costingForJob,
  createJobRecord,
  LIST_CAP,
  listReference,
  totalLabel,
  listDay,
  namedInFilter,
  choice,
  bracketed,
  bracketNote,
  listNotes,
} from './jobs';

/**
 * Job orders — the PROJECT WORK ORDER (2026-10-09, the owner's call; a
 * request for service work before that).
 *
 * Sales raises it for a customer, linked to the quotation (any open one —
 * one under negotiation included), the sales order and/or the project it is
 * for; it names the project, the contact and their number, the target start
 * and finish (the working days between them computed, never stored), the
 * scope of work in one box, the amount, and the people to send — project
 * manager, project engineer, project lead, project support.
 *
 * The route is the project manager named on the order, then the
 * salesperson's team leader. APPROVAL BUILDS THE PROJECT from the costing
 * behind the linked quotation's value revision, with the targets as its
 * dates and the PM as its manager — the same `createJobRecord` as POST /jobs,
 * so there is one way a project comes to be. An order already linked to a
 * project is approved and builds nothing; one whose quotation has no usable
 * costing is approved and says so, for the project to be built by hand once
 * it is costed.
 *
 * It carries no cost of its own: cost reaches its project through overtime,
 * PRs, stock issues and claims.
 */

export const jobOrderRoutes = Router();
jobOrderRoutes.use(authenticate);

const num = (v: Prisma.Decimal | null | undefined) => (v == null ? null : Number(v));

function asDate(value: string, label: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw badRequest(`${label} is not a valid date`);
  return dayKey(date);
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

const person = { select: { id: true, name: true, position: true } } as const;

const jobOrderInclude = {
  customer: { select: { id: true, code: true, name: true } },
  site: { select: { id: true, name: true, city: true } },
  contact: { select: { id: true, name: true, phone: true } },
  job: { select: { id: true, number: true, name: true, status: true } },
  quotation: { select: { id: true, number: true, subject: true, outcome: true } },
  salesOrder: { select: { id: true, number: true, status: true } },
  requestedBy: person,
  assignedTo: { select: { id: true, name: true } },
  projectManager: person,
  projectEngineer: person,
  projectLead: person,
  support: { select: { user: person } },
  visit: {
    select: {
      id: true,
      number: true,
      status: true,
      dueDate: true,
      report: { select: { id: true, number: true, status: true } },
    },
  },
  invoice: { select: { id: true, number: true, status: true } },
} satisfies Prisma.JobOrderInclude;

type JobOrderRow = Prisma.JobOrderGetPayload<{ include: typeof jobOrderInclude }>;

/** The target window: orders raised before the targets carry only the day they were wanted on. */
function targets(row: { targetStart: Date | null; targetFinish: Date | null; requestedFor: Date }) {
  const start = row.targetStart ?? row.requestedFor;
  const finish = row.targetFinish ?? row.targetStart ?? row.requestedFor;
  return { targetStart: start, targetFinish: finish, durationDays: workingDaysBetween(start, finish) };
}

function present(row: JobOrderRow) {
  const { support, ...rest } = row;
  return {
    ...rest,
    ...targets(row),
    amount: num(row.amount),
    billable: row.chargeBasis === 'CHARGEABLE',
    support: support.map((s) => s.user),
  };
}

/** Somebody with only view_own sees the orders they raised or are sent on. */
function onlyOwn(me: ResolvedUser): boolean {
  return !can(me, 'gops.job_orders.view_all');
}

function onIt(me: ResolvedUser, row: JobOrderRow): boolean {
  return (
    row.requestedById === me.id ||
    row.assignedToId === me.id ||
    row.projectManagerId === me.id ||
    row.projectEngineerId === me.id ||
    row.projectLeadId === me.id ||
    row.support.some((s) => s.user.id === me.id)
  );
}

function mayOpen(me: ResolvedUser, row: JobOrderRow): boolean {
  return !onlyOwn(me) || onIt(me, row);
}

/**
 * The order's route, one slot a step. A DRAFT or a RETURNED order shows the
 * route submitting it now WOULD take, every step open under who may sign it
 * — not `approvalSlots(…, draft)`, which previews only while no request
 * exists: a returned order keeps its last request, closed, and its signed
 * steps would date an approval nobody now gives. A CANCELLED order prints
 * only signatures that stand: all of them when it was cancelled after its
 * route approved it, and none when it was cancelled as a draft or while
 * returned — a step signed before the return approved a version nobody now
 * decides on, and an open step will never be signed. Every other order
 * shows its latest request, each step signed and dated or still open.
 */
async function routeSlots(row: JobOrderRow): Promise<ApprovalSlot[]> {
  if (row.status === 'DRAFT' || row.status === 'REJECTED') {
    const route = await routePreview('job_order', num(row.amount), row.requestedById, null, {
      jobId: row.jobId,
      projectManagerId: row.projectManagerId,
    });
    return route ? route.steps.map((st) => ({ step: st.name, assigned: st.approvers })) : [];
  }
  if (row.status === 'CANCELLED') {
    const latest = await prisma.approvalRequest.findFirst({
      where: { documentType: 'job_order', documentId: row.id },
      orderBy: { createdAt: 'desc' },
      select: { status: true },
    });
    if (latest?.status !== 'APPROVED') return [];
    return (await approvalSlots('job_order', row.id)).filter((s) => s.name);
  }
  return approvalSlots('job_order', row.id);
}

async function load(id: string): Promise<JobOrderRow> {
  const row = await prisma.jobOrder.findUnique({ where: { id }, include: jobOrderInclude });
  if (!row) throw notFound('Job order not found');
  return row;
}

const subjectOf = (row: { title: string; projectName: string | null; customer: { name: string } }) =>
  `${row.projectName ?? row.title} — ${row.customer.name}`;

/** Everyone the order sends, once each, never the person told the news already. */
function crewOf(row: JobOrderRow, except: string | null = null): string[] {
  const ids = [row.projectManagerId, row.projectEngineerId, row.projectLeadId, row.assignedToId, ...row.support.map((s) => s.user.id)];
  return [...new Set(ids.filter((id): id is string => !!id && id !== except))];
}

/** Which of a viewer's orders "mine" means: raised by them, or sending them. */
const mineWhere = (userId: string): Prisma.JobOrderWhereInput => ({
  OR: [
    { requestedById: userId },
    { assignedToId: userId },
    { projectManagerId: userId },
    { projectEngineerId: userId },
    { projectLeadId: userId },
    { support: { some: { userId } } },
  ],
});

// ── List ────────────────────────────────────────────────────────────────────

const JOB_ORDER_SORTS = ['number', 'requestedFor', 'createdAt'];

/** A status in the screen's words, through statusLabel: REJECTED reads "Returned" — the order goes back to whoever raised it. */
const statusWord = (status: string) => statusLabel(status === 'REJECTED' ? 'RETURNED' : status);

/**
 * Which job orders a list query means — one rule for the list and its
 * printed twin. A `view_own` holder sees what they raised or are sent on;
 * `?ids=` (the rows ticked) is ANDed with that.
 */
function jobOrderListWhere(me: ResolvedUser, q: ListQuery): Prisma.JobOrderWhereInput {
  const where: Prisma.JobOrderWhereInput = {};
  const and: Prisma.JobOrderWhereInput[] = [];

  if (onlyOwn(me) || q.scope === 'mine') and.push(mineWhere(me.id));
  const ids = idsFilter(q.filters.ids);
  if (ids) and.push({ id: { in: ids } });

  const status = choice(q.filters.status, JobOrderStatus, 'Status');
  if (status) where.status = status;
  if (q.filters.open === 'true') where.status = 'APPROVED';
  // The unbilled queue finance works from.
  if (q.filters.unbilled === 'true') {
    where.chargeBasis = 'CHARGEABLE';
    where.status = 'COMPLETED';
    where.invoice = { is: null };
  }
  for (const key of ['customerId', 'jobId', 'quotationId', 'salesOrderId', 'projectManagerId', 'assignedToId'] as const) {
    if (q.filters[key]) where[key] = q.filters[key];
  }
  // requestedFor mirrors the target start, so one index serves both shapes.
  if (q.filters.from || q.filters.to) {
    where.requestedFor = {};
    if (q.filters.from) where.requestedFor.gte = asDate(q.filters.from, 'From');
    if (q.filters.to) where.requestedFor.lte = asDate(q.filters.to, 'To');
  }
  if (q.search) {
    and.push({
      OR: [
        { number: { contains: q.search, mode: 'insensitive' } },
        { title: { contains: q.search, mode: 'insensitive' } },
        { projectName: { contains: q.search, mode: 'insensitive' } },
        { customer: { name: { contains: q.search, mode: 'insensitive' } } },
        { quotation: { number: { contains: q.search, mode: 'insensitive' } } },
      ],
    });
  }
  if (and.length) where.AND = and;
  return where;
}

jobOrderRoutes.get(
  '/',
  requireAny('gops.job_orders.view_all', 'gops.job_orders.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const where = jobOrderListWhere(me, q);

    const [rows, total] = await Promise.all([
      prisma.jobOrder.findMany({
        where,
        include: jobOrderInclude,
        orderBy: orderBy(q, JOB_ORDER_SORTS, { requestedFor: 'asc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.jobOrder.count({ where }),
    ]);

    res.json(listResult(rows.map(present), total, q));
  }),
);

/**
 * The job orders list on paper (rule 6, A5): the list's own query and sort —
 * or the rows ticked — on landscape pages; the targets as short dates with
 * the working days between them, the amount before VAT with the code in the
 * head, and the whole set's total in the totals block. A cancelled order's
 * amount prints in brackets and is not counted, and the note under the
 * totals says how many were left out. Declared above `/:id`.
 */
jobOrderRoutes.get(
  '/pdf',
  requireAny('gops.job_orders.view_all', 'gops.job_orders.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const where = jobOrderListWhere(me, q);
    const f = q.filters;
    const [rows, count, live, cancelled, currency, named, assignee, quotation, salesOrder] = await Promise.all([
      prisma.jobOrder.findMany({ where, include: jobOrderInclude, orderBy: orderBy(q, JOB_ORDER_SORTS, { requestedFor: 'asc' }), take: LIST_CAP }),
      prisma.jobOrder.count({ where }),
      prisma.jobOrder.aggregate({ where: { AND: [where, { status: { not: 'CANCELLED' } }] }, _sum: { amount: true } }),
      prisma.jobOrder.count({ where: { AND: [where, { status: 'CANCELLED' }] } }),
      companyCurrency(),
      namedInFilter({ customerId: f.customerId, jobId: f.jobId, userId: f.projectManagerId }),
      f.assignedToId ? prisma.user.findUnique({ where: { id: f.assignedToId }, select: { name: true } }) : null,
      f.quotationId ? prisma.quotation.findUnique({ where: { id: f.quotationId }, select: { number: true } }) : null,
      f.salesOrderId ? prisma.salesOrder.findUnique({ where: { id: f.salesOrderId }, select: { number: true } }) : null,
    ]);
    const reference = listReference(count, rows.length, ['job order', 'job orders'], [
      q.search ? `search "${q.search}"` : null,
      f.status && f.open !== 'true' && f.unbilled !== 'true' ? `status ${statusWord(f.status)}` : null,
      f.open === 'true' ? 'open (approved)' : null,
      f.unbilled === 'true' ? 'completed, chargeable, not yet invoiced' : null,
      named.customer ? `customer ${named.customer}` : null,
      named.project ? `project ${named.project}` : null,
      f.quotationId ? `quotation ${quotation?.number ?? 'not found'}` : null,
      f.salesOrderId ? `sales order ${salesOrder?.number ?? 'not found'}` : null,
      named.person ? `project manager ${named.person}` : null,
      f.assignedToId ? `assigned to ${assignee?.name ?? 'not found'}` : null,
      f.from || f.to ? `target start ${listDay(f.from)} to ${listDay(f.to)}` : null,
      q.scope === 'mine' ? 'raised by me or sending me' : null,
      f.ids ? 'the rows selected' : null,
    ]);

    const pdf = await renderDocument({
      title: 'Job Orders',
      date: new Date(),
      reference,
      landscape: true,
      sections: [
        {
          kind: 'table',
          head: ['Number', 'Project', 'Customer', 'Target', `Amount (${currency})`, 'Project manager', 'Links', 'Status'],
          align: ['left', 'left', 'left', 'left', 'right', 'left', 'left', 'left'],
          rows: rows.map((r) => {
            const t = targets(r);
            const amount = r.amount == null ? '' : formatAmount(Number(r.amount));
            return [
              r.number,
              { title: r.projectName ?? r.title, body: r.projectName && r.projectName !== r.title ? r.title : undefined },
              { title: r.customer.name, body: r.site?.name ?? r.contact?.name ?? undefined },
              // Dates are never bold: the window, then the working days in it.
              `${formatShortDate(t.targetStart)} – ${formatShortDate(t.targetFinish)}\n${t.durationDays} working day${t.durationDays === 1 ? '' : 's'}`,
              amount && bracketed(amount, r.status !== 'CANCELLED'),
              { title: r.projectManager?.name ?? 'None named', body: `Raised by ${r.requestedBy.name}` },
              [r.quotation?.number, r.salesOrder?.number, r.job?.number].filter(Boolean).join('\n'),
              statusWord(r.status),
            ];
          }),
        },
        {
          kind: 'totals',
          rows: [
            {
              label: totalLabel('Total before VAT', count, rows.length),
              value: formatMoney(Number(live._sum.amount ?? 0), currency),
              bold: true,
            },
          ],
        },
        ...listNotes([bracketNote(cancelled, ['cancelled job order', 'cancelled job orders'])]),
      ],
    });

    await audit(
      { entityType: 'job_order', entityId: 'list', action: 'EXPORTED', summary: `Exported the job orders list as PDF (${listReference(count, rows.length, ['job order', 'job orders'], [])})` },
      req,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="job-orders.pdf"');
    res.send(pdf);
  }),
);

// ── Lookups for the form (above /:id — route order) ─────────────────────────

/** The net of a quotation revision: the lines before discount, less the discount — what the customer agreed to, before VAT. */
const netOf = (r: { subtotal: Prisma.Decimal; discountAmount: Prisma.Decimal }) => Number(r.subtotal.sub(r.discountAmount));

/**
 * The pickers the form needs, behind the form's own permission: the customer
 * names, then — for one customer — its sites, contacts, quotations (any but a
 * lost one, with what linking one would fill in), live sales orders and
 * projects. Names, numbers and the agreed amounts only.
 */
jobOrderRoutes.get(
  '/options',
  requireAny('gops.job_orders.create', 'gops.job_orders.edit_own', 'gops.job_orders.edit_all'),
  handler(async (req, res) => {
    const customerId = typeof req.query.customerId === 'string' ? req.query.customerId : '';
    if (!customerId) {
      const customers = await prisma.customer.findMany({
        where: { isActive: true },
        select: { id: true, code: true, name: true },
        orderBy: { name: 'asc' },
        take: 1000,
      });
      res.json({ customers });
      return;
    }
    const [sites, contacts, quotations, salesOrders, jobs] = await Promise.all([
      prisma.customerSite.findMany({
        where: { customerId },
        select: { id: true, name: true, city: true },
        orderBy: { name: 'asc' },
      }),
      prisma.customerContact.findMany({
        where: { customerId },
        select: { id: true, name: true, phone: true },
        orderBy: { name: 'asc' },
      }),
      prisma.quotation.findMany({
        where: { customerId, outcome: { not: 'LOST' } },
        select: {
          id: true,
          number: true,
          subject: true,
          outcome: true,
          contactId: true,
          siteId: true,
          revisions: { select: { status: true, revision: true, subtotal: true, discountAmount: true, costingId: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      prisma.salesOrder.findMany({
        where: { customerId, status: { not: 'CANCELLED' } },
        select: { id: true, number: true, status: true, quotationId: true, contactId: true, poNumber: true, subtotal: true, discountAmount: true },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      prisma.job.findMany({
        where: { customerId, status: { not: 'CANCELLED' } },
        select: { id: true, number: true, name: true, type: true, status: true, projectManagerId: true },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    ]);
    res.json({
      sites,
      contacts,
      quotations: quotations.map((q) => {
        const rev = valueRevision(q.revisions);
        return {
          id: q.id,
          number: q.number,
          subject: q.subject,
          outcome: q.outcome,
          contactId: q.contactId,
          siteId: q.siteId,
          amount: rev ? netOf(rev) : null,
          /** Whether approval could build the project from it. */
          costed: !!rev?.costingId,
        };
      }),
      salesOrders: salesOrders.map((o) => ({
        id: o.id,
        number: o.number,
        status: o.status,
        quotationId: o.quotationId,
        contactId: o.contactId,
        poNumber: o.poNumber,
        amount: netOf(o),
      })),
      jobs,
    });
  }),
);

// ── Create and edit ─────────────────────────────────────────────────────────

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const jobOrderSchema = z.object({
  customerId: z.string().min(1, 'Which customer?'),
  siteId: z.string().optional().nullable(),
  contactId: z.string().optional().nullable(),
  quotationId: z.string().optional().nullable(),
  salesOrderId: z.string().optional().nullable(),
  jobId: z.string().optional().nullable(),
  projectName: z.string().trim().min(2, 'Name the project').max(300),
  contactNumber: z.string().trim().max(60).optional().nullable(),
  title: z.string().trim().min(3, 'Say in a line what the job is').max(300),
  scope: z.string().trim().min(5, 'Describe the scope of work').max(20000),
  targetStart: z.string().regex(DAY, 'Use a date'),
  targetFinish: z.string().regex(DAY, 'Use a date'),
  projectManagerId: z.string().optional().nullable(),
  projectEngineerId: z.string().optional().nullable(),
  projectLeadId: z.string().optional().nullable(),
  supportIds: z.array(z.string()).max(50).optional(),
  customerPoNumber: z.string().trim().max(120).optional().nullable(),
  amount: z.number().min(0).optional().nullable(),
  notes: z.string().optional().nullable(),
});

/** The target window as DATEs, the finish no earlier than the start. */
function window(startText: string, finishText: string) {
  const targetStart = asDate(startText, 'Target start');
  const targetFinish = asDate(finishText, 'Target finish');
  if (targetFinish < targetStart) throw badRequest('The target finish is before the target start');
  return { targetStart, targetFinish };
}

/** Checks that everything a body names belongs to the order's customer, and that the people exist. */
async function checkBelongs(
  customerId: string,
  body: {
    siteId?: string | null;
    contactId?: string | null;
    quotationId?: string | null;
    salesOrderId?: string | null;
    jobId?: string | null;
    projectManagerId?: string | null;
    projectEngineerId?: string | null;
    projectLeadId?: string | null;
    supportIds?: string[];
  },
) {
  const [site, contact, quotation, salesOrder, job] = await Promise.all([
    body.siteId ? prisma.customerSite.findUnique({ where: { id: body.siteId }, select: { customerId: true } }) : null,
    body.contactId ? prisma.customerContact.findUnique({ where: { id: body.contactId }, select: { customerId: true } }) : null,
    body.quotationId ? prisma.quotation.findUnique({ where: { id: body.quotationId }, select: { customerId: true, outcome: true } }) : null,
    body.salesOrderId
      ? prisma.salesOrder.findUnique({ where: { id: body.salesOrderId }, select: { customerId: true, quotationId: true, status: true } })
      : null,
    body.jobId ? prisma.job.findUnique({ where: { id: body.jobId }, select: { customerId: true } }) : null,
  ]);
  if (body.siteId && site?.customerId !== customerId) throw badRequest('That site is not this customer’s');
  if (body.contactId && contact?.customerId !== customerId) throw badRequest('That contact is not at this customer');
  if (body.quotationId && quotation?.customerId !== customerId) throw badRequest('That quotation is for another customer');
  if (quotation?.outcome === 'LOST') throw badRequest('That quotation was lost — a job order books work that is still on');
  if (body.salesOrderId && salesOrder?.customerId !== customerId) throw badRequest('That sales order is for another customer');
  if (salesOrder?.status === 'CANCELLED') throw badRequest('That sales order was cancelled');
  if (body.quotationId && salesOrder && salesOrder.quotationId !== body.quotationId) {
    throw badRequest('That sales order books a different quotation');
  }
  if (body.jobId && job?.customerId !== customerId) throw badRequest('That project is for another customer');

  const peopleIds = [
    ...new Set([body.projectManagerId, body.projectEngineerId, body.projectLeadId, ...(body.supportIds ?? [])].filter((id): id is string => !!id)),
  ];
  if (peopleIds.length) {
    const found = await prisma.user.count({ where: { id: { in: peopleIds }, isActive: true } });
    if (found !== peopleIds.length) throw badRequest('Somebody named to send is not an active login');
  }
}

/**
 * The agreed amount when nobody typed one: the sales order's net, else the
 * quotation's value revision's net (approved, else latest) — before VAT,
 * because the invoice adds it, and after the quote-level discount, because
 * that is the price the customer agreed to.
 */
async function agreedAmount(body: { salesOrderId?: string | null; quotationId?: string | null }): Promise<number | null> {
  if (body.salesOrderId) {
    const o = await prisma.salesOrder.findUnique({ where: { id: body.salesOrderId }, select: { subtotal: true, discountAmount: true } });
    if (o) return netOf(o);
  }
  if (body.quotationId) {
    const revisions = await prisma.quotationRevision.findMany({
      where: { quotationId: body.quotationId },
      select: { status: true, revision: true, subtotal: true, discountAmount: true },
    });
    const rev = valueRevision(revisions);
    if (rev) return netOf(rev);
  }
  return null;
}

jobOrderRoutes.post(
  '/',
  require_('gops.job_orders.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(jobOrderSchema, req.body);
    await checkBelongs(body.customerId, body);
    const { targetStart, targetFinish } = window(body.targetStart, body.targetFinish);
    const amount = body.amount ?? (await agreedAmount(body));

    const row = await prisma.$transaction(async (tx) => {
      const number = await nextNumber('job_order', tx);
      return tx.jobOrder.create({
        data: {
          number,
          customerId: body.customerId,
          siteId: body.siteId || null,
          contactId: body.contactId || null,
          quotationId: body.quotationId || null,
          salesOrderId: body.salesOrderId || null,
          jobId: body.jobId || null,
          projectName: body.projectName,
          contactNumber: body.contactNumber?.trim() || null,
          title: body.title,
          description: body.scope,
          scope: body.scope,
          targetStart,
          targetFinish,
          requestedFor: targetStart,
          chargeBasis: 'CHARGEABLE',
          customerPoNumber: body.customerPoNumber || null,
          amount: amount == null ? null : new Prisma.Decimal(amount),
          requestedById: me.id,
          projectManagerId: body.projectManagerId || null,
          projectEngineerId: body.projectEngineerId || null,
          projectLeadId: body.projectLeadId || null,
          support: { create: [...new Set(body.supportIds ?? [])].map((userId) => ({ userId })) },
          notes: body.notes || null,
        },
        include: jobOrderInclude,
      });
    });

    await audit(
      { entityType: 'job_order', entityId: row.id, action: 'CREATED', summary: `${row.number} — ${subjectOf(row)}` },
      req,
    );
    res.status(201).json(present(row));
  }),
);

jobOrderRoutes.get(
  '/:id',
  requireAny('gops.job_orders.view_all', 'gops.job_orders.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await load(req.params.id);
    if (!mayOpen(me, row)) throw forbidden('That is someone else’s job order');
    const owner = canEditRecord(me, 'gops', 'job_orders', row.requestedById);
    // Who would decide it, so the page can say where Submit sends it.
    const route = row.status === 'DRAFT' || row.status === 'REJECTED' ? await routeSlots(row) : [];
    res.json({
      ...present(row),
      canEdit: owner && (row.status === 'DRAFT' || row.status === 'REJECTED'),
      canCancel: owner && ['DRAFT', 'REJECTED', 'APPROVED'].includes(row.status),
      canAcknowledge: (owner || onIt(me, row)) && row.status !== 'DRAFT' && row.status !== 'CANCELLED',
      route: route.map((s) => ({ step: s.step, names: (s.assigned ?? []).map((p) => p.name) })),
    });
  }),
);

/**
 * Editing, while nobody has decided on it. A returned order is corrected and
 * resubmitted — the approval history keeps both attempts, and the printed
 * sign-offs read the latest.
 */
jobOrderRoutes.patch(
  '/:id',
  requireAny('gops.job_orders.edit_own', 'gops.job_orders.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(jobOrderSchema.omit({ customerId: true }).partial(), req.body);
    const existing = await load(req.params.id);
    if (!canEditRecord(me, 'gops', 'job_orders', existing.requestedById)) {
      throw forbidden('Only whoever raised this job order can change it');
    }
    if (existing.status !== 'DRAFT' && existing.status !== 'REJECTED') {
      throw badRequest('This job order has gone for approval. Its content is what was decided on.');
    }
    await checkBelongs(existing.customerId, {
      ...body,
      // A sales order must book the quotation the order keeps, when the body changes only one of them.
      quotationId: body.quotationId !== undefined ? body.quotationId : existing.quotationId,
      salesOrderId: body.salesOrderId !== undefined ? body.salesOrderId : existing.salesOrderId,
    });
    const current = targets(existing);
    const dates = window(body.targetStart ?? isoDay(current.targetStart), body.targetFinish ?? isoDay(current.targetFinish));

    const updated = await prisma.$transaction(async (tx) => {
      if (body.supportIds !== undefined) {
        await tx.jobOrderSupport.deleteMany({ where: { jobOrderId: existing.id } });
      }
      return tx.jobOrder.update({
        where: { id: existing.id },
        data: {
          ...(body.siteId !== undefined ? { siteId: body.siteId || null } : {}),
          ...(body.contactId !== undefined ? { contactId: body.contactId || null } : {}),
          ...(body.quotationId !== undefined ? { quotationId: body.quotationId || null } : {}),
          ...(body.salesOrderId !== undefined ? { salesOrderId: body.salesOrderId || null } : {}),
          ...(body.jobId !== undefined ? { jobId: body.jobId || null } : {}),
          ...(body.projectName ? { projectName: body.projectName } : {}),
          ...(body.contactNumber !== undefined ? { contactNumber: body.contactNumber?.trim() || null } : {}),
          ...(body.title ? { title: body.title } : {}),
          ...(body.scope ? { scope: body.scope, description: body.scope } : {}),
          targetStart: dates.targetStart,
          targetFinish: dates.targetFinish,
          requestedFor: dates.targetStart,
          ...(body.projectManagerId !== undefined ? { projectManagerId: body.projectManagerId || null } : {}),
          ...(body.projectEngineerId !== undefined ? { projectEngineerId: body.projectEngineerId || null } : {}),
          ...(body.projectLeadId !== undefined ? { projectLeadId: body.projectLeadId || null } : {}),
          ...(body.supportIds !== undefined
            ? { support: { create: [...new Set(body.supportIds)].map((userId) => ({ userId })) } }
            : {}),
          ...(body.customerPoNumber !== undefined ? { customerPoNumber: body.customerPoNumber || null } : {}),
          ...(body.amount !== undefined ? { amount: body.amount == null ? null : new Prisma.Decimal(body.amount) } : {}),
          ...(body.notes !== undefined ? { notes: body.notes || null } : {}),
        },
        include: jobOrderInclude,
      });
    });

    await audit(
      {
        entityType: 'job_order',
        entityId: updated.id,
        action: 'UPDATED',
        summary: `${updated.number} updated`,
        before: present(existing),
        after: present(updated),
      },
      req,
    );
    res.json(present(updated));
  }),
);

// ── The lifecycle ───────────────────────────────────────────────────────────

/**
 * Submitting: to the project manager named on the order, then the
 * salesperson's team leader. Not gated on a price — the amount is the
 * quotation's unless somebody typed one, and the invoice step is where one
 * becomes compulsory.
 */
jobOrderRoutes.post(
  '/:id/submit',
  requireAny('gops.job_orders.create', 'gops.job_orders.edit_own', 'gops.job_orders.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await load(req.params.id);
    if (!canEditRecord(me, 'gops', 'job_orders', row.requestedById)) {
      throw forbidden('Only whoever raised this job order can submit it');
    }
    if (row.status !== 'DRAFT' && row.status !== 'REJECTED') {
      throw badRequest('Only a draft or a returned job order can be submitted');
    }

    // Claimed on the order exactly as read — still a draft or returned, and
    // not modified since (`updatedAt`, which every write to an order moves).
    // The request snapshots this read's amount, subject and project manager,
    // so a Modify that lands between the read and the claim refuses the
    // submit rather than sending stale facts to the approver.
    const before = row.status;
    const claimed = await prisma.jobOrder.updateMany({
      where: { id: row.id, status: before, updatedAt: row.updatedAt },
      data: { status: 'PENDING_APPROVAL' },
    });
    if (!claimed.count) throw badRequest('It changed a moment ago — reload to see where it stands');
    try {
      // Filed in the name of whoever RAISED the order, whoever presses the
      // button: the route (the team leader is the requester's supervisor) is
      // the one the page and the draft PDF named, and the self-approval rule
      // keeps the author — not the presser — off their own order.
      await submitForApproval({
        documentType: 'job_order',
        documentId: row.id,
        documentNumber: row.number,
        subject: subjectOf(row),
        amount: num(row.amount),
        link: `/g-ops/job-orders/${row.id}`,
        requesterId: row.requestedById,
        jobId: row.jobId,
        projectManagerId: row.projectManagerId,
      });
    } catch (err) {
      // No workflow, or a workflow that routes only to the requester: put the
      // document back where it was, so it is not stranded as "pending" with
      // no request behind it.
      await prisma.jobOrder.update({ where: { id: row.id }, data: { status: before } });
      throw err;
    }

    await audit(
      { entityType: 'job_order', entityId: row.id, action: 'SUBMITTED', summary: `${row.number} submitted` },
      req,
    );
    res.json({ ok: true });
  }),
);

/**
 * Cancelling. A pending order is withdrawn by its approver returning it. A
 * completed order is a record of what happened; a project already built from
 * an approved one stays — a project is cancelled from its own page.
 */
jobOrderRoutes.post(
  '/:id/cancel',
  requireAny('gops.job_orders.create', 'gops.job_orders.edit_own', 'gops.job_orders.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(z.object({ reason: z.string().trim().min(3, 'Say why it is cancelled') }), req.body);
    const row = await load(req.params.id);
    if (!canEditRecord(me, 'gops', 'job_orders', row.requestedById)) {
      throw forbidden('Only whoever raised this job order can cancel it');
    }
    if (row.status === 'COMPLETED') {
      throw badRequest('This job order was completed; its record is what happened.');
    }
    if (row.status === 'PENDING_APPROVAL') {
      throw badRequest('It is with the approver. Ask them to return it, then cancel it.');
    }
    if (row.status === 'CANCELLED') throw badRequest('This job order is already cancelled');

    await prisma.$transaction(async (tx) => {
      // An order raised as a service call before 2026-10-09 may still carry a visit.
      if (row.visit && row.visit.status === 'SCHEDULED') {
        await tx.serviceVisit.update({ where: { id: row.visit.id }, data: { status: 'CANCELLED' } });
      }
      await tx.jobOrder.update({
        where: { id: row.id },
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: body.reason },
      });
    });

    if (row.status === 'APPROVED') {
      for (const userId of crewOf(row, me.id)) {
        await notify({
          userId,
          type: 'pm.due',
          title: 'Job order cancelled',
          body: `${row.number} — ${subjectOf(row)}: ${body.reason}`,
          link: `/g-ops/job-orders/${row.id}`,
        });
      }
    }
    await audit(
      {
        entityType: 'job_order',
        entityId: row.id,
        action: 'CANCELLED',
        summary: `${row.number} cancelled — ${body.reason}${row.job ? ` (project ${row.job.number} stays)` : ''}`,
      },
      req,
    );
    res.json({ ok: true });
  }),
);

/** The customer's signature slot on the printed order. */
jobOrderRoutes.patch(
  '/:id/acknowledge',
  requireAny('gops.job_orders.view_all', 'gops.job_orders.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(
      z.object({ customerAcknowledgedBy: z.string().trim().min(2, 'Who signed for it?') }),
      req.body,
    );
    const row = await load(req.params.id);
    const owner = canEditRecord(me, 'gops', 'job_orders', row.requestedById);
    if (!owner && !onIt(me, row)) {
      throw forbidden('Only whoever raised the order or somebody sent on it can record this');
    }
    if (row.status === 'DRAFT' || row.status === 'CANCELLED') {
      throw badRequest('A draft or cancelled order has nothing for the customer to acknowledge');
    }
    const updated = await prisma.jobOrder.update({
      where: { id: row.id },
      data: { customerAcknowledgedBy: body.customerAcknowledgedBy, customerAcknowledgedAt: new Date() },
      include: jobOrderInclude,
    });
    await audit(
      {
        entityType: 'job_order',
        entityId: row.id,
        action: 'UPDATED',
        summary: `${row.number} acknowledged by ${body.customerAcknowledgedBy}`,
      },
      req,
    );
    res.json(present(updated));
  }),
);

jobOrderRoutes.get(
  '/:id/pdf',
  requireAny('gops.job_orders.view_all', 'gops.job_orders.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await load(req.params.id);
    if (!mayOpen(me, row)) throw forbidden('That is someone else’s job order');
    const t = targets(row);
    const nameOf = (p: { name: string; position: string | null } | null) => (p ? [p.name, p.position].filter(Boolean).join(' · ') : '—');
    const currency = await companyCurrency();
    // The requester's contact lines, for the paper only (the JSON never carries a mobile).
    const requester = await prisma.user.findUnique({
      where: { id: row.requestedById },
      select: { email: true, phone: true, employee: { select: { mobile: true } } },
    });

    const sections: PdfSection[] = [
      {
        kind: 'fields',
        title: 'Project',
        columns: 2,
        fields: [
          { label: 'Project name', value: row.projectName ?? row.title },
          { label: 'Customer', value: row.customer.name },
          { label: 'Site', value: row.site ? [row.site.name, row.site.city].filter(Boolean).join(', ') : '—' },
          { label: 'Contact', value: row.contact?.name ?? '—' },
          { label: 'Contact number', value: row.contactNumber ?? row.contact?.phone ?? '—' },
          { label: 'Requested by', value: row.requestedBy.name },
          { label: 'Target start', value: formatDate(t.targetStart) },
          { label: 'Target finish', value: formatDate(t.targetFinish) },
          { label: 'Duration', value: `${t.durationDays} working day${t.durationDays === 1 ? '' : 's'}` },
        ],
      },
      {
        kind: 'fields',
        title: 'Links and amount',
        columns: 2,
        fields: [
          { label: 'Quotation', value: row.quotation ? `${row.quotation.number} — ${row.quotation.subject}` : '—' },
          { label: 'Sales order', value: row.salesOrder?.number ?? '—' },
          { label: 'Project', value: row.job ? `${row.job.number} — ${row.job.name}` : '—' },
          { label: 'Customer PO', value: row.customerPoNumber ?? '—' },
          { label: 'Amount (before VAT)', value: row.amount != null ? formatMoney(Number(row.amount), currency) : 'To be billed on completion' },
        ],
      },
      { kind: 'text', title: 'Scope of work', body: row.scope ?? row.description },
      {
        kind: 'fields',
        title: 'Personnel to send',
        columns: 2,
        fields: [
          { label: 'Project manager', value: nameOf(row.projectManager) },
          { label: 'Project engineer', value: nameOf(row.projectEngineer) },
          { label: 'Project lead', value: nameOf(row.projectLead) },
          { label: 'Project support', value: row.support.length ? row.support.map((s) => s.user.name).join(', ') : '—' },
        ],
      },
    ];
    if (row.status === 'CANCELLED' && row.cancelReason) {
      sections.push({ kind: 'text', title: 'Cancelled', body: row.cancelReason });
    }

    // Requested by, then the route as the workflow names its steps — the
    // project manager, the team leader — who signed and when, else who is
    // assigned with "Pending" under them (a draft or a returned order prints
    // the route submitting it would take), then the customer's slot last.
    // A cancelled order prints only the signatures that stand (routeSlots)
    // and no slot left "Pending" for ever.
    const route = await routeSlots(row);
    const cancelled = row.status === 'CANCELLED';
    const signatories: Signatory[] = [
      {
        role: 'Requested by',
        name: row.requestedBy.name,
        phone: requester ? contactPhone(requester) : undefined,
        email: requester?.email,
        at: row.createdAt,
      },
      ...(route.length ? slotSignatories(route) : cancelled ? [] : [{ role: 'Approved by' }]),
      ...(row.customerAcknowledgedBy || !cancelled
        ? [{ role: 'Acknowledged by (customer)', name: row.customerAcknowledgedBy ?? undefined, at: row.customerAcknowledgedAt }]
        : []),
    ];
    const pdf = await renderDocument({
      title: 'Job Order',
      documentNumber: row.number,
      date: row.createdAt,
      reference: `${row.projectName ?? row.title} — ${row.customer.name}`,
      sections,
      signatories,
    });

    await audit({ entityType: 'job_order', entityId: row.id, action: 'EXPORTED', summary: `Printed ${row.number}` }, req);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${row.number}.pdf"`);
    res.send(pdf);
  }),
);

// ── Approval ────────────────────────────────────────────────────────────────

/**
 * The route's last signature BUILDS THE PROJECT (2026-10-09, the owner's
 * call): from the costing behind the linked quotation's value revision, named
 * as the order names it, running from the target start to the target finish,
 * with the order's project manager — through `createJobRecord`, the one way
 * a project comes to be. The order's own status is claimed first with a
 * conditional update, so a settle that arrives twice builds nothing twice.
 *
 * An order already linked to a project is approved and builds nothing. One
 * whose quotation has no costing, or a costing that cannot yet carry a
 * project (with the approver, no scope, a scope that does not add up), is
 * still approved — the decision stands — and says why in its trail and to
 * whoever raised it, for the project to be built by hand once the costing
 * is ready.
 */
export async function settleJobOrder(
  approval: { documentId: string },
  outcome: ApprovalOutcome,
): Promise<void> {
  const jo = await prisma.jobOrder.findUnique({ where: { id: approval.documentId }, include: jobOrderInclude });
  if (!jo || jo.status !== 'PENDING_APPROVAL') return;

  if (outcome === 'REJECTED') {
    await prisma.jobOrder.update({ where: { id: jo.id }, data: { status: 'REJECTED' } });
    await audit({ entityType: 'job_order', entityId: jo.id, action: 'REJECTED', summary: `${jo.number} returned — no project was built` });
    return;
  }

  const claimed = await prisma.jobOrder.updateMany({
    where: { id: jo.id, status: 'PENDING_APPROVAL' },
    data: { status: 'APPROVED', approvedAt: new Date() },
  });
  if (claimed.count === 0) return;

  let built: { id: string; number: string; name: string } | null = null;
  let notBuilt: string | null = null;
  if (jo.jobId) {
    notBuilt = null;
  } else if (!jo.quotationId) {
    notBuilt = 'no quotation is linked, so there is no costing to build the project from';
  } else {
    try {
      const revisions = await prisma.quotationRevision.findMany({
        where: { quotationId: jo.quotationId },
        select: { id: true, status: true, revision: true, costingId: true },
      });
      const rev = valueRevision(revisions);
      if (!rev?.costingId) throw badRequest(`${jo.quotation?.number ?? 'the quotation'} has no costing behind it`);
      const costing = await costingForJob(rev.costingId, jo.customerId);
      const t = targets(jo);
      built = await prisma.$transaction(async (tx) => {
        const job = await createJobRecord(tx, costing, {
          name: jo.projectName ?? jo.title,
          type: 'PROJECT',
          customerId: jo.customerId,
          siteId: jo.siteId,
          contactId: jo.contactId,
          projectManagerId: jo.projectManagerId,
          // A project built on a quotation still under negotiation keeps the
          // link for later: only an APPROVED revision may stand behind a job.
          quotationRevisionId: rev.status === 'APPROVED' ? rev.id : null,
          customerPoNumber: jo.customerPoNumber,
          startDate: t.targetStart,
          targetEndDate: t.targetFinish,
          notes: `Built from job order ${jo.number}`,
          createdById: jo.requestedById,
        });
        await tx.jobOrder.update({ where: { id: jo.id }, data: { jobId: job.id } });
        return { id: job.id, number: job.number, name: job.name };
      });
    } catch (err) {
      notBuilt = err instanceof Error ? err.message : String(err);
    }
  }

  if (built) {
    await audit({
      entityType: 'job',
      entityId: built.id,
      action: 'CONVERTED',
      summary: `Created ${built.number} — ${built.name} from job order ${jo.number}`,
    });
  }
  await audit({
    entityType: 'job_order',
    entityId: jo.id,
    action: 'EXECUTED',
    summary: built
      ? `${jo.number} approved — project ${built.number} built, ${isoDay(targets(jo).targetStart)} to ${isoDay(targets(jo).targetFinish)}`
      : jo.job
        ? `${jo.number} approved for project ${jo.job.number}`
        : `${jo.number} approved — no project built: ${notBuilt}`,
  });

  // The requester hears from the engine; the people sent, and the requester
  // when the project could not be built, hear from here.
  const link = built ? `/g-ops/projects/${built.id}` : `/g-ops/job-orders/${jo.id}`;
  for (const userId of crewOf(jo)) {
    await notify({
      userId,
      type: 'pm.due',
      title: `Job order ${jo.number} approved${built ? ` — project ${built.number}` : ''}`,
      body: `${subjectOf(jo)}, ${isoDay(targets(jo).targetStart)} to ${isoDay(targets(jo).targetFinish)}`,
      link,
    });
  }
  if (!built && !jo.job) {
    await notify({
      userId: jo.requestedById,
      type: 'pm.due',
      title: `${jo.number} approved, but no project was built`,
      body: `${notBuilt}. Build it from the quotation once it is costed.`,
      link: `/g-ops/job-orders/${jo.id}`,
    });
  }
}

onApprovalSettled('job_order', settleJobOrder);

// ── Ctrl+K ──────────────────────────────────────────────────────────────────

registerSearch({
  kind: 'job_order',
  label: 'Job orders',
  permission: ['gops.job_orders.view_all', 'gops.job_orders.view_own'],
  ownWhere: (user) => mineWhere(user.id),
  search: async (term, _user, limit, own) => {
    const rows = await prisma.jobOrder.findMany({
      where: {
        AND: [
          own ?? {},
          {
            OR: [
              { number: { contains: term, mode: 'insensitive' } },
              { title: { contains: term, mode: 'insensitive' } },
              { projectName: { contains: term, mode: 'insensitive' } },
              { customer: { name: { contains: term, mode: 'insensitive' } } },
            ],
          },
        ],
      },
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: { id: true, number: true, title: true, projectName: true, status: true, customer: { select: { name: true } } },
    });
    return rows.map((r) => ({
      kind: 'job_order',
      id: r.id,
      title: `${r.number} — ${r.projectName ?? r.title}`,
      subtitle: `${r.customer.name} · ${r.status.toLowerCase().replace(/_/g, ' ')}`,
      link: `/g-ops/job-orders/${r.id}`,
    }));
  },
});
