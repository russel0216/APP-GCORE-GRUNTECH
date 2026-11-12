import { topOfFlow } from '../shared/sankey';
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
import { NO_GROUP, groupKeyOf, groupSharesOf, isNarrowed, live as liveRows, narrowRows, salesOrderRows, type RowFilter } from '../shared/salesFigures';
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
  const words: string[] = [];
  if (q.ownerId) {
    and.push({ ownerId: q.ownerId });
    const owner = await prisma.user.findUnique({ where: { id: q.ownerId }, select: { name: true } });
    words.push(`booked by ${owner?.name ?? 'someone not on file'}`);
  }
  if (q.teamId === 'none') {
    and.push({ teamId: null, quotation: { teamId: null, owner: { OR: [{ employee: null }, { employee: { industryId: null } }] } } });
    words.push('no team');
  } else if (q.teamId) {
    and.push(orderTeamWhere(q.teamId));
    const team = await prisma.industry.findUnique({ where: { id: q.teamId }, select: { code: true } });
    words.push(`team ${team?.code ?? 'not found'}`);
  }
  if (q.status) {
    if (!(STATUSES as readonly string[]).includes(q.status)) throw badRequest(`Status is one of ${STATUSES.map(statusLabel).join(', ')}`);
    and.push({ status: q.status as (typeof STATUSES)[number] });
    words.push(`status ${statusLabel(q.status)}`);
  }
  if (q.customerId) {
    and.push({ customerId: q.customerId });
    const customer = await prisma.customer.findUnique({ where: { id: q.customerId }, select: { name: true } });
    words.push(`customer ${customer?.name ?? 'not on file'}`);
  }
  // A product group narrows each order to that group's SHARE of it (below).
  const wantGroup = q.group ? groupKeyOf(q.group === 'none' ? NO_GROUP : q.group) : null;
  if (q.group) words.push(`product group ${q.group === 'none' ? NO_GROUP : q.group} (each order's share of it)`);

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
    liveIds.length
      ? prisma.invoice.groupBy({ by: ['salesOrderId'], where: { salesOrderId: { in: liveIds }, status: { not: 'CANCELLED' } }, _sum: { grossAmount: true } })
      : [],
  ]);
  const linesOf = new Map<string, typeof lines>();
  for (const l of lines) linesOf.set(l.orderId, [...(linesOf.get(l.orderId) ?? []), l]);
  const invoicedOf = new Map(invoiced.map((i) => [i.salesOrderId, num(i._sum.grossAmount)]));

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
  const figures = !wantGroup
    ? wholeFigures
    : wholeFigures.flatMap((x) => {
        const mine = x.groups.filter((g) => groupKeyOf(g.group) === wantGroup);
        const share = x.subtotalRaw > 0 ? mine.reduce((n, g) => n + g.amount, 0) / x.subtotalRaw : wantGroup === groupKeyOf(NO_GROUP) ? 1 : 0;
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
      ownerId: q.ownerId || null,
      teamId: q.teamId || null,
      customerId: q.customerId || null,
      ...(q.status ? { status: q.status } : { booked: 'yes' }),
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
  for (const o of wantGroup ? figures.map((x) => ({ status: x.o.status, total: x.total })) : orders) {
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

  const cancelled = wantGroup ? 0 : orders.length - live.length;
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

/** The report's filters off a query, checked: the pictures and the paper read them alike. */
function rowFilterOf(query: Record<string, unknown>): RowFilter {
  const one = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const status = one(query.status);
  if (status && !(STATUSES as readonly string[]).includes(status)) throw badRequest(`Status is one of ${STATUSES.map(statusLabel).join(', ')}`);
  return { ownerId: one(query.ownerId), teamId: one(query.teamId), customerId: one(query.customerId), status, group: one(query.group) };
}

/** What a filter narrowed to, in words. */
async function filterWords(f: RowFilter): Promise<string[]> {
  const words: string[] = [];
  if (f.ownerId) words.push((await prisma.user.findUnique({ where: { id: f.ownerId }, select: { name: true } }))?.name ?? 'one salesperson');
  if (f.teamId) words.push(f.teamId === 'none' ? 'no team' : `team ${(await prisma.industry.findUnique({ where: { id: f.teamId }, select: { code: true } }))?.code ?? ''}`.trim());
  if (f.customerId) words.push((await prisma.customer.findUnique({ where: { id: f.customerId }, select: { name: true } }))?.name ?? 'one customer');
  if (f.group) words.push(`product group ${f.group === 'none' ? NO_GROUP : f.group}`);
  if (f.status) words.push(statusLabel(f.status));
  return words;
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
    const sales = await gopsSales(me, range, narrowed ? (rows) => narrowRows(rows, f) : undefined);
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

    const sales = await gopsSales(me, { from: `${year}-01-01`, to: q.to ?? `${year}-12-31` }, narrowed ? (all) => narrowRows(all, f) : undefined);
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
    const shares = f.group ? null : await groupSharesOf(rows.map((o) => o.id));
    const byGroup = new Map<string, { name: string; values: number[]; total: number }>();
    for (const o of rows) {
      const parts = shares ? shares.get(o.id) ?? [{ group: NO_GROUP, share: 1 }] : [{ group: f.group === 'none' ? NO_GROUP : f.group!, share: 1 }];
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
      sankey: sales.sankey.root.value > 0 ? sales.sankey : null,
      customerSankey: sales.customerSankey.root.value > 0 ? topOfFlow(sales.customerSankey, topN) : null,
    });
    await audit({ entityType: 'sales_report', entityId: 'sales-orders', action: 'EXPORTED', summary: `${year} sales report printed (one page)` }, req);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition(paperFileName({ kind: 'Sales Report', number: String(year), author: me.name, date: new Date() })));
    res.send(pdf);
  }),
);

mountReports(salesReportRoutes, { view: 'gops.sales_orders.view_own', auditType: 'sales_report', kinds: { 'sales-orders': salesOrdersReport, 'sales-matrix': salesMatrixReport } });
