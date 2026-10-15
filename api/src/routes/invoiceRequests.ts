import { Router } from 'express';
import { z } from 'zod';
import { Prisma, InvoiceRequestStatus, type ApprovalRequest } from '@prisma/client';
import { prisma } from '../prisma';
import { handler, parseBody, listQuery, listResult, orderBy, idsFilter, notFound, badRequest, forbidden, deleteOrRefuse } from '../http/kit';
import { authenticate, require_, requireAny, requireAnyOrDecider, currentUser } from '../auth/middleware';
import { can, canEditRecord, type ResolvedUser } from '../permissions/resolve';
import { audit } from '../shared/audit';
import { nextNumber } from '../shared/numbering';
import { notify } from '../shared/notifications';
import {
  approvalSlots,
  cancelOpenRequest,
  contactOf,
  mayDecide,
  onApprovalSettled,
  openSteps,
  preparedAt,
  routeBrief,
  slotSignatories,
  submitForApproval,
  type ApprovalOutcome,
} from '../shared/approvals';
import { registerAttachmentGuard, deleteAttachmentsOf } from '../shared/attachments';
import { attachedFiles, withAttachments } from '../shared/pdfAttachments';
import { registerSearch } from '../shared/search';
import {
  renderDocument,
  formatAmount,
  formatDate,
  formatMoney,
  formatShortDate,
  statusLabel,
  companyCurrency,
  type PdfSection,
  type Signatory,
} from '../shared/pdf';
import { LIST_CAP, listReference, recordNamed, choice, sendListPdf, rangeNamed, filterDay } from '../shared/listPaper';
import { contentDisposition, paperFileName } from '../shared/paperName';
import { cents, num } from '../shared/finance';
import { financeSettings } from '../shared/finance';
import { dayKey, manilaDayStart, manilaDayEnd } from '../shared/day';
import { expectedCollection, invoiceCredit, termsLabel } from '../shared/receivables';
import { quotationTeamOf } from '../shared/team';
import { usersHolding } from '../shared/clearance';
import { assertOrderLeft, billingForInvoiceInclude, createInvoiceFromBilling, orderInvoiced, orderNet } from '../shared/billingInvoice';

/**
 * INVOICE REQUESTS (2026-10-15, the owner's call: "the Sales or Team Leader
 * holding the project can raise an invoice request from the Progress billing,
 * to be processed by Back Support; it routes on the sales order, and once
 * approved it goes to Accounts Receivable").
 *
 * Raised from an APPROVED progress billing (its own Technical Manager › Team
 * Leader route stands), naming the project's ISSUED sales order: the order
 * lends its customer PO and terms, and the billing's gross must fit what is
 * left of the order's net (the invoice's own rule, `assertOrderLeft`). It goes
 * through the one engine as `invoice_request` (rule 2) — "Invoice request —
 * back support", the Back Support on the requester's team — and its approval
 * raises the DRAFT invoice in A/R through `createInvoiceFromBilling`, the same
 * code finance's direct door runs, so a billing is invoiced one way. The money
 * is the billing's, never re-keyed.
 */

export const invoiceRequestRoutes = Router();
invoiceRequestRoutes.use(authenticate);

const DOC = 'invoice_request';
const VIEW = ['gfin.invoice_requests.view_all', 'gfin.invoice_requests.view_own'];
export const INVOICE_REQUEST_LINK = (id: string) => `/g-fin/invoice-requests/${id}`;
const LIVE: InvoiceRequestStatus[] = ['DRAFT', 'PENDING_APPROVAL'];

const userSelect = { select: { id: true, name: true, email: true, position: true } } as const;

const requestInclude = {
  progressBilling: {
    include: {
      lines: { include: { scopeItem: { select: { name: true, sortOrder: true } } } },
      progressReport: { select: { id: true, number: true, periodFrom: true, periodTo: true } },
    },
  },
  job: { select: { id: true, number: true, name: true, customer: { select: { id: true, name: true } } } },
  salesOrder: { select: { id: true, number: true, poNumber: true, termsDays: true, total: true, vatAmount: true, status: true } },
  salesperson: userSelect,
  team: { select: { id: true, code: true, name: true } },
  requestedBy: userSelect,
  invoice: { select: { id: true, number: true, status: true } },
} satisfies Prisma.InvoiceRequestInclude;

type RequestRow = Prisma.InvoiceRequestGetPayload<{ include: typeof requestInclude }>;

/** The project's quotation, its owner and team — who "holds the project". */
async function projectHolders(jobId: string) {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      number: true,
      name: true,
      customerId: true,
      quotationRevision: {
        select: {
          quotation: {
            select: {
              id: true,
              ownerId: true,
              team: { select: { id: true, code: true, name: true } },
              owner: { select: { id: true, name: true, supervisorId: true, employee: { select: { industry: { select: { id: true, code: true, name: true } } } } } },
            },
          },
        },
      },
    },
  });
  if (!job) throw notFound('Project not found');
  const quotation = job.quotationRevision?.quotation ?? null;
  return { job, quotation, team: quotation ? quotationTeamOf(quotation) : null };
}

/**
 * Who may raise a billing's invoice request: the salesperson who owns the
 * project's quotation, their Team Leader (their "Reports to", or a Team
 * Leader on the quotation's team), or whoever may edit every request. The
 * route and the page's button both ask this one function.
 */
export async function mayRequestInvoice(me: ResolvedUser, jobId: string): Promise<boolean> {
  if (!(me.isSuperAdmin || can(me, 'gfin.invoice_requests.create'))) return false;
  if (me.isSuperAdmin || can(me, 'gfin.invoice_requests.edit_all')) return true;
  const { quotation, team } = await projectHolders(jobId);
  if (!quotation) return false;
  if (quotation.ownerId === me.id) return true;
  if (!me.roleKeys.includes('team_leader')) return false;
  if (quotation.owner.supervisorId === me.id) return true;
  if (!team) return false;
  const mine = await prisma.employee.findUnique({ where: { userId: me.id }, select: { industryId: true } });
  return mine?.industryId === team.id;
}

/** view_all, the person who raised it, or — while it waits on them — whoever may decide it. */
async function mayRead(me: ResolvedUser, row: { id: string; requestedById: string }, deciderOnly = false): Promise<boolean> {
  if (!deciderOnly && (me.isSuperAdmin || can(me, 'gfin.invoice_requests.view_all') || row.requestedById === me.id)) return true;
  return mayDecide(me.id, DOC, [row.id]);
}

async function loadVisible(me: ResolvedUser, id: string, deciderOnly = false): Promise<RequestRow> {
  const row = await prisma.invoiceRequest.findUnique({ where: { id }, include: requestInclude });
  if (!row || !(await mayRead(me, row, deciderOnly))) throw notFound('Invoice request not found');
  return row;
}

const mayEdit = (me: ResolvedUser, row: { requestedById: string }) => canEditRecord(me, 'gfin', 'invoice_requests', row.requestedById);

/** The billing's money, as numbers. */
function moneyOf(b: RequestRow['progressBilling']) {
  return {
    grossAmount: num(b.grossAmount),
    vatRate: num(b.vatRate),
    vatAmount: num(b.vatAmount),
    ewtRate: num(b.ewtRate),
    ewtAmount: num(b.ewtAmount),
    invoiceTotal: num(b.invoiceTotal),
    netCollectible: num(b.netCollectible),
  };
}

/** What is left of a sales order to invoice, before VAT. */
async function orderLeft(order: { id: string; total: Prisma.Decimal; vatAmount: Prisma.Decimal }) {
  const net = orderNet(order);
  const invoiced = await orderInvoiced(prisma, order.id);
  return { net, invoiced, left: cents(Math.max(0, net - invoiced)) };
}

async function present(me: ResolvedUser, row: RequestRow) {
  const editable = row.status === 'DRAFT';
  const editor = mayEdit(me, row);
  const money = moneyOf(row.progressBilling);
  const order = await orderLeft(row.salesOrder);
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    job: row.job,
    customer: row.job.customer,
    progressBilling: {
      id: row.progressBilling.id,
      number: row.progressBilling.number,
      status: row.progressBilling.status,
      billingDate: row.progressBilling.billingDate,
      report: row.progressBilling.progressReport,
      lines: row.progressBilling.lines
        .slice()
        .sort((a, b) => (a.scopeItem?.sortOrder ?? 0) - (b.scopeItem?.sortOrder ?? 0))
        .map((l) => ({
          id: l.id,
          name: l.scopeItem?.name ?? 'Progress billing',
          previousPct: num(l.previousPct),
          toDatePct: num(l.toDatePct),
          amount: num(l.thisPeriodAmount),
        })),
    },
    ...money,
    salesOrder: { id: row.salesOrder.id, number: row.salesOrder.number, poNumber: row.salesOrder.poNumber, ...order },
    invoiceDate: row.invoiceDate,
    termsDays: row.termsDays,
    terms: termsLabel(row.termsDays ?? undefined),
    poReference: row.poReference,
    salesperson: row.salesperson,
    team: row.team,
    notes: row.notes,
    requestedBy: row.requestedBy,
    submittedAt: row.submittedAt,
    approvedAt: row.approvedAt,
    cancelReason: row.cancelReason,
    invoice: row.invoice,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    canEdit: editable && editor,
    canSubmit: editable && editor,
    canWithdraw: row.status === 'PENDING_APPROVAL' && editor,
    canCancel: (editable || row.status === 'PENDING_APPROVAL') && editor,
    canDelete: (editable || row.status === 'CANCELLED') && editor && can(me, 'gfin.invoice_requests.delete'),
    approvalRoute: editable ? await routeBrief(DOC, money.netCollectible, row.requestedById, null, { jobId: row.jobId }) : null,
  };
}

// Files on a request (the customer's PO, a signed acceptance) are read as the
// request is, and change only on a draft, by whoever may edit it.
registerAttachmentGuard(
  'invoice_request',
  async (user, id) => {
    const row = await prisma.invoiceRequest.findUnique({ where: { id }, select: { id: true, requestedById: true } });
    return !!row && (await mayRead(user, row));
  },
  {
    write: async (user, id) => {
      const row = await prisma.invoiceRequest.findUnique({ where: { id }, select: { status: true, requestedById: true } });
      return !!row && row.status === 'DRAFT' && mayEdit(user, row);
    },
  },
);

// ── List ─────────────────────────────────────────────────────────────────────

/** The list's where-builder — the register, its cards and its paper read it. */
export function requestListWhere(me: ResolvedUser, q: ReturnType<typeof listQuery>) {
  const base: Prisma.InvoiceRequestWhereInput[] = [];
  const seesAll = me.isSuperAdmin || can(me, 'gfin.invoice_requests.view_all');
  const mine = !seesAll || q.scope === 'mine';
  if (mine) base.push({ requestedById: me.id });
  if (q.filters.jobId) base.push({ jobId: q.filters.jobId });
  if (q.filters.salesOrderId) base.push({ salesOrderId: q.filters.salesOrderId });
  if (q.filters.requestedById) base.push({ requestedById: q.filters.requestedById });
  if (q.filters.teamId) base.push(q.filters.teamId === 'none' ? { teamId: null } : { teamId: q.filters.teamId });
  const from = filterDay(q.filters.dateFrom, 'From');
  const to = filterDay(q.filters.dateTo, 'To');
  if (from || to) base.push({ createdAt: { ...(from ? { gte: manilaDayStart(from) } : {}), ...(to ? { lte: manilaDayEnd(to) } : {}) } });
  if (q.search) {
    base.push({
      OR: [
        { number: { contains: q.search, mode: 'insensitive' } },
        { poReference: { contains: q.search, mode: 'insensitive' } },
        { progressBilling: { number: { contains: q.search, mode: 'insensitive' } } },
        { salesOrder: { number: { contains: q.search, mode: 'insensitive' } } },
        { job: { number: { contains: q.search, mode: 'insensitive' } } },
        { job: { name: { contains: q.search, mode: 'insensitive' } } },
        { job: { customer: { name: { contains: q.search, mode: 'insensitive' } } } },
      ],
    });
  }
  const ids = idsFilter(q.filters.ids);
  if (ids) base.push({ id: { in: ids } });
  const status = choice(q.filters.status, InvoiceRequestStatus, 'Status');
  const where: Prisma.InvoiceRequestWhereInput = { AND: [...base, ...(status ? [{ status }] : [])] };
  return { base: { AND: base } as Prisma.InvoiceRequestWhereInput, where, mine, status, from, to };
}

const SORTS = ['number', 'status', 'createdAt'];

/** The list's cards, under everything but the status filter — each equals the list its link opens. */
async function requestListSummary(base: Prisma.InvoiceRequestWhereInput) {
  const monthStart = dayKey(new Date());
  monthStart.setUTCDate(1);
  const [waiting, drafts, approved, waitingSum] = await Promise.all([
    prisma.invoiceRequest.count({ where: { AND: [base, { status: 'PENDING_APPROVAL' }] } }),
    prisma.invoiceRequest.count({ where: { AND: [base, { status: 'DRAFT' }] } }),
    prisma.invoiceRequest.count({ where: { AND: [base, { status: 'APPROVED' }, { approvedAt: { gte: monthStart } }] } }),
    prisma.invoiceRequest.findMany({ where: { AND: [base, { status: 'PENDING_APPROVAL' }] }, select: { progressBilling: { select: { netCollectible: true } } } }),
  ]);
  return {
    waiting,
    waitingValue: cents(waitingSum.reduce((s, r) => s + num(r.progressBilling.netCollectible), 0)),
    drafts,
    approvedThisMonth: approved,
  };
}

function listRow(r: RequestRow, stage: string | undefined) {
  return {
    id: r.id,
    number: r.number,
    status: r.status,
    stage: stage ?? null,
    job: r.job,
    customer: r.job.customer,
    billing: { id: r.progressBilling.id, number: r.progressBilling.number },
    salesOrder: { id: r.salesOrder.id, number: r.salesOrder.number },
    poReference: r.poReference,
    netCollectible: num(r.progressBilling.netCollectible),
    invoiceTotal: num(r.progressBilling.invoiceTotal),
    requestedBy: r.requestedBy,
    team: r.team,
    invoice: r.invoice,
    createdAt: r.createdAt,
  };
}

invoiceRequestRoutes.get(
  '/',
  requireAny(...VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const { base, where } = requestListWhere(me, q);
    const [rows, total, summary] = await Promise.all([
      prisma.invoiceRequest.findMany({
        where,
        include: requestInclude,
        orderBy: orderBy(q, SORTS, { createdAt: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.invoiceRequest.count({ where }),
      requestListSummary(base),
    ]);
    const steps = await openSteps(DOC, rows.filter((r) => r.status === 'PENDING_APPROVAL').map((r) => r.id));
    res.json({ ...listResult(rows.map((r) => listRow(r, steps.get(r.id))), total, q), summary });
  }),
);

/** The register on paper — the list as filtered, or the rows ticked. Above `/:id`. */
invoiceRequestRoutes.get(
  '/pdf',
  requireAny(...VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const { where, mine, status, from, to } = requestListWhere(me, q);
    const [rows, count, project, order] = await Promise.all([
      prisma.invoiceRequest.findMany({ where, include: requestInclude, orderBy: orderBy(q, SORTS, { createdAt: 'desc' }), take: LIST_CAP }),
      prisma.invoiceRequest.count({ where }),
      recordNamed('project', q.filters.jobId),
      recordNamed('sales order', q.filters.salesOrderId),
    ]);
    const currency = await companyCurrency();
    const reference = listReference(count, rows.length, ['invoice request', 'invoice requests'], [
      q.search && `search "${q.search}"`,
      status && `status ${statusLabel(status)}`,
      project,
      order,
      rangeNamed('raised', from ?? undefined, to ?? undefined),
      mine && 'raised by me',
      q.filters.ids && 'the rows selected',
    ]);
    const pdf = await renderDocument({
      title: 'Invoice Requests',
      date: new Date(),
      reference,
      landscape: true,
      sections: [
        {
          kind: 'table',
          head: ['Number', 'Project', 'Customer', 'Billing', 'Sales order', `Net collectible (${currency})`, 'Requested by', 'Raised', 'Invoice', 'Status'],
          rows: rows.map((r) => [
            r.number,
            { title: r.job.number, body: r.job.name },
            r.job.customer.name,
            r.progressBilling.number,
            r.salesOrder.number,
            formatAmount(num(r.progressBilling.netCollectible)),
            r.requestedBy.name,
            formatShortDate(r.createdAt),
            r.invoice?.number ?? '',
            statusLabel(r.status),
          ]),
        },
      ],
    });
    await audit({ entityType: 'invoice_request', entityId: 'list', action: 'EXPORTED', summary: `Exported the invoice requests as PDF (${rows.length})` }, req);
    sendListPdf(res, pdf, 'invoice-requests.pdf');
  }),
);

/**
 * What a request is raised FROM: the billing (approved, not invoiced, nothing
 * live on it), the project's ISSUED sales orders with what is left of each,
 * and the salesperson and team the invoice would be credited to. Above `/:id`.
 */
invoiceRequestRoutes.get(
  '/source',
  require_('gfin.invoice_requests.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const billingId = String(req.query.billingId ?? '');
    if (!billingId) throw badRequest('Which billing?');
    const billing = await prisma.progressBilling.findUnique({
      where: { id: billingId },
      include: { job: { select: { id: true, number: true, name: true, customer: { select: { id: true, name: true } } } }, invoice: { select: { number: true } } },
    });
    if (!billing) throw notFound('Progress billing not found');
    res.json({
      billing: {
        id: billing.id,
        number: billing.number,
        status: billing.status,
        grossAmount: num(billing.grossAmount),
        invoiceTotal: num(billing.invoiceTotal),
        netCollectible: num(billing.netCollectible),
        invoice: billing.invoice,
      },
      job: billing.job,
      problem: await sourceProblem(billing),
      mayRequest: await mayRequestInvoice(me, billing.jobId),
      salesOrders: await projectOrders(billing.jobId),
      credit: await invoiceCredit({ jobId: billing.jobId }),
    });
  }),
);

/** Why a billing cannot be requested now, in words — or null. */
async function sourceProblem(billing: { id: string; number: string; status: string; invoice: { number: string } | null }): Promise<string | null> {
  if (billing.invoice) return `${billing.number} has already been invoiced as ${billing.invoice.number}`;
  if (billing.status !== 'APPROVED') return `${billing.number} is ${statusLabel(billing.status).toLowerCase()} — only an approved billing can be invoiced`;
  const live = await prisma.invoiceRequest.findFirst({ where: { progressBillingId: billing.id, status: { in: LIVE } }, select: { number: true } });
  return live ? `${billing.number} already has invoice request ${live.number} open` : null;
}

/** The project's ISSUED sales orders — through the quotation the project was won from — with what is left of each. */
async function projectOrders(jobId: string) {
  const { quotation } = await projectHolders(jobId);
  if (!quotation) return [];
  const orders = await prisma.salesOrder.findMany({
    where: { quotationId: quotation.id, status: 'ISSUED' },
    orderBy: { orderDate: 'asc' },
    select: { id: true, number: true, poNumber: true, termsDays: true, total: true, vatAmount: true, orderDate: true },
  });
  return Promise.all(
    orders.map(async (o) => ({
      id: o.id,
      number: o.number,
      poNumber: o.poNumber,
      termsDays: o.termsDays,
      orderDate: o.orderDate,
      ...(await orderLeft(o)),
    })),
  );
}

// ── One ──────────────────────────────────────────────────────────────────────

invoiceRequestRoutes.get(
  '/:id',
  requireAnyOrDecider(...VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await loadVisible(me, req.params.id, res.locals.deciderOnly === true);
    res.json(await present(me, row));
  }),
);

const headerSchema = z.object({
  salesOrderId: z.string().min(1, 'Which sales order does it bill?'),
  invoiceDate: z.string().optional().nullable(),
  termsDays: z.number().int().min(0).max(365).optional().nullable(),
  poReference: z.string().trim().max(120).optional().nullable(),
  salespersonId: z.string().optional().nullable(),
  teamId: z.string().optional().nullable(),
  notes: z.string().trim().max(5000).optional().nullable(),
});

/**
 * The header a request may carry, checked: the order ISSUED, the job's
 * customer's and booked from the project's quotation, the billing's gross
 * within what is left of the order's net; the PO and terms the order's unless
 * typed; a salesperson and an active team that exist.
 */
async function checkHeader(body: z.infer<typeof headerSchema>, billing: { jobId: string; grossAmount: Prisma.Decimal }) {
  const orders = await projectOrders(billing.jobId);
  const order = orders.find((o) => o.id === body.salesOrderId);
  if (!order) {
    throw badRequest(
      orders.length
        ? 'That sales order is not one of this project’s issued orders'
        : 'This project has no issued sales order — the quotation it was won from must be booked as a sales order first',
    );
  }
  const gross = num(billing.grossAmount);
  if (gross > order.left + 0.005) {
    throw badRequest(`Only ${formatMoney(order.left, await companyCurrency())} of ${order.number} is left to invoice (before VAT) — this billing is ${formatMoney(gross, await companyCurrency())}`);
  }
  if (body.salespersonId) {
    const known = await prisma.user.findUnique({ where: { id: body.salespersonId }, select: { id: true } });
    if (!known) throw badRequest('That salesperson is not on file');
  }
  if (body.teamId) {
    const team = await prisma.industry.findUnique({ where: { id: body.teamId }, select: { isActive: true } });
    if (!team?.isActive) throw badRequest('That team is not on the list');
  }
  const invoiceDate = body.invoiceDate ? new Date(body.invoiceDate) : null;
  if (invoiceDate && Number.isNaN(invoiceDate.getTime())) throw badRequest('Invoice date is not a valid date');
  return {
    salesOrderId: order.id,
    invoiceDate: invoiceDate ? dayKey(invoiceDate) : null,
    termsDays: body.termsDays ?? order.termsDays ?? null,
    poReference: body.poReference?.trim() || order.poNumber || null,
    notes: body.notes || null,
  };
}

invoiceRequestRoutes.post(
  '/',
  require_('gfin.invoice_requests.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(headerSchema.extend({ progressBillingId: z.string().min(1, 'Which billing?') }), req.body);
    const billing = await prisma.progressBilling.findUnique({
      where: { id: body.progressBillingId },
      include: { invoice: { select: { number: true } } },
    });
    if (!billing) throw notFound('Progress billing not found');
    if (!(await mayRequestInvoice(me, billing.jobId))) {
      throw forbidden('Only the salesperson who holds the project, or their Team Leader, can ask for its invoice');
    }
    const header = await checkHeader(body, billing);
    const credit =
      body.salespersonId === undefined || body.teamId === undefined ? await invoiceCredit({ jobId: billing.jobId, salesOrderId: header.salesOrderId }) : null;

    const made = await prisma.$transaction(async (tx) => {
      // One live request per billing, decided under a lock on the billing's row.
      await tx.$queryRaw`SELECT id FROM "ProgressBilling" WHERE id = ${billing.id} FOR UPDATE`;
      const fresh = await tx.progressBilling.findUniqueOrThrow({ where: { id: billing.id }, include: { invoice: { select: { number: true } } } });
      const problem = await sourceProblem(fresh);
      if (problem) throw badRequest(problem);
      return tx.invoiceRequest.create({
        data: {
          number: await nextNumber(DOC, tx),
          progressBillingId: billing.id,
          jobId: billing.jobId,
          ...header,
          salespersonId: body.salespersonId === undefined ? credit!.salespersonId : body.salespersonId || null,
          teamId: body.teamId === undefined ? credit!.teamId : body.teamId || null,
          requestedById: me.id,
        },
      });
    });
    await audit({ entityType: 'invoice_request', entityId: made.id, action: 'CREATED', summary: `Raised ${made.number} for ${billing.number}` }, req);
    res.status(201).json(await present(me, await loadVisible(me, made.id)));
  }),
);

invoiceRequestRoutes.put(
  '/:id',
  requireAny('gfin.invoice_requests.edit_own', 'gfin.invoice_requests.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(headerSchema, req.body);
    const row = await loadVisible(me, req.params.id);
    if (!mayEdit(me, row)) throw forbidden('Only the person who raised this request can change it');
    if (row.status !== 'DRAFT') throw badRequest('Only a draft can be changed — pull it back first');
    const header = await checkHeader(body, row.progressBilling);
    const claimed = await prisma.invoiceRequest.updateMany({
      where: { id: row.id, status: 'DRAFT' },
      data: {
        ...header,
        ...(body.salespersonId !== undefined ? { salespersonId: body.salespersonId || null } : {}),
        ...(body.teamId !== undefined ? { teamId: body.teamId || null } : {}),
      },
    });
    if (!claimed.count) throw badRequest('It was submitted a moment ago — reload');
    await audit({ entityType: 'invoice_request', entityId: row.id, action: 'UPDATED', summary: `${row.number} changed` }, req);
    res.json(await present(me, await loadVisible(me, row.id)));
  }),
);

/**
 * Submitting: claimed on DRAFT and on what it read, filed in the requester's
 * name whoever presses the button, the billing's net collectible as the
 * amount; back to DRAFT if the engine refuses — never pending with no request.
 */
invoiceRequestRoutes.post(
  '/:id/submit',
  requireAny('gfin.invoice_requests.create', 'gfin.invoice_requests.edit_own', 'gfin.invoice_requests.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await loadVisible(me, req.params.id);
    if (!mayEdit(me, row)) throw forbidden('Only the person who raised this request can submit it');
    if (row.status !== 'DRAFT') throw badRequest('This request has already been submitted');
    // The order must still hold the billing — another invoice may have taken it since.
    await checkHeader({ salesOrderId: row.salesOrderId, termsDays: row.termsDays, poReference: row.poReference }, row.progressBilling);

    const claimed = await prisma.invoiceRequest.updateMany({
      where: { id: row.id, status: 'DRAFT', updatedAt: row.updatedAt },
      data: { status: 'PENDING_APPROVAL', submittedAt: new Date() },
    });
    if (!claimed.count) throw badRequest('It changed a moment ago — reload');
    try {
      await submitForApproval({
        documentType: DOC,
        documentId: row.id,
        documentNumber: row.number,
        subject: `${row.job.number} — invoice ${row.progressBilling.number} on ${row.salesOrder.number}`,
        amount: num(row.progressBilling.netCollectible),
        link: INVOICE_REQUEST_LINK(row.id),
        requesterId: row.requestedById,
        jobId: row.jobId,
      });
    } catch (err) {
      await prisma.invoiceRequest.updateMany({ where: { id: row.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT', submittedAt: null } });
      throw err;
    }
    await audit({ entityType: 'invoice_request', entityId: row.id, action: 'SUBMITTED', summary: `${row.number} sent to Back Support` }, req);
    res.json(await present(me, await loadVisible(me, row.id)));
  }),
);

/** Pulled back to DRAFT before anybody decides — the request withdrawn in the same transaction. */
invoiceRequestRoutes.post(
  '/:id/withdraw',
  requireAny('gfin.invoice_requests.create', 'gfin.invoice_requests.edit_own', 'gfin.invoice_requests.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await loadVisible(me, req.params.id);
    if (!mayEdit(me, row)) throw forbidden('Only the person who raised this request can pull it back');
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.invoiceRequest.updateMany({ where: { id: row.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
      if (!claimed.count) throw badRequest('It was decided a moment ago — the decision stands');
      await cancelOpenRequest(DOC, row.id, tx, `pulled back by ${me.name}`, me.id);
    });
    await audit({ entityType: 'invoice_request', entityId: row.id, action: 'UPDATED', summary: `${row.number} pulled back to draft` }, req);
    res.json(await present(me, await loadVisible(me, row.id)));
  }),
);

invoiceRequestRoutes.post(
  '/:id/cancel',
  requireAny('gfin.invoice_requests.create', 'gfin.invoice_requests.edit_own', 'gfin.invoice_requests.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(z.object({ reason: z.string().trim().min(3, 'Say why').max(500) }), req.body ?? {});
    const row = await loadVisible(me, req.params.id);
    if (!mayEdit(me, row)) throw forbidden('Only the person who raised this request can cancel it');
    if (!LIVE.includes(row.status)) throw badRequest(`This request is ${statusLabel(row.status).toLowerCase()} — it cannot be cancelled`);
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.invoiceRequest.updateMany({ where: { id: row.id, status: row.status }, data: { status: 'CANCELLED', cancelReason: body.reason } });
      if (!claimed.count) throw badRequest('It moved a moment ago — reload to see where it stands');
      await cancelOpenRequest(DOC, row.id, tx, `cancelled by ${me.name}: ${body.reason}`, me.id);
    });
    await audit({ entityType: 'invoice_request', entityId: row.id, action: 'CANCELLED', summary: `${row.number} cancelled — ${body.reason}` }, req);
    res.json(await present(me, await loadVisible(me, row.id)));
  }),
);

invoiceRequestRoutes.delete(
  '/:id',
  require_('gfin.invoice_requests.delete'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await loadVisible(me, req.params.id);
    if (!mayEdit(me, row)) throw forbidden('That is someone else’s request');
    if (row.status !== 'DRAFT' && row.status !== 'CANCELLED') {
      throw badRequest('Only a draft or a cancelled request can be deleted — an approved one is a record');
    }
    await deleteOrRefuse(row.number, () => prisma.invoiceRequest.delete({ where: { id: row.id } }));
    await deleteAttachmentsOf('invoice_request', [row.id]);
    await audit({ entityType: 'invoice_request', entityId: row.id, action: 'DELETED', summary: `Deleted ${statusLabel(row.status).toLowerCase()} ${row.number}` }, req);
    res.json({ ok: true });
  }),
);

// ── Settle ───────────────────────────────────────────────────────────────────

/**
 * Applied only while the request is still PENDING_APPROVAL (a conditional
 * claim), so a decision after a pull-back or a cancel changes nothing and the
 * trail says so. Approved: in ONE transaction the request is claimed APPROVED
 * and the DRAFT invoice raised from its billing (`createInvoiceFromBilling`,
 * finance's own door) on the order it names — or, when the invoice cannot be
 * made (the order has nothing left, the billing was invoiced meanwhile), the
 * whole thing rolls back and the request goes back to DRAFT with a bell
 * saying why: never half done. Returned or rejected: back to DRAFT.
 * Exported so a test can call it twice.
 */
export async function settleInvoiceRequest(approval: ApprovalRequest, outcome: ApprovalOutcome) {
  const row = await prisma.invoiceRequest.findUnique({ where: { id: approval.documentId }, include: requestInclude });
  if (!row) return;
  if (outcome !== 'APPROVED') {
    const claimed = await prisma.invoiceRequest.updateMany({ where: { id: row.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
    await audit({
      entityType: 'invoice_request',
      entityId: row.id,
      action: outcome,
      summary: claimed.count ? `${row.number} returned to draft` : `${row.number} ${outcome.toLowerCase()} after it was ${statusLabel(row.status).toLowerCase()} — not applied`,
    });
    return;
  }
  const last = await prisma.approvalAction.findFirst({ where: { requestId: approval.id, action: 'APPROVED' }, orderBy: { actedAt: 'desc' }, select: { approverId: true } });
  const settings = await financeSettings();
  let invoiceNumber: string | null = null;
  try {
    invoiceNumber = await prisma.$transaction(async (tx) => {
      const claimed = await tx.invoiceRequest.updateMany({ where: { id: row.id, status: 'PENDING_APPROVAL' }, data: { status: 'APPROVED', approvedAt: new Date() } });
      if (!claimed.count) return null;
      await tx.$queryRaw`SELECT id FROM "ProgressBilling" WHERE id = ${row.progressBillingId} FOR UPDATE`;
      const billing = await tx.progressBilling.findUniqueOrThrow({ where: { id: row.progressBillingId }, include: billingForInvoiceInclude });
      if (billing.invoice) throw new Error(`${billing.number} was invoiced as ${billing.invoice.number} meanwhile`);
      if (billing.status !== 'APPROVED') throw new Error(`${billing.number} is ${statusLabel(billing.status).toLowerCase()}`);
      await assertOrderLeft(tx, { id: row.salesOrder.id, number: row.salesOrder.number, net: orderNet(row.salesOrder) }, num(billing.grossAmount));
      const invoiceDate = row.invoiceDate ?? dayKey(new Date());
      const termsDays = row.termsDays ?? settings.defaultTermsDays;
      const invoice = await createInvoiceFromBilling(
        tx,
        billing,
        {
          invoiceDate,
          dueDate: expectedCollection(invoiceDate, null, termsDays),
          termsDays,
          poReference: row.poReference,
          notes: row.notes,
          salespersonId: row.salespersonId,
          teamId: row.teamId,
          salesOrderId: row.salesOrderId,
        },
        last?.approverId ?? row.requestedById,
      );
      await tx.invoiceRequest.update({ where: { id: row.id }, data: { invoiceId: invoice.id } });
      return invoice.number;
    });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    await prisma.invoiceRequest.updateMany({ where: { id: row.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
    await audit({ entityType: 'invoice_request', entityId: row.id, action: 'REJECTED', summary: `${row.number} approved but no invoice could be raised — ${why}; back to draft` });
    await notify({
      userId: row.requestedById,
      type: 'invoice_request.not_invoiced',
      title: `${row.number}: no invoice raised`,
      body: `Back Support approved it, but ${why}. It is a draft again.`,
      link: INVOICE_REQUEST_LINK(row.id),
    });
    return;
  }
  if (!invoiceNumber) {
    await audit({ entityType: 'invoice_request', entityId: row.id, action: 'APPROVED', summary: `${row.number} approved after it was ${statusLabel(row.status).toLowerCase()} — not applied` });
    return;
  }
  await audit({ entityType: 'invoice_request', entityId: row.id, action: 'APPROVED', summary: `${row.number} approved — draft invoice ${invoiceNumber} raised in Accounts Receivable` });
  const finance = await usersHolding('gfin.ar.edit_all');
  const fresh = await prisma.invoiceRequest.findUnique({ where: { id: row.id }, select: { invoiceId: true } });
  await notify([
    {
      userId: row.requestedById,
      type: 'invoice_request.invoiced',
      title: `${row.number} approved — invoice ${invoiceNumber}`,
      body: `${row.progressBilling.number} is now draft invoice ${invoiceNumber} in Accounts Receivable.`,
      link: INVOICE_REQUEST_LINK(row.id),
    },
    ...finance
      .filter((id) => id !== row.requestedById)
      .map((userId) => ({
        userId,
        type: 'invoice_request.invoiced' as const,
        title: `Draft invoice ${invoiceNumber} is ready to issue`,
        body: `From ${row.number} — ${row.job.number} ${row.job.name}, on ${row.salesOrder.number}.`,
        link: fresh?.invoiceId ? `/g-fin/ar/${fresh.invoiceId}` : INVOICE_REQUEST_LINK(row.id),
      })),
  ]);
}
onApprovalSettled(DOC, settleInvoiceRequest);

// ── The paper ────────────────────────────────────────────────────────────────

/**
 * "Invoice Request" through `renderDocument`, in the standard dress: what is
 * to be invoiced (the customer, the project, the order and its PO, the
 * billing and its period, the terms and who is credited), the particulars
 * from the billing's lines, the money as a `totals` block, then Requested by
 * and one sign-off per step of its route (a draft prints the route submitting
 * would take, Pending under it); files behind unless `?attachments=0`.
 */
invoiceRequestRoutes.get(
  '/:id/pdf',
  requireAnyOrDecider(...VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await loadVisible(me, req.params.id, res.locals.deciderOnly === true);
    const currency = await companyCurrency();
    const money = moneyOf(row.progressBilling);
    const slots =
      row.status === 'DRAFT'
        ? await approvalSlots(DOC, row.id, { amount: money.netCollectible, requesterId: row.requestedById, jobId: row.jobId })
        : await approvalSlots(DOC, row.id);
    const requester = { name: row.requestedBy.name, ...(await contactOf(row.requestedById)) };
    const signatories: Signatory[] = [{ role: 'Requested by', ...requester, at: preparedAt(slots) ?? row.createdAt }, ...slotSignatories(slots)];
    const report = row.progressBilling.progressReport;
    const period = `${formatDate(report.periodFrom)} – ${formatDate(report.periodTo)}`;
    const lines = row.progressBilling.lines.slice().sort((a, b) => (a.scopeItem?.sortOrder ?? 0) - (b.scopeItem?.sortOrder ?? 0));
    const sections: PdfSection[] = [
      {
        kind: 'fields',
        columns: 3,
        fields: [
          { label: 'Customer', value: row.job.customer.name },
          { label: 'Project', value: `${row.job.number} — ${row.job.name}` },
          { label: 'Sales order', value: row.salesOrder.number },
          { label: 'Customer P.O.', value: row.poReference ?? '' },
          { label: 'Billing no.', value: row.progressBilling.number },
          { label: 'Report period', value: period },
          { label: 'Payment terms', value: termsLabel(row.termsDays ?? undefined) },
          { label: 'Invoice date', value: row.invoiceDate ? formatDate(row.invoiceDate) : 'On approval' },
          { label: 'Sales personnel', value: row.salesperson?.name ?? '' },
          { label: 'Team', value: row.team?.code ?? '' },
          { label: 'Status', value: statusLabel(row.status) },
          { label: 'Invoice', value: row.invoice?.number ?? '' },
        ],
      },
      {
        kind: 'table',
        title: 'Particulars',
        head: ['No.', 'Scope of work', 'Previous', 'To date', `Amount (${currency})`],
        widths: [8, 50, 12, 12, 18],
        rows: lines.map((l, i) => [
          String(i + 1),
          l.scopeItem?.name ?? 'Progress billing',
          `${num(l.previousPct).toFixed(2)}%`,
          `${num(l.toDatePct).toFixed(2)}%`,
          formatAmount(num(l.thisPeriodAmount)),
        ]),
      },
      {
        kind: 'totals',
        rows: [
          { label: 'Gross', value: formatMoney(money.grossAmount, currency) },
          { label: `VAT (${(money.vatRate * 100).toFixed(0)}%)`, value: formatMoney(money.vatAmount, currency) },
          { label: 'Invoice total', value: formatMoney(money.invoiceTotal, currency) },
          { label: `Less: EWT (${(money.ewtRate * 100).toFixed(0)}%)`, value: formatMoney(money.ewtAmount, currency) },
          { label: 'Net collectible', value: formatMoney(money.netCollectible, currency), bold: true },
        ],
      },
    ];
    if (row.notes) sections.push({ kind: 'text', title: 'Notes', body: row.notes });
    if (row.cancelReason && row.status === 'CANCELLED') sections.push({ kind: 'text', title: 'Cancelled', body: row.cancelReason });

    const bare = await renderDocument({
      title: 'Invoice Request',
      documentNumber: row.number,
      date: row.createdAt,
      reference: row.job.customer.name,
      sections,
      signatories,
    });
    const files = req.query.attachments === '0' ? [] : await attachedFiles('invoice_request', row.id);
    const { pdf, listed } = await withAttachments(bare, files, { title: 'Invoice Request', number: row.number, reference: row.job.name });
    await audit(
      { entityType: 'invoice_request', entityId: row.id, action: 'EXPORTED', summary: `Printed ${row.number}${listed ? ` with ${listed} attachment${listed === 1 ? '' : 's'}` : ''}` },
      req,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition(paperFileName({ kind: 'Invoice Request', number: row.number, author: row.requestedBy.name, date: row.createdAt })));
    res.send(pdf);
  }),
);

registerSearch({
  kind: 'invoice_request',
  label: 'Invoice requests',
  permission: VIEW,
  ownWhere: (user) => ({ requestedById: user.id }),
  async search(term, _user, limit, own) {
    const rows = await prisma.invoiceRequest.findMany({
      where: {
        ...((own ?? {}) as Prisma.InvoiceRequestWhereInput),
        OR: [
          { number: { contains: term, mode: 'insensitive' } },
          { progressBilling: { number: { contains: term, mode: 'insensitive' } } },
          { job: { name: { contains: term, mode: 'insensitive' } } },
        ],
      },
      select: { id: true, number: true, status: true, job: { select: { number: true, name: true } }, progressBilling: { select: { number: true } } },
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      kind: 'invoice_request',
      id: r.id,
      title: `${r.number} — ${r.progressBilling.number}`,
      subtitle: `${r.job.number} ${r.job.name} · ${statusLabel(r.status).toLowerCase()}`,
      link: INVOICE_REQUEST_LINK(r.id),
    }));
  },
});
