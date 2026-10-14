import { Router } from 'express';
import { z } from 'zod';
import { Prisma, PulloutKind, PulloutStatus } from '@prisma/client';
import { prisma } from '../prisma';
import { handler, parseBody, listQuery, listResult, orderBy, notFound, badRequest, forbidden, idsFilter, type ListQuery } from '../http/kit';
import { authenticate, require_, requireAny, requireAnyOrDecider, currentUser } from '../auth/middleware';
import { can, type ResolvedUser } from '../permissions/resolve';
import { audit } from '../shared/audit';
import { registerSearch } from '../shared/search';
import { availableOf } from '../shared/chain';
import { nextNumber } from '../shared/numbering';
import { notify } from '../shared/notifications';
import {
  contactOf,
  submitForApproval,
  onApprovalSettled,
  cancelOpenRequest,
  pickWorkflow,
  routeBrief,
  approvalSlots,
  slotSignatories,
  preparedAt,
  mayDecide,
  type ApprovalOutcome,
} from '../shared/approvals';
import { registerAttachmentGuard } from '../shared/attachments';
import { attachedFiles, withAttachments } from '../shared/pdfAttachments';
import { renderDocument, formatDate, formatShortDate, statusLabel, type Signatory } from '../shared/pdf';
import { manilaDate } from '../shared/day';
import { LIST_CAP, listReference, recordNamed, choice, sendListPdf } from '../shared/listPaper';
import { issueStock, postJobCost, releaseCommitment } from '../shared/inventory';
import { contentDisposition, paperFileName } from '../shared/paperName';

/**
 * Pull-out slips (2026-10-14, the owner's call: "Pull-out Slip — approved
 * Sales Order, or from Purchase Request"; "if no project was created, the
 * sales order is enough"). Stock leaves a warehouse against the document
 * that asked for it:
 *
 * - an ISSUED sales order — the customer's delivery. A sales order line names
 *   a product, not an item, so the warehouse picks the item (the form offers
 *   the one whose part number or code matches). When the order's quotation
 *   built a project, that project is charged as a stock issue charges it;
 *   otherwise the order is the whole reference and no job bears a cost.
 * - an APPROVED direct-to-project purchase request — the project takes from
 *   the shelf what it asked to buy. The request line's quantity pulled
 *   (`pulledQty`) is no longer offered to a purchase order, the request's
 *   commitment for it is released at its estimate, and the project is
 *   charged INCURRED + CONSUMED at the warehouse's average, the stock
 *   issue's rule.
 *
 * DRAFT → PENDING_APPROVAL → PULLED_OUT, or CANCELLED with a reason. The route
 * is the preparer's "Reports to" (else a Warehouse Supervisor); with it
 * switched off "Pull out" posts at once, the Outgoing rule.
 */
export const pulloutRoutes = Router();
pulloutRoutes.use(authenticate);

const DOC = 'pullout_slip';
const VIEW = 'gchain.pullout_slips.view_all';
const EDIT_ALL = 'gchain.pullout_slips.edit_all';
const SORTS = ['number', 'pulloutDate', 'createdAt'];

const D = (v: number | string | null | undefined) => (v === null || v === undefined ? new Prisma.Decimal(0) : new Prisma.Decimal(v));
const num = (v: Prisma.Decimal | number | null | undefined) => (v == null ? 0 : Number(v));
const cents = (n: number) => Math.round(n * 100) / 100;
const today = () => manilaDate(new Date());
const qty = (v: number) => new Intl.NumberFormat('en-PH', { maximumFractionDigits: 3 }).format(v);

/** A request whose lines may be pulled: approved, direct to a project, not yet wholly ordered. */
const PULLABLE_PR = ['APPROVED', 'PARTIALLY_ORDERED'] as const;

// ── The source document ──────────────────────────────────────────────────────

export interface SourceLine {
  id: string;
  title: string;
  description: string;
  partNumber: string | null;
  unit: string;
  quantity: number;
  /** Still to pull: the line less what is out on, or waiting on, other slips (and, for a request, what was ordered). */
  left: number;
  /** The item the line names (a request line), or the one whose part number or code matches (a sales order line). */
  itemId: string | null;
  /** The budget line a project is charged under (a request line's own). */
  costCategoryId: string | null;
  estimatedCost: number;
}

interface Source {
  kind: PulloutKind;
  salesOrderId: string | null;
  requestId: string | null;
  number: string;
  /** "SO-… · ACME Hospital" / "GT-PR-… · GT-PRJ-…". */
  label: string;
  jobId: string | null;
  job: { id: string; number: string; name: string } | null;
  customerName: string | null;
  lines: SourceLine[];
}

/**
 * What each source line already gave: the quantities on other slips that are
 * waiting for approval or went out (a draft holds nothing — it is checked
 * again at submit and at posting).
 */
async function pulledBySource(lineIds: string[], exceptSlipId?: string, statuses: PulloutStatus[] = ['PENDING_APPROVAL', 'PULLED_OUT']) {
  if (!lineIds.length) return new Map<string, number>();
  const rows = await prisma.pulloutItem.groupBy({
    by: ['sourceLineId'],
    where: { sourceLineId: { in: lineIds }, slip: { status: { in: statuses }, ...(exceptSlipId ? { id: { not: exceptSlipId } } : {}) } },
    _sum: { quantity: true },
  });
  return new Map(rows.map((r) => [r.sourceLineId as string, num(r._sum.quantity)]));
}

/** The source a slip pulls against, with what is left on each line. Refuses one that cannot be pulled against. */
async function loadSource(kind: PulloutKind, id: string, exceptSlipId?: string): Promise<Source> {
  if (kind === 'SALES_ORDER') {
    const so = await prisma.salesOrder.findUnique({
      where: { id },
      include: {
        customer: { select: { name: true } },
        lines: { where: { isHeading: false }, orderBy: { sortOrder: 'asc' } },
      },
    });
    if (!so) throw notFound('Sales order not found');
    if (so.status !== 'ISSUED') throw badRequest(`${so.number} is ${statusLabel(so.status).toLowerCase()} — stock is pulled out against an issued sales order`);
    // The project built from the order's quotation, when there is one.
    const job = await prisma.job.findFirst({
      where: { quotationRevision: { quotationId: so.quotationId }, status: { not: 'CANCELLED' } },
      select: { id: true, number: true, name: true },
      orderBy: { createdAt: 'asc' },
    });
    const parts = [...new Set(so.lines.map((l) => l.partNumber?.trim()).filter((p): p is string => !!p))];
    const matches = parts.length
      ? await prisma.item.findMany({
          where: { isActive: true, OR: [{ partNumber: { in: parts, mode: 'insensitive' } }, { code: { in: parts, mode: 'insensitive' } }] },
          select: { id: true, partNumber: true, code: true },
        })
      : [];
    const itemFor = (part: string | null) => {
      const p = part?.trim().toLowerCase();
      if (!p) return null;
      return matches.find((m) => m.partNumber?.toLowerCase() === p)?.id ?? matches.find((m) => m.code.toLowerCase() === p)?.id ?? null;
    };
    const pulled = await pulledBySource(so.lines.map((l) => l.id), exceptSlipId);
    return {
      kind,
      salesOrderId: so.id,
      requestId: null,
      number: so.number,
      label: `${so.number} · ${so.customer.name}`,
      jobId: job?.id ?? null,
      job,
      customerName: so.customer.name,
      lines: so.lines.map((l) => ({
        id: l.id,
        title: l.title || l.description || 'Line',
        description: l.title && l.description !== l.title ? l.description : '',
        partNumber: l.partNumber,
        unit: l.unit,
        quantity: num(l.quantity),
        left: Math.max(0, cents(num(l.quantity) - (pulled.get(l.id) ?? 0))),
        itemId: itemFor(l.partNumber),
        costCategoryId: null,
        estimatedCost: 0,
      })),
    };
  }
  const pr = await prisma.purchaseRequest.findUnique({
    where: { id },
    include: { items: { orderBy: { sortOrder: 'asc' } }, job: { select: { id: true, number: true, name: true } } },
  });
  if (!pr) throw notFound('Purchase request not found');
  if (pr.kind !== 'DIRECT_TO_JOB' || !pr.job) throw badRequest(`${pr.number} buys for warehouse stock — only a project's request is pulled from the shelf`);
  if (!(PULLABLE_PR as readonly string[]).includes(pr.status)) {
    throw badRequest(`${pr.number} is ${statusLabel(pr.status).toLowerCase()} — stock is pulled out against an approved request`);
  }
  // A request line's pulled-out quantity is on the line (`pulledQty`); only
  // what waits for approval is counted from the slips.
  const pending = await pulledBySource(pr.items.map((i) => i.id), exceptSlipId, ['PENDING_APPROVAL']);
  return {
    kind,
    salesOrderId: null,
    requestId: pr.id,
    number: pr.number,
    label: `${pr.number} · ${pr.job.number}`,
    jobId: pr.job.id,
    job: pr.job,
    customerName: null,
    lines: pr.items.map((i) => ({
      id: i.id,
      title: i.name || i.description,
      description: i.name && i.description !== i.name ? i.description : '',
      partNumber: i.partNumber,
      unit: i.unit,
      quantity: num(i.quantity),
      left: Math.max(0, cents(num(i.quantity) - num(i.orderedQty) - num(i.pulledQty) - (pending.get(i.id) ?? 0))),
      itemId: i.itemId,
      costCategoryId: i.costCategoryId,
      estimatedCost: num(i.estimatedCost),
    })),
  };
}

// ── The sheet ────────────────────────────────────────────────────────────────

const lineSchema = z.object({
  sourceLineId: z.string().min(1),
  itemId: z.string().min(1, 'Which item?'),
  quantity: z.number().positive(),
});

const sheetSchema = z
  .object({
    kind: z.nativeEnum(PulloutKind),
    salesOrderId: z.string().optional().nullable(),
    requestId: z.string().optional().nullable(),
    warehouseId: z.string().min(1, 'Which warehouse?'),
    pulloutDate: z.string().optional().nullable(),
    receivedByName: z.string().trim().max(200).optional().nullable(),
    notes: z.string().max(4000).optional().nullable(),
    lines: z.array(lineSchema).min(1, 'Pull out at least one line'),
  })
  .refine((b) => (b.kind === 'SALES_ORDER' ? !!b.salesOrderId : !!b.requestId), { message: 'Name the sales order or the request it pulls against' });

function asDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw badRequest(`"${v}" is not a valid date`);
  return d;
}

/**
 * One rule for what a slip may say, on create, modify and submit: every line
 * answers a line of its source and takes no more than is left on it; the
 * item exists, matches a request line that names one, and the warehouse
 * holds enough AVAILABLE now; a project charged knows each line's budget
 * line (the request line's, else the item's) — refused naming the item.
 */
async function checkSheet(body: z.infer<typeof sheetSchema>, exceptSlipId?: string) {
  const sourceId = body.kind === 'SALES_ORDER' ? body.salesOrderId! : body.requestId!;
  const source = await loadSource(body.kind, sourceId, exceptSlipId);
  const warehouse = await prisma.warehouse.findUnique({ where: { id: body.warehouseId }, select: { isActive: true, name: true } });
  if (!warehouse || !warehouse.isActive) throw badRequest('That warehouse is not available');
  const byLine = new Map(source.lines.map((l) => [l.id, l]));
  const items = await prisma.item.findMany({
    where: { id: { in: [...new Set(body.lines.map((l) => l.itemId))] } },
    select: { id: true, name: true, isActive: true, costCategoryId: true },
  });
  const itemById = new Map(items.map((i) => [i.id, i]));
  const perLine = new Map<string, number>();
  const perItem = new Map<string, number>();
  for (const l of body.lines) {
    const src = byLine.get(l.sourceLineId);
    if (!src) throw badRequest(`One of the lines is not on ${source.number}`);
    const item = itemById.get(l.itemId);
    if (!item || !item.isActive) throw badRequest(`The item for "${src.title}" is not in the item master`);
    if (src.itemId && body.kind === 'PURCHASE_REQUEST' && src.itemId !== l.itemId) {
      throw badRequest(`"${src.title}" names its item — pull out that item`);
    }
    if (source.jobId && !(src.costCategoryId ?? item.costCategoryId)) {
      throw badRequest(`${item.name} has no budget line — set its cost category in the item master; ${source.job!.number} is charged by budget line`);
    }
    perLine.set(src.id, (perLine.get(src.id) ?? 0) + l.quantity);
    perItem.set(item.id, (perItem.get(item.id) ?? 0) + l.quantity);
  }
  for (const [lineId, q] of perLine) {
    const src = byLine.get(lineId)!;
    if (q > src.left + 0.0005) throw badRequest(`Only ${qty(src.left)} ${src.unit} of "${src.title}" is left to pull out`);
  }
  const balances = await prisma.inventoryBalance.findMany({
    where: { warehouseId: body.warehouseId, itemId: { in: [...perItem.keys()] } },
    include: { item: { select: { name: true } } },
  });
  const balByItem = new Map(balances.map((b) => [b.itemId, b]));
  for (const [itemId, q] of perItem) {
    const b = balByItem.get(itemId);
    const free = b ? availableOf(b) : 0;
    if (free < q - 0.0005) throw badRequest(`Only ${qty(free)} of ${itemById.get(itemId)!.name} is available in ${warehouse.name} now`);
  }
  return { source, balByItem, pulloutDate: asDate(body.pulloutDate) ?? today() };
}

/** Writes the lines of a draft, each priced at the warehouse's average now — an estimate until it goes out. */
async function writeLines(
  tx: Prisma.TransactionClient,
  slipId: string,
  lines: z.infer<typeof lineSchema>[],
  balByItem: Map<string, { averageCost: Prisma.Decimal }>,
) {
  await tx.pulloutItem.deleteMany({ where: { slipId } });
  await tx.pulloutItem.createMany({
    data: lines.map((l, n) => {
      const avg = num(balByItem.get(l.itemId)?.averageCost);
      return { slipId, itemId: l.itemId, sourceLineId: l.sourceLineId, quantity: D(l.quantity), unitCost: D(avg), amount: D(cents(avg * l.quantity)), sortOrder: n };
    }),
  });
}

// ── Reading ──────────────────────────────────────────────────────────────────

/** Which slips a list query means — one rule for the list, its cards and its paper. */
function listWhere(q: ListQuery) {
  const base: Prisma.PulloutSlipWhereInput[] = [];
  const f = q.filters;
  if (f.salesOrderId) base.push({ salesOrderId: f.salesOrderId });
  if (f.requestId) base.push({ requestId: f.requestId });
  if (f.jobId) base.push({ jobId: f.jobId });
  const kind = choice(f.kind, PulloutKind, 'Kind');
  if (kind) base.push({ kind });
  if (q.search) {
    base.push({
      OR: [
        { number: { contains: q.search, mode: 'insensitive' } },
        { receivedByName: { contains: q.search, mode: 'insensitive' } },
        { salesOrder: { number: { contains: q.search, mode: 'insensitive' } } },
        { salesOrder: { customer: { name: { contains: q.search, mode: 'insensitive' } } } },
        { request: { number: { contains: q.search, mode: 'insensitive' } } },
        { job: { number: { contains: q.search, mode: 'insensitive' } } },
      ],
    });
  }
  const ids = idsFilter(f.ids);
  if (ids) base.push({ id: { in: ids } });
  const and = [...base];
  const status = choice(f.status, PulloutStatus, 'Status');
  if (status) and.push({ status });
  const join = (parts: Prisma.PulloutSlipWhereInput[]): Prisma.PulloutSlipWhereInput => (parts.length ? { AND: parts } : {});
  return { base: join(base), where: join(and) };
}

const LIST_INCLUDE = {
  salesOrder: { select: { id: true, number: true, customer: { select: { name: true } } } },
  request: { select: { id: true, number: true } },
  job: { select: { id: true, number: true, name: true } },
  warehouse: { select: { id: true, name: true } },
  preparedBy: { select: { id: true, name: true } },
  items: { select: { quantity: true } },
} satisfies Prisma.PulloutSlipInclude;

pulloutRoutes.get(
  '/',
  require_(VIEW),
  handler(async (req, res) => {
    const q = listQuery(req);
    const { base, where } = listWhere(q);
    const count = (extra: Prisma.PulloutSlipWhereInput) => prisma.pulloutSlip.count({ where: { AND: [base, extra] } });
    const [rows, total, pending, pulledOut, drafts] = await Promise.all([
      prisma.pulloutSlip.findMany({
        where,
        include: LIST_INCLUDE,
        orderBy: orderBy(q, SORTS, { createdAt: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.pulloutSlip.count({ where }),
      count({ status: 'PENDING_APPROVAL' }),
      count({ status: 'PULLED_OUT' }),
      count({ status: 'DRAFT' }),
    ]);
    res.json({
      ...listResult(
        rows.map((r) => ({
          id: r.id,
          number: r.number,
          kind: r.kind,
          status: r.status,
          pulloutDate: r.pulloutDate,
          releasedAt: r.releasedAt,
          receivedByName: r.receivedByName,
          salesOrder: r.salesOrder,
          request: r.request,
          job: r.job,
          warehouse: r.warehouse,
          preparedBy: r.preparedBy,
          lineCount: r.items.length,
          quantity: cents(r.items.reduce((s, i) => s + num(i.quantity), 0)),
        })),
        total,
        q,
      ),
      summary: { pending, pulledOut, drafts },
    });
  }),
);

/** The list on paper, through `listWhere` (`?ids=` for the rows ticked). Above `/:id`. */
pulloutRoutes.get(
  '/pdf',
  require_(VIEW),
  handler(async (req, res) => {
    const q = listQuery(req);
    const { where } = listWhere(q);
    const f = q.filters;
    const [rows, count, so, pr, project] = await Promise.all([
      prisma.pulloutSlip.findMany({ where, include: LIST_INCLUDE, orderBy: orderBy(q, SORTS, { createdAt: 'desc' }), take: LIST_CAP }),
      prisma.pulloutSlip.count({ where }),
      recordNamed('sales order', f.salesOrderId),
      recordNamed('purchase request', f.requestId, 'request'),
      recordNamed('project', f.jobId),
    ]);
    const reference = listReference(count, rows.length, ['pull-out slip', 'pull-out slips'], [
      q.search && `search "${q.search}"`,
      f.status && `status ${statusLabel(f.status)}`,
      f.kind && (f.kind === 'SALES_ORDER' ? 'against sales orders' : 'against purchase requests'),
      so,
      pr,
      project,
      f.ids && 'the rows selected',
    ]);
    const pdf = await renderDocument({
      title: 'Pull-out Slips',
      date: new Date(),
      reference,
      landscape: true,
      sections: [
        {
          kind: 'table',
          head: ['Number', 'Against', 'Project', 'Warehouse', 'Date', 'Lines', 'Received by', 'Status'],
          align: ['left', 'left', 'left', 'left', 'left', 'right', 'left', 'left'],
          rows: rows.map((r) => [
            r.number,
            r.salesOrder ? { title: r.salesOrder.number, body: r.salesOrder.customer.name } : (r.request?.number ?? ''),
            r.job?.number ?? '',
            r.warehouse.name,
            formatShortDate(r.pulloutDate),
            String(r.items.length),
            r.receivedByName ?? '',
            statusLabel(r.status),
          ]),
        },
      ],
    });
    await audit({ entityType: 'pullout_slip', entityId: 'list', action: 'EXPORTED', summary: `Exported the pull-out slip list as PDF (${rows.length} slip(s))` }, req);
    sendListPdf(res, pdf, 'pullout-slips.pdf');
  }),
);

/**
 * The documents a slip may be raised against (above `/:id`), for the form's
 * "Against" picker: ISSUED sales orders, or APPROVED direct-to-project
 * requests not yet wholly ordered — numbers, customers and projects only.
 */
pulloutRoutes.get(
  '/sources',
  require_('gchain.pullout_slips.create'),
  handler(async (req, res) => {
    const kind = req.query.kind === 'PURCHASE_REQUEST' ? 'PURCHASE_REQUEST' : 'SALES_ORDER';
    const term = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (kind === 'SALES_ORDER') {
      const rows = await prisma.salesOrder.findMany({
        where: {
          status: 'ISSUED',
          ...(term
            ? { OR: [{ number: { contains: term, mode: 'insensitive' } }, { customer: { name: { contains: term, mode: 'insensitive' } } }, { poNumber: { contains: term, mode: 'insensitive' } }] }
            : {}),
        },
        select: { id: true, number: true, orderDate: true, customer: { select: { name: true } } },
        orderBy: { orderDate: 'desc' },
        take: 30,
      });
      res.json(rows.map((r) => ({ id: r.id, number: r.number, label: r.customer.name, date: r.orderDate })));
      return;
    }
    const rows = await prisma.purchaseRequest.findMany({
      where: {
        kind: 'DIRECT_TO_JOB',
        status: { in: [...PULLABLE_PR] },
        jobId: { not: null },
        ...(term ? { OR: [{ number: { contains: term, mode: 'insensitive' } }, { job: { number: { contains: term, mode: 'insensitive' } } }, { purpose: { contains: term, mode: 'insensitive' } }] } : {}),
      },
      select: { id: true, number: true, purpose: true, createdAt: true, job: { select: { number: true } } },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
    res.json(rows.map((r) => ({ id: r.id, number: r.number, label: `${r.job?.number ?? ''} — ${r.purpose}`, date: r.createdAt })));
  }),
);

/**
 * What the form starts from (above `/:id`): the source document with what is
 * left on each line, the warehouses, and — with `?warehouseId=` — that
 * warehouse's items with what is available (names, codes, part numbers,
 * units; never a cost).
 */
pulloutRoutes.get(
  '/source',
  require_('gchain.pullout_slips.create'),
  handler(async (req, res) => {
    const salesOrderId = typeof req.query.salesOrderId === 'string' ? req.query.salesOrderId : '';
    const requestId = typeof req.query.requestId === 'string' ? req.query.requestId : '';
    const warehouseId = typeof req.query.warehouseId === 'string' ? req.query.warehouseId : '';
    const exceptSlipId = typeof req.query.slipId === 'string' ? req.query.slipId : undefined;
    if (!salesOrderId && !requestId) throw badRequest('Name the sales order or the request');
    const source = await loadSource(salesOrderId ? 'SALES_ORDER' : 'PURCHASE_REQUEST', salesOrderId || requestId, exceptSlipId);
    const [warehouses, stock] = await Promise.all([
      prisma.warehouse.findMany({ where: { isActive: true }, select: { id: true, code: true, name: true }, orderBy: { name: 'asc' } }),
      warehouseId
        ? prisma.inventoryBalance.findMany({
            where: { warehouseId, item: { isActive: true } },
            include: { item: { select: { id: true, code: true, partNumber: true, name: true, unit: true } } },
            orderBy: { item: { name: 'asc' } },
          })
        : [],
    ]);
    res.json({
      source,
      warehouses,
      items: stock.map((b) => ({ ...b.item, available: availableOf(b) })),
    });
  }),
);

async function loadSlip(id: string) {
  return prisma.pulloutSlip.findUnique({
    where: { id },
    include: {
      salesOrder: { select: { id: true, number: true, ownerId: true, customer: { select: { name: true } } } },
      request: { select: { id: true, number: true, requestedById: true } },
      job: { select: { id: true, number: true, name: true } },
      warehouse: { select: { id: true, name: true } },
      preparedBy: { select: { id: true, name: true } },
      releasedBy: { select: { id: true, name: true } },
      items: { include: { item: { select: { id: true, code: true, partNumber: true, name: true, unit: true } } }, orderBy: { sortOrder: 'asc' } },
    },
  });
}
type LoadedSlip = NonNullable<Awaited<ReturnType<typeof loadSlip>>>;

/** The register's right; or — through `requireAnyOrDecider` — whoever may decide its open request, only while it waits on them. */
async function visibleSlip(me: ResolvedUser, id: string, deciderOnly: boolean): Promise<LoadedSlip> {
  const slip = await loadSlip(id);
  if (!slip) throw notFound('Pull-out slip not found');
  if (deciderOnly && !(await mayDecide(me.id, DOC, [slip.id]))) throw notFound('Pull-out slip not found');
  return slip;
}

/** Whoever may move a slip on — modify, submit, pull back, cancel, pull out: who prepared it, or edit_all. */
const mayHandle = (me: ResolvedUser, slip: { preparedById: string }) =>
  can(me, EDIT_ALL) || (can(me, 'gchain.pullout_slips.create') && slip.preparedById === me.id);

/** What each source line says, for the record page and the paper. */
async function sourceLinesOf(slip: LoadedSlip) {
  const ids = slip.items.map((i) => i.sourceLineId).filter((x): x is string => !!x);
  if (!ids.length) return new Map<string, { title: string; unit: string }>();
  if (slip.kind === 'SALES_ORDER') {
    const rows = await prisma.salesOrderLine.findMany({ where: { id: { in: ids } }, select: { id: true, title: true, description: true, unit: true } });
    return new Map(rows.map((r) => [r.id, { title: r.title || r.description, unit: r.unit }]));
  }
  const rows = await prisma.purchaseRequestItem.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, description: true, unit: true } });
  return new Map(rows.map((r) => [r.id, { title: r.name || r.description, unit: r.unit }]));
}

async function presentSlip(slip: LoadedSlip, me: ResolvedUser) {
  const draft = slip.status === 'DRAFT';
  const handles = mayHandle(me, slip);
  const route = draft ? await pickWorkflow(DOC, null, { requesterId: slip.preparedById }) : null;
  const lines = await sourceLinesOf(slip);
  return {
    ...slip,
    canEdit: draft && handles,
    needsApproval: draft ? !!route : null,
    canSubmit: draft && handles && !!route && slip.items.length > 0,
    canPullOut: draft && handles && !route && slip.items.length > 0,
    canWithdraw: slip.status === 'PENDING_APPROVAL' && handles,
    canCancel: (draft || slip.status === 'PENDING_APPROVAL') && handles,
    approvalRoute: draft && route ? await routeBrief(DOC, null, slip.preparedById) : null,
    items: slip.items.map((i) => ({
      ...i,
      quantity: num(i.quantity),
      unitCost: num(i.unitCost),
      amount: num(i.amount),
      sourceLine: i.sourceLineId ? (lines.get(i.sourceLineId) ?? null) : null,
    })),
  };
}

pulloutRoutes.get(
  '/:id',
  requireAnyOrDecider(VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    res.json(await presentSlip(await visibleSlip(me, req.params.id, res.locals.deciderOnly === true), me));
  }),
);

/**
 * The slip on paper — what goes out, never what it cost (the slip travels
 * with the delivery): the source and its customer or project, the lines
 * against the source lines they answer, then PREPARED BY (its timestamp),
 * the route's step ("Pending" until signed; a draft prints the route
 * submitting would take), RELEASED BY and RECEIVED BY — the name written on
 * the slip, dated when it went out. The delivery receipt or photos attached
 * follow it (`?attachments=0` bare).
 */
pulloutRoutes.get(
  '/:id/pdf',
  requireAnyOrDecider(VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    const slip = await visibleSlip(me, req.params.id, res.locals.deciderOnly === true);
    const lines = await sourceLinesOf(slip);
    const slots =
      slip.status === 'DRAFT'
        ? await approvalSlots(DOC, slip.id, { amount: null, requesterId: slip.preparedById })
        : await approvalSlots(DOC, slip.id);
    const out = slip.status === 'PULLED_OUT';
    const signatories: Signatory[] = [
      { role: 'Prepared by', name: slip.preparedBy.name, ...(await contactOf(slip.preparedBy.id)), at: preparedAt(slots) ?? slip.createdAt },
      ...slotSignatories(slots),
    ];
    if (out && slip.releasedBy) {
      signatories.push({ role: 'Released by', name: slip.releasedBy.name, ...(await contactOf(slip.releasedBy.id)), at: slip.releasedAt });
    }
    if (slip.receivedByName && slip.status !== 'CANCELLED') {
      signatories.push({ role: 'Received by', name: slip.receivedByName, at: out ? slip.releasedAt : null });
    }
    const against = slip.salesOrder ? `${slip.salesOrder.number} — ${slip.salesOrder.customer.name}` : (slip.request?.number ?? '');
    const pdf = await renderDocument({
      title: 'Pull-out Slip',
      documentNumber: slip.number,
      date: slip.pulloutDate,
      reference: against,
      sections: [
        {
          kind: 'fields',
          columns: 3,
          fields: [
            { label: slip.kind === 'SALES_ORDER' ? 'Sales order' : 'Purchase request', value: slip.salesOrder?.number ?? slip.request?.number ?? '—' },
            { label: slip.kind === 'SALES_ORDER' ? 'Customer' : 'Project', value: slip.salesOrder ? slip.salesOrder.customer.name : (slip.job ? `${slip.job.number} — ${slip.job.name}` : '—') },
            { label: 'Warehouse', value: slip.warehouse.name },
            ...(slip.kind === 'SALES_ORDER' && slip.job ? [{ label: 'Project', value: `${slip.job.number} — ${slip.job.name}` }] : []),
            { label: 'Date', value: formatDate(slip.pulloutDate) },
            { label: 'Status', value: statusLabel(slip.status) },
          ],
        },
        {
          kind: 'table',
          title: 'Items pulled out',
          head: ['No.', 'Code', 'Item', 'Against', 'Qty', 'Unit'],
          align: ['right', 'left', 'left', 'left', 'right', 'left'],
          rows: slip.items.map((i, n) => [
            String(n + 1),
            i.item.code,
            i.item.partNumber ? { title: i.item.name, body: i.item.partNumber } : i.item.name,
            (i.sourceLineId && lines.get(i.sourceLineId)?.title) || '',
            qty(num(i.quantity)),
            i.item.unit,
          ]),
        },
        ...(slip.notes ? [{ kind: 'text' as const, title: 'Notes', body: slip.notes }] : []),
        ...(slip.status === 'CANCELLED' && slip.cancelReason ? [{ kind: 'text' as const, title: 'Cancelled', body: slip.cancelReason }] : []),
      ],
      signatories,
    });
    const files = req.query.attachments === '0' ? [] : await attachedFiles('pullout_slip', slip.id);
    const { pdf: withFiles, listed } = await withAttachments(pdf, files, { title: 'Pull-out Slip', number: slip.number, reference: against });
    await audit({ entityType: 'pullout_slip', entityId: slip.id, action: 'EXPORTED', summary: `Printed ${slip.number}${listed ? ` with ${listed} attachment${listed === 1 ? '' : 's'}` : ''}` }, req);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition(paperFileName({ kind: 'Pull-out Slip', number: slip.number, author: slip.preparedBy.name, date: slip.pulloutDate })));
    res.send(withFiles);
  }),
);

// ── Writing ──────────────────────────────────────────────────────────────────

pulloutRoutes.post(
  '/',
  require_('gchain.pullout_slips.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(sheetSchema, req.body);
    const { source, balByItem, pulloutDate } = await checkSheet(body);
    const slip = await prisma.$transaction(async (tx) => {
      const number = await nextNumber(DOC, tx);
      const created = await tx.pulloutSlip.create({
        data: {
          number,
          kind: body.kind,
          salesOrderId: source.salesOrderId,
          requestId: source.requestId,
          jobId: source.jobId,
          warehouseId: body.warehouseId,
          preparedById: me.id,
          pulloutDate,
          receivedByName: body.receivedByName?.trim() || null,
          notes: body.notes?.trim() || null,
        },
      });
      await writeLines(tx, created.id, body.lines, balByItem);
      return created;
    });
    await audit({ entityType: 'pullout_slip', entityId: slip.id, action: 'CREATED', summary: `${slip.number} raised against ${source.number}` }, req);
    const routed = !!(await pickWorkflow(DOC, null, { requesterId: me.id }));
    res.status(201).json({ ...slip, needsApproval: routed });
  }),
);

/** Modify a draft whole — header and lines in one save, claimed on DRAFT and the `version` read. */
pulloutRoutes.put(
  '/:id/sheet',
  requireAny('gchain.pullout_slips.create', EDIT_ALL),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(sheetSchema.and(z.object({ version: z.string().optional() })), req.body);
    const slip = await prisma.pulloutSlip.findUnique({ where: { id: req.params.id } });
    if (!slip) throw notFound('Pull-out slip not found');
    if (!mayHandle(me, slip)) throw forbidden('This slip is someone else’s');
    if (slip.status !== 'DRAFT') throw badRequest(`${slip.number} is ${statusLabel(slip.status).toLowerCase()}${slip.status === 'PENDING_APPROVAL' ? ' — pull it back first' : ''}`);
    if (body.kind !== slip.kind || (body.salesOrderId ?? null) !== slip.salesOrderId || (body.requestId ?? null) !== slip.requestId) {
      throw badRequest('A slip keeps the document it pulls against — raise another for a different one');
    }
    if (body.version && new Date(body.version).getTime() !== slip.updatedAt.getTime()) throw badRequest(`${slip.number} changed a moment ago — reload to see it`);
    const { balByItem, pulloutDate } = await checkSheet(body, slip.id);
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.pulloutSlip.updateMany({
        where: { id: slip.id, status: 'DRAFT', updatedAt: slip.updatedAt },
        data: { warehouseId: body.warehouseId, pulloutDate, receivedByName: body.receivedByName?.trim() || null, notes: body.notes?.trim() || null },
      });
      if (!claimed.count) throw badRequest(`${slip.number} changed a moment ago — reload to see it`);
      await writeLines(tx, slip.id, body.lines, balByItem);
    });
    await audit({ entityType: 'pullout_slip', entityId: slip.id, action: 'UPDATED', summary: `Modified ${slip.number}` }, req);
    res.json(await presentSlip((await loadSlip(slip.id))!, me));
  }),
);

/** The sheet a slip says, re-read as the check takes it — submit and posting check again what the draft was saved with. */
async function recheck(slip: LoadedSlip) {
  return checkSheet(
    {
      kind: slip.kind,
      salesOrderId: slip.salesOrderId,
      requestId: slip.requestId,
      warehouseId: slip.warehouseId,
      pulloutDate: slip.pulloutDate.toISOString().slice(0, 10),
      receivedByName: slip.receivedByName,
      notes: slip.notes,
      lines: slip.items.map((i) => ({ sourceLineId: i.sourceLineId ?? '', itemId: i.itemId, quantity: num(i.quantity) })),
    },
    slip.id,
  );
}

/**
 * Submit for approval: the slip is checked again (what is left on the source,
 * what the shelf holds), claimed on DRAFT and its `updatedAt`, and filed in
 * the PREPARER's name — their supervisor decides. A refused submit puts it
 * back to a draft.
 */
pulloutRoutes.post(
  '/:id/submit',
  requireAny('gchain.pullout_slips.create', EDIT_ALL),
  handler(async (req, res) => {
    const me = currentUser(req);
    const slip = await loadSlip(req.params.id);
    if (!slip) throw notFound('Pull-out slip not found');
    if (!mayHandle(me, slip)) throw forbidden('This slip is someone else’s');
    if (slip.status !== 'DRAFT') throw badRequest(`${slip.number} is ${statusLabel(slip.status).toLowerCase()}`);
    if (!slip.items.length) throw badRequest('Add at least one line before submitting');
    await recheck(slip);
    const claimed = await prisma.pulloutSlip.updateMany({ where: { id: slip.id, status: 'DRAFT', updatedAt: slip.updatedAt }, data: { status: 'PENDING_APPROVAL' } });
    if (!claimed.count) throw badRequest(`${slip.number} changed a moment ago — reload to see where it stands`);
    try {
      await submitForApproval({
        documentType: DOC,
        documentId: slip.id,
        documentNumber: slip.number,
        subject: `${slip.salesOrder ? `${slip.salesOrder.number} — ${slip.salesOrder.customer.name}` : (slip.request?.number ?? '')} · ${slip.warehouse.name}`,
        amount: null,
        link: `/g-chain/pullout-slips/${slip.id}`,
        requesterId: slip.preparedById,
      });
    } catch (err) {
      await prisma.pulloutSlip.updateMany({ where: { id: slip.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
      throw err;
    }
    await audit({ entityType: 'pullout_slip', entityId: slip.id, action: 'SUBMITTED', summary: `${slip.number} submitted for approval` }, req);
    res.json(await presentSlip((await loadSlip(slip.id))!, me));
  }),
);

pulloutRoutes.post(
  '/:id/withdraw',
  requireAny('gchain.pullout_slips.create', EDIT_ALL),
  handler(async (req, res) => {
    const me = currentUser(req);
    const slip = await prisma.pulloutSlip.findUnique({ where: { id: req.params.id } });
    if (!slip) throw notFound('Pull-out slip not found');
    if (!mayHandle(me, slip)) throw forbidden('This slip is someone else’s');
    if (slip.status !== 'PENDING_APPROVAL') throw badRequest(`${slip.number} is not waiting for approval`);
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.pulloutSlip.updateMany({ where: { id: slip.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
      if (!claimed.count) throw badRequest(`${slip.number} was decided a moment ago — reload to see where it stands`);
      const withdrawn = await cancelOpenRequest(DOC, slip.id, tx, `pulled back by ${me.name}`, me.id);
      if (!withdrawn.length) throw badRequest(`${slip.number} was decided a moment ago — reload to see where it stands`);
    });
    await audit({ entityType: 'pullout_slip', entityId: slip.id, action: 'UPDATED', summary: `${slip.number} pulled back to a draft` }, req);
    res.json(await presentSlip((await loadSlip(slip.id))!, me));
  }),
);

/** Cancels a draft or a pending slip, the reason kept — nothing had gone out; its open request is withdrawn. */
pulloutRoutes.post(
  '/:id/cancel',
  requireAny('gchain.pullout_slips.create', EDIT_ALL),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(z.object({ reason: z.string().trim().min(3, 'Say why it is cancelled').max(2000) }), req.body);
    const slip = await prisma.pulloutSlip.findUnique({ where: { id: req.params.id } });
    if (!slip) throw notFound('Pull-out slip not found');
    if (!mayHandle(me, slip)) throw forbidden('This slip is someone else’s');
    if (slip.status !== 'DRAFT' && slip.status !== 'PENDING_APPROVAL') {
      throw badRequest(`${slip.number} is ${statusLabel(slip.status).toLowerCase()} — ${slip.status === 'PULLED_OUT' ? 'the stock has gone out' : 'nothing to cancel'}`);
    }
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.pulloutSlip.updateMany({ where: { id: slip.id, status: slip.status }, data: { status: 'CANCELLED', cancelReason: body.reason } });
      if (!claimed.count) throw badRequest(`${slip.number} changed a moment ago — reload to see where it stands`);
      if (slip.status === 'PENDING_APPROVAL') await cancelOpenRequest(DOC, slip.id, tx, `cancelled by ${me.name}: ${body.reason}`, me.id);
    });
    await audit({ entityType: 'pullout_slip', entityId: slip.id, action: 'CANCELLED', summary: `${slip.number} cancelled — ${body.reason}` }, req);
    res.json({ ok: true, status: 'CANCELLED' });
  }),
);

/**
 * The stock goes out, inside the caller's transaction (the slip already
 * claimed): every line at the warehouse's average as it stands, re-checked
 * against what is left on its source. A request's lines take their pulled
 * quantity, the request's commitment for them is released at its estimate,
 * and its status follows what is now covered; a project is charged INCURRED
 * and CONSUMED by budget line, the stock issue's rule.
 */
async function postPullout(tx: Prisma.TransactionClient, slipId: string, actorId: string) {
  const slip = await tx.pulloutSlip.findUniqueOrThrow({
    where: { id: slipId },
    include: { items: { include: { item: { select: { costCategoryId: true, name: true } } } }, request: { include: { items: true } } },
  });
  const prLines = new Map((slip.request?.items ?? []).map((i) => [i.id, i]));
  const incurred = new Map<string, number>();
  const release = new Map<string, number>();
  for (const line of slip.items) {
    const moved = await issueStock(tx, {
      itemId: line.itemId,
      warehouseId: slip.warehouseId,
      quantity: num(line.quantity),
      sourceType: DOC,
      sourceId: slip.id,
      sourceNumber: slip.number,
      createdById: actorId,
    });
    await tx.pulloutItem.update({ where: { id: line.id }, data: { unitCost: D(moved.unitCost), amount: D(moved.amount) } });
    let category = line.item.costCategoryId;
    if (slip.kind === 'PURCHASE_REQUEST' && line.sourceLineId) {
      const pr = prLines.get(line.sourceLineId);
      if (!pr) throw badRequest(`A line of ${slip.number} is no longer on its request`);
      const left = num(pr.quantity) - num(pr.orderedQty) - num(pr.pulledQty);
      if (num(line.quantity) > left + 0.0005) throw badRequest(`Only ${qty(Math.max(0, left))} ${pr.unit} of "${pr.name || pr.description}" is left on ${slip.request!.number}`);
      await tx.purchaseRequestItem.update({ where: { id: pr.id }, data: { pulledQty: D(num(pr.pulledQty) + num(line.quantity)) } });
      pr.pulledQty = D(num(pr.pulledQty) + num(line.quantity));
      category = pr.costCategoryId ?? category;
      if (category) release.set(category, (release.get(category) ?? 0) + cents(num(line.quantity) * num(pr.estimatedCost)));
    }
    if (slip.jobId && category) incurred.set(category, (incurred.get(category) ?? 0) + moved.amount);
  }
  if (slip.jobId) {
    if (slip.requestId) {
      for (const [costCategoryId, amount] of release) {
        if (amount > 0) {
          await releaseCommitment(tx, {
            jobId: slip.jobId,
            sourceType: 'purchase_request',
            sourceId: slip.requestId,
            costCategoryId,
            amount,
            reason: `Taken from stock on ${slip.number}`,
            createdById: actorId,
          });
        }
      }
    }
    for (const [costCategoryId, amount] of incurred) {
      for (const state of ['INCURRED', 'CONSUMED'] as const) {
        await postJobCost(tx, {
          jobId: slip.jobId,
          costCategoryId,
          state,
          amount,
          sourceType: DOC,
          sourceId: slip.id,
          sourceNumber: slip.number,
          description: `Pulled out from stock — ${slip.number}`,
          createdById: actorId,
        });
      }
    }
  }
  if (slip.request) {
    const items = [...prLines.values()];
    const covered = items.every((i) => num(i.orderedQty) + num(i.pulledQty) >= num(i.quantity) - 0.0005);
    await tx.purchaseRequest.update({ where: { id: slip.request.id }, data: { status: covered ? 'ORDERED' : 'PARTIALLY_ORDERED' } });
  }
}

/** Tells who asked — the sales order's owner or the request's requester — that the stock went out. */
async function tellPulledOut(slipId: string, actorId: string | null) {
  const slip = await loadSlip(slipId);
  if (!slip) return;
  const to = slip.salesOrder?.ownerId ?? slip.request?.requestedById;
  if (!to || to === actorId) return;
  await notify({
    userId: to,
    type: 'pullout.done',
    title: `${slip.number} pulled out — ${slip.salesOrder?.number ?? slip.request?.number ?? ''}`,
    body: `${slip.items.length} line${slip.items.length === 1 ? '' : 's'} from ${slip.warehouse.name}${slip.receivedByName ? `, received by ${slip.receivedByName}` : ''}`,
    link: `/g-chain/pullout-slips/${slip.id}`,
  });
}

/** Without a route (switched off), the preparer pulls it out at once — the Outgoing rule. */
pulloutRoutes.post(
  '/:id/pull-out',
  requireAny('gchain.pullout_slips.create', EDIT_ALL),
  handler(async (req, res) => {
    const me = currentUser(req);
    const slip = await loadSlip(req.params.id);
    if (!slip) throw notFound('Pull-out slip not found');
    if (!mayHandle(me, slip)) throw forbidden('This slip is someone else’s');
    if (slip.status !== 'DRAFT') throw badRequest(`${slip.number} is ${statusLabel(slip.status).toLowerCase()}`);
    if (await pickWorkflow(DOC, null, { requesterId: slip.preparedById })) {
      throw badRequest(`${slip.number} goes for approval — Submit for approval, and its approval pulls it out`);
    }
    await recheck(slip);
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.pulloutSlip.updateMany({
        where: { id: slip.id, status: 'DRAFT', updatedAt: slip.updatedAt },
        data: { status: 'PULLED_OUT', releasedById: me.id, releasedAt: new Date() },
      });
      if (!claimed.count) throw badRequest(`${slip.number} was changed or pulled out a moment ago — reload to see where it stands`);
      await postPullout(tx, slip.id, me.id);
    });
    await audit({ entityType: 'pullout_slip', entityId: slip.id, action: 'EXECUTED', summary: `${slip.number} pulled out` }, req);
    await tellPulledOut(slip.id, me.id);
    res.json(await presentSlip((await loadSlip(slip.id))!, me));
  }),
);

/**
 * The route's decision. Approved: claims PENDING_APPROVAL → PULLED_OUT and
 * posts in the same transaction — once, whatever calls it twice — released
 * by the preparer at that instant. A shelf or a source that can no longer
 * honour it sends the slip back to a draft, said on its trail and by a bell,
 * never half posted. Returned or rejected: back to a draft. A decision that
 * finds the slip no longer pending changes nothing, and says so.
 */
export async function settlePullout(documentId: string, outcome: ApprovalOutcome) {
  const slip = await prisma.pulloutSlip.findUnique({ where: { id: documentId } });
  if (!slip) return;
  const notApplied = async (status: string) =>
    audit({
      entityType: 'pullout_slip',
      entityId: slip.id,
      action: outcome === 'APPROVED' ? 'APPROVED' : 'REJECTED',
      summary: `${slip.number} ${outcome.toLowerCase()} after it was ${status.toLowerCase().replace(/_/g, ' ')} — not applied`,
      actorName: 'system',
    });
  if (outcome !== 'APPROVED') {
    const back = await prisma.pulloutSlip.updateMany({ where: { id: slip.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
    if (!back.count) await notApplied(slip.status);
    return;
  }
  let posted = false;
  try {
    posted = await prisma.$transaction(async (tx) => {
      const claimed = await tx.pulloutSlip.updateMany({
        where: { id: slip.id, status: 'PENDING_APPROVAL' },
        data: { status: 'PULLED_OUT', releasedById: slip.preparedById, releasedAt: new Date() },
      });
      if (!claimed.count) return false;
      await postPullout(tx, slip.id, slip.preparedById);
      return true;
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'the stock could not be moved';
    const back = await prisma.pulloutSlip.updateMany({ where: { id: slip.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
    if (back.count) {
      await audit({ entityType: 'pullout_slip', entityId: slip.id, action: 'UPDATED', summary: `${slip.number} approved, but not pulled out — ${reason}; back to a draft`, actorName: 'system' });
      await notify({
        userId: slip.preparedById,
        type: 'warehouse.not_posted',
        title: `${slip.number} approved but not pulled out`,
        body: `${reason}. It is a draft again — change it and submit it again.`,
        link: `/g-chain/pullout-slips/${slip.id}`,
      });
    }
    return;
  }
  if (!posted) {
    const now = await prisma.pulloutSlip.findUnique({ where: { id: slip.id }, select: { status: true } });
    await notApplied(now?.status ?? slip.status);
    return;
  }
  await audit({ entityType: 'pullout_slip', entityId: slip.id, action: 'EXECUTED', summary: `${slip.number} pulled out — approved`, actorName: 'system' });
  await tellPulledOut(slip.id, null);
}

onApprovalSettled(DOC, async (request, outcome) => {
  await settlePullout(request.documentId, outcome);
});

// The delivery receipt or photos: read as the slip is read, added while it
// is a draft or pending by whoever may move it on.
registerAttachmentGuard(
  'pullout_slip',
  async (user, id) => {
    if (can(user, VIEW)) return !!(await prisma.pulloutSlip.findUnique({ where: { id }, select: { id: true } }));
    return mayDecide(user.id, DOC, [id]);
  },
  {
    write: async (user, id) => {
      const r = await prisma.pulloutSlip.findUnique({ where: { id }, select: { status: true, preparedById: true } });
      return !!r && (r.status === 'DRAFT' || r.status === 'PENDING_APPROVAL') && mayHandle(user, r);
    },
  },
);

registerSearch({
  kind: 'pullout_slip',
  label: 'Pull-out slips',
  permission: VIEW,
  async search(term, _user, limit) {
    const rows = await prisma.pulloutSlip.findMany({
      where: {
        OR: [
          { number: { contains: term, mode: 'insensitive' } },
          { salesOrder: { number: { contains: term, mode: 'insensitive' } } },
          { request: { number: { contains: term, mode: 'insensitive' } } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, number: true, status: true, salesOrder: { select: { number: true, customer: { select: { name: true } } } }, request: { select: { number: true } } },
    });
    return rows.map((r) => ({
      kind: 'pullout_slip',
      id: r.id,
      title: `${r.number} — ${r.salesOrder ? r.salesOrder.customer.name : (r.request?.number ?? '')}`,
      subtitle: `${r.salesOrder ? `Against ${r.salesOrder.number}` : `Against ${r.request?.number ?? ''}`} · ${statusLabel(r.status)}`,
      link: `/g-chain/pullout-slips/${r.id}`,
    }));
  },
});
