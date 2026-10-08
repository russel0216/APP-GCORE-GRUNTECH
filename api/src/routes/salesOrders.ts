import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { teamMembers, teamOf } from '../shared/team';
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
  quotationTaxOptions,
  stripLineCost,
  QUOTATION_EXTRA_TAX_RATES,
  productTitle,
} from '../shared/quotation';
import { valueRevision } from '../shared/pipeline';
import { bookingFor, thou } from '../shared/salesOrderBooking';
import {
  formatAmount,
  formatDate,
  formatMoney,
  formatShortDate,
  renderDocument,
  type PdfTotal,
  type Signatory,
} from '../shared/pdf';
import { renderDesigned, type DesignData, type DesignRow } from '../shared/pdfDesign';
import { salesOrderDesign, withoutCostColumns } from '../shared/salesOrderTemplate';
import {
  approvalOptions,
  approvalSlots,
  cancelOpenRequest,
  contactPhone,
  onApprovalSettled,
  pickWorkflow,
  routePreview,
  submitForApproval,
} from '../shared/approvals';

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
export async function recalcOrder(orderId: string, tx: Prisma.TransactionClient = prisma) {
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
  return totals;
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

export const SALES_ORDER_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'ISSUED', 'CANCELLED'] as const;
type SoStatus = (typeof SALES_ORDER_STATUSES)[number];
const SO_STATUS_LABEL: Record<SoStatus, string> = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Pending approval',
  ISSUED: 'Issued',
  CANCELLED: 'Cancelled',
};
const SO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function soDay(value: string | undefined, label: string): string | null {
  if (!value) return null;
  if (!SO_DAY.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw badRequest(`${label} is a date written YYYY-MM-DD`);
  return value;
}

/**
 * Which sales orders a list query means — ONE rule for the list, its summary
 * (the status tabs' counts and the totals line) and its PDF (the quotation
 * list's pattern, 2026-10-08). `base` is everything but the status; the tabs
 * count under it, so each says what clicking it would show with the other
 * filters kept. The quotation page's Sales orders card reads the same list
 * with `?quotationId=`.
 */
export function salesOrderListWhere(
  me: ReturnType<typeof currentUser>,
  q: ReturnType<typeof listQuery>,
  /** The viewer's team (shared/team.ts) for `?scope=team`; without one the Team view is Mine. */
  team: string | null = null,
): { base: Prisma.SalesOrderWhereInput; where: Prisma.SalesOrderWhereInput } {
  const and: Prisma.SalesOrderWhereInput[] = [];
  const onlyOwn = !me.isSuperAdmin && !me.permissions.has('gops.sales_orders.view_all');
  if (onlyOwn || q.scope === 'mine') and.push({ ownerId: me.id });
  if (q.scope === 'team') and.push(team ? { owner: teamMembers(team) } : { ownerId: me.id });
  const f = q.filters;
  if (f.customerId) and.push({ customerId: f.customerId });
  if (f.quotationId) and.push({ quotationId: f.quotationId });
  if (f.ownerId) and.push({ ownerId: f.ownerId });
  // The order date is a DATE: UTC-midnight edges of the days named.
  const from = soDay(f.dateFrom, 'Date from');
  const to = soDay(f.dateTo, 'Date to');
  if (from || to) {
    and.push({
      orderDate: {
        ...(from ? { gte: new Date(`${from}T00:00:00.000Z`) } : {}),
        ...(to ? { lte: new Date(`${to}T23:59:59.999Z`) } : {}),
      },
    });
  }
  // Released: the SI/BS or DR number is filled in — what finance chases.
  const RELEASED: Prisma.SalesOrderWhereInput = { OR: [{ siNumber: { not: null } }, { drNumber: { not: null } }] };
  if (f.released === 'yes') and.push(RELEASED);
  else if (f.released === 'no') and.push({ NOT: RELEASED });
  else if (f.released) throw badRequest('Released is yes or no');
  // The rows a person ticked (mass actions); the rules above still apply.
  const ids = idsFilter(f.ids);
  if (ids) and.push({ id: { in: ids } });
  if (q.search) {
    and.push({
      OR: [
        { number: { contains: q.search, mode: 'insensitive' } },
        { poNumber: { contains: q.search, mode: 'insensitive' } },
        { siNumber: { contains: q.search, mode: 'insensitive' } },
        { drNumber: { contains: q.search, mode: 'insensitive' } },
        { customer: { name: { contains: q.search, mode: 'insensitive' } } },
        { quotation: { number: { contains: q.search, mode: 'insensitive' } } },
        { quotation: { subject: { contains: q.search, mode: 'insensitive' } } },
      ],
    });
  }
  const base: Prisma.SalesOrderWhereInput = and.length ? { AND: and } : {};
  if (!f.status) return { base, where: base };
  if (!(SALES_ORDER_STATUSES as readonly string[]).includes(f.status)) throw badRequest(`Unknown status: ${f.status}`);
  return { base, where: { AND: [...and, { status: f.status as SoStatus }] } };
}

/**
 * The tabs' counts under `base` ('' is All), the count under `where`, and the
 * booked value: the totals of the orders `where` selects that are still
 * standing — a cancelled order books nothing (the quotation page's
 * "Booked"), so it is counted apart, never summed in.
 */
export async function salesOrderListSummary(
  base: Prisma.SalesOrderWhereInput,
  where: Prisma.SalesOrderWhereInput,
  /** `teamWhere`: the viewer's team's share of the booked value; `margin`: only where the caller may see every listed order's cost. */
  opts: { teamWhere?: Prisma.SalesOrderWhereInput | null; margin?: boolean } = {},
) {
  const LIVE: Prisma.SalesOrderWhereInput = { status: { not: 'CANCELLED' } };
  const [perStatus, live, cancelled, team, liveOrders] = await Promise.all([
    prisma.salesOrder.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
    prisma.salesOrder.aggregate({ where: { AND: [where, LIVE] }, _sum: { total: true }, _count: { _all: true } }),
    prisma.salesOrder.count({ where: { AND: [where, { status: 'CANCELLED' }] } }),
    opts.teamWhere ? prisma.salesOrder.aggregate({ where: { AND: [where, LIVE, opts.teamWhere] }, _sum: { total: true }, _count: { _all: true } }) : null,
    opts.margin ? prisma.salesOrder.findMany({ where: { AND: [where, LIVE] }, select: { id: true, discountPct: true, vatRate: true, vatInclusive: true } }) : null,
  ]);
  // The totals row's margin: every live order with a costed line, the row's
  // own figure summed, against the orders' sums without tax (the quotation
  // list's rule, over SalesOrderLine).
  let margin: { amount: number; pct: number | null; costed: number } | undefined;
  if (liveOrders) {
    const sums = liveOrders.length
      ? await prisma.salesOrderLine.groupBy({
          by: ['orderId'],
          where: { orderId: { in: liveOrders.map((o) => o.id) }, isHeading: false },
          _sum: { amount: true, costAmount: true },
          _count: { costAmount: true },
        })
      : [];
    let marginCents = 0;
    let netCents = 0;
    let costed = 0;
    for (const s of sums) {
      if (!s._count.costAmount) continue;
      const o = liveOrders.find((x) => x.id === s.orderId)!;
      const t = quotationTotals({
        lines: [{ amount: s._sum.amount ?? 0, costAmount: s._sum.costAmount ?? 0 }],
        discountPct: o.discountPct,
        vatRate: o.vatRate,
        vatInclusive: o.vatInclusive,
      });
      marginCents += Math.round(t.cost.totalMargin * 100);
      netCents += Math.round(t.netOfTax * 100);
      costed++;
    }
    margin = { amount: marginCents / 100, pct: netCents > 0 ? Math.round((marginCents / netCents) * 1000) / 10 : null, costed };
  }
  const tabCounts: Record<string, number> = { '': 0 };
  for (const st of SALES_ORDER_STATUSES) tabCounts[st] = 0;
  for (const r of perStatus) {
    tabCounts[r.status] = r._count._all;
    tabCounts[''] += r._count._all;
  }
  return {
    tabCounts,
    count: live._count._all + cancelled,
    value: num(live._sum.total),
    cancelledCount: cancelled,
    ...(team ? { team: { count: team._count._all, value: num(team._sum.total) } } : {}),
    ...(margin ? { margin } : {}),
  };
}

const SO_SORTS = ['number', 'orderDate', 'total', 'createdAt'];

function salesOrderOrderBy(q: ReturnType<typeof listQuery>): Prisma.SalesOrderOrderByWithRelationInput {
  if (q.sort === 'customer') return { customer: { name: q.dir } };
  return orderBy(q, SO_SORTS, { createdAt: 'desc' });
}

salesOrderRoutes.get(
  '/',
  requireAny('gops.sales_orders.view_all', 'gops.sales_orders.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const team = await teamOf(me.id);
    const { base, where } = salesOrderListWhere(me, q, team?.id ?? null);

    const [rows, total, summary] = await Promise.all([
      prisma.salesOrder.findMany({
        where,
        include: ORDER_INCLUDE,
        orderBy: salesOrderOrderBy(q),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.salesOrder.count({ where }),
      salesOrderListSummary(base, where, {
        teamWhere: team ? { owner: teamMembers(team.id) } : null,
        margin:
          me.isSuperAdmin ||
          me.permissions.has('gops.sales_orders.edit_all') ||
          me.permissions.has('gops.costing.view_all') ||
          !me.permissions.has('gops.sales_orders.view_all') ||
          q.scope === 'mine',
      }),
    ]);

    // Margin, only where the caller may see this order's cost — the
    // quotation's rule — off the order's own lines.
    const costed = rows.filter((r) => canSeeOrderCost(me, r.ownerId)).map((r) => r.id);
    const lines = costed.length
      ? await prisma.salesOrderLine.findMany({
          where: { orderId: { in: costed } },
          select: { orderId: true, amount: true, costAmount: true, providerUserId: true, providerSupplierId: true, isHeading: true },
        })
      : [];

    res.json({
      ...listResult(
        rows.map((r) => {
          let margin: { amount: number; pct: number | null; costedLines: number; lineCount: number } | null = null;
          if (costed.includes(r.id)) {
            const t = quotationTotals({
              lines: lines.filter((l) => l.orderId === r.id),
              discountPct: r.discountPct,
              vatRate: r.vatRate,
              vatInclusive: r.vatInclusive,
            });
            if (t.cost.costedLines > 0) {
              margin = { amount: t.cost.totalMargin, pct: t.cost.totalMarginPct, costedLines: t.cost.costedLines, lineCount: t.cost.lineCount };
            }
          }
          return { ...presentOrder(r as unknown as Record<string, unknown>, false), margin };
        }),
        total,
        q,
      ),
      summary,
    });
  }),
);

/**
 * The sales order list on paper — the list as filtered, through
 * `salesOrderListWhere`, so the paper is the screen (or, with `?ids=`, the
 * rows ticked). Totals and value only, never cost: a list leaves the
 * building more easily than an order does. Capped at 1,000 rows, audited,
 * declared above `/:id`.
 */
salesOrderRoutes.get(
  '/pdf',
  requireAny('gops.sales_orders.view_all', 'gops.sales_orders.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const team = await teamOf(me.id);
    const { base, where } = salesOrderListWhere(me, q, team?.id ?? null);
    const [rows, summary] = await Promise.all([
      prisma.salesOrder.findMany({
        where,
        include: { customer: { select: { name: true } }, quotation: { select: { number: true, subject: true } } },
        orderBy: salesOrderOrderBy(q),
        take: 1000,
      }),
      salesOrderListSummary(base, where),
    ]);
    const f = q.filters;
    const filters = [
      q.search ? `search "${q.search}"` : null,
      f.status ? `status ${SO_STATUS_LABEL[f.status as SoStatus] ?? f.status}` : null,
      f.customerId ? 'one customer' : null,
      f.ownerId ? 'one owner' : null,
      f.quotationId ? 'one quotation' : null,
      f.dateFrom || f.dateTo ? `dated ${f.dateFrom ?? '…'} to ${f.dateTo ?? '…'}` : null,
      f.released === 'yes' ? 'released' : f.released === 'no' ? 'not yet released' : null,
      q.scope === 'mine' ? 'mine only' : null,
      f.ids ? 'the rows selected' : null,
    ].filter(Boolean);

    const pdf = await renderDocument({
      title: 'Sales Orders',
      date: new Date(),
      reference: `${summary.count} order(s)${summary.count > rows.length ? `, first ${rows.length} printed` : ''}${filters.length ? ` — ${filters.join(' · ')}` : ''}`,
      sections: [
        {
          kind: 'table',
          head: ['Number', 'Quotation and customer', 'Status', 'PO', 'SI / DR', 'Date', 'Total'],
          widths: [1.7, 2.7, 1.4, 1.4, 1.3, 1.3, 1.4],
          align: ['left', 'left', 'left', 'left', 'left', 'left', 'right'],
          rows: rows.map((r) => [
            r.number,
            { title: r.quotation.subject, body: `${r.quotation.number} · ${r.customer.name}` },
            SO_STATUS_LABEL[r.status as SoStatus] ?? r.status,
            r.poNumber ?? '',
            [r.siNumber, r.drNumber].filter(Boolean).join(' / '),
            formatShortDate(r.orderDate),
            r.status === 'CANCELLED' ? `(${formatAmount(num(r.total))})` : formatAmount(num(r.total)),
          ]),
        },
        {
          kind: 'totals',
          rows: [
            { label: 'Booked value, total:', value: formatMoney(summary.value), bold: true },
            ...(summary.cancelledCount
              ? [{ label: `Cancelled, not counted:`, value: `${summary.cancelledCount} order(s)` }]
              : []),
          ],
        },
      ],
      signatories: [],
    });

    await audit(
      { entityType: 'sales_order', entityId: 'list', action: 'EXPORTED', summary: `Exported the sales orders list as PDF (${rows.length} order(s))` },
      req,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="sales-orders.pdf"');
    res.send(pdf);
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
    // Approval (2026-10-07, the owner's call): a fixed approver and an
    // optional one, both data in Admin › Approval Workflows. With a route
    // active the order is submitted, not issued; the page names who decides.
    const total = num(order.total);
    const workflow = await pickWorkflow('sales_order', total);
    const options = order.status === 'DRAFT' && workflow ? await approvalOptions('sales_order', total) : [];
    const brief = (route: Awaited<ReturnType<typeof routePreview>>) =>
      route && {
        name: route.name,
        steps: route.steps.map((st) => ({ name: st.name, approvers: st.approvers.map((p) => ({ id: p.id, name: p.name })) })),
      };
    const approvalRoutes =
      order.status === 'DRAFT' && workflow
        ? {
            standard: brief(await routePreview('sales_order', total, me.id)),
            options: await Promise.all(options.map(async (o) => ({ id: o.id, route: brief(await routePreview('sales_order', total, me.id, o.id)) }))),
          }
        : null;
    // The editor's Tax dropdown: the quotation's choices, and the rate this
    // order was created with should Settings have moved since.
    const company = await prisma.company.findUnique({ where: { id: 'company' }, select: { vatRate: true } });
    const taxOptions = quotationTaxOptions(company ? num(company.vatRate) : 0.12);
    const ownRate = num(order.vatRate);
    if (!taxOptions.some((o) => Math.abs(o.rate - ownRate) < 0.00005)) {
      taxOptions.push({ rate: ownRate, label: `${Number((ownRate * 100).toFixed(2))}% (this order)` });
    }
    res.json({
      ...presentOrder(order as unknown as Record<string, unknown>, showCost),
      canEdit: canEditRecord(me, 'gops', 'sales_orders', order.ownerId),
      canSeeCost: showCost,
      taxOptions,
      needsApproval: !!workflow,
      approvalOptions: options,
      approvalRoutes,
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
                          brand: i.brand,
                          productType: i.productType,
                          partNumber: i.partNumber,
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
  brand: z.string().trim().max(120).optional().nullable(),
  productType: z.string().trim().max(160).optional().nullable(),
  partNumber: z.string().trim().max(80).optional().nullable(),
  description: z.string().optional().nullable(),
  quantity: z.number().min(0).default(1),
  unit: z.string().trim().min(1).default('lot'),
  unitPrice: z.number().min(0).default(0),
  unitCost: z.number().min(0).optional().nullable(),
  /** Who carries the line's cost — one of our people, or a supplier; never both. The quotation's rule. */
  providerUserId: z.string().optional().nullable(),
  providerSupplierId: z.string().optional().nullable(),
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
          if (!line.isHeading && !(line.title ?? '').trim() && !productTitle(line) && !(line.description ?? '').trim()) {
            throw badRequest(`Line ${i + 1}: give the line a brand, product type or part number, or a description`);
          }
          if (line.providerUserId && line.providerSupplierId) throw badRequest(`Line ${i + 1}: a line's cost is carried by a person or a supplier, not both`);
          if (line.providerUserId && !(await tx.user.findUnique({ where: { id: line.providerUserId }, select: { id: true } }))) {
            throw badRequest(`Line ${i + 1}: that person does not exist`);
          }
          if (line.providerSupplierId && !(await tx.supplier.findUnique({ where: { id: line.providerSupplierId }, select: { id: true } }))) {
            throw badRequest(`Line ${i + 1}: that supplier does not exist`);
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
              brand: l.brand || null,
              productType: l.productType || null,
              partNumber: l.partNumber || null,
              title: productTitle(l) ?? (l.title || null),
              description: l.description ?? '',
              quantity: d(l.quantity),
              unit: l.unit,
              unitPrice: d(l.unitPrice),
              amount: lineAmount(l.quantity, l.unitPrice),
              sortOrder: i,
              unitCost: hasCost ? d(l.unitCost!) : null,
              costAmount: hasCost ? lineAmount(l.quantity, l.unitCost!) : null,
              costNote: l.costNote || null,
              providerUserId: l.providerUserId || null,
              providerSupplierId: l.providerSupplierId || null,
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
    if (await pickWorkflow('sales_order', num(order.total))) {
      throw badRequest('This sales order goes through approval — submit it for approval instead');
    }
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

// ── Approval: the one engine, a fixed approver and an optional one ──────────

salesOrderRoutes.post(
  '/:id/submit',
  require_('gops.sales_orders.edit_own'),
  handler(async (req, res) => {
    const { me, order } = await orderForEdit(req, req.params.id);
    // An optional route the submitter ticked — "Add the CEO as approver".
    const { optionId } = parseBody(z.object({ optionId: z.string().optional().nullable() }), req.body ?? {});
    const hasLine = await prisma.salesOrderLine.count({ where: { orderId: order.id, isHeading: false } });
    if (!hasLine) throw badRequest('Add at least one line before submitting it');
    // The quotation's rule (2026-10-08): every priced line names its product group before the order moves on.
    const ungrouped = await prisma.salesOrderLine.count({ where: { orderId: order.id, isHeading: false, OR: [{ group: null }, { group: '' }] } });
    if (ungrouped) throw badRequest(`Every line needs a product group before the order can be submitted — ${ungrouped} line${ungrouped === 1 ? ' has' : 's have'} none`);
    const full = await prisma.salesOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: { customer: { select: { name: true } }, quotation: { select: { subject: true } } },
    });
    const claimed = await prisma.salesOrder.updateMany({ where: { id: order.id, status: 'DRAFT' }, data: { status: 'PENDING_APPROVAL' } });
    if (!claimed.count) throw badRequest('This sales order moved a moment ago — reload to see where it stands');
    try {
      await submitForApproval({
        documentType: 'sales_order',
        documentId: order.id,
        documentNumber: order.number,
        subject: `${full.customer.name} — ${full.quotation.subject}`,
        amount: num(order.total),
        link: `/g-ops/sales-orders/${order.id}`,
        requesterId: me.id,
        optionId: optionId || null,
      });
    } catch (err) {
      // Refused (no route, nobody to approve, an option that does not apply):
      // back to a draft, never pending with no approval behind it.
      await prisma.salesOrder.updateMany({ where: { id: order.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
      throw err;
    }
    await audit({ entityType: 'sales_order', entityId: order.id, action: 'SUBMITTED', summary: `Sales order ${order.number} sent for approval` }, req);
    res.json({ ok: true, status: 'PENDING_APPROVAL' });
  }),
);

/**
 * Pulling an order back from the approver to edit it, as a quotation's
 * revision can be: the claim is conditional, so a decision that lands first
 * wins, and the open request is withdrawn through the engine, which tells
 * the approvers.
 */
salesOrderRoutes.post(
  '/:id/withdraw',
  require_('gops.sales_orders.edit_own'),
  handler(async (req, res) => {
    const { me, order } = await orderForEdit(req, req.params.id, false);
    if (order.status !== 'PENDING_APPROVAL') throw badRequest('This sales order is not with the approver — nothing to pull back');
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.salesOrder.updateMany({ where: { id: order.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
      if (!claimed.count) throw badRequest('It was decided a moment ago — reload to see where it stands');
      await cancelOpenRequest('sales_order', order.id, tx, `pulled back to draft by ${me.name}`, me.id);
    });
    await audit({ entityType: 'sales_order', entityId: order.id, action: 'UPDATED', summary: `Pulled sales order ${order.number} back to draft` }, req);
    res.json({ ok: true, status: 'DRAFT' });
  }),
);

/**
 * An approved order is ISSUED — booked — and a rejected one goes back to
 * draft. Claimed on PENDING_APPROVAL, so a decision that lands after a cancel
 * or a pull-back changes nothing and the trail says so.
 */
export async function settleSalesOrder(documentId: string, outcome: 'APPROVED' | 'REJECTED') {
  const claimed = await prisma.salesOrder.updateMany({
    where: { id: documentId, status: 'PENDING_APPROVAL' },
    data: { status: outcome === 'APPROVED' ? 'ISSUED' : 'DRAFT' },
  });
  const order = await prisma.salesOrder.findUnique({ where: { id: documentId }, select: { number: true, total: true, status: true } });
  if (!order) return;
  if (!claimed.count) {
    await audit({
      entityType: 'sales_order',
      entityId: documentId,
      action: outcome === 'APPROVED' ? 'APPROVED' : 'REJECTED',
      summary: `Sales order ${order.number} ${outcome.toLowerCase()} after it was ${order.status.toLowerCase()} — not applied`,
    });
    return;
  }
  await audit({
    entityType: 'sales_order',
    entityId: documentId,
    action: outcome === 'APPROVED' ? 'APPROVED' : 'REJECTED',
    summary:
      outcome === 'APPROVED'
        ? `Sales order ${order.number} approved and issued — booked at ${formatAmount(num(order.total))}`
        : `Sales order ${order.number} returned to draft`,
  });
}

onApprovalSettled('sales_order', async (request, outcome) => {
  await settleSalesOrder(request.documentId, outcome);
});

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
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.salesOrder.updateMany({
        where: { id: order.id, status: { in: ['DRAFT', 'PENDING_APPROVAL', 'ISSUED'] } },
        data: { status: 'CANCELLED', cancelReason: reason },
      });
      if (!claimed.count) throw badRequest('This sales order is already cancelled');
      // One with the approver takes its request with it, and the approvers are told.
      if (order.status === 'PENDING_APPROVAL') {
        await cancelOpenRequest('sales_order', order.id, tx, `cancelled by ${me.name}: ${reason}`, me.id);
      }
    });
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
    const { order } = await orderForEdit(req, req.params.id, false);
    if (order.status !== 'DRAFT' && order.status !== 'CANCELLED') {
      throw badRequest('Only a draft or a cancelled sales order can be deleted — cancel it first');
    }
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

  // Prepared by the author; then every step of the approval route, dated
  // once it has approved and "Pending" until then — a draft shows the route
  // submitting would take. Without a route, Noted and Approved stay open.
  const slots = await approvalSlots(
    'sales_order',
    order.id,
    order.status === 'DRAFT' ? { amount: num(order.total), requesterId: order.ownerId } : undefined,
  );
  const signatories: Signatory[] = [
    {
      role: 'Prepared by',
      name: order.owner.name,
      position: order.owner.position ?? undefined,
      phone: fields['owner.phone'] || undefined,
      email: order.owner.email ?? undefined,
      at: order.createdAt,
    },
    ...(slots.length
      ? slots.map((sl): Signatory => {
          const role = slots.length > 1 ? `Approved by — ${sl.step}` : 'Approved by';
          if (sl.name) return { role, name: sl.name, position: sl.position, phone: sl.phone, email: sl.email, at: sl.at };
          const who = sl.assigned ?? [];
          if (who.length === 1) return { role, name: who[0].name, position: who[0].position, phone: who[0].phone, email: who[0].email };
          return who.length > 1 ? { role, name: who.map((p) => p.name).join(' or ') } : { role };
        })
      : [{ role: 'Noted by' }, { role: 'Approved by' }]),
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
