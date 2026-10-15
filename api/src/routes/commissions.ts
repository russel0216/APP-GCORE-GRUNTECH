import { Router } from 'express';
import { z } from 'zod';
import { Prisma, CommissionStatus, type ApprovalRequest } from '@prisma/client';
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
  onApprovalReopened,
  openSteps,
  preparedAt,
  routeBrief,
  slotSignatories,
  stageWords,
  submitForApproval,
  type ApprovalOutcome,
} from '../shared/approvals';
import { registerAttachmentGuard, deleteAttachmentsOf } from '../shared/attachments';
import { attachedFiles, withAttachments } from '../shared/pdfAttachments';
import { registerSearch } from '../shared/search';
import { renderDocument, formatAmount, formatDate, formatMoney, formatShortDate, statusLabel, companyCurrency, type PdfSection, type Signatory } from '../shared/pdf';
import { LIST_CAP, listReference, recordNamed, choice, sendListPdf, rangeNamed, filterDay } from '../shared/listPaper';
import { contentDisposition, paperFileName } from '../shared/paperName';
import { cents, num, refreshAdvance, settleable } from '../shared/finance';
import { dayKey, manilaDayStart, manilaDayEnd } from '../shared/day';
import { quotationTeamOf } from '../shared/team';
import { usersHolding } from '../shared/clearance';
import { orderNet } from '../shared/billingInvoice';
import { quotationTotals } from '../shared/quotation';
import { commissionFigures } from '../shared/commission';

/**
 * COMMISSIONS (2026-10-16, the owner's "Commission Request System"): a sales
 * order's commission, raised once the order is FULLY COLLECTED — its live
 * invoices cover the order's net and every one is PAID — and split among the
 * people who earned it: the sales order's author, the quotation's owner,
 * their Team Leader, the project's Technical Manager and the job orders'
 * personnel are offered first; anyone else may be added. The figures are the
 * owner's banner: actual margin = collected − VAT − total cost; gross =
 * margin × rate; each share less its tax (10% by default) and a cash advance
 * deduction gives its net (`shared/commission.ts`, the one arithmetic).
 *
 * It routes through the one engine as `commission` (rule 2): seeded
 * "Commission — finance manager, CEO / President". Approved, finance PAYS it
 * (`POST /:id/pay`, `gfin.ap.create` — money out is A/P's right): one
 * DISBURSEMENT voucher per beneficiary for their net, allocated to the share,
 * and every cash advance deduction recorded as a repayment of that advance —
 * a RECEIPT allocation of kind `advance_refund`, method COMMISSION_DEDUCTION
 * — all in one transaction, `refreshAdvance()` deciding the advance's status.
 */

export const commissionRoutes = Router();
commissionRoutes.use(authenticate);

const DOC = 'commission';
const VIEW = ['gfin.commissions.view_all', 'gfin.commissions.view_own'];
export const COMMISSION_LINK = (id: string) => `/g-fin/commissions/${id}`;
/** A request that still stands on its order — one per sales order. */
const STANDING: CommissionStatus[] = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PAID'];
/** Shares whose cash advance deduction is reserved but not yet recorded. */
const UNPAID: CommissionStatus[] = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'];

const userSelect = { select: { id: true, name: true, email: true, position: true } } as const;
const D = (n: number) => new Prisma.Decimal(n);

const requestInclude = {
  salesOrder: { select: { id: true, number: true, orderDate: true, quotationId: true, ownerId: true, quotation: { select: { id: true, number: true, subject: true } } } },
  customer: { select: { id: true, name: true } },
  job: { select: { id: true, number: true, name: true } },
  requestedBy: userSelect,
  salesperson: userSelect,
  team: { select: { id: true, code: true, name: true } },
  shares: {
    orderBy: { sortOrder: 'asc' },
    include: {
      user: userSelect,
      cashAdvance: { select: { id: true, number: true } },
      payment: { select: { id: true, number: true } },
    },
  },
} satisfies Prisma.CommissionRequestInclude;

type RequestRow = Prisma.CommissionRequestGetPayload<{ include: typeof requestInclude }>;

// ── The sales order behind it ────────────────────────────────────────────────

/**
 * Everything a request reads off its sales order: the money (total, VAT, net,
 * the lines' cost — the order's own arithmetic), the collection (each live
 * invoice, what was settled on it, the official receipts, the latest day),
 * whether it is FULLY collected, the project built from its quotation, and
 * the people involved. `collected` counts what the customer settled on each
 * invoice plus the EWT it withheld at source — the withheld part is paid to
 * the government on our account, not lost (Phase 7: invoiced ≠ collectible,
 * but EWT is never short-paid).
 */
async function orderSource(salesOrderId: string) {
  const order = await prisma.salesOrder.findUnique({
    where: { id: salesOrderId },
    include: {
      lines: { orderBy: { sortOrder: 'asc' } },
      customer: { select: { id: true, name: true } },
      owner: { select: { id: true, name: true, position: true, supervisorId: true } },
      quotation: {
        select: {
          id: true,
          number: true,
          subject: true,
          ownerId: true,
          team: { select: { id: true, code: true, name: true } },
          owner: { select: { id: true, name: true, position: true, supervisorId: true, employee: { select: { industry: { select: { id: true, code: true, name: true } } } } } },
        },
      },
      invoices: {
        where: { status: { not: 'CANCELLED' } },
        orderBy: { invoiceDate: 'asc' },
        select: {
          id: true,
          number: true,
          siNumber: true,
          status: true,
          invoiceDate: true,
          grossAmount: true,
          invoiceTotal: true,
          ewtAmount: true,
          netCollectible: true,
          amountCollected: true,
          allocations: { where: { payment: { kind: 'RECEIPT' } }, select: { amount: true, payment: { select: { id: true, number: true, orNumber: true, paymentDate: true } } } },
        },
      },
    },
  });
  if (!order) throw notFound('Sales order not found');
  const totals = quotationTotals({ lines: order.lines, discountPct: order.discountPct, vatRate: order.vatRate, vatInclusive: order.vatInclusive });
  const net = orderNet(order);
  const invoiced = cents(order.invoices.reduce((s, i) => s + num(i.grossAmount), 0));
  const collected = cents(order.invoices.reduce((s, i) => s + num(i.amountCollected) + (i.status === 'PAID' ? num(i.ewtAmount) : 0), 0));
  const collections = order.invoices.flatMap((i) => i.allocations.map((a) => ({ invoice: i.number, ...a.payment, amount: num(a.amount) })));
  const orNumbers = [...new Set(collections.map((c) => c.orNumber).filter((x): x is string => !!x))];
  const collectedOn = collections.reduce<Date | null>((d, c) => (!d || c.paymentDate > d ? c.paymentDate : d), null);
  const unpaid = order.invoices.filter((i) => i.status !== 'PAID');
  const fully = order.invoices.length > 0 && invoiced + 0.005 >= net && unpaid.length === 0;
  const problem =
    order.status !== 'ISSUED'
      ? `${order.number} is ${statusLabel(order.status).toLowerCase()} — a commission is raised on an issued sales order`
      : !order.invoices.length
        ? `${order.number} has not been invoiced yet — a commission is raised once the order is fully collected`
        : invoiced + 0.005 < net
          ? `${order.number} is invoiced ${formatAmount(invoiced)} of ${formatAmount(net)} before VAT — a commission is raised once the whole order is invoiced and collected`
          : unpaid.length
            ? `${unpaid.map((i) => i.number).join(', ')} ${unpaid.length === 1 ? 'is' : 'are'} not fully collected yet`
            : null;
  const job = await prisma.job.findFirst({
    where: { quotationRevision: { quotationId: order.quotationId }, status: { not: 'CANCELLED' } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, number: true, name: true, projectManagerId: true },
  });
  return {
    order,
    totals,
    figures: {
      totalAmount: num(order.total),
      vatAmount: num(order.vatAmount),
      netOfVat: net,
      totalCost: totals.cost.totalCost,
      collectedAmount: collected,
      invoiced,
    },
    fully,
    problem: fully ? null : problem,
    orNumbers,
    collectedOn,
    collections,
    job,
    team: quotationTeamOf(order.quotation),
  };
}

/**
 * The deal's people, each with what they did on it — offered first by "+ Add
 * person" (the owner's call: Sales and Project Management involved in the
 * collection). Anybody else is added through the people picker.
 */
async function dealPeople(src: Awaited<ReturnType<typeof orderSource>>) {
  const roles = new Map<string, string[]>();
  const add = (id: string | null | undefined, role: string) => {
    if (!id) return;
    const list = roles.get(id) ?? [];
    if (!list.includes(role)) list.push(role);
    roles.set(id, list);
  };
  add(src.order.ownerId, 'Sales order');
  add(src.order.quotation.ownerId, 'Quotation owner');
  add(src.order.quotation.owner.supervisorId, 'Team Leader');
  add(src.job?.projectManagerId, 'Technical Manager');
  const orders = await prisma.jobOrder.findMany({
    where: { OR: [{ salesOrderId: src.order.id }, { quotationId: src.order.quotationId }, ...(src.job ? [{ jobId: src.job.id }] : [])], status: { not: 'CANCELLED' } },
    select: { projectManagerId: true, projectEngineerId: true, projectLeadId: true, assignedToId: true, support: { select: { userId: true } } },
  });
  for (const o of orders) {
    add(o.projectManagerId, 'Technical Manager');
    add(o.projectEngineerId, 'Project Engineer');
    add(o.projectLeadId, 'Project Lead');
    add(o.assignedToId, 'Assigned personnel');
    for (const s of o.support) add(s.userId, 'Project Support');
  }
  const users = await prisma.user.findMany({ where: { id: { in: [...roles.keys()] }, isActive: true }, select: { id: true, name: true, position: true } });
  const order = [...roles.keys()];
  return users.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)).map((u) => ({ ...u, roles: roles.get(u.id) ?? [] }));
}

/**
 * Each person's open repayable cash advances (RELEASED, a balance owed) and
 * what of each is FREE to deduct: the balance less the deductions other
 * unpaid commission requests already reserve on it.
 */
async function openAdvances(userIds: string[], exceptRequestId?: string) {
  if (!userIds.length) return new Map<string, { id: string; number: string; balance: number; reserved: number; free: number }[]>();
  const rows = await prisma.cashAdvance.findMany({
    where: { requestedById: { in: userIds }, repayable: true, status: 'RELEASED' },
    orderBy: { releasedAt: 'asc' },
    select: {
      id: true,
      number: true,
      requestedById: true,
      amountReleased: true,
      amountRefunded: true,
      commissionDeductions: { where: { request: { status: { in: UNPAID }, ...(exceptRequestId ? { id: { not: exceptRequestId } } : {}) } }, select: { caDeduction: true } },
    },
  });
  const out = new Map<string, { id: string; number: string; balance: number; reserved: number; free: number }[]>();
  for (const r of rows) {
    const balance = cents(num(r.amountReleased) - num(r.amountRefunded));
    if (balance <= 0.005) continue;
    const reserved = cents(r.commissionDeductions.reduce((s, d) => s + num(d.caDeduction), 0));
    const list = out.get(r.requestedById) ?? [];
    list.push({ id: r.id, number: r.number, balance, reserved, free: cents(Math.max(0, balance - reserved)) });
    out.set(r.requestedById, list);
  }
  return out;
}

// ── Who may ──────────────────────────────────────────────────────────────────

/**
 * Who may raise a commission on an order — `mayRequestInvoice`'s rule: the
 * create right AND the order's author, the quotation's owner, their Team
 * Leader (their "Reports to", or a Team Leader on the quotation's team), or
 * whoever may edit every request. The route and the page both ask this.
 */
export async function mayRaiseCommission(me: ResolvedUser, salesOrderId: string): Promise<boolean> {
  if (!(me.isSuperAdmin || can(me, 'gfin.commissions.create'))) return false;
  if (me.isSuperAdmin || can(me, 'gfin.commissions.edit_all')) return true;
  const so = await prisma.salesOrder.findUnique({
    where: { id: salesOrderId },
    select: { ownerId: true, quotation: { select: { ownerId: true, team: { select: { id: true, code: true, name: true } }, owner: { select: { supervisorId: true, employee: { select: { industry: { select: { id: true, code: true, name: true } } } } } } } } },
  });
  if (!so) return false;
  if (so.ownerId === me.id || so.quotation.ownerId === me.id) return true;
  if (!me.roleKeys.includes('team_leader')) return false;
  if (so.quotation.owner.supervisorId === me.id) return true;
  const team = quotationTeamOf(so.quotation);
  if (!team) return false;
  const mine = await prisma.employee.findUnique({ where: { userId: me.id }, select: { industryId: true } });
  return mine?.industryId === team.id;
}

/** view_all, the person who raised it, a beneficiary, or — while it waits on them — whoever may decide it. */
async function mayRead(me: ResolvedUser, row: { id: string; requestedById: string; shares?: { userId: string }[] }, deciderOnly = false): Promise<boolean> {
  if (!deciderOnly) {
    if (me.isSuperAdmin || can(me, 'gfin.commissions.view_all') || row.requestedById === me.id) return true;
    if (row.shares?.some((s) => s.userId === me.id)) return true;
  }
  return mayDecide(me.id, DOC, [row.id]);
}

async function loadVisible(me: ResolvedUser, id: string, deciderOnly = false): Promise<RequestRow> {
  const row = await prisma.commissionRequest.findUnique({ where: { id }, include: requestInclude });
  if (!row || !(await mayRead(me, row, deciderOnly))) throw notFound('Commission request not found');
  return row;
}

const mayEdit = (me: ResolvedUser, row: { requestedById: string }) => canEditRecord(me, 'gfin', 'commissions', row.requestedById);
const mayPay = (me: ResolvedUser) => me.isSuperAdmin || (can(me, 'gfin.ap.create') && can(me, 'gfin.commissions.view_all'));

// ── Presenting ───────────────────────────────────────────────────────────────

async function present(me: ResolvedUser, row: RequestRow) {
  const draft = row.status === 'DRAFT';
  const editor = mayEdit(me, row);
  const src = await orderSource(row.salesOrderId);
  const advances = await openAdvances(row.shares.map((s) => s.userId), row.id);
  const steps = row.status === 'PENDING_APPROVAL' ? await openSteps(DOC, [row.id]) : new Map<string, string>();
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    stage: stageWords(row.status, steps.get(row.id), false),
    salesOrder: { id: row.salesOrder.id, number: row.salesOrder.number, orderDate: row.salesOrder.orderDate },
    quotation: row.salesOrder.quotation,
    customer: row.customer,
    job: row.job,
    requestedBy: row.requestedBy,
    salesperson: row.salesperson,
    team: row.team,
    commissionType: row.commissionType,
    ratePct: num(row.ratePct),
    totalAmount: num(row.totalAmount),
    netOfVat: num(row.netOfVat),
    vatAmount: num(row.vatAmount),
    totalCost: num(row.totalCost),
    margin: num(row.margin),
    collectedAmount: num(row.collectedAmount),
    grossCommission: num(row.grossCommission),
    totalTax: num(row.totalTax),
    totalCa: num(row.totalCa),
    totalNet: num(row.totalNet),
    orNumbers: row.orNumbers,
    collectedOn: row.collectedOn,
    notes: row.notes,
    cancelReason: row.cancelReason,
    submittedAt: row.submittedAt,
    approvedAt: row.approvedAt,
    paidAt: row.paidAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    shares: row.shares.map((s) => ({
      id: s.id,
      user: s.user,
      position: s.position,
      sharePct: num(s.sharePct),
      share: num(s.share),
      taxPct: num(s.taxPct),
      tax: num(s.tax),
      caDeduction: num(s.caDeduction),
      cashAdvance: s.cashAdvance,
      net: num(s.net),
      payment: s.payment,
      openAdvances: advances.get(s.userId) ?? [],
    })),
    /** The links: the invoices and the collections behind it, as they stand now. */
    invoices: src.order.invoices.map((i) => ({ id: i.id, number: i.number, siNumber: i.siNumber, status: i.status, invoiceDate: i.invoiceDate, netCollectible: num(i.netCollectible), amountCollected: num(i.amountCollected) })),
    collections: src.collections.map((c) => ({ id: c.id, number: c.number, orNumber: c.orNumber, paymentDate: c.paymentDate, invoice: c.invoice, amount: c.amount })),
    fullyCollected: src.fully,
    canEdit: draft && editor,
    canSubmit: draft && editor,
    canWithdraw: row.status === 'PENDING_APPROVAL' && editor,
    canCancel: (draft || row.status === 'PENDING_APPROVAL') && editor,
    canDelete: (draft || row.status === 'CANCELLED') && editor && can(me, 'gfin.commissions.delete'),
    canPay: row.status === 'APPROVED' && mayPay(me),
    approvalRoute: draft ? await routeBrief(DOC, num(row.totalNet), row.requestedById, null, { jobId: row.jobId ?? undefined }) : null,
  };
}

registerAttachmentGuard(
  'commission_request',
  async (user, id) => {
    const row = await prisma.commissionRequest.findUnique({ where: { id }, select: { id: true, requestedById: true, shares: { select: { userId: true } } } });
    return !!row && (await mayRead(user, row));
  },
  {
    write: async (user, id) => {
      const row = await prisma.commissionRequest.findUnique({ where: { id }, select: { status: true, requestedById: true } });
      return !!row && row.status === 'DRAFT' && mayEdit(user, row);
    },
  },
);

// ── List ─────────────────────────────────────────────────────────────────────

/** The list's where-builder — the register, its cards and its paper read it. */
export function commissionListWhere(me: ResolvedUser, q: ReturnType<typeof listQuery>) {
  const base: Prisma.CommissionRequestWhereInput[] = [];
  const seesAll = me.isSuperAdmin || can(me, 'gfin.commissions.view_all');
  const mine = !seesAll || q.scope === 'mine';
  if (mine) base.push({ OR: [{ requestedById: me.id }, { shares: { some: { userId: me.id } } }] });
  if (q.filters.salesOrderId) base.push({ salesOrderId: q.filters.salesOrderId });
  if (q.filters.jobId) base.push({ jobId: q.filters.jobId });
  if (q.filters.requestedById) base.push({ requestedById: q.filters.requestedById });
  if (q.filters.teamId) base.push(q.filters.teamId === 'none' ? { teamId: null } : { teamId: q.filters.teamId });
  const from = filterDay(q.filters.dateFrom, 'From');
  const to = filterDay(q.filters.dateTo, 'To');
  if (from || to) base.push({ createdAt: { ...(from ? { gte: manilaDayStart(from) } : {}), ...(to ? { lte: manilaDayEnd(to) } : {}) } });
  if (q.search) {
    base.push({
      OR: [
        { number: { contains: q.search, mode: 'insensitive' } },
        { requestedBy: { name: { contains: q.search, mode: 'insensitive' } } },
        { salesOrder: { number: { contains: q.search, mode: 'insensitive' } } },
        { customer: { name: { contains: q.search, mode: 'insensitive' } } },
        { orNumbers: { contains: q.search, mode: 'insensitive' } },
      ],
    });
  }
  const ids = idsFilter(q.filters.ids);
  if (ids) base.push({ id: { in: ids } });
  const status = choice(q.filters.status, CommissionStatus, 'Status');
  const where: Prisma.CommissionRequestWhereInput = { AND: [...base, ...(status ? [{ status }] : [])] };
  return { base: { AND: base } as Prisma.CommissionRequestWhereInput, where, mine, status, from, to };
}

const SORTS = ['number', 'status', 'createdAt', 'totalNet'];

/** The owner's five cards, under everything but the status filter — each equals the list its link opens. */
async function commissionListSummary(base: Prisma.CommissionRequestWhereInput) {
  const [paid, pending, active, teams, margins] = await Promise.all([
    prisma.commissionRequest.aggregate({ where: { AND: [base, { status: 'PAID' }] }, _sum: { grossCommission: true }, _count: true }),
    prisma.commissionRequest.aggregate({ where: { AND: [base, { status: 'PENDING_APPROVAL' }] }, _sum: { grossCommission: true }, _count: true }),
    prisma.commissionRequest.count({ where: { AND: [base, { status: { in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'] } }] } }),
    prisma.commissionRequest.findMany({ where: { AND: [base, { status: { not: 'CANCELLED' } }, { teamId: { not: null } }] }, distinct: ['teamId'], select: { teamId: true } }),
    prisma.commissionRequest.aggregate({ where: { AND: [base, { status: { not: 'CANCELLED' } }] }, _sum: { margin: true, netOfVat: true } }),
  ]);
  const margin = num(margins._sum.margin);
  const net = num(margins._sum.netOfVat);
  return {
    paid: cents(num(paid._sum.grossCommission)),
    paidCount: paid._count,
    pending: cents(num(pending._sum.grossCommission)),
    pendingCount: pending._count,
    active,
    teams: teams.length,
    /** The margin over the net of VAT, weighted by value — null with nothing to weigh. */
    avgMarginPct: net > 0 ? Math.round((margin / net) * 10000) / 100 : null,
  };
}

commissionRoutes.get(
  '/',
  requireAny(...VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const { base, where } = commissionListWhere(me, q);
    const [rows, total, summary] = await Promise.all([
      prisma.commissionRequest.findMany({ where, include: requestInclude, orderBy: orderBy(q, SORTS, { createdAt: 'desc' }), skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      prisma.commissionRequest.count({ where }),
      commissionListSummary(base),
    ]);
    const steps = await openSteps(DOC, rows.filter((r) => r.status === 'PENDING_APPROVAL').map((r) => r.id));
    res.json({
      ...listResult(
        rows.map((r) => ({
          id: r.id,
          number: r.number,
          status: r.status,
          stage: stageWords(r.status, steps.get(r.id), false),
          requestedBy: r.requestedBy,
          team: r.team,
          salesOrder: { id: r.salesOrder.id, number: r.salesOrder.number },
          customer: r.customer,
          commissionType: r.commissionType,
          people: r.shares.length,
          grossCommission: num(r.grossCommission),
          totalNet: num(r.totalNet),
          createdAt: r.createdAt,
        })),
        total,
        q,
      ),
      summary,
    });
  }),
);

/** The register on paper. Above `/:id`. */
commissionRoutes.get(
  '/pdf',
  requireAny(...VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const { where, mine, status, from, to } = commissionListWhere(me, q);
    const [rows, count, order] = await Promise.all([
      prisma.commissionRequest.findMany({ where, include: requestInclude, orderBy: orderBy(q, SORTS, { createdAt: 'desc' }), take: LIST_CAP }),
      prisma.commissionRequest.count({ where }),
      recordNamed('sales order', q.filters.salesOrderId),
    ]);
    const currency = await companyCurrency();
    const reference = listReference(count, rows.length, ['commission request', 'commission requests'], [
      q.search && `search "${q.search}"`,
      status && `status ${statusLabel(status)}`,
      order,
      rangeNamed('requested', from ?? undefined, to ?? undefined),
      mine && 'mine',
      q.filters.ids && 'the rows selected',
    ]);
    const closed = rows.filter((r) => r.status === 'CANCELLED').length;
    const pdf = await renderDocument({
      title: 'Commission Requests',
      date: new Date(),
      reference,
      landscape: true,
      sections: [
        {
          kind: 'table',
          head: ['RFC No.', 'Requester', 'Team', 'Sales order', 'Customer', 'Date requested', `Gross (${currency})`, `Net (${currency})`, 'Status'],
          rows: rows.map((r) => [
            r.number,
            r.requestedBy.name,
            r.team?.code ?? '',
            r.salesOrder.number,
            r.customer.name,
            formatShortDate(r.createdAt),
            r.status === 'CANCELLED' ? `(${formatAmount(num(r.grossCommission))})` : formatAmount(num(r.grossCommission)),
            r.status === 'CANCELLED' ? `(${formatAmount(num(r.totalNet))})` : formatAmount(num(r.totalNet)),
            statusLabel(r.status),
          ]),
        },
        {
          kind: 'totals',
          rows: [
            {
              label: 'Total gross commission',
              value: formatMoney(cents(rows.filter((r) => r.status !== 'CANCELLED').reduce((s, r) => s + num(r.grossCommission), 0)), currency),
              bold: true,
            },
          ],
        },
        ...(closed ? [{ kind: 'text' as const, body: `${closed} cancelled request${closed === 1 ? '' : 's'} in brackets, not counted.` }] : []),
      ],
    });
    await audit({ entityType: DOC, entityId: 'list', action: 'EXPORTED', summary: `Exported the commission requests as PDF (${rows.length})` }, req);
    sendListPdf(res, pdf, 'commissions.pdf');
  }),
);

/** Fully collected issued orders the caller may raise a commission on, with none standing. Above `/:id`. */
commissionRoutes.get(
  '/eligible-orders',
  require_('gfin.commissions.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = String(req.query.q ?? '').trim();
    const candidates = await prisma.salesOrder.findMany({
      where: {
        status: 'ISSUED',
        commissionRequests: { none: { status: { in: STANDING } } },
        invoices: { some: { status: 'PAID' }, none: { status: { in: ['DRAFT', 'ISSUED', 'PARTIALLY_PAID'] } } },
        ...(q ? { OR: [{ number: { contains: q, mode: 'insensitive' } }, { customer: { name: { contains: q, mode: 'insensitive' } } }] } : {}),
      },
      orderBy: { orderDate: 'desc' },
      take: 100,
      select: { id: true, number: true, orderDate: true, total: true, vatAmount: true, customer: { select: { name: true } }, invoices: { where: { status: { not: 'CANCELLED' } }, select: { grossAmount: true } } },
    });
    const out = [];
    for (const o of candidates) {
      const invoiced = o.invoices.reduce((s, i) => s + num(i.grossAmount), 0);
      if (invoiced + 0.005 < orderNet(o)) continue;
      if (!(await mayRaiseCommission(me, o.id))) continue;
      out.push({ id: o.id, number: o.number, orderDate: o.orderDate, customer: o.customer.name, total: num(o.total) });
      if (out.length >= 50) break;
    }
    res.json(out);
  }),
);

/** What a request is raised FROM: the order's breakdown, its collection, its people and their open advances. Above `/:id`. */
commissionRoutes.get(
  '/source',
  requireAny('gfin.commissions.create', 'gfin.commissions.edit_own', 'gfin.commissions.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const salesOrderId = String(req.query.salesOrderId ?? '');
    if (!salesOrderId) throw badRequest('Which sales order?');
    const exceptId = req.query.requestId ? String(req.query.requestId) : undefined;
    const src = await orderSource(salesOrderId);
    const standing = await prisma.commissionRequest.findFirst({
      where: { salesOrderId, status: { in: STANDING }, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { number: true },
    });
    const people = await dealPeople(src);
    const extra = String(req.query.userIds ?? '').split(',').filter(Boolean);
    const advances = await openAdvances([...new Set([...people.map((p) => p.id), ...extra])], exceptId);
    res.json({
      salesOrder: { id: src.order.id, number: src.order.number, orderDate: src.order.orderDate, status: src.order.status },
      quotation: { id: src.order.quotation.id, number: src.order.quotation.number, subject: src.order.quotation.subject },
      customer: src.order.customer,
      job: src.job && { id: src.job.id, number: src.job.number, name: src.job.name },
      salesperson: src.order.quotation.owner && { id: src.order.quotation.owner.id, name: src.order.quotation.owner.name },
      team: src.team,
      ...src.figures,
      margin: cents(src.figures.collectedAmount - src.figures.vatAmount - src.figures.totalCost),
      fullyCollected: src.fully,
      orNumbers: src.orNumbers,
      collectedOn: src.collectedOn,
      invoices: src.order.invoices.map((i) => ({ id: i.id, number: i.number, status: i.status, netCollectible: num(i.netCollectible), amountCollected: num(i.amountCollected) })),
      problem: src.problem ?? (standing ? `${src.order.number} already has commission request ${standing.number}` : null),
      mayRaise: await mayRaiseCommission(me, salesOrderId),
      people: people.map((p) => ({ ...p, openAdvances: advances.get(p.id) ?? [] })),
      advances: Object.fromEntries(extra.map((id) => [id, advances.get(id) ?? []])),
    });
  }),
);

// ── One ──────────────────────────────────────────────────────────────────────

commissionRoutes.get(
  '/:id',
  requireAnyOrDecider(...VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await loadVisible(me, req.params.id, res.locals.deciderOnly === true);
    res.json(await present(me, row));
  }),
);

const sheetSchema = z.object({
  salesOrderId: z.string().min(1, 'Which sales order is the commission on?'),
  commissionType: z.enum(['INDIVIDUAL', 'GROUP']).default('INDIVIDUAL'),
  ratePct: z.number().gt(0, 'Give the commission rate').max(1, 'A rate is at most 100%'),
  notes: z.string().trim().max(5000).optional().nullable(),
  shares: z
    .array(
      z.object({
        userId: z.string().min(1, 'Who is it for?'),
        position: z.string().trim().max(120).optional().nullable(),
        sharePct: z.number().gt(0, 'A share must be more than 0%').max(1),
        taxPct: z.number().min(0).max(1).default(0.1),
        caDeduction: z.number().min(0).default(0),
        cashAdvanceId: z.string().optional().nullable(),
      }),
    )
    .min(1, 'Add the person the commission is for')
    .max(30),
});

/**
 * The sheet a draft may carry, checked before anything is written: the order
 * issued, fully collected and with no other standing request; the people
 * real, active and named once; an INDIVIDUAL request one person at 100%; the
 * shares adding up to 100%; each cash advance deduction against one of the
 * person's open repayable advances and within what is free on it; no net
 * below zero. Returns the figures to store.
 */
async function checkSheet(body: z.infer<typeof sheetSchema>, exceptRequestId?: string) {
  const src = await orderSource(body.salesOrderId);
  if (src.problem) throw badRequest(src.problem);
  const ids = body.shares.map((s) => s.userId);
  if (new Set(ids).size !== ids.length) throw badRequest('A person is named twice — give them one line');
  if (body.commissionType === 'INDIVIDUAL' && body.shares.length !== 1) throw badRequest('An individual commission is for one person — choose Group allocation to split it');
  const users = await prisma.user.findMany({ where: { id: { in: ids }, isActive: true }, select: { id: true, name: true, position: true } });
  for (const s of body.shares) if (!users.find((u) => u.id === s.userId)) throw badRequest('One of the people is not an active login');
  const advances = await openAdvances(ids, exceptRequestId);
  const shares = body.shares.map((s) => {
    const user = users.find((u) => u.id === s.userId)!;
    let cashAdvanceId: string | null = null;
    if (s.caDeduction > 0.004) {
      const open = advances.get(s.userId) ?? [];
      const advance = s.cashAdvanceId ? open.find((a) => a.id === s.cashAdvanceId) : open.find((a) => a.free > 0.005);
      if (!advance) throw badRequest(`${user.name} has no open cash advance to deduct from`);
      if (s.caDeduction > advance.free + 0.005) {
        throw badRequest(`${user.name}'s ${advance.number} has ${formatAmount(advance.free)} left to repay${advance.reserved > 0 ? ' after other commissions’ deductions' : ''} — the deduction is ${formatAmount(s.caDeduction)}`);
      }
      cashAdvanceId = advance.id;
    }
    return { ...s, user, cashAdvanceId };
  });
  const figures = commissionFigures({
    totalAmount: src.figures.totalAmount,
    vatAmount: src.figures.vatAmount,
    totalCost: src.figures.totalCost,
    collectedAmount: src.figures.collectedAmount,
    ratePct: body.ratePct,
    shares: shares.map((s) => ({ sharePct: s.sharePct, taxPct: s.taxPct, caDeduction: s.caDeduction })),
  });
  if (!figures.sharesComplete) throw badRequest('The shares must add up to 100%');
  figures.shares.forEach((f, i) => {
    if (f.net < -0.004) throw badRequest(`${shares[i].user.name}'s deductions are more than their share`);
  });
  const quotationOwner = src.order.quotation.owner;
  return {
    src,
    shares,
    figures,
    header: {
      salesOrderId: src.order.id,
      customerId: src.order.customerId,
      jobId: src.job?.id ?? null,
      salespersonId: quotationOwner?.id ?? null,
      teamId: src.team?.id ?? null,
      commissionType: body.commissionType,
      ratePct: D(body.ratePct),
      totalAmount: D(src.figures.totalAmount),
      netOfVat: D(figures.netOfVat),
      vatAmount: D(src.figures.vatAmount),
      totalCost: D(src.figures.totalCost),
      margin: D(figures.margin),
      collectedAmount: D(src.figures.collectedAmount),
      grossCommission: D(figures.grossCommission),
      totalTax: D(figures.totalTax),
      totalCa: D(figures.totalCa),
      totalNet: D(figures.totalNet),
      orNumbers: src.orNumbers.join(', ') || null,
      collectedOn: src.collectedOn,
      notes: body.notes || null,
    },
  };
}

const shareRows = (checked: Awaited<ReturnType<typeof checkSheet>>) =>
  checked.shares.map((s, i) => ({
    userId: s.userId,
    position: s.position?.trim() || s.user.position || null,
    sharePct: D(s.sharePct),
    share: D(checked.figures.shares[i].share),
    taxPct: D(s.taxPct),
    tax: D(checked.figures.shares[i].tax),
    caDeduction: D(checked.figures.shares[i].caDeduction),
    cashAdvanceId: s.cashAdvanceId,
    net: D(checked.figures.shares[i].net),
    sortOrder: i,
  }));

commissionRoutes.post(
  '/',
  require_('gfin.commissions.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(sheetSchema, req.body);
    if (!(await mayRaiseCommission(me, body.salesOrderId))) {
      throw forbidden('Only the salesperson who holds the sales order, or their Team Leader, can raise its commission');
    }
    const checked = await checkSheet(body);
    const made = await prisma.$transaction(async (tx) => {
      // One standing request per sales order, decided under a lock on the order's row.
      await tx.$queryRaw`SELECT id FROM "SalesOrder" WHERE id = ${body.salesOrderId} FOR UPDATE`;
      const standing = await tx.commissionRequest.findFirst({ where: { salesOrderId: body.salesOrderId, status: { in: STANDING } }, select: { number: true } });
      if (standing) throw badRequest(`${checked.src.order.number} already has commission request ${standing.number}`);
      return tx.commissionRequest.create({
        data: { number: await nextNumber('commission_request', tx), ...checked.header, requestedById: me.id, shares: { create: shareRows(checked) } },
      });
    });
    await audit({ entityType: DOC, entityId: made.id, action: 'CREATED', summary: `Raised ${made.number} on ${checked.src.order.number} — ${formatAmount(checked.figures.grossCommission)} gross for ${checked.shares.length} ${checked.shares.length === 1 ? 'person' : 'people'}` }, req);
    res.status(201).json(await present(me, await loadVisible(me, made.id)));
  }),
);

commissionRoutes.put(
  '/:id',
  requireAny('gfin.commissions.edit_own', 'gfin.commissions.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(sheetSchema.extend({ version: z.string().optional() }), req.body);
    const row = await loadVisible(me, req.params.id);
    if (!mayEdit(me, row)) throw forbidden('Only the person who raised this request can change it');
    if (row.status !== 'DRAFT') throw badRequest('Only a draft can be changed — pull it back first');
    if (body.salesOrderId !== row.salesOrderId) throw badRequest('The sales order a commission is on does not change — cancel it and raise another');
    const checked = await checkSheet(body, row.id);
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.commissionRequest.updateMany({
        where: { id: row.id, status: 'DRAFT', ...(body.version ? { updatedAt: new Date(body.version) } : {}) },
        data: checked.header,
      });
      if (!claimed.count) throw badRequest('It changed a moment ago — reload');
      await tx.commissionShare.deleteMany({ where: { requestId: row.id } });
      await tx.commissionShare.createMany({ data: shareRows(checked).map((s) => ({ ...s, requestId: row.id })) });
    });
    await audit({ entityType: DOC, entityId: row.id, action: 'UPDATED', summary: `${row.number} changed — ${formatAmount(checked.figures.grossCommission)} gross` }, req);
    res.json(await present(me, await loadVisible(me, row.id)));
  }),
);

/** Submitting: re-checked against the order as it stands, claimed on DRAFT, filed in the requester's name; back to DRAFT if the engine refuses. */
commissionRoutes.post(
  '/:id/submit',
  requireAny('gfin.commissions.create', 'gfin.commissions.edit_own', 'gfin.commissions.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await loadVisible(me, req.params.id);
    if (!mayEdit(me, row)) throw forbidden('Only the person who raised this request can submit it');
    if (row.status !== 'DRAFT') throw badRequest('This request has already been submitted');
    await checkSheet(
      {
        salesOrderId: row.salesOrderId,
        commissionType: row.commissionType,
        ratePct: num(row.ratePct),
        notes: row.notes,
        shares: row.shares.map((s) => ({ userId: s.userId, position: s.position, sharePct: num(s.sharePct), taxPct: num(s.taxPct), caDeduction: num(s.caDeduction), cashAdvanceId: s.cashAdvanceId })),
      },
      row.id,
    );
    const claimed = await prisma.commissionRequest.updateMany({ where: { id: row.id, status: 'DRAFT', updatedAt: row.updatedAt }, data: { status: 'PENDING_APPROVAL', submittedAt: new Date() } });
    if (!claimed.count) throw badRequest('It changed a moment ago — reload');
    try {
      await submitForApproval({
        documentType: DOC,
        documentId: row.id,
        documentNumber: row.number,
        subject: `${row.customer.name} — commission on ${row.salesOrder.number}`,
        amount: num(row.grossCommission),
        link: COMMISSION_LINK(row.id),
        requesterId: row.requestedById,
        jobId: row.jobId ?? undefined,
      });
    } catch (err) {
      await prisma.commissionRequest.updateMany({ where: { id: row.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT', submittedAt: null } });
      throw err;
    }
    await audit({ entityType: DOC, entityId: row.id, action: 'SUBMITTED', summary: `${row.number} submitted for approval` }, req);
    res.json(await present(me, await loadVisible(me, row.id)));
  }),
);

commissionRoutes.post(
  '/:id/withdraw',
  requireAny('gfin.commissions.create', 'gfin.commissions.edit_own', 'gfin.commissions.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await loadVisible(me, req.params.id);
    if (!mayEdit(me, row)) throw forbidden('Only the person who raised this request can pull it back');
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.commissionRequest.updateMany({ where: { id: row.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
      if (!claimed.count) throw badRequest('It was decided a moment ago — the decision stands');
      await cancelOpenRequest(DOC, row.id, tx, `pulled back by ${me.name}`, me.id);
    });
    await audit({ entityType: DOC, entityId: row.id, action: 'UPDATED', summary: `${row.number} pulled back to draft` }, req);
    res.json(await present(me, await loadVisible(me, row.id)));
  }),
);

commissionRoutes.post(
  '/:id/cancel',
  requireAny('gfin.commissions.create', 'gfin.commissions.edit_own', 'gfin.commissions.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(z.object({ reason: z.string().trim().min(3, 'Say why').max(500) }), req.body ?? {});
    const row = await loadVisible(me, req.params.id);
    if (!mayEdit(me, row)) throw forbidden('Only the person who raised this request can cancel it');
    if (row.status !== 'DRAFT' && row.status !== 'PENDING_APPROVAL') throw badRequest(`This request is ${statusLabel(row.status).toLowerCase()} — it cannot be cancelled`);
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.commissionRequest.updateMany({ where: { id: row.id, status: row.status }, data: { status: 'CANCELLED', cancelReason: body.reason } });
      if (!claimed.count) throw badRequest('It moved a moment ago — reload to see where it stands');
      await cancelOpenRequest(DOC, row.id, tx, `cancelled by ${me.name}: ${body.reason}`, me.id);
    });
    await audit({ entityType: DOC, entityId: row.id, action: 'CANCELLED', summary: `${row.number} cancelled — ${body.reason}` }, req);
    res.json(await present(me, await loadVisible(me, row.id)));
  }),
);

commissionRoutes.delete(
  '/:id',
  require_('gfin.commissions.delete'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await loadVisible(me, req.params.id);
    if (!mayEdit(me, row)) throw forbidden('That is someone else’s request');
    if (row.status !== 'DRAFT' && row.status !== 'CANCELLED') throw badRequest('Only a draft or a cancelled request can be deleted — an approved one is a record');
    await deleteOrRefuse(row.number, () => prisma.commissionRequest.delete({ where: { id: row.id } }));
    await deleteAttachmentsOf('commission_request', [row.id]);
    await audit({ entityType: DOC, entityId: row.id, action: 'DELETED', summary: `Deleted ${statusLabel(row.status).toLowerCase()} ${row.number}` }, req);
    res.json({ ok: true });
  }),
);

// ── Paying ───────────────────────────────────────────────────────────────────

const paySchema = z.object({
  paymentDate: z.string().optional(),
  method: z.enum(['CASH', 'CHECK', 'BANK_TRANSFER', 'ONLINE']).default('BANK_TRANSFER'),
  reference: z.string().trim().max(120).optional().nullable(),
  bank: z.string().trim().max(120).optional().nullable(),
});

/**
 * APPROVED → PAID, in ONE transaction: claimed on APPROVED; per beneficiary a
 * DISBURSEMENT voucher for their net, allocated to their share (none when
 * the net is nil), and their cash advance deduction recorded as a repayment
 * of that advance — a RECEIPT of method COMMISSION_DEDUCTION allocated to the
 * advance, checked against what it still owes, the advance re-derived by
 * `refreshAdvance()`. Money out is A/P's right: `gfin.ap.create`, with the
 * register's `view_all`.
 */
commissionRoutes.post(
  '/:id/pay',
  require_('gfin.ap.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    if (!mayPay(me)) throw forbidden('Paying a commission needs "gfin.ap.create" and "gfin.commissions.view_all"');
    const body = parseBody(paySchema, req.body ?? {});
    const row = await loadVisible(me, req.params.id);
    if (row.status !== 'APPROVED') throw badRequest(`${row.number} is ${statusLabel(row.status).toLowerCase()} — only an approved commission is paid`);
    const paymentDate = body.paymentDate ? dayKey(new Date(body.paymentDate)) : dayKey(new Date());
    if (Number.isNaN(paymentDate.getTime())) throw badRequest('Payment date is not a valid date');
    const vouchers: string[] = [];
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.commissionRequest.updateMany({ where: { id: row.id, status: 'APPROVED' }, data: { status: 'PAID', paidAt: new Date() } });
      if (!claimed.count) throw badRequest('It changed a moment ago — reload to see where it stands');
      for (const s of row.shares) {
        const ca = num(s.caDeduction);
        if (ca > 0.004) {
          if (!s.cashAdvanceId) throw badRequest(`${s.user.name}'s deduction names no cash advance`);
          const owed = await settleable('advance_refund', s.cashAdvanceId, tx);
          if (!owed || ca > owed.outstanding + 0.005) {
            throw badRequest(`${s.cashAdvance?.number ?? 'The advance'} has only ${formatAmount(owed?.outstanding ?? 0)} left to repay — ${s.user.name}'s deduction is ${formatAmount(ca)}. Pull the request back and change it.`);
          }
          await tx.payment.create({
            data: {
              number: await nextNumber('payment', tx),
              kind: 'RECEIPT',
              method: 'COMMISSION_DEDUCTION',
              paymentDate,
              payeeUserId: s.userId,
              amount: D(ca),
              clearedAt: paymentDate,
              notes: `Deducted from commission ${row.number}`,
              recordedById: me.id,
              allocations: { create: [{ advanceId: s.cashAdvanceId, amount: D(ca) }] },
            },
          });
          await refreshAdvance(tx, s.cashAdvanceId);
        }
        const net = num(s.net);
        if (net > 0.004) {
          const payment = await tx.payment.create({
            data: {
              number: await nextNumber('disbursement', tx),
              kind: 'DISBURSEMENT',
              method: body.method,
              paymentDate,
              payeeUserId: s.userId,
              amount: D(net),
              reference: body.reference || null,
              bank: body.bank || null,
              clearedAt: body.method === 'CHECK' ? null : paymentDate,
              notes: `Commission ${row.number} — ${row.salesOrder.number}`,
              recordedById: me.id,
              allocations: { create: [{ commissionShareId: s.id, amount: D(net) }] },
            },
          });
          await tx.commissionShare.update({ where: { id: s.id }, data: { paymentId: payment.id } });
          vouchers.push(payment.number);
        }
      }
    });
    await audit({ entityType: DOC, entityId: row.id, action: 'UPDATED', summary: `${row.number} paid — ${vouchers.length} voucher${vouchers.length === 1 ? '' : 's'}${vouchers.length ? ` (${vouchers.join(', ')})` : ''}, ${formatAmount(num(row.totalCa))} deducted from cash advances` }, req);
    await notify(
      row.shares.map((s) => ({
        userId: s.userId,
        type: 'system' as const,
        title: `Commission ${row.number} paid`,
        body: `${formatAmount(num(s.net))} paid to you${num(s.caDeduction) > 0 ? `, ${formatAmount(num(s.caDeduction))} applied to ${s.cashAdvance?.number ?? 'your cash advance'}` : ''}.`,
        link: COMMISSION_LINK(row.id),
      })),
    );
    res.json(await present(me, await loadVisible(me, row.id)));
  }),
);

// ── Settle ───────────────────────────────────────────────────────────────────

/**
 * Applied only while still PENDING_APPROVAL (a conditional claim), so a
 * decision after a pull-back or a cancel changes nothing and the trail says
 * so. Approved: APPROVED, and finance is told it is ready to pay. Returned or
 * rejected: back to DRAFT. Exported so a test can call it twice.
 */
export async function settleCommission(approval: ApprovalRequest, outcome: ApprovalOutcome) {
  const row = await prisma.commissionRequest.findUnique({ where: { id: approval.documentId }, select: { id: true, number: true, status: true, requestedById: true } });
  if (!row) return;
  if (outcome !== 'APPROVED') {
    const claimed = await prisma.commissionRequest.updateMany({ where: { id: row.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
    await audit({ entityType: DOC, entityId: row.id, action: outcome, summary: claimed.count ? `${row.number} returned to draft` : `${row.number} ${outcome.toLowerCase()} after it was ${statusLabel(row.status).toLowerCase()} — not applied` });
    return;
  }
  const claimed = await prisma.commissionRequest.updateMany({ where: { id: row.id, status: 'PENDING_APPROVAL' }, data: { status: 'APPROVED', approvedAt: new Date() } });
  if (!claimed.count) {
    await audit({ entityType: DOC, entityId: row.id, action: 'APPROVED', summary: `${row.number} approved after it was ${statusLabel(row.status).toLowerCase()} — not applied` });
    return;
  }
  await audit({ entityType: DOC, entityId: row.id, action: 'APPROVED', summary: `${row.number} approved — ready to pay` });
  const payers = (await usersHolding('gfin.ap.create')).filter((id) => id !== row.requestedById);
  await notify([
    { userId: row.requestedById, type: 'system', title: `${row.number} approved`, body: 'Finance pays it next.', link: COMMISSION_LINK(row.id) },
    ...payers.map((userId) => ({ userId, type: 'system' as const, title: `Commission ${row.number} is ready to pay`, body: 'Approved by the Finance Manager and the CEO / President.', link: COMMISSION_LINK(row.id) })),
  ]);
}
onApprovalSettled(DOC, settleCommission);

/** Pulled back after approval: back to DRAFT — refused once paid (the money has gone). */
onApprovalReopened(DOC, {
  may: async (actor, id) => {
    const row = await prisma.commissionRequest.findUnique({ where: { id }, select: { status: true, requestedById: true } });
    return !!row && row.status === 'APPROVED' && mayEdit(actor, row);
  },
  reopen: async ({ documentId, tx, actor }) => {
    const row = await tx.commissionRequest.findUnique({ where: { id: documentId }, select: { id: true, number: true, status: true } });
    if (!row) throw notFound('Commission request not found');
    if (row.status === 'PAID') throw badRequest(`${row.number} has been paid — its vouchers stand, so it cannot be pulled back`);
    if (row.status !== 'APPROVED') throw badRequest(`${row.number} is ${statusLabel(row.status).toLowerCase()} — only an approved request can be pulled back`);
    const claimed = await tx.commissionRequest.updateMany({ where: { id: row.id, status: 'APPROVED' }, data: { status: 'DRAFT', approvedAt: null } });
    if (!claimed.count) throw badRequest(`${row.number} changed a moment ago — reload to see where it stands`);
    await audit({ entityType: DOC, entityId: row.id, action: 'UPDATED', summary: `${row.number} back to draft after approval`, actorId: actor.id, actorName: actor.name }, undefined, tx);
  },
});

// ── The paper ────────────────────────────────────────────────────────────────

/**
 * "Commission Request" through `renderDocument`: the order and its
 * collection, the financial breakdown with the owner's banner, the
 * beneficiaries table, the totals, then Requested by and one sign-off per
 * step of its route; files behind unless `?attachments=0`.
 */
commissionRoutes.get(
  '/:id/pdf',
  requireAnyOrDecider(...VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await loadVisible(me, req.params.id, res.locals.deciderOnly === true);
    const currency = await companyCurrency();
    const slots =
      row.status === 'DRAFT'
        ? await approvalSlots(DOC, row.id, { amount: num(row.grossCommission), requesterId: row.requestedById, jobId: row.jobId ?? undefined })
        : await approvalSlots(DOC, row.id);
    const requester = { name: row.requestedBy.name, ...(await contactOf(row.requestedById)) };
    const signatories: Signatory[] = [{ role: 'Requested by', ...requester, at: preparedAt(slots) ?? row.createdAt }, ...slotSignatories(slots)];
    const m = (v: Prisma.Decimal) => formatMoney(num(v), currency);
    const sections: PdfSection[] = [
      {
        kind: 'fields',
        columns: 3,
        fields: [
          { label: 'Company name', value: row.customer.name },
          { label: 'Sales order', value: row.salesOrder.number },
          { label: 'Sales personnel', value: row.salesperson?.name ?? '' },
          { label: 'Sales order date', value: formatDate(row.salesOrder.orderDate) },
          { label: 'Date of collection', value: row.collectedOn ? formatDate(row.collectedOn) : '' },
          { label: 'OR No.', value: row.orNumbers ?? '' },
          { label: 'Project', value: row.job ? `${row.job.number} — ${row.job.name}` : '' },
          { label: 'Team', value: row.team?.code ?? '' },
          { label: 'Commission type', value: row.commissionType === 'GROUP' ? 'Group allocation' : 'Individual' },
        ],
      },
      { kind: 'text', title: 'Sales order financial breakdown', body: `Actual margin = total collected (${formatAmount(num(row.collectedAmount))}) − VAT (${formatAmount(num(row.vatAmount))}) − total cost (${formatAmount(num(row.totalCost))}) = ${formatAmount(num(row.margin))}. Gross commission = ${(num(row.ratePct) * 100).toFixed(2).replace(/\.?0+$/, '')}% of the margin. Total net commission = commission share − tax deduction − cash advance.` },
      {
        kind: 'totals',
        rows: [
          { label: 'Total amount', value: m(row.totalAmount) },
          { label: 'Amount net of VAT', value: m(row.netOfVat) },
          { label: 'VAT amount', value: m(row.vatAmount) },
          { label: 'Total cost', value: m(row.totalCost) },
          { label: 'Collected amount', value: m(row.collectedAmount) },
          { label: 'Actual margin', value: m(row.margin), bold: true },
        ],
      },
      {
        kind: 'table',
        title: 'Commission beneficiaries and deductions',
        head: ['Beneficiary', 'Share %', `Comm. share (${currency})`, `Tax deduction (${currency})`, `CA deduction (${currency})`, `Total net (${currency})`],
        rows: [
          ...row.shares.map((s) => [
            { title: s.user.name, body: [s.position, s.cashAdvance ? `CA ${s.cashAdvance.number}` : null].filter(Boolean).join(' · ') },
            `${(num(s.sharePct) * 100).toFixed(2)}%`,
            formatAmount(num(s.share)),
            `${formatAmount(num(s.tax))} (${(num(s.taxPct) * 100).toFixed(0)}%)`,
            formatAmount(num(s.caDeduction)),
            formatAmount(num(s.net)),
          ]),
        ],
      },
      {
        kind: 'totals',
        rows: [
          { label: 'Gross commission', value: m(row.grossCommission) },
          { label: 'Less: tax deduction', value: m(row.totalTax) },
          { label: 'Less: cash advance', value: m(row.totalCa) },
          { label: 'Total net commission', value: m(row.totalNet), bold: true },
        ],
      },
    ];
    if (row.notes) sections.push({ kind: 'text', title: 'Notes', body: row.notes });
    if (row.status === 'CANCELLED' && row.cancelReason) sections.push({ kind: 'text', title: 'Cancelled', body: row.cancelReason });
    const bare = await renderDocument({ title: 'Commission Request', documentNumber: row.number, date: row.createdAt, reference: row.customer.name, sections, signatories });
    const files = req.query.attachments === '0' ? [] : await attachedFiles('commission_request', row.id);
    const { pdf, listed } = await withAttachments(bare, files, { title: 'Commission Request', number: row.number, reference: row.customer.name });
    await audit({ entityType: DOC, entityId: row.id, action: 'EXPORTED', summary: `Printed ${row.number}${listed ? ` with ${listed} attachment${listed === 1 ? '' : 's'}` : ''}` }, req);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition(paperFileName({ kind: 'Commission Request', number: row.number, author: row.requestedBy.name, date: row.createdAt })));
    res.send(pdf);
  }),
);

registerSearch({
  kind: DOC,
  label: 'Commission requests',
  permission: VIEW,
  ownWhere: (user) => ({ OR: [{ requestedById: user.id }, { shares: { some: { userId: user.id } } }] }),
  async search(term, _user, limit, own) {
    const rows = await prisma.commissionRequest.findMany({
      where: {
        ...((own ?? {}) as Prisma.CommissionRequestWhereInput),
        AND: [{ OR: [{ number: { contains: term, mode: 'insensitive' } }, { salesOrder: { number: { contains: term, mode: 'insensitive' } } }, { customer: { name: { contains: term, mode: 'insensitive' } } }] }],
      },
      select: { id: true, number: true, status: true, salesOrder: { select: { number: true } }, customer: { select: { name: true } } },
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({ kind: DOC, id: r.id, title: `${r.number} — ${r.salesOrder.number}`, subtitle: `${r.customer.name} · ${statusLabel(r.status).toLowerCase()}`, link: COMMISSION_LINK(r.id) }));
  },
});

