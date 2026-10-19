import { Router } from 'express';
import { z } from 'zod';
import { Prisma, CashAdvanceStatus, type ApprovalRequest } from '@prisma/client';
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
import { canEditRecord } from '../permissions/resolve';
import { audit } from '../shared/audit';
import { nextNumber } from '../shared/numbering';
import {
  submitForApproval,
  onApprovalSettled,
  onApprovalReopened,
  cancelOpenRequest,
  openSteps,
  stageWords,
  routeBrief,
  type ApprovalOutcome,
} from '../shared/approvals';
import { requestItemSchema, requestMoney } from '../shared/requestLines';
import { TEAM_OR_DEPT_SELECT, teamOrDepartment, userTeamWhere } from '../shared/team';
import { registerSearch } from '../shared/search';
import { renderDocument, companyCurrency, formatAmount, formatMoney, formatQuantity, formatShortDate, statusLabel, type PdfSection } from '../shared/pdf';
import { cents, D, num, dayKey, daysBetween, financeSettings } from '../shared/finance';
import { claimInclude, presentClaim, cashRequestSections, cashRequestSignatories } from './finance';
import { LIST_CAP, listReference, bracketed, totalLabel, bracketNote, listNotes, recordNamed, choice, sendListPdf } from '../shared/listPaper';
import { contentDisposition, paperFileName } from '../shared/paperName';

/**
 * Cash advances — money issued to a person BEFORE it is spent.
 *
 * An advance is a receivable from that person until an approved liquidation
 * (an ExpenseClaim with `advanceId`) says what was spent. Nothing reaches a
 * job's ledger on approval or on release: the liquidation posts INCURRED at
 * what was actually spent, the first and only time the cash appears as cost.
 *
 * Everything the advance carries as a figure — released, spent, refunded —
 * is re-derived by `refreshAdvance()` in shared/finance.ts from the payment
 * allocations and the approved liquidation. This module never writes those
 * columns itself.
 */

export const advanceRoutes = Router();
advanceRoutes.use(authenticate);

const advanceInclude = {
  requestedBy: { select: { id: true, name: true, email: true, position: true, ...TEAM_OR_DEPT_SELECT.select } },
  job: { select: { id: true, number: true, name: true } },
  costCategory: { select: { id: true, name: true } },
  liquidations: {
    select: { id: true, number: true, status: true, total: true, amountPaid: true, claimDate: true, approvedAt: true },
    orderBy: { createdAt: 'desc' },
  },
  /** The breakdown — what the cash buys, line by line (2026-10-19). */
  items: { orderBy: { sortOrder: 'asc' } },
} satisfies Prisma.CashAdvanceInclude;

type AdvanceRow = Prisma.CashAdvanceGetPayload<{ include: typeof advanceInclude }>;

/** Statuses of a liquidation that still counts — everything but the two dead ends. */
const LIVE_LIQUIDATION = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SETTLED', 'REIMBURSED'] as const;

function presentAdvance(row: AdvanceRow, today = dayKey(new Date())) {
  const amount = num(row.amount);
  const released = num(row.amountReleased);
  const spent = num(row.amountSpent);
  const refunded = num(row.amountRefunded);
  const liquidated = !!row.liquidatedAt;
  const refundDue = liquidated ? cents(Math.max(0, released - spent)) : 0;
  const liquidation = row.liquidations.find((l) => (LIVE_LIQUIDATION as readonly string[]).includes(l.status)) ?? null;
  const { department: _d, employee: _e, ...requester } = row.requestedBy;
  return {
    ...row,
    requestedBy: requester,
    /** The requester's team, else their department. */
    team: teamOrDepartment(row.requestedBy),
    /** Money lent: the repayments made and what is still owed (2026-10-15). */
    paymentsMade: row.repayable ? refunded : 0,
    balance: row.repayable && ['RELEASED', 'PAID'].includes(row.status) ? cents(released - refunded) : 0,
    amount,
    amountReleased: released,
    amountSpent: spent,
    amountRefunded: refunded,
    /** What finance still has to hand over. Only an approved advance is owed anything. */
    toRelease: row.status === 'APPROVED' ? cents(amount - released) : 0,
    spent,
    /** Spent beyond the advance — owed to the person, settled on the claim. */
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

function ownOnly(me: ReturnType<typeof currentUser>): boolean {
  return !me.isSuperAdmin && !me.permissions.has('gfin.cash_advances.view_all');
}

/**
 * The advance list's where-builder — the screen's rows and the printed list
 * read the same set. A `view_own` holder reads only their own advances
 * whatever the URL says, and `?ids=` is ANDed with that, so a ticked id
 * never prints somebody else's advance.
 */
function advanceListWhere(me: ReturnType<typeof currentUser>, q: ListQuery, today: Date) {
  const where: Prisma.CashAdvanceWhereInput = {};
  const mine = ownOnly(me) || q.scope === 'mine';
  // Who asked: the visibility rule and the `requestedById` filter are ANDed,
  // never one written over the other — so the filter can only narrow. A
  // `view_own` holder naming somebody else gets nothing, not their advances.
  const asked = q.filters.requestedById || undefined;
  const people: Prisma.CashAdvanceWhereInput[] = [];
  if (mine) people.push({ requestedById: me.id });
  if (asked) people.push({ requestedById: asked });
  if (people.length) where.AND = people;
  const status = choice(q.filters.status, CashAdvanceStatus, 'Status');
  if (status) where.status = status;
  if (q.filters.jobId) where.jobId = q.filters.jobId;
  const f = q.filters;
  const and: Prisma.CashAdvanceWhereInput[] = [];
  if (f.teamId) and.push({ requestedBy: userTeamWhere(f.teamId) });
  if (f.from || f.to) {
    and.push({ requestDate: { ...(f.from ? { gte: asDate(f.from, 'From') } : {}), ...(f.to ? { lte: asDate(f.to, 'To') } : {}) } });
  }
  // A loan still owed on (released, not repaid) — Payment Entry's choices.
  if (f.owing === 'true') and.push({ repayable: true, status: 'RELEASED' });
  if (f.pending === 'true') and.push({ status: 'PENDING_APPROVAL' });
  if (f.forRelease === 'true') and.push({ status: 'APPROVED' });
  if (and.length) where.AND = [...((where.AND as Prisma.CashAdvanceWhereInput[] | undefined) ?? []), ...and];
  // Overdue is not a status: released, past the deadline, no approved liquidation.
  if (q.filters.overdue === 'true') {
    where.status = 'RELEASED';
    where.liquidationDueDate = { lt: today };
  }
  if (q.search) {
    where.OR = [
      { number: { contains: q.search, mode: 'insensitive' } },
      { purpose: { contains: q.search, mode: 'insensitive' } },
      { requestedBy: { name: { contains: q.search, mode: 'insensitive' } } },
    ];
  }
  const ids = idsFilter(q.filters.ids);
  if (ids) where.id = { in: ids };
  // The person the filter names is said on paper only where it is not the
  // caller already said as "requested by me".
  const person = asked && !(mine && asked === me.id) ? asked : undefined;
  return { where, mine, status, person };
}

const ADVANCE_SORTS = ['number', 'requestDate', 'amount', 'liquidationDueDate', 'createdAt'];

advanceRoutes.get(
  '/',
  requireAny('gfin.cash_advances.view_all', 'gfin.cash_advances.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const today = dayKey(new Date());
    const { where } = advanceListWhere(me, q, today);

    const [rows, total] = await Promise.all([
      prisma.cashAdvance.findMany({
        where,
        include: advanceInclude,
        orderBy: orderBy(q, ADVANCE_SORTS, { requestDate: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.cashAdvance.count({ where }),
    ]);
    const [steps, summary] = await Promise.all([openSteps('cash_advance', rows.map((r) => r.id)), advanceListSummary(where)]);

    res.json({
      ...listResult(
        rows.map((r) => {
          const row = presentAdvance(r, today);
          return { ...row, stage: advanceStage(r.status, steps.get(r.id), row.toRelease > 0.005, r.repayable) };
        }),
        total,
        q,
      ),
      summary,
    });
  }),
);

/**
 * Where an advance stands in the owner's words: the open step (TL Approval …
 * CEO Approval), For Release, then — for a loan — Repaying while a balance is
 * owed and Paid once it is not; an older advance keeps its liquidation words.
 */
function advanceStage(status: string, openStep: string | undefined, toRelease: boolean, repayable: boolean): string {
  if (repayable && status === 'RELEASED') return 'Repaying';
  return stageWords(status, openStep, toRelease);
}

/**
 * The register's cards (the owner's module 7), under the list's own query:
 * the total granted (every advance still standing), the payments made on the
 * loans, and the net outstanding balance — what was released and not yet
 * repaid; plus what waits in approval and to be released.
 */
async function advanceListSummary(where: Prisma.CashAdvanceWhereInput) {
  const agg = (extra: Prisma.CashAdvanceWhereInput) =>
    prisma.cashAdvance.aggregate({ where: { AND: [where, extra] }, _count: { _all: true }, _sum: { amount: true, amountReleased: true, amountRefunded: true } });
  const [granted, loansOut, pending, toRelease] = await Promise.all([
    agg({ status: { notIn: ['DRAFT', 'REJECTED', 'CANCELLED'] } }),
    agg({ repayable: true, status: { in: ['RELEASED', 'PAID'] } }),
    agg({ status: 'PENDING_APPROVAL' }),
    agg({ status: 'APPROVED' }),
  ]);
  const owing = await agg({ repayable: true, status: 'RELEASED' });
  return {
    granted: num(granted._sum.amount),
    grantedCount: granted._count._all,
    paymentsMade: num(loansOut._sum.amountRefunded),
    outstanding: cents(num(owing._sum.amountReleased) - num(owing._sum.amountRefunded)),
    owingCount: owing._count._all,
    pending: num(pending._sum.amount),
    pendingCount: pending._count._all,
    toRelease: cents(num(toRelease._sum.amount) - num(toRelease._sum.amountReleased)),
    toReleaseCount: toRelease._count._all,
  };
}

/** An advance that will never be handed over — listed, never summed. */
const ADVANCE_CLOSED: CashAdvanceStatus[] = ['REJECTED', 'CANCELLED'];

/**
 * The cash advances on paper — the list as filtered (or the rows ticked),
 * through `advanceListWhere`, so a `view_own` holder prints only their own.
 * Asked, released and spent as the screen shows them, the deadline with how
 * late a liquidation is; the totals run over every advance the filter
 * matched, a rejected or cancelled one in brackets and not counted. Declared
 * above `/:id`, or that route swallows it.
 */
advanceRoutes.get(
  '/pdf',
  requireAny('gfin.cash_advances.view_all', 'gfin.cash_advances.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const today = dayKey(new Date());
    const { where, mine, status, person: personId } = advanceListWhere(me, q, today);
    const [rows, count, sums, closed, currency, project, person] = await Promise.all([
      prisma.cashAdvance.findMany({
        where,
        include: {
          requestedBy: { select: { name: true } },
          job: { select: { number: true } },
          costCategory: { select: { name: true } },
        },
        orderBy: orderBy(q, ADVANCE_SORTS, { requestDate: 'desc' }),
        take: LIST_CAP,
      }),
      prisma.cashAdvance.count({ where }),
      prisma.cashAdvance.aggregate({
        where: { AND: [where, { status: { notIn: ADVANCE_CLOSED } }] },
        _sum: { amount: true, amountReleased: true, amountSpent: true },
      }),
      prisma.cashAdvance.count({ where: { AND: [where, { status: { in: ADVANCE_CLOSED } }] } }),
      companyCurrency(),
      recordNamed('project', q.filters.jobId),
      recordNamed('person', personId, 'requested by'),
    ]);

    const f = q.filters;
    const reference = listReference(count, rows.length, ['cash advance', 'cash advances'], [
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
          'Requested by and purpose',
          'Dated',
          'Charged to',
          `Amount (${currency})`,
          `Released (${currency})`,
          `Spent (${currency})`,
          'Liquidate by',
          'Status',
        ],
        align: ['left', 'left', 'left', 'left', 'right', 'right', 'right', 'left', 'left'],
        rows: rows.map((r) => {
          const inSum = !ADVANCE_CLOSED.includes(r.status);
          const late = r.status === 'RELEASED' && r.liquidationDueDate ? daysBetween(r.liquidationDueDate, today) : 0;
          return [
            r.number,
            { title: r.requestedBy.name, body: r.purpose },
            formatShortDate(r.requestDate),
            r.job ? { title: r.job.number, body: r.costCategory?.name ?? undefined } : 'Overheads',
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
    sections.push(...listNotes([bracketNote(closed, ['rejected or cancelled advance', 'rejected or cancelled advances'])]));

    const pdf = await renderDocument({ title: 'Cash Advances', date: new Date(), reference, landscape: true, sections });
    await audit(
      {
        entityType: 'cash_advance',
        entityId: 'list',
        action: 'EXPORTED',
        summary: `Exported the cash advance list as PDF (${rows.length} advance(s))`,
      },
      req,
    );
    sendListPdf(res, pdf, 'cash-advances.pdf');
  }),
);

/**
 * Every advance and every claim against one job — the project workspace's
 * "Cash advances & liquidations" card. Gated on budget monitoring rather than
 * on the finance keys, because the question being asked is "what is out
 * against my budget", and lives here so jobs.ts imports nothing from finance.
 */
advanceRoutes.get(
  '/for-job/:jobId',
  require_('gops.budget_monitoring.view_all'),
  handler(async (req, res) => {
    const [advances, claims] = await Promise.all([
      prisma.cashAdvance.findMany({
        where: { jobId: req.params.jobId },
        include: advanceInclude,
        orderBy: { requestDate: 'desc' },
      }),
      prisma.expenseClaim.findMany({
        where: { jobId: req.params.jobId },
        include: claimInclude,
        orderBy: { claimDate: 'desc' },
      }),
    ]);
    res.json({ advances: advances.map((a) => presentAdvance(a)), claims: claims.map(presentClaim) });
  }),
);

/** "Submit for approval sends it to …" — at the amount on the page, in the requester's name. Above `/:id`. */
advanceRoutes.get(
  '/route',
  requireAny('gfin.cash_advances.create', 'gfin.cash_advances.edit_own', 'gfin.cash_advances.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const amount = Number(req.query.amount ?? 0);
    if (!Number.isFinite(amount) || amount < 0) throw badRequest('The amount is not a number');
    const advanceId = req.query.advanceId ? String(req.query.advanceId) : null;
    const row = advanceId ? await prisma.cashAdvance.findUnique({ where: { id: advanceId }, select: { requestedById: true } }) : null;
    if (advanceId && !row) throw notFound('Cash advance not found');
    // The advance's submit names no project: its route has no project step.
    res.json({ route: await routeBrief('cash_advance', amount, row?.requestedById ?? me.id, null, { jobId: null }) });
  }),
);

async function loadAdvance(id: string) {
  return prisma.cashAdvance.findUnique({
    where: { id },
    include: {
      ...advanceInclude,
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

function assertCanSee(me: ReturnType<typeof currentUser>, row: { requestedById: string }) {
  if (row.requestedById !== me.id && ownOnly(me)) throw forbidden('That is someone else’s advance');
}

advanceRoutes.get(
  '/:id',
  requireAny('gfin.cash_advances.view_all', 'gfin.cash_advances.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await loadAdvance(req.params.id);
    if (!row) throw notFound('Cash advance not found');
    assertCanSee(me, row);
    res.json({
      ...presentAdvance(row),
      allocations: row.allocations.map((a) => ({ ...a, amount: num(a.amount) })),
    });
  }),
);

const advanceSchema = z.object({
  jobId: z.string().optional().nullable(),
  costCategoryId: z.string().optional().nullable(),
  requestDate: z.string().optional(),
  neededBy: z.string().optional().nullable(),
  purpose: z.string().trim().min(3, 'What is the cash for?'),
  /** Typed only for an advance with no breakdown; with lines, their sum is the amount. */
  amount: z.number().positive('The advance must be more than zero').optional(),
  items: z.array(requestItemSchema).max(200).optional(),
  notes: z.string().optional().nullable(),
});

function asDate(value: string, label: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw badRequest(`${label} is not a valid date`);
  return dayKey(date);
}

/**
 * Naming a project means naming a budget line: the liquidation that follows
 * charges exactly that line, and it is too late to ask by then.
 */
function checkCharging(body: { jobId?: string | null; costCategoryId?: string | null }) {
  if (body.jobId && !body.costCategoryId) {
    throw badRequest('An advance charged to a project needs a budget line');
  }
}

advanceRoutes.post(
  '/',
  require_('gfin.cash_advances.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(advanceSchema, req.body);
    checkCharging(body);
    const money = requestMoney(body.items, body.amount);

    // One advance at a time: a person still holding unaccounted cash does not
    // get more until the receipts are in. Finance can switch this off.
    const settings = await financeSettings();
    if (settings.blockAdvanceWhileUnliquidated) {
      const open = await prisma.cashAdvance.findFirst({
        where: { requestedById: me.id, status: 'RELEASED' },
        select: { number: true, repayable: true },
      });
      if (open) {
        throw badRequest(
          open.repayable
            ? `${open.number} has not been repaid yet. Repay it before asking for another advance.`
            : `${open.number} has not been liquidated yet. File its receipts before asking for another advance.`,
        );
      }
    }

    const advance = await prisma.$transaction(async (tx) => {
      const number = await nextNumber('cash_advance', tx);
      return tx.cashAdvance.create({
        data: {
          number,
          requestedById: me.id,
          jobId: body.jobId || null,
          costCategoryId: body.jobId ? body.costCategoryId || null : null,
          requestDate: body.requestDate ? asDate(body.requestDate, 'Request date') : dayKey(new Date()),
          neededBy: body.neededBy ? asDate(body.neededBy, 'Needed by') : null,
          purpose: body.purpose,
          amount: D(money.amount),
          notes: body.notes || null,
          items: money.lines.length ? { create: money.lines } : undefined,
          // Money lent (2026-10-15): repaid in instalments, never liquidated.
          repayable: true,
        },
        include: advanceInclude,
      });
    });

    await audit(
      {
        entityType: 'cash_advance',
        entityId: advance.id,
        action: 'CREATED',
        summary: `${advance.number} — ${cents(money.amount)} requested for ${body.purpose}`,
      },
      req,
    );
    res.status(201).json(presentAdvance(advance));
  }),
);

advanceRoutes.put(
  '/:id',
  requireAny('gfin.cash_advances.edit_own', 'gfin.cash_advances.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(advanceSchema, req.body);
    checkCharging(body);
    const existing = await prisma.cashAdvance.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('Cash advance not found');
    if (!canEditRecord(me, 'gfin', 'cash_advances', existing.requestedById)) {
      throw forbidden('Only the person who asked for this advance can change it');
    }
    if (existing.status !== 'DRAFT') throw badRequest('Only a draft can be changed — this one has been submitted');
    // Sent without lines, the breakdown on file stays and the typed amount
    // counts only where there is none.
    const kept = body.items === undefined ? await prisma.cashAdvanceItem.count({ where: { advanceId: existing.id } }) : 0;
    const money = kept ? null : requestMoney(body.items, body.amount ?? num(existing.amount));

    const advance = await prisma.$transaction(async (tx) => {
      const claimed = await tx.cashAdvance.updateMany({
        where: { id: existing.id, status: 'DRAFT' },
        data: {
          jobId: body.jobId || null,
          costCategoryId: body.jobId ? body.costCategoryId || null : null,
          requestDate: body.requestDate ? asDate(body.requestDate, 'Request date') : existing.requestDate,
          neededBy: body.neededBy ? asDate(body.neededBy, 'Needed by') : null,
          purpose: body.purpose,
          ...(money ? { amount: D(money.amount) } : {}),
          notes: body.notes || null,
        },
      });
      if (!claimed.count) throw badRequest('It was submitted a moment ago — reload to see it');
      if (money && body.items !== undefined) {
        await tx.cashAdvanceItem.deleteMany({ where: { advanceId: existing.id } });
        if (money.lines.length) {
          await tx.cashAdvanceItem.createMany({ data: money.lines.map((l) => ({ ...l, advanceId: existing.id })) });
        }
      }
      return tx.cashAdvance.findUniqueOrThrow({ where: { id: existing.id }, include: advanceInclude });
    });
    await audit(
      { entityType: 'cash_advance', entityId: advance.id, action: 'UPDATED', summary: `${advance.number} changed` },
      req,
    );
    res.json(presentAdvance(advance));
  }),
);

/**
 * Submitting. No budget guard and nothing committed: an approved advance is
 * cash promised to a person, not cost promised to a project. The project
 * hears about it when the liquidation posts.
 */
advanceRoutes.post(
  '/:id/submit',
  require_('gfin.cash_advances.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const advance = await prisma.cashAdvance.findUnique({
      where: { id: req.params.id },
      include: { requestedBy: { select: { name: true } } },
    });
    if (!advance) throw notFound('Cash advance not found');
    if (advance.requestedById !== me.id && !me.isSuperAdmin) throw forbidden('That is someone else’s advance');
    if (advance.status !== 'DRAFT') throw badRequest('This advance has already been submitted');

    // Claimed on the advance exactly as read — still a draft, and not changed
    // since — never simply written: two Submit clicks file once, and a Modify
    // that lands in between refuses the submit rather than sending a request
    // that snapshots the old amount.
    const claimed = await prisma.cashAdvance.updateMany({
      where: { id: advance.id, status: 'DRAFT', updatedAt: advance.updatedAt },
      data: { status: 'PENDING_APPROVAL' },
    });
    if (!claimed.count) throw badRequest('It changed a moment ago — reload to see where it stands');
    try {
      await submitForApproval({
        documentType: 'cash_advance',
        documentId: advance.id,
        documentNumber: advance.number,
        subject: `${advance.requestedBy.name} — ${advance.purpose}`,
        amount: num(advance.amount),
        link: `/g-fin/cash-advances/${advance.id}`,
        // The requester, even when a super admin presses the button for
        // them: the route runs on THEIR supervisor, the self-approval rule
        // has to see whose advance this is, and the draft's paper previews
        // exactly this route.
        requesterId: advance.requestedById,
      });
    } catch (err) {
      // The engine refused (no workflow, a self-approval trap). The document
      // goes back to where it was rather than sitting PENDING with no request.
      await prisma.cashAdvance.updateMany({ where: { id: advance.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
      throw err;
    }

    await audit(
      { entityType: 'cash_advance', entityId: advance.id, action: 'SUBMITTED', summary: `${advance.number} sent for approval` },
      req,
    );
    res.json({ ok: true });
  }),
);

/**
 * Approval moves no money. APPROVED means finance may now hand the cash over;
 * the release is a disbursement allocated to the advance, and the status
 * moves to RELEASED when `refreshAdvance()` sees it. Exported so the test can
 * call it twice — the status guard is what makes the second call a no-op.
 */
export const settleAdvance = async (approval: ApprovalRequest, outcome: ApprovalOutcome) => {
  const advance = await prisma.cashAdvance.findUnique({
    where: { id: approval.documentId },
    include: { requestedBy: { select: { name: true } } },
  });
  if (!advance) return;
  if (advance.status !== 'PENDING_APPROVAL') return;

  if (outcome !== 'APPROVED') {
    await prisma.cashAdvance.update({ where: { id: advance.id }, data: { status: 'REJECTED' } });
    await audit({
      entityType: 'cash_advance',
      entityId: advance.id,
      action: 'REJECTED',
      summary: `${advance.number} rejected — nothing released`,
    });
    return;
  }

  await prisma.cashAdvance.update({
    where: { id: advance.id },
    data: { status: 'APPROVED', approvedAt: new Date() },
  });
  // The engine already tells the requester (approval.approved); finance finds
  // it in the "awaiting release" queue on the dashboard.
  await audit({
    entityType: 'cash_advance',
    entityId: advance.id,
    action: 'APPROVED',
    summary: `${advance.number} approved — ${num(advance.amount)} to release to ${advance.requestedBy.name}; nothing charged until liquidated`,
  });
};
onApprovalSettled('cash_advance', settleAdvance);

/**
 * Pulled back after approval (2026-10-16): back to DRAFT while finance has
 * released nothing. Approval moved no money and charged nothing, so there is
 * nothing to undo — only refused once cash has gone out on it.
 */
onApprovalReopened('cash_advance', {
  may: async (actor, id) => {
    const row = await prisma.cashAdvance.findUnique({ where: { id }, select: { status: true, requestedById: true } });
    return !!row && !['DRAFT', 'PENDING_APPROVAL', 'REJECTED', 'CANCELLED'].includes(row.status) && canEditRecord(actor, 'gfin', 'cash_advances', row.requestedById);
  },
  reopen: async ({ documentId, tx, actor }) => {
    const row = await tx.cashAdvance.findUnique({ where: { id: documentId } });
    if (!row) throw badRequest('Not found');
    const paid = await tx.paymentAllocation.findFirst({ where: { advanceId: row.id }, include: { payment: { select: { number: true } } } });
    if (paid || row.status !== 'APPROVED') {
      throw badRequest(`${row.number} has been released${paid ? ` (${paid.payment.number})` : ''} — remove the release before pulling it back`);
    }
    const claimed = await tx.cashAdvance.updateMany({ where: { id: row.id, status: 'APPROVED' }, data: { status: 'DRAFT', approvedAt: null } });
    if (!claimed.count) throw badRequest(`${row.number} changed a moment ago — reload to see where it stands`);
    await audit(
      { entityType: 'cash_advance', entityId: row.id, action: 'UPDATED', summary: `${row.number} back to draft after approval — nothing had been released`, actorId: actor.id, actorName: actor.name },
      undefined,
      tx,
    );
  },
});

advanceRoutes.post(
  '/:id/cancel',
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(z.object({ reason: z.string().trim().optional().nullable() }), req.body ?? {});
    const advance = await prisma.cashAdvance.findUnique({ where: { id: req.params.id } });
    if (!advance) throw notFound('Cash advance not found');

    const mine = advance.requestedById === me.id;
    const editAll = me.isSuperAdmin || me.permissions.has('gfin.cash_advances.edit_all');
    if (advance.status === 'DRAFT' || advance.status === 'PENDING_APPROVAL') {
      if (!mine && !editAll) throw forbidden('That is someone else’s advance');
    } else if (advance.status === 'APPROVED' && num(advance.amountReleased) <= 0.005) {
      if (!mine && !editAll) throw forbidden('That is someone else’s advance');
    } else if (advance.status === 'CANCELLED' || advance.status === 'REJECTED') {
      throw badRequest(`This advance is already ${advance.status.toLowerCase()}`);
    } else {
      throw badRequest('Cash has been released — liquidate it instead.');
    }

    await prisma.$transaction(async (tx) => {
      await tx.cashAdvance.update({
        where: { id: advance.id },
        data: { status: 'CANCELLED', notes: body.reason ? `${advance.notes ? `${advance.notes}\n` : ''}Cancelled: ${body.reason}` : advance.notes },
      });
      // Still with the approver: withdrawn through the engine, so it leaves
      // their queue and they are told.
      await cancelOpenRequest(
        'cash_advance',
        advance.id,
        tx,
        `cancelled by ${me.name}${body.reason ? `: ${body.reason}` : ''}`,
        me.id,
      );
    });
    await audit(
      {
        entityType: 'cash_advance',
        entityId: advance.id,
        action: 'CANCELLED',
        summary: `${advance.number} cancelled${body.reason ? ` — ${body.reason}` : ''}`,
      },
      req,
    );
    res.json({ ok: true });
  }),
);

/**
 * The advance on paper — the same document as a budget request, through the
 * same builders (`cashRequestSections` / `cashRequestSignatories`): the
 * request, its money as a totals block, the liquidation, and the sign-offs
 * of the route it took (or would take, while a draft).
 */
advanceRoutes.get(
  '/:id/pdf',
  requireAny('gfin.cash_advances.view_all', 'gfin.cash_advances.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await loadAdvance(req.params.id);
    if (!row) throw notFound('Cash advance not found');
    assertCanSee(me, row);
    const view = presentAdvance(row);

    const release = row.allocations.find((a) => a.payment.kind === 'DISBURSEMENT');
    const sections = cashRequestSections({
      requestedBy: row.requestedBy.name,
      neededBy: row.neededBy,
      project: row.job ? `${row.job.number} — ${row.job.name}` : 'Overheads',
      budgetLine: row.costCategory?.name ?? '—',
      status: row.status,
      purpose: row.purpose,
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

    const pdf = await renderDocument({
      title: 'Cash Advance',
      documentNumber: row.number,
      date: row.requestDate,
      reference: row.purpose,
      sections,
      signatories: await cashRequestSignatories({
        documentType: 'cash_advance',
        id: row.id,
        status: row.status,
        amount: view.amount,
        requester: row.requestedBy,
        // The advance's submit names no project: its route has no project step.
        jobId: null,
        raisedAt: row.createdAt,
        releasedOn: release?.createdAt ?? null,
      }),
    });

    await audit(
      { entityType: 'cash_advance', entityId: row.id, action: 'EXPORTED', summary: `Printed ${row.number}` },
      req,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition(paperFileName({ kind: 'Cash Advance', number: row.number, author: row.requestedBy.name, date: row.requestDate })));
    res.send(pdf);
  }),
);

registerSearch({
  kind: 'cash_advance',
  label: 'Cash advances',
  permission: ['gfin.cash_advances.view_all', 'gfin.cash_advances.view_own'],
  ownWhere: (user) => ({ requestedById: user.id }),
  async search(term, _user, limit, own) {
    const rows = await prisma.cashAdvance.findMany({
      where: {
        ...(own ?? {}),
        OR: [
          { number: { contains: term, mode: 'insensitive' } },
          { purpose: { contains: term, mode: 'insensitive' } },
          { requestedBy: { name: { contains: term, mode: 'insensitive' } } },
        ],
      },
      select: { id: true, number: true, purpose: true, status: true, requestedBy: { select: { name: true } } },
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      kind: 'cash_advance',
      id: r.id,
      title: `${r.number} — ${r.purpose}`,
      subtitle: `${r.requestedBy.name} · ${r.status.toLowerCase().replace(/_/g, ' ')}`,
      link: `/g-fin/cash-advances/${r.id}`,
    }));
  },
});
