import { Router } from 'express';
import { z } from 'zod';
import { Prisma, RequestStatus, type ApprovalRequest } from '@prisma/client';
import { prisma } from '../prisma';
import { handler, parseBody, listQuery, listResult, orderBy, idsFilter, notFound, badRequest, forbidden } from '../http/kit';
import { authenticate, require_, requireAny, currentUser } from '../auth/middleware';
import { canEditRecord } from '../permissions/resolve';
import { audit } from '../shared/audit';
import { nextNumber } from '../shared/numbering';
import { notify } from '../shared/notifications';
import {
  cancelOpenRequest,
  onApprovalSettled,
  routePreview,
  submitForApproval,
  usersInRole,
  type ApprovalOutcome,
} from '../shared/approvals';
import { registerSearch } from '../shared/search';
import { renderDocument, formatMoney, formatAmount, formatShortDate, statusLabel, companyCurrency, type PdfSection } from '../shared/pdf';
import { cents, D, num, dayKey, daysBetween } from '../shared/finance';
import {
  claimInclude,
  presentClaim,
  cashRequestSections,
  cashRequestSignatories,
  LIST_CAP,
  listReference,
  bracketed,
  totalLabel,
  bracketNote,
  listNotes,
  recordNamed,
  sendListPdf,
} from './finance';

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
  requestedBy: { select: { id: true, name: true, email: true, position: true } },
  liquidations: {
    select: { id: true, number: true, status: true, total: true, amountPaid: true, claimDate: true, approvedAt: true },
    orderBy: { createdAt: 'desc' },
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
  return {
    ...row,
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
  };
}

type Me = ReturnType<typeof currentUser>;

/** Everyone's requests: the project side's view_all, or finance's. */
function seesAll(me: Me): boolean {
  return me.isSuperAdmin || me.permissions.has('gops.budget_requests.view_all') || me.permissions.has('gfin.budget_requests.view_all');
}

/**
 * A single request is readable by anyone who sees them all, by whoever raised
 * it, and by the project's manager — who is asked to decide it and must be
 * able to open what they decide.
 */
function assertCanSee(me: Me, row: { requestedById: string; job: { projectManager: { id: string } | null } }) {
  if (seesAll(me)) return;
  if (row.requestedById === me.id) return;
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
  if (mine) people.push({ requestedById: me.id });
  if (asked) people.push({ requestedById: asked });
  if (people.length) where.AND = people;
  if (q.filters.jobId) where.jobId = q.filters.jobId;
  const status = q.filters.status && q.filters.status in RequestStatus ? (q.filters.status as RequestStatus) : undefined;
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

const LIST_PERMISSIONS = ['gops.budget_requests.view_all', 'gops.budget_requests.view_own', 'gfin.budget_requests.view_all'];

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
    res.json(listResult(rows.map((r) => presentBudgetRequest(r, today)), total, q));
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

budgetRequestRoutes.get(
  '/:id',
  requireAny(...LIST_PERMISSIONS),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await loadRequest(req.params.id);
    if (!row) throw notFound('Budget request not found');
    assertCanSee(me, row);
    // The route a draft WOULD take — the project's manager, then finance —
    // named before anybody presses Submit (names only).
    const route =
      row.status === 'DRAFT'
        ? await routePreview('budget_request', num(row.amount), row.requestedById, null, { jobId: row.jobId })
        : null;
    res.json({
      ...presentBudgetRequest(row),
      allocations: row.allocations.map((a) => ({ ...a, amount: num(a.amount) })),
      canEdit: row.status === 'DRAFT' && canEditRecord(me, 'gops', 'budget_requests', row.requestedById),
      approvalRoute: route
        ? { name: route.name, steps: route.steps.map((st) => ({ name: st.name, approvers: st.approvers.map((p) => ({ id: p.id, name: p.name })) })) }
        : null,
    });
  }),
);

const requestSchema = z.object({
  jobId: z.string().min(1, 'Which project?'),
  costCategoryId: z.string().min(1, 'Which budget line?'),
  amount: z.number().positive('A budget request must be for more than zero'),
  reason: z.string().trim().min(3, 'What is the cash for?'),
  neededBy: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

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

    const request = await prisma.$transaction(async (tx) => {
      const number = await nextNumber('budget_request', tx);
      return tx.budgetRequest.create({
        data: {
          number,
          jobId: body.jobId,
          costCategoryId: body.costCategoryId,
          amount: D(body.amount),
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
        summary: `Raised ${request.number} — ${cents(body.amount)} for ${job.number}: ${body.reason}`,
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

    const request = await prisma.budgetRequest.update({
      where: { id: existing.id },
      data: {
        costCategoryId: body.costCategoryId,
        amount: D(body.amount),
        reason: body.reason,
        neededBy: body.neededBy ? asDate(body.neededBy, 'Needed by') : null,
        notes: body.notes || null,
      },
      include: requestInclude,
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
    try {
      await submitForApproval({
        documentType: 'budget_request',
        documentId: request.id,
        documentNumber: request.number,
        subject: `${request.job.number} — ${request.costCategory.name}: ${request.reason}`,
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
    if (request.status !== 'DRAFT') throw badRequest('Only a draft can be deleted — cancel it instead');
    await prisma.budgetRequest.delete({ where: { id: request.id } });
    await audit({ entityType: 'budget_request', entityId: request.id, action: 'DELETED', summary: `Deleted draft ${request.number}`, before: request }, req);
    res.json({ ok: true });
  }),
);

/**
 * The request on paper — the same document as a cash advance, through the
 * same builders (`cashRequestSections` / `cashRequestSignatories`): the
 * request, its money as a totals block, the liquidation, and every step of
 * its route by the step's own name — the project's manager, then finance —
 * with who received the cash once it is out.
 */
budgetRequestRoutes.get(
  '/:id/pdf',
  requireAny(...LIST_PERMISSIONS),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await loadRequest(req.params.id);
    if (!row) throw notFound('Budget request not found');
    assertCanSee(me, row);
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
    if (row.cancelReason) sections.push({ kind: 'text', title: 'Cancelled', body: row.cancelReason });

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
    res.setHeader('Content-Disposition', `inline; filename="${row.number}.pdf"`);
    res.send(pdf);
  }),
);

/** The liquidation claims against one request, for its page — the ordinary claim rows. */
budgetRequestRoutes.get(
  '/:id/liquidations',
  requireAny(...LIST_PERMISSIONS),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await prisma.budgetRequest.findUnique({
      where: { id: req.params.id },
      select: { id: true, requestedById: true, job: { select: { projectManager: { select: { id: true } } } } },
    });
    if (!row) throw notFound('Budget request not found');
    assertCanSee(me, row);
    const claims = await prisma.expenseClaim.findMany({ where: { budgetRequestId: row.id }, include: claimInclude, orderBy: { claimDate: 'desc' } });
    res.json({ rows: claims.map(presentClaim) });
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
