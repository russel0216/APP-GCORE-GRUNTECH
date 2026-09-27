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
  notFound,
  badRequest,
  forbidden,
} from '../http/kit';
import { authenticate, require_, requireAny, currentUser } from '../auth/middleware';
import { canEditRecord } from '../permissions/resolve';
import { audit } from '../shared/audit';
import { nextNumber } from '../shared/numbering';
import { submitForApproval, onApprovalSettled, approvalSignoffs, type ApprovalOutcome } from '../shared/approvals';
import { registerSearch } from '../shared/search';
import { renderDocument, formatMoney, formatDate, type PdfSection } from '../shared/pdf';
import { cents, D, num, dayKey, daysBetween, financeSettings } from '../shared/finance';
import { claimInclude, presentClaim } from './finance';

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
  requestedBy: { select: { id: true, name: true, email: true, position: true } },
  job: { select: { id: true, number: true, name: true } },
  costCategory: { select: { id: true, name: true } },
  liquidations: {
    select: { id: true, number: true, status: true, total: true, claimDate: true, approvedAt: true },
    orderBy: { createdAt: 'desc' },
  },
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
  return {
    ...row,
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
    liquidation: liquidation ? { ...liquidation, total: num(liquidation.total) } : null,
    liquidations: row.liquidations.map((l) => ({ ...l, total: num(l.total) })),
  };
}

function ownOnly(me: ReturnType<typeof currentUser>): boolean {
  return !me.isSuperAdmin && !me.permissions.has('gfin.cash_advances.view_all');
}

advanceRoutes.get(
  '/',
  requireAny('gfin.cash_advances.view_all', 'gfin.cash_advances.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const where: Prisma.CashAdvanceWhereInput = {};
    const today = dayKey(new Date());

    if (ownOnly(me) || q.scope === 'mine') where.requestedById = me.id;
    const status = q.filters.status && q.filters.status in CashAdvanceStatus ? (q.filters.status as CashAdvanceStatus) : undefined;
    if (status) where.status = status;
    if (q.filters.jobId) where.jobId = q.filters.jobId;
    if (q.filters.requestedById) where.requestedById = q.filters.requestedById;
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

    const [rows, total] = await Promise.all([
      prisma.cashAdvance.findMany({
        where,
        include: advanceInclude,
        orderBy: orderBy(q, ['number', 'requestDate', 'amount', 'liquidationDueDate', 'createdAt'], { requestDate: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.cashAdvance.count({ where }),
    ]);

    res.json(listResult(rows.map((r) => presentAdvance(r, today)), total, q));
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
  amount: z.number().positive('The advance must be more than zero'),
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

    // One advance at a time: a person still holding unaccounted cash does not
    // get more until the receipts are in. Finance can switch this off.
    const settings = await financeSettings();
    if (settings.blockAdvanceWhileUnliquidated) {
      const open = await prisma.cashAdvance.findFirst({
        where: { requestedById: me.id, status: 'RELEASED' },
        select: { number: true },
      });
      if (open) {
        throw badRequest(`${open.number} has not been liquidated yet. File its receipts before asking for another advance.`);
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
          amount: D(body.amount),
          notes: body.notes || null,
        },
        include: advanceInclude,
      });
    });

    await audit(
      {
        entityType: 'cash_advance',
        entityId: advance.id,
        action: 'CREATED',
        summary: `${advance.number} — ${cents(body.amount)} requested for ${body.purpose}`,
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

    const advance = await prisma.cashAdvance.update({
      where: { id: existing.id },
      data: {
        jobId: body.jobId || null,
        costCategoryId: body.jobId ? body.costCategoryId || null : null,
        requestDate: body.requestDate ? asDate(body.requestDate, 'Request date') : existing.requestDate,
        neededBy: body.neededBy ? asDate(body.neededBy, 'Needed by') : null,
        purpose: body.purpose,
        amount: D(body.amount),
        notes: body.notes || null,
      },
      include: advanceInclude,
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
    const advance = await prisma.cashAdvance.findUnique({ where: { id: req.params.id } });
    if (!advance) throw notFound('Cash advance not found');
    if (advance.requestedById !== me.id && !me.isSuperAdmin) throw forbidden('That is someone else’s advance');
    if (advance.status !== 'DRAFT') throw badRequest('This advance has already been submitted');

    await prisma.cashAdvance.update({ where: { id: advance.id }, data: { status: 'PENDING_APPROVAL' } });
    try {
      await submitForApproval({
        documentType: 'cash_advance',
        documentId: advance.id,
        documentNumber: advance.number,
        subject: `${me.name} — ${advance.purpose}`,
        amount: num(advance.amount),
        link: `/g-fin/cash-advances/${advance.id}`,
        requesterId: me.id,
      });
    } catch (err) {
      // The engine refused (no workflow, a self-approval trap). The document
      // goes back to where it was rather than sitting PENDING with no request.
      await prisma.cashAdvance.update({ where: { id: advance.id }, data: { status: 'DRAFT' } });
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
      await tx.approvalRequest.updateMany({
        where: { documentType: 'cash_advance', documentId: advance.id, status: 'PENDING' },
        data: { status: 'CANCELLED', closedAt: new Date() },
      });
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
    const sections: PdfSection[] = [
      {
        kind: 'fields',
        columns: 3,
        fields: [
          { label: 'Requested by', value: row.requestedBy.name },
          { label: 'Date', value: formatDate(row.requestDate) },
          { label: 'Needed by', value: row.neededBy ? formatDate(row.neededBy) : '—' },
          { label: 'Project', value: row.job ? `${row.job.number} — ${row.job.name}` : 'Overheads' },
          { label: 'Budget line', value: row.costCategory?.name ?? '—' },
          { label: 'Status', value: row.status.replace(/_/g, ' ') },
        ],
      },
      { kind: 'text', title: 'Purpose', body: row.purpose },
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
                view.excessDue > 0
                  ? ['Excess owed to requester', formatMoney(view.excessDue)]
                  : ['Unspent — owed back', formatMoney(view.refundDue)],
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

    const signoffs = await approvalSignoffs('cash_advance', row.id);
    const pdf = await renderDocument({
      title: 'Cash Advance',
      documentNumber: row.number,
      date: row.requestDate,
      reference: row.purpose,
      sections,
      signatories: [
        { role: 'Requested by', name: row.requestedBy.name, position: row.requestedBy.position ?? undefined, at: row.createdAt },
        // The two approval steps, in order: supervisor, then finance.
        { role: 'Checked by', ...signoffs[0] },
        { role: 'Approved by', ...signoffs[1] },
        { role: 'Received by', ...(release ? { name: row.requestedBy.name, position: row.requestedBy.position ?? undefined, at: release.payment.paymentDate } : {}) },
      ],
    });

    await audit(
      { entityType: 'cash_advance', entityId: row.id, action: 'EXPORTED', summary: `Printed ${row.number}` },
      req,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${row.number}.pdf"`);
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
