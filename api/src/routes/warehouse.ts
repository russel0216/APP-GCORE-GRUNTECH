import { Router } from 'express';
import { z } from 'zod';
import { Prisma, IssueStatus, BorrowStatus, BorrowType, ReturnCondition, ReceivingStatus } from '@prisma/client';
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
import { authenticate, require_, requireAny, requireAnyOrDecider, currentUser } from '../auth/middleware';
import { can, type ResolvedUser } from '../permissions/resolve';
import { requireView, requireEdit, ownOnly, viewScope, assertCanView, assertCanEdit, mayEdit } from '../shared/ownScope';
import { audit } from '../shared/audit';
import { registerSearch } from '../shared/search';
import { stockOnHand, availableOf, belowReorder, REORDER_CANDIDATES, stockState, itemsOnOrder, STOCK_STATES, type StockState } from '../shared/chain';
import { nextNumber } from '../shared/numbering';
import { issueProjectStock, projectHoldings, receiveProjectStock } from '../shared/projectStock';
import { itemForTypedLine } from '../shared/typedItems';
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
  usersInRole,
  onApprovalReopened,
  type ApprovalOutcome,
} from '../shared/approvals';
import { registerAttachmentGuard, deleteAttachmentsOf } from '../shared/attachments';
import { attachedFiles, withAttachments } from '../shared/pdfAttachments';
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
import { LIST_CAP, listReference, totalLabel, bracketed, counted, bracketNote, listNotes, recordNamed, choice, sendListPdf } from '../shared/listPaper';
import {
  receiveStock,
  issueStock,
  borrowStock,
  returnBorrowedStock,
  postJobCost,
  releaseCommitment,
  reverseReceipt,
  returnIssuedStock,
  reverseJobCost,
} from '../shared/inventory';
import { contentDisposition, paperFileName } from '../shared/paperName';

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

/**
 * Today, for a DATE column: Manila's date. A bare `new Date()` written into,
 * or compared with, a DATE column is the UTC date — yesterday's until 08:00,
 * which is when crews collect their materials and tools.
 */
const today = () => manilaDate(new Date());

// ── The printed lists ────────────────────────────────────────────────────────
//
// Every register here has a printed twin, `GET <list>/pdf` above `/:id`: the
// SAME where-builder the list reads (with `?ids=`, the rows ticked), the
// list's own sort, at most LIST_CAP rows, a reference naming every filter
// that narrowed it, and an EXPORTED audit row with entityId 'list' (rule 6).
// The helpers are shared/listPaper.

/** A quantity as a list prints it: grouped, to its own three decimals at most. */
const qty = (v: number) => new Intl.NumberFormat('en-PH', { maximumFractionDigits: 3 }).format(v);

// ════════════════════════════════════════════════════════════════════
//  RECEIVING
// ════════════════════════════════════════════════════════════════════

export const receivingRoutes = Router();
receivingRoutes.use(authenticate);

/*
 * INCOMING goes for approval. Saving a report writes a DRAFT that moves
 * nothing; "Submit for approval" files it in the receiver's name through the
 * seeded "Incoming — back support, purchasing manager" route (2026-10-14,
 * the owner's call: WAREHOUSE — creator › back support › purchasing
 * manager); the approval posts it (`postReceiving`, through
 * `settleReceiving`). With the route deactivated a save posts at once.
 *
 * A report receives AGAINST AN ISSUED PURCHASE ORDER — its lines are the
 * order's, at the order's price, a pending report holding its quantities —
 * or WITHOUT ONE (the owner's call: "possible receive without a purchase
 * order, approve it too"): a return, a free replacement, a customer-supplied
 * item. Such a report names where the goods came from (a supplier on file,
 * else a name) and why there is no order, goes into a warehouse, and each
 * line names an item from the item master with the unit cost it is taken
 * into stock at. It builds stock and charges no project and no supplier.
 */

const RECEIVING_SORTS = ['number', 'receivedDate'];
const RECEIVING_DOC = 'receiving';
const RECEIVING_VIEW = 'gchain.receiving.view_all';
/** View Own on Incoming (2026-10-18): the reports one received. */
const RECEIVING_VIEW_OWN = 'gchain.receiving.view_own';
/** The Incoming page's helpers: whoever may write a report — create, or either key of the edit pair (2026-10-18). */
const RECEIVING_FORM = ['gchain.receiving.create', 'gchain.receiving.edit_own', 'gchain.receiving.edit_all'] as const;

/** Where a report's goods came from: the order's supplier, else the one named on it. */
function receivedFrom(r: { order: { supplier: { name: string } } | null; supplier?: { name: string } | null; sourceName?: string | null }) {
  return r.order?.supplier.name ?? r.supplier?.name ?? r.sourceName ?? '—';
}

/**
 * Which receivings a list query means — one rule for the list, its cards and
 * its printed twin. A View Own holder reads the reports they received
 * (2026-10-18, `ownOnly`).
 */
function receivingListWhere(me: ResolvedUser, q: ListQuery): Prisma.ReceivingWhereInput {
  return ownOnly(me, 'gchain', 'receiving', receivingListWhereAll(q), { receivedById: me.id });
}

function receivingListWhereAll(q: ListQuery): Prisma.ReceivingWhereInput {
  const and: Prisma.ReceivingWhereInput[] = [];
  const status = choice(q.filters.status, ReceivingStatus, 'Status');
  if (status) and.push({ status });
  if (q.filters.orderId) and.push({ orderId: q.filters.orderId });
  const against = choice(q.filters.against, { order: 'order', none: 'none' }, 'Against');
  if (against === 'order') and.push({ orderId: { not: null } });
  if (against === 'none') and.push({ orderId: null });
  if (q.filters.warehouseId) and.push({ warehouseId: q.filters.warehouseId });
  // A receiving has no job of its own — it inherits its order's. The job
  // workspace's Procurement tab lists a project's deliveries through this.
  if (q.filters.jobId) and.push({ order: { jobId: q.filters.jobId } });
  if (q.search) {
    and.push({
      OR: [
        { number: { contains: q.search, mode: 'insensitive' } },
        { deliveryRefNo: { contains: q.search, mode: 'insensitive' } },
        { sourceName: { contains: q.search, mode: 'insensitive' } },
        { items: { some: { partNumber: { contains: q.search, mode: 'insensitive' } } } },
        { supplier: { name: { contains: q.search, mode: 'insensitive' } } },
        { order: { number: { contains: q.search, mode: 'insensitive' } } },
        { order: { supplier: { name: { contains: q.search, mode: 'insensitive' } } } },
      ],
    });
  }
  const ids = idsFilter(q.filters.ids);
  if (ids) and.push({ id: { in: ids } });
  return and.length ? { AND: and } : {};
}

const LIST_INCLUDE = {
  order: {
    select: {
      id: true,
      number: true,
      kind: true,
      supplier: { select: { id: true, name: true } },
      job: { select: { id: true, number: true, name: true } },
    },
  },
  supplier: { select: { id: true, name: true } },
  warehouse: { select: { id: true, name: true } },
  receivedBy: { select: { id: true, name: true } },
  items: { select: { quantity: true, unitCost: true } },
} satisfies Prisma.ReceivingInclude;

receivingRoutes.get(
  '/',
  requireView('gchain', 'receiving'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const where = receivingListWhere(currentUser(req), q);

    const [rows, total, received, waiting, drafts, withoutOrder] = await Promise.all([
      prisma.receiving.findMany({
        where,
        include: LIST_INCLUDE,
        orderBy: orderBy(q, RECEIVING_SORTS, { receivedDate: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.receiving.count({ where }),
      prisma.receivingItem.findMany({ where: { receiving: { AND: [where, { status: 'RECEIVED' }] } }, select: { quantity: true, unitCost: true } }),
      prisma.receiving.count({ where: { AND: [where, { status: 'PENDING_APPROVAL' }] } }),
      prisma.receiving.count({ where: { AND: [where, { status: 'DRAFT' }] } }),
      prisma.receiving.count({ where: { AND: [where, { orderId: null }] } }),
    ]);

    res.json({
      ...listResult(
        rows.map((r) => ({
          id: r.id,
          number: r.number,
          status: r.status,
          receivedDate: r.receivedDate,
          deliveryRefNo: r.deliveryRefNo,
          order: r.order,
          from: receivedFrom(r),
          reason: r.reason,
          warehouse: r.warehouse,
          receivedBy: r.receivedBy,
          lineCount: r.items.length,
          value: cents(r.items.reduce((s, i) => s + num(i.quantity) * num(i.unitCost), 0)),
        })),
        total,
        q,
      ),
      // The cards over the list, under the list's own query.
      summary: {
        count: total,
        receivedValue: cents(received.reduce((s, i) => s + num(i.quantity) * num(i.unitCost), 0)),
        waiting,
        drafts,
        withoutOrder,
      },
    });
  }),
);

/**
 * What the Incoming page offers: the warehouses, and the issued orders that
 * still have something to receive (newest first, a search narrowing them).
 * Behind the create right, so the warehouse need hold no purchasing right.
 */
receivingRoutes.get(
  '/options',
  requireAny(...RECEIVING_FORM),
  handler(async (req, res) => {
    const term = String(req.query.q ?? '').trim();
    const [warehouses, orders] = await Promise.all([
      prisma.warehouse.findMany({ where: { isActive: true }, orderBy: { name: 'asc' }, select: { id: true, code: true, name: true } }),
      prisma.purchaseOrder.findMany({
        where: {
          status: { in: ['ISSUED', 'PARTIALLY_RECEIVED'] },
          ...(term
            ? {
                OR: [
                  { number: { contains: term, mode: 'insensitive' } },
                  { supplier: { name: { contains: term, mode: 'insensitive' } } },
                  { job: { number: { contains: term, mode: 'insensitive' } } },
                ],
              }
            : {}),
        },
        orderBy: { orderDate: 'desc' },
        take: 50,
        select: {
          id: true,
          number: true,
          status: true,
          orderDate: true,
          supplier: { select: { name: true } },
          job: { select: { number: true, name: true } },
        },
      }),
    ]);
    res.json({ warehouses, orders });
  }),
);

/** The route a report of this value would take, in the caller's name — the Incoming page's "Submit for approval sends it to …". */
receivingRoutes.get(
  '/route',
  requireAny(...RECEIVING_FORM),
  handler(async (req, res) => {
    const me = currentUser(req);
    const amount = Number(req.query.amount ?? 0) || 0;
    // Goods of an importation order (no VAT) go to the Purchasing Manager (Importation).
    const importation = String(req.query.importation ?? '') === '1';
    const route = (await pickWorkflow(RECEIVING_DOC, amount, { requesterId: me.id })) ? await routeBrief(RECEIVING_DOC, amount, me.id, null, { importation }) : null;
    res.json({ route });
  }),
);

/** An item from the item master, for a line received without an order (behind the create right). */
receivingRoutes.get(
  '/items',
  requireAny(...RECEIVING_FORM),
  handler(async (req, res) => {
    const term = String(req.query.q ?? '').trim();
    const items = await prisma.item.findMany({
      where: {
        isActive: true,
        ...(term
          ? {
              OR: [
                { code: { contains: term, mode: 'insensitive' } },
                { name: { contains: term, mode: 'insensitive' } },
                { partNumber: { contains: term, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { name: 'asc' },
      take: 20,
      select: { id: true, code: true, name: true, partNumber: true, unit: true, standardCost: true },
    });
    res.json(items.map((i) => ({ ...i, standardCost: num(i.standardCost) })));
  }),
);

/**
 * An order's lines as a report receives them: ordered, received, held by
 * other reports pending approval, and what is left — the figures
 * `checkOutstanding` refuses against.
 */
receivingRoutes.get(
  '/order/:orderId',
  requireAny(...RECEIVING_FORM),
  handler(async (req, res) => {
    const order = await prisma.purchaseOrder.findUnique({
      where: { id: req.params.orderId },
      include: {
        supplier: { select: { id: true, name: true } },
        job: { select: { id: true, number: true, name: true } },
        warehouse: { select: { id: true, name: true } },
        items: { include: { item: { select: { id: true, code: true } } }, orderBy: { id: 'asc' } },
      },
    });
    if (!order) throw notFound('Purchase order not found');
    const exceptId = req.query.except ? String(req.query.except) : undefined;
    const held = await prisma.receivingItem.groupBy({
      by: ['orderItemId'],
      where: {
        orderItemId: { in: order.items.map((i) => i.id) },
        receiving: { status: 'PENDING_APPROVAL', ...(exceptId ? { id: { not: exceptId } } : {}) },
      },
      _sum: { quantity: true },
    });
    const pending = new Map(held.map((h) => [h.orderItemId, num(h._sum.quantity)]));
    res.json({
      id: order.id,
      number: order.number,
      status: order.status,
      kind: order.kind,
      supplier: order.supplier,
      job: order.job,
      warehouse: order.warehouse,
      receivable: order.status === 'ISSUED' || order.status === 'PARTIALLY_RECEIVED',
      // An importation order (no VAT): its goods go to the Purchasing Manager (Importation).
      importation: num(order.vatRate) === 0,
      lines: order.items.map((i) => {
        const waiting = pending.get(i.id) ?? 0;
        return {
          id: i.id,
          code: i.item?.code ?? null,
          partNumber: i.partNumber,
          name: i.name,
          description: i.description,
          unit: i.unit,
          quantity: num(i.quantity),
          receivedQty: num(i.receivedQty),
          pendingQty: waiting,
          left: Math.max(0, Math.round((num(i.quantity) - num(i.receivedQty) - waiting) * 1000) / 1000),
          unitPrice: num(i.unitPrice),
        };
      }),
    });
  }),
);

/**
 * The receiving list on paper, through `receivingListWhere` (or the rows
 * ticked, `?ids=`). A report not received yet (a draft, one pending
 * approval, a cancelled one) moved nothing: its value prints in brackets and
 * is not summed. Above `/:id`.
 */
receivingRoutes.get(
  '/pdf',
  requireView('gchain', 'receiving'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const where = receivingListWhere(currentUser(req), q);
    const f = q.filters;
    const [rows, count, lines, notYet, currency, project, order] = await Promise.all([
      prisma.receiving.findMany({
        where,
        include: LIST_INCLUDE,
        orderBy: orderBy(q, RECEIVING_SORTS, { receivedDate: 'desc' }),
        take: LIST_CAP,
      }),
      prisma.receiving.count({ where }),
      prisma.receivingItem.findMany({ where: { receiving: { AND: [where, { status: 'RECEIVED' }] } }, select: { quantity: true, unitCost: true } }),
      prisma.receiving.count({ where: { AND: [where, { status: { not: 'RECEIVED' } }] } }),
      companyCurrency(),
      recordNamed('project', f.jobId),
      f.orderId ? prisma.purchaseOrder.findUnique({ where: { id: f.orderId }, select: { number: true } }) : null,
    ]);
    const reference = listReference(count, rows.length, ['incoming report', 'incoming reports'], [
      q.search && `search "${q.search}"`,
      f.status && `status ${statusLabel(f.status)}`,
      f.against && (f.against === 'none' ? 'without a purchase order' : 'against a purchase order'),
      f.orderId && `order ${order?.number ?? 'not found'}`,
      project,
      f.ids && 'the rows selected',
    ]);
    const valueOf = (items: { quantity: Prisma.Decimal; unitCost: Prisma.Decimal }[]) =>
      items.reduce((s, i) => s.add(i.quantity.mul(i.unitCost)), new Prisma.Decimal(0));

    const pdf = await renderDocument({
      title: 'Incoming Reports',
      date: new Date(),
      reference,
      landscape: true,
      sections: [
        {
          kind: 'table',
          head: ['Number', 'From', 'Against', 'For', 'Into', 'Received', 'Lines', `Value (${currency})`, 'Received by', 'DR no.', 'Status'],
          align: ['left', 'left', 'left', 'left', 'left', 'left', 'right', 'right', 'left', 'left', 'left'],
          rows: rows.map((r) => [
            r.number,
            receivedFrom(r),
            r.order?.number ?? 'No purchase order',
            r.order?.job?.number ?? 'Stock',
            r.warehouse?.name ?? 'Site',
            formatShortDate(r.receivedDate),
            String(r.items.length),
            bracketed(formatAmount(valueOf(r.items).toFixed(2)), r.status === 'RECEIVED'),
            r.receivedBy.name,
            r.deliveryRefNo ?? '',
            statusLabel(r.status),
          ]),
        },
        {
          kind: 'totals',
          rows: [{ label: totalLabel('Total received', count, rows.length), value: formatMoney(valueOf(lines).toFixed(2), currency), bold: true }],
        },
        ...listNotes([bracketNote(notYet, ['report not received yet (a draft, pending or cancelled)', 'reports not received yet (drafts, pending or cancelled)'])]),
      ],
    });
    await audit(
      { entityType: 'receiving', entityId: 'list', action: 'EXPORTED', summary: `Exported the incoming list as PDF (${rows.length} report(s))` },
      req,
    );
    sendListPdf(res, pdf, 'incoming.pdf');
  }),
);

async function loadReceiving(id: string) {
  return prisma.receiving.findUnique({
    where: { id },
    include: {
      order: {
        include: {
          supplier: { select: { id: true, name: true } },
          job: { select: { id: true, number: true, name: true } },
        },
      },
      supplier: { select: { id: true, name: true } },
      warehouse: { select: { id: true, name: true } },
      receivedBy: { select: { id: true, name: true } },
      // The bill that covers these goods. Its presence is what stops the
      // bill posting job cost a second time (Phase 7), so it is worth seeing.
      bills: {
        orderBy: { billDate: 'desc' },
        select: { id: true, number: true, status: true },
      },
      items: {
        include: {
          orderItem: {
            include: {
              item: { select: { id: true, code: true, name: true } },
              costCategory: { select: { id: true, name: true } },
            },
          },
          item: { select: { id: true, code: true, name: true, partNumber: true, unit: true } },
          location: { select: { id: true, code: true } },
        },
        orderBy: { id: 'asc' },
      },
    },
  });
}

type LoadedReceiving = NonNullable<Awaited<ReturnType<typeof loadReceiving>>>;

const receivingValue = (items: { quantity: Prisma.Decimal; unitCost: Prisma.Decimal }[]) =>
  cents(items.reduce((s, i) => s + num(i.quantity) * num(i.unitCost), 0));

/** A received line as every reader shows it, whichever way it was received. */
function lineFacts(i: LoadedReceiving['items'][number]) {
  if (i.orderItem) {
    return {
      code: i.orderItem.item?.code ?? i.orderItem.partNumber ?? null,
      partNumber: i.orderItem.partNumber ?? null,
      name: i.orderItem.name,
      description: i.orderItem.description,
      unit: i.orderItem.unit,
    };
  }
  return {
    code: i.item?.code ?? null,
    partNumber: i.partNumber ?? null,
    name: i.item?.name ?? null,
    description: i.description ?? i.item?.name ?? '',
    unit: i.unit ?? i.item?.unit ?? '',
  };
}

/** Goods of an importation order (no VAT, 2026-10-16) — the Purchasing Manager (Importation) signs them (the owner's chart of 2026-10-17). */
const isImportation = (r: { order: { vatRate: Prisma.Decimal } | null }) => !!r.order && num(r.order.vatRate) === 0;

/** Who may move a report on — submit, modify, pull back, cancel: whoever received it, or edit_all. */
function mayHandleReceiving(me: ResolvedUser, r: { receivedById: string }) {
  return r.receivedById === me.id || can(me, 'gchain.receiving.edit_all');
}

async function presentReceiving(receiving: LoadedReceiving, me: ResolvedUser) {
  const seesBills = can(me, 'gfin.ap.view_all');
  const value = receivingValue(receiving.items);
  const draft = receiving.status === 'DRAFT';
  const handler_ = mayHandleReceiving(me, receiving);
  const route = draft ? await pickWorkflow(RECEIVING_DOC, value, { requesterId: receiving.receivedById }) : null;
  return {
    ...receiving,
    from: receivedFrom(receiving),
    bills: seesBills ? receiving.bills : [],
    billsVisible: seesBills,
    // Its references only (PATCH /:id) once it is past a draft — Edit All,
    // or Edit Own on a report one received (2026-10-18).
    canEdit: mayEdit(me, 'gchain', 'receiving', receiving.receivedById === me.id),
    // A draft is modified whole on its page (PUT /:id/sheet).
    canModify: draft && handler_ && can(me, 'gchain.receiving.create'),
    canSubmit: draft && handler_ && can(me, 'gchain.receiving.create'),
    needsApproval: draft ? !!route : null,
    canWithdraw: receiving.status === 'PENDING_APPROVAL' && handler_,
    canCancel: (draft || receiving.status === 'PENDING_APPROVAL') && handler_,
    // A draft or a cancelled report posted nothing (2026-10-19): its handler deletes it.
    canDelete: (draft || receiving.status === 'CANCELLED') && handler_ && can(me, 'gchain.receiving.delete'),
    approvalRoute: draft && route ? await routeBrief(RECEIVING_DOC, value, receiving.receivedById, null, { importation: isImportation(receiving) }) : null,
    order: receiving.order ? { ...receiving.order, total: num(receiving.order.total) } : null,
    items: receiving.items.map((i) => ({
      id: i.id,
      orderItemId: i.orderItemId,
      itemId: i.itemId,
      ...lineFacts(i),
      locationId: i.locationId,
      location: i.location,
      serialNo: i.serialNo,
      batchNo: i.batchNo,
      remarks: i.remarks,
      quantity: num(i.quantity),
      unitCost: num(i.unitCost),
      amount: cents(num(i.quantity) * num(i.unitCost)),
      orderItem: i.orderItem
        ? {
            ...i.orderItem,
            quantity: num(i.orderItem.quantity),
            unitPrice: num(i.orderItem.unitPrice),
            receivedQty: num(i.orderItem.receivedQty),
          }
        : null,
    })),
    value,
  };
}

/**
 * The report as its reader may see it: the register's right, or — through
 * `requireAnyOrDecider` — whoever may decide its open request, only while it
 * waits on them.
 */
async function visibleReceiving(me: ResolvedUser, id: string, deciderOnly: boolean) {
  const receiving = await loadReceiving(id);
  if (!receiving) throw notFound('Receiving report not found');
  if (deciderOnly && !(await mayDecide(me.id, RECEIVING_DOC, [receiving.id]))) throw notFound('Receiving report not found');
  // View Own reads the reports one received — and one waiting on one's decision (2026-10-18).
  if (!deciderOnly && viewScope(me, 'gchain', 'receiving') === 'own' && receiving.receivedById !== me.id) {
    if (!(await mayDecide(me.id, RECEIVING_DOC, [receiving.id]))) throw notFound('Receiving report not found');
  }
  return receiving;
}

receivingRoutes.get(
  '/:id',
  requireAnyOrDecider(RECEIVING_VIEW, RECEIVING_VIEW_OWN),
  handler(async (req, res) => {
    const me = currentUser(req);
    const receiving = await visibleReceiving(me, req.params.id, res.locals.deciderOnly === true);
    res.json(await presentReceiving(receiving, me));
  }),
);

/**
 * A report's paper references change at any time — the delivery receipt and
 * supplier invoice numbers, and the notes. What arrived is the record once it
 * is past a draft (a draft is modified whole on its page). A key it cannot
 * change is refused, not ignored.
 */
receivingRoutes.patch(
  '/:id',
  requireEdit('gchain', 'receiving'),
  handler(async (req, res) => {
    const body = parseBody(
      z
        .object({
          deliveryRefNo: z.string().trim().optional().nullable(),
          invoiceRefNo: z.string().trim().optional().nullable(),
          notes: z.string().optional().nullable(),
        })
        .strict(),
      req.body,
    );
    const existing = await prisma.receiving.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('Receiving report not found');
    assertCanEdit(currentUser(req), 'gchain', 'receiving', existing.receivedById === currentUser(req).id);

    const next = {
      deliveryRefNo: body.deliveryRefNo !== undefined ? body.deliveryRefNo || null : existing.deliveryRefNo,
      invoiceRefNo: body.invoiceRefNo !== undefined ? body.invoiceRefNo || null : existing.invoiceRefNo,
      notes: body.notes !== undefined ? body.notes?.trim() || null : existing.notes,
    };
    const changed = [
      next.deliveryRefNo !== existing.deliveryRefNo && `DR no. ${existing.deliveryRefNo ?? '—'} → ${next.deliveryRefNo ?? '—'}`,
      next.invoiceRefNo !== existing.invoiceRefNo && `invoice no. ${existing.invoiceRefNo ?? '—'} → ${next.invoiceRefNo ?? '—'}`,
      next.notes !== existing.notes && 'notes',
    ].filter(Boolean);

    await prisma.receiving.update({ where: { id: existing.id }, data: next });
    await audit(
      {
        entityType: 'receiving',
        entityId: existing.id,
        action: 'UPDATED',
        summary: `Modified ${existing.number}${changed.length ? `: ${changed.join(', ')}` : ''}`,
        before: { deliveryRefNo: existing.deliveryRefNo, invoiceRefNo: existing.invoiceRefNo, notes: existing.notes },
        after: next,
      },
      req,
    );
    res.json(await presentReceiving((await loadReceiving(existing.id))!, currentUser(req)));
  }),
);

/**
 * One report, as the Incoming page saves it. Against an order (`orderId`):
 * each line names an order line (`orderItemId`), at the order's price unless
 * a cost is typed. Without one: `supplierId` or `sourceName`, a `reason`, a
 * warehouse, and each line an item (`itemId`) with its unit cost.
 *
 * This is the moment the two purchase kinds diverge (model §4.3):
 *   DIRECT_TO_JOB        releases the commitment and charges the job (INCURRED)
 *   STOCK_REPLENISHMENT  adds to inventory; the job is charged later, at issue
 */
const receivingSchema = z.object({
  orderId: z.string().min(1).optional().nullable(),
  supplierId: z.string().optional().nullable(),
  sourceName: z.string().trim().max(200).optional().nullable(),
  reason: z.string().trim().max(2000).optional().nullable(),
  warehouseId: z.string().optional().nullable(),
  receivedDate: z.string().optional().nullable(),
  deliveryRefNo: z.string().trim().optional().nullable(),
  invoiceRefNo: z.string().trim().optional().nullable(),
  notes: z.string().optional().nullable(),
  version: z.string().optional(),
  items: z
    .array(
      z.object({
        orderItemId: z.string().optional().nullable(),
        itemId: z.string().optional().nullable(),
        partNumber: z.string().trim().max(120).optional().nullable(),
        description: z.string().trim().max(2000).optional().nullable(),
        unit: z.string().trim().max(40).optional().nullable(),
        quantity: z.number().positive(),
        unitCost: z.number().min(0).optional(),
        locationId: z.string().optional().nullable(),
        serialNo: z.string().trim().optional().nullable(),
        batchNo: z.string().trim().optional().nullable(),
        remarks: z.string().optional().nullable(),
      }),
    )
    .min(1, 'Receive at least one line'),
});
type ReceivingBody = z.infer<typeof receivingSchema>;

/**
 * What a report may still receive of each order line: ordered less received
 * less what OTHER reports pending approval hold. Over-delivery is refused
 * outright: receiving more than was ordered means either the delivery or the
 * order is wrong.
 */
async function checkOutstanding(
  db: Prisma.TransactionClient | typeof prisma,
  orderItems: { id: string; description: string; quantity: Prisma.Decimal; receivedQty: Prisma.Decimal }[],
  lines: { orderItemId?: string | null; quantity: number }[],
  exceptReceivingId?: string,
) {
  const held = await db.receivingItem.groupBy({
    by: ['orderItemId'],
    where: {
      orderItemId: { in: orderItems.map((i) => i.id) },
      receiving: { status: 'PENDING_APPROVAL', ...(exceptReceivingId ? { id: { not: exceptReceivingId } } : {}) },
    },
    _sum: { quantity: true },
  });
  const pending = new Map(held.map((h) => [h.orderItemId, num(h._sum.quantity)]));
  const byOrderItem = new Map(orderItems.map((i) => [i.id, i]));
  for (const line of lines) {
    const orderItem = line.orderItemId ? byOrderItem.get(line.orderItemId) : undefined;
    if (!orderItem) throw badRequest('One of the lines is not on that order');
    const waiting = pending.get(orderItem.id) ?? 0;
    const outstanding = num(orderItem.quantity) - num(orderItem.receivedQty) - waiting;
    if (line.quantity > outstanding + 0.0005) {
      throw badRequest(
        `${orderItem.description}: ${qty(Math.max(0, outstanding))} outstanding on the order` +
          `${waiting ? ` (${qty(waiting)} more on a report pending approval)` : ''}, ${qty(line.quantity)} being received. ` +
          'Amend the order if the delivery is genuinely larger.',
      );
    }
  }
}

/**
 * Checks a report as the page sends it, before anything is written or a
 * number issued, and returns the rows to write. One rule for the create and
 * the modify.
 */
async function checkReceivingSheet(body: ReceivingBody, exceptReceivingId?: string) {
  const warehouseId = body.warehouseId || null;
  if (warehouseId && !(await prisma.warehouse.findFirst({ where: { id: warehouseId }, select: { id: true } }))) {
    throw badRequest('That warehouse is not on file');
  }
  const misc = {
    warehouseId,
    receivedDate: asDate(body.receivedDate) ?? today(),
    deliveryRefNo: body.deliveryRefNo || null,
    invoiceRefNo: body.invoiceRefNo || null,
    notes: body.notes?.trim() || null,
  };
  const extras = (l: ReceivingBody['items'][number]) => ({
    locationId: l.locationId || null,
    serialNo: l.serialNo || null,
    batchNo: l.batchNo || null,
    remarks: l.remarks || null,
  });

  if (body.orderId) {
    const order = await prisma.purchaseOrder.findUnique({ where: { id: body.orderId }, include: { items: true } });
    if (!order) throw notFound('Purchase order not found');
    if (order.status === 'DRAFT' || order.status === 'PENDING_APPROVAL') throw badRequest(`${order.number} has not been issued yet`);
    if (order.status === 'CANCELLED') throw badRequest(`${order.number} was cancelled`);
    if (order.status === 'RECEIVED') throw badRequest(`${order.number} has been received in full`);
    await checkOutstanding(prisma, order.items, body.items, exceptReceivingId);
    const byOrderItem = new Map(order.items.map((i) => [i.id, i]));
    const rows = body.items.map((l) => ({
      orderItemId: l.orderItemId!,
      itemId: null,
      partNumber: null,
      description: null,
      unit: null,
      quantity: D(l.quantity),
      unitCost: D(l.unitCost ?? num(byOrderItem.get(l.orderItemId!)!.unitPrice)),
      ...extras(l),
    }));
    return {
      header: { orderId: order.id, supplierId: null, sourceName: null, reason: null, ...misc, warehouseId: warehouseId ?? order.warehouseId ?? null },
      rows,
      newItems: new Map<number, { name: string; partNumber: string | null; unit: string }>(),
      label: `against ${order.number}`,
    };
  }

  // Without an order: where from, why, into which warehouse, and an item per line.
  let supplierName: string | null = null;
  if (body.supplierId) {
    const supplier = await prisma.supplier.findUnique({ where: { id: body.supplierId }, select: { name: true } });
    if (!supplier) throw badRequest('That supplier is not on file');
    supplierName = supplier.name;
  }
  if (!supplierName && !body.sourceName?.trim()) throw badRequest('Say where the goods came from — a supplier, or a name');
  if (!body.reason?.trim()) throw badRequest('Say why there is no purchase order');
  if (!warehouseId) throw badRequest('Goods received without a purchase order go into a warehouse — choose one');
  const itemIds = [...new Set(body.items.map((l) => l.itemId).filter((v): v is string => !!v))];
  const items = await prisma.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, name: true, unit: true, partNumber: true } });
  const byItem = new Map(items.map((i) => [i.id, i]));
  // A line typed without picking from the item master: the one active item
  // whose part number or code (else name) is what was typed, else a new item
  // filed in the item master when the report is saved (2026-10-16, the
  // owner's report: "Can't save").
  const newItems = new Map<number, { name: string; partNumber: string | null; unit: string }>();
  const rows: Array<{
    orderItemId: null; itemId: string | null; partNumber: string | null; description: string | null; unit: string | null;
    quantity: Prisma.Decimal; unitCost: Prisma.Decimal; locationId: string | null; serialNo: string | null; batchNo: string | null; remarks: string | null;
  }> = [];
  for (const [n, l] of body.items.entries()) {
    if (l.orderItemId) throw badRequest(`Line ${n + 1}: there is no purchase order on this report`);
    if (l.unitCost === undefined) throw badRequest(`Line ${n + 1}: type the unit cost it is taken into stock at (0 for a free item)`);
    let item: { id: string; name: string; unit: string; partNumber: string | null } | undefined | null = l.itemId ? byItem.get(l.itemId) : undefined;
    if (l.itemId && !item) throw badRequest(`Line ${n + 1}: that item is not on file`);
    const part = l.partNumber?.trim() || null;
    const desc = l.description?.trim() || null;
    if (!item) {
      if (!part && !desc) throw badRequest(`Line ${n + 1}: type the part number or the description of the item`);
      const sel = { id: true, name: true, unit: true, partNumber: true } as const;
      let found = part
        ? await prisma.item.findMany({ where: { isActive: true, OR: [{ partNumber: { equals: part, mode: 'insensitive' } }, { code: { equals: part, mode: 'insensitive' } }] }, select: sel, take: 2 })
        : [];
      if (!found.length && desc) found = await prisma.item.findMany({ where: { isActive: true, name: { equals: desc, mode: 'insensitive' } }, select: sel, take: 2 });
      if (found.length > 1) throw badRequest(`Line ${n + 1}: “${part ?? desc}” matches more than one item — pick it from the list`);
      item = found[0] ?? null;
      if (!item) newItems.set(n, { name: desc ?? part!, partNumber: part, unit: l.unit?.trim() || 'pcs' });
    }
    rows.push({
      orderItemId: null,
      itemId: item?.id ?? null,
      partNumber: part || item?.partNumber || null,
      description: desc || item?.name || part,
      unit: l.unit?.trim() || item?.unit || 'pcs',
      quantity: D(l.quantity),
      unitCost: D(l.unitCost),
      ...extras(l),
    });
  }
  return {
    header: {
      orderId: null,
      supplierId: body.supplierId || null,
      sourceName: supplierName ? null : body.sourceName!.trim(),
      reason: body.reason.trim(),
      ...misc,
    },
    rows,
    newItems,
    label: `from ${supplierName ?? body.sourceName!.trim()}, without a purchase order`,
  };
}

/** Files the items a no-PO report typed by hand, inside the save's transaction. */
async function fileNewItems(
  tx: Prisma.TransactionClient,
  rows: Array<{ itemId: string | null }>,
  newItems: Map<number, { name: string; partNumber: string | null; unit: string }>,
  actorId: string,
) {
  for (const [n, it] of newItems) {
    const code = await nextNumber('item', tx);
    const created = await tx.item.create({ data: { code, name: it.name, partNumber: it.partNumber, unit: it.unit } });
    rows[n].itemId = created.id;
    await tx.auditLog.create({
      data: { entityType: 'item', entityId: created.id, action: 'CREATED', summary: `${code} ${it.name} added from an incoming report`, actorId },
    });
  }
}

/**
 * Posts a receiving report: against an order, the order's received
 * quantities and status, the stock (a replenishment), the job cost (direct
 * to a project); without one, the stock alone at each line's cost. Inside
 * the caller's transaction, after its claim.
 */
async function postReceiving(tx: Prisma.TransactionClient, receivingId: string, actorId: string) {
  const receiving = await tx.receiving.findUniqueOrThrow({
    where: { id: receivingId },
    include: { items: true, order: { include: { items: true, supplier: { select: { name: true } } } } },
  });
  const order = receiving.order;

  if (!order) {
    if (!receiving.warehouseId) throw badRequest(`${receiving.number} names no warehouse`);
    for (const line of receiving.items) {
      if (!line.itemId) throw badRequest(`${receiving.number} has a line with no item`);
      await receiveStock(tx, {
        itemId: line.itemId,
        warehouseId: receiving.warehouseId,
        quantity: num(line.quantity),
        unitCost: num(line.unitCost),
        sourceType: 'receiving',
        sourceId: receiving.id,
        sourceNumber: receiving.number,
        createdById: actorId,
      });
    }
    return;
  }

  if (order.status === 'CANCELLED') throw badRequest(`${order.number} was cancelled`);
  const byOrderItem = new Map(order.items.map((i) => [i.id, i]));
  const byCategory = new Map<string, number>();

  for (const line of receiving.items) {
    const orderItem = line.orderItemId ? byOrderItem.get(line.orderItemId) : undefined;
    if (!orderItem) throw badRequest(`${receiving.number} has a line that is not on ${order.number}`);
    const quantity = num(line.quantity);
    const unitCost = num(line.unitCost);
    const amount = cents(quantity * unitCost);

    await tx.purchaseOrderItem.update({
      where: { id: orderItem.id },
      data: { receivedQty: { increment: line.quantity } },
    });

    // ONLY a stock replenishment builds inventory. Direct-to-job material is
    // charged to the project the moment it arrives; entering stock as well
    // would charge it twice at issue.
    // A stock line typed on the order without picking an item still builds
    // stock (2026-10-16, the owner's report: received but not in inventory):
    // the one active item by part number or code, else by name, else a new
    // one filed now — and the order line is linked to it.
    const stockWarehouseId = receiving.warehouseId ?? order.warehouseId;
    if (order.kind === 'STOCK_REPLENISHMENT' && stockWarehouseId && !orderItem.itemId) {
      orderItem.itemId = await itemForTypedLine(tx, orderItem, actorId);
      await tx.purchaseOrderItem.update({ where: { id: orderItem.id }, data: { itemId: orderItem.itemId } });
    }
    if (order.kind === 'STOCK_REPLENISHMENT' && stockWarehouseId && orderItem.itemId) {
      await receiveStock(tx, {
        itemId: orderItem.itemId,
        warehouseId: stockWarehouseId,
        quantity,
        unitCost,
        sourceType: 'receiving',
        sourceId: receiving.id,
        sourceNumber: receiving.number,
        createdById: actorId,
      });
    }
    if (order.kind === 'STOCK_REPLENISHMENT' && stockWarehouseId && orderItem.itemId && line.locationId) {
      // A receipt into a named bin files the stock line there while it has none.
      await tx.inventoryBalance.updateMany({
        where: { itemId: orderItem.itemId, warehouseId: stockWarehouseId, locationId: null },
        data: { locationId: line.locationId },
      });
    }

    if (order.kind === 'DIRECT_TO_JOB' && orderItem.costCategoryId) {
      byCategory.set(orderItem.costCategoryId, (byCategory.get(orderItem.costCategoryId) ?? 0) + amount);
    }

    // Project goods received into a WAREHOUSE (not to site) sit on its shelf
    // as the project's own stock (2026-10-18): charged below, as ever, and
    // never again when they leave — shared/projectStock.ts.
    if (order.kind === 'DIRECT_TO_JOB' && order.jobId && receiving.warehouseId) {
      if (!orderItem.itemId) {
        orderItem.itemId = await itemForTypedLine(tx, orderItem, actorId);
        await tx.purchaseOrderItem.update({ where: { id: orderItem.id }, data: { itemId: orderItem.itemId } });
      }
      await receiveProjectStock(tx, {
        jobId: order.jobId,
        itemId: orderItem.itemId,
        warehouseId: receiving.warehouseId,
        quantity,
        unitCost,
        locationId: line.locationId,
        sourceType: 'receiving',
        sourceId: receiving.id,
        sourceNumber: receiving.number,
        createdById: actorId,
      });
    }
  }

  if (order.kind === 'DIRECT_TO_JOB' && order.jobId) {
    for (const [costCategoryId, amount] of byCategory) {
      await releaseCommitment(tx, {
        jobId: order.jobId,
        sourceType: 'purchase_order',
        sourceId: order.id,
        costCategoryId,
        amount,
        reason: `Received on ${receiving.number}`,
        createdById: actorId,
      });
      await postJobCost(tx, {
        jobId: order.jobId,
        costCategoryId,
        state: 'INCURRED',
        amount,
        sourceType: 'receiving',
        sourceId: receiving.id,
        sourceNumber: receiving.number,
        description: `Goods received from ${order.supplier.name}`,
        createdById: actorId,
      });
    }
  }

  const refreshed = await tx.purchaseOrderItem.findMany({ where: { orderId: order.id } });
  const fully = refreshed.every((i) => num(i.receivedQty) >= num(i.quantity) - 0.0005);
  await tx.purchaseOrder.update({
    where: { id: order.id },
    data: { status: fully ? 'RECEIVED' : 'PARTIALLY_RECEIVED' },
  });
}

/** Tells the receiver the goods are in, for a project's order. */
async function tellReceived(receivingId: string, userId: string) {
  const r = await prisma.receiving.findUnique({
    where: { id: receivingId },
    select: { id: true, number: true, order: { select: { number: true, job: { select: { number: true } } } } },
  });
  if (!r?.order?.job) return;
  await notify({
    userId,
    type: 'po.received',
    title: `Goods received — ${r.order.number}`,
    body: `${r.order.job.number} · ${r.number}`,
    link: `/g-chain/incoming/${r.id}`,
  });
}

receivingRoutes.post(
  '/',
  require_('gchain.receiving.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(receivingSchema, req.body);
    const { header, rows, label, newItems } = await checkReceivingSheet(body);
    const value = cents(rows.reduce((s, l) => s + num(l.quantity) * num(l.unitCost), 0));
    // With the Incoming route active the report waits for its approval;
    // without one it posts now.
    const routed = !!(await pickWorkflow(RECEIVING_DOC, value, { requesterId: me.id }));

    const receiving = await prisma.$transaction(async (tx) => {
      await fileNewItems(tx, rows, newItems, me.id);
      const number = await nextNumber('receiving', tx);
      const created = await tx.receiving.create({
        data: {
          number,
          ...header,
          receivedById: me.id,
          status: routed ? 'DRAFT' : 'RECEIVED',
          items: { create: rows },
        },
      });
      if (!routed) await postReceiving(tx, created.id, me.id);
      return created;
    });

    await audit(
      {
        entityType: 'receiving',
        entityId: receiving.id,
        action: 'CREATED',
        summary: routed ? `${receiving.number} saved ${label}, to submit for approval` : `${receiving.number} received ${label}`,
      },
      req,
    );
    if (!routed) await tellReceived(receiving.id, me.id);
    res.status(201).json({ ...receiving, needsApproval: routed });
  }),
);

/**
 * Modify a DRAFT whole — header and lines — claimed on the `version`
 * (`updatedAt`) the page read. The lines are replaced: nothing points at a
 * draft's lines.
 */
receivingRoutes.put(
  '/:id/sheet',
  require_('gchain.receiving.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(receivingSchema, req.body);
    const existing = await prisma.receiving.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('Receiving report not found');
    if (!mayHandleReceiving(me, existing)) throw forbidden('This report is someone else’s — they, or the warehouse lead, modify it');
    if (existing.status !== 'DRAFT') throw badRequest(`${existing.number} is ${statusLabel(existing.status).toLowerCase()} — only a draft is modified`);
    const { header, rows, newItems } = await checkReceivingSheet(body, existing.id);
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.receiving.updateMany({
        where: { id: existing.id, status: 'DRAFT', ...(body.version ? { updatedAt: new Date(body.version) } : {}) },
        data: header,
      });
      if (!claimed.count) throw badRequest(`${existing.number} changed a moment ago — reload to see where it stands`);
      await fileNewItems(tx, rows, newItems, me.id);
      await tx.receivingItem.deleteMany({ where: { receivingId: existing.id } });
      await tx.receivingItem.createMany({ data: rows.map((r) => ({ ...r, receivingId: existing.id })) });
    });
    await audit({ entityType: 'receiving', entityId: existing.id, action: 'UPDATED', summary: `Modified ${existing.number} (${rows.length} line${rows.length === 1 ? '' : 's'})` }, req);
    res.json(await presentReceiving((await loadReceiving(existing.id))!, me));
  }),
);

/**
 * Submit for approval: claims the DRAFT on the `updatedAt` it carries,
 * checks the order can still take its quantities, and files the request in
 * the RECEIVER's name whoever presses it. A refused submit puts it back to a
 * draft.
 */
receivingRoutes.post(
  '/:id/submit',
  require_('gchain.receiving.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const receiving = await prisma.receiving.findUnique({
      where: { id: req.params.id },
      include: {
        items: true,
        supplier: { select: { name: true } },
        order: { include: { items: true, supplier: { select: { name: true } }, job: { select: { number: true } } } },
      },
    });
    if (!receiving) throw notFound('Receiving report not found');
    if (!mayHandleReceiving(me, receiving)) throw forbidden('This report is someone else’s — they, or the warehouse lead, submit it');
    if (receiving.status !== 'DRAFT') throw badRequest(`${receiving.number} is ${statusLabel(receiving.status).toLowerCase()}`);
    if (receiving.order) {
      if (['DRAFT', 'PENDING_APPROVAL', 'CANCELLED'].includes(receiving.order.status)) {
        throw badRequest(`${receiving.order.number} is ${statusLabel(receiving.order.status).toLowerCase()} — goods are received against an issued order`);
      }
      await checkOutstanding(
        prisma,
        receiving.order.items,
        receiving.items.map((i) => ({ orderItemId: i.orderItemId, quantity: num(i.quantity) })),
        receiving.id,
      );
    }
    const value = receivingValue(receiving.items);
    const claimed = await prisma.receiving.updateMany({
      where: { id: receiving.id, status: 'DRAFT', updatedAt: receiving.updatedAt },
      data: { status: 'PENDING_APPROVAL' },
    });
    if (!claimed.count) throw badRequest(`${receiving.number} changed a moment ago — reload to see where it stands`);
    const subject = receiving.order
      ? `${receiving.order.supplier.name} — ${receiving.order.number}${receiving.order.job ? ` · ${receiving.order.job.number}` : ''}`
      : `${receivedFrom(receiving)} — without a purchase order`;
    try {
      await submitForApproval({
        documentType: RECEIVING_DOC,
        documentId: receiving.id,
        documentNumber: receiving.number,
        subject,
        amount: value,
        link: `/g-chain/incoming/${receiving.id}`,
        requesterId: receiving.receivedById,
        // Goods of an importation order (no VAT) go to the Purchasing Manager
        // (Importation), the owner's chart of 2026-10-17.
        importation: isImportation(receiving),
      });
    } catch (err) {
      await prisma.receiving.updateMany({ where: { id: receiving.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
      throw err;
    }
    await audit({ entityType: 'receiving', entityId: receiving.id, action: 'SUBMITTED', summary: `${receiving.number} submitted for approval` }, req);
    res.json(await presentReceiving((await loadReceiving(receiving.id))!, me));
  }),
);

/** Pulls a pending report back to a draft — the request withdrawn in the same transaction; a decision that landed first wins. */
receivingRoutes.post(
  '/:id/withdraw',
  require_('gchain.receiving.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const receiving = await prisma.receiving.findUnique({ where: { id: req.params.id } });
    if (!receiving) throw notFound('Receiving report not found');
    if (!mayHandleReceiving(me, receiving)) throw forbidden('This report is someone else’s');
    if (receiving.status !== 'PENDING_APPROVAL') throw badRequest(`${receiving.number} is not waiting for approval`);
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.receiving.updateMany({ where: { id: receiving.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
      if (!claimed.count) throw badRequest(`${receiving.number} was decided a moment ago — reload to see where it stands`);
      const withdrawn = await cancelOpenRequest(RECEIVING_DOC, receiving.id, tx, `pulled back by ${me.name}`, me.id);
      if (!withdrawn.length) throw badRequest(`${receiving.number} was decided a moment ago — reload to see where it stands`);
    });
    await audit({ entityType: 'receiving', entityId: receiving.id, action: 'UPDATED', summary: `${receiving.number} pulled back to a draft` }, req);
    res.json(await presentReceiving((await loadReceiving(receiving.id))!, me));
  }),
);

/** Cancels a draft or a pending report, the reason kept — nothing had moved, and its open request is withdrawn. */
receivingRoutes.post(
  '/:id/cancel',
  require_('gchain.receiving.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(z.object({ reason: z.string().trim().min(3, 'Say why it is cancelled').max(2000) }), req.body);
    const receiving = await prisma.receiving.findUnique({ where: { id: req.params.id } });
    if (!receiving) throw notFound('Receiving report not found');
    if (!mayHandleReceiving(me, receiving)) throw forbidden('This report is someone else’s');
    if (receiving.status !== 'DRAFT' && receiving.status !== 'PENDING_APPROVAL') {
      throw badRequest(`${receiving.number} is ${statusLabel(receiving.status).toLowerCase()} — ${receiving.status === 'RECEIVED' ? 'the goods are in, so it stays on record' : 'nothing to cancel'}`);
    }
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.receiving.updateMany({
        where: { id: receiving.id, status: receiving.status },
        data: { status: 'CANCELLED', cancelReason: body.reason },
      });
      if (!claimed.count) throw badRequest(`${receiving.number} changed a moment ago — reload to see where it stands`);
      if (receiving.status === 'PENDING_APPROVAL') {
        await cancelOpenRequest(RECEIVING_DOC, receiving.id, tx, `cancelled by ${me.name}: ${body.reason}`, me.id);
      }
    });
    await audit({ entityType: 'receiving', entityId: receiving.id, action: 'CANCELLED', summary: `${receiving.number} cancelled — ${body.reason}` }, req);
    res.json({ ok: true, status: 'CANCELLED' });
  }),
);

/**
 * Deletes a draft or a CANCELLED incoming report (2026-10-19, the owner's
 * call) — neither posted anything: the delete right, and its receiver or
 * edit_all; refused while a live supplier bill names it. Its lines cascade,
 * its files go after the commit, one DELETED row.
 */
receivingRoutes.delete(
  '/:id',
  require_('gchain.receiving.delete'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const receiving = await prisma.receiving.findUnique({
      where: { id: req.params.id },
      include: { bills: { where: { status: { not: 'CANCELLED' } }, select: { number: true } } },
    });
    if (!receiving) throw notFound('Incoming report not found');
    if (!mayHandleReceiving(me, receiving)) throw forbidden('This report is someone else’s');
    if (receiving.status !== 'DRAFT' && receiving.status !== 'CANCELLED') {
      throw badRequest(`Only a draft or a cancelled incoming report can be deleted — ${receiving.number} is ${statusLabel(receiving.status).toLowerCase()}`);
    }
    if (receiving.bills.length) throw badRequest(`Supplier bill ${receiving.bills.map((b) => b.number).join(', ')} names ${receiving.number} — cancel it first`);
    await deleteOrRefuse(receiving.number, () =>
      prisma.receiving.delete({ where: { id: receiving.id, status: { in: ['DRAFT', 'CANCELLED'] } } }),
    );
    await deleteAttachmentsOf('receiving', [receiving.id]);
    await audit(
      { entityType: 'receiving', entityId: receiving.id, action: 'DELETED', summary: `Deleted ${receiving.status === 'CANCELLED' ? 'cancelled' : 'draft'} ${receiving.number}` },
      req,
    );
    res.json({ ok: true });
  }),
);

/**
 * The route's decision. Approved: claims PENDING_APPROVAL → RECEIVED and
 * posts in the same transaction — once, whatever calls it twice. Returned or
 * rejected: back to a draft for the receiver to put right. A decision that
 * finds the report no longer pending changes nothing, and says so.
 */
export async function settleReceiving(documentId: string, outcome: ApprovalOutcome) {
  const receiving = await prisma.receiving.findUnique({ where: { id: documentId } });
  if (!receiving) return;
  if (outcome !== 'APPROVED') {
    const back = await prisma.receiving.updateMany({ where: { id: receiving.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
    if (!back.count) await warehouseNotApplied('receiving', receiving.id, receiving.number, receiving.status, outcome);
    return;
  }
  let posted = false;
  try {
    posted = await prisma.$transaction(async (tx) => {
      const claimed = await tx.receiving.updateMany({ where: { id: receiving.id, status: 'PENDING_APPROVAL' }, data: { status: 'RECEIVED' } });
      if (!claimed.count) return false;
      await postReceiving(tx, receiving.id, receiving.receivedById);
      return true;
    });
  } catch (err) {
    // Approved, but its order can no longer take it: back to a draft, said
    // on its trail and to the receiver, never half posted.
    const reason = err instanceof Error ? err.message : 'it could not be posted';
    const back = await prisma.receiving.updateMany({ where: { id: receiving.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
    if (back.count) {
      await audit({ entityType: 'receiving', entityId: receiving.id, action: 'UPDATED', summary: `${receiving.number} approved, but not received — ${reason}; back to a draft`, actorName: 'system' });
      await notify({
        userId: receiving.receivedById,
        type: 'warehouse.not_posted',
        title: `${receiving.number} approved but not received`,
        body: `${reason}. It is a draft again.`,
        link: `/g-chain/incoming/${receiving.id}`,
      });
    }
    return;
  }
  if (!posted) {
    const now = await prisma.receiving.findUnique({ where: { id: receiving.id }, select: { status: true } });
    await warehouseNotApplied('receiving', receiving.id, receiving.number, now?.status ?? receiving.status, outcome);
    return;
  }
  await audit({ entityType: 'receiving', entityId: receiving.id, action: 'EXECUTED', summary: `${receiving.number} received — approved`, actorName: 'system' });
  await tellReceived(receiving.id, receiving.receivedById);
}

onApprovalSettled(RECEIVING_DOC, async (request, outcome) => {
  await settleReceiving(request.documentId, outcome);
});

/**
 * Pulled back after approval (2026-10-16, the owner's call): RECEIVED →
 * DRAFT, everything `postReceiving` did undone by movements of its own — the
 * stock taken back out at the cost it came in at, the order's received
 * quantities and status put back, the project's cost reversed and the
 * order's commitment restored by what the receipt released. Refused once a
 * supplier bill is matched to it, or once the stock it brought in has moved
 * on (less is available at the warehouse than it received).
 */
onApprovalReopened(RECEIVING_DOC, {
  may: async (actor, id) => {
    const r = await prisma.receiving.findUnique({ where: { id }, select: { receivedById: true } });
    return !!r && mayHandleReceiving(actor, r);
  },
  reopen: async ({ documentId, tx, actor, reason }) => {
    const receiving = await tx.receiving.findUnique({
      where: { id: documentId },
      include: {
        items: true,
        order: { include: { items: true } },
        bills: { where: { status: { not: 'CANCELLED' } }, select: { number: true } },
      },
    });
    if (!receiving) throw notFound('Incoming report not found');
    if (receiving.status !== 'RECEIVED') {
      throw badRequest(`${receiving.number} is ${statusLabel(receiving.status).toLowerCase()} — only a received report is pulled back`);
    }
    if (receiving.bills.length) {
      throw badRequest(`Supplier bill ${receiving.bills.map((b) => b.number).join(', ')} is matched to ${receiving.number} — cancel it first`);
    }
    const claimed = await tx.receiving.updateMany({ where: { id: receiving.id, status: 'RECEIVED' }, data: { status: 'DRAFT' } });
    if (!claimed.count) throw badRequest(`${receiving.number} changed a moment ago — reload to see where it stands`);

    const why = `${receiving.number} pulled back to draft by ${actor.name}: ${reason}`;
    const order = receiving.order;
    const byOrderItem = new Map((order?.items ?? []).map((i) => [i.id, i]));
    for (const line of receiving.items) {
      const orderItem = line.orderItemId ? byOrderItem.get(line.orderItemId) : undefined;
      // What came into stock: every line without an order, a replenishment's lines with an item.
      const itemId = order ? (order.kind === 'STOCK_REPLENISHMENT' ? orderItem?.itemId : null) : line.itemId;
      if (order?.kind === 'DIRECT_TO_JOB' && order.jobId && receiving.warehouseId && orderItem?.itemId) {
        // The project's own stock goes back out — refused, naming it, once some left the shelf.
        await issueProjectStock(tx, {
          jobId: order.jobId,
          itemId: orderItem.itemId,
          warehouseId: receiving.warehouseId,
          quantity: num(line.quantity),
          type: 'RECEIPT',
          sourceType: 'receiving',
          sourceId: receiving.id,
          sourceNumber: receiving.number,
          notes: why,
          createdById: actor.id,
        });
      }
      if (itemId && receiving.warehouseId) {
        await reverseReceipt(tx, {
          itemId,
          warehouseId: receiving.warehouseId,
          quantity: num(line.quantity),
          unitCost: num(line.unitCost),
          sourceType: 'receiving',
          sourceId: receiving.id,
          sourceNumber: receiving.number,
          notes: why,
          createdById: actor.id,
        });
      }
      if (orderItem) {
        const left = Math.max(0, Math.round((num(orderItem.receivedQty) - num(line.quantity)) * 1000) / 1000);
        await tx.purchaseOrderItem.update({ where: { id: orderItem.id }, data: { receivedQty: D(left) } });
        orderItem.receivedQty = D(left);
      }
    }
    if (order) {
      const lines = [...byOrderItem.values()];
      const none = lines.every((i) => num(i.receivedQty) < 0.0005);
      const fully = lines.every((i) => num(i.receivedQty) >= num(i.quantity) - 0.0005);
      await tx.purchaseOrder.updateMany({
        where: { id: order.id, status: { in: ['ISSUED', 'PARTIALLY_RECEIVED', 'RECEIVED'] } },
        data: { status: none ? 'ISSUED' : fully ? 'RECEIVED' : 'PARTIALLY_RECEIVED' },
      });
      await reverseJobCost(tx, { sourceType: 'receiving', sourceId: receiving.id, reason: why, sourceNumber: receiving.number, createdById: actor.id });
      await reverseJobCost(tx, {
        sourceType: 'purchase_order',
        sourceId: order.id,
        states: ['COMMITTED'],
        description: `Received on ${receiving.number}`,
        reason: why,
        createdById: actor.id,
      });
    }
  },
});

/**
 * The incoming report on paper, in the purchase order's dress (2026-10-14,
 * the owner's call: "printed PDF should pattern to the standard template"):
 * ORDER DETAILS (the purchase order or why there is none, the DR and invoice
 * numbers, the date received, what it is for), "Received from" and
 * "Received at" side by side, the lines and their total, then Prepared by
 * and one slot per step of the route (a draft prints the route submitting
 * would take; "Pending" until signed). The packing list, the DR and the
 * photos attached to it follow it unless `?attachments=0`.
 */
receivingRoutes.get(
  '/:id/pdf',
  requireAnyOrDecider(RECEIVING_VIEW, RECEIVING_VIEW_OWN),
  handler(async (req, res) => {
    const me = currentUser(req);
    const receiving = await visibleReceiving(me, req.params.id, res.locals.deciderOnly === true);
    const view = await presentReceiving(receiving, me);
    const slots =
      receiving.status === 'DRAFT'
        ? await approvalSlots(RECEIVING_DOC, receiving.id, { amount: view.value, requesterId: receiving.receivedById, importation: isImportation(receiving) })
        : await approvalSlots(RECEIVING_DOC, receiving.id);
    const signatories: Signatory[] = [
      { role: 'Prepared by', name: receiving.receivedBy.name, ...(await contactOf(receiving.receivedById)), at: preparedAt(slots) ?? receiving.createdAt },
      ...slotSignatories(slots),
    ];

    // Received from: the supplier's own block where one is on file.
    const supplierId = receiving.order?.supplier.id ?? receiving.supplierId;
    const supplier = supplierId
      ? await prisma.supplier.findUnique({ where: { id: supplierId }, select: { name: true, address: true, city: true, phone: true, email: true } })
      : null;
    const warehouse = receiving.warehouseId
      ? await prisma.warehouse.findUnique({ where: { id: receiving.warehouseId }, select: { name: true, address: true, city: true } })
      : null;
    const company = await prisma.company.findUnique({ where: { id: 'company' } });
    const place = (...parts: (string | null | undefined)[]) => parts.filter((p) => p?.trim()).join(', ');
    const fromLines = [
      receivedFrom(receiving),
      place(supplier?.address, supplier?.city),
      supplier?.phone ?? '',
      supplier?.email ?? '',
    ].filter((l) => l.trim());
    const atLines = warehouse
      ? [company?.legalName || company?.name || '', warehouse.name, place(warehouse.address, warehouse.city) || place(company?.address, company?.city)]
      : [company?.legalName || company?.name || '', 'Straight to site', receiving.order?.job ? `${receiving.order.job.number} — ${receiving.order.job.name}` : ''];

    const sections: PdfSection[] = [
      { kind: 'blocks', titleSize: 11, blocks: [{ title: 'Received from', lines: fromLines }, { title: 'Received at', lines: atLines.filter((l) => l.trim()) }] },
      {
        kind: 'table',
        // No widths: each column from its content, the description taking what is left (rule 6).
        head: ['No.', 'Code', 'Part No.', 'Description', 'Qty', 'Unit', 'Unit cost', 'Amount'],
        align: ['right', 'left', 'left', 'left', 'right', 'left', 'right', 'right'],
        rows: view.items.map((i, n) => [
          String(n + 1),
          i.code ?? '',
          i.partNumber ?? '',
          i.name && i.description && i.description !== i.name ? { title: i.name, body: i.description } : (i.name ?? i.description ?? ''),
          qty(i.quantity),
          i.unit ?? '',
          formatAmount(i.unitCost),
          formatAmount(i.amount),
        ]),
      },
      { kind: 'totals', rows: [{ label: 'Total', value: formatAmount(view.value), bold: true }] },
    ];
    if (receiving.reason) sections.push({ kind: 'text', title: 'Why there is no purchase order', body: receiving.reason });
    if (receiving.notes) sections.push({ kind: 'text', title: 'Notes', body: receiving.notes });
    if (receiving.cancelReason && receiving.status === 'CANCELLED') sections.push({ kind: 'text', title: 'Cancelled', body: receiving.cancelReason });

    const currency = await companyCurrency();
    const bare = await renderDocument({
      title: 'Incoming Report',
      titleBold: true,
      documentNumber: receiving.number,
      date: receiving.receivedDate,
      numberNote: `Date: ${formatDate(receiving.receivedDate)}`,
      detailsTitle: 'Order details',
      detailsTitleSize: 11,
      details: [
        [
          ['Purchase order', receiving.order?.number ?? 'None'],
          ['For', receiving.order?.job ? receiving.order.job.number : 'Stock'],
        ],
        [
          ['Delivery receipt no.', receiving.deliveryRefNo ?? '—'],
          ['Invoice no.', receiving.invoiceRefNo ?? '—'],
          ['Currency', currency],
        ],
      ],
      sections,
      signatories,
      signoffNote: 'The name, date and time are considered a digital signature of approval.',
      footerNote:
        receiving.status === 'DRAFT' || receiving.status === 'PENDING_APPROVAL' ? 'DRAFT — NOT YET RECEIVED.' : receiving.status === 'CANCELLED' ? 'CANCELLED.' : undefined,
    });
    const files = req.query.attachments === '0' ? [] : await attachedFiles('receiving', receiving.id);
    const { pdf, listed } = await withAttachments(bare, files, { title: 'Incoming Report', number: receiving.number, reference: receivedFrom(receiving) });
    await audit(
      { entityType: 'receiving', entityId: receiving.id, action: 'EXPORTED', summary: `Printed ${receiving.number}${listed ? ` with ${listed} attachment${listed === 1 ? '' : 's'}` : ''}` },
      req,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition(paperFileName({ kind: 'Incoming Report', number: receiving.number, author: receiving.receivedBy.name, date: receiving.receivedDate })));
    res.send(pdf);
  }),
);

// The packing list, the delivery receipt, photos of what arrived: read as the
// report is read, added while it is a draft or waiting for its approval by
// whoever may move it on — what the supervisor decides on is what was sent.
registerAttachmentGuard(
  'receiving',
  async (user, id) => {
    if (can(user, RECEIVING_VIEW)) return !!(await prisma.receiving.findUnique({ where: { id }, select: { id: true } }));
    if (can(user, RECEIVING_VIEW_OWN)) {
      const r = await prisma.receiving.findUnique({ where: { id }, select: { receivedById: true } });
      if (r?.receivedById === user.id) return true;
    }
    return mayDecide(user.id, RECEIVING_DOC, [id]);
  },
  {
    write: async (user, id) => {
      const r = await prisma.receiving.findUnique({ where: { id }, select: { status: true, receivedById: true } });
      return !!r && (r.status === 'DRAFT' || r.status === 'PENDING_APPROVAL') && mayHandleReceiving(user, r);
    },
  },
);

/** The trail's line for a decision that found its document no longer waiting for one. */
async function warehouseNotApplied(entityType: string, documentId: string, number: string, status: string, outcome: ApprovalOutcome) {
  await audit({
    entityType,
    entityId: documentId,
    action: outcome === 'APPROVED' ? 'APPROVED' : 'REJECTED',
    summary: `${number} ${outcome.toLowerCase()} after it was ${status.toLowerCase().replace(/_/g, ' ')} — not applied`,
    actorName: 'system',
  });
}

// ════════════════════════════════════════════════════════════════════
//  STOCK ISSUANCE
// ════════════════════════════════════════════════════════════════════

export const stockIssueRoutes = Router();
stockIssueRoutes.use(authenticate);

const ISSUE_SORTS = ['number', 'issueDate'];

/**
 * Which stock issues a list query means — one rule for the list, its summary
 * cards and its printed twin. `base` is everything but the status and
 * received filters (the cards count under it, so each card equals the list it
 * opens); `where` adds them.
 */
function issueListWhere(me: ResolvedUser, q: ListQuery): { base: Prisma.StockIssueWhereInput; where: Prisma.StockIssueWhereInput } {
  // View Own reads the slips one issued (2026-10-18) — under the cards too.
  const { base, where } = issueListWhereAll(q);
  const mine = { issuedById: me.id };
  return { base: ownOnly(me, 'gchain', 'stock_issuance', base, mine), where: ownOnly(me, 'gchain', 'stock_issuance', where, mine) };
}

function issueListWhereAll(q: ListQuery): { base: Prisma.StockIssueWhereInput; where: Prisma.StockIssueWhereInput } {
  const and: Prisma.StockIssueWhereInput[] = [];
  if (q.filters.jobId) and.push({ jobId: q.filters.jobId });
  if (q.filters.issuedToId) and.push({ issuedToId: q.filters.issuedToId });
  if (q.filters.warehouseId) and.push({ warehouseId: q.filters.warehouseId });
  if (q.search) {
    and.push({
      OR: [
        { number: { contains: q.search, mode: 'insensitive' } },
        { purpose: { contains: q.search, mode: 'insensitive' } },
        { issuedToName: { contains: q.search, mode: 'insensitive' } },
        { issuedTo: { name: { contains: q.search, mode: 'insensitive' } } },
        { referenceNo: { contains: q.search, mode: 'insensitive' } },
        { job: { name: { contains: q.search, mode: 'insensitive' } } },
        { job: { number: { contains: q.search, mode: 'insensitive' } } },
      ],
    });
  }
  const ids = idsFilter(q.filters.ids);
  if (ids) and.push({ id: { in: ids } });
  const base: Prisma.StockIssueWhereInput = and.length ? { AND: [...and] } : {};
  const status = choice(q.filters.status, IssueStatus, 'Status');
  if (status) and.push({ status });
  // The receive proof (2026-10-15): issued and confirmed, or issued and not yet.
  const received = choice(q.filters.received, { yes: 'yes', no: 'no' }, 'Received');
  if (received === 'yes') and.push({ receivedAt: { not: null } });
  if (received === 'no') and.push({ status: 'ISSUED', receivedAt: null });
  return { base, where: and.length ? { AND: and } : {} };
}

stockIssueRoutes.get(
  '/',
  requireView('gchain', 'stock_issuance'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const { base, where } = issueListWhere(currentUser(req), q);

    const [rows, total, waiting, drafts, issued, toConfirm] = await Promise.all([
      prisma.stockIssue.findMany({
        where,
        include: {
          job: { select: { id: true, number: true, name: true } },
          warehouse: { select: { id: true, name: true } },
          issuedBy: { select: { id: true, name: true } },
          issuedTo: { select: { id: true, name: true } },
          items: { select: { amount: true } },
        },
        orderBy: orderBy(q, ISSUE_SORTS, { issueDate: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.stockIssue.count({ where }),
      prisma.stockIssue.count({ where: { AND: [base, { status: 'PENDING_APPROVAL' }] } }),
      prisma.stockIssue.count({ where: { AND: [base, { status: 'DRAFT' }] } }),
      prisma.stockIssue.count({ where: { AND: [base, { status: 'ISSUED' }] } }),
      prisma.stockIssue.count({ where: { AND: [base, { status: 'ISSUED', receivedAt: null }] } }),
    ]);

    res.json({
      ...listResult(
        rows.map((r) => ({
          id: r.id,
          number: r.number,
          status: r.status,
          issueDate: r.issueDate,
          purpose: r.purpose,
          issuedToName: r.issuedTo?.name ?? r.issuedToName,
          issuedTo: r.issuedTo,
          deliverTo: r.deliverTo,
          receivedAt: r.receivedAt,
          job: r.job,
          warehouse: r.warehouse,
          issuedBy: r.issuedBy,
          lineCount: r.items.length,
          value: cents(r.items.reduce((s, i) => s + num(i.amount), 0)),
        })),
        total,
        q,
      ),
      summary: { waiting, drafts, issued, toConfirm },
    });
  }),
);

/**
 * The stock issue list on paper, through `issueListWhere` (or the rows
 * ticked, `?ids=`), valued at the moving average each line was issued at — the
 * figure the screen shows. A cancelled issue moved nothing: its value prints
 * in brackets and is not summed. A draft has moved nothing YET: it is summed,
 * as G-FIN sums a draft invoice, and the note under the total says how many —
 * nothing leaves the warehouse on one until it is issued. Above `/:id`.
 */
stockIssueRoutes.get(
  '/pdf',
  requireView('gchain', 'stock_issuance'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const { where } = issueListWhere(currentUser(req), q);
    const f = q.filters;
    const [rows, count, live, cancelled, drafts, currency, project] = await Promise.all([
      prisma.stockIssue.findMany({
        where,
        include: {
          job: { select: { number: true, name: true } },
          warehouse: { select: { name: true } },
          issuedTo: { select: { name: true } },
          items: { select: { amount: true } },
        },
        orderBy: orderBy(q, ISSUE_SORTS, { issueDate: 'desc' }),
        take: LIST_CAP,
      }),
      prisma.stockIssue.count({ where }),
      prisma.stockIssueItem.aggregate({ where: { issue: { AND: [where, { status: { not: 'CANCELLED' } }] } }, _sum: { amount: true } }),
      prisma.stockIssue.count({ where: { AND: [where, { status: 'CANCELLED' }] } }),
      prisma.stockIssue.count({ where: { AND: [where, { status: { in: ['DRAFT', 'PENDING_APPROVAL'] } }] } }),
      companyCurrency(),
      recordNamed('project', f.jobId),
    ]);
    const warehouseName = f.warehouseId ? (await prisma.warehouse.findUnique({ where: { id: f.warehouseId }, select: { name: true } }))?.name : null;
    const reference = listReference(count, rows.length, ['outgoing slip', 'outgoing slips'], [
      q.search && `search "${q.search}"`,
      f.status && `status ${statusLabel(f.status)}`,
      f.received === 'yes' && 'confirmed received',
      f.received === 'no' && 'issued, not yet confirmed received',
      warehouseName && `from ${warehouseName}`,
      project,
      f.ids && 'the rows selected',
    ]);
    const valueOf = (r: (typeof rows)[number]) => r.items.reduce((s, i) => s.add(i.amount), new Prisma.Decimal(0));

    // Nine columns: landscape, each sized from what it holds (rule 6).
    const sections: PdfSection[] = [
      {
        kind: 'table',
        head: ['Number', 'Outgoing', 'Requested by', 'From', 'Date', 'Lines', `Value (${currency})`, 'Status', 'Received'],
        align: ['left', 'left', 'left', 'left', 'left', 'right', 'right', 'left', 'left'],
        rows: rows.map((i) => [
          i.number,
          { title: i.purpose, body: i.job ? `${i.job.number} — ${i.job.name}` : (i.deliverTo ?? 'No project') },
          i.issuedTo?.name ?? i.issuedToName ?? '',
          i.warehouse.name,
          formatShortDate(i.issueDate),
          String(i.items.length),
          bracketed(formatAmount(valueOf(i).toFixed(2)), i.status !== 'CANCELLED'),
          statusLabel(i.status),
          i.receivedAt ? formatShortDate(i.receivedAt) : i.status === 'ISSUED' ? 'Not yet' : '',
        ]),
      },
      {
        kind: 'totals',
        rows: [{ label: totalLabel('Total', count, rows.length), value: formatMoney(num(live._sum.amount), currency), bold: true }],
      },
    ];
    sections.push(
      ...listNotes([
        drafts > 0 &&
          `The total includes ${counted(drafts, ['draft or pending issue', 'draft or pending issues'])}, not issued yet — nothing leaves the warehouse on ${drafts === 1 ? 'it' : 'them'} until ${drafts === 1 ? 'it is' : 'they are'}.`,
        bracketNote(cancelled, ['cancelled issue', 'cancelled issues']),
      ]),
    );

    const pdf = await renderDocument({ title: 'Outgoing', date: new Date(), reference, landscape: true, sections });
    await audit(
      { entityType: 'stock_issue', entityId: 'list', action: 'EXPORTED', summary: `Exported the outgoing list as PDF (${rows.length} slip(s))` },
      req,
    );
    sendListPdf(res, pdf, 'outgoing.pdf');
  }),
);

async function loadIssue(id: string) {
  return prisma.stockIssue.findUnique({
    where: { id },
    include: {
      job: { select: { id: true, number: true, name: true } },
      warehouse: { select: { id: true, name: true, address: true, city: true } },
      issuedBy: { select: { id: true, name: true, position: true } },
      issuedTo: { select: { id: true, name: true, position: true, email: true } },
      receivedBy: { select: { id: true, name: true } },
      items: {
        include: {
          item: { select: { id: true, code: true, partNumber: true, brand: true, name: true, unit: true } },
          costCategory: { select: { id: true, name: true } },
          location: { select: { id: true, code: true } },
        },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      },
    },
  });
}

/**
 * The terms of receipt a new slip starts with (2026-10-15, the owner's
 * delivery receipt) — editable per slip, printed over the sign-offs.
 */
export const OUTGOING_TERMS =
  'Please check that every item listed was received complete and in good condition. Report any discrepancy or damage to the warehouse in writing within 24 hours of receipt. The person receiving confirms receipt in G-CORE, or signs and returns this copy to the warehouse.';

function presentIssue(issue: NonNullable<Awaited<ReturnType<typeof loadIssue>>>) {
  const items = issue.items.map((i) => ({
    ...i,
    quantity: num(i.quantity),
    unitCost: num(i.unitCost),
    amount: num(i.amount),
  }));
  return { ...issue, items, value: cents(items.reduce((s, i) => s + i.amount, 0)) };
}

/**
 * Raising, and changing a draft: the create right, or edit_all — and since
 * 2026-10-18 Edit Own, on a slip one issued (`mayChangeIssue`). The routes
 * let in any of the three; the record decides.
 */
const ISSUE_EDIT = ['gchain.stock_issuance.create', 'gchain.stock_issuance.edit_own', 'gchain.stock_issuance.edit_all'] as const;
const ISSUE_EDIT_ANY = ['gchain.stock_issuance.create', 'gchain.stock_issuance.edit_all'] as const;

/** May the caller change this slip? Create or Edit All any draft; Edit Own the slips one issued. */
function mayChangeIssue(me: ResolvedUser, issue: { issuedById: string }): boolean {
  return ISSUE_EDIT_ANY.some((k) => can(me, k)) || (issue.issuedById === me.id && can(me, 'gchain.stock_issuance.edit_own'));
}

function assertChangeIssue(me: ResolvedUser, issue: { issuedById: string }): void {
  if (!mayChangeIssue(me, issue)) throw forbidden('You may change only your own — this one is somebody else’s');
}

const ISSUE_DOC = 'stock_issue';
const ISSUE_VIEW = 'gchain.stock_issuance.view_all';
/** View Own on Outgoing (2026-10-18): the slips one issued. */
const ISSUE_VIEW_OWN = 'gchain.stock_issuance.view_own';

/**
 * The slip as its reader may see it: the register's right, or — through
 * `requireAnyOrDecider` — whoever may decide its open request (the issuer's
 * supervisor with no warehouse right), only while it waits on them.
 */
async function visibleIssue(me: ResolvedUser, id: string, deciderOnly: boolean) {
  const issue = await loadIssue(id);
  if (!issue) throw notFound('Stock issue not found');
  // The person it was issued to reads their own slip — it is their receive
  // proof (2026-10-15) — whatever rights they hold.
  if (deciderOnly && issue.issuedToId !== me.id && !(await mayDecide(me.id, ISSUE_DOC, [issue.id]))) throw notFound('Stock issue not found');
  // View Own reads the slips one issued (2026-10-18) — and, as anyone, one
  // issued to them or waiting on their decision.
  if (!deciderOnly && viewScope(me, 'gchain', 'stock_issuance') === 'own' && issue.issuedById !== me.id && issue.issuedToId !== me.id) {
    if (!(await mayDecide(me.id, ISSUE_DOC, [issue.id]))) throw notFound('Stock issue not found');
  }
  return issue;
}

/** The record with what its reader may do — the routes' own rules. */
async function issueView(issue: NonNullable<Awaited<ReturnType<typeof loadIssue>>>, me: ResolvedUser) {
  const view = presentIssue(issue);
  const draft = issue.status === 'DRAFT';
  const raiser = mayChangeIssue(me, issue);
  // OUTGOING goes for approval while its route is active; without one the
  // slip is issued at once, as it was before (the sales order's rule).
  const route = draft ? await pickWorkflow(ISSUE_DOC, view.value, { requesterId: issue.issuedById }) : null;
  return {
    ...view,
    // A DRAFT is changed by whoever may raise one (or edit_all) and deleted
    // by a delete holder; a pending one is pulled back first; issued stock
    // has moved.
    canEdit: draft && raiser,
    canDelete: (draft || issue.status === 'CANCELLED') && raiser && can(me, 'gchain.stock_issuance.delete'),
    canCancel: (draft || issue.status === 'PENDING_APPROVAL') && raiser,
    needsApproval: draft ? !!route : null,
    canSubmit: draft && !!route && raiser && issue.items.length > 0,
    canIssue: draft && !route && can(me, 'gchain.stock_issuance.create') && issue.items.length > 0,
    canWithdraw: issue.status === 'PENDING_APPROVAL' && raiser,
    approvalRoute: draft && route ? await routeBrief(ISSUE_DOC, view.value, issue.issuedById) : null,
    // The receive proof: the person it went to confirms it arrived; the
    // warehouse lead may record a paper signature for them.
    canConfirmReceipt:
      issue.status === 'ISSUED' && !issue.receivedAt && (issue.issuedToId === me.id || mayEdit(me, 'gchain', 'stock_issuance', issue.issuedById === me.id)),
  };
}

/** The route a slip of this value would take, raised by the caller — the Outgoing page's preview. */
stockIssueRoutes.get(
  '/route',
  requireAny(...ISSUE_EDIT),
  handler(async (req, res) => {
    const me = currentUser(req);
    const amount = Number(req.query.amount ?? 0) || 0;
    const route = (await pickWorkflow(ISSUE_DOC, amount, { requesterId: me.id })) ? await routeBrief(ISSUE_DOC, amount, me.id) : null;
    res.json({ route });
  }),
);

/** What the Outgoing page offers (above `/:id`, the route-order trap): the warehouses, and what one of them holds available. */
stockIssueRoutes.get(
  '/options',
  requireAny(...ISSUE_EDIT),
  handler(async (req, res) => {
    const warehouseId = req.query.warehouseId ? String(req.query.warehouseId) : null;
    const jobId = req.query.jobId ? String(req.query.jobId) : null;
    const [warehouses, stock, ownStock] = await Promise.all([
      prisma.warehouse.findMany({ where: { isActive: true }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
      warehouseId
        ? prisma.inventoryBalance.findMany({
            where: { warehouseId },
            include: { item: { select: { id: true, code: true, partNumber: true, brand: true, name: true, unit: true, costCategoryId: true, isActive: true } } },
            orderBy: { item: { name: 'asc' } },
          })
        : [],
      // The project's own stock at that warehouse (2026-10-18): offered first, marked.
      warehouseId && jobId ? projectHoldings(prisma, jobId, warehouseId) : new Map(),
    ]);
    res.json({
      warehouses,
      projectStock: [...ownStock.values()].map((r) => ({
        itemId: r.itemId,
        code: r.item.code,
        partNumber: r.item.partNumber,
        name: r.item.name,
        unit: r.item.unit,
        available: num(r.quantity),
        averageCost: num(r.averageCost),
      })),
      stock: stock
        .filter((b) => b.item.isActive)
        .map((b) => ({ itemId: b.itemId, code: b.item.code, partNumber: b.item.partNumber, brand: b.item.brand, name: b.item.name, unit: b.item.unit, available: availableOf(b), averageCost: num(b.averageCost) })),
      terms: OUTGOING_TERMS,
    });
  }),
);

stockIssueRoutes.get(
  '/:id',
  requireAnyOrDecider(ISSUE_VIEW, ISSUE_VIEW_OWN),
  handler(async (req, res) => {
    const me = currentUser(req);
    const issue = await visibleIssue(me, req.params.id, res.locals.deciderOnly === true);
    res.json(await issueView(issue, me));
  }),
);

const issueLineSchema = z.object({
  itemId: z.string().min(1),
  quantity: z.number().positive(),
  costCategoryId: z.string().optional().nullable(),
  locationId: z.string().optional().nullable(),
  serialNo: z.string().trim().max(120).optional().nullable(),
  condition: z.string().trim().max(80).optional().nullable(),
  remarks: z.string().trim().max(500).optional().nullable(),
  /** From the slip's project's own stock (2026-10-18) — needs the slip to name the project. */
  projectStock: z.boolean().optional(),
});

const issueSchema = z.object({
  jobId: z.string().optional().nullable(),
  warehouseId: z.string().min(1, 'Which warehouse?'),
  issuedToId: z.string().optional().nullable(),
  issuedToName: z.string().trim().optional().nullable(),
  issueDate: z.string().optional().nullable(),
  purpose: z.string().trim().min(3, 'Say what this is for'),
  notes: z.string().optional().nullable(),
  deliverTo: z.string().trim().max(300).optional().nullable(),
  referenceNo: z.string().trim().max(120).optional().nullable(),
  carrier: z.string().trim().max(200).optional().nullable(),
  driverName: z.string().trim().max(120).optional().nullable(),
  instructions: z.string().trim().max(2000).optional().nullable(),
});

/**
 * Checks a slip's lines as the Outgoing page sends them, before anything is
 * written or a number issued: each item is held at the warehouse with that
 * much available, priced at its average now (the price a draft shows is the
 * one it would issue at), and — charged to a project — carries its budget
 * line, the item's own filling in.
 */
async function checkIssueLines(lines: z.infer<typeof issueLineSchema>[], warehouseId: string, jobId: string | null) {
  const ids = [...new Set(lines.map((l) => l.itemId))];
  const [items, balances, own] = await Promise.all([
    prisma.item.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, costCategoryId: true } }),
    prisma.inventoryBalance.findMany({ where: { warehouseId, itemId: { in: ids } } }),
    jobId ? projectHoldings(prisma, jobId, warehouseId) : Promise.resolve(new Map()),
  ]);
  const byItem = new Map(items.map((i) => [i.id, i]));
  const byBalance = new Map(balances.map((b) => [b.itemId, b]));
  const asked = new Map<string, number>();
  for (const l of lines) {
    const k = `${l.projectStock ? 'p' : 'c'}:${l.itemId}`;
    asked.set(k, (asked.get(k) ?? 0) + l.quantity);
  }
  return lines.map((l, n) => {
    const item = byItem.get(l.itemId);
    if (!item) throw badRequest(`Line ${n + 1}: that item does not exist`);
    if (l.projectStock) {
      // The project's own goods: already charged to it at receiving.
      if (!jobId) throw badRequest(`Line ${n + 1}: project stock goes out on a slip that names the project`);
      const held = own.get(l.itemId);
      const onHand = held ? num(held.quantity) : 0;
      if ((asked.get(`p:${l.itemId}`) ?? 0) > onHand + 0.0005) {
        throw badRequest(`Line ${n + 1}: the project holds only ${qty(onHand)} of ${item.name} at this warehouse`);
      }
      const unitCost = num(held?.averageCost);
      return {
        itemId: l.itemId,
        costCategoryId: l.costCategoryId || item.costCategoryId || null,
        locationId: l.locationId || held?.locationId || null,
        quantity: D(l.quantity),
        unitCost: D(unitCost),
        amount: D(cents(l.quantity * unitCost)),
        projectStock: true,
        serialNo: l.serialNo || null,
        condition: l.condition || null,
        remarks: l.remarks || null,
        sortOrder: n,
      };
    }
    const balance = byBalance.get(l.itemId);
    if (!balance) throw badRequest(`Line ${n + 1}: the warehouse does not hold ${item.name}`);
    const available = availableOf(balance);
    if ((asked.get(`c:${l.itemId}`) ?? 0) > available + 0.0005) throw badRequest(`Line ${n + 1}: only ${qty(available)} of ${item.name} available`);
    let costCategoryId = l.costCategoryId || null;
    if (jobId && !costCategoryId) {
      costCategoryId = item.costCategoryId ?? null;
      if (!costCategoryId) throw badRequest(`Line ${n + 1}: ${item.name} has no cost bucket, so it cannot be charged to a budget line — set one on the item first`);
    }
    const unitCost = num(balance.averageCost);
    return {
      itemId: l.itemId,
      costCategoryId,
      locationId: l.locationId || balance.locationId || null,
      quantity: D(l.quantity),
      unitCost: D(unitCost),
      amount: D(cents(l.quantity * unitCost)),
      projectStock: false,
      serialNo: l.serialNo || null,
      condition: l.condition || null,
      remarks: l.remarks || null,
      sortOrder: n,
    };
  });
}

/** Checks the header's references: the warehouse, the project, the person it goes to. */
async function checkIssueHeader(body: Partial<z.infer<typeof issueSchema>>) {
  if (body.warehouseId && !(await prisma.warehouse.findUnique({ where: { id: body.warehouseId }, select: { id: true } }))) {
    throw badRequest('That warehouse does not exist');
  }
  if (body.jobId && !(await prisma.job.findUnique({ where: { id: body.jobId }, select: { id: true } }))) {
    throw badRequest('That project does not exist');
  }
  if (body.issuedToId && !(await prisma.user.findUnique({ where: { id: body.issuedToId }, select: { id: true } }))) {
    throw badRequest('That person is not on file');
  }
}

stockIssueRoutes.post(
  '/',
  require_('gchain.stock_issuance.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(issueSchema.extend({ lines: z.array(issueLineSchema).max(300).optional() }), req.body);
    await checkIssueHeader(body);
    const rows = body.lines?.length ? await checkIssueLines(body.lines, body.warehouseId, body.jobId || null) : [];

    const issue = await prisma.$transaction(async (tx) => {
      const number = await nextNumber('stock_issue', tx);
      return tx.stockIssue.create({
        data: {
          number,
          jobId: body.jobId || null,
          warehouseId: body.warehouseId,
          issuedById: me.id,
          issuedToId: body.issuedToId || null,
          issuedToName: body.issuedToName || null,
          issueDate: asDate(body.issueDate) ?? today(),
          purpose: body.purpose,
          notes: body.notes || null,
          deliverTo: body.deliverTo || null,
          referenceNo: body.referenceNo || null,
          carrier: body.carrier || null,
          driverName: body.driverName || null,
          instructions: body.instructions === undefined ? OUTGOING_TERMS : body.instructions || null,
          items: { create: rows },
        },
      });
    });

    await audit(
      { entityType: 'stock_issue', entityId: issue.id, action: 'CREATED', summary: `Raised ${issue.number} — ${issue.purpose}${rows.length ? ` (${rows.length} line${rows.length === 1 ? '' : 's'})` : ''}` },
      req,
    );
    res.status(201).json(issue);
  }),
);

/**
 * The Outgoing page's save on a DRAFT: header and lines at once, claimed on
 * the `version` (`updatedAt`) the page read. The lines are replaced — nothing
 * points at a draft's lines — and re-priced at the warehouse's average.
 */
stockIssueRoutes.put(
  '/:id/sheet',
  requireAny(...ISSUE_EDIT),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(issueSchema.extend({ lines: z.array(issueLineSchema).max(300), version: z.string().optional() }), req.body);
    const issue = await prisma.stockIssue.findUnique({ where: { id: req.params.id } });
    if (!issue) throw notFound('Stock issue not found');
    assertChangeIssue(me, issue);
    if (issue.status !== 'DRAFT') throw badRequest(`${issue.number} is ${statusLabel(issue.status).toLowerCase()} — only a draft is modified`);
    await checkIssueHeader(body);
    const rows = await checkIssueLines(body.lines, body.warehouseId, body.jobId || null);
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.stockIssue.updateMany({
        where: { id: issue.id, status: 'DRAFT', ...(body.version ? { updatedAt: new Date(body.version) } : {}) },
        data: {
          jobId: body.jobId || null,
          warehouseId: body.warehouseId,
          issuedToId: body.issuedToId || null,
          issuedToName: body.issuedToName || null,
          issueDate: asDate(body.issueDate) ?? issue.issueDate,
          purpose: body.purpose,
          notes: body.notes || null,
          deliverTo: body.deliverTo || null,
          referenceNo: body.referenceNo || null,
          carrier: body.carrier || null,
          driverName: body.driverName || null,
          instructions: body.instructions || null,
        },
      });
      if (!claimed.count) throw badRequest(`${issue.number} was changed or issued a moment ago — reload to see where it stands`);
      await tx.stockIssueItem.deleteMany({ where: { issueId: issue.id } });
      if (rows.length) await tx.stockIssueItem.createMany({ data: rows.map((r) => ({ ...r, issueId: issue.id })) });
    });
    await audit(
      { entityType: 'stock_issue', entityId: issue.id, action: 'UPDATED', summary: `Modified ${issue.number} (${rows.length} line${rows.length === 1 ? '' : 's'})` },
      req,
    );
    res.json(await issueView((await loadIssue(issue.id))!, me));
  }),
);

/**
 * The receive proof (2026-10-15, the owner's call: "Outgoing = internal
 * receive proof to the requestor"): the person it went to confirms it
 * arrived in good order — or notes what did not. The warehouse lead
 * (`edit_all`) may record it for them from a signed paper copy, and the
 * record says who did. Once, claimed on `receivedAt` being empty.
 */
stockIssueRoutes.post(
  '/:id/receive',
  // Signed in is enough to ask: the person it went to may hold no warehouse right.
  requireAnyOrDecider(ISSUE_VIEW, ISSUE_VIEW_OWN),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(z.object({ note: z.string().trim().max(1000).optional().nullable() }), req.body ?? {});
    const issue = await prisma.stockIssue.findUnique({ where: { id: req.params.id }, include: { issuedTo: { select: { name: true } } } });
    if (!issue) throw notFound('Stock issue not found');
    const forThem = issue.issuedToId !== me.id;
    // Edit All records it for anyone's slip; Edit Own for a slip one issued (2026-10-18).
    if (forThem && !mayEdit(me, 'gchain', 'stock_issuance', issue.issuedById === me.id)) throw forbidden('Only the person it was issued to confirms receiving it');
    if (issue.status !== 'ISSUED') throw badRequest(`${issue.number} has not been issued yet`);
    const note = [forThem ? `Recorded by ${me.name} for ${issue.issuedTo?.name ?? issue.issuedToName ?? 'the receiver'}` : null, body.note || null].filter(Boolean).join(' — ') || null;
    const claimed = await prisma.stockIssue.updateMany({
      where: { id: issue.id, status: 'ISSUED', receivedAt: null },
      data: { receivedAt: new Date(), receivedById: me.id, receivedNote: note },
    });
    if (!claimed.count) throw badRequest(`${issue.number} was confirmed received a moment ago`);
    await audit(
      { entityType: 'stock_issue', entityId: issue.id, action: 'APPROVED', summary: `${issue.number} confirmed received${forThem ? ` (recorded by ${me.name})` : ''}${body.note ? ` — ${body.note}` : ''}` },
      req,
    );
    if (issue.issuedById !== me.id) {
      await notify({
        userId: issue.issuedById,
        type: 'warehouse.received',
        title: `Received: ${issue.number}`,
        body: `${issue.issuedTo?.name ?? issue.issuedToName ?? 'The receiver'} confirmed it arrived${body.note ? ` — ${body.note}` : ''}`,
        link: `/g-chain/outgoing/${issue.id}`,
      });
    }
    res.json(await issueView((await loadIssue(issue.id))!, me));
  }),
);

/** Tells the person a slip went to that it is on its way, for them to confirm. */
async function tellIssuedTo(issueId: string) {
  const issue = await prisma.stockIssue.findUnique({ where: { id: issueId }, select: { id: true, number: true, purpose: true, issuedToId: true, warehouse: { select: { name: true } } } });
  if (!issue?.issuedToId) return;
  await notify({
    userId: issue.issuedToId,
    type: 'warehouse.issued_to_you',
    title: `Issued to you: ${issue.number}`,
    body: `${issue.purpose} — from ${issue.warehouse.name}. Confirm when you have received it.`,
    link: `/g-chain/outgoing/${issue.id}`,
  });
}

async function issueForEdit(id: string, me: ResolvedUser) {
  const issue = await prisma.stockIssue.findUnique({ where: { id } });
  if (!issue) throw notFound('Stock issue not found');
  assertChangeIssue(me, issue);
  if (issue.status !== 'DRAFT') {
    throw badRequest(`${issue.number} has been issued — stock has already moved and cannot be changed`);
  }
  return issue;
}

/**
 * Holds a draft issue, as it was read, for a change to its lines: the row
 * stays locked until the change commits. An Issue pressed meanwhile waits and
 * then issues the line with the rest; one that went first — or a Modify that
 * moved the draft to another warehouse or project, which a line's price and
 * budget line depend on — leaves nothing to hold, and the change is refused.
 */
async function holdDraftIssue(
  tx: Prisma.TransactionClient,
  issue: { id: string; number: string; warehouseId: string; jobId: string | null },
) {
  const held = await tx.stockIssue.updateMany({
    where: { id: issue.id, status: 'DRAFT', warehouseId: issue.warehouseId, jobId: issue.jobId },
    data: { updatedAt: new Date() },
  });
  if (!held.count) throw badRequest(`${issue.number} was changed or issued a moment ago — reload to see where it stands`);
}

/**
 * Modifying a draft issue's header: where it comes from, who and what it is
 * for, its date. Nothing has moved yet, so everything may change, under two
 * rules that keep the lines honest:
 *
 * - Moving it to another warehouse re-prices every line at THAT warehouse's
 *   average cost — the price a draft shows is the one it would issue at — and
 *   is refused for an item the new warehouse has never held.
 * - Charging it to a project needs a budget line on every line: a line with
 *   none takes its item's default category, as adding a line does, or the
 *   change is refused naming the item.
 */
stockIssueRoutes.patch(
  '/:id',
  requireAny(...ISSUE_EDIT),
  handler(async (req, res) => {
    const body = parseBody(issueSchema.partial(), req.body);
    const issue = await prisma.stockIssue.findUnique({
      where: { id: req.params.id },
      include: { items: { include: { item: { select: { name: true, costCategoryId: true } } } } },
    });
    if (!issue) throw notFound('Stock issue not found');
    assertChangeIssue(currentUser(req), issue);
    if (issue.status !== 'DRAFT') {
      throw badRequest(`${issue.number} has been issued — stock has already moved and cannot be changed`);
    }

    const warehouseId = body.warehouseId ?? issue.warehouseId;
    const jobId = body.jobId !== undefined ? body.jobId || null : issue.jobId;
    const moved = warehouseId !== issue.warehouseId;

    let warehouseName: string | null = null;
    if (moved) {
      const warehouse = await prisma.warehouse.findUnique({ where: { id: warehouseId }, select: { name: true } });
      if (!warehouse) throw badRequest('That warehouse does not exist');
      warehouseName = warehouse.name;
    }
    if (jobId && jobId !== issue.jobId) {
      const job = await prisma.job.findUnique({ where: { id: jobId }, select: { id: true } });
      if (!job) throw badRequest('That project does not exist');
    }

    // Each line's price at the new warehouse — Decimal throughout, so the
    // stored amount is exact rather than a float rounded back.
    const reprice = new Map<string, { unitCost: Prisma.Decimal; amount: Prisma.Decimal }>();
    if (moved && issue.items.length) {
      const balances = await prisma.inventoryBalance.findMany({
        where: { warehouseId, itemId: { in: issue.items.map((l) => l.itemId) } },
      });
      const byItem = new Map(balances.map((b) => [b.itemId, b]));
      const missing = issue.items.filter((l) => !byItem.has(l.itemId)).map((l) => l.item.name);
      if (missing.length) {
        throw badRequest(
          `${warehouseName} does not hold ${missing.join(', ')} — remove ${missing.length === 1 ? 'that line' : 'those lines'} before moving the issue there`,
        );
      }
      for (const line of issue.items) {
        const unitCost = byItem.get(line.itemId)!.averageCost;
        reprice.set(line.id, {
          unitCost,
          amount: line.quantity.mul(unitCost).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
        });
      }
    }

    // Charged to a project, every line needs its budget line.
    const categoryFills = new Map<string, string>();
    if (jobId) {
      const bare: string[] = [];
      for (const line of issue.items) {
        if (line.costCategoryId) continue;
        if (line.item.costCategoryId) categoryFills.set(line.id, line.item.costCategoryId);
        else bare.push(line.item.name);
      }
      if (bare.length) {
        throw badRequest(
          `${bare.join(', ')} ${bare.length === 1 ? 'has' : 'have'} no cost bucket, so the issue cannot be charged to a budget line. ` +
            'Set one on the item, or remove the line, first.',
        );
      }
    }

    const changed: string[] = [];
    if (moved) changed.push(`now from ${warehouseName}, re-priced`);
    if (jobId !== issue.jobId) changed.push(jobId ? 'project' : 'no project');
    if (body.purpose !== undefined && body.purpose !== issue.purpose) changed.push('purpose');
    if (body.issuedToName !== undefined && (body.issuedToName || null) !== issue.issuedToName) changed.push('issued to');
    const issueDate = body.issueDate !== undefined ? asDate(body.issueDate) ?? today() : issue.issueDate;
    if (issueDate.getTime() !== issue.issueDate.getTime()) changed.push('date');
    if (body.notes !== undefined && (body.notes || null) !== issue.notes) changed.push('notes');

    await prisma.$transaction(async (tx) => {
      // Claimed on the draft exactly as read: an issue that went out since
      // wins, and so does a line added or removed since (holdDraftIssue
      // touches updatedAt) — the re-pricing and budget lines above were
      // worked out for the lines read, and must not miss one.
      const claimed = await tx.stockIssue.updateMany({
        where: { id: issue.id, status: 'DRAFT', updatedAt: issue.updatedAt },
        data: {
          warehouseId,
          jobId,
          ...(body.issuedToId !== undefined ? { issuedToId: body.issuedToId || null } : {}),
          ...(body.issuedToName !== undefined ? { issuedToName: body.issuedToName || null } : {}),
          issueDate,
          ...(body.purpose !== undefined ? { purpose: body.purpose } : {}),
          ...(body.notes !== undefined ? { notes: body.notes || null } : {}),
        },
      });
      if (!claimed.count) throw badRequest(`${issue.number} was changed or issued a moment ago — reload to see where it stands`);
      for (const line of issue.items) {
        const price = reprice.get(line.id);
        const costCategoryId = categoryFills.get(line.id);
        if (!price && !costCategoryId) continue;
        await tx.stockIssueItem.update({
          where: { id: line.id },
          data: { ...(price ?? {}), ...(costCategoryId ? { costCategoryId } : {}) },
        });
      }
      await audit(
        {
          entityType: 'stock_issue',
          entityId: issue.id,
          action: 'UPDATED',
          summary: `Modified ${issue.number}${changed.length ? `: ${changed.join(', ')}` : ''}`,
        },
        req,
        tx,
      );
    });

    res.json(presentIssue((await loadIssue(issue.id))!));
  }),
);

/**
 * Cancels a draft or pending outgoing slip (2026-10-19, the owner's call):
 * whoever may change it, the reason kept; a pending one's request is
 * withdrawn in the same transaction. Neither moved any stock. An issued slip
 * is pulled back to a draft first, which puts the stock back.
 */
stockIssueRoutes.post(
  '/:id/cancel',
  requireAny(...ISSUE_EDIT),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(z.object({ reason: z.string().trim().min(3, 'Say why it is cancelled').max(2000) }), req.body);
    const issue = await prisma.stockIssue.findUnique({ where: { id: req.params.id } });
    if (!issue) throw notFound('Stock issue not found');
    assertChangeIssue(me, issue);
    if (issue.status === 'CANCELLED') throw badRequest(`${issue.number} is already cancelled`);
    if (issue.status !== 'DRAFT' && issue.status !== 'PENDING_APPROVAL') {
      throw badRequest(`${issue.number} has been issued — pull it back to a draft first, then cancel it`);
    }
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.stockIssue.updateMany({ where: { id: issue.id, status: issue.status }, data: { status: 'CANCELLED', cancelReason: body.reason } });
      if (!claimed.count) throw badRequest(`${issue.number} changed a moment ago — reload to see where it stands`);
      if (issue.status === 'PENDING_APPROVAL') {
        const withdrawn = await cancelOpenRequest(ISSUE_DOC, issue.id, tx, `cancelled by ${me.name}: ${body.reason}`, me.id);
        if (!withdrawn.length) throw badRequest(`${issue.number} was decided a moment ago — reload to see where it stands`);
      }
    });
    await audit({ entityType: 'stock_issue', entityId: issue.id, action: 'CANCELLED', summary: `${issue.number} cancelled — ${body.reason}` }, req);
    res.json(await issueView((await loadIssue(issue.id))!, me));
  }),
);

/**
 * A draft or a CANCELLED slip is deleted outright — nothing has moved: the
 * delete right, and whoever may change it. An issued one is the record of
 * stock that left. Its files go after the commit.
 */
stockIssueRoutes.delete(
  '/:id',
  require_('gchain.stock_issuance.delete'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const issue = await prisma.stockIssue.findUnique({ where: { id: req.params.id } });
    if (!issue) throw notFound('Stock issue not found');
    assertChangeIssue(me, issue);
    if (issue.status !== 'DRAFT' && issue.status !== 'CANCELLED') {
      throw badRequest(`Only a draft or a cancelled slip can be deleted — ${issue.number} is ${statusLabel(issue.status).toLowerCase()}`);
    }
    const gone = await prisma.stockIssue.deleteMany({ where: { id: issue.id, status: { in: ['DRAFT', 'CANCELLED'] } } });
    if (!gone.count) throw badRequest(`${issue.number} changed a moment ago — it stays on record`);
    await deleteAttachmentsOf('stock_issue', [issue.id]);
    await audit(
      { entityType: 'stock_issue', entityId: issue.id, action: 'DELETED', summary: `Deleted ${issue.status === 'CANCELLED' ? 'cancelled' : 'draft'} ${issue.number}` },
      req,
    );
    res.json({ ok: true });
  }),
);

stockIssueRoutes.post(
  '/:id/items',
  requireAny(...ISSUE_EDIT),
  handler(async (req, res) => {
    const issue = await issueForEdit(req.params.id, currentUser(req));
    const body = parseBody(
      z.object({
        itemId: z.string().min(1),
        costCategoryId: z.string().optional().nullable(),
        locationId: z.string().optional().nullable(),
        quantity: z.number().positive(),
        remarks: z.string().optional().nullable(),
      }),
      req.body,
    );

    // Costing a job issue needs a category; the item's default fills it in.
    const item = await prisma.item.findUnique({ where: { id: body.itemId } });
    if (!item) throw badRequest('That item does not exist');
    let costCategoryId = body.costCategoryId || null;
    if (issue.jobId && !costCategoryId) {
      costCategoryId = item.costCategoryId ?? null;
      if (!costCategoryId) {
        throw badRequest(
          'That item has no cost bucket, so the issue cannot be charged to a budget line. Set one on the item, or choose a category here.',
        );
      }
    }

    // Priced at the current average, shown before the issue is committed.
    const balance = await prisma.inventoryBalance.findUnique({
      where: { itemId_warehouseId: { itemId: body.itemId, warehouseId: issue.warehouseId } },
    });
    const unitCost = num(balance?.averageCost);

    await prisma.$transaction(async (tx) => {
      await holdDraftIssue(tx, issue);
      await tx.stockIssueItem.create({
        data: {
          issueId: issue.id,
          itemId: body.itemId,
          costCategoryId,
          locationId: body.locationId || null,
          quantity: D(body.quantity),
          unitCost: D(unitCost),
          amount: D(cents(body.quantity * unitCost)),
          remarks: body.remarks || null,
        },
      });
    });
    await audit(
      { entityType: 'stock_issue', entityId: issue.id, action: 'UPDATED', summary: `Added ${item.name} to ${issue.number}` },
      req,
    );

    res.status(201).json(presentIssue((await loadIssue(issue.id))!));
  }),
);

stockIssueRoutes.delete(
  '/:id/items/:itemId',
  requireAny(...ISSUE_EDIT),
  handler(async (req, res) => {
    const issue = await issueForEdit(req.params.id, currentUser(req));
    const line = await prisma.stockIssueItem.findFirst({
      where: { id: req.params.itemId, issueId: req.params.id },
      include: { item: { select: { name: true } } },
    });
    if (!line) throw notFound('Line not found');
    await prisma.$transaction(async (tx) => {
      await holdDraftIssue(tx, issue);
      await tx.stockIssueItem.delete({ where: { id: line.id } });
    });
    await audit(
      { entityType: 'stock_issue', entityId: issue.id, action: 'UPDATED', summary: `Removed ${line.item.name} from ${issue.number}` },
      req,
    );
    res.json(presentIssue((await loadIssue(req.params.id))!));
  }),
);

/**
 * Posting the issue: stock leaves, and if it is for a job, the job is
 * charged. This is where stock-sourced material first hits a project (§4.3).
 * Inside the caller's transaction, AFTER its claim — Issue (no route) or the
 * route's approval — so it runs once whatever presses twice.
 */
async function postStockIssue(tx: Prisma.TransactionClient, issueId: string, actorId: string) {
  const current = await tx.stockIssue.findUniqueOrThrow({
    where: { id: issueId },
    include: { items: true, job: { select: { number: true } } },
  });
  if (!current.items.length) throw badRequest('Add at least one line before issuing');

  const byCategory = new Map<string, number>();
  // The project's own stock: charged at receiving, so only CONSUMED here.
  const ownByCategory = new Map<string, number>();

  for (const line of current.items) {
    if (line.projectStock) {
      if (!current.jobId) throw badRequest(`${current.number} draws project stock but names no project`);
      const moved = await issueProjectStock(tx, {
        jobId: current.jobId,
        itemId: line.itemId,
        warehouseId: current.warehouseId,
        quantity: num(line.quantity),
        sourceType: 'stock_issue',
        sourceId: current.id,
        sourceNumber: current.number,
        createdById: actorId,
      });
      await tx.stockIssueItem.update({ where: { id: line.id }, data: { unitCost: D(moved.unitCost), amount: D(moved.amount) } });
      if (line.costCategoryId) ownByCategory.set(line.costCategoryId, (ownByCategory.get(line.costCategoryId) ?? 0) + moved.amount);
      continue;
    }
    const moved = await issueStock(tx, {
      itemId: line.itemId,
      warehouseId: current.warehouseId,
      quantity: num(line.quantity),
      sourceType: 'stock_issue',
      sourceId: current.id,
      sourceNumber: current.number,
      createdById: actorId,
    });

    // Re-price at the average as at the moment of issue, which may have
    // moved since the line was added.
    await tx.stockIssueItem.update({
      where: { id: line.id },
      data: { unitCost: D(moved.unitCost), amount: D(moved.amount) },
    });

    if (current.jobId && line.costCategoryId) {
      byCategory.set(line.costCategoryId, (byCategory.get(line.costCategoryId) ?? 0) + moved.amount);
    }
  }

  if (current.jobId) {
    for (const [costCategoryId, amount] of byCategory) {
      // INCURRED — this is the first time the job bears this cost.
      await postJobCost(tx, {
        jobId: current.jobId,
        costCategoryId,
        state: 'INCURRED',
        amount,
        sourceType: 'stock_issue',
        sourceId: current.id,
        sourceNumber: current.number,
        description: `Issued from stock — ${current.purpose}`,
        createdById: actorId,
      });
      // CONSUMED — and it is physically in the work. Reported, not
      // subtracted again; see budgetPosition.
      await postJobCost(tx, {
        jobId: current.jobId,
        costCategoryId,
        state: 'CONSUMED',
        amount,
        sourceType: 'stock_issue',
        sourceId: current.id,
        sourceNumber: current.number,
        description: `Issued from stock — ${current.purpose}`,
        createdById: actorId,
      });
    }
    for (const [costCategoryId, amount] of ownByCategory) {
      await postJobCost(tx, {
        jobId: current.jobId,
        costCategoryId,
        state: 'CONSUMED',
        amount,
        sourceType: 'stock_issue',
        sourceId: current.id,
        sourceNumber: current.number,
        description: `Issued from the project's own stock — ${current.purpose}`,
        createdById: actorId,
      });
    }
  }
  return current;
}

/**
 * Issue now — only while no Outgoing route is active (an install that
 * deactivated it); otherwise the slip goes for approval and its approval
 * issues it. Claimed first, on the draft as it was read.
 */
stockIssueRoutes.post(
  '/:id/issue',
  require_('gchain.stock_issuance.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const issue = await prisma.stockIssue.findUnique({
      where: { id: req.params.id },
      include: { items: { select: { id: true, amount: true } } },
    });
    if (!issue) throw notFound('Stock issue not found');
    if (issue.status !== 'DRAFT') throw badRequest('This issue has already been made');
    if (!issue.items.length) throw badRequest('Add at least one line before issuing');
    const value = cents(issue.items.reduce((s, i) => s + num(i.amount), 0));
    if (await pickWorkflow(ISSUE_DOC, value, { requesterId: issue.issuedById })) {
      throw badRequest(`${issue.number} goes for approval — Submit for approval, and its approval issues it`);
    }

    const issued = await prisma.$transaction(async (tx) => {
      // Claimed first, on the draft as it was read: a second press, or a
      // Modify that moved it to another warehouse or project since, finds
      // nothing to claim — so stock never leaves twice, nor from a warehouse
      // the record no longer names. Everything issued below is read again
      // under the claim.
      const claimed = await tx.stockIssue.updateMany({
        where: { id: issue.id, status: 'DRAFT', warehouseId: issue.warehouseId, jobId: issue.jobId },
        data: { status: 'ISSUED', issuedAt: new Date() },
      });
      if (!claimed.count) throw badRequest(`${issue.number} was changed or issued a moment ago — reload to see where it stands`);
      return postStockIssue(tx, issue.id, me.id);
    });

    await audit(
      {
        entityType: 'stock_issue',
        entityId: issued.id,
        action: 'EXECUTED',
        summary: `${issued.number} issued${issued.job ? ` to ${issued.job.number}` : ''}`,
      },
      req,
    );
    await tellIssuedTo(issue.id);

    res.json(await issueView((await loadIssue(issue.id))!, me));
  }),
);

/**
 * Submit for approval: claims the DRAFT on what it was read as (its lines,
 * warehouse and project can no longer move under the approver), checks the
 * warehouse holds every line now, and files the request in the ISSUER's name
 * whoever presses it — so the issuer's own supervisor decides. A refused
 * submit puts it back to a draft.
 */
stockIssueRoutes.post(
  '/:id/submit',
  requireAny(...ISSUE_EDIT),
  handler(async (req, res) => {
    const me = currentUser(req);
    const issue = await prisma.stockIssue.findUnique({
      where: { id: req.params.id },
      include: { items: { include: { item: { select: { name: true } } } }, job: { select: { number: true } }, warehouse: { select: { name: true } } },
    });
    if (!issue) throw notFound('Stock issue not found');
    assertChangeIssue(me, issue);
    if (issue.status !== 'DRAFT') throw badRequest(`${issue.number} is ${statusLabel(issue.status).toLowerCase()}`);
    if (!issue.items.length) throw badRequest('Add at least one line before submitting');
    // What the warehouse holds now — a slip the shelf cannot fill is not sent up.
    const balances = await prisma.inventoryBalance.findMany({
      where: { warehouseId: issue.warehouseId, itemId: { in: issue.items.map((l) => l.itemId) } },
    });
    const byItem = new Map(balances.map((b) => [b.itemId, b]));
    const short = issue.items.filter((l) => {
      const b = byItem.get(l.itemId);
      return !b || availableOf(b) < num(l.quantity) - 0.0005;
    });
    if (short.length) {
      throw badRequest(`${issue.warehouse.name} does not have enough of ${short.map((l) => l.item.name).join(', ')} available to issue`);
    }
    const value = cents(issue.items.reduce((s, i) => s + num(i.amount), 0));
    const claimed = await prisma.stockIssue.updateMany({
      where: { id: issue.id, status: 'DRAFT', updatedAt: issue.updatedAt },
      data: { status: 'PENDING_APPROVAL' },
    });
    if (!claimed.count) throw badRequest(`${issue.number} changed a moment ago — reload to see where it stands`);
    try {
      await submitForApproval({
        documentType: ISSUE_DOC,
        documentId: issue.id,
        documentNumber: issue.number,
        subject: `${issue.job ? `${issue.job.number} — ` : ''}${issue.purpose}`,
        amount: value,
        link: `/g-chain/outgoing/${issue.id}`,
        requesterId: issue.issuedById,
      });
    } catch (err) {
      await prisma.stockIssue.updateMany({ where: { id: issue.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
      throw err;
    }
    await audit({ entityType: 'stock_issue', entityId: issue.id, action: 'SUBMITTED', summary: `${issue.number} submitted for approval` }, req);
    res.json(await issueView((await loadIssue(issue.id))!, me));
  }),
);

/** Pulls a pending slip back to a draft — the request withdrawn in the same transaction; a decision that landed first wins. */
stockIssueRoutes.post(
  '/:id/withdraw',
  requireAny(...ISSUE_EDIT),
  handler(async (req, res) => {
    const me = currentUser(req);
    const issue = await prisma.stockIssue.findUnique({ where: { id: req.params.id } });
    if (!issue) throw notFound('Stock issue not found');
    assertChangeIssue(me, issue);
    if (issue.status !== 'PENDING_APPROVAL') throw badRequest(`${issue.number} is not waiting for approval`);
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.stockIssue.updateMany({ where: { id: issue.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
      if (!claimed.count) throw badRequest(`${issue.number} was decided a moment ago — reload to see where it stands`);
      const withdrawn = await cancelOpenRequest(ISSUE_DOC, issue.id, tx, `pulled back by ${me.name}`, me.id);
      if (!withdrawn.length) throw badRequest(`${issue.number} was decided a moment ago — reload to see where it stands`);
    });
    await audit({ entityType: 'stock_issue', entityId: issue.id, action: 'UPDATED', summary: `${issue.number} pulled back to a draft` }, req);
    res.json(await issueView((await loadIssue(issue.id))!, me));
  }),
);

/**
 * The route's decision. Approved: claims PENDING_APPROVAL → ISSUED and
 * posts in the same transaction — once, whatever calls it twice. If the
 * shelf no longer holds the quantities (something else left meanwhile) the
 * slip goes back to a draft, said on its trail and to the issuer, rather
 * than issuing stock that is not there. Returned or rejected: back to a
 * draft. A decision that finds the slip no longer pending changes nothing.
 */
export async function settleStockIssue(documentId: string, outcome: ApprovalOutcome) {
  const issue = await prisma.stockIssue.findUnique({ where: { id: documentId } });
  if (!issue) return;
  if (outcome !== 'APPROVED') {
    const back = await prisma.stockIssue.updateMany({ where: { id: issue.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
    if (!back.count) await warehouseNotApplied('stock_issue', issue.id, issue.number, issue.status, outcome);
    return;
  }
  let posted: Awaited<ReturnType<typeof postStockIssue>> | null = null;
  try {
    posted = await prisma.$transaction(async (tx) => {
      const claimed = await tx.stockIssue.updateMany({ where: { id: issue.id, status: 'PENDING_APPROVAL' }, data: { status: 'ISSUED', issuedAt: new Date() } });
      if (!claimed.count) return null;
      return postStockIssue(tx, issue.id, issue.issuedById);
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'the stock could not be moved';
    const back = await prisma.stockIssue.updateMany({ where: { id: issue.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
    if (back.count) {
      await audit({ entityType: 'stock_issue', entityId: issue.id, action: 'UPDATED', summary: `${issue.number} approved, but not issued — ${reason}; back to a draft`, actorName: 'system' });
      await notify({
        userId: issue.issuedById,
        type: 'warehouse.not_posted',
        title: `${issue.number} approved but not issued`,
        body: `${reason}. It is a draft again — change it and submit it again.`,
        link: `/g-chain/outgoing/${issue.id}`,
      });
    }
    return;
  }
  if (!posted) {
    const now = await prisma.stockIssue.findUnique({ where: { id: issue.id }, select: { status: true } });
    await warehouseNotApplied('stock_issue', issue.id, issue.number, now?.status ?? issue.status, outcome);
    return;
  }
  await audit({
    entityType: 'stock_issue',
    entityId: issue.id,
    action: 'EXECUTED',
    summary: `${issue.number} issued${posted.job ? ` to ${posted.job.number}` : ''} — approved`,
    actorName: 'system',
  });
  await tellIssuedTo(issue.id);
}

onApprovalSettled(ISSUE_DOC, async (request, outcome) => {
  await settleStockIssue(request.documentId, outcome);
});

/**
 * Pulled back after approval (2026-10-16): ISSUED → DRAFT, the stock put
 * back at the cost each line left at and the project's cost reversed by rows
 * of its own. Refused once the person it went to confirmed receiving it —
 * that confirmation is the slip's record of fact.
 */
onApprovalReopened(ISSUE_DOC, {
  may: async (actor, id) => {
    const issue = await prisma.stockIssue.findUnique({ where: { id }, select: { issuedById: true } });
    return (
      !!issue &&
      ((issue.issuedById === actor.id && (can(actor, 'gchain.stock_issuance.create') || can(actor, 'gchain.stock_issuance.edit_own'))) ||
        can(actor, 'gchain.stock_issuance.edit_all'))
    );
  },
  reopen: async ({ documentId, tx, actor, reason }) => {
    const issue = await tx.stockIssue.findUnique({ where: { id: documentId }, include: { items: true } });
    if (!issue) throw notFound('Stock issue not found');
    if (issue.status !== 'ISSUED') throw badRequest(`${issue.number} is ${statusLabel(issue.status).toLowerCase()} — only an issued slip is pulled back`);
    if (issue.receivedAt) throw badRequest(`${issue.number} was confirmed received — it cannot be pulled back`);
    const claimed = await tx.stockIssue.updateMany({
      where: { id: issue.id, status: 'ISSUED', receivedAt: null },
      data: { status: 'DRAFT', issuedAt: null },
    });
    if (!claimed.count) throw badRequest(`${issue.number} changed a moment ago — reload to see where it stands`);
    const why = `${issue.number} pulled back to draft by ${actor.name}: ${reason}`;
    for (const line of issue.items) {
      if (line.projectStock && issue.jobId) {
        await receiveProjectStock(tx, {
          jobId: issue.jobId,
          itemId: line.itemId,
          warehouseId: issue.warehouseId,
          quantity: num(line.quantity),
          unitCost: num(line.unitCost),
          sourceType: 'stock_issue',
          sourceId: issue.id,
          sourceNumber: issue.number,
          notes: why,
          createdById: actor.id,
        });
        continue;
      }
      await returnIssuedStock(tx, {
        itemId: line.itemId,
        warehouseId: issue.warehouseId,
        quantity: num(line.quantity),
        unitCost: num(line.unitCost),
        sourceType: 'stock_issue',
        sourceId: issue.id,
        sourceNumber: issue.number,
        notes: why,
        createdById: actor.id,
      });
    }
    await reverseJobCost(tx, { sourceType: 'stock_issue', sourceId: issue.id, reason: why, sourceNumber: issue.number, createdById: actor.id });
  },
});

// The signed gate pass, photos of what left: read as the slip is read, added
// while it is a draft or pending by whoever may raise one.
registerAttachmentGuard(
  'stock_issue',
  async (user, id) => {
    if (can(user, ISSUE_VIEW)) return !!(await prisma.stockIssue.findUnique({ where: { id }, select: { id: true } }));
    if ((await prisma.stockIssue.count({ where: { id, issuedToId: user.id } })) > 0) return true;
    if (can(user, ISSUE_VIEW_OWN) && (await prisma.stockIssue.count({ where: { id, issuedById: user.id } })) > 0) return true;
    return mayDecide(user.id, ISSUE_DOC, [id]);
  },
  {
    write: async (user, id) => {
      const r = await prisma.stockIssue.findUnique({ where: { id }, select: { status: true, issuedById: true } });
      return !!r && (r.status === 'DRAFT' || r.status === 'PENDING_APPROVAL') && mayChangeIssue(user, r);
    },
  },
);

// ════════════════════════════════════════════════════════════════════
//  BORROW SLIPS
// ════════════════════════════════════════════════════════════════════

export const borrowRoutes = Router();
borrowRoutes.use(authenticate);

/**
 * Borrow slips (2026-10-14, the owner's call: "anyone can request to borrow;
 * approval by the Team Leader / Technical Manager they report to or within
 * the team; the warehouse processes it, with its reports-to's approval").
 *
 * A REQUEST is DRAFT → PENDING_APPROVAL → APPROVED, and nothing leaves the
 * shelf until the warehouse RELEASES it (OUT): only then is the stock moved
 * out of available. With the route switched off, a request from anyone but
 * the warehouse is saved APPROVED (waiting for the release), and the
 * warehouse's own slip for a walk-in goes OUT at once, as it always did.
 * A borrow slip never charges job cost — the tool is on loan, not consumed.
 */
const BORROW_DOC = 'borrow_slip';
const BORROW_VIEW_ALL = 'gchain.borrow_slips.view_all';
/** The warehouse: releases, takes returns, modifies a slip on loan, names any borrower. */
const BORROW_WAREHOUSE = 'gchain.borrow_slips.edit_all';
const BORROW_SORTS = ['number', 'dueAt', 'borrowedAt', 'neededOn'];
/** A slip with something still out on it. */
const ON_LOAN: BorrowStatus[] = ['OUT', 'PARTIALLY_RETURNED', 'OVERDUE'];

/** The borrower's slip (2026-10-15, the owner's form): why it is borrowed, and what came back. */
export const BORROW_TYPES: Record<BorrowType, string> = {
  INTERNAL_OFFICE: 'Internal / office use',
  ON_SITE_PROJECT: 'On-site project / customer site',
  PERSONAL: 'Personal request',
  RND_TESTING: 'R&D / testing',
};
export const RETURN_CONDITIONS: Record<ReturnCondition, string> = {
  COMPLETE_GOOD: 'Complete / good',
  DAMAGED: 'Damaged',
  MISSING_PARTS: 'Missing parts',
};

/** What a reader without the register's right sees: what they asked for and what they hold. */
const mineWhere = (me: ResolvedUser): Prisma.BorrowSlipWhereInput => ({ OR: [{ requestedById: me.id }, { borrowerId: me.id }] });
const partyTo = (me: ResolvedUser, slip: { requestedById: string | null; borrowerId: string | null }) =>
  slip.requestedById === me.id || slip.borrowerId === me.id;

/**
 * Which borrow slips a list query means — one rule for the list, its summary
 * cards and its printed twin. `base` is everything but the status (the cards
 * count under it); `day` is the one "today" for the Overdue filter, each
 * row's flag and both dashboard tiles. Overdue, when asked, decides the
 * status by itself.
 */
function borrowListWhere(me: ResolvedUser, q: ListQuery, day: Date) {
  const base: Prisma.BorrowSlipWhereInput[] = [];
  if (!can(me, BORROW_VIEW_ALL) || q.scope === 'mine') base.push(mineWhere(me));
  if (q.filters.jobId) base.push({ jobId: q.filters.jobId });
  if (q.search) {
    base.push({
      OR: [
        { number: { contains: q.search, mode: 'insensitive' } },
        { borrowerName: { contains: q.search, mode: 'insensitive' } },
        { purpose: { contains: q.search, mode: 'insensitive' } },
        { siteLocation: { contains: q.search, mode: 'insensitive' } },
        { requestedBy: { name: { contains: q.search, mode: 'insensitive' } } },
      ],
    });
  }
  const ids = idsFilter(q.filters.ids);
  if (ids) base.push({ id: { in: ids } });
  const borrowType = choice(q.filters.borrowType, BorrowType, 'Borrowing type');
  if (borrowType) base.push({ borrowType });
  const and = [...base];
  if (q.filters.overdue === 'true') and.push({ status: { in: ['OUT', 'PARTIALLY_RETURNED'] }, dueAt: { lt: day } });
  else {
    const status = choice(q.filters.status, BorrowStatus, 'Status');
    if (status) and.push({ status });
  }
  const join = (parts: Prisma.BorrowSlipWhereInput[]): Prisma.BorrowSlipWhereInput => (parts.length ? { AND: parts } : {});
  return { base: join(base), where: join(and) };
}

/**
 * How late a slip is, against the DAY, not the instant: dueAt is a date, held
 * as UTC midnight, so `dueAt < new Date()` flagged a slip from 08:00 on the
 * day it was due back. 0 for a slip that is back, not yet out or not yet due.
 */
function daysOverdue(slip: { status: string; dueAt: Date }, day: Date): number {
  const out = slip.status === 'OUT' || slip.status === 'PARTIALLY_RETURNED';
  return out && slip.dueAt < day ? Math.floor((day.getTime() - slip.dueAt.getTime()) / 86400000) : 0;
}

/** What is still out on a slip, across its lines — nothing before it is released. */
const stillOut = (slip: { status: BorrowStatus; items: { quantity: Prisma.Decimal; returnedQty: Prisma.Decimal }[] }) =>
  ON_LOAN.includes(slip.status) ? cents(slip.items.reduce((s, i) => s + num(i.quantity) - num(i.returnedQty), 0)) : 0;

/** The summary cards: what waits on an approver, what waits on the warehouse, what is out and late. */
async function borrowSummary(base: Prisma.BorrowSlipWhereInput, day: Date) {
  const count = (extra: Prisma.BorrowSlipWhereInput) => prisma.borrowSlip.count({ where: { AND: [base, extra] } });
  const [awaitingApproval, toRelease, onLoan, overdue] = await Promise.all([
    count({ status: 'PENDING_APPROVAL' }),
    count({ status: 'APPROVED' }),
    count({ status: { in: ['OUT', 'PARTIALLY_RETURNED'] } }),
    count({ status: { in: ['OUT', 'PARTIALLY_RETURNED'] }, dueAt: { lt: day } }),
  ]);
  return { awaitingApproval, toRelease, onLoan, overdue };
}

borrowRoutes.get(
  '/',
  requireAny(BORROW_VIEW_ALL, 'gchain.borrow_slips.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const day = today();
    const { base, where } = borrowListWhere(me, q, day);

    const [rows, total, summary] = await Promise.all([
      prisma.borrowSlip.findMany({
        where,
        include: {
          job: { select: { id: true, number: true, name: true } },
          warehouse: { select: { id: true, name: true } },
          requestedBy: { select: { id: true, name: true } },
          items: { include: { item: { select: { id: true, code: true, name: true } } } },
        },
        orderBy: orderBy(q, BORROW_SORTS, { createdAt: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.borrowSlip.count({ where }),
      borrowSummary(base, day),
    ]);

    res.json({
      ...listResult(
        rows.map((r) => {
          const late = daysOverdue(r, day);
          return {
            id: r.id,
            number: r.number,
            status: r.status,
            borrowerName: r.borrowerName,
            requestedBy: r.requestedBy,
            purpose: r.purpose,
            borrowType: r.borrowType,
            borrowTypeLabel: r.borrowType ? BORROW_TYPES[r.borrowType] : null,
            siteLocation: r.siteLocation,
            neededOn: r.neededOn,
            borrowedAt: r.borrowedAt,
            dueAt: r.dueAt,
            returnedAt: r.returnedAt,
            released: ON_LOAN.includes(r.status) || r.status === 'RETURNED',
            job: r.job,
            warehouse: r.warehouse,
            itemCount: r.items.length,
            outstandingQty: stillOut(r),
            isOverdue: late > 0,
            daysOverdue: late,
          };
        }),
        total,
        q,
      ),
      summary,
    });
  }),
);

/**
 * The borrow slip list on paper, through `borrowListWhere` (or the rows
 * ticked, `?ids=`), with the same "today" deciding what is overdue — a slip
 * past its date prints "Overdue, n days" where the screen shows its badge.
 * Above `/:id`.
 */
borrowRoutes.get(
  '/pdf',
  requireAny(BORROW_VIEW_ALL, 'gchain.borrow_slips.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const day = today();
    const { where } = borrowListWhere(me, q, day);
    const f = q.filters;
    const [rows, count, project] = await Promise.all([
      prisma.borrowSlip.findMany({
        where,
        include: {
          job: { select: { number: true } },
          requestedBy: { select: { name: true } },
          items: { select: { quantity: true, returnedQty: true } },
        },
        orderBy: orderBy(q, BORROW_SORTS, { createdAt: 'desc' }),
        take: LIST_CAP,
      }),
      prisma.borrowSlip.count({ where }),
      recordNamed('project', f.jobId),
    ]);
    const reference = listReference(count, rows.length, ['borrow slip', 'borrow slips'], [
      q.search && `search "${q.search}"`,
      f.overdue === 'true' ? 'overdue' : f.status && `status ${statusLabel(f.status)}`,
      project,
      !can(me, BORROW_VIEW_ALL) || q.scope === 'mine' ? 'mine' : null,
      f.ids && 'the rows selected',
    ]);

    // Eight columns: landscape, each sized from what it holds (rule 6).
    const pdf = await renderDocument({
      title: 'Borrow Slips',
      date: new Date(),
      reference,
      landscape: true,
      sections: [
        {
          kind: 'table',
          head: ['Number', 'Borrower', 'Project', 'Out', 'Due back', 'Items', 'Still out', 'Status'],
          align: ['left', 'left', 'left', 'left', 'left', 'right', 'right', 'left'],
          rows: rows.map((b) => {
            const late = daysOverdue(b, day);
            const out = stillOut(b);
            const released = ON_LOAN.includes(b.status) || b.status === 'RETURNED';
            return [
              b.number,
              { title: b.borrowerName, body: b.requestedBy && b.requestedBy.name !== b.borrowerName ? `${b.purpose} — asked by ${b.requestedBy.name}` : b.purpose },
              b.job?.number ?? '',
              released ? formatShortDate(b.borrowedAt) : '',
              formatShortDate(b.dueAt),
              String(b.items.length),
              out ? qty(out) : '',
              late ? `Overdue, ${late} day${late === 1 ? '' : 's'}` : statusLabel(b.status),
            ];
          }),
        },
      ],
    });
    await audit(
      { entityType: 'borrow_slip', entityId: 'list', action: 'EXPORTED', summary: `Exported the borrow slip list as PDF (${rows.length} slip(s))` },
      req,
    );
    sendListPdf(res, pdf, 'borrow-slips.pdf');
  }),
);

/**
 * What the request form offers (above `/:id`): the active warehouses; with
 * `?warehouseId=`, that warehouse's items with what is AVAILABLE now (on hand
 * less what is already lent) — names, codes and units, never a cost; the open
 * projects by number and name (naming the project you borrow for is not the
 * right to read it); and whether the caller may name somebody else as the
 * borrower (the warehouse's walk-in slip).
 */
borrowRoutes.get(
  '/options',
  require_('gchain.borrow_slips.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const warehouseId = typeof req.query.warehouseId === 'string' ? req.query.warehouseId : '';
    const [warehouses, jobs, stock] = await Promise.all([
      prisma.warehouse.findMany({ where: { isActive: true }, select: { id: true, code: true, name: true }, orderBy: { name: 'asc' } }),
      prisma.job.findMany({
        where: { status: { in: ['PLANNING', 'IN_PROGRESS', 'ON_HOLD'] } },
        select: { id: true, number: true, name: true },
        orderBy: { number: 'desc' },
        take: 300,
      }),
      warehouseId
        ? prisma.inventoryBalance.findMany({
            where: { warehouseId, item: { isActive: true } },
            include: { item: { select: { id: true, code: true, name: true, unit: true } } },
            orderBy: { item: { name: 'asc' } },
          })
        : [],
    ]);
    res.json({
      warehouses,
      jobs,
      items: stock.map((b) => ({ ...b.item, available: availableOf(b) })).filter((i) => i.available > 0),
      mayNameBorrower: can(me, BORROW_WAREHOUSE),
    });
  }),
);

async function loadSlip(id: string) {
  return prisma.borrowSlip.findUnique({
    where: { id },
    include: {
      job: { select: { id: true, number: true, name: true } },
      warehouse: { select: { id: true, name: true } },
      issuedBy: { select: { id: true, name: true } },
      requestedBy: { select: { id: true, name: true } },
      inspectedBy: { select: { id: true, name: true } },
      borrower: { select: { id: true, name: true, employeeNo: true, position: true, employee: { select: { industry: { select: { code: true } } } } } },
      items: { include: { item: { select: { id: true, code: true, partNumber: true, brand: true, name: true, unit: true } } } },
    },
  });
}
type LoadedSlip = NonNullable<Awaited<ReturnType<typeof loadSlip>>>;

/**
 * The slip as its reader may see it: the register's right; its requester or
 * borrower (view_own); or — through `requireAnyOrDecider` — whoever may
 * decide its open request, only while it waits on them. Anyone else: 404.
 */
async function visibleSlip(me: ResolvedUser, id: string, deciderOnly: boolean): Promise<LoadedSlip> {
  const slip = await loadSlip(id);
  if (!slip) throw notFound('Borrow slip not found');
  if (can(me, BORROW_VIEW_ALL) && !deciderOnly) return slip;
  if (!deciderOnly && can(me, 'gchain.borrow_slips.view_own') && partyTo(me, slip)) return slip;
  if (await mayDecide(me.id, BORROW_DOC, [slip.id])) return slip;
  throw notFound('Borrow slip not found');
}

/** Whoever may move a request on — modify, submit, pull back, cancel: who asked for it, or the warehouse. */
const mayHandleRequest = (me: ResolvedUser, slip: { requestedById: string | null; borrowerId: string | null }) =>
  can(me, BORROW_WAREHOUSE) || (can(me, 'gchain.borrow_slips.edit_own') && slip.requestedById === me.id);

async function presentSlip(slip: LoadedSlip, me: ResolvedUser) {
  const draft = slip.status === 'DRAFT';
  const handles = mayHandleRequest(me, slip);
  const warehouse = can(me, BORROW_WAREHOUSE);
  const route = draft ? await pickWorkflow(BORROW_DOC, null, { requesterId: slip.requestedById ?? me.id }) : null;
  const day = today();
  return {
    ...slip,
    // A draft request is changed on its page by who asked for it or the
    // warehouse; a slip on loan only by the warehouse, and only who, when due
    // back, what for and the notes (PATCH /:id) — the stock has moved.
    canEdit: (draft && handles) || (warehouse && [...ON_LOAN, 'APPROVED'].includes(slip.status)),
    canEditSheet: draft && handles,
    needsApproval: draft ? !!route : null,
    canSubmit: draft && handles && !!route && slip.items.length > 0,
    canWithdraw: slip.status === 'PENDING_APPROVAL' && handles,
    canCancel: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(slip.status) && handles,
    canDelete: (draft || slip.status === 'CANCELLED') && handles && can(me, 'gchain.borrow_slips.delete'),
    canRelease: slip.status === 'APPROVED' && warehouse,
    canReturn: ON_LOAN.includes(slip.status) && warehouse,
    approvalRoute: draft && route ? await routeBrief(BORROW_DOC, null, slip.requestedById ?? me.id) : null,
    isOverdue: daysOverdue(slip, day) > 0,
    daysOverdue: daysOverdue(slip, day),
    borrowTypeLabel: slip.borrowType ? BORROW_TYPES[slip.borrowType] : null,
    returnedConditionLabel: slip.returnedCondition ? RETURN_CONDITIONS[slip.returnedCondition] : null,
    items: slip.items.map((i) => ({
      ...i,
      quantity: num(i.quantity),
      returnedQty: num(i.returnedQty),
      outstandingQty: ON_LOAN.includes(slip.status) ? cents(num(i.quantity) - num(i.returnedQty)) : 0,
    })),
  };
}

borrowRoutes.get(
  '/:id',
  requireAnyOrDecider(BORROW_VIEW_ALL, 'gchain.borrow_slips.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const slip = await visibleSlip(me, req.params.id, res.locals.deciderOnly === true);
    res.json(await presentSlip(slip, me));
  }),
);

/**
 * The slip on paper — the EQUIPMENT & TOOL BORROWER'S SLIP (2026-10-15, the
 * owner's form as the guide), in its five sections: the borrower's details
 * (name, employee no., team, contact, the borrowing type), the
 * equipment and tools (each line's serial, condition out and what came
 * back), the reason and destination (project, site, purpose), the people who
 * acted — REQUESTED BY (who asked for it, its first slot's timestamp), the
 * route's two steps ("Pending" until signed; a draft prints the route
 * submitting would take), RELEASED BY (whoever released it, when; a slip the
 * warehouse wrote before requests prints ISSUED BY) — and the return
 * clearance: what the custodian recorded, or the lines left blank for them
 * while anything is still out.
 */
borrowRoutes.get(
  '/:id/pdf',
  requireAnyOrDecider(BORROW_VIEW_ALL, 'gchain.borrow_slips.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const slip = await visibleSlip(me, req.params.id, res.locals.deciderOnly === true);
    const requester = slip.requestedById ?? slip.issuedById;
    const slots =
      slip.status === 'DRAFT' && requester
        ? await approvalSlots(BORROW_DOC, slip.id, { amount: null, requesterId: requester })
        : await approvalSlots(BORROW_DOC, slip.id);
    const signatories: Signatory[] = [];
    if (slip.requestedBy) {
      signatories.push({
        role: 'Requested by',
        name: slip.requestedBy.name,
        ...(await contactOf(slip.requestedBy.id)),
        at: preparedAt(slots) ?? slip.createdAt,
      });
    }
    signatories.push(...slotSignatories(slots));
    const released = ON_LOAN.includes(slip.status) || slip.status === 'RETURNED';
    if (slip.issuedBy && released) {
      signatories.push({
        role: slip.requestedBy ? 'Released by' : 'Issued by',
        name: slip.issuedBy.name,
        ...(await contactOf(slip.issuedBy.id)),
        at: slip.releasedAt ?? slip.createdAt,
      });
    } else if (slip.status === 'APPROVED') {
      signatories.push({ role: 'Released by', name: '', at: null });
    }

    // The borrower's details: a login's own record, else the name and number on the slip.
    const borrowerContact = slip.borrower ? await contactOf(slip.borrower.id) : {};
    const contact = slip.contactNo ?? ('phone' in borrowerContact && borrowerContact.phone ? String(borrowerContact.phone) : null);
    const anyBack = slip.items.some((i) => num(i.returnedQty) > 0);
    const sections: PdfSection[] = [
      {
        kind: 'table',
        title: 'Equipment & tool details',
        head: ['No.', 'Item description / model', 'Asset / serial no.', 'Qty', 'Unit', 'Condition out', 'Returned'],
        align: ['right', 'left', 'left', 'right', 'left', 'left', 'left'],
        rows: slip.items.map((i, n) => [
          String(n + 1),
          { title: i.item.name, body: [i.item.partNumber ?? i.item.code, i.item.brand, i.remarks].filter(Boolean).join(' · ') || undefined },
          i.serialNo ?? '',
          qty(num(i.quantity)),
          i.item.unit,
          i.conditionOut ?? '',
          num(i.returnedQty) ? [qty(num(i.returnedQty)), i.conditionBack].filter(Boolean).join(' · ') : '',
        ]),
      },
      {
        kind: 'text',
        title: 'Reason for borrowing / project destination',
        body: [
          `Project / customer: ${slip.job ? `${slip.job.number} — ${slip.job.name}` : '—'}`,
          `Site location: ${slip.siteLocation ?? '—'}`,
          `Purpose: ${slip.purpose}`,
          slip.notes ? `Notes: ${slip.notes}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ];
    if (slip.status === 'CANCELLED' && slip.cancelReason) sections.push({ kind: 'text', title: 'Cancelled', body: slip.cancelReason });
    // The return clearance: what the custodian recorded, else their lines to fill.
    if (anyBack || slip.status === 'RETURNED') {
      sections.push({
        kind: 'text',
        title: 'Return clearance (warehouse / custodian)',
        body: [
          `Actual return date: ${slip.returnedAt ? formatDate(slip.returnedAt) : slip.status === 'PARTIALLY_RETURNED' ? 'part returned — the rest still out' : '—'}`,
          `Returned condition: ${slip.returnedCondition ? RETURN_CONDITIONS[slip.returnedCondition] : '—'}`,
          `Inspected by: ${slip.inspectedBy ? `${slip.inspectedBy.name}${slip.inspectedAt ? `, ${formatDate(slip.inspectedAt)}` : ''}` : '—'}`,
          slip.returnNote ? `Note: ${slip.returnNote}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
      });
    } else if (released || slip.status === 'APPROVED') {
      sections.push({
        kind: 'text',
        title: 'Return clearance (warehouse / custodian use only)',
        body: 'Actual return date: ______________    Returned condition:  [ ] Complete / good   [ ] Damaged   [ ] Missing parts\n\nInspected by: ______________________________    Custodian signature: ______________________',
      });
    }

    const pdf = await renderDocument({
      title: "Borrower's Slip",
      titleBold: true,
      documentNumber: slip.number,
      date: slip.createdAt,
      numberNote: `Date: ${formatDate(slip.createdAt)}`,
      detailsTitle: "Borrower's details",
      detailsTitleSize: 11,
      details: [
        [
          ["Borrower's name", slip.borrowerName],
          ['Employee no.', slip.borrower?.employeeNo ?? '—'],
          ['Borrowing type', slip.borrowType ? BORROW_TYPES[slip.borrowType] : '—'],
        ],
        [
          ['Team', slip.borrower?.employee?.industry?.code ?? '—'],
          ['Contact no.', contact ?? '—'],
          ['Warehouse', slip.warehouse.name],
        ],
        [
          ['Needed on', slip.neededOn ? formatDate(slip.neededOn) : '—'],
          ['Expected return', formatDate(slip.dueAt)],
          ['Status', statusLabel(slip.status) + (released && slip.borrowedAt ? ` — out ${formatDate(slip.borrowedAt)}` : '')],
        ],
      ],
      sections,
      signatories,
      signoffNote: 'The name, date and time are considered a digital signature.',
      footerNote: slip.status === 'DRAFT' || slip.status === 'PENDING_APPROVAL' ? 'REQUEST — NOT YET RELEASED.' : slip.status === 'CANCELLED' ? 'CANCELLED.' : undefined,
    });
    await audit({ entityType: 'borrow_slip', entityId: slip.id, action: 'EXPORTED', summary: `Printed ${slip.number}` }, req);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      contentDisposition(paperFileName({ kind: "Borrower's Slip", number: slip.number, author: slip.requestedBy?.name ?? slip.issuedBy?.name ?? '', date: slip.createdAt })),
    );
    res.send(pdf);
  }),
);

/**
 * Modifying a slip the warehouse holds — approved and waiting for release,
 * or with anything still out: who has it, when it is due back, what it is
 * for, the notes. The warehouse and the items are fixed (a draft request is
 * changed whole on its page, `PUT /:id/sheet`), so a key for either is
 * refused rather than ignored. A borrower renamed without a login named
 * loses the old login link, so the clearance scan matches the new name and
 * never charges the tools to the person the slip no longer names.
 */
borrowRoutes.patch(
  '/:id',
  require_(BORROW_WAREHOUSE),
  handler(async (req, res) => {
    const body = parseBody(
      z
        .object({
          borrowerId: z.string().optional().nullable(),
          borrowerName: z.string().trim().min(2, 'Who is borrowing?').optional(),
          dueAt: z.string().min(1, 'When is it due back?').optional(),
          purpose: z.string().trim().min(3, 'What is it for?').optional(),
          notes: z.string().optional().nullable(),
          borrowType: z.nativeEnum(BorrowType).optional().nullable(),
          siteLocation: z.string().trim().max(300).optional().nullable(),
          contactNo: z.string().trim().max(80).optional().nullable(),
        })
        .strict(),
      req.body,
    );
    const slip = await prisma.borrowSlip.findUnique({ where: { id: req.params.id } });
    if (!slip) throw notFound('Borrow slip not found');
    if (slip.status === 'RETURNED') {
      throw badRequest(`Everything on ${slip.number} is back — the slip is a record now`);
    }
    if (slip.status === 'CANCELLED') throw badRequest(`${slip.number} was cancelled — the slip is a record now`);
    if (slip.status === 'DRAFT' || slip.status === 'PENDING_APPROVAL') {
      throw badRequest(`${slip.number} is a request ${slip.status === 'DRAFT' ? 'still in draft — modify it on its page' : 'waiting for approval — pull it back first'}`);
    }

    const dueAt = body.dueAt !== undefined ? asDate(body.dueAt)! : slip.dueAt;
    const from = ON_LOAN.includes(slip.status) ? slip.borrowedAt : today();
    if (dueAt.getTime() < from.getTime()) {
      throw badRequest(ON_LOAN.includes(slip.status) ? `It cannot be due back before it went out on ${formatDate(slip.borrowedAt)}` : 'It cannot be due back before today');
    }
    if (body.borrowerId) {
      const user = await prisma.user.findUnique({ where: { id: body.borrowerId }, select: { id: true } });
      if (!user) throw badRequest('That borrower has no login');
    }
    const renamed = body.borrowerName !== undefined && body.borrowerName !== slip.borrowerName;
    const borrowerId =
      body.borrowerId !== undefined ? body.borrowerId || null : renamed ? null : slip.borrowerId;

    const changed: string[] = [];
    if (renamed) changed.push(`borrower ${slip.borrowerName} → ${body.borrowerName}`);
    if (dueAt.getTime() !== slip.dueAt.getTime()) changed.push(`due ${formatDate(slip.dueAt)} → ${formatDate(dueAt)}`);
    if (body.purpose !== undefined && body.purpose !== slip.purpose) changed.push('purpose');
    if (body.notes !== undefined && (body.notes?.trim() || null) !== slip.notes) changed.push('notes');

    // Claimed on the state it was read in: the last return, or a release, wins.
    const claimed = await prisma.borrowSlip.updateMany({
      where: { id: slip.id, status: { in: [...ON_LOAN, 'APPROVED'] } },
      data: {
        borrowerId,
        dueAt,
        ...(body.borrowerName !== undefined ? { borrowerName: body.borrowerName } : {}),
        ...(body.purpose !== undefined ? { purpose: body.purpose } : {}),
        ...(body.notes !== undefined ? { notes: body.notes?.trim() || null } : {}),
        ...(body.borrowType !== undefined ? { borrowType: body.borrowType } : {}),
        ...(body.siteLocation !== undefined ? { siteLocation: body.siteLocation?.trim() || null } : {}),
        ...(body.contactNo !== undefined ? { contactNo: body.contactNo?.trim() || null } : {}),
      },
    });
    if (!claimed.count) throw badRequest(`Everything on ${slip.number} came back a moment ago — reload to see it`);
    await audit(
      {
        entityType: 'borrow_slip',
        entityId: slip.id,
        action: 'UPDATED',
        summary: `Modified ${slip.number}${changed.length ? `: ${changed.join(', ')}` : ''}`,
      },
      req,
    );
    res.json(await presentSlip((await loadSlip(slip.id))!, currentUser(req)));
  }),
);

const borrowLineSchema = z.object({
  itemId: z.string().min(1),
  quantity: z.number().positive(),
  serialNo: z.string().trim().optional().nullable(),
  conditionOut: z.string().trim().max(80).optional().nullable(),
});

const borrowSheetSchema = z.object({
  jobId: z.string().optional().nullable(),
  warehouseId: z.string().min(1, 'Which warehouse?'),
  borrowerId: z.string().optional().nullable(),
  borrowerName: z.string().trim().optional().nullable(),
  borrowType: z.nativeEnum(BorrowType).optional().nullable(),
  siteLocation: z.string().trim().max(300).optional().nullable(),
  contactNo: z.string().trim().max(80).optional().nullable(),
  neededOn: z.string().optional().nullable(),
  dueAt: z.string().min(1, 'When is it due back?'),
  purpose: z.string().trim().min(3, 'What is it for?'),
  notes: z.string().optional().nullable(),
  items: z.array(borrowLineSchema).min(1, 'Add at least one item'),
});

/**
 * One rule for what a request may say, on create and on modify: the
 * warehouse exists and is active, the project is open, each item is in that
 * warehouse with enough AVAILABLE now (a request for what the shelf does not
 * hold is refused naming it — the release checks again), the dates hold, and
 * the borrower is the caller unless the caller is the warehouse.
 */
async function checkBorrowSheet(me: ResolvedUser, body: z.infer<typeof borrowSheetSchema>) {
  const warehouse = await prisma.warehouse.findUnique({ where: { id: body.warehouseId }, select: { isActive: true, name: true } });
  if (!warehouse || !warehouse.isActive) throw badRequest('That warehouse is not available');
  if (body.jobId) {
    const job = await prisma.job.findUnique({ where: { id: body.jobId }, select: { status: true } });
    if (!job || !['PLANNING', 'IN_PROGRESS', 'ON_HOLD'].includes(job.status)) throw badRequest('That project is not open');
  }
  const day = today();
  const dueAt = asDate(body.dueAt)!;
  const neededOn = asDate(body.neededOn);
  if (dueAt.getTime() < day.getTime()) throw badRequest('It cannot be due back before today');
  if (neededOn && neededOn.getTime() > dueAt.getTime()) throw badRequest('It cannot be due back before the day it is needed');
  const wanted = new Map<string, number>();
  for (const l of body.items) wanted.set(l.itemId, (wanted.get(l.itemId) ?? 0) + l.quantity);
  const balances = await prisma.inventoryBalance.findMany({
    where: { warehouseId: body.warehouseId, itemId: { in: [...wanted.keys()] } },
    include: { item: { select: { name: true } } },
  });
  const byItem = new Map(balances.map((b) => [b.itemId, b]));
  for (const [itemId, quantity] of wanted) {
    const b = byItem.get(itemId);
    if (!b) throw badRequest(`${warehouse.name} holds none of one of the items asked for`);
    if (availableOf(b) < quantity - 0.0005) {
      throw badRequest(`Only ${qty(availableOf(b))} of ${b.item.name} is available in ${warehouse.name} now`);
    }
  }
  // The borrower: the caller, unless the warehouse writes it for someone.
  const warehouseWrites = can(me, BORROW_WAREHOUSE);
  if (!warehouseWrites && body.borrowerId && body.borrowerId !== me.id) {
    throw forbidden('You ask to borrow for yourself — the warehouse writes a slip for someone else');
  }
  let borrowerId: string | null = warehouseWrites ? (body.borrowerId ?? null) : me.id;
  let borrowerName = warehouseWrites ? body.borrowerName?.trim() || '' : me.name;
  if (warehouseWrites && borrowerId) {
    const user = await prisma.user.findUnique({ where: { id: borrowerId }, select: { name: true } });
    if (!user) throw badRequest('That borrower has no login');
    borrowerName = borrowerName || user.name;
  }
  if (warehouseWrites && !borrowerId && !borrowerName) {
    borrowerId = me.id;
    borrowerName = me.name;
  }
  if (borrowerName.length < 2) throw badRequest('Who is borrowing?');
  return { dueAt, neededOn, borrowerId, borrowerName };
}

/**
 * A new borrow slip. Anyone may ask (2026-10-14): with the route active it
 * is saved as a DRAFT REQUEST — nothing moves — to submit for approval. With
 * the route switched off, the warehouse's own slip goes OUT at once (the
 * walk-in borrower, as before) and anyone else's is saved APPROVED, waiting
 * for the warehouse to release it.
 */
borrowRoutes.post(
  '/',
  require_('gchain.borrow_slips.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(borrowSheetSchema, req.body);
    const checked = await checkBorrowSheet(me, body);
    const routed = !!(await pickWorkflow(BORROW_DOC, null, { requesterId: me.id }));
    const lendsNow = !routed && can(me, BORROW_WAREHOUSE);
    const status: BorrowStatus = routed ? 'DRAFT' : lendsNow ? 'OUT' : 'APPROVED';

    const slip = await prisma.$transaction(async (tx) => {
      const number = await nextNumber('borrow_slip', tx);
      const created = await tx.borrowSlip.create({
        data: {
          number,
          status,
          jobId: body.jobId || null,
          warehouseId: body.warehouseId,
          borrowerId: checked.borrowerId,
          borrowerName: checked.borrowerName,
          requestedById: me.id,
          issuedById: lendsNow ? me.id : null,
          releasedAt: lendsNow ? new Date() : null,
          // Set here rather than left to the column's now(): the database
          // takes its date in UTC. For a request it is the day asked; the
          // release moves it to the day it went out.
          borrowedAt: today(),
          neededOn: checked.neededOn,
          dueAt: checked.dueAt,
          purpose: body.purpose,
          notes: body.notes?.trim() || null,
          borrowType: body.borrowType ?? null,
          siteLocation: body.siteLocation?.trim() || null,
          contactNo: body.contactNo?.trim() || null,
          items: {
            create: body.items.map((i) => ({ itemId: i.itemId, quantity: D(i.quantity), serialNo: i.serialNo || null, conditionOut: i.conditionOut?.trim() || null })),
          },
        },
      });
      if (lendsNow) await lendItems(tx, created.id, me.id);
      return created;
    });

    await audit(
      {
        entityType: 'borrow_slip',
        entityId: slip.id,
        action: 'CREATED',
        summary: lendsNow
          ? `${slip.number} lent to ${slip.borrowerName}, due ${formatDate(slip.dueAt)}`
          : `${slip.number} requested for ${slip.borrowerName}, due back ${formatDate(slip.dueAt)}${routed ? ', to submit for approval' : ', for the warehouse to release'}`,
      },
      req,
    );
    if (status === 'APPROVED') await tellWarehouse(slip.id);
    res.status(201).json({ ...slip, needsApproval: routed });
  }),
);

/** Moves every line of a slip out of available — the release (or the warehouse's walk-in slip). */
async function lendItems(tx: Prisma.TransactionClient, slipId: string, actorId: string) {
  const slip = await tx.borrowSlip.findUniqueOrThrow({ where: { id: slipId }, include: { items: true } });
  for (const line of slip.items) {
    await borrowStock(tx, {
      itemId: line.itemId,
      warehouseId: slip.warehouseId,
      quantity: num(line.quantity),
      sourceType: 'borrow_slip',
      sourceId: slip.id,
      sourceNumber: slip.number,
      createdById: actorId,
    });
  }
}

/** The warehouse is told an approved request waits for its release. */
async function tellWarehouse(slipId: string) {
  const slip = await prisma.borrowSlip.findUnique({ where: { id: slipId }, select: { id: true, number: true, borrowerName: true, warehouse: { select: { name: true } } } });
  if (!slip) return;
  const people = new Set([...(await usersInRole('warehouse')), ...(await usersInRole('warehouse_supervisor'))]);
  for (const userId of people) {
    await notify({
      userId,
      type: 'borrow.to_release',
      title: `${slip.number} approved — to release`,
      body: `${slip.borrowerName} · ${slip.warehouse.name}`,
      link: `/g-chain/borrow-slips/${slip.id}`,
    });
  }
}

/**
 * Modify a DRAFT request whole — the header and the items in one save,
 * claimed on DRAFT and the `version` (updatedAt) the page read.
 */
borrowRoutes.put(
  '/:id/sheet',
  requireAny('gchain.borrow_slips.edit_own', BORROW_WAREHOUSE),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(borrowSheetSchema.extend({ version: z.string().optional() }), req.body);
    const slip = await prisma.borrowSlip.findUnique({ where: { id: req.params.id } });
    if (!slip) throw notFound('Borrow slip not found');
    if (!mayHandleRequest(me, slip)) throw forbidden('This request is someone else’s');
    if (slip.status !== 'DRAFT') {
      throw badRequest(`${slip.number} is ${statusLabel(slip.status).toLowerCase()}${slip.status === 'PENDING_APPROVAL' ? ' — pull it back first' : ''}`);
    }
    if (body.version && new Date(body.version).getTime() !== slip.updatedAt.getTime()) {
      throw badRequest(`${slip.number} changed a moment ago — reload to see it`);
    }
    const checked = await checkBorrowSheet(me, body);
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.borrowSlip.updateMany({
        where: { id: slip.id, status: 'DRAFT', updatedAt: slip.updatedAt },
        data: {
          jobId: body.jobId || null,
          warehouseId: body.warehouseId,
          borrowerId: checked.borrowerId,
          borrowerName: checked.borrowerName,
          neededOn: checked.neededOn,
          dueAt: checked.dueAt,
          purpose: body.purpose,
          notes: body.notes?.trim() || null,
          borrowType: body.borrowType ?? null,
          siteLocation: body.siteLocation?.trim() || null,
          contactNo: body.contactNo?.trim() || null,
        },
      });
      if (!claimed.count) throw badRequest(`${slip.number} changed a moment ago — reload to see it`);
      await tx.borrowSlipItem.deleteMany({ where: { slipId: slip.id } });
      await tx.borrowSlipItem.createMany({
        data: body.items.map((i) => ({ slipId: slip.id, itemId: i.itemId, quantity: D(i.quantity), serialNo: i.serialNo || null, conditionOut: i.conditionOut?.trim() || null })),
      });
    });
    await audit({ entityType: 'borrow_slip', entityId: slip.id, action: 'UPDATED', summary: `Modified the request ${slip.number}` }, req);
    res.json(await presentSlip((await loadSlip(slip.id))!, me));
  }),
);

/**
 * Submit for approval: claims the DRAFT on what it was read as, checks the
 * warehouse can still lend every line, and files the request in the
 * REQUESTER's name whoever presses it — so it is their Team Leader who
 * decides. A refused submit puts it back to a draft.
 */
borrowRoutes.post(
  '/:id/submit',
  requireAny('gchain.borrow_slips.edit_own', BORROW_WAREHOUSE),
  handler(async (req, res) => {
    const me = currentUser(req);
    const slip = await prisma.borrowSlip.findUnique({ where: { id: req.params.id }, include: { items: true, warehouse: { select: { name: true } } } });
    if (!slip) throw notFound('Borrow slip not found');
    if (!mayHandleRequest(me, slip)) throw forbidden('This request is someone else’s');
    if (slip.status !== 'DRAFT') throw badRequest(`${slip.number} is ${statusLabel(slip.status).toLowerCase()}`);
    if (!slip.items.length) throw badRequest('Add at least one item before submitting');
    const balances = await prisma.inventoryBalance.findMany({
      where: { warehouseId: slip.warehouseId, itemId: { in: slip.items.map((i) => i.itemId) } },
      include: { item: { select: { name: true } } },
    });
    const byItem = new Map(balances.map((b) => [b.itemId, b]));
    const short = slip.items.filter((l) => {
      const b = byItem.get(l.itemId);
      return !b || availableOf(b) < num(l.quantity) - 0.0005;
    });
    if (short.length) {
      const names = short.map((l) => byItem.get(l.itemId)?.item.name ?? 'an item').join(', ');
      throw badRequest(`${slip.warehouse.name} does not have enough of ${names} available to lend now`);
    }
    const requesterId = slip.requestedById ?? me.id;
    const claimed = await prisma.borrowSlip.updateMany({
      where: { id: slip.id, status: 'DRAFT', updatedAt: slip.updatedAt },
      data: { status: 'PENDING_APPROVAL', requestedById: requesterId },
    });
    if (!claimed.count) throw badRequest(`${slip.number} changed a moment ago — reload to see where it stands`);
    try {
      await submitForApproval({
        documentType: BORROW_DOC,
        documentId: slip.id,
        documentNumber: slip.number,
        subject: `${slip.borrowerName} — ${slip.purpose}`,
        amount: null,
        link: `/g-chain/borrow-slips/${slip.id}`,
        requesterId,
      });
    } catch (err) {
      await prisma.borrowSlip.updateMany({ where: { id: slip.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
      throw err;
    }
    await audit({ entityType: 'borrow_slip', entityId: slip.id, action: 'SUBMITTED', summary: `${slip.number} submitted for approval` }, req);
    res.json(await presentSlip((await loadSlip(slip.id))!, me));
  }),
);

/** Pulls a pending request back to a draft — its request withdrawn in the same transaction; a decision that landed first wins. */
borrowRoutes.post(
  '/:id/withdraw',
  requireAny('gchain.borrow_slips.edit_own', BORROW_WAREHOUSE),
  handler(async (req, res) => {
    const me = currentUser(req);
    const slip = await prisma.borrowSlip.findUnique({ where: { id: req.params.id } });
    if (!slip) throw notFound('Borrow slip not found');
    if (!mayHandleRequest(me, slip)) throw forbidden('This request is someone else’s');
    if (slip.status !== 'PENDING_APPROVAL') throw badRequest(`${slip.number} is not waiting for approval`);
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.borrowSlip.updateMany({ where: { id: slip.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
      if (!claimed.count) throw badRequest(`${slip.number} was decided a moment ago — reload to see where it stands`);
      const withdrawn = await cancelOpenRequest(BORROW_DOC, slip.id, tx, `pulled back by ${me.name}`, me.id);
      if (!withdrawn.length) throw badRequest(`${slip.number} was decided a moment ago — reload to see where it stands`);
    });
    await audit({ entityType: 'borrow_slip', entityId: slip.id, action: 'UPDATED', summary: `${slip.number} pulled back to a draft` }, req);
    res.json(await presentSlip((await loadSlip(slip.id))!, me));
  }),
);

/**
 * Cancels a request before anything left the shelf — a draft, a pending one
 * (its request withdrawn) or an approved one the warehouse will not release
 * ("not on the shelf"), the reason kept. Who asked for it is told when the
 * warehouse cancels it.
 */
borrowRoutes.post(
  '/:id/cancel',
  requireAny('gchain.borrow_slips.edit_own', BORROW_WAREHOUSE),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(z.object({ reason: z.string().trim().min(3, 'Say why it is cancelled').max(2000) }), req.body);
    const slip = await prisma.borrowSlip.findUnique({ where: { id: req.params.id } });
    if (!slip) throw notFound('Borrow slip not found');
    if (!mayHandleRequest(me, slip)) throw forbidden('This request is someone else’s');
    if (!['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(slip.status)) {
      throw badRequest(`${slip.number} is ${statusLabel(slip.status).toLowerCase()} — ${ON_LOAN.includes(slip.status) ? 'the items are out; take them back instead' : 'nothing to cancel'}`);
    }
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.borrowSlip.updateMany({ where: { id: slip.id, status: slip.status }, data: { status: 'CANCELLED', cancelReason: body.reason } });
      if (!claimed.count) throw badRequest(`${slip.number} changed a moment ago — reload to see where it stands`);
      if (slip.status === 'PENDING_APPROVAL') {
        await cancelOpenRequest(BORROW_DOC, slip.id, tx, `cancelled by ${me.name}: ${body.reason}`, me.id);
      }
    });
    await audit({ entityType: 'borrow_slip', entityId: slip.id, action: 'CANCELLED', summary: `${slip.number} cancelled — ${body.reason}` }, req);
    if (slip.requestedById && slip.requestedById !== me.id) {
      await notify({
        userId: slip.requestedById,
        type: 'borrow.cancelled',
        title: `${slip.number} cancelled by ${me.name}`,
        body: body.reason,
        link: `/g-chain/borrow-slips/${slip.id}`,
      });
    }
    res.json({ ok: true, status: 'CANCELLED' });
  }),
);

/**
 * A draft or a CANCELLED request is deleted (2026-10-19, the owner's call):
 * nothing left the shelf on either. The delete right, and who asked for it
 * or the warehouse; its files go after the commit.
 */
borrowRoutes.delete(
  '/:id',
  require_('gchain.borrow_slips.delete'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const slip = await prisma.borrowSlip.findUnique({ where: { id: req.params.id } });
    if (!slip) throw notFound('Borrow slip not found');
    if (!mayHandleRequest(me, slip)) throw forbidden('This request is someone else’s');
    if (slip.status !== 'DRAFT' && slip.status !== 'CANCELLED') {
      throw badRequest(`Only a draft or a cancelled slip can be deleted — ${slip.number} is ${statusLabel(slip.status).toLowerCase()}`);
    }
    const gone = await deleteOrRefuse(slip.number, () =>
      prisma.borrowSlip.deleteMany({ where: { id: slip.id, status: { in: ['DRAFT', 'CANCELLED'] } } }),
    );
    if (!gone.count) throw badRequest(`${slip.number} changed a moment ago — it stays on record`);
    await deleteAttachmentsOf(BORROW_DOC, [slip.id]);
    await audit(
      { entityType: 'borrow_slip', entityId: slip.id, action: 'DELETED', summary: `Deleted ${slip.status === 'CANCELLED' ? 'cancelled' : 'draft'} ${slip.number}` },
      req,
    );
    res.json({ ok: true });
  }),
);

/**
 * The route's decision. Approved: claims PENDING_APPROVAL → APPROVED — the
 * warehouse is told it waits for its release; nothing moves until then.
 * Returned or rejected: back to a draft for who asked for it. A decision
 * that finds the request no longer pending changes nothing, and says so.
 */
export async function settleBorrowSlip(documentId: string, outcome: ApprovalOutcome) {
  const slip = await prisma.borrowSlip.findUnique({ where: { id: documentId } });
  if (!slip) return;
  const next: BorrowStatus = outcome === 'APPROVED' ? 'APPROVED' : 'DRAFT';
  const claimed = await prisma.borrowSlip.updateMany({ where: { id: slip.id, status: 'PENDING_APPROVAL' }, data: { status: next } });
  if (!claimed.count) {
    const now = await prisma.borrowSlip.findUnique({ where: { id: slip.id }, select: { status: true } });
    await warehouseNotApplied('borrow_slip', slip.id, slip.number, now?.status ?? slip.status, outcome);
    return;
  }
  if (outcome === 'APPROVED') {
    await audit({ entityType: 'borrow_slip', entityId: slip.id, action: 'APPROVED', summary: `${slip.number} approved — for the warehouse to release`, actorName: 'system' });
    await tellWarehouse(slip.id);
  }
}

onApprovalSettled(BORROW_DOC, async (request, outcome) => {
  await settleBorrowSlip(request.documentId, outcome);
});

/**
 * Pulled back after approval (2026-10-16): APPROVED → DRAFT while the
 * warehouse has not released it — approval moved nothing, so nothing is
 * undone. Once released (out, back, overdue) it is refused: the loan is a
 * fact, closed by its return.
 */
onApprovalReopened(BORROW_DOC, {
  may: async (actor, id) => {
    const slip = await prisma.borrowSlip.findUnique({ where: { id }, select: { requestedById: true, borrowerId: true } });
    return !!slip && mayHandleRequest(actor, slip);
  },
  reopen: async ({ documentId, tx }) => {
    const slip = await tx.borrowSlip.findUnique({ where: { id: documentId }, select: { id: true, number: true, status: true, releasedAt: true } });
    if (!slip) throw notFound('Borrow slip not found');
    if (slip.status !== 'APPROVED' || slip.releasedAt) {
      throw badRequest(`${slip.number} is ${statusLabel(slip.status).toLowerCase()} — once the warehouse released it, it cannot be pulled back`);
    }
    const claimed = await tx.borrowSlip.updateMany({ where: { id: slip.id, status: 'APPROVED', releasedAt: null }, data: { status: 'DRAFT' } });
    if (!claimed.count) throw badRequest(`${slip.number} was released a moment ago — reload to see where it stands`);
  },
});

/**
 * The warehouse releases an approved request: claimed on APPROVED, every
 * line moved out of available in the same transaction (a line the shelf can
 * no longer fill refuses the whole release, naming it — cancel the request
 * with that reason instead), dated the day it went out, released by whoever
 * pressed it. A new due date may be given, never before today.
 */
borrowRoutes.post(
  '/:id/release',
  require_(BORROW_WAREHOUSE),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(z.object({ dueAt: z.string().optional().nullable(), serials: z.record(z.string(), z.string()).optional() }), req.body ?? {});
    const slip = await prisma.borrowSlip.findUnique({ where: { id: req.params.id } });
    if (!slip) throw notFound('Borrow slip not found');
    if (slip.status !== 'APPROVED') {
      throw badRequest(`${slip.number} is ${statusLabel(slip.status).toLowerCase()} — only an approved request is released`);
    }
    const dueAt = body.dueAt ? asDate(body.dueAt)! : slip.dueAt;
    if (dueAt.getTime() < today().getTime()) throw badRequest('It cannot be due back before today');
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.borrowSlip.updateMany({
        where: { id: slip.id, status: 'APPROVED' },
        data: { status: 'OUT', issuedById: me.id, releasedAt: new Date(), borrowedAt: today(), dueAt },
      });
      if (!claimed.count) throw badRequest(`${slip.number} was released or cancelled a moment ago — reload to see where it stands`);
      for (const [lineId, serialNo] of Object.entries(body.serials ?? {})) {
        await tx.borrowSlipItem.updateMany({ where: { id: lineId, slipId: slip.id }, data: { serialNo: serialNo.trim() || null } });
      }
      await lendItems(tx, slip.id, me.id);
    });
    await audit({ entityType: 'borrow_slip', entityId: slip.id, action: 'EXECUTED', summary: `${slip.number} released to ${slip.borrowerName}, due back ${formatDate(dueAt)}` }, req);
    const tell = new Set([slip.requestedById, slip.borrowerId].filter((u): u is string => !!u && u !== me.id));
    for (const userId of tell) {
      await notify({
        userId,
        type: 'borrow.released',
        title: `${slip.number} released — collect it from the warehouse`,
        body: `Due back ${formatDate(dueAt)}`,
        link: `/g-chain/borrow-slips/${slip.id}`,
      });
    }
    res.json(await presentSlip((await loadSlip(slip.id))!, me));
  }),
);

borrowRoutes.post(
  '/:id/return',
  require_(BORROW_WAREHOUSE),
  handler(async (req, res) => {
    const me = currentUser(req);
    // The return clearance (2026-10-15, the owner's form): what came back on
    // each line and in what condition, the custodian's verdict and note —
    // recorded by whoever receives it, dated; the last return's word stands.
    const body = parseBody(
      z.object({
        items: z.array(z.object({ itemId: z.string(), quantity: z.number().positive(), conditionBack: z.string().trim().max(80).optional().nullable() })).min(1),
        returnedCondition: z.nativeEnum(ReturnCondition).optional().nullable(),
        note: z.string().trim().max(2000).optional().nullable(),
      }),
      req.body,
    );

    const slip = await prisma.borrowSlip.findUnique({
      where: { id: req.params.id },
      include: { items: true },
    });
    if (!slip) throw notFound('Borrow slip not found');
    if (slip.status === 'RETURNED') throw badRequest('Everything on this slip is already back');
    if (!ON_LOAN.includes(slip.status)) throw badRequest(`${slip.number} is ${statusLabel(slip.status).toLowerCase()} — nothing has gone out on it`);

    await prisma.$transaction(async (tx) => {
      for (const line of body.items) {
        const slipItem = slip.items.find((i) => i.id === line.itemId);
        if (!slipItem) throw badRequest('One of the lines is not on this slip');

        const outstanding = num(slipItem.quantity) - num(slipItem.returnedQty);
        if (line.quantity > outstanding + 0.0005) {
          throw badRequest(`Only ${outstanding} of that item is still out`);
        }

        await tx.borrowSlipItem.update({
          where: { id: slipItem.id },
          data: { returnedQty: D(num(slipItem.returnedQty) + line.quantity), ...(line.conditionBack !== undefined ? { conditionBack: line.conditionBack?.trim() || null } : {}) },
        });

        await returnBorrowedStock(tx, {
          itemId: slipItem.itemId,
          warehouseId: slip.warehouseId,
          quantity: line.quantity,
          sourceType: 'borrow_slip',
          sourceId: slip.id,
          sourceNumber: slip.number,
          createdById: me.id,
        });
      }

      const refreshed = await tx.borrowSlipItem.findMany({ where: { slipId: slip.id } });
      const allBack = refreshed.every(
        (i) => num(i.returnedQty) >= num(i.quantity) - 0.0005,
      );
      await tx.borrowSlip.update({
        where: { id: slip.id },
        data: {
          status: allBack ? 'RETURNED' : 'PARTIALLY_RETURNED',
          returnedAt: allBack ? today() : null,
          returnedCondition: body.returnedCondition ?? (allBack ? 'COMPLETE_GOOD' : slip.returnedCondition),
          returnNote: body.note?.trim() || slip.returnNote,
          inspectedById: me.id,
          inspectedAt: new Date(),
        },
      });
    });

    const verdict = body.returnedCondition ? ` — ${RETURN_CONDITIONS[body.returnedCondition].toLowerCase()}` : '';
    await audit(
      {
        entityType: 'borrow_slip',
        entityId: slip.id,
        action: 'UPDATED',
        summary: `Items returned on ${slip.number}${verdict}${body.note ? `: ${body.note.trim()}` : ''}`,
      },
      req,
    );
    res.json({ ok: true });
  }),
);

// ════════════════════════════════════════════════════════════════════
//  INVENTORY
// ════════════════════════════════════════════════════════════════════

export const inventoryRoutes = Router();
inventoryRoutes.use(authenticate);

/**
 * Which balances a stock list query means — one rule for the list, its
 * board and its printed twin. `base` is the search, the warehouse and the
 * rows ticked; `where` adds the category, the state (2026-10-15) and "Below
 * level". A state compares columns and open orders, which a where-clause
 * cannot, so it is decided over the candidates and named by id: the list then
 * pages and counts it like any other.
 */
async function inventoryListWhere(me: ResolvedUser, q: ListQuery): Promise<{ base: Prisma.InventoryBalanceWhereInput; where: Prisma.InventoryBalanceWhereInput }> {
  const and: Prisma.InventoryBalanceWhereInput[] = [];
  // View Own reads the stock of the items one added (2026-10-18) — first, so
  // the cards, the tiles and the state's candidates are narrowed too.
  const own = ownStockWhere(me);
  if (own) and.push(own);
  if (q.filters.warehouseId) and.push({ warehouseId: q.filters.warehouseId });
  if (q.search) {
    and.push({
      item: {
        OR: [
          { name: { contains: q.search, mode: 'insensitive' } },
          { code: { contains: q.search, mode: 'insensitive' } },
          { partNumber: { contains: q.search, mode: 'insensitive' } },
          { brand: { contains: q.search, mode: 'insensitive' } },
          { category: { name: { contains: q.search, mode: 'insensitive' } } },
        ],
      },
    });
  }
  const ids = idsFilter(q.filters.ids);
  if (ids) and.push({ id: { in: ids } });
  const base: Prisma.InventoryBalanceWhereInput = and.length ? { AND: [...and] } : {};

  if (q.filters.categoryId) and.push({ item: { categoryId: q.filters.categoryId === 'none' ? null : q.filters.categoryId } });
  if (q.filters.needsReorder === 'true') {
    const candidates = await prisma.inventoryBalance.findMany({
      where: { AND: [...and, REORDER_CANDIDATES] },
      select: { id: true, quantity: true, borrowedQty: true, item: { select: { reorderLevel: true } } },
    });
    and.push({ id: { in: candidates.filter(belowReorder).map((b) => b.id) } });
  }
  const state = choice(q.filters.state, Object.fromEntries(STOCK_STATES.map((k) => [k, k])) as Record<StockState, StockState>, 'Status');
  if (state) {
    const candidates = await prisma.inventoryBalance.findMany({
      where: { AND: and },
      select: { id: true, itemId: true, quantity: true, borrowedQty: true, item: { select: { reorderLevel: true, minStock: true } } },
    });
    const onOrder = await itemsOnOrder([...new Set(candidates.map((c) => c.itemId))]);
    and.push({ id: { in: candidates.filter((c) => stockState(c, onOrder.has(c.itemId)) === state).map((c) => c.id) } });
  }
  return { base, where: and.length ? { AND: and } : {} };
}

/**
 * What "own" means on Inventory (2026-10-18): the stock of the items the
 * caller added (`Item.createdById`). Null for a View All holder.
 */
function ownStockWhere(me: ResolvedUser): { item: { createdById: string } } | null {
  return viewScope(me, 'gchain', 'inventory') === 'all' ? null : { item: { createdById: me.id } };
}

/** May the caller see this item's stock? View All any; View Own the items they added — anybody else's is a 404. */
function assertStockVisible(me: ResolvedUser, item: { createdById: string | null }) {
  assertCanView(me, 'gchain', 'inventory', item.createdById === me.id);
}

/**
 * The projects' own stock (2026-10-18): goods bought for a project and
 * received into a warehouse — `?stock=project` on the inventory list, its rows
 * in the company stock's shape plus the project. Never in the company's value.
 */
function projectStockWhere(me: ResolvedUser, q: ListQuery): { base: Prisma.ProjectStockWhereInput; where: Prisma.ProjectStockWhereInput } {
  const and: Prisma.ProjectStockWhereInput[] = [{ quantity: { gt: 0 } }];
  const own = ownStockWhere(me);
  if (own) and.push(own);
  if (q.filters.warehouseId) and.push({ warehouseId: q.filters.warehouseId });
  if (q.filters.jobId) and.push({ jobId: q.filters.jobId });
  if (q.search) {
    and.push({
      OR: [
        { item: { name: { contains: q.search, mode: 'insensitive' } } },
        { item: { code: { contains: q.search, mode: 'insensitive' } } },
        { item: { partNumber: { contains: q.search, mode: 'insensitive' } } },
        { item: { brand: { contains: q.search, mode: 'insensitive' } } },
        { job: { number: { contains: q.search, mode: 'insensitive' } } },
        { job: { name: { contains: q.search, mode: 'insensitive' } } },
      ],
    });
  }
  const ids = idsFilter(q.filters.ids);
  if (ids) and.push({ id: { in: ids } });
  const base = { AND: [...and] };
  if (q.filters.categoryId) and.push({ item: { categoryId: q.filters.categoryId === 'none' ? null : q.filters.categoryId } });
  return { base, where: { AND: and } };
}

async function projectStockCard(me: ResolvedUser) {
  const rows = await prisma.projectStock.findMany({ where: { quantity: { gt: 0 }, ...(ownStockWhere(me) ?? {}) }, select: { jobId: true, quantity: true, averageCost: true } });
  const value = rows.reduce((s, b) => s.add(b.quantity.mul(b.averageCost)), new Prisma.Decimal(0));
  return { lines: rows.length, projects: new Set(rows.map((r) => r.jobId)).size, value: Number(value.toFixed(2)) };
}

async function projectStockList(me: ResolvedUser, q: ListQuery) {
  const { base, where } = projectStockWhere(me, q);
  const [rows, total, everything, inBase, categories] = await Promise.all([
    prisma.projectStock.findMany({
      where,
      include: {
        item: {
          select: {
            id: true,
            code: true,
            partNumber: true,
            brand: true,
            name: true,
            description: true,
            unit: true,
            minStock: true,
            reorderLevel: true,
            category: { select: { id: true, name: true } },
            preferredSupplier: { select: { id: true, name: true } },
          },
        },
        warehouse: { select: { id: true, name: true } },
        location: { select: { id: true, code: true, name: true } },
        job: { select: { id: true, number: true, name: true } },
      },
      orderBy: [{ job: { number: 'asc' } }, { item: { name: 'asc' } }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
    prisma.projectStock.count({ where }),
    prisma.projectStock.findMany({ where, select: { jobId: true, itemId: true, quantity: true, averageCost: true } }),
    prisma.projectStock.findMany({ where: base, select: { itemId: true, quantity: true, averageCost: true, item: { select: { categoryId: true } } } }),
    prisma.itemCategory.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { id: true, name: true, description: true } }),
  ]);
  const tiles = new Map<string, { items: Set<string>; value: Prisma.Decimal }>();
  for (const b of inBase) {
    const key = b.item.categoryId ?? 'none';
    const t = tiles.get(key) ?? { items: new Set<string>(), value: new Prisma.Decimal(0) };
    t.items.add(b.itemId);
    t.value = t.value.add(b.quantity.mul(b.averageCost));
    tiles.set(key, t);
  }
  const tile = (id: string, name: string, description: string | null) => {
    const t = tiles.get(id);
    return { id, name, description, items: t?.items.size ?? 0, value: t ? Number(t.value.toFixed(2)) : 0, low: 0, critical: 0 };
  };
  const value = everything.reduce((s, b) => s.add(b.quantity.mul(b.averageCost)), new Prisma.Decimal(0));
  return {
    ...listResult(
      rows.map((r) => {
        const quantity = num(r.quantity);
        return {
          id: r.id,
          item: {
            ...r.item,
            minStock: r.item.minStock == null ? null : num(r.item.minStock),
            reorderLevel: r.item.reorderLevel == null ? null : num(r.item.reorderLevel),
          },
          warehouse: r.warehouse,
          location: r.location,
          project: r.job,
          quantity,
          borrowedQty: 0,
          available: quantity,
          averageCost: num(r.averageCost),
          value: cents(quantity * num(r.averageCost)),
          needsReorder: false,
          state: 'PROJECT_STOCK',
        };
      }),
      total,
      q,
    ),
    summary: {
      stock: 'project',
      items: new Set(everything.map((b) => b.itemId)).size,
      projects: new Set(everything.map((b) => b.jobId)).size,
      // What the projects paid for it — already on their ledgers.
      valuation: Number(value.toFixed(2)),
      categories: categories.filter((c) => tiles.has(c.id)).map((c) => tile(c.id, c.name, c.description)).concat(tiles.has('none') ? [tile('none', 'Not categorised', null)] : []),
    },
  };
}

inventoryRoutes.get(
  '/',
  requireView('gchain', 'inventory'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const stockKind = choice(q.filters.stock, { company: 'company', project: 'project' } as const, 'Stock');
    if (stockKind === 'project') {
      res.json(await projectStockList(me, q));
      return;
    }
    const { base, where } = await inventoryListWhere(me, q);

    const [rows, total, everything, inBase, categories, pendingOrders] = await Promise.all([
      prisma.inventoryBalance.findMany({
        where,
        include: {
          item: {
            select: {
              id: true,
              code: true,
              partNumber: true,
              brand: true,
              name: true,
              description: true,
              unit: true,
              minStock: true,
              reorderLevel: true,
              category: { select: { id: true, name: true } },
              preferredSupplier: { select: { id: true, name: true } },
            },
          },
          warehouse: { select: { id: true, name: true } },
          location: { select: { id: true, code: true, name: true } },
        },
        orderBy: { item: { name: 'asc' } },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.inventoryBalance.count({ where }),
      // The cards, under the list's own query.
      prisma.inventoryBalance.findMany({
        where,
        select: { itemId: true, quantity: true, borrowedQty: true, averageCost: true, item: { select: { reorderLevel: true, minStock: true } } },
      }),
      // The category tiles, under everything but the category and the state —
      // so every tile still shows when one is chosen.
      prisma.inventoryBalance.findMany({
        where: base,
        select: { itemId: true, quantity: true, borrowedQty: true, averageCost: true, item: { select: { categoryId: true, reorderLevel: true, minStock: true } } },
      }),
      prisma.itemCategory.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { id: true, name: true, description: true } }),
      prisma.purchaseOrder.count({ where: { status: { in: ['ISSUED', 'PARTIALLY_RECEIVED'] } } }),
    ]);
    const onOrder = await itemsOnOrder([...new Set([...everything.map((r) => r.itemId), ...inBase.map((r) => r.itemId)])]);
    const valuation = everything.reduce((s, b) => s.add(b.quantity.mul(b.averageCost)), new Prisma.Decimal(0));
    const states = everything.map((b) => stockState(b, onOrder.has(b.itemId)));

    // A tile per category: its items, value, and how many need reordering.
    const tiles = new Map<string, { items: Set<string>; value: Prisma.Decimal; low: number; critical: number }>();
    for (const b of inBase) {
      const key = b.item.categoryId ?? 'none';
      const t = tiles.get(key) ?? { items: new Set<string>(), value: new Prisma.Decimal(0), low: 0, critical: 0 };
      t.items.add(b.itemId);
      t.value = t.value.add(b.quantity.mul(b.averageCost));
      const st = stockState(b, onOrder.has(b.itemId));
      if (st === 'LOW_STOCK') t.low += 1;
      if (st === 'CRITICAL') t.critical += 1;
      tiles.set(key, t);
    }
    const tile = (id: string, name: string, description: string | null) => {
      const t = tiles.get(id);
      return { id, name, description, items: t?.items.size ?? 0, value: t ? Number(t.value.toFixed(2)) : 0, low: t?.low ?? 0, critical: t?.critical ?? 0 };
    };

    res.json({
      ...listResult(
        rows.map((r) => {
          const quantity = num(r.quantity);
          return {
            id: r.id,
            item: {
              ...r.item,
              minStock: r.item.minStock == null ? null : num(r.item.minStock),
              reorderLevel: r.item.reorderLevel == null ? null : num(r.item.reorderLevel),
            },
            warehouse: r.warehouse,
            location: r.location,
            quantity,
            borrowedQty: num(r.borrowedQty),
            available: availableOf(r),
            averageCost: num(r.averageCost),
            value: cents(quantity * num(r.averageCost)),
            needsReorder: belowReorder(r),
            state: stockState(r, onOrder.has(r.itemId)),
          };
        }),
        total,
        q,
      ),
      summary: {
        items: new Set(everything.map((b) => b.itemId)).size,
        valuation: Number(valuation.toFixed(2)),
        lowStock: states.filter((st) => st === 'LOW_STOCK').length,
        critical: states.filter((st) => st === 'CRITICAL').length,
        onOrder: states.filter((st) => st === 'ON_ORDER').length,
        pendingOrders,
        // The projects' own goods on the shelves — their card links to `?stock=project`.
        projectStock: await projectStockCard(me),
        // The first eight categories always (the owner's eight lead the
        // order), and any other that holds stock.
        categories: [
          ...categories.filter((c, n) => n < 8 || tiles.has(c.id)).map((c) => tile(c.id, c.name, c.description)),
          ...(tiles.has('none') ? [tile('none', 'Not categorised', null)] : []),
        ],
      },
    });
  }),
);

/**
 * Where a stock line sits — its bin or rack (2026-10-15), one of its
 * warehouse's locations, or none. The inventory's edit right.
 */
inventoryRoutes.patch(
  '/balances/:id',
  requireEdit('gchain', 'inventory'),
  handler(async (req, res) => {
    const body = parseBody(z.object({ locationId: z.string().nullable() }).strict(), req.body);
    const balance = await prisma.inventoryBalance.findUnique({
      where: { id: req.params.id },
      include: { item: { select: { code: true, createdById: true } }, warehouse: { select: { name: true } }, location: { select: { code: true } } },
    });
    if (!balance) throw notFound('Stock line not found');
    // Edit Own places the stock of the items one added (2026-10-18).
    assertCanEdit(currentUser(req), 'gchain', 'inventory', balance.item.createdById === currentUser(req).id);
    let code: string | null = null;
    if (body.locationId) {
      const loc = await prisma.location.findUnique({ where: { id: body.locationId }, select: { warehouseId: true, code: true } });
      if (!loc || loc.warehouseId !== balance.warehouseId) throw badRequest(`That location is not in ${balance.warehouse.name}`);
      code = loc.code;
    }
    await prisma.inventoryBalance.update({ where: { id: balance.id }, data: { locationId: body.locationId } });
    await audit(
      {
        entityType: 'inventory',
        entityId: balance.id,
        action: 'UPDATED',
        summary: `${balance.item.code} at ${balance.warehouse.name}: bin ${balance.location?.code ?? '—'} → ${code ?? '—'}`,
      },
      req,
    );
    res.json({ ok: true, locationId: body.locationId });
  }),
);

/**
 * The latest stock movements — the owner's "Recent stock movement log":
 * each movement in or out, its item, warehouse and the document behind it.
 */
inventoryRoutes.get(
  '/movements',
  requireView('gchain', 'inventory'),
  handler(async (req, res) => {
    const take = Math.min(30, Math.max(1, Number(req.query.limit) || 8));
    const rows = await prisma.inventoryTransaction.findMany({
      // View Own: the moves of the items one added (2026-10-18).
      where: ownStockWhere(currentUser(req)) ?? {},
      orderBy: { occurredAt: 'desc' },
      take,
      select: {
        id: true,
        type: true,
        quantity: true,
        sourceType: true,
        sourceId: true,
        sourceNumber: true,
        occurredAt: true,
        item: { select: { id: true, code: true, name: true, unit: true } },
        warehouse: { select: { id: true, name: true } },
        job: { select: { id: true, number: true } },
      },
    });
    const LINKS: Record<string, string> = {
      receiving: '/g-chain/incoming/',
      stock_issue: '/g-chain/outgoing/',
      borrow_slip: '/g-chain/borrow-slips/',
      pullout_slip: '/g-chain/pullout-slips/',
    };
    res.json(
      rows.map((r) => ({
        ...r,
        quantity: num(r.quantity),
        link: r.sourceId && LINKS[r.sourceType] ? `${LINKS[r.sourceType]}${r.sourceId}` : null,
      })),
    );
  }),
);

/** The most cards a board column draws; the column says how many more it holds. */
const BOARD_CAP = 200;

/**
 * The Kanban view of the stock (2026-10-14, the owner's call: "Inventory —
 * can be switched to Kanban or List view"): a column per active warehouse
 * (and any other warehouse a row names) holding what it has AVAILABLE, and an
 * "Out of stock" column for every row with nothing available — none on hand,
 * or everything lent. The SAME query as the list (`inventoryListWhere`, every
 * filter and search), so the board's total is the list's; no dragging — a
 * card opens the stock card. Above `/:itemId/card`.
 */
inventoryRoutes.get(
  '/board',
  requireView('gchain', 'inventory'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const { where } = await inventoryListWhere(currentUser(req), q);
    const [rows, active] = await Promise.all([
      prisma.inventoryBalance.findMany({
        where,
        include: {
          item: { select: { id: true, code: true, partNumber: true, name: true, unit: true, reorderLevel: true } },
          warehouse: { select: { id: true, name: true } },
        },
        orderBy: { item: { name: 'asc' } },
      }),
      prisma.warehouse.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    ]);
    const card = (r: (typeof rows)[number]) => {
      const quantity = num(r.quantity);
      return {
        id: r.id,
        item: { ...r.item, reorderLevel: r.item.reorderLevel == null ? null : num(r.item.reorderLevel) },
        warehouse: r.warehouse,
        quantity,
        borrowedQty: num(r.borrowedQty),
        available: availableOf(r),
        value: cents(quantity * num(r.averageCost)),
        needsReorder: belowReorder(r),
      };
    };
    const inStock = rows.filter((r) => availableOf(r) > 0);
    const empty = rows.filter((r) => availableOf(r) <= 0);
    // Every active warehouse has its column — unless the list is narrowed to
    // one, which is then the only one — and an inactive one still holding a
    // row is shown too, so no row falls off the board.
    const named = q.filters.warehouseId ? active.filter((w) => w.id === q.filters.warehouseId) : active;
    const seen = new Map(named.map((w) => [w.id, w]));
    for (const r of inStock) if (!seen.has(r.warehouseId)) seen.set(r.warehouseId, r.warehouse);
    const columns = [...seen.values()].map((w) => {
      const here = inStock.filter((r) => r.warehouseId === w.id);
      return {
        warehouse: w,
        count: here.length,
        value: cents(here.reduce((s, r) => s + num(r.quantity) * num(r.averageCost), 0)),
        cards: here.slice(0, BOARD_CAP).map(card),
      };
    });
    res.json({
      total: rows.length,
      columns,
      outOfStock: { count: empty.length, cards: empty.slice(0, BOARD_CAP).map(card) },
      cap: BOARD_CAP,
    });
  }),
);

/**
 * The stock on hand on paper, through `inventoryListWhere` (or the rows
 * ticked, `?ids=`): what the screen shows — on hand, on loan, available, the
 * moving average and the value — with "Below level" written where the screen
 * marks a reorder. The total is valued as `stockOnHand()` values stock (the
 * sum rounded once), so the unfiltered paper prints the dashboard's figure.
 */
inventoryRoutes.get(
  '/pdf',
  requireView('gchain', 'inventory'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    if (choice(q.filters.stock, { company: 'company', project: 'project' } as const, 'Stock') === 'project') {
      // The projects' own stock on paper (2026-10-18), the same query as the list.
      const { where: own } = projectStockWhere(me, q);
      const [rows, count, currency] = await Promise.all([
        prisma.projectStock.findMany({
          where: own,
          include: {
            item: { select: { code: true, name: true, brand: true, unit: true } },
            warehouse: { select: { name: true } },
            location: { select: { code: true } },
            job: { select: { number: true, name: true } },
          },
          orderBy: [{ job: { number: 'asc' } }, { item: { name: 'asc' } }],
          take: LIST_CAP,
        }),
        prisma.projectStock.count({ where: own }),
        companyCurrency(),
      ]);
      const total = cents(rows.reduce((s2, b) => s2 + num(b.quantity) * num(b.averageCost), 0));
      const pdf = await renderDocument({
        title: 'Project Stock',
        date: new Date(),
        reference: listReference(count, rows.length, ['stock line', 'stock lines'], [
          q.search && `search "${q.search}"`,
          q.filters.ids && 'the rows selected',
        ]),
        landscape: true,
        sections: [
          {
            kind: 'table',
            head: ['Project', 'Item', 'Warehouse', 'Bin', 'On hand', `Avg. cost (${currency})`, `Value (${currency})`],
            align: ['left', 'left', 'left', 'left', 'right', 'right', 'right'],
            rows: rows.map((b) => [
              { title: b.job.number, body: b.job.name },
              { title: b.item.name, body: [b.item.code, b.item.brand].filter(Boolean).join(' · ') },
              b.warehouse.name,
              b.location?.code ?? '',
              `${qty(num(b.quantity))} ${b.item.unit}`,
              formatAmount(num(b.averageCost)),
              formatAmount(cents(num(b.quantity) * num(b.averageCost))),
            ]),
          },
          { kind: 'totals', rows: [{ label: totalLabel('Charged to the projects', count, rows.length), value: formatMoney(total, currency), bold: true }] },
        ],
      });
      await audit({ entityType: 'inventory', entityId: 'list', action: 'EXPORTED', summary: `Exported the project stock as PDF (${rows.length} line(s))` }, req);
      sendListPdf(res, pdf, 'project-stock.pdf');
      return;
    }
    const { where } = await inventoryListWhere(me, q);
    const f = q.filters;
    const [rows, count, all, currency, warehouse, category] = await Promise.all([
      prisma.inventoryBalance.findMany({
        where,
        include: {
          item: { select: { code: true, name: true, brand: true, unit: true, reorderLevel: true, minStock: true, category: { select: { name: true } } } },
          warehouse: { select: { name: true } },
          location: { select: { code: true } },
        },
        orderBy: { item: { name: 'asc' } },
        take: LIST_CAP,
      }),
      prisma.inventoryBalance.count({ where }),
      prisma.inventoryBalance.findMany({ where, select: { quantity: true, averageCost: true } }),
      companyCurrency(),
      f.warehouseId ? prisma.warehouse.findUnique({ where: { id: f.warehouseId }, select: { name: true } }) : null,
      f.categoryId && f.categoryId !== 'none' ? prisma.itemCategory.findUnique({ where: { id: f.categoryId }, select: { name: true } }) : null,
    ]);
    const onOrder = await itemsOnOrder([...new Set(rows.map((r) => r.itemId))]);
    const STATE_WORDS: Record<StockState, string> = { IN_STOCK: 'In stock', LOW_STOCK: 'Low stock', CRITICAL: 'Critical', ON_ORDER: 'On order' };
    const reference = listReference(count, rows.length, ['stock line', 'stock lines'], [
      q.search && `search "${q.search}"`,
      f.warehouseId && `warehouse ${warehouse?.name ?? 'not found'}`,
      f.categoryId && (f.categoryId === 'none' ? 'not categorised' : `category ${category?.name ?? 'not found'}`),
      f.state && `status ${STATE_WORDS[f.state as StockState] ?? f.state}`,
      f.needsReorder === 'true' && 'below reorder level',
      f.ids && 'the rows selected',
    ]);
    const total = cents(all.reduce((s, b) => s + num(b.quantity) * num(b.averageCost), 0));

    // Ten columns: landscape, each sized from what it holds (rule 6).
    const pdf = await renderDocument({
      title: 'Inventory',
      date: new Date(),
      reference,
      landscape: true,
      sections: [
        {
          kind: 'table',
          head: ['Item', 'Category', 'Warehouse', 'Bin', 'Available', 'On loan', 'Reorder at', `Avg. cost (${currency})`, `Value (${currency})`, 'Status'],
          align: ['left', 'left', 'left', 'left', 'right', 'right', 'right', 'right', 'right', 'left'],
          rows: rows.map((b) => [
            { title: b.item.name, body: [b.item.code, b.item.brand].filter(Boolean).join(' · ') },
            b.item.category?.name ?? '',
            b.warehouse.name,
            b.location?.code ?? '',
            `${qty(availableOf(b))} ${b.item.unit}`,
            num(b.borrowedQty) ? qty(num(b.borrowedQty)) : '',
            b.item.reorderLevel == null ? '' : qty(num(b.item.reorderLevel)),
            formatAmount(num(b.averageCost)),
            formatAmount(cents(num(b.quantity) * num(b.averageCost))),
            STATE_WORDS[stockState(b, onOrder.has(b.itemId))],
          ]),
        },
        { kind: 'totals', rows: [{ label: totalLabel('Stock value', count, rows.length), value: formatMoney(total, currency), bold: true }] },
      ],
    });
    await audit(
      { entityType: 'inventory', entityId: 'list', action: 'EXPORTED', summary: `Exported the stock on hand as PDF (${rows.length} line(s))` },
      req,
    );
    sendListPdf(res, pdf, 'stock-on-hand.pdf');
  }),
);

/** The stock card: every movement for one item in one warehouse. */
inventoryRoutes.get(
  '/:itemId/card',
  requireView('gchain', 'inventory'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const warehouseId = req.query.warehouseId ? String(req.query.warehouseId) : undefined;
    // A project's own stock of the item (2026-10-18) — its rows and its moves alone.
    const jobId = req.query.jobId ? String(req.query.jobId) : undefined;
    if (jobId) {
      const [item, rows, moves] = await Promise.all([
        prisma.item.findUnique({ where: { id: req.params.itemId }, select: { id: true, code: true, name: true, unit: true, reorderLevel: true, minStock: true, createdById: true } }),
        prisma.projectStock.findMany({
          where: { itemId: req.params.itemId, jobId, ...(warehouseId ? { warehouseId } : {}) },
          include: { warehouse: { select: { id: true, name: true } }, location: { select: { id: true, code: true, name: true } }, job: { select: { id: true, number: true, name: true } } },
        }),
        prisma.inventoryTransaction.findMany({
          where: { itemId: req.params.itemId, jobId, ...(warehouseId ? { warehouseId } : {}) },
          include: { warehouse: { select: { id: true, name: true } }, createdBy: { select: { id: true, name: true } } },
          orderBy: { occurredAt: 'desc' },
          take: 200,
        }),
      ]);
      if (!item) throw notFound('Item not found');
      assertStockVisible(me, item);
      res.json({
        canEdit: mayEdit(me, 'gchain', 'inventory', item.createdById === me.id),
        item: { ...item, reorderLevel: item.reorderLevel == null ? null : num(item.reorderLevel), minStock: item.minStock == null ? null : num(item.minStock) },
        project: rows[0]?.job ?? (await prisma.job.findUnique({ where: { id: jobId }, select: { id: true, number: true, name: true } })),
        balances: rows.map((b) => ({
          ...b,
          warehouse: { ...b.warehouse, locations: [] },
          quantity: num(b.quantity),
          borrowedQty: 0,
          averageCost: num(b.averageCost),
          value: cents(num(b.quantity) * num(b.averageCost)),
        })),
        movements: moves.map((m) => ({ ...m, quantity: num(m.quantity), unitCost: num(m.unitCost), balanceAfter: num(m.balanceAfter) })),
      });
      return;
    }

    const [item, balances, moves] = await Promise.all([
      prisma.item.findUnique({
        where: { id: req.params.itemId },
        select: { id: true, code: true, name: true, unit: true, reorderLevel: true, minStock: true, createdById: true },
      }),
      prisma.inventoryBalance.findMany({
        where: { itemId: req.params.itemId, ...(warehouseId ? { warehouseId } : {}) },
        include: {
          warehouse: { select: { id: true, name: true, locations: { where: { isActive: true }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } } } },
          location: { select: { id: true, code: true, name: true } },
        },
      }),
      prisma.inventoryTransaction.findMany({
        // The company's stock alone: a project's own moves have their own card.
        where: { itemId: req.params.itemId, jobId: null, ...(warehouseId ? { warehouseId } : {}) },
        include: {
          warehouse: { select: { id: true, name: true } },
          createdBy: { select: { id: true, name: true } },
        },
        orderBy: { occurredAt: 'desc' },
        take: 200,
      }),
    ]);
    if (!item) throw notFound('Item not found');
    assertStockVisible(me, item);

    res.json({
      // Edit All places any stock line in a bin; Edit Own the items one added (2026-10-18).
      canEdit: mayEdit(me, 'gchain', 'inventory', item.createdById === me.id),
      item: {
        ...item,
        reorderLevel: item.reorderLevel == null ? null : num(item.reorderLevel),
        minStock: item.minStock == null ? null : num(item.minStock),
      },
      balances: balances.map((b) => ({
        ...b,
        quantity: num(b.quantity),
        borrowedQty: num(b.borrowedQty),
        averageCost: num(b.averageCost),
        value: cents(num(b.quantity) * num(b.averageCost)),
      })),
      movements: moves.map((m) => ({
        ...m,
        quantity: num(m.quantity),
        unitCost: num(m.unitCost),
        balanceAfter: num(m.balanceAfter),
      })),
    });
  }),
);

/** Stock-on-hand valuation and reorder report. */
inventoryRoutes.get(
  '/reports/summary',
  require_('gchain.reports.view_all'),
  handler(async (_req, res) => {
    const balances = await prisma.inventoryBalance.findMany({
      include: {
        item: { select: { id: true, code: true, name: true, unit: true, reorderLevel: true } },
        warehouse: { select: { id: true, name: true } },
      },
    });

    const byWarehouse = new Map<string, { name: string; items: number; value: number }>();
    const reorder: {
      itemId: string;
      warehouseId: string;
      item: string;
      code: string;
      warehouse: string;
      available: number;
      reorderLevel: number;
    }[] = [];

    for (const b of balances) {
      const quantity = num(b.quantity);
      const value = cents(quantity * num(b.averageCost));
      const entry = byWarehouse.get(b.warehouseId) ?? { name: b.warehouse.name, items: 0, value: 0 };
      entry.items += 1;
      entry.value = cents(entry.value + value);
      byWarehouse.set(b.warehouseId, entry);

      // The list's own rule, so this count is the total its Reorder filter opens.
      if (belowReorder(b)) {
        reorder.push({
          itemId: b.item.id,
          warehouseId: b.warehouseId,
          item: b.item.name,
          code: b.item.code,
          warehouse: b.warehouse.name,
          available: availableOf(b),
          reorderLevel: num(b.item.reorderLevel),
        });
      }
    }

    const [overdueBorrows, stock] = await Promise.all([
      prisma.borrowSlip.count({
        where: { status: { in: ['OUT', 'PARTIALLY_RETURNED'] }, dueAt: { lt: today() } },
      }),
      // Stock value is decided once, in shared/chain.ts — the same figure the
      // G-CHAIN dashboard and the Insights brief print.
      stockOnHand(),
    ]);

    res.json({
      warehouses: [...byWarehouse.entries()].map(([id, v]) => ({ id, ...v })),
      totalValue: stock.value,
      reorder,
      overdueBorrows,
    });
  }),
);

// ── Stock issue PDF ──────────────────────────────────────────────────────────

/**
 * The Outgoing slip on paper — the internal DELIVERY RECEIPT (2026-10-15,
 * the owner's reference, "internal receive proof to the requestor"; no
 * customer): DELIVERY DETAILS (the reference, the project, the dispatch
 * warehouse, the carrier), "Received by" (the requestor) and "Deliver to"
 * side by side, the items with their serial and condition — no prices, it is
 * a receipt — the terms of receipt, then the people who acted: Prepared &
 * dispatched by, the route's steps, Delivered by (the driver) and Received
 * in good order by — dated when the requestor confirms it in G-CORE,
 * "Pending" until then.
 */
stockIssueRoutes.get(
  '/:id/pdf',
  requireAnyOrDecider(ISSUE_VIEW, ISSUE_VIEW_OWN),
  handler(async (req, res) => {
    const me = currentUser(req);
    const issue = await visibleIssue(me, req.params.id, res.locals.deciderOnly === true);
    const view = presentIssue(issue);

    const routed = issue.status === 'DRAFT' && !!(await pickWorkflow(ISSUE_DOC, view.value, { requesterId: issue.issuedById }));
    const slots = routed
      ? await approvalSlots(ISSUE_DOC, issue.id, { amount: view.value, requesterId: issue.issuedById })
      : await approvalSlots(ISSUE_DOC, issue.id);
    const receiverName = issue.issuedTo?.name ?? issue.issuedToName;
    const signatories: Signatory[] = [
      { role: 'Prepared & dispatched by', name: issue.issuedBy.name, ...(await contactOf(issue.issuedById)), at: preparedAt(slots) ?? issue.createdAt },
      ...slotSignatories(slots),
    ];
    if (issue.status === 'ISSUED' && !slots.length) {
      const executed = await prisma.auditLog.findFirst({
        where: { entityType: 'stock_issue', entityId: issue.id, action: 'EXECUTED' },
        orderBy: { at: 'desc' },
        select: { actorId: true, actorName: true, at: true },
      });
      signatories.push({
        role: 'Issued by',
        name: executed?.actorName ?? issue.issuedBy.name,
        ...(await contactOf(executed?.actorId ?? issue.issuedById)),
        at: issue.issuedAt ?? executed?.at ?? null,
      });
    }
    if (issue.driverName && issue.status !== 'CANCELLED') {
      signatories.push({ role: 'Delivered by', name: issue.driverName, at: issue.status === 'ISSUED' ? issue.issuedAt : null });
    }
    // A cancelled slip is handed to nobody, so it names no receiver.
    if (receiverName && issue.status !== 'CANCELLED') {
      signatories.push({
        role: 'Received in good order by',
        name: receiverName,
        ...(await contactOf(issue.issuedToId)),
        at: issue.receivedAt,
      });
    }

    const company = await prisma.company.findUnique({ where: { id: 'company' } });
    const place = (...parts: (string | null | undefined)[]) => parts.filter((p) => p?.trim()).join(', ');
    const receiver = issue.issuedToId ? await contactOf(issue.issuedToId) : {};
    const receiverLines = [
      receiverName ?? '—',
      issue.issuedTo?.position ?? '',
      'phone' in receiver && receiver.phone ? String(receiver.phone) : '',
      issue.issuedTo?.email ?? '',
    ].filter((l) => l.trim());
    const deliverLines = [
      company?.legalName || company?.name || '',
      issue.deliverTo?.trim() || (issue.job ? `${issue.job.number} — ${issue.job.name}` : place(issue.warehouse.name, issue.warehouse.address, issue.warehouse.city)),
    ].filter((l) => l.trim());

    const sections: PdfSection[] = [
      { kind: 'blocks', titleSize: 11, blocks: [{ title: 'Received by', lines: receiverLines }, { title: 'Deliver to', lines: deliverLines }] },
      {
        kind: 'table',
        title: 'Outgoing items',
        head: ['No.', 'Item / Part no.', 'Description', 'Serial / batch', 'Qty', 'Unit', 'Condition'],
        align: ['right', 'left', 'left', 'left', 'right', 'left', 'left'],
        rows: view.items.map((i, n) => [
          String(n + 1),
          i.item.partNumber ?? i.item.code,
          { title: i.item.name, body: [i.item.brand, i.remarks].filter(Boolean).join(' · ') || undefined },
          i.serialNo ?? '',
          qty(i.quantity),
          i.item.unit,
          i.condition ?? '',
        ]),
      },
    ];
    if (issue.purpose) sections.push({ kind: 'text', title: 'Purpose', body: issue.purpose });
    if (issue.notes) sections.push({ kind: 'text', title: 'Notes', body: issue.notes });
    if (issue.instructions) sections.push({ kind: 'text', title: 'Instructions & terms of receipt', body: issue.instructions });
    if (issue.receivedNote) sections.push({ kind: 'text', title: 'On receipt', body: issue.receivedNote });

    const pdf = await renderDocument({
      title: 'Delivery Receipt',
      titleBold: true,
      documentNumber: issue.number,
      date: issue.issueDate,
      numberNote: `Date: ${formatDate(issue.issueDate)}`,
      detailsTitle: 'Delivery details',
      detailsTitleSize: 11,
      details: [
        [
          ['Ref / request no.', issue.referenceNo ?? '—'],
          ['Project', issue.job ? `${issue.job.number} — ${issue.job.name}` : '—'],
        ],
        [
          ['Dispatch warehouse', issue.warehouse.name],
          ['Carrier / vehicle', issue.carrier ?? '—'],
        ],
      ],
      sections,
      signatories,
      signoffNote: 'The name, date and time are considered a digital signature.',
      footerNote:
        issue.status === 'DRAFT' || issue.status === 'PENDING_APPROVAL' ? 'DRAFT — NOT YET ISSUED.' : issue.status === 'CANCELLED' ? 'CANCELLED.' : undefined,
    });
    const files = req.query.attachments === '0' ? [] : await attachedFiles('stock_issue', issue.id);
    const { pdf: withFiles, listed } = await withAttachments(pdf, files, { title: 'Delivery Receipt', number: issue.number, reference: issue.purpose });

    await audit(
      { entityType: 'stock_issue', entityId: issue.id, action: 'EXPORTED', summary: `Printed ${issue.number}${listed ? ` with ${listed} attachment${listed === 1 ? '' : 's'}` : ''}` },
      req,
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition(paperFileName({ kind: 'Delivery Receipt', number: issue.number, author: issue.issuedBy.name, date: issue.issueDate })));
    res.send(withFiles);
  }),
);

// ── Global search ────────────────────────────────────────────────────────────
// Warehouse documents by number. Incoming and Outgoing narrow a View Own
// holder to their own (2026-10-18); the rest are view_all-only. Numbers and
// names only.

registerSearch({
  kind: 'receiving',
  label: 'Incoming',
  permission: ['gchain.receiving.view_all', RECEIVING_VIEW_OWN],
  ownWhere: (user) => ({ receivedById: user.id }),
  async search(term, _user, limit, own) {
    const rows = await prisma.receiving.findMany({
      where: {
        ...(own ?? {}),
        OR: [
          { number: { contains: term, mode: 'insensitive' } },
          { deliveryRefNo: { contains: term, mode: 'insensitive' } },
          { order: { number: { contains: term, mode: 'insensitive' } } },
          { sourceName: { contains: term, mode: 'insensitive' } },
        ],
      },
      orderBy: { receivedDate: 'desc' },
      take: limit,
      select: {
        id: true,
        number: true,
        sourceName: true,
        supplier: { select: { name: true } },
        order: { select: { number: true, supplier: { select: { name: true } } } },
      },
    });
    return rows.map((r) => ({
      kind: 'receiving',
      id: r.id,
      title: `${r.number} — ${receivedFrom(r)}`,
      subtitle: r.order ? `Against ${r.order.number}` : 'Without a purchase order',
      link: `/g-chain/incoming/${r.id}`,
    }));
  },
});

registerSearch({
  kind: 'stock_issue',
  label: 'Outgoing',
  permission: ['gchain.stock_issuance.view_all', ISSUE_VIEW_OWN],
  ownWhere: (user) => ({ issuedById: user.id }),
  async search(term, _user, limit, own) {
    const rows = await prisma.stockIssue.findMany({
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
      kind: 'stock_issue',
      id: r.id,
      title: `${r.number} — ${r.purpose}`,
      subtitle: [r.job?.number, r.status.toLowerCase()].filter(Boolean).join(' · '),
      link: `/g-chain/outgoing/${r.id}`,
    }));
  },
});

registerSearch({
  kind: 'borrow_slip',
  label: 'Borrow slips',
  permission: 'gchain.borrow_slips.view_all',
  async search(term, _user, limit) {
    const rows = await prisma.borrowSlip.findMany({
      where: {
        OR: [
          { number: { contains: term, mode: 'insensitive' } },
          { borrowerName: { contains: term, mode: 'insensitive' } },
          { purpose: { contains: term, mode: 'insensitive' } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, number: true, borrowerName: true, purpose: true, status: true },
    });
    return rows.map((r) => ({
      kind: 'borrow_slip',
      id: r.id,
      title: `${r.number} — ${r.borrowerName}`,
      subtitle: `${r.purpose} · ${r.status.toLowerCase().replace(/_/g, ' ')}`,
      link: `/g-chain/borrow-slips/${r.id}`,
    }));
  },
});

registerSearch({
  kind: 'warehouse',
  label: 'Warehouses',
  permission: 'gchain.warehouses.view_all',
  async search(term, _user, limit) {
    const rows = await prisma.warehouse.findMany({
      where: {
        OR: [
          { code: { contains: term, mode: 'insensitive' } },
          { name: { contains: term, mode: 'insensitive' } },
          { city: { contains: term, mode: 'insensitive' } },
        ],
      },
      orderBy: { name: 'asc' },
      take: limit,
      select: { id: true, code: true, name: true, city: true },
    });
    // Warehouses have no per-record page — the master list is the screen the
    // same permission opens (links.ts maps `warehouse` there too).
    return rows.map((r) => ({
      kind: 'warehouse',
      id: r.id,
      title: `${r.code} — ${r.name}`,
      subtitle: r.city ?? undefined,
      link: '/g-chain/warehouses',
    }));
  },
});
