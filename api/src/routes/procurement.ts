import { Router } from 'express';
import { z } from 'zod';
import { Prisma, PrStatus, PurchaseKind, PoStatus, CanvassStatus } from '@prisma/client';
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
import { registerSearch } from '../shared/search';
import { nextNumber } from '../shared/numbering';
import {
  submitForApproval,
  onApprovalSettled,
  approvalSlots,
  slotSignatories,
  contactOf,
  cancelOpenRequest,
  type ApprovalOutcome,
} from '../shared/approvals';
import {
  renderDocument,
  formatMoney,
  formatAmount,
  formatDate,
  formatShortDate,
  statusLabel,
  companyCurrency,
  type PdfSection,
  type Signatory,
} from '../shared/pdf';
import { manilaDate } from '../shared/day';
import { LIST_CAP, listReference, totalLabel, bracketed, counted, bracketNote, listNotes, recordNamed, choice, sendListPdf, ratePct } from '../shared/listPaper';
import {
  postJobCost,
  releaseCommitment,
  availableBudget,
  overBudgetIsBlocked,
} from '../shared/inventory';

const D = (v: number | string | null | undefined) =>
  v === null || v === undefined ? new Prisma.Decimal(0) : new Prisma.Decimal(v);
const num = (v: Prisma.Decimal | null | undefined) => (v == null ? 0 : Number(v));
const cents = (n: number) => Math.round(n * 100) / 100;

function asDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const date = new Date(v);
  if (Number.isNaN(date.getTime())) throw badRequest(`"${v}" is not a valid date`);
  return date;
}

// ── The printed lists ────────────────────────────────────────────────────────
//
// Every register here has a printed twin, `GET <list>/pdf` above `/:id`: the
// SAME where-builder the list reads (with `?ids=`, the rows ticked, ANDed
// with the visibility rule), the list's own sort, at most LIST_CAP rows, a
// reference that names every filter that narrowed it, and an EXPORTED audit
// row with entityId 'list' (rule 6, A5). The helpers are shared/listPaper.

// ════════════════════════════════════════════════════════════════════
//  PURCHASE REQUESTS
// ════════════════════════════════════════════════════════════════════

export const purchaseRequestRoutes = Router();
purchaseRequestRoutes.use(authenticate);

function presentPr(pr: Record<string, unknown>) {
  const items = (pr.items ?? []) as Record<string, unknown>[];
  return {
    ...pr,
    items: items.map((i) => ({
      ...i,
      quantity: num(i.quantity as Prisma.Decimal),
      estimatedCost: num(i.estimatedCost as Prisma.Decimal),
      estimatedAmount: num(i.estimatedAmount as Prisma.Decimal),
      orderedQty: num(i.orderedQty as Prisma.Decimal),
    })),
    estimatedTotal: items.reduce((s, i) => s + num(i.estimatedAmount as Prisma.Decimal), 0),
  };
}

const PR_SORTS = ['number', 'neededBy', 'createdAt'];

/**
 * Which purchase requests a list query means — ONE rule for the list and its
 * printed twin. A `view_own` holder sees their own requests whatever the
 * scope says (`mine` is then true), exactly as `chainOverview()` counts them.
 */
function prListWhere(me: ResolvedUser, q: ListQuery): { where: Prisma.PurchaseRequestWhereInput; mine: boolean } {
  const and: Prisma.PurchaseRequestWhereInput[] = [];
  const onlyOwn = !me.isSuperAdmin && !me.permissions.has('gchain.purchase_requests.view_all');
  const mine = onlyOwn || q.scope === 'mine';
  if (mine) and.push({ requestedById: me.id });
  const f = q.filters;
  const status = choice(f.status, PrStatus, 'Status');
  if (status) and.push({ status });
  const kind = choice(f.kind, PurchaseKind, 'Type');
  if (kind) and.push({ kind });
  if (f.jobId) and.push({ jobId: f.jobId });
  if (q.search) {
    and.push({
      OR: [
        { number: { contains: q.search, mode: 'insensitive' } },
        { purpose: { contains: q.search, mode: 'insensitive' } },
        { job: { name: { contains: q.search, mode: 'insensitive' } } },
      ],
    });
  }
  const ids = idsFilter(f.ids);
  if (ids) and.push({ id: { in: ids } });
  return { where: and.length ? { AND: and } : {}, mine };
}

purchaseRequestRoutes.get(
  '/',
  requireAny('gchain.purchase_requests.view_all', 'gchain.purchase_requests.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const { where } = prListWhere(me, q);

    const [rows, total] = await Promise.all([
      prisma.purchaseRequest.findMany({
        where,
        include: {
          job: { select: { id: true, number: true, name: true } },
          requestedBy: { select: { id: true, name: true } },
          warehouse: { select: { id: true, name: true } },
          items: { select: { estimatedAmount: true } },
          _count: { select: { canvasses: true, orders: true } },
        },
        orderBy: orderBy(q, PR_SORTS, { createdAt: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.purchaseRequest.count({ where }),
    ]);

    res.json(
      listResult(
        rows.map((r) => ({
          id: r.id,
          number: r.number,
          kind: r.kind,
          status: r.status,
          purpose: r.purpose,
          neededBy: r.neededBy,
          createdAt: r.createdAt,
          job: r.job,
          warehouse: r.warehouse,
          requestedBy: r.requestedBy,
          itemCount: r.items.length,
          estimatedTotal: cents(r.items.reduce((s, i) => s + num(i.estimatedAmount), 0)),
          canvassCount: r._count.canvasses,
          orderCount: r._count.orders,
        })),
        total,
        q,
      ),
    );
  }),
);

/** A request that will never be bought — listed, never summed. */
const PR_CLOSED: PrStatus[] = ['CANCELLED', 'REJECTED'];

/**
 * The purchase request list on paper — the list as filtered (or the rows
 * ticked, `?ids=`), through `prListWhere`, so the paper is the screen and a
 * `view_own` holder prints only their own. Estimates are what the screen
 * shows; the total leaves out the cancelled and rejected, whose figures print
 * in brackets. Above `/:id`.
 */
purchaseRequestRoutes.get(
  '/pdf',
  requireAny('gchain.purchase_requests.view_all', 'gchain.purchase_requests.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const { where, mine } = prListWhere(me, q);
    const [rows, count, live, closed, currency, project] = await Promise.all([
      prisma.purchaseRequest.findMany({
        where,
        include: {
          job: { select: { number: true, name: true } },
          requestedBy: { select: { name: true } },
          warehouse: { select: { name: true } },
          items: { select: { estimatedAmount: true } },
        },
        orderBy: orderBy(q, PR_SORTS, { createdAt: 'desc' }),
        take: LIST_CAP,
      }),
      prisma.purchaseRequest.count({ where }),
      prisma.purchaseRequestItem.aggregate({
        where: { request: { AND: [where, { status: { notIn: PR_CLOSED } }] } },
        _sum: { estimatedAmount: true },
      }),
      prisma.purchaseRequest.count({ where: { AND: [where, { status: { in: PR_CLOSED } }] } }),
      companyCurrency(),
      recordNamed('project', q.filters.jobId),
    ]);

    const f = q.filters;
    const reference = listReference(count, rows.length, ['purchase request', 'purchase requests'], [
      q.search && `search "${q.search}"`,
      f.status && `status ${statusLabel(f.status)}`,
      f.kind && (f.kind === 'DIRECT_TO_JOB' ? 'direct to job' : 'stock replenishment'),
      project,
      mine && 'raised by me',
      f.ids && 'the rows selected',
    ]);
    const estimated = (r: (typeof rows)[number]) => r.items.reduce((s, i) => s.add(i.estimatedAmount), new Prisma.Decimal(0));

    // Eight columns: landscape, each sized from what it holds (rule 6).
    const sections: PdfSection[] = [
      {
        kind: 'table',
        head: ['Number', 'Request', 'Type', 'Lines', `Estimated (${currency})`, 'Raised by', 'Needed by', 'Status'],
        align: ['left', 'left', 'left', 'right', 'right', 'left', 'left', 'left'],
        rows: rows.map((r) => [
          r.number,
          { title: r.purpose, body: r.job ? `${r.job.number} — ${r.job.name}` : (r.warehouse?.name ?? 'Stock') },
          r.kind === 'DIRECT_TO_JOB' ? 'Direct to job' : 'Stock',
          String(r.items.length),
          bracketed(formatAmount(estimated(r).toFixed(2)), !PR_CLOSED.includes(r.status)),
          r.requestedBy.name,
          r.neededBy ? formatShortDate(r.neededBy) : '',
          statusLabel(r.status),
        ]),
      },
      {
        kind: 'totals',
        rows: [
          {
            label: totalLabel('Estimated total', count, rows.length),
            value: formatMoney(num(live._sum.estimatedAmount), currency),
            bold: true,
          },
        ],
      },
    ];
    sections.push(...listNotes([bracketNote(closed, ['cancelled or rejected request', 'cancelled or rejected requests'])]));

    const pdf = await renderDocument({ title: 'Purchase Requests', date: new Date(), reference, landscape: true, sections });
    await audit(
      {
        entityType: 'purchase_request',
        entityId: 'list',
        action: 'EXPORTED',
        summary: `Exported the purchase request list as PDF (${rows.length} request(s))`,
      },
      req,
    );
    sendListPdf(res, pdf, 'purchase-requests.pdf');
  }),
);

async function loadPr(id: string) {
  return prisma.purchaseRequest.findUnique({
    where: { id },
    include: {
      job: { select: { id: true, number: true, name: true } },
      warehouse: { select: { id: true, name: true } },
      requestedBy: { select: { id: true, name: true, position: true } },
      items: {
        orderBy: { sortOrder: 'asc' },
        include: {
          item: { select: { id: true, code: true, name: true, unit: true } },
          costCategory: { select: { id: true, code: true, name: true } },
        },
      },
      canvasses: {
        orderBy: { createdAt: 'desc' },
        select: { id: true, number: true, status: true, createdAt: true },
      },
      orders: {
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          number: true,
          status: true,
          total: true,
          supplier: { select: { id: true, name: true } },
        },
      },
    },
  });
}

purchaseRequestRoutes.get(
  '/:id',
  requireAny('gchain.purchase_requests.view_all', 'gchain.purchase_requests.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const pr = await loadPr(req.params.id);
    if (!pr) throw notFound('Purchase request not found');

    // Budget position per category, so the requester sees what is left before
    // they ask for more.
    const budget: Record<string, Awaited<ReturnType<typeof availableBudget>>> = {};
    if (pr.jobId) {
      const categoryIds = [...new Set(pr.items.map((i) => i.costCategoryId).filter(Boolean))];
      for (const categoryId of categoryIds as string[]) {
        budget[categoryId] = await availableBudget(prisma, pr.jobId, categoryId);
      }
    }

    res.json({
      ...presentPr(pr as unknown as Record<string, unknown>),
      orders: pr.orders.map((o) => ({ ...o, total: num(o.total) })),
      budget,
      // The routes' own rules (prForEdit, /withdraw): a draft is changed, and
      // a pending one pulled back, by its requester or an edit_all holder.
      canEdit: pr.status === 'DRAFT' && mayEditPr(me, pr),
      canWithdraw: pr.status === 'PENDING_APPROVAL' && mayEditPr(me, pr),
    });
  }),
);

const prSchema = z.object({
  kind: z.enum(['DIRECT_TO_JOB', 'STOCK_REPLENISHMENT']).default('DIRECT_TO_JOB'),
  jobId: z.string().optional().nullable(),
  warehouseId: z.string().optional().nullable(),
  purpose: z.string().trim().min(3, 'Say what this is for'),
  neededBy: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

/** The rights on the request's edit routes: its requester's, or anybody's. */
const PR_EDIT = ['gchain.purchase_requests.edit_own', 'gchain.purchase_requests.edit_all'] as const;

/** Who may change a draft request, or pull a pending one back: edit_all, or its requester holding edit_own (rule 7). */
function mayEditPr(me: ResolvedUser, pr: { requestedById: string }): boolean {
  return canEditRecord(me, 'gchain', 'purchase_requests', pr.requestedById);
}

/**
 * The distinction that stops double-counting, held on create and on every
 * change: a direct-to-job request must name its job, a stock replenishment
 * its warehouse (and never a job).
 */
function checkPrTarget(kind: string, jobId: string | null | undefined, warehouseId: string | null | undefined) {
  if (kind === 'DIRECT_TO_JOB' && !jobId) {
    throw badRequest('A direct-to-job request must name the project it is for');
  }
  if (kind === 'STOCK_REPLENISHMENT' && !warehouseId) {
    throw badRequest('A stock replenishment must name the warehouse it is for');
  }
}

purchaseRequestRoutes.post(
  '/',
  require_('gchain.purchase_requests.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(prSchema, req.body);
    checkPrTarget(body.kind, body.jobId, body.warehouseId);

    const pr = await prisma.$transaction(async (tx) => {
      const number = await nextNumber('purchase_request', tx);
      return tx.purchaseRequest.create({
        data: {
          number,
          kind: body.kind,
          jobId: body.kind === 'DIRECT_TO_JOB' ? body.jobId : null,
          warehouseId: body.warehouseId || null,
          requestedById: me.id,
          purpose: body.purpose,
          neededBy: asDate(body.neededBy),
          notes: body.notes || null,
        },
      });
    });

    await audit(
      {
        entityType: 'purchase_request',
        entityId: pr.id,
        action: 'CREATED',
        summary: `Raised ${pr.number} — ${pr.purpose}`,
      },
      req,
    );
    res.status(201).json(pr);
  }),
);

async function prForEdit(req: Parameters<typeof currentUser>[0], id: string) {
  const me = currentUser(req);
  const pr = await prisma.purchaseRequest.findUnique({
    where: { id },
    include: { items: { include: { item: { select: { name: true, costCategoryId: true } } } } },
  });
  if (!pr) throw notFound('Purchase request not found');
  if (pr.status !== 'DRAFT') {
    throw badRequest(`${pr.number} is ${pr.status.toLowerCase().replace(/_/g, ' ')} and cannot be changed`);
  }
  if (!mayEditPr(me, pr)) throw forbidden('This request belongs to someone else');
  return { pr, me };
}

/**
 * Modifying a draft request's header — including what it is for.
 *
 * The kind and the project may change, under the create route's rules: a
 * direct-to-job request names its project and every line its budget line (a
 * line with none takes its item's default category, or the change is
 * refused); a stock replenishment names its warehouse and loses its project.
 * Approval snapshots the amount and the subject, so only a DRAFT is changed —
 * a pending one is pulled back first (POST /:id/withdraw).
 */
purchaseRequestRoutes.patch(
  '/:id',
  requireAny(...PR_EDIT),
  handler(async (req, res) => {
    const { pr } = await prForEdit(req, req.params.id);
    const body = parseBody(
      z.object({
        kind: z.enum(['DIRECT_TO_JOB', 'STOCK_REPLENISHMENT']).optional(),
        jobId: z.string().optional().nullable(),
        warehouseId: z.string().optional().nullable(),
        purpose: z.string().trim().min(3, 'Say what this is for').optional(),
        neededBy: z.string().optional().nullable(),
        notes: z.string().optional().nullable(),
      }),
      req.body,
    );

    const kind = body.kind ?? pr.kind;
    const jobId =
      kind === 'STOCK_REPLENISHMENT' ? null : body.jobId !== undefined ? body.jobId || null : pr.jobId;
    const warehouseId = body.warehouseId !== undefined ? body.warehouseId || null : pr.warehouseId;
    checkPrTarget(kind, jobId, warehouseId);

    if (jobId && jobId !== pr.jobId) {
      const job = await prisma.job.findUnique({ where: { id: jobId }, select: { id: true } });
      if (!job) throw badRequest('That project does not exist');
    }
    if (warehouseId && warehouseId !== pr.warehouseId) {
      const warehouse = await prisma.warehouse.findUnique({ where: { id: warehouseId }, select: { id: true } });
      if (!warehouse) throw badRequest('That warehouse does not exist');
    }

    // Charged to a project, every line must find its budget line — the
    // item's own category where the line names an item that has one.
    const categoryFills: { id: string; costCategoryId: string }[] = [];
    if (kind === 'DIRECT_TO_JOB') {
      const bare: string[] = [];
      for (const line of pr.items) {
        if (line.costCategoryId) continue;
        if (line.item?.costCategoryId) categoryFills.push({ id: line.id, costCategoryId: line.item.costCategoryId });
        else bare.push(line.description);
      }
      if (bare.length) {
        throw badRequest(
          `A direct-to-job request needs a budget line on every line, and ${bare.join(', ')} ` +
            `${bare.length === 1 ? 'has' : 'have'} none. Give ${bare.length === 1 ? 'it' : 'them'} one, or remove ${
              bare.length === 1 ? 'it' : 'them'
            }, first.`,
        );
      }
    }

    const changed: string[] = [];
    if (kind !== pr.kind) changed.push(kind === 'DIRECT_TO_JOB' ? 'now for a project' : 'now for warehouse stock');
    if (jobId !== pr.jobId && kind === pr.kind) changed.push('project');
    if (warehouseId !== pr.warehouseId) changed.push('warehouse');
    if (body.purpose !== undefined && body.purpose !== pr.purpose) changed.push('purpose');
    if (body.neededBy !== undefined && (asDate(body.neededBy)?.getTime() ?? null) !== (pr.neededBy?.getTime() ?? null)) {
      changed.push('needed by');
    }
    if (body.notes !== undefined && (body.notes || null) !== pr.notes) changed.push('notes');
    if (categoryFills.length) changed.push(`budget line filled on ${categoryFills.length} line${categoryFills.length === 1 ? '' : 's'}`);

    await prisma.$transaction(async (tx) => {
      // Claimed on DRAFT: a submit that landed since the read above wins.
      const claimed = await tx.purchaseRequest.updateMany({
        where: { id: pr.id, status: 'DRAFT' },
        data: {
          kind,
          jobId,
          warehouseId,
          ...(body.purpose !== undefined ? { purpose: body.purpose } : {}),
          ...(body.notes !== undefined ? { notes: body.notes || null } : {}),
          ...(body.neededBy !== undefined ? { neededBy: asDate(body.neededBy) } : {}),
        },
      });
      if (!claimed.count) throw badRequest(`${pr.number} was submitted a moment ago and cannot be changed`);
      for (const fill of categoryFills) {
        await tx.purchaseRequestItem.update({ where: { id: fill.id }, data: { costCategoryId: fill.costCategoryId } });
      }
      await audit(
        {
          entityType: 'purchase_request',
          entityId: pr.id,
          action: 'UPDATED',
          summary: `Modified ${pr.number}${changed.length ? `: ${changed.join(', ')}` : ''}`,
        },
        req,
        tx,
      );
    });

    const full = await loadPr(pr.id);
    res.json(presentPr(full as unknown as Record<string, unknown>));
  }),
);

const prItemSchema = z.object({
  itemId: z.string().optional().nullable(),
  costCategoryId: z.string().optional().nullable(),
  description: z.string().trim().min(1, 'Describe what is needed'),
  quantity: z.number().positive('Quantity must be more than zero'),
  unit: z.string().trim().min(1).default('pcs'),
  estimatedCost: z.number().min(0).default(0),
});

purchaseRequestRoutes.post(
  '/:id/items',
  requireAny(...PR_EDIT),
  handler(async (req, res) => {
    const { pr } = await prForEdit(req, req.params.id);
    const body = parseBody(prItemSchema, req.body);

    if (pr.kind === 'DIRECT_TO_JOB' && !body.costCategoryId) {
      throw badRequest('A direct-to-job line needs a cost category — it is how the cost finds its budget line');
    }

    const count = await prisma.purchaseRequestItem.count({ where: { requestId: pr.id } });
    await prisma.purchaseRequestItem.create({
      data: {
        requestId: pr.id,
        itemId: body.itemId || null,
        costCategoryId: body.costCategoryId || null,
        description: body.description,
        quantity: D(body.quantity),
        unit: body.unit,
        estimatedCost: D(body.estimatedCost),
        estimatedAmount: D(cents(body.quantity * body.estimatedCost)),
        sortOrder: count,
      },
    });
    await audit(
      {
        entityType: 'purchase_request',
        entityId: pr.id,
        action: 'UPDATED',
        summary: `Added a line to ${pr.number}: ${body.description}`,
      },
      req,
    );

    const full = await loadPr(pr.id);
    res.status(201).json(presentPr(full as unknown as Record<string, unknown>));
  }),
);

purchaseRequestRoutes.patch(
  '/:id/items/:itemId',
  requireAny(...PR_EDIT),
  handler(async (req, res) => {
    const { pr } = await prForEdit(req, req.params.id);
    const body = parseBody(prItemSchema.partial(), req.body);
    if (pr.kind === 'DIRECT_TO_JOB' && body.costCategoryId !== undefined && !body.costCategoryId) {
      throw badRequest('A direct-to-job line needs a cost category — it is how the cost finds its budget line');
    }

    const existing = await prisma.purchaseRequestItem.findFirst({
      where: { id: req.params.itemId, requestId: req.params.id },
    });
    if (!existing) throw notFound('Line not found');

    const quantity = body.quantity ?? num(existing.quantity);
    const estimatedCost = body.estimatedCost ?? num(existing.estimatedCost);

    await prisma.purchaseRequestItem.update({
      where: { id: req.params.itemId },
      data: {
        ...(body.itemId !== undefined ? { itemId: body.itemId || null } : {}),
        ...(body.costCategoryId !== undefined ? { costCategoryId: body.costCategoryId || null } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.unit !== undefined ? { unit: body.unit } : {}),
        quantity: D(quantity),
        estimatedCost: D(estimatedCost),
        estimatedAmount: D(cents(quantity * estimatedCost)),
      },
    });
    await audit(
      {
        entityType: 'purchase_request',
        entityId: pr.id,
        action: 'UPDATED',
        summary: `Modified a line on ${pr.number}: ${body.description ?? existing.description}`,
      },
      req,
    );

    const full = await loadPr(req.params.id);
    res.json(presentPr(full as unknown as Record<string, unknown>));
  }),
);

purchaseRequestRoutes.delete(
  '/:id/items/:itemId',
  requireAny(...PR_EDIT),
  handler(async (req, res) => {
    const { pr } = await prForEdit(req, req.params.id);
    const existing = await prisma.purchaseRequestItem.findFirst({
      where: { id: req.params.itemId, requestId: req.params.id },
    });
    if (!existing) throw notFound('Line not found');
    await prisma.purchaseRequestItem.delete({ where: { id: req.params.itemId } });
    await audit(
      {
        entityType: 'purchase_request',
        entityId: pr.id,
        action: 'UPDATED',
        summary: `Removed a line from ${pr.number}: ${existing.description}`,
      },
      req,
    );
    const full = await loadPr(req.params.id);
    res.json(presentPr(full as unknown as Record<string, unknown>));
  }),
);

/**
 * Submitting a purchase request for approval.
 *
 * Before it routes, a direct-to-job request is checked against the budget. "A
 * PR that would push Available below zero is blocked, or requires a Budget
 * Request first" (model §5.2) — a budget nobody can exceed is the only kind
 * that means anything.
 *
 * Submitted in the REQUESTER's name, whoever pressed the button — otherwise an
 * edit_all holder submitting it could approve the request someone else raised.
 * A submit the engine refuses goes back to DRAFT, never PENDING with no
 * approval behind it.
 */
purchaseRequestRoutes.post(
  '/:id/submit',
  require_('gchain.purchase_requests.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const pr = await prisma.purchaseRequest.findUnique({
      where: { id: req.params.id },
      include: { items: { include: { costCategory: true } }, job: true },
    });
    if (!pr) throw notFound('Purchase request not found');
    if (!mayEditPr(me, pr)) throw forbidden('This request belongs to someone else');
    if (pr.status !== 'DRAFT') throw badRequest('This request has already been submitted');
    if (!pr.items.length) throw badRequest('Add at least one line before submitting');

    const total = cents(pr.items.reduce((s, i) => s + num(i.estimatedAmount), 0));

    if (pr.kind === 'DIRECT_TO_JOB' && pr.jobId) {
      const blocked = await overBudgetIsBlocked();
      const byCategory = new Map<string, { name: string; amount: number }>();
      for (const line of pr.items) {
        if (!line.costCategoryId) continue;
        const entry = byCategory.get(line.costCategoryId) ?? {
          name: line.costCategory?.name ?? 'that category',
          amount: 0,
        };
        entry.amount += num(line.estimatedAmount);
        byCategory.set(line.costCategoryId, entry);
      }

      const shortfalls: string[] = [];
      for (const [categoryId, entry] of byCategory) {
        const position = await availableBudget(prisma, pr.jobId, categoryId);
        if (entry.amount > position.available + 0.005) {
          shortfalls.push(
            `${entry.name}: ${formatMoney(entry.amount)} requested, ${formatMoney(position.available)} available`,
          );
        }
      }

      if (shortfalls.length && blocked) {
        throw badRequest(
          `This request exceeds the project's remaining budget — ${shortfalls.join('; ')}. ` +
            `Raise a budget request first, or reduce the quantities.`,
        );
      }
    }

    // Claimed on DRAFT, so two presses cannot both submit it.
    const claimed = await prisma.purchaseRequest.updateMany({
      where: { id: pr.id, status: 'DRAFT' },
      data: { status: 'PENDING_APPROVAL' },
    });
    if (!claimed.count) throw badRequest('This request has already been submitted');

    try {
      await submitForApproval({
        documentType: 'purchase_request',
        documentId: pr.id,
        documentNumber: pr.number,
        subject: `${pr.job ? `${pr.job.number} — ` : ''}${pr.purpose}`,
        amount: total,
        link: `/g-chain/purchase-requests/${pr.id}`,
        requesterId: pr.requestedById,
      });
    } catch (err) {
      // Refused (no workflow, nobody to approve, already open): back to a
      // draft the requester can act on.
      await prisma.purchaseRequest.updateMany({
        where: { id: pr.id, status: 'PENDING_APPROVAL' },
        data: { status: 'DRAFT' },
      });
      throw err;
    }

    // Pulled back while the request above was being opened: the pull-back
    // found nothing to withdraw, so the request opened here would sit on a
    // draft — where no decision can land and every later submit is refused as
    // "already awaiting approval". Withdrawn now, through the engine, under a
    // claim on the draft so a fresh submit cannot slip in between.
    const pulledBack = await prisma.$transaction(async (tx) => {
      const stillDraft = await tx.purchaseRequest.updateMany({
        where: { id: pr.id, status: 'DRAFT' },
        data: { updatedAt: new Date() },
      });
      if (!stillDraft.count) return false;
      await cancelOpenRequest('purchase_request', pr.id, tx, `pulled back to draft by ${me.name} while it was being submitted`, me.id);
      return true;
    });
    if (pulledBack) {
      throw badRequest(`${pr.number} was pulled back to draft while it was being submitted — submit it again when it is ready`);
    }

    await audit(
      { entityType: 'purchase_request', entityId: pr.id, action: 'SUBMITTED', summary: `${pr.number} sent for approval` },
      req,
    );
    res.json({ ok: true, status: 'PENDING_APPROVAL' });
  }),
);

/**
 * Pulling a request back from the approver to change it, as a sales order can
 * be: the claim is conditional, so a decision that lands first wins, and the
 * open request is withdrawn through the engine in the same transaction, which
 * tells the approvers. The same request returns to DRAFT — no number burned.
 */
purchaseRequestRoutes.post(
  '/:id/withdraw',
  requireAny(...PR_EDIT),
  handler(async (req, res) => {
    const me = currentUser(req);
    const pr = await prisma.purchaseRequest.findUnique({ where: { id: req.params.id } });
    if (!pr) throw notFound('Purchase request not found');
    if (!mayEditPr(me, pr)) throw forbidden('This request belongs to someone else');
    if (pr.status !== 'PENDING_APPROVAL') {
      throw badRequest('This request is not with the approver — nothing to pull back');
    }
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.purchaseRequest.updateMany({
        where: { id: pr.id, status: 'PENDING_APPROVAL' },
        data: { status: 'DRAFT' },
      });
      if (!claimed.count) throw badRequest('It was decided a moment ago — reload to see where it stands');
      const withdrawn = await cancelOpenRequest('purchase_request', pr.id, tx, `pulled back to draft by ${me.name}`, me.id);
      if (!withdrawn.length) {
        // Nothing was open to withdraw. act() commits a final decision before
        // its subscriber runs, so a request can read decided while this
        // document still says pending: APPROVED, REJECTED, or CANCELLED by a
        // return. That decision stands — the throw rolls the claim back and
        // the subscriber applies it. Only a request stranded pending with no
        // approval behind it (a submit the engine refused, before the submit
        // reverted to draft) comes back with nothing to withdraw — or one
        // whose submit is still opening its request, which the submit route
        // then withdraws itself when it finds the document a draft.
        const last = await tx.approvalRequest.findFirst({
          where: { documentType: 'purchase_request', documentId: pr.id },
          orderBy: { createdAt: 'desc' },
          select: { status: true, actions: { where: { action: 'RETURNED' }, select: { id: true }, take: 1 } },
        });
        if (last && (last.status === 'APPROVED' || last.status === 'REJECTED' || last.actions.length)) {
          throw badRequest('It was decided a moment ago — reload to see where it stands');
        }
      }
    });
    await audit(
      { entityType: 'purchase_request', entityId: pr.id, action: 'UPDATED', summary: `Pulled ${pr.number} back to draft` },
      req,
    );
    res.json({ ok: true, status: 'DRAFT' });
  }),
);

/** The trail's line for a decision that found its document no longer waiting for one. */
async function notApplied(entityType: string, documentId: string, number: string, status: string, outcome: ApprovalOutcome) {
  await audit({
    entityType,
    entityId: documentId,
    action: outcome === 'APPROVED' ? 'APPROVED' : 'REJECTED',
    summary: `${number} ${outcome.toLowerCase()} after it was ${status.toLowerCase().replace(/_/g, ' ')} — not applied`,
  });
}

/**
 * An approved direct-to-job request commits budget.
 *
 * This is the SOFT commitment — a promise to spend, at estimated prices. The
 * purchase order later replaces it with the firm figure at the price actually
 * agreed (model §5.1).
 *
 * Claimed on PENDING_APPROVAL with a conditional update, so a decision that
 * lands after the request was pulled back to draft changes nothing — it
 * commits no budget — and the trail says so. Exported so the test can settle
 * a request that is no longer waiting.
 */
export async function settlePurchaseRequest(documentId: string, outcome: ApprovalOutcome) {
  const pr = await prisma.purchaseRequest.findUnique({ where: { id: documentId } });
  if (!pr) return;

  if (outcome !== 'APPROVED') {
    const claimed = await prisma.purchaseRequest.updateMany({
      where: { id: pr.id, status: 'PENDING_APPROVAL' },
      data: { status: 'REJECTED' },
    });
    if (!claimed.count) {
      const now = await prisma.purchaseRequest.findUnique({ where: { id: pr.id }, select: { status: true } });
      await notApplied('purchase_request', pr.id, pr.number, now?.status ?? pr.status, outcome);
    }
    return;
  }

  const applied = await prisma.$transaction(async (tx) => {
    const claimed = await tx.purchaseRequest.updateMany({
      where: { id: pr.id, status: 'PENDING_APPROVAL' },
      data: { status: 'APPROVED', approvedAt: new Date() },
    });
    if (!claimed.count) return null;

    // Read again under the claim: what is committed is the request as it
    // stood when approved, never a kind or project read before it.
    const now = await tx.purchaseRequest.findUniqueOrThrow({ where: { id: pr.id } });
    if (now.kind !== 'DIRECT_TO_JOB' || !now.jobId) return now;

    const items = await tx.purchaseRequestItem.findMany({ where: { requestId: pr.id } });
    const byCategory = new Map<string, number>();
    for (const line of items) {
      if (!line.costCategoryId) continue;
      byCategory.set(
        line.costCategoryId,
        (byCategory.get(line.costCategoryId) ?? 0) + num(line.estimatedAmount),
      );
    }
    for (const [costCategoryId, amount] of byCategory) {
      await postJobCost(tx, {
        jobId: now.jobId,
        costCategoryId,
        state: 'COMMITTED',
        amount,
        sourceType: 'purchase_request',
        sourceId: now.id,
        sourceNumber: now.number,
        description: `Approved request — ${now.purpose}`,
        createdById: now.requestedById,
      });
    }
    return now;
  });

  if (!applied) {
    const now = await prisma.purchaseRequest.findUnique({ where: { id: pr.id }, select: { status: true } });
    await notApplied('purchase_request', pr.id, pr.number, now?.status ?? pr.status, outcome);
    return;
  }

  await audit({
    entityType: 'purchase_request',
    entityId: applied.id,
    action: 'APPROVED',
    summary:
      applied.kind === 'DIRECT_TO_JOB' && applied.jobId
        ? `${applied.number} approved — budget committed`
        : `${applied.number} approved`,
  });
}

onApprovalSettled('purchase_request', async (request, outcome) => {
  await settlePurchaseRequest(request.documentId, outcome);
});

purchaseRequestRoutes.delete(
  '/:id',
  require_('gchain.purchase_requests.delete'),
  handler(async (req, res) => {
    const pr = await prisma.purchaseRequest.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { orders: true } } },
    });
    if (!pr) throw notFound('Purchase request not found');
    if (pr.status !== 'DRAFT' && pr.status !== 'REJECTED') {
      throw badRequest('Only a draft or rejected request can be deleted');
    }
    if (pr._count.orders > 0) throw badRequest('Purchase orders were raised from this request');

    await prisma.purchaseRequest.delete({ where: { id: req.params.id } });
    await audit(
      { entityType: 'purchase_request', entityId: req.params.id, action: 'DELETED', summary: `Deleted ${pr.number}` },
      req,
    );
    res.json({ ok: true });
  }),
);

// ════════════════════════════════════════════════════════════════════
//  CANVASS
// ════════════════════════════════════════════════════════════════════

export const canvassRoutes = Router();
canvassRoutes.use(authenticate);

const CANVASS_SORTS = ['number', 'createdAt'];

/** Which canvasses a list query means — one rule for the list and its printed twin. */
function canvassListWhere(q: ListQuery): Prisma.CanvassWhereInput {
  const and: Prisma.CanvassWhereInput[] = [];
  const status = choice(q.filters.status, CanvassStatus, 'Status');
  if (status) and.push({ status });
  if (q.search) {
    and.push({
      OR: [
        { number: { contains: q.search, mode: 'insensitive' } },
        { request: { number: { contains: q.search, mode: 'insensitive' } } },
        { request: { purpose: { contains: q.search, mode: 'insensitive' } } },
      ],
    });
  }
  const ids = idsFilter(q.filters.ids);
  if (ids) and.push({ id: { in: ids } });
  return and.length ? { AND: and } : {};
}

canvassRoutes.get(
  '/',
  requireAny('gchain.canvass.view_all', 'gchain.canvass.view_own'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const where = canvassListWhere(q);

    const [rows, total] = await Promise.all([
      prisma.canvass.findMany({
        where,
        include: {
          request: {
            select: { id: true, number: true, purpose: true, job: { select: { id: true, name: true } } },
          },
          createdBy: { select: { id: true, name: true } },
          suppliers: { select: { id: true, isSelected: true, supplier: { select: { name: true } } } },
        },
        orderBy: orderBy(q, CANVASS_SORTS, { createdAt: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.canvass.count({ where }),
    ]);

    res.json(
      listResult(
        rows.map((r) => ({
          ...r,
          supplierCount: r.suppliers.length,
          awarded: r.suppliers.find((s) => s.isSelected)?.supplier.name ?? null,
        })),
        total,
        q,
      ),
    );
  }),
);

/**
 * The canvass list on paper, through `canvassListWhere` (or the rows ticked,
 * `?ids=`). No prices: a canvass's figures are per supplier and belong on the
 * canvass itself. Above `/:id`.
 */
canvassRoutes.get(
  '/pdf',
  requireAny('gchain.canvass.view_all', 'gchain.canvass.view_own'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const where = canvassListWhere(q);
    const [rows, count] = await Promise.all([
      prisma.canvass.findMany({
        where,
        include: {
          request: { select: { number: true, purpose: true, job: { select: { number: true } } } },
          createdBy: { select: { name: true } },
          suppliers: { select: { isSelected: true, supplier: { select: { name: true } } } },
        },
        orderBy: orderBy(q, CANVASS_SORTS, { createdAt: 'desc' }),
        take: LIST_CAP,
      }),
      prisma.canvass.count({ where }),
    ]);
    const f = q.filters;
    const reference = listReference(count, rows.length, ['canvass', 'canvasses'], [
      q.search && `search "${q.search}"`,
      f.status && `status ${statusLabel(f.status)}`,
      f.ids && 'the rows selected',
    ]);

    // Seven columns: portrait, each sized from what it holds (rule 6).
    const pdf = await renderDocument({
      title: 'Canvass / RFQ',
      date: new Date(),
      reference,
      sections: [
        {
          kind: 'table',
          head: ['Number', 'For', 'Suppliers', 'Awarded to', 'Opened by', 'Opened', 'Status'],
          align: ['left', 'left', 'right', 'left', 'left', 'left', 'left'],
          rows: rows.map((c) => [
            c.number,
            { title: c.request.purpose, body: [c.request.number, c.request.job?.number].filter(Boolean).join(' · ') },
            String(c.suppliers.length),
            c.suppliers.find((s) => s.isSelected)?.supplier.name ?? '',
            c.createdBy.name,
            formatShortDate(c.createdAt),
            statusLabel(c.status),
          ]),
        },
      ],
    });
    await audit(
      { entityType: 'canvass', entityId: 'list', action: 'EXPORTED', summary: `Exported the canvass list as PDF (${rows.length} canvass(es))` },
      req,
    );
    sendListPdf(res, pdf, 'canvasses.pdf');
  }),
);

async function loadCanvass(id: string) {
  return prisma.canvass.findUnique({
    where: { id },
    include: {
      request: {
        include: {
          job: { select: { id: true, number: true, name: true } },
          items: {
            orderBy: { sortOrder: 'asc' },
            include: { costCategory: { select: { id: true, name: true } } },
          },
        },
      },
      createdBy: { select: { id: true, name: true } },
      suppliers: {
        include: {
          supplier: { select: { id: true, code: true, name: true, paymentTerms: true } },
          quotes: true,
        },
      },
    },
  });
}

type LoadedCanvass = NonNullable<Awaited<ReturnType<typeof loadCanvass>>>;

/** Who may change a canvass's own notes: edit_all, or whoever opened it holding edit_own (rule 7). */
function mayEditCanvass(me: ResolvedUser, canvass: { createdById: string }): boolean {
  return canEditRecord(me, 'gchain', 'canvass', canvass.createdById);
}

function presentCanvass(canvass: LoadedCanvass, me: ResolvedUser) {
  // Total per supplier for the lines they actually quoted, so the comparison
  // is like for like.
  const suppliers = canvass.suppliers.map((s) => {
    const quoted = new Map(s.quotes.map((qq) => [qq.requestItemId, num(qq.unitPrice)]));
    const total = canvass.request.items.reduce((sum, item) => {
      const price = quoted.get(item.id);
      return price === undefined ? sum : sum + num(item.quantity) * price;
    }, 0);
    return {
      ...s,
      quotes: s.quotes.map((qq) => ({ ...qq, unitPrice: num(qq.unitPrice) })),
      quotedCount: s.quotes.length,
      total: cents(total),
      complete: s.quotes.length === canvass.request.items.length,
    };
  });

  const complete = suppliers.filter((s) => s.complete && s.total > 0);
  const lowest = complete.length
    ? complete.reduce((best, s) => (s.total < best.total ? s : best))
    : null;

  const open = canvass.status === 'OPEN';
  return {
    ...canvass,
    request: presentPr(canvass.request as unknown as Record<string, unknown>),
    suppliers,
    lowestSupplierId: lowest?.id ?? null,
    // The routes' own rules: while OPEN, the notes are the opener's (or
    // edit_all's), the supplier rows edit_all's. An award is the record.
    canEdit: open && mayEditCanvass(me, canvass),
    canEditSuppliers: open && can(me, 'gchain.canvass.edit_all'),
  };
}

canvassRoutes.get(
  '/:id',
  requireAny('gchain.canvass.view_all', 'gchain.canvass.view_own'),
  handler(async (req, res) => {
    const canvass = await loadCanvass(req.params.id);
    if (!canvass) throw notFound('Canvass not found');
    res.json(presentCanvass(canvass, currentUser(req)));
  }),
);

/**
 * Modifying a canvass: its notes, while it is OPEN. Which request it
 * canvasses is what it is, and an award is the decision on record — so the
 * header takes nothing else (a key it cannot change is refused, not ignored).
 */
canvassRoutes.patch(
  '/:id',
  requireAny('gchain.canvass.edit_own', 'gchain.canvass.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(z.object({ notes: z.string().nullable() }).strict(), req.body);
    const canvass = await prisma.canvass.findUnique({ where: { id: req.params.id } });
    if (!canvass) throw notFound('Canvass not found');
    if (!mayEditCanvass(me, canvass)) throw forbidden('This canvass belongs to someone else');
    if (canvass.status !== 'OPEN') {
      throw badRequest(`${canvass.number} is ${canvass.status.toLowerCase()} — it stands as it was decided`);
    }
    const notes = body.notes?.trim() || null;
    const claimed = await prisma.canvass.updateMany({ where: { id: canvass.id, status: 'OPEN' }, data: { notes } });
    if (!claimed.count) throw badRequest(`${canvass.number} was awarded a moment ago — reload to see it`);
    await audit(
      { entityType: 'canvass', entityId: canvass.id, action: 'UPDATED', summary: `Modified ${canvass.number}: notes` },
      req,
    );
    res.json(presentCanvass((await loadCanvass(canvass.id))!, me));
  }),
);

canvassRoutes.post(
  '/',
  require_('gchain.canvass.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(z.object({ requestId: z.string().min(1), notes: z.string().optional() }), req.body);

    const pr = await prisma.purchaseRequest.findUnique({
      where: { id: body.requestId },
      include: { items: true },
    });
    if (!pr) throw notFound('Purchase request not found');
    if (pr.status !== 'APPROVED' && pr.status !== 'PARTIALLY_ORDERED') {
      throw badRequest('Only an approved request can be canvassed');
    }
    if (!pr.items.length) throw badRequest('That request has no lines');

    const canvass = await prisma.$transaction(async (tx) => {
      const number = await nextNumber('canvass', tx);
      return tx.canvass.create({
        data: { number, requestId: pr.id, createdById: me.id, notes: body.notes || null },
      });
    });

    await audit(
      {
        entityType: 'canvass',
        entityId: canvass.id,
        action: 'CREATED',
        summary: `Opened ${canvass.number} for ${pr.number}`,
      },
      req,
    );
    res.status(201).json(canvass);
  }),
);

canvassRoutes.post(
  '/:id/suppliers',
  require_('gchain.canvass.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(
      z.object({
        supplierId: z.string().min(1),
        leadTimeDays: z.number().int().min(0).optional().nullable(),
        terms: z.string().optional().nullable(),
        remarks: z.string().optional().nullable(),
      }),
      req.body,
    );

    const canvass = await prisma.canvass.findUnique({ where: { id: req.params.id } });
    if (!canvass) throw notFound('Canvass not found');
    if (canvass.status !== 'OPEN') throw badRequest('This canvass has been awarded');

    const clash = await prisma.canvassSupplier.findFirst({
      where: { canvassId: canvass.id, supplierId: body.supplierId },
    });
    if (clash) throw badRequest('That supplier is already on this canvass');

    const row = await prisma.canvassSupplier.create({
      data: {
        canvassId: canvass.id,
        supplierId: body.supplierId,
        leadTimeDays: body.leadTimeDays ?? null,
        terms: body.terms || null,
        remarks: body.remarks || null,
      },
      include: { supplier: { select: { name: true } } },
    });
    await audit(
      { entityType: 'canvass', entityId: canvass.id, action: 'UPDATED', summary: `Added ${row.supplier.name} to ${canvass.number}` },
      req,
    );
    const full = await loadCanvass(canvass.id);
    res.status(201).json(full);
  }),
);

canvassRoutes.put(
  '/:id/suppliers/:supplierRowId/quotes',
  require_('gchain.canvass.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(
      z.object({
        quotes: z.array(z.object({ requestItemId: z.string(), unitPrice: z.number().min(0) })),
      }),
      req.body,
    );

    const row = await prisma.canvassSupplier.findFirst({
      where: { id: req.params.supplierRowId, canvassId: req.params.id },
      include: { canvass: true },
    });
    if (!row) throw notFound('Supplier not on this canvass');
    if (row.canvass.status !== 'OPEN') throw badRequest('This canvass has been awarded');

    await prisma.$transaction(async (tx) => {
      await tx.canvassQuote.deleteMany({ where: { canvassSupplierId: row.id } });
      if (body.quotes.length) {
        await tx.canvassQuote.createMany({
          data: body.quotes.map((qq) => ({
            canvassSupplierId: row.id,
            requestItemId: qq.requestItemId,
            unitPrice: D(qq.unitPrice),
          })),
        });
      }
    });

    const full = await loadCanvass(req.params.id);
    res.json(full);
  }),
);

/**
 * A supplier row's own terms — lead time, payment terms, remarks — while the
 * canvass is OPEN. Its prices go through PUT …/quotes; which supplier it is
 * never changes (remove the row and add the other).
 */
canvassRoutes.patch(
  '/:id/suppliers/:supplierRowId',
  require_('gchain.canvass.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(
      z
        .object({
          leadTimeDays: z.number().int().min(0).optional().nullable(),
          terms: z.string().optional().nullable(),
          remarks: z.string().optional().nullable(),
        })
        .strict(),
      req.body,
    );
    const row = await prisma.canvassSupplier.findFirst({
      where: { id: req.params.supplierRowId, canvassId: req.params.id },
      include: { canvass: true, supplier: { select: { name: true } } },
    });
    if (!row) throw notFound('Supplier not on this canvass');
    if (row.canvass.status !== 'OPEN') throw badRequest('This canvass has been awarded — its quotes stand as they were');

    // Claimed on the canvass still being OPEN: an award that lands first wins.
    const claimed = await prisma.canvassSupplier.updateMany({
      where: { id: row.id, canvass: { status: 'OPEN' } },
      data: {
        ...(body.leadTimeDays !== undefined ? { leadTimeDays: body.leadTimeDays } : {}),
        ...(body.terms !== undefined ? { terms: body.terms?.trim() || null } : {}),
        ...(body.remarks !== undefined ? { remarks: body.remarks?.trim() || null } : {}),
      },
    });
    if (!claimed.count) throw badRequest('This canvass was awarded a moment ago — reload to see it');
    await audit(
      {
        entityType: 'canvass',
        entityId: row.canvassId,
        action: 'UPDATED',
        summary: `Modified ${row.supplier.name} on ${row.canvass.number}`,
      },
      req,
    );
    res.json(presentCanvass((await loadCanvass(row.canvassId))!, currentUser(req)));
  }),
);

/** Removing a supplier from an OPEN canvass — never from an awarded one, whose winner the order was placed with. */
canvassRoutes.delete(
  '/:id/suppliers/:supplierRowId',
  require_('gchain.canvass.edit_all'),
  handler(async (req, res) => {
    const row = await prisma.canvassSupplier.findFirst({
      where: { id: req.params.supplierRowId, canvassId: req.params.id },
      include: { canvass: true, supplier: { select: { name: true } } },
    });
    if (!row) throw notFound('Supplier not on this canvass');
    if (row.canvass.status !== 'OPEN') {
      throw badRequest('This canvass has been awarded — its suppliers stand as they were');
    }
    const gone = await prisma.canvassSupplier.deleteMany({ where: { id: row.id, canvass: { status: 'OPEN' } } });
    if (!gone.count) throw badRequest('This canvass was awarded a moment ago — reload to see it');
    await audit(
      {
        entityType: 'canvass',
        entityId: row.canvassId,
        action: 'UPDATED',
        summary: `Removed ${row.supplier.name} from ${row.canvass.number}`,
      },
      req,
    );
    res.json({ ok: true });
  }),
);

/** Awarding the canvass marks the winner; the PO is raised from it after. */
canvassRoutes.post(
  '/:id/award/:supplierRowId',
  require_('gchain.canvass.edit_all'),
  handler(async (req, res) => {
    const row = await prisma.canvassSupplier.findFirst({
      where: { id: req.params.supplierRowId, canvassId: req.params.id },
      include: { supplier: true, quotes: true, canvass: { include: { request: { include: { items: true } } } } },
    });
    if (!row) throw notFound('Supplier not on this canvass');
    if (row.canvass.status !== 'OPEN') throw badRequest('This canvass has already been awarded');
    if (!row.quotes.length) throw badRequest('That supplier has not quoted anything');

    await prisma.$transaction(async (tx) => {
      await tx.canvassSupplier.updateMany({
        where: { canvassId: req.params.id },
        data: { isSelected: false },
      });
      await tx.canvassSupplier.update({ where: { id: row.id }, data: { isSelected: true } });
      await tx.canvass.update({
        where: { id: req.params.id },
        data: { status: 'AWARDED', awardedAt: new Date() },
      });
    });

    await audit(
      {
        entityType: 'canvass',
        entityId: req.params.id,
        action: 'APPROVED',
        summary: `${row.canvass.number} awarded to ${row.supplier.name}`,
      },
      req,
    );
    res.json({ ok: true, supplier: row.supplier.name });
  }),
);

// ════════════════════════════════════════════════════════════════════
//  PURCHASE ORDERS
// ════════════════════════════════════════════════════════════════════

export const purchaseOrderRoutes = Router();
purchaseOrderRoutes.use(authenticate);

async function recalcPo(orderId: string, tx: Prisma.TransactionClient = prisma) {
  const order = await tx.purchaseOrder.findUnique({
    where: { id: orderId },
    include: { items: true },
  });
  if (!order) return null;

  const subtotal = cents(order.items.reduce((s, i) => s + num(i.amount), 0));
  const rate = num(order.vatRate);
  const vatAmount = order.vatInclusive ? cents(subtotal - subtotal / (1 + rate)) : cents(subtotal * rate);
  const total = order.vatInclusive ? subtotal : cents(subtotal + vatAmount);

  return tx.purchaseOrder.update({
    where: { id: orderId },
    data: { subtotal: D(subtotal), vatAmount: D(vatAmount), total: D(total) },
  });
}

const PO_SORTS = ['number', 'orderDate', 'total', 'createdAt'];

/**
 * Which purchase orders a list query means — one rule for the list and its
 * printed twin. "Awaiting delivery" is two statuses — the same pair
 * chainOverview() counts, so the dashboard tile opens exactly the orders it
 * counted; a status chosen as well wins, as it always has.
 */
function poListWhere(q: ListQuery): Prisma.PurchaseOrderWhereInput {
  const and: Prisma.PurchaseOrderWhereInput[] = [];
  const f = q.filters;
  const status = choice(f.status, PoStatus, 'Status');
  if (status) and.push({ status });
  else if (f.awaiting === 'true') and.push({ status: { in: ['ISSUED', 'PARTIALLY_RECEIVED'] } });
  if (f.supplierId) and.push({ supplierId: f.supplierId });
  if (f.jobId) and.push({ jobId: f.jobId });
  if (q.search) {
    and.push({
      OR: [
        { number: { contains: q.search, mode: 'insensitive' } },
        { supplier: { name: { contains: q.search, mode: 'insensitive' } } },
        { job: { name: { contains: q.search, mode: 'insensitive' } } },
      ],
    });
  }
  const ids = idsFilter(f.ids);
  if (ids) and.push({ id: { in: ids } });
  return and.length ? { AND: and } : {};
}

/** How much of an order has arrived, by quantity — the list's Received column. */
function receivedPct(items: { quantity: Prisma.Decimal; receivedQty: Prisma.Decimal }[]): number {
  const ordered = items.reduce((s, i) => s + num(i.quantity), 0);
  const received = items.reduce((s, i) => s + num(i.receivedQty), 0);
  return ordered > 0 ? cents((received / ordered) * 100) : 0;
}

purchaseOrderRoutes.get(
  '/',
  requireAny('gchain.purchase_orders.view_all', 'gchain.purchase_orders.view_own'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const where = poListWhere(q);

    const [rows, total] = await Promise.all([
      prisma.purchaseOrder.findMany({
        where,
        include: {
          supplier: { select: { id: true, name: true } },
          job: { select: { id: true, number: true, name: true } },
          request: { select: { id: true, number: true } },
          items: { select: { quantity: true, receivedQty: true } },
        },
        orderBy: orderBy(q, PO_SORTS, { createdAt: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.purchaseOrder.count({ where }),
    ]);

    res.json(
      listResult(
        rows.map((r) => ({
          id: r.id,
          number: r.number,
          kind: r.kind,
          status: r.status,
          supplier: r.supplier,
          job: r.job,
          request: r.request,
          orderDate: r.orderDate,
          deliveryDate: r.deliveryDate,
          total: num(r.total),
          receivedPct: receivedPct(r.items),
        })),
        total,
        q,
      ),
    );
  }),
);

/** An order not issued to its supplier yet — summed, and said, as G-FIN says a draft invoice. */
const PO_UNISSUED: PoStatus[] = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'];

/**
 * The purchase order list on paper, through `poListWhere` (or the rows
 * ticked, `?ids=`) — the totals the screen shows, never a line's cost
 * category or the supplier's TIN. A cancelled order's total prints in
 * brackets and is not summed; an order not issued yet is summed, as G-FIN
 * sums a draft invoice, and the note under the total says how many — nothing
 * is committed on one until it is issued. Above `/:id`.
 */
purchaseOrderRoutes.get(
  '/pdf',
  requireAny('gchain.purchase_orders.view_all', 'gchain.purchase_orders.view_own'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const where = poListWhere(q);
    const f = q.filters;
    const [rows, count, live, cancelled, unissued, currency, project, supplier] = await Promise.all([
      prisma.purchaseOrder.findMany({
        where,
        include: {
          supplier: { select: { name: true } },
          job: { select: { number: true, name: true } },
          request: { select: { number: true } },
          items: { select: { quantity: true, receivedQty: true } },
        },
        orderBy: orderBy(q, PO_SORTS, { createdAt: 'desc' }),
        take: LIST_CAP,
      }),
      prisma.purchaseOrder.count({ where }),
      prisma.purchaseOrder.aggregate({ where: { AND: [where, { status: { not: 'CANCELLED' } }] }, _sum: { total: true } }),
      prisma.purchaseOrder.count({ where: { AND: [where, { status: 'CANCELLED' }] } }),
      prisma.purchaseOrder.count({ where: { AND: [where, { status: { in: PO_UNISSUED } }] } }),
      companyCurrency(),
      recordNamed('project', f.jobId),
      f.supplierId ? prisma.supplier.findUnique({ where: { id: f.supplierId }, select: { name: true } }) : null,
    ]);
    const reference = listReference(count, rows.length, ['purchase order', 'purchase orders'], [
      q.search && `search "${q.search}"`,
      f.status ? `status ${statusLabel(f.status)}` : f.awaiting === 'true' && 'awaiting delivery',
      f.supplierId && `supplier ${supplier?.name ?? 'not found'}`,
      project,
      f.ids && 'the rows selected',
    ]);
    // A whole percentage, never rounded up to a delivery that is not complete.
    const pct = (v: number) => (v >= 100 ? '100%' : `${Math.floor(v)}%`);

    // Eight columns: landscape, each sized from what it holds (rule 6).
    const sections: PdfSection[] = [
      {
        kind: 'table',
        head: ['Number', 'Supplier', 'Ordered', 'Required', `Total (${currency})`, 'Received', 'Request', 'Status'],
        align: ['left', 'left', 'left', 'left', 'right', 'right', 'left', 'left'],
        rows: rows.map((o) => [
          o.number,
          { title: o.supplier.name, body: o.job ? `${o.job.number} — ${o.job.name}` : 'Stock' },
          formatShortDate(o.orderDate),
          o.deliveryDate ? formatShortDate(o.deliveryDate) : '',
          bracketed(formatAmount(num(o.total)), o.status !== 'CANCELLED'),
          pct(receivedPct(o.items)),
          o.request?.number ?? '',
          statusLabel(o.status),
        ]),
      },
      {
        kind: 'totals',
        rows: [{ label: totalLabel('Total', count, rows.length), value: formatMoney(num(live._sum.total), currency), bold: true }],
      },
    ];
    sections.push(
      ...listNotes([
        unissued > 0 &&
          `The total includes ${counted(unissued, ['order', 'orders'])} not issued yet — nothing is committed on ${unissued === 1 ? 'it' : 'them'} until ${unissued === 1 ? 'it is' : 'they are'}.`,
        bracketNote(cancelled, ['cancelled order', 'cancelled orders']),
      ]),
    );

    const pdf = await renderDocument({ title: 'Purchase Orders', date: new Date(), reference, landscape: true, sections });
    await audit(
      { entityType: 'purchase_order', entityId: 'list', action: 'EXPORTED', summary: `Exported the purchase order list as PDF (${rows.length} order(s))` },
      req,
    );
    sendListPdf(res, pdf, 'purchase-orders.pdf');
  }),
);

async function loadPo(id: string) {
  return prisma.purchaseOrder.findUnique({
    where: { id },
    include: {
      supplier: true,
      job: { select: { id: true, number: true, name: true } },
      warehouse: { select: { id: true, name: true } },
      request: {
        select: {
          id: true,
          number: true,
          purpose: true,
          // The awarded canvass, if any: its winner is the order's supplier
          // and must not be swapped on the draft afterwards.
          canvasses: {
            where: { status: 'AWARDED' },
            orderBy: { awardedAt: 'desc' },
            select: {
              id: true,
              number: true,
              suppliers: { where: { isSelected: true }, select: { supplierId: true } },
            },
          },
        },
      },
      createdBy: { select: { id: true, name: true, position: true } },
      items: {
        orderBy: { sortOrder: 'asc' },
        include: {
          item: { select: { id: true, code: true, name: true } },
          costCategory: { select: { id: true, name: true } },
        },
      },
      bills: {
        orderBy: { billDate: 'desc' },
        select: { id: true, number: true, status: true, total: true, dueDate: true },
      },
      receivings: {
        orderBy: { receivedDate: 'desc' },
        select: {
          id: true,
          number: true,
          receivedDate: true,
          receivedBy: { select: { name: true } },
        },
      },
    },
  });
}

type LoadedPo = NonNullable<Awaited<ReturnType<typeof loadPo>>>;

/** The awarded canvass this order was placed from — its supplier is decided. */
function awardedCanvass(po: LoadedPo): { id: string; number: string } | null {
  const hit = po.request?.canvasses.find((c) => c.suppliers.some((s) => s.supplierId === po.supplierId));
  return hit ? { id: hit.id, number: hit.number } : null;
}

/**
 * Who may change a draft order: edit_all, or its author holding edit_own
 * (rule 7). The route guard only proves the caller holds one of the two.
 */
function mayEditPo(me: ResolvedUser, po: { createdById: string }): boolean {
  return canEditRecord(me, 'gchain', 'purchase_orders', po.createdById);
}

/**
 * The approver's reason when the latest submission came back.
 *
 * A rejected order reverts to DRAFT silently (onApprovalSettled below), so
 * without this the person who raised it saw an editable draft and no idea
 * why — the comment lived only in a notification they may have dismissed.
 */
async function lastReturn(documentId: string) {
  const latest = await prisma.approvalRequest.findFirst({
    where: { documentType: 'purchase_order', documentId },
    orderBy: { createdAt: 'desc' },
    select: {
      status: true,
      actions: {
        where: { action: { in: ['REJECTED', 'RETURNED'] } },
        orderBy: { actedAt: 'desc' },
        take: 1,
        select: { comment: true, actedAt: true, approver: { select: { name: true } } },
      },
    },
  });
  if (!latest || latest.status !== 'REJECTED') return null;
  const last = latest.actions[0];
  return {
    by: last?.approver.name ?? null,
    comment: last?.comment ?? null,
    at: last?.actedAt ?? null,
  };
}

function presentPo(po: LoadedPo, me?: ResolvedUser) {
  const { bills, request, ...rest } = po;
  // Supplier bills are finance's register: listed only to those who can open
  // them, so a link here never lands on a 403.
  const seesBills = !!me && can(me, 'gfin.ap.view_all');
  return {
    ...rest,
    request: request ? { id: request.id, number: request.number, purpose: request.purpose } : null,
    fromCanvass: awardedCanvass(po),
    bills: seesBills ? bills.map((b) => ({ ...b, total: num(b.total) })) : [],
    billsVisible: seesBills,
    canEdit: !!me && po.status === 'DRAFT' && mayEditPo(me, po),
    vatRate: num(po.vatRate),
    subtotal: num(po.subtotal),
    vatAmount: num(po.vatAmount),
    total: num(po.total),
    items: po.items.map((i) => ({
      ...i,
      quantity: num(i.quantity),
      unitPrice: num(i.unitPrice),
      amount: num(i.amount),
      receivedQty: num(i.receivedQty),
      outstandingQty: cents(num(i.quantity) - num(i.receivedQty)),
    })),
  };
}

purchaseOrderRoutes.get(
  '/:id',
  requireAny('gchain.purchase_orders.view_all', 'gchain.purchase_orders.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const po = await loadPo(req.params.id);
    if (!po) throw notFound('Purchase order not found');
    res.json({
      ...presentPo(po, me),
      returned: po.status === 'DRAFT' ? await lastReturn(po.id) : null,
    });
  }),
);

/**
 * Raising a purchase order, optionally from an awarded canvass.
 *
 * From a canvass, the winning supplier's quoted prices become the order lines —
 * the point of canvassing in the first place.
 */
const poSchema = z.object({
  supplierId: z.string().min(1, 'Choose a supplier'),
  requestId: z.string().optional().nullable(),
  canvassId: z.string().optional().nullable(),
  deliveryDate: z.string().optional().nullable(),
  deliverTo: z.string().optional().nullable(),
  terms: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  vatInclusive: z.boolean().default(false),
});

purchaseOrderRoutes.post(
  '/',
  require_('gchain.purchase_orders.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(poSchema, req.body);
    const company = await prisma.company.findUnique({ where: { id: 'company' } });

    let pr: Awaited<ReturnType<typeof prisma.purchaseRequest.findUnique>> = null;
    let lines: {
      requestItemId: string | null;
      itemId: string | null;
      costCategoryId: string | null;
      description: string;
      quantity: number;
      unit: string;
      unitPrice: number;
    }[] = [];

    if (body.canvassId) {
      const canvass = await prisma.canvass.findUnique({
        where: { id: body.canvassId },
        include: {
          request: { include: { items: true } },
          suppliers: { where: { isSelected: true }, include: { quotes: true } },
        },
      });
      if (!canvass) throw notFound('Canvass not found');
      if (canvass.status !== 'AWARDED') throw badRequest('Award the canvass before raising the order');

      const winner = canvass.suppliers[0];
      if (!winner) throw badRequest('That canvass has no awarded supplier');
      if (winner.supplierId !== body.supplierId) {
        throw badRequest('The order supplier does not match the awarded supplier');
      }

      const priced = new Map(winner.quotes.map((qq) => [qq.requestItemId, num(qq.unitPrice)]));
      pr = canvass.request;
      lines = canvass.request.items
        .filter((i) => priced.has(i.id))
        .map((i) => ({
          requestItemId: i.id,
          itemId: i.itemId,
          costCategoryId: i.costCategoryId,
          description: i.description,
          quantity: num(i.quantity) - num(i.orderedQty),
          unit: i.unit,
          unitPrice: priced.get(i.id) ?? 0,
        }))
        .filter((l) => l.quantity > 0);
    } else if (body.requestId) {
      const found = await prisma.purchaseRequest.findUnique({
        where: { id: body.requestId },
        include: { items: true },
      });
      if (!found) throw notFound('Purchase request not found');
      if (found.status !== 'APPROVED' && found.status !== 'PARTIALLY_ORDERED') {
        throw badRequest('Only an approved request can be ordered');
      }
      pr = found;
      lines = found.items
        .map((i) => ({
          requestItemId: i.id,
          itemId: i.itemId,
          costCategoryId: i.costCategoryId,
          description: i.description,
          quantity: num(i.quantity) - num(i.orderedQty),
          unit: i.unit,
          unitPrice: num(i.estimatedCost),
        }))
        .filter((l) => l.quantity > 0);
    }

    if (pr && !lines.length) {
      throw badRequest('Everything on that request has already been ordered');
    }

    const po = await prisma.$transaction(async (tx) => {
      const number = await nextNumber('purchase_order', tx);
      const created = await tx.purchaseOrder.create({
        data: {
          number,
          kind: pr?.kind ?? 'DIRECT_TO_JOB',
          supplierId: body.supplierId,
          requestId: pr?.id ?? null,
          jobId: pr?.jobId ?? null,
          warehouseId: pr?.warehouseId ?? null,
          createdById: me.id,
          // Set here rather than left to the column's now(), which the
          // database takes in UTC — yesterday's date until 08:00 Manila.
          orderDate: manilaDate(new Date()),
          deliveryDate: asDate(body.deliveryDate),
          deliverTo: body.deliverTo || null,
          terms: body.terms || null,
          notes: body.notes || null,
          vatRate: company?.vatRate ?? D(0.12),
          vatInclusive: body.vatInclusive,
          items: {
            create: lines.map((l, i) => ({
              requestItemId: l.requestItemId,
              itemId: l.itemId,
              costCategoryId: l.costCategoryId,
              description: l.description,
              quantity: D(l.quantity),
              unit: l.unit,
              unitPrice: D(l.unitPrice),
              amount: D(cents(l.quantity * l.unitPrice)),
              sortOrder: i,
            })),
          },
        },
      });
      await recalcPo(created.id, tx);
      return created;
    });

    await audit(
      {
        entityType: 'purchase_order',
        entityId: po.id,
        action: 'CREATED',
        summary: `Raised ${po.number}${pr ? ` from ${pr.number}` : ''}`,
      },
      req,
    );
    res.status(201).json({ ...po, total: num(po.total) });
  }),
);

const poItemSchema = z.object({
  itemId: z.string().optional().nullable(),
  costCategoryId: z.string().optional().nullable(),
  description: z.string().trim().min(1),
  quantity: z.number().positive(),
  unit: z.string().trim().min(1).default('pcs'),
  unitPrice: z.number().min(0),
});

async function poForEdit(req: Parameters<typeof currentUser>[0], id: string) {
  const me = currentUser(req);
  const po = await prisma.purchaseOrder.findUnique({ where: { id } });
  if (!po) throw notFound('Purchase order not found');
  if (po.status !== 'DRAFT') {
    throw badRequest(`${po.number} is ${po.status.toLowerCase().replace(/_/g, ' ')} and cannot be changed`);
  }
  if (!mayEditPo(me, po)) throw forbidden('This order belongs to someone else');
  return { po, me };
}

/** The request's rule, held on the order too: a direct-to-job line must find its budget line. */
function requireCategory(kind: string, costCategoryId: string | null | undefined) {
  if (kind === 'DIRECT_TO_JOB' && !costCategoryId) {
    throw badRequest('A direct-to-job line needs a cost category — it is how the cost finds its budget line');
  }
}

const PO_EDIT = ['gchain.purchase_orders.edit_all', 'gchain.purchase_orders.edit_own'] as const;

purchaseOrderRoutes.post(
  '/:id/items',
  requireAny(...PO_EDIT),
  handler(async (req, res) => {
    const { po, me } = await poForEdit(req, req.params.id);
    const body = parseBody(poItemSchema, req.body);
    requireCategory(po.kind, body.costCategoryId);
    const count = await prisma.purchaseOrderItem.count({ where: { orderId: req.params.id } });

    await prisma.purchaseOrderItem.create({
      data: {
        orderId: req.params.id,
        itemId: body.itemId || null,
        costCategoryId: body.costCategoryId || null,
        description: body.description,
        quantity: D(body.quantity),
        unit: body.unit,
        unitPrice: D(body.unitPrice),
        amount: D(cents(body.quantity * body.unitPrice)),
        sortOrder: count,
      },
    });
    await recalcPo(req.params.id);
    await audit(
      {
        entityType: 'purchase_order',
        entityId: po.id,
        action: 'UPDATED',
        summary: `Added a line to ${po.number}: ${body.description}`,
      },
      req,
    );
    res.status(201).json(presentPo((await loadPo(req.params.id))!, me));
  }),
);

purchaseOrderRoutes.patch(
  '/:id/items/:itemId',
  requireAny(...PO_EDIT),
  handler(async (req, res) => {
    const { po, me } = await poForEdit(req, req.params.id);
    const body = parseBody(poItemSchema.partial(), req.body);
    if (body.costCategoryId !== undefined) requireCategory(po.kind, body.costCategoryId);
    const existing = await prisma.purchaseOrderItem.findFirst({
      where: { id: req.params.itemId, orderId: req.params.id },
    });
    if (!existing) throw notFound('Line not found');

    const quantity = body.quantity ?? num(existing.quantity);
    const unitPrice = body.unitPrice ?? num(existing.unitPrice);

    await prisma.purchaseOrderItem.update({
      where: { id: existing.id },
      data: {
        ...(body.itemId !== undefined ? { itemId: body.itemId || null } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.unit !== undefined ? { unit: body.unit } : {}),
        ...(body.costCategoryId !== undefined ? { costCategoryId: body.costCategoryId || null } : {}),
        quantity: D(quantity),
        unitPrice: D(unitPrice),
        amount: D(cents(quantity * unitPrice)),
      },
    });
    await recalcPo(req.params.id);
    await audit(
      {
        entityType: 'purchase_order',
        entityId: po.id,
        action: 'UPDATED',
        summary: `Modified a line on ${po.number}: ${body.description ?? existing.description}`,
      },
      req,
    );
    res.json(presentPo((await loadPo(req.params.id))!, me));
  }),
);

purchaseOrderRoutes.delete(
  '/:id/items/:itemId',
  requireAny(...PO_EDIT),
  handler(async (req, res) => {
    const { po, me } = await poForEdit(req, req.params.id);
    const existing = await prisma.purchaseOrderItem.findFirst({
      where: { id: req.params.itemId, orderId: req.params.id },
    });
    if (!existing) throw notFound('Line not found');
    await prisma.purchaseOrderItem.delete({ where: { id: existing.id } });
    await recalcPo(req.params.id);
    await audit(
      {
        entityType: 'purchase_order',
        entityId: po.id,
        action: 'UPDATED',
        summary: `Removed a line from ${po.number}: ${existing.description}`,
      },
      req,
    );
    res.json(presentPo((await loadPo(req.params.id))!, me));
  }),
);

purchaseOrderRoutes.patch(
  '/:id',
  requireAny(...PO_EDIT),
  handler(async (req, res) => {
    const { po, me } = await poForEdit(req, req.params.id);
    const body = parseBody(poSchema.partial().omit({ requestId: true, canvassId: true }), req.body);

    // The canvass decided the supplier; swapping it on the draft would issue an
    // order at one supplier's quoted prices to another.
    if (body.supplierId !== undefined && body.supplierId !== po.supplierId) {
      const loaded = await loadPo(po.id);
      const canvass = loaded ? awardedCanvass(loaded) : null;
      if (canvass) {
        throw badRequest(`The supplier was awarded on ${canvass.number} and cannot be changed on the order`);
      }
    }

    await prisma.purchaseOrder.update({
      where: { id: req.params.id },
      data: {
        ...(body.supplierId !== undefined ? { supplierId: body.supplierId } : {}),
        ...(body.deliveryDate !== undefined ? { deliveryDate: asDate(body.deliveryDate) } : {}),
        ...(body.deliverTo !== undefined ? { deliverTo: body.deliverTo || null } : {}),
        ...(body.terms !== undefined ? { terms: body.terms || null } : {}),
        ...(body.notes !== undefined ? { notes: body.notes || null } : {}),
        ...(body.vatInclusive !== undefined ? { vatInclusive: body.vatInclusive } : {}),
      },
    });
    await recalcPo(req.params.id);
    await audit(
      {
        entityType: 'purchase_order',
        entityId: po.id,
        action: 'UPDATED',
        summary: `Modified ${po.number}`,
      },
      req,
    );
    res.json(presentPo((await loadPo(req.params.id))!, me));
  }),
);

purchaseOrderRoutes.post(
  '/:id/submit',
  require_('gchain.purchase_orders.create'),
  handler(async (req, res) => {
    const po = await prisma.purchaseOrder.findUnique({
      where: { id: req.params.id },
      include: { items: true, supplier: true, job: true },
    });
    if (!po) throw notFound('Purchase order not found');
    if (po.status !== 'DRAFT') throw badRequest('This order has already been submitted');
    if (!po.items.length) throw badRequest('Add at least one line before submitting');

    // Claimed on DRAFT, so two presses cannot both submit it.
    const claimed = await prisma.purchaseOrder.updateMany({
      where: { id: po.id, status: 'DRAFT' },
      data: { status: 'PENDING_APPROVAL' },
    });
    if (!claimed.count) throw badRequest('This order has already been submitted');

    try {
      await submitForApproval({
        documentType: 'purchase_order',
        documentId: po.id,
        documentNumber: po.number,
        subject: `${po.supplier.name}${po.job ? ` — ${po.job.number}` : ''}`,
        amount: num(po.total),
        link: `/g-chain/purchase-orders/${po.id}`,
        // Filed in the BUYER's name whoever presses Submit, as a purchase
        // request is in its requester's: the self-approval rule then keeps
        // the person who raised the order off its route, and the route the
        // paper prints for a draft is the route it takes.
        requesterId: po.createdById,
      });
    } catch (err) {
      // Refused (no workflow, nobody to approve, already open): back to a
      // draft, never PENDING with no approval behind it.
      await prisma.purchaseOrder.updateMany({
        where: { id: po.id, status: 'PENDING_APPROVAL' },
        data: { status: 'DRAFT' },
      });
      throw err;
    }

    await audit(
      { entityType: 'purchase_order', entityId: po.id, action: 'SUBMITTED', summary: `${po.number} sent for approval` },
      req,
    );
    res.json({ ok: true, status: 'PENDING_APPROVAL' });
  }),
);

/**
 * An approved order becomes the FIRM commitment.
 *
 * The request's soft commitment at estimated prices is released and replaced
 * with the order's figure at the price actually agreed. Without the release,
 * the same material would be committed twice — once as a request, once as an
 * order — and the project would look far more committed than it is.
 *
 * Claimed on PENDING_APPROVAL with a conditional update, so a decision that
 * finds the order no longer waiting (already issued by a repeated settle, or
 * back in draft) commits nothing twice and the trail says so. A rejection
 * returns it to DRAFT for the buyer to change. Exported for the test.
 */
export async function settlePurchaseOrder(documentId: string, outcome: ApprovalOutcome) {
  const po = await prisma.purchaseOrder.findUnique({ where: { id: documentId } });
  if (!po) return;

  if (outcome !== 'APPROVED') {
    const claimed = await prisma.purchaseOrder.updateMany({
      where: { id: po.id, status: 'PENDING_APPROVAL' },
      data: { status: 'DRAFT' },
    });
    if (!claimed.count) {
      const now = await prisma.purchaseOrder.findUnique({ where: { id: po.id }, select: { status: true } });
      await notApplied('purchase_order', po.id, po.number, now?.status ?? po.status, outcome);
    }
    return;
  }

  const applied = await prisma.$transaction(async (tx) => {
    const claimed = await tx.purchaseOrder.updateMany({
      where: { id: po.id, status: 'PENDING_APPROVAL' },
      data: { status: 'ISSUED', approvedAt: new Date(), issuedAt: new Date() },
    });
    if (!claimed.count) return false;

    const items = await tx.purchaseOrderItem.findMany({ where: { orderId: po.id } });

    // Mark the ordered quantities back on the request.
    for (const line of items) {
      if (!line.requestItemId) continue;
      const reqItem = await tx.purchaseRequestItem.findUnique({ where: { id: line.requestItemId } });
      if (!reqItem) continue;
      await tx.purchaseRequestItem.update({
        where: { id: line.requestItemId },
        data: { orderedQty: D(num(reqItem.orderedQty) + num(line.quantity)) },
      });
    }

    if (po.requestId) {
      const reqItems = await tx.purchaseRequestItem.findMany({ where: { requestId: po.requestId } });
      const fully = reqItems.every((i) => num(i.orderedQty) >= num(i.quantity) - 0.0005);
      await tx.purchaseRequest.update({
        where: { id: po.requestId },
        data: { status: fully ? 'ORDERED' : 'PARTIALLY_ORDERED' },
      });
    }

    if (po.kind !== 'DIRECT_TO_JOB' || !po.jobId) return true;

    // Release the request's soft commitment, then commit the firm figure.
    if (po.requestId) {
      await releaseCommitment(tx, {
        jobId: po.jobId,
        sourceType: 'purchase_request',
        sourceId: po.requestId,
        reason: `Superseded by order ${po.number}`,
        createdById: po.createdById,
      });
    }

    const byCategory = new Map<string, number>();
    for (const line of items) {
      if (!line.costCategoryId) continue;
      byCategory.set(
        line.costCategoryId,
        (byCategory.get(line.costCategoryId) ?? 0) + num(line.amount),
      );
    }
    for (const [costCategoryId, amount] of byCategory) {
      await postJobCost(tx, {
        jobId: po.jobId,
        costCategoryId,
        state: 'COMMITTED',
        amount,
        sourceType: 'purchase_order',
        sourceId: po.id,
        sourceNumber: po.number,
        description: 'Order issued',
        createdById: po.createdById,
      });
    }
    return true;
  });

  if (!applied) {
    const now = await prisma.purchaseOrder.findUnique({ where: { id: po.id }, select: { status: true } });
    await notApplied('purchase_order', po.id, po.number, now?.status ?? po.status, outcome);
    return;
  }

  await audit({
    entityType: 'purchase_order',
    entityId: po.id,
    action: 'APPROVED',
    summary: `${po.number} issued${po.kind === 'DIRECT_TO_JOB' ? ' — budget committed at order price' : ''}`,
  });
}

onApprovalSettled('purchase_order', async (request, outcome) => {
  await settlePurchaseOrder(request.documentId, outcome);
});

purchaseOrderRoutes.delete(
  '/:id',
  require_('gchain.purchase_orders.delete'),
  handler(async (req, res) => {
    const po = await prisma.purchaseOrder.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { receivings: true } } },
    });
    if (!po) throw notFound('Purchase order not found');
    if (po._count.receivings > 0) throw badRequest('Goods have been received against this order');
    if (po.status !== 'DRAFT') throw badRequest('Only a draft order can be deleted');

    await prisma.purchaseOrder.delete({ where: { id: req.params.id } });
    await audit(
      { entityType: 'purchase_order', entityId: req.params.id, action: 'DELETED', summary: `Deleted ${po.number}` },
      req,
    );
    res.json({ ok: true });
  }),
);

// ── PDFs ─────────────────────────────────────────────────────────────────────

purchaseOrderRoutes.get(
  '/:id/pdf',
  requireAny('gchain.purchase_orders.view_all', 'gchain.purchase_orders.view_own'),
  handler(async (req, res) => {
    const po = await loadPo(req.params.id);
    if (!po) throw notFound('Purchase order not found');

    const view = presentPo(po);
    const currency = await companyCurrency();
    // The stored rate as stored — 12.5% prints 12.5%, never a rounded 13%.
    const rate = ratePct(po.vatRate);

    const sections: PdfSection[] = [
      {
        kind: 'fields',
        columns: 2,
        fields: [
          { label: 'Supplier', value: po.supplier.name },
          { label: 'Deliver to', value: po.deliverTo ?? po.warehouse?.name ?? '—' },
          { label: 'Address', value: [po.supplier.address, po.supplier.city].filter(Boolean).join(', ') || '—' },
          { label: 'Required by', value: po.deliveryDate ? formatDate(po.deliveryDate) : '—' },
          { label: 'Terms', value: po.terms ?? po.supplier.paymentTerms ?? '—' },
          // The request it fills, named for what it is.
          { label: 'Purchase request', value: po.request?.number ?? '—' },
          { label: 'For', value: po.job ? `${po.job.number} — ${po.job.name}` : 'Stock replenishment' },
          { label: 'TIN', value: po.supplier.tin ?? '—' },
          // So a draft never leaves the building looking like an order.
          { label: 'Status', value: statusLabel(po.status) },
        ],
      },
      {
        kind: 'table',
        title: 'Order',
        // No widths: each column from its content, the description taking what is left (rule 6).
        head: ['No.', 'Description', 'Qty', 'Unit', `Unit price (${currency})`, `Amount (${currency})`],
        align: ['right', 'left', 'right', 'left', 'right', 'right'],
        rows: view.items.map((i, n) => [
          String(n + 1),
          i.description,
          String(i.quantity),
          i.unit,
          formatAmount(i.unitPrice),
          formatAmount(i.amount),
        ]),
      },
      // The quotation's money block: on an inclusive order the subtotal
      // already carries the VAT, and the line says so.
      {
        kind: 'totals',
        rows: [
          { label: 'Subtotal', value: formatMoney(view.subtotal, currency) },
          { label: po.vatInclusive ? `VAT included (${rate})` : `VAT (${rate})`, value: formatMoney(view.vatAmount, currency) },
          { label: 'Total', value: formatMoney(view.total, currency), bold: true },
        ],
      },
    ];

    if (po.notes) sections.push({ kind: 'text', title: 'Notes', body: po.notes });

    // Prepared by the buyer, with how to reach them (read for the paper
    // only — the order's JSON carries no mobile), then every step of the
    // route through the engine's one mapping (rule 6) — the project manager
    // and finance, who signed and when, "Pending" until they do. A draft
    // prints the route submitting it would take, in the buyer's name as the
    // submit files it (a rejection returns the order to draft, so it reads
    // as one; a pulled-back order's old signatures sign nothing now). A
    // cancelled order prints only the steps that did sign — no approval is
    // coming. One open "Approved by" only while an approval may still come
    // and no workflow covers orders at all. Receiving is its own document,
    // so no slot waits for it here.
    const slots = await approvalSlots(
      'purchase_order',
      po.id,
      po.status === 'DRAFT' ? { amount: view.total, requesterId: po.createdById } : undefined,
    );
    const signatories: Signatory[] = [
      { role: 'Prepared by', name: po.createdBy.name, ...(await contactOf(po.createdById)), at: po.createdAt },
      ...(slots.length ? slotSignatories(slots) : po.status === 'CANCELLED' ? [] : [{ role: 'Approved by' }]),
    ];

    const pdf = await renderDocument({
      title: 'Purchase Order',
      documentNumber: po.number,
      date: po.orderDate,
      // The supplier is named once, in the fields with its address and TIN —
      // never again as the reference.
      sections,
      signatories,
    });

    await audit(
      { entityType: 'purchase_order', entityId: po.id, action: 'EXPORTED', summary: `Printed ${po.number}` },
      req,
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${po.number}.pdf"`);
    res.send(pdf);
  }),
);

purchaseRequestRoutes.get(
  '/:id/pdf',
  requireAny('gchain.purchase_requests.view_all', 'gchain.purchase_requests.view_own'),
  handler(async (req, res) => {
    const pr = await loadPr(req.params.id);
    if (!pr) throw notFound('Purchase request not found');

    // Reads straight off the loaded record — the presented shape widens its
    // item type and loses the fields the table needs.
    const currency = await companyCurrency();
    const estimatedTotal = cents(pr.items.reduce((s, i) => s + num(i.estimatedAmount), 0));

    // Requested by the requester, then every step of the route (a request of
    // ₱50,000 or more takes three), who signed it and when — "Pending" until
    // they do. A draft prints the route submitting would take, every step
    // open: pulled back, its last request keeps the steps that had signed,
    // and those are nobody's signature now. A rejected or cancelled request
    // prints only the steps that signed before it closed — nobody signs the
    // rest — and no open "Approved by", which is only for a request an
    // approval may still come to with no workflow covering it.
    const closed = pr.status === 'REJECTED' || pr.status === 'CANCELLED';
    const slots = await approvalSlots(
      'purchase_request',
      pr.id,
      pr.status === 'DRAFT' ? { amount: estimatedTotal, requesterId: pr.requestedById } : undefined,
    );
    const signatories: Signatory[] = [
      { role: 'Requested by', name: pr.requestedBy.name, ...(await contactOf(pr.requestedById)), at: pr.createdAt },
      ...(slots.length ? slotSignatories(slots) : closed ? [] : [{ role: 'Approved by' }]),
    ];

    const pdf = await renderDocument({
      title: 'Purchase Request',
      documentNumber: pr.number,
      date: pr.createdAt,
      reference: pr.purpose,
      sections: [
        {
          kind: 'fields',
          columns: 3,
          fields: [
            { label: 'Type', value: pr.kind === 'DIRECT_TO_JOB' ? 'Direct to project' : 'Stock replenishment' },
            { label: 'Project', value: pr.job ? `${pr.job.number} — ${pr.job.name}` : '—' },
            { label: 'Warehouse', value: pr.warehouse?.name ?? '—' },
            { label: 'Requested by', value: pr.requestedBy.name },
            { label: 'Needed by', value: pr.neededBy ? formatDate(pr.neededBy) : '—' },
            { label: 'Status', value: statusLabel(pr.status) },
          ],
        },
        {
          kind: 'table',
          title: 'Items requested',
          head: ['No.', 'Description', 'Category', 'Qty', 'Unit', `Est. cost (${currency})`, `Est. amount (${currency})`],
          align: ['right', 'left', 'left', 'right', 'left', 'right', 'right'],
          rows: pr.items.map((i, n) => [
            String(n + 1),
            i.description,
            i.costCategory?.name ?? '—',
            String(num(i.quantity)),
            i.unit,
            formatAmount(num(i.estimatedCost)),
            formatAmount(num(i.estimatedAmount)),
          ]),
        },
        { kind: 'totals', rows: [{ label: 'Estimated total', value: formatMoney(estimatedTotal, currency), bold: true }] },
        ...(pr.notes ? [{ kind: 'text' as const, title: 'Notes', body: pr.notes }] : []),
      ],
      signatories,
    });

    await audit(
      { entityType: 'purchase_request', entityId: pr.id, action: 'EXPORTED', summary: `Printed ${pr.number}` },
      req,
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${pr.number}.pdf"`);
    res.send(pdf);
  }),
);

// ── Global search ────────────────────────────────────────────────────────────
// Ctrl+K finds a procurement document by its number — "PO-2026-0142" is the
// example the palette itself promises. Numbers and names only; each hit links
// to the record, never to the list.

registerSearch({
  kind: 'purchase_request',
  label: 'Purchase requests',
  permission: ['gchain.purchase_requests.view_all', 'gchain.purchase_requests.view_own'],
  // The list's own rule (procurement.ts, GET /): own-scope sees what it raised.
  ownWhere: (user) => ({ requestedById: user.id }),
  async search(term, _user, limit, own) {
    const rows = await prisma.purchaseRequest.findMany({
      where: {
        ...(own ?? {}),
        OR: [
          { number: { contains: term, mode: 'insensitive' } },
          { purpose: { contains: term, mode: 'insensitive' } },
          { job: { number: { contains: term, mode: 'insensitive' } } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, number: true, purpose: true, status: true, job: { select: { number: true } } },
    });
    return rows.map((r) => ({
      kind: 'purchase_request',
      id: r.id,
      title: `${r.number} — ${r.purpose}`,
      subtitle: [r.job?.number, r.status.toLowerCase().replace(/_/g, ' ')].filter(Boolean).join(' · '),
      link: `/g-chain/purchase-requests/${r.id}`,
    }));
  },
});

registerSearch({
  kind: 'canvass',
  label: 'Canvass',
  permission: ['gchain.canvass.view_all', 'gchain.canvass.view_own'],
  ownWhere: (user) => ({ createdById: user.id }),
  async search(term, _user, limit, own) {
    const rows = await prisma.canvass.findMany({
      where: {
        ...(own ?? {}),
        OR: [
          { number: { contains: term, mode: 'insensitive' } },
          { request: { number: { contains: term, mode: 'insensitive' } } },
          { request: { purpose: { contains: term, mode: 'insensitive' } } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, number: true, status: true, request: { select: { number: true, purpose: true } } },
    });
    return rows.map((r) => ({
      kind: 'canvass',
      id: r.id,
      title: `${r.number} — ${r.request.purpose}`,
      subtitle: `${r.request.number} · ${r.status.toLowerCase()}`,
      link: `/g-chain/canvass/${r.id}`,
    }));
  },
});

registerSearch({
  kind: 'purchase_order',
  label: 'Purchase orders',
  permission: ['gchain.purchase_orders.view_all', 'gchain.purchase_orders.view_own'],
  ownWhere: (user) => ({ createdById: user.id }),
  async search(term, _user, limit, own) {
    const rows = await prisma.purchaseOrder.findMany({
      where: {
        ...(own ?? {}),
        OR: [
          { number: { contains: term, mode: 'insensitive' } },
          { supplier: { name: { contains: term, mode: 'insensitive' } } },
          { job: { number: { contains: term, mode: 'insensitive' } } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        number: true,
        status: true,
        supplier: { select: { name: true } },
        job: { select: { number: true } },
      },
    });
    return rows.map((r) => ({
      kind: 'purchase_order',
      id: r.id,
      title: `${r.number} — ${r.supplier.name}`,
      subtitle: [r.job?.number ?? 'Stock', r.status.toLowerCase().replace(/_/g, ' ')].join(' · '),
      link: `/g-chain/purchase-orders/${r.id}`,
    }));
  },
});
