import { topOfFlow } from '../shared/sankey';
import { ordersInvoiced } from '../shared/billingInvoice';
import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { authenticate, currentUser, require_ } from '../auth/middleware';
import { can } from '../permissions/resolve';
import { audit } from '../shared/audit';
import { parseRange } from '../shared/insights';
import { gopsSales } from '../shared/gops';
import { renderSalesReport, companyCurrency, formatAmount, formatDate } from '../shared/pdf';
import { contentDisposition, paperFileName } from '../shared/paperName';
import { handler, forbidden } from '../http/kit';
import { type Range } from '../shared/insights';
import { statusLabel } from '../shared/pdf';
import { quotationTotals } from '../shared/quotation';
import { orderTeamWhere } from '../shared/team';
import { GROUP_SEPARATOR, NO_GROUP, groupKeyOf, groupSharesOf, isNarrowed, listParam, live as liveRows, narrowRows, salesOrderRows, type RowFilter } from '../shared/salesFigures';
import { salesMatrix } from '../shared/gops';
import { badRequest } from '../http/kit';
import { Series, byValue, cents, linkTo, monthsOf, mountReports, num, pct, table, tally, type Cell, type Report, type ReportContext } from '../shared/reportKit';
import { canSeeOrderCost } from './salesOrders';

/**
 * The Sales Order report (2026-10-23, the owner's call: "create a button
 * report for Sales Order") — the Report button on the Sales Orders list,
 * on the shared engine (`shared/reportKit.ts`). Orders DATED in the range,
 * under the list's own visibility rule (`salesOrdersReadable`), narrowed
 * by `?ownerId=`, `?teamId=` (an id or `none`) and `?status=`. Figures are
 * pesos: an order is in its quotation's currency, converted at the
 * quotation's own rate (`inBase`). A cancelled order books nothing: it is
 * counted under By status and nowhere else. The margin is read only off the
 * orders whose cost the reader may see (`canSeeOrderCost`), and says on how
 * many. No table of its own: every figure is read off the orders, their
 * lines and their live invoices.
 */

export const salesReportRoutes = Router();
salesReportRoutes.use(authenticate);

const STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'ISSUED', 'CANCELLED'] as const;

async function salesOrdersReport(range: Range, ctx: ReportContext): Promise<Report> {
  const me = currentUser(ctx.req);
  const q = ctx.query;
  const and: Prisma.SalesOrderWhereInput[] = [{ orderDate: { gte: range.from, lte: range.to } }];
  // Several of each (2026-11-13): `ownerId=a,b`, `teamId=a,none`,
  // `customerId=a,b`, `group=X|Y` — the pictures' and the paper's own filter.
  const f = rowFilterOf(q);
  const words = await filterWords(f);
  if (f.ownerIds) and.push({ ownerId: { in: f.ownerIds } });
  if (f.teamIds) {
    and.push({
      OR: f.teamIds.map((t) =>
        t === 'none' ? { teamId: null, quotation: { teamId: null, owner: { OR: [{ employee: null }, { employee: { industryId: null } }] } } } : orderTeamWhere(t),
      ),
    });
  }
  if (f.status) and.push({ status: f.status as (typeof STATUSES)[number] });
  if (f.customerIds) and.push({ customerId: { in: f.customerIds } });
  // Product groups narrow each order to the ticked groups' SHARE of it (below).
  const wantGroups = f.groups ? new Set(f.groups.map((g) => groupKeyOf(g === 'none' ? NO_GROUP : g))) : null;

  // The rows and their pesos are shared/salesFigures.ts — the G-OPS dashboard
  // reads the same, so the two cannot disagree (2026-11-08). The range's
  // own `orderDate` filter is the shared function's first condition.
  const orders = await salesOrderRows(me, range.from, range.to, and.slice(1));
  const live = liveRows(orders);
  const liveIds = live.map((o) => o.id);
  const [lines, invoiced] = await Promise.all([
    liveIds.length
      ? prisma.salesOrderLine.findMany({ where: { orderId: { in: liveIds } }, select: { orderId: true, group: true, amount: true, costAmount: true, isHeading: true } })
      : [],
    // Each order's own share of its invoices — an S.I. may bill several orders (2026-11-14).
    ordersInvoiced(prisma, liveIds),
  ]);
  const linesOf = new Map<string, typeof lines>();
  for (const l of lines) linesOf.set(l.orderId, [...(linesOf.get(l.orderId) ?? []), l]);
  const invoicedOf = invoiced;

  // Each live order in pesos: its total (with VAT), its net before VAT, what
  // live invoices bill of it (before VAT), and its margin where seen.
  const wholeFigures = live.map((o) => {
    const rate = o.rate;
    const t = quotationTotals({ lines: (linesOf.get(o.id) ?? []).filter((l) => !l.isHeading), discountPct: o.raw.discountPct, vatRate: o.raw.vatRate, vatInclusive: o.raw.vatInclusive });
    const seen = canSeeOrderCost(me, o.ownerId) && t.cost.costedLines > 0;
    return {
      o,
      team: o.team ? o.team.code : 'No team',
      teamId: o.team ? o.team.id : 'none',
      total: o.total,
      // Before VAT is the order's stored total less its VAT — what invoicing reads (orderNet).
      net: o.net,
      invoiced: cents((invoicedOf.get(o.id) ?? 0) * rate),
      margin: seen ? cents(t.cost.totalMargin * rate) : 0,
      marginBase: seen ? cents(t.netOfTax * rate) : 0,
      seen,
      // Each line's share of the order's net, by its product group.
      groups: (linesOf.get(o.id) ?? [])
        .filter((l) => !l.isHeading)
        .map((l) => ({ group: l.group?.trim() || 'No group', amount: num(l.amount) })),
      netRaw: o.raw.total - o.raw.vatAmount,
      subtotalRaw: t.subtotal,
      rate,
    };
  });
  // With a product group chosen, an order keeps the fraction its lines under
  // that group make of its subtotal — of its total, net, invoiced and margin
  // alike — and an order with none of it drops out.
  const figures = !wantGroups
    ? wholeFigures
    : wholeFigures.flatMap((x) => {
        const mine = x.groups.filter((g) => wantGroups.has(groupKeyOf(g.group)));
        const share = x.subtotalRaw > 0 ? mine.reduce((n, g) => n + g.amount, 0) / x.subtotalRaw : wantGroups.has(groupKeyOf(NO_GROUP)) ? 1 : 0;
        if (!(share > 0)) return [];
        return [{ ...x, total: cents(x.total * share), net: cents(x.net * share), invoiced: cents(x.invoiced * share), margin: cents(x.margin * share), marginBase: cents(x.marginBase * share), groups: mine }];
      });
  const sum = (f: (x: (typeof figures)[number]) => number) => cents(figures.reduce((s, x) => s + f(x), 0));
  const booked = sum((x) => x.total);
  const net = sum((x) => x.net);
  const billed = sum((x) => x.invoiced);
  const margin = sum((x) => x.margin);
  const marginBase = sum((x) => x.marginBase);
  const seenCount = figures.filter((x) => x.seen).length;

  const months = monthsOf(range);
  const series = new Series(
    'Sales orders by month',
    [{ label: 'Orders' }, { label: 'Booked (with VAT)', money: true }, { label: 'Before VAT', money: true }, { label: 'Invoiced', money: true }],
    months,
  );
  for (const x of figures) {
    series.add(x.o.orderDate, 0, 1);
    series.add(x.o.orderDate, 1, x.total);
    series.add(x.o.orderDate, 2, x.net);
    series.add(x.o.orderDate, 3, x.invoiced);
  }

  const four = (x: (typeof figures)[number]) => [1, x.total, x.net, x.invoiced];
  const shareCols = [{ label: 'Orders', align: 'right' as const }, { label: 'Booked', money: true }, { label: 'Before VAT', money: true }, { label: 'Invoiced', money: true }, { label: 'Share %', align: 'right' as const }];
  const shareRows = (m: Map<string, number[]>, top = 15) =>
    byValue(m, 1, top).map(([k, v]) => [k, v[0], cents(v[1]), cents(v[2]), cents(v[3]), pct(v[1], booked)]);

  // Keyed by id, named for the row: each row opens the list on the same slice (2026-11-04).
  const byTeam = tally(figures, (x) => x.teamId, four);
  const byOwner = tally(figures, (x) => x.o.ownerId, four);
  const byCustomer = tally(figures, (x) => x.o.customerId, four);
  const teamName = new Map(figures.map((x) => [x.teamId, x.team]));
  const ownerName = new Map(figures.map((x) => [x.o.ownerId, x.o.ownerName]));
  const customerName = new Map(figures.map((x) => [x.o.customerId, x.o.customerName]));
  const named = (rows: ReturnType<typeof shareRows>, names: Map<string, string>) => rows.map(([k, ...rest]) => [names.get(String(k)) ?? String(k), ...rest]);
  const keysOf = (rows: ReturnType<typeof shareRows>) => rows.map((r) => String(r[0]));

  // Every link opens the Sales Orders list on the report's own slice: its
  // dates, every order the reader may see, the orders it counts (booked —
  // not cancelled — unless a status narrowed it), and its narrowing.
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const listLink = (extra: Record<string, string | null | undefined>) =>
    linkTo('/g-ops/sales-orders', {
      dateFrom: day(range.from),
      dateTo: day(range.to),
      scope: 'all',
      // The list's filters take one value each: a box with several ticks is left to the row's own link.
      ownerId: f.ownerIds?.length === 1 ? f.ownerIds[0] : null,
      teamId: f.teamIds?.length === 1 ? f.teamIds[0] : null,
      customerId: f.customerIds?.length === 1 ? f.customerIds[0] : null,
      ...(f.status ? { status: f.status } : { booked: 'yes' }),
      ...extra,
    });
  const teamRows = shareRows(byTeam, 10);
  const ownerRows = shareRows(byOwner);
  const customerRows = shareRows(byCustomer);

  // A product group's share of each order's net, in pesos (the lines'
  // amounts carry the order's discount pro rata).
  const groupNet = new Map<string, number>();
  for (const x of figures) {
    // An order with no priced lines puts its whole net under "No group", so the table adds up to Before VAT.
    if (x.subtotalRaw <= 0) {
      groupNet.set('No group', (groupNet.get('No group') ?? 0) + x.netRaw * x.rate);
      continue;
    }
    for (const g of x.groups) groupNet.set(g.group, (groupNet.get(g.group) ?? 0) + (g.amount / x.subtotalRaw) * x.netRaw * x.rate);
  }

  const byStatus = new Map<string, number[]>();
  // With a product group chosen only the orders holding it are counted, at their share.
  for (const o of wantGroups ? figures.map((x) => ({ status: x.o.status, total: x.total })) : orders) {
    const cur = byStatus.get(o.status) ?? [0, 0];
    byStatus.set(o.status, [cur[0] + 1, cur[1] + o.total]);
  }

  const tables = [
    table('By team', [{ label: 'Team' }, ...shareCols], named(teamRows, teamName), keysOf(teamRows).map((k) => listLink({ teamId: k }))),
    table('By salesperson', [{ label: 'Booked by' }, ...shareCols], named(ownerRows, ownerName), keysOf(ownerRows).map((k) => listLink({ ownerId: k }))),
    table('By customer', [{ label: 'Customer' }, ...shareCols], named(customerRows, customerName), keysOf(customerRows).map((k) => listLink({ customerId: k }))),
    table(
      'By product group (before VAT)',
      [{ label: 'Group' }, { label: 'Before VAT', money: true }, { label: 'Share %', align: 'right' }],
      [...groupNet.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => [k, cents(v), pct(v, net)]),
    ),
    table(
      'By status',
      [{ label: 'Status' }, { label: 'Orders', align: 'right' }, { label: 'Total', money: true }],
      STATUSES.filter((s) => byStatus.has(s)).map((s) => [statusLabel(s), byStatus.get(s)![0], cents(byStatus.get(s)![1])]),
      STATUSES.filter((s) => byStatus.has(s)).map((s) => listLink({ status: s, booked: null })),
    ),
    table(
      'Largest orders',
      [{ label: 'Number' }, { label: 'Customer' }, { label: 'Booked by' }, { label: 'Status' }, { label: 'Booked', money: true }, { label: 'Invoiced', money: true }],
      [...figures].sort((a, b) => b.total - a.total).slice(0, 15).map((x) => [x.o.number, x.o.customerName, x.o.ownerName, statusLabel(x.o.status), x.total, x.invoiced]),
      [...figures].sort((a, b) => b.total - a.total).slice(0, 15).map((x) => `/g-ops/sales-orders/${x.o.id}`),
    ),
  ];

  const cancelled = wantGroups ? 0 : orders.length - live.length;
  const notes: string[] = [];
  if (cancelled) notes.push(`${cancelled} cancelled order${cancelled === 1 ? '' : 's'} in the period book${cancelled === 1 ? 's' : ''} nothing and ${cancelled === 1 ? 'is' : 'are'} counted under By status only.`);
  if (figures.some((x) => x.o.currency !== 'PHP')) notes.push('Orders in a foreign currency are converted to pesos at their quotation’s own rate.');
  if (figures.length && seenCount < figures.length) notes.push(`The margin is read off the ${seenCount} of ${figures.length} orders whose cost you may see.`);

  return {
    kind: 'sales-orders',
    title: 'Sales Order Report',
    from: range.from.toISOString().slice(0, 10),
    to: range.to.toISOString().slice(0, 10),
    ...(words.length ? { filterLine: words.join(' · ') } : {}),
    cards: [
      { label: 'Sales orders', value: figures.length, ...(cancelled ? { sub: `${cancelled} cancelled, not counted` } : {}) },
      { label: 'Booked (with VAT)', value: booked, money: true },
      { label: 'Before VAT', value: net, money: true },
      { label: 'Invoiced', value: billed, money: true, sub: `${pct(billed, net)}% of before VAT` },
      { label: 'Left to invoice', value: cents(Math.max(0, net - billed)), money: true },
      ...(seenCount ? [{ label: 'Margin', value: margin, money: true, sub: `${pct(margin, marginBase)}% on ${seenCount} order${seenCount === 1 ? '' : 's'}` }] : []),
    ],
    // Each month opens the list on its days, clipped to the range.
    series: (() => {
      const done = series.done();
      return {
        ...done,
        rows: done.rows.map((r, i) => {
          const m = months[i];
          if (!m) return r;
          const first = `${m.key}-01`;
          const lastDay = new Date(Date.UTC(Number(m.key.slice(0, 4)), Number(m.key.slice(5, 7)), 0)).toISOString().slice(0, 10);
          const from = first < day(range.from) ? day(range.from) : first;
          const to = lastDay > day(range.to) ? day(range.to) : lastDay;
          return { ...r, link: listLink({ dateFrom: from, dateTo: to }) };
        }),
      };
    })(),
    tables,
    ...(notes.length ? { notes } : {}),
  };
}

/**
 * Sales orders with NO sales invoice yet — or not all of it (2026-11-14, the
 * owner's call: "a view of sales orders without a sales invoice, to better
 * understand their sales — by personnel, by team"). ISSUED orders dated in
 * the range, under the list's visibility, each with what is left of it to
 * invoice before VAT (its net less its own share of the live invoices —
 * `ordersInvoiced`, one S.I. for several orders included). An order invoiced
 * in full drops out. Narrowed like the Sales Order report: `ownerId`,
 * `teamId`, `customerId`. Nothing stored: read off the orders, their
 * invoices and the open invoice requests.
 */
async function toInvoiceReport(range: Range, ctx: ReportContext): Promise<Report> {
  const me = currentUser(ctx.req);
  const f = rowFilterOf(ctx.query);
  const words = await filterWords({ ...f, status: undefined, groups: undefined });
  const and: Prisma.SalesOrderWhereInput[] = [{ status: 'ISSUED' }];
  if (f.ownerIds) and.push({ ownerId: { in: f.ownerIds } });
  if (f.teamIds) {
    and.push({
      OR: f.teamIds.map((t) =>
        t === 'none' ? { teamId: null, quotation: { teamId: null, owner: { OR: [{ employee: null }, { employee: { industryId: null } }] } } } : orderTeamWhere(t),
      ),
    });
  }
  if (f.customerIds) and.push({ customerId: { in: f.customerIds } });
  const orders = await salesOrderRows(me, range.from, range.to, and);
  const ids = orders.map((o) => o.id);
  const live = { status: { in: ['DRAFT', 'PENDING_APPROVAL'] as ('DRAFT' | 'PENDING_APPROVAL')[] } };
  const [invoicedOf, singles, parts, poOf] = await Promise.all([
    ordersInvoiced(prisma, ids),
    ids.length
      ? prisma.invoiceRequest.findMany({ where: { salesOrderId: { in: ids }, parts: { none: {} }, ...live }, select: { salesOrderId: true, grossAmount: true, progressBilling: { select: { grossAmount: true } } } })
      : [],
    ids.length ? prisma.invoiceRequestPart.findMany({ where: { salesOrderId: { in: ids }, request: live }, select: { salesOrderId: true, amount: true } }) : [],
    ids.length ? prisma.salesOrder.findMany({ where: { id: { in: ids } }, select: { id: true, poNumber: true, drNumber: true } }) : [],
  ]);
  const requestedOf = new Map<string, number>();
  for (const r of singles) requestedOf.set(r.salesOrderId, (requestedOf.get(r.salesOrderId) ?? 0) + num(r.progressBilling?.grossAmount ?? r.grossAmount));
  for (const p of parts) requestedOf.set(p.salesOrderId, (requestedOf.get(p.salesOrderId) ?? 0) + num(p.amount));
  const po = new Map(poOf.map((o) => [o.id, o]));

  const today = new Date();
  const rows = orders
    .map((o) => {
      const invoiced = cents((invoicedOf.get(o.id) ?? 0) * o.rate);
      const left = cents(Math.max(0, o.net - invoiced));
      const requested = cents(Math.min(left, (requestedOf.get(o.id) ?? 0) * o.rate));
      const age = Math.max(0, Math.floor((today.getTime() - o.orderDate.getTime()) / 86_400_000));
      return { o, invoiced, left, requested, age, never: invoiced < 0.005, team: o.team ? o.team.code : 'No team', teamId: o.team ? o.team.id : 'none' };
    })
    // A peso of tolerance: rounding between an order and its invoice is not a backlog.
    .filter((x) => x.left > 1);

  const sum = (pick: (x: (typeof rows)[number]) => number, of = rows) => cents(of.reduce((n, x) => n + pick(x), 0));
  const left = sum((x) => x.left);
  const never = rows.filter((x) => x.never);
  const partly = rows.filter((x) => !x.never);
  const requested = sum((x) => x.requested);
  const oldest = rows.reduce((m, x) => Math.max(m, x.age), 0);
  const delivered = rows.filter((x) => po.get(x.o.id)?.drNumber);

  const months = monthsOf(range);
  const series = new Series('Left to invoice, by the month the order was booked', [{ label: 'Orders', align: 'right' }, { label: 'Left to invoice', money: true }], months);
  for (const x of rows) {
    series.add(x.o.orderDate, 0, 1);
    series.add(x.o.orderDate, 1, x.left);
  }

  const day = (d: Date) => d.toISOString().slice(0, 10);
  const listLink = (extra: Record<string, string | null | undefined>) =>
    linkTo('/g-ops/sales-orders', { dateFrom: day(range.from), dateTo: day(range.to), scope: 'all', status: 'ISSUED', ...extra });
  const cols = [
    { label: 'Orders', align: 'right' as const },
    { label: 'Never invoiced', align: 'right' as const },
    { label: 'Before VAT', money: true },
    { label: 'Invoiced', money: true },
    { label: 'Left to invoice', money: true },
    { label: 'Share %', align: 'right' as const },
    { label: 'Oldest (days)', align: 'right' as const },
  ];
  const grouped = (keyOf: (x: (typeof rows)[number]) => string, top?: number) => {
    const m = new Map<string, { n: number; never: number; net: number; inv: number; left: number; oldest: number }>();
    for (const x of rows) {
      const cur = m.get(keyOf(x)) ?? { n: 0, never: 0, net: 0, inv: 0, left: 0, oldest: 0 };
      m.set(keyOf(x), { n: cur.n + 1, never: cur.never + (x.never ? 1 : 0), net: cur.net + x.o.net, inv: cur.inv + x.invoiced, left: cur.left + x.left, oldest: Math.max(cur.oldest, x.age) });
    }
    const sorted = [...m.entries()].sort((a, b) => b[1].left - a[1].left);
    return top ? sorted.slice(0, top) : sorted;
  };
  const cells = (v: { n: number; never: number; net: number; inv: number; left: number; oldest: number }): Cell[] => [v.n, v.never, cents(v.net), cents(v.inv), cents(v.left), pct(v.left, left), v.oldest];
  const ownerName = new Map(rows.map((x) => [x.o.ownerId, x.o.ownerName]));
  const customerName = new Map(rows.map((x) => [x.o.customerId, x.o.customerName]));
  const teamName = new Map(rows.map((x) => [x.teamId, x.team]));
  const byOwner = grouped((x) => x.o.ownerId);
  const byTeam = grouped((x) => x.teamId);
  const byCustomer = grouped((x) => x.o.customerId, 20);

  // How long it has waited since it was booked.
  const BUCKETS: [string, number, number][] = [['0–30 days', 0, 30], ['31–60 days', 31, 60], ['61–90 days', 61, 90], ['Over 90 days', 91, Infinity]];
  const byAge = BUCKETS.map(([label, lo, hi]) => {
    const of = rows.filter((x) => x.age >= lo && x.age <= hi);
    return [label, of.length, sum((x) => x.left, of), pct(sum((x) => x.left, of), left)] as Cell[];
  });

  const listed = [...rows].sort((a, b) => b.left - a.left).slice(0, 100);
  const notes: string[] = ['Issued sales orders with something still to invoice, before VAT; an order invoiced in full is not listed, and neither is a draft, pending or cancelled order.'];
  if (requested > 0) notes.push('“Already requested” is what open invoice requests ask of these orders — on its way to Accounts Receivable.');
  if (rows.length > listed.length) notes.push(`The orders table lists the ${listed.length} with the most left to invoice, of ${rows.length}.`);
  if (rows.some((x) => x.o.currency !== 'PHP')) notes.push('Orders in a foreign currency are converted to pesos at their quotation’s own rate.');

  return {
    kind: 'to-invoice',
    title: 'Sales Orders Not Yet Invoiced',
    from: day(range.from),
    to: day(range.to),
    ...(words.length ? { filterLine: words.join(' · ') } : {}),
    cards: [
      { label: 'Orders to invoice', value: rows.length, sub: `of ${orders.length} issued in the period` },
      { label: 'Left to invoice', value: left, money: true, sub: 'before VAT' },
      { label: 'Never invoiced', value: sum((x) => x.left, never), money: true, sub: `${never.length} order${never.length === 1 ? '' : 's'} with no invoice at all` },
      { label: 'Partly invoiced', value: sum((x) => x.left, partly), money: true, sub: `${partly.length} order${partly.length === 1 ? '' : 's'} with a balance left` },
      { label: 'Already requested', value: requested, money: true, sub: 'in open invoice requests' },
      { label: 'Delivered, not invoiced', value: sum((x) => x.left, delivered), money: true, sub: `${delivered.length} with a DR number` },
      { label: 'Oldest waiting', value: oldest, sub: 'days since it was booked' },
    ],
    series: series.done(),
    tables: [
      table('By salesperson', [{ label: 'Booked by' }, ...cols], byOwner.map(([k, v]) => [ownerName.get(k) ?? k, ...cells(v)]), byOwner.map(([k]) => listLink({ ownerId: k }))),
      table('By team', [{ label: 'Team' }, ...cols], byTeam.map(([k, v]) => [teamName.get(k) ?? k, ...cells(v)]), byTeam.map(([k]) => listLink({ teamId: k }))),
      table('By customer', [{ label: 'Customer' }, ...cols], byCustomer.map(([k, v]) => [customerName.get(k) ?? k, ...cells(v)]), byCustomer.map(([k]) => listLink({ customerId: k }))),
      table('By how long it has waited', [{ label: 'Since booked' }, { label: 'Orders', align: 'right' }, { label: 'Left to invoice', money: true }, { label: 'Share %', align: 'right' }], byAge),
      table(
        'The orders',
        [
          { label: 'Number' },
          { label: 'Booked' },
          { label: 'Customer' },
          { label: 'Booked by' },
          { label: 'Team' },
          { label: 'PO' },
          { label: 'Before VAT', money: true },
          { label: 'Invoiced', money: true },
          { label: 'Left to invoice', money: true },
          { label: 'Requested', money: true },
          { label: 'Days', align: 'right' },
        ],
        listed.map((x) => [x.o.number, formatDate(x.o.orderDate), x.o.customerName, x.o.ownerName, x.team, po.get(x.o.id)?.poNumber ?? '—', x.o.net, x.invoiced, x.left, x.requested, x.age]),
        listed.map((x) => `/g-ops/sales-orders/${x.o.id}`),
      ),
    ],
    notes,
  };
}

/**
 * The G-OPS dashboard's monthly sales analysis (2026-11-08, page 2 of the
 * owner's `G-OPS_Dashboard_1.pdf`): the months of the range across, the
 * teams down with each person under their team — or the key customers
 * (`?by=customer`) — every figure booked sales orders BEFORE VAT in pesos,
 * the dashboard's own rows (`salesMatrix` in shared/gops.ts). `?teamId=`
 * narrows to one team or `none`. The series is Gruntech's month by month;
 * the one table is the matrix, a person's row under their team marked "↳".
 */
async function salesMatrixReport(range: Range, ctx: ReportContext): Promise<Report> {
  const me = currentUser(ctx.req);
  const by = ctx.query.by === 'customer' ? 'customer' : ctx.query.by === 'team' || !ctx.query.by ? 'team' : null;
  if (!by) throw badRequest('Grouping is one of team, customer');
  const m = await salesMatrix(me, range.from, range.to, { by, teamId: ctx.query.teamId });
  const periods = m.months.map((x) => ({ key: x.key, label: x.label }));
  const series = new Series('Sales by month', [{ label: 'Before VAT', money: true }], periods);
  m.months.forEach((x, i) => series.addTo(x.key, 0, m.total[i]));
  const monthCols = m.months.map((x) => ({ label: x.label, money: true }));
  const rows: Cell[][] = [];
  const links: (string | null)[] = [];
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const listLink = (extra: Record<string, string | null | undefined>) =>
    linkTo('/g-ops/sales-orders', { dateFrom: day(range.from), dateTo: day(range.to), scope: 'all', booked: 'yes', ...extra });
  for (const g of m.groups) {
    rows.push([g.label, ...g.values, g.total]);
    links.push(by === 'team' ? listLink({ teamId: g.id }) : listLink({ customerId: g.id }));
    for (const c of g.children) {
      rows.push([`↳ ${c.label}`, ...c.values, c.total]);
      links.push(listLink({ ownerId: c.id, teamId: g.id }));
    }
  }
  rows.push(['Gruntech', ...m.total, cents(m.total.reduce((s, v) => s + v, 0))]);
  links.push(listLink({}));
  const grand = cents(m.total.reduce((s, v) => s + v, 0));
  return {
    kind: 'sales-matrix',
    title: 'Monthly Sales Performance Analysis',
    from: day(range.from),
    to: day(range.to),
    filterLine: m.filterLine,
    cards: [{ label: 'Before VAT', value: grand, money: true }, { label: by === 'team' ? 'Teams' : 'Customers', value: m.groups.length }],
    series: series.done(),
    tables: [table(by === 'team' ? 'By sales team and personnel' : 'Key customers', [{ label: by === 'team' ? 'Team / personnel' : 'Customer' }, ...monthCols, { label: 'Total', money: true }], rows, links)],
    notes: ['Booked sales orders before VAT, in pesos at each quotation’s own rate; a cancelled order books nothing.'],
  };
}

// View Own is implied by View Team and View All (withImpliedLevels), so one key opens it for every reader of the list.
// ── The one-page Sales Report (2026-11-09) ──────────────────────────────────
//
// The owner's "2026 GRUNTECHNOLOGY MONTHLY SALE REPORT" (his
// Sale_Report_October_31_2026.pdf): the Sales Order report's Print is ONE
// landscape page — every salesperson by month with their team and the year's
// total, the team summary, the date, who printed it, the year's target and
// the achievement, then the month bars against last year and the Sankey.
// The year is the one the report's range ends in, January to December; the
// figures are the dashboard's own (`salesOrderRows`, before VAT, pesos), so
// the paper, the dashboard and the report agree. Declared before
// mountReports so it answers `/sales-orders.pdf` in place of the generic
// paper. The target is one Setting per year, `sales.target.<year>`.

const TARGET_KEY = (year: number) => `sales.target.${year}`;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

async function yearTarget(year: number): Promise<number | null> {
  const row = await prisma.setting.findUnique({ where: { key: TARGET_KEY(year) } });
  const v = row ? Number((row.value as { amount?: unknown })?.amount) : NaN;
  return Number.isFinite(v) && v > 0 ? v : null;
}

salesReportRoutes.get(
  '/target/:year',
  require_('gops.sales_orders.view_own'),
  handler(async (req, res) => {
    const year = Number(req.params.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw badRequest('Name a year');
    res.json({ year, amount: await yearTarget(year), canEdit: canSetTarget(currentUser(req)) });
  }),
);

function canSetTarget(me: ReturnType<typeof currentUser>) {
  return me.isSuperAdmin || can(me, 'gops.sales_orders.edit_all') || can(me, 'gops.dashboard.edit_all');
}

salesReportRoutes.put(
  '/target/:year',
  handler(async (req, res) => {
    const me = currentUser(req);
    if (!canSetTarget(me)) throw forbidden('Setting the sales target needs Sales Orders › Edit All');
    const year = Number(req.params.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw badRequest('Name a year');
    const amount = req.body?.amount == null || req.body.amount === '' ? null : Number(req.body.amount);
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) throw badRequest('The target is an amount in pesos');
    const before = await yearTarget(year);
    if (amount) await prisma.setting.upsert({ where: { key: TARGET_KEY(year) }, create: { key: TARGET_KEY(year), value: { amount } }, update: { value: { amount } } });
    else await prisma.setting.deleteMany({ where: { key: TARGET_KEY(year) } });
    await audit({ entityType: 'setting', entityId: TARGET_KEY(year), action: 'UPDATED', summary: `${year} sales target: ${before ?? 'none'} → ${amount ?? 'none'}` }, req);
    res.json({ year, amount: amount || null });
  }),
);

/** The report's filters off a query, checked: the report, the pictures and the paper read them alike. */
function rowFilterOf(query: Record<string, unknown>): RowFilter {
  const status = typeof query.status === 'string' && query.status ? query.status : undefined;
  if (status && !(STATUSES as readonly string[]).includes(status)) throw badRequest(`Status is one of ${STATUSES.map(statusLabel).join(', ')}`);
  return {
    ownerIds: listParam(query.ownerId),
    teamIds: listParam(query.teamId),
    customerIds: listParam(query.customerId),
    status,
    groups: listParam(query.group, GROUP_SEPARATOR),
  };
}

/** Names in a line: every one up to four, then "A, B, C and 5 more". */
function namesLine(names: string[], noun: string): string {
  if (names.length <= 4) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more ${noun}`;
}

/** What a filter narrowed to, in words. */
async function filterWords(f: RowFilter): Promise<string[]> {
  const words: string[] = [];
  if (f.ownerIds) {
    const rows = await prisma.user.findMany({ where: { id: { in: f.ownerIds } }, select: { id: true, name: true } });
    const name = new Map(rows.map((r) => [r.id, r.name]));
    words.push(namesLine(f.ownerIds.map((id) => name.get(id) ?? 'someone not on file'), 'salespeople'));
  }
  if (f.teamIds) {
    const ids = f.teamIds.filter((t) => t !== 'none');
    const rows = ids.length ? await prisma.industry.findMany({ where: { id: { in: ids } }, select: { id: true, code: true } }) : [];
    const code = new Map(rows.map((r) => [r.id, r.code]));
    words.push(`team ${namesLine(f.teamIds.map((t) => (t === 'none' ? 'none' : code.get(t) ?? 'not found')), 'teams')}`);
  }
  if (f.customerIds) {
    const rows = await prisma.customer.findMany({ where: { id: { in: f.customerIds } }, select: { id: true, name: true } });
    const name = new Map(rows.map((r) => [r.id, r.name]));
    words.push(namesLine(f.customerIds.map((id) => name.get(id) ?? 'a customer not on file'), 'customers'));
  }
  if (f.groups) words.push(`product group ${namesLine(f.groups.map((g) => (g === 'none' ? NO_GROUP : g)), 'groups')}${f.groups.length > 1 ? ' (each order\u2019s share of them)' : ''}`);
  if (f.status) words.push(statusLabel(f.status));
  return words;
}

/**
 * The two flows for a filter (2026-11-13). With salespeople ticked they keep
 * the whole company in view: Gruntech and every team at what the OTHER
 * filters admit, the last column only the ticked people and their customers
 * (`gopsSales`' focus). With none ticked, the filter's own slice as before.
 */
function flowsFor(me: ReturnType<typeof currentUser>, range: { from?: unknown; to?: unknown }, f: RowFilter) {
  if (f.ownerIds?.length) {
    const rest: RowFilter = { ...f, ownerIds: undefined };
    return gopsSales(me, range, isNarrowed(rest) ? (rows) => narrowRows(rows, rest) : undefined, f.ownerIds);
  }
  return gopsSales(me, range, isNarrowed(f) ? (rows) => narrowRows(rows, f) : undefined);
}

// The two flows as figures (2026-11-12, the owner's call: "on sales order
// report add download png or jpg for the sankey, salesperson and customer"):
// Gruntech > team > person and Gruntech > team > customer over the report's
// own days — the dashboard's `gopsSales`, so the pictures, the dashboard and
// the paper agree. Declared before mountReports' `/:kind`.
salesReportRoutes.get(
  '/flows',
  require_('gops.sales_orders.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    // The report's own narrowing (2026-11-12, the owner's report: "the filter
    // is not working per person" — the pictures showed everybody): the
    // salesperson, the team, the customer, the product group and the status.
    const f = rowFilterOf(req.query);
    const narrowed = isNarrowed(f);
    const range = { from: req.query.from, to: req.query.to };
    const sales = await flowsFor(me, range, f);
    // Everyone who booked and every customer of these days, whatever the
    // narrowing — the page's pickers list them (a salesperson even once gone).
    const everyone = narrowed ? await gopsSales(me, range) : sales;
    const customers = new Map<string, string>();
    for (const p of everyone.customerSankey.people) customers.set(p.of, p.label);
    res.json({
      from: sales.from,
      to: sales.to,
      total: sales.total,
      orders: sales.orders,
      sankey: sales.sankey,
      customerSankey: sales.customerSankey,
      filterLine: (await filterWords(f)).join(' · '),
      // The flows keep the whole company in view while salespeople are ticked.
      focused: !!f.ownerIds?.length,
      owners: everyone.people.map((p) => ({ id: p.id, name: p.name })),
      customers: [...customers.entries()].map(([id, name]) => ({ id, name })).sort((x, y) => x.name.localeCompare(y.name)),
    });
  }),
);

salesReportRoutes.get(
  '/sales-orders.pdf',
  require_('gops.sales_orders.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, typeof v === 'string' ? v : undefined]));
    const range = parseRange(q.from, q.to);
    const year = range.to.getUTCFullYear();
    const from = new Date(Date.UTC(year, 0, 1));
    const to = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));
    // The paper follows the report's filters (2026-11-12, the owner's batch:
    // "all report details will be about my team sales").
    const f = rowFilterOf(q);
    const narrowed = isNarrowed(f);
    const rows = await narrowRows(liveRows(await salesOrderRows(me, from, to)), f);
    const month = (d: Date) => Number(d.toISOString().slice(5, 7)) - 1;
    const zero = () => MONTHS.map(() => 0);

    type Line = { name: string; team: string; values: number[]; total: number; teams: Map<string, number> };
    const people = new Map<string, Line>();
    const teams = new Map<string, { name: string; code: string; values: number[]; total: number }>();
    const total = zero();
    for (const o of rows) {
      const m = month(o.orderDate);
      const p = people.get(o.ownerId) ?? { name: o.ownerName, team: '', values: zero(), total: 0, teams: new Map() };
      p.values[m] += o.net;
      p.total += o.net;
      const code = o.team?.code ?? o.ownerTeam?.code ?? '';
      p.teams.set(code, (p.teams.get(code) ?? 0) + o.net);
      people.set(o.ownerId, p);
      const tid = o.team?.id ?? 'none';
      const t = teams.get(tid) ?? { name: o.team?.name ?? 'No team', code: o.team?.code ?? '', values: zero(), total: 0 };
      t.values[m] += o.net;
      t.total += o.net;
      teams.set(tid, t);
      total[m] += o.net;
    }
    const peopleRows = [...people.values()]
      .filter((p) => Math.abs(p.total) >= 0.005)
      .map((p) => ({ name: p.name, team: [...p.teams.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '', values: p.values.map(cents), total: cents(p.total) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    // Every active team, even at zero, in the master's order; "No team" last.
    const master = await prisma.industry.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { id: true, code: true, name: true } });
    const teamRows = [
      ...master.map((t) => teams.get(t.id) ?? { name: t.name, code: t.code, values: zero(), total: 0 }),
      ...[...teams.entries()].filter(([id]) => !master.some((t) => t.id === id)).map(([, t]) => t),
    ].map((t) => ({ ...t, values: t.values.map(cents), total: cents(t.total) }));
    const grand = cents(total.reduce((a, b) => a + b, 0));

    const yearRange = { from: `${year}-01-01`, to: q.to ?? `${year}-12-31` };
    const sales = await gopsSales(me, yearRange, narrowed ? (all) => narrowRows(all, f) : undefined);
    const flows = f.ownerIds?.length ? await flowsFor(me, yearRange, f) : sales;
    // `customers=10|25|50` prints the top customers on the flow's page, the
    // rest gathered per team; anything else prints them all.
    const topN = ['10', '25', '50'].includes(q.customers ?? '') ? Number(q.customers) : 0;
    // By customer, by month: every customer once, the largest first, the team
    // that sold it most beside it; past the top n the rest are one row.
    const share = (v: number) => (grand > 0 ? `${((v / grand) * 100).toFixed(1)}%` : '0%');
    type Row = { name: string; second: string; values: number[]; total: number; teams: Map<string, number> };
    const byCustomer = new Map<string, Row>();
    for (const o of rows) {
      const c = byCustomer.get(o.customerId) ?? { name: o.customerName, second: '', values: zero(), total: 0, teams: new Map<string, number>() };
      c.values[month(o.orderDate)] += o.net;
      c.total += o.net;
      const code = o.team?.code ?? '';
      c.teams.set(code, (c.teams.get(code) ?? 0) + o.net);
      byCustomer.set(o.customerId, c);
    }
    const rankedCustomers = [...byCustomer.values()].filter((c) => Math.abs(c.total) >= 0.005).sort((a, b) => b.total - a.total);
    const shownCustomers = topN ? rankedCustomers.slice(0, topN) : rankedCustomers;
    const restCustomers = topN ? rankedCustomers.slice(topN) : [];
    const customerRows = shownCustomers.map((c) => ({ name: c.name, second: [...c.teams.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '', values: c.values.map(cents), total: cents(c.total), pct: share(c.total) }));
    if (restCustomers.length) {
      const values = zero();
      for (const c of restCustomers) c.values.forEach((v, i) => (values[i] += v));
      const sum = restCustomers.reduce((n, c) => n + c.total, 0);
      customerRows.push({ name: `Other customers (${restCustomers.length})`, second: '', values: values.map(cents), total: cents(sum), pct: share(sum) });
    }
    // By product group, by month: each order's net spread over its groups (an
    // order narrowed to one group is already that group's share).
    // One group ticked: every order is already that group's share. Several: split what is left over the ticked ones.
    const oneGroup = f.groups?.length === 1 ? f.groups[0] : null;
    const wanted = f.groups && f.groups.length > 1 ? new Set(f.groups.map((g) => groupKeyOf(g === 'none' ? NO_GROUP : g))) : null;
    const shares = oneGroup ? null : await groupSharesOf(rows.map((o) => o.id));
    const byGroup = new Map<string, { name: string; values: number[]; total: number }>();
    for (const o of rows) {
      let parts = shares ? shares.get(o.id) ?? [{ group: NO_GROUP, share: 1 }] : [{ group: oneGroup === 'none' ? NO_GROUP : oneGroup!, share: 1 }];
      if (wanted) {
        // The order's net is already the ticked groups' together: spread it over them alone.
        const kept = parts.filter((p) => wanted.has(groupKeyOf(p.group)));
        const sum = kept.reduce((n, p) => n + p.share, 0);
        parts = sum > 0 ? kept.map((p) => ({ group: p.group, share: p.share / sum })) : parts;
      }
      for (const part of parts) {
        const g = byGroup.get(groupKeyOf(part.group)) ?? { name: part.group, values: zero(), total: 0 };
        g.values[month(o.orderDate)] += o.net * part.share;
        g.total += o.net * part.share;
        byGroup.set(groupKeyOf(part.group), g);
      }
    }
    const productRows = [...byGroup.values()]
      .filter((g) => Math.abs(g.total) >= 0.005)
      .sort((a, b) => b.total - a.total)
      .map((g) => ({ name: g.name, second: '', values: g.values.map(cents), total: cents(g.total), pct: share(g.total) }));
    const words = await filterWords(f);
    const target = await yearTarget(year);
    const currency = await companyCurrency();
    const pdf = await renderSalesReport({
      title: `${year} Monthly Sale Report`,
      subtitle: `Booked sales orders before VAT, in ${currency} · January to December ${year}${words.length ? ` · ${words.join(' · ')}` : ''}`,
      months: MONTHS,
      people: peopleRows,
      teams: teamRows,
      total: total.map(cents),
      grandTotal: grand,
      facts: {
        left: [
          { label: 'Date of report', value: formatDate(new Date()) },
          { label: 'Data gathered by', value: me.name },
        ],
        // The target is the company's: a narrowed paper says what it shows instead.
        right: narrowed
          ? [{ label: 'Showing', value: words.join(' · ') }]
          : [
              { label: `${year} Target`, value: target ? formatAmount(target) : 'Not set' },
              { label: '% Achievement', value: target ? `${((grand / target) * 100).toFixed(2)}%` : '—' },
            ],
      },
      bars: sales.months.map((m) => ({ label: m.label, current: m.state === 'future' ? 0 : m.current, previous: m.previous, partial: m.state === 'partial' })),
      barSeries: [`${year}`, `${year - 1}`],
      customerTable: customerRows,
      productTable: productRows,
      sankey: flows.sankey.root.value > 0 ? flows.sankey : null,
      customerSankey: flows.customerSankey.root.value > 0 ? topOfFlow(flows.customerSankey, topN) : null,
    });
    await audit({ entityType: 'sales_report', entityId: 'sales-orders', action: 'EXPORTED', summary: `${year} sales report printed (one page)` }, req);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition(paperFileName({ kind: 'Sales Report', number: String(year), author: me.name, date: new Date() })));
    res.send(pdf);
  }),
);

mountReports(salesReportRoutes, { view: 'gops.sales_orders.view_own', auditType: 'sales_report', kinds: { 'sales-orders': salesOrdersReport, 'to-invoice': toInvoiceReport, 'sales-matrix': salesMatrixReport } });
