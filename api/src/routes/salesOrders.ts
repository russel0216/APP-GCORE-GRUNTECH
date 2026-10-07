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
  forbidden,
} from '../http/kit';
import { authenticate, require_, requireAny, currentUser } from '../auth/middleware';
import { can, canEditRecord } from '../permissions/resolve';
import { audit } from '../shared/audit';
import { nextNumber } from '../shared/numbering';
import { manilaDate } from '../shared/day';
import { rememberGroups } from '../shared/quotationGroups';
import {
  lineAmount,
  quotationTotals,
  stripLineCost,
  QUOTATION_EXTRA_TAX_RATES,
} from '../shared/quotation';
import { valueRevision } from '../shared/pipeline';
import { bookingFor, thou } from '../shared/salesOrderBooking';
import { formatAmount, formatDate, formatShortDate, type PdfTotal, type Signatory } from '../shared/pdf';
import { renderDesigned, type DesignData, type DesignRow } from '../shared/pdfDesign';
import { salesOrderDesign, withoutCostColumns } from '../shared/salesOrderTemplate';
import { contactPhone } from '../shared/approvals';

/**
 * SALES ORDERS — SCORO's "Create invoice", under its real name here: the
 * document that books a quotation's work in Gruntech operations
 * (2026-10-07, the owner's call; patterned on SCORO quote 8442 → invoices
 * 4622 and 4622.1).
 *
 * The rules it lives by:
 *  - Raised FROM a quotation — all of its value revision, chosen lines, or
 *    one summarised line — never from nothing. The lead → quotation → order
 *    chain is what makes the booking traceable.
 *  - One quotation, one base number: the first order takes the next number
 *    of the `sales_order` series; every later one is `<base>.1`, `<base>.2`…
 *    (progress booking), issued inside the transaction.
 *  - The money arithmetic is the quotation's own (`quotationTotals`), and
 *    cost visibility is the quotation's own rule: the author, `edit_all`, or
 *    `gops.costing.view_all` — everybody else gets the lines with the cost
 *    keys REMOVED, server-side.
 *  - An internal document: the PDF prints cost and margin to those who may
 *    see cost. It never goes to the customer — the invoice is G-FIN's.
 */

export const salesOrderRoutes = Router();
salesOrderRoutes.use(authenticate);

const d = (v: number | string | Prisma.Decimal) => new Prisma.Decimal(v);
const num = (v: Prisma.Decimal | number | null | undefined) => (v == null ? 0 : Number(v));

export function canSeeOrderCost(me: ReturnType<typeof currentUser>, ownerId: string): boolean {
  return canEditRecord(me, 'gops', 'sales_orders', ownerId) || can(me, 'gops.costing.view_all');
}

const ORDER_INCLUDE = {
  customer: { select: { id: true, code: true, name: true, tin: true, phone: true } },
  contact: { select: { id: true, name: true, position: true } },
  quotation: { select: { id: true, number: true, subject: true, siteId: true } },
  owner: { select: { id: true, name: true, email: true, position: true } },
} as const;

/** The quotation an order is booked from, with the lines of every revision — or a refusal. */
async function bookableQuotation(me: ReturnType<typeof currentUser>, quotationId: string) {
  const quotation = await prisma.quotation.findUnique({
    where: { id: quotationId },
    include: { revisions: { include: { items: { orderBy: { sortOrder: 'asc' } } } } },
  });
  if (!quotation) throw notFound('Quotation not found');
  if (!me.isSuperAdmin && !me.permissions.has('gops.quotations.view_all') && quotation.ownerId !== me.id) {
    throw forbidden('That quotation is someone else’s');
  }
  return quotation;
}

/** Totals recomputed from the lines — the only writer of an order's money. */
async function recalcOrder(orderId: string, tx: Prisma.TransactionClient = prisma): Promise<void> {
  const order = await tx.salesOrder.findUniqueOrThrow({
    where: { id: orderId },
    include: { lines: { orderBy: { sortOrder: 'asc' } } },
  });
  const totals = quotationTotals({
    lines: order.lines,
    discountPct: order.discountPct,
    vatRate: order.vatRate,
    vatInclusive: order.vatInclusive,
  });
  await tx.salesOrder.update({
    where: { id: orderId },
    data: {
      subtotal: d(totals.subtotal),
      discountAmount: d(totals.discountAmount),
      vatAmount: d(totals.vatAmount),
      total: d(totals.total),
    },
  });
}

/** An order as the API returns it: Decimals as numbers, cost only to those who may see it. */
function presentOrder(order: Record<string, unknown>, showCost: boolean) {
  const lines = (order.lines ?? null) as Record<string, unknown>[] | null;
  const totals = lines
    ? quotationTotals({
        lines: lines as { amount: Prisma.Decimal }[],
        discountPct: order.discountPct as Prisma.Decimal,
        vatRate: order.vatRate as Prisma.Decimal,
        vatInclusive: order.vatInclusive as boolean,
      })
    : null;
  const presented: Record<string, unknown> = {
    ...order,
    discountPct: num(order.discountPct as Prisma.Decimal),
    vatRate: num(order.vatRate as Prisma.Decimal),
    subtotal: num(order.subtotal as Prisma.Decimal),
    discountAmount: num(order.discountAmount as Prisma.Decimal),
    vatAmount: num(order.vatAmount as Prisma.Decimal),
    total: num(order.total as Prisma.Decimal),
    net: totals ? totals.net : num(order.subtotal as Prisma.Decimal) - num(order.discountAmount as Prisma.Decimal),
  };
  if (lines) {
    presented.lines = lines.map((l, n) => {
      const line: Record<string, unknown> = {
        ...l,
        quantity: num(l.quantity as Prisma.Decimal),
        unitPrice: num(l.unitPrice as Prisma.Decimal),
        amount: num(l.amount as Prisma.Decimal),
      };
      if (!showCost) return stripLineCost(line);
      const m = totals!.lines[n];
      return {
        ...line,
        unitCost: l.unitCost == null ? null : num(l.unitCost as Prisma.Decimal),
        costAmount: m.costAmount,
        margin: m.margin,
        marginPct: m.marginPct,
      };
    });
    if (showCost && totals) presented.costPanel = totals.cost;
  }
  return presented;
}

/**
 * The base number comes from the `sales_order` series once per quotation;
 * every later order on the same quotation is `<base>.<n>` — SCORO's 4622,
 * 4622.1 progress booking. Inside the caller's transaction, so a refused
 * order burns no number and two creates cannot share a suffix.
 */
async function nextOrderNumber(tx: Prisma.TransactionClient, quotationId: string): Promise<string> {
  const existing = await tx.salesOrder.findMany({
    where: { quotationId },
    select: { number: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!existing.length) return nextNumber('sales_order', tx);
  const base = existing[0].number.split('.')[0];
  const used = new Set(
    existing.map((o) => (o.number.startsWith(`${base}.`) ? Number(o.number.slice(base.length + 1)) : 0)),
  );
  let n = 1;
  while (used.has(n)) n += 1;
  return `${base}.${n}`;
}

// ── List ─────────────────────────────────────────────────────────────────────

salesOrderRoutes.get(
  '/',
  requireAny('gops.sales_orders.view_all', 'gops.sales_orders.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const where: Prisma.SalesOrderWhereInput = {};

    const onlyOwn = !me.isSuperAdmin && !me.permissions.has('gops.sales_orders.view_all');
    if (onlyOwn || q.scope === 'mine') where.ownerId = me.id;
    if (q.filters.status && ['DRAFT', 'ISSUED', 'CANCELLED'].includes(q.filters.status)) {
      where.status = q.filters.status as 'DRAFT' | 'ISSUED' | 'CANCELLED';
    }
    if (q.filters.customerId) where.customerId = q.filters.customerId;
    if (q.filters.quotationId) where.quotationId = q.filters.quotationId;
    if (q.search) {
      where.OR = [
        { number: { contains: q.search, mode: 'insensitive' } },
        { poNumber: { contains: q.search, mode: 'insensitive' } },
        { customer: { name: { contains: q.search, mode: 'insensitive' } } },
        { quotation: { number: { contains: q.search, mode: 'insensitive' } } },
        { quotation: { subject: { contains: q.search, mode: 'insensitive' } } },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.salesOrder.findMany({
        where,
        include: ORDER_INCLUDE,
        orderBy: orderBy(q, ['number', 'orderDate', 'total', 'createdAt'], { createdAt: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.salesOrder.count({ where }),
    ]);
    res.json(listResult(rows.map((r) => presentOrder(r as unknown as Record<string, unknown>, false)), total, q));
  }),
);

// What is left to book on a quotation — the Create Sales Order panel's
// table (SCORO's "Create invoice"). Above /:id, which would take "booking"
// for an order. No cost in it.
salesOrderRoutes.get(
  '/booking',
  requireAny('gops.sales_orders.create', 'gops.sales_orders.view_all', 'gops.sales_orders.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const quotationId = String(req.query.quotationId ?? '');
    if (!quotationId) throw badRequest('Which quotation?');
    const quotation = await bookableQuotation(me, quotationId);
    const booking = await bookingFor(quotation);
    if (!booking) throw badRequest('That quotation has no revision yet');
    res.json({ quotationId: quotation.id, number: quotation.number, subject: quotation.subject, ...booking });
  }),
);

// ── One order ────────────────────────────────────────────────────────────────

salesOrderRoutes.get(
  '/:id',
  requireAny('gops.sales_orders.view_all', 'gops.sales_orders.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const order = await prisma.salesOrder.findUnique({
      where: { id: req.params.id },
      include: {
        ...ORDER_INCLUDE,
        lines: {
          orderBy: { sortOrder: 'asc' },
          include: {
            providerSupplier: { select: { id: true, name: true } },
            providerUser: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (!order) throw notFound('Sales order not found');
    if (!me.isSuperAdmin && !me.permissions.has('gops.sales_orders.view_all') && order.ownerId !== me.id) {
      throw forbidden('This sales order is someone else’s');
    }
    const showCost = canSeeOrderCost(me, order.ownerId);
    res.json({
      ...presentOrder(order as unknown as Record<string, unknown>, showCost),
      canEdit: canEditRecord(me, 'gops', 'sales_orders', order.ownerId),
      canSeeCost: showCost,
    });
  }),
);

// ── Create from a quotation ──────────────────────────────────────────────────

const createSchema = z.object({
  quotationId: z.string().min(1),
  /**
   * SCORO's choices. `lines` (or the older `partial`) books the lines named,
   * at the quantities given; `all` books what is left of every line;
   * `summary` books the selection — or what is left — as one line worth it.
   */
  mode: z.enum(['all', 'partial', 'lines', 'summary']).default('all'),
  /** The quotation lines to book, each at a quantity no more than is left of it. */
  lines: z.array(z.object({ id: z.string().min(1), quantity: z.number().positive().max(1_000_000_000) })).max(500).optional(),
  /** The older shape: these lines, at what is left of each. */
  lineIds: z.array(z.string()).max(500).optional(),
});

salesOrderRoutes.post(
  '/',
  require_('gops.sales_orders.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(createSchema, req.body);
    const quotation = await bookableQuotation(me, body.quotationId);
    const revision = valueRevision(quotation.revisions);
    if (!revision) throw badRequest('That quotation has no revision yet');
    if (!revision.items.some((i) => !i.isHeading)) throw badRequest('That quotation has no lines to book');

    // What is left of each line, read in the creating transaction so two
    // bookings of the same line cannot both pass.
    const order = await prisma.$transaction(async (tx) => {
      const booking = (await bookingFor(quotation, tx))!;
      const left = new Map(booking.lines.map((l) => [l.id, l]));
      const byId = new Map(revision.items.map((i) => [i.id, i]));
      type Pick = { item: (typeof revision.items)[number]; quantity: number };
      let picks: Pick[];
      if (body.lines) {
        picks = body.lines.map((p) => {
          const item = byId.get(p.id);
          const line = left.get(p.id);
          if (!item || !line || item.isHeading) throw badRequest('That line is not on the quotation’s value revision');
          if (p.quantity > line.available + 0.0005) {
            throw badRequest(
              `Only ${line.available} ${item.unit} of “${(item.title ?? '').trim() || item.description}” is left to book — ${line.booked} ${item.unit} of ${line.quantity} already booked`,
            );
          }
          return { item, quantity: thou(p.quantity) };
        });
      } else {
        const wanted = body.lineIds ? revision.items.filter((i) => body.lineIds!.includes(i.id)) : revision.items;
        picks = wanted
          .filter((i) => !i.isHeading)
          .map((i) => ({ item: i, quantity: left.get(i.id)?.available ?? 0 }))
          .filter((p) => p.quantity > 0);
        if (body.lineIds && !wanted.some((i) => !i.isHeading)) throw badRequest('Pick at least one line to book');
      }
      picks = picks.filter((p) => p.quantity > 0);
      if (!picks.length) throw badRequest('Nothing is left to book on this quotation — every line is already on a sales order');

      // The selection's own money, through the quotation's arithmetic: its
      // discount, its tax — a summary line is worth the selection net.
      const pickedLines = picks.map((p) => ({
        amount: lineAmount(p.quantity, p.item.unitPrice),
        costAmount: p.item.unitCost == null ? null : lineAmount(p.quantity, p.item.unitCost),
        providerUserId: p.item.providerUserId,
        providerSupplierId: p.item.providerSupplierId,
        isHeading: false,
      }));
      const selection = quotationTotals({
        lines: pickedLines,
        discountPct: revision.discountPct,
        vatRate: revision.vatRate,
        vatInclusive: revision.vatInclusive,
      });

      // The subheadings over the picked lines come along; empty sections do not.
      const pickedIds = new Set(picks.map((p) => p.item.id));
      const rows: { item: (typeof revision.items)[number]; quantity: number }[] = [];
      let heading: (typeof revision.items)[number] | null = null;
      for (const i of revision.items) {
        if (i.isHeading) {
          heading = i;
          continue;
        }
        if (!pickedIds.has(i.id)) continue;
        if (heading) {
          rows.push({ item: heading, quantity: 0 });
          heading = null;
        }
        rows.push(picks.find((p) => p.item.id === i.id)!);
      }

      const number = await nextOrderNumber(tx, quotation.id);
      const created = await tx.salesOrder.create({
        data: {
          number,
          quotationId: quotation.id,
          customerId: quotation.customerId,
          contactId: quotation.contactId,
          ownerId: me.id,
          orderDate: manilaDate(new Date()),
          poNumber: revision.prNumber ?? null,
          // A summary line already carries the discount inside its one price.
          discountPct: body.mode === 'summary' ? d(0) : revision.discountPct,
          vatRate: revision.vatRate,
          vatInclusive: revision.vatInclusive,
          lines: {
            create:
              body.mode === 'summary'
                ? [
                    {
                      title: quotation.subject,
                      description: `Per quotation ${quotation.number} R${revision.revision} — ${picks.length} line${picks.length === 1 ? '' : 's'}`,
                      quantity: d(1),
                      unit: 'lot',
                      unitPrice: d(selection.net),
                      amount: d(selection.net),
                      sortOrder: 0,
                      unitCost: d(selection.cost.totalCost),
                      costAmount: d(selection.cost.totalCost),
                      bookedItems: picks.map((p) => ({ quotationItemId: p.item.id, quantity: p.quantity })),
                    },
                  ]
                : rows.map(({ item: i, quantity }, n) =>
                    i.isHeading
                      ? { title: i.title, description: '', isHeading: true, quantity: d(0), unit: i.unit, unitPrice: d(0), amount: d(0), sortOrder: n }
                      : {
                          group: i.group,
                          title: i.title,
                          description: i.description,
                          isHeading: false,
                          quantity: d(quantity),
                          unit: i.unit,
                          unitPrice: i.unitPrice,
                          amount: lineAmount(quantity, i.unitPrice),
                          sortOrder: n,
                          unitCost: i.unitCost,
                          costAmount: i.unitCost == null ? null : lineAmount(quantity, i.unitCost),
                          providerSupplierId: i.providerSupplierId,
                          providerUserId: i.providerUserId,
                          costNote: i.costNote,
                          quotationItemId: i.id,
                        },
                  ),
          },
        },
      });
      await recalcOrder(created.id, tx);
      const fresh = await tx.salesOrder.findUniqueOrThrow({
        where: { id: created.id },
        include: { ...ORDER_INCLUDE, lines: { orderBy: { sortOrder: 'asc' } } },
      });
      return { fresh, picks: picks.length, of: booking.lines.filter((l) => !l.isHeading).length };
    });

    await audit(
      {
        entityType: 'sales_order',
        entityId: order.fresh.id,
        action: 'CREATED',
        summary: `Created sales order ${order.fresh.number} from quotation ${quotation.number} (${
          body.mode === 'summary' ? `summarised, ${order.picks} of ${order.of} lines` : `${order.picks} of ${order.of} lines`
        })`,
      },
      req,
    );
    res.status(201).json(presentOrder(order.fresh as unknown as Record<string, unknown>, true));
  }),
);

// ── The one save: header and lines together ──────────────────────────────────

const lineFields = {
  id: z.string().optional(),
  group: z.string().trim().max(120).optional().nullable(),
  isHeading: z.boolean().optional(),
  title: z.string().trim().max(300).optional().nullable(),
  description: z.string().optional().nullable(),
  quantity: z.number().min(0).default(1),
  unit: z.string().trim().min(1).default('lot'),
  unitPrice: z.number().min(0).default(0),
  unitCost: z.number().min(0).optional().nullable(),
  costNote: z.string().optional().nullable(),
};

const saveSchema = z.object({
  orderDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date of issue?').optional(),
  termsDays: z.number().int().min(0).max(365).optional(),
  paymentMethod: z.string().trim().max(120).optional().nullable(),
  referenceNo: z.string().trim().max(120).optional().nullable(),
  poNumber: z.string().trim().max(120).optional().nullable(),
  comment: z.string().optional().nullable(),
  contactId: z.string().optional().nullable(),
  discountPct: z.number().min(0).max(100).optional(),
  vatRate: z.number().min(0).max(1).optional(),
  vatInclusive: z.boolean().optional(),
  lines: z.array(z.object(lineFields)).max(500).optional(),
});

/** Loads an order and refuses unless this caller may edit it now. */
async function orderForEdit(req: Parameters<typeof currentUser>[0], id: string, draftOnly = true) {
  const me = currentUser(req);
  const order = await prisma.salesOrder.findUnique({ where: { id } });
  if (!order) throw notFound('Sales order not found');
  if (!canEditRecord(me, 'gops', 'sales_orders', order.ownerId)) {
    throw forbidden('Only its author can edit this sales order');
  }
  if (draftOnly && order.status !== 'DRAFT') {
    throw badRequest(`This sales order is ${order.status.toLowerCase()} — reopen it to change it`);
  }
  return { me, order };
}

salesOrderRoutes.put(
  '/:id',
  require_('gops.sales_orders.edit_own'),
  handler(async (req, res) => {
    const { me, order } = await orderForEdit(req, req.params.id);
    const body = parseBody(saveSchema, req.body);

    // The quotation's tax choices apply here too: the company rate, 8%, 6%,
    // 0%, or the rate the order was created with.
    if (body.vatRate !== undefined) {
      const company = await prisma.company.findUnique({ where: { id: 'company' }, select: { vatRate: true } });
      const allowed = [d(0), company?.vatRate ?? d(0.12), ...QUOTATION_EXTRA_TAX_RATES.map((o) => d(o.rate)), order.vatRate];
      if (!allowed.some((r) => r.equals(d(body.vatRate!)))) {
        throw badRequest('VAT on a sales order is the company rate, 8%, 6%, or 0%');
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.salesOrder.update({
        where: { id: order.id },
        data: {
          ...(body.orderDate ? { orderDate: new Date(`${body.orderDate}T00:00:00Z`) } : {}),
          ...(body.termsDays !== undefined ? { termsDays: body.termsDays } : {}),
          ...(body.paymentMethod !== undefined ? { paymentMethod: body.paymentMethod || null } : {}),
          ...(body.referenceNo !== undefined ? { referenceNo: body.referenceNo || null } : {}),
          ...(body.poNumber !== undefined ? { poNumber: body.poNumber || null } : {}),
          ...(body.comment !== undefined ? { comment: body.comment || null } : {}),
          ...(body.contactId !== undefined ? { contactId: body.contactId || null } : {}),
          ...(body.discountPct !== undefined ? { discountPct: d(body.discountPct) } : {}),
          ...(body.vatRate !== undefined ? { vatRate: d(body.vatRate) } : {}),
          ...(body.vatInclusive !== undefined ? { vatInclusive: body.vatInclusive } : {}),
        },
      });
      if (body.lines) {
        for (const [i, line] of body.lines.entries()) {
          if (line.isHeading && !(line.title ?? '').trim()) throw badRequest(`Line ${i + 1}: give the subheading its text`);
          if (!line.isHeading && !(line.title ?? '').trim() && !(line.description ?? '').trim()) {
            throw badRequest(`Line ${i + 1}: give the line a product title or a description`);
          }
        }
        // A line sent back with its id keeps what it books of the quotation.
        const kept = new Map(
          (await tx.salesOrderLine.findMany({ where: { orderId: order.id }, select: { id: true, quotationItemId: true, bookedItems: true } })).map((l) => [l.id, l]),
        );
        await tx.salesOrderLine.deleteMany({ where: { orderId: order.id } });
        await tx.salesOrderLine.createMany({
          data: body.lines.map((l, i) => {
            if (l.isHeading) {
              return {
                orderId: order.id,
                isHeading: true,
                title: (l.title ?? '').trim(),
                description: '',
                quantity: d(0),
                unit: l.unit || 'lot',
                unitPrice: d(0),
                amount: d(0),
                sortOrder: i,
              };
            }
            const hasCost = l.unitCost !== undefined && l.unitCost !== null;
            return {
              orderId: order.id,
              isHeading: false,
              group: l.group || null,
              title: l.title || null,
              description: l.description ?? '',
              quantity: d(l.quantity),
              unit: l.unit,
              unitPrice: d(l.unitPrice),
              amount: lineAmount(l.quantity, l.unitPrice),
              sortOrder: i,
              unitCost: hasCost ? d(l.unitCost!) : null,
              costAmount: hasCost ? lineAmount(l.quantity, l.unitCost!) : null,
              costNote: l.costNote || null,
              quotationItemId: (l.id && kept.get(l.id)?.quotationItemId) || null,
              bookedItems: (l.id && kept.get(l.id)?.bookedItems) || undefined,
            };
          }),
        });
        await rememberGroups(tx, body.lines.map((l) => l.group));
      }
      await recalcOrder(order.id, tx);
    });

    const fresh = await prisma.salesOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: { ...ORDER_INCLUDE, lines: { orderBy: { sortOrder: 'asc' } } },
    });
    await audit(
      { entityType: 'sales_order', entityId: order.id, action: 'UPDATED', summary: `Updated sales order ${order.number}` },
      req,
    );
    res.json(presentOrder(fresh as unknown as Record<string, unknown>, canSeeOrderCost(me, fresh.ownerId)));
  }),
);

/** The release references and small corrections an ISSUED order may still take. */
salesOrderRoutes.patch(
  '/:id',
  require_('gops.sales_orders.edit_own'),
  handler(async (req, res) => {
    const { order } = await orderForEdit(req, req.params.id, false);
    if (order.status === 'CANCELLED') throw badRequest('A cancelled sales order stays as it was');
    const body = parseBody(
      z.object({
        siNumber: z.string().trim().max(60).optional().nullable(),
        drNumber: z.string().trim().max(60).optional().nullable(),
        paymentMethod: z.string().trim().max(120).optional().nullable(),
        referenceNo: z.string().trim().max(120).optional().nullable(),
      }),
      req.body,
    );
    const updated = await prisma.salesOrder.update({
      where: { id: order.id },
      data: {
        ...(body.siNumber !== undefined ? { siNumber: body.siNumber || null } : {}),
        ...(body.drNumber !== undefined ? { drNumber: body.drNumber || null } : {}),
        ...(body.paymentMethod !== undefined ? { paymentMethod: body.paymentMethod || null } : {}),
        ...(body.referenceNo !== undefined ? { referenceNo: body.referenceNo || null } : {}),
      },
    });
    await audit(
      { entityType: 'sales_order', entityId: order.id, action: 'UPDATED', summary: `Updated sales order ${order.number}`, before: order, after: updated },
      req,
    );
    res.json({ ok: true });
  }),
);

// ── Status: issue, reopen, cancel ────────────────────────────────────────────

salesOrderRoutes.post(
  '/:id/issue',
  require_('gops.sales_orders.edit_own'),
  handler(async (req, res) => {
    const { order } = await orderForEdit(req, req.params.id);
    const hasLine = await prisma.salesOrderLine.count({ where: { orderId: order.id, isHeading: false } });
    if (!hasLine) throw badRequest('Add at least one line before issuing it');
    // Claimed, never simply written: two Issue clicks book once.
    const claimed = await prisma.salesOrder.updateMany({
      where: { id: order.id, status: 'DRAFT' },
      data: { status: 'ISSUED' },
    });
    if (!claimed.count) throw badRequest('This sales order moved a moment ago — reload to see where it stands');
    await audit(
      { entityType: 'sales_order', entityId: order.id, action: 'COMPLETED', summary: `Issued sales order ${order.number} — booked at ${formatAmount(num(order.total))}` },
      req,
    );
    res.json({ ok: true, status: 'ISSUED' });
  }),
);

salesOrderRoutes.post(
  '/:id/reopen',
  require_('gops.sales_orders.edit_own'),
  handler(async (req, res) => {
    const { order } = await orderForEdit(req, req.params.id, false);
    const claimed = await prisma.salesOrder.updateMany({
      where: { id: order.id, status: 'ISSUED' },
      data: { status: 'DRAFT' },
    });
    if (!claimed.count) throw badRequest('Only an issued sales order can be reopened');
    await audit(
      { entityType: 'sales_order', entityId: order.id, action: 'UPDATED', summary: `Reopened sales order ${order.number}` },
      req,
    );
    res.json({ ok: true, status: 'DRAFT' });
  }),
);

salesOrderRoutes.post(
  '/:id/cancel',
  require_('gops.sales_orders.edit_own'),
  handler(async (req, res) => {
    const { me, order } = await orderForEdit(req, req.params.id, false);
    const { reason } = parseBody(z.object({ reason: z.string().trim().min(3, 'Say why it is cancelled') }), req.body);
    const claimed = await prisma.salesOrder.updateMany({
      where: { id: order.id, status: { in: ['DRAFT', 'ISSUED'] } },
      data: { status: 'CANCELLED', cancelReason: reason },
    });
    if (!claimed.count) throw badRequest('This sales order is already cancelled');
    await audit(
      {
        entityType: 'sales_order',
        entityId: order.id,
        action: 'CANCELLED',
        summary: `Cancelled sales order ${order.number} — ${reason}`,
        actorId: me.id,
      },
      req,
    );
    res.json({ ok: true, status: 'CANCELLED' });
  }),
);

salesOrderRoutes.delete(
  '/:id',
  require_('gops.sales_orders.delete'),
  handler(async (req, res) => {
    const { order } = await orderForEdit(req, req.params.id);
    await prisma.salesOrder.delete({ where: { id: order.id } });
    await audit(
      { entityType: 'sales_order', entityId: order.id, action: 'DELETED', summary: `Deleted sales order ${order.number}`, before: order },
      req,
    );
    res.json({ ok: true });
  }),
);

// ── The paper ────────────────────────────────────────────────────────────────

const PRINT_INCLUDE = {
  ...ORDER_INCLUDE,
  lines: {
    orderBy: { sortOrder: 'asc' },
    include: { providerSupplier: { select: { name: true } }, providerUser: { select: { name: true } } },
  },
} as const;

export type PrintableSalesOrder = Prisma.SalesOrderGetPayload<{ include: typeof PRINT_INCLUDE }>;

/** The order, for printing: whoever prints it must be able to open it. */
export async function printableSalesOrder(me: ReturnType<typeof currentUser>, id: string): Promise<PrintableSalesOrder> {
  const order = await prisma.salesOrder.findUnique({ where: { id }, include: PRINT_INCLUDE });
  if (!order) throw notFound('Sales order not found');
  if (!me.isSuperAdmin && !me.permissions.has('gops.sales_orders.view_all') && order.ownerId !== me.id) {
    throw forbidden('This sales order is someone else\u2019s');
  }
  return order;
}

const STATUS_LABEL: Record<string, string> = { DRAFT: 'Draft', ISSUED: 'Issued', CANCELLED: 'Cancelled' };

/**
 * What a sales order prints — its fields, its lines, its totals and who
 * signs it — for the layout in Admin › PDF Templates to place (the owner's
 * sample, Sale Order 4622, in the quotation template's dress). It is the
 * internal booking record: `showCost` is the quotation's own cost rule, and
 * without it no cost cell, cost total or margin is in the data at all — a
 * layout that places the cost columns prints them empty.
 */
export async function salesOrderPrintData(order: PrintableSalesOrder, showCost: boolean): Promise<DesignData> {
  const company = await prisma.company.findUnique({ where: { id: 'company' }, select: { currency: true } });
  const currency = company?.currency ?? 'PHP';
  const site = order.quotation.siteId
    ? await prisma.customerSite.findUnique({ where: { id: order.quotation.siteId }, select: { address: true, city: true } })
    : null;
  const totals = quotationTotals({
    lines: order.lines,
    discountPct: order.discountPct,
    vatRate: order.vatRate,
    vatInclusive: order.vatInclusive,
  });
  const amount = (v: number) => formatAmount(v);
  const ratePct = `${Number(d(num(order.vatRate)).mul(100).toFixed(2))}%`;
  const contact = order.contact;

  const fields: Record<string, string> = {
    'order.number': order.number,
    'order.date': formatShortDate(order.orderDate),
    'order.dateLong': formatDate(order.orderDate),
    'order.status': STATUS_LABEL[order.status] ?? order.status,
    'order.subject': order.quotation.subject,
    'order.poNumber': order.poNumber ?? '',
    'order.paymentTerms': `${order.termsDays} days`,
    'order.paymentMethod': order.paymentMethod ?? '',
    'order.referenceNo': order.referenceNo ?? '',
    'order.siNumber': order.siNumber ?? '',
    'order.drNumber': order.drNumber ?? '',
    'order.comment': order.comment ?? '',
    'order.draftNote': order.status === 'DRAFT' ? 'DRAFT — not yet issued.' : '',
    'order.cancelReason': order.status === 'CANCELLED' ? (order.cancelReason ?? '') : '',
    'order.currency': currency,
    'order.vatRate': ratePct,
    'order.subtotal': amount(totals.subtotal),
    'order.discount': totals.discountAmount > 0 ? amount(totals.discountAmount) : '',
    'order.net': amount(totals.net),
    'order.vat': amount(totals.vatAmount),
    'order.total': amount(totals.total),
    'quotation.number': order.quotation.number,
    'quotation.subject': order.quotation.subject,
    'customer.name': order.customer.name,
    'customer.code': order.customer.code,
    'customer.address': [site?.address, site?.city].filter(Boolean).join(', '),
    'customer.phone': order.customer.phone ?? '',
    'customer.tin': order.customer.tin ?? '',
    'contact.name': contact?.name ?? '',
    'contact.position': contact?.position ?? '',
    'contact.nameAndPosition': contact ? `${contact.name}${contact.position ? `, ${contact.position}` : ''}` : '',
    'owner.name': order.owner.name,
    'owner.position': order.owner.position ?? '',
    'owner.email': order.owner.email ?? '',
    'owner.phone': '',
  };
  const author = await prisma.user.findUnique({
    where: { id: order.ownerId },
    select: { phone: true, employee: { select: { mobile: true } } },
  });
  if (author) fields['owner.phone'] = contactPhone(author) ?? '';

  const rows: DesignRow[] = [];
  let n = 0;
  order.lines.forEach((l, i) => {
    if (l.isHeading) {
      rows.push({ heading: (l.title ?? '').trim() });
      return;
    }
    const m = totals.lines[i];
    const qty = Number(l.quantity);
    const qtyText = Number.isInteger(qty) ? String(qty) : qty.toString();
    const title = (l.title ?? '').trim();
    const description = (l.description ?? '').trim();
    rows.push({
      cells: {
        no: String(++n),
        product: title ? (description ? { title, body: description } : { title }) : description,
        qtyUnit: `${qtyText} ${l.unit}`,
        qty: qtyText,
        unit: l.unit,
        unitPrice: amount(num(l.unitPrice)),
        amount: amount(num(l.amount)),
        group: l.group ?? '',
        ...(showCost
          ? {
              cost: {
                title: l.costAmount == null ? '' : amount(num(l.costAmount)),
                body: l.providerSupplier?.name ?? l.providerUser?.name ?? undefined,
              },
              margin: m.margin == null ? '' : amount(m.margin),
            }
          : {}),
      },
    });
  });

  const totalRows: PdfTotal[] = [{ label: 'Subtotal:', value: amount(totals.subtotal) }];
  if (totals.discountAmount > 0) {
    totalRows.push({
      label: `Discount (${num(order.discountPct).toFixed(num(order.discountPct) % 1 ? 2 : 0)}%):`,
      value: `-${amount(totals.discountAmount)}`,
    });
    if (!order.vatInclusive) totalRows.push({ label: 'Sum without tax:', value: amount(totals.net) });
  }
  totalRows.push({ label: order.vatInclusive ? `VAT included (${ratePct}):` : `Tax (${ratePct}):`, value: amount(totals.vatAmount) });
  totalRows.push({ label: `Total (${currency}):`, value: amount(totals.total), bold: true });
  if (showCost) {
    totalRows.push({ label: `Cost (${currency}):`, value: amount(totals.cost.totalCost) });
    totalRows.push({ label: 'Margin sum:', value: amount(totals.cost.totalMargin) });
  }

  const signatories: Signatory[] = [
    {
      role: 'Prepared by',
      name: order.owner.name,
      position: order.owner.position ?? undefined,
      phone: fields['owner.phone'] || undefined,
      email: order.owner.email ?? undefined,
      at: order.createdAt,
    },
    { role: 'Noted by' },
    { role: 'Approved by' },
  ];

  return { title: `${order.number} — Sales Order`, fields, rows, totals: totalRows, signatories };
}

/**
 * The paper prints through the layout in Admin › PDF Templates (the standard
 * one is landscape, in the quotation template's dress). A caller who may not
 * see cost prints a layout with the cost columns taken out, and data that
 * never carried a cost.
 */
salesOrderRoutes.get(
  '/:id/pdf',
  requireAny('gops.sales_orders.view_all', 'gops.sales_orders.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const order = await printableSalesOrder(me, req.params.id);
    const showCost = canSeeOrderCost(me, order.ownerId);
    const { design } = await salesOrderDesign();
    const data = await salesOrderPrintData(order, showCost);
    const pdf = await renderDesigned(showCost ? design : withoutCostColumns(design), data);

    await audit(
      { entityType: 'sales_order', entityId: order.id, action: 'EXPORTED', summary: `Printed sales order ${order.number}` },
      req,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="SO-${order.number}.pdf"`);
    res.send(pdf);
  }),
);

/** Which of a quotation's revisions' lines the create panel offers — its value revision's. */
export { valueRevision };
