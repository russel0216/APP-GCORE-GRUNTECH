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
  deleteOrRefuse,
  type ListQuery,
} from '../http/kit';
import { deleteAttachmentsOf } from '../shared/attachments';
import { authenticate, require_, requireAny, currentUser } from '../auth/middleware';
import { can, canEditRecord, type ResolvedUser } from '../permissions/resolve';
import { audit } from '../shared/audit';
import { registerSearch } from '../shared/search';
import { nextNumber } from '../shared/numbering';
import {
  submitForApproval,
  onApprovalSettled,
  approvalSlots,
  preparedAt,
  slotSignatories,
  contactOf,
  cancelOpenRequest,
  routeBrief,
  type ApprovalOutcome,
} from '../shared/approvals';
import {
  renderDocument,
  formatMoney,
  formatAmount,
  formatDate,
  formatShortDate,
  formatQuantity,
  statusLabel,
  companyCurrency,
  type PdfCell,
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
import { contentDisposition, paperFileName } from '../shared/paperName';
import { canvassFigures, MAX_SHEET_SUPPLIERS, type SheetLine } from '../shared/canvassMath';

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
      pulledQty: num(i.pulledQty as Prisma.Decimal),
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

// ── The requisition page's helpers (2026-10-13) ─────────────────────────────
//
// The owner's call: "Purchase request in Project should not be popup window,
// it should be a full form with line item and budget allocation". The page
// (`/g-ops/projects/:jobId/purchase-requests/new`, `/…/:id/edit`) reads three
// things before anything is saved, each declared above `/:id`: the project's
// budget by budget line, what a line may be filled from (the project's
// costing and the item master), and the route submitting would take.

/** Whoever may raise or change a request — the page's own readers. */
const PR_WRITERS = [
  'gchain.purchase_requests.create',
  'gchain.purchase_requests.edit_own',
  'gchain.purchase_requests.edit_all',
] as const;

/**
 * The project's budget by budget line: budgeted, committed, incurred and
 * available (`availableBudget()`'s arithmetic, every category in one query),
 * one row per ACTIVE cost category in its order, and the project's whole.
 * A draft commits nothing, so nothing is left out for the request being
 * edited; the page subtracts its own lines live.
 */
export async function projectBudgetByLine(jobId: string) {
  const [categories, rows] = await Promise.all([
    prisma.costCategory.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, code: true, name: true },
    }),
    prisma.jobCostEntry.groupBy({ by: ['costCategoryId', 'state'], where: { jobId }, _sum: { amount: true } }),
  ]);
  const sum = (categoryId: string | null, state: string) =>
    rows
      .filter((r) => (categoryId === null || r.costCategoryId === categoryId) && r.state === state)
      .reduce((s, r) => s + num(r._sum.amount), 0);
  const position = (categoryId: string | null) => {
    const budgeted = sum(categoryId, 'BUDGETED');
    const committed = sum(categoryId, 'COMMITTED');
    const incurred = sum(categoryId, 'INCURRED');
    return {
      budgeted: cents(budgeted),
      committed: cents(committed),
      incurred: cents(incurred),
      available: cents(budgeted - committed - incurred),
    };
  };
  return {
    lines: categories.map((c) => ({ ...c, ...position(c.id) })),
    total: position(null),
  };
}

purchaseRequestRoutes.get(
  '/budget',
  requireAny(...PR_WRITERS),
  handler(async (req, res) => {
    const jobId = String(req.query.jobId ?? '');
    if (!jobId) throw badRequest('Name the project');
    const job = await prisma.job.findUnique({ where: { id: jobId }, select: { id: true, number: true, name: true } });
    if (!job) throw notFound('Project not found');
    // The project's number and name come too: the page's header names it for
    // a requester who cannot list projects.
    res.json({ job, ...(await projectBudgetByLine(jobId)), blocked: await overBudgetIsBlocked() });
  }),
);

/**
 * What a line may be filled from, as it is typed: the project's costing lines
 * (its own estimate — name, description, unit, quantity, budget line) and the
 * item master (code, part number, name, unit, budget line). A COST comes only
 * where the caller may see it: the costing's to a costing or budget reader or
 * the project's manager, an item's standard cost to an item or costing
 * reader — the quotation's suggestion rule. Without `q` the costing's lines
 * come whole ("Add from costing…"); the items need a word.
 */
export async function lineSuggestions(me: ResolvedUser, term: string, jobId: string) {
  const job = jobId
    ? await prisma.job.findUnique({ where: { id: jobId }, select: { costingId: true, projectManagerId: true } })
    : null;
  const seesCostingCost =
    can(me, 'gops.costing.view_all') ||
    can(me, 'gops.budget_monitoring.view_all') ||
    (job !== null && job.projectManagerId === me.id);
  const seesItemCost = can(me, 'gchain.items.view_all') || can(me, 'gops.costing.view_all');
  const words = term
    ? {
        OR: [
          { name: { contains: term, mode: 'insensitive' as const } },
          { description: { contains: term, mode: 'insensitive' as const } },
        ],
      }
    : {};
  const [costing, items] = await Promise.all([
    job
      ? prisma.costingLine.findMany({
          where: { costingId: job.costingId, isHeading: false, ...words },
          orderBy: [{ costCategory: { sortOrder: 'asc' } }, { sortOrder: 'asc' }],
          take: term ? 25 : 500,
          select: {
            id: true,
            name: true,
            description: true,
            quantity: true,
            unit: true,
            unitCost: true,
            itemId: true,
            item: { select: { partNumber: true } },
            costCategory: { select: { id: true, code: true, name: true } },
            supplierName: true,
            supplier: { select: { name: true } },
          },
        })
      : [],
    term
      ? prisma.item.findMany({
          where: {
            isActive: true,
            OR: [
              { name: { contains: term, mode: 'insensitive' } },
              { code: { contains: term, mode: 'insensitive' } },
              { partNumber: { contains: term, mode: 'insensitive' } },
            ],
          },
          orderBy: { name: 'asc' },
          take: 15,
          select: {
            id: true,
            code: true,
            partNumber: true,
            name: true,
            description: true,
            unit: true,
            standardCost: true,
            costCategory: { select: { id: true, code: true, name: true } },
          },
        })
      : [],
  ]);
  return {
    costing: costing.map((l) => ({
      id: l.id,
      itemId: l.itemId,
      partNumber: l.item?.partNumber ?? null,
      name: l.name ?? l.description,
      description: l.name && l.description !== l.name ? l.description : '',
      quantity: num(l.quantity),
      unit: l.unit,
      unitCost: seesCostingCost ? num(l.unitCost) : null,
      costCategory: l.costCategory,
      /** Who the costing says supplies it — the request's preferred supplier when it names none. */
      supplier: l.supplier?.name ?? l.supplierName ?? null,
    })),
    items: items.map((i) => ({
      id: i.id,
      code: i.code,
      partNumber: i.partNumber,
      name: i.name,
      description: i.description ?? '',
      unit: i.unit,
      unitCost: seesItemCost && i.standardCost != null ? num(i.standardCost) : null,
      costCategory: i.costCategory,
    })),
  };
}

purchaseRequestRoutes.get(
  '/suggest',
  requireAny(...PR_WRITERS),
  handler(async (req, res) => {
    res.json(await lineSuggestions(currentUser(req), String(req.query.q ?? '').trim(), String(req.query.jobId ?? '')));
  }),
);

/**
 * The route submitting would take — "Submit for approval sends it to …" on
 * the page, as the request stands (`amount`) and in its requester's name (the
 * request's own when one is named, else the caller's).
 */
purchaseRequestRoutes.get(
  '/route',
  requireAny(...PR_WRITERS),
  handler(async (req, res) => {
    const me = currentUser(req);
    const amount = Number(req.query.amount ?? 0);
    if (!Number.isFinite(amount) || amount < 0) throw badRequest('The amount is not a number');
    const requestId = req.query.requestId ? String(req.query.requestId) : null;
    const pr = requestId
      ? await prisma.purchaseRequest.findUnique({ where: { id: requestId }, select: { requestedById: true, jobId: true } })
      : null;
    if (requestId && !pr) throw notFound('Purchase request not found');
    const jobId = pr?.jobId ?? (req.query.jobId ? String(req.query.jobId) : null);
    res.json({ route: await routeBrief('purchase_request', amount, pr?.requestedById ?? me.id, null, { jobId }) });
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
      rfqs: {
        orderBy: { createdAt: 'desc' },
        select: { id: true, number: true, status: true, createdAt: true, _count: { select: { suppliers: true, items: true } } },
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
    // The request's OWN net commitment (an approved one committed its
    // estimate) is left out, so "This request" is never counted twice — once
    // in "Already committed" and again against what is left.
    const budget: Record<string, Awaited<ReturnType<typeof availableBudget>>> = {};
    if (pr.jobId) {
      const categoryIds = [...new Set(pr.items.map((i) => i.costCategoryId).filter(Boolean))] as string[];
      const own = await prisma.jobCostEntry.groupBy({
        by: ['costCategoryId'],
        where: { jobId: pr.jobId, state: 'COMMITTED', sourceType: 'purchase_request', sourceId: pr.id },
        _sum: { amount: true },
      });
      for (const categoryId of categoryIds) {
        const b = await availableBudget(prisma, pr.jobId, categoryId);
        const mine = num(own.find((o) => o.costCategoryId === categoryId)?._sum.amount);
        budget[categoryId] = mine
          ? { ...b, committed: Math.round((b.committed - mine) * 100) / 100, available: Math.round((b.available + mine) * 100) / 100 }
          : b;
      }
    }

    res.json({
      ...presentPr(pr as unknown as Record<string, unknown>),
      orders: pr.orders.map((o) => ({ ...o, total: num(o.total) })),
      budget,
      // The routes' own rules (prForEdit, /withdraw): a draft is changed, and
      // a pending one pulled back, by its requester or an edit_all holder.
      canEdit: pr.status === 'DRAFT' && mayEditPr(me, pr),
      /** What the page's save claims on (`PUT /:id/sheet`'s `version`). */
      version: pr.updatedAt.toISOString(),
      canWithdraw: pr.status === 'PENDING_APPROVAL' && mayEditPr(me, pr),
      // POST /:id/cancel's own rule, short of the canvass check it makes itself.
      canCancel: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(pr.status) && pr.orders.length === 0 && mayEditPr(me, pr),
    });
  }),
);

/**
 * One line of the requisition page's save — `POST /` with `lines[]` and
 * `PUT /:id/sheet`. A line sent with its `id` is updated in place; a line
 * left out is removed (the costing sheet's rule, never delete-and-recreate).
 * `name` is the bold title; a line typed as a name alone carries it as its
 * description too, because every older reader prints `description`.
 */
const prLineSchema = z.object({
  id: z.string().optional().nullable(),
  itemId: z.string().optional().nullable(),
  costCategoryId: z.string().optional().nullable(),
  partNumber: z.string().trim().max(120).optional().nullable(),
  name: z.string().trim().max(300).optional().nullable(),
  description: z.string().trim().max(4000).optional().nullable(),
  quantity: z.number().positive('Quantity must be more than zero'),
  unit: z.string().trim().max(40).optional().nullable(),
  estimatedCost: z.number().min(0, 'An estimated cost cannot be negative').default(0),
});
type PrLineInput = z.infer<typeof prLineSchema>;

interface CheckedPrLine {
  id: string | null;
  itemId: string | null;
  costCategoryId: string | null;
  partNumber: string | null;
  name: string | null;
  description: string;
  quantity: number;
  unit: string;
  estimatedCost: number;
}

/**
 * The lines as they will be written, every reference checked first: the item
 * and the budget line must exist, a line must say what it is, and on a
 * direct-to-job request every line names its budget line — the item's own
 * where it has one, else refused naming the line. `existingIds` are the
 * request's own lines; an id that is not one of them is a 400.
 */
async function checkPrLines(kind: string, lines: PrLineInput[], existingIds: string[]): Promise<CheckedPrLine[]> {
  const itemIds = [...new Set(lines.map((l) => l.itemId).filter((v): v is string => !!v))];
  const categoryIds = [...new Set(lines.map((l) => l.costCategoryId).filter((v): v is string => !!v))];
  const [items, categories] = await Promise.all([
    itemIds.length
      ? prisma.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, costCategoryId: true } })
      : [],
    categoryIds.length ? prisma.costCategory.findMany({ where: { id: { in: categoryIds } }, select: { id: true } }) : [],
  ]);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const known = new Set(categories.map((c) => c.id));
  const own = new Set(existingIds);
  return lines.map((l, index) => {
    const n = index + 1;
    if (l.id && !own.has(l.id)) throw badRequest(`Line ${n} is not on this request`);
    if (l.itemId && !itemById.has(l.itemId)) throw badRequest(`Line ${n}: that item is not in the item master`);
    if (l.costCategoryId && !known.has(l.costCategoryId)) throw badRequest(`Line ${n}: that budget line does not exist`);
    const name = l.name?.trim() || null;
    const description = l.description?.trim() || name;
    if (!description) throw badRequest(`Line ${n}: say what is needed`);
    const costCategoryId = l.costCategoryId || (l.itemId ? itemById.get(l.itemId)?.costCategoryId : null) || null;
    if (kind === 'DIRECT_TO_JOB' && !costCategoryId) {
      throw badRequest(`Line ${n} (${name ?? description}): choose its budget line — it is how the cost finds the project budget`);
    }
    return {
      id: l.id || null,
      itemId: l.itemId || null,
      costCategoryId,
      partNumber: l.partNumber?.trim() || null,
      name,
      description,
      quantity: l.quantity,
      unit: l.unit?.trim() || 'pcs',
      estimatedCost: l.estimatedCost,
    };
  });
}

/** Writes the checked lines in order: updates the ones with an id, creates the rest, removes what was left out. */
async function writePrLines(tx: Prisma.TransactionClient, requestId: string, lines: CheckedPrLine[]) {
  const keep = lines.map((l) => l.id).filter((v): v is string => !!v);
  await tx.purchaseRequestItem.deleteMany({ where: { requestId, id: { notIn: keep } } });
  for (const [sortOrder, l] of lines.entries()) {
    const data = {
      itemId: l.itemId,
      costCategoryId: l.costCategoryId,
      partNumber: l.partNumber,
      name: l.name,
      description: l.description,
      quantity: D(l.quantity),
      unit: l.unit,
      estimatedCost: D(l.estimatedCost),
      estimatedAmount: D(cents(l.quantity * l.estimatedCost)),
      sortOrder,
    };
    if (l.id) await tx.purchaseRequestItem.update({ where: { id: l.id }, data });
    else await tx.purchaseRequestItem.create({ data: { requestId, ...data } });
  }
}

const prSchema = z.object({
  kind: z.enum(['DIRECT_TO_JOB', 'STOCK_REPLENISHMENT']).default('DIRECT_TO_JOB'),
  jobId: z.string().optional().nullable(),
  warehouseId: z.string().optional().nullable(),
  purpose: z.string().trim().min(3, 'Say what this is for'),
  neededBy: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  preferredSupplier: z.string().trim().max(200).optional().nullable(),
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
    const body = parseBody(prSchema.extend({ lines: z.array(prLineSchema).max(500).optional() }), req.body);
    checkPrTarget(body.kind, body.jobId, body.warehouseId);
    if (body.jobId && body.kind === 'DIRECT_TO_JOB') {
      const job = await prisma.job.findUnique({ where: { id: body.jobId }, select: { id: true } });
      if (!job) throw badRequest('That project does not exist');
    }
    // Every line is checked before the number is issued: a refused line
    // burns no number (the costing sheet's rule).
    const lines = body.lines ? await checkPrLines(body.kind, body.lines, []) : [];

    const pr = await prisma.$transaction(async (tx) => {
      const number = await nextNumber('purchase_request', tx);
      const created = await tx.purchaseRequest.create({
        data: {
          number,
          kind: body.kind,
          jobId: body.kind === 'DIRECT_TO_JOB' ? body.jobId : null,
          warehouseId: body.warehouseId || null,
          requestedById: me.id,
          purpose: body.purpose,
          neededBy: asDate(body.neededBy),
          notes: body.notes || null,
          preferredSupplier: body.preferredSupplier || null,
        },
      });
      await writePrLines(tx, created.id, lines);
      await audit(
        {
          entityType: 'purchase_request',
          entityId: created.id,
          action: 'CREATED',
          summary: `Raised ${created.number} — ${created.purpose}${lines.length ? ` (${lines.length} line${lines.length === 1 ? '' : 's'})` : ''}`,
        },
        req,
        tx,
      );
      return created;
    });

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
        preferredSupplier: z.string().trim().max(200).optional().nullable(),
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
    if (body.preferredSupplier !== undefined && (body.preferredSupplier || null) !== pr.preferredSupplier) {
      changed.push('preferred supplier');
    }
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
          ...(body.preferredSupplier !== undefined ? { preferredSupplier: body.preferredSupplier || null } : {}),
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
 * The requisition page's save: the header AND the lines in one transaction
 * (`PUT /:id/sheet`). The header follows PATCH's rules — the kind, the
 * project and the warehouse under `checkPrTarget` — and the lines
 * `checkPrLines()`, all checked before anything is written. Claimed on DRAFT
 * and on the `updatedAt` the page read (`version`), so a submit, or another
 * save, that landed in between wins: "It changed a moment ago — reload".
 */
purchaseRequestRoutes.put(
  '/:id/sheet',
  requireAny(...PR_EDIT),
  handler(async (req, res) => {
    const { pr } = await prForEdit(req, req.params.id);
    const body = parseBody(
      prSchema.extend({ lines: z.array(prLineSchema).max(500), version: z.string().optional().nullable() }),
      req.body,
    );
    const kind = body.kind;
    const jobId = kind === 'STOCK_REPLENISHMENT' ? null : body.jobId || null;
    const warehouseId = body.warehouseId || null;
    checkPrTarget(kind, jobId, warehouseId);
    if (jobId && jobId !== pr.jobId) {
      const job = await prisma.job.findUnique({ where: { id: jobId }, select: { id: true } });
      if (!job) throw badRequest('That project does not exist');
    }
    if (warehouseId && warehouseId !== pr.warehouseId) {
      const warehouse = await prisma.warehouse.findUnique({ where: { id: warehouseId }, select: { id: true } });
      if (!warehouse) throw badRequest('That warehouse does not exist');
    }
    const lines = await checkPrLines(kind, body.lines, pr.items.map((i) => i.id));
    const version = body.version ? new Date(body.version) : null;
    if (version && Number.isNaN(version.getTime())) throw badRequest('The version is not a date');

    await prisma.$transaction(async (tx) => {
      const claimed = await tx.purchaseRequest.updateMany({
        where: { id: pr.id, status: 'DRAFT', ...(version ? { updatedAt: version } : {}) },
        data: {
          kind,
          jobId,
          warehouseId,
          purpose: body.purpose,
          neededBy: asDate(body.neededBy),
          notes: body.notes || null,
          preferredSupplier: body.preferredSupplier || null,
        },
      });
      if (!claimed.count) throw badRequest(`${pr.number} changed a moment ago — reload it and make the change again`);
      await writePrLines(tx, pr.id, lines);
      const total = lines.reduce((sum, l) => sum + cents(l.quantity * l.estimatedCost), 0);
      await audit(
        {
          entityType: 'purchase_request',
          entityId: pr.id,
          action: 'UPDATED',
          summary: `Modified ${pr.number}: ${lines.length} line${lines.length === 1 ? '' : 's'}, ${formatMoney(cents(total))} estimated`,
        },
        req,
        tx,
      );
    });

    const full = await loadPr(pr.id);
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

/**
 * Cancels a purchase request (2026-10-11, the owner's call) — its requester
 * or edit_all, with a reason. A draft, a pending one (its request withdrawn
 * through the engine in the same transaction) or an approved one nothing has
 * been bought on: no purchase order, and no canvass still open or awarded.
 * An approved direct-to-job request releases the budget it committed. The
 * claim is on the status it was read in, so a decision landing meanwhile
 * refuses the cancel rather than being written over.
 */
purchaseRequestRoutes.post(
  '/:id/cancel',
  requireAny(...PR_EDIT),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(z.object({ reason: z.string().trim().min(3, 'Say why it is cancelled').max(2000) }), req.body);
    const pr = await prisma.purchaseRequest.findUnique({
      where: { id: req.params.id },
      include: {
        _count: { select: { orders: true } },
        canvasses: { where: { status: { not: 'CANCELLED' } }, select: { number: true } },
        rfqs: { where: { status: { in: ['DRAFT', 'SENT', 'QUOTED'] } }, select: { number: true } },
        pulloutSlips: { where: { status: { not: 'CANCELLED' } }, select: { number: true } },
      },
    });
    if (!pr) throw notFound('Purchase request not found');
    if (!mayEditPr(me, pr)) throw forbidden('This request belongs to someone else');
    if (!['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(pr.status)) {
      throw badRequest(pr.status === 'CANCELLED' ? 'This request is already cancelled' : `A ${statusLabel(pr.status).toLowerCase()} request cannot be cancelled`);
    }
    if (pr._count.orders > 0) throw badRequest('Purchase orders were raised from this request — cancel those first');
    if (pr.canvasses.length) throw badRequest(`Canvass ${pr.canvasses.map((c) => c.number).join(', ')} is still on this request — cancel it first`);
    if (pr.rfqs.length) throw badRequest(`RFQ ${pr.rfqs.map((r) => r.number).join(', ')} is still open on this request — cancel it first`);
    // Stock pulled from the shelf for it (2026-10-14) is a fact, not an intention.
    if (pr.pulloutSlips.length) throw badRequest(`Pull-out slip ${pr.pulloutSlips.map((p) => p.number).join(', ')} stands on this request — cancel it first, or keep the request`);

    await prisma.$transaction(async (tx) => {
      const claimed = await tx.purchaseRequest.updateMany({
        where: { id: pr.id, status: pr.status },
        data: { status: 'CANCELLED', notes: `${pr.notes ? `${pr.notes}\n` : ''}Cancelled: ${body.reason}` },
      });
      if (!claimed.count) throw badRequest('It changed a moment ago — reload to see where it stands');
      if (pr.status === 'PENDING_APPROVAL') {
        const withdrawn = await cancelOpenRequest('purchase_request', pr.id, tx, `cancelled by ${me.name}: ${body.reason}`, me.id);
        if (!withdrawn.length) {
          const last = await tx.approvalRequest.findFirst({
            where: { documentType: 'purchase_request', documentId: pr.id },
            orderBy: { createdAt: 'desc' },
            select: { status: true },
          });
          if (last && (last.status === 'APPROVED' || last.status === 'REJECTED')) {
            throw badRequest('It was decided a moment ago — reload to see where it stands');
          }
        }
      }
      if (pr.status === 'APPROVED' && pr.kind === 'DIRECT_TO_JOB' && pr.jobId) {
        await releaseCommitment(tx, {
          jobId: pr.jobId,
          sourceType: 'purchase_request',
          sourceId: pr.id,
          reason: `${pr.number} cancelled`,
          createdById: me.id,
        });
      }
    });
    await audit(
      { entityType: 'purchase_request', entityId: pr.id, action: 'CANCELLED', summary: `${pr.number} cancelled — ${body.reason}` },
      req,
    );
    res.json({ ok: true, status: 'CANCELLED' });
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
      include: { _count: { select: { orders: true } }, rfqs: { select: { suppliers: { select: { id: true } } } } },
    });
    if (!pr) throw notFound('Purchase request not found');
    if (pr.status !== 'DRAFT' && pr.status !== 'REJECTED' && pr.status !== 'CANCELLED') {
      throw badRequest('Only a draft, rejected or cancelled request can be deleted — cancel it first');
    }
    if (pr._count.orders > 0) throw badRequest('Purchase orders were raised from this request');

    await deleteOrRefuse(pr.number, () => prisma.purchaseRequest.delete({ where: { id: req.params.id } }));
    await deleteAttachmentsOf('purchase_request', [pr.id]);
    // Its cancelled RFQs cascade with it; their suppliers' quotation files go too.
    await deleteAttachmentsOf('rfq_supplier', pr.rfqs.flatMap((r) => r.suppliers.map((s) => s.id)));
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

/*
 * The canvass is the COMPARISON SHEET (2026-10-14, the owner's call:
 * "Purchase Request, RFQ, Canvass, Purchase Order"; his sample canvass sheet
 * with a row for Percentage Savings against the approved request). Raised
 * from an RFQ, it SNAPSHOTS the RFQ's lines (`lineIds`), the suppliers that
 * quoted and their quotes — the abstract is a record, so a quote changed on
 * the RFQ later never moves an awarded sheet ("Refresh from RFQ" copies again
 * while it is OPEN). Raised from a request with no RFQ (a quote already in
 * hand) it compares every line of the request, as a canvass always did. The
 * arithmetic is `canvassFigures()` in `shared/canvassMath.ts`. No approval
 * route: the award is the buyer's decision on record, and the purchase order
 * raised from it is approved.
 */

const CANVASS_SORTS = ['number', 'createdAt'];

/** A reader with view_own alone sees what they opened (the search provider's own rule). */
function seesAllCanvasses(me: ResolvedUser) {
  return can(me, 'gchain.canvass.view_all');
}

/** Which canvasses a list query means — one rule for the list and its printed twin. */
function canvassListWhere(me: ResolvedUser, q: ListQuery): Prisma.CanvassWhereInput {
  const and: Prisma.CanvassWhereInput[] = [];
  if (!seesAllCanvasses(me) || q.scope === 'mine') and.push({ createdById: me.id });
  const f = q.filters;
  const status = choice(f.status, CanvassStatus, 'Status');
  if (status) and.push({ status });
  if (f.rfqId) and.push({ rfqId: f.rfqId });
  if (f.requestId) and.push({ requestId: f.requestId });
  if (f.supplierId) and.push({ suppliers: { some: { supplierId: f.supplierId } } });
  if (q.search) {
    and.push({
      OR: [
        { number: { contains: q.search, mode: 'insensitive' } },
        { request: { number: { contains: q.search, mode: 'insensitive' } } },
        { request: { purpose: { contains: q.search, mode: 'insensitive' } } },
        { rfq: { number: { contains: q.search, mode: 'insensitive' } } },
        { suppliers: { some: { supplier: { name: { contains: q.search, mode: 'insensitive' } } } } },
      ],
    });
  }
  const ids = idsFilter(f.ids);
  if (ids) and.push({ id: { in: ids } });
  return and.length ? { AND: and } : {};
}

/** The lines a sheet compares: its snapshot, else (a canvass opened before 2026-10-14) every line of its request. */
function sheetLinesOf<T extends { id: string }>(canvass: { lineIds: string[] }, items: T[]): T[] {
  if (!canvass.lineIds.length) return items;
  const keep = new Set(canvass.lineIds);
  return items.filter((i) => keep.has(i.id));
}

type FigureItem = { id: string; quantity: Prisma.Decimal; estimatedCost: Prisma.Decimal; estimatedAmount: Prisma.Decimal };
type FigureSupplier = { id: string; quotes: { requestItemId: string; unitPrice: Prisma.Decimal }[] };

/** The sheet's figures — the reference budget and each supplier column's total and saving. */
function figuresOf(canvass: { lineIds: string[] }, items: FigureItem[], suppliers: FigureSupplier[]) {
  const lines: SheetLine[] = sheetLinesOf(canvass, items).map((i) => ({
    id: i.id,
    quantity: num(i.quantity),
    estimatedCost: num(i.estimatedCost),
    estimatedAmount: num(i.estimatedAmount),
  }));
  return canvassFigures(
    lines,
    suppliers.map((s) => ({ id: s.id, prices: Object.fromEntries(s.quotes.map((qq) => [qq.requestItemId, num(qq.unitPrice)])) })),
  );
}

const LIST_INCLUDE = {
  request: {
    select: {
      id: true,
      number: true,
      purpose: true,
      job: { select: { id: true, number: true, name: true } },
      items: { select: { id: true, quantity: true, estimatedCost: true, estimatedAmount: true } },
    },
  },
  rfq: { select: { id: true, number: true } },
  createdBy: { select: { id: true, name: true } },
  suppliers: {
    orderBy: { id: 'asc' },
    select: { id: true, isSelected: true, supplier: { select: { name: true } }, quotes: { select: { requestItemId: true, unitPrice: true } } },
  },
} satisfies Prisma.CanvassInclude;

type ListedCanvass = Prisma.CanvassGetPayload<{ include: typeof LIST_INCLUDE }>;

/** A list row: the awarded supplier, else the lowest complete quote, with its saving against the request's estimate. */
function canvassRow(c: ListedCanvass) {
  const figures = figuresOf(c, c.request.items, c.suppliers);
  const awarded = c.suppliers.find((s) => s.isSelected);
  const pickId = awarded?.id ?? figures.lowestCompleteId;
  const pick = pickId ? figures.columns.find((col) => col.id === pickId) : undefined;
  const pickName = pickId ? c.suppliers.find((s) => s.id === pickId)?.supplier.name ?? null : null;
  const { items: _items, ...request } = c.request;
  return {
    id: c.id,
    number: c.number,
    status: c.status,
    createdAt: c.createdAt,
    awardedAt: c.awardedAt,
    request,
    rfq: c.rfq,
    createdBy: c.createdBy,
    supplierCount: c.suppliers.length,
    suppliers: c.suppliers.map((s) => s.supplier.name),
    awarded: awarded?.supplier.name ?? null,
    budget: figures.budget,
    /** The awarded supplier, else the lowest complete quote: what the sheet's saving is read off. */
    pick: pick && pickName ? { name: pickName, total: pick.total, savings: pick.savings, savingsPct: pick.savingsPct, awarded: !!awarded, complete: pick.complete } : null,
  };
}

canvassRoutes.get(
  '/',
  requireAny('gchain.canvass.view_all', 'gchain.canvass.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const where = canvassListWhere(me, q);
    const [rows, total, byStatus] = await Promise.all([
      prisma.canvass.findMany({
        where,
        include: LIST_INCLUDE,
        orderBy: orderBy(q, CANVASS_SORTS, { createdAt: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.canvass.count({ where }),
      prisma.canvass.groupBy({ by: ['status'], where, _count: true }),
    ]);
    const counted = (s: CanvassStatus) => byStatus.find((b) => b.status === s)?._count ?? 0;
    res.json({
      ...listResult(rows.map(canvassRow), total, q),
      summary: { count: total, open: counted('OPEN'), awarded: counted('AWARDED') },
    });
  }),
);

/**
 * The canvass list on paper, through `canvassListWhere` (or the rows ticked,
 * `?ids=`): each sheet's reference budget and the saving of its award (else
 * its lowest complete quote) — never a supplier's line prices, which belong
 * on the sheet itself. Ten columns, so landscape. Above `/:id`.
 */
canvassRoutes.get(
  '/pdf',
  requireAny('gchain.canvass.view_all', 'gchain.canvass.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const where = canvassListWhere(me, q);
    const [rows, count] = await Promise.all([
      prisma.canvass.findMany({ where, include: LIST_INCLUDE, orderBy: orderBy(q, CANVASS_SORTS, { createdAt: 'desc' }), take: LIST_CAP }),
      prisma.canvass.count({ where }),
    ]);
    const f = q.filters;
    const [rfqNamed, requestNamed, supplierNamed] = await Promise.all([
      recordNamed('RFQ', f.rfqId),
      recordNamed('purchase request', f.requestId),
      recordNamed('supplier', f.supplierId),
    ]);
    const reference = listReference(count, rows.length, ['canvass', 'canvasses'], [
      q.search && `search "${q.search}"`,
      f.status && `status ${statusLabel(f.status)}`,
      rfqNamed,
      requestNamed,
      supplierNamed,
      q.scope === 'mine' && 'opened by me',
      f.ids && 'the rows selected',
    ]);
    const currency = await companyCurrency();
    const pdf = await renderDocument({
      title: 'Canvass Sheets',
      date: new Date(),
      reference,
      landscape: true,
      sections: [
        {
          kind: 'table',
          head: ['Number', 'For', 'RFQ', 'Suppliers', 'Awarded / lowest', `Reference budget (${currency})`, `Quoted (${currency})`, 'Savings', 'Canvassed by', 'Status'],
          align: ['left', 'left', 'left', 'right', 'left', 'right', 'right', 'right', 'left', 'left'],
          rows: rows.map(canvassRow).map((c) => [
            c.number,
            { title: c.request.purpose, body: [c.request.number, c.request.job?.number].filter(Boolean).join(' · ') },
            c.rfq?.number ?? '',
            String(c.supplierCount),
            c.pick ? `${c.pick.name}${c.pick.awarded ? ' (awarded)' : ''}` : '',
            formatAmount(c.budget),
            c.pick ? formatAmount(c.pick.total) : '',
            c.pick?.savingsPct != null ? `${c.pick.savingsPct.toFixed(2)}%` : '',
            `${c.createdBy.name}, ${formatShortDate(c.createdAt)}`,
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
          warehouse: { select: { id: true, name: true } },
          items: {
            orderBy: { sortOrder: 'asc' },
            include: { costCategory: { select: { id: true, name: true } } },
          },
        },
      },
      rfq: { select: { id: true, number: true, status: true, dueDate: true } },
      createdBy: { select: { id: true, name: true } },
      awardedBy: { select: { id: true, name: true } },
      suppliers: {
        orderBy: { id: 'asc' },
        include: {
          supplier: { select: { id: true, code: true, name: true, paymentTerms: true, phone: true, email: true } },
          quotes: true,
        },
      },
    },
  });
}

type LoadedCanvass = NonNullable<Awaited<ReturnType<typeof loadCanvass>>>;

/** Who may change a canvass's own notes and recommendation: edit_all, or whoever opened it holding edit_own (rule 7). */
function mayEditCanvass(me: ResolvedUser, canvass: { createdById: string }): boolean {
  return canEditRecord(me, 'gchain', 'canvass', canvass.createdById);
}

function assertCanvassVisible(me: ResolvedUser, canvass: { createdById: string }) {
  if (!seesAllCanvasses(me) && canvass.createdById !== me.id) throw notFound('Canvass not found');
}

/** The purchase orders placed on an award: the request's live orders with the winner. */
async function ordersOnAward(canvass: { requestId: string; status: CanvassStatus; suppliers: { supplierId: string; isSelected: boolean }[] }) {
  const winner = canvass.suppliers.find((s) => s.isSelected);
  if (canvass.status !== 'AWARDED' || !winner) return [];
  return prisma.purchaseOrder.findMany({
    where: { requestId: canvass.requestId, supplierId: winner.supplierId, status: { not: 'CANCELLED' } },
    select: { id: true, number: true, status: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
}

function presentCanvass(canvass: LoadedCanvass, me: ResolvedUser, orders: { id: string; number: string; status: string; createdAt: Date }[] = []) {
  const figures = figuresOf(canvass, canvass.request.items, canvass.suppliers);
  const byId = new Map(figures.columns.map((c) => [c.id, c]));
  const lineIds = new Set(sheetLinesOf(canvass, canvass.request.items).map((i) => i.id));
  const suppliers = canvass.suppliers.map((s) => {
    const f = byId.get(s.id)!;
    return {
      ...s,
      quotes: s.quotes.filter((qq) => lineIds.has(qq.requestItemId)).map((qq) => ({ ...qq, unitPrice: num(qq.unitPrice) })),
      quotedCount: f.quotedCount,
      total: f.total,
      complete: f.complete,
      amounts: f.amounts,
      budgetOnQuoted: f.budgetOnQuoted,
      savings: f.savings,
      savingsPct: f.savingsPct,
    };
  });
  const open = canvass.status === 'OPEN';
  return {
    ...canvass,
    // The request with the SHEET's lines: an RFQ's sheet compares what the RFQ asked.
    request: presentPr({ ...canvass.request, items: sheetLinesOf(canvass, canvass.request.items) } as unknown as Record<string, unknown>),
    suppliers,
    budget: figures.budget,
    lowestSupplierId: figures.lowestCompleteId,
    orders,
    // The routes' own rules: while OPEN, the notes and the recommendation
    // are the opener's (or edit_all's), the supplier rows and the award
    // edit_all's. An award is the record.
    canEdit: open && mayEditCanvass(me, canvass),
    canEditSuppliers: open && can(me, 'gchain.canvass.edit_all'),
    canAward: open && can(me, 'gchain.canvass.edit_all'),
    canRefresh: open && !!canvass.rfq && can(me, 'gchain.canvass.edit_all'),
    // POST /:id/cancel and DELETE /:id's own rules (the cancel also refuses
    // an award an order was placed on).
    canCancel: (open || canvass.status === 'AWARDED') && mayEditCanvass(me, canvass) && !orders.length,
    canDelete: canvass.status === 'CANCELLED' && can(me, 'gchain.canvass.delete') && mayEditCanvass(me, canvass),
  };
}

async function canvassView(id: string, me: ResolvedUser) {
  const canvass = await loadCanvass(id);
  if (!canvass) throw notFound('Canvass not found');
  return presentCanvass(canvass, me, await ordersOnAward(canvass));
}

canvassRoutes.get(
  '/:id',
  requireAny('gchain.canvass.view_all', 'gchain.canvass.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const canvass = await loadCanvass(req.params.id);
    if (!canvass) throw notFound('Canvass not found');
    assertCanvassVisible(me, canvass);
    res.json(presentCanvass(canvass, me, await ordersOnAward(canvass)));
  }),
);

/**
 * Modifying a canvass: its notes (printed as the sheet's Remarks) and the
 * buyer's recommendation, while it is OPEN. Which request it canvasses is
 * what it is, and an award is the decision on record — so the header takes
 * nothing else (a key it cannot change is refused, not ignored).
 */
canvassRoutes.patch(
  '/:id',
  requireAny('gchain.canvass.edit_own', 'gchain.canvass.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(
      z.object({ notes: z.string().max(5000).nullable().optional(), recommendedRowId: z.string().nullable().optional() }).strict(),
      req.body,
    );
    const canvass = await prisma.canvass.findUnique({ where: { id: req.params.id }, include: { suppliers: { include: { quotes: { select: { id: true } }, supplier: { select: { name: true } } } } } });
    if (!canvass) throw notFound('Canvass not found');
    if (!mayEditCanvass(me, canvass)) throw forbidden('This canvass belongs to someone else');
    if (canvass.status !== 'OPEN') {
      throw badRequest(`${canvass.number} is ${canvass.status.toLowerCase()} — it stands as it was decided`);
    }
    let recommended: string | null = null;
    if (body.recommendedRowId) {
      const row = canvass.suppliers.find((s) => s.id === body.recommendedRowId);
      if (!row) throw badRequest('That supplier is not on this canvass');
      if (!row.quotes.length) throw badRequest(`${row.supplier.name} has not quoted anything — nothing to recommend`);
      recommended = row.supplier.name;
    }
    const claimed = await prisma.canvass.updateMany({
      where: { id: canvass.id, status: 'OPEN' },
      data: {
        ...(body.notes !== undefined ? { notes: body.notes?.trim() || null } : {}),
        ...(body.recommendedRowId !== undefined ? { recommendedRowId: body.recommendedRowId || null } : {}),
      },
    });
    if (!claimed.count) throw badRequest(`${canvass.number} was awarded a moment ago — reload to see it`);
    const said = [
      body.notes !== undefined && 'notes',
      body.recommendedRowId !== undefined && (recommended ? `recommended ${recommended}` : 'recommendation cleared'),
    ].filter(Boolean);
    await audit(
      { entityType: 'canvass', entityId: canvass.id, action: 'UPDATED', summary: `Modified ${canvass.number}: ${said.join(', ') || 'nothing'}` },
      req,
    );
    res.json(await canvassView(canvass.id, me));
  }),
);

/**
 * Cancels a canvass (2026-10-11, the owner's call) — its opener or
 * edit_all, with a reason kept on its notes. An OPEN one, or an AWARDED one
 * no live purchase order was placed on (an order's supplier is the award,
 * `awardedCanvass()`): cancel the order first. Claimed on the status it was
 * read in, so an award landing meanwhile refuses the cancel. An award
 * withdrawn opens its RFQ again (CLOSED → QUOTED), so it can be canvassed
 * anew.
 */
canvassRoutes.post(
  '/:id/cancel',
  requireAny('gchain.canvass.edit_own', 'gchain.canvass.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(z.object({ reason: z.string().trim().min(3, 'Say why it is cancelled').max(2000) }), req.body);
    const canvass = await prisma.canvass.findUnique({
      where: { id: req.params.id },
      include: { suppliers: { where: { isSelected: true }, select: { supplierId: true } } },
    });
    if (!canvass) throw notFound('Canvass not found');
    if (!mayEditCanvass(me, canvass)) throw forbidden('This canvass belongs to someone else');
    if (canvass.status === 'CANCELLED') throw badRequest(`${canvass.number} is already cancelled`);
    if (canvass.status === 'AWARDED') {
      const winners = canvass.suppliers.map((s) => s.supplierId);
      const orders = await prisma.purchaseOrder.findMany({
        where: { requestId: canvass.requestId, supplierId: { in: winners }, status: { not: 'CANCELLED' } },
        select: { number: true },
      });
      if (orders.length) {
        throw badRequest(`Purchase order ${orders.map((o) => o.number).join(', ')} was placed on this award — cancel it first`);
      }
    }
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.canvass.updateMany({
        where: { id: canvass.id, status: canvass.status },
        data: { status: 'CANCELLED', notes: `${canvass.notes ? `${canvass.notes}\n` : ''}Cancelled: ${body.reason}` },
      });
      if (!claimed.count) throw badRequest(`${canvass.number} changed a moment ago — reload to see it`);
      if (canvass.rfqId) await tx.rfq.updateMany({ where: { id: canvass.rfqId, status: 'CLOSED' }, data: { status: 'QUOTED' } });
    });
    await audit({ entityType: 'canvass', entityId: canvass.id, action: 'CANCELLED', summary: `${canvass.number} cancelled — ${body.reason}` }, req);
    res.json({ ok: true, status: 'CANCELLED' });
  }),
);

/** Deletes a CANCELLED canvass — its opener or edit_all, with the delete right. Its suppliers and quotes go with it. */
canvassRoutes.delete(
  '/:id',
  require_('gchain.canvass.delete'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const canvass = await prisma.canvass.findUnique({ where: { id: req.params.id } });
    if (!canvass) throw notFound('Canvass not found');
    if (!mayEditCanvass(me, canvass)) throw forbidden('This canvass belongs to someone else');
    if (canvass.status !== 'CANCELLED') throw badRequest('Only a cancelled canvass can be deleted — cancel it first');
    await deleteOrRefuse(canvass.number, () => prisma.canvass.delete({ where: { id: canvass.id } }));
    await deleteAttachmentsOf('canvass', [canvass.id]);
    await audit({ entityType: 'canvass', entityId: canvass.id, action: 'DELETED', summary: `Deleted cancelled canvass ${canvass.number}` }, req);
    res.json({ ok: true });
  }),
);

/** What a sheet's supplier row copies from its RFQ row: whom it names, the quote's terms and its prices on the sheet's lines. */
function snapshotOf(
  row: {
    id: string;
    supplierId: string;
    contactName: string | null;
    contactPhone: string | null;
    quoteRef: string | null;
    leadTimeDays: number | null;
    terms: string | null;
    remarks: string | null;
    supplier: { phone: string | null; paymentTerms: string | null };
    quotes: { requestItemId: string; unitPrice: Prisma.Decimal; remarks: string | null }[];
  },
  lines: Set<string>,
) {
  return {
    supplierId: row.supplierId,
    rfqSupplierId: row.id,
    contactName: row.contactName,
    contactPhone: row.contactPhone ?? row.supplier.phone,
    quoteRef: row.quoteRef,
    leadTimeDays: row.leadTimeDays,
    terms: row.terms ?? row.supplier.paymentTerms,
    remarks: row.remarks,
    quotes: row.quotes
      .filter((qq) => lines.has(qq.requestItemId))
      .map((qq) => ({ requestItemId: qq.requestItemId, unitPrice: qq.unitPrice, remarks: qq.remarks })),
  };
}

const RFQ_FOR_SHEET = {
  request: { select: { id: true, number: true, status: true, items: { select: { id: true } } } },
  items: { orderBy: { sortOrder: 'asc' }, select: { requestItemId: true } },
  suppliers: {
    orderBy: { id: 'asc' },
    include: { supplier: { select: { name: true, phone: true, paymentTerms: true } }, quotes: true },
  },
  canvasses: { where: { status: { not: 'CANCELLED' } }, select: { number: true } },
} satisfies Prisma.RfqInclude;

/**
 * Opens a canvass. From an RFQ (`rfqId`, the RFQ page's "Start canvass"):
 * SENT or QUOTED, one live sheet at a time; the sheet takes the RFQ's lines
 * and the suppliers that quoted (or the rows named, six at most) with their
 * quotes. From a request with no RFQ (`requestId`, a quote already in hand):
 * an empty sheet over every line, suppliers added on it — the old way.
 */
canvassRoutes.post(
  '/',
  require_('gchain.canvass.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(
      z
        .object({
          requestId: z.string().min(1).optional(),
          rfqId: z.string().min(1).optional(),
          supplierRowIds: z.array(z.string()).max(30).optional(),
          notes: z.string().max(5000).optional(),
        })
        .refine((b) => !!b.requestId !== !!b.rfqId, { message: 'Name the RFQ or the purchase request, one of them' }),
      req.body,
    );

    if (body.rfqId) {
      const rfq = await prisma.rfq.findUnique({ where: { id: body.rfqId }, include: RFQ_FOR_SHEET });
      if (!rfq) throw notFound('RFQ not found');
      if (rfq.status !== 'SENT' && rfq.status !== 'QUOTED') {
        throw badRequest(`${rfq.number} is ${statusLabel(rfq.status).toLowerCase()} — a sheet compares an RFQ that went out`);
      }
      if (rfq.request.status !== 'APPROVED' && rfq.request.status !== 'PARTIALLY_ORDERED') {
        throw badRequest(`${rfq.request.number} is ${statusLabel(rfq.request.status).toLowerCase()} — only an approved request can be canvassed`);
      }
      if (rfq.canvasses.length) throw badRequest(`Canvass ${rfq.canvasses.map((c) => c.number).join(', ')} already compares ${rfq.number}`);
      const lines = rfq.items.map((i) => i.requestItemId);
      const lineSet = new Set(lines);
      const quoted = rfq.suppliers.filter((s) => s.quotes.some((qq) => lineSet.has(qq.requestItemId)));
      let rows = quoted;
      if (body.supplierRowIds) {
        const own = new Map(rfq.suppliers.map((s) => [s.id, s]));
        if (body.supplierRowIds.some((id) => !own.has(id))) throw badRequest(`A supplier named is not on ${rfq.number}`);
        rows = [...new Set(body.supplierRowIds)].map((id) => own.get(id)!);
      }
      if (!rows.length) throw badRequest(`No quote is recorded on ${rfq.number} yet — record the quotes that came back first`);
      if (rows.length > MAX_SHEET_SUPPLIERS) {
        throw badRequest(`${MAX_SHEET_SUPPLIERS} suppliers at most on one sheet — ${rows.length} quoted on ${rfq.number}; choose which ${MAX_SHEET_SUPPLIERS}`);
      }
      const canvass = await prisma.$transaction(async (tx) => {
        const number = await nextNumber('canvass', tx);
        return tx.canvass.create({
          data: {
            number,
            requestId: rfq.requestId,
            rfqId: rfq.id,
            createdById: me.id,
            lineIds: lines,
            notes: body.notes?.trim() || null,
            suppliers: {
              create: rows.map((r) => {
                const snap = snapshotOf(r, lineSet);
                return { ...snap, quotes: { create: snap.quotes } };
              }),
            },
          },
        });
      });
      await audit(
        {
          entityType: 'canvass',
          entityId: canvass.id,
          action: 'CREATED',
          summary: `Opened ${canvass.number} from ${rfq.number} (${rfq.request.number}): ${lines.length} line(s), ${rows.length} supplier(s)`,
        },
        req,
      );
      res.status(201).json(canvass);
      return;
    }

    const pr = await prisma.purchaseRequest.findUnique({
      where: { id: body.requestId! },
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

/**
 * "Refresh from RFQ": an OPEN sheet copies its RFQ again — each row's
 * quotes and terms as they stand there now, and any supplier that has quoted
 * since added, up to six. A row typed on the sheet itself (no RFQ row) is
 * left as it is.
 */
canvassRoutes.post(
  '/:id/refresh',
  require_('gchain.canvass.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const canvass = await prisma.canvass.findUnique({ where: { id: req.params.id }, include: { suppliers: true } });
    if (!canvass) throw notFound('Canvass not found');
    if (canvass.status !== 'OPEN') throw badRequest(`${canvass.number} is ${canvass.status.toLowerCase()} — it stands as it was decided`);
    if (!canvass.rfqId) throw badRequest(`${canvass.number} was not raised from an RFQ`);
    const rfq = await prisma.rfq.findUniqueOrThrow({ where: { id: canvass.rfqId }, include: RFQ_FOR_SHEET });
    const lineSet = new Set(sheetLinesOf(canvass, rfq.request.items).map((i) => i.id));
    const byRfqRow = new Map(canvass.suppliers.filter((s) => s.rfqSupplierId).map((s) => [s.rfqSupplierId!, s]));
    const onSheet = new Set(canvass.suppliers.map((s) => s.supplierId));
    const added = rfq.suppliers.filter(
      (r) => !byRfqRow.has(r.id) && !onSheet.has(r.supplierId) && r.quotes.some((qq) => lineSet.has(qq.requestItemId)),
    );
    const room = MAX_SHEET_SUPPLIERS - canvass.suppliers.length;
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.canvass.updateMany({ where: { id: canvass.id, status: 'OPEN' }, data: { updatedAt: new Date() } });
      if (!claimed.count) throw badRequest(`${canvass.number} was awarded a moment ago — reload to see it`);
      for (const r of rfq.suppliers) {
        const row = byRfqRow.get(r.id);
        if (!row) continue;
        const { quotes, supplierId: _s, ...snap } = snapshotOf(r, lineSet);
        await tx.canvassSupplier.update({ where: { id: row.id }, data: snap });
        await tx.canvassQuote.deleteMany({ where: { canvassSupplierId: row.id } });
        if (quotes.length) await tx.canvassQuote.createMany({ data: quotes.map((qq) => ({ ...qq, canvassSupplierId: row.id })) });
      }
      for (const r of added.slice(0, Math.max(0, room))) {
        const snap = snapshotOf(r, lineSet);
        await tx.canvassSupplier.create({ data: { ...snap, canvassId: canvass.id, quotes: { create: snap.quotes } } });
      }
    });
    const left = added.length - Math.max(0, room);
    await audit(
      {
        entityType: 'canvass',
        entityId: canvass.id,
        action: 'UPDATED',
        summary: `Refreshed ${canvass.number} from ${rfq.number}${added.length ? ` — ${Math.min(added.length, Math.max(0, room))} supplier(s) added` : ''}${left > 0 ? `, ${left} left off (six at most)` : ''}`,
      },
      req,
    );
    res.json(await canvassView(canvass.id, me));
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
        contactName: z.string().trim().max(200).optional().nullable(),
        contactPhone: z.string().trim().max(60).optional().nullable(),
      }),
      req.body,
    );

    const canvass = await prisma.canvass.findUnique({ where: { id: req.params.id }, include: { _count: { select: { suppliers: true } } } });
    if (!canvass) throw notFound('Canvass not found');
    if (canvass.status !== 'OPEN') throw badRequest('This canvass has been awarded');
    if (canvass._count.suppliers >= MAX_SHEET_SUPPLIERS) throw badRequest(`${MAX_SHEET_SUPPLIERS} suppliers at most on one sheet`);

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
        contactName: body.contactName || null,
        contactPhone: body.contactPhone || null,
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

/**
 * A supplier column's prices on the sheet — a quote received by phone is
 * typed here too — only on the sheet's own lines, while it is OPEN; audited,
 * since the sheet is what the award is read off.
 */
canvassRoutes.put(
  '/:id/suppliers/:supplierRowId/quotes',
  require_('gchain.canvass.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(
      z.object({
        quotes: z.array(z.object({ requestItemId: z.string(), unitPrice: z.number().min(0).max(1e12) })).max(1000),
      }),
      req.body,
    );

    const row = await prisma.canvassSupplier.findFirst({
      where: { id: req.params.supplierRowId, canvassId: req.params.id },
      include: { canvass: { include: { request: { select: { items: { select: { id: true } } } } } }, supplier: { select: { name: true } } },
    });
    if (!row) throw notFound('Supplier not on this canvass');
    if (row.canvass.status !== 'OPEN') throw badRequest('This canvass has been awarded');
    const onSheet = new Set(sheetLinesOf(row.canvass, row.canvass.request.items).map((i) => i.id));
    if (body.quotes.some((qq) => !onSheet.has(qq.requestItemId))) throw badRequest('A price is for a line this sheet does not compare');
    if (new Set(body.quotes.map((qq) => qq.requestItemId)).size !== body.quotes.length) throw badRequest('A line is priced twice');

    await prisma.$transaction(async (tx) => {
      const open = await tx.canvass.updateMany({ where: { id: row.canvassId, status: 'OPEN' }, data: { updatedAt: new Date() } });
      if (!open.count) throw badRequest('This canvass was awarded a moment ago — reload to see it');
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
    await audit(
      {
        entityType: 'canvass',
        entityId: row.canvassId,
        action: 'UPDATED',
        summary: `${row.supplier.name}'s prices on ${row.canvass.number}: ${body.quotes.length} of ${onSheet.size} line(s)`,
      },
      req,
    );

    const full = await loadCanvass(req.params.id);
    res.json(full);
  }),
);

/**
 * A supplier row's own terms — lead time, payment terms, remarks, whom it
 * names — while the canvass is OPEN. Its prices go through PUT …/quotes;
 * which supplier it is never changes (remove the row and add the other).
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
          contactName: z.string().max(200).optional().nullable(),
          contactPhone: z.string().max(60).optional().nullable(),
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
        ...(body.contactName !== undefined ? { contactName: body.contactName?.trim() || null } : {}),
        ...(body.contactPhone !== undefined ? { contactPhone: body.contactPhone?.trim() || null } : {}),
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
    res.json(await canvassView(row.canvassId, currentUser(req)));
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
    const gone = await prisma.$transaction(async (tx) => {
      const n = await tx.canvassSupplier.deleteMany({ where: { id: row.id, canvass: { status: 'OPEN' } } });
      // A recommendation of the row removed goes with it.
      if (n.count) await tx.canvass.updateMany({ where: { id: row.canvassId, recommendedRowId: row.id }, data: { recommendedRowId: null } });
      return n;
    });
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

/**
 * Awarding the canvass marks the winner, records who awarded it and when
 * (AWARDED BY on the sheet), and closes the RFQ it compares; the purchase
 * order is raised from it after, at the awarded prices. A supplier that
 * quoted none of the sheet's lines cannot win; a partial winner can, and
 * the order takes only the lines it quoted. Claimed on OPEN, so two awards
 * cannot both land.
 */
canvassRoutes.post(
  '/:id/award/:supplierRowId',
  require_('gchain.canvass.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await prisma.canvassSupplier.findFirst({
      where: { id: req.params.supplierRowId, canvassId: req.params.id },
      include: { supplier: true, quotes: true, canvass: { include: { request: { include: { items: true } } } } },
    });
    if (!row) throw notFound('Supplier not on this canvass');
    if (row.canvass.status !== 'OPEN') throw badRequest('This canvass has already been awarded');
    const onSheet = new Set(sheetLinesOf(row.canvass, row.canvass.request.items).map((i) => i.id));
    if (!row.quotes.some((qq) => onSheet.has(qq.requestItemId))) throw badRequest('That supplier has not quoted anything');

    await prisma.$transaction(async (tx) => {
      const claimed = await tx.canvass.updateMany({
        where: { id: row.canvassId, status: 'OPEN' },
        data: { status: 'AWARDED', awardedAt: new Date(), awardedById: me.id },
      });
      if (!claimed.count) throw badRequest('This canvass was awarded a moment ago — reload to see it');
      await tx.canvassSupplier.updateMany({ where: { canvassId: row.canvassId }, data: { isSelected: false } });
      await tx.canvassSupplier.update({ where: { id: row.id }, data: { isSelected: true } });
      if (row.canvass.rfqId) await tx.rfq.updateMany({ where: { id: row.canvass.rfqId, status: { in: ['SENT', 'QUOTED'] } }, data: { status: 'CLOSED' } });
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

/**
 * The CANVASS SHEET on paper, in landscape — the owner's sample: the lines
 * with the REFERENCE BUDGET (the approved request's estimate, unit cost and
 * amount), then a unit cost and amount per supplier under its name, Tel
 * No. and contact ("not quoted" where it gave none); then the TOTAL row, the
 * SAVINGS vs reference budget row (pesos and %, on the lines quoted for a
 * partial quote) and the lead time and terms. Those three rows are the
 * sheet's structure, as a costing's bucket subtotals are the estimate's.
 * Three suppliers to a table: four to six run onto a second table with the
 * same lines. The awarded column's name in green. Signed by the people who
 * acted: CANVASSED BY (the opener, its timestamp) and AWARDED BY ("Pending"
 * until awarded); the order raised from it is named under them.
 */
canvassRoutes.get(
  '/:id/pdf',
  requireAny('gchain.canvass.view_all', 'gchain.canvass.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const canvass = await loadCanvass(req.params.id);
    if (!canvass) throw notFound('Canvass not found');
    assertCanvassVisible(me, canvass);
    const orders = await ordersOnAward(canvass);
    const view = presentCanvass(canvass, me, orders);
    const currency = await companyCurrency();
    const pr = canvass.request;
    const lines = view.request.items as unknown as { id: string; partNumber: string | null; name: string | null; description: string; unit: string; quantity: number; estimatedCost: number; estimatedAmount: number }[];

    const money = (v: number) => formatAmount(v);
    const pct = (v: number | null) => (v == null ? '' : `${v.toFixed(2)}%`);
    // The reference line names the request (and when it was approved), the RFQ and the project — no fields block, so the lines start high on a landscape page.
    const sections: PdfSection[] = [];

    const chunks: (typeof view.suppliers)[] = [];
    for (let i = 0; i < view.suppliers.length; i += 3) chunks.push(view.suppliers.slice(i, i + 3));
    if (!chunks.length) chunks.push([]);
    chunks.forEach((chunk, n) => {
      const label = (s: (typeof view.suppliers)[number]) =>
        [s.isSelected ? 'Awarded' : view.recommendedRowId === s.id ? 'Recommended' : null, s.contactPhone ? `Tel ${s.contactPhone}` : null, s.contactName]
          .filter(Boolean)
          .join(' · ');
      const quoteLines = (s: (typeof view.suppliers)[number]) => (s.complete || !s.quotedCount ? '' : `${s.quotedCount} of ${lines.length} lines`);
      sections.push({
        kind: 'table',
        title: chunks.length > 1 ? `Suppliers ${n * 3 + 1}–${n * 3 + chunk.length} of ${view.suppliers.length}` : undefined,
        head: ['Item code', 'Description', 'U/M', 'Qty', `Unit cost (${currency})`, 'Amount', ...chunk.flatMap(() => [`Unit cost (${currency})`, 'Amount'])],
        align: ['left', 'left', 'left', 'right', 'right', 'right', ...chunk.flatMap(() => ['right', 'right'] as const)],
        widths: [64, 140, 38, 36, 70, 74, ...chunk.flatMap(() => [70, 74])],
        groups: [
          { label: '', span: 4 },
          { label: 'Reference budget', sub: 'approved PR estimate', span: 2 },
          ...chunk.map((s) => ({ label: s.supplier.name, sub: label(s) || undefined, span: 2, accent: s.isSelected })),
        ],
        rows: [
          ...lines.map((l) => [
            l.partNumber ?? '',
            l.name && l.description && l.description !== l.name ? { title: l.name, body: l.description } : (l.name ?? l.description),
            l.unit,
            formatQuantity(l.quantity),
            money(l.estimatedCost),
            money(l.estimatedAmount),
            ...chunk.flatMap((s): PdfCell[] => {
              const q = s.quotes.find((qq) => qq.requestItemId === l.id);
              return q ? [money(q.unitPrice), money(s.amounts[l.id] ?? 0)] : ['—', 'not quoted'];
            }),
          ]),
          // Each supplier's figures take its two columns: the count of lines
          // quoted beside the total, the pesos beside the percentage, the lead
          // time beside the terms — so none wraps inside one narrow cell.
          ['', { title: 'TOTAL' }, '', '', '', { title: money(view.budget) }, ...chunk.flatMap((s): PdfCell[] => [quoteLines(s), s.quotedCount ? { title: money(s.total) } : '—'])],
          [
            '',
            chunk.some((s) => s.quotedCount && !s.complete)
              ? { title: 'SAVINGS vs reference budget', body: 'a partial quote: on the lines it quoted' }
              : { title: 'SAVINGS vs reference budget' },
            '',
            '',
            '',
            '',
            ...chunk.flatMap((s): PdfCell[] => (s.quotedCount ? [{ title: money(s.savings) }, { title: pct(s.savingsPct) }] : ['', ''])),
          ],
          [
            '',
            'Lead time · Terms',
            '',
            '',
            '',
            '',
            ...chunk.flatMap((s): PdfCell[] => [s.leadTimeDays != null ? `${s.leadTimeDays} day(s)` : '—', s.terms ?? s.supplier.paymentTerms ?? '—']),
          ],
        ],
      });
    });

    const recommended = view.suppliers.find((s) => s.id === view.recommendedRowId);
    const remarks = [
      recommended && !recommended.isSelected ? `Recommended: ${recommended.supplier.name}.` : null,
      canvass.notes,
    ].filter(Boolean);
    if (remarks.length) sections.push({ kind: 'text', title: 'Remarks', body: remarks.join('\n') });
    if (orders.length) {
      sections.push({
        kind: 'text',
        title: 'Purchase order',
        body: orders.map((o) => `${o.number} — raised at the awarded prices (${statusLabel(o.status).toLowerCase()})`).join('\n'),
      });
    }

    const signatories: Signatory[] = [
      { role: 'Canvassed by', name: canvass.createdBy.name, ...(await contactOf(canvass.createdById)), at: canvass.createdAt },
      canvass.awardedBy
        ? { role: 'Awarded by', name: canvass.awardedBy.name, ...(await contactOf(canvass.awardedBy.id)), at: canvass.awardedAt }
        : { role: 'Awarded by' },
    ];

    const pdf = await renderDocument({
      title: 'Canvass Sheet',
      documentNumber: canvass.number,
      date: canvass.createdAt,
      reference: [
        `PR ${pr.number}${pr.approvedAt ? ` (approved ${formatShortDate(pr.approvedAt)})` : ''}`,
        canvass.rfq ? `RFQ ${canvass.rfq.number}` : null,
        pr.job ? `${pr.job.number} — ${pr.job.name}` : pr.warehouse ? `Stock for ${pr.warehouse.name}` : pr.purpose,
      ]
        .filter(Boolean)
        .join(' · '),
      landscape: true,
      sections,
      signatories,
    });
    await audit({ entityType: 'canvass', entityId: canvass.id, action: 'EXPORTED', summary: `Printed ${canvass.number}` }, req);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      contentDisposition(paperFileName({ kind: 'Canvass Sheet', number: canvass.number, author: canvass.createdBy.name, date: canvass.createdAt })),
    );
    res.send(pdf);
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
          status: true,
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
    /** What the order page's save claims on (`PUT /:id/sheet`'s `version`). */
    version: po.updatedAt.toISOString(),
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

// ── The order page's helpers (2026-10-13) ─────────────────────────────────
// Declared above `/:id`: what an order from a request or canvass starts with,
// the project's budget as the order would leave it, line suggestions and the
// route submitting would take.

const PO_WRITERS = [
  'gchain.purchase_orders.create',
  'gchain.purchase_orders.edit_own',
  'gchain.purchase_orders.edit_all',
] as const;

purchaseOrderRoutes.get(
  '/draft',
  require_('gchain.purchase_orders.create'),
  handler(async (req, res) => {
    const requestId = req.query.requestId ? String(req.query.requestId) : null;
    const canvassId = req.query.canvassId ? String(req.query.canvassId) : null;
    const source = await orderSource(requestId, canvassId);
    const pr = source.pr;
    if (pr && !source.lines.length) throw badRequest('Everything on that request has already been ordered');
    const company = await prisma.company.findUnique({ where: { id: 'company' }, select: { vatRate: true } });
    res.json({
      vatRate: company ? num(company.vatRate) : 0.12,
      kind: pr?.kind ?? 'DIRECT_TO_JOB',
      request: pr ? { id: pr.id, number: pr.number, purpose: pr.purpose, preferredSupplier: pr.preferredSupplier } : null,
      job: pr?.job ?? null,
      warehouse: pr?.warehouse ?? null,
      canvass: source.canvass,
      supplier: source.supplier,
      quoteRef: source.quoteRef,
      neededBy: pr?.neededBy ?? null,
      lines: source.lines,
    });
  }),
);

/**
 * The project's budget by budget line (`projectBudgetByLine()`), and — for an
 * order from a request — what issuing it releases: the request's net
 * commitment per budget line, which `settlePurchaseOrder` releases whole
 * before it commits the order's own figure.
 */
purchaseOrderRoutes.get(
  '/budget',
  requireAny(...PO_WRITERS),
  handler(async (req, res) => {
    const jobId = String(req.query.jobId ?? '');
    if (!jobId) throw badRequest('Name the project');
    const job = await prisma.job.findUnique({ where: { id: jobId }, select: { id: true, number: true, name: true } });
    if (!job) throw notFound('Project not found');
    const requestId = req.query.requestId ? String(req.query.requestId) : null;
    const released: Record<string, number> = {};
    if (requestId) {
      const rows = await prisma.jobCostEntry.groupBy({
        by: ['costCategoryId'],
        where: { jobId, state: 'COMMITTED', sourceType: 'purchase_request', sourceId: requestId },
        _sum: { amount: true },
      });
      for (const r of rows) if (Math.abs(num(r._sum.amount)) >= 0.005) released[r.costCategoryId] = cents(num(r._sum.amount));
    }
    res.json({ job, ...(await projectBudgetByLine(jobId)), released, blocked: await overBudgetIsBlocked() });
  }),
);

purchaseOrderRoutes.get(
  '/suggest',
  requireAny(...PO_WRITERS),
  handler(async (req, res) => {
    res.json(await lineSuggestions(currentUser(req), String(req.query.q ?? '').trim(), String(req.query.jobId ?? '')));
  }),
);

/** "Submit for approval sends it to …" — at the order's total, in its buyer's name (the order's own, else the caller's). */
purchaseOrderRoutes.get(
  '/route',
  requireAny(...PO_WRITERS),
  handler(async (req, res) => {
    const me = currentUser(req);
    const amount = Number(req.query.amount ?? 0);
    if (!Number.isFinite(amount) || amount < 0) throw badRequest('The amount is not a number');
    const orderId = req.query.orderId ? String(req.query.orderId) : null;
    const po = orderId ? await prisma.purchaseOrder.findUnique({ where: { id: orderId }, select: { createdById: true } }) : null;
    if (orderId && !po) throw notFound('Purchase order not found');
    res.json({ route: await routeBrief('purchase_order', amount, po?.createdById ?? me.id) });
  }),
);

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
  quoteRef: z.string().max(120).optional().nullable(),
  terms: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  vatInclusive: z.boolean().default(false),
});

/** One line of the order page's save — `POST /` with `lines[]` and `PUT /:id/sheet`. */
const poLineSchema = z.object({
  id: z.string().optional().nullable(),
  requestItemId: z.string().optional().nullable(),
  itemId: z.string().optional().nullable(),
  costCategoryId: z.string().optional().nullable(),
  partNumber: z.string().trim().max(120).optional().nullable(),
  name: z.string().trim().max(300).optional().nullable(),
  description: z.string().trim().max(4000).optional().nullable(),
  quantity: z.number().positive('Quantity must be more than zero'),
  unit: z.string().trim().max(40).optional().nullable(),
  unitPrice: z.number().min(0, 'A unit price cannot be negative'),
});
type PoLineInput = z.infer<typeof poLineSchema>;

interface OrderLine {
  id: string | null;
  requestItemId: string | null;
  itemId: string | null;
  costCategoryId: string | null;
  partNumber: string | null;
  name: string | null;
  description: string;
  quantity: number;
  unit: string;
  unitPrice: number;
}

/**
 * What an order raised from a request or an awarded canvass starts with: the
 * request, the canvass, the supplier the canvass decided and the lines still
 * to be ordered — at the winner's quoted prices from a canvass, at the
 * request's estimates otherwise. ONE rule for `POST /` and the page's
 * `GET /draft`, so the page shows exactly what a save would write.
 */
async function orderSource(requestId: string | null | undefined, canvassId: string | null | undefined) {
  if (canvassId) {
    const canvass = await prisma.canvass.findUnique({
      where: { id: canvassId },
      include: {
        request: { include: { items: { orderBy: { sortOrder: 'asc' } }, job: { select: { id: true, number: true, name: true } }, warehouse: { select: { id: true, name: true } } } },
        suppliers: { where: { isSelected: true }, include: { quotes: true, supplier: { select: { id: true, name: true, paymentTerms: true } } } },
      },
    });
    if (!canvass) throw notFound('Canvass not found');
    if (canvass.status !== 'AWARDED') throw badRequest('Award the canvass before raising the order');
    const winner = canvass.suppliers[0];
    if (!winner) throw badRequest('That canvass has no awarded supplier');
    const priced = new Map(winner.quotes.map((qq) => [qq.requestItemId, num(qq.unitPrice)]));
    const pr = canvass.request;
    const lines: OrderLine[] = pr.items
      .filter((i) => priced.has(i.id))
      .map((i) => fromRequestItem(i, priced.get(i.id) ?? 0))
      .filter((l) => l.quantity > 0);
    return { pr, canvass: { id: canvass.id, number: canvass.number }, supplier: winner.supplier, quoteRef: winner.quoteRef ?? null, lines };
  }
  if (requestId) {
    const pr = await prisma.purchaseRequest.findUnique({
      where: { id: requestId },
      include: { items: { orderBy: { sortOrder: 'asc' } }, job: { select: { id: true, number: true, name: true } }, warehouse: { select: { id: true, name: true } } },
    });
    if (!pr) throw notFound('Purchase request not found');
    if (pr.status !== 'APPROVED' && pr.status !== 'PARTIALLY_ORDERED') {
      throw badRequest('Only an approved request can be ordered');
    }
    const lines = pr.items.map((i) => fromRequestItem(i, num(i.estimatedCost))).filter((l) => l.quantity > 0);
    return { pr, canvass: null, supplier: null, quoteRef: null, lines };
  }
  return { pr: null, canvass: null, supplier: null, quoteRef: null as string | null, lines: [] as OrderLine[] };
}

function fromRequestItem(
  i: { id: string; itemId: string | null; costCategoryId: string | null; partNumber: string | null; name: string | null; description: string; quantity: Prisma.Decimal; orderedQty: Prisma.Decimal; pulledQty: Prisma.Decimal; unit: string },
  unitPrice: number,
): OrderLine {
  return {
    id: null,
    requestItemId: i.id,
    itemId: i.itemId,
    costCategoryId: i.costCategoryId,
    partNumber: i.partNumber,
    name: i.name,
    description: i.description,
    // What a pull-out slip took from the shelf is not bought (2026-10-14).
    quantity: num(i.quantity) - num(i.orderedQty) - num(i.pulledQty),
    unit: i.unit,
    unitPrice,
  };
}

/**
 * The order's lines as they will be written, every reference checked first:
 * a request line must be one of the order's request's, the item and the
 * budget line must exist, a line says what it is, and a direct-to-job line
 * names its budget line (else its item's) — refused naming the line.
 */
async function checkPoLines(
  kind: string,
  lines: PoLineInput[],
  existingIds: string[],
  requestItemIds: string[],
): Promise<OrderLine[]> {
  const itemIds = [...new Set(lines.map((l) => l.itemId).filter((v): v is string => !!v))];
  const categoryIds = [...new Set(lines.map((l) => l.costCategoryId).filter((v): v is string => !!v))];
  const [items, categories] = await Promise.all([
    itemIds.length ? prisma.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, costCategoryId: true } }) : [],
    categoryIds.length ? prisma.costCategory.findMany({ where: { id: { in: categoryIds } }, select: { id: true } }) : [],
  ]);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const known = new Set(categories.map((c) => c.id));
  const own = new Set(existingIds);
  const fromRequest = new Set(requestItemIds);
  return lines.map((l, index) => {
    const n = index + 1;
    if (l.id && !own.has(l.id)) throw badRequest(`Line ${n} is not on this order`);
    if (l.requestItemId && !fromRequest.has(l.requestItemId)) throw badRequest(`Line ${n} is not a line of the order's purchase request`);
    if (l.itemId && !itemById.has(l.itemId)) throw badRequest(`Line ${n}: that item is not in the item master`);
    if (l.costCategoryId && !known.has(l.costCategoryId)) throw badRequest(`Line ${n}: that budget line does not exist`);
    const name = l.name?.trim() || null;
    const description = l.description?.trim() || name;
    if (!description) throw badRequest(`Line ${n}: say what is ordered`);
    const costCategoryId = l.costCategoryId || (l.itemId ? itemById.get(l.itemId)?.costCategoryId : null) || null;
    if (kind === 'DIRECT_TO_JOB' && !costCategoryId) {
      throw badRequest(`Line ${n} (${name ?? description}): choose its budget line — it is how the committed cost finds the project budget`);
    }
    return {
      id: l.id || null,
      requestItemId: l.requestItemId || null,
      itemId: l.itemId || null,
      costCategoryId,
      partNumber: l.partNumber?.trim() || null,
      name,
      description,
      quantity: l.quantity,
      unit: l.unit?.trim() || 'pcs',
      unitPrice: l.unitPrice,
    };
  });
}

/** Writes the checked lines in order: updates those with an id, creates the rest, removes what was left out. */
async function writePoLines(tx: Prisma.TransactionClient, orderId: string, lines: OrderLine[]) {
  const keep = lines.map((l) => l.id).filter((v): v is string => !!v);
  await tx.purchaseOrderItem.deleteMany({ where: { orderId, id: { notIn: keep } } });
  for (const [sortOrder, l] of lines.entries()) {
    const data = {
      requestItemId: l.requestItemId,
      itemId: l.itemId,
      costCategoryId: l.costCategoryId,
      partNumber: l.partNumber,
      name: l.name,
      description: l.description,
      quantity: D(l.quantity),
      unit: l.unit,
      unitPrice: D(l.unitPrice),
      amount: D(cents(l.quantity * l.unitPrice)),
      sortOrder,
    };
    if (l.id) await tx.purchaseOrderItem.update({ where: { id: l.id }, data });
    else await tx.purchaseOrderItem.create({ data: { orderId, ...data } });
  }
}

purchaseOrderRoutes.post(
  '/',
  require_('gchain.purchase_orders.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(poSchema.extend({ lines: z.array(poLineSchema).max(500).optional() }), req.body);
    const company = await prisma.company.findUnique({ where: { id: 'company' } });

    const source = await orderSource(body.requestId, body.canvassId);
    const pr = source.pr;
    if (source.supplier && source.supplier.id !== body.supplierId) {
      throw badRequest('The order supplier does not match the awarded supplier');
    }
    if (pr && !source.lines.length) {
      throw badRequest('Everything on that request has already been ordered');
    }
    const kind = pr?.kind ?? 'DIRECT_TO_JOB';
    // The page sends the lines as it shows them; a caller that sends none
    // gets the source's lines, as before. Every line is checked before the
    // number is issued.
    const lines = body.lines
      ? await checkPoLines(kind, body.lines, [], pr ? pr.items.map((i) => i.id) : [])
      : source.lines;
    if (pr && !lines.length) throw badRequest('An order from a request needs at least one of its lines');

    const po = await prisma.$transaction(async (tx) => {
      const number = await nextNumber('purchase_order', tx);
      const created = await tx.purchaseOrder.create({
        data: {
          number,
          kind,
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
          // The awarded supplier's quotation no. unless the buyer typed one.
          quoteRef: (body.quoteRef ?? source.quoteRef) || null,
          terms: body.terms || null,
          notes: body.notes || null,
          vatRate: company?.vatRate ?? D(0.12),
          vatInclusive: body.vatInclusive,
        },
      });
      await writePoLines(tx, created.id, lines);
      const totals = await recalcPo(created.id, tx);
      await audit(
        {
          entityType: 'purchase_order',
          entityId: created.id,
          action: 'CREATED',
          summary: `Raised ${created.number}${pr ? ` from ${pr.number}` : ''}${body.lines ? ` (${lines.length} line${lines.length === 1 ? '' : 's'})` : ''}`,
        },
        req,
        tx,
      );
      return totals ?? created;
    });

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
        ...(body.quoteRef !== undefined ? { quoteRef: body.quoteRef || null } : {}),
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

/**
 * The order page's save: header and lines in one transaction (the
 * requisition's `PUT /:id/sheet`). Claimed on DRAFT and on the `version` the
 * page read. The supplier an awarded canvass decided cannot be swapped; a
 * line's request line must be one of the order's request's.
 */
purchaseOrderRoutes.put(
  '/:id/sheet',
  requireAny(...PO_EDIT),
  handler(async (req, res) => {
    const { po, me } = await poForEdit(req, req.params.id);
    const body = parseBody(
      poSchema.omit({ requestId: true, canvassId: true }).extend({
        lines: z.array(poLineSchema).max(500),
        version: z.string().optional().nullable(),
      }),
      req.body,
    );
    const loaded = (await loadPo(po.id))!;
    if (body.supplierId !== po.supplierId) {
      const canvass = awardedCanvass(loaded);
      if (canvass) throw badRequest(`The supplier was awarded on ${canvass.number} and cannot be changed on the order`);
      const supplier = await prisma.supplier.findUnique({ where: { id: body.supplierId }, select: { id: true } });
      if (!supplier) throw badRequest('That supplier does not exist');
    }
    const requestItemIds = po.requestId
      ? (await prisma.purchaseRequestItem.findMany({ where: { requestId: po.requestId }, select: { id: true } })).map((i) => i.id)
      : [];
    const lines = await checkPoLines(po.kind, body.lines, loaded.items.map((i) => i.id), requestItemIds);
    const version = body.version ? new Date(body.version) : null;
    if (version && Number.isNaN(version.getTime())) throw badRequest('The version is not a date');

    await prisma.$transaction(async (tx) => {
      const claimed = await tx.purchaseOrder.updateMany({
        where: { id: po.id, status: 'DRAFT', ...(version ? { updatedAt: version } : {}) },
        data: {
          supplierId: body.supplierId,
          deliveryDate: asDate(body.deliveryDate),
          deliverTo: body.deliverTo || null,
          ...(body.quoteRef !== undefined ? { quoteRef: body.quoteRef || null } : {}),
          terms: body.terms || null,
          notes: body.notes || null,
          vatInclusive: body.vatInclusive,
        },
      });
      if (!claimed.count) throw badRequest(`${po.number} changed a moment ago — reload it and make the change again`);
      await writePoLines(tx, po.id, lines);
      const totals = await recalcPo(po.id, tx);
      await audit(
        {
          entityType: 'purchase_order',
          entityId: po.id,
          action: 'UPDATED',
          summary: `Modified ${po.number}: ${lines.length} line${lines.length === 1 ? '' : 's'}, ${formatMoney(num(totals?.total))} in all`,
        },
        req,
        tx,
      );
    });
    res.json(presentPo((await loadPo(po.id))!, me));
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
      const fully = reqItems.every((i) => num(i.orderedQty) + num(i.pulledQty) >= num(i.quantity) - 0.0005);
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

    // Whom the supplier's side is reached through (2026-10-14, the owner's
    // call): the supplier's primary contact, else its first, else the
    // supplier's own telephone and email.
    const contact = await prisma.supplierContact.findFirst({
      where: { supplierId: po.supplierId },
      orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
      select: { name: true, position: true, phone: true, mobile: true, email: true },
    });
    const tel = contact?.mobile ?? contact?.phone ?? po.supplier.phone;
    const mail = contact?.email ?? po.supplier.email;

    // The owner's layout of 2026-10-14 (docs/mockups/purchase-order-
    // layout.pptx): Supplier and Delivery and terms side by side, each an
    // address block with no labels. No "For" (internal), no supplier TIN,
    // no purchase request or status.
    const company = await prisma.company.findUnique({ where: { id: 'company' } });
    const place = (...parts: (string | null | undefined)[]) => parts.filter((p) => p?.trim()).join(', ');
    const supplierLines = [
      po.supplier.name,
      place(po.supplier.address, po.supplier.city),
      tel ?? '',
      contact ? [contact.name, contact.position].filter(Boolean).join(', ') : '',
      mail ?? '',
    ].filter((l) => l.trim());
    const deliveryLines = [
      company?.legalName || company?.name || '',
      po.deliverTo?.trim() || place(company?.address, company?.city) || po.warehouse?.name || '',
      company?.phone ?? '',
      company?.email ?? '',
      `Terms: ${po.terms ?? po.supplier.paymentTerms ?? '—'}`,
    ].filter((l) => l.trim());
    const sections: PdfSection[] = [
      {
        kind: 'blocks',
        blocks: [
          { title: 'Supplier', lines: supplierLines },
          { title: 'Delivery and terms', lines: deliveryLines },
        ],
      },
      {
        kind: 'table',
        title: 'Order',
        // No widths: each column from its content, the description taking what is left (rule 6).
        head: ['No.', 'Part No.', 'Description', 'Qty', 'Unit', `Unit price (${currency})`, `Amount (${currency})`],
        align: ['right', 'left', 'left', 'right', 'left', 'right', 'right'],
        rows: view.items.map((i, n) => [
          String(n + 1),
          i.partNumber ?? '',
          // The bold name over its description, or the description alone on a line typed before the order page.
          i.name && i.description !== i.name ? { title: i.name, body: i.description } : (i.name ?? i.description),
          formatQuantity(i.quantity),
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
      // A Purchasing Manager's own order: step 1 signed at submit, one timestamp.
      { role: 'Prepared by', name: po.createdBy.name, ...(await contactOf(po.createdById)), at: preparedAt(slots) ?? po.createdAt },
      ...(slots.length ? slotSignatories(slots) : po.status === 'CANCELLED' ? [] : [{ role: 'Approved by' }]),
    ];

    const pdf = await renderDocument({
      title: 'Purchase Order',
      documentNumber: po.number,
      date: po.orderDate,
      // The P.O. date under the number, and DETAILS the supplier's
      // quotation it answers and when it is due (2026-10-14, the owner's call).
      numberNote: `Date: ${formatDate(po.orderDate)}`,
      details: [
        ['Quotation reference', po.quoteRef ?? '—'],
        ['Delivery date', po.deliveryDate ? formatDate(po.deliveryDate) : '—'],
      ],
      sections,
      signatories,
      signoffNote: 'The name, date and time are considered a digital signature of approval.',
      // The status line went with the owner's layout; a draft still never
      // leaves the building looking like an order.
      footerNote: po.status === 'DRAFT' || po.status === 'PENDING_APPROVAL' ? 'DRAFT — NOT YET ISSUED.' : po.status === 'CANCELLED' ? 'CANCELLED.' : undefined,
    });

    await audit(
      { entityType: 'purchase_order', entityId: po.id, action: 'EXPORTED', summary: `Printed ${po.number}` },
      req,
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition(paperFileName({ kind: 'Purchase Order', number: po.number, author: po.createdBy.name, date: po.orderDate })));
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
      { role: 'Requested by', name: pr.requestedBy.name, ...(await contactOf(pr.requestedById)), at: preparedAt(slots) ?? pr.createdAt },
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
            ...(pr.preferredSupplier ? [{ label: 'Preferred supplier', value: pr.preferredSupplier }] : []),
          ],
        },
        {
          kind: 'table',
          title: 'Items requested',
          head: ['No.', 'Budget line', 'Part No.', 'Item', 'Qty', 'Unit', `Est. cost (${currency})`, `Est. amount (${currency})`],
          align: ['right', 'left', 'left', 'left', 'right', 'left', 'right', 'right'],
          rows: pr.items.map((i, n) => [
            String(n + 1),
            i.costCategory?.name ?? '—',
            i.partNumber ?? '',
            // The bold name over its description (the costing's cell), or
            // the description alone on a line typed before the page editor.
            i.name && i.description !== i.name ? { title: i.name, body: i.description } : (i.name ?? i.description),
            formatQuantity(num(i.quantity)),
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
    res.setHeader('Content-Disposition', contentDisposition(paperFileName({ kind: 'Purchase Request', number: pr.number, author: pr.requestedBy.name, date: pr.createdAt })));
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
