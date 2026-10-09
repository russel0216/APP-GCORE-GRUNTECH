import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import {
  handler,
  parseBody,
  listQuery,
  listResult,
  orderBy,
  notFound,
  badRequest,
} from '../http/kit';
import { authenticate, require_, requireAny, currentUser } from '../auth/middleware';
import { can, type ResolvedUser } from '../permissions/resolve';
import { audit } from '../shared/audit';
import { registerSearch } from '../shared/search';
import { stockOnHand } from '../shared/chain';
import { nextNumber } from '../shared/numbering';
import { notify } from '../shared/notifications';
import { renderDocument, formatMoney, formatDate } from '../shared/pdf';
import { manilaDate } from '../shared/day';
import {
  receiveStock,
  issueStock,
  borrowStock,
  returnBorrowedStock,
  postJobCost,
  releaseCommitment,
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

/**
 * Today, for a DATE column: Manila's date. A bare `new Date()` written into,
 * or compared with, a DATE column is the UTC date — yesterday's until 08:00,
 * which is when crews collect their materials and tools.
 */
const today = () => manilaDate(new Date());

// ════════════════════════════════════════════════════════════════════
//  RECEIVING
// ════════════════════════════════════════════════════════════════════

export const receivingRoutes = Router();
receivingRoutes.use(authenticate);

receivingRoutes.get(
  '/',
  require_('gchain.receiving.view_all'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const where: Prisma.ReceivingWhereInput = {};
    if (q.filters.orderId) where.orderId = q.filters.orderId;
    // A receiving has no job of its own — it inherits its order's. The job
    // workspace's Procurement tab lists a project's deliveries through this.
    if (q.filters.jobId) where.order = { jobId: q.filters.jobId };
    if (q.search) {
      where.OR = [
        { number: { contains: q.search, mode: 'insensitive' } },
        { deliveryRefNo: { contains: q.search, mode: 'insensitive' } },
        { order: { number: { contains: q.search, mode: 'insensitive' } } },
        { order: { supplier: { name: { contains: q.search, mode: 'insensitive' } } } },
      ];
    }

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
        orderBy: orderBy(q, ['number', 'receivedDate'], { receivedDate: 'desc' }),
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

function presentReceiving(receiving: NonNullable<Awaited<ReturnType<typeof loadReceiving>>>, me: ResolvedUser) {
  // Finance's register, listed only to those who can open it.
  const seesBills = can(me, 'gfin.ap.view_all');
  return {
    ...receiving,
    bills: seesBills ? receiving.bills : [],
    billsVisible: seesBills,
    // Its references only (PATCH /:id): what arrived is the record.
    canEdit: can(me, 'gchain.receiving.edit_all'),
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
    value: cents(receiving.items.reduce((s, i) => s + num(i.quantity) * num(i.unitCost), 0)),
  };
}

receivingRoutes.get(
  '/:id',
  require_('gchain.receiving.view_all'),
  handler(async (req, res) => {
    const receiving = await loadReceiving(req.params.id);
    if (!receiving) throw notFound('Receiving report not found');
    res.json(presentReceiving(receiving, currentUser(req)));
  }),
);

/**
 * A receiving report is a record of what arrived: its lines, quantities,
 * costs, warehouse and date moved stock and job cost, and stay as they were.
 * Only its paper references change — the delivery receipt and supplier
 * invoice numbers, and the notes — and a key it cannot change is refused,
 * not ignored.
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
    res.json(presentReceiving((await loadReceiving(existing.id))!, currentUser(req)));
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

    // Over-delivery is refused outright: receiving more than was ordered means
    // either the delivery or the order is wrong, and quietly accepting it
    // corrupts both the commitment release and the stock value.
    const byOrderItem = new Map(order.items.map((i) => [i.id, i]));
    for (const line of body.items) {
      const orderItem = byOrderItem.get(line.orderItemId);
      if (!orderItem) throw badRequest('One of the lines is not on that order');
      const outstanding = num(orderItem.quantity) - num(orderItem.receivedQty);
      if (line.quantity > outstanding + 0.0005) {
        throw badRequest(
          `${orderItem.description}: ${outstanding} outstanding on the order, ${line.quantity} being received. ` +
            `Amend the order if the delivery is genuinely larger.`,
        );
      }
    }

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

      const byCategory = new Map<string, number>();

      for (const line of body.items) {
        const orderItem = byOrderItem.get(line.orderItemId)!;
        const unitCost = line.unitCost ?? num(orderItem.unitPrice);
        const amount = cents(line.quantity * unitCost);

        await tx.purchaseOrderItem.update({
          where: { id: orderItem.id },
          data: { receivedQty: D(num(orderItem.receivedQty) + line.quantity) },
        });

        // ONLY a stock replenishment builds inventory.
        //
        // Direct-to-job material is charged to the project the moment it
        // arrives. If it also entered stock, issuing it to that same project
        // later would charge it a second time at average cost — the exact
        // double-count the two purchase kinds exist to prevent. It may still
        // physically pass through the store; that is a storage detail, not a
        // stock balance.
        if (order.kind === 'STOCK_REPLENISHMENT' && warehouseId && orderItem.itemId) {
          await receiveStock(tx, {
            itemId: orderItem.itemId,
            warehouseId,
            quantity: line.quantity,
            unitCost,
            sourceType: 'receiving',
            sourceId: created.id,
            sourceNumber: created.number,
            createdById: me.id,
          });
        }

        if (order.kind === 'DIRECT_TO_JOB' && orderItem.costCategoryId) {
          byCategory.set(
            orderItem.costCategoryId,
            (byCategory.get(orderItem.costCategoryId) ?? 0) + amount,
          );
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
            reason: `Received on ${created.number}`,
            createdById: me.id,
          });
          await postJobCost(tx, {
            jobId: order.jobId,
            costCategoryId,
            state: 'INCURRED',
            amount,
            sourceType: 'receiving',
            sourceId: created.id,
            sourceNumber: created.number,
            description: `Goods received from ${order.supplier.name}`,
            createdById: me.id,
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

      return created;
    });

    await audit(
      {
        entityType: 'receiving',
        entityId: receiving.id,
        action: 'CREATED',
        summary: `${receiving.number} received against ${order.number}`,
      },
      req,
    );

    if (order.jobId && order.job) {
      await notify({
        userId: me.id,
        type: 'po.received',
        title: `Goods received — ${order.number}`,
        body: `${order.job.number} · ${receiving.number}`,
        link: `/g-chain/receiving/${receiving.id}`,
      });
    }

    res.status(201).json(receiving);
  }),
);

// ════════════════════════════════════════════════════════════════════
//  STOCK ISSUANCE
// ════════════════════════════════════════════════════════════════════

export const stockIssueRoutes = Router();
stockIssueRoutes.use(authenticate);

stockIssueRoutes.get(
  '/',
  require_('gchain.stock_issuance.view_all'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const where: Prisma.StockIssueWhereInput = {};
    if (q.filters.status) where.status = q.filters.status as Prisma.EnumIssueStatusFilter['equals'];
    if (q.filters.jobId) where.jobId = q.filters.jobId;
    if (q.search) {
      where.OR = [
        { number: { contains: q.search, mode: 'insensitive' } },
        { purpose: { contains: q.search, mode: 'insensitive' } },
        { job: { name: { contains: q.search, mode: 'insensitive' } } },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.stockIssue.findMany({
        where,
        include: {
          job: { select: { id: true, number: true, name: true } },
          warehouse: { select: { id: true, name: true } },
          issuedBy: { select: { id: true, name: true } },
          items: { select: { amount: true } },
        },
        orderBy: orderBy(q, ['number', 'issueDate'], { issueDate: 'desc' }),
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

stockIssueRoutes.get(
  '/:id',
  require_('gchain.stock_issuance.view_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const issue = await loadIssue(req.params.id);
    if (!issue) throw notFound('Stock issue not found');
    const draft = issue.status === 'DRAFT';
    res.json({
      ...presentIssue(issue),
      // The routes' own rules: a DRAFT is changed by whoever may raise one
      // (or edit_all) and deleted by a delete holder; issued stock has moved.
      canEdit: draft && ISSUE_EDIT.some((k) => can(me, k)),
      canDelete: draft && can(me, 'gchain.stock_issuance.delete'),
    });
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
 * Committing the issue: stock leaves, and if it is for a job, the job is
 * charged. This is where stock-sourced material first hits a project (§4.3).
 */
stockIssueRoutes.post(
  '/:id/issue',
  require_('gchain.stock_issuance.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const issue = await prisma.stockIssue.findUnique({
      where: { id: req.params.id },
      include: { items: { select: { id: true } } },
    });
    if (!issue) throw notFound('Stock issue not found');
    if (issue.status !== 'DRAFT') throw badRequest('This issue has already been made');
    if (!issue.items.length) throw badRequest('Add at least one line before issuing');

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
      const current = await tx.stockIssue.findUniqueOrThrow({
        where: { id: issue.id },
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
          createdById: me.id,
        });

        // Re-price at the average as at the moment of issue, which may have
        // moved since the line was added.
        await tx.stockIssueItem.update({
          where: { id: line.id },
          data: { unitCost: D(moved.unitCost), amount: D(moved.amount) },
        });

        if (current.jobId && line.costCategoryId) {
          byCategory.set(
            line.costCategoryId,
            (byCategory.get(line.costCategoryId) ?? 0) + moved.amount,
          );
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
            createdById: me.id,
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
            createdById: me.id,
          });
        }
      }
      return current;
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

    res.json(presentIssue((await loadIssue(issue.id))!));
  }),
);

// ════════════════════════════════════════════════════════════════════
//  BORROW SLIPS
// ════════════════════════════════════════════════════════════════════

export const borrowRoutes = Router();
borrowRoutes.use(authenticate);

borrowRoutes.get(
  '/',
  require_('gchain.borrow_slips.view_all'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const where: Prisma.BorrowSlipWhereInput = {};
    if (q.filters.status) where.status = q.filters.status as Prisma.EnumBorrowStatusFilter['equals'];
    if (q.filters.jobId) where.jobId = q.filters.jobId;
    // One "today" for the filter, each row's flag and both dashboard tiles, so a
    // slip the list flags as overdue is one the Overdue filter finds.
    const day = today();
    if (q.filters.overdue === 'true') {
      where.status = { in: ['OUT', 'PARTIALLY_RETURNED'] };
      where.dueAt = { lt: day };
    }
    if (q.search) {
      where.OR = [
        { number: { contains: q.search, mode: 'insensitive' } },
        { borrowerName: { contains: q.search, mode: 'insensitive' } },
        { purpose: { contains: q.search, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.borrowSlip.findMany({
        where,
        include: {
          job: { select: { id: true, number: true, name: true } },
          warehouse: { select: { id: true, name: true } },
          items: { include: { item: { select: { id: true, code: true, name: true } } } },
        },
        orderBy: orderBy(q, ['number', 'dueAt', 'borrowedAt'], { borrowedAt: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.borrowSlip.count({ where }),
    ]);

    res.json(
      listResult(
        rows.map((r) => ({
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
          outstandingQty: cents(
            r.items.reduce((s, i) => s + num(i.quantity) - num(i.returnedQty), 0),
          ),
          // Against the DAY, not the instant: dueAt is a date, held as UTC
          // midnight, so `dueAt < new Date()` flagged a slip from 08:00 on the
          // day it was due back.
          isOverdue:
            (r.status === 'OUT' || r.status === 'PARTIALLY_RETURNED') && r.dueAt < day,
          daysOverdue:
            (r.status === 'OUT' || r.status === 'PARTIALLY_RETURNED') && r.dueAt < day
              ? Math.floor((day.getTime() - r.dueAt.getTime()) / 86400000)
              : 0,
        })),
        total,
        q,
      ),
    );
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

inventoryRoutes.get(
  '/',
  require_('gchain.inventory.view_all'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const where: Prisma.InventoryBalanceWhereInput = {};
    if (q.filters.warehouseId) where.warehouseId = q.filters.warehouseId;
    if (q.search) {
      where.item = {
        OR: [
          { name: { contains: q.search, mode: 'insensitive' } },
          { code: { contains: q.search, mode: 'insensitive' } },
          { partNumber: { contains: q.search, mode: 'insensitive' } },
        ],
      };
    }

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

    const mapped = rows.map((r) => {
      const quantity = num(r.quantity);
      const borrowed = num(r.borrowedQty);
      const reorderLevel = r.item.reorderLevel == null ? null : num(r.item.reorderLevel);
      const available = cents(quantity - borrowed);
      return {
        id: r.id,
        item: { ...r.item, minStock: r.item.minStock == null ? null : num(r.item.minStock), reorderLevel },
        warehouse: r.warehouse,
        quantity,
        borrowedQty: borrowed,
        available,
        averageCost: num(r.averageCost),
        value: cents(quantity * num(r.averageCost)),
        needsReorder: reorderLevel !== null && available <= reorderLevel,
      };
    });

    // Filtering on a derived flag has to happen after the mapping.
    const filtered = q.filters.needsReorder === 'true' ? mapped.filter((m) => m.needsReorder) : mapped;

    res.json(listResult(filtered, q.filters.needsReorder === 'true' ? filtered.length : total, q));
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

      const level = b.item.reorderLevel == null ? null : num(b.item.reorderLevel);
      const available = cents(quantity - num(b.borrowedQty));
      if (level !== null && available <= level) {
        reorder.push({
          itemId: b.item.id,
          warehouseId: b.warehouseId,
          item: b.item.name,
          code: b.item.code,
          warehouse: b.warehouse.name,
          available,
          reorderLevel: level,
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
  require_('gchain.stock_issuance.view_all'),
  handler(async (req, res) => {
    const issue = await loadIssue(req.params.id);
    if (!issue) throw notFound('Stock issue not found');

    const view = presentIssue(issue);
    const company = await prisma.company.findUnique({ where: { id: 'company' } });
    const currency = company?.currency ?? 'PHP';

    const pdf = await renderDocument({
      title: 'Stock Issuance',
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
            { label: 'Issued by', value: issue.issuedBy.name },
            { label: 'Status', value: issue.status },
          ],
        },
        {
          kind: 'table',
          title: 'Items issued',
          head: ['#', 'Code', 'Description', 'Qty', 'Unit', 'Unit cost', 'Amount'],
          widths: [5, 14, 33, 9, 8, 15, 16],
          align: ['right', 'left', 'left', 'right', 'left', 'right', 'right'],
          rows: [
            ...view.items.map((i, n) => [
              String(n + 1),
              i.item.code,
              i.item.name,
              String(i.quantity),
              i.item.unit,
              formatMoney(i.unitCost, currency),
              formatMoney(i.amount, currency),
            ]),
            ['', '', 'TOTAL', '', '', '', formatMoney(view.value, currency)],
          ],
        },
      ],
      signatories: [
        { role: 'Issued by', name: issue.issuedBy.name, at: issue.createdAt },
        { role: 'Received by', name: issue.issuedToName ?? undefined },
        { role: 'Noted by' },
      ],
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${issue.number}.pdf"`);
    res.send(pdf);
  }),
);

// ── Global search ────────────────────────────────────────────────────────────
// Warehouse documents by number. These registers are view_all-only, so there
// is no own scope to narrow to. Numbers and names only.

registerSearch({
  kind: 'receiving',
  label: 'Receiving',
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
      link: `/g-chain/receiving/${r.id}`,
    }));
  },
});

registerSearch({
  kind: 'stock_issue',
  label: 'Stock issues',
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
      link: `/g-chain/stock-issuance/${r.id}`,
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
