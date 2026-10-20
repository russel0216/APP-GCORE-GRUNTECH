import { Router } from 'express';
import { z } from 'zod';
import { Prisma, RfqStatus } from '@prisma/client';
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
import { deleteAttachmentsOf, registerAttachmentGuard } from '../shared/attachments';
import { authenticate, require_, requireAny, currentUser } from '../auth/middleware';
import { can, canEditRecord, type ResolvedUser } from '../permissions/resolve';
import { audit } from '../shared/audit';
import { registerSearch } from '../shared/search';
import { nextNumber } from '../shared/numbering';
import { contactOf } from '../shared/approvals';
import {
  renderDocument,
  formatAmount,
  formatDate,
  formatShortDate,
  formatQuantity,
  statusLabel,
  companyCurrency,
  type PdfSection,
  type Signatory,
} from '../shared/pdf';
import { LIST_CAP, listReference, recordNamed, choice, sendListPdf } from '../shared/listPaper';
import { contentDisposition, paperFileName } from '../shared/paperName';
import { visibleOwners } from '../shared/team';

/**
 * Requests for Quotation (2026-10-14, the owner's call: "Purchase Request,
 * RFQ, Canvass, Purchase Order — the flow from PR to RFQ, a standard form
 * and list; printed documents show Prepared by with the standard digital
 * time stamp").
 *
 * An RFQ is raised FROM an APPROVED purchase request and asks suppliers to
 * quote some or all of its lines (`RfqItem`, a subset — one request may be
 * split by category, or asked again). It is printed one paper per supplier
 * and sent by hand (the owner's call: printed only); the quotes that come
 * back are recorded on the RFQ, and the canvass sheet compares them. It has
 * NO approval route: an enquiry decides nothing — the request was approved
 * and the purchase order will be.
 *
 * DRAFT → SENT (dated, "Mark sent") → QUOTED (the first quote recorded) →
 * CLOSED (its canvass awarded); CANCELLED with a reason from any open
 * state. Lines are fixed once sent; suppliers may still be added (a late
 * enquiry), and a supplier who has quoted is never removed.
 */
export const rfqRoutes = Router();
rfqRoutes.use(authenticate);

const num = (v: Prisma.Decimal | null | undefined) => (v == null ? 0 : Number(v));
const cents = (n: number) => Math.round(n * 100) / 100;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const asDay = (v: string | null | undefined) => (v ? new Date(`${v}T00:00:00Z`) : null);
const OPEN: RfqStatus[] = ['DRAFT', 'SENT', 'QUOTED'];
const RFQ_SORTS = ['number', 'createdAt', 'dueDate'];

/** Who may change an RFQ: edit_all, or whoever prepared it holding edit_own (rule 7). */
function mayEditRfq(me: ResolvedUser, rfq: { preparedById: string }): boolean {
  return canEditRecord(me, 'gchain', 'rfq', rfq.preparedById);
}

/** A reader with view_own alone sees what they prepared. */
function seesAll(me: ResolvedUser) {
  return can(me, 'gchain.rfq.view_all');
}

async function assertVisible(me: ResolvedUser, rfq: { preparedById: string }) {
  if (!seesAll(me) && !visibleOwners(me, 'gchain', 'rfq').includes(rfq.preparedById)) throw notFound('RFQ not found');
}

/** Which RFQs a list query means — one rule for the list and its printed twin. */
function rfqListWhere(me: ResolvedUser, q: ListQuery): Prisma.RfqWhereInput {
  const and: Prisma.RfqWhereInput[] = [];
  if (q.scope === 'mine') and.push({ preparedById: me.id });
  else if (!seesAll(me)) and.push({ preparedById: { in: visibleOwners(me, 'gchain', 'rfq') } });
  const f = q.filters;
  const status = choice(f.status, RfqStatus, 'Status');
  if (status) and.push({ status });
  if (f.open === 'true') and.push({ status: { in: OPEN } });
  if (f.requestId) and.push({ requestId: f.requestId });
  if (f.supplierId) and.push({ suppliers: { some: { supplierId: f.supplierId } } });
  if (q.search) {
    and.push({
      OR: [
        { number: { contains: q.search, mode: 'insensitive' } },
        { request: { number: { contains: q.search, mode: 'insensitive' } } },
        { request: { purpose: { contains: q.search, mode: 'insensitive' } } },
        { suppliers: { some: { supplier: { name: { contains: q.search, mode: 'insensitive' } } } } },
      ],
    });
  }
  const ids = idsFilter(f.ids);
  if (ids) and.push({ id: { in: ids } });
  return and.length ? { AND: and } : {};
}

const LIST_INCLUDE = {
  request: {
    select: {
      id: true,
      number: true,
      purpose: true,
      job: { select: { id: true, number: true, name: true } },
      warehouse: { select: { id: true, name: true } },
    },
  },
  preparedBy: { select: { id: true, name: true } },
  suppliers: { select: { id: true, supplier: { select: { name: true } }, _count: { select: { quotes: true } } } },
  _count: { select: { items: true } },
} satisfies Prisma.RfqInclude;

rfqRoutes.get(
  '/',
  requireAny('gchain.rfq.view_all', 'gchain.rfq.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const where = rfqListWhere(me, q);
    const [rows, total, open] = await Promise.all([
      prisma.rfq.findMany({
        where,
        include: LIST_INCLUDE,
        orderBy: orderBy(q, RFQ_SORTS, { createdAt: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.rfq.count({ where }),
      prisma.rfq.count({ where: { AND: [where, { status: { in: OPEN } }] } }),
    ]);
    res.json({
      ...listResult(
        rows.map((r) => ({
          ...r,
          lineCount: r._count.items,
          supplierCount: r.suppliers.length,
          quotedCount: r.suppliers.filter((s) => s._count.quotes > 0).length,
        })),
        total,
        q,
      ),
      summary: { count: total, open },
    });
  }),
);

/** The RFQ list on paper (`rfqListWhere`, or the rows ticked). No prices: those are per supplier. Above `/:id`. */
rfqRoutes.get(
  '/pdf',
  requireAny('gchain.rfq.view_all', 'gchain.rfq.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const where = rfqListWhere(me, q);
    const [rows, count] = await Promise.all([
      prisma.rfq.findMany({ where, include: LIST_INCLUDE, orderBy: orderBy(q, RFQ_SORTS, { createdAt: 'desc' }), take: LIST_CAP }),
      prisma.rfq.count({ where }),
    ]);
    const f = q.filters;
    const [request, supplier] = await Promise.all([recordNamed('purchase request', f.requestId), recordNamed('supplier', f.supplierId)]);
    const reference = listReference(count, rows.length, ['RFQ', 'RFQs'], [
      q.search && `search "${q.search}"`,
      f.status && `status ${statusLabel(f.status)}`,
      f.open === 'true' && 'open only',
      request,
      supplier,
      q.scope === 'mine' && 'prepared by me',
      f.ids && 'the rows selected',
    ]);
    const pdf = await renderDocument({
      title: 'Requests for Quotation',
      date: new Date(),
      reference,
      // Eight columns: landscape (rule 6, A5).
      landscape: true,
      sections: [
        {
          kind: 'table',
          head: ['Number', 'Request', 'Suppliers', 'Quoted', 'Quote by', 'Prepared by', 'Date', 'Status'],
          align: ['left', 'left', 'left', 'right', 'left', 'left', 'left', 'left'],
          rows: rows.map((r) => [
            r.number,
            { title: r.request.purpose, body: [r.request.number, r.request.job?.number].filter(Boolean).join(' · ') },
            r.suppliers.map((s) => s.supplier.name).join(', '),
            `${r.suppliers.filter((s) => s._count.quotes > 0).length} of ${r.suppliers.length}`,
            r.dueDate ? formatShortDate(r.dueDate) : '',
            r.preparedBy.name,
            formatShortDate(r.createdAt),
            statusLabel(r.status),
          ]),
        },
      ],
    });
    await audit({ entityType: 'rfq', entityId: 'list', action: 'EXPORTED', summary: `Exported the RFQ list as PDF (${rows.length} RFQ(s))` }, req);
    sendListPdf(res, pdf, 'rfqs.pdf');
  }),
);

/**
 * What a new RFQ starts from: the approved request, its lines with what each
 * is estimated at, and where it is delivered — the form shows it before
 * anything is saved. Lines already asked on another open RFQ are marked, so
 * a second RFQ on one request is a deliberate split, never an accident.
 */
rfqRoutes.get(
  '/source',
  require_('gchain.rfq.create'),
  handler(async (req, res) => {
    const requestId = String(req.query.requestId ?? '');
    if (!requestId) throw badRequest('Name the purchase request');
    const pr = await prisma.purchaseRequest.findUnique({
      where: { id: requestId },
      include: {
        job: { select: { id: true, number: true, name: true, site: { select: { name: true, address: true, city: true } } } },
        warehouse: { select: { id: true, name: true, address: true, city: true } },
        items: { orderBy: { sortOrder: 'asc' }, include: { costCategory: { select: { id: true, name: true } } } },
        requestedBy: { select: { id: true, name: true } },
      },
    });
    if (!pr) throw notFound('Purchase request not found');
    if (pr.status !== 'APPROVED' && pr.status !== 'PARTIALLY_ORDERED') {
      throw badRequest(`${pr.number} is ${statusLabel(pr.status).toLowerCase()} — only an approved request is sent for quotation`);
    }
    const asked = await prisma.rfqItem.findMany({
      where: { requestItemId: { in: pr.items.map((i) => i.id) }, rfq: { status: { in: OPEN } } },
      select: { requestItemId: true, rfq: { select: { number: true } } },
    });
    const askedOn = new Map<string, string[]>();
    for (const a of asked) askedOn.set(a.requestItemId, [...(askedOn.get(a.requestItemId) ?? []), a.rfq.number]);
    res.json({
      request: {
        id: pr.id,
        number: pr.number,
        purpose: pr.purpose,
        kind: pr.kind,
        neededBy: pr.neededBy,
        preferredSupplier: pr.preferredSupplier,
        job: pr.job ? { id: pr.job.id, number: pr.job.number, name: pr.job.name } : null,
        warehouse: pr.warehouse ? { id: pr.warehouse.id, name: pr.warehouse.name } : null,
        requestedBy: pr.requestedBy,
      },
      deliverTo: deliverToOf(pr),
      lines: pr.items.map((i) => ({
        id: i.id,
        partNumber: i.partNumber,
        name: i.name,
        description: i.description,
        unit: i.unit,
        quantity: num(i.quantity),
        estimatedCost: num(i.estimatedCost),
        estimatedAmount: num(i.estimatedAmount),
        costCategory: i.costCategory,
        askedOn: askedOn.get(i.id) ?? [],
      })),
    });
  }),
);

/**
 * The approved requests an RFQ may be raised from, for the form's picker —
 * behind the RFQ's own create right, so a buyer need not read every request
 * register to ask suppliers about one. Numbers and purposes only.
 */
/**
 * The RFQs a canvass may be started from (2026-10-16, the owner's call: the
 * Canvass list's "+ New canvass"): sent or quoted, at least one supplier
 * quoted, no live canvass yet — the RFQ page's own `canStartCanvass` rule.
 * Above `/:id`.
 */
rfqRoutes.get(
  '/canvassable',
  require_('gchain.canvass.create'),
  handler(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const rows = await prisma.rfq.findMany({
      where: {
        status: { in: ['SENT', 'QUOTED'] },
        canvasses: { none: { status: { not: 'CANCELLED' } } },
        suppliers: { some: { quotes: { some: {} } } },
        ...(q
          ? {
              OR: [
                { number: { contains: q, mode: 'insensitive' } },
                { request: { number: { contains: q, mode: 'insensitive' } } },
                { request: { purpose: { contains: q, mode: 'insensitive' } } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        number: true,
        status: true,
        request: { select: { number: true, purpose: true, job: { select: { number: true, name: true } } } },
        suppliers: { select: { _count: { select: { quotes: true } } } },
      },
      orderBy: { updatedAt: 'desc' },
      take: 30,
    });
    res.json(
      rows.map((r) => ({
        id: r.id,
        number: r.number,
        status: r.status,
        request: r.request,
        quotedSuppliers: r.suppliers.filter((x) => x._count.quotes > 0).length,
      })),
    );
  }),
);

rfqRoutes.get(
  '/requests',
  require_('gchain.rfq.create'),
  handler(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const rows = await prisma.purchaseRequest.findMany({
      where: {
        status: { in: ['APPROVED', 'PARTIALLY_ORDERED'] },
        ...(q
          ? {
              OR: [
                { number: { contains: q, mode: 'insensitive' } },
                { purpose: { contains: q, mode: 'insensitive' } },
                { job: { name: { contains: q, mode: 'insensitive' } } },
                { job: { number: { contains: q, mode: 'insensitive' } } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        number: true,
        purpose: true,
        approvedAt: true,
        job: { select: { number: true, name: true } },
        warehouse: { select: { name: true } },
        _count: { select: { items: true, rfqs: { where: { status: { in: OPEN } } } } },
      },
      orderBy: { approvedAt: 'desc' },
      take: 20,
    });
    res.json(rows.map((r) => ({ ...r, lineCount: r._count.items, openRfqs: r._count.rfqs, _count: undefined })));
  }),
);

/**
 * Whom an RFQ is addressed to at a supplier: its primary contact (else its
 * first), with the supplier's own phone and email to fall back on — for the
 * form to fill a row when the supplier is picked. Names and numbers only.
 */
rfqRoutes.get(
  '/contacts',
  requireAny('gchain.rfq.create', 'gchain.rfq.edit_own', 'gchain.rfq.edit_all'),
  handler(async (req, res) => {
    const supplierId = String(req.query.supplierId ?? '');
    const s = await prisma.supplier.findUnique({
      where: { id: supplierId },
      select: {
        phone: true,
        email: true,
        paymentTerms: true,
        contacts: { select: { name: true, position: true, phone: true, mobile: true, email: true, isPrimary: true }, orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }] },
      },
    });
    if (!s) throw notFound('Supplier not found');
    res.json({
      phone: s.phone,
      email: s.email,
      paymentTerms: s.paymentTerms,
      contacts: s.contacts.map((c) => ({ name: c.name, position: c.position, phone: c.mobile ?? c.phone, email: c.email, isPrimary: c.isPrimary })),
    });
  }),
);

function deliverToOf(pr: {
  job: { name: string; site?: { name: string; address: string | null; city: string | null } | null } | null;
  warehouse: { name: string; address?: string | null; city?: string | null } | null;
}): string {
  if (pr.job) {
    const site = pr.job.site;
    const where = site ? [site.address, site.city].filter(Boolean).join(', ') || site.name : null;
    return [pr.job.name, where].filter(Boolean).join(' — ');
  }
  if (pr.warehouse) return [pr.warehouse.name, [pr.warehouse.address, pr.warehouse.city].filter(Boolean).join(', ')].filter(Boolean).join(' — ');
  return '';
}

async function loadRfq(id: string) {
  return prisma.rfq.findUnique({
    where: { id },
    include: {
      request: {
        select: {
          id: true,
          number: true,
          purpose: true,
          status: true,
          kind: true,
          neededBy: true,
          preferredSupplier: true,
          approvedAt: true,
          job: { select: { id: true, number: true, name: true } },
          warehouse: { select: { id: true, name: true } },
        },
      },
      preparedBy: { select: { id: true, name: true } },
      items: {
        orderBy: { sortOrder: 'asc' },
        include: { requestItem: { include: { costCategory: { select: { id: true, name: true } } } } },
      },
      suppliers: {
        orderBy: { supplier: { name: 'asc' } },
        include: {
          supplier: { select: { id: true, code: true, name: true, address: true, city: true, phone: true, email: true, paymentTerms: true } },
          quotes: true,
        },
      },
      canvasses: { select: { id: true, number: true, status: true } },
    },
  });
}

type LoadedRfq = NonNullable<Awaited<ReturnType<typeof loadRfq>>>;

function presentRfq(rfq: LoadedRfq, me: ResolvedUser) {
  const lines = rfq.items.map((it) => ({
    id: it.requestItem.id,
    partNumber: it.requestItem.partNumber,
    name: it.requestItem.name,
    description: it.requestItem.description,
    unit: it.requestItem.unit,
    quantity: num(it.requestItem.quantity),
    estimatedCost: num(it.requestItem.estimatedCost),
    estimatedAmount: num(it.requestItem.estimatedAmount),
    costCategory: it.requestItem.costCategory,
  }));
  const asked = new Set(lines.map((l) => l.id));
  const suppliers = rfq.suppliers.map((s) => {
    const quotes = s.quotes.filter((qq) => asked.has(qq.requestItemId)).map((qq) => ({ ...qq, unitPrice: num(qq.unitPrice) }));
    const priced = new Map(quotes.map((qq) => [qq.requestItemId, qq.unitPrice]));
    const total = lines.reduce((sum, l) => (priced.has(l.id) ? sum + cents(l.quantity * priced.get(l.id)!) : sum), 0);
    return { ...s, quotes, quotedCount: quotes.length, total: cents(total), complete: quotes.length === lines.length && lines.length > 0 };
  });
  const open = OPEN.includes(rfq.status);
  const editable = open && mayEditRfq(me, rfq);
  const liveCanvass = rfq.canvasses.find((c) => c.status !== 'CANCELLED') ?? null;
  return {
    ...rfq,
    items: undefined,
    lines,
    suppliers,
    estimatedTotal: cents(lines.reduce((s, l) => s + l.estimatedAmount, 0)),
    version: rfq.updatedAt.toISOString(),
    canEdit: editable,
    canEditLines: editable && rfq.status === 'DRAFT',
    canSend: editable && rfq.status === 'DRAFT' && rfq.suppliers.length > 0,
    canRecordQuotes: editable && rfq.status !== 'DRAFT',
    // A quote is removed while no live canvass compares the RFQ (2026-10-19).
    canRemoveQuotes: editable && rfq.status !== 'DRAFT' && !liveCanvass,
    canCancel: editable && !liveCanvass,
    liveCanvass,
    // The next step once quotes are in: the comparison sheet (one live at a time).
    canStartCanvass:
      (rfq.status === 'SENT' || rfq.status === 'QUOTED') && !liveCanvass && suppliers.some((s) => s.quotedCount > 0) && can(me, 'gchain.canvass.create'),
    canDelete: (rfq.status === 'DRAFT' || rfq.status === 'CANCELLED') && can(me, 'gchain.rfq.delete') && mayEditRfq(me, rfq),
  };
}

rfqRoutes.get(
  '/:id',
  requireAny('gchain.rfq.view_all', 'gchain.rfq.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const rfq = await loadRfq(req.params.id);
    if (!rfq) throw notFound('RFQ not found');
    await assertVisible(me, rfq);
    res.json(presentRfq(rfq, me));
  }),
);

const supplierRowSchema = z.object({
  /** A row already on this RFQ keeps its id. */
  id: z.string().optional(),
  supplierId: z.string().min(1, 'Choose the supplier'),
  contactName: z.string().trim().max(200).optional().nullable(),
  contactPhone: z.string().trim().max(60).optional().nullable(),
  email: z.string().trim().max(200).optional().nullable(),
});

const headerSchema = z.object({
  dueDate: z.string().regex(DAY, 'Use a date').optional().nullable(),
  deliverTo: z.string().trim().max(500).optional().nullable(),
  terms: z.string().max(5000).optional().nullable(),
  notes: z.string().max(5000).optional().nullable(),
});

const createSchema = headerSchema.extend({
  requestId: z.string().min(1),
  /** The request lines asked about; all of them when left out. */
  itemIds: z.array(z.string()).max(1000).optional(),
  suppliers: z.array(supplierRowSchema).max(30, 'Thirty suppliers at most on one RFQ').default([]),
});

const sheetSchema = headerSchema.extend({
  /** What the page read (`version`); a change in between is refused. */
  version: z.string().min(1),
  itemIds: z.array(z.string()).max(1000).optional(),
  suppliers: z.array(supplierRowSchema).max(30, 'Thirty suppliers at most on one RFQ'),
});

/** Every supplier named exists, is active, and is named once — checked before a number is issued. */
async function checkSuppliers(rows: z.infer<typeof supplierRowSchema>[]) {
  const ids = rows.map((r) => r.supplierId);
  if (new Set(ids).size !== ids.length) throw badRequest('A supplier is named twice on this RFQ');
  if (!ids.length) return;
  const found = await prisma.supplier.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, isActive: true } });
  if (found.length !== ids.length) throw badRequest('A supplier named does not exist');
  const off = found.filter((s) => !s.isActive);
  if (off.length) throw badRequest(`${off.map((s) => s.name).join(', ')} ${off.length === 1 ? 'is' : 'are'} inactive — switch back on first`);
}

/** A supplier row's contact: a field left out is kept, one sent empty is cleared. */
const rowData = (r: z.infer<typeof supplierRowSchema>) => ({
  ...(r.contactName !== undefined ? { contactName: r.contactName?.trim() || null } : {}),
  ...(r.contactPhone !== undefined ? { contactPhone: r.contactPhone?.trim() || null } : {}),
  ...(r.email !== undefined ? { email: r.email?.trim() || null } : {}),
});

rfqRoutes.post(
  '/',
  require_('gchain.rfq.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(createSchema, req.body);
    const pr = await prisma.purchaseRequest.findUnique({ where: { id: body.requestId }, include: { items: { orderBy: { sortOrder: 'asc' } } } });
    if (!pr) throw notFound('Purchase request not found');
    if (pr.status !== 'APPROVED' && pr.status !== 'PARTIALLY_ORDERED') {
      throw badRequest(`${pr.number} is ${statusLabel(pr.status).toLowerCase()} — only an approved request is sent for quotation`);
    }
    const own = new Map(pr.items.map((i, n) => [i.id, n]));
    const itemIds = body.itemIds ?? pr.items.map((i) => i.id);
    if (!itemIds.length) throw badRequest('Tick at least one line to ask about');
    if (itemIds.some((id) => !own.has(id))) throw badRequest(`A line is not one of ${pr.number}'s`);
    await checkSuppliers(body.suppliers);

    const rfq = await prisma.$transaction(async (tx) => {
      const number = await nextNumber('rfq', tx);
      return tx.rfq.create({
        data: {
          number,
          requestId: pr.id,
          preparedById: me.id,
          dueDate: asDay(body.dueDate),
          deliverTo: body.deliverTo?.trim() || null,
          terms: body.terms?.trim() || null,
          notes: body.notes?.trim() || null,
          items: { create: [...new Set(itemIds)].map((id) => ({ requestItemId: id, sortOrder: own.get(id)! })) },
          suppliers: { create: body.suppliers.map((s) => ({ supplierId: s.supplierId, ...rowData(s) })) },
        },
      });
    });
    await audit(
      { entityType: 'rfq', entityId: rfq.id, action: 'CREATED', summary: `Prepared ${rfq.number} for ${pr.number} (${itemIds.length} line(s), ${body.suppliers.length} supplier(s))` },
      req,
    );
    res.status(201).json({ id: rfq.id, number: rfq.number });
  }),
);

/**
 * The form's one save: the header, the lines (while DRAFT) and the
 * suppliers asked — a row sent with its id kept (its quotes with it), one
 * left out removed unless it has quoted. Claimed on the `version` read.
 */
rfqRoutes.put(
  '/:id/sheet',
  requireAny('gchain.rfq.edit_own', 'gchain.rfq.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(sheetSchema, req.body);
    const rfq = await prisma.rfq.findUnique({
      where: { id: req.params.id },
      include: { items: true, suppliers: { include: { _count: { select: { quotes: true } }, supplier: { select: { name: true } } } }, request: { include: { items: true } } },
    });
    if (!rfq) throw notFound('RFQ not found');
    if (!mayEditRfq(me, rfq)) throw forbidden('This RFQ belongs to someone else');
    if (!OPEN.includes(rfq.status)) throw badRequest(`${rfq.number} is ${statusLabel(rfq.status).toLowerCase()} — it stands as it was`);
    if (rfq.updatedAt.toISOString() !== body.version) throw badRequest(`${rfq.number} changed a moment ago — reload to see it`);

    const own = new Map(rfq.request.items.map((i, n) => [i.id, n]));
    let itemIds: string[] | null = null;
    if (body.itemIds) {
      const before = rfq.items.map((i) => i.requestItemId).sort().join();
      const after = [...new Set(body.itemIds)].sort().join();
      if (before !== after) {
        if (rfq.status !== 'DRAFT') throw badRequest(`${rfq.number} was sent — its lines are what the suppliers were asked`);
        if (!body.itemIds.length) throw badRequest('Tick at least one line to ask about');
        if (body.itemIds.some((id) => !own.has(id))) throw badRequest(`A line is not one of ${rfq.request.number}'s`);
        itemIds = [...new Set(body.itemIds)];
      }
    }
    await checkSuppliers(body.suppliers);
    const rowsById = new Map(rfq.suppliers.map((s) => [s.id, s]));
    for (const r of body.suppliers) {
      if (r.id && !rowsById.has(r.id)) throw badRequest('A supplier row is not on this RFQ');
      if (r.id && rowsById.get(r.id)!.supplierId !== r.supplierId) throw badRequest('A supplier row keeps its supplier — remove it and add the other');
    }
    const kept = new Set(body.suppliers.map((r) => r.id).filter(Boolean));
    const dropped = rfq.suppliers.filter((s) => !kept.has(s.id));
    const quoted = dropped.filter((s) => s._count.quotes > 0);
    if (quoted.length) throw badRequest(`${quoted.map((s) => s.supplier.name).join(', ')} quoted — a supplier who quoted stays on the RFQ`);

    await prisma.$transaction(async (tx) => {
      const claimed = await tx.rfq.updateMany({
        where: { id: rfq.id, updatedAt: rfq.updatedAt, status: { in: OPEN } },
        // A field left out of the save is kept; one sent empty is cleared.
        data: {
          // Moved on every save, so the version a page read goes stale even
          // when only the suppliers changed.
          updatedAt: new Date(),
          ...(body.dueDate !== undefined ? { dueDate: asDay(body.dueDate) } : {}),
          ...(body.deliverTo !== undefined ? { deliverTo: body.deliverTo?.trim() || null } : {}),
          ...(body.terms !== undefined ? { terms: body.terms?.trim() || null } : {}),
          ...(body.notes !== undefined ? { notes: body.notes?.trim() || null } : {}),
        },
      });
      if (!claimed.count) throw badRequest(`${rfq.number} changed a moment ago — reload to see it`);
      if (itemIds) {
        await tx.rfqItem.deleteMany({ where: { rfqId: rfq.id } });
        await tx.rfqItem.createMany({ data: itemIds.map((id) => ({ rfqId: rfq.id, requestItemId: id, sortOrder: own.get(id)! })) });
      }
      if (dropped.length) await tx.rfqSupplier.deleteMany({ where: { id: { in: dropped.map((s) => s.id) } } });
      for (const r of body.suppliers) {
        if (r.id) await tx.rfqSupplier.update({ where: { id: r.id }, data: rowData(r) });
        // A supplier added after the RFQ went out is asked on the day it is added.
        else await tx.rfqSupplier.create({ data: { rfqId: rfq.id, supplierId: r.supplierId, ...rowData(r), sentAt: rfq.status === 'DRAFT' ? null : new Date() } });
      }
    });
    if (dropped.length) await deleteAttachmentsOf('rfq_supplier', dropped.map((s) => s.id));
    await audit({ entityType: 'rfq', entityId: rfq.id, action: 'UPDATED', summary: `Modified ${rfq.number}` }, req);
    res.json(presentRfq((await loadRfq(rfq.id))!, me));
  }),
);

/** DRAFT → SENT: the papers went out (printed and sent by hand — the owner's call). */
rfqRoutes.post(
  '/:id/send',
  requireAny('gchain.rfq.edit_own', 'gchain.rfq.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const rfq = await prisma.rfq.findUnique({ where: { id: req.params.id }, include: { _count: { select: { suppliers: true, items: true } } } });
    if (!rfq) throw notFound('RFQ not found');
    if (!mayEditRfq(me, rfq)) throw forbidden('This RFQ belongs to someone else');
    if (rfq.status !== 'DRAFT') throw badRequest(`${rfq.number} was already sent`);
    if (!rfq._count.suppliers) throw badRequest('Name at least one supplier to ask');
    if (!rfq._count.items) throw badRequest('Tick at least one line to ask about');
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.rfq.updateMany({ where: { id: rfq.id, status: 'DRAFT' }, data: { status: 'SENT', sentAt: now } });
      if (!claimed.count) throw badRequest(`${rfq.number} changed a moment ago — reload to see it`);
      await tx.rfqSupplier.updateMany({ where: { rfqId: rfq.id, sentAt: null }, data: { sentAt: now } });
    });
    await audit({ entityType: 'rfq', entityId: rfq.id, action: 'UPDATED', summary: `${rfq.number} sent to ${rfq._count.suppliers} supplier(s)` }, req);
    res.json(presentRfq((await loadRfq(rfq.id))!, me));
  }),
);

/**
 * A supplier's quote, recorded as it came in: a price per line asked (a line
 * left out is "not quoted"), and the terms that came with it. The first
 * quote moves the RFQ to QUOTED. The supplier's own paper goes on the row as
 * an attachment (`rfq_supplier`).
 */
rfqRoutes.put(
  '/:id/suppliers/:rowId/quote',
  requireAny('gchain.rfq.edit_own', 'gchain.rfq.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(
      z.object({
        quotes: z.array(z.object({ requestItemId: z.string(), unitPrice: z.number().min(0).max(1e12), remarks: z.string().trim().max(500).optional().nullable() })).max(1000),
        quoteRef: z.string().trim().max(100).optional().nullable(),
        quoteReceivedAt: z.string().regex(DAY, 'Use a date').optional().nullable(),
        leadTimeDays: z.number().int().min(0).max(3650).optional().nullable(),
        terms: z.string().trim().max(1000).optional().nullable(),
        validUntil: z.string().regex(DAY, 'Use a date').optional().nullable(),
        remarks: z.string().trim().max(2000).optional().nullable(),
      }),
      req.body,
    );
    const row = await prisma.rfqSupplier.findFirst({
      where: { id: req.params.rowId, rfqId: req.params.id },
      include: { rfq: { include: { items: true } }, supplier: { select: { name: true } } },
    });
    if (!row) throw notFound('Supplier not on this RFQ');
    if (!mayEditRfq(me, row.rfq)) throw forbidden('This RFQ belongs to someone else');
    if (row.rfq.status === 'DRAFT') throw badRequest(`${row.rfq.number} has not been sent — mark it sent first`);
    if (!OPEN.includes(row.rfq.status)) throw badRequest(`${row.rfq.number} is ${statusLabel(row.rfq.status).toLowerCase()} — its quotes stand as they were`);
    const asked = new Set(row.rfq.items.map((i) => i.requestItemId));
    if (body.quotes.some((qq) => !asked.has(qq.requestItemId))) throw badRequest('A price is for a line this RFQ did not ask about');
    if (new Set(body.quotes.map((qq) => qq.requestItemId)).size !== body.quotes.length) throw badRequest('A line is priced twice');

    await prisma.$transaction(async (tx) => {
      const claimed = await tx.rfq.updateMany({ where: { id: row.rfqId, status: { in: ['SENT', 'QUOTED'] } }, data: { status: 'QUOTED' } });
      if (!claimed.count) throw badRequest(`${row.rfq.number} changed a moment ago — reload to see it`);
      await tx.rfqQuote.deleteMany({ where: { rfqSupplierId: row.id } });
      if (body.quotes.length) {
        await tx.rfqQuote.createMany({
          data: body.quotes.map((qq) => ({ rfqSupplierId: row.id, requestItemId: qq.requestItemId, unitPrice: new Prisma.Decimal(qq.unitPrice), remarks: qq.remarks?.trim() || null })),
        });
      }
      await tx.rfqSupplier.update({
        where: { id: row.id },
        data: {
          quoteRef: body.quoteRef?.trim() || null,
          quoteReceivedAt: asDay(body.quoteReceivedAt) ?? (body.quotes.length ? asDay(new Date().toISOString().slice(0, 10)) : null),
          leadTimeDays: body.leadTimeDays ?? null,
          terms: body.terms?.trim() || null,
          validUntil: asDay(body.validUntil),
          remarks: body.remarks?.trim() || null,
        },
      });
    });
    await audit(
      { entityType: 'rfq', entityId: row.rfqId, action: 'UPDATED', summary: `Recorded ${row.supplier.name}'s quote on ${row.rfq.number} (${body.quotes.length} of ${asked.size} line(s))` },
      req,
    );
    res.json(presentRfq((await loadRfq(row.rfqId))!, me));
  }),
);

/**
 * Removes a supplier's recorded quote (2026-10-19, the owner's call): its
 * prices, its terms and the supplier's paper filed on the row go; the
 * supplier stays asked, and may then be dropped from the RFQ like one who
 * never quoted. Refused while a live canvass compares the RFQ — cancel it
 * first. The last quote gone, the RFQ is SENT again.
 */
rfqRoutes.delete(
  '/:id/suppliers/:rowId/quote',
  requireAny('gchain.rfq.edit_own', 'gchain.rfq.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const reason = typeof req.query.reason === 'string' ? req.query.reason.trim().slice(0, 2000) : '';
    const row = await prisma.rfqSupplier.findFirst({
      where: { id: req.params.rowId, rfqId: req.params.id },
      include: {
        rfq: { include: { canvasses: { where: { status: { not: 'CANCELLED' } }, select: { number: true } } } },
        supplier: { select: { name: true } },
        _count: { select: { quotes: true } },
      },
    });
    if (!row) throw notFound('Supplier not on this RFQ');
    if (!mayEditRfq(me, row.rfq)) throw forbidden('This RFQ belongs to someone else');
    if (!OPEN.includes(row.rfq.status)) throw badRequest(`${row.rfq.number} is ${statusLabel(row.rfq.status).toLowerCase()} — its quotes stand as they were`);
    if (row.rfq.canvasses.length) throw badRequest(`Canvass ${row.rfq.canvasses.map((c) => c.number).join(', ')} compares this RFQ — cancel it first`);
    if (!row._count.quotes && !row.quoteRef && !row.quoteReceivedAt) throw badRequest(`${row.supplier.name} has no quote on file`);

    await prisma.$transaction(async (tx) => {
      const claimed = await tx.rfq.updateMany({ where: { id: row.rfqId, status: row.rfq.status }, data: { updatedAt: new Date() } });
      if (!claimed.count) throw badRequest(`${row.rfq.number} changed a moment ago — reload to see it`);
      await tx.rfqQuote.deleteMany({ where: { rfqSupplierId: row.id } });
      await tx.rfqSupplier.update({
        where: { id: row.id },
        data: { quoteRef: null, quoteReceivedAt: null, leadTimeDays: null, terms: null, validUntil: null, remarks: null },
      });
      const left = await tx.rfqQuote.count({ where: { rfqSupplier: { rfqId: row.rfqId } } });
      if (!left) await tx.rfq.updateMany({ where: { id: row.rfqId, status: 'QUOTED' }, data: { status: 'SENT' } });
    });
    await deleteAttachmentsOf('rfq_supplier', [row.id]);
    await audit(
      {
        entityType: 'rfq',
        entityId: row.rfqId,
        action: 'DELETED',
        summary: `Removed ${row.supplier.name}'s quote from ${row.rfq.number}${reason ? ` — ${reason}` : ''}`,
      },
      req,
    );
    res.json(presentRfq((await loadRfq(row.rfqId))!, me));
  }),
);

/** Cancels an open RFQ, the reason kept. A canvass raised from it is cancelled first. */
rfqRoutes.post(
  '/:id/cancel',
  requireAny('gchain.rfq.edit_own', 'gchain.rfq.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(z.object({ reason: z.string().trim().min(3, 'Say why it is cancelled').max(2000) }), req.body);
    const rfq = await prisma.rfq.findUnique({ where: { id: req.params.id }, include: { canvasses: { where: { status: { not: 'CANCELLED' } }, select: { number: true } } } });
    if (!rfq) throw notFound('RFQ not found');
    if (!mayEditRfq(me, rfq)) throw forbidden('This RFQ belongs to someone else');
    if (!OPEN.includes(rfq.status)) throw badRequest(`${rfq.number} is ${statusLabel(rfq.status).toLowerCase()}`);
    if (rfq.canvasses.length) throw badRequest(`Canvass ${rfq.canvasses.map((c) => c.number).join(', ')} compares this RFQ — cancel it first`);
    const claimed = await prisma.rfq.updateMany({ where: { id: rfq.id, status: rfq.status }, data: { status: 'CANCELLED', cancelReason: body.reason } });
    if (!claimed.count) throw badRequest(`${rfq.number} changed a moment ago — reload to see it`);
    await audit({ entityType: 'rfq', entityId: rfq.id, action: 'CANCELLED', summary: `${rfq.number} cancelled — ${body.reason}` }, req);
    res.json({ ok: true, status: 'CANCELLED' });
  }),
);

/** Deletes a draft or a cancelled RFQ — its preparer or edit_all, with the delete right; its rows and files go with it. */
rfqRoutes.delete(
  '/:id',
  require_('gchain.rfq.delete'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const rfq = await prisma.rfq.findUnique({ where: { id: req.params.id }, include: { suppliers: { select: { id: true } } } });
    if (!rfq) throw notFound('RFQ not found');
    if (!mayEditRfq(me, rfq)) throw forbidden('This RFQ belongs to someone else');
    if (rfq.status !== 'DRAFT' && rfq.status !== 'CANCELLED') throw badRequest('Only a draft or a cancelled RFQ can be deleted — cancel it first');
    await deleteOrRefuse(rfq.number, () => prisma.rfq.delete({ where: { id: rfq.id } }));
    await deleteAttachmentsOf('rfq_supplier', rfq.suppliers.map((s) => s.id));
    await audit({ entityType: 'rfq', entityId: rfq.id, action: 'DELETED', summary: `Deleted ${rfq.number}` }, req);
    res.json({ ok: true });
  }),
);

/**
 * The paper. With `?supplier=<rowId>` it is the enquiry ONE supplier gets —
 * TO that supplier, the lines with blank price, amount and lead-time columns
 * for them to fill; without it, the RFQ whole with every supplier asked and
 * what each quoted. Prepared by with the standard digital timestamp (the
 * record's own: when it was prepared), and Sent once it went out — the
 * people who acted, never a slot nobody fills (rule 6).
 */
rfqRoutes.get(
  '/:id/pdf',
  requireAny('gchain.rfq.view_all', 'gchain.rfq.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const rfq = await loadRfq(req.params.id);
    if (!rfq) throw notFound('RFQ not found');
    await assertVisible(me, rfq);
    const view = presentRfq(rfq, me);
    const currency = await companyCurrency();
    const rowId = typeof req.query.supplier === 'string' ? req.query.supplier : '';
    const row = rowId ? view.suppliers.find((s) => s.id === rowId) : undefined;
    if (rowId && !row) throw notFound('Supplier not on this RFQ');

    const reference = [`PR ${rfq.request.number}`, rfq.request.job ? `${rfq.request.job.number} — ${rfq.request.job.name}` : rfq.request.purpose].join(' · ');
    const sections: PdfSection[] = [];
    if (row) {
      const s = row.supplier;
      sections.push({
        kind: 'fields',
        columns: 2,
        fields: [
          { label: 'To', value: s.name },
          { label: 'Quote by', value: rfq.dueDate ? formatDate(rfq.dueDate) : '—' },
          { label: 'Attention', value: row.contactName ?? '—' },
          { label: 'Deliver to', value: rfq.deliverTo ?? '—' },
          { label: 'Tel No.', value: row.contactPhone ?? s.phone ?? '—' },
          { label: 'Purchase request', value: rfq.request.number },
          { label: 'Email', value: row.email ?? s.email ?? '—' },
          { label: 'Sent', value: row.sentAt ? formatDate(row.sentAt) : 'Not yet sent' },
          { label: 'Address', value: [s.address, s.city].filter(Boolean).join(', ') || '—' },
        ],
      });
      sections.push({
        kind: 'table',
        title: 'Please quote',
        head: ['No.', 'Part No.', 'Description', 'Unit', 'Qty', `Unit price (${currency})`, `Amount (${currency})`, 'Lead time'],
        align: ['right', 'left', 'left', 'left', 'right', 'right', 'right', 'left'],
        widths: [36, 66, 190, 44, 40, 70, 74, 56],
        rows: view.lines.map((l, n) => [
          String(n + 1),
          l.partNumber ?? '',
          l.name && l.description !== l.name ? { title: l.name, body: l.description } : (l.name ?? l.description),
          l.unit,
          formatQuantity(l.quantity),
          '',
          '',
          '',
        ]),
      });
    } else {
      sections.push({
        kind: 'fields',
        columns: 2,
        fields: [
          { label: 'Purchase request', value: rfq.request.number },
          { label: 'Quote by', value: rfq.dueDate ? formatDate(rfq.dueDate) : '—' },
          { label: 'For', value: rfq.request.job ? `${rfq.request.job.number} — ${rfq.request.job.name}` : (rfq.request.warehouse?.name ?? 'Stock') },
          { label: 'Deliver to', value: rfq.deliverTo ?? '—' },
          { label: 'Status', value: statusLabel(rfq.status) },
          { label: 'Sent', value: rfq.sentAt ? formatDate(rfq.sentAt) : 'Not yet sent' },
          { label: 'Suppliers asked', value: String(view.suppliers.length) },
        ],
      });
      sections.push({
        kind: 'table',
        title: 'Lines asked',
        head: ['No.', 'Part No.', 'Description', 'Unit', 'Qty'],
        align: ['right', 'left', 'left', 'left', 'right'],
        rows: view.lines.map((l, n) => [
          String(n + 1),
          l.partNumber ?? '',
          l.name && l.description !== l.name ? { title: l.name, body: l.description } : (l.name ?? l.description),
          l.unit,
          formatQuantity(l.quantity),
        ]),
      });
      sections.push({
        kind: 'table',
        title: 'Suppliers asked',
        head: ['Supplier', 'Contact', 'Sent', 'Quote', `Total (${currency})`, 'Lead time'],
        align: ['left', 'left', 'left', 'left', 'right', 'left'],
        rows: view.suppliers.map((s) => [
          s.supplier.name,
          { title: s.contactName ?? '', body: [s.contactPhone, s.email].filter(Boolean).join(' · ') },
          s.sentAt ? formatShortDate(s.sentAt) : 'Not sent',
          s.quotedCount ? `${s.quotedCount} of ${view.lines.length} line(s)${s.quoteRef ? ` · ${s.quoteRef}` : ''}` : 'No quote yet',
          s.quotedCount ? formatAmount(s.total) : '',
          s.leadTimeDays != null ? `${s.leadTimeDays} day(s)` : '',
        ]),
      });
    }
    const terms = rfq.terms ?? 'Please quote your best price per unit, whether prices include VAT, your payment terms, how long the quote is valid and the delivery lead time.';
    sections.push({ kind: 'text', title: 'Terms of the quotation', body: terms });
    if (rfq.notes && !row) sections.push({ kind: 'text', title: 'Notes', body: rfq.notes });

    // Prepared by, with the standard digital timestamp: the person who acted
    // and when (rule 6) — an enquiry decides nothing, so nobody else signs.
    const signatories: Signatory[] = [
      { role: 'Prepared by', name: rfq.preparedBy.name, ...(await contactOf(rfq.preparedById)), at: rfq.createdAt },
    ];

    const pdf = await renderDocument({
      title: 'Request for Quotation',
      documentNumber: rfq.number,
      date: rfq.createdAt,
      reference: row ? `${reference} · to ${row.supplier.name}` : reference,
      sections,
      signatories,
    });
    await audit(
      { entityType: 'rfq', entityId: rfq.id, action: 'EXPORTED', summary: `Printed ${rfq.number}${row ? ` for ${row.supplier.name}` : ''}` },
      req,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      contentDisposition(paperFileName({ kind: row ? `RFQ ${row.supplier.name}` : 'RFQ', number: rfq.number, author: rfq.preparedBy.name, date: rfq.createdAt })),
    );
    res.send(pdf);
  }),
);

// A supplier's quotation file lives on its row: read as the RFQ is read,
// written by whoever may edit the RFQ while it is open.
registerAttachmentGuard(
  'rfq_supplier',
  async (user, entityId) => {
    const row = await prisma.rfqSupplier.findUnique({ where: { id: entityId }, select: { rfq: { select: { preparedById: true } } } });
    if (!row) return false;
    return can(user, 'gchain.rfq.view_all') || (can(user, 'gchain.rfq.view_own') && visibleOwners(user, 'gchain', 'rfq').includes(row.rfq.preparedById));
  },
  {
    write: async (user, entityId) => {
      const row = await prisma.rfqSupplier.findUnique({ where: { id: entityId }, select: { rfq: { select: { preparedById: true, status: true } } } });
      return !!row && OPEN.includes(row.rfq.status) && mayEditRfq(user, row.rfq);
    },
  },
);

registerSearch({
  kind: 'rfq',
  label: 'RFQs',
  permission: ['gchain.rfq.view_all', 'gchain.rfq.view_own'],
  ownWhere: (user) => ({ preparedById: user.id }),
  async search(term, user, limit) {
    const rows = await prisma.rfq.findMany({
      where: {
        ...(can(user, 'gchain.rfq.view_all') ? {} : { preparedById: { in: visibleOwners(user, 'gchain', 'rfq') } }),
        OR: [
          { number: { contains: term, mode: 'insensitive' } },
          { request: { number: { contains: term, mode: 'insensitive' } } },
          { request: { purpose: { contains: term, mode: 'insensitive' } } },
        ],
      },
      select: { id: true, number: true, status: true, request: { select: { number: true, purpose: true } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map((r) => ({
      kind: 'rfq',
      id: r.id,
      title: `${r.number} — ${r.request.purpose}`,
      subtitle: `${r.request.number} · ${statusLabel(r.status)}`,
      link: `/g-chain/rfq/${r.id}`,
    }));
  },
});
