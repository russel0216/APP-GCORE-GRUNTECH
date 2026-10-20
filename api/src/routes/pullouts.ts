import { Router } from 'express';
import { z } from 'zod';
import { Prisma, PulloutKind, PulloutPurpose, PulloutStatus } from '@prisma/client';
import { prisma } from '../prisma';
import { handler, parseBody, listQuery, listResult, orderBy, notFound, badRequest, forbidden, idsFilter, deleteOrRefuse, type ListQuery } from '../http/kit';
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
  onApprovalReopened,
  type ApprovalOutcome,
} from '../shared/approvals';
import { registerAttachmentGuard, deleteAttachmentsOf } from '../shared/attachments';
import { attachedFiles, withAttachments } from '../shared/pdfAttachments';
import { renderDocument, formatDate, formatShortDate, statusLabel, type PdfSection, type Signatory } from '../shared/pdf';
import { manilaDate } from '../shared/day';
import { LIST_CAP, listReference, recordNamed, choice, sendListPdf } from '../shared/listPaper';
import { issueProjectStock, projectHoldings, receiveProjectStock } from '../shared/projectStock';
import { issueStock, postJobCost, releaseCommitment, returnIssuedStock, reverseJobCost } from '../shared/inventory';
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
 * - no source document at all (2026-10-15, the owner's call: "yes" — a
 *   supplier return, testing, a repair): the reason is kept, the lines are
 *   whatever the warehouse holds, and no project is charged.
 *
 * It is the INTERNAL release slip (the owner's call: "Pull-out Slip — internal,
 * allowing the warehouse to release the item; no customer involved"): what it
 * is for, who asked for it (sales or the project — their manager approves),
 * the references written on it, the authorized person or courier and their
 * vehicle, where it goes and when it is expected back, each line's serial and
 * condition, and on paper the gate clearance for the guard.
 *
 * DRAFT → PENDING_APPROVAL → PULLED_OUT, or CANCELLED with a reason. The route
 * is the REQUESTER's "Reports to" (else a Warehouse Supervisor) — the
 * preparer's when nobody else asked; with it switched off "Pull out" posts at
 * once, the Outgoing rule.
 */
export const pulloutRoutes = Router();
pulloutRoutes.use(authenticate);

const DOC = 'pullout_slip';
const VIEW = 'gchain.pullout_slips.view_all';
/** Anyone may raise a pull-out (2026-10-18): View Own reads the slips one prepared or asked for. */
const VIEW_OWN = 'gchain.pullout_slips.view_own';
const EDIT_OWN = 'gchain.pullout_slips.edit_own';
const EDIT_ALL = 'gchain.pullout_slips.edit_all';

/** A View Own holder's slips: the ones they prepared or asked for. */
const ownSlips = (me: ResolvedUser): Prisma.PulloutSlipWhereInput =>
  can(me, VIEW) ? {} : { OR: [{ preparedById: me.id }, { requestedById: me.id }] };
const SORTS = ['number', 'pulloutDate', 'createdAt'];

const D = (v: number | string | null | undefined) => (v === null || v === undefined ? new Prisma.Decimal(0) : new Prisma.Decimal(v));
const num = (v: Prisma.Decimal | number | null | undefined) => (v == null ? 0 : Number(v));
const cents = (n: number) => Math.round(n * 100) / 100;
const today = () => manilaDate(new Date());
const qty = (v: number) => new Intl.NumberFormat('en-PH', { maximumFractionDigits: 3 }).format(v);

/** A request whose lines may be pulled: approved, direct to a project, not yet wholly ordered. */
const PULLABLE_PR = ['APPROVED', 'PARTIALLY_ORDERED'] as const;

/** What a pull-out is for, as the slip prints it (the owner's "purpose / transaction type"). */
export const PULLOUT_PURPOSES: Record<PulloutPurpose, string> = {
  SALES_ORDER: 'Sales order fulfilment',
  PROJECT_USE: 'Project / site use',
  SITE_INSTALLATION: 'Site installation',
  TESTING_AUDIT: 'Testing / audit',
  REPAIR_SERVICE: 'Repair / service',
  SUPPLIER_RETURN: 'Supplier return',
  OTHER: 'Other',
};
/** The purposes a slip with no source document may carry — a sales order or a project's use has its document. */
const OTHER_PURPOSES: PulloutPurpose[] = ['SITE_INSTALLATION', 'TESTING_AUDIT', 'REPAIR_SERVICE', 'SUPPLIER_RETURN', 'OTHER'];
/** A slip's purpose: its own, else what its kind means (a slip from before the purposes). */
export const purposeOf = (slip: { purpose: PulloutPurpose | null; kind: PulloutKind }): PulloutPurpose =>
  slip.purpose ??
  (slip.kind === 'SALES_ORDER' ? 'SALES_ORDER' : slip.kind === 'PURCHASE_REQUEST' || slip.kind === 'PROJECT_STOCK' ? 'PROJECT_USE' : 'OTHER');

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
  /** Who asked for it: the sales order's author, the request's requester — the slip's "Requested by" to start with. */
  owner: { id: string; name: string } | null;
  /** The references the source carries: the customer's PO and the DR on a sales order. */
  poReference: string | null;
  drReference: string | null;
  lines: SourceLine[];
}

/** A slip with no source document: nothing to answer, no project. */
const NO_SOURCE: Source = {
  kind: 'OTHER',
  salesOrderId: null,
  requestId: null,
  number: '',
  label: 'No source document',
  jobId: null,
  job: null,
  customerName: null,
  owner: null,
  poReference: null,
  drReference: null,
  lines: [],
};

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
  if (kind === 'OTHER') return NO_SOURCE;
  if (kind === 'PROJECT_STOCK') {
    // A project's own stock (2026-10-18): the project is the source; its lines
    // are whatever it holds at the warehouse, checked in checkSheet.
    const job = await prisma.job.findUnique({
      where: { id },
      select: {
        id: true,
        number: true,
        name: true,
        status: true,
        customer: { select: { name: true } },
        projectManager: { select: { id: true, name: true } },
      },
    });
    if (!job) throw badRequest('That project does not exist');
    if (job.status === 'CANCELLED') throw badRequest(`${job.number} was cancelled`);
    return {
      kind,
      salesOrderId: null,
      requestId: null,
      number: job.number,
      label: `${job.number} · ${job.name} — project stock`,
      jobId: job.id,
      job: { id: job.id, number: job.number, name: job.name },
      customerName: job.customer?.name ?? null,
      owner: job.projectManager,
      poReference: null,
      drReference: null,
      lines: [],
    };
  }
  if (kind === 'SALES_ORDER') {
    const so = await prisma.salesOrder.findUnique({
      where: { id },
      include: {
        customer: { select: { name: true } },
        owner: { select: { id: true, name: true } },
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
      owner: so.owner,
      poReference: so.poNumber,
      drReference: so.drNumber,
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
    include: {
      items: { orderBy: { sortOrder: 'asc' } },
      job: { select: { id: true, number: true, name: true } },
      requestedBy: { select: { id: true, name: true } },
    },
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
    owner: pr.requestedBy,
    poReference: null,
    drReference: null,
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
  /** The source line it answers — none on a slip with no source document. */
  sourceLineId: z.string().optional().nullable(),
  itemId: z.string().min(1, 'Which item?'),
  quantity: z.number().positive(),
  serialNo: z.string().trim().max(120).optional().nullable(),
  condition: z.string().trim().max(80).optional().nullable(),
});

const text = (max: number) => z.string().trim().max(max).optional().nullable();

const sheetSchema = z
  .object({
    kind: z.nativeEnum(PulloutKind),
    salesOrderId: z.string().optional().nullable(),
    requestId: z.string().optional().nullable(),
    /** The project whose own stock a PROJECT_STOCK slip releases. */
    jobId: z.string().optional().nullable(),
    warehouseId: z.string().min(1, 'Which warehouse?'),
    pulloutDate: z.string().optional().nullable(),
    purpose: z.nativeEnum(PulloutPurpose).optional().nullable(),
    requestedById: z.string().optional().nullable(),
    receivedByName: text(200),
    courierCompany: text(200),
    courierContact: text(80),
    vehicle: text(120),
    destination: text(300),
    poReference: text(120),
    drReference: text(120),
    returnBy: z.string().optional().nullable(),
    reason: text(2000),
    notes: z.string().max(4000).optional().nullable(),
    lines: z.array(lineSchema).min(1, 'Pull out at least one line'),
  })
  .refine(
    (b) =>
      b.kind === 'SALES_ORDER' ? !!b.salesOrderId : b.kind === 'PURCHASE_REQUEST' ? !!b.requestId : b.kind === 'PROJECT_STOCK' ? !!b.jobId : true,
    { message: 'Name the sales order, the request or the project it pulls against' },
  )
  .refine((b) => b.kind !== 'OTHER' || (b.reason ?? '').trim().length >= 3, { message: 'Say why there is no source document', path: ['reason'] })
  .refine((b) => b.kind !== 'OTHER' || (!!b.purpose && OTHER_PURPOSES.includes(b.purpose)), {
    message: 'Say what it is for — site installation, testing, a repair, a supplier return or other',
    path: ['purpose'],
  });

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
  const sourceId =
    body.kind === 'SALES_ORDER' ? body.salesOrderId! : body.kind === 'PURCHASE_REQUEST' ? body.requestId! : body.kind === 'PROJECT_STOCK' ? body.jobId! : '';
  const source = await loadSource(body.kind, sourceId, exceptSlipId);
  const free = body.kind === 'OTHER' || body.kind === 'PROJECT_STOCK';
  if (body.requestedById && !(await prisma.user.findUnique({ where: { id: body.requestedById }, select: { id: true } }))) {
    throw badRequest('The person who asked for it is not on file');
  }
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
    if (free) {
      if (l.sourceLineId) throw badRequest('This slip answers no source line');
      const item = itemById.get(l.itemId);
      if (!item || !item.isActive) throw badRequest('One of the items is not in the item master');
      perItem.set(item.id, (perItem.get(item.id) ?? 0) + l.quantity);
      continue;
    }
    const src = l.sourceLineId ? byLine.get(l.sourceLineId) : undefined;
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
  if (body.kind === 'PROJECT_STOCK') {
    // What the project holds at that warehouse — its own goods, at their own average.
    const own = await projectHoldings(prisma, source.jobId!, body.warehouseId);
    for (const [itemId, q] of perItem) {
      const held = own.get(itemId);
      const onHand = held ? num(held.quantity) : 0;
      if (onHand < q - 0.0005) {
        throw badRequest(`${source.job!.number} holds only ${qty(onHand)} of ${itemById.get(itemId)!.name} in ${warehouse.name}`);
      }
    }
    const balByItem = new Map([...own].map(([k, v]) => [k, { averageCost: v.averageCost }]));
    return { source, balByItem, pulloutDate: asDate(body.pulloutDate) ?? today(), returnBy: asDate(body.returnBy) };
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
  return { source, balByItem, pulloutDate: asDate(body.pulloutDate) ?? today(), returnBy: asDate(body.returnBy) };
}

/** The header a sheet writes, beyond its source and warehouse. */
function headerData(body: z.infer<typeof sheetSchema>, returnBy: Date | null) {
  const t = (v: string | null | undefined) => v?.trim() || null;
  return {
    purpose:
      body.purpose ??
      (body.kind === 'SALES_ORDER' ? ('SALES_ORDER' as const) : body.kind === 'PURCHASE_REQUEST' || body.kind === 'PROJECT_STOCK' ? ('PROJECT_USE' as const) : null),
    receivedByName: t(body.receivedByName),
    courierCompany: t(body.courierCompany),
    courierContact: t(body.courierContact),
    vehicle: t(body.vehicle),
    destination: t(body.destination),
    poReference: t(body.poReference),
    drReference: t(body.drReference),
    returnBy,
    reason: body.kind === 'OTHER' ? t(body.reason) : null,
    notes: t(body.notes),
  };
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
      return {
        slipId,
        itemId: l.itemId,
        sourceLineId: l.sourceLineId || null,
        quantity: D(l.quantity),
        unitCost: D(avg),
        amount: D(cents(avg * l.quantity)),
        sortOrder: n,
        serialNo: l.serialNo?.trim() || null,
        condition: l.condition?.trim() || null,
      };
    }),
  });
}

// ── Reading ──────────────────────────────────────────────────────────────────

/** Which slips a list query means — one rule for the list, its cards and its paper. */
function listWhere(q: ListQuery, me: ResolvedUser) {
  const base: Prisma.PulloutSlipWhereInput[] = [ownSlips(me)];
  const f = q.filters;
  if (f.salesOrderId) base.push({ salesOrderId: f.salesOrderId });
  if (f.requestId) base.push({ requestId: f.requestId });
  if (f.jobId) base.push({ jobId: f.jobId });
  const kind = choice(f.kind, PulloutKind, 'Kind');
  if (kind) base.push({ kind });
  const purpose = choice(f.purpose, PulloutPurpose, 'Purpose');
  // A slip from before the purposes reads its purpose from its kind.
  if (purpose === 'SALES_ORDER') base.push({ OR: [{ purpose }, { purpose: null, kind: 'SALES_ORDER' }] });
  else if (purpose === 'PROJECT_USE') base.push({ OR: [{ purpose }, { purpose: null, kind: 'PURCHASE_REQUEST' }] });
  else if (purpose) base.push({ purpose });
  if (q.search) {
    base.push({
      OR: [
        { number: { contains: q.search, mode: 'insensitive' } },
        { receivedByName: { contains: q.search, mode: 'insensitive' } },
        { destination: { contains: q.search, mode: 'insensitive' } },
        { courierCompany: { contains: q.search, mode: 'insensitive' } },
        { poReference: { contains: q.search, mode: 'insensitive' } },
        { drReference: { contains: q.search, mode: 'insensitive' } },
        { reason: { contains: q.search, mode: 'insensitive' } },
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
  requestedBy: { select: { id: true, name: true } },
  items: { select: { quantity: true } },
} satisfies Prisma.PulloutSlipInclude;

pulloutRoutes.get(
  '/',
  requireAny(VIEW, VIEW_OWN),
  handler(async (req, res) => {
    const q = listQuery(req);
    const { base, where } = listWhere(q, currentUser(req));
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
          purpose: purposeOf(r),
          purposeLabel: PULLOUT_PURPOSES[purposeOf(r)],
          destination: r.destination,
          returnBy: r.returnBy,
          salesOrder: r.salesOrder,
          request: r.request,
          job: r.job,
          warehouse: r.warehouse,
          preparedBy: r.preparedBy,
          requestedBy: r.requestedBy ?? r.preparedBy,
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
  requireAny(VIEW, VIEW_OWN),
  handler(async (req, res) => {
    const q = listQuery(req);
    const { where } = listWhere(q, currentUser(req));
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
      f.kind && (f.kind === 'SALES_ORDER' ? 'against sales orders' : f.kind === 'PURCHASE_REQUEST' ? 'against purchase requests' : f.kind === 'PROJECT_STOCK' ? 'from project stock' : 'with no source document'),
      f.purpose && `for ${PULLOUT_PURPOSES[f.purpose as PulloutPurpose].toLowerCase()}`,
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
          head: ['Number', 'Against', 'Purpose', 'Destination', 'Warehouse', 'Date', 'Lines', 'Requested by', 'Courier / received by', 'Status'],
          align: ['left', 'left', 'left', 'left', 'left', 'left', 'right', 'left', 'left', 'left'],
          rows: rows.map((r) => [
            r.number,
            r.salesOrder
              ? { title: r.salesOrder.number, body: r.job?.number }
              : r.request
                ? { title: r.request.number, body: r.job?.number }
                : r.kind === 'PROJECT_STOCK' && r.job
                  ? { title: r.job.number, body: 'Project stock' }
                  : 'No source document',
            PULLOUT_PURPOSES[purposeOf(r)],
            r.destination ?? '',
            r.warehouse.name,
            formatShortDate(r.pulloutDate),
            String(r.items.length),
            (r.requestedBy ?? r.preparedBy).name,
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
    const kind = req.query.kind === 'PURCHASE_REQUEST' ? 'PURCHASE_REQUEST' : req.query.kind === 'PROJECT_STOCK' ? 'PROJECT_STOCK' : 'SALES_ORDER';
    const term = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (kind === 'PROJECT_STOCK') {
      // Projects holding goods of their own in a warehouse.
      const rows = await prisma.job.findMany({
        where: {
          projectStock: { some: { quantity: { gt: 0 } } },
          ...(term ? { OR: [{ number: { contains: term, mode: 'insensitive' } }, { name: { contains: term, mode: 'insensitive' } }] } : {}),
        },
        select: { id: true, number: true, name: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 30,
      });
      res.json(rows.map((r) => ({ id: r.id, number: r.number, label: r.name, date: r.createdAt })));
      return;
    }
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
    const jobId = typeof req.query.jobId === 'string' ? req.query.jobId : '';
    const warehouseId = typeof req.query.warehouseId === 'string' ? req.query.warehouseId : '';
    const exceptSlipId = typeof req.query.slipId === 'string' ? req.query.slipId : undefined;
    const none = req.query.kind === 'OTHER';
    const ownStock = req.query.kind === 'PROJECT_STOCK';
    if (ownStock && !jobId) throw badRequest('Name the project');
    if (!none && !ownStock && !salesOrderId && !requestId) throw badRequest('Name the sales order or the request');
    const source = none
      ? NO_SOURCE
      : ownStock
        ? await loadSource('PROJECT_STOCK', jobId)
        : await loadSource(salesOrderId ? 'SALES_ORDER' : 'PURCHASE_REQUEST', salesOrderId || requestId, exceptSlipId);
    if (ownStock) {
      // The project's own goods: which warehouses hold any, and what it holds at the one asked.
      const [held, warehouses] = await Promise.all([
        warehouseId ? projectHoldings(prisma, jobId, warehouseId) : Promise.resolve(new Map()),
        prisma.warehouse.findMany({
          where: { isActive: true, projectStock: { some: { jobId, quantity: { gt: 0 } } } },
          select: { id: true, code: true, name: true },
          orderBy: { name: 'asc' },
        }),
      ]);
      res.json({
        source,
        purposes: Object.entries(PULLOUT_PURPOSES).map(([key, label]) => ({ key, label, noSource: OTHER_PURPOSES.includes(key as PulloutPurpose) })),
        warehouses,
        items: [...held.values()].map((r) => ({
          id: r.item.id,
          code: r.item.code,
          partNumber: r.item.partNumber,
          brand: null,
          name: r.item.name,
          unit: r.item.unit,
          available: num(r.quantity),
        })),
      });
      return;
    }
    const [warehouses, stock] = await Promise.all([
      prisma.warehouse.findMany({ where: { isActive: true }, select: { id: true, code: true, name: true }, orderBy: { name: 'asc' } }),
      warehouseId
        ? prisma.inventoryBalance.findMany({
            where: { warehouseId, item: { isActive: true } },
            include: { item: { select: { id: true, code: true, partNumber: true, brand: true, name: true, unit: true } } },
            orderBy: { item: { name: 'asc' } },
          })
        : [],
    ]);
    res.json({
      source,
      purposes: Object.entries(PULLOUT_PURPOSES).map(([key, label]) => ({ key, label, noSource: OTHER_PURPOSES.includes(key as PulloutPurpose) })),
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
      requestedBy: { select: { id: true, name: true, position: true } },
      items: { include: { item: { select: { id: true, code: true, partNumber: true, brand: true, name: true, unit: true } } }, orderBy: { sortOrder: 'asc' } },
    },
  });
}
type LoadedSlip = NonNullable<Awaited<ReturnType<typeof loadSlip>>>;

/** The register's right; or — through `requireAnyOrDecider` — whoever may decide its open request, only while it waits on them. */
async function visibleSlip(me: ResolvedUser, id: string, deciderOnly: boolean): Promise<LoadedSlip> {
  const slip = await loadSlip(id);
  if (!slip) throw notFound('Pull-out slip not found');
  // Who asked for it reads it — sales or the project, who may hold no warehouse right.
  // View Own reads the slips one prepared or asked for.
  const ownOnly = deciderOnly || !can(me, VIEW);
  if (ownOnly && slip.requestedById !== me.id && slip.preparedById !== me.id && !(await mayDecide(me.id, DOC, [slip.id]))) {
    throw notFound('Pull-out slip not found');
  }
  return slip;
}

/** In whose name it goes for approval: who asked for it, else who prepared it. */
const requesterOf = (slip: { requestedById: string | null; preparedById: string }) => slip.requestedById ?? slip.preparedById;

/** Whoever may move a slip on — modify, submit, pull back, cancel, pull out: who prepared it, or edit_all. */
const mayHandle = (me: ResolvedUser, slip: { preparedById: string }) =>
  can(me, EDIT_ALL) || (can(me, EDIT_OWN) && slip.preparedById === me.id);

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
  const route = draft ? await pickWorkflow(DOC, null, { requesterId: requesterOf(slip) }) : null;
  const lines = await sourceLinesOf(slip);
  return {
    ...slip,
    purpose: purposeOf(slip),
    purposeLabel: PULLOUT_PURPOSES[purposeOf(slip)],
    requestedBy: slip.requestedBy ?? { ...slip.preparedBy, position: null },
    canEdit: draft && handles,
    needsApproval: draft ? !!route : null,
    canSubmit: draft && handles && !!route && slip.items.length > 0,
    canPullOut: draft && handles && !route && slip.items.length > 0,
    canWithdraw: slip.status === 'PENDING_APPROVAL' && handles,
    canCancel: (draft || slip.status === 'PENDING_APPROVAL') && handles,
    canDelete: (draft || slip.status === 'CANCELLED') && handles && can(me, 'gchain.pullout_slips.delete'),
    approvalRoute: draft && route ? await routeBrief(DOC, null, requesterOf(slip)) : null,
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
  requireAnyOrDecider(VIEW, VIEW_OWN),
  handler(async (req, res) => {
    const me = currentUser(req);
    res.json(await presentSlip(await visibleSlip(me, req.params.id, res.locals.deciderOnly === true), me));
  }),
);

/**
 * The slip on paper — the internal release slip (2026-10-15, the owner's
 * pull-out slip as the guide), what goes out, never what it cost: the
 * references (sales order, purchase request, PO and DR refs, the purpose and
 * the project), the authorized person or courier beside where it goes, the
 * items with their serial and condition, the reason (no source document),
 * the instructions, and the gate clearance the guard signs on paper. Then
 * REQUESTED BY (who asked, dated when the slip was raised), the route's step
 * ("Pending" until signed; a draft prints the route submitting would take),
 * WAREHOUSE RELEASED BY and PULLED OUT / RECEIVED BY — the name written on the
 * slip, dated when it went out. Attachments follow it (`?attachments=0` bare).
 */
pulloutRoutes.get(
  '/:id/pdf',
  requireAnyOrDecider(VIEW, VIEW_OWN),
  handler(async (req, res) => {
    const me = currentUser(req);
    const slip = await visibleSlip(me, req.params.id, res.locals.deciderOnly === true);
    const lines = await sourceLinesOf(slip);
    const requesterId = requesterOf(slip);
    const requester = slip.requestedBy ?? slip.preparedBy;
    const slots =
      slip.status === 'DRAFT'
        ? await approvalSlots(DOC, slip.id, { amount: null, requesterId })
        : await approvalSlots(DOC, slip.id);
    const out = slip.status === 'PULLED_OUT';
    const signatories: Signatory[] = [
      { role: 'Requested by', name: requester.name, ...(await contactOf(requester.id)), at: preparedAt(slots) ?? slip.createdAt },
      ...slotSignatories(slots),
    ];
    if (out && slip.releasedBy) {
      signatories.push({ role: 'Warehouse released by', name: slip.releasedBy.name, ...(await contactOf(slip.releasedBy.id)), at: slip.releasedAt });
    }
    if (slip.receivedByName && slip.status !== 'CANCELLED') {
      signatories.push({ role: 'Pulled out / received by', name: slip.receivedByName, at: out ? slip.releasedAt : null });
    }
    const purpose = PULLOUT_PURPOSES[purposeOf(slip)];
    const against = slip.salesOrder?.number ?? slip.request?.number ?? purpose;
    const courierLines = [
      slip.receivedByName ?? '—',
      slip.courierCompany ?? '',
      slip.courierContact ? `Contact: ${slip.courierContact}` : '',
      slip.vehicle ? `Vehicle: ${slip.vehicle}` : '',
    ].filter((l) => l.trim());
    const destinationLines = [
      slip.destination ?? (slip.job ? `${slip.job.number} — ${slip.job.name}` : '—'),
      `Warehouse source: ${slip.warehouse.name}`,
      slip.returnBy ? `Expected back: ${formatDate(slip.returnBy)}` : '',
    ].filter((l) => l.trim());
    const sections: PdfSection[] = [
      { kind: 'blocks', titleSize: 11, blocks: [{ title: 'Authorized person / courier', lines: courierLines }, { title: 'Destination', lines: destinationLines }] },
      {
        kind: 'table',
        title: 'Authorized warehouse items to pull out',
        head: ['Item', 'Part / SKU no.', 'Item description & specifications', 'Serial / batch no.', 'Qty', 'Unit', 'Condition'],
        align: ['right', 'left', 'left', 'left', 'right', 'left', 'left'],
        rows: slip.items.map((i, n) => {
          const answers = i.sourceLineId ? lines.get(i.sourceLineId)?.title : undefined;
          return [
            String(n + 1),
            i.item.partNumber ?? i.item.code,
            { title: i.item.name, body: [i.item.brand, answers && answers !== i.item.name ? `For: ${answers}` : null].filter(Boolean).join(' · ') || undefined },
            i.serialNo ?? '',
            qty(num(i.quantity)),
            i.item.unit,
            i.condition ?? '',
          ];
        }),
      },
    ];
    if (slip.reason) sections.push({ kind: 'text', title: 'Why there is no source document', body: slip.reason });
    if (slip.notes) sections.push({ kind: 'text', title: 'Special instructions / remarks / accessories included', body: slip.notes });
    if (slip.status === 'CANCELLED' && slip.cancelReason) sections.push({ kind: 'text', title: 'Cancelled', body: slip.cancelReason });
    if (slip.status !== 'CANCELLED') {
      sections.push({
        kind: 'text',
        title: 'Warehouse gate clearance & inspection',
        body: 'Security must check the item serial numbers and count against this slip before the vehicle is released.\n\nGuard on duty: ______________________________    Time out: ______________',
      });
    }
    const pdf = await renderDocument({
      title: 'Pull-out Slip',
      titleBold: true,
      documentNumber: slip.number,
      date: slip.pulloutDate,
      numberNote: `Date: ${formatDate(slip.pulloutDate)}`,
      detailsTitle: 'References',
      detailsTitleSize: 11,
      details: [
        [
          ['Sales order (SO)', slip.salesOrder?.number ?? '—'],
          ['Purchase request (PR)', slip.request?.number ?? '—'],
        ],
        [
          ['PO ref.', slip.poReference ?? '—'],
          ['DR ref.', slip.drReference ?? '—'],
        ],
        [
          ['Purpose', purpose],
          ['Project', slip.job ? slip.job.number : '—'],
        ],
      ],
      sections,
      signatories,
      signoffNote: 'The name, date and time are considered a digital signature.',
      footerNote:
        slip.status === 'DRAFT' || slip.status === 'PENDING_APPROVAL' ? 'DRAFT — NOT YET RELEASED.' : slip.status === 'CANCELLED' ? 'CANCELLED.' : undefined,
    });
    const files = req.query.attachments === '0' ? [] : await attachedFiles('pullout_slip', slip.id);
    const { pdf: withFiles, listed } = await withAttachments(pdf, files, { title: 'Pull-out Slip', number: slip.number, reference: against });
    await audit({ entityType: 'pullout_slip', entityId: slip.id, action: 'EXPORTED', summary: `Printed ${slip.number}${listed ? ` with ${listed} attachment${listed === 1 ? '' : 's'}` : ''}` }, req);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition(paperFileName({ kind: 'Pull-out Slip', number: slip.number, author: requester.name, date: slip.pulloutDate })));
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
    const { source, balByItem, pulloutDate, returnBy } = await checkSheet(body);
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
          requestedById: body.requestedById || null,
          pulloutDate,
          ...headerData(body, returnBy),
        },
      });
      await writeLines(tx, created.id, body.lines, balByItem);
      return created;
    });
    await audit(
      {
        entityType: 'pullout_slip',
        entityId: slip.id,
        action: 'CREATED',
        summary: `${slip.number} raised ${source.number ? `against ${source.number}` : `with no source document — ${PULLOUT_PURPOSES[slip.purpose ?? 'OTHER'].toLowerCase()}`}`,
      },
      req,
    );
    const routed = !!(await pickWorkflow(DOC, null, { requesterId: slip.requestedById ?? me.id }));
    res.status(201).json({ ...slip, needsApproval: routed });
  }),
);

/** Modify a draft whole — header and lines in one save, claimed on DRAFT and the `version` read. */
pulloutRoutes.put(
  '/:id/sheet',
  requireAny(EDIT_OWN, EDIT_ALL),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(sheetSchema.and(z.object({ version: z.string().optional() })), req.body);
    const slip = await prisma.pulloutSlip.findUnique({ where: { id: req.params.id } });
    if (!slip) throw notFound('Pull-out slip not found');
    if (!mayHandle(me, slip)) throw forbidden('This slip is someone else’s');
    if (slip.status !== 'DRAFT') throw badRequest(`${slip.number} is ${statusLabel(slip.status).toLowerCase()}${slip.status === 'PENDING_APPROVAL' ? ' — pull it back first' : ''}`);
    if (
      body.kind !== slip.kind ||
      (body.salesOrderId ?? null) !== slip.salesOrderId ||
      (body.requestId ?? null) !== slip.requestId ||
      (slip.kind === 'PROJECT_STOCK' && (body.jobId ?? null) !== slip.jobId)
    ) {
      throw badRequest('A slip keeps the document it pulls against — raise another for a different one');
    }
    if (body.version && new Date(body.version).getTime() !== slip.updatedAt.getTime()) throw badRequest(`${slip.number} changed a moment ago — reload to see it`);
    const { balByItem, pulloutDate, returnBy } = await checkSheet(body, slip.id);
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.pulloutSlip.updateMany({
        where: { id: slip.id, status: 'DRAFT', updatedAt: slip.updatedAt },
        data: { warehouseId: body.warehouseId, pulloutDate, requestedById: body.requestedById || null, ...headerData(body, returnBy) },
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
      jobId: slip.jobId,
      warehouseId: slip.warehouseId,
      pulloutDate: slip.pulloutDate.toISOString().slice(0, 10),
      purpose: slip.purpose,
      reason: slip.reason,
      receivedByName: slip.receivedByName,
      notes: slip.notes,
      lines: slip.items.map((i) => ({ sourceLineId: i.sourceLineId, itemId: i.itemId, quantity: num(i.quantity) })),
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
  requireAny(EDIT_OWN, EDIT_ALL),
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
        subject: `${slip.salesOrder ? `${slip.salesOrder.number} — ${slip.salesOrder.customer.name}` : (slip.request?.number ?? PULLOUT_PURPOSES[purposeOf(slip)])} · ${slip.warehouse.name}`,
        amount: null,
        link: `/g-chain/pullout-slips/${slip.id}`,
        requesterId: requesterOf(slip),
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
  requireAny(EDIT_OWN, EDIT_ALL),
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
  requireAny(EDIT_OWN, EDIT_ALL),
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
 * A draft or a CANCELLED slip is deleted (2026-10-19, the owner's call):
 * nothing went out on either. The delete right, and whoever may change it;
 * its files go after the commit.
 */
pulloutRoutes.delete(
  '/:id',
  require_('gchain.pullout_slips.delete'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const slip = await prisma.pulloutSlip.findUnique({ where: { id: req.params.id } });
    if (!slip) throw notFound('Pull-out slip not found');
    if (!mayHandle(me, slip)) throw forbidden('This slip is someone else’s');
    if (slip.status !== 'DRAFT' && slip.status !== 'CANCELLED') {
      throw badRequest(`Only a draft or a cancelled slip can be deleted — ${slip.number} is ${statusLabel(slip.status).toLowerCase()}`);
    }
    const gone = await deleteOrRefuse(slip.number, () =>
      prisma.pulloutSlip.deleteMany({ where: { id: slip.id, status: { in: ['DRAFT', 'CANCELLED'] } } }),
    );
    if (!gone.count) throw badRequest(`${slip.number} changed a moment ago — it stays on record`);
    await deleteAttachmentsOf(DOC, [slip.id]);
    await audit(
      { entityType: 'pullout_slip', entityId: slip.id, action: 'DELETED', summary: `Deleted ${slip.status === 'CANCELLED' ? 'cancelled' : 'draft'} ${slip.number}` },
      req,
    );
    res.json({ ok: true });
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
  // The project's own stock: charged at receiving, so only CONSUMED is posted.
  const own = slip.kind === 'PROJECT_STOCK';
  for (const line of slip.items) {
    const move = {
      itemId: line.itemId,
      warehouseId: slip.warehouseId,
      quantity: num(line.quantity),
      sourceType: DOC,
      sourceId: slip.id,
      sourceNumber: slip.number,
      createdById: actorId,
    };
    if (own && !slip.jobId) throw badRequest(`${slip.number} names no project`);
    const moved = own ? await issueProjectStock(tx, { ...move, jobId: slip.jobId! }) : await issueStock(tx, move);
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
      for (const state of own ? (['CONSUMED'] as const) : (['INCURRED', 'CONSUMED'] as const)) {
        await postJobCost(tx, {
          jobId: slip.jobId,
          costCategoryId,
          state,
          amount,
          sourceType: DOC,
          sourceId: slip.id,
          sourceNumber: slip.number,
          description: own ? `Pulled out from the project's own stock — ${slip.number}` : `Pulled out from stock — ${slip.number}`,
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
  // Who asked for it, and the owner of the document it answers — once each.
  const to = [...new Set([slip.requestedById, slip.salesOrder?.ownerId, slip.request?.requestedById].filter((u): u is string => !!u && u !== actorId))];
  for (const userId of to) {
    await notify({
      userId,
      type: 'pullout.done',
      title: `${slip.number} pulled out — ${slip.salesOrder?.number ?? slip.request?.number ?? PULLOUT_PURPOSES[purposeOf(slip)]}`,
      body: `${slip.items.length} line${slip.items.length === 1 ? '' : 's'} from ${slip.warehouse.name}${slip.receivedByName ? `, received by ${slip.receivedByName}` : ''}`,
      link: `/g-chain/pullout-slips/${slip.id}`,
    });
  }
}

/** Without a route (switched off), the preparer pulls it out at once — the Outgoing rule. */
pulloutRoutes.post(
  '/:id/pull-out',
  requireAny(EDIT_OWN, EDIT_ALL),
  handler(async (req, res) => {
    const me = currentUser(req);
    const slip = await loadSlip(req.params.id);
    if (!slip) throw notFound('Pull-out slip not found');
    if (!mayHandle(me, slip)) throw forbidden('This slip is someone else’s');
    if (slip.status !== 'DRAFT') throw badRequest(`${slip.number} is ${statusLabel(slip.status).toLowerCase()}`);
    if (await pickWorkflow(DOC, null, { requesterId: requesterOf(slip) })) {
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

/**
 * Pulled back after approval (2026-10-16, the owner's call): PULLED_OUT →
 * DRAFT, `postPullout` undone by movements of its own — the stock put back
 * at the cost each line left at, a request's pulled quantities and status
 * put back and its commitment restored by what the slip released, the
 * project's cost reversed. A request no longer open (cancelled meanwhile)
 * refuses it.
 */
onApprovalReopened(DOC, {
  may: async (actor, id) => {
    const slip = await prisma.pulloutSlip.findUnique({ where: { id }, select: { preparedById: true } });
    return !!slip && mayHandle(actor, slip);
  },
  reopen: async ({ documentId, tx, actor, reason }) => {
    const slip = await tx.pulloutSlip.findUnique({ where: { id: documentId }, include: { items: true, request: { include: { items: true } } } });
    if (!slip) throw notFound('Pull-out slip not found');
    if (slip.status !== 'PULLED_OUT') throw badRequest(`${slip.number} is ${statusLabel(slip.status).toLowerCase()} — only a pulled-out slip is pulled back`);
    if (slip.request && !['APPROVED', 'PARTIALLY_ORDERED', 'ORDERED'].includes(slip.request.status)) {
      throw badRequest(`${slip.request.number} is ${statusLabel(slip.request.status).toLowerCase()} — ${slip.number} cannot be pulled back`);
    }
    const claimed = await tx.pulloutSlip.updateMany({
      where: { id: slip.id, status: 'PULLED_OUT' },
      data: { status: 'DRAFT', releasedById: null, releasedAt: null },
    });
    if (!claimed.count) throw badRequest(`${slip.number} changed a moment ago — reload to see where it stands`);
    const why = `${slip.number} pulled back to draft by ${actor.name}: ${reason}`;
    const prLines = new Map((slip.request?.items ?? []).map((i) => [i.id, i]));
    for (const line of slip.items) {
      const back = {
        itemId: line.itemId,
        warehouseId: slip.warehouseId,
        quantity: num(line.quantity),
        unitCost: num(line.unitCost),
        sourceType: DOC,
        sourceId: slip.id,
        sourceNumber: slip.number,
        notes: why,
        createdById: actor.id,
      };
      if (slip.kind === 'PROJECT_STOCK' && slip.jobId) await receiveProjectStock(tx, { ...back, jobId: slip.jobId });
      else await returnIssuedStock(tx, back);
      const pr = slip.kind === 'PURCHASE_REQUEST' && line.sourceLineId ? prLines.get(line.sourceLineId) : undefined;
      if (pr) {
        const left = Math.max(0, Math.round((num(pr.pulledQty) - num(line.quantity)) * 1000) / 1000);
        await tx.purchaseRequestItem.update({ where: { id: pr.id }, data: { pulledQty: D(left) } });
        pr.pulledQty = D(left);
      }
    }
    if (slip.request) {
      const items = [...prLines.values()];
      const none = items.every((i) => num(i.orderedQty) + num(i.pulledQty) < 0.0005);
      const covered = items.every((i) => num(i.orderedQty) + num(i.pulledQty) >= num(i.quantity) - 0.0005);
      await tx.purchaseRequest.update({ where: { id: slip.request.id }, data: { status: none ? 'APPROVED' : covered ? 'ORDERED' : 'PARTIALLY_ORDERED' } });
      await reverseJobCost(tx, {
        sourceType: 'purchase_request',
        sourceId: slip.request.id,
        states: ['COMMITTED'],
        description: `Taken from stock on ${slip.number}`,
        reason: why,
        createdById: actor.id,
      });
    }
    await reverseJobCost(tx, { sourceType: DOC, sourceId: slip.id, reason: why, sourceNumber: slip.number, createdById: actor.id });
  },
});

// The delivery receipt or photos: read as the slip is read, added while it
// is a draft or pending by whoever may move it on.
registerAttachmentGuard(
  'pullout_slip',
  async (user, id) => {
    if (can(user, VIEW)) return !!(await prisma.pulloutSlip.findUnique({ where: { id }, select: { id: true } }));
    if ((await prisma.pulloutSlip.count({ where: { id, OR: [{ requestedById: user.id }, { preparedById: user.id }] } })) > 0) return true;
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
          { destination: { contains: term, mode: 'insensitive' } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        number: true,
        status: true,
        kind: true,
        purpose: true,
        destination: true,
        salesOrder: { select: { number: true, customer: { select: { name: true } } } },
        request: { select: { number: true } },
      },
    });
    return rows.map((r) => ({
      kind: 'pullout_slip',
      id: r.id,
      title: `${r.number} — ${r.salesOrder ? r.salesOrder.customer.name : (r.request?.number ?? PULLOUT_PURPOSES[purposeOf(r)])}`,
      subtitle: `${r.salesOrder ? `Against ${r.salesOrder.number}` : r.request ? `Against ${r.request.number}` : r.kind === 'PROJECT_STOCK' ? `Project stock` : `No source document${r.destination ? ` · ${r.destination}` : ''}`} · ${statusLabel(r.status)}`,
      link: `/g-chain/pullout-slips/${r.id}`,
    }));
  },
});
