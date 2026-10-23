import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { authenticate, currentUser } from '../auth/middleware';
import { type Range } from '../shared/insights';
import { statusLabel } from '../shared/pdf';
import { inBase, rateOf, RATE_SELECT } from '../shared/exchangeRates';
import { quotationTotals } from '../shared/quotation';
import { OWNER_TEAM_SELECT, TEAM_REF_SELECT, quotationTeamOf, quotationTeamWhere, salesOrdersReadable } from '../shared/team';
import { badRequest } from '../http/kit';
import { Series, byValue, cents, monthsOf, mountReports, num, pct, table, tally, type Report, type ReportContext } from '../shared/reportKit';
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
  const readable = salesOrdersReadable(me);
  if (readable) and.push(readable);
  const words: string[] = [];
  if (q.ownerId) {
    and.push({ ownerId: q.ownerId });
    const owner = await prisma.user.findUnique({ where: { id: q.ownerId }, select: { name: true } });
    words.push(`booked by ${owner?.name ?? 'someone not on file'}`);
  }
  if (q.teamId === 'none') {
    and.push({ quotation: { teamId: null, owner: { OR: [{ employee: null }, { employee: { industryId: null } }] } } });
    words.push('no team');
  } else if (q.teamId) {
    and.push({ quotation: quotationTeamWhere(q.teamId) });
    const team = await prisma.industry.findUnique({ where: { id: q.teamId }, select: { code: true } });
    words.push(`team ${team?.code ?? 'not found'}`);
  }
  if (q.status) {
    if (!(STATUSES as readonly string[]).includes(q.status)) throw badRequest(`Status is one of ${STATUSES.map(statusLabel).join(', ')}`);
    and.push({ status: q.status as (typeof STATUSES)[number] });
    words.push(`status ${statusLabel(q.status)}`);
  }

  const orders = await prisma.salesOrder.findMany({
    where: { AND: and },
    select: {
      id: true,
      number: true,
      status: true,
      orderDate: true,
      ownerId: true,
      total: true,
      vatAmount: true,
      discountPct: true,
      vatRate: true,
      vatInclusive: true,
      owner: { select: { name: true } },
      customer: { select: { name: true } },
      quotation: { select: { ...RATE_SELECT, team: TEAM_REF_SELECT, owner: OWNER_TEAM_SELECT } },
    },
    orderBy: { orderDate: 'asc' },
  });
  const live = orders.filter((o) => o.status !== 'CANCELLED');
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
  const figures = live.map((o) => {
    const rate = rateOf(o.quotation);
    const t = quotationTotals({ lines: (linesOf.get(o.id) ?? []).filter((l) => !l.isHeading), discountPct: o.discountPct, vatRate: o.vatRate, vatInclusive: o.vatInclusive });
    const seen = canSeeOrderCost(me, o.ownerId) && t.cost.costedLines > 0;
    const team = quotationTeamOf(o.quotation);
    return {
      o,
      team: team ? team.code : 'No team',
      total: cents(inBase(num(o.total), o.quotation)),
      // Before VAT is the order's stored total less its VAT — what invoicing reads (orderNet).
      net: cents((num(o.total) - num(o.vatAmount)) * rate),
      invoiced: cents((invoicedOf.get(o.id) ?? 0) * rate),
      margin: seen ? cents(t.cost.totalMargin * rate) : 0,
      marginBase: seen ? cents(t.netOfTax * rate) : 0,
      seen,
      // Each line's share of the order's net, by its product group.
      groups: (linesOf.get(o.id) ?? [])
        .filter((l) => !l.isHeading)
        .map((l) => ({ group: l.group?.trim() || 'No group', amount: num(l.amount) })),
      netRaw: num(o.total) - num(o.vatAmount),
      subtotalRaw: t.subtotal,
      rate,
    };
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

  const byTeam = tally(figures, (x) => x.team, four);
  const byOwner = tally(figures, (x) => x.o.owner.name, four);
  const byCustomer = tally(figures, (x) => x.o.customer.name, four);

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
  for (const o of orders) {
    const cur = byStatus.get(o.status) ?? [0, 0];
    byStatus.set(o.status, [cur[0] + 1, cur[1] + inBase(num(o.total), o.quotation)]);
  }

  const tables = [
    table('By team', [{ label: 'Team' }, ...shareCols], shareRows(byTeam, 10)),
    table('By salesperson', [{ label: 'Booked by' }, ...shareCols], shareRows(byOwner)),
    table('By customer', [{ label: 'Customer' }, ...shareCols], shareRows(byCustomer)),
    table(
      'By product group (before VAT)',
      [{ label: 'Group' }, { label: 'Before VAT', money: true }, { label: 'Share %', align: 'right' }],
      [...groupNet.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => [k, cents(v), pct(v, net)]),
    ),
    table(
      'By status',
      [{ label: 'Status' }, { label: 'Orders', align: 'right' }, { label: 'Total', money: true }],
      STATUSES.filter((s) => byStatus.has(s)).map((s) => [statusLabel(s), byStatus.get(s)![0], cents(byStatus.get(s)![1])]),
    ),
    table(
      'Largest orders',
      [{ label: 'Number' }, { label: 'Customer' }, { label: 'Booked by' }, { label: 'Status' }, { label: 'Booked', money: true }, { label: 'Invoiced', money: true }],
      [...figures].sort((a, b) => b.total - a.total).slice(0, 15).map((x) => [x.o.number, x.o.customer.name, x.o.owner.name, statusLabel(x.o.status), x.total, x.invoiced]),
    ),
  ];

  const cancelled = orders.length - live.length;
  const notes: string[] = [];
  if (cancelled) notes.push(`${cancelled} cancelled order${cancelled === 1 ? '' : 's'} in the period book${cancelled === 1 ? 's' : ''} nothing and ${cancelled === 1 ? 'is' : 'are'} counted under By status only.`);
  if (figures.some((x) => x.o.quotation.currency !== 'PHP')) notes.push('Orders in a foreign currency are converted to pesos at their quotation’s own rate.');
  if (live.length && seenCount < live.length) notes.push(`The margin is read off the ${seenCount} of ${live.length} orders whose cost you may see.`);

  return {
    kind: 'sales-orders',
    title: 'Sales Order Report',
    from: range.from.toISOString().slice(0, 10),
    to: range.to.toISOString().slice(0, 10),
    ...(words.length ? { filterLine: words.join(' · ') } : {}),
    cards: [
      { label: 'Sales orders', value: live.length, ...(cancelled ? { sub: `${cancelled} cancelled, not counted` } : {}) },
      { label: 'Booked (with VAT)', value: booked, money: true },
      { label: 'Before VAT', value: net, money: true },
      { label: 'Invoiced', value: billed, money: true, sub: `${pct(billed, net)}% of before VAT` },
      { label: 'Left to invoice', value: cents(Math.max(0, net - billed)), money: true },
      ...(seenCount ? [{ label: 'Margin', value: margin, money: true, sub: `${pct(margin, marginBase)}% on ${seenCount} order${seenCount === 1 ? '' : 's'}` }] : []),
    ],
    series: series.done(),
    tables,
    ...(notes.length ? { notes } : {}),
  };
}

// View Own is implied by View Team and View All (withImpliedLevels), so one key opens it for every reader of the list.
mountReports(salesReportRoutes, { view: 'gops.sales_orders.view_own', auditType: 'sales_report', kinds: { 'sales-orders': salesOrdersReport } });
