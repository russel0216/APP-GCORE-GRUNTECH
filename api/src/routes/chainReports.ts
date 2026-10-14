import { Router } from 'express';
import { prisma } from '../prisma';
import { authenticate } from '../auth/middleware';
import { type Range } from '../shared/insights';
import { manilaDate, manilaMonthKey } from '../shared/day';
import { availableOf, belowReorder } from '../shared/chain';
import { statusLabel } from '../shared/pdf';
import { Series, byValue, cents, dayOf, mountReports, monthsOf, num, pct, round3, table, tally, type Report, type Table } from '../shared/reportKit';
import { figuresOf } from './procurement';
import { PULLOUT_PURPOSES, purposeOf } from './pullouts';
import { BORROW_TYPES } from './warehouse';

/**
 * G-CHAIN reports (2026-10-15, the owner's call: "a Report button per menu,
 * any applicable in the list, selectable time range" — his examples: monthly
 * incoming goods by quantity or value, a supplier's monthly total cost). One
 * report per procurement and warehouse menu, over a chosen range of Manila
 * days: summary cards, a month-by-month series (every month of the range
 * listed, at zero when empty) and the breakdowns that menu's reader asks for.
 * Every report has a `.csv` and a `.pdf` twin, each audited before the bytes
 * go out (Insights' rule). **No table, and none must be acquired**: every
 * figure is read off the documents the menus record.
 *
 * `gchain.reports` is READ in the registry — `view_all` is the whole right,
 * for the report and its twins alike.
 */
export const chainReportRoutes = Router();
chainReportRoutes.use(authenticate);

const VIEW = 'gchain.reports.view_all';

// ── The reports ──────────────────────────────────────────────────────────────

async function overview(range: Range): Promise<Report> {
  const today = manilaDate(new Date());
  const [balances, moves, overdue] = await Promise.all([
    prisma.inventoryBalance.findMany({
      include: {
        item: { select: { id: true, code: true, name: true, isActive: true, reorderLevel: true, minStock: true, category: { select: { name: true } } } },
        warehouse: { select: { id: true, name: true } },
      },
    }),
    prisma.inventoryTransaction.findMany({
      where: { occurredAt: { gte: range.fromAt, lte: range.toAt } },
      select: { type: true, quantity: true, unitCost: true, occurredAt: true },
    }),
    prisma.borrowSlip.count({ where: { status: { in: ['OUT', 'PARTIALLY_RETURNED'] }, dueAt: { lt: today } } }),
  ]);
  const live = balances.filter((b) => b.item.isActive);
  const valueOf = (b: (typeof balances)[number]) => cents(num(b.quantity) * num(b.averageCost));
  const stockValue = cents(live.reduce((s, b) => s + valueOf(b), 0));
  const onLoan = round3(live.reduce((s, b) => s + num(b.borrowedQty), 0));
  const low = live.filter((b) => belowReorder(b));
  const series = new Series('Stock movement by month', [{ label: 'Received' }, { label: 'Received value', money: true }, { label: 'Issued' }, { label: 'Issued value', money: true }, { label: 'Lent' }, { label: 'Returned' }], monthsOf(range));
  for (const m of moves) {
    const q = Math.abs(num(m.quantity));
    const v = cents(q * num(m.unitCost));
    if (m.type === 'RECEIPT') {
      series.add(m.occurredAt, 0, q);
      series.add(m.occurredAt, 1, v);
    } else if (m.type === 'ISSUE') {
      series.add(m.occurredAt, 2, q);
      series.add(m.occurredAt, 3, v);
    } else if (m.type === 'BORROW') series.add(m.occurredAt, 4, q);
    else if (m.type === 'RETURN') series.add(m.occurredAt, 5, q);
  }
  const byWarehouse = tally(live, (b) => b.warehouse.name, (b) => [1, valueOf(b)]);
  const byCategory = tally(live, (b) => b.item.category?.name ?? 'Uncategorised', (b) => [1, valueOf(b)]);
  return {
    kind: 'overview',
    title: 'Supply Chain Overview',
    from: dayOf(range.from),
    to: dayOf(range.to),
    cards: [
      { label: 'Stock value', value: stockValue, money: true, sub: 'on hand now, at moving average cost' },
      { label: 'Item lines', value: live.length, sub: 'item × warehouse' },
      { label: 'Below reorder level', value: low.length, sub: low.length ? 'listed below' : 'everything above its level' },
      { label: 'On loan', value: onLoan, sub: overdue ? `${overdue} slip${overdue === 1 ? '' : 's'} overdue` : 'nothing overdue' },
    ],
    series: series.done(),
    tables: [
      table('Stock by warehouse', [{ label: 'Warehouse' }, { label: 'Item lines', align: 'right' }, { label: 'Value', money: true }], byValue(byWarehouse, 1, 50).map(([k, v]) => [k, v[0], cents(v[1])])),
      table('Stock by category', [{ label: 'Category' }, { label: 'Item lines', align: 'right' }, { label: 'Value', money: true }], byValue(byCategory, 1, 50).map(([k, v]) => [k, v[0], cents(v[1])])),
      table(
        'Needs reordering',
        [{ label: 'Item' }, { label: 'Warehouse' }, { label: 'Available', align: 'right' }, { label: 'Reorder at', align: 'right' }],
        low
          .sort((a, b) => availableOf(a) - num(a.item.reorderLevel) - (availableOf(b) - num(b.item.reorderLevel)))
          .slice(0, 30)
          .map((b) => [`${b.item.name} (${b.item.code})`, b.warehouse.name, availableOf(b), num(b.item.reorderLevel)]),
      ),
    ],
    notes: ['Stock figures are as of now; the movement series covers the period chosen.'],
  };
}

async function purchaseRequests(range: Range): Promise<Report> {
  const rows = await prisma.purchaseRequest.findMany({
    where: { createdAt: { gte: range.fromAt, lte: range.toAt } },
    include: {
      items: { select: { estimatedAmount: true } },
      job: { select: { number: true, name: true } },
      requestedBy: { select: { name: true } },
      warehouse: { select: { name: true } },
    },
  });
  const valueOf = (r: (typeof rows)[number]) => cents(r.items.reduce((s, i) => s + num(i.estimatedAmount), 0));
  const approved = (s: string) => ['APPROVED', 'PARTIALLY_ORDERED', 'ORDERED'].includes(s);
  const live = rows.filter((r) => !['CANCELLED', 'REJECTED'].includes(r.status));
  const series = new Series('Purchase requests by month', [{ label: 'Raised' }, { label: 'Approved' }, { label: 'Estimated value', money: true }], monthsOf(range));
  for (const r of rows) {
    series.add(r.createdAt, 0, 1);
    if (approved(r.status)) series.add(r.createdAt, 1, 1);
    if (!['CANCELLED', 'REJECTED'].includes(r.status)) series.add(r.createdAt, 2, valueOf(r));
  }
  const fig = (r: (typeof rows)[number]) => [1, valueOf(r)];
  const money2 = (m: Map<string, number[]>, top = 10) => byValue(m, 1, top).map(([k, v]) => [k, v[0], cents(v[1])]);
  return {
    kind: 'purchase-requests',
    title: 'Purchase Requests',
    from: dayOf(range.from),
    to: dayOf(range.to),
    cards: [
      { label: 'Raised', value: rows.length },
      { label: 'Approved', value: rows.filter((r) => approved(r.status)).length, sub: `${rows.filter((r) => r.status === 'PENDING_APPROVAL').length} waiting for approval` },
      { label: 'Estimated value', value: cents(live.reduce((s, r) => s + valueOf(r), 0)), money: true, sub: 'drafts and pending included; cancelled and rejected left out' },
      { label: 'Direct to project', value: rows.filter((r) => r.kind === 'DIRECT_TO_JOB').length, sub: `${rows.filter((r) => r.kind !== 'DIRECT_TO_JOB').length} for stock` },
    ],
    series: series.done(),
    tables: [
      table('By status', [{ label: 'Status' }, { label: 'Requests', align: 'right' }, { label: 'Estimated value', money: true }], money2(tally(rows, (r) => statusLabel(r.status), fig), 20)),
      table('By project', [{ label: 'Project' }, { label: 'Requests', align: 'right' }, { label: 'Estimated value', money: true }], money2(tally(live, (r) => (r.job ? `${r.job.number} — ${r.job.name}` : (r.warehouse ? `Stock — ${r.warehouse.name}` : 'Stock')), fig))),
      table('By requester', [{ label: 'Requester' }, { label: 'Requests', align: 'right' }, { label: 'Estimated value', money: true }], money2(tally(live, (r) => r.requestedBy.name, fig))),
    ],
  };
}

async function rfq(range: Range): Promise<Report> {
  const rows = await prisma.rfq.findMany({
    where: { createdAt: { gte: range.fromAt, lte: range.toAt } },
    include: { request: { select: { number: true, job: { select: { number: true } } } } },
  });
  const ids = rows.map((r) => r.id);
  const [asked, quoted] = await Promise.all([
    ids.length ? prisma.rfqSupplier.findMany({ where: { rfqId: { in: ids } }, select: { id: true, rfqId: true, supplier: { select: { name: true } } } }) : [],
    ids.length ? prisma.rfqQuote.groupBy({ by: ['rfqSupplierId'], where: { rfqSupplier: { rfqId: { in: ids } } }, _count: { _all: true } }) : [],
  ]);
  const quotedRows = new Set(quoted.map((q) => q.rfqSupplierId));
  const askedByRfq = tally(asked, (a) => a.rfqId, (a) => [1, quotedRows.has(a.id) ? 1 : 0]);
  const series = new Series('RFQs by month', [{ label: 'Raised' }, { label: 'Sent' }, { label: 'Suppliers asked' }, { label: 'Suppliers quoted' }], monthsOf(range));
  for (const r of rows) {
    const a = askedByRfq.get(r.id) ?? [0, 0];
    series.add(r.createdAt, 0, 1);
    if (r.sentAt) series.add(r.createdAt, 1, 1);
    series.add(r.createdAt, 2, a[0]);
    series.add(r.createdAt, 3, a[1]);
  }
  const bySupplier = tally(asked, (a) => a.supplier.name, (a) => [1, quotedRows.has(a.id) ? 1 : 0]);
  return {
    kind: 'rfq',
    title: 'Requests for Quotation',
    from: dayOf(range.from),
    to: dayOf(range.to),
    cards: [
      { label: 'RFQs raised', value: rows.length, sub: `${rows.filter((r) => r.sentAt).length} sent` },
      { label: 'Suppliers asked', value: asked.length },
      { label: 'Suppliers quoted', value: quotedRows.size, sub: `${pct(quotedRows.size, asked.length)}% response` },
      { label: 'Closed by a canvass', value: rows.filter((r) => r.status === 'CLOSED').length },
    ],
    series: series.done(),
    tables: [
      table('By status', [{ label: 'Status' }, { label: 'RFQs', align: 'right' }], byValue(tally(rows, (r) => statusLabel(r.status), () => [1]), 0, 20).map(([k, v]) => [k, v[0]])),
      table(
        'By supplier',
        [{ label: 'Supplier' }, { label: 'Asked', align: 'right' }, { label: 'Quoted', align: 'right' }, { label: 'Response', align: 'right' }],
        byValue(bySupplier, 0, 15).map(([k, v]) => [k, v[0], v[1], `${pct(v[1], v[0])}%`]),
      ),
    ],
  };
}

async function canvass(range: Range): Promise<Report> {
  const rows = await prisma.canvass.findMany({
    where: { createdAt: { gte: range.fromAt, lte: range.toAt } },
    include: {
      request: { select: { number: true, items: { select: { id: true, quantity: true, estimatedCost: true, estimatedAmount: true } } } },
      suppliers: { select: { id: true, isSelected: true, supplier: { select: { name: true } }, quotes: { select: { requestItemId: true, unitPrice: true } } } },
    },
  });
  const figured = rows.map((c) => {
    const f = figuresOf(c, c.request.items, c.suppliers);
    const winner = c.suppliers.find((s) => s.isSelected);
    const col = winner ? f.columns.find((x) => x.id === winner.id) : undefined;
    return { c, budget: f.budget, winner, total: col?.total ?? 0, savings: col?.savings ?? 0, budgetOnQuoted: col?.budgetOnQuoted ?? 0 };
  });
  const awarded = figured.filter((x) => x.c.status === 'AWARDED' && x.winner);
  const series = new Series('Canvasses by month', [{ label: 'Opened' }, { label: 'Awarded' }, { label: 'Reference budget', money: true }, { label: 'Awarded total', money: true }, { label: 'Savings', money: true }], monthsOf(range));
  for (const x of figured) {
    series.add(x.c.createdAt, 0, 1);
    if (x.c.status === 'AWARDED' && x.winner) {
      series.add(x.c.awardedAt ?? x.c.createdAt, 1, 1);
      series.add(x.c.awardedAt ?? x.c.createdAt, 2, x.budgetOnQuoted);
      series.add(x.c.awardedAt ?? x.c.createdAt, 3, x.total);
      series.add(x.c.awardedAt ?? x.c.createdAt, 4, x.savings);
    }
  }
  const awardedBudget = cents(awarded.reduce((s, x) => s + x.budgetOnQuoted, 0));
  const awardedTotal = cents(awarded.reduce((s, x) => s + x.total, 0));
  const savings = cents(awarded.reduce((s, x) => s + x.savings, 0));
  const bySupplier = tally(awarded, (x) => x.winner!.supplier.name, (x) => [1, x.total, x.savings]);
  return {
    kind: 'canvass',
    title: 'Canvass Sheets',
    from: dayOf(range.from),
    to: dayOf(range.to),
    cards: [
      { label: 'Canvasses opened', value: rows.length, sub: `${awarded.length} awarded` },
      { label: 'Reference budget', value: awardedBudget, money: true, sub: 'on the lines awarded' },
      { label: 'Awarded total', value: awardedTotal, money: true },
      { label: 'Savings', value: savings, money: true, sub: `${pct(savings, awardedBudget)}% against the reference budget` },
    ],
    series: series.done(),
    tables: [
      table(
        'By supplier awarded',
        [{ label: 'Supplier' }, { label: 'Awards', align: 'right' }, { label: 'Awarded total', money: true }, { label: 'Savings', money: true }],
        byValue(bySupplier, 1, 15).map(([k, v]) => [k, v[0], cents(v[1]), cents(v[2])]),
      ),
      table('By status', [{ label: 'Status' }, { label: 'Canvasses', align: 'right' }], byValue(tally(rows, (r) => statusLabel(r.status), () => [1]), 0, 20).map(([k, v]) => [k, v[0]])),
    ],
  };
}

async function purchaseOrders(range: Range): Promise<Report> {
  const rows = await prisma.purchaseOrder.findMany({
    where: { orderDate: { gte: range.from, lte: range.to } },
    include: { supplier: { select: { name: true } }, job: { select: { number: true, name: true } } },
  });
  const placed = rows.filter((r) => ['ISSUED', 'PARTIALLY_RECEIVED', 'RECEIVED'].includes(r.status));
  const months = monthsOf(range);
  const series = new Series('Purchase orders by month', [{ label: 'Placed' }, { label: 'Total', money: true }, { label: 'Received' }], months);
  for (const r of placed) {
    series.add(r.orderDate, 0, 1);
    series.add(r.orderDate, 1, num(r.total));
    if (r.status === 'RECEIVED') series.add(r.orderDate, 2, 1);
  }
  const bySupplier = tally(placed, (r) => r.supplier.name, (r) => [1, num(r.total)]);
  const topSuppliers = byValue(bySupplier, 1, 10).map(([k]) => k);
  // The owner's example — a supplier's monthly total cost — as a matrix while the range fits a page.
  const matrix: Table | null =
    months.length <= 12
      ? table(
          'Supplier by month',
          [{ label: 'Supplier' }, ...months.map((m) => ({ label: m.label, money: true })), { label: 'Total', money: true }],
          topSuppliers.map((name) => {
            const cells = months.map((m) => cents(placed.filter((r) => r.supplier.name === name && manilaMonthKey(r.orderDate) === m.key).reduce((s, r) => s + num(r.total), 0)));
            return [name, ...cells, cents(cells.reduce((s, v) => s + v, 0))];
          }),
        )
      : null;
  const money2 = (m: Map<string, number[]>, top = 10) => byValue(m, 1, top).map(([k, v]) => [k, v[0], cents(v[1])]);
  return {
    kind: 'purchase-orders',
    title: 'Purchase Orders',
    from: dayOf(range.from),
    to: dayOf(range.to),
    cards: [
      { label: 'Orders placed', value: placed.length, sub: `${rows.length - placed.length} draft, pending or cancelled` },
      { label: 'Total placed', value: cents(placed.reduce((s, r) => s + num(r.total), 0)), money: true, sub: 'VAT included' },
      { label: 'Awaiting delivery', value: placed.filter((r) => r.status !== 'RECEIVED').length },
      { label: 'Suppliers', value: bySupplier.size },
    ],
    series: series.done(),
    tables: [
      table('By supplier', [{ label: 'Supplier' }, { label: 'Orders', align: 'right' }, { label: 'Total', money: true }], money2(bySupplier, 15)),
      ...(matrix ? [matrix] : []),
      table('By project', [{ label: 'Project' }, { label: 'Orders', align: 'right' }, { label: 'Total', money: true }], money2(tally(placed, (r) => (r.job ? `${r.job.number} — ${r.job.name}` : 'Stock'), (r) => [1, num(r.total)]))),
    ],
    notes: months.length > 12 ? ['Choose a range of twelve months or fewer to see each supplier month by month.'] : undefined,
  };
}

async function incoming(range: Range): Promise<Report> {
  const rows = await prisma.receiving.findMany({
    where: { receivedDate: { gte: range.from, lte: range.to } },
    include: {
      items: {
        select: {
          quantity: true,
          unitCost: true,
          description: true,
          item: { select: { name: true, code: true } },
          // A line received against an order names its goods on the order's line.
          orderItem: { select: { name: true, description: true, partNumber: true, item: { select: { name: true, code: true } } } },
        },
      },
      supplier: { select: { name: true } },
      order: { select: { supplier: { select: { name: true } } } },
      warehouse: { select: { name: true } },
    },
  });
  const received = rows.filter((r) => r.status === 'RECEIVED');
  const qtyOf = (r: (typeof rows)[number]) => round3(r.items.reduce((s, i) => s + num(i.quantity), 0));
  const valueOf = (r: (typeof rows)[number]) => cents(r.items.reduce((s, i) => s + num(i.quantity) * num(i.unitCost), 0));
  const fromOf = (r: (typeof rows)[number]) => r.order?.supplier.name ?? r.supplier?.name ?? r.sourceName ?? 'Not stated';
  const series = new Series('Incoming goods by month', [{ label: 'Reports' }, { label: 'Quantity' }, { label: 'Value', money: true }], monthsOf(range));
  for (const r of received) {
    series.add(r.receivedDate, 0, 1);
    series.add(r.receivedDate, 1, qtyOf(r));
    series.add(r.receivedDate, 2, valueOf(r));
  }
  const lines = received.flatMap((r) =>
    r.items.map((i) => {
      const it = i.item ?? i.orderItem?.item ?? null;
      return {
        name: it?.name ?? i.orderItem?.name ?? i.orderItem?.description ?? i.description ?? 'Line',
        code: it?.code ?? i.orderItem?.partNumber ?? '',
        quantity: num(i.quantity),
        value: cents(num(i.quantity) * num(i.unitCost)),
      };
    }),
  );
  const three = (m: Map<string, number[]>, top = 15) => byValue(m, 2, top).map(([k, v]) => [k, v[0], round3(v[1]), cents(v[2])]);
  return {
    kind: 'incoming',
    title: 'Incoming Goods',
    from: dayOf(range.from),
    to: dayOf(range.to),
    cards: [
      { label: 'Reports received', value: received.length, sub: `${rows.filter((r) => r.status === 'PENDING_APPROVAL').length} waiting for approval` },
      { label: 'Quantity received', value: round3(received.reduce((s, r) => s + qtyOf(r), 0)) },
      { label: 'Value received', value: cents(received.reduce((s, r) => s + valueOf(r), 0)), money: true, sub: 'at the price taken into stock' },
      { label: 'Suppliers', value: new Set(received.map(fromOf)).size },
    ],
    series: series.done(),
    tables: [
      table('By supplier', [{ label: 'Supplier' }, { label: 'Reports', align: 'right' }, { label: 'Quantity', align: 'right' }, { label: 'Value', money: true }], three(tally(received, fromOf, (r) => [1, qtyOf(r), valueOf(r)]))),
      table('By warehouse', [{ label: 'Warehouse' }, { label: 'Reports', align: 'right' }, { label: 'Quantity', align: 'right' }, { label: 'Value', money: true }], three(tally(received, (r) => r.warehouse?.name ?? 'Straight to site', (r) => [1, qtyOf(r), valueOf(r)]))),
      table('Top items by value', [{ label: 'Item' }, { label: 'Lines', align: 'right' }, { label: 'Quantity', align: 'right' }, { label: 'Value', money: true }], three(tally(lines, (l) => (l.code ? `${l.name} (${l.code})` : l.name), (l) => [1, l.quantity, l.value]))),
    ],
  };
}

async function inventory(range: Range): Promise<Report> {
  const [balances, moves] = await Promise.all([
    prisma.inventoryBalance.findMany({
      include: {
        item: { select: { id: true, code: true, name: true, isActive: true, category: { select: { name: true } } } },
        warehouse: { select: { name: true } },
      },
    }),
    prisma.inventoryTransaction.findMany({
      where: { occurredAt: { gte: range.fromAt, lte: range.toAt } },
      select: { itemId: true, warehouseId: true, type: true, quantity: true, unitCost: true, occurredAt: true, item: { select: { name: true, code: true } } },
    }),
  ]);
  const live = balances.filter((b) => b.item.isActive);
  const valueOf = (b: (typeof balances)[number]) => cents(num(b.quantity) * num(b.averageCost));
  const series = new Series('Stock movement by month', [{ label: 'Received' }, { label: 'Received value', money: true }, { label: 'Issued' }, { label: 'Issued value', money: true }, { label: 'Lent' }, { label: 'Returned' }], monthsOf(range));
  const outByItem = new Map<string, number[]>();
  const movedOut = new Set<string>();
  let inValue = 0;
  let outValue = 0;
  for (const m of moves) {
    const q = Math.abs(num(m.quantity));
    const v = cents(q * num(m.unitCost));
    if (m.type === 'RECEIPT') {
      series.add(m.occurredAt, 0, q);
      series.add(m.occurredAt, 1, v);
      inValue += v;
    } else if (m.type === 'ISSUE') {
      series.add(m.occurredAt, 2, q);
      series.add(m.occurredAt, 3, v);
      outValue += v;
      const key = `${m.item.name} (${m.item.code})`;
      const cur = outByItem.get(key) ?? [0, 0];
      outByItem.set(key, [cur[0] + q, cur[1] + v]);
      movedOut.add(`${m.itemId}|${m.warehouseId}`);
    } else if (m.type === 'BORROW') {
      series.add(m.occurredAt, 4, q);
      movedOut.add(`${m.itemId}|${m.warehouseId}`);
    } else if (m.type === 'RETURN') series.add(m.occurredAt, 5, q);
  }
  const slow = live.filter((b) => num(b.quantity) > 0 && !movedOut.has(`${b.itemId}|${b.warehouseId}`)).sort((a, b) => valueOf(b) - valueOf(a));
  const byCategory = tally(live, (b) => b.item.category?.name ?? 'Uncategorised', (b) => [1, num(b.quantity), valueOf(b)]);
  return {
    kind: 'inventory',
    title: 'Inventory',
    from: dayOf(range.from),
    to: dayOf(range.to),
    cards: [
      { label: 'Stock value now', value: cents(live.reduce((s, b) => s + valueOf(b), 0)), money: true, sub: 'at moving average cost' },
      { label: 'Received in the period', value: cents(inValue), money: true },
      { label: 'Issued in the period', value: cents(outValue), money: true, sub: 'issues and pull-outs, at average cost' },
      { label: 'Slow-moving lines', value: slow.length, sub: 'nothing issued or lent in the period' },
    ],
    series: series.done(),
    tables: [
      table('Valuation by category', [{ label: 'Category' }, { label: 'Item lines', align: 'right' }, { label: 'On hand', align: 'right' }, { label: 'Value', money: true }], byValue(byCategory, 2, 30).map(([k, v]) => [k, v[0], round3(v[1]), cents(v[2])])),
      table('Top movers out', [{ label: 'Item' }, { label: 'Issued', align: 'right' }, { label: 'Value', money: true }], byValue(outByItem, 1, 15).map(([k, v]) => [k, round3(v[0]), cents(v[1])])),
      table(
        'Slow-moving stock by value',
        [{ label: 'Item' }, { label: 'Warehouse' }, { label: 'On hand', align: 'right' }, { label: 'Value', money: true }],
        slow.slice(0, 15).map((b) => [`${b.item.name} (${b.item.code})`, b.warehouse.name, num(b.quantity), valueOf(b)]),
      ),
    ],
    notes: ['Slow-moving ranks by value, not age: an idle compressor matters more than a thousand idle washers.'],
  };
}

async function outgoing(range: Range): Promise<Report> {
  const rows = await prisma.stockIssue.findMany({
    where: { issueDate: { gte: range.from, lte: range.to } },
    include: {
      items: { select: { quantity: true, amount: true, item: { select: { name: true, code: true } } } },
      job: { select: { number: true, name: true } },
      issuedTo: { select: { name: true } },
    },
  });
  const issued = rows.filter((r) => r.status === 'ISSUED');
  const qtyOf = (r: (typeof rows)[number]) => round3(r.items.reduce((s, i) => s + num(i.quantity), 0));
  const valueOf = (r: (typeof rows)[number]) => cents(r.items.reduce((s, i) => s + num(i.amount), 0));
  const series = new Series('Outgoing by month', [{ label: 'Slips issued' }, { label: 'Quantity' }, { label: 'Value', money: true }], monthsOf(range));
  for (const r of issued) {
    series.add(r.issueDate, 0, 1);
    series.add(r.issueDate, 1, qtyOf(r));
    series.add(r.issueDate, 2, valueOf(r));
  }
  const lines = issued.flatMap((r) => r.items.map((i) => ({ key: `${i.item.name} (${i.item.code})`, quantity: num(i.quantity), value: num(i.amount) })));
  const three = (m: Map<string, number[]>, top = 10) => byValue(m, 2, top).map(([k, v]) => [k, v[0], round3(v[1]), cents(v[2])]);
  return {
    kind: 'outgoing',
    title: 'Outgoing',
    from: dayOf(range.from),
    to: dayOf(range.to),
    cards: [
      { label: 'Slips issued', value: issued.length, sub: `${rows.filter((r) => r.status === 'PENDING_APPROVAL').length} waiting for approval` },
      { label: 'Quantity issued', value: round3(issued.reduce((s, r) => s + qtyOf(r), 0)) },
      { label: 'Value issued', value: cents(issued.reduce((s, r) => s + valueOf(r), 0)), money: true, sub: 'at average cost' },
      { label: 'Not yet confirmed received', value: issued.filter((r) => !r.receivedAt).length },
    ],
    series: series.done(),
    tables: [
      table('By project', [{ label: 'Project' }, { label: 'Slips', align: 'right' }, { label: 'Quantity', align: 'right' }, { label: 'Value', money: true }], three(tally(issued, (r) => (r.job ? `${r.job.number} — ${r.job.name}` : 'General use'), (r) => [1, qtyOf(r), valueOf(r)]))),
      table('By requestor', [{ label: 'Requested by' }, { label: 'Slips', align: 'right' }, { label: 'Quantity', align: 'right' }, { label: 'Value', money: true }], three(tally(issued, (r) => r.issuedTo?.name ?? r.issuedToName ?? 'Not named', (r) => [1, qtyOf(r), valueOf(r)]))),
      table('Top items', [{ label: 'Item' }, { label: 'Lines', align: 'right' }, { label: 'Quantity', align: 'right' }, { label: 'Value', money: true }], three(tally(lines, (l) => l.key, (l) => [1, l.quantity, l.value]), 15)),
    ],
  };
}

async function borrow(range: Range): Promise<Report> {
  const today = manilaDate(new Date());
  const rows = await prisma.borrowSlip.findMany({
    where: { borrowedAt: { gte: range.from, lte: range.to }, status: { in: ['OUT', 'PARTIALLY_RETURNED', 'OVERDUE', 'RETURNED'] } },
    include: { items: { select: { quantity: true, returnedQty: true, item: { select: { name: true, code: true } } } } },
  });
  const lent = (r: (typeof rows)[number]) => round3(r.items.reduce((s, i) => s + num(i.quantity), 0));
  const out = (r: (typeof rows)[number]) => (r.status === 'RETURNED' ? 0 : round3(r.items.reduce((s, i) => s + num(i.quantity) - num(i.returnedQty), 0)));
  const series = new Series('Borrow slips by month', [{ label: 'Released' }, { label: 'Items lent' }, { label: 'Returned in full' }], monthsOf(range));
  for (const r of rows) {
    series.add(r.borrowedAt, 0, 1);
    series.add(r.borrowedAt, 1, lent(r));
    if (r.status === 'RETURNED') series.add(r.borrowedAt, 2, 1);
  }
  const lines = rows.flatMap((r) => r.items.map((i) => ({ key: `${i.item.name} (${i.item.code})`, quantity: num(i.quantity) })));
  const overdue = rows.filter((r) => r.status !== 'RETURNED' && r.dueAt < today);
  return {
    kind: 'borrow',
    title: 'Borrow Slips',
    from: dayOf(range.from),
    to: dayOf(range.to),
    cards: [
      { label: 'Slips released', value: rows.length, sub: `${rows.filter((r) => r.status === 'RETURNED').length} back in full` },
      { label: 'Items lent', value: round3(rows.reduce((s, r) => s + lent(r), 0)) },
      { label: 'Still out', value: round3(rows.reduce((s, r) => s + out(r), 0)), sub: 'from slips released in the period' },
      { label: 'Overdue now', value: overdue.length, sub: overdue.length ? 'past their return date' : 'everything on time' },
    ],
    series: series.done(),
    tables: [
      table('By borrowing type', [{ label: 'Type' }, { label: 'Slips', align: 'right' }, { label: 'Items', align: 'right' }], byValue(tally(rows, (r) => (r.borrowType ? BORROW_TYPES[r.borrowType] : 'Not said'), (r) => [1, lent(r)]), 0, 10).map(([k, v]) => [k, v[0], round3(v[1])])),
      table('By borrower', [{ label: 'Borrower' }, { label: 'Slips', align: 'right' }, { label: 'Items', align: 'right' }, { label: 'Still out', align: 'right' }], byValue(tally(rows, (r) => r.borrowerName, (r) => [1, lent(r), out(r)]), 0, 15).map(([k, v]) => [k, v[0], round3(v[1]), round3(v[2])])),
      table('Most borrowed', [{ label: 'Item' }, { label: 'Times', align: 'right' }, { label: 'Quantity', align: 'right' }], byValue(tally(lines, (l) => l.key, (l) => [1, l.quantity]), 0, 15).map(([k, v]) => [k, v[0], round3(v[1])])),
    ],
  };
}

async function pullout(range: Range): Promise<Report> {
  const rows = await prisma.pulloutSlip.findMany({
    where: { pulloutDate: { gte: range.from, lte: range.to } },
    include: {
      items: { select: { quantity: true, amount: true, item: { select: { name: true, code: true } } } },
      job: { select: { number: true, name: true } },
    },
  });
  const done = rows.filter((r) => r.status === 'PULLED_OUT');
  const qtyOf = (r: (typeof rows)[number]) => round3(r.items.reduce((s, i) => s + num(i.quantity), 0));
  const valueOf = (r: (typeof rows)[number]) => cents(r.items.reduce((s, i) => s + num(i.amount), 0));
  const series = new Series('Pull-outs by month', [{ label: 'Slips pulled out' }, { label: 'Quantity' }, { label: 'Value at cost', money: true }], monthsOf(range));
  for (const r of done) {
    series.add(r.pulloutDate, 0, 1);
    series.add(r.pulloutDate, 1, qtyOf(r));
    series.add(r.pulloutDate, 2, valueOf(r));
  }
  const three = (m: Map<string, number[]>, top = 10) => byValue(m, 2, top).map(([k, v]) => [k, v[0], round3(v[1]), cents(v[2])]);
  const kindOf = (r: (typeof rows)[number]) => (r.kind === 'SALES_ORDER' ? 'Against a sales order' : r.kind === 'PURCHASE_REQUEST' ? 'Against a purchase request' : 'No source document');
  return {
    kind: 'pullout',
    title: 'Pull-out Slips',
    from: dayOf(range.from),
    to: dayOf(range.to),
    cards: [
      { label: 'Slips pulled out', value: done.length, sub: `${rows.filter((r) => r.status === 'PENDING_APPROVAL').length} waiting for approval` },
      { label: 'Quantity', value: round3(done.reduce((s, r) => s + qtyOf(r), 0)) },
      { label: 'Value at cost', value: cents(done.reduce((s, r) => s + valueOf(r), 0)), money: true, sub: 'never printed on the slip' },
      { label: 'With no source document', value: done.filter((r) => r.kind === 'OTHER').length },
    ],
    series: series.done(),
    tables: [
      table('By purpose', [{ label: 'Purpose' }, { label: 'Slips', align: 'right' }, { label: 'Quantity', align: 'right' }, { label: 'Value at cost', money: true }], three(tally(done, (r) => PULLOUT_PURPOSES[purposeOf(r)], (r) => [1, qtyOf(r), valueOf(r)]))),
      table('By destination', [{ label: 'Project / destination' }, { label: 'Slips', align: 'right' }, { label: 'Quantity', align: 'right' }, { label: 'Value at cost', money: true }], three(tally(done, (r) => (r.job ? `${r.job.number} — ${r.job.name}` : (r.destination ?? 'Not stated')), (r) => [1, qtyOf(r), valueOf(r)]))),
      table('By source', [{ label: 'Source' }, { label: 'Slips', align: 'right' }, { label: 'Quantity', align: 'right' }, { label: 'Value at cost', money: true }], three(tally(done, kindOf, (r) => [1, qtyOf(r), valueOf(r)]))),
    ],
  };
}

const KINDS: Record<string, (range: Range) => Promise<Report>> = {
  overview,
  'purchase-requests': purchaseRequests,
  rfq,
  canvass,
  'purchase-orders': purchaseOrders,
  incoming,
  inventory,
  outgoing,
  borrow,
  pullout,
};
export const REPORT_KINDS = Object.keys(KINDS);

mountReports(chainReportRoutes, { view: VIEW, auditType: 'chain_report', kinds: KINDS });
