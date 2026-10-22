import { Router } from 'express';
import { z } from 'zod';
import {
  Prisma,
  InvoiceStatus,
  BillStatus,
  ExpenseStatus,
  PaymentKind,
  PaymentMethod,
  type ApprovalRequest,
} from '@prisma/client';
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
  conflict,
  type ListQuery,
} from '../http/kit';
import { authenticate, require_, requireAny, currentUser } from '../auth/middleware';
import { can, canEditRecord, type ResolvedUser } from '../permissions/resolve';
import { requireView, requireEdit, ownOnly, assertCanView, assertCanEdit, mayEdit } from '../shared/ownScope';
import { registerAttachmentGuard, deleteAttachmentsOf } from '../shared/attachments';
import { assertSiNumberFree } from '../shared/siNumbers';
import { audit } from '../shared/audit';
import { nextNumber } from '../shared/numbering';
import { notify } from '../shared/notifications';
import {
  submitForApproval,
  onApprovalSettled,
  onApprovalReopened,
  routeBrief,
  approvalSlots, preparedAt,
  slotSignatories,
  contactOf,
  contactsOf,
  cancelOpenRequest,
  openSteps,
  stageWords,
  type ApprovalOutcome,
} from '../shared/approvals';
import { postJobCost } from '../shared/inventory';
import { assertOrderLeft, billingForInvoiceInclude, createInvoiceFromBilling } from '../shared/billingInvoice';
import {
  LIST_CAP,
  listReference,
  bracketed,
  totalLabel,
  counted,
  bracketNote,
  listNotes,
  recordNamed,
  rangeNamed,
  filterDay,
  dayOf,
  choice,
  sendListPdf,
  ratePct,
} from '../shared/listPaper';
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
  cents,
  D,
  num,
  taxBreakdown,
  currentRates,
  financeSettings,
  saveFinanceSettings,
  addDays,
  dayKey,
  daysBetween,
  settleable,
  refreshSettlement,
  withheldOn,
  refreshAdvance,
  refreshBudgetRequest,
  claimPayable,
  liquidatedReleased,
  LIQUIDATION_SOURCES,
  LIVE_MONEY,
  financePosition,
  bucketFor,
  summarise,
  type AgedRow,
  type SettleableKind,
} from '../shared/finance';
import { contentDisposition, paperFileName } from '../shared/paperName';
import { attachedFiles, withAttachments } from '../shared/pdfAttachments';
import { teamShares, TEAM_REF_SELECT, USER_TEAM_SELECT, teamOfUser, userTeamWhere, visibleOwners } from '../shared/team';
import { BILL_PAYABLE, DUE_SOON_DAYS, billDueDate, billTermsLabel, dueSoonWhere } from '../shared/payables';
import {
  TERMS_CHOICES,
  AWAITING_COUNTER_WHERE,
  daysLate,
  expectedCollection,
  invoiceCredit,
  isOverdue,
  overdueWhere,
  parseTermsDays,
  termsLabel,
} from '../shared/receivables';

function asDate(value: string, label: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw badRequest(`${label} is not a valid date`);
  return dayKey(date);
}

// ── On paper (rule 6) ────────────────────────────────────────────────


/**
 * A cash advance and a budget request on paper. They are one document in
 * structure — cash asked for, approved, released, spent and accounted for —
 * so both print the same sections through this one builder: the request,
 * its purpose, the money as the quotation's totals block (the last row, in
 * bold, is where it stands now), the liquidation that accounts for it, the
 * notes. A section a module adds of its own (a cancellation's reason) goes
 * after these.
 */
export function cashRequestSections(input: {
  requestedBy: string;
  neededBy: Date | null;
  project: string;
  budgetLine: string;
  status: string;
  purpose: string;
  release: { number: string; paymentDate: Date } | null;
  liquidationDueDate: Date | null;
  liquidated: boolean;
  figures: { amount: number; amountReleased: number; spent: number; excessDue: number; refundDue: number; amountRefunded: number };
  /** The live liquidation; `amountPaid` is what has been reimbursed on it — an excess is paid there. */
  liquidation: { number: string; status: string; total: number; amountPaid: number } | null;
  notes: string | null;
  currency: string;
}): PdfSection[] {
  const { figures: f, currency } = input;
  const money = (n: number) => formatMoney(n, currency);
  const totals: PdfTotal[] = [{ label: 'Amount requested', value: money(f.amount) }];
  if (input.release) totals.push({ label: 'Released', value: money(f.amountReleased) });
  if (input.liquidated) {
    totals.push({ label: 'Spent (per liquidation)', value: money(f.spent) });
    if (f.excessDue > 0) {
      // Spending beyond the cash is owed to the requester ON THE LIQUIDATION
      // REPORT, never on this document: what that claim has reimbursed comes
      // off, so a paid excess reads nothing still owed.
      const reimbursed = input.liquidation?.amountPaid ?? 0;
      totals.push(
        { label: 'Excess spent', value: money(f.excessDue) },
        {
          label: input.liquidation ? `Less: reimbursed on ${input.liquidation.number}` : 'Less: reimbursed',
          value: money(reimbursed),
        },
        { label: 'Still owed to requester', value: money(cents(Math.max(0, f.excessDue - reimbursed))) },
      );
    } else {
      totals.push({ label: 'Unspent — owed back', value: money(f.refundDue) });
      if (f.refundDue > 0) {
        totals.push(
          { label: 'Less: refunded', value: money(f.amountRefunded) },
          { label: 'Still to refund', value: money(cents(Math.max(0, f.refundDue - f.amountRefunded))) },
        );
      }
    }
  }
  totals[totals.length - 1].bold = true;

  const sections: PdfSection[] = [
    {
      kind: 'fields',
      columns: 3,
      fields: [
        { label: 'Requested by', value: input.requestedBy },
        { label: 'Needed by', value: input.neededBy ? formatDate(input.neededBy) : '—' },
        { label: 'Status', value: statusLabel(input.status) },
        { label: 'Project', value: input.project },
        { label: 'Budget line', value: input.budgetLine },
        {
          label: 'Released',
          value: input.release ? `${input.release.number}, ${formatDate(input.release.paymentDate)}` : 'Not yet released',
        },
        { label: 'Liquidate by', value: input.liquidationDueDate ? formatDate(input.liquidationDueDate) : '—' },
      ],
    },
    { kind: 'text', title: 'Purpose', body: input.purpose },
    { kind: 'totals', rows: totals },
  ];
  if (input.liquidation) {
    sections.push({
      kind: 'fields',
      title: 'Liquidation',
      columns: 3,
      fields: [
        { label: 'Report', value: input.liquidation.number },
        { label: 'Status', value: statusLabel(input.liquidation.status) },
        { label: 'Total receipts', value: money(input.liquidation.total) },
      ],
    });
  }
  if (input.notes) sections.push({ kind: 'text', title: 'Notes', body: input.notes });
  return sections;
}

/**
 * Whether an approval may still come to a finance document — a draft, or
 * one pending — so that, with no workflow covering it, its paper prints one
 * open "Approved by". Past that (approved, released, refused, withdrawn) a
 * document with no route on file prints no approval line rather than an
 * empty one.
 */
const awaitsApproval = (status: string) => status === 'DRAFT' || status === 'PENDING_APPROVAL';

/**
 * The sign-offs of a cash advance or a budget request: whoever asked, dated
 * when they asked; every step of the route through the engine's one mapping
 * (`approvalSlots` — a draft, a pulled-back one too, prints the route it
 * would take, with the project for a PROJECT_MANAGER step; a refused or
 * withdrawn one only the steps that did sign); and, once the cash is out,
 * the requester again as "Received by", dated when the release was recorded
 * (a voucher's own date is a DATE, which has no time to print). Nothing for
 * a receipt that has not happened.
 */
export async function cashRequestSignatories(input: {
  documentType: 'cash_advance' | 'budget_request';
  id: string;
  status: string;
  amount: number;
  requester: { id: string; name: string };
  jobId: string | null;
  raisedAt: Date;
  releasedOn: Date | null;
}): Promise<Signatory[]> {
  const requester = { name: input.requester.name, ...(await contactOf(input.requester.id)) };
  const slots = await approvalSlots(
    input.documentType,
    input.id,
    input.status === 'DRAFT' ? { amount: input.amount, requesterId: input.requester.id, jobId: input.jobId } : undefined,
  );
  return [
    // One timestamp per person: a preparer who signed a step at submit (a
    // Team Leader's own budget request) prints that instant here too.
    { role: 'Requested by', ...requester, at: preparedAt(slots) ?? input.raisedAt },
    ...(slots.length ? slotSignatories(slots) : awaitsApproval(input.status) ? [{ role: 'Approved by' }] : []),
    ...(input.releasedOn ? [{ role: 'Received by', ...requester, at: input.releasedOn }] : []),
  ];
}

// ════════════════════════════════════════════════════════════════════
//  ACCOUNTS RECEIVABLE — invoices
// ════════════════════════════════════════════════════════════════════

export const invoiceRoutes = Router();
invoiceRoutes.use(authenticate);

const invoiceInclude = {
  customer: { select: { id: true, code: true, name: true } },
  job: { select: { id: true, number: true, name: true } },
  progressBilling: { select: { id: true, number: true, billingNo: true } },
  jobOrder: { select: { id: true, number: true } },
  salesOrder: { select: { id: true, number: true, poNumber: true } },
  salesperson: { select: { id: true, name: true } },
  team: TEAM_REF_SELECT,
  lines: { orderBy: { sortOrder: 'asc' } },
} satisfies Prisma.InvoiceInclude;

type InvoiceRow = Prisma.InvoiceGetPayload<{ include: typeof invoiceInclude }>;

function presentInvoice(row: InvoiceRow, attachments?: number) {
  const netCollectible = num(row.netCollectible);
  const collected = num(row.amountCollected);
  const outstanding = cents(netCollectible - collected);
  const owed = row.status === 'ISSUED' || row.status === 'PARTIALLY_PAID';
  return {
    ...row,
    grossAmount: num(row.grossAmount),
    vatRate: num(row.vatRate),
    vatAmount: num(row.vatAmount),
    ewtRate: num(row.ewtRate),
    ewtAmount: num(row.ewtAmount),
    invoiceTotal: num(row.invoiceTotal),
    netCollectible,
    amountCollected: collected,
    // The number every A/R screen actually needs. Measured against net
    // collectible, because the withheld EWT is never going to arrive as cash.
    outstanding,
    // Late only once countered (2026-10-15): until the customer has the
    // invoice in hand its terms have not started.
    daysOverdue: daysLate({ ...row, outstanding }),
    awaitingCounter: owed && !row.counteredDate,
    termsLabel: termsLabel(row.termsDays, row.terms),
    ...(attachments === undefined ? {} : { attachments }),
    lines: row.lines.map((l) => ({ ...l, amount: num(l.amount) })),
  };
}

/** How many files each invoice carries — the list's "Invoice copy" column. */
async function attachmentCounts(ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const rows = await prisma.attachment.groupBy({ by: ['entityId'], where: { entityType: 'invoice', entityId: { in: ids } }, _count: { _all: true } });
  return new Map(rows.map((r) => [r.entityId, r._count._all]));
}

/**
 * The invoice's files — the customer's countered copy, the signed delivery,
 * whatever finance keeps with it: read with A/R, written by whoever raises or
 * edits invoices; printed behind the invoice's paper.
 */
registerAttachmentGuard(
  'invoice',
  // View Own reads the files of the invoices one raised, Edit Own writes them
  // (2026-10-18).
  async (user, id) => {
    if (can(user, 'gfin.ar.view_all')) return true;
    if (!can(user, 'gfin.ar.view_own')) return false;
    const inv = await prisma.invoice.findUnique({ where: { id }, select: { createdById: true } });
    return inv?.createdById === user.id;
  },
  {
    write: async (user, id) => {
      if (can(user, 'gfin.ar.create') || can(user, 'gfin.ar.edit_all')) return true;
      if (!can(user, 'gfin.ar.edit_own')) return false;
      const inv = await prisma.invoice.findUnique({ where: { id }, select: { createdById: true } });
      return inv?.createdById === user.id;
    },
  },
);

/** An invoice something is owed on — the receivable, as `financePosition` reads it. */
const INVOICE_OWED: InvoiceStatus[] = ['ISSUED', 'PARTIALLY_PAID'];
/** A bill something is payable on — the payable, as `financePosition` reads it. */
const BILL_OWED: BillStatus[] = ['APPROVED', 'PARTIALLY_PAID'];

/**
 * The invoice list's where-builder — the screen's rows, its cards and the
 * printed list read the same set; `?ids=` narrows to the rows ticked. A View
 * Own holder reads the invoices they raised (2026-10-18, `ownOnly`).
 */
function invoiceListWhere(me: ResolvedUser, q: ListQuery): Prisma.InvoiceWhereInput {
  return ownOnly(me, 'gfin', 'ar', invoiceListWhereAll(q), (ids) => ({ createdById: { in: ids } }));
}

function invoiceListWhereAll(q: ListQuery): Prisma.InvoiceWhereInput {
  const where: Prisma.InvoiceWhereInput = {};

  const and: Prisma.InvoiceWhereInput[] = [];
  const f = q.filters;
  const status = choice(f.status, InvoiceStatus, 'Status');
  if (status) where.status = status;
  if (f.customerId) where.customerId = f.customerId;
  if (f.jobId) where.jobId = f.jobId;
  if (f.salesOrderId) where.salesOrderId = f.salesOrderId;
  if (f.salespersonId) where.salespersonId = f.salespersonId === 'none' ? null : f.salespersonId;
  if (f.teamId) where.teamId = f.teamId === 'none' ? null : f.teamId;
  if (f.termsDays) {
    const days = Number(f.termsDays);
    if (!Number.isInteger(days) || days < 0 || days > 365) throw badRequest('Terms is a number of days');
    where.termsDays = days;
  }
  const from = filterDay(f.from, 'From');
  const to = filterDay(f.to, 'To');
  if (from || to) where.invoiceDate = { ...(from ? { gte: dayOf(from) } : {}), ...(to ? { lte: dayOf(to) } : {}) };
  // The expected collection — the due date, counted from the countered day.
  const dueFrom = filterDay(f.dueFrom, 'Expected from');
  const dueTo = filterDay(f.dueTo, 'Expected to');
  if (dueFrom || dueTo) where.dueDate = { ...(dueFrom ? { gte: dayOf(dueFrom) } : {}), ...(dueTo ? { lte: dayOf(dueTo) } : {}) };
  const countered = choice(f.countered, { yes: 'yes', no: 'no' }, 'Countered', (v) => (v === 'yes' ? 'Countered' : 'Awaiting countering'));
  if (countered === 'yes') where.counteredDate = { not: null };
  if (countered === 'no') and.push(AWAITING_COUNTER_WHERE);
  // "Outstanding" is not a status — a partially paid invoice and an issued
  // one are both outstanding, and a paid one never is.
  if (f.outstanding === 'true') {
    where.status = { in: ['ISSUED', 'PARTIALLY_PAID'] };
  }
  // Overdue only once countered: an invoice the customer has not received
  // has not started its terms.
  if (f.overdue === 'true') and.push(overdueWhere());
  if (q.search) {
    where.OR = [
      { number: { contains: q.search, mode: 'insensitive' } },
      { poReference: { contains: q.search, mode: 'insensitive' } },
      { siNumber: { contains: q.search, mode: 'insensitive' } },
      { customer: { name: { contains: q.search, mode: 'insensitive' } } },
      { job: { number: { contains: q.search, mode: 'insensitive' } } },
      { salesOrder: { number: { contains: q.search, mode: 'insensitive' } } },
      { salesperson: { name: { contains: q.search, mode: 'insensitive' } } },
    ];
  }
  const ids = idsFilter(f.ids);
  if (ids) where.id = { in: ids };
  return and.length ? { AND: [where, ...and] } : where;
}

/**
 * The cards over the list (the owner's sample: "TOTAL RECEIVABLES SUM — N
 * active invoices pending collection"), under the list's own query: the
 * receivable (issued and partly paid, against net collectible), what of it is
 * overdue and what is awaiting countering, what has been collected on the
 * invoices listed, and the receivable split by the team credited — the same
 * cards as the sales lists (`teamShares`).
 */
async function invoiceListSummary(where: Prisma.InvoiceWhereInput) {
  const today = dayKey(new Date());
  const [owed, collected] = await Promise.all([
    prisma.invoice.findMany({
      where: { AND: [where, { status: { in: INVOICE_OWED } }] },
      select: { status: true, counteredDate: true, dueDate: true, netCollectible: true, amountCollected: true, team: TEAM_REF_SELECT },
    }),
    prisma.invoice.aggregate({ where: { AND: [where, { status: { not: 'CANCELLED' } }] }, _sum: { amountCollected: true } }),
  ]);
  let receivable = 0;
  let overdue = 0;
  let overdueCount = 0;
  let awaiting = 0;
  let awaitingCount = 0;
  const shares: { team: { id: string; code: string; name: string } | null; cents: number }[] = [];
  for (const r of owed) {
    const outstanding = Math.round((num(r.netCollectible) - num(r.amountCollected)) * 100);
    if (outstanding <= 0) continue;
    receivable += outstanding;
    shares.push({ team: r.team, cents: outstanding });
    if (!r.counteredDate) {
      awaiting += outstanding;
      awaitingCount++;
    } else if (isOverdue({ ...r, outstanding: outstanding / 100 }, today)) {
      overdue += outstanding;
      overdueCount++;
    }
  }
  return {
    receivable: receivable / 100,
    active: shares.length,
    overdue: overdue / 100,
    overdueCount,
    awaiting: awaiting / 100,
    awaitingCount,
    collected: num(collected._sum.amountCollected),
    teams: await teamShares(shares),
  };
}

const INVOICE_SORTS = ['number', 'invoiceDate', 'dueDate', 'createdAt'];

invoiceRoutes.get(
  '/',
  requireView('gfin', 'ar'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const where = invoiceListWhere(me, q);

    const [rows, total] = await Promise.all([
      prisma.invoice.findMany({
        where,
        include: invoiceInclude,
        orderBy: orderBy(q, INVOICE_SORTS, { invoiceDate: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.invoice.count({ where }),
    ]);
    const [files, summary] = await Promise.all([attachmentCounts(rows.map((r) => r.id)), invoiceListSummary(where)]);

    res.json({
      ...listResult(rows.map((r) => ({ ...presentInvoice(r, files.get(r.id) ?? 0), canEdit: mayEdit(me, 'gfin', 'ar', r.createdById === me.id, r.createdById) })), total, q),
      summary,
    });
  }),
);

/**
 * The issued sales orders a new invoice may bill — the form's "From a sales
 * order" choices, for one customer: each with its net (the order's total
 * before VAT), what live invoices already bill of it, what is left, its PO,
 * its terms and who sold it. Above `/:id`.
 */
/**
 * Who an invoice would be credited to — the person who raised the order's
 * invoice request, else the order's or project's salesperson — so the form
 * shows the names it will fill in (2026-10-16). Above `/:id`.
 */
invoiceRoutes.get(
  '/credit',
  require_('gfin.ar.create'),
  handler(async (req, res) => {
    const str = (k: string) => (typeof req.query[k] === 'string' && req.query[k] ? String(req.query[k]) : null);
    const credit = await invoiceCredit({ salesOrderId: str('salesOrderId'), jobId: str('jobId'), jobOrderId: str('jobOrderId') });
    const [person, team] = await Promise.all([
      credit.salespersonId ? prisma.user.findUnique({ where: { id: credit.salespersonId }, select: { id: true, name: true } }) : null,
      credit.teamId ? prisma.industry.findUnique({ where: { id: credit.teamId }, select: { id: true, code: true, name: true } }) : null,
    ]);
    res.json({ salesperson: person, team });
  }),
);

invoiceRoutes.get(
  '/sales-orders',
  require_('gfin.ar.create'),
  handler(async (req, res) => {
    const customerId = typeof req.query.customerId === 'string' ? req.query.customerId : '';
    if (!customerId) throw badRequest('Which customer?');
    const orders = await prisma.salesOrder.findMany({
      where: { customerId, status: 'ISSUED' },
      orderBy: { orderDate: 'desc' },
      select: {
        id: true,
        number: true,
        orderDate: true,
        poNumber: true,
        termsDays: true,
        total: true,
        vatAmount: true,
        vatRate: true,
        owner: { select: { id: true, name: true } },
        quotation: { select: { subject: true } },
        invoices: { where: { status: { not: 'CANCELLED' } }, select: { grossAmount: true } },
      },
    });
    res.json(
      orders.map((o) => {
        const net = cents(num(o.total) - num(o.vatAmount));
        const invoiced = cents(o.invoices.reduce((s, i) => s + num(i.grossAmount), 0));
        return {
          id: o.id,
          number: o.number,
          orderDate: o.orderDate,
          poNumber: o.poNumber,
          termsDays: o.termsDays,
          vatRate: num(o.vatRate),
          subject: o.quotation.subject,
          owner: o.owner,
          net,
          invoiced,
          left: cents(Math.max(0, net - invoiced)),
        };
      }),
    );
  }),
);


/**
 * The A/R register on paper — the list as filtered (or the rows ticked),
 * through `invoiceListWhere`, so the paper is the screen. The figures are the
 * screen's: invoiced, net collectible (the EWT the customer withholds never
 * arrives as cash) and outstanding against what is collectible. Invoiced, net
 * collectible and collected run over every invoice the filter matched, a
 * cancelled one in brackets and not counted. Outstanding is the RECEIVABLE —
 * issued and partly paid invoices only, `financePosition`'s rule — so a draft,
 * on which nothing is owed yet, prints "—" there and a note says how many are
 * in the other totals; the unfiltered paper's Outstanding equals the
 * `?outstanding=true` paper's. Declared above `/:id`, or that route swallows it.
 */
invoiceRoutes.get(
  '/pdf',
  requireView('gfin', 'ar'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const where = invoiceListWhere(currentUser(req), q);
    const countedWhere: Prisma.InvoiceWhereInput = { AND: [where, { status: { not: 'CANCELLED' } }] };
    // What is owed: an issued invoice, paid in part or not at all.
    const owedWhere: Prisma.InvoiceWhereInput = { AND: [where, { status: { in: INVOICE_OWED } }] };
    const [rows, count, sums, owed, byStatus, currency, customer, project] = await Promise.all([
      prisma.invoice.findMany({
        where,
        include: {
          customer: { select: { name: true } },
          job: { select: { number: true, name: true } },
          jobOrder: { select: { number: true } },
          salesOrder: { select: { number: true } },
          salesperson: { select: { name: true } },
          team: { select: { code: true } },
        },
        orderBy: orderBy(q, INVOICE_SORTS, { invoiceDate: 'desc' }),
        take: LIST_CAP,
      }),
      prisma.invoice.count({ where }),
      prisma.invoice.aggregate({ where: countedWhere, _sum: { invoiceTotal: true, netCollectible: true, amountCollected: true } }),
      prisma.invoice.aggregate({ where: owedWhere, _sum: { netCollectible: true, amountCollected: true } }),
      prisma.invoice.groupBy({ by: ['status'], where, _count: { _all: true } }),
      companyCurrency(),
      recordNamed('customer', q.filters.customerId),
      recordNamed('project', q.filters.jobId),
    ]);
    const [salespersonNamed, teamNamed, orderNamed] = await Promise.all([
      q.filters.salespersonId === 'none' ? 'no salesperson' : recordNamed('person', q.filters.salespersonId),
      q.filters.teamId === 'none'
        ? 'no team'
        : q.filters.teamId
          ? prisma.industry.findUnique({ where: { id: q.filters.teamId }, select: { code: true } }).then((t) => (t ? `team ${t.code}` : undefined))
          : undefined,
      recordNamed('sales order', q.filters.salesOrderId),
    ]);

    const f = q.filters;
    const status = choice(f.status, InvoiceStatus, 'Status');
    const reference = listReference(count, rows.length, ['invoice', 'invoices'], [
      q.search && `search "${q.search}"`,
      f.overdue === 'true' ? 'overdue' : f.outstanding === 'true' ? 'outstanding' : status && `status ${statusLabel(status)}`,
      f.countered === 'yes' ? 'countered' : f.countered === 'no' ? 'awaiting countering' : undefined,
      customer,
      project,
      orderNamed,
      salespersonNamed,
      teamNamed,
      f.termsDays && termsLabel(Number(f.termsDays)),
      rangeNamed('dated', f.from, f.to),
      rangeNamed('expected', f.dueFrom, f.dueTo),
      f.ids && 'the rows selected',
    ]);
    const today = dayKey(new Date());
    const invoiced = num(sums._sum.invoiceTotal);
    const collectible = num(sums._sum.netCollectible);
    const collected = num(sums._sum.amountCollected);
    const receivable = cents(num(owed._sum.netCollectible) - num(owed._sum.amountCollected));

    // Eight columns: landscape (rule 6).
    const sections: PdfSection[] = [
      {
        kind: 'table',
        head: ['Number', 'Customer and project', 'Countered', 'Expected', `Invoiced (${currency})`, `Collectible (${currency})`, `Outstanding (${currency})`, 'Status'],
        align: ['left', 'left', 'left', 'left', 'right', 'right', 'right', 'left'],
        rows: rows.map((r) => {
          const inSum = r.status !== 'CANCELLED';
          const outstanding = cents(num(r.netCollectible) - num(r.amountCollected));
          const late = daysLate({ ...r, outstanding }, today);
          const owed = r.status === 'ISSUED' || r.status === 'PARTIALLY_PAID';
          const credit = [r.salesperson?.name, r.team?.code].filter(Boolean).join(' · ');
          return [
            r.siNumber ? { title: r.number, body: `SI ${r.siNumber}` } : r.number,
            {
              title: r.customer.name,
              body: [
                r.job ? `${r.job.number} — ${r.job.name}` : r.salesOrder ? `Sales order ${r.salesOrder.number}` : r.jobOrder ? `Job order ${r.jobOrder.number}` : 'No project',
                credit,
              ]
                .filter(Boolean)
                .join(' · '),
            },
            r.counteredDate
              ? { title: formatShortDate(r.counteredDate), body: termsLabel(r.termsDays, r.terms) }
              : { title: owed ? 'Awaiting' : '—', body: termsLabel(r.termsDays, r.terms) },
            late > 0
              ? { title: formatShortDate(r.dueDate), body: `${late} day${late === 1 ? '' : 's'} late` }
              : owed && !r.counteredDate
                ? { title: formatShortDate(r.dueDate), body: 'not yet countered' }
                : formatShortDate(r.dueDate),
            bracketed(formatAmount(num(r.invoiceTotal)), inSum),
            bracketed(formatAmount(num(r.netCollectible)), inSum),
            // Nothing is owed on a draft until it is issued.
            r.status === 'DRAFT' ? '—' : bracketed(formatAmount(outstanding), inSum),
            statusLabel(r.status),
          ];
        }),
      },
      {
        kind: 'totals',
        rows: [
          { label: 'Invoiced', value: formatMoney(invoiced, currency) },
          { label: 'Net collectible', value: formatMoney(collectible, currency) },
          { label: 'Collected', value: formatMoney(collected, currency) },
          { label: totalLabel('Outstanding', count, rows.length), value: formatMoney(receivable, currency), bold: true },
        ],
      },
    ];
    const inStatus = (st: InvoiceStatus) => byStatus.find((g) => g.status === st)?._count._all ?? 0;
    const drafts = inStatus('DRAFT');
    sections.push(
      ...listNotes([
        bracketNote(inStatus('CANCELLED'), ['cancelled invoice', 'cancelled invoices']),
        drafts > 0 &&
          `${counted(drafts, ['draft invoice is', 'draft invoices are'])} counted in Invoiced and Net collectible but not in Outstanding — nothing is owed on ${drafts === 1 ? 'it' : 'them'} until ${drafts === 1 ? 'it is' : 'they are'} issued.`,
      ]),
    );

    const pdf = await renderDocument({ title: 'Invoices', date: new Date(), reference, landscape: true, sections });
    await audit(
      { entityType: 'invoice', entityId: 'list', action: 'EXPORTED', summary: `Exported the invoice list as PDF (${rows.length} invoice(s))` },
      req,
    );
    sendListPdf(res, pdf, 'invoices.pdf');
  }),
);

/**
 * The STATEMENT OF ACCOUNT (2026-10-20, the owner's call): one customer's
 * open invoices as of a day — each with what it was billed, the EWT, what is
 * collectible, what was collected BY that day and the balance, and how late
 * it is (never late until countered, the A/R rule) — then the collections of
 * the ninety days to that day, and the total due. `?asOf=` (a day, today by
 * default; never a day to come). Behind the A/R register's right; audited on
 * the customer.
 */
invoiceRoutes.get(
  '/statement/:customerId/pdf',
  requireView('gfin', 'ar'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const customer = await prisma.customer.findUnique({
      where: { id: req.params.customerId },
      select: { id: true, code: true, name: true, legalName: true, tin: true, address: true, phone: true, email: true },
    });
    if (!customer) throw notFound('Customer not found');
    const today = dayKey(new Date());
    const asOf = req.query.asOf ? asDate(String(req.query.asOf), 'As of') : today;
    if (asOf > today) throw badRequest('A statement is as of today or a day before');
    const since = addDays(asOf, -90);
    const currency = await companyCurrency();

    const invoices = await prisma.invoice.findMany({
      where: { customerId: customer.id, status: { in: ['ISSUED', 'PARTIALLY_PAID', 'PAID'] }, invoiceDate: { lte: asOf } },
      select: {
        id: true,
        number: true,
        siNumber: true,
        status: true,
        invoiceDate: true,
        counteredDate: true,
        dueDate: true,
        invoiceTotal: true,
        ewtAmount: true,
        netCollectible: true,
        allocations: { where: { payment: { paymentDate: { lte: asOf } } }, select: { amount: true } },
      },
      orderBy: { invoiceDate: 'asc' },
    });
    // What was owed on that day: collected BY it, an invoice countered after it
    // not yet countered then.
    const open = invoices
      .map((i) => {
        const collected = cents(i.allocations.reduce((t, a) => t + num(a.amount), 0));
        const balance = cents(num(i.netCollectible) - collected);
        const countered = i.counteredDate && i.counteredDate <= asOf ? i.counteredDate : null;
        const late = daysLate({ status: 'ISSUED', counteredDate: countered, dueDate: i.dueDate, outstanding: balance }, asOf);
        return { ...i, collected, balance, countered, late };
      })
      .filter((i) => i.balance > 0.005);
    const total = cents(open.reduce((t, i) => t + i.balance, 0));
    const overdue = cents(open.filter((i) => i.late > 0).reduce((t, i) => t + i.balance, 0));
    const awaiting = cents(open.filter((i) => !i.countered).reduce((t, i) => t + i.balance, 0));

    const collections = await prisma.payment.findMany({
      where: { customerId: customer.id, kind: 'RECEIPT', paymentDate: { gte: since, lte: asOf } },
      select: {
        number: true,
        orNumber: true,
        paymentDate: true,
        method: true,
        reference: true,
        amount: true,
        importedFrom: true,
        allocations: { select: { invoice: { select: { number: true, siNumber: true } } } },
      },
      orderBy: { paymentDate: 'asc' },
    });

    const sections: PdfSection[] = [
      {
        kind: 'blocks',
        blocks: [
          {
            title: 'Statement for',
            lines: [customer.legalName || customer.name, customer.address ?? '', customer.tin ? `TIN: ${customer.tin}` : '', [customer.phone, customer.email].filter(Boolean).join(' | ')].filter(
              (l) => l.trim(),
            ),
          },
          {
            title: 'Summary',
            lines: [
              `As of ${formatDate(asOf)}`,
              `Total due: ${formatMoney(total, currency)}`,
              `Of it overdue: ${formatMoney(overdue, currency)}`,
              ...(awaiting > 0.005 ? [`Awaiting countering: ${formatMoney(awaiting, currency)}`] : []),
            ],
          },
        ],
      },
      {
        kind: 'table',
        title: 'Open invoices',
        head: ['SI No.', 'Dated', 'Countered', 'Due', 'Days late', `Invoice total (${currency})`, `EWT (${currency})`, `Collected (${currency})`, `Balance (${currency})`],
        align: ['left', 'left', 'left', 'left', 'right', 'right', 'right', 'right', 'right'],
        rows: open.map((i) => [
          i.siNumber ? { title: i.siNumber, body: i.number } : i.number,
          formatShortDate(i.invoiceDate),
          i.countered ? formatShortDate(i.countered) : 'Not yet',
          i.countered ? formatShortDate(i.dueDate) : 'Once countered',
          i.late > 0 ? String(i.late) : '',
          formatAmount(num(i.invoiceTotal)),
          formatAmount(num(i.ewtAmount)),
          formatAmount(i.collected),
          formatAmount(i.balance),
        ]),
      },
      {
        kind: 'totals',
        rows: [
          ...(overdue > 0.005 ? [{ label: 'Of it overdue', value: formatMoney(overdue, currency) }] : []),
          { label: 'Total due', value: formatMoney(total, currency), bold: true },
        ],
      },
      {
        kind: 'table',
        title: `Collections, ${formatDate(since)} to ${formatDate(asOf)}`,
        head: ['Date', 'OR No.', 'Method / reference', 'Applied to', `Amount (${currency})`],
        align: ['left', 'left', 'left', 'left', 'right'],
        rows: collections.map((p) => [
          formatShortDate(p.paymentDate),
          p.orNumber ?? (p.importedFrom ? 'SCORO' : p.number),
          [statusLabel(p.method), p.reference].filter(Boolean).join(' · '),
          p.allocations.map((a) => a.invoice?.siNumber ?? a.invoice?.number).filter(Boolean).join(', ') || 'On account',
          formatAmount(num(p.amount)),
        ]),
      },
      {
        kind: 'text',
        body: 'Withholding tax (EWT) is deducted from what is collectible: the balance is what is still to be paid after it. Please let us know of any difference.',
      },
    ];
    const pdf = await renderDocument({
      title: 'Statement of Account',
      documentNumber: customer.code,
      date: asOf,
      reference: customer.name,
      landscape: true,
      sections,
      signatories: [{ role: 'Prepared by', name: me.name, ...(await contactOf(me.id)), at: new Date() }],
    });
    await audit(
      { entityType: 'customer', entityId: customer.id, action: 'EXPORTED', summary: `Printed the statement of account as of ${formatDate(asOf)} (${open.length} open invoice(s))` },
      req,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition(paperFileName({ kind: 'Statement of Account', number: customer.code, author: me.name, date: asOf })));
    res.send(pdf);
  }),
);

invoiceRoutes.get(
  '/:id',
  requireView('gfin', 'ar'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      include: {
        ...invoiceInclude,
        allocations: {
          include: {
            payment: {
              select: {
                id: true,
                number: true,
                paymentDate: true,
                method: true,
                reference: true,
                clearedAt: true,
              },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!row) throw notFound('Invoice not found');
    // View Own reads the invoices one raised; Edit Own changes them (2026-10-18).
    assertCanView(me, 'gfin', 'ar', row.createdById === me.id, row.createdById);

    res.json({
      ...presentInvoice(row),
      canEdit: mayEdit(me, 'gfin', 'ar', row.createdById === me.id, row.createdById),
      // The delete route's own door (2026-10-22): the creator or Edit All
      // holding the delete right, or a super admin; the status is the page's.
      canDelete: me.isSuperAdmin || (can(me, 'gfin.ar.delete') && canEditRecord(me, 'gfin', 'ar', row.createdById)),
      allocations: row.allocations.map((a) => ({ ...a, amount: num(a.amount) })),
    });
  }),
);

/**
 * The customer-facing sales invoice.
 *
 * Prints the figures the invoice carries, never recomputed: gross, VAT,
 * the total, the EWT the customer will withhold and what will actually
 * arrive — as the quotation's totals block, the line figures without the
 * code, which the column head names.
 *
 * An invoice has no approval route, so it prints the people who actually
 * acted, each dated: who prepared it, and who issued it — the trail's issue
 * row, "Pending" while it is a draft. Never its creator as an approver.
 */
invoiceRoutes.get(
  '/:id/pdf',
  requireView('gfin', 'ar'),
  handler(async (req, res) => {
    const inv = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      include: {
        ...invoiceInclude,
        customer: { select: { id: true, code: true, name: true, tin: true } },
        createdBy: { select: { id: true, name: true } },
      },
    });
    if (!inv) throw notFound('Invoice not found');
    assertCanView(currentUser(req), 'gfin', 'ar', inv.createdById === currentUser(req).id, inv.createdById);
    const currency = await companyCurrency();

    const sections: PdfSection[] = [
      {
        kind: 'fields',
        columns: 3,
        fields: [
          { label: 'Customer', value: inv.customer.name },
          { label: 'Invoice no.', value: inv.siNumber ?? '—' },
          { label: 'TIN', value: inv.customer.tin ?? '—' },
          { label: 'Project', value: inv.job ? `${inv.job.number} — ${inv.job.name}` : '—' },
          { label: 'Customer P.O.', value: inv.poReference ?? inv.salesOrder?.poNumber ?? '—' },
          { label: 'Payment terms', value: termsLabel(inv.termsDays, inv.terms) },
          { label: 'Countered', value: inv.counteredDate ? formatDate(inv.counteredDate) : 'Not yet' },
          { label: inv.counteredDate ? 'Due date' : 'Due (if countered on the invoice date)', value: formatDate(inv.dueDate) },
          inv.salesOrder
            ? { label: 'Sales order', value: inv.salesOrder.number }
            : inv.jobOrder
              ? { label: 'Job order', value: inv.jobOrder.number }
              : { label: 'Billing no.', value: inv.progressBilling ? `${inv.progressBilling.number} (#${inv.progressBilling.billingNo})` : '—' },
          { label: 'Sales personnel', value: [inv.salesperson?.name, inv.team?.code].filter(Boolean).join(' · ') || '—' },
          { label: 'Status', value: statusLabel(inv.status) },
        ],
      },
      // An invoice raised from a billing with no line breakdown has nothing
      // to list: no table, rather than a head over nothing.
      ...(inv.lines.length
        ? [
            {
              kind: 'table' as const,
              title: 'Particulars',
              head: ['No.', 'Description', `Amount (${currency})`],
              widths: [8, 68, 24],
              align: ['right' as const, 'left' as const, 'right' as const],
              rows: inv.lines.map((l, n) => [
                String(n + 1),
                l.detail ? `${l.description} — ${l.detail}` : l.description,
                formatAmount(num(l.amount)),
              ]),
            },
          ]
        : []),
      // The money block: a "Less:" row names its own sign, so the figure
      // prints as the amount taken off; the bold row is what will arrive.
      {
        kind: 'totals',
        rows: [
          { label: 'Gross', value: formatMoney(num(inv.grossAmount), currency) },
          { label: `VAT (${ratePct(num(inv.vatRate))})`, value: formatMoney(num(inv.vatAmount), currency) },
          { label: 'Invoice total', value: formatMoney(num(inv.invoiceTotal), currency) },
          { label: `Less: EWT (${ratePct(num(inv.ewtRate))})`, value: formatMoney(num(inv.ewtAmount), currency) },
          { label: 'Net collectible', value: formatMoney(num(inv.netCollectible), currency), bold: true },
        ],
      },
    ];
    if (inv.notes) sections.push({ kind: 'text', title: 'Notes', body: inv.notes });

    // Who issued it is the trail's issue row (the one route that issues);
    // an invoice issued outside the routes names nobody rather than a guess.
    const issueRow = inv.issuedAt
      ? await prisma.auditLog.findFirst({
          where: { entityType: 'invoice', entityId: inv.id, action: 'SUBMITTED', OR: [{ actorId: { not: null } }, { actorName: { not: null } }] },
          orderBy: { at: 'desc' },
          select: { actorId: true, actorName: true, at: true },
        })
      : null;
    const people = await contactsOf([inv.createdBy.id, issueRow?.actorId]);
    const preparer = people.get(inv.createdBy.id);
    const issuer = issueRow?.actorId ? people.get(issueRow.actorId) : undefined;
    const signatories: Signatory[] = [
      { role: 'Prepared by', name: inv.createdBy.name, phone: preparer?.phone, email: preparer?.email, at: inv.createdAt },
    ];
    if (!inv.issuedAt) {
      if (inv.status === 'DRAFT') signatories.push({ role: 'Issued by' });
    } else if (issueRow) {
      signatories.push({
        role: 'Issued by',
        name: issuer?.name ?? issueRow.actorName ?? undefined,
        phone: issuer?.phone,
        email: issuer?.email,
        at: inv.issuedAt,
      });
    }

    const bare = await renderDocument({
      title: 'Sales Invoice',
      documentNumber: inv.number,
      date: inv.invoiceDate,
      reference: inv.customer.name,
      sections,
      signatories,
    });
    // The invoice's files (the countered copy, the signed delivery) print
    // behind it unless `?attachments=0`.
    const files = req.query.attachments === '0' ? [] : await attachedFiles('invoice', inv.id);
    const { pdf, listed } = await withAttachments(bare, files, { title: 'Sales invoice', number: inv.number, reference: inv.customer.name });

    await audit(
      {
        entityType: 'invoice',
        entityId: inv.id,
        action: 'EXPORTED',
        summary: `Printed ${inv.number}${listed ? ` with ${listed} attachment${listed === 1 ? '' : 's'}` : ''}`,
      },
      req,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition(paperFileName({ kind: 'Invoice', number: inv.number, author: inv.createdBy.name, date: inv.invoiceDate })));
    res.send(pdf);
  }),
);

/** An invoice's own header — what a billing's invoice may set, raised or modified. */
const invoiceHeaderSchema = z.object({
  invoiceDate: z.string().optional(),
  /**
   * The day the customer received it (2026-10-16, the owner's call: the form
   * asks this in place of the invoice date). Given, it is the invoice date
   * too unless one is sent, and the terms run from it.
   */
  counteredDate: z.string().optional().nullable(),
  /** The printed sales invoice (BIR booklet) number — one invoice each. */
  siNumber: z.string().trim().max(60).optional().nullable(),
  dueDate: z.string().optional(),
  /** Net days — the due date follows from it unless a due date is typed. */
  termsDays: z.number().int().min(0).max(365).optional().nullable(),
  terms: z.string().optional().nullable(),
  poReference: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

/** Who is credited with an invoice — named on the form, else its source's. */
const creditSchema = z.object({
  salespersonId: z.string().optional().nullable(),
  teamId: z.string().optional().nullable(),
});

/**
 * The salesperson and team an invoice is credited to: those the form names
 * (checked to exist — a team must be active), else the ones its source
 * names (`invoiceCredit`), the team falling back to the salesperson's own.
 * `undefined` in the body means "from the source"; null means nobody.
 */
async function resolveCredit(
  body: { salespersonId?: string | null; teamId?: string | null },
  source: { salesOrderId?: string | null; jobId?: string | null; jobOrderId?: string | null },
): Promise<{ salespersonId: string | null; teamId: string | null }> {
  const fromSource = body.salespersonId === undefined || body.teamId === undefined ? await invoiceCredit(source) : null;
  const salespersonId = body.salespersonId === undefined ? fromSource!.salespersonId : body.salespersonId || null;
  if (salespersonId && body.salespersonId) {
    const known = await prisma.user.findUnique({ where: { id: salespersonId }, select: { id: true } });
    if (!known) throw badRequest('That salesperson is not on file');
  }
  let teamId: string | null;
  if (body.teamId === undefined) {
    teamId = fromSource!.teamId;
    if (!teamId && salespersonId && body.salespersonId) {
      teamId = (await prisma.employee.findUnique({ where: { userId: salespersonId }, select: { industryId: true } }))?.industryId ?? null;
    }
  } else {
    teamId = body.teamId || null;
    if (teamId) {
      const team = await prisma.industry.findUnique({ where: { id: teamId }, select: { isActive: true } });
      if (!team?.isActive) throw badRequest('That team is not on the list');
    }
  }
  return { salespersonId, teamId };
}

/**
 * A printed sales invoice number belongs to one live invoice: the same number
 * (case- and space-blind) on another invoice that is not cancelled is a 409
 * naming it, before anything is written.
 */

/** The invoice date and countered day a form sends: countered alone is both. */
function datesFrom(body: { invoiceDate?: string; counteredDate?: string | null }, fallback: Date) {
  const counteredDate = body.counteredDate ? asDate(body.counteredDate, 'Countered date') : null;
  const invoiceDate = body.invoiceDate ? asDate(body.invoiceDate, 'Invoice date') : (counteredDate ?? fallback);
  if (counteredDate && counteredDate < invoiceDate) throw badRequest('It cannot be countered before its invoice date');
  if (counteredDate && counteredDate > dayKey(new Date())) throw badRequest('It cannot be countered on a day still to come');
  return { invoiceDate, counteredDate };
}

/** The due date: typed, else the countered day (else the invoice date) plus the terms. */
function dueFrom(body: { dueDate?: string; termsDays?: number | null }, invoiceDate: Date, counteredDate: Date | null, termsDays: number): Date {
  const dueDate = body.dueDate ? asDate(body.dueDate, 'Due date') : expectedCollection(invoiceDate, counteredDate, termsDays);
  if (dueDate < invoiceDate) throw badRequest('The due date is before the invoice date');
  return dueDate;
}

/**
 * Raising an invoice from an approved progress billing.
 *
 * Everything is carried from the billing — gross, both rates, both tax amounts,
 * the line breakdown. Nothing is recomputed, because the billing already
 * snapshotted the rates it was issued under and an invoice raised months later
 * must not silently use today's VAT (model §4.6: finance consumes, it does not
 * re-key).
 */
invoiceRoutes.post(
  '/from-billing/:billingId',
  require_('gfin.ar.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(invoiceHeaderSchema.merge(creditSchema).extend({ ewtRate: z.number().min(0).max(0.15).optional().nullable() }), req.body);

    const billing = await prisma.progressBilling.findUnique({
      where: { id: req.params.billingId },
      include: billingForInvoiceInclude,
    });
    if (!billing) throw notFound('Progress billing not found');
    if (billing.status !== 'APPROVED' && billing.status !== 'INVOICED') {
      throw badRequest(
        `${billing.number} is ${billing.status.toLowerCase().replace(/_/g, ' ')}. Only an approved billing can be invoiced.`,
      );
    }
    if (billing.invoice) {
      throw badRequest(
        `${billing.number} has already been invoiced as ${billing.invoice.number}. Raise a credit note against that instead of a second invoice.`,
      );
    }
    // The other door: an invoice request on its way to Back Support raises this
    // billing's invoice when approved, so this one waits for it (2026-10-15).
    const live = await prisma.invoiceRequest.findFirst({
      where: { progressBillingId: billing.id, status: { in: ['DRAFT', 'PENDING_APPROVAL'] } },
      select: { number: true },
    });
    if (live) throw badRequest(`${billing.number} has invoice request ${live.number} open — its approval raises the invoice`);

    const settings = await financeSettings();
    const { invoiceDate, counteredDate } = datesFrom(body, dayKey(new Date()));
    const termsDays = body.termsDays ?? parseTermsDays(body.terms) ?? settings.defaultTermsDays;
    const dueDate = dueFrom(body, invoiceDate, counteredDate, termsDays);
    const credit = await resolveCredit(body, { jobId: billing.jobId });
    await assertSiNumberFree(body.siNumber);

    const made = await prisma.$transaction((tx) =>
      createInvoiceFromBilling(
        tx,
        billing,
        { invoiceDate, dueDate, termsDays, terms: body.terms, poReference: body.poReference, siNumber: body.siNumber, notes: body.notes, ewtRate: body.ewtRate ?? null, ...credit },
        me.id,
      ).then(async (inv) => (counteredDate ? tx.invoice.update({ where: { id: inv.id }, data: { counteredDate } }) : inv)),
    );
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: made.id }, include: invoiceInclude });

    await audit(
      {
        entityType: 'invoice',
        entityId: invoice.id,
        action: 'CREATED',
        summary: `${invoice.number} raised from ${billing.number} — ${num(invoice.invoiceTotal)} invoiced, ${num(invoice.netCollectible)} collectible`,
      },
      req,
    );
    res.status(201).json(presentInvoice(invoice));
  }),
);

/** A standalone invoice, for work with no progress billing behind it. */
const manualInvoiceSchema = creditSchema.extend({
  customerId: z.string().optional().nullable(),
  jobId: z.string().optional().nullable(),
  /** An issued sales order this invoice bills — never past what is left of its net. */
  salesOrderId: z.string().optional().nullable(),
  termsDays: z.number().int().min(0).max(365).optional().nullable(),
  /** A completed, chargeable job order — billed once, like a billing. */
  jobOrderId: z.string().optional().nullable(),
  invoiceDate: z.string().optional(),
  counteredDate: z.string().optional().nullable(),
  siNumber: z.string().trim().max(60).optional().nullable(),
  dueDate: z.string().optional(),
  terms: z.string().optional().nullable(),
  poReference: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  vatRate: z.number().min(0).max(1).optional(),
  ewtRate: z.number().min(0).max(1).optional(),
  lines: z
    .array(
      z.object({
        description: z.string().trim().min(1, 'Every line needs a description'),
        detail: z.string().optional().nullable(),
        amount: z.number(),
      }),
    )
    .min(1, 'An invoice needs at least one line'),
});

/**
 * A manual invoice's money, from its lines — the one rule for raising one and
 * for modifying a draft. Each line is taken to the centavo first, so the gross
 * is exactly the sum of the lines stored under it.
 */
function manualInvoiceMoney(
  lines: { description: string; detail?: string | null; amount: number }[],
  vatRate: number,
  ewtRate: number,
) {
  const rows = lines.map((l, i) => ({
    sortOrder: i,
    description: l.description,
    detail: l.detail || null,
    amount: cents(l.amount),
  }));
  const gross = cents(rows.reduce((s, l) => s + l.amount, 0));
  if (gross <= 0) throw badRequest('The invoice total must be more than zero');
  const tax = taxBreakdown(gross, vatRate, ewtRate);
  return {
    tax,
    figures: {
      grossAmount: D(tax.grossAmount),
      vatRate: D(tax.vatRate),
      vatAmount: D(tax.vatAmount),
      ewtRate: D(tax.ewtRate),
      ewtAmount: D(tax.ewtAmount),
      invoiceTotal: D(tax.invoiceTotal),
      netCollectible: D(tax.netCollectible),
    },
    lines: rows.map((l) => ({ ...l, amount: D(l.amount) })),
  };
}

invoiceRoutes.post(
  '/',
  require_('gfin.ar.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(manualInvoiceSchema, req.body);
    const settings = await financeSettings();
    const rates = await currentRates();

    // A job order is billed the way a billing is: once, after the work is
    // checked, and only when somebody decided it was chargeable. The customer,
    // project and PO reference come off the order unless the body says otherwise.
    let jobOrder: { id: string; number: string } | null = null;
    if (body.jobOrderId) {
      const jo = await prisma.jobOrder.findUnique({
        where: { id: body.jobOrderId },
        select: {
          id: true,
          number: true,
          status: true,
          chargeBasis: true,
          customerId: true,
          jobId: true,
          customerPoNumber: true,
          invoice: { select: { number: true } },
        },
      });
      if (!jo) throw notFound('Job order not found');
      if (jo.chargeBasis !== 'CHARGEABLE') {
        throw badRequest(
          `${jo.number} is covered by ${jo.chargeBasis === 'GOODWILL' ? 'goodwill' : jo.chargeBasis.toLowerCase()} — nothing to bill`,
        );
      }
      if (jo.status !== 'COMPLETED') throw badRequest('A job order is billed once its report is approved');
      if (jo.invoice) throw badRequest(`${jo.number} is already invoiced as ${jo.invoice.number}`);
      body.customerId ??= jo.customerId;
      body.jobId ??= jo.jobId;
      body.poReference ??= jo.customerPoNumber;
      jobOrder = { id: jo.id, number: jo.number };
    }
    // An issued sales order (2026-10-15, the owner's "+ Add Invoice"): its
    // customer, PO, terms and VAT rate unless the body says otherwise, and
    // never more than is left of its net — checked again under a lock below.
    let salesOrder: { id: string; number: string; net: number } | null = null;
    if (body.salesOrderId) {
      if (jobOrder) throw badRequest('An invoice bills a job order or a sales order, not both');
      const so = await prisma.salesOrder.findUnique({
        where: { id: body.salesOrderId },
        select: { id: true, number: true, status: true, customerId: true, poNumber: true, termsDays: true, vatRate: true, total: true, vatAmount: true },
      });
      if (!so) throw notFound('Sales order not found');
      if (so.status !== 'ISSUED') throw badRequest(`${so.number} is ${statusLabel(so.status).toLowerCase()} — only an issued sales order is invoiced`);
      if (body.customerId && body.customerId !== so.customerId) throw badRequest(`${so.number} is another customer's order`);
      body.customerId ??= so.customerId;
      body.poReference ??= so.poNumber;
      body.termsDays ??= so.termsDays;
      body.vatRate ??= num(so.vatRate);
      salesOrder = { id: so.id, number: so.number, net: cents(num(so.total) - num(so.vatAmount)) };
    }
    if (!body.customerId) throw badRequest('Which customer?');
    const customerId = body.customerId;

    const money = manualInvoiceMoney(body.lines, body.vatRate ?? rates.vatRate, body.ewtRate ?? rates.ewtRate);
    const { invoiceDate, counteredDate } = datesFrom(body, dayKey(new Date()));
    const termsDays = body.termsDays ?? parseTermsDays(body.terms) ?? settings.defaultTermsDays;
    const dueDate = dueFrom(body, invoiceDate, counteredDate, termsDays);
    await assertSiNumberFree(body.siNumber);
    const credit = await resolveCredit(body, { salesOrderId: salesOrder?.id, jobId: body.jobId, jobOrderId: jobOrder?.id });

    const invoice = await prisma.$transaction(async (tx) => {
      if (salesOrder) await assertOrderLeft(tx, salesOrder, money.tax.grossAmount);
      const number = await nextNumber('invoice', tx);
      return tx.invoice.create({
        data: {
          number,
          customerId,
          jobId: body.jobId || null,
          jobOrderId: jobOrder?.id ?? null,
          salesOrderId: salesOrder?.id ?? null,
          invoiceDate,
          counteredDate,
          dueDate,
          termsDays,
          ...credit,
          terms: body.terms ?? termsLabel(termsDays),
          poReference: body.poReference || null,
          siNumber: body.siNumber?.trim() || null,
          ...money.figures,
          notes: body.notes || null,
          createdById: me.id,
          lines: { create: money.lines },
        },
        include: invoiceInclude,
      });
    });

    await audit(
      {
        entityType: 'invoice',
        entityId: invoice.id,
        action: 'CREATED',
        summary: jobOrder
          ? `${invoice.number} raised from job order ${jobOrder.number}`
          : salesOrder
            ? `${invoice.number} raised from sales order ${salesOrder.number} — ${num(invoice.grossAmount)} of its ${salesOrder.net} net`
            : `${invoice.number} raised`,
      },
      req,
    );
    res.status(201).json(presentInvoice(invoice));
  }),
);

/** What a billing's invoice never takes on Modify: its figures and whom they bill. */
// The withholding rate is the one figure a billing's draft takes (2026-10-16,
// the owner's call: "editable withholding tax, e.g. 1% or 2%") — EWT is the
// customer's to withhold, and it is withheld on the gross the billing carries.
const BILLING_CARRIED = ['customerId', 'jobId', 'jobOrderId', 'vatRate', 'lines'] as const;

/**
 * Modifying a draft invoice (2026-10-09, Phase 2 of the button standard).
 *
 * Only while DRAFT: once issued it is a receivable the customer holds, and a
 * wrong one is cancelled and raised again. An invoice raised FROM a progress
 * billing carries the billing's figures (Phase 7: carried, never
 * recomputed), so only its dates, terms, PO reference and notes change here —
 * any figure in the body is a 400 naming the billing. A manual invoice (a job
 * order's, or a standalone one) is re-entered whole: lines replaced, tax
 * recomputed — at the rates it was raised with unless the body names others,
 * never today's Settings quietly. The job order it bills never changes, nor
 * does that invoice's customer. A field left out keeps what is stored.
 * Claimed on DRAFT, so an Issue that lands first wins.
 */
invoiceRoutes.put(
  '/:id',
  requireEdit('gfin', 'ar'),
  handler(async (req, res) => {
    const existing = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      include: {
        progressBilling: { select: { number: true } },
        jobOrder: { select: { number: true } },
        salesOrder: { select: { id: true, number: true, total: true, vatAmount: true } },
      },
    });
    if (!existing) throw notFound('Invoice not found');
    assertCanEdit(currentUser(req), 'gfin', 'ar', existing.createdById === currentUser(req).id, existing.createdById);
    if (existing.status !== 'DRAFT') {
      throw badRequest('Only a draft invoice can be modified — once issued, cancel it and raise another');
    }
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const fromBilling = !!existing.progressBillingId;
    if (fromBilling) {
      const carried = BILLING_CARRIED.filter((key) => raw[key] !== undefined);
      if (carried.length) {
        throw badRequest(
          `${existing.number} carries the figures of ${existing.progressBilling?.number ?? 'its billing'} — only its dates, terms, PO reference and notes change here (not ${carried.join(', ')})`,
        );
      }
    } else if (raw.jobOrderId !== undefined && raw.jobOrderId !== existing.jobOrderId) {
      throw badRequest('The job order an invoice bills does not change — cancel this one and raise another');
    } else if (raw.salesOrderId !== undefined && (raw.salesOrderId || null) !== existing.salesOrderId) {
      throw badRequest('The sales order an invoice bills does not change — cancel this one and raise another');
    }

    const header = parseBody(invoiceHeaderSchema, raw);
    const counteredDate =
      header.counteredDate === undefined ? existing.counteredDate : header.counteredDate ? asDate(header.counteredDate, 'Countered date') : null;
    const invoiceDate = header.invoiceDate
      ? asDate(header.invoiceDate, 'Invoice date')
      : header.counteredDate && counteredDate
        ? counteredDate
        : existing.invoiceDate;
    if (counteredDate && counteredDate < invoiceDate) throw badRequest('It cannot be countered before its invoice date');
    if (counteredDate && counteredDate > dayKey(new Date())) throw badRequest('It cannot be countered on a day still to come');
    const termsDays = header.termsDays ?? existing.termsDays;
    // The due date follows the terms unless one is typed; an invoice from
    // before the terms were kept keeps the one it was given.
    const dueDate = header.dueDate
      ? asDate(header.dueDate, 'Due date')
      : termsDays !== null && (header.termsDays !== undefined || header.invoiceDate || header.counteredDate !== undefined)
        ? expectedCollection(invoiceDate, counteredDate, termsDays)
        : existing.dueDate;
    if (dueDate < invoiceDate) throw badRequest('The due date is before the invoice date');
    if (header.siNumber !== undefined) await assertSiNumberFree(header.siNumber, { invoiceId: existing.id });
    const headerData = {
      invoiceDate,
      counteredDate,
      siNumber: header.siNumber === undefined ? existing.siNumber : header.siNumber?.trim() || null,
      dueDate,
      termsDays,
      terms: header.terms === undefined ? existing.terms : header.terms || null,
      poReference: header.poReference === undefined ? existing.poReference : header.poReference || null,
      notes: header.notes === undefined ? existing.notes : header.notes || null,
    };

    let manual: ReturnType<typeof manualInvoiceMoney> | null = null;
    let customerId = existing.customerId;
    let jobId = existing.jobId;
    // A body without lines changes the header alone (the printed invoice
    // number, the countered day) and leaves the figures as they stand.
    if (!fromBilling && raw.lines !== undefined) {
      const body = parseBody(manualInvoiceSchema.omit({ jobOrderId: true }), raw);
      customerId = body.customerId ?? existing.customerId;
      if (customerId !== existing.customerId) {
        if (existing.jobOrderId) {
          throw badRequest(`${existing.number} bills job order ${existing.jobOrder?.number} — it is that order's customer's`);
        }
        const known = await prisma.customer.findUnique({ where: { id: customerId }, select: { id: true } });
        if (!known) throw badRequest('That customer does not exist');
      }
      jobId = body.jobId === undefined ? existing.jobId : body.jobId || null;
      if (jobId && jobId !== existing.jobId) {
        const known = await prisma.job.findUnique({ where: { id: jobId }, select: { id: true } });
        if (!known) throw badRequest('That project does not exist');
      }
      manual = manualInvoiceMoney(body.lines, body.vatRate ?? num(existing.vatRate), body.ewtRate ?? num(existing.ewtRate));
    }

    // A new withholding rate with no lines (a billing's draft, or a header
    // save): EWT again on the stored gross, the rest of the figures kept.
    const ewtOnly =
      !manual && raw.ewtRate !== undefined
        ? (() => {
            const rate = parseBody(z.object({ ewtRate: z.number().min(0).max(0.15) }), raw).ewtRate;
            const tax = taxBreakdown(num(existing.grossAmount), num(existing.vatRate), rate);
            return { ewtRate: D(tax.ewtRate), ewtAmount: D(tax.ewtAmount), netCollectible: D(tax.netCollectible) };
          })()
        : null;

    const updated = await prisma.$transaction(async (tx) => {
      if (manual && existing.salesOrder) {
        const order = existing.salesOrder;
        await assertOrderLeft(tx, { id: order.id, number: order.number, net: cents(num(order.total) - num(order.vatAmount)) }, manual.tax.grossAmount, existing.id);
      }
      const claimed = await tx.invoice.updateMany({
        where: { id: existing.id, status: 'DRAFT' },
        data: { ...headerData, ...(manual ? { customerId, jobId, ...manual.figures } : {}), ...(ewtOnly ?? {}) },
      });
      if (!claimed.count) throw badRequest('It was issued or cancelled a moment ago — reload to see where it stands');
      if (manual) {
        await tx.invoiceLine.deleteMany({ where: { invoiceId: existing.id } });
        await tx.invoiceLine.createMany({ data: manual.lines.map((l) => ({ ...l, invoiceId: existing.id })) });
      }
      return tx.invoice.findUniqueOrThrow({ where: { id: existing.id }, include: invoiceInclude });
    });

    await audit(
      {
        entityType: 'invoice',
        entityId: existing.id,
        action: 'UPDATED',
        summary: ewtOnly
          ? `${existing.number} modified — EWT ${ratePct(num(ewtOnly.ewtRate))}, ${num(ewtOnly.netCollectible)} collectible (was ${num(existing.netCollectible)})`
          : manual
          ? `${existing.number} modified — ${num(updated.netCollectible)} collectible (was ${num(existing.netCollectible)})`
          : `${existing.number} modified — dates, terms, PO reference or notes; the figures stay ${existing.progressBilling?.number ?? 'the billing'}'s`,
        before: {
          invoiceDate: existing.invoiceDate,
          dueDate: existing.dueDate,
          terms: existing.terms,
          poReference: existing.poReference,
          ...(manual ? { customerId: existing.customerId, jobId: existing.jobId, netCollectible: num(existing.netCollectible) } : {}),
        },
        after: {
          ...headerData,
          ...(manual ? { customerId, jobId, netCollectible: manual.tax.netCollectible } : {}),
        },
      },
      req,
    );
    res.json(presentInvoice(updated));
  }),
);

/** Issuing is the act of sending it. Until then it is a draft nobody owes. */
invoiceRoutes.post(
  '/:id/issue',
  requireEdit('gfin', 'ar'),
  handler(async (req, res) => {
    const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!invoice) throw notFound('Invoice not found');
    assertCanEdit(currentUser(req), 'gfin', 'ar', invoice.createdById === currentUser(req).id, invoice.createdById);
    if (invoice.status !== 'DRAFT') throw badRequest('This invoice has already been issued');

    const updated = await prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: 'ISSUED', issuedAt: new Date() },
      include: invoiceInclude,
    });

    await audit(
      {
        entityType: 'invoice',
        entityId: invoice.id,
        action: 'SUBMITTED',
        summary: `${invoice.number} issued — ${num(invoice.netCollectible)} collectible, due ${invoice.dueDate.toISOString().slice(0, 10)}`,
      },
      req,
    );
    res.json(presentInvoice(updated));
  }),
);

/**
 * Countered (2026-10-15, the owner's sample): the customer received the
 * issued invoice on this day. The terms run from it, so the due date — the
 * expected collection — moves with it; until it is recorded the invoice is
 * awaiting countering and never overdue. A wrong day is corrected by saying
 * it again; never a day before the invoice or after today.
 */
invoiceRoutes.post(
  '/:id/counter',
  requireEdit('gfin', 'ar'),
  handler(async (req, res) => {
    const body = parseBody(
      z.object({
        counteredDate: z.string().optional(),
        termsDays: z.number().int().min(0).max(365).optional(),
      }),
      req.body,
    );
    const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!invoice) throw notFound('Invoice not found');
    assertCanEdit(currentUser(req), 'gfin', 'ar', invoice.createdById === currentUser(req).id, invoice.createdById);
    // "Mark as received" (2026-10-16, the owner's call: no customer is
    // involved in G-CORE's side of it): on a draft it issues the invoice and
    // records the day the customer received it, in one step.
    if (!['DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID'].includes(invoice.status)) {
      throw badRequest('A cancelled invoice is not countered');
    }
    const issuing = invoice.status === 'DRAFT';
    const today = dayKey(new Date());
    const counteredDate = body.counteredDate ? asDate(body.counteredDate, 'Countered date') : today;
    if (counteredDate < invoice.invoiceDate) throw badRequest('It cannot be countered before its invoice date');
    if (counteredDate > today) throw badRequest('It cannot be countered on a day still to come');
    const termsDays = body.termsDays ?? invoice.termsDays ?? Math.max(0, daysBetween(invoice.invoiceDate, invoice.dueDate));
    const dueDate = expectedCollection(invoice.invoiceDate, counteredDate, termsDays);

    // Claimed on what was read, so two people countering at once do not
    // both write a trail row over the other's day.
    const claimed = await prisma.invoice.updateMany({
      where: { id: invoice.id, status: invoice.status, counteredDate: invoice.counteredDate },
      data: { counteredDate, termsDays, dueDate, ...(issuing ? { status: 'ISSUED' as const, issuedAt: new Date() } : {}) },
    });
    if (!claimed.count) throw badRequest('It changed a moment ago — reload to see where it stands');
    const updated = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id }, include: invoiceInclude });

    await audit(
      {
        entityType: 'invoice',
        entityId: invoice.id,
        action: 'UPDATED',
        summary: `${invoice.number} ${issuing ? 'issued and ' : ''}received by the customer on ${formatDate(counteredDate)} — ${termsLabel(termsDays)}, expected ${formatDate(dueDate)}`,
        before: { counteredDate: invoice.counteredDate, dueDate: invoice.dueDate, termsDays: invoice.termsDays },
        after: { counteredDate, dueDate, termsDays },
      },
      req,
    );
    res.json(presentInvoice(updated));
  }),
);

/**
 * Who is credited with the invoice — the salesperson and the team. A
 * category, not a figure, so it changes at any stage but a cancelled one's.
 */
invoiceRoutes.patch(
  '/:id/credit',
  requireEdit('gfin', 'ar'),
  handler(async (req, res) => {
    const body = parseBody(creditSchema, req.body);
    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      select: { id: true, number: true, status: true, salespersonId: true, teamId: true, salesOrderId: true, jobId: true, jobOrderId: true, createdById: true },
    });
    if (!invoice) throw notFound('Invoice not found');
    assertCanEdit(currentUser(req), 'gfin', 'ar', invoice.createdById === currentUser(req).id, invoice.createdById);
    if (invoice.status === 'CANCELLED') throw badRequest('A cancelled invoice keeps the credit it had');
    const credit = await resolveCredit(
      { salespersonId: body.salespersonId === undefined ? invoice.salespersonId : body.salespersonId, teamId: body.teamId },
      invoice,
    );
    const updated = await prisma.invoice.update({ where: { id: invoice.id }, data: credit, include: invoiceInclude });
    await audit(
      {
        entityType: 'invoice',
        entityId: invoice.id,
        action: 'UPDATED',
        summary: `${invoice.number} credited to ${updated.salesperson?.name ?? 'nobody'}${updated.team ? ` (${updated.team.code})` : ''}`,
        before: { salespersonId: invoice.salespersonId, teamId: invoice.teamId },
        after: credit,
      },
      req,
    );
    res.json(presentInvoice(updated));
  }),
);

/** Recording the BIR 2307 that makes the withheld tax creditable. */
invoiceRoutes.patch(
  '/:id/certificate',
  requireEdit('gfin', 'ar'),
  handler(async (req, res) => {
    const body = parseBody(
      z.object({
        ewtCertificateNo: z.string().trim().min(1).nullable(),
        ewtCertificateAt: z.string().optional().nullable(),
      }),
      req.body,
    );
    const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!invoice) throw notFound('Invoice not found');
    assertCanEdit(currentUser(req), 'gfin', 'ar', invoice.createdById === currentUser(req).id, invoice.createdById);
    if (num(invoice.ewtAmount) <= 0) {
      throw badRequest('Nothing was withheld on this invoice, so there is no certificate to record');
    }

    const updated = await prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        ewtCertificateNo: body.ewtCertificateNo,
        ewtCertificateAt: body.ewtCertificateAt ? asDate(body.ewtCertificateAt, 'Certificate date') : null,
      },
      include: invoiceInclude,
    });

    await audit(
      {
        entityType: 'invoice',
        entityId: invoice.id,
        action: 'UPDATED',
        summary: body.ewtCertificateNo
          ? `BIR 2307 ${body.ewtCertificateNo} recorded for ${invoice.number} — ${num(invoice.ewtAmount)} creditable`
          : `BIR 2307 cleared on ${invoice.number}`,
      },
      req,
    );
    res.json(presentInvoice(updated));
  }),
);

invoiceRoutes.post(
  '/:id/cancel',
  requireEdit('gfin', 'ar'),
  handler(async (req, res) => {
    const body = parseBody(z.object({ reason: z.string().trim().min(3, 'Why?') }), req.body);
    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      include: { allocations: true },
    });
    if (!invoice) throw notFound('Invoice not found');
    assertCanEdit(currentUser(req), 'gfin', 'ar', invoice.createdById === currentUser(req).id, invoice.createdById);
    if (invoice.allocations.length) {
      throw badRequest(
        'Payments have been applied to this invoice. Remove the allocations first — cancelling it would leave money pointing at nothing.',
      );
    }
    if (invoice.status === 'CANCELLED') throw badRequest('Already cancelled');

    await prisma.$transaction(async (tx) => {
      // Claimed, so two cancels cannot both put the billing back.
      const claimed = await tx.invoice.updateMany({
        where: { id: invoice.id, status: { not: 'CANCELLED' } },
        data: {
          status: 'CANCELLED',
          voidedAt: new Date(),
          voidReason: body.reason,
          // The billing or job order it billed is let go, so either can be
          // invoiced again — the point of cancelling is usually that the
          // invoice was wrong, not the work. Both links are unique: kept, they
          // would block the corrected invoice for good.
          progressBillingId: null,
          jobOrderId: null,
        },
      });
      if (!claimed.count) throw badRequest('Already cancelled');
      if (invoice.progressBillingId) {
        await tx.progressBilling.update({
          where: { id: invoice.progressBillingId },
          data: { status: 'APPROVED' },
        });
      }
    });

    const jobOrder = invoice.jobOrderId
      ? await prisma.jobOrder.findUnique({ where: { id: invoice.jobOrderId }, select: { number: true } })
      : null;
    const billing = invoice.progressBillingId
      ? await prisma.progressBilling.findUnique({ where: { id: invoice.progressBillingId }, select: { number: true } })
      : null;
    await audit(
      {
        entityType: 'invoice',
        entityId: invoice.id,
        action: 'CANCELLED',
        summary:
          `${invoice.number} cancelled — ${body.reason}` +
          (billing ? `; billing ${billing.number} released to be invoiced again` : '') +
          (jobOrder ? `; job order ${jobOrder.number} released to be invoiced again` : ''),
      },
      req,
    );
    res.json({ ok: true });
  }),
);

/**
 * A cancelled (or never issued) invoice is deleted (2026-10-22, the owner's
 * report on a cancelled sample: "still can't delete this"): `gfin.ar.delete`
 * on one the caller raised or may edit all, or a super admin — the sales
 * order's rule. Nothing stands on it: a collection applied to it is refused
 * (a cancelled invoice has none, and a draft was never collected), its
 * lines and allocations cascade, an invoice request that raised it is let
 * go (SetNull), its files go with it, one DELETED audit row.
 */
invoiceRoutes.delete(
  '/:id',
  require_('gfin.ar.delete'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      include: { allocations: { select: { id: true } } },
    });
    if (!invoice) throw notFound('Invoice not found');
    if (!me.isSuperAdmin && !canEditRecord(me, 'gfin', 'ar', invoice.createdById)) {
      throw forbidden('Only whoever raised this invoice, or Edit All, may delete it');
    }
    if (invoice.status !== 'CANCELLED' && invoice.status !== 'DRAFT') {
      throw badRequest('Only a draft or a cancelled invoice can be deleted — cancel it first');
    }
    if (invoice.allocations.length) throw badRequest('Money was applied to this invoice — it is kept');
    await deleteOrRefuse(invoice.number, () => prisma.invoice.delete({ where: { id: invoice.id } }));
    await deleteAttachmentsOf('invoice', [invoice.id]);
    await audit(
      {
        entityType: 'invoice',
        entityId: invoice.id,
        action: 'DELETED',
        summary: `Deleted ${invoice.status === 'DRAFT' ? 'draft' : 'cancelled'} invoice ${invoice.number}`,
      },
      req,
    );
    res.json({ ok: true });
  }),
);

/** Approved billings with no invoice yet — the A/R work queue. */
invoiceRoutes.get(
  '/queue/uninvoiced',
  require_('gfin.ar.view_all'),
  handler(async (_req, res) => {
    const billings = await prisma.progressBilling.findMany({
      where: { status: 'APPROVED', invoice: null },
      include: {
        job: {
          select: {
            id: true,
            number: true,
            name: true,
            customer: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { billingDate: 'asc' },
    });

    res.json(
      billings.map((b) => ({
        id: b.id,
        number: b.number,
        billingNo: b.billingNo,
        billingDate: b.billingDate,
        job: b.job,
        grossAmount: num(b.grossAmount),
        invoiceTotal: num(b.invoiceTotal),
        netCollectible: num(b.netCollectible),
        waitingDays: daysBetween(b.billingDate, new Date()),
      })),
    );
  }),
);

// ════════════════════════════════════════════════════════════════════
//  ACCOUNTS PAYABLE — supplier bills
// ════════════════════════════════════════════════════════════════════

export const billRoutes = Router();
billRoutes.use(authenticate);

const billInclude = {
  supplier: { select: { id: true, code: true, name: true } },
  order: { select: { id: true, number: true, kind: true } },
  receiving: { select: { id: true, number: true, receivedDate: true } },
  job: { select: { id: true, number: true, name: true } },
  costCategory: { select: { id: true, name: true } },
  purchaser: { select: { id: true, name: true } },
  lines: { orderBy: { sortOrder: 'asc' } },
} satisfies Prisma.SupplierBillInclude;

type BillRow = Prisma.SupplierBillGetPayload<{ include: typeof billInclude }>;

function presentBill(row: BillRow) {
  const netPayable = num(row.netPayable);
  const paid = num(row.amountPaid);
  return {
    ...row,
    subtotal: num(row.subtotal),
    vatRate: num(row.vatRate),
    vatAmount: num(row.vatAmount),
    total: num(row.total),
    ewtRate: num(row.ewtRate),
    ewtAmount: num(row.ewtAmount),
    netPayable,
    amountPaid: paid,
    outstanding: cents(netPayable - paid),
    daysOverdue: daysBetween(row.dueDate, new Date()),
    termsLabel: billTermsLabel(row.termsDays, row.terms),
    lines: row.lines.map((l) => ({
      ...l,
      quantity: num(l.quantity),
      unitPrice: num(l.unitPrice),
      amount: num(l.amount),
    })),
  };
}

/**
 * The supplier bill list's where-builder — the screen's rows, its cards and
 * the printed list read the same set (`?ids=` narrows to the rows ticked). A
 * View Own holder reads the bills they entered (2026-10-18, `ownOnly`).
 */
function billListWhere(me: ResolvedUser, q: ListQuery): Prisma.SupplierBillWhereInput {
  return ownOnly(me, 'gfin', 'ap', billListWhereAll(q), (ids) => ({ createdById: { in: ids } }));
}

function billListWhereAll(q: ListQuery): Prisma.SupplierBillWhereInput {
  const where: Prisma.SupplierBillWhereInput = {};

  const status = choice(q.filters.status, BillStatus, 'Status');
  if (status) where.status = status;
  const f = q.filters;
  if (f.supplierId) where.supplierId = f.supplierId;
  if (f.jobId) where.jobId = f.jobId;
  if (f.purchaserId) Object.assign(where, f.purchaserId === 'none' ? { purchaserId: null, purchaserName: null } : { purchaserId: f.purchaserId });
  const and: Prisma.SupplierBillWhereInput[] = [];
  if (f.outstanding === 'true') and.push({ status: { in: [...BILL_PAYABLE] } });
  if (f.overdue === 'true') and.push({ status: { in: [...BILL_PAYABLE] }, dueDate: { lt: dayKey(new Date()) } });
  if (f.dueSoon === 'true') and.push(dueSoonWhere());
  if (f.pending === 'true') and.push({ status: { in: ['DRAFT', 'PENDING_APPROVAL'] } });
  if (f.dueFrom || f.dueTo) {
    and.push({ dueDate: { ...(f.dueFrom ? { gte: asDate(f.dueFrom, 'Due from') } : {}), ...(f.dueTo ? { lte: asDate(f.dueTo, 'Due to') } : {}) } });
  }
  if (f.deliveredFrom || f.deliveredTo) {
    and.push({
      deliveryDate: {
        ...(f.deliveredFrom ? { gte: asDate(f.deliveredFrom, 'Delivered from') } : {}),
        ...(f.deliveredTo ? { lte: asDate(f.deliveredTo, 'Delivered to') } : {}),
      },
    });
  }
  if (f.termsDays) {
    const days = Number(f.termsDays);
    if (!Number.isInteger(days) || days < 0) throw badRequest('Terms must be a whole number of days');
    and.push({ termsDays: days });
  }
  if (and.length) where.AND = and;
  if (q.search) {
    where.OR = [
      { number: { contains: q.search, mode: 'insensitive' } },
      { supplierInvoiceNo: { contains: q.search, mode: 'insensitive' } },
      { supplier: { name: { contains: q.search, mode: 'insensitive' } } },
      { purchaser: { name: { contains: q.search, mode: 'insensitive' } } },
      { purchaserName: { contains: q.search, mode: 'insensitive' } },
      { order: { number: { contains: q.search, mode: 'insensitive' } } },
    ];
  }
  const ids = idsFilter(q.filters.ids);
  if (ids) where.id = { in: ids };
  return where;
}

const BILL_SORTS = ['number', 'billDate', 'dueDate', 'deliveryDate', 'createdAt'];

/**
 * The A/P list's cards, under the list's own query (the owner's sample): the
 * sum of all payables (approved and partly paid, what is left of each), the
 * bills pending approval, what falls due in the next seven days, and what is
 * overdue — each a filter of the same list, so a card equals the list it opens.
 */
async function billListSummary(where: Prisma.SupplierBillWhereInput) {
  const today = dayKey(new Date());
  const [owed, pending, soon] = await Promise.all([
    prisma.supplierBill.findMany({
      where: { AND: [where, { status: { in: [...BILL_PAYABLE] } }] },
      select: { dueDate: true, netPayable: true, amountPaid: true },
    }),
    prisma.supplierBill.aggregate({
      where: { AND: [where, { status: { in: ['DRAFT', 'PENDING_APPROVAL'] } }] },
      _count: { _all: true },
      _sum: { netPayable: true },
    }),
    prisma.supplierBill.findMany({ where: { AND: [where, dueSoonWhere(today)] }, select: { netPayable: true, amountPaid: true } }),
  ]);
  const left = (r: { netPayable: Prisma.Decimal; amountPaid: Prisma.Decimal }) => Math.round((num(r.netPayable) - num(r.amountPaid)) * 100);
  let payable = 0;
  let count = 0;
  let overdue = 0;
  let overdueCount = 0;
  for (const r of owed) {
    const c = left(r);
    if (c <= 0) continue;
    payable += c;
    count++;
    if (r.dueDate < today) {
      overdue += c;
      overdueCount++;
    }
  }
  const dueSoon = soon.map(left).filter((c) => c > 0);
  return {
    payable: payable / 100,
    payableCount: count,
    pendingCount: pending._count._all,
    pending: num(pending._sum.netPayable),
    dueSoon: dueSoon.reduce((s, c) => s + c, 0) / 100,
    dueSoonCount: dueSoon.length,
    dueSoonDays: DUE_SOON_DAYS,
    overdue: overdue / 100,
    overdueCount,
  };
}

billRoutes.get(
  '/',
  requireView('gfin', 'ap'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const where = billListWhere(me, q);

    const [rows, total] = await Promise.all([
      prisma.supplierBill.findMany({
        where,
        include: billInclude,
        orderBy: orderBy(q, BILL_SORTS, { billDate: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.supplierBill.count({ where }),
    ]);

    res.json({
      ...listResult(rows.map((r) => ({ ...presentBill(r), canEdit: mayEdit(me, 'gfin', 'ap', r.createdById === me.id, r.createdById) })), total, q),
      summary: await billListSummary(where),
    });
  }),
);

/**
 * The A/P register on paper — the list as filtered (or the rows ticked),
 * through `billListWhere`. Billed, net payable (less what we withhold) and
 * outstanding, as the screen shows them. Billed, net payable and paid run over
 * every bill the filter matched, a cancelled one in brackets and not counted.
 * Outstanding is the PAYABLE — approved and partly paid bills only,
 * `financePosition`'s rule — so a bill not approved yet prints "—" there and a
 * note says how many are in the other totals; the unfiltered paper's
 * Outstanding equals the `?outstanding=true` paper's. Above `/:id`.
 */
billRoutes.get(
  '/pdf',
  requireView('gfin', 'ap'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const where = billListWhere(currentUser(req), q);
    const countedWhere: Prisma.SupplierBillWhereInput = { AND: [where, { status: { not: 'CANCELLED' } }] };
    // What is payable: an approved bill, paid in part or not at all.
    const owedWhere: Prisma.SupplierBillWhereInput = { AND: [where, { status: { in: BILL_OWED } }] };
    const [rows, count, sums, owed, byStatus, currency, supplier, project, purchaser] = await Promise.all([
      prisma.supplierBill.findMany({
        where,
        include: {
          supplier: { select: { name: true } },
          job: { select: { number: true, name: true } },
          receiving: { select: { number: true } },
          purchaser: { select: { name: true } },
        },
        orderBy: orderBy(q, BILL_SORTS, { billDate: 'desc' }),
        take: LIST_CAP,
      }),
      prisma.supplierBill.count({ where }),
      prisma.supplierBill.aggregate({ where: countedWhere, _sum: { total: true, netPayable: true, amountPaid: true } }),
      prisma.supplierBill.aggregate({ where: owedWhere, _sum: { netPayable: true, amountPaid: true } }),
      prisma.supplierBill.groupBy({ by: ['status'], where, _count: { _all: true } }),
      companyCurrency(),
      recordNamed('supplier', q.filters.supplierId),
      recordNamed('project', q.filters.jobId),
      q.filters.purchaserId === 'none'
        ? 'no purchaser'
        : q.filters.purchaserId
          ? prisma.user.findUnique({ where: { id: q.filters.purchaserId }, select: { name: true } }).then((u) => `bought by ${u?.name ?? 'someone not on file'}`)
          : undefined,
    ]);

    const f = q.filters;
    const status = choice(f.status, BillStatus, 'Status');
    const reference = listReference(count, rows.length, ['supplier bill', 'supplier bills'], [
      q.search && `search "${q.search}"`,
      f.overdue === 'true' ? 'overdue' : f.outstanding === 'true' ? 'outstanding' : status && `status ${statusLabel(status)}`,
      f.dueSoon === 'true' && `due in ${DUE_SOON_DAYS} days`,
      f.pending === 'true' && 'pending approval',
      (f.dueFrom || f.dueTo) && `due ${f.dueFrom ?? '…'} to ${f.dueTo ?? '…'}`,
      (f.deliveredFrom || f.deliveredTo) && `delivered ${f.deliveredFrom ?? '…'} to ${f.deliveredTo ?? '…'}`,
      f.termsDays && billTermsLabel(Number(f.termsDays)),
      supplier,
      project,
      purchaser,
      f.ids && 'the rows selected',
    ]);
    const today = dayKey(new Date());
    const billed = num(sums._sum.total);
    const payable = num(sums._sum.netPayable);
    const paid = num(sums._sum.amountPaid);
    const owing = cents(num(owed._sum.netPayable) - num(owed._sum.amountPaid));

    // Eight columns: landscape (rule 6).
    const sections: PdfSection[] = [
      {
        kind: 'table',
        head: ['Number', 'Supplier and project', 'Delivered', 'Terms', 'Due', `Payable (${currency})`, `Outstanding (${currency})`, 'Purchaser', 'Status'],
        align: ['left', 'left', 'left', 'left', 'left', 'right', 'right', 'left', 'left'],
        rows: rows.map((r) => {
          const inSum = r.status !== 'CANCELLED';
          const outstanding = cents(num(r.netPayable) - num(r.amountPaid));
          const late = (r.status === 'APPROVED' || r.status === 'PARTIALLY_PAID') && outstanding > 0 ? daysBetween(r.dueDate, today) : 0;
          return [
            r.number,
            {
              title: r.supplier.name,
              body: [
                r.supplierInvoiceNo && `Their invoice ${r.supplierInvoiceNo}`,
                r.job ? `${r.job.number} — ${r.job.name}` : 'No project',
                r.receiving?.number,
              ]
                .filter(Boolean)
                .join(' · '),
            },
            r.deliveryDate ? formatShortDate(r.deliveryDate) : { title: '—', body: `billed ${formatShortDate(r.billDate)}` },
            billTermsLabel(r.termsDays, r.terms),
            late > 0 ? { title: formatShortDate(r.dueDate), body: `${late} day${late === 1 ? '' : 's'} late` } : formatShortDate(r.dueDate),
            bracketed(formatAmount(num(r.netPayable)), inSum),
            // Nothing is payable on a bill until it is approved.
            r.status === 'DRAFT' || r.status === 'PENDING_APPROVAL' ? '—' : bracketed(formatAmount(outstanding), inSum),
            r.purchaser?.name ?? r.purchaserName ?? '—',
            statusLabel(r.status),
          ];
        }),
      },
      {
        kind: 'totals',
        rows: [
          { label: 'Billed', value: formatMoney(billed, currency) },
          { label: 'Net payable', value: formatMoney(payable, currency) },
          { label: 'Paid', value: formatMoney(paid, currency) },
          { label: totalLabel('Outstanding', count, rows.length), value: formatMoney(owing, currency), bold: true },
        ],
      },
    ];
    const inStatus = (st: BillStatus) => byStatus.find((g) => g.status === st)?._count._all ?? 0;
    const unapproved = inStatus('DRAFT') + inStatus('PENDING_APPROVAL');
    sections.push(
      ...listNotes([
        bracketNote(inStatus('CANCELLED'), ['cancelled bill', 'cancelled bills']),
        unapproved > 0 &&
          `${counted(unapproved, ['bill not approved yet is', 'bills not approved yet are'])} counted in Billed and Net payable but not in Outstanding — nothing is payable on ${unapproved === 1 ? 'it' : 'them'} until ${unapproved === 1 ? 'it is' : 'they are'} approved.`,
      ]),
    );

    const pdf = await renderDocument({ title: 'Supplier Bills', date: new Date(), reference, landscape: true, sections });
    await audit(
      {
        entityType: 'supplier_bill',
        entityId: 'list',
        action: 'EXPORTED',
        summary: `Exported the supplier bill list as PDF (${rows.length} bill(s))`,
      },
      req,
    );
    sendListPdf(res, pdf, 'supplier-bills.pdf');
  }),
);

billRoutes.get(
  '/:id',
  requireView('gfin', 'ap'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await prisma.supplierBill.findUnique({
      where: { id: req.params.id },
      include: {
        ...billInclude,
        allocations: {
          include: {
            payment: {
              select: { id: true, number: true, paymentDate: true, method: true, reference: true },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!row) throw notFound('Supplier bill not found');
    // View Own reads the bills one entered; Edit Own changes them (2026-10-18).
    assertCanView(me, 'gfin', 'ap', row.createdById === me.id, row.createdById);
    res.json({
      ...presentBill(row),
      canEdit: mayEdit(me, 'gfin', 'ap', row.createdById === me.id, row.createdById),
      allocations: row.allocations.map((a) => ({ ...a, amount: num(a.amount) })),
    });
  }),
);

const billSchema = z.object({
  supplierId: z.string().min(1, 'Which supplier?'),
  orderId: z.string().optional().nullable(),
  receivingId: z.string().optional().nullable(),
  jobId: z.string().optional().nullable(),
  costCategoryId: z.string().optional().nullable(),
  supplierInvoiceNo: z.string().optional().nullable(),
  billDate: z.string().optional(),
  dueDate: z.string().optional(),
  terms: z.string().optional().nullable(),
  /** When the goods or the work were delivered — the receiving's date where one is matched. */
  deliveryDate: z.string().optional().nullable(),
  termsDays: z.number().int().min(0).max(365).optional(),
  /** The purchaser / buyer — the order's author when the bill is against one. */
  purchaserId: z.string().optional().nullable(),
  /** A purchaser with no login, by name — used when no `purchaserId` is sent. */
  purchaserName: z.string().trim().max(120).optional().nullable(),
  vatRate: z.number().min(0).max(1).optional(),
  vatInclusive: z.boolean().default(false),
  ewtRate: z.number().min(0).max(1).default(0),
  notes: z.string().optional().nullable(),
  lines: z
    .array(
      z.object({
        description: z.string().trim().min(1, 'Every line needs a description'),
        quantity: z.number().default(1),
        unitPrice: z.number(),
      }),
    )
    .min(1, 'A bill needs at least one line'),
});

type BillBody = z.infer<typeof billSchema>;

/**
 * A bill's money, from its lines — the one rule for entering a bill and for
 * modifying a draft one. Each line is taken to the centavo first, so the
 * figures are the sum of what is stored under them.
 */
function billMoney(body: Pick<BillBody, 'lines' | 'vatInclusive' | 'ewtRate'>, vatRate: number) {
  const lines = body.lines.map((l, i) => ({
    sortOrder: i,
    description: l.description,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    amount: cents(l.quantity * l.unitPrice),
  }));
  const lineTotal = cents(lines.reduce((s, l) => s + l.amount, 0));
  if (lineTotal <= 0) throw badRequest('The bill total must be more than zero');

  // A supplier's invoice may quote VAT-inclusive prices. Back it out rather
  // than adding VAT on top of VAT.
  const subtotal = body.vatInclusive ? cents(lineTotal / (1 + vatRate)) : lineTotal;
  const vatAmount = cents(subtotal * vatRate);
  const total = cents(subtotal + vatAmount);
  // Withheld on the subtotal, never on the VAT — the same rule as the
  // receivable side, in the other direction.
  const ewtAmount = cents(subtotal * body.ewtRate);
  const netPayable = cents(total - ewtAmount);
  return {
    total,
    netPayable,
    figures: {
      subtotal: D(subtotal),
      vatRate: D(vatRate),
      vatAmount: D(vatAmount),
      total: D(total),
      ewtRate: D(body.ewtRate),
      ewtAmount: D(ewtAmount),
      netPayable: D(netPayable),
    },
    lines: lines.map((l) => ({ ...l, quantity: D(l.quantity), unitPrice: D(l.unitPrice), amount: D(l.amount) })),
  };
}

/**
 * Which supplier, order, receiving and project a bill belongs to — checked
 * the same way on entry and on Modify.
 *
 * The job comes from the order where none is given — the point of raising a
 * bill against an order is not retyping it. And the RECEIVING is what stops
 * the bill charging the project a second time at approval: an order with
 * goods received always lends the bill one, and a receiving named outright
 * must be of that order and that supplier.
 */
async function billLinks(input: {
  supplierId: string;
  orderId: string | null;
  receivingId: string | null;
  jobId: string | null;
}) {
  const supplier = await prisma.supplier.findUnique({ where: { id: input.supplierId }, select: { id: true } });
  if (!supplier) throw badRequest('That supplier does not exist');

  let jobId = input.jobId;
  let receivingId = input.receivingId;
  let buyerId: string | null = null;
  let receivedDate: Date | null = null;
  if (input.orderId) {
    const order = await prisma.purchaseOrder.findUnique({
      where: { id: input.orderId },
      // Goods RECEIVED — a report still waiting for its approval posted nothing.
      include: { receivings: { where: { status: 'RECEIVED' }, select: { id: true }, orderBy: { receivedDate: 'desc' } } },
    });
    if (!order) throw notFound('Purchase order not found');
    if (order.supplierId !== input.supplierId) {
      throw badRequest('That order belongs to a different supplier');
    }
    if (!jobId) jobId = order.jobId;
    buyerId = order.createdById;
    // If the goods have been received and nobody said which receiving, take
    // the latest: what matters is that a receiving EXISTS, because that is
    // what stops the bill posting cost a second time.
    if (!receivingId && order.receivings.length) receivingId = order.receivings[0].id;
  }
  if (receivingId) {
    const receiving = await prisma.receiving.findUnique({
      where: { id: receivingId },
      select: { orderId: true, status: true, number: true, receivedDate: true, order: { select: { supplierId: true, createdById: true } } },
    });
    if (!receiving) throw notFound('Receiving not found');
    receivedDate = receiving.receivedDate;
    if (!buyerId && receiving.order) buyerId = receiving.order.createdById;
    // A bill matched to a report that posted nothing would post no cost
    // either — the cost the receiving was to carry would be charged nowhere.
    if (receiving.status !== 'RECEIVED') throw badRequest(`${receiving.number} is ${receiving.status.toLowerCase().replace(/_/g, ' ')} — a bill is matched to goods received`);
    if (input.orderId && receiving.orderId !== input.orderId) {
      throw badRequest('That receiving is against a different order');
    }
    // Goods received without an order have no supplier's bill behind them.
    if (!receiving.order) throw badRequest(`${receiving.number} was received without a purchase order — there is no bill to match`);
    if (receiving.order.supplierId !== input.supplierId) {
      throw badRequest('Those goods came from a different supplier');
    }
  }
  return { links: { orderId: input.orderId, receivingId, jobId }, buyerId, receivedDate };
}

/** A purchaser named on a bill must be an active login. */
async function checkPurchaser(id: string | null | undefined): Promise<void> {
  if (!id) return;
  const user = await prisma.user.findUnique({ where: { id }, select: { isActive: true } });
  if (!user?.isActive) throw badRequest('Purchaser: no such active login');
}

billRoutes.post(
  '/',
  require_('gfin.ap.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(billSchema, req.body);
    const settings = await financeSettings();
    const rates = await currentRates();

    const money = billMoney(body, body.vatRate ?? rates.vatRate);

    const billDate = body.billDate ? asDate(body.billDate, 'Bill date') : dayKey(new Date());
    const { links, buyerId, receivedDate } = await billLinks({
      supplierId: body.supplierId,
      orderId: body.orderId || null,
      receivingId: body.receivingId || null,
      jobId: body.jobId || null,
    });
    // The receiving's date, else typed; the terms run from it.
    const deliveryDate = body.deliveryDate ? asDate(body.deliveryDate, 'Date of delivery') : receivedDate;
    const termsDays = body.termsDays ?? parseTermsDays(body.terms) ?? settings.defaultTermsDays;
    const dueDate = body.dueDate ? asDate(body.dueDate, 'Due date') : billDueDate(billDate, deliveryDate, termsDays);
    if (dueDate < (deliveryDate ?? billDate)) throw badRequest(deliveryDate ? 'The due date is before the delivery' : 'The due date is before the bill date');
    // A name typed for someone with no login stands in place of a login.
    const purchaserName = !body.purchaserId && body.purchaserName ? body.purchaserName : null;
    const purchaserId = purchaserName ? null : body.purchaserId || buyerId;
    await checkPurchaser(purchaserId);

    const bill = await prisma.$transaction(async (tx) => {
      const number = await nextNumber('supplier_bill', tx);
      return tx.supplierBill.create({
        data: {
          number,
          supplierId: body.supplierId,
          ...links,
          costCategoryId: body.costCategoryId || null,
          supplierInvoiceNo: body.supplierInvoiceNo || null,
          billDate,
          dueDate,
          deliveryDate,
          termsDays,
          purchaserId: purchaserId ?? null,
          purchaserName,
          terms: body.terms ?? `${termsDays} days`,
          ...money.figures,
          notes: body.notes || null,
          createdById: me.id,
          lines: { create: money.lines },
        },
        include: billInclude,
      });
    });

    await audit(
      {
        entityType: 'supplier_bill',
        entityId: bill.id,
        action: 'CREATED',
        summary: `${bill.number} from ${bill.supplier.name} — ${money.total} total, ${money.netPayable} payable`,
      },
      req,
    );
    res.status(201).json(presentBill(bill));
  }),
);

/**
 * What Modify takes for a bill: the entry form, with every field but the
 * lines optional — a field the body leaves out keeps what is stored, where
 * the entry form would default it (no withholding, VAT-exclusive prices).
 */
const billModifySchema = billSchema.extend({
  supplierId: z.string().min(1, 'Which supplier?').optional(),
  vatInclusive: z.boolean().optional(),
  ewtRate: z.number().min(0).max(1).optional(),
});

/**
 * Modifying a draft bill (2026-10-09, Phase 2 of the button standard).
 *
 * Only while DRAFT: submitting snapshots the amount the approval route was
 * picked by, so a bill with the approver is not edited under them. The lines
 * are always sent and replace the bill's; the money is recomputed by
 * `billMoney()` at the VAT rate the bill was entered with unless the body
 * names another. Every other field the body leaves out keeps what is stored
 * — the supplier, the withholding rate, whether the prices include VAT
 * (read off the stored subtotal against its lines), the project, the budget
 * line, the supplier's invoice number, dates, terms and notes; a null clears
 * it. The supplier, order and receiving are re-checked by `billLinks()`, so a
 * bill against received goods keeps a receiving and still charges nothing at
 * approval (a cleared receiving on an order with goods received is lent one
 * back). Claimed on DRAFT, so a submit that lands first wins.
 */
billRoutes.put(
  '/:id',
  requireEdit('gfin', 'ap'),
  handler(async (req, res) => {
    const body = parseBody(billModifySchema, req.body);
    const existing = await prisma.supplierBill.findUnique({
      where: { id: req.params.id },
      include: { lines: { select: { amount: true } } },
    });
    if (!existing) throw notFound('Supplier bill not found');
    assertCanEdit(currentUser(req), 'gfin', 'ap', existing.createdById === currentUser(req).id, existing.createdById);
    if (existing.status !== 'DRAFT') {
      throw badRequest(
        existing.status === 'PENDING_APPROVAL'
          ? 'Only a draft bill can be modified — this one is with the approver'
          : `Only a draft bill can be modified — this one is ${existing.status.toLowerCase().replace(/_/g, ' ')}`,
      );
    }

    // A bill entered VAT-inclusive stores its lines as typed and its subtotal
    // with the VAT backed out — so the two differ exactly when it was.
    const storedLineTotal = cents(existing.lines.reduce((s, l) => s + num(l.amount), 0));
    const storedInclusive = Math.abs(num(existing.subtotal) - storedLineTotal) > 0.005;
    const keep = <T,>(sent: T | null | undefined, stored: T | null): T | null =>
      sent === undefined ? stored : sent || null;

    const supplierId = body.supplierId ?? existing.supplierId;
    const money = billMoney(
      {
        lines: body.lines,
        vatInclusive: body.vatInclusive ?? storedInclusive,
        ewtRate: body.ewtRate ?? num(existing.ewtRate),
      },
      body.vatRate ?? num(existing.vatRate),
    );
    const billDate = body.billDate ? asDate(body.billDate, 'Bill date') : existing.billDate;
    const { links, buyerId, receivedDate } = await billLinks({
      supplierId,
      orderId: keep(body.orderId, existing.orderId),
      receivingId: keep(body.receivingId, existing.receivingId),
      jobId: keep(body.jobId, existing.jobId),
    });
    const deliveryDate =
      body.deliveryDate === undefined
        ? existing.deliveryDate ?? receivedDate
        : body.deliveryDate
          ? asDate(body.deliveryDate, 'Date of delivery')
          : receivedDate;
    const termsDays = body.termsDays ?? existing.termsDays ?? parseTermsDays(existing.terms) ?? 0;
    const dueDate = body.dueDate
      ? asDate(body.dueDate, 'Due date')
      : body.termsDays !== undefined || body.deliveryDate !== undefined || body.billDate
        ? billDueDate(billDate, deliveryDate, termsDays)
        : existing.dueDate;
    if (dueDate < (deliveryDate ?? billDate)) throw badRequest(deliveryDate ? 'The due date is before the delivery' : 'The due date is before the bill date');
    const purchaserName =
      body.purchaserId
        ? null
        : body.purchaserName === undefined
          ? body.purchaserId === undefined
            ? existing.purchaserName
            : null
          : body.purchaserName || null;
    const purchaserId = purchaserName
      ? null
      : body.purchaserId === undefined
        ? existing.purchaserId ?? buyerId
        : body.purchaserId || buyerId;
    await checkPurchaser(purchaserId);

    const updated = await prisma.$transaction(async (tx) => {
      const claimed = await tx.supplierBill.updateMany({
        where: { id: existing.id, status: 'DRAFT' },
        data: {
          supplierId,
          ...links,
          costCategoryId: keep(body.costCategoryId, existing.costCategoryId),
          supplierInvoiceNo: keep(body.supplierInvoiceNo, existing.supplierInvoiceNo),
          billDate,
          dueDate,
          deliveryDate,
          termsDays,
          purchaserId: purchaserId ?? null,
          purchaserName,
          terms: body.termsDays !== undefined ? `${termsDays} days` : keep(body.terms, existing.terms),
          ...money.figures,
          notes: keep(body.notes, existing.notes),
        },
      });
      if (!claimed.count) throw badRequest('It was submitted a moment ago — reload to see where it stands');
      await tx.supplierBillLine.deleteMany({ where: { billId: existing.id } });
      await tx.supplierBillLine.createMany({ data: money.lines.map((l) => ({ ...l, billId: existing.id })) });
      return tx.supplierBill.findUniqueOrThrow({ where: { id: existing.id }, include: billInclude });
    });

    await audit(
      {
        entityType: 'supplier_bill',
        entityId: existing.id,
        action: 'UPDATED',
        summary:
          `${existing.number} modified — ${money.total} total, ${money.netPayable} payable` +
          (updated.receiving ? `; matched to ${updated.receiving.number}, so approval charges nothing` : ''),
        before: {
          supplierId: existing.supplierId,
          orderId: existing.orderId,
          receivingId: existing.receivingId,
          jobId: existing.jobId,
          costCategoryId: existing.costCategoryId,
          total: num(existing.total),
          netPayable: num(existing.netPayable),
        },
        after: {
          supplierId: updated.supplierId,
          orderId: updated.orderId,
          receivingId: updated.receivingId,
          jobId: updated.jobId,
          costCategoryId: updated.costCategoryId,
          total: money.total,
          netPayable: money.netPayable,
        },
      },
      req,
    );
    res.json(presentBill(updated));
  }),
);

/**
 * Cancelling a draft bill — one entered in error, or that the supplier
 * withdrew. Only a draft: nothing has been decided, posted or paid on it. The
 * bill has no column of its own for the reason, so it is kept on its notes
 * and in the trail. Claimed on DRAFT, so a submit that lands first wins.
 */
billRoutes.post(
  '/:id/cancel',
  requireEdit('gfin', 'ap'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(z.object({ reason: z.string().trim().min(3, 'Why?') }), req.body ?? {});
    const bill = await prisma.supplierBill.findUnique({ where: { id: req.params.id } });
    if (!bill) throw notFound('Supplier bill not found');
    assertCanEdit(me, 'gfin', 'ap', bill.createdById === me.id, bill.createdById);
    if (bill.status !== 'DRAFT') {
      throw badRequest(
        bill.status === 'CANCELLED'
          ? 'Already cancelled'
          : 'Only a draft bill can be cancelled — this one has gone for approval',
      );
    }

    await prisma.$transaction(async (tx) => {
      const claimed = await tx.supplierBill.updateMany({
        where: { id: bill.id, status: 'DRAFT' },
        data: { status: 'CANCELLED', notes: `${bill.notes ? `${bill.notes}\n` : ''}Cancelled: ${body.reason}` },
      });
      if (!claimed.count) throw badRequest('It was submitted a moment ago — reload to see where it stands');
      // A draft has nothing open with an approver; one left behind by a
      // refused submit goes with it, through the engine.
      await cancelOpenRequest('supplier_bill', bill.id, tx, `cancelled by ${me.name}: ${body.reason}`, me.id);
    });

    await audit(
      { entityType: 'supplier_bill', entityId: bill.id, action: 'CANCELLED', summary: `${bill.number} cancelled — ${body.reason}` },
      req,
    );
    res.json({ ok: true });
  }),
);

billRoutes.post(
  '/:id/submit',
  require_('gfin.ap.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const bill = await prisma.supplierBill.findUnique({
      where: { id: req.params.id },
      include: { supplier: true },
    });
    if (!bill) throw notFound('Supplier bill not found');
    if (bill.status !== 'DRAFT') throw badRequest('This bill has already been submitted');

    // Claimed on the bill exactly as read — still a draft, and not modified
    // since (`updatedAt`, which every write to a bill moves). The request
    // below snapshots this read's amount and subject, and the route is picked
    // by that amount, so a Modify or a cancel that lands between the read and
    // the claim refuses the submit rather than sending stale figures.
    const claimed = await prisma.supplierBill.updateMany({
      where: { id: bill.id, status: 'DRAFT', updatedAt: bill.updatedAt },
      data: { status: 'PENDING_APPROVAL' },
    });
    if (!claimed.count) throw badRequest('It changed a moment ago — reload to see where it stands');

    try {
      await submitForApproval({
        documentType: 'supplier_bill',
        documentId: bill.id,
        documentNumber: bill.number,
        subject: `${bill.supplier.name} — ${bill.supplierInvoiceNo ?? bill.number}`,
        amount: num(bill.total),
        link: `/g-fin/ap/${bill.id}`,
        requesterId: me.id,
      });
    } catch (err) {
      // The engine refused (no workflow, nobody to approve). The bill goes
      // back to DRAFT rather than sitting PENDING with no request behind it.
      await prisma.supplierBill.updateMany({
        where: { id: bill.id, status: 'PENDING_APPROVAL' },
        data: { status: 'DRAFT' },
      });
      throw err;
    }

    await audit(
      { entityType: 'supplier_bill', entityId: bill.id, action: 'SUBMITTED', summary: `${bill.number} sent for approval` },
      req,
    );
    res.json({ ok: true });
  }),
);

/**
 * A decision that finds the bill no longer pending changes nothing. A repeat
 * on a bill already settled says nothing; one on a bill that went back to
 * draft or was cancelled meanwhile is written down, so the trail explains
 * why the approval history and the bill disagree.
 */
async function billNotApplied(billId: string, outcome: ApprovalOutcome) {
  const bill = await prisma.supplierBill.findUnique({ where: { id: billId }, select: { number: true, status: true } });
  if (!bill || (bill.status !== 'DRAFT' && bill.status !== 'CANCELLED')) return;
  await audit({
    entityType: 'supplier_bill',
    entityId: billId,
    action: 'UPDATED',
    summary: `${bill.number} ${outcome === 'APPROVED' ? 'approved' : 'rejected'} after it was ${bill.status === 'DRAFT' ? 'put back to draft' : 'cancelled'} — not applied`,
  });
}

/**
 * An approved bill posts job cost ONLY when nothing has already incurred it.
 *
 * Receiving posts INCURRED at the moment the goods arrive (Phase 5). A bill for
 * those same goods is the paperwork catching up, not a second cost. But a bill
 * with no receiving behind it — a subcontractor's certificate, a service call,
 * a hauling charge — is the first and only time that cost appears, so it must
 * post.
 *
 * Getting this wrong charges a project twice for the same peso, which is the
 * single most common defect in this codebase's problem space.
 *
 * The outcome is applied only while the bill is still PENDING_APPROVAL — a
 * conditional claim, so a repeated settlement posts nothing the second time.
 */
onApprovalSettled('supplier_bill', async (approval, outcome) => {
  const bill = await prisma.supplierBill.findUnique({
    where: { id: approval.documentId },
    include: { supplier: true, job: true, receiving: true },
  });
  if (!bill) return;
  if (bill.status !== 'PENDING_APPROVAL') return billNotApplied(bill.id, outcome);

  if (outcome !== 'APPROVED') {
    const claimed = await prisma.supplierBill.updateMany({
      where: { id: bill.id, status: 'PENDING_APPROVAL' },
      data: { status: 'CANCELLED' },
    });
    if (!claimed.count) return billNotApplied(bill.id, outcome);
    await audit({
      entityType: 'supplier_bill',
      entityId: bill.id,
      action: 'REJECTED',
      summary: `${bill.number} rejected — nothing posted, nothing payable`,
    });
    return;
  }

  const alreadyIncurred = bill.receivingId !== null;
  const postable = !alreadyIncurred && bill.jobId && bill.costCategoryId && num(bill.subtotal) > 0;

  const applied = await prisma.$transaction(async (tx) => {
    const claimed = await tx.supplierBill.updateMany({
      where: { id: bill.id, status: 'PENDING_APPROVAL' },
      data: {
        status: 'APPROVED',
        approvedAt: new Date(),
        postedToJob: !!postable,
        postedAt: postable ? new Date() : null,
      },
    });
    if (!claimed.count) return false;

    if (postable) {
      // Net of VAT: input VAT is recoverable, so the project bears the
      // subtotal. The same basis Phase 5's receiving uses.
      await postJobCost(tx, {
        jobId: bill.jobId!,
        costCategoryId: bill.costCategoryId!,
        state: 'INCURRED',
        amount: num(bill.subtotal),
        sourceType: 'supplier_bill',
        sourceId: bill.id,
        sourceNumber: bill.number,
        description: `${bill.supplier.name} — ${bill.supplierInvoiceNo ?? 'bill'}`,
      });
    }
    return true;
  });
  if (!applied) return billNotApplied(bill.id, outcome);

  await audit({
    entityType: 'supplier_bill',
    entityId: bill.id,
    action: 'APPROVED',
    summary: postable
      ? `${bill.number} approved — ${num(bill.subtotal)} charged to ${bill.job?.number}`
      : alreadyIncurred
        ? `${bill.number} approved — no cost posted, ${bill.receiving?.number} already incurred it`
        : `${bill.number} approved — no project or category, so nothing was charged`,
  });
});

/**
 * Takes back the INCURRED cost a document's approval posted, by posting its
 * negative per project and budget line (never deleting — the ledger is a
 * history). Reads what the ledger still holds for the source, so a document
 * approved, pulled back and approved again nets out exactly.
 */
async function reverseIncurred(
  tx: Prisma.TransactionClient,
  source: { sourceType: string; sourceId: string; sourceNumber: string },
  why: string,
  actorId: string,
): Promise<number> {
  const rows = await tx.jobCostEntry.groupBy({
    by: ['jobId', 'costCategoryId'],
    where: { sourceType: source.sourceType, sourceId: source.sourceId, state: 'INCURRED' },
    _sum: { amount: true },
  });
  let reversed = 0;
  for (const r of rows) {
    const net = num(r._sum.amount);
    if (Math.abs(net) < 0.005) continue;
    await postJobCost(tx, {
      jobId: r.jobId,
      costCategoryId: r.costCategoryId,
      state: 'INCURRED',
      amount: -net,
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      sourceNumber: source.sourceNumber,
      description: `Reversed — ${source.sourceNumber} pulled back to draft: ${why}`,
      createdById: actorId,
    });
    reversed = cents(reversed + net);
  }
  return reversed;
}

/**
 * Pulled back after approval (2026-10-16): the bill goes back to DRAFT and the
 * cost its approval charged the project is reversed. Refused once anything
 * has been paid on it — the payment would be left settling a draft.
 */
onApprovalReopened('supplier_bill', {
  may: async (actor, id) => {
    const bill = await prisma.supplierBill.findUnique({ where: { id }, select: { status: true, createdById: true } });
    return !!bill && !['DRAFT', 'PENDING_APPROVAL', 'CANCELLED'].includes(bill.status) && canEditRecord(actor, 'gfin', 'ap', bill.createdById);
  },
  reopen: async ({ documentId, tx, actor, reason }) => {
    const bill = await tx.supplierBill.findUnique({ where: { id: documentId } });
    if (!bill) throw badRequest('Bill not found');
    const paid = await tx.paymentAllocation.findFirst({ where: { billId: bill.id }, include: { payment: { select: { number: true } } } });
    if (paid || bill.status !== 'APPROVED') {
      throw badRequest(`${bill.number} has been paid${paid ? ` (${paid.payment.number})` : ''} — remove the payment before pulling it back`);
    }
    const claimed = await tx.supplierBill.updateMany({
      where: { id: bill.id, status: 'APPROVED' },
      data: { status: 'DRAFT', approvedAt: null, postedToJob: false, postedAt: null },
    });
    if (!claimed.count) throw badRequest(`${bill.number} changed a moment ago — reload to see where it stands`);
    const reversed = await reverseIncurred(tx, { sourceType: 'supplier_bill', sourceId: bill.id, sourceNumber: bill.number }, reason, actor.id);
    await audit(
      {
        entityType: 'supplier_bill',
        entityId: bill.id,
        action: 'UPDATED',
        summary: `${bill.number} back to draft after approval${reversed ? ` — ${reversed} taken back off the project` : ''}`,
        actorId: actor.id,
        actorName: actor.name,
      },
      undefined,
      tx,
    );
  },
});

/** Purchase orders with goods received and no bill yet — the A/P work queue. */
billRoutes.get(
  '/queue/unbilled',
  require_('gfin.ap.view_all'),
  handler(async (_req, res) => {
    const receivings = await prisma.receiving.findMany({
      // Goods received without an order are billed by nobody.
      where: { status: 'RECEIVED', orderId: { not: null }, bills: { none: {} } },
      include: {
        order: {
          select: {
            id: true,
            number: true,
            total: true,
            supplier: { select: { id: true, name: true } },
            job: { select: { id: true, number: true, name: true } },
          },
        },
        items: { select: { quantity: true, unitCost: true } },
      },
      orderBy: { receivedDate: 'asc' },
      take: 100,
    });

    res.json(
      receivings.map((r) => ({
        id: r.id,
        number: r.number,
        receivedDate: r.receivedDate,
        invoiceRefNo: r.invoiceRefNo,
        order: { ...r.order!, total: num(r.order!.total) },
        receivedValue: cents(r.items.reduce((s, i) => s + num(i.quantity) * num(i.unitCost), 0)),
        waitingDays: daysBetween(r.receivedDate, new Date()),
      })),
    );
  }),
);

// ════════════════════════════════════════════════════════════════════
//  EXPENSE CLAIMS
// ════════════════════════════════════════════════════════════════════

export const expenseRoutes = Router();
expenseRoutes.use(authenticate);

/**
 * The receipts on a claim are the claim's. Reading them (listing, serving) is
 * the same door as GET /:id — the claimant, or whoever reads every claim
 * (super admins pass the engine's own check); knowing a file's id is not the
 * same right as seeing the claim. Changing them is Modify's door: a DRAFT, by
 * the claimant with `edit_own` or by `edit_all` — the receipts are what the
 * approver decides on, so they do not change under a submitted claim.
 *
 * The shared guard does not yet say which it is asked: it answers listing,
 * serving and uploading alike, and DELETE /attachments/:id asks only whether
 * the caller uploaded the file. Until `AttachmentGuard` passes the intent —
 * 'write' from `guardRecord` on POST and from that DELETE — every call reads
 * as 'read', and only the page holds uploads to a draft.
 */
registerAttachmentGuard('expense_claim', async (user, id, mode: 'read' | 'write' = 'read') => {
  const claim = await prisma.expenseClaim.findUnique({ where: { id }, select: { claimedById: true, status: true } });
  if (!claim) return false;
  if (mode === 'write') return claim.status === 'DRAFT' && canEditRecord(user, 'gfin', 'expenses', claim.claimedById);
  return claim.claimedById === user.id || can(user, 'gfin.expenses.view_all');
});

export const claimInclude = {
  claimedBy: { select: { id: true, name: true, email: true, ...USER_TEAM_SELECT.select } },
  job: { select: { id: true, number: true, name: true } },
  costCategory: { select: { id: true, name: true } },
  // `amountRefunded`: unspent cash already handed back — the liquidation
  // report's paper takes it off what it says is owed back.
  advance: {
    select: { id: true, number: true, amountReleased: true, amountRefunded: true, status: true, jobId: true, costCategoryId: true },
  },
  // Project cash liquidated the same way — a claim names one or the other.
  budgetRequest: {
    select: { id: true, number: true, amountReleased: true, amountRefunded: true, status: true, jobId: true, costCategoryId: true },
  },
  lines: { orderBy: { sortOrder: 'asc' } },
} satisfies Prisma.ExpenseClaimInclude;

type ClaimRow = Prisma.ExpenseClaimGetPayload<{ include: typeof claimInclude }>;

/**
 * A claim as the screens read it.
 *
 * `payable` is what the person is still owed on this document — the total for
 * a reimbursement, the excess over the advance for a liquidation. `refundDue`
 * is the other direction: unspent cash the liquidation says must come back,
 * carried on the advance but shown here so the page can say so.
 */
export function presentClaim(row: ClaimRow) {
  const total = num(row.total);
  const paid = num(row.amountPaid);
  const payable = claimPayable(row);
  const released = liquidatedReleased(row);
  const liquidates = !!(row.advance || row.budgetRequest);
  const { employee: _e, ...claimant } = row.claimedBy;
  return {
    ...row,
    claimedBy: claimant,
    /** The claimant's team — the register's Team column. */
    team: teamOfUser(row.claimedBy),
    total,
    amountPaid: paid,
    payable,
    outstanding: cents(payable - paid),
    refundDue: liquidates ? cents(Math.max(0, released - total)) : 0,
    kind: liquidates ? ('liquidation' as const) : ('reimbursement' as const),
    advance: row.advance
      ? { ...row.advance, amountReleased: num(row.advance.amountReleased), amountRefunded: num(row.advance.amountRefunded) }
      : null,
    budgetRequest: row.budgetRequest
      ? { ...row.budgetRequest, amountReleased: num(row.budgetRequest.amountReleased), amountRefunded: num(row.budgetRequest.amountRefunded) }
      : null,
    lines: row.lines.map((l) => ({ ...l, amount: num(l.amount) })),
  };
}

/**
 * What a claim or an advance may be charged to.
 *
 * Not `/jobs/lookup`: naming the project you spent money on is not the same
 * right as project-management access, and the filing roles hold none of it.
 * TURNED_OVER jobs are kept on purpose — a late receipt against a turned-over
 * job is legitimate, and refusing it would push the cost to overheads.
 */
/**
 * "Submit for approval sends it to …" — the claim page's preview, at the total
 * on the page, in the claimant's name (a draft's, else the caller's). Above
 * `/:id`.
 */
expenseRoutes.get(
  '/route',
  requireAny('gfin.expenses.create', 'gfin.expenses.edit_own', 'gfin.expenses.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const amount = Number(req.query.amount ?? 0);
    if (!Number.isFinite(amount) || amount < 0) throw badRequest('The amount is not a number');
    const claimId = req.query.claimId ? String(req.query.claimId) : null;
    const row = claimId ? await prisma.expenseClaim.findUnique({ where: { id: claimId }, select: { claimedById: true } }) : null;
    if (claimId && !row) throw notFound('Claim not found');
    res.json({ route: await routeBrief('expense', amount, row?.claimedById ?? me.id, null) });
  }),
);

expenseRoutes.get(
  '/chargeable',
  requireAny('gfin.expenses.create', 'gfin.cash_advances.create'),
  handler(async (_req, res) => {
    const [jobs, categories] = await Promise.all([
      prisma.job.findMany({
        where: { status: { notIn: ['CANCELLED'] } },
        select: { id: true, number: true, name: true },
        orderBy: { number: 'desc' },
        take: 300,
      }),
      prisma.costCategory.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
        orderBy: { sortOrder: 'asc' },
      }),
    ]);
    res.json({ jobs, categories });
  }),
);

/**
 * The expense claim list's where-builder — the screen's rows and the printed
 * list read the same set. A `view_own` holder reads only their own claims
 * whatever the URL says (`mine`), and `?ids=` is ANDed with that, so a
 * ticked id never prints somebody else's claim.
 */
function claimListWhere(me: ReturnType<typeof currentUser>, q: ListQuery) {
  const where: Prisma.ExpenseClaimWhereInput = {};

  const onlyOwn = !me.isSuperAdmin && !me.permissions.has('gfin.expenses.view_all');
  const mine = onlyOwn || q.scope === 'mine';
  // View Team reads the team's claims (2026-10-19); "Mine" is one's own.
  if (q.scope === 'mine') where.claimedById = me.id;
  else if (onlyOwn) where.claimedById = { in: visibleOwners(me, 'gfin', 'expenses') };

  const status = choice(q.filters.status, ExpenseStatus, 'Status');
  if (status) where.status = status;
  if (q.filters.jobId) where.jobId = q.filters.jobId;
  if (q.filters.advanceId) where.advanceId = q.filters.advanceId;
  if (q.filters.budgetRequestId) where.budgetRequestId = q.filters.budgetRequestId;
  const f = q.filters;
  const and: Prisma.ExpenseClaimWhereInput[] = [];
  if (f.claimedById) and.push({ claimedById: f.claimedById });
  if (f.teamId) and.push({ claimedBy: userTeamWhere(f.teamId) });
  if (f.from || f.to) and.push({ claimDate: { ...(f.from ? { gte: asDate(f.from, 'From') } : {}), ...(f.to ? { lte: asDate(f.to, 'To') } : {}) } });
  // In approval, approved and still to pay — the cards' filters.
  if (f.pending === 'true') and.push({ status: 'PENDING_APPROVAL' });
  if (f.forRelease === 'true') and.push({ status: 'APPROVED' });
  if (and.length) where.AND = and;
  // A liquidation is a claim that names an advance or a budget request; a
  // reimbursement is one that names neither. Same table, a column apart.
  if (q.filters.kind === 'liquidation') where.OR = [{ advanceId: { not: null } }, { budgetRequestId: { not: null } }];
  if (q.filters.kind === 'reimbursement') {
    where.advanceId = null;
    where.budgetRequestId = null;
  }
  if (q.search) {
    const terms: Prisma.ExpenseClaimWhereInput[] = [
      { number: { contains: q.search, mode: 'insensitive' } },
      { purpose: { contains: q.search, mode: 'insensitive' } },
      { claimedBy: { name: { contains: q.search, mode: 'insensitive' } } },
      { advance: { number: { contains: q.search, mode: 'insensitive' } } },
      { budgetRequest: { number: { contains: q.search, mode: 'insensitive' } } },
    ];
    // The kind filter already uses OR: the two conditions AND together.
    if (where.OR) {
      where.AND = [...((where.AND as Prisma.ExpenseClaimWhereInput[] | undefined) ?? []), { OR: where.OR }, { OR: terms }];
      delete where.OR;
    } else {
      where.OR = terms;
    }
  }
  const ids = idsFilter(q.filters.ids);
  if (ids) where.id = { in: ids };
  return { where, mine };
}

const CLAIM_SORTS = ['number', 'claimDate', 'createdAt'];

expenseRoutes.get(
  '/',
  requireAny('gfin.expenses.view_all', 'gfin.expenses.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const { where } = claimListWhere(me, q);

    const [rows, total] = await Promise.all([
      prisma.expenseClaim.findMany({
        where,
        include: claimInclude,
        orderBy: orderBy(q, CLAIM_SORTS, { claimDate: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.expenseClaim.count({ where }),
    ]);
    const [steps, summary] = await Promise.all([openSteps('expense', rows.map((r) => r.id)), claimListSummary(where)]);

    res.json({
      ...listResult(
        rows.map((r) => {
          const row = presentClaim(r);
          // The owner's words for where it stands: TL Approval … For Release, Paid.
          return { ...row, stage: stageWords(r.status, steps.get(r.id), row.outstanding > 0.005) };
        }),
        total,
        q,
      ),
      summary,
    });
  }),
);

/**
 * The reimbursement register's cards (the owner's module 6), under the
 * list's own query: the sum of every claim still standing, what waits in
 * approval ("pending process"), what is approved and still to pay ("for
 * release"), and what was paid out.
 */
async function claimListSummary(where: Prisma.ExpenseClaimWhereInput) {
  const agg = (extra: Prisma.ExpenseClaimWhereInput) =>
    prisma.expenseClaim.aggregate({ where: { AND: [where, extra] }, _count: { _all: true }, _sum: { total: true, amountPaid: true } });
  const [all, pending, approved, paid] = await Promise.all([
    agg({ status: { notIn: ['REJECTED', 'CANCELLED'] } }),
    agg({ status: 'PENDING_APPROVAL' }),
    prisma.expenseClaim.findMany({ where: { AND: [where, { status: 'APPROVED' }] }, include: { advance: true, budgetRequest: true } }),
    agg({ amountPaid: { gt: 0 } }),
  ]);
  const owed = approved.map((c) => cents(claimPayable(c as Parameters<typeof claimPayable>[0]) - num(c.amountPaid))).filter((x) => x > 0.005);
  return {
    total: num(all._sum.total),
    count: all._count._all,
    pending: num(pending._sum.total),
    pendingCount: pending._count._all,
    forRelease: cents(owed.reduce((s, x) => s + x, 0)),
    forReleaseCount: owed.length,
    paidOut: num(paid._sum.amountPaid),
    paidCount: paid._count._all,
  };
}

/** A claim that will never be paid — listed, never summed. */
const CLAIM_CLOSED: ExpenseStatus[] = ['REJECTED', 'CANCELLED'];

/**
 * The expense claims on paper — the list as filtered (or the rows ticked),
 * through `claimListWhere`, so a `view_own` holder prints only their own.
 * Spent is each claim's receipts; "Owed back" is what an APPROVED claim still
 * owes its claimant (the screen's column — the excess over an advance for a
 * liquidation), so its total is the set's share of what the finance position
 * calls reimbursable. A rejected or cancelled claim prints in brackets.
 * Above `/:id`.
 */
expenseRoutes.get(
  '/pdf',
  requireAny('gfin.expenses.view_all', 'gfin.expenses.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const { where, mine } = claimListWhere(me, q);
    const [rows, count, spent, approved, closed, currency, project, advance, budgetRequest] = await Promise.all([
      prisma.expenseClaim.findMany({
        where,
        include: {
          claimedBy: { select: { name: true } },
          job: { select: { number: true } },
          costCategory: { select: { name: true } },
          ...LIQUIDATION_SOURCES,
        },
        orderBy: orderBy(q, CLAIM_SORTS, { claimDate: 'desc' }),
        take: LIST_CAP,
      }),
      prisma.expenseClaim.count({ where }),
      prisma.expenseClaim.aggregate({ where: { AND: [where, { status: { notIn: CLAIM_CLOSED } }] }, _sum: { total: true } }),
      // What is still owed back over EVERY approved claim the filter matched,
      // not only those printed — each claim's own payable (`claimPayable`).
      prisma.expenseClaim.findMany({
        where: { AND: [where, { status: 'APPROVED' }] },
        select: { total: true, amountPaid: true, ...LIQUIDATION_SOURCES },
      }),
      prisma.expenseClaim.count({ where: { AND: [where, { status: { in: CLAIM_CLOSED } }] } }),
      companyCurrency(),
      recordNamed('project', q.filters.jobId),
      recordNamed('advance', q.filters.advanceId),
      recordNamed('budget request', q.filters.budgetRequestId),
    ]);

    const f = q.filters;
    const status = choice(f.status, ExpenseStatus, 'Status');
    const reference = listReference(count, rows.length, ['expense claim', 'expense claims'], [
      q.search && `search "${q.search}"`,
      status && `status ${statusLabel(status)}`,
      f.kind === 'liquidation' ? 'liquidations' : f.kind === 'reimbursement' ? 'reimbursements' : null,
      project,
      advance,
      budgetRequest,
      mine && 'claimed by me',
      f.ids && 'the rows selected',
    ]);
    // The screen's "Owed back": what an APPROVED claim still owes its claimant.
    const owedOn = (r: Parameters<typeof claimPayable>[0] & { amountPaid: Prisma.Decimal }) =>
      Math.max(0, cents(claimPayable(r) - num(r.amountPaid)));
    const stillOwed = cents(approved.reduce((s, r) => s + owedOn(r), 0));

    // Eight columns: landscape (rule 6).
    const sections: PdfSection[] = [
      {
        kind: 'table',
        head: ['Number', 'Claimed by and purpose', 'Kind', 'Dated', 'Charged to', `Spent (${currency})`, `Owed back (${currency})`, 'Status'],
        align: ['left', 'left', 'left', 'left', 'left', 'right', 'right', 'left'],
        rows: rows.map((r) => {
          const inSum = !CLAIM_CLOSED.includes(r.status);
          const source = r.advance ?? r.budgetRequest;
          const owed = r.status === 'APPROVED' ? owedOn(r) : 0;
          return [
            r.number,
            { title: r.claimedBy.name, body: r.purpose },
            source ? { title: 'Liquidation', body: source.number } : 'Reimbursement',
            formatShortDate(r.claimDate),
            r.job ? { title: r.job.number, body: r.costCategory?.name ?? undefined } : 'Overheads',
            bracketed(formatAmount(num(r.total)), inSum),
            owed > 0 ? formatAmount(owed) : '',
            statusLabel(r.status),
          ];
        }),
      },
      {
        kind: 'totals',
        rows: [
          { label: 'Still owed to claimants', value: formatMoney(stillOwed, currency) },
          { label: totalLabel('Spent', count, rows.length), value: formatMoney(num(spent._sum.total), currency), bold: true },
        ],
      },
    ];
    sections.push(...listNotes([bracketNote(closed, ['rejected or cancelled claim', 'rejected or cancelled claims'])]));

    const pdf = await renderDocument({ title: 'Expense Claims', date: new Date(), reference, landscape: true, sections });
    await audit(
      {
        entityType: 'expense_claim',
        entityId: 'list',
        action: 'EXPORTED',
        summary: `Exported the expense claim list as PDF (${rows.length} claim(s))`,
      },
      req,
    );
    sendListPdf(res, pdf, 'expense-claims.pdf');
  }),
);

expenseRoutes.get(
  '/:id',
  requireAny('gfin.expenses.view_all', 'gfin.expenses.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await prisma.expenseClaim.findUnique({
      where: { id: req.params.id },
      include: {
        ...claimInclude,
        allocations: {
          include: { payment: { select: { id: true, number: true, paymentDate: true, method: true } } },
        },
      },
    });
    if (!row) throw notFound('Expense claim not found');
    if (
      !visibleOwners(me, 'gfin', 'expenses').includes(row.claimedById) &&
      !me.isSuperAdmin &&
      !me.permissions.has('gfin.expenses.view_all')
    ) {
      throw forbidden('That is someone else’s claim');
    }
    res.json({
      ...presentClaim(row),
      allocations: row.allocations.map((a) => ({ ...a, amount: num(a.amount) })),
    });
  }),
);

const claimSchema = z.object({
  claimDate: z.string().optional(),
  purpose: z.string().trim().min(3, 'What was the expense for?'),
  jobId: z.string().optional().nullable(),
  costCategoryId: z.string().optional().nullable(),
  /** Set when this claim liquidates a cash advance. */
  advanceId: z.string().optional().nullable(),
  /** Set when this claim liquidates a budget request (project cash). Never both. */
  budgetRequestId: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  lines: z
    .array(
      z.object({
        spentOn: z.string().min(1, 'When was it spent?'),
        description: z.string().trim().min(1, 'Every line needs a description'),
        category: z.string().optional().nullable(),
        receiptNo: z.string().optional().nullable(),
        vendor: z.string().trim().max(200).optional().nullable(),
        amount: z.number().positive('Every line must be more than zero'),
      }),
    )
    .min(1, 'A claim needs at least one line'),
});

/**
 * A claim's receipts and their total — the one rule for filing a claim and
 * for modifying a draft. Each line is taken to the centavo first, so the total
 * is exactly the sum of the lines stored under it.
 */
function claimLines(input: z.infer<typeof claimSchema>['lines']) {
  const rows = input.map((l, i) => ({
    sortOrder: i,
    spentOn: asDate(l.spentOn, 'Spent on'),
    description: l.description,
    category: l.category || null,
    receiptNo: l.receiptNo || null,
    vendor: l.vendor || null,
    amount: cents(l.amount),
  }));
  return {
    total: cents(rows.reduce((s, l) => s + l.amount, 0)),
    lines: rows.map((l) => ({ ...l, amount: D(l.amount) })),
  };
}

expenseRoutes.post(
  '/',
  require_('gfin.expenses.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(claimSchema, req.body);

    // A liquidation is the person who holds the cash accounting for it,
    // against the project and budget line the advance was approved for.
    // Changing either at liquidation time would let cost land somewhere
    // nobody approved.
    let jobId = body.jobId || null;
    let costCategoryId = body.costCategoryId || null;
    let advanceNumber: string | null = null;
    if (body.advanceId) {
      const advance = await prisma.cashAdvance.findUnique({
        where: { id: body.advanceId },
        include: {
          liquidations: {
            where: { status: { in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SETTLED', 'REIMBURSED'] } },
            select: { number: true },
          },
        },
      });
      if (!advance) throw notFound('Cash advance not found');
      if (advance.repayable) throw badRequest(`${advance.number} is money lent — it is repaid, not liquidated with receipts`);
      if (advance.requestedById !== me.id && !me.isSuperAdmin) {
        throw forbidden('Only the person who received the advance can liquidate it');
      }
      if (advance.status !== 'RELEASED') {
        throw badRequest(
          advance.status === 'APPROVED'
            ? `${advance.number} has not been released yet — there is no cash to account for`
            : `${advance.number} is ${advance.status.toLowerCase().replace(/_/g, ' ')} and cannot be liquidated`,
        );
      }
      if (advance.liquidations.length) {
        throw badRequest(`${advance.number} is already being liquidated by ${advance.liquidations[0].number}`);
      }
      if (jobId && advance.jobId && jobId !== advance.jobId) {
        throw badRequest(`${advance.number} was approved against a different project — the liquidation charges that one`);
      }
      jobId = advance.jobId;
      costCategoryId = advance.costCategoryId;
      advanceNumber = advance.number;
    }
    if (body.advanceId && body.budgetRequestId) {
      throw badRequest('A liquidation accounts for one thing — a cash advance or a budget request, not both');
    }
    // Project cash: the same rules, on the request. Whoever raised the request
    // files the receipts, against the project and budget line it was
    // approved for.
    if (body.budgetRequestId) {
      const request = await prisma.budgetRequest.findUnique({
        where: { id: body.budgetRequestId },
        include: {
          liquidations: {
            where: { status: { in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SETTLED', 'REIMBURSED'] } },
            select: { number: true },
          },
        },
      });
      if (!request) throw notFound('Budget request not found');
      if (request.requestedById !== me.id && !me.isSuperAdmin) {
        throw forbidden('Only the person who raised the budget request can liquidate it');
      }
      if (request.status !== 'RELEASED') {
        throw badRequest(
          request.status === 'APPROVED'
            ? `${request.number} has not been released yet — there is no cash to account for`
            : `${request.number} is ${request.status.toLowerCase().replace(/_/g, ' ')} and cannot be liquidated`,
        );
      }
      if (request.liquidations.length) {
        throw badRequest(`${request.number} is already being liquidated by ${request.liquidations[0].number}`);
      }
      if (jobId && jobId !== request.jobId) {
        throw badRequest(`${request.number} was approved against a different project — the liquidation charges that one`);
      }
      jobId = request.jobId;
      costCategoryId = request.costCategoryId;
      advanceNumber = request.number;
    }

    const { total, lines } = claimLines(body.lines);
    const claim = await prisma.$transaction(async (tx) => {
      const number = await nextNumber('expense', tx);
      return tx.expenseClaim.create({
        data: {
          number,
          claimedById: me.id,
          jobId,
          costCategoryId,
          advanceId: body.advanceId || null,
          budgetRequestId: body.budgetRequestId || null,
          claimDate: body.claimDate ? asDate(body.claimDate, 'Claim date') : dayKey(new Date()),
          purpose: body.purpose,
          total: D(total),
          notes: body.notes || null,
          lines: { create: lines },
        },
        include: claimInclude,
      });
    });

    await audit(
      {
        entityType: 'expense_claim',
        entityId: claim.id,
        action: 'CREATED',
        summary: advanceNumber
          ? `${claim.number} — ${total} liquidated against ${advanceNumber} for ${body.purpose}`
          : `${claim.number} — ${total} claimed for ${body.purpose}`,
      },
      req,
    );
    res.status(201).json(presentClaim(claim));
  }),
);

/**
 * Modifying a draft claim (2026-10-09, Phase 2 of the button standard).
 *
 * The claimant's, or `edit_all`'s, and only while DRAFT — submitting
 * snapshots the amount the approval route was picked by, so a claim with the
 * approver is pulled back first (`/withdraw`). The body is the filing form's,
 * whole: the receipts are replaced and the total recomputed in one
 * transaction. A liquidation keeps the advance or budget request it accounts
 * for, and with it that source's project and budget line — the cost lands
 * where the cash was approved to land, exactly as when it was filed. Claimed
 * on DRAFT, so a submit that lands first wins.
 */
expenseRoutes.put(
  '/:id',
  requireAny('gfin.expenses.edit_own', 'gfin.expenses.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(claimSchema, req.body);
    const existing = await prisma.expenseClaim.findUnique({
      where: { id: req.params.id },
      include: {
        advance: { select: { number: true, jobId: true, costCategoryId: true } },
        budgetRequest: { select: { number: true, jobId: true, costCategoryId: true } },
      },
    });
    if (!existing) throw notFound('Expense claim not found');
    if (!canEditRecord(me, 'gfin', 'expenses', existing.claimedById)) {
      throw forbidden('Only the person who filed this claim can change it');
    }
    if (existing.status !== 'DRAFT') {
      throw badRequest(
        existing.status === 'PENDING_APPROVAL'
          ? 'Only a draft can be changed — this one is with the approver; pull it back to draft first'
          : `Only a draft can be changed — this one is ${existing.status.toLowerCase().replace(/_/g, ' ')}`,
      );
    }

    // What a liquidation accounts for was checked when it was filed (released,
    // the filer's own, one live liquidation), and Modify never re-points it.
    const source = existing.advance ?? existing.budgetRequest;
    if (
      (body.advanceId || existing.advanceId) !== existing.advanceId ||
      (body.budgetRequestId || existing.budgetRequestId) !== existing.budgetRequestId
    ) {
      throw badRequest(
        source
          ? `This liquidation accounts for ${source.number} — cancel it and file another to account for something else`
          : 'A claim does not become a liquidation on Modify — file the liquidation from the advance or budget request',
      );
    }

    let jobId: string | null;
    let costCategoryId: string | null;
    if (source) {
      if (body.jobId && source.jobId && body.jobId !== source.jobId) {
        throw badRequest(`${source.number} was approved against a different project — the liquidation charges that one`);
      }
      jobId = source.jobId;
      costCategoryId = source.costCategoryId;
    } else {
      jobId = body.jobId || null;
      costCategoryId = body.costCategoryId || null;
      if (jobId && jobId !== existing.jobId) {
        const job = await prisma.job.findUnique({ where: { id: jobId }, select: { status: true } });
        if (!job || job.status === 'CANCELLED') throw badRequest('That project cannot be charged');
      }
    }

    const { total, lines } = claimLines(body.lines);
    const claimDate = body.claimDate ? asDate(body.claimDate, 'Claim date') : existing.claimDate;
    const updated = await prisma.$transaction(async (tx) => {
      const claimed = await tx.expenseClaim.updateMany({
        where: { id: existing.id, status: 'DRAFT' },
        data: {
          jobId,
          costCategoryId,
          claimDate,
          purpose: body.purpose,
          total: D(total),
          notes: body.notes === undefined ? existing.notes : body.notes || null,
        },
      });
      if (!claimed.count) throw badRequest('It was submitted a moment ago — reload to see where it stands');
      await tx.expenseClaimLine.deleteMany({ where: { claimId: existing.id } });
      await tx.expenseClaimLine.createMany({ data: lines.map((l) => ({ ...l, claimId: existing.id })) });
      return tx.expenseClaim.findUniqueOrThrow({ where: { id: existing.id }, include: claimInclude });
    });

    await audit(
      {
        entityType: 'expense_claim',
        entityId: existing.id,
        action: 'UPDATED',
        summary: source
          ? `${existing.number} modified — ${total} liquidated against ${source.number} for ${body.purpose}`
          : `${existing.number} modified — ${total} claimed for ${body.purpose}`,
        before: { purpose: existing.purpose, total: num(existing.total), jobId: existing.jobId, costCategoryId: existing.costCategoryId },
        after: { purpose: body.purpose, total, jobId, costCategoryId },
      },
      req,
    );
    res.json(presentClaim(updated));
  }),
);

/**
 * Why a claim read PENDING_APPROVAL had no open request to withdraw. Either
 * the approver decided it a moment ago — its latest request closed APPROVED
 * or REJECTED, and the settlement is on its way — and then the decision
 * stands and the caller rolls back; or nothing has been decided: the claim is
 * still being submitted (its request not made yet), or a submit died
 * half-way. Then the caller may go ahead, and a submit still running
 * withdraws the request it makes once it finds the claim has moved on (see
 * `/submit`), so a claim that is not waiting never leaves one in a queue.
 */
async function claimDecided(tx: Prisma.TransactionClient, claimId: string): Promise<boolean> {
  const latest = await tx.approvalRequest.findFirst({
    where: { documentType: 'expense', documentId: claimId },
    orderBy: { createdAt: 'desc' },
    select: { status: true },
  });
  return latest?.status === 'APPROVED' || latest?.status === 'REJECTED';
}

/**
 * Pulling a claim back from the approver to change it — the sales order's
 * shape. The claim is claimed PENDING_APPROVAL → DRAFT and its request
 * withdrawn through the engine in the same transaction, which tells the
 * approvers. If nothing was open to withdraw because a decision landed a
 * moment before (`claimDecided`), the decision stands: the transaction rolls
 * back and the settlement it carries goes through.
 */
expenseRoutes.post(
  '/:id/withdraw',
  requireAny('gfin.expenses.edit_own', 'gfin.expenses.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const claim = await prisma.expenseClaim.findUnique({ where: { id: req.params.id } });
    if (!claim) throw notFound('Expense claim not found');
    if (!canEditRecord(me, 'gfin', 'expenses', claim.claimedById)) {
      throw forbidden('Only the person who filed this claim can pull it back');
    }
    if (claim.status !== 'PENDING_APPROVAL') throw badRequest('This claim is not with the approver — nothing to pull back');

    await prisma.$transaction(async (tx) => {
      const claimed = await tx.expenseClaim.updateMany({
        where: { id: claim.id, status: 'PENDING_APPROVAL' },
        data: { status: 'DRAFT' },
      });
      if (!claimed.count) throw badRequest('It was decided a moment ago — reload to see where it stands');
      const withdrawn = await cancelOpenRequest('expense', claim.id, tx, `pulled back to draft by ${me.name}`, me.id);
      if (!withdrawn.length && (await claimDecided(tx, claim.id))) {
        throw badRequest('The approver decided it a moment ago — reload to see where it stands');
      }
    });

    await audit(
      {
        entityType: 'expense_claim',
        entityId: claim.id,
        action: 'UPDATED',
        summary: `${claim.number} pulled back from approval to draft`,
      },
      req,
    );
    res.json({ ok: true, status: 'DRAFT' });
  }),
);

expenseRoutes.post(
  '/:id/submit',
  require_('gfin.expenses.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const claim = await prisma.expenseClaim.findUnique({
      where: { id: req.params.id },
      include: { lines: true, claimedBy: { select: { name: true } } },
    });
    if (!claim) throw notFound('Expense claim not found');
    if (claim.claimedById !== me.id && !me.isSuperAdmin) throw forbidden('That is someone else’s claim');
    if (claim.status !== 'DRAFT') throw badRequest('This claim has already been submitted');

    // A claim without receipt numbers is not claimable, and finding that out at
    // approval time wastes the approver's round trip.
    const missing = claim.lines.filter((l) => !l.receiptNo).length;
    if (missing > 0) {
      throw badRequest(
        `${missing} line${missing === 1 ? ' has' : 's have'} no receipt number. Finance needs an OR against every peso.`,
      );
    }

    // Claimed on the claim exactly as read — still a draft, and not modified
    // since (`updatedAt`, which every write to a claim moves; a Modify writes
    // its receipts in the same transaction as the header). The receipt check
    // above ran on this read, the request below snapshots its total and
    // purpose, and the route is picked by that total — so a Modify or a
    // cancel that lands between the read and the claim refuses the submit
    // rather than sending stale figures.
    const claimed = await prisma.expenseClaim.updateMany({
      where: { id: claim.id, status: 'DRAFT', updatedAt: claim.updatedAt },
      data: { status: 'PENDING_APPROVAL' },
    });
    if (!claimed.count) throw badRequest('It changed a moment ago — reload to see where it stands');

    try {
      await submitForApproval({
        documentType: 'expense',
        documentId: claim.id,
        documentNumber: claim.number,
        // Named for the claimant, whoever pressed the button.
        subject: `${claim.claimedBy.name} — ${claim.purpose}`,
        amount: num(claim.total),
        link: `/g-fin/expenses/${claim.id}`,
        // The claimant, even when a super admin presses the button for them:
        // the self-approval rule has to see whose money this is.
        requesterId: claim.claimedById,
      });
    } catch (err) {
      // The engine refused (no workflow, a self-approval trap). The claim goes
      // back to DRAFT rather than sitting PENDING with no request behind it.
      await prisma.expenseClaim.updateMany({ where: { id: claim.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
      throw err;
    }

    // A cancel or a pull-back that landed while the request was being made
    // found nothing open to withdraw, and went ahead (`claimDecided`). Tested
    // under the claim's row lock, which either of them holds until it
    // commits: if the claim is no longer pending, the request just made is
    // withdrawn through the engine, so it never sits in a queue for a claim
    // that is not waiting on it.
    const movedOn = await prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ status: string }[]>`
        SELECT status::text AS status FROM "ExpenseClaim" WHERE id = ${claim.id} FOR UPDATE`;
      if (row?.status === 'PENDING_APPROVAL') return null;
      await cancelOpenRequest(
        'expense',
        claim.id,
        tx,
        `the claim was ${row?.status === 'DRAFT' ? 'pulled back to draft' : 'cancelled'} while it was being submitted`,
        me.id,
      );
      return row?.status ?? 'DELETED';
    });
    if (movedOn) {
      throw badRequest(
        `It was ${movedOn === 'DRAFT' ? 'pulled back to draft' : 'cancelled'} a moment ago — reload to see where it stands`,
      );
    }

    await audit(
      { entityType: 'expense_claim', entityId: claim.id, action: 'SUBMITTED', summary: `${claim.number} sent for approval` },
      req,
    );
    res.json({ ok: true });
  }),
);

/**
 * A decision that finds the claim no longer pending changes nothing. A repeat
 * on a claim already settled says nothing (the "settling twice" rule); one on
 * a claim pulled back to draft or cancelled meanwhile is written down, so the
 * trail explains why the approval history and the claim disagree.
 */
async function claimNotApplied(claimId: string, outcome: ApprovalOutcome) {
  const claim = await prisma.expenseClaim.findUnique({ where: { id: claimId }, select: { number: true, status: true } });
  if (!claim || (claim.status !== 'DRAFT' && claim.status !== 'CANCELLED')) return;
  await audit({
    entityType: 'expense_claim',
    entityId: claimId,
    action: 'UPDATED',
    summary: `${claim.number} ${outcome === 'APPROVED' ? 'approved' : 'rejected'} after it was ${claim.status === 'DRAFT' ? 'pulled back to draft' : 'cancelled'} — not applied`,
  });
}

/**
 * An approved claim is money owed to a person, and cost owed by a job.
 *
 * For a liquidation the cost is the same — INCURRED at what was actually
 * spent, the first and only time the advance reaches a ledger — but the money
 * runs the other way: the person already holds the cash. The claim settles at
 * the EXCESS over the advance (SETTLED outright when there is none), and the
 * advance is re-derived so unspent cash reads as REFUND_DUE.
 *
 * The outcome is applied only while the claim is still PENDING_APPROVAL, by a
 * conditional claim in the same transaction as the cost — so a decision that
 * lands after a pull-back or a cancel changes nothing, and a repeated
 * settlement posts nothing the second time.
 *
 * Exported so a test can call it twice: the status guard is what makes a
 * repeated settlement post nothing the second time.
 */
export const settleExpense = async (approval: ApprovalRequest, outcome: ApprovalOutcome) => {
  const claim = await prisma.expenseClaim.findUnique({
    where: { id: approval.documentId },
    include: { claimedBy: true, job: true, advance: true, budgetRequest: true },
  });
  if (!claim) return;
  if (claim.status !== 'PENDING_APPROVAL') return claimNotApplied(claim.id, outcome);
  // What this liquidation accounts for, if anything: the advance or the request.
  const source = claim.advance ?? claim.budgetRequest;

  if (outcome !== 'APPROVED') {
    const claimed = await prisma.expenseClaim.updateMany({
      where: { id: claim.id, status: 'PENDING_APPROVAL' },
      data: { status: 'REJECTED' },
    });
    if (!claimed.count) return claimNotApplied(claim.id, outcome);
    await audit({
      entityType: 'expense_claim',
      entityId: claim.id,
      action: 'REJECTED',
      summary: `${claim.number} rejected — nothing posted, nothing reimbursable`,
    });
    return;
  }

  const total = num(claim.total);
  const postable = claim.jobId && claim.costCategoryId && total > 0;
  const payable = claimPayable(claim);
  const released = source ? num(source.amountReleased) : 0;
  const refundDue = source ? cents(Math.max(0, released - total)) : 0;

  const applied = await prisma.$transaction(async (tx) => {
    const claimed = await tx.expenseClaim.updateMany({
      where: { id: claim.id, status: 'PENDING_APPROVAL' },
      data: {
        // A liquidation the cash fully covered owes the person nothing; it
        // is settled the moment it is approved.
        status: source && payable <= 0 ? 'SETTLED' : 'APPROVED',
        approvedAt: new Date(),
        postedToJob: !!postable,
        postedAt: postable ? new Date() : null,
      },
    });
    if (!claimed.count) return false;
    if (postable) {
      await postJobCost(tx, {
        jobId: claim.jobId!,
        costCategoryId: claim.costCategoryId!,
        state: 'INCURRED',
        amount: total,
        sourceType: 'expense_claim',
        sourceId: claim.id,
        sourceNumber: claim.number,
        description: source
          ? `${claim.claimedBy.name} — ${claim.purpose} (liquidation of ${source.number})`
          : `${claim.claimedBy.name} — ${claim.purpose}`,
      });
    }
    if (claim.advanceId) await refreshAdvance(tx, claim.advanceId);
    if (claim.budgetRequestId) await refreshBudgetRequest(tx, claim.budgetRequestId);
    return true;
  });
  if (!applied) return claimNotApplied(claim.id, outcome);

  const what = claim.advance ? 'advanced' : 'released';
  const body = !source
    ? `${total} is due back to you. Finance will reimburse it.`
    : payable > 0
      ? `You spent ${payable} more than the ${released} ${what}. Finance will reimburse the excess.`
      : refundDue > 0
        ? `${refundDue} of the ${released} ${what} was not spent. Return it to finance.`
        : `The cash covered it exactly. Nothing is owed either way.`;
  await notify({
    userId: claim.claimedById,
    type: 'approval.approved',
    title: `${claim.number} approved`,
    body,
    link: `/g-fin/expenses/${claim.id}`,
  });

  await audit({
    entityType: 'expense_claim',
    entityId: claim.id,
    action: 'APPROVED',
    summary: source
      ? `${claim.number} approved — ${total} spent against ${source.number}${postable ? `, charged to ${claim.job?.number}` : ''}; ${payable > 0 ? `${payable} owed to ${claim.claimedBy.name}` : refundDue > 0 ? `${refundDue} owed back` : 'settled exactly'}`
      : postable
        ? `${claim.number} approved — ${total} charged to ${claim.job?.number} and owed to ${claim.claimedBy.name}`
        : `${claim.number} approved — ${total} owed to ${claim.claimedBy.name}, no project charged`,
  });
};
onApprovalSettled('expense', settleExpense);

/**
 * Pulled back after approval (2026-10-16): the claim — a reimbursement or a
 * liquidation — goes back to DRAFT, the cost its approval charged the project
 * is reversed, and a liquidation's advance or budget request is re-derived so
 * its status follows (back to RELEASED). Refused once anything was paid on the
 * claim, or once unspent cash came back on the source the liquidation settled.
 */
onApprovalReopened('expense', {
  may: async (actor, id) => {
    const claim = await prisma.expenseClaim.findUnique({ where: { id }, select: { status: true, claimedById: true } });
    return !!claim && !['DRAFT', 'PENDING_APPROVAL', 'REJECTED', 'CANCELLED'].includes(claim.status) && canEditRecord(actor, 'gfin', 'expenses', claim.claimedById);
  },
  reopen: async ({ documentId, tx, actor, reason }) => {
    const claim = await tx.expenseClaim.findUnique({
      where: { id: documentId },
      include: { advance: { select: { id: true, number: true } }, budgetRequest: { select: { id: true, number: true } } },
    });
    if (!claim) throw badRequest('Claim not found');
    const paid = await tx.paymentAllocation.findFirst({ where: { claimId: claim.id }, include: { payment: { select: { number: true } } } });
    if (paid) throw badRequest(`${claim.number} has been paid (${paid.payment.number}) — remove the payment before pulling it back`);
    if (claim.status !== 'APPROVED' && claim.status !== 'SETTLED') {
      throw badRequest(`${claim.number} is ${claim.status.toLowerCase().replace(/_/g, ' ')} — only an approved claim nobody has paid can be pulled back`);
    }
    const source = claim.advance ?? claim.budgetRequest;
    if (source) {
      const refund = await tx.paymentAllocation.findFirst({
        where: { ...(claim.advanceId ? { advanceId: claim.advanceId } : { budgetRequestId: claim.budgetRequestId }), payment: { kind: 'RECEIPT' } },
        include: { payment: { select: { number: true } } },
      });
      if (refund) throw badRequest(`Unspent cash has come back on ${source.number} (${refund.payment.number}) — remove that refund before pulling the liquidation back`);
    }
    const claimed = await tx.expenseClaim.updateMany({
      where: { id: claim.id, status: { in: ['APPROVED', 'SETTLED'] } },
      data: { status: 'DRAFT', approvedAt: null, postedToJob: false, postedAt: null },
    });
    if (!claimed.count) throw badRequest(`${claim.number} changed a moment ago — reload to see where it stands`);
    const reversed = await reverseIncurred(tx, { sourceType: 'expense_claim', sourceId: claim.id, sourceNumber: claim.number }, reason, actor.id);
    if (claim.advanceId) await refreshAdvance(tx, claim.advanceId);
    if (claim.budgetRequestId) await refreshBudgetRequest(tx, claim.budgetRequestId);
    await audit(
      {
        entityType: 'expense_claim',
        entityId: claim.id,
        action: 'UPDATED',
        summary: `${claim.number} back to draft after approval${reversed ? ` — ${reversed} taken back off the project` : ''}${source ? `; ${source.number} awaits its liquidation again` : ''}`,
        actorId: actor.id,
        actorName: actor.name,
      },
      undefined,
      tx,
    );
  },
});

expenseRoutes.post(
  '/:id/cancel',
  handler(async (req, res) => {
    const me = currentUser(req);
    const claim = await prisma.expenseClaim.findUnique({
      where: { id: req.params.id },
      include: { allocations: true },
    });
    if (!claim) throw notFound('Expense claim not found');
    if (claim.claimedById !== me.id && !me.isSuperAdmin && !canEditRecord(me, 'gfin', 'expenses', claim.claimedById)) {
      throw forbidden('That is someone else’s claim');
    }
    // Cancelling is for a claim nobody has decided on yet. Once approved it has
    // charged a project, told a person they are owed money, or settled an
    // advance — every one of those is reversed through finance, on the record,
    // not by the author quietly withdrawing the document.
    if (claim.status !== 'DRAFT' && claim.status !== 'PENDING_APPROVAL') {
      throw badRequest(
        claim.status === 'CANCELLED' || claim.status === 'REJECTED'
          ? `This claim is already ${claim.status.toLowerCase()}`
          : 'This claim has been approved; reverse it through finance, not by cancelling',
      );
    }
    if (claim.allocations.length) throw badRequest('This claim has already been reimbursed');

    await prisma.$transaction(async (tx) => {
      // Claimed in the status it was read in, never simply written: a
      // decision the subscriber applied meanwhile (an approved claim has
      // posted its cost and refreshed its advance) or a submit that took the
      // draft refuses the cancel rather than being written over.
      const claimed = await tx.expenseClaim.updateMany({
        where: { id: claim.id, status: claim.status },
        data: { status: 'CANCELLED' },
      });
      if (!claimed.count) throw badRequest('It changed a moment ago — reload to see where it stands');
      // Still with the approver: withdrawn through the engine, so it leaves
      // their queue and they are told. Nothing open while it reads pending
      // means a decision landed a moment ago — it stands, and this rolls back
      // — or it is still being submitted, which that submit sorts out.
      const withdrawn = await cancelOpenRequest('expense', claim.id, tx, `cancelled by ${me.name}`, me.id);
      if (claim.status === 'PENDING_APPROVAL' && !withdrawn.length && (await claimDecided(tx, claim.id))) {
        throw badRequest('The approver decided it a moment ago — reload to see where it stands');
      }
    });
    await audit(
      { entityType: 'expense_claim', entityId: claim.id, action: 'CANCELLED', summary: `${claim.number} cancelled` },
      req,
    );
    res.json({ ok: true });
  }),
);

/**
 * Deletes a CANCELLED claim — the claimant or edit_all, with the delete right.
 * A cancelled claim charged nothing and was never paid (the cancel refuses
 * both), so nothing behind it moves; its receipts go with it.
 */
expenseRoutes.delete(
  '/:id',
  require_('gfin.expenses.delete'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const claim = await prisma.expenseClaim.findUnique({ where: { id: req.params.id }, include: { allocations: { select: { id: true } } } });
    if (!claim) throw notFound('Expense claim not found');
    if (claim.claimedById !== me.id && !me.isSuperAdmin && !canEditRecord(me, 'gfin', 'expenses', claim.claimedById)) {
      throw forbidden('That is someone else’s claim');
    }
    if (claim.status !== 'CANCELLED') throw badRequest('Only a cancelled claim can be deleted — cancel it first');
    if (claim.allocations.length) throw badRequest('Money was applied to this claim — it is kept');
    await deleteOrRefuse(claim.number, () => prisma.expenseClaim.delete({ where: { id: claim.id } }));
    await deleteAttachmentsOf('expense_claim', [claim.id]);
    await audit({ entityType: 'expense_claim', entityId: claim.id, action: 'DELETED', summary: `Deleted cancelled claim ${claim.number}` }, req);
    res.json({ ok: true });
  }),
);

/**
 * The printed claim. A liquidation prints as a "Liquidation Report" — same
 * document, same number series; only the title and the settlement rows
 * differ, because that is all that differs on paper. The receipts add up in
 * the totals block (never a TOTAL row in the table), which says what is owed
 * either way only once the claim is approved; and the sign-offs are the
 * claimant, then the route as `approvalSlots` reads it for the claim's
 * status (rule 6).
 */
expenseRoutes.get(
  '/:id/pdf',
  requireAny('gfin.expenses.view_all', 'gfin.expenses.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const claim = await prisma.expenseClaim.findUnique({
      where: { id: req.params.id },
      include: claimInclude,
    });
    if (!claim) throw notFound('Expense claim not found');
    if (!visibleOwners(me, 'gfin', 'expenses').includes(claim.claimedById) && !me.isSuperAdmin && !me.permissions.has('gfin.expenses.view_all')) {
      throw forbidden('That is someone else’s claim');
    }

    const view = presentClaim(claim);
    const currency = await companyCurrency();
    const money = (n: number) => formatMoney(n, currency);
    const liquidated = claim.advance ?? claim.budgetRequest;
    // What the receipts add up to, then — only once the claim is approved —
    // where that leaves the claimant; the last row, in bold, is where it
    // stands NOW. Before approval (and on a rejected or cancelled claim)
    // nothing is owed either way, so the paper states the arithmetic and
    // claims no position: a plain claim its total, a liquidation the
    // difference from the cash released.
    const approved = view.status === 'APPROVED' || view.status === 'REIMBURSED' || view.status === 'SETTLED';
    const totals: PdfTotal[] = [];
    if (view.kind === 'liquidation') {
      totals.push(
        { label: 'Total', value: money(view.total) },
        { label: claim.advance ? 'Advance released' : 'Cash released', value: money(liquidatedReleased(claim)) },
      );
      if (view.payable > 0) {
        // Spent beyond the cash: owed to the claimant on THIS document once
        // approved, less what has been reimbursed on it.
        totals.push({ label: 'Excess spent', value: money(view.payable) });
        if (approved) {
          totals.push(
            { label: 'Less: reimbursed', value: money(view.amountPaid) },
            { label: 'Still owed', value: money(Math.max(0, view.outstanding)) },
          );
        }
      } else if (!approved) {
        totals.push({ label: 'Unspent', value: money(view.refundDue) });
      } else {
        // Unspent cash comes back against the advance or the request, which
        // carries what has been refunded so far.
        totals.push({ label: 'Unspent — owed back', value: money(view.refundDue) });
        if (view.refundDue > 0) {
          const refunded = liquidated ? num(liquidated.amountRefunded) : 0;
          totals.push(
            { label: 'Less: refunded', value: money(refunded) },
            { label: 'Still to refund', value: money(cents(Math.max(0, view.refundDue - refunded))) },
          );
        }
      }
    } else if (approved) {
      totals.push(
        { label: 'Total', value: money(view.total) },
        { label: 'Reimbursed', value: money(view.amountPaid) },
        { label: 'Still owed', value: money(Math.max(0, view.outstanding)) },
      );
    } else {
      totals.push({ label: 'Claimed', value: money(view.total) });
    }
    totals[totals.length - 1].bold = true;
    const sections: PdfSection[] = [
      {
        kind: 'fields',
        columns: 3,
        fields: [
          { label: 'Claimed by', value: claim.claimedBy.name },
          { label: 'Purpose', value: claim.purpose },
          { label: 'Project', value: claim.job ? `${claim.job.number} — ${claim.job.name}` : 'Overheads' },
          { label: 'Budget line', value: claim.costCategory?.name ?? '—' },
          ...(claim.advance ? [{ label: 'Liquidates', value: claim.advance.number }] : []),
          ...(claim.budgetRequest ? [{ label: 'Liquidates', value: `Budget request ${claim.budgetRequest.number}` }] : []),
          { label: 'Status', value: statusLabel(claim.status) },
        ],
      },
      {
        kind: 'table',
        title: 'Receipts',
        head: ['No.', 'Date', 'Company / receipt', 'Item / purpose', `Amount (${currency})`],
        widths: [7, 14, 28, 33, 18],
        align: ['right', 'left', 'left', 'left', 'right'],
        rows: claim.lines.map((l, n) => [
          String(n + 1),
          formatShortDate(l.spentOn),
          { title: l.vendor ?? '—', body: l.receiptNo ? `Receipt ${l.receiptNo}` : 'No receipt no.' },
          { title: l.description, body: l.category ?? undefined },
          formatAmount(num(l.amount)),
        ]),
      },
      { kind: 'totals', rows: totals },
    ];
    if (claim.notes) sections.push({ kind: 'text', title: 'Notes', body: claim.notes });

    const claimant = await contactOf(claim.claimedById);
    const slots = await approvalSlots(
      'expense',
      claim.id,
      // Submitted in the claimant's name, as the submit route does.
      claim.status === 'DRAFT' ? { amount: view.total, requesterId: claim.claimedById } : undefined,
    );
    const pdf = await renderDocument({
      title: liquidated ? 'Liquidation Report' : 'Expense Claim',
      documentNumber: claim.number,
      date: claim.claimDate,
      reference: liquidated ? `Liquidation of ${liquidated.number}` : claim.purpose,
      sections,
      signatories: [
        { role: 'Prepared by', name: claim.claimedBy.name, ...claimant, at: claim.createdAt },
        ...(slots.length ? slotSignatories(slots) : awaitsApproval(claim.status) ? [{ role: 'Approved by' }] : []),
      ],
    });

    await audit(
      { entityType: 'expense_claim', entityId: claim.id, action: 'EXPORTED', summary: `Printed ${claim.number}` },
      req,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition(paperFileName({ kind: 'Expense Claim', number: claim.number, author: claim.claimedBy.name, date: claim.claimDate })));
    res.send(pdf);
  }),
);

// ════════════════════════════════════════════════════════════════════
//  PAYMENTS
// ════════════════════════════════════════════════════════════════════

export const paymentRoutes = Router();
paymentRoutes.use(authenticate);

const paymentInclude = {
  customer: { select: { id: true, name: true } },
  supplier: { select: { id: true, name: true } },
  payeeUser: { select: { id: true, name: true } },
  recordedBy: { select: { id: true, name: true } },
  allocations: {
    include: {
      invoice: {
        select: {
          id: true,
          number: true,
          invoiceDate: true,
          netCollectible: true,
          salesperson: { select: { id: true, name: true } },
          team: TEAM_REF_SELECT,
        },
      },
      bill: { select: { id: true, number: true, netPayable: true } },
      claim: { select: { id: true, number: true, total: true } },
      advance: { select: { id: true, number: true, amount: true } },
      budgetRequest: { select: { id: true, number: true, amount: true } },
      commissionShare: { select: { id: true, request: { select: { id: true, number: true } } } },
    },
  },
  lines: { orderBy: { sortOrder: 'asc' } },
} satisfies Prisma.PaymentInclude;

type PaymentRow = Prisma.PaymentGetPayload<{ include: typeof paymentInclude }>;

/**
 * Who a collection is credited to (the owner's sample: Sale Personnel and
 * Team on every collection) — read off the invoices it settles, never kept on
 * the payment: one name where they agree, every name where they do not.
 */
function collectionCredit(row: { allocations: { invoice: { salesperson: { id: string; name: string } | null; team: { id: string; code: string; name: string } | null } | null }[] }) {
  const people = new Map<string, { id: string; name: string }>();
  const teams = new Map<string, { id: string; code: string; name: string }>();
  for (const a of row.allocations) {
    if (a.invoice?.salesperson) people.set(a.invoice.salesperson.id, a.invoice.salesperson);
    if (a.invoice?.team) teams.set(a.invoice.team.id, a.invoice.team);
  }
  return { salespeople: [...people.values()], teams: [...teams.values()] };
}

function presentPayment(row: PaymentRow) {
  return {
    ...row,
    ...collectionCredit(row),
    amount: num(row.amount),
    allocations: row.allocations.map((a) => ({
      ...a,
      amount: num(a.amount),
      ewtWithheld: a.ewtWithheld == null ? null : num(a.ewtWithheld),
      invoice: a.invoice ? { ...a.invoice, netCollectible: num(a.invoice.netCollectible) } : null,
      bill: a.bill ? { ...a.bill, netPayable: num(a.bill.netPayable) } : null,
      claim: a.claim ? { ...a.claim, total: num(a.claim.total) } : null,
      advance: a.advance ? { ...a.advance, amount: num(a.advance.amount) } : null,
      budgetRequest: a.budgetRequest ? { ...a.budgetRequest, amount: num(a.budgetRequest.amount) } : null,
      commission: a.commissionShare ? a.commissionShare.request : null,
    })),
    lines: row.lines.map((l) => ({ ...l, amount: num(l.amount) })),
    /** Received on account — typed lines settling no invoice yet. */
    onAccount: cents(row.lines.reduce((t, l) => t + num(l.amount), 0)),
  };
}

/** Which settleable an allocation row points at. Exactly one of the five is set. */
function allocationKind(a: {
  invoiceId: string | null;
  billId: string | null;
  claimId: string | null;
  advanceId: string | null;
  budgetRequestId: string | null;
}, paymentKind: PaymentKind): SettleableKind {
  if (a.invoiceId) return 'invoice';
  if (a.billId) return 'bill';
  if (a.claimId) return 'claim';
  // Direction decides what an advance or budget request allocation IS: money
  // out is the release, money in is unspent cash coming back.
  if (a.budgetRequestId) return paymentKind === 'RECEIPT' ? 'budget_request_refund' : 'budget_request';
  return paymentKind === 'RECEIPT' ? 'advance_refund' : 'advance';
}

/**
 * The payment register's where-builder — the screen's rows and the printed
 * list read the same set (`?ids=` narrows to the rows ticked).
 */
/**
 * The two registers over one table (2026-10-20, the owner's call: "CA
 * repayment don't direct to money in Collection, as the collection is intended
 * for monitoring accounts receivable only"). COLLECTIONS is money in FROM A
 * CUSTOMER; everything else — money out, and money a person pays back (a cash
 * advance's repayment, a salary or commission deduction, unspent budget
 * returned) — is Money out › Payments & Repayments.
 */
export const COLLECTION_WHERE: Prisma.PaymentWhereInput = { kind: 'RECEIPT', customerId: { not: null } };
const NOT_COLLECTION_WHERE: Prisma.PaymentWhereInput = { OR: [{ kind: 'DISBURSEMENT' }, { customerId: null }] };
const PAYMENT_REGISTERS = ['collections', 'other'] as const;
type PaymentRegister = (typeof PAYMENT_REGISTERS)[number];

/** The rights that open the whole table; a holder of Payments & Repayments alone sees its register only. */
const ALL_PAYMENTS = ['gfin.payments.view_all', 'gfin.ar.view_all', 'gfin.ap.view_all'] as const;
const PAYMENT_READERS = [...ALL_PAYMENTS, 'gfin.payments_out.view_all'] as const;

function paymentRegister(me: ResolvedUser, q: ListQuery): PaymentRegister | null {
  const asked = q.filters.register;
  if (asked !== undefined && asked !== '' && !PAYMENT_REGISTERS.includes(asked as PaymentRegister)) {
    throw badRequest(`Unknown register "${asked}" — collections or other`);
  }
  if (!ALL_PAYMENTS.some((k) => can(me, k))) return 'other';
  return (asked as PaymentRegister) || null;
}

/** May this caller open this one payment? The whole table's readers, or the other register's for what is not a collection. */
function mayReadPayment(me: ResolvedUser, row: { kind: PaymentKind; customerId: string | null }): boolean {
  if (ALL_PAYMENTS.some((k) => can(me, k))) return true;
  return can(me, 'gfin.payments_out.view_all') && !(row.kind === 'RECEIPT' && row.customerId);
}

function paymentListWhere(q: ListQuery, register: PaymentRegister | null = null): Prisma.PaymentWhereInput {
  const where: Prisma.PaymentWhereInput = {};
  if (register === 'collections') Object.assign(where, COLLECTION_WHERE);
  if (register === 'other') where.AND = [NOT_COLLECTION_WHERE];

  const kind = choice(q.filters.kind, PaymentKind, 'Direction', (k) => (k === 'RECEIPT' ? 'Money in' : 'Money out'));
  if (kind) where.AND = [...((where.AND as Prisma.PaymentWhereInput[] | undefined) ?? []), { kind }];
  if (q.filters.customerId) where.AND = [...((where.AND as Prisma.PaymentWhereInput[] | undefined) ?? []), { customerId: q.filters.customerId }];
  if (q.filters.supplierId) where.supplierId = q.filters.supplierId;
  if (q.filters.payeeUserId) where.payeeUserId = q.filters.payeeUserId;
  const from = filterDay(q.filters.from, 'From');
  const to = filterDay(q.filters.to, 'To');
  if (from || to) where.paymentDate = { ...(from ? { gte: dayOf(from) } : {}), ...(to ? { lte: dayOf(to) } : {}) };
  if (q.filters.uncleared === 'true') where.clearedAt = null;
  const method = choice(q.filters.method, PaymentMethod, 'Method');
  if (method) where.method = method;
  // A collection's salesperson and team are its invoices' (`collectionCredit`).
  const invoiceCredit: Prisma.InvoiceWhereInput = {};
  if (q.filters.salespersonId) invoiceCredit.salespersonId = q.filters.salespersonId === 'none' ? null : q.filters.salespersonId;
  if (q.filters.teamId) invoiceCredit.teamId = q.filters.teamId === 'none' ? null : q.filters.teamId;
  if (Object.keys(invoiceCredit).length) where.allocations = { some: { invoice: invoiceCredit } };
  if (q.filters.invoiceId) where.allocations = { some: { invoiceId: q.filters.invoiceId } };
  if (q.search) {
    where.OR = [
      { number: { contains: q.search, mode: 'insensitive' } },
      { orNumber: { contains: q.search, mode: 'insensitive' } },
      { reference: { contains: q.search, mode: 'insensitive' } },
      { allocations: { some: { invoice: { number: { contains: q.search, mode: 'insensitive' } } } } },
      { customer: { name: { contains: q.search, mode: 'insensitive' } } },
      { supplier: { name: { contains: q.search, mode: 'insensitive' } } },
      // A person is a party too: reimbursements, releases and refunds.
      { payeeUser: { name: { contains: q.search, mode: 'insensitive' } } },
    ];
  }
  const ids = idsFilter(q.filters.ids);
  if (ids) where.id = { in: ids };
  return where;
}

const PAYMENT_SORTS = ['number', 'paymentDate', 'amount', 'createdAt'];

paymentRoutes.get(
  '/',
  requireAny(...PAYMENT_READERS),
  handler(async (req, res) => {
    const q = listQuery(req);
    const where = paymentListWhere(q, paymentRegister(currentUser(req), q));

    const [rows, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        include: paymentInclude,
        orderBy: orderBy(q, PAYMENT_SORTS, { paymentDate: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.payment.count({ where }),
    ]);

    res.json({ ...listResult(rows.map(presentPayment), total, q), summary: await paymentListSummary(where) });
  }),
);

/**
 * The cards over the register (the owner's "TOTAL COLLECTIONS SUM"), under
 * the list's own query: what customers paid (collections only — a refund of
 * unspent cash is money in, never a collection), what of it is still an
 * uncleared cheque, money out, and the collections split by the team of the
 * invoices they settled (`teamShares`, by the amount applied to each).
 */
async function paymentListSummary(where: Prisma.PaymentWhereInput) {
  const collectionWhere: Prisma.PaymentWhereInput = { AND: [where, { ...COLLECTION_WHERE, ...LIVE_MONEY }] };
  const chequeWhere: Prisma.PaymentWhereInput = { AND: [collectionWhere, { method: 'CHECK' }] };
  const [collected, uncleared, out, allocations, cheques, chequesCleared, history, repaid, unclearedAll] = await Promise.all([
    prisma.payment.aggregate({ where: collectionWhere, _sum: { amount: true }, _count: { _all: true } }),
    prisma.payment.aggregate({ where: { AND: [collectionWhere, { clearedAt: null }] }, _sum: { amount: true }, _count: { _all: true } }),
    prisma.payment.aggregate({ where: { AND: [where, { kind: 'DISBURSEMENT' }] }, _sum: { amount: true }, _count: { _all: true } }),
    prisma.paymentAllocation.findMany({
      where: { payment: collectionWhere, invoiceId: { not: null } },
      select: { amount: true, invoice: { select: { team: TEAM_REF_SELECT } } },
    }),
    prisma.payment.aggregate({ where: chequeWhere, _sum: { amount: true }, _count: { _all: true } }),
    prisma.payment.aggregate({ where: { AND: [chequeWhere, { clearedAt: { not: null } }] }, _sum: { amount: true }, _count: { _all: true } }),
    // SCORO's collections, listed but never counted (the owner's call).
    prisma.payment.aggregate({ where: { AND: [where, { kind: 'RECEIPT', importedFrom: { not: null } }] }, _sum: { amount: true }, _count: { _all: true } }),
    // Money a person paid back — never a collection (2026-10-20).
    prisma.payment.aggregate({ where: { AND: [where, { kind: 'RECEIPT', customerId: null }] }, _sum: { amount: true }, _count: { _all: true } }),
    prisma.payment.aggregate({ where: { AND: [where, { clearedAt: null }] }, _sum: { amount: true } }),
  ]);
  const chequeTotal = num(cheques._sum.amount);
  return {
    // Cheques received from customers, and the share of their value the bank has cleared.
    cheques: cheques._count._all,
    chequesCleared: chequesCleared._count._all,
    chequesClearedPct: chequeTotal > 0 ? Math.round((num(chequesCleared._sum.amount) / chequeTotal) * 1000) / 10 : null,
    collected: num(collected._sum.amount),
    collections: collected._count._all,
    uncleared: num(uncleared._sum.amount),
    unclearedCount: uncleared._count._all,
    paidOut: num(out._sum.amount),
    disbursements: out._count._all,
    teams: await teamShares(allocations.map((a) => ({ team: a.invoice?.team ?? null, cents: Math.round(num(a.amount) * 100) }))),
    history: { count: history._count._all, amount: num(history._sum.amount) },
    repaid: num(repaid._sum.amount),
    repayments: repaid._count._all,
    unclearedAll: num(unclearedAll._sum.amount),
  };
}

/**
 * The payment register on paper — the list as filtered (or the rows ticked),
 * through `paymentListWhere`: every movement of money, which way it went and
 * what it settled. The totals are money in, money out and the difference,
 * over every payment the filter matched; an uncleared cheque is counted as
 * recorded, and a note says how many are still uncleared — cash only once
 * the bank says so. Above `/:id`.
 */
paymentRoutes.get(
  '/pdf',
  requireAny(...PAYMENT_READERS),
  handler(async (req, res) => {
    const q = listQuery(req);
    const register = paymentRegister(currentUser(req), q);
    const where = paymentListWhere(q, register);
    const [rows, count, byKind, uncleared, currency, customer, supplier, payee] = await Promise.all([
      prisma.payment.findMany({
        where,
        include: {
          customer: { select: { name: true } },
          supplier: { select: { name: true } },
          payeeUser: { select: { name: true } },
          allocations: {
            select: {
              invoice: { select: { number: true } },
              bill: { select: { number: true } },
              claim: { select: { number: true } },
              advance: { select: { number: true } },
              budgetRequest: { select: { number: true } },
              commissionShare: { select: { request: { select: { number: true } } } },
            },
          },
        },
        orderBy: orderBy(q, PAYMENT_SORTS, { paymentDate: 'desc' }),
        take: LIST_CAP,
      }),
      prisma.payment.count({ where }),
      prisma.payment.groupBy({ by: ['kind'], where, _sum: { amount: true } }),
      prisma.payment.count({ where: { AND: [where, { clearedAt: null }] } }),
      companyCurrency(),
      recordNamed('customer', q.filters.customerId),
      recordNamed('supplier', q.filters.supplierId),
      recordNamed('person', q.filters.payeeUserId, 'with'),
    ]);

    const f = q.filters;
    const kind = choice(f.kind, PaymentKind, 'Direction', (k) => (k === 'RECEIPT' ? 'Money in' : 'Money out'));
    const reference = listReference(count, rows.length, ['payment', 'payments'], [
      q.search && `search "${q.search}"`,
      kind && (kind === 'RECEIPT' ? 'money in' : 'money out'),
      customer,
      supplier,
      payee,
      rangeNamed('dated', f.from, f.to),
      f.uncleared === 'true' && 'uncleared only',
      f.method && statusLabel(f.method),
      f.salespersonId && (f.salespersonId === 'none' ? 'no salesperson' : await recordNamed('person', f.salespersonId)),
      f.teamId && (f.teamId === 'none' ? 'no team' : `team ${(await prisma.industry.findUnique({ where: { id: f.teamId }, select: { code: true } }))?.code ?? '?'}`),
      f.ids && 'the rows selected',
    ]);
    const sumOf = (k: PaymentKind) => num(byKind.find((g) => g.kind === k)?._sum.amount);
    const moneyIn = sumOf('RECEIPT');
    const moneyOut = sumOf('DISBURSEMENT');
    // One direction (filtered to it, or all there is): its own total. Otherwise each, then the difference.
    const kinds = new Set(byKind.map((g) => g.kind));
    const only: PaymentKind | null = kind ?? (kinds.size === 1 ? [...kinds][0] : null);
    const settles = (r: (typeof rows)[number]) =>
      r.allocations
        .map((a) => a.invoice?.number ?? a.bill?.number ?? a.claim?.number ?? a.advance?.number ?? a.budgetRequest?.number ?? a.commissionShare?.request.number)
        .filter(Boolean)
        .join('\n');

    const sections: PdfSection[] = [
      {
        kind: 'table',
        head: ['Number', 'Date', 'Who', 'Direction', 'Settles', `Amount (${currency})`, 'Cleared'],
        align: ['left', 'left', 'left', 'left', 'left', 'right', 'left'],
        rows: rows.map((r) => [
          r.orNumber ? { title: r.number, body: `OR ${r.orNumber}` } : r.number,
          formatShortDate(r.paymentDate),
          {
            title: r.customer?.name ?? r.supplier?.name ?? r.payeeUser?.name ?? '—',
            body: [statusLabel(r.method), r.reference].filter(Boolean).join(' · '),
          },
          r.kind === 'RECEIPT' ? 'Money in' : 'Money out',
          settles(r),
          formatAmount(num(r.amount)),
          r.clearedAt ? formatShortDate(r.clearedAt) : 'Uncleared',
        ]),
      },
      {
        kind: 'totals',
        rows: only
          ? [
              {
                label: totalLabel(only === 'DISBURSEMENT' ? 'Money out' : 'Money in', count, rows.length),
                value: formatMoney(only === 'DISBURSEMENT' ? moneyOut : moneyIn, currency),
                bold: true,
              },
            ]
          : [
              { label: 'Money in', value: formatMoney(moneyIn, currency) },
              { label: 'Money out', value: formatMoney(moneyOut, currency) },
              { label: totalLabel('Net, in less out', count, rows.length), value: formatMoney(cents(moneyIn - moneyOut), currency), bold: true },
            ],
      },
    ];
    sections.push(
      ...listNotes([
        uncleared > 0 &&
          `${counted(uncleared, ['payment is', 'payments are'])} not cleared yet — recorded, and counted above, but not cash until the bank says so.`,
      ]),
    );

    const pdf = await renderDocument({
      title: register === 'collections' ? 'Collections' : register === 'other' ? 'Payments & Repayments' : 'Payments',
      date: new Date(),
      reference,
      sections,
    });
    await audit(
      { entityType: 'payment', entityId: 'list', action: 'EXPORTED', summary: `Exported the payment list as PDF (${rows.length} payment(s))` },
      req,
    );
    sendListPdf(res, pdf, 'payments.pdf');
  }),
);

paymentRoutes.get(
  '/:id',
  requireAny(...PAYMENT_READERS),
  handler(async (req, res) => {
    const row = await prisma.payment.findUnique({
      where: { id: req.params.id },
      include: paymentInclude,
    });
    if (!row || !mayReadPayment(currentUser(req), row)) throw notFound('Payment not found');
    res.json(presentPayment(row));
  }),
);

/**
 * One payment on paper. Money in from a customer is a **Collection
 * Receipt** under its OR number (G-CORE's `official_receipt` series): who
 * paid, how — the cheque or transfer reference and the bank — and the
 * invoices it settled with the amount applied to each. Money out is a
 * **Payment Voucher**. Signed by whoever recorded it, dated when they did;
 * an uncleared cheque says so in the foot.
 */
paymentRoutes.get(
  '/:id/pdf',
  requireAny(...PAYMENT_READERS),
  handler(async (req, res) => {
    const row = await prisma.payment.findUnique({ where: { id: req.params.id }, include: paymentInclude });
    if (!row || !mayReadPayment(currentUser(req), row)) throw notFound('Payment not found');
    const currency = await companyCurrency();
    const receipt = row.kind === 'RECEIPT';
    const party = row.customer?.name ?? row.supplier?.name ?? row.payeeUser?.name ?? '—';
    const credit = collectionCredit(row);
    const settled = row.allocations.map((a) => {
      const t = a.invoice ?? a.bill ?? a.claim ?? a.advance ?? a.budgetRequest ?? a.commissionShare?.request;
      const what = a.invoice ? 'Sales invoice' : a.bill ? 'Supplier bill' : a.claim ? 'Expense claim' : a.advance ? 'Cash advance' : a.budgetRequest ? 'Budget request' : 'Commission';
      return [
        t?.number ?? '—',
        what,
        a.invoice?.invoiceDate ? formatShortDate(a.invoice.invoiceDate) : '—',
        a.ewtWithheld == null ? '' : formatAmount(num(a.ewtWithheld)),
        formatAmount(num(a.amount)),
      ];
    });
    // Lines typed by hand: received on account, settling no invoice yet.
    for (const l of row.lines) settled.push([l.reference, 'On account', '—', '', formatAmount(num(l.amount))]);
    // The EWT column only where a collection said what was withheld (2026-10-20).
    const withEwt = row.allocations.some((a) => a.ewtWithheld != null);
    const cols = (r: string[]) => (withEwt ? r : [...r.slice(0, 3), r[4]]);
    const sections: PdfSection[] = [
      {
        kind: 'fields',
        columns: 3,
        fields: [
          { label: receipt ? 'Received from' : 'Paid to', value: party },
          { label: 'Method', value: statusLabel(row.method) },
          { label: row.method === 'CHECK' ? 'Cheque no.' : 'Reference', value: row.reference ?? '—' },
          { label: 'Bank', value: row.bank ?? '—' },
          { label: 'Cleared', value: row.clearedAt ? formatDate(row.clearedAt) : 'Not yet' },
          ...(row.orNumber ? [{ label: 'Payment no.', value: row.number }] : []),
          ...(credit.salespeople.length ? [{ label: 'Sales personnel', value: credit.salespeople.map((p) => p.name).join(', ') }] : []),
          ...(credit.teams.length ? [{ label: 'Team', value: credit.teams.map((t) => t.code).join(', ') }] : []),
        ],
      },
      {
        kind: 'table',
        title: receipt ? 'In payment of' : 'Settles',
        head: cols(['Number', 'Document', 'Dated', `EWT withheld (${currency})`, `Applied (${currency})`]),
        align: cols(['left', 'left', 'left', 'right', 'right']) as ('left' | 'right')[],
        rows: settled.map(cols),
      },
      { kind: 'totals', rows: [{ label: receipt ? 'Amount received' : 'Amount paid', value: formatMoney(num(row.amount), currency), bold: true }] },
    ];
    if (row.notes) sections.push({ kind: 'text', title: 'Notes', body: row.notes });
    const recorder = await contactOf(row.recordedBy.id);
    const pdf = await renderDocument({
      title: receipt ? (row.orNumber ? 'Collection Receipt' : 'Receipt') : 'Payment Voucher',
      documentNumber: row.orNumber ?? row.number,
      date: row.paymentDate,
      reference: party,
      sections,
      signatories: [{ role: receipt ? 'Received by' : 'Prepared by', name: row.recordedBy.name, ...recorder, at: row.createdAt }],
      footerNote: row.method === 'CHECK' && !row.clearedAt ? 'Cheque received — not yet cleared.' : undefined,
    });
    await audit({ entityType: 'payment', entityId: row.id, action: 'EXPORTED', summary: `Printed ${row.orNumber ? `OR ${row.orNumber}` : row.number}` }, req);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      contentDisposition(paperFileName({ kind: receipt ? 'Collection Receipt' : 'Payment Voucher', number: row.orNumber ?? row.number, author: row.recordedBy.name, date: row.paymentDate })),
    );
    res.send(pdf);
  }),
);

const paymentSchema = z.object({
  kind: z.enum(['RECEIPT', 'DISBURSEMENT']),
  method: z.enum(['CASH', 'CHECK', 'BANK_TRANSFER', 'ONLINE', 'OFFSET', 'SALARY_DEDUCTION']).default('BANK_TRANSFER'),
  paymentDate: z.string().optional(),
  customerId: z.string().optional().nullable(),
  supplierId: z.string().optional().nullable(),
  payeeUserId: z.string().optional().nullable(),
  reference: z.string().optional().nullable(),
  bank: z.string().optional().nullable(),
  clearedAt: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  allocations: z
    .array(
      z.object({
        kind: z.enum(['invoice', 'bill', 'claim', 'advance', 'advance_refund', 'budget_request', 'budget_request_refund']),
        id: z.string().min(1),
        amount: z.number().positive('An allocation must be more than zero'),
        /** On a customer's invoice: the EWT they withheld on this collection, typed (2026-10-20). */
        ewtWithheld: z.number().min(0).optional().nullable(),
      }),
    )
    .default([]),
  /**
   * Lines typed by hand on a customer's collection (2026-10-16, the owner's
   * call): a reference and an amount received on account, against no invoice
   * on file — applied to one later.
   */
  lines: z
    .array(
      z.object({
        reference: z.string().trim().min(1, 'Every line needs a reference — an SI no. or what it is for').max(200),
        amount: z.number().positive('A line must be more than zero'),
      }),
    )
    .max(50)
    .default([]),
});

/**
 * Recording money, and saying what it settles.
 *
 * A payment must be fully allocated. A cheque sitting against no invoice is
 * cash the aging report cannot see, and "we were paid but A/R still shows it
 * outstanding" is the complaint that follows.
 */
paymentRoutes.post(
  '/',
  requireAny('gfin.ar.create', 'gfin.ap.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(paymentSchema, req.body);
    if (!body.allocations.length && !body.lines.length) throw badRequest('Say which documents this payment settles, or add a line by hand');
    if (body.lines.length && (body.kind !== 'RECEIPT' || body.method === 'SALARY_DEDUCTION')) {
      throw badRequest('Lines typed by hand are a customer’s money received on account — record a disbursement against its documents');
    }

    // Recording money in and recording money out are different rights.
    const needed = body.kind === 'RECEIPT' ? 'gfin.ar.create' : 'gfin.ap.create';
    if (!me.isSuperAdmin && !me.permissions.has(needed)) {
      throw forbidden(`Recording a ${body.kind.toLowerCase()} needs "${needed}"`);
    }

    // Money in settles what is owed TO us: a customer's invoice, or a person's
    // unspent advance coming back. Money out settles what we owe: a bill, a
    // claim, or the advance itself.
    const MONEY_IN = ['invoice', 'advance_refund', 'budget_request_refund'];
    // A salary deduction repays a cash advance out of the person's pay; it
    // settles nothing else.
    if (body.method === 'SALARY_DEDUCTION' && (body.kind !== 'RECEIPT' || body.allocations.some((a) => a.kind !== 'advance_refund'))) {
      throw badRequest('A salary deduction repays a cash advance — record anything else as cash, cheque or transfer');
    }
    if (body.kind === 'RECEIPT' && body.allocations.some((a) => !MONEY_IN.includes(a.kind))) {
      throw badRequest('A receipt settles customer invoices or returns unspent cash. Record money going out as a disbursement.');
    }
    if (body.kind === 'DISBURSEMENT' && body.allocations.some((a) => MONEY_IN.includes(a.kind))) {
      throw badRequest('A disbursement settles supplier bills, expense claims, cash advances or budget requests, not money coming in.');
    }

    const amount = cents(body.allocations.reduce((s, a) => s + a.amount, 0) + body.lines.reduce((s, l) => s + cents(l.amount), 0));
    if (amount <= 0) throw badRequest('The payment must be more than zero');

    // Every allocation is checked against what is actually still owed, before
    // anything is written. Over-applying is how a document ends up "more than
    // paid" and an aging report goes negative.
    const advances: { id: string; number: string }[] = [];
    const requests: { id: string; number: string }[] = [];
    for (const allocation of body.allocations) {
      if (allocation.ewtWithheld != null && allocation.kind !== 'invoice') {
        throw badRequest('The EWT withheld is typed on a customer’s invoice only');
      }
      const target = await settleable(allocation.kind as SettleableKind, allocation.id);
      if (!target) throw notFound(`That ${allocation.kind.replace(/_/g, ' ')} does not exist`);
      // The EWT the customer withheld on THIS collection (2026-10-20): the
      // invoice's EWT becomes what its collections say, so what is owed moves
      // with it — checked as it will stand once this is written.
      if (allocation.kind === 'invoice' && allocation.ewtWithheld != null) {
        const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: allocation.id } });
        if (allocation.ewtWithheld > cents(num(inv.grossAmount) * 0.15) + 0.005) {
          throw badRequest(`${inv.number}: an EWT of ${allocation.ewtWithheld} is more than 15% of its amount before VAT`);
        }
        const after = await withheldOn(prisma, inv.id, inv, cents(allocation.ewtWithheld));
        target.outstanding = cents(after.netCollectible - num(inv.amountCollected));
      }
      if (allocation.amount > target.outstanding + 0.005) {
        throw badRequest(
          target.outstanding <= 0.005 && allocation.kind === 'advance_refund'
            ? `${target.number} has nothing to repay or return`
            : `${target.number} has only ${target.outstanding} outstanding, but ${allocation.amount} is being applied to it.`,
        );
      }
      // An advance — and a budget request — is released in one voucher. Half
      // of one is a second document with its own liquidation, and the paper
      // form has no such thing.
      if (allocation.kind === 'advance' || allocation.kind === 'budget_request') {
        const what = allocation.kind === 'advance' ? 'An advance' : 'A budget request';
        if (target.outstanding <= 0.005) throw badRequest(`${target.number} is not waiting to be released`);
        if (Math.abs(allocation.amount - target.outstanding) > 0.005) {
          throw badRequest(`${what} is released in one voucher — release PHP ${target.outstanding} or cancel it`);
        }
        (allocation.kind === 'advance' ? advances : requests).push({ id: target.id, number: target.number });
      }
    }

    // A customer's collection is given an official receipt, numbered by
    // G-CORE in the same transaction (2026-10-15, the owner's call). It is
    // from ONE customer — the invoices', named on the payment whether or not
    // the form said so.
    const collection = body.kind === 'RECEIPT' && (body.allocations.some((a) => a.kind === 'invoice') || body.lines.length > 0);
    if (body.lines.length && !body.customerId && !body.allocations.some((a) => a.kind === 'invoice')) {
      throw badRequest('Money received on account is a customer’s — say which company paid');
    }
    if (body.lines.length && body.customerId && !(await prisma.customer.findUnique({ where: { id: body.customerId }, select: { id: true } }))) {
      throw badRequest('That customer does not exist');
    }
    if (collection) {
      const invoiceIds = body.allocations.filter((a) => a.kind === 'invoice').map((a) => a.id);
      const owners = await prisma.invoice.findMany({ where: { id: { in: invoiceIds } }, select: { customerId: true }, distinct: ['customerId'] });
      if (owners.length > 1) throw badRequest('One collection is from one customer — record each customer’s payment on its own');
      if (owners[0] && body.customerId && body.customerId !== owners[0].customerId) throw badRequest('Those invoices are another customer’s');
      body.customerId = owners[0]?.customerId ?? body.customerId;
    }
    const payment = await prisma.$transaction(async (tx) => {
      const number = await nextNumber(body.kind === 'RECEIPT' ? 'payment' : 'disbursement', tx);
      const orNumber = collection ? await nextNumber('official_receipt', tx) : null;
      const created = await tx.payment.create({
        data: {
          number,
          orNumber,
          kind: body.kind,
          method: body.method,
          paymentDate: body.paymentDate ? asDate(body.paymentDate, 'Payment date') : dayKey(new Date()),
          customerId: body.customerId || null,
          supplierId: body.supplierId || null,
          payeeUserId: body.payeeUserId || null,
          amount: D(amount),
          reference: body.reference || null,
          bank: body.bank || null,
          // A cheque is a promise until it clears; a transfer is cash on the day.
          clearedAt: body.clearedAt
            ? asDate(body.clearedAt, 'Cleared date')
            : body.method === 'CHECK'
              ? null
              : body.paymentDate
                ? asDate(body.paymentDate, 'Payment date')
                : dayKey(new Date()),
          notes: body.notes || null,
          recordedById: me.id,
          allocations: {
            create: body.allocations.map((a) => ({
              invoiceId: a.kind === 'invoice' ? a.id : null,
              ewtWithheld: a.kind === 'invoice' && a.ewtWithheld != null ? D(cents(a.ewtWithheld)) : null,
              billId: a.kind === 'bill' ? a.id : null,
              claimId: a.kind === 'claim' ? a.id : null,
              advanceId: a.kind === 'advance' || a.kind === 'advance_refund' ? a.id : null,
              budgetRequestId: a.kind === 'budget_request' || a.kind === 'budget_request_refund' ? a.id : null,
              amount: D(a.amount),
            })),
          },
          lines: { create: body.lines.map((l, i) => ({ sortOrder: i, reference: l.reference, amount: D(cents(l.amount)) })) },
        },
        include: paymentInclude,
      });

      for (const allocation of body.allocations) {
        await refreshSettlement(tx, allocation.kind as SettleableKind, allocation.id);
      }
      return created;
    });

    // The person now holds the cash; the liquidation clock has started.
    for (const adv of advances) {
      const released = await prisma.cashAdvance.findUnique({
        where: { id: adv.id },
        select: { requestedById: true, liquidationDueDate: true, amountReleased: true },
      });
      if (!released) continue;
      const due = released.liquidationDueDate ? formatDate(released.liquidationDueDate) : 'the due date';
      await notify({
        userId: released.requestedById,
        type: 'system',
        title: `${adv.number} released — liquidate by ${due}`,
        body: `${num(released.amountReleased)} has been released to you. File the receipts as a liquidation before ${due}.`,
        link: `/g-fin/cash-advances/${adv.id}`,
      });
      await audit(
        {
          entityType: 'cash_advance',
          entityId: adv.id,
          action: 'UPDATED',
          summary: `${adv.number} released on ${payment.number} — liquidate by ${due}`,
        },
        req,
      );
    }
    // The team now holds the project's cash; its liquidation clock has started.
    for (const br of requests) {
      const released = await prisma.budgetRequest.findUnique({
        where: { id: br.id },
        select: { requestedById: true, liquidationDueDate: true, amountReleased: true, job: { select: { number: true } } },
      });
      if (!released) continue;
      const due = released.liquidationDueDate ? formatDate(released.liquidationDueDate) : 'the due date';
      await notify({
        userId: released.requestedById,
        type: 'system',
        title: `${br.number} released — liquidate by ${due}`,
        body: `${num(released.amountReleased)} has been released for ${released.job.number}. File the receipts as a liquidation in Expenses before ${due}.`,
        link: `/g-ops/budget-requests/${br.id}`,
      });
      await audit(
        {
          entityType: 'budget_request',
          entityId: br.id,
          action: 'UPDATED',
          summary: `${br.number} released on ${payment.number} — liquidate by ${due}`,
        },
        req,
      );
    }

    await audit(
      {
        entityType: 'payment',
        entityId: payment.id,
        action: 'CREATED',
        summary: `${payment.number}${payment.orNumber ? ` (OR ${payment.orNumber})` : ''} — ${amount} ${body.kind === 'RECEIPT' ? 'received' : 'paid'} across ${body.allocations.length} document(s)${body.lines.length ? `, ${body.lines.length} line(s) on account` : ''}`,
      },
      req,
    );
    res.status(201).json(presentPayment(payment));
  }),
);

/**
 * Applying money received on account to an invoice once it is on file
 * (2026-10-16): the line's amount — or part of it — becomes an allocation on
 * the same payment, never past the invoice's outstanding, the same customer's
 * invoice only; the line shrinks or goes. Settled totals re-derive as ever.
 */
paymentRoutes.post(
  '/:id/lines/:lineId/apply',
  require_('gfin.ar.create'),
  handler(async (req, res) => {
    const body = parseBody(z.object({ invoiceId: z.string().min(1, 'Which invoice?'), amount: z.number().positive().optional() }), req.body);
    const payment = await prisma.payment.findUnique({ where: { id: req.params.id }, include: { lines: true } });
    if (!payment) throw notFound('Payment not found');
    const line = payment.lines.find((l) => l.id === req.params.lineId);
    if (!line) throw notFound('That line is not on this payment');
    const invoice = await prisma.invoice.findUnique({ where: { id: body.invoiceId }, select: { id: true, number: true, customerId: true } });
    if (!invoice) throw notFound('Invoice not found');
    if (payment.customerId && invoice.customerId !== payment.customerId) throw badRequest(`${invoice.number} is another customer’s invoice`);
    const lineAmount = num(line.amount);
    const applying = cents(body.amount ?? lineAmount);
    if (applying > lineAmount + 0.005) throw badRequest(`Only ${lineAmount} is on that line`);
    const target = await settleable('invoice', invoice.id);
    if (!target) throw notFound('Invoice not found');
    const amount = cents(Math.min(applying, target.outstanding));
    if (amount <= 0.005) throw badRequest(`${invoice.number} has nothing outstanding`);
    await prisma.$transaction(async (tx) => {
      const left = cents(lineAmount - amount);
      const moved = left > 0.005
        ? await tx.paymentLine.updateMany({ where: { id: line.id, amount: line.amount }, data: { amount: D(left) } })
        : await tx.paymentLine.deleteMany({ where: { id: line.id, amount: line.amount } });
      if (!moved.count) throw badRequest('That line changed a moment ago — reload');
      await tx.paymentAllocation.create({ data: { paymentId: payment.id, invoiceId: invoice.id, amount: D(amount) } });
      await refreshSettlement(tx, 'invoice', invoice.id);
    });
    await audit(
      { entityType: 'payment', entityId: payment.id, action: 'UPDATED', summary: `${payment.number}: ${amount} on account (${line.reference}) applied to ${invoice.number}` },
      req,
    );
    const fresh = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id }, include: paymentInclude });
    res.json(presentPayment(fresh));
  }),
);

/** Marking a cheque cleared. Until then it is a promise, not cash. */
paymentRoutes.post(
  '/:id/clear',
  requireAny('gfin.ar.edit_all', 'gfin.ap.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(z.object({ clearedAt: z.string().optional() }), req.body);
    const payment = await prisma.payment.findUnique({ where: { id: req.params.id } });
    if (!payment) throw notFound('Payment not found');
    if (payment.clearedAt) throw badRequest('This payment has already cleared');

    const updated = await prisma.payment.update({
      where: { id: payment.id },
      data: { clearedAt: body.clearedAt ? asDate(body.clearedAt, 'Cleared date') : dayKey(new Date()) },
      include: paymentInclude,
    });
    await audit(
      { entityType: 'payment', entityId: payment.id, action: 'UPDATED', summary: `${payment.number} cleared` },
      req,
    );
    res.json(presentPayment(updated));
  }),
);

/**
 * Reversing a payment.
 *
 * Deleting the allocations and re-deriving each document is deliberate: the
 * settled totals are recomputed from the rows that remain, so nothing can be
 * left behind pointing at money that is no longer there.
 */
paymentRoutes.delete(
  '/:id',
  requireAny('gfin.ar.delete', 'gfin.ap.delete'),
  handler(async (req, res) => {
    const payment = await prisma.payment.findUnique({
      where: { id: req.params.id },
      include: { allocations: true },
    });
    if (!payment) throw notFound('Payment not found');
    // A commission's payout and the advance repayment it deducted are one
    // decision, written together by POST /commissions/:id/pay (2026-10-16);
    // reversing half of it would pay a beneficiary twice or forgive a loan.
    if (payment.method === 'COMMISSION_DEDUCTION' || payment.allocations.some((a) => a.commissionShareId)) {
      throw badRequest('This payment is a commission payout or its cash advance deduction — it is not reversed on its own');
    }

    const touched = payment.allocations.map((a) => ({
      kind: allocationKind(a, payment.kind),
      id: (a.invoiceId ?? a.billId ?? a.claimId ?? a.advanceId ?? a.budgetRequestId)!,
    }));

    // Reversing a release while somebody is accounting for that cash would
    // leave a liquidation pointing at cash that was never handed over.
    for (const t of touched) {
      if (t.kind !== 'advance' && t.kind !== 'budget_request') continue;
      const live = await prisma.expenseClaim.findFirst({
        where: {
          ...(t.kind === 'advance' ? { advanceId: t.id } : { budgetRequestId: t.id }),
          status: { in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SETTLED', 'REIMBURSED'] },
        },
        select: { number: true },
      });
      if (live) {
        throw badRequest(`${live.number} is liquidating this ${t.kind === 'advance' ? 'advance' : 'budget request'}. Cancel the liquidation first.`);
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.payment.delete({ where: { id: payment.id } });
      for (const t of touched) await refreshSettlement(tx, t.kind, t.id);
    });

    await audit(
      {
        entityType: 'payment',
        entityId: payment.id,
        action: 'DELETED',
        summary: `${payment.number} reversed — ${num(payment.amount)} unapplied from ${touched.length} document(s)`,
      },
      req,
    );
    res.json({ ok: true });
  }),
);

/** What a customer or supplier still owes, ready to allocate against. */
paymentRoutes.get(
  '/open/:kind',
  requireAny('gfin.ar.view_all', 'gfin.ap.view_all'),
  handler(async (req, res) => {
    const kind = req.params.kind;
    const partyId = req.query.partyId ? String(req.query.partyId) : undefined;

    if (kind === 'invoice') {
      const rows = await prisma.invoice.findMany({
        where: {
          status: { in: ['ISSUED', 'PARTIALLY_PAID'] },
          ...(partyId ? { customerId: partyId } : {}),
        },
        include: invoiceInclude,
        orderBy: { dueDate: 'asc' },
      });
      res.json(rows.map(presentInvoice).filter((r) => r.outstanding > 0.005));
      return;
    }
    if (kind === 'bill') {
      const rows = await prisma.supplierBill.findMany({
        where: {
          status: { in: ['APPROVED', 'PARTIALLY_PAID'] },
          ...(partyId ? { supplierId: partyId } : {}),
        },
        include: billInclude,
        orderBy: { dueDate: 'asc' },
      });
      res.json(rows.map(presentBill).filter((r) => r.outstanding > 0.005));
      return;
    }
    if (kind === 'claim') {
      const rows = await prisma.expenseClaim.findMany({
        where: { status: 'APPROVED', ...(partyId ? { claimedById: partyId } : {}) },
        include: claimInclude,
        orderBy: { claimDate: 'asc' },
      });
      res.json(rows.map(presentClaim).filter((r) => r.outstanding > 0.005));
      return;
    }
    if (kind === 'advance' || kind === 'advance_refund') {
      const rows = await prisma.cashAdvance.findMany({
        where: {
          // Money back on an advance: unspent cash after a liquidation, or a
          // loan's repayments while it is out (2026-10-15).
          ...(kind === 'advance' ? { status: 'APPROVED' as const } : { OR: [{ status: 'REFUND_DUE' as const }, { status: 'RELEASED' as const, repayable: true }] }),
          ...(partyId ? { requestedById: partyId } : {}),
        },
        include: { requestedBy: { select: { id: true, name: true } } },
        orderBy: { requestDate: 'asc' },
      });
      res.json(
        rows
          .map((r) => {
            const released = num(r.amountReleased);
            const outstanding =
              kind === 'advance'
                ? cents(num(r.amount) - released)
                : r.repayable
                  ? cents(released - num(r.amountRefunded))
                  : cents(Math.max(0, released - num(r.amountSpent)) - num(r.amountRefunded));
            return {
              id: r.id,
              number: r.number,
              purpose: r.purpose,
              status: r.status,
              requestedBy: r.requestedBy,
              amount: num(r.amount),
              outstanding,
            };
          })
          .filter((r) => r.outstanding > 0.005),
      );
      return;
    }
    if (kind === 'budget_request' || kind === 'budget_request_refund') {
      const rows = await prisma.budgetRequest.findMany({
        where: {
          status: kind === 'budget_request' ? 'APPROVED' : 'REFUND_DUE',
          ...(partyId ? { requestedById: partyId } : {}),
        },
        include: { requestedBy: { select: { id: true, name: true } }, job: { select: { number: true } } },
        orderBy: { createdAt: 'asc' },
      });
      res.json(
        rows
          .map((r) => {
            const released = num(r.amountReleased);
            const outstanding =
              kind === 'budget_request'
                ? cents(num(r.amount) - released)
                : cents(Math.max(0, released - num(r.amountSpent)) - num(r.amountRefunded));
            return {
              id: r.id,
              number: r.number,
              purpose: `${r.job.number} — ${r.reason}`,
              status: r.status,
              requestedBy: r.requestedBy,
              amount: num(r.amount),
              outstanding,
            };
          })
          .filter((r) => r.outstanding > 0.005),
      );
      return;
    }
    throw badRequest('Ask for invoice, bill, claim, advance, advance_refund, budget_request or budget_request_refund');
  }),
);

// ════════════════════════════════════════════════════════════════════
//  REPORTS — aging, cash flow, budget vs actual, the dashboard
// ════════════════════════════════════════════════════════════════════

export const financeReportRoutes = Router();
financeReportRoutes.use(authenticate);

/**
 * A/R aging.
 *
 * Outstanding is `netCollectible − collected`. The withheld EWT is reported in
 * its own column so it can be chased as a 2307 certificate, but it is NEVER
 * part of the overdue balance — that is the whole point (model §5.4).
 */
financeReportRoutes.get(
  '/ar-aging',
  require_('gfin.ar.view_all'),
  handler(async (req, res) => {
    const asOf = req.query.asOf ? asDate(String(req.query.asOf), 'As of') : dayKey(new Date());
    const settings = await financeSettings();

    const invoices = await prisma.invoice.findMany({
      where: { status: { in: ['ISSUED', 'PARTIALLY_PAID'] } },
      include: {
        customer: { select: { id: true, name: true } },
        job: { select: { number: true } },
      },
      orderBy: { dueDate: 'asc' },
    });

    const rows: AgedRow[] = invoices
      .map((inv) => {
        const payable = num(inv.netCollectible);
        const paid = num(inv.amountCollected);
        const outstanding = cents(payable - paid);
        // Not countered: the terms have not started, so it is never late
        // (it ages as Current and is counted apart below).
        const daysOverdue = inv.counteredDate ? daysBetween(inv.dueDate, asOf) : Math.min(0, daysBetween(inv.dueDate, asOf));
        return {
          id: inv.id,
          number: inv.number,
          awaitingCounter: !inv.counteredDate,
          party: inv.customer.name,
          partyId: inv.customerId,
          date: inv.invoiceDate,
          dueDate: inv.dueDate,
          daysOverdue,
          payable,
          paid,
          outstanding,
          bucket: bucketFor(daysOverdue, settings.agingBuckets),
          jobNumber: inv.job?.number ?? null,
          withheld: inv.ewtCertificateNo ? 0 : num(inv.ewtAmount),
        };
      })
      .filter((r) => r.outstanding > 0.005);

    // Per customer, so the collections call has one number per conversation.
    const byCustomer = new Map<string, { id: string; name: string; outstanding: number; overdue: number; invoices: number }>();
    for (const r of rows) {
      const entry = byCustomer.get(r.partyId) ?? {
        id: r.partyId,
        name: r.party,
        outstanding: 0,
        overdue: 0,
        invoices: 0,
      };
      entry.outstanding = cents(entry.outstanding + r.outstanding);
      if (r.daysOverdue > 0) entry.overdue = cents(entry.overdue + r.outstanding);
      entry.invoices += 1;
      byCustomer.set(r.partyId, entry);
    }

    res.json({
      asOf,
      buckets: summarise(rows, settings.agingBuckets),
      rows,
      customers: [...byCustomer.values()].sort((a, b) => b.outstanding - a.outstanding),
      totalOutstanding: cents(rows.reduce((s, r) => s + r.outstanding, 0)),
      totalOverdue: cents(rows.filter((r) => r.daysOverdue > 0).reduce((s, r) => s + r.outstanding, 0)),
      // Issued and not yet received by the customer — not overdue, whatever its date.
      awaitingCountering: cents(rows.filter((r) => r.awaitingCounter).reduce((s, r) => s + r.outstanding, 0)),
      // Withheld at source and not yet certificated. Real money, but it comes
      // back as a tax credit — never chase it as an unpaid invoice.
      withheldAwaitingCertificate: cents(rows.reduce((s, r) => s + (r.withheld ?? 0), 0)),
    });
  }),
);

financeReportRoutes.get(
  '/ap-aging',
  require_('gfin.ap.view_all'),
  handler(async (req, res) => {
    const asOf = req.query.asOf ? asDate(String(req.query.asOf), 'As of') : dayKey(new Date());
    const settings = await financeSettings();

    const bills = await prisma.supplierBill.findMany({
      where: { status: { in: ['APPROVED', 'PARTIALLY_PAID'] } },
      include: {
        supplier: { select: { id: true, name: true } },
        job: { select: { number: true } },
      },
      orderBy: { dueDate: 'asc' },
    });

    const rows: AgedRow[] = bills
      .map((bill) => {
        const payable = num(bill.netPayable);
        const paid = num(bill.amountPaid);
        const daysOverdue = daysBetween(bill.dueDate, asOf);
        return {
          id: bill.id,
          number: bill.number,
          party: bill.supplier.name,
          partyId: bill.supplierId,
          date: bill.billDate,
          dueDate: bill.dueDate,
          daysOverdue,
          payable,
          paid,
          outstanding: cents(payable - paid),
          bucket: bucketFor(daysOverdue, settings.agingBuckets),
          jobNumber: bill.job?.number ?? null,
        };
      })
      .filter((r) => r.outstanding > 0.005);

    const bySupplier = new Map<string, { id: string; name: string; outstanding: number; overdue: number; bills: number }>();
    for (const r of rows) {
      const entry = bySupplier.get(r.partyId) ?? {
        id: r.partyId,
        name: r.party,
        outstanding: 0,
        overdue: 0,
        bills: 0,
      };
      entry.outstanding = cents(entry.outstanding + r.outstanding);
      if (r.daysOverdue > 0) entry.overdue = cents(entry.overdue + r.outstanding);
      entry.bills += 1;
      bySupplier.set(r.partyId, entry);
    }

    const [claims, advances] = await Promise.all([
      prisma.expenseClaim.findMany({
        where: { status: 'APPROVED' },
        include: { claimedBy: { select: { id: true, name: true } }, advance: { select: { amountReleased: true } } },
      }),
      prisma.cashAdvance.findMany({
        where: { status: 'RELEASED' },
        include: { requestedBy: { select: { id: true, name: true } } },
        orderBy: { liquidationDueDate: 'asc' },
      }),
    ]);
    const unreimbursed = claims
      .map((c) => ({
        id: c.id,
        number: c.number,
        person: c.claimedBy.name,
        claimDate: c.claimDate,
        outstanding: cents(claimPayable(c) - num(c.amountPaid)),
      }))
      .filter((c) => c.outstanding > 0.005);
    // Cash out with people and not yet accounted for. Not a payable — the
    // company is the creditor here — but the aging screen is where finance
    // looks for money that has stopped moving.
    const unliquidated = advances.map((a) => ({
      id: a.id,
      number: a.number,
      person: a.requestedBy.name,
      releasedAt: a.releasedAt,
      liquidationDueDate: a.liquidationDueDate,
      daysOverdue: a.liquidationDueDate ? daysBetween(a.liquidationDueDate, asOf) : 0,
      amount: num(a.amountReleased),
    }));

    res.json({
      asOf,
      buckets: summarise(rows, settings.agingBuckets),
      rows,
      suppliers: [...bySupplier.values()].sort((a, b) => b.outstanding - a.outstanding),
      totalOutstanding: cents(rows.reduce((s, r) => s + r.outstanding, 0)),
      totalOverdue: cents(rows.filter((r) => r.daysOverdue > 0).reduce((s, r) => s + r.outstanding, 0)),
      unreimbursedClaims: unreimbursed,
      unreimbursedTotal: cents(unreimbursed.reduce((s, c) => s + c.outstanding, 0)),
      unliquidatedAdvances: unliquidated,
      unliquidatedTotal: cents(unliquidated.reduce((s, a) => s + a.amount, 0)),
    });
  }),
);

/**
 * Cash flow — what moved, and what is due to move.
 *
 * Actuals come from cleared payments only: an uncleared cheque is a promise,
 * and a cash position that counts promises is the one that bounces. The
 * forecast comes from what is still owed, bucketed by due date.
 */
financeReportRoutes.get(
  '/cash-flow',
  require_('gfin.cashflow.view_all'),
  handler(async (req, res) => {
    const months = Math.min(24, Math.max(1, Number(req.query.months ?? 6)));
    const to = dayKey(new Date());
    const from = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - months + 1, 1));

    const payments = await prisma.payment.findMany({
      where: { clearedAt: { not: null, gte: from }, ...LIVE_MONEY },
      select: { kind: true, amount: true, clearedAt: true },
    });

    const key = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const buckets = new Map<string, { month: string; in: number; out: number }>();
    for (let i = 0; i < months; i++) {
      const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + i, 1));
      buckets.set(key(d), { month: key(d), in: 0, out: 0 });
    }
    for (const p of payments) {
      const bucket = buckets.get(key(p.clearedAt!));
      if (!bucket) continue;
      if (p.kind === 'RECEIPT') bucket.in = cents(bucket.in + num(p.amount));
      else bucket.out = cents(bucket.out + num(p.amount));
    }

    const actual = [...buckets.values()].map((b) => ({ ...b, net: cents(b.in - b.out) }));

    // Forecast: everything still owed, in or out, by when it falls due.
    const [openInvoices, openBills, openClaims, openAdvances, openRequests, uncleared] = await Promise.all([
      prisma.invoice.findMany({
        where: { status: { in: ['ISSUED', 'PARTIALLY_PAID'] } },
        select: { dueDate: true, netCollectible: true, amountCollected: true },
      }),
      prisma.supplierBill.findMany({
        where: { status: { in: ['APPROVED', 'PARTIALLY_PAID'] } },
        select: { dueDate: true, netPayable: true, amountPaid: true },
      }),
      prisma.expenseClaim.findMany({
        where: { status: 'APPROVED' },
        select: {
          claimDate: true,
          total: true,
          amountPaid: true,
          advance: { select: { amountReleased: true } },
          budgetRequest: { select: { amountReleased: true } },
        },
      }),
      prisma.cashAdvance.findMany({
        where: { status: { in: ['APPROVED', 'REFUND_DUE'] } },
        select: {
          status: true,
          amount: true,
          amountReleased: true,
          amountSpent: true,
          amountRefunded: true,
          requestDate: true,
          neededBy: true,
          liquidationDueDate: true,
        },
      }),
      // Project cash: the same two movements, on the budget request.
      prisma.budgetRequest.findMany({
        where: { status: { in: ['APPROVED', 'REFUND_DUE'] } },
        select: {
          status: true,
          amount: true,
          amountReleased: true,
          amountSpent: true,
          amountRefunded: true,
          createdAt: true,
          neededBy: true,
          liquidationDueDate: true,
        },
      }),
      prisma.payment.findMany({
        where: { clearedAt: null },
        select: { id: true, kind: true, amount: true, paymentDate: true, number: true, method: true },
      }),
    ]);

    const horizon = [
      { label: 'Overdue', from: Number.NEGATIVE_INFINITY, to: -1 },
      { label: 'Next 7 days', from: 0, to: 7 },
      { label: '8–30 days', from: 8, to: 30 },
      { label: '31–60 days', from: 31, to: 60 },
      { label: 'Beyond 60 days', from: 61, to: Number.POSITIVE_INFINITY },
    ];
    const forecast = horizon.map((h) => ({ label: h.label, in: 0, out: 0, net: 0 }));
    const place = (dueDate: Date, amount: number, direction: 'in' | 'out') => {
      if (amount <= 0.005) return;
      const days = daysBetween(to, dueDate);
      const i = horizon.findIndex((h) => days >= h.from && days <= h.to);
      if (i < 0) return;
      forecast[i][direction] = cents(forecast[i][direction] + amount);
    };

    for (const inv of openInvoices) {
      place(inv.dueDate, cents(num(inv.netCollectible) - num(inv.amountCollected)), 'in');
    }
    for (const bill of openBills) {
      place(bill.dueDate, cents(num(bill.netPayable) - num(bill.amountPaid)), 'out');
    }
    for (const claim of openClaims) {
      place(claim.claimDate, cents(claimPayable(claim) - num(claim.amountPaid)), 'out');
    }
    // An approved advance goes out when the person needs it; unspent cash
    // comes back by the liquidation deadline, or today if it has passed.
    let advancesToRelease = 0;
    let refundsDue = 0;
    for (const adv of openAdvances) {
      if (adv.status === 'APPROVED') {
        const out = cents(num(adv.amount) - num(adv.amountReleased));
        advancesToRelease = cents(advancesToRelease + out);
        place(adv.neededBy ?? adv.requestDate, out, 'out');
      } else {
        const back = cents(Math.max(0, num(adv.amountReleased) - num(adv.amountSpent)) - num(adv.amountRefunded));
        refundsDue = cents(refundsDue + back);
        place(adv.liquidationDueDate ?? to, back, 'in');
      }
    }
    let budgetRequestsToRelease = 0;
    for (const br of openRequests) {
      if (br.status === 'APPROVED') {
        const out = cents(num(br.amount) - num(br.amountReleased));
        budgetRequestsToRelease = cents(budgetRequestsToRelease + out);
        place(br.neededBy ?? dayKey(br.createdAt), out, 'out');
      } else {
        const back = cents(Math.max(0, num(br.amountReleased) - num(br.amountSpent)) - num(br.amountRefunded));
        refundsDue = cents(refundsDue + back);
        place(br.liquidationDueDate ?? to, back, 'in');
      }
    }
    for (const f of forecast) f.net = cents(f.in - f.out);

    res.json({
      months: actual,
      forecast,
      advancesToRelease,
      budgetRequestsToRelease,
      refundsDue,
      // Cheques written or received that have not cleared. Neither in the
      // actuals nor in the forecast, and worth seeing for exactly that reason.
      uncleared: uncleared.map((p) => ({ ...p, amount: num(p.amount) })),
      unclearedIn: cents(
        uncleared.filter((p) => p.kind === 'RECEIPT').reduce((s, p) => s + num(p.amount), 0),
      ),
      unclearedOut: cents(
        uncleared.filter((p) => p.kind === 'DISBURSEMENT').reduce((s, p) => s + num(p.amount), 0),
      ),
      netMovement: cents(actual.reduce((s, m) => s + m.net, 0)),
    });
  }),
);

/**
 * Budget vs actual, per job.
 *
 * Five columns that have to be read together: what was budgeted, what is
 * committed, what has been incurred, what has been billed, and what has been
 * collected. A job can be profitable on paper and still be the reason there is
 * no cash — that is what the last two columns are for.
 */
financeReportRoutes.get(
  '/budget-vs-actual',
  require_('gfin.budget_vs_actual.view_all'),
  handler(async (req, res) => {
    const where: Prisma.JobWhereInput = { status: { notIn: ['CANCELLED'] } };
    if (req.query.jobId) where.id = String(req.query.jobId);

    const jobs = await prisma.job.findMany({
      where,
      select: {
        id: true,
        number: true,
        name: true,
        status: true,
        contractValue: true,
        customer: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const jobIds = jobs.map((j) => j.id);
    if (!jobIds.length) {
      res.json({ jobs: [], totals: null });
      return;
    }

    const [ledger, billings, invoices] = await Promise.all([
      prisma.jobCostEntry.groupBy({
        by: ['jobId', 'state'],
        where: { jobId: { in: jobIds } },
        _sum: { amount: true },
      }),
      prisma.progressBilling.groupBy({
        by: ['jobId'],
        where: { jobId: { in: jobIds }, status: { in: ['APPROVED', 'INVOICED'] } },
        _sum: { grossAmount: true },
      }),
      prisma.invoice.groupBy({
        by: ['jobId'],
        where: { jobId: { in: jobIds }, status: { not: 'CANCELLED' } },
        _sum: { netCollectible: true, amountCollected: true },
      }),
    ]);

    const state = (jobId: string, s: string) =>
      num(ledger.find((l) => l.jobId === jobId && l.state === s)?._sum.amount);

    const rows = jobs.map((job) => {
      const contractValue = num(job.contractValue);
      const budgeted = state(job.id, 'BUDGETED');
      const committed = state(job.id, 'COMMITTED');
      const incurred = state(job.id, 'INCURRED');
      const consumed = state(job.id, 'CONSUMED');
      const billed = num(billings.find((b) => b.jobId === job.id)?._sum.grossAmount);
      const inv = invoices.find((i) => i.jobId === job.id);
      const invoiced = num(inv?._sum.netCollectible);
      const collected = num(inv?._sum.amountCollected);

      return {
        job: { id: job.id, number: job.number, name: job.name, status: job.status },
        customer: job.customer,
        contractValue,
        budgeted,
        committed,
        incurred,
        consumed,
        // Available = budgeted − committed − incurred. CONSUMED is reported
        // but never subtracted: it was already incurred when it was received.
        available: cents(budgeted - committed - incurred),
        billed,
        invoiced,
        collected,
        uncollected: cents(invoiced - collected),
        // Work done but not yet billed — the commonest reason a profitable job
        // runs out of cash.
        unbilled: cents(contractValue - billed),
        expectedProfit: cents(contractValue - budgeted),
        expectedMarginPct: contractValue > 0 ? cents(((contractValue - budgeted) / contractValue) * 100) : 0,
      };
    });

    const sum = (pick: (r: (typeof rows)[number]) => number) => cents(rows.reduce((s, r) => s + pick(r), 0));

    res.json({
      jobs: rows,
      totals: {
        contractValue: sum((r) => r.contractValue),
        budgeted: sum((r) => r.budgeted),
        committed: sum((r) => r.committed),
        incurred: sum((r) => r.incurred),
        available: sum((r) => r.available),
        billed: sum((r) => r.billed),
        invoiced: sum((r) => r.invoiced),
        collected: sum((r) => r.collected),
        uncollected: sum((r) => r.uncollected),
        unbilled: sum((r) => r.unbilled),
      },
    });
  }),
);

/** The executive view: one screen, the numbers a director asks for. */
financeReportRoutes.get(
  '/dashboard',
  require_('gfin.dashboard.view_all'),
  handler(async (_req, res) => {
    const today = dayKey(new Date());
    const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    const yearStart = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));

    // The position itself is decided in shared/finance.ts so that Insights'
    // company overview cannot print a different working position.
    const [
      position,
      receiptsThisMonth,
      receiptsThisYear,
      invoicedThisYear,
      uninvoicedBillings,
      unbilledReceivings,
      advancesAwaitingRelease,
      liquidationsOverdue,
      refundsAwaitingReceipt,
      activeJobs,
      budgetRequestsAwaitingRelease,
      budgetLiquidationsOverdue,
      budgetRefundsAwaitingReceipt,
    ] = await Promise.all([
      financePosition(today),
      // Customer receipts only. A person returning unspent advance money is
      // cash in, but it was never a collection.
      prisma.payment.aggregate({
        where: { kind: 'RECEIPT', customerId: { not: null }, ...LIVE_MONEY, clearedAt: { gte: monthStart } },
        _sum: { amount: true },
      }),
      prisma.payment.aggregate({
        where: { kind: 'RECEIPT', customerId: { not: null }, ...LIVE_MONEY, clearedAt: { gte: yearStart } },
        _sum: { amount: true },
      }),
      prisma.invoice.aggregate({
        where: { invoiceDate: { gte: yearStart }, status: { not: 'CANCELLED' } },
        _sum: { grossAmount: true },
      }),
      prisma.progressBilling.count({ where: { status: 'APPROVED', invoice: null } }),
      prisma.receiving.count({ where: { status: 'RECEIVED', orderId: { not: null }, bills: { none: {} } } }),
      prisma.cashAdvance.count({ where: { status: 'APPROVED' } }),
      prisma.cashAdvance.count({ where: { status: 'RELEASED', liquidationDueDate: { lt: today } } }),
      prisma.cashAdvance.count({ where: { status: 'REFUND_DUE' } }),
      prisma.job.count({ where: { status: { in: ['PLANNING', 'IN_PROGRESS'] } } }),
      prisma.budgetRequest.count({ where: { status: 'APPROVED' } }),
      prisma.budgetRequest.count({ where: { status: 'RELEASED', liquidationDueDate: { lt: today } } }),
      prisma.budgetRequest.count({ where: { status: 'REFUND_DUE' } }),
    ]);

    res.json({
      asOf: today,
      receivable: position.receivable,
      receivableOverdue: position.receivableOverdue,
      payable: position.payable,
      payableOverdue: position.payableOverdue,
      reimbursable: position.reimbursable,
      advancesInHand: position.advancesInHand,
      advancesToRelease: position.advancesToRelease,
      budgetRequestsInHand: position.budgetRequestsInHand,
      budgetRequestsToRelease: position.budgetRequestsToRelease,
      workingPosition: position.workingPosition,
      collectedThisMonth: cents(num(receiptsThisMonth._sum.amount)),
      collectedThisYear: cents(num(receiptsThisYear._sum.amount)),
      invoicedThisYear: cents(num(invoicedThisYear._sum.grossAmount)),
      withheldAwaitingCertificate: position.withheldAwaitingCertificate,
      queue: {
        billingsAwaitingInvoice: uninvoicedBillings,
        receivingsAwaitingBill: unbilledReceivings,
        advancesAwaitingRelease,
        liquidationsOverdue,
        refundsAwaitingReceipt,
        budgetRequestsAwaitingRelease,
        budgetLiquidationsOverdue,
        budgetRefundsAwaitingReceipt,
      },
      activeJobs,
    });
  }),
);

// ── Settings ─────────────────────────────────────────────────────────────────

export const financeSettingsRoutes = Router();
financeSettingsRoutes.use(authenticate);

financeSettingsRoutes.get(
  '/',
  // Either key of a pair (2026-10-18): the page keeps no record of anybody's,
  // and the A/R and A/P forms read its terms.
  requireAny(
    'gfin.settings.view_all',
    'gfin.settings.view_own',
    'gfin.ar.view_all',
    'gfin.ar.view_own',
    'gfin.ap.view_all',
    'gfin.ap.view_own',
  ),
  handler(async (_req, res) => {
    const [settings, rates] = await Promise.all([financeSettings(), currentRates()]);
    res.json({ ...settings, ...rates });
  }),
);

financeSettingsRoutes.put(
  '/',
  requireEdit('gfin', 'settings'),
  handler(async (req, res) => {
    const body = parseBody(
      z.object({
        defaultTermsDays: z.number().int().min(0).max(365).optional(),
        supplierEwtGoods: z.number().min(0).max(1).optional(),
        supplierEwtServices: z.number().min(0).max(1).optional(),
        agingBuckets: z.array(z.number().int().positive()).min(1).max(6).optional(),
        advanceLiquidationDays: z.number().int().min(1).max(365).optional(),
        blockAdvanceWhileUnliquidated: z.boolean().optional(),
        budgetRequestLiquidationDays: z.number().int().min(1).max(365).optional(),
      }),
      req.body,
    );

    if (body.agingBuckets) {
      const sorted = [...body.agingBuckets].sort((a, b) => a - b);
      if (sorted.join(',') !== body.agingBuckets.join(',')) {
        throw badRequest('Aging buckets must be in increasing order');
      }
    }

    const saved = await saveFinanceSettings(body);
    await audit(
      { entityType: 'setting', entityId: 'finance.rules', action: 'UPDATED', summary: 'Updated finance rules' },
      req,
    );
    res.json(saved);
  }),
);
