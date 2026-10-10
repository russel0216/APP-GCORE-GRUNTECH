import { Router } from 'express';
import { z } from 'zod';
import { Prisma, RequestStatus, type ApprovalRequest } from '@prisma/client';
import { prisma } from '../prisma';
import { handler, parseBody, listQuery, listResult, orderBy, notFound, badRequest, forbidden } from '../http/kit';
import { authenticate, require_, requireAny, currentUser } from '../auth/middleware';
import { canEditRecord } from '../permissions/resolve';
import { audit } from '../shared/audit';
import { nextNumber } from '../shared/numbering';
import { notify } from '../shared/notifications';
import {
  approvalSlots,
  cancelOpenRequest,
  onApprovalSettled,
  routePreview,
  submitForApproval,
  usersInRole,
  type ApprovalOutcome,
} from '../shared/approvals';
import { registerSearch } from '../shared/search';
import { renderDocument, formatMoney, formatDate, type PdfSection, type Signatory } from '../shared/pdf';
import { cents, D, num, dayKey, daysBetween } from '../shared/finance';
import { claimInclude, presentClaim } from './finance';

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
    select: { id: true, number: true, status: true, total: true, claimDate: true, approvedAt: true },
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
    liquidation: liquidation ? { ...liquidation, total: num(liquidation.total) } : null,
    liquidations: row.liquidations.map((l) => ({ ...l, total: num(l.total) })),
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
  if (!seesAll(me) || q.scope === 'mine') where.requestedById = me.id;
  if (q.filters.jobId) where.jobId = q.filters.jobId;
  const status = q.filters.status && q.filters.status in RequestStatus ? (q.filters.status as RequestStatus) : undefined;
  if (status) where.status = status;
  if (q.filters.requestedById) where.requestedById = q.filters.requestedById;
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
  return where;
}

const LIST_PERMISSIONS = ['gops.budget_requests.view_all', 'gops.budget_requests.view_own', 'gfin.budget_requests.view_all'];

budgetRequestRoutes.get(
  '/',
  requireAny(...LIST_PERMISSIONS),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const today = dayKey(new Date());
    const where = budgetRequestListWhere(me, q, today);
    const [rows, total] = await Promise.all([
      prisma.budgetRequest.findMany({
        where,
        include: requestInclude,
        orderBy: orderBy(q, ['number', 'amount', 'createdAt', 'neededBy', 'liquidationDueDate'], { createdAt: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.budgetRequest.count({ where }),
    ]);
    res.json(listResult(rows.map((r) => presentBudgetRequest(r, today)), total, q));
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

/** The request on house-style paper, with the PM and finance sign-offs and who received the cash. */
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
    const sections: PdfSection[] = [
      {
        kind: 'fields',
        columns: 3,
        fields: [
          { label: 'Requested by', value: row.requestedBy.name },
          { label: 'Date', value: formatDate(row.createdAt) },
          { label: 'Needed by', value: row.neededBy ? formatDate(row.neededBy) : '—' },
          { label: 'Project', value: `${row.job.number} — ${row.job.name}` },
          { label: 'Budget line', value: row.costCategory.name },
          { label: 'Status', value: row.status.replace(/_/g, ' ') },
        ],
      },
      { kind: 'text', title: 'Purpose', body: row.reason },
      {
        kind: 'table',
        head: ['', ''],
        widths: [72, 28],
        align: ['right', 'right'],
        rows: [
          ['AMOUNT REQUESTED', formatMoney(view.amount)],
          ['Released', release ? `${formatMoney(view.amountReleased)} on ${release.payment.number}, ${formatDate(release.payment.paymentDate)}` : 'Not yet released'],
          ['Liquidate by', row.liquidationDueDate ? formatDate(row.liquidationDueDate) : '—'],
          ...(row.liquidatedAt
            ? [
                ['Spent (per liquidation)', formatMoney(view.spent)],
                view.excessDue > 0 ? ['Excess owed to requester', formatMoney(view.excessDue)] : ['Unspent — owed back', formatMoney(view.refundDue)],
                ['Refunded', formatMoney(view.amountRefunded)],
              ]
            : []),
        ],
      },
    ];
    if (view.liquidation) {
      sections.push({
        kind: 'fields',
        title: 'Liquidation',
        columns: 3,
        fields: [
          { label: 'Report', value: view.liquidation.number },
          { label: 'Status', value: view.liquidation.status.replace(/_/g, ' ') },
          { label: 'Total receipts', value: formatMoney(view.liquidation.total) },
        ],
      });
    }
    if (row.notes) sections.push({ kind: 'text', title: 'Notes', body: row.notes });
    if (row.cancelReason) sections.push({ kind: 'text', title: 'Cancelled', body: row.cancelReason });

    // Every step of the route: who signed and when, or who may yet — "Pending".
    const slots = await approvalSlots(
      'budget_request',
      row.id,
      row.status === 'DRAFT' ? { amount: num(row.amount), requesterId: row.requestedById, jobId: row.jobId } : undefined,
    );
    const stepSignatories: Signatory[] = slots.length
      ? slots.map((sl) => {
          const role = `Approved by — ${sl.step}`;
          if (sl.name) return { role, name: sl.name, position: sl.position, at: sl.at };
          const who = sl.assigned ?? [];
          if (who.length === 1) return { role, name: who[0].name, position: who[0].position };
          return who.length > 1 ? { role, name: who.map((p) => p.name).join(' or ') } : { role };
        })
      : [{ role: 'Approved by — Project Manager' }, { role: 'Approved by — Finance' }];
    const pdf = await renderDocument({
      title: 'Budget Request',
      documentNumber: row.number,
      date: row.createdAt,
      reference: `${row.job.number} — ${row.reason}`,
      sections,
      signatories: [
        { role: 'Requested by', name: row.requestedBy.name, position: row.requestedBy.position ?? undefined, at: row.createdAt },
        ...stepSignatories,
        {
          role: 'Received by',
          ...(release ? { name: row.requestedBy.name, position: row.requestedBy.position ?? undefined, at: release.payment.paymentDate } : {}),
        },
      ],
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
