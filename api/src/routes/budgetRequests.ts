import { Router } from 'express';
import { z } from 'zod';
import { Prisma, RequestStatus, type ApprovalRequest } from '@prisma/client';
import { prisma } from '../prisma';
import { deleteAttachmentsOf } from '../shared/attachments';
import { handler, parseBody, listQuery, listResult, orderBy, idsFilter, notFound, badRequest, forbidden, deleteOrRefuse } from '../http/kit';
import { authenticate, require_, requireAny, requireAnyOrDecider, currentUser } from '../auth/middleware';
import { canEditRecord } from '../permissions/resolve';
import { audit } from '../shared/audit';
import { nextNumber } from '../shared/numbering';
import { notify } from '../shared/notifications';
import {
  cancelOpenRequest,
  mayDecide,
  onApprovalSettled,
  onApprovalReopened,
  routeBrief,
  submitForApproval,
  usersInRole,
  type ApprovalOutcome,
} from '../shared/approvals';
import { registerSearch } from '../shared/search';
import { renderDocument, formatMoney, formatAmount, formatQuantity, formatShortDate, statusLabel, companyCurrency, type PdfSection } from '../shared/pdf';
import { cents, D, num, dayKey, daysBetween } from '../shared/finance';
import { cashRequestSections, cashRequestSignatories } from './finance';
import { LIST_CAP, listReference, bracketed, totalLabel, bracketNote, listNotes, recordNamed, choice, sendListPdf } from '../shared/listPaper';
import { contentDisposition, paperFileName } from '../shared/paperName';
import { USER_TEAM_SELECT, teamOfUser, userTeamWhere, visibleOwners } from '../shared/team';
import { projectBudgetByLine } from './procurement';

/**
 * BUDGET REQUESTS — project cash (model §5.2, 2026-10-07, the owner's call).
 *
 * "It is not about changing the total budget allocated for the project; it is
 * about requesting cash so that the project team can purchase something
 * without the need for a purchase requisition." So a budget request is a sum
 * against a project and budget line: the project's manager allows it, finance
 * approves and releases it in one voucher, the team spends it, and whoever
 * asked accounts for it with receipts — an ExpenseClaim naming the request,
 * filed in Expenses. It used to raise the project's budget; it no longer does.
 *
 * It is NOT a cash advance. A cash advance is the company's term for a
 * personal loan to a person, with its own rules and its own liquidation days;
 * nothing here routes to it. The arithmetic is the same shape — released,
 * spent, refunded, re-derived by `refreshBudgetRequest()` in shared/finance.ts
 * from the payment allocations and the approved liquidation — but on the
 * project's money. Nothing reaches the project's ledger on approval or on
 * release: the liquidation posts INCURRED at what was actually spent.
 */

export const budgetRequestRoutes = Router();
budgetRequestRoutes.use(authenticate);

const requestInclude = {
  job: { select: { id: true, number: true, name: true, projectManager: { select: { id: true, name: true } } } },
  costCategory: { select: { id: true, name: true } },
  requestedBy: { select: { id: true, name: true, email: true, position: true, ...USER_TEAM_SELECT.select } },
  liquidations: {
    select: { id: true, number: true, status: true, total: true, amountPaid: true, claimDate: true, approvedAt: true },
    orderBy: { createdAt: 'desc' },
  },
  items: { orderBy: { sortOrder: 'asc' } },
} satisfies Prisma.BudgetRequestInclude;

type RequestRow = Prisma.BudgetRequestGetPayload<{ include: typeof requestInclude }>;

/** Statuses of a liquidation that still counts — everything but the two dead ends. */
const LIVE_LIQUIDATION = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SETTLED', 'REIMBURSED'] as const;

export function presentBudgetRequest(row: RequestRow, today = dayKey(new Date())) {
  const amount = num(row.amount);
  const released = num(row.amountReleased);
  const spent = num(row.amountSpent);
  const refunded = num(row.amountRefunded);
  const liquidated = !!row.liquidatedAt;
  const refundDue = liquidated ? cents(Math.max(0, released - spent)) : 0;
  const liquidation = row.liquidations.find((l) => (LIVE_LIQUIDATION as readonly string[]).includes(l.status)) ?? null;
  const { employee: _e, ...requester } = row.requestedBy;
  return {
    ...row,
    requestedBy: requester,
    /** The requester's team — the Team column. */
    team: teamOfUser(row.requestedBy),
    amount,
    amountReleased: released,
    amountSpent: spent,
    amountRefunded: refunded,
    /** What finance still has to hand over. Only an approved request is owed anything. */
    toRelease: row.status === 'APPROVED' ? cents(amount - released) : 0,
    spent,
    /** Spent beyond the cash released — owed to the person who filed the receipts, settled on the claim. */
    excessDue: liquidated ? cents(Math.max(0, spent - released)) : 0,
    /** Unspent cash owed back. Zero until a liquidation says what was spent. */
    refundDue,
    refundOutstanding: row.status === 'REFUND_DUE' ? cents(refundDue - refunded) : 0,
    /** Derived on read — a status that is only right when a job ran is worse than none. */
    liquidationOverdue:
      row.status === 'RELEASED' && !!row.liquidationDueDate && daysBetween(row.liquidationDueDate, today) > 0,
    daysToLiquidate:
      row.status === 'RELEASED' && row.liquidationDueDate ? -daysBetween(row.liquidationDueDate, today) : null,
    liquidation: liquidation ? { ...liquidation, total: num(liquidation.total), amountPaid: num(liquidation.amountPaid) } : null,
    liquidations: row.liquidations.map((l) => ({ ...l, total: num(l.total), amountPaid: num(l.amountPaid) })),
    items: row.items.map((i) => ({ ...i, quantity: num(i.quantity), unitCost: num(i.unitCost), amount: num(i.amount) })),
  };
}

type Me = ReturnType<typeof currentUser>;

/** Everyone's requests: the project side's view_all, or finance's. */
function seesAll(me: Me): boolean {
  return (
    me.isSuperAdmin ||
    me.permissions.has('gops.budget_requests.view_all') ||
    me.permissions.has('gfin.budget_requests.view_all') ||
    me.permissions.has('gfin.budget_liquidations.view_all')
  );
}

/**
 * A single request is readable by anyone who sees them all, by whoever raised
 * it, and by the project's manager — who is asked to decide it and must be
 * able to open what they decide.
 */
function assertCanSee(me: Me, row: { requestedById: string; job: { projectManager: { id: string } | null } }) {
  if (seesAll(me)) return;
  if (visibleOwners(me, 'gops', 'budget_requests').includes(row.requestedById)) return;
  if (row.job.projectManager?.id === me.id) return;
  throw forbidden('That is someone else’s budget request');
}

/** The list's where-builder — the project tab and the G-FIN screen read the same rows. */
export function budgetRequestListWhere(me: Me, q: ReturnType<typeof listQuery>, today = dayKey(new Date())) {
  const where: Prisma.BudgetRequestWhereInput = {};
  const mine = !seesAll(me) || q.scope === 'mine';
  // Who asked: the visibility rule and the `requestedById` filter are ANDed,
  // never one written over the other — so the filter can only narrow. A
  // requester who sees only their own, naming somebody else, gets nothing.
  const asked = q.filters.requestedById || undefined;
  const people: Prisma.BudgetRequestWhereInput[] = [];
  // View Team reads the team's requests (2026-10-19); "Mine" is one's own.
  if (q.scope === 'mine') people.push({ requestedById: me.id });
  else if (mine) people.push({ requestedById: { in: visibleOwners(me, 'gops', 'budget_requests') } });
  if (asked) people.push({ requestedById: asked });
  if (people.length) where.AND = people;
  if (q.filters.jobId) where.jobId = q.filters.jobId;
  const f = q.filters;
  const and: Prisma.BudgetRequestWhereInput[] = [];
  if (f.teamId) and.push({ requestedBy: userTeamWhere(f.teamId) });
  if (f.neededFrom || f.neededTo) {
    and.push({ neededBy: { ...(f.neededFrom ? { gte: asDate(f.neededFrom, 'Needed from') } : {}), ...(f.neededTo ? { lte: asDate(f.neededTo, 'Needed to') } : {}) } });
  }
  // The liquidation register: the requests whose cash went out — released,
  // owed back or liquidated (the owner's module 5).
  if (f.released === 'true') and.push({ status: { in: [...RELEASED_STATES] } });
  if (f.pending === 'true') and.push({ status: 'PENDING_APPROVAL' });
  if (f.approved === 'true') and.push({ status: { in: [...APPROVED_STATES] } });
  if (and.length) where.AND = [...((where.AND as Prisma.BudgetRequestWhereInput[] | undefined) ?? []), ...and];
  const status = choice(q.filters.status, RequestStatus, 'Status');
  if (status) where.status = status;
  // Overdue is not a status: released, past the deadline, no approved liquidation.
  if (q.filters.overdue === 'true') {
    where.status = 'RELEASED';
    where.liquidationDueDate = { lt: today };
  }
  if (q.search) {
    where.OR = [
      { number: { contains: q.search, mode: 'insensitive' } },
      { reason: { contains: q.search, mode: 'insensitive' } },
      { job: { name: { contains: q.search, mode: 'insensitive' } } },
      { job: { number: { contains: q.search, mode: 'insensitive' } } },
      { requestedBy: { name: { contains: q.search, mode: 'insensitive' } } },
    ];
  }
  // The rows ticked — ANDed with the visibility rule above, so a ticked id
  // never prints somebody else's request.
  const ids = idsFilter(q.filters.ids);
  if (ids) where.id = { in: ids };
  // The person the filter names is said on paper only where it is not the
  // caller already said as "requested by me".
  const person = asked && !(mine && asked === me.id) ? asked : undefined;
  return { where, mine, status, person };
}

/** Approved funds: approved, and every state after it. */
const APPROVED_STATES = ['APPROVED', 'RELEASED', 'REFUND_DUE', 'LIQUIDATED'] as const;
/** The cash went out. */
const RELEASED_STATES = ['RELEASED', 'REFUND_DUE', 'LIQUIDATED'] as const;

/**
 * The cards over both registers (the owner's modules 4 and 5), under the
 * list's own query: the sum of every request still standing (rejected and
 * cancelled left out), the approved funds, what waits on approval and what
 * finance has still to release; and for the liquidation view, released,
 * spent, returned and still owed back. Each a filter of the same list.
 */
async function budgetRequestListSummary(where: Prisma.BudgetRequestWhereInput) {
  const sum = (extra: Prisma.BudgetRequestWhereInput) =>
    prisma.budgetRequest.aggregate({
      where: { AND: [where, extra] },
      _count: { _all: true },
      _sum: { amount: true, amountReleased: true, amountSpent: true, amountRefunded: true },
    });
  const [all, approved, pending, toRelease, released, refundDue] = await Promise.all([
    sum({ status: { notIn: ['REJECTED', 'CANCELLED'] } }),
    sum({ status: { in: [...APPROVED_STATES] } }),
    sum({ status: 'PENDING_APPROVAL' }),
    sum({ status: 'APPROVED' }),
    sum({ status: { in: [...RELEASED_STATES] } }),
    sum({ status: 'REFUND_DUE' }),
  ]);
  const liquidated = await prisma.budgetRequest.aggregate({
    where: { AND: [where, { status: { in: [...RELEASED_STATES] }, liquidatedAt: { not: null } }] },
    _sum: { amountReleased: true, amountSpent: true },
  });
  // Unspent cash on a liquidated request: what was released and not spent.
  const unspent = Math.max(0, cents(num(liquidated._sum.amountReleased) - num(liquidated._sum.amountSpent)));
  return {
    total: num(all._sum.amount),
    count: all._count._all,
    approved: num(approved._sum.amount),
    approvedCount: approved._count._all,
    pending: num(pending._sum.amount),
    pendingCount: pending._count._all,
    toRelease: cents(num(toRelease._sum.amount) - num(toRelease._sum.amountReleased)),
    toReleaseCount: toRelease._count._all,
    released: num(released._sum.amountReleased),
    releasedCount: released._count._all,
    spent: num(liquidated._sum.amountSpent),
    returned: num(released._sum.amountRefunded),
    owedBack: cents(unspent - num(released._sum.amountRefunded)),
    refundDueCount: refundDue._count._all,
  };
}

const LIST_PERMISSIONS = ['gops.budget_requests.view_all', 'gops.budget_requests.view_own', 'gfin.budget_requests.view_all', 'gfin.budget_liquidations.view_all'];

const REQUEST_SORTS = ['number', 'amount', 'createdAt', 'neededBy', 'liquidationDueDate'];

budgetRequestRoutes.get(
  '/',
  requireAny(...LIST_PERMISSIONS),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const today = dayKey(new Date());
    const { where } = budgetRequestListWhere(me, q, today);
    const [rows, total] = await Promise.all([
      prisma.budgetRequest.findMany({
        where,
        include: requestInclude,
        orderBy: orderBy(q, REQUEST_SORTS, { createdAt: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.budgetRequest.count({ where }),
    ]);
    const after = await availableAfterFor(rows);
    res.json({
      ...listResult(rows.map((r) => ({ ...presentBudgetRequest(r, today), availableAfter: after.get(r.id) ?? null })), total, q),
      summary: await budgetRequestListSummary(where),
    });
  }),
);

/** A request that will never be released — listed, never summed. */
const REQUEST_CLOSED: RequestStatus[] = ['REJECTED', 'CANCELLED'];

/**
 * The budget requests on paper — the list as filtered (or the rows ticked),
 * through `budgetRequestListWhere`, the query the project tab and G-FIN's
 * register both read, so a requester who sees only their own prints only
 * their own. Asked, released and spent as the screen shows them, the
 * liquidation deadline with how late it is; the totals run over every request
 * the filter matched, a rejected or cancelled one in brackets and not
 * counted. Declared above `/:id`, or that route swallows it.
 */
budgetRequestRoutes.get(
  '/pdf',
  requireAny(...LIST_PERMISSIONS),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const today = dayKey(new Date());
    const { where, mine, status, person: personId } = budgetRequestListWhere(me, q, today);
    const [rows, count, sums, closed, currency, project, person] = await Promise.all([
      prisma.budgetRequest.findMany({
        where,
        include: {
          job: { select: { number: true, name: true } },
          costCategory: { select: { name: true } },
          requestedBy: { select: { name: true } },
        },
        orderBy: orderBy(q, REQUEST_SORTS, { createdAt: 'desc' }),
        take: LIST_CAP,
      }),
      prisma.budgetRequest.count({ where }),
      prisma.budgetRequest.aggregate({
        where: { AND: [where, { status: { notIn: REQUEST_CLOSED } }] },
        _sum: { amount: true, amountReleased: true, amountSpent: true },
      }),
      prisma.budgetRequest.count({ where: { AND: [where, { status: { in: REQUEST_CLOSED } }] } }),
      companyCurrency(),
      recordNamed('project', q.filters.jobId),
      recordNamed('person', personId, 'requested by'),
    ]);

    const f = q.filters;
    const reference = listReference(count, rows.length, ['budget request', 'budget requests'], [
      q.search && `search "${q.search}"`,
      f.overdue === 'true' ? 'liquidation overdue' : status && `status ${statusLabel(status)}`,
      project,
      person,
      mine && 'requested by me',
      f.ids && 'the rows selected',
    ]);

    // Nine columns: landscape (rule 6).
    const sections: PdfSection[] = [
      {
        kind: 'table',
        head: [
          'Number',
          'Project and budget line',
          'Requested by and purpose',
          'Raised',
          `Amount (${currency})`,
          `Released (${currency})`,
          `Spent (${currency})`,
          'Liquidate by',
          'Status',
        ],
        align: ['left', 'left', 'left', 'left', 'right', 'right', 'right', 'left', 'left'],
        rows: rows.map((r) => {
          const inSum = !REQUEST_CLOSED.includes(r.status);
          const late = r.status === 'RELEASED' && r.liquidationDueDate ? daysBetween(r.liquidationDueDate, today) : 0;
          return [
            r.number,
            { title: r.job.name, body: `${r.job.number} · ${r.costCategory.name}` },
            { title: r.requestedBy.name, body: r.reason },
            formatShortDate(r.createdAt),
            bracketed(formatAmount(num(r.amount)), inSum),
            num(r.amountReleased) > 0 ? formatAmount(num(r.amountReleased)) : '',
            r.liquidatedAt ? formatAmount(num(r.amountSpent)) : '',
            r.liquidationDueDate
              ? late > 0
                ? { title: formatShortDate(r.liquidationDueDate), body: `${late} day${late === 1 ? '' : 's'} overdue` }
                : formatShortDate(r.liquidationDueDate)
              : '',
            statusLabel(r.status),
          ];
        }),
      },
      {
        kind: 'totals',
        rows: [
          { label: 'Released', value: formatMoney(num(sums._sum.amountReleased), currency) },
          { label: 'Spent', value: formatMoney(num(sums._sum.amountSpent), currency) },
          { label: totalLabel('Requested', count, rows.length), value: formatMoney(num(sums._sum.amount), currency), bold: true },
        ],
      },
    ];
    sections.push(...listNotes([bracketNote(closed, ['rejected or cancelled request', 'rejected or cancelled requests'])]));

    const pdf = await renderDocument({ title: 'Budget Requests', date: new Date(), reference, landscape: true, sections });
    await audit(
      {
        entityType: 'budget_request',
        entityId: 'list',
        action: 'EXPORTED',
        summary: `Exported the budget request list as PDF (${rows.length} request(s))`,
      },
      req,
    );
    sendListPdf(res, pdf, 'budget-requests.pdf');
  }),
);

/**
 * The projects a budget request may be raised against — G-FIN's "+ Add
 * budget request" (the owner's call: a request always names a project; an
 * operations budget is a project of its own). Running ones, numbers and
 * names only, behind the create right. Above `/:id`.
 */
budgetRequestRoutes.get(
  '/projects',
  require_('gops.budget_requests.create'),
  handler(async (_req, res) => {
    res.json(
      await prisma.job.findMany({
        where: { status: { notIn: ['CANCELLED', 'COMPLETED', 'TURNED_OVER'] } },
        select: { id: true, number: true, name: true },
        orderBy: { number: 'desc' },
        take: 500,
      }),
    );
  }),
);

const REQUEST_WRITERS = ['gops.budget_requests.create', 'gops.budget_requests.edit_own', 'gops.budget_requests.edit_all'];

/**
 * The project's budget by budget line for the request page's live panel —
 * `projectBudgetByLine()`, the purchase requisition's own figures. A budget
 * request commits nothing (project cash reaches the ledger only when it is
 * liquidated), so the panel shows what is left beside what is asked.
 */
budgetRequestRoutes.get(
  '/budget',
  requireAny(...REQUEST_WRITERS),
  handler(async (req, res) => {
    const jobId = String(req.query.jobId ?? '');
    if (!jobId) throw badRequest('Name the project');
    const job = await prisma.job.findUnique({ where: { id: jobId }, select: { id: true, number: true, name: true } });
    if (!job) throw notFound('Project not found');
    res.json({ job, ...(await projectBudgetByLine(jobId)) });
  }),
);

/** "Submit for approval sends it to …" — at the amount on the page, in the requester's name. Above `/:id`. */
budgetRequestRoutes.get(
  '/route',
  requireAny(...REQUEST_WRITERS),
  handler(async (req, res) => {
    const me = currentUser(req);
    const amount = Number(req.query.amount ?? 0);
    if (!Number.isFinite(amount) || amount < 0) throw badRequest('The amount is not a number');
    const requestId = req.query.requestId ? String(req.query.requestId) : null;
    const row = requestId ? await prisma.budgetRequest.findUnique({ where: { id: requestId }, select: { requestedById: true, jobId: true } }) : null;
    if (requestId && !row) throw notFound('Budget request not found');
    const jobId = row?.jobId ?? (req.query.jobId ? String(req.query.jobId) : null);
    res.json({ route: await routeBrief('budget_request', amount, row?.requestedById ?? me.id, null, { jobId }) });
  }),
);

/**
 * "Against the project budget" (2026-10-23, the owner's call: "Budget Request
 * should reflect subtraction so finance or other who will approve know where
 * the budget allocated"): the request's budget line as it stands —
 * `projectBudgetByLine()`, Budget Monitoring's own figures — with the
 * request's OWN released commitment left out, then this request and what is
 * left after it. Before release the request commits nothing, so it is the
 * amount asked; released, the cash still out (released less refunded);
 * liquidated, rejected or cancelled it takes nothing more (`settled`), the
 * line shown as it stands. Every other budget line is sent too, so finance
 * sees where the rest of the money sits.
 */
export async function requestBudget(row: { id: string; jobId: string; costCategoryId: string; status: RequestStatus; amount: Prisma.Decimal; amountReleased: Prisma.Decimal; amountRefunded: Prisma.Decimal }) {
  const { lines, total } = await projectBudgetByLine(row.jobId, { exclude: { sourceType: 'budget_request', sourceId: row.id } });
  const settled = ['LIQUIDATED', 'REJECTED', 'CANCELLED'].includes(row.status);
  const out = ['RELEASED', 'REFUND_DUE'].includes(row.status);
  const thisRequest = settled ? 0 : out ? cents(Math.max(0, num(row.amountReleased) - num(row.amountRefunded))) : num(row.amount);
  const line = lines.find((l) => l.id === row.costCategoryId) ?? null;
  const before = line?.available ?? 0;
  const after = cents(before - thisRequest);
  return {
    line,
    lines,
    total,
    availableBefore: before,
    thisRequest,
    availableAfter: after,
    over: after < 0,
    overBy: after < 0 ? cents(-after) : 0,
    settled,
    /** What the figure "This request" means at this status. */
    basis: settled ? 'settled' : out ? 'released' : 'asked',
  };
}

/**
 * The register's "Available after" column for one page of requests —
 * `requestBudget()`'s rule in two queries whatever the page's length: the
 * ledger of every project on the page, and the page's own commitments.
 * Null for a request that takes nothing more (liquidated, rejected,
 * cancelled).
 */
async function availableAfterFor(rows: Parameters<typeof requestBudget>[0][]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  const open = rows.filter((r) => !['LIQUIDATED', 'REJECTED', 'CANCELLED'].includes(r.status));
  for (const r of rows) out.set(r.id, null);
  if (!open.length) return out;
  const [ledger, own] = await Promise.all([
    prisma.jobCostEntry.groupBy({
      by: ['jobId', 'costCategoryId', 'state'],
      where: { jobId: { in: [...new Set(open.map((r) => r.jobId))] }, state: { in: ['BUDGETED', 'COMMITTED', 'INCURRED'] } },
      _sum: { amount: true },
    }),
    prisma.jobCostEntry.groupBy({
      by: ['sourceId', 'costCategoryId', 'state'],
      where: { sourceType: 'budget_request', sourceId: { in: open.map((r) => r.id) }, state: { in: ['COMMITTED', 'INCURRED'] } },
      _sum: { amount: true },
    }),
  ]);
  for (const r of open) {
    const of = (state: string) =>
      ledger.filter((l) => l.jobId === r.jobId && l.costCategoryId === r.costCategoryId && l.state === state).reduce((s, l) => s + num(l._sum.amount), 0) -
      own.filter((o) => o.sourceId === r.id && o.costCategoryId === r.costCategoryId && o.state === state).reduce((s, o) => s + num(o._sum.amount), 0);
    const before = of('BUDGETED') - of('COMMITTED') - of('INCURRED');
    const out_ = ['RELEASED', 'REFUND_DUE'].includes(r.status);
    const take = out_ ? Math.max(0, num(r.amountReleased) - num(r.amountRefunded)) : num(r.amount);
    out.set(r.id, cents(before - take));
  }
  return out;
}

/**
 * "Against the project budget" on paper: the project's budget lines as
 * Budget Monitoring has them (this request's own commitment left out), the
 * request's line marked, then the subtraction as a totals block.
 */
function budgetSections(b: Awaited<ReturnType<typeof requestBudget>>, lineName: string, currency: string): PdfSection[] {
  const shown = b.lines.filter((l) => l.id === b.line?.id || l.budgeted || l.committed || l.incurred);
  const words = b.basis === 'released' ? 'This request (cash still out)' : 'This request';
  return [
    {
      kind: 'table',
      title: 'Against the project budget',
      head: ['Budget line', `Budgeted (${currency})`, `Committed (${currency})`, `Spent (${currency})`, `Available (${currency})`],
      align: ['left', 'right', 'right', 'right', 'right'],
      rows: shown.map((l) => [
        l.id === b.line?.id ? { title: `${l.name} — this request's line` } : l.name,
        formatAmount(l.budgeted),
        formatAmount(l.committed),
        formatAmount(l.incurred),
        formatAmount(l.available),
      ]),
    },
    {
      kind: 'totals',
      rows: b.settled
        ? [{ label: `${lineName} — available now`, value: formatMoney(b.availableBefore, currency), bold: true }]
        : [
            { label: `${lineName} — available before`, value: formatMoney(b.availableBefore, currency) },
            { label: `Less: ${words.toLowerCase()}`, value: formatMoney(b.thisRequest, currency) },
            { label: b.over ? 'Over the budget line by' : 'Available after', value: formatMoney(b.over ? b.overBy : b.availableAfter, currency), bold: true },
          ],
    },
  ];
}

async function loadRequest(id: string) {
  return prisma.budgetRequest.findUnique({
    where: { id },
    include: {
      ...requestInclude,
      allocations: {
        include: {
          payment: {
            select: { id: true, number: true, kind: true, paymentDate: true, method: true, reference: true, clearedAt: true },
          },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
}

/**
 * Who may open one request: the register's readers (`assertCanSee`), or —
 * through `requireAnyOrDecider` — whoever may decide its open approval
 * request, while it waits on them (a Back Support or Team Leader with no
 * right to the register reads what they are asked to decide).
 */
async function assertCanOpen(me: Me, row: Parameters<typeof assertCanSee>[1] & { id: string }, deciderOnly: boolean) {
  if (!deciderOnly) {
    try {
      assertCanSee(me, row);
      return;
    } catch (err) {
      if (!(await mayDecide(me.id, 'budget_request', [row.id]))) throw err;
      return;
    }
  }
  if (!(await mayDecide(me.id, 'budget_request', [row.id]))) throw forbidden('That is someone else’s budget request');
}

budgetRequestRoutes.get(
  '/:id',
  requireAnyOrDecider(...LIST_PERMISSIONS),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await loadRequest(req.params.id);
    if (!row) throw notFound('Budget request not found');
    await assertCanOpen(me, row, !!res.locals.deciderOnly);
    // The route a draft WOULD take — the team leader, back support, the finance
    // manager (and the CEO / President above ₱100,000) —
    // named before anybody presses Submit (names only).
    const approvalRoute =
      row.status === 'DRAFT' ? await routeBrief('budget_request', num(row.amount), row.requestedById, null, { jobId: row.jobId }) : null;
    res.json({
      ...presentBudgetRequest(row),
      allocations: row.allocations.map((a) => ({ ...a, amount: num(a.amount) })),
      canEdit: row.status === 'DRAFT' && canEditRecord(me, 'gops', 'budget_requests', row.requestedById),
      approvalRoute,
      budget: await requestBudget(row),
    });
  }),
);

const itemSchema = z.object({
  name: z.string().trim().min(1, 'Say what the line buys').max(300),
  description: z.string().trim().max(2000).optional().nullable(),
  quantity: z.number().positive('A line’s quantity must be more than zero'),
  unit: z.string().trim().max(40).optional().nullable(),
  unitCost: z.number().min(0, 'A unit cost cannot be negative'),
});

const requestSchema = z.object({
  jobId: z.string().min(1, 'Which project?'),
  costCategoryId: z.string().min(1, 'Which budget line?'),
  /** Typed when there is no breakdown; with `items`, their sum and nothing else. */
  amount: z.number().optional(),
  reason: z.string().trim().min(3, 'What is the cash for?'),
  neededBy: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  /** The breakdown (2026-10-19). Sent, it replaces the request's lines whole. */
  items: z.array(itemSchema).max(200).optional(),
});

type RequestBody = z.infer<typeof requestSchema>;

/**
 * The lines as stored and the amount they make: each line's amount is
 * quantity (3 dp) × unit cost rounded to the centavo — the purchase
 * requisition's `cents()` rule — and the request is their sum. With no lines
 * the typed amount stands.
 */
/**
 * A line's amount in exact integers: quantity in thousandths × unit cost in
 * centavos ÷ 1000, half away from zero — never a float multiplied and stored
 * (rule 10). The page's `requestLineAmount()` is the same rule.
 */
export function requestLineAmount(quantity: number, unitCost: number): number {
  const milli = BigInt(Math.round(quantity * 1000));
  const centavos = BigInt(Math.round(unitCost * 100));
  const product = milli * centavos;
  const sign = product < 0n ? -1n : 1n;
  const rounded = ((product * sign + 500n) / 1000n) * sign;
  return Number(rounded) / 100;
}

function moneyOf(body: RequestBody) {
  const lines = (body.items ?? []).map((i, n) => ({
    sortOrder: n,
    name: i.name,
    description: i.description?.trim() || null,
    quantity: D(Math.round(i.quantity * 1000) / 1000),
    unit: i.unit?.trim() || 'pcs',
    unitCost: D(Math.round(i.unitCost * 100) / 100),
    amount: D(requestLineAmount(i.quantity, i.unitCost)),
  }));
  const amount = lines.length ? cents(lines.reduce((s, l) => s + num(l.amount), 0)) : cents(body.amount ?? 0);
  if (!(amount > 0)) throw badRequest(lines.length ? 'The lines add up to nothing — give them a unit cost' : 'A budget request must be for more than zero');
  return { lines, amount };
}

function asDate(value: string, label: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw badRequest(`${label} is not a valid date`);
  return dayKey(date);
}

/** The project must exist and still be running, and the budget line must be one of its lines. */
async function checkCharging(body: { jobId: string; costCategoryId: string }) {
  const job = await prisma.job.findUnique({ where: { id: body.jobId }, select: { id: true, number: true, status: true } });
  if (!job) throw notFound('Project not found');
  if (job.status === 'CANCELLED') throw badRequest(`${job.number} is cancelled — nothing can be requested against it`);
  const category = await prisma.costCategory.findUnique({ where: { id: body.costCategoryId }, select: { id: true } });
  if (!category) throw notFound('Budget line not found');
  return job;
}

budgetRequestRoutes.post(
  '/',
  require_('gops.budget_requests.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(requestSchema, req.body);
    const job = await checkCharging(body);
    const { lines, amount } = moneyOf(body);

    const request = await prisma.$transaction(async (tx) => {
      const number = await nextNumber('budget_request', tx);
      return tx.budgetRequest.create({
        data: {
          number,
          jobId: body.jobId,
          costCategoryId: body.costCategoryId,
          amount: D(amount),
          items: { create: lines },
          reason: body.reason,
          neededBy: body.neededBy ? asDate(body.neededBy, 'Needed by') : null,
          notes: body.notes || null,
          requestedById: me.id,
        },
        include: requestInclude,
      });
    });

    await audit(
      {
        entityType: 'budget_request',
        entityId: request.id,
        action: 'CREATED',
        summary: `Raised ${request.number} — ${amount} for ${job.number}: ${body.reason}${lines.length ? ` (${lines.length} line${lines.length === 1 ? '' : 's'})` : ''}`,
      },
      req,
    );
    res.status(201).json(presentBudgetRequest(request));
  }),
);

budgetRequestRoutes.put(
  '/:id',
  requireAny('gops.budget_requests.edit_own', 'gops.budget_requests.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(requestSchema, req.body);
    const existing = await prisma.budgetRequest.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('Budget request not found');
    if (!canEditRecord(me, 'gops', 'budget_requests', existing.requestedById)) {
      throw forbidden('Only the person who raised this request can change it');
    }
    if (existing.status !== 'DRAFT') throw badRequest('Only a draft can be changed — this one has been submitted');
    if (body.jobId !== existing.jobId) throw badRequest('A budget request stays on the project it was raised for — raise another');
    await checkCharging(body);
    // Lines sent replace the breakdown whole; none sent keeps it, with the
    // amount still their sum (a typed amount counts only with no lines).
    const kept = body.items ? null : await prisma.budgetRequestItem.findMany({ where: { requestId: existing.id }, orderBy: { sortOrder: 'asc' } });
    const { lines, amount } = kept?.length
      ? { lines: null, amount: cents(kept.reduce((s, l) => s + num(l.amount), 0)) }
      : moneyOf(body);

    const request = await prisma.$transaction(async (tx) => {
      // Claimed on DRAFT: a submit that landed first wins.
      const claimed = await tx.budgetRequest.updateMany({
        where: { id: existing.id, status: 'DRAFT' },
        data: {
          costCategoryId: body.costCategoryId,
          amount: D(amount),
          reason: body.reason,
          neededBy: body.neededBy ? asDate(body.neededBy, 'Needed by') : null,
          notes: body.notes || null,
        },
      });
      if (!claimed.count) throw badRequest('This request moved a moment ago — reload to see where it stands');
      if (lines) {
        await tx.budgetRequestItem.deleteMany({ where: { requestId: existing.id } });
        if (lines.length) await tx.budgetRequestItem.createMany({ data: lines.map((l) => ({ ...l, requestId: existing.id })) });
      }
      return tx.budgetRequest.findUniqueOrThrow({ where: { id: existing.id }, include: requestInclude });
    });
    await audit({ entityType: 'budget_request', entityId: request.id, action: 'UPDATED', summary: `${request.number} changed` }, req);
    res.json(presentBudgetRequest(request));
  }),
);

/**
 * Submitting. The project's manager first, then finance — the seeded
 * workflow, with the project passed as the request's context so the
 * PROJECT_MANAGER step can resolve it. Nothing is committed to the project:
 * an approved request is cash promised to the team, not cost promised to the
 * project. The project hears about it when the liquidation posts.
 */
budgetRequestRoutes.post(
  '/:id/submit',
  require_('gops.budget_requests.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const request = await prisma.budgetRequest.findUnique({
      where: { id: req.params.id },
      include: { job: { select: { number: true } }, costCategory: { select: { name: true } } },
    });
    if (!request) throw notFound('Budget request not found');
    if (request.requestedById !== me.id && !me.isSuperAdmin) throw forbidden('Only the requester can submit this');
    if (request.status !== 'DRAFT') throw badRequest('This request has already been submitted');

    // Claimed, never simply written: two Submit clicks file once.
    const claimed = await prisma.budgetRequest.updateMany({ where: { id: request.id, status: 'DRAFT' }, data: { status: 'PENDING_APPROVAL' } });
    if (!claimed.count) throw badRequest('This request moved a moment ago — reload to see where it stands');
    // The approvers' bell and queue say what the request takes from its
    // budget line, as it stood at submit (the page has the live figures).
    const budget = await requestBudget(request);
    const currency = await companyCurrency();
    const position = budget.over
      ? `${formatMoney(budget.availableBefore, currency)} available, over by ${formatMoney(budget.overBy, currency)}`
      : `${formatMoney(budget.availableBefore, currency)} available → ${formatMoney(budget.availableAfter, currency)} left`;
    try {
      await submitForApproval({
        documentType: 'budget_request',
        documentId: request.id,
        documentNumber: request.number,
        subject: `${request.job.number} — ${request.costCategory.name}: ${request.reason} (${request.costCategory.name}: ${position})`,
        amount: num(request.amount),
        link: `/g-ops/budget-requests/${request.id}`,
        // The requester, even when a super admin presses the button: the
        // self-approval rule, and the PROJECT_MANAGER step, have to see whose
        // request this is.
        requesterId: request.requestedById,
        jobId: request.jobId,
      });
    } catch (err) {
      // The engine refused (no workflow, a self-approval trap, nobody to
      // approve). Back to a draft, never pending with no request behind it.
      await prisma.budgetRequest.updateMany({ where: { id: request.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
      throw err;
    }

    await audit({ entityType: 'budget_request', entityId: request.id, action: 'SUBMITTED', summary: `${request.number} sent for approval` }, req);
    res.json({ ok: true, status: 'PENDING_APPROVAL' });
  }),
);

/**
 * Approval moves no money and changes no budget. APPROVED means finance may
 * now release the cash; the release is a disbursement allocated to the
 * request, and the status moves to RELEASED when `refreshBudgetRequest()`
 * sees it. Guarded on PENDING_APPROVAL, so a decision that lands after a
 * cancel changes nothing and the trail says so. Exported so a test can call
 * it twice — the guard is what makes the second call a no-op.
 */
export const settleBudgetRequest = async (approval: ApprovalRequest, outcome: ApprovalOutcome) => {
  const request = await prisma.budgetRequest.findUnique({
    where: { id: approval.documentId },
    include: { requestedBy: { select: { name: true } }, job: { select: { number: true } } },
  });
  if (!request) return;
  const claimed = await prisma.budgetRequest.updateMany({
    where: { id: request.id, status: 'PENDING_APPROVAL' },
    data: outcome === 'APPROVED' ? { status: 'APPROVED', approvedAt: new Date() } : { status: 'REJECTED' },
  });
  if (!claimed.count) {
    await audit({
      entityType: 'budget_request',
      entityId: request.id,
      action: outcome,
      summary: `${request.number} ${outcome.toLowerCase()} after it was ${request.status.toLowerCase().replace(/_/g, ' ')} — not applied`,
    });
    return;
  }

  if (outcome !== 'APPROVED') {
    await audit({ entityType: 'budget_request', entityId: request.id, action: 'REJECTED', summary: `${request.number} rejected — nothing released` });
    return;
  }

  // The engine already tells the requester (approval.approved). Finance is
  // told it is theirs to release: the G-FIN Budget Requests screen lists it
  // under "awaiting release", and this is the bell that sends them there.
  const finance = await usersInRole('finance');
  await notify(
    finance.map((userId) => ({
      userId,
      type: 'system' as const,
      title: `${request.number} approved — ${formatMoney(num(request.amount))} to release for ${request.job.number}`,
      body: `${request.requestedBy.name}: ${request.reason}`,
      link: `/g-ops/budget-requests/${request.id}`,
    })),
  );
  await audit({
    entityType: 'budget_request',
    entityId: request.id,
    action: 'APPROVED',
    summary: `${request.number} approved — ${num(request.amount)} to release to ${request.requestedBy.name} for ${request.job.number}; nothing charged until liquidated`,
  });
};
onApprovalSettled('budget_request', settleBudgetRequest);

/**
 * Pulled back after approval (2026-10-16): back to DRAFT while finance has
 * released nothing. Approval moved no money and charged nothing, so there is
 * nothing to undo — only refused once cash has gone out on it.
 */
onApprovalReopened('budget_request', {
  may: async (actor, id) => {
    const row = await prisma.budgetRequest.findUnique({ where: { id }, select: { status: true, requestedById: true } });
    return !!row && !['DRAFT', 'PENDING_APPROVAL', 'REJECTED', 'CANCELLED'].includes(row.status) && canEditRecord(actor, 'gops', 'budget_requests', row.requestedById);
  },
  reopen: async ({ documentId, tx, actor }) => {
    const row = await tx.budgetRequest.findUnique({ where: { id: documentId } });
    if (!row) throw badRequest('Not found');
    const paid = await tx.paymentAllocation.findFirst({ where: { budgetRequestId: row.id }, include: { payment: { select: { number: true } } } });
    if (paid || row.status !== 'APPROVED') {
      throw badRequest(`${row.number} has been released${paid ? ` (${paid.payment.number})` : ''} — remove the release before pulling it back`);
    }
    const claimed = await tx.budgetRequest.updateMany({ where: { id: row.id, status: 'APPROVED' }, data: { status: 'DRAFT', approvedAt: null } });
    if (!claimed.count) throw badRequest(`${row.number} changed a moment ago — reload to see where it stands`);
    await audit(
      { entityType: 'budget_request', entityId: row.id, action: 'UPDATED', summary: `${row.number} back to draft after approval — nothing had been released`, actorId: actor.id, actorName: actor.name },
      undefined,
      tx,
    );
  },
});

budgetRequestRoutes.post(
  '/:id/cancel',
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(z.object({ reason: z.string().trim().optional().nullable() }), req.body ?? {});
    const request = await prisma.budgetRequest.findUnique({ where: { id: req.params.id } });
    if (!request) throw notFound('Budget request not found');

    const mine = request.requestedById === me.id;
    const editAll = me.isSuperAdmin || me.permissions.has('gops.budget_requests.edit_all');
    if (request.status === 'DRAFT' || request.status === 'PENDING_APPROVAL') {
      if (!mine && !editAll) throw forbidden('That is someone else’s budget request');
    } else if (request.status === 'APPROVED' && num(request.amountReleased) <= 0.005) {
      if (!mine && !editAll) throw forbidden('That is someone else’s budget request');
    } else if (request.status === 'CANCELLED' || request.status === 'REJECTED') {
      throw badRequest(`This request is already ${request.status.toLowerCase()}`);
    } else {
      throw badRequest('The cash has been released — liquidate it instead');
    }

    await prisma.$transaction(async (tx) => {
      const claimed = await tx.budgetRequest.updateMany({
        where: { id: request.id, status: request.status },
        data: { status: 'CANCELLED', cancelReason: body.reason || null },
      });
      if (!claimed.count) throw badRequest('This request moved a moment ago — reload to see where it stands');
      // Still with an approver: withdrawn through the engine, so it leaves
      // their queue and they are told.
      await cancelOpenRequest('budget_request', request.id, tx, `cancelled by ${me.name}${body.reason ? `: ${body.reason}` : ''}`, me.id);
    });
    await audit(
      { entityType: 'budget_request', entityId: request.id, action: 'CANCELLED', summary: `${request.number} cancelled${body.reason ? ` — ${body.reason}` : ''}` },
      req,
    );
    res.json({ ok: true });
  }),
);

budgetRequestRoutes.delete(
  '/:id',
  require_('gops.budget_requests.delete'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const request = await prisma.budgetRequest.findUnique({ where: { id: req.params.id } });
    if (!request) throw notFound('Budget request not found');
    if (!canEditRecord(me, 'gops', 'budget_requests', request.requestedById)) throw forbidden('That is someone else’s budget request');
    if (request.status !== 'DRAFT' && request.status !== 'CANCELLED') {
      throw badRequest('Only a draft or a cancelled budget request can be deleted — cancel it first');
    }
    // A cancelled request never moved money (cancel comes before release), but
    // a payment row pointing at it would be a fact on file: refused, not lost.
    if (await prisma.paymentAllocation.count({ where: { budgetRequestId: request.id } })) {
      throw badRequest('Money was released or returned on this request — it is kept');
    }
    await deleteOrRefuse(request.number, () => prisma.budgetRequest.delete({ where: { id: request.id } }));
    await deleteAttachmentsOf('budget_request', [request.id]);
    await audit(
      { entityType: 'budget_request', entityId: request.id, action: 'DELETED', summary: `Deleted ${request.status === 'DRAFT' ? 'draft' : 'cancelled'} ${request.number}`, before: request },
      req,
    );
    res.json({ ok: true });
  }),
);

/**
 * The request on paper — the same document as a cash advance, through the
 * same builders (`cashRequestSections` / `cashRequestSignatories`): the
 * request, its money as a totals block, the liquidation, and every step of
 * its route by the step's own name — the team leader, back support, the
 * finance manager — with who received the cash once it is out.
 */
budgetRequestRoutes.get(
  '/:id/pdf',
  requireAnyOrDecider(...LIST_PERMISSIONS),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await loadRequest(req.params.id);
    if (!row) throw notFound('Budget request not found');
    await assertCanOpen(me, row, !!res.locals.deciderOnly);
    const view = presentBudgetRequest(row);

    const release = row.allocations.find((a) => a.payment.kind === 'DISBURSEMENT');
    const sections = cashRequestSections({
      requestedBy: row.requestedBy.name,
      neededBy: row.neededBy,
      project: `${row.job.number} — ${row.job.name}`,
      budgetLine: row.costCategory.name,
      status: row.status,
      purpose: row.reason,
      release: release ? release.payment : null,
      liquidationDueDate: row.liquidationDueDate,
      liquidated: !!row.liquidatedAt,
      figures: view,
      liquidation: view.liquidation,
      notes: row.notes,
      currency: await companyCurrency(),
    });
    if (row.items.length) {
      const currency = await companyCurrency();
      // The breakdown under the request's details, before its money.
      sections.splice(1, 0, {
        kind: 'table',
        title: 'Breakdown',
        head: ['#', 'Item and description', 'Qty', 'Unit', `Unit cost (${currency})`, `Amount (${currency})`],
        align: ['left', 'left', 'right', 'left', 'right', 'right'],
        rows: row.items.map((i, n) => [
          String(n + 1),
          i.description ? { title: i.name, body: i.description } : i.name,
          formatQuantity(num(i.quantity)),
          i.unit,
          formatAmount(num(i.unitCost)),
          formatAmount(num(i.amount)),
        ]),
      });
    }
    if (row.cancelReason) sections.push({ kind: 'text', title: 'Cancelled', body: row.cancelReason });
    sections.push(...budgetSections(await requestBudget(row), row.costCategory.name, await companyCurrency()));

    const pdf = await renderDocument({
      title: 'Budget Request',
      documentNumber: row.number,
      date: row.createdAt,
      reference: `${row.job.number} — ${row.reason}`,
      sections,
      signatories: await cashRequestSignatories({
        documentType: 'budget_request',
        id: row.id,
        status: row.status,
        amount: view.amount,
        requester: row.requestedBy,
        // The project the submit names, for its PROJECT_MANAGER step.
        jobId: row.jobId,
        raisedAt: row.createdAt,
        releasedOn: release?.createdAt ?? null,
      }),
    });

    await audit({ entityType: 'budget_request', entityId: row.id, action: 'EXPORTED', summary: `Printed ${row.number}` }, req);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition(paperFileName({ kind: 'Budget Request', number: row.number, author: row.requestedBy.name, date: row.createdAt })));
    res.send(pdf);
  }),
);

registerSearch({
  kind: 'budget_request',
  label: 'Budget requests',
  permission: LIST_PERMISSIONS,
  ownWhere: (user) => ({ requestedById: user.id }),
  async search(term, _user, limit, own) {
    const rows = await prisma.budgetRequest.findMany({
      where: {
        ...(own ?? {}),
        OR: [
          { number: { contains: term, mode: 'insensitive' } },
          { reason: { contains: term, mode: 'insensitive' } },
          { job: { number: { contains: term, mode: 'insensitive' } } },
          { requestedBy: { name: { contains: term, mode: 'insensitive' } } },
        ],
      },
      select: { id: true, number: true, reason: true, status: true, job: { select: { number: true } }, requestedBy: { select: { name: true } } },
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      kind: 'budget_request',
      id: r.id,
      title: `${r.number} — ${r.reason}`,
      subtitle: `${r.job.number} · ${r.requestedBy.name} · ${r.status.toLowerCase().replace(/_/g, ' ')}`,
      link: `/g-ops/budget-requests/${r.id}`,
    }));
  },
});
