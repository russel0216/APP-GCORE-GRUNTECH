import { Router } from 'express';
import { z } from 'zod';
import { Prisma, IssueStatus, BorrowStatus, ReceivingStatus } from '@prisma/client';
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
import { authenticate, require_, requireAny, requireAnyOrDecider, currentUser } from '../auth/middleware';
import { can, type ResolvedUser } from '../permissions/resolve';
import { audit } from '../shared/audit';
import { registerSearch } from '../shared/search';
import { stockOnHand, availableOf, belowReorder, REORDER_CANDIDATES } from '../shared/chain';
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
 * INCOMING goes for approval (2026-10-14, the owner's call: "Incoming — the
 * warehouse receives this, approval of his/her report to; can attach the
 * packing list or documents"). Saving a receiving report writes a DRAFT that
 * moves nothing; "Submit for approval" files it in the receiver's name
 * through the seeded "Incoming — the receiver's supervisor" route (their
 * "Reports to", else a Warehouse Supervisor); the approval posts what the
 * save used to post — the stock, the job cost, the order's received
 * quantities and status (`postReceiving`, through `settleReceiving`). A
 * pending report holds its quantities against the order, so two cannot both
 * receive the same goods. With the route deactivated, a save posts at once
 * (RECEIVED), as it did before — the sales order's rule.
 */

const RECEIVING_SORTS = ['number', 'receivedDate'];
const RECEIVING_DOC = 'receiving';
const RECEIVING_VIEW = 'gchain.receiving.view_all';

/** Which receivings a list query means — one rule for the list and its printed twin. */
function receivingListWhere(q: ListQuery): Prisma.ReceivingWhereInput {
  const and: Prisma.ReceivingWhereInput[] = [];
  const status = choice(q.filters.status, ReceivingStatus, 'Status');
  if (status) and.push({ status });
  if (q.filters.orderId) and.push({ orderId: q.filters.orderId });
  // A receiving has no job of its own — it inherits its order's. The job
  // workspace's Procurement tab lists a project's deliveries through this.
  if (q.filters.jobId) and.push({ order: { jobId: q.filters.jobId } });
  if (q.search) {
    and.push({
      OR: [
        { number: { contains: q.search, mode: 'insensitive' } },
        { deliveryRefNo: { contains: q.search, mode: 'insensitive' } },
        { order: { number: { contains: q.search, mode: 'insensitive' } } },
        { order: { supplier: { name: { contains: q.search, mode: 'insensitive' } } } },
      ],
    });
  }
  const ids = idsFilter(q.filters.ids);
  if (ids) and.push({ id: { in: ids } });
  return and.length ? { AND: and } : {};
}

receivingRoutes.get(
  '/',
  require_(RECEIVING_VIEW),
  handler(async (req, res) => {
    const q = listQuery(req);
    const where = receivingListWhere(q);

    const [rows, total] = await Promise.all([
      prisma.receiving.findMany({
        where,
        include: {
          order: {
            select: {
              id: true,
              number: true,
              kind: true,
              supplier: { select: { id: true, name: true } },
              job: { select: { id: true, number: true, name: true } },
            },
          },
          warehouse: { select: { id: true, name: true } },
          receivedBy: { select: { id: true, name: true } },
          items: { select: { quantity: true, unitCost: true } },
        },
        orderBy: orderBy(q, RECEIVING_SORTS, { receivedDate: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.receiving.count({ where }),
    ]);

    res.json(
      listResult(
        rows.map((r) => ({
          id: r.id,
          number: r.number,
          status: r.status,
          receivedDate: r.receivedDate,
          deliveryRefNo: r.deliveryRefNo,
          order: r.order,
          warehouse: r.warehouse,
          receivedBy: r.receivedBy,
          lineCount: r.items.length,
          value: cents(r.items.reduce((s, i) => s + num(i.quantity) * num(i.unitCost), 0)),
        })),
        total,
        q,
      ),
    );
  }),
);

/**
 * The receiving list on paper, through `receivingListWhere` (or the rows
 * ticked, `?ids=`): what arrived, against which order, into where, and its
 * value at the order's price — the figure the screen shows. A report not
 * received yet (a draft, one pending approval, a cancelled one) moved
 * nothing: its value prints in brackets and is not summed. Above `/:id`.
 */
receivingRoutes.get(
  '/pdf',
  require_(RECEIVING_VIEW),
  handler(async (req, res) => {
    const q = listQuery(req);
    const where = receivingListWhere(q);
    const f = q.filters;
    const [rows, count, lines, notYet, currency, project, order] = await Promise.all([
      prisma.receiving.findMany({
        where,
        include: {
          order: { select: { number: true, supplier: { select: { name: true } }, job: { select: { number: true } } } },
          warehouse: { select: { name: true } },
          receivedBy: { select: { name: true } },
          items: { select: { quantity: true, unitCost: true } },
        },
        orderBy: orderBy(q, RECEIVING_SORTS, { receivedDate: 'desc' }),
        take: LIST_CAP,
      }),
      prisma.receiving.count({ where }),
      // Every line of every RECEIVED report listed, for the total — summed
      // exactly and rounded once, never the sum of rounded rows.
      prisma.receivingItem.findMany({ where: { receiving: { AND: [where, { status: 'RECEIVED' }] } }, select: { quantity: true, unitCost: true } }),
      prisma.receiving.count({ where: { AND: [where, { status: { not: 'RECEIVED' } }] } }),
      companyCurrency(),
      recordNamed('project', f.jobId),
      f.orderId ? prisma.purchaseOrder.findUnique({ where: { id: f.orderId }, select: { number: true } }) : null,
    ]);
    const reference = listReference(count, rows.length, ['receiving', 'receivings'], [
      q.search && `search "${q.search}"`,
      f.status && `status ${statusLabel(f.status)}`,
      f.orderId && `order ${order?.number ?? 'not found'}`,
      project,
      f.ids && 'the rows selected',
    ]);
    const valueOf = (items: { quantity: Prisma.Decimal; unitCost: Prisma.Decimal }[]) =>
      items.reduce((s, i) => s.add(i.quantity.mul(i.unitCost)), new Prisma.Decimal(0));

    // Ten columns: landscape, each sized from what it holds (rule 6).
    const pdf = await renderDocument({
      title: 'Incoming',
      date: new Date(),
      reference,
      landscape: true,
      sections: [
        {
          kind: 'table',
          head: ['Number', 'Against', 'For', 'Into', 'Received', 'Lines', `Value (${currency})`, 'Received by', 'DR no.', 'Status'],
          align: ['left', 'left', 'left', 'left', 'left', 'right', 'right', 'left', 'left', 'left'],
          rows: rows.map((r) => [
            r.number,
            { title: r.order.supplier.name, body: r.order.number },
            r.order.job?.number ?? 'Stock',
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
      { entityType: 'receiving', entityId: 'list', action: 'EXPORTED', summary: `Exported the receiving list as PDF (${rows.length} receiving(s))` },
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
          location: { select: { id: true, code: true } },
        },
      },
    },
  });
}

type LoadedReceiving = NonNullable<Awaited<ReturnType<typeof loadReceiving>>>;

const receivingValue = (items: { quantity: Prisma.Decimal; unitCost: Prisma.Decimal }[]) =>
  cents(items.reduce((s, i) => s + num(i.quantity) * num(i.unitCost), 0));

/** Who may move a report on — submit, pull back, cancel: whoever received it, or edit_all. */
function mayHandleReceiving(me: ResolvedUser, r: { receivedById: string }) {
  return r.receivedById === me.id || can(me, 'gchain.receiving.edit_all');
}

async function presentReceiving(receiving: LoadedReceiving, me: ResolvedUser) {
  // Finance's register, listed only to those who can open it.
  const seesBills = can(me, 'gfin.ap.view_all');
  const value = receivingValue(receiving.items);
  const draft = receiving.status === 'DRAFT';
  const handler_ = mayHandleReceiving(me, receiving);
  const route = draft ? await pickWorkflow(RECEIVING_DOC, value, { requesterId: receiving.receivedById }) : null;
  return {
    ...receiving,
    bills: seesBills ? receiving.bills : [],
    billsVisible: seesBills,
    // Its references only (PATCH /:id): what arrived is the record.
    canEdit: can(me, 'gchain.receiving.edit_all'),
    canSubmit: draft && handler_ && can(me, 'gchain.receiving.create'),
    needsApproval: draft ? !!route : null,
    canWithdraw: receiving.status === 'PENDING_APPROVAL' && handler_,
    canCancel: (draft || receiving.status === 'PENDING_APPROVAL') && handler_,
    // The route a draft WOULD take, by name — who signs it.
    approvalRoute: draft && route ? await routeBrief(RECEIVING_DOC, value, receiving.receivedById) : null,
    order: { ...receiving.order, total: num(receiving.order.total) },
    items: receiving.items.map((i) => ({
      ...i,
      quantity: num(i.quantity),
      unitCost: num(i.unitCost),
      amount: cents(num(i.quantity) * num(i.unitCost)),
      orderItem: {
        ...i.orderItem,
        quantity: num(i.orderItem.quantity),
        unitPrice: num(i.orderItem.unitPrice),
        receivedQty: num(i.orderItem.receivedQty),
      },
    })),
    value,
  };
}

/**
 * The report as its reader may see it: the register's right, or — through
 * `requireAnyOrDecider` — whoever may decide its open request (a supervisor
 * with no warehouse right), only while it waits on them.
 */
async function visibleReceiving(me: ResolvedUser, id: string, deciderOnly: boolean) {
  const receiving = await loadReceiving(id);
  if (!receiving) throw notFound('Receiving report not found');
  if (deciderOnly && !(await mayDecide(me.id, RECEIVING_DOC, [receiving.id]))) throw notFound('Receiving report not found');
  return receiving;
}

receivingRoutes.get(
  '/:id',
  requireAnyOrDecider(RECEIVING_VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    const receiving = await visibleReceiving(me, req.params.id, res.locals.deciderOnly === true);
    res.json(await presentReceiving(receiving, me));
  }),
);

/**
 * A receiving report's paper references change at any time — the delivery
 * receipt and supplier invoice numbers, and the notes. What arrived (lines,
 * quantities, costs, warehouse, date) is the record once received; a draft
 * that is wrong is cancelled and saved again. A key it cannot change is
 * refused, not ignored.
 */
receivingRoutes.patch(
  '/:id',
  require_('gchain.receiving.edit_all'),
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
 * Receiving goods against a purchase order.
 *
 * This is the moment the two purchase kinds diverge (model §4.3):
 *
 *   DIRECT_TO_JOB        releases the commitment and charges the job (INCURRED)
 *   STOCK_REPLENISHMENT  adds to inventory; the job is charged later, at issue
 *
 * Both raise the warehouse balance when a warehouse is named — direct-to-job
 * material often still passes through the store.
 */
const receivingSchema = z.object({
  orderId: z.string().min(1),
  warehouseId: z.string().optional().nullable(),
  receivedDate: z.string().optional().nullable(),
  deliveryRefNo: z.string().trim().optional().nullable(),
  invoiceRefNo: z.string().trim().optional().nullable(),
  notes: z.string().optional().nullable(),
  items: z
    .array(
      z.object({
        orderItemId: z.string().min(1),
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

/**
 * What a report may still receive of each order line: ordered less received
 * less what OTHER reports pending approval hold — so two pending reports
 * cannot both receive the same goods. Over-delivery is refused outright:
 * receiving more than was ordered means either the delivery or the order is
 * wrong, and quietly accepting it corrupts the commitment release and the
 * stock value.
 */
async function checkOutstanding(
  db: Prisma.TransactionClient | typeof prisma,
  orderItems: { id: string; description: string; quantity: Prisma.Decimal; receivedQty: Prisma.Decimal }[],
  lines: { orderItemId: string; quantity: number }[],
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
    const orderItem = byOrderItem.get(line.orderItemId);
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
 * Posts a receiving report: the order's received quantities and status, the
 * stock (a replenishment), the job cost (direct to a project) — what the
 * save did before the route. Inside the caller's transaction, after its claim.
 */
async function postReceiving(tx: Prisma.TransactionClient, receivingId: string, actorId: string) {
  const receiving = await tx.receiving.findUniqueOrThrow({
    where: { id: receivingId },
    include: { items: true, order: { include: { items: true, supplier: { select: { name: true } } } } },
  });
  const order = receiving.order;
  if (order.status === 'CANCELLED') throw badRequest(`${order.number} was cancelled`);
  const byOrderItem = new Map(order.items.map((i) => [i.id, i]));
  const byCategory = new Map<string, number>();

  for (const line of receiving.items) {
    const orderItem = byOrderItem.get(line.orderItemId)!;
    const quantity = num(line.quantity);
    const unitCost = num(line.unitCost);
    const amount = cents(quantity * unitCost);

    await tx.purchaseOrderItem.update({
      where: { id: orderItem.id },
      data: { receivedQty: { increment: line.quantity } },
    });

    // ONLY a stock replenishment builds inventory.
    //
    // Direct-to-job material is charged to the project the moment it
    // arrives. If it also entered stock, issuing it to that same project
    // later would charge it a second time at average cost — the exact
    // double-count the two purchase kinds exist to prevent. It may still
    // physically pass through the store; that is a storage detail, not a
    // stock balance.
    if (order.kind === 'STOCK_REPLENISHMENT' && receiving.warehouseId && orderItem.itemId) {
      await receiveStock(tx, {
        itemId: orderItem.itemId,
        warehouseId: receiving.warehouseId,
        quantity,
        unitCost,
        sourceType: 'receiving',
        sourceId: receiving.id,
        sourceNumber: receiving.number,
        createdById: actorId,
      });
    }

    if (order.kind === 'DIRECT_TO_JOB' && orderItem.costCategoryId) {
      byCategory.set(orderItem.costCategoryId, (byCategory.get(orderItem.costCategoryId) ?? 0) + amount);
    }
  }

  // Direct-to-job: the cost is now real. Release the commitment in the same
  // amount and record it as incurred.
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

  // Order status follows what is outstanding.
  const refreshed = await tx.purchaseOrderItem.findMany({ where: { orderId: order.id } });
  const fully = refreshed.every((i) => num(i.receivedQty) >= num(i.quantity) - 0.0005);
  await tx.purchaseOrder.update({
    where: { id: order.id },
    data: { status: fully ? 'RECEIVED' : 'PARTIALLY_RECEIVED' },
  });
}

/** Tells the receiver the goods are in, for a project's order (the bell the save rang before). */
async function tellReceived(receivingId: string, userId: string) {
  const r = await prisma.receiving.findUnique({
    where: { id: receivingId },
    select: { id: true, number: true, order: { select: { number: true, job: { select: { number: true } } } } },
  });
  if (!r?.order.job) return;
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

    const order = await prisma.purchaseOrder.findUnique({
      where: { id: body.orderId },
      include: { items: true, supplier: true, job: true },
    });
    if (!order) throw notFound('Purchase order not found');
    if (order.status === 'DRAFT' || order.status === 'PENDING_APPROVAL') {
      throw badRequest('That order has not been issued yet');
    }
    if (order.status === 'CANCELLED') throw badRequest('That order was cancelled');

    const warehouseId = body.warehouseId ?? order.warehouseId ?? null;
    await checkOutstanding(prisma, order.items, body.items);
    const byOrderItem = new Map(order.items.map((i) => [i.id, i]));
    const value = cents(body.items.reduce((s, l) => s + l.quantity * (l.unitCost ?? num(byOrderItem.get(l.orderItemId)!.unitPrice)), 0));
    // With the Incoming route active the report waits for its approval;
    // without one it posts now, as it always did.
    const routed = !!(await pickWorkflow(RECEIVING_DOC, value, { requesterId: me.id }));

    const receiving = await prisma.$transaction(async (tx) => {
      const number = await nextNumber('receiving', tx);
      const created = await tx.receiving.create({
        data: {
          number,
          orderId: order.id,
          warehouseId,
          receivedById: me.id,
          receivedDate: asDate(body.receivedDate) ?? today(),
          deliveryRefNo: body.deliveryRefNo || null,
          invoiceRefNo: body.invoiceRefNo || null,
          notes: body.notes || null,
          status: routed ? 'DRAFT' : 'RECEIVED',
          items: {
            create: body.items.map((l) => {
              const orderItem = byOrderItem.get(l.orderItemId)!;
              return {
                orderItemId: l.orderItemId,
                locationId: l.locationId || null,
                quantity: D(l.quantity),
                unitCost: D(l.unitCost ?? num(orderItem.unitPrice)),
                serialNo: l.serialNo || null,
                batchNo: l.batchNo || null,
                remarks: l.remarks || null,
              };
            }),
          },
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
        summary: routed ? `${receiving.number} saved against ${order.number}, to submit for approval` : `${receiving.number} received against ${order.number}`,
      },
      req,
    );
    if (!routed) await tellReceived(receiving.id, me.id);
    res.status(201).json({ ...receiving, needsApproval: routed });
  }),
);

/**
 * Submit for approval: claims the DRAFT on the `updatedAt` it carries,
 * checks the order can still take its quantities (other pending reports
 * counted), and files the request in the RECEIVER's name whoever presses it
 * — so the receiver's own supervisor decides, never the receiver. A refused
 * submit puts it back to a draft.
 */
receivingRoutes.post(
  '/:id/submit',
  require_('gchain.receiving.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const receiving = await prisma.receiving.findUnique({
      where: { id: req.params.id },
      include: { items: true, order: { include: { items: true, supplier: { select: { name: true } }, job: { select: { number: true } } } } },
    });
    if (!receiving) throw notFound('Receiving report not found');
    if (!mayHandleReceiving(me, receiving)) throw forbidden('This report is someone else’s — they, or the warehouse lead, submit it');
    if (receiving.status !== 'DRAFT') throw badRequest(`${receiving.number} is ${statusLabel(receiving.status).toLowerCase()}`);
    if (['DRAFT', 'PENDING_APPROVAL', 'CANCELLED'].includes(receiving.order.status)) {
      throw badRequest(`${receiving.order.number} is ${statusLabel(receiving.order.status).toLowerCase()} — goods are received against an issued order`);
    }
    await checkOutstanding(
      prisma,
      receiving.order.items,
      receiving.items.map((i) => ({ orderItemId: i.orderItemId, quantity: num(i.quantity) })),
      receiving.id,
    );
    const value = receivingValue(receiving.items);
    const claimed = await prisma.receiving.updateMany({
      where: { id: receiving.id, status: 'DRAFT', updatedAt: receiving.updatedAt },
      data: { status: 'PENDING_APPROVAL' },
    });
    if (!claimed.count) throw badRequest(`${receiving.number} changed a moment ago — reload to see where it stands`);
    try {
      await submitForApproval({
        documentType: RECEIVING_DOC,
        documentId: receiving.id,
        documentNumber: receiving.number,
        subject: `${receiving.order.supplier.name} — ${receiving.order.number}${receiving.order.job ? ` · ${receiving.order.job.number}` : ''}`,
        amount: value,
        link: `/g-chain/incoming/${receiving.id}`,
        requesterId: receiving.receivedById,
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
 * The receiving report on paper: what arrived against which order, into
 * where, valued at the order's price; RECEIVED BY (whoever saved it, dated)
 * and one slot per step of its route (a draft prints the route submitting
 * would take; "Pending" until signed). The packing list, the DR and the
 * photos attached to it follow it (`withAttachments`) unless `?attachments=0`.
 */
receivingRoutes.get(
  '/:id/pdf',
  requireAnyOrDecider(RECEIVING_VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    const receiving = await visibleReceiving(me, req.params.id, res.locals.deciderOnly === true);
    const view = await presentReceiving(receiving, me);
    const currency = await companyCurrency();
    const slots =
      receiving.status === 'DRAFT'
        ? await approvalSlots(RECEIVING_DOC, receiving.id, { amount: view.value, requesterId: receiving.receivedById })
        : await approvalSlots(RECEIVING_DOC, receiving.id);
    const signatories: Signatory[] = [
      { role: 'Received by', name: receiving.receivedBy.name, ...(await contactOf(receiving.receivedById)), at: preparedAt(slots) ?? receiving.createdAt },
      ...slotSignatories(slots),
    ];
    const sections: PdfSection[] = [
      {
        kind: 'fields',
        columns: 3,
        fields: [
          { label: 'Purchase order', value: receiving.order.number },
          { label: 'Supplier', value: receiving.order.supplier.name },
          { label: 'For', value: receiving.order.job ? `${receiving.order.job.number} — ${receiving.order.job.name}` : 'Stock' },
          { label: 'Into', value: receiving.warehouse?.name ?? 'Site' },
          { label: 'DR no.', value: receiving.deliveryRefNo ?? '—' },
          { label: 'Invoice no.', value: receiving.invoiceRefNo ?? '—' },
          { label: 'Received', value: formatDate(receiving.receivedDate) },
          { label: 'Status', value: statusLabel(receiving.status) },
        ],
      },
      {
        kind: 'table',
        title: 'Goods received',
        head: ['No.', 'Code', 'Description', 'Qty', `Unit cost (${currency})`, `Amount (${currency})`],
        align: ['right', 'left', 'left', 'right', 'right', 'right'],
        rows: view.items.map((i, n) => [
          String(n + 1),
          i.orderItem.item?.code ?? i.orderItem.partNumber ?? '',
          i.orderItem.name && i.orderItem.description !== i.orderItem.name ? { title: i.orderItem.name, body: i.orderItem.description } : (i.orderItem.name ?? i.orderItem.description),
          qty(i.quantity),
          formatAmount(i.unitCost),
          formatAmount(i.amount),
        ]),
      },
      { kind: 'totals', rows: [{ label: 'Total', value: formatMoney(view.value, currency), bold: true }] },
    ];
    if (receiving.notes) sections.push({ kind: 'text', title: 'Notes', body: receiving.notes });
    if (receiving.cancelReason && receiving.status === 'CANCELLED') sections.push({ kind: 'text', title: 'Cancelled', body: receiving.cancelReason });

    const bare = await renderDocument({
      title: 'Incoming Report',
      documentNumber: receiving.number,
      date: receiving.receivedDate,
      reference: `${receiving.order.number} — ${receiving.order.supplier.name}`,
      sections,
      signatories,
    });
    const files = req.query.attachments === '0' ? [] : await attachedFiles('receiving', receiving.id);
    const { pdf, listed } = await withAttachments(bare, files, { title: 'Incoming Report', number: receiving.number, reference: receiving.order.supplier.name });
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

/** Which stock issues a list query means — one rule for the list and its printed twin. */
function issueListWhere(q: ListQuery): Prisma.StockIssueWhereInput {
  const and: Prisma.StockIssueWhereInput[] = [];
  const status = choice(q.filters.status, IssueStatus, 'Status');
  if (status) and.push({ status });
  if (q.filters.jobId) and.push({ jobId: q.filters.jobId });
  if (q.search) {
    and.push({
      OR: [
        { number: { contains: q.search, mode: 'insensitive' } },
        { purpose: { contains: q.search, mode: 'insensitive' } },
        { job: { name: { contains: q.search, mode: 'insensitive' } } },
      ],
    });
  }
  const ids = idsFilter(q.filters.ids);
  if (ids) and.push({ id: { in: ids } });
  return and.length ? { AND: and } : {};
}

stockIssueRoutes.get(
  '/',
  require_('gchain.stock_issuance.view_all'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const where = issueListWhere(q);

    const [rows, total] = await Promise.all([
      prisma.stockIssue.findMany({
        where,
        include: {
          job: { select: { id: true, number: true, name: true } },
          warehouse: { select: { id: true, name: true } },
          issuedBy: { select: { id: true, name: true } },
          items: { select: { amount: true } },
        },
        orderBy: orderBy(q, ISSUE_SORTS, { issueDate: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.stockIssue.count({ where }),
    ]);

    res.json(
      listResult(
        rows.map((r) => ({
          id: r.id,
          number: r.number,
          status: r.status,
          issueDate: r.issueDate,
          purpose: r.purpose,
          issuedToName: r.issuedToName,
          job: r.job,
          warehouse: r.warehouse,
          issuedBy: r.issuedBy,
          lineCount: r.items.length,
          value: cents(r.items.reduce((s, i) => s + num(i.amount), 0)),
        })),
        total,
        q,
      ),
    );
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
  require_('gchain.stock_issuance.view_all'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const where = issueListWhere(q);
    const f = q.filters;
    const [rows, count, live, cancelled, drafts, currency, project] = await Promise.all([
      prisma.stockIssue.findMany({
        where,
        include: {
          job: { select: { number: true, name: true } },
          warehouse: { select: { name: true } },
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
    const reference = listReference(count, rows.length, ['stock issue', 'stock issues'], [
      q.search && `search "${q.search}"`,
      f.status && `status ${statusLabel(f.status)}`,
      project,
      f.ids && 'the rows selected',
    ]);
    const valueOf = (r: (typeof rows)[number]) => r.items.reduce((s, i) => s.add(i.amount), new Prisma.Decimal(0));

    // Eight columns: landscape, each sized from what it holds (rule 6).
    const sections: PdfSection[] = [
      {
        kind: 'table',
        head: ['Number', 'Issue', 'From', 'To', 'Date', 'Lines', `Value (${currency})`, 'Status'],
        align: ['left', 'left', 'left', 'left', 'left', 'right', 'right', 'left'],
        rows: rows.map((i) => [
          i.number,
          { title: i.purpose, body: i.job ? `${i.job.number} — ${i.job.name}` : 'No project' },
          i.warehouse.name,
          i.issuedToName ?? '',
          formatShortDate(i.issueDate),
          String(i.items.length),
          bracketed(formatAmount(valueOf(i).toFixed(2)), i.status !== 'CANCELLED'),
          statusLabel(i.status),
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
      { entityType: 'stock_issue', entityId: 'list', action: 'EXPORTED', summary: `Exported the stock issue list as PDF (${rows.length} issue(s))` },
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
      warehouse: { select: { id: true, name: true } },
      issuedBy: { select: { id: true, name: true, position: true } },
      items: {
        include: {
          item: { select: { id: true, code: true, name: true, unit: true } },
          costCategory: { select: { id: true, name: true } },
          location: { select: { id: true, code: true } },
        },
      },
    },
  });
}

function presentIssue(issue: NonNullable<Awaited<ReturnType<typeof loadIssue>>>) {
  const items = issue.items.map((i) => ({
    ...i,
    quantity: num(i.quantity),
    unitCost: num(i.unitCost),
    amount: num(i.amount),
  }));
  return { ...issue, items, value: cents(items.reduce((s, i) => s + i.amount, 0)) };
}

/** Raising, and changing a draft: the create right, or edit_all. */
const ISSUE_EDIT = ['gchain.stock_issuance.create', 'gchain.stock_issuance.edit_all'] as const;

const ISSUE_DOC = 'stock_issue';
const ISSUE_VIEW = 'gchain.stock_issuance.view_all';

/**
 * The slip as its reader may see it: the register's right, or — through
 * `requireAnyOrDecider` — whoever may decide its open request (the issuer's
 * supervisor with no warehouse right), only while it waits on them.
 */
async function visibleIssue(me: ResolvedUser, id: string, deciderOnly: boolean) {
  const issue = await loadIssue(id);
  if (!issue) throw notFound('Stock issue not found');
  if (deciderOnly && !(await mayDecide(me.id, ISSUE_DOC, [issue.id]))) throw notFound('Stock issue not found');
  return issue;
}

/** The record with what its reader may do — the routes' own rules. */
async function issueView(issue: NonNullable<Awaited<ReturnType<typeof loadIssue>>>, me: ResolvedUser) {
  const view = presentIssue(issue);
  const draft = issue.status === 'DRAFT';
  const raiser = ISSUE_EDIT.some((k) => can(me, k));
  // OUTGOING goes for approval while its route is active; without one the
  // slip is issued at once, as it was before (the sales order's rule).
  const route = draft ? await pickWorkflow(ISSUE_DOC, view.value, { requesterId: issue.issuedById }) : null;
  return {
    ...view,
    // A DRAFT is changed by whoever may raise one (or edit_all) and deleted
    // by a delete holder; a pending one is pulled back first; issued stock
    // has moved.
    canEdit: draft && raiser,
    canDelete: draft && can(me, 'gchain.stock_issuance.delete'),
    needsApproval: draft ? !!route : null,
    canSubmit: draft && !!route && raiser && issue.items.length > 0,
    canIssue: draft && !route && can(me, 'gchain.stock_issuance.create') && issue.items.length > 0,
    canWithdraw: issue.status === 'PENDING_APPROVAL' && raiser,
    approvalRoute: draft && route ? await routeBrief(ISSUE_DOC, view.value, issue.issuedById) : null,
  };
}

stockIssueRoutes.get(
  '/:id',
  requireAnyOrDecider(ISSUE_VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    const issue = await visibleIssue(me, req.params.id, res.locals.deciderOnly === true);
    res.json(await issueView(issue, me));
  }),
);

const issueSchema = z.object({
  jobId: z.string().optional().nullable(),
  warehouseId: z.string().min(1, 'Which warehouse?'),
  issuedToId: z.string().optional().nullable(),
  issuedToName: z.string().trim().optional().nullable(),
  issueDate: z.string().optional().nullable(),
  purpose: z.string().trim().min(3, 'Say what this is for'),
  notes: z.string().optional().nullable(),
});

stockIssueRoutes.post(
  '/',
  require_('gchain.stock_issuance.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(issueSchema, req.body);

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
        },
      });
    });

    await audit(
      { entityType: 'stock_issue', entityId: issue.id, action: 'CREATED', summary: `Raised ${issue.number} — ${issue.purpose}` },
      req,
    );
    res.status(201).json(issue);
  }),
);

async function issueForEdit(id: string) {
  const issue = await prisma.stockIssue.findUnique({ where: { id } });
  if (!issue) throw notFound('Stock issue not found');
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

/** A draft is deleted outright — nothing has moved. An issued one is the record of stock that left. */
stockIssueRoutes.delete(
  '/:id',
  require_('gchain.stock_issuance.delete'),
  handler(async (req, res) => {
    const issue = await prisma.stockIssue.findUnique({ where: { id: req.params.id } });
    if (!issue) throw notFound('Stock issue not found');
    if (issue.status !== 'DRAFT') {
      throw badRequest(`${issue.number} has been issued — the stock has moved, so it stays on record`);
    }
    const gone = await prisma.stockIssue.deleteMany({ where: { id: issue.id, status: 'DRAFT' } });
    if (!gone.count) throw badRequest(`${issue.number} was issued a moment ago — it stays on record`);
    await audit(
      { entityType: 'stock_issue', entityId: issue.id, action: 'DELETED', summary: `Deleted ${issue.number}` },
      req,
    );
    res.json({ ok: true });
  }),
);

stockIssueRoutes.post(
  '/:id/items',
  requireAny(...ISSUE_EDIT),
  handler(async (req, res) => {
    const issue = await issueForEdit(req.params.id);
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
    const issue = await issueForEdit(req.params.id);
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

  for (const line of current.items) {
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
}

onApprovalSettled(ISSUE_DOC, async (request, outcome) => {
  await settleStockIssue(request.documentId, outcome);
});

// The signed gate pass, photos of what left: read as the slip is read, added
// while it is a draft or pending by whoever may raise one.
registerAttachmentGuard(
  'stock_issue',
  async (user, id) => {
    if (can(user, ISSUE_VIEW)) return !!(await prisma.stockIssue.findUnique({ where: { id }, select: { id: true } }));
    return mayDecide(user.id, ISSUE_DOC, [id]);
  },
  {
    write: async (user, id) => {
      const r = await prisma.stockIssue.findUnique({ where: { id }, select: { status: true } });
      return !!r && (r.status === 'DRAFT' || r.status === 'PENDING_APPROVAL') && ISSUE_EDIT.some((k) => can(user, k));
    },
  },
);

// ════════════════════════════════════════════════════════════════════
//  BORROW SLIPS
// ════════════════════════════════════════════════════════════════════

export const borrowRoutes = Router();
borrowRoutes.use(authenticate);

const BORROW_SORTS = ['number', 'dueAt', 'borrowedAt'];

/**
 * Which borrow slips a list query means — one rule for the list and its
 * printed twin. `day` is the one "today" for the filter, each row's flag and
 * both dashboard tiles, so a slip the list flags as overdue is one the Overdue
 * filter finds. Overdue, when asked, decides the status by itself.
 */
function borrowListWhere(q: ListQuery, day: Date): Prisma.BorrowSlipWhereInput {
  const and: Prisma.BorrowSlipWhereInput[] = [];
  if (q.filters.overdue === 'true') and.push({ status: { in: ['OUT', 'PARTIALLY_RETURNED'] }, dueAt: { lt: day } });
  else {
    const status = choice(q.filters.status, BorrowStatus, 'Status');
    if (status) and.push({ status });
  }
  if (q.filters.jobId) and.push({ jobId: q.filters.jobId });
  if (q.search) {
    and.push({
      OR: [
        { number: { contains: q.search, mode: 'insensitive' } },
        { borrowerName: { contains: q.search, mode: 'insensitive' } },
        { purpose: { contains: q.search, mode: 'insensitive' } },
      ],
    });
  }
  const ids = idsFilter(q.filters.ids);
  if (ids) and.push({ id: { in: ids } });
  return and.length ? { AND: and } : {};
}

/**
 * How late a slip is, against the DAY, not the instant: dueAt is a date, held
 * as UTC midnight, so `dueAt < new Date()` flagged a slip from 08:00 on the
 * day it was due back. 0 for a slip that is back or not yet due.
 */
function daysOverdue(slip: { status: string; dueAt: Date }, day: Date): number {
  const out = slip.status === 'OUT' || slip.status === 'PARTIALLY_RETURNED';
  return out && slip.dueAt < day ? Math.floor((day.getTime() - slip.dueAt.getTime()) / 86400000) : 0;
}

/** What is still out on a slip, across its lines. */
const stillOut = (items: { quantity: Prisma.Decimal; returnedQty: Prisma.Decimal }[]) =>
  cents(items.reduce((s, i) => s + num(i.quantity) - num(i.returnedQty), 0));

borrowRoutes.get(
  '/',
  require_('gchain.borrow_slips.view_all'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const day = today();
    const where = borrowListWhere(q, day);

    const [rows, total] = await Promise.all([
      prisma.borrowSlip.findMany({
        where,
        include: {
          job: { select: { id: true, number: true, name: true } },
          warehouse: { select: { id: true, name: true } },
          items: { include: { item: { select: { id: true, code: true, name: true } } } },
        },
        orderBy: orderBy(q, BORROW_SORTS, { borrowedAt: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.borrowSlip.count({ where }),
    ]);

    res.json(
      listResult(
        rows.map((r) => {
          const late = daysOverdue(r, day);
          return {
            id: r.id,
            number: r.number,
            status: r.status,
            borrowerName: r.borrowerName,
            purpose: r.purpose,
            borrowedAt: r.borrowedAt,
            dueAt: r.dueAt,
            returnedAt: r.returnedAt,
            job: r.job,
            warehouse: r.warehouse,
            itemCount: r.items.length,
            outstandingQty: stillOut(r.items),
            isOverdue: late > 0,
            daysOverdue: late,
          };
        }),
        total,
        q,
      ),
    );
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
  require_('gchain.borrow_slips.view_all'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const day = today();
    const where = borrowListWhere(q, day);
    const f = q.filters;
    const [rows, count, project] = await Promise.all([
      prisma.borrowSlip.findMany({
        where,
        include: {
          job: { select: { number: true } },
          items: { select: { quantity: true, returnedQty: true } },
        },
        orderBy: orderBy(q, BORROW_SORTS, { borrowedAt: 'desc' }),
        take: LIST_CAP,
      }),
      prisma.borrowSlip.count({ where }),
      recordNamed('project', f.jobId),
    ]);
    const reference = listReference(count, rows.length, ['borrow slip', 'borrow slips'], [
      q.search && `search "${q.search}"`,
      f.overdue === 'true' ? 'overdue' : f.status && `status ${statusLabel(f.status)}`,
      project,
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
            const out = stillOut(b.items);
            return [
              b.number,
              { title: b.borrowerName, body: b.purpose },
              b.job?.number ?? '',
              formatShortDate(b.borrowedAt),
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

async function loadSlip(id: string) {
  return prisma.borrowSlip.findUnique({
    where: { id },
    include: {
      job: { select: { id: true, number: true, name: true } },
      warehouse: { select: { id: true, name: true } },
      issuedBy: { select: { id: true, name: true } },
      items: { include: { item: { select: { id: true, code: true, name: true, unit: true } } } },
    },
  });
}

function presentSlip(slip: NonNullable<Awaited<ReturnType<typeof loadSlip>>>, me: ResolvedUser) {
  return {
    ...slip,
    // The route's own rule (PATCH /:id): while anything is still out.
    canEdit: slip.status !== 'RETURNED' && can(me, 'gchain.borrow_slips.edit_all'),
    items: slip.items.map((i) => ({
      ...i,
      quantity: num(i.quantity),
      returnedQty: num(i.returnedQty),
      outstandingQty: cents(num(i.quantity) - num(i.returnedQty)),
    })),
  };
}

borrowRoutes.get(
  '/:id',
  require_('gchain.borrow_slips.view_all'),
  handler(async (req, res) => {
    const slip = await loadSlip(req.params.id);
    if (!slip) throw notFound('Borrow slip not found');
    res.json(presentSlip(slip, currentUser(req)));
  }),
);

/**
 * Modifying a slip while anything on it is still out: who has it, when it is
 * due back, what it is for, the notes. The warehouse and the items are fixed —
 * the stock has moved out of available against them — so a key for either is
 * refused rather than ignored. A borrower renamed without a login named loses
 * the old login link, so the clearance scan matches the new name and never
 * charges the tools to the person the slip no longer names.
 */
borrowRoutes.patch(
  '/:id',
  require_('gchain.borrow_slips.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(
      z
        .object({
          borrowerId: z.string().optional().nullable(),
          borrowerName: z.string().trim().min(2, 'Who is borrowing?').optional(),
          dueAt: z.string().min(1, 'When is it due back?').optional(),
          purpose: z.string().trim().min(3, 'What is it for?').optional(),
          notes: z.string().optional().nullable(),
        })
        .strict(),
      req.body,
    );
    const slip = await prisma.borrowSlip.findUnique({ where: { id: req.params.id } });
    if (!slip) throw notFound('Borrow slip not found');
    if (slip.status === 'RETURNED') {
      throw badRequest(`Everything on ${slip.number} is back — the slip is a record now`);
    }

    const dueAt = body.dueAt !== undefined ? asDate(body.dueAt)! : slip.dueAt;
    if (dueAt.getTime() < slip.borrowedAt.getTime()) {
      throw badRequest(`It cannot be due back before it went out on ${formatDate(slip.borrowedAt)}`);
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

    // Claimed on something still being out: the last return wins.
    const claimed = await prisma.borrowSlip.updateMany({
      where: { id: slip.id, status: { not: 'RETURNED' } },
      data: {
        borrowerId,
        dueAt,
        ...(body.borrowerName !== undefined ? { borrowerName: body.borrowerName } : {}),
        ...(body.purpose !== undefined ? { purpose: body.purpose } : {}),
        ...(body.notes !== undefined ? { notes: body.notes?.trim() || null } : {}),
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
    res.json(presentSlip((await loadSlip(slip.id))!, currentUser(req)));
  }),
);

/**
 * Lending tools out.
 *
 * A borrow slip does NOT charge job cost (model §4.3) — the asset is on loan,
 * not consumed. Stock stays owned; only availability moves.
 */
borrowRoutes.post(
  '/',
  require_('gchain.borrow_slips.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(
      z.object({
        jobId: z.string().optional().nullable(),
        warehouseId: z.string().min(1, 'Which warehouse?'),
        borrowerId: z.string().optional().nullable(),
        borrowerName: z.string().trim().min(2, 'Who is borrowing?'),
        dueAt: z.string().min(1, 'When is it due back?'),
        purpose: z.string().trim().min(3, 'What is it for?'),
        notes: z.string().optional().nullable(),
        items: z
          .array(
            z.object({
              itemId: z.string().min(1),
              quantity: z.number().positive(),
              serialNo: z.string().trim().optional().nullable(),
            }),
          )
          .min(1, 'Add at least one item'),
      }),
      req.body,
    );

    const slip = await prisma.$transaction(async (tx) => {
      const number = await nextNumber('borrow_slip', tx);
      const created = await tx.borrowSlip.create({
        data: {
          number,
          jobId: body.jobId || null,
          warehouseId: body.warehouseId,
          borrowerId: body.borrowerId || null,
          borrowerName: body.borrowerName,
          issuedById: me.id,
          // Set here rather than left to the column's now(): the database
          // takes its date in UTC.
          borrowedAt: today(),
          dueAt: new Date(body.dueAt),
          purpose: body.purpose,
          notes: body.notes || null,
          items: {
            create: body.items.map((i) => ({
              itemId: i.itemId,
              quantity: D(i.quantity),
              serialNo: i.serialNo || null,
            })),
          },
        },
      });

      for (const line of body.items) {
        await borrowStock(tx, {
          itemId: line.itemId,
          warehouseId: body.warehouseId,
          quantity: line.quantity,
          sourceType: 'borrow_slip',
          sourceId: created.id,
          sourceNumber: created.number,
          createdById: me.id,
        });
      }
      return created;
    });

    await audit(
      {
        entityType: 'borrow_slip',
        entityId: slip.id,
        action: 'CREATED',
        summary: `${slip.number} lent to ${slip.borrowerName}, due ${formatDate(slip.dueAt)}`,
      },
      req,
    );
    res.status(201).json(slip);
  }),
);

borrowRoutes.post(
  '/:id/return',
  require_('gchain.borrow_slips.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(
      z.object({
        items: z.array(z.object({ itemId: z.string(), quantity: z.number().positive() })).min(1),
      }),
      req.body,
    );

    const slip = await prisma.borrowSlip.findUnique({
      where: { id: req.params.id },
      include: { items: true },
    });
    if (!slip) throw notFound('Borrow slip not found');
    if (slip.status === 'RETURNED') throw badRequest('Everything on this slip is already back');

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
          data: { returnedQty: D(num(slipItem.returnedQty) + line.quantity) },
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
        },
      });
    });

    await audit(
      {
        entityType: 'borrow_slip',
        entityId: slip.id,
        action: 'UPDATED',
        summary: `Items returned on ${slip.number}`,
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
 * Which balances a stock list query means — one rule for the list and its
 * printed twin. "Below level" compares two columns, which a where-clause
 * cannot, so it is decided by `belowReorder` over the candidates and named by
 * id: the list then pages and counts the reorder set like any other, where it
 * used to filter one page after the database had cut it.
 */
async function inventoryListWhere(q: ListQuery): Promise<Prisma.InventoryBalanceWhereInput> {
  const and: Prisma.InventoryBalanceWhereInput[] = [];
  if (q.filters.warehouseId) and.push({ warehouseId: q.filters.warehouseId });
  if (q.search) {
    and.push({
      item: {
        OR: [
          { name: { contains: q.search, mode: 'insensitive' } },
          { code: { contains: q.search, mode: 'insensitive' } },
          { partNumber: { contains: q.search, mode: 'insensitive' } },
        ],
      },
    });
  }
  const ids = idsFilter(q.filters.ids);
  if (ids) and.push({ id: { in: ids } });
  if (q.filters.needsReorder === 'true') {
    const candidates = await prisma.inventoryBalance.findMany({
      where: { AND: [...and, REORDER_CANDIDATES] },
      select: { id: true, quantity: true, borrowedQty: true, item: { select: { reorderLevel: true } } },
    });
    and.push({ id: { in: candidates.filter(belowReorder).map((b) => b.id) } });
  }
  return and.length ? { AND: and } : {};
}

inventoryRoutes.get(
  '/',
  require_('gchain.inventory.view_all'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const where = await inventoryListWhere(q);

    const [rows, total] = await Promise.all([
      prisma.inventoryBalance.findMany({
        where,
        include: {
          item: {
            select: {
              id: true,
              code: true,
              name: true,
              unit: true,
              minStock: true,
              reorderLevel: true,
              category: { select: { name: true } },
            },
          },
          warehouse: { select: { id: true, name: true } },
        },
        orderBy: { item: { name: 'asc' } },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.inventoryBalance.count({ where }),
    ]);

    res.json(
      listResult(
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
            quantity,
            borrowedQty: num(r.borrowedQty),
            available: availableOf(r),
            averageCost: num(r.averageCost),
            value: cents(quantity * num(r.averageCost)),
            needsReorder: belowReorder(r),
          };
        }),
        total,
        q,
      ),
    );
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
  require_('gchain.inventory.view_all'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const where = await inventoryListWhere(q);
    const f = q.filters;
    const [rows, count, all, currency, warehouse] = await Promise.all([
      prisma.inventoryBalance.findMany({
        where,
        include: {
          item: { select: { code: true, name: true, unit: true, reorderLevel: true, category: { select: { name: true } } } },
          warehouse: { select: { name: true } },
        },
        orderBy: { item: { name: 'asc' } },
        take: LIST_CAP,
      }),
      prisma.inventoryBalance.count({ where }),
      prisma.inventoryBalance.findMany({ where, select: { quantity: true, averageCost: true } }),
      companyCurrency(),
      f.warehouseId ? prisma.warehouse.findUnique({ where: { id: f.warehouseId }, select: { name: true } }) : null,
    ]);
    const reference = listReference(count, rows.length, ['stock line', 'stock lines'], [
      q.search && `search "${q.search}"`,
      f.warehouseId && `warehouse ${warehouse?.name ?? 'not found'}`,
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
          head: ['Item', 'Warehouse', 'Unit', 'On hand', 'On loan', 'Available', 'Reorder at', `Avg. cost (${currency})`, `Value (${currency})`, 'Reorder'],
          align: ['left', 'left', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'left'],
          rows: rows.map((b) => [
            { title: b.item.name, body: [b.item.code, b.item.category?.name].filter(Boolean).join(' · ') },
            b.warehouse.name,
            b.item.unit,
            qty(num(b.quantity)),
            num(b.borrowedQty) ? qty(num(b.borrowedQty)) : '',
            qty(availableOf(b)),
            b.item.reorderLevel == null ? '' : qty(num(b.item.reorderLevel)),
            formatAmount(num(b.averageCost)),
            formatAmount(cents(num(b.quantity) * num(b.averageCost))),
            belowReorder(b) ? 'Below level' : '',
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
  require_('gchain.inventory.view_all'),
  handler(async (req, res) => {
    const warehouseId = req.query.warehouseId ? String(req.query.warehouseId) : undefined;

    const [item, balances, moves] = await Promise.all([
      prisma.item.findUnique({
        where: { id: req.params.itemId },
        select: { id: true, code: true, name: true, unit: true, reorderLevel: true, minStock: true },
      }),
      prisma.inventoryBalance.findMany({
        where: { itemId: req.params.itemId, ...(warehouseId ? { warehouseId } : {}) },
        include: { warehouse: { select: { id: true, name: true } } },
      }),
      prisma.inventoryTransaction.findMany({
        where: { itemId: req.params.itemId, ...(warehouseId ? { warehouseId } : {}) },
        include: {
          warehouse: { select: { id: true, name: true } },
          createdBy: { select: { id: true, name: true } },
        },
        orderBy: { occurredAt: 'desc' },
        take: 200,
      }),
    ]);
    if (!item) throw notFound('Item not found');

    res.json({
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

stockIssueRoutes.get(
  '/:id/pdf',
  requireAnyOrDecider(ISSUE_VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    const issue = await visibleIssue(me, req.params.id, res.locals.deciderOnly === true);

    const view = presentIssue(issue);
    const currency = await companyCurrency();

    // The people who acted, each dated (rule 6): whoever raised the slip;
    // then its route's steps (the issuer's supervisor — a draft prints the
    // route submitting would take, "Pending" until signed) when it went for
    // approval, else whoever pressed Issue (the trail's EXECUTED row, the
    // only record of who moved the stock); and the person it was issued to,
    // dated by the handover. Never a slot nobody fills: no "Noted by", and
    // no receiver when the slip names none.
    const routed = issue.status === 'DRAFT' && !!(await pickWorkflow(ISSUE_DOC, view.value, { requesterId: issue.issuedById }));
    const slots = routed
      ? await approvalSlots(ISSUE_DOC, issue.id, { amount: view.value, requesterId: issue.issuedById })
      : await approvalSlots(ISSUE_DOC, issue.id);
    const signatories: Signatory[] = [
      { role: 'Prepared by', name: issue.issuedBy.name, ...(await contactOf(issue.issuedById)), at: preparedAt(slots) ?? issue.createdAt },
      ...slotSignatories(slots),
    ];
    if (issue.status === 'ISSUED' && !slots.length) {
      const executed = await prisma.auditLog.findFirst({
        where: { entityType: 'stock_issue', entityId: issue.id, action: 'EXECUTED' },
        orderBy: { at: 'desc' },
        select: { actorId: true, actorName: true, at: true },
      });
      const issuerId = executed?.actorId ?? issue.issuedById;
      signatories.push({
        role: 'Issued by',
        name: executed?.actorName ?? issue.issuedBy.name,
        ...(await contactOf(issuerId)),
        at: issue.issuedAt ?? executed?.at ?? null,
      });
    }
    // A cancelled slip is handed to nobody, so it names no receiver.
    if (issue.issuedToName && issue.status !== 'CANCELLED') {
      signatories.push({
        role: 'Received by',
        name: issue.issuedToName,
        ...(await contactOf(issue.issuedToId)),
        at: issue.status === 'ISSUED' ? issue.issuedAt : null,
      });
    }

    const pdf = await renderDocument({
      title: 'Outgoing Slip',
      documentNumber: issue.number,
      date: issue.issueDate,
      reference: issue.job ? `${issue.job.number} — ${issue.job.name}` : issue.purpose,
      sections: [
        {
          kind: 'fields',
          columns: 3,
          fields: [
            { label: 'Warehouse', value: issue.warehouse.name },
            { label: 'Project', value: issue.job ? `${issue.job.number}` : '—' },
            { label: 'Issued to', value: issue.issuedToName ?? '—' },
            { label: 'Purpose', value: issue.purpose },
            // Who raised the slip — `issuedById` is its author, set on
            // create. Who pressed Issue is the sign-off's "Issued by".
            { label: 'Prepared by', value: issue.issuedBy.name },
            { label: 'Status', value: statusLabel(issue.status) },
          ],
        },
        {
          kind: 'table',
          title: 'Items issued',
          head: ['No.', 'Code', 'Description', 'Qty', 'Unit', `Unit cost (${currency})`, `Amount (${currency})`],
          align: ['right', 'left', 'left', 'right', 'left', 'right', 'right'],
          rows: view.items.map((i, n) => [
            String(n + 1),
            i.item.code,
            i.item.name,
            String(i.quantity),
            i.item.unit,
            formatAmount(i.unitCost),
            formatAmount(i.amount),
          ]),
        },
        { kind: 'totals', rows: [{ label: 'Total', value: formatMoney(view.value, currency), bold: true }] },
      ],
      signatories,
    });
    const files = req.query.attachments === '0' ? [] : await attachedFiles('stock_issue', issue.id);
    const { pdf: withFiles, listed } = await withAttachments(pdf, files, { title: 'Outgoing Slip', number: issue.number, reference: issue.purpose });

    await audit(
      { entityType: 'stock_issue', entityId: issue.id, action: 'EXPORTED', summary: `Printed ${issue.number}${listed ? ` with ${listed} attachment${listed === 1 ? '' : 's'}` : ''}` },
      req,
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition(paperFileName({ kind: 'Outgoing Slip', number: issue.number, author: issue.issuedBy.name, date: issue.issueDate })));
    res.send(withFiles);
  }),
);

// ── Global search ────────────────────────────────────────────────────────────
// Warehouse documents by number. These registers are view_all-only, so there
// is no own scope to narrow to. Numbers and names only.

registerSearch({
  kind: 'receiving',
  label: 'Incoming',
  permission: 'gchain.receiving.view_all',
  async search(term, _user, limit) {
    const rows = await prisma.receiving.findMany({
      where: {
        OR: [
          { number: { contains: term, mode: 'insensitive' } },
          { deliveryRefNo: { contains: term, mode: 'insensitive' } },
          { order: { number: { contains: term, mode: 'insensitive' } } },
        ],
      },
      orderBy: { receivedDate: 'desc' },
      take: limit,
      select: {
        id: true,
        number: true,
        order: { select: { number: true, supplier: { select: { name: true } } } },
      },
    });
    return rows.map((r) => ({
      kind: 'receiving',
      id: r.id,
      title: `${r.number} — ${r.order.supplier.name}`,
      subtitle: `Against ${r.order.number}`,
      link: `/g-chain/incoming/${r.id}`,
    }));
  },
});

registerSearch({
  kind: 'stock_issue',
  label: 'Outgoing',
  permission: 'gchain.stock_issuance.view_all',
  async search(term, _user, limit) {
    const rows = await prisma.stockIssue.findMany({
      where: {
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
