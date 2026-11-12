import { Router } from 'express';
import { z } from 'zod';
import { Prisma, RequestStatus, type ApprovalRequest } from '@prisma/client';
import { prisma } from '../prisma';
import { deleteAttachmentsOf, registerAttachmentGuard } from '../shared/attachments';
import { attachedFiles, withAttachments } from '../shared/pdfAttachments';
import { handler, parseBody, listQuery, listResult, orderBy, idsFilter, notFound, badRequest, forbidden, deleteOrRefuse, assertMayDelete } from '../http/kit';
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
import { cents, D, num, dayKey, daysBetween, refreshBudgetRequest } from '../shared/finance';
import { cashRequestSections, cashRequestSignatories, budgetSections as chargeSections } from './finance';
import { officeBudgetPosition, officePosition, requestOffice } from '../shared/officeBudget';
import { OFFICE_LINE_SELECT } from '../shared/officeBudget';
import { NO_CHARGE, checkLineCharges, collapse, jobIdsOf, type LineCharge } from '../shared/lineCharges';
import { cardsPosition, requestCards } from '../shared/chargeCards';
import { LIST_CAP, listReference, bracketed, totalLabel, bracketNote, listNotes, recordNamed, choice, sendListPdf } from '../shared/listPaper';
import { contentDisposition, paperFileName } from '../shared/paperName';
import { USER_TEAM_SELECT, teamOfUser, userTeamWhere, visibleOwners } from '../shared/team';
import { projectBudgetByLine } from '../shared/projectBudget';
import {
  SOURCE_INCLUDE,
  checkSource,
  raisedOn,
  recordBudget,
  sourceFilter,
  sourceOf,
  sourceSearch,
  type RequestSource,
  type SourceKind,
} from '../shared/budgetRequestSources';

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
  ...SOURCE_INCLUDE,
  costCategory: { select: { id: true, name: true } },
  requestedBy: { select: { id: true, name: true, email: true, position: true, ...USER_TEAM_SELECT.select } },
  liquidations: {
    select: { id: true, number: true, status: true, total: true, amountPaid: true, claimDate: true, approvedAt: true },
    orderBy: { createdAt: 'desc' },
  },
  // Each item's own place, on a request charged item by item (2026-11-11).
  items: {
    orderBy: { sortOrder: 'asc' },
    include: { job: { select: { id: true, number: true, name: true } }, costCategory: { select: { id: true, name: true } }, officeBudgetLine: OFFICE_LINE_SELECT },
  },
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
    /** What the cash is for (2026-10-26): the project, else the sales order, quotation or costing; none when charged item by item. */
    for: sourceOf(row),
    /** Charged item by item (2026-11-11): how many places its items name. */
    places: row.split ? new Set(row.items.map((i) => i.officeBudgetLineId ?? `${i.jobId}:${i.costCategoryId}`)).size : null,
    /** The record it was raised on, kept once a project took it over. */
    raisedOn: raisedOn(row),
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

/**
 * A TRAVEL request (2026-11-10, the owner's call: "Travel Request for
 * shipping lines, transportation or air flight … redirected to G-FIN › Money
 * out") is a budget request with a journey on it: the same sources, release,
 * liquidation and registers, its own number (GT-TR-…) and its own approval
 * route (`travel_request` — the Technical Manager and the Team Leader first).
 */
const docType = (row: { isTravel?: boolean | null }) => (row.isTravel ? ('travel_request' as const) : ('budget_request' as const));
const docWord = (row: { isTravel?: boolean | null }) => (row.isTravel ? 'travel request' : 'budget request');
/** Whoever may decide its open approval — under either route's name. */
const decides = async (userId: string, id: string) => (await mayDecide(userId, 'budget_request', [id])) || (await mayDecide(userId, 'travel_request', [id]));
/** The Travel Requests screens' own readers: every travel request, never the other cash requests. */
const TRAVEL_ALL = ['gops.travel_requests.view_all', 'gfin.travel_requests.view_all'];
const seesAllTravel = (me: Me) => seesAll(me) || TRAVEL_ALL.some((k) => me.permissions.has(k));
const readsCashRegister = (me: Me) => me.isSuperAdmin || BUDGET_LIST_PERMISSIONS.some((k) => me.permissions.has(k));
const TRAVEL_MODES = ['SHIPPING', 'LAND', 'AIR'] as const;
export const TRAVEL_MODE_WORDS: Record<string, string> = { SHIPPING: 'Shipping line', LAND: 'Land transportation', AIR: 'Air flight' };
/** "Air flight: Manila → Cebu, Nov 12, 2026 (back Nov 15, 2026)". */
function journeyOf(row: { travelMode: string | null; travelFrom: string | null; travelTo: string | null; departOn: Date | null; returnOn: Date | null }) {
  return `${TRAVEL_MODE_WORDS[row.travelMode ?? ''] ?? 'Travel'}: ${row.travelFrom ?? ''} → ${row.travelTo ?? ''}${row.departOn ? `, ${formatShortDate(row.departOn)}` : ''}${row.returnOn ? ` (back ${formatShortDate(row.returnOn)})` : ''}`;
}

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
function assertCanSee(me: Me, row: { requestedById: string; isTravel?: boolean | null; job: { projectManager: { id: string } | null } | null }) {
  if (seesAll(me)) return;
  if (row.isTravel && seesAllTravel(me)) return;
  if (row.requestedById === me.id) return;
  if (visibleOwners(me, 'gops', 'budget_requests').includes(row.requestedById)) return;
  if (row.job?.projectManager?.id === me.id) return;
  throw forbidden('That is someone else’s budget request');
}

/** The list's where-builder — the project tab and the G-FIN screen read the same rows. */
export function budgetRequestListWhere(me: Me, q: ReturnType<typeof listQuery>, today = dayKey(new Date())) {
  const where: Prisma.BudgetRequestWhereInput = {};
  // The Travel Requests screens (`?travel=yes`), and a reader who holds only
  // their right, list travel requests alone.
  const travelOnly = q.filters.travel === 'yes' || !readsCashRegister(me);
  const mine = !(travelOnly ? seesAllTravel(me) : seesAll(me)) || q.scope === 'mine';
  // Who asked: the visibility rule and the `requestedById` filter are ANDed,
  // never one written over the other — so the filter can only narrow. A
  // requester who sees only their own, naming somebody else, gets nothing.
  const asked = q.filters.requestedById || undefined;
  const people: Prisma.BudgetRequestWhereInput[] = [];
  // View Team reads the team's requests (2026-10-19); "Mine" is one's own.
  if (q.scope === 'mine') people.push({ requestedById: me.id });
  else if (mine) people.push({ requestedById: { in: [...new Set([me.id, ...visibleOwners(me, 'gops', 'budget_requests')])] } });
  if (asked) people.push({ requestedById: asked });
  if (people.length) where.AND = people;
  const f = q.filters;
  // What it is for: a record's own requests (`?jobId=`, `?salesOrderId=`,
  // `?quotationId=`, `?costingId=`) or a kind (`?for=`).
  const and: Prisma.BudgetRequestWhereInput[] = [...sourceFilter(f)];
  if (travelOnly) and.push({ isTravel: true });
  else if (f.travel === 'no') and.push({ isTravel: false });
  if (f.travelMode) and.push({ travelMode: choice(f.travelMode, Object.fromEntries(TRAVEL_MODES.map((m) => [m, m])) as Record<string, string>, 'Travel by') ?? undefined });
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
      ...sourceSearch(q.search),
      { requestedBy: { name: { contains: q.search, mode: 'insensitive' } } },
      { travelFrom: { contains: q.search, mode: 'insensitive' } },
      { travelTo: { contains: q.search, mode: 'insensitive' } },
      { carrier: { contains: q.search, mode: 'insensitive' } },
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

const BUDGET_LIST_PERMISSIONS = ['gops.budget_requests.view_all', 'gops.budget_requests.view_own', 'gfin.budget_requests.view_all', 'gfin.budget_liquidations.view_all'];
/** The registers' doors: the cash registers', and the Travel Requests screens' (which list travel requests alone). */
const LIST_PERMISSIONS = [...BUDGET_LIST_PERMISSIONS, 'gops.travel_requests.view_all', 'gops.travel_requests.view_own', 'gfin.travel_requests.view_all'];

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
          ...SOURCE_INCLUDE,
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
    const travelPaper = q.filters.travel === 'yes';
    const reference = listReference(count, rows.length, travelPaper ? ['travel request', 'travel requests'] : ['budget request', 'budget requests'], [
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
          'For and budget line',
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
            { title: sourceOf(r)?.name ?? '', body: r.officeBudgetLine ? `Office budget · ${r.officeBudgetLine.budget.name}` : `${sourceOf(r)?.label.replace(/ — .*$/, '') ?? ''} · ${r.costCategory.name}` },
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

    const pdf = await renderDocument({ title: travelPaper ? 'Travel Requests' : 'Budget Requests', date: new Date(), reference, landscape: true, sections });
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
    // An office budget line (2026-11-10): its budget's lines in the panel's shape.
    if (req.query.officeBudgetLineId) {
      const line = await prisma.officeBudgetLine.findUnique({ where: { id: String(req.query.officeBudgetLineId) }, select: { budgetId: true } });
      const pool = line ? await officeBudgetPosition(line.budgetId) : null;
      if (!pool) throw badRequest('That office budget line is not on file');
      const shape = (l: (typeof pool.lines)[number]) => ({ id: l.id, code: l.code, name: `${l.code} ${l.name}`, budgeted: l.budget, committed: l.released, incurred: l.actual, consumed: 0, requested: l.requested, available: l.remaining });
      res.json({
        source: { kind: 'office', id: String(req.query.officeBudgetLineId), number: '', name: pool.budget.name, label: `Office budget ${pool.budget.name}`, link: `/g-fin/operations-budget?budget=${pool.budget.id}` },
        categories: [],
        job: null,
        perLine: true,
        lines: pool.lines.filter((l) => l.isActive).map(shape),
        total: { budgeted: pool.total.budget, committed: pool.total.released, incurred: pool.total.actual, consumed: 0, requested: pool.total.requested, available: pool.total.remaining },
      });
      return;
    }
    const source = await sourceFromQuery(req.query as Record<string, unknown>);
    // The budget lines a request may name — every active one, whatever the
    // record carries (a sales order's cost has no lines of its own).
    const categories = await prisma.costCategory.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { id: true, name: true } });
    if (source.kind === 'project') {
      res.json({ source, categories, job: { id: source.id, number: source.number, name: source.name }, perLine: true, ...(await projectBudgetByLine(source.id)) });
      return;
    }
    res.json({ source, categories, job: null, ...(await recordBudget(source, null)) });
  }),
);

/** The record named in a query — `?jobId=`, `?salesOrderId=`, `?quotationId=` or `?costingId=`. */
async function sourceFromQuery(query: Record<string, unknown>): Promise<RequestSource> {
  const id = (k: string) => (query[k] ? String(query[k]) : null);
  const row = {
    job: id('jobId') ? await prisma.job.findUnique({ where: { id: id('jobId')! }, select: { id: true, number: true, name: true } }) : null,
    salesOrder: id('salesOrderId')
      ? await prisma.salesOrder.findUnique({ where: { id: id('salesOrderId')! }, select: { id: true, number: true, quotation: { select: { subject: true } } } })
      : null,
    quotation: id('quotationId') ? await prisma.quotation.findUnique({ where: { id: id('quotationId')! }, select: { id: true, number: true, subject: true } }) : null,
    costing: id('costingId') ? await prisma.costing.findUnique({ where: { id: id('costingId')! }, select: { id: true, number: true, title: true } }) : null,
  };
  const source = sourceOf(row);
  if (!source) throw badRequest('Name the project, sales order, quotation or costing');
  return source;
}

/**
 * What a new request may be raised on, for the request page's "For" picker
 * (2026-10-26): issued sales orders, open or won quotations, final costings —
 * the ones the caller may read (View All, else their Own / Team scope or a
 * direct report's), numbers and names only. `?kind=` and `?q=`. Above `/:id`.
 */
budgetRequestRoutes.get(
  '/sources',
  require_('gops.budget_requests.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const kind = String(req.query.kind ?? '') as SourceKind;
    const q = String(req.query.q ?? '').trim();
    const like = q ? { contains: q, mode: 'insensitive' as const } : undefined;
    const reports = async () => (await prisma.user.findMany({ where: { supervisorId: me.id }, select: { id: true } })).map((u) => u.id);
    const owners = async (module: string) =>
      me.isSuperAdmin || me.permissions.has(`gops.${module}.view_all`) ? null : [me.id, ...visibleOwners(me, 'gops', module), ...(await reports())];
    if (kind === 'sales_order') {
      const ids = await owners('sales_orders');
      const rows = await prisma.salesOrder.findMany({
        where: { status: 'ISSUED', ...(ids ? { ownerId: { in: ids } } : {}), ...(like ? { OR: [{ number: like }, { quotation: { subject: like } }, { customer: { name: like } }] } : {}) },
        select: { id: true, number: true, quotation: { select: { subject: true } }, customer: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      res.json(rows.map((r) => ({ id: r.id, number: r.number, name: r.quotation.subject, sub: r.customer.name })));
      return;
    }
    if (kind === 'quotation') {
      const ids = await owners('quotations');
      const rows = await prisma.quotation.findMany({
        where: { outcome: { in: ['OPEN', 'SUBMITTED', 'NEGOTIATION', 'WON'] }, ...(ids ? { ownerId: { in: ids } } : {}), ...(like ? { OR: [{ number: like }, { subject: like }, { customer: { name: like } }] } : {}) },
        select: { id: true, number: true, subject: true, customer: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      res.json(rows.map((r) => ({ id: r.id, number: r.number, name: r.subject, sub: r.customer.name })));
      return;
    }
    if (kind === 'costing') {
      const ids = await owners('costing');
      const rows = await prisma.costing.findMany({
        where: { status: 'FINAL', ...(ids ? { ownerId: { in: ids } } : {}), ...(like ? { OR: [{ number: like }, { title: like }, { customer: { name: like } }] } : {}) },
        select: { id: true, number: true, title: true, customer: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      res.json(rows.map((r) => ({ id: r.id, number: r.number, name: r.title, sub: r.customer?.name ?? '' })));
      return;
    }
    throw badRequest('Kind must be sales_order, quotation or costing');
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
    const row = requestId ? await prisma.budgetRequest.findUnique({ where: { id: requestId }, select: { requestedById: true, jobId: true, isTravel: true } }) : null;
    if (requestId && !row) throw notFound('Budget request not found');
    const jobId = row?.jobId ?? (req.query.jobId ? String(req.query.jobId) : null);
    // The projects the page's lines charge (2026-11-11), else the one project.
    const jobIds = req.query.jobIds ? String(req.query.jobIds).split(',').filter(Boolean) : jobId ? [jobId] : [];
    const type = docType({ isTravel: row ? row.isTravel : String(req.query.travel ?? '') === '1' });
    res.json({ route: await routeBrief(type, amount, row?.requestedById ?? me.id, null, { jobId, jobIds }) });
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
type BudgetRow = {
  id: string;
  jobId: string | null;
  costCategoryId: string;
  status: RequestStatus;
  amount: Prisma.Decimal;
  amountReleased: Prisma.Decimal;
  amountRefunded: Prisma.Decimal;
  officeBudgetLineId?: string | null;
  split?: boolean;
} & Parameters<typeof sourceOf>[0];

export async function requestBudget(row: BudgetRow) {
  // Charged item by item (2026-11-11): one card per place, `requestCards()`.
  if (row.split) return null;
  // Office cash (2026-11-10): the office budget line's own position.
  if (row.officeBudgetLineId) {
    const office = await requestOffice({ ...row, officeBudgetLineId: row.officeBudgetLineId });
    if (office) return office;
  }
  return recordOrProjectBudget(row);
}

async function recordOrProjectBudget(row: BudgetRow) {
  // A project's request reads Budget Monitoring; one on a sales order,
  // quotation or costing reads that record's cost (2026-10-26) — one budget
  // line each, or one "whole cost" row where the record carries none.
  const source = sourceOf(row);
  const pool =
    row.jobId || !source
      ? { ...(await projectBudgetByLine(row.jobId!, { exclude: { sourceType: 'budget_request', sourceId: row.id }, own: { budgetRequestId: row.id } })), perLine: true }
      : (await recordBudget(source, row.id)) ?? { lines: [], total: { budgeted: 0, committed: 0, incurred: 0, consumed: 0, available: 0 }, perLine: false };
  const { lines, total, perLine } = pool;
  const settled = ['LIQUIDATED', 'REJECTED', 'CANCELLED'].includes(row.status);
  const out = ['RELEASED', 'REFUND_DUE'].includes(row.status);
  const thisRequest = settled ? 0 : out ? cents(Math.max(0, num(row.amountReleased) - num(row.amountRefunded))) : num(row.amount);
  const line = (perLine ? lines.find((l) => l.id === row.costCategoryId) : lines[0]) ?? null;
  const before = line?.available ?? 0;
  const after = cents(before - thisRequest);
  return {
    /** What it is checked against: the project's Budget Monitoring, or the record's cost. */
    source: (source?.kind ?? 'project') as Exclude<SourceKind, 'office'>,
    /** False where the record carries no budget lines (a sales order; a quotation with no costing). */
    perLine,
    line,
    lines,
    total,
    availableBefore: before,
    thisRequest,
    availableAfter: after,
    over: after < 0,
    overBy: after < 0 ? cents(-after) : 0,
    /** Also waiting on this line, besides this request (2026-11-09) — shown, never subtracted. */
    requested: perLine ? ((line as { requested?: number } | null)?.requested ?? 0) : 0,
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
  const live = rows.filter((r) => !['LIQUIDATED', 'REJECTED', 'CANCELLED'].includes(r.status));
  for (const r of rows) out.set(r.id, null);
  // A request on a sales order, quotation or costing reads its record's cost, one at a time;
  // one charged item by item has no single line to say (its page has a card per place).
  for (const r of live.filter((r) => !r.jobId && !r.split)) out.set(r.id, (await requestBudget(r))?.availableAfter ?? null);
  const open = live.filter((r): r is typeof r & { jobId: string } => !!r.jobId && !r.split);
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
function budgetSections(b: NonNullable<Awaited<ReturnType<typeof requestBudget>>>, lineName: string, currency: string): PdfSection[] {
  if (b.source === 'office') return chargeSections(b, b.line.name, 'This request', currency);
  const shown = b.lines.filter((l) => l.id === b.line?.id || l.budgeted || l.committed || l.incurred);
  const words = b.basis === 'released' ? 'This request (cash still out)' : 'This request';
  return [
    {
      kind: 'table',
      title: b.source === 'project' ? 'Against the project budget' : 'Against its cost',
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
      if (!(await decides(me.id, row.id))) throw err;
      return;
    }
  }
  if (!(await decides(me.id, row.id))) throw forbidden('That is someone else’s budget request');
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
      row.status === 'DRAFT' ? await routeBrief(docType(row), num(row.amount), row.requestedById, null, { jobId: row.jobId, jobIds: jobIdsOf(row, row.items) }) : null;
    res.json({
      ...presentBudgetRequest(row),
      allocations: row.allocations.map((a) => ({ ...a, amount: num(a.amount) })),
      canEdit: row.status === 'DRAFT' && canEditRecord(me, 'gops', 'budget_requests', row.requestedById),
      /** Finance may book and pay an approved travel request itself — the company card (2026-11-10). */
      canBook: row.isTravel && row.status === 'APPROVED' && (me.isSuperAdmin || me.permissions.has('gfin.ap.create')),
      approvalType: docType(row),
      approvalRoute,
      budget: await requestBudget(row),
      // Charged item by item (2026-11-11): one card per place.
      budgets: await requestCards(row),
    });
  }),
);

const itemSchema = z.object({
  name: z.string().trim().min(1, 'Say what the line buys').max(300),
  description: z.string().trim().max(2000).optional().nullable(),
  quantity: z.number().positive('A line’s quantity must be more than zero'),
  unit: z.string().trim().max(40).optional().nullable(),
  unitCost: z.number().min(0, 'A unit cost cannot be negative'),
  /** Where this item is charged (2026-11-11); left out, the request's own. */
  jobId: z.string().optional().nullable(),
  costCategoryId: z.string().optional().nullable(),
  officeBudgetLineId: z.string().optional().nullable(),
});

const requestSchema = z.object({
  /** Exactly one of the four (2026-10-26). */
  jobId: z.string().optional().nullable(),
  salesOrderId: z.string().optional().nullable(),
  quotationId: z.string().optional().nullable(),
  costingId: z.string().optional().nullable(),
  /** An office budget line instead of the four (2026-11-10); it needs no cost category. */
  officeBudgetLineId: z.string().optional().nullable(),
  costCategoryId: z.string().optional().nullable(),
  /** Typed when there is no breakdown; with `items`, their sum and nothing else. */
  amount: z.number().optional(),
  reason: z.string().trim().min(3, 'What is the cash for?'),
  neededBy: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  /** The breakdown (2026-10-19). Sent, it replaces the request's lines whole. */
  items: z.array(itemSchema).max(200).optional(),
  /** The journey: sent, the request is a TRAVEL request (2026-11-10). */
  travel: z
    .object({
      mode: z.enum(TRAVEL_MODES),
      from: z.string().trim().min(2, 'Where from?').max(200),
      to: z.string().trim().min(2, 'Where to?').max(200),
      departOn: z.string().min(1, 'When does it leave?'),
      returnOn: z.string().optional().nullable(),
      travellers: z.string().trim().max(1000).optional().nullable(),
      carrier: z.string().trim().max(200).optional().nullable(),
    })
    .optional()
    .nullable(),
});

/** The journey's columns, checked: a return never before the departure. */
function travelColumns(body: RequestBody) {
  const t = body.travel;
  if (!t) return { isTravel: false, travelMode: null, travelFrom: null, travelTo: null, departOn: null, returnOn: null, travellers: null, carrier: null };
  const departOn = asDate(t.departOn, 'Departure');
  const returnOn = t.returnOn ? asDate(t.returnOn, 'Return') : null;
  if (returnOn && returnOn < departOn) throw badRequest('The return is before the departure');
  return { isTravel: true, travelMode: t.mode, travelFrom: t.from, travelTo: t.to, departOn, returnOn, travellers: t.travellers || null, carrier: t.carrier || null };
}

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

function moneyOf(body: RequestBody, charges: LineCharge[] = []) {
  const lines = (body.items ?? []).map((i, n) => ({
    sortOrder: n,
    name: i.name,
    description: i.description?.trim() || null,
    quantity: D(Math.round(i.quantity * 1000) / 1000),
    unit: i.unit?.trim() || 'pcs',
    unitCost: D(Math.round(i.unitCost * 100) / 100),
    amount: D(requestLineAmount(i.quantity, i.unitCost)),
    ...(charges[n] ?? NO_CHARGE),
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

/** Indirect Cost, a system row: the stand-in for a request whose `costCategoryId` means nothing (office cash, or charged item by item). */
async function standInCategory() {
  const standIn =
    (await prisma.costCategory.findFirst({ where: { code: 'IND' }, select: { id: true } })) ??
    (await prisma.costCategory.findFirst({ orderBy: { sortOrder: 'asc' }, select: { id: true } }));
  if (!standIn) throw badRequest('No cost category is on file');
  return standIn.id;
}

/**
 * Where a request's money goes (2026-11-11): its own place as the items'
 * default, each item's own where the form says — collapsed to one place when
 * they agree (`collapse()`), else charged item by item (`split`). Only a
 * project's or the office's request is split: one on a sales order, quotation
 * or costing, and a travel request, are charged whole.
 */
async function requestCharging(me: Me, body: RequestBody, keepOffice: (string | null)[] = []) {
  const sent = (body.items ?? []).map((i) => ({ jobId: i.jobId || null, costCategoryId: i.costCategoryId || null, officeBudgetLineId: i.officeBudgetLineId || null }));
  const whole = async (b: RequestBody) => ({ ...(await checkCharging(me, b, keepOffice.find((x) => x === b.officeBudgetLineId) ?? null)), split: false, itemCharges: sent.map(() => NO_CHARGE) });
  if (!sent.some((c) => c.jobId || c.officeBudgetLineId)) return whole(body);
  if (body.travel || body.salesOrderId || body.quotationId || body.costingId) {
    throw badRequest(body.travel ? 'A travel request is charged whole — leave its lines on the request’s own project or office line' : 'A request on a sales order, quotation or costing is charged whole — its lines cannot name other places');
  }
  const header = { jobId: body.jobId || null, costCategoryId: body.jobId ? body.costCategoryId || null : null, officeBudgetLineId: body.jobId ? null : body.officeBudgetLineId || null };
  const c = collapse(sent, header);
  if (!c.split) return whole({ ...body, jobId: c.header.jobId, costCategoryId: c.header.costCategoryId, officeBudgetLineId: c.header.officeBudgetLineId });
  await checkLineCharges(c.lines, { keepOffice, requireCharge: true });
  return {
    columns: { jobId: null, salesOrderId: null, quotationId: null, costingId: null, officeBudgetLineId: null },
    number: 'several places',
    kind: 'split' as const,
    costCategoryId: await standInCategory(),
    split: true,
    itemCharges: c.lines,
  };
}

/** The record must still stand (`checkSource`), and the budget line must exist. */
async function checkCharging(me: Me, body: RequestBody, keepOfficeLine?: string | null) {
  const source = await checkSource(me, body, keepOfficeLine);
  if (source.kind === 'office') {
    // The column is required and means nothing here: office cash is read by
    // its office line. Indirect Cost, a system row, stands in.
    const standIn =
      (await prisma.costCategory.findFirst({ where: { code: 'IND' }, select: { id: true } })) ??
      (await prisma.costCategory.findFirst({ orderBy: { sortOrder: 'asc' }, select: { id: true } }));
    if (!standIn) throw badRequest('No cost category is on file');
    return { ...source, costCategoryId: standIn.id };
  }
  if (!body.costCategoryId) throw badRequest('Which budget line?');
  const category = await prisma.costCategory.findUnique({ where: { id: body.costCategoryId }, select: { id: true } });
  if (!category) throw notFound('Budget line not found');
  return { ...source, costCategoryId: category.id };
}

budgetRequestRoutes.post(
  '/',
  require_('gops.budget_requests.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(requestSchema, req.body);
    const source = await requestCharging(me, body);
    const { lines, amount } = moneyOf(body, source.itemCharges);
    const travel = travelColumns(body);

    const request = await prisma.$transaction(async (tx) => {
      const number = await nextNumber(docType(travel), tx);
      return tx.budgetRequest.create({
        data: {
          number,
          ...travel,
          ...source.columns,
          costCategoryId: source.costCategoryId,
          split: source.split,
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
        summary: `Raised ${request.number} — ${amount} for ${source.number}: ${body.reason}${lines.length ? ` (${lines.length} line${lines.length === 1 ? '' : 's'})` : ''}`,
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
    const same = (a: string | null | undefined, b: string | null) => (a || null) === b;
    // A request on a record stays on it. One for a project, the office or
    // several places (2026-11-11) may move between them while a draft — its
    // lines say where the money goes.
    const onRecord = !!(existing.salesOrderId || existing.quotationId || existing.costingId);
    if (onRecord && (!same(body.salesOrderId, existing.salesOrderId) || !same(body.quotationId, existing.quotationId) || !same(body.costingId, existing.costingId))) {
      throw badRequest('A budget request stays on what it was raised for — raise another');
    }
    if (!onRecord && (body.salesOrderId || body.quotationId || body.costingId)) throw badRequest('A budget request stays on what it was raised for — raise another');
    if (!!body.travel !== existing.isTravel) throw badRequest(existing.isTravel ? 'A travel request keeps its journey — say where and when' : 'This is a budget request, not a travel request — raise a travel request instead');
    const travel = travelColumns(body);
    // Lines sent replace the breakdown whole; none sent keeps it, with the
    // amount still their sum (a typed amount counts only with no lines).
    const kept = body.items ? null : await prisma.budgetRequestItem.findMany({ where: { requestId: existing.id }, orderBy: { sortOrder: 'asc' } });
    if (kept?.length && existing.split) throw badRequest('Send the lines: this request is charged line by line');
    const oldOffice = [existing.officeBudgetLineId, ...(await prisma.budgetRequestItem.findMany({ where: { requestId: existing.id }, select: { officeBudgetLineId: true } })).map((i) => i.officeBudgetLineId)];
    const source = await requestCharging(me, body, oldOffice);
    // Charged whole before and after, a request stays on what it was raised
    // for (an office request may move to another office line); spreading its
    // lines over several places, or gathering them again, is the draft's to do.
    if (!existing.split && !source.split) {
      if ((existing.jobId || null) !== (source.columns.jobId || null) || !!existing.officeBudgetLineId !== !!source.columns.officeBudgetLineId) {
        throw badRequest('A budget request stays on what it was raised for — raise another');
      }
    }
    const { lines, amount } = kept?.length
      ? { lines: null, amount: cents(kept.reduce((s, l) => s + num(l.amount), 0)) }
      : moneyOf(body, source.itemCharges);

    const request = await prisma.$transaction(async (tx) => {
      // Claimed on DRAFT: a submit that landed first wins.
      const claimed = await tx.budgetRequest.updateMany({
        where: { id: existing.id, status: 'DRAFT' },
        data: {
          costCategoryId: source.costCategoryId,
          jobId: source.columns.jobId,
          officeBudgetLineId: source.columns.officeBudgetLineId,
          split: source.split,
          ...travel,
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
      include: { ...SOURCE_INCLUDE, costCategory: { select: { name: true } } },
    });
    if (!request) throw notFound('Budget request not found');
    if (request.requestedById !== me.id && !me.isSuperAdmin) throw forbidden('Only the requester can submit this');
    const forWhat = sourceOf(request)?.label.replace(/ — .*$/, '') ?? '';
    if (request.status !== 'DRAFT') throw badRequest('This request has already been submitted');

    // Claimed, never simply written: two Submit clicks file once.
    const claimed = await prisma.budgetRequest.updateMany({ where: { id: request.id, status: 'DRAFT' }, data: { status: 'PENDING_APPROVAL' } });
    if (!claimed.count) throw badRequest('This request moved a moment ago — reload to see where it stands');
    // The approvers' bell and queue say what the request takes from its
    // budget line, as it stood at submit (the page has the live figures).
    const budget = await requestBudget(request);
    const currency = await companyCurrency();
    const cards = await requestCards(request);
    const position = !budget
      ? cardsPosition(cards, (n) => formatMoney(n, currency))
      : budget.source === 'office'
        ? officePosition(budget, (n) => formatMoney(n, currency))
        : budget.over
          ? `${formatMoney(budget.availableBefore, currency)} available, over by ${formatMoney(budget.overBy, currency)}`
          : `${formatMoney(budget.availableBefore, currency)} available → ${formatMoney(budget.availableAfter, currency)} left`;
    const items = await prisma.budgetRequestItem.findMany({ where: { requestId: request.id }, select: { jobId: true } });
    try {
      await submitForApproval({
        documentType: docType(request),
        documentId: request.id,
        documentNumber: request.number,
        subject:
          (request.isTravel ? `${journeyOf(request)} — ` : '') +
          (request.split
            ? `Several places — ${request.reason} (${position})`
            : request.officeBudgetLine
              ? `Office budget — ${request.officeBudgetLine.code} ${request.officeBudgetLine.name}: ${request.reason} (${position})`
              : `${forWhat} — ${request.costCategory.name}: ${request.reason} (${request.costCategory.name}: ${position})`),
        amount: num(request.amount),
        link: `/g-ops/budget-requests/${request.id}`,
        // The requester, even when a super admin presses the button: the
        // self-approval rule, and the PROJECT_MANAGER step, have to see whose
        // request this is.
        requesterId: request.requestedById,
        jobId: request.jobId,
        // Every project its items charge: each one's Technical Manager agrees (2026-11-11).
        jobIds: jobIdsOf(request, items),
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
    include: { requestedBy: { select: { name: true } }, ...SOURCE_INCLUDE },
  });
  if (!request) return;
  const forWhat = sourceOf(request)?.label.replace(/ — .*$/, '') ?? '';
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
      title: `${request.number} approved — ${formatMoney(num(request.amount))} to ${request.isTravel ? 'book or release' : 'release'} for ${forWhat}`,
      body: `${request.requestedBy.name}: ${request.reason}`,
      link: `/g-ops/budget-requests/${request.id}`,
    })),
  );
  await audit({
    entityType: 'budget_request',
    entityId: request.id,
    action: 'APPROVED',
    summary: `${request.number} approved — ${num(request.amount)} to release to ${request.requestedBy.name} for ${forWhat}; nothing charged until liquidated`,
  });
};
onApprovalSettled('budget_request', settleBudgetRequest);
onApprovalSettled('travel_request', settleBudgetRequest);

/**
 * Pulled back after approval (2026-10-16): back to DRAFT while finance has
 * released nothing. Approval moved no money and charged nothing, so there is
 * nothing to undo — only refused once cash has gone out on it.
 */
const reopenRequest: Parameters<typeof onApprovalReopened>[1] = {
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
};
onApprovalReopened('budget_request', reopenRequest);
onApprovalReopened('travel_request', reopenRequest);

/**
 * Finance books and pays the trip itself (2026-11-10, the owner's call:
 * "finance can also pay, particularly the booking of an airline using a
 * credit card"). An APPROVED travel request, the A/P create right: one
 * payment voucher for what the booking cost — never more than was approved —
 * allocated to the request and marked `paidDirect`. Nobody holds cash, so
 * `refreshBudgetRequest()` reads what was paid as what was spent: the request
 * is LIQUIDATED at once, a project is charged INCURRED, an office line counts
 * it as actual. Deleting the voucher puts the request back to approved.
 */
budgetRequestRoutes.post(
  '/:id/book',
  require_('gfin.ap.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(
      z.object({
        amount: z.number().positive('What did the booking cost?'),
        method: z.enum(['CREDIT_CARD', 'BANK_TRANSFER', 'ONLINE', 'CASH', 'CHECK']).default('CREDIT_CARD'),
        paymentDate: z.string().optional().nullable(),
        reference: z.string().trim().max(200).optional().nullable(),
        carrier: z.string().trim().max(200).optional().nullable(),
        notes: z.string().trim().max(2000).optional().nullable(),
      }),
      req.body,
    );
    const request = await prisma.budgetRequest.findUnique({ where: { id: req.params.id }, include: { requestedBy: { select: { id: true, name: true } } } });
    if (!request) throw notFound('Travel request not found');
    if (!request.isTravel) throw badRequest('Only a travel request is booked and paid by finance — a budget request is released to its requester');
    if (request.status !== 'APPROVED') throw badRequest(`${request.number} is ${statusLabel(request.status).toLowerCase()} — only an approved travel request can be booked`);
    const amount = cents(body.amount);
    if (amount > num(request.amount) + 0.005) {
      throw badRequest(`${request.number} was approved for ${formatMoney(num(request.amount))} — the booking cannot cost more. Raise another request for the difference`);
    }
    const paymentDate = body.paymentDate ? asDate(body.paymentDate, 'Payment date') : dayKey(new Date());
    if (paymentDate > dayKey(new Date())) throw badRequest('The payment date is still to come');

    const payment = await prisma.$transaction(async (tx) => {
      // Claimed on APPROVED with nothing paid: two clicks book once.
      const claimed = await tx.budgetRequest.updateMany({
        where: { id: request.id, status: 'APPROVED', paidDirect: false },
        data: { paidDirect: true, ...(body.carrier ? { carrier: body.carrier } : {}) },
      });
      if (!claimed.count) throw badRequest('This request moved a moment ago — reload to see where it stands');
      const number = await nextNumber('disbursement', tx);
      const created = await tx.payment.create({
        data: {
          number,
          kind: 'DISBURSEMENT',
          method: body.method,
          paymentDate,
          amount: D(amount),
          reference: body.reference || null,
          // A cheque is a promise until it clears; a card or a transfer is paid on the day.
          clearedAt: body.method === 'CHECK' ? null : paymentDate,
          notes: `Booked and paid directly for ${request.number} — ${journeyOf(request)}${body.notes ? `. ${body.notes}` : ''}`,
          recordedById: me.id,
          allocations: { create: [{ budgetRequestId: request.id, amount: D(amount) }] },
        },
      });
      await refreshBudgetRequest(tx, request.id);
      return created;
    });
    await notify([
      {
        userId: request.requestedById,
        type: 'system' as const,
        title: `${request.number} booked — ${formatMoney(amount)} paid by finance`,
        body: `${journeyOf(request)}${body.reference ? ` · ref. ${body.reference}` : ''}. Nothing to liquidate.`,
        link: `/g-ops/budget-requests/${request.id}`,
      },
    ]);
    await audit(
      {
        entityType: 'budget_request',
        entityId: request.id,
        action: 'UPDATED',
        summary: `${request.number} booked and paid directly by finance — ${amount} (${payment.number}, ${statusLabel(body.method).toLowerCase()}); nothing to liquidate`,
        after: { paymentId: payment.id, amount, method: body.method },
      },
      req,
    );
    res.json({ ok: true, paymentId: payment.id, paymentNumber: payment.number });
  }),
);

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
      await cancelOpenRequest(docType(request), request.id, tx, `cancelled by ${me.name}${body.reason ? `: ${body.reason}` : ''}`, me.id);
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
    assertMayDelete(me, request.requestedById, request.number);
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
      project: row.officeBudgetLine ? `Office budget — ${row.officeBudgetLine.budget.name}` : (sourceOf(row)?.label ?? ''),
      budgetLine: row.officeBudgetLine ? `${row.officeBudgetLine.code} ${row.officeBudgetLine.name}` : row.costCategory.name,
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
    if (row.isTravel) {
      // The journey, right under the request's details.
      sections.splice(1, 0, {
        kind: 'fields',
        title: 'Journey',
        columns: 3,
        fields: [
          { label: 'Travel by', value: TRAVEL_MODE_WORDS[row.travelMode ?? ''] ?? '—' },
          { label: 'From', value: row.travelFrom ?? '—' },
          { label: 'To', value: row.travelTo ?? '—' },
          { label: 'Departure', value: row.departOn ? formatShortDate(row.departOn) : '—' },
          { label: 'Return', value: row.returnOn ? formatShortDate(row.returnOn) : 'One way' },
          { label: 'Carrier', value: row.carrier ?? '—' },
          { label: 'Travellers / cargo', value: row.travellers ?? '—' },
          ...(row.paidDirect ? [{ label: 'Paid', value: 'Booked and paid directly by finance — nothing to liquidate' }] : []),
        ],
      });
    }
    if (row.cancelReason) sections.push({ kind: 'text', title: 'Cancelled', body: row.cancelReason });
    const one = await requestBudget(row);
    const currency = await companyCurrency();
    if (one) sections.push(...budgetSections(one, row.costCategory.name, currency));
    // Charged item by item (2026-11-11): one block per place.
    for (const card of await requestCards(row)) sections.push(...chargeSections(card.budget, card.title, 'This request', currency));

    const paperTitle = row.isTravel ? 'Travel Request' : 'Budget Request';
    const pdf = await renderDocument({
      title: paperTitle,
      documentNumber: row.number,
      date: row.createdAt,
      reference: `${sourceOf(row)?.label.replace(/ — .*$/, '') ?? ''} — ${row.reason}`,
      sections,
      signatories: await cashRequestSignatories({
        documentType: docType(row),
        id: row.id,
        status: row.status,
        amount: view.amount,
        requester: row.requestedBy,
        // The project the submit names, for its PROJECT_MANAGER step.
        jobId: row.jobId,
        jobIds: jobIdsOf(row, row.items),
        raisedAt: row.createdAt,
        releasedOn: release?.createdAt ?? null,
      }),
    });

    // The quotations, receipts and papers filed for the approvers go behind
    // the request (2026-11-03); `?attachments=0` prints it bare.
    const files = req.query.attachments === '0' ? [] : await attachedFiles('budget_request', row.id);
    const { pdf: withFiles, listed } = await withAttachments(pdf, files, { title: paperTitle, number: row.number, reference: row.reason });

    await audit(
      {
        entityType: 'budget_request',
        entityId: row.id,
        action: 'EXPORTED',
        summary: `Printed ${row.number}${listed ? ` with ${listed} attachment${listed === 1 ? '' : 's'}` : ''}`,
      },
      req,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition(paperFileName({ kind: paperTitle, number: row.number, author: row.requestedBy.name, date: row.createdAt })));
    res.send(withFiles);
  }),
);

registerSearch({
  kind: 'budget_request',
  label: 'Budget requests',
  permission: BUDGET_LIST_PERMISSIONS,
  ownWhere: (user) => ({ requestedById: user.id }),
  async search(term, _user, limit, own) {
    const rows = await prisma.budgetRequest.findMany({
      where: {
        ...(own ?? {}),
        OR: [
          { number: { contains: term, mode: 'insensitive' } },
          { reason: { contains: term, mode: 'insensitive' } },
          ...sourceSearch(term),
          { requestedBy: { name: { contains: term, mode: 'insensitive' } } },
        ],
      },
      select: { id: true, number: true, reason: true, status: true, ...SOURCE_INCLUDE, requestedBy: { select: { name: true } } },
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      kind: 'budget_request',
      id: r.id,
      title: `${r.number} — ${r.reason}`,
      subtitle: `${sourceOf(r)?.number ?? ''} · ${r.requestedBy.name} · ${r.status.toLowerCase().replace(/_/g, ' ')}`,
      link: `/g-ops/budget-requests/${r.id}`,
    }));
  },
});

/**
 * A budget request's papers (2026-11-03, the owner's call: "on budget request
 * add attachment option") — a quotation, a breakdown, a photo — read by
 * whoever reads the request (its register's readers, the project's Technical
 * Manager) and by whoever may decide its open approval; filed while it is a
 * draft or with the approvers, by whoever may change it.
 */
registerAttachmentGuard(
  'budget_request',
  async (user, id) => {
    const row = await prisma.budgetRequest.findUnique({
      where: { id },
      select: { requestedById: true, isTravel: true, job: { select: { projectManager: { select: { id: true } } } } },
    });
    if (!row) return false;
    try {
      assertCanSee(user, row);
      return true;
    } catch {
      return decides(user.id, id);
    }
  },
  {
    write: async (user, id) => {
      const row = await prisma.budgetRequest.findUnique({ where: { id }, select: { status: true, requestedById: true } });
      if (!row || !['DRAFT', 'PENDING_APPROVAL'].includes(row.status)) return false;
      return canEditRecord(user, 'gops', 'budget_requests', row.requestedById);
    },
  },
);
