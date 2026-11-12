import { prisma } from '../prisma';
import type { ResolvedUser } from '../permissions/resolve';
import { manilaDate, manilaDayEnd, manilaDayStart } from './day';
import { parseRange } from './insights';
import { live, orderMonth, salesOrderRows, type OrderRow } from './salesFigures';
import { linkTo } from './reportKit';

/**
 * The G-OPS overview, decided once.
 *
 * `GET /gops/overview` (the G-OPS dashboard) and the Insights brief both print
 * these counts. The brief used to be where a second copy of the where-clauses
 * would have gone, and a hand-copied where-clause is exactly how two screens
 * come to disagree — so the handler body moved here, unchanged, and both call
 * it. Change a figure HERE, never in one of its readers.
 *
 * READ ONLY, and it adds no table. Every figure is a count of documents the
 * other phases already record. It is COUNTS, not money: value lives in
 * Insights, which reconciles it against those documents (model §11).
 *
 * **Every block is gated on its own permission**, not on the dashboard's.
 * Holding `gops.dashboard.view_all` is permission to see the overview, not
 * permission to learn how many quotations are out — a count is a small leak
 * wearing a number, and the client cannot be the one to decide that.
 */

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The from/to range, as a Prisma filter on one date column.
 *
 * Two kinds of figure live on this dashboard and only one of them takes a
 * range. Period ACTIVITY — quotations raised, PM visits accomplished — is a
 * question about a window, and dated by the column that records when the
 * thing happened: `createdAt` for a document that was raised, `performedAt`
 * for work that was carried out. A LIVE QUEUE — projects in progress,
 * contracts running — is a question about right now, and filtering it by
 * date wouldn't narrow the dashboard, it would hide what is open. Those
 * stay unfiltered whatever range is showing.
 *
 * The days are Manila's. A document raised is an instant, so its range runs
 * from Manila midnight of `from` to the last instant of `to` in Manila. `from`
 * used to be UTC midnight — 08:00 here — and a range left out whatever was
 * raised before 08:00 on its first day: "this month" on the 1st, "this year"
 * on 1 January. Work performed is a DATE, which Prisma binds as its UTC date,
 * so there UTC midnight IS the day, and Manila midnight would read as the day
 * before. The end of a Manila day is still that day to a DATE, so `to` serves
 * both. verify-aftermarket pins the PM count through `/gops/overview`.
 */
export function periodWhere(
  req: { query: { from?: unknown; to?: unknown } },
  column: 'createdAt' | 'performedAt' = 'createdAt',
) {
  const from = typeof req.query.from === 'string' ? req.query.from : undefined;
  const to = typeof req.query.to === 'string' ? req.query.to : undefined;
  if (!from && !to) return {};
  const start = (key: string) =>
    column === 'createdAt' && DAY_KEY.test(key) ? manilaDayStart(key) : new Date(key);
  return {
    [column]: {
      ...(from ? { gte: start(from) } : {}),
      // A bare date is midnight, which would cut off "to" before its own day
      // has started — push it to the end of that day instead.
      ...(to ? { lte: DAY_KEY.test(to) ? manilaDayEnd(to) : new Date(to) } : {}),
    },
  };
}

/** `{ DRAFT: 3, FINAL: 1 }` from a Prisma groupBy, zero-filled by the caller. */
export type Tally = Record<string, number>;

function tally(rows: { status?: string | null; _count: { _all: number } }[]): Tally {
  const out: Tally = {};
  for (const r of rows) if (r.status) out[r.status] = r._count._all;
  return out;
}

/** Reading a screen means holding either view scope over it. */
function canSee(user: ResolvedUser, submodule: string): boolean {
  return (
    user.isSuperAdmin ||
    user.permissions.has(`gops.${submodule}.view_all`) ||
    user.permissions.has(`gops.${submodule}.view_own`)
  );
}

export interface GopsOverview {
  sales: { leads: Tally | null; quotations: Tally | null; costings: Tally | null } | null;
  delivery: { jobs: Tally | null; reportsAwaitingApproval: number | null } | null;
  aftermarket: {
    contracts: Tally | null;
    activeContracts: number | null;
    pmAccomplished: number | null;
  } | null;
  /**
   * Whether an owner-scoped block counted the caller's own records only.
   * NOT part of the `/gops/overview` response — the route strips it, so that
   * response stays byte-identical. The Insights brief reads it to say "yours"
   * on a line that would otherwise pass one person's count off as the
   * company's.
   */
  _scope: { leads: 'all' | 'mine'; quotations: 'all' | 'mine'; costings: 'all' | 'mine' };
}

/**
 * The G-OPS dashboard's figures. `query` is the request's own query object —
 * pass the same `from`/`to` strings the G-OPS page sends, so the same
 * `periodWhere` decides the window.
 */
export async function gopsOverview(
  me: ResolvedUser,
  query: { from?: unknown; to?: unknown },
): Promise<GopsOverview> {
  const req = { query };
  const period = periodWhere(req);
  const performed = periodWhere(req, 'performedAt');

  const sees = {
    leads: canSee(me, 'leads'),
    quotations: canSee(me, 'quotations'),
    costing: canSee(me, 'costing'),
    projects: canSee(me, 'projects'),
    progress: canSee(me, 'progress_billing'),
    contracts: canSee(me, 'service_contracts'),
    visits: canSee(me, 'visits'),
  };

  // Someone who can only see their own records must not be counting the
  // whole company's. Where a screen is owner-scoped, so is its tile.
  const mineOnly = (submodule: string) =>
    !me.isSuperAdmin && !me.permissions.has(`gops.${submodule}.view_all`);

  const [leads, quotations, costings, jobs, reportsPending, contracts, activeContracts, pmAccomplished] =
    await Promise.all([
      sees.leads
        ? prisma.lead.groupBy({
            by: ['status'],
            _count: { _all: true },
            where: { ...period, ...(mineOnly('leads') ? { assignedToId: me.id } : {}) },
          })
        : null,
      sees.quotations
        ? prisma.quotation.groupBy({
            by: ['outcome'],
            _count: { _all: true },
            where: { ...period, ...(mineOnly('quotations') ? { ownerId: me.id } : {}) },
          })
        : null,
      sees.costing
        ? prisma.costing.groupBy({
            by: ['status'],
            _count: { _all: true },
            where: { ...period, ...(mineOnly('costing') ? { ownerId: me.id } : {}) },
          })
        : null,
      sees.projects
        ? prisma.job.groupBy({
            by: ['status'],
            _count: { _all: true },
            where: { type: 'PROJECT' },
          })
        : null,
      sees.progress ? prisma.progressReport.count({ where: { status: 'PENDING_APPROVAL' } }) : null,
      sees.contracts ? prisma.serviceContract.groupBy({ by: ['status'], _count: { _all: true } }) : null,
      // Cover the business is carrying right now — a live figure, so no range.
      sees.contracts ? prisma.serviceContract.count({ where: { status: 'ACTIVE' } }) : null,
      // PM actually carried out, dated by the day the engineer did the work
      // rather than the day the visit row was created — a visit scheduled in
      // January and performed in March belongs to March.
      sees.visits
        ? prisma.serviceVisit.count({
            where: { kind: 'PREVENTIVE_MAINTENANCE', status: 'COMPLETED', ...performed },
          })
        : null,
    ]);

  return {
    // The client renders a section only when its block is present, so a
    // permission it does not hold is an absent key rather than a zero.
    sales:
      sees.leads || sees.quotations || sees.costing
        ? {
            leads: leads ? tally(leads) : null,
            quotations: quotations
              ? tally(quotations.map((q) => ({ status: q.outcome, _count: q._count })))
              : null,
            costings: costings ? tally(costings) : null,
          }
        : null,
    delivery:
      sees.projects || sees.progress
        ? {
            jobs: jobs ? tally(jobs) : null,
            reportsAwaitingApproval: reportsPending,
          }
        : null,
    aftermarket:
      sees.contracts || sees.visits
        ? {
            contracts: contracts ? tally(contracts) : null,
            activeContracts,
            pmAccomplished,
          }
        : null,
    _scope: {
      leads: mineOnly('leads') ? 'mine' : 'all',
      quotations: mineOnly('quotations') ? 'mine' : 'all',
      costings: mineOnly('costing') ? 'mine' : 'all',
    },
  };
}

// ── Sales performance (2026-11-08) ───────────────────────────────────────────

/**
 * The owner's G-OPS dashboard of 2026-11-08 (`G-OPS_Dashboard_1.pdf`): the
 * revenue side the counts above never carried. Every figure is BOOKED SALES
 * ORDERS BEFORE VAT, in pesos, read through `shared/salesFigures.ts` — the
 * Sales Order report's own rows, so the dashboard and the report agree to the
 * centavo (verify-pipeline asserts it). The caller's visibility is the sales
 * order list's: a View Own holder sees their own orders and nobody else's.
 *
 *   months       the twelve months of the range's year against the same
 *                months of the year before (the PDF's "Monthly Sales
 *                Performance Comparison"); a month still running is `partial`
 *                (the `Nov*` of the PDF), one yet to start `future`
 *   customers    the top ten customers of the range, by revenue
 *   people       who booked, with their own team, the CURRENT MONTH (the
 *                month the range ends in, clipped to the range) and the range
 *   sankey       Gruntech → team → person: every person ONCE whatever roles
 *                they hold (keyed by login, never by role), each node its
 *                revenue and its share of Gruntech's. The team is the
 *                quotation's (the list's rule), so a person whose orders were
 *                tagged with two teams gets two incoming flows and one node;
 *                the three columns add up to the same total by construction.
 */
export interface GopsSales {
  from: string;
  to: string;
  year: number;
  previousYear: number;
  /** PHP, before VAT, over the range. */
  total: number;
  orders: number;
  months: { key: string; label: string; current: number; previous: number; currentOrders: number; state: 'done' | 'partial' | 'future' }[];
  customers: { id: string; name: string; orders: number; revenue: number; to: string }[];
  people: { id: string; name: string; team: string | null; month: number; range: number; orders: number; to: string }[];
  currentMonth: { key: string; label: string; from: string; to: string };
  sankey: {
    root: { label: string; value: number };
    teams: { id: string; label: string; name: string; value: number; pct: number; to: string }[];
    people: { id: string; label: string; value: number; pct: number; to: string }[];
    links: { team: string; person: string; value: number }[];
  };
  /**
   * Gruntech → team → CUSTOMER (2026-11-12, the owner's call: "add another
   * sankey by Gruntech > Team > Customer"): the same shape and the same rows
   * as `sankey`, `people` holding a node per team × customer (`of` the
   * customer): a customer two teams sold to stands under each, so no band
   * crosses from one team to another's customer.
   */
  customerSankey: Omit<GopsSales['sankey'], 'people'> & { people: { id: string; of: string; label: string; value: number; pct: number; to: string }[] };
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const cents = (n: number) => Math.round(n * 100) / 100;
const share = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

export function canSeeSales(me: ResolvedUser): boolean {
  return canSee(me, 'sales_orders');
}

export async function gopsSales(me: ResolvedUser, query: { from?: unknown; to?: unknown }, only?: (o: OrderRow) => boolean): Promise<GopsSales> {
  const range = parseRange(typeof query.from === 'string' ? query.from : undefined, typeof query.to === 'string' ? query.to : undefined);
  const year = range.to.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year - 1, 0, 1));
  const yearEnd = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));
  // One read covers the chart's two years; the range's own rows are the
  // subset dated inside it (the range never reaches past its own year's end).
  const wide = range.from < yearStart ? range.from : yearStart;
  // `only` narrows every figure to the orders it admits (the report's
  // salesperson, team and status filters, for its pictures).
  const all = live(await salesOrderRows(me, wide, yearEnd));
  const rows = only ? all.filter(only) : all;
  const inRange = rows.filter((o) => o.orderDate >= range.from && o.orderDate <= range.to);

  const today = dayOf(manilaDate(new Date()));
  const thisMonth = today.slice(0, 7);
  const byMonth = new Map<string, { net: number; n: number }>();
  for (const o of rows) {
    const k = orderMonth(o.orderDate);
    const cur = byMonth.get(k) ?? { net: 0, n: 0 };
    byMonth.set(k, { net: cur.net + o.net, n: cur.n + 1 });
  }
  const months = MONTH_LABELS.map((label, i) => {
    const key = `${year}-${String(i + 1).padStart(2, '0')}`;
    const prev = `${year - 1}-${String(i + 1).padStart(2, '0')}`;
    const state: 'done' | 'partial' | 'future' = key > thisMonth ? 'future' : key === thisMonth ? 'partial' : 'done';
    return { key, label, current: cents(byMonth.get(key)?.net ?? 0), previous: cents(byMonth.get(prev)?.net ?? 0), currentOrders: byMonth.get(key)?.n ?? 0, state };
  });

  const total = cents(inRange.reduce((s, o) => s + o.net, 0));
  const from = dayOf(range.from);
  const to = dayOf(range.to);
  const listLink = (extra: Record<string, string | null | undefined>) => linkTo('/g-ops/sales-orders', { dateFrom: from, dateTo: to, scope: 'all', booked: 'yes', ...extra });

  // Top customers.
  const byCustomer = new Map<string, { name: string; orders: number; revenue: number }>();
  for (const o of inRange) {
    const cur = byCustomer.get(o.customerId) ?? { name: o.customerName, orders: 0, revenue: 0 };
    byCustomer.set(o.customerId, { name: cur.name, orders: cur.orders + 1, revenue: cur.revenue + o.net });
  }
  const customers = [...byCustomer.entries()]
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .slice(0, 10)
    .map(([id, c]) => ({ id, name: c.name, orders: c.orders, revenue: cents(c.revenue), to: listLink({ customerId: id }) }));

  // The current month: the month the range ends in, clipped to the range.
  const monthKey = to.slice(0, 7);
  const monthFrom = `${monthKey}-01` < from ? from : `${monthKey}-01`;
  const currentMonth = { key: monthKey, label: `${MONTH_LABELS[Number(monthKey.slice(5, 7)) - 1]} ${monthKey.slice(0, 4)}`, from: monthFrom, to };

  // People: everyone who booked in the range, once.
  const byPerson = new Map<string, { name: string; team: string | null; month: number; range: number; orders: number }>();
  for (const o of inRange) {
    const cur = byPerson.get(o.ownerId) ?? { name: o.ownerName, team: o.ownerTeam?.code ?? null, month: 0, range: 0, orders: 0 };
    const inMonth = dayOf(o.orderDate) >= monthFrom;
    byPerson.set(o.ownerId, { ...cur, month: cur.month + (inMonth ? o.net : 0), range: cur.range + o.net, orders: cur.orders + 1 });
  }
  const people = [...byPerson.entries()]
    .sort((a, b) => b[1].range - a[1].range)
    .map(([id, p]) => ({ id, name: p.name, team: p.team, month: cents(p.month), range: cents(p.range), orders: p.orders, to: listLink({ ownerId: id }) }));

  // The Sankey: Gruntech → the quotation's team → the person who booked.
  const teams = new Map<string, { label: string; name: string; value: number }>();
  const links = new Map<string, number>();
  for (const o of inRange) {
    const teamId = o.team ? o.team.id : 'none';
    const t = teams.get(teamId) ?? { label: o.team ? o.team.code : 'No team', name: o.team ? o.team.name : 'No team', value: 0 };
    teams.set(teamId, { ...t, value: t.value + o.net });
    const lk = `${teamId}\u0000${o.ownerId}`;
    links.set(lk, (links.get(lk) ?? 0) + o.net);
  }
  const sankey: GopsSales['sankey'] = {
    root: { label: 'Gruntech', value: total },
    teams: [...teams.entries()]
      .sort((a, b) => b[1].value - a[1].value)
      .map(([id, t]) => ({ id, label: t.label, name: t.name, value: cents(t.value), pct: share(t.value, total), to: listLink({ teamId: id }) })),
    people: people.map((p) => ({ id: p.id, label: p.name, value: p.range, pct: share(p.range, total), to: p.to })),
    links: [...links.entries()].map(([k, v]) => {
      const [team, person] = k.split('\u0000');
      return { team, person, value: cents(v) };
    }),
  };

  // The same flow by customer. A customer stands under the TEAM OF THE
  // SALESPERSON who booked each order (the order's own team), so one that two
  // teams sold to is a node under each — no band ever crosses to another team
  // (2026-11-12, the owner's call: "some crosses; it should be determined by
  // the salesperson who handles the account or created the sales order").
  // `of` is the customer, for ranking the top n.
  const byTeamCustomer = new Map<string, { team: string; customerId: string; name: string; value: number }>();
  for (const o of inRange) {
    const team = o.team ? o.team.id : 'none';
    const k = `${team}:${o.customerId}`;
    const cur = byTeamCustomer.get(k) ?? { team, customerId: o.customerId, name: o.customerName, value: 0 };
    byTeamCustomer.set(k, { ...cur, value: cur.value + o.net });
  }
  const custNodes = [...byTeamCustomer.entries()].sort((a, b) => b[1].value - a[1].value);
  const customerSankey: GopsSales['customerSankey'] = {
    root: sankey.root,
    teams: sankey.teams,
    people: custNodes.map(([id, c]) => ({ id, of: c.customerId, label: c.name, value: cents(c.value), pct: share(c.value, total), to: listLink({ customerId: c.customerId, teamId: c.team }) })),
    links: custNodes.map(([id, c]) => ({ team: c.team, person: id, value: cents(c.value) })),
  };

  return { from, to, year, previousYear: year - 1, total, orders: inRange.length, months, customers, people, currentMonth, sankey, customerSankey };
}

/**
 * Page 2 of the owner's PDF — the year's months across, the teams down with
 * each person under their team, or the key customers (`by=customer`). Built
 * as a report so the shared engine gives it its CSV and PDF twins: the
 * series is Gruntech's month by month, the one table the matrix. `teamId`
 * narrows to one team (or `none`). Figures are the same rows as above.
 */
export async function salesMatrix(
  me: ResolvedUser,
  from: Date,
  to: Date,
  opts: { by: 'team' | 'customer'; teamId?: string },
): Promise<{ months: { key: string; label: string }[]; groups: { id: string; label: string; values: number[]; total: number; children: { id: string; label: string; values: number[]; total: number }[] }[]; total: number[]; filterLine: string }> {
  const rows = live(await salesOrderRows(me, from, to)).filter((o) => {
    if (!opts.teamId) return true;
    if (opts.teamId === 'none') return !o.team;
    return o.team?.id === opts.teamId;
  });
  const months: { key: string; label: string }[] = [];
  for (let d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1)); d <= to && months.length < 24; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    months.push({ key: dayOf(d).slice(0, 7), label: MONTH_LABELS[d.getUTCMonth()] + (from.getUTCFullYear() !== to.getUTCFullYear() ? ` ${d.getUTCFullYear()}` : '') });
  }
  const col = new Map(months.map((m, i) => [m.key, i]));
  const zero = () => months.map(() => 0);
  type Line = { id: string; label: string; values: number[]; total: number; children: Map<string, { id: string; label: string; values: number[]; total: number }> };
  const groups = new Map<string, Line>();
  const put = (line: { values: number[]; total: number }, o: OrderRow) => {
    const i = col.get(orderMonth(o.orderDate));
    if (i === undefined) return;
    line.values[i] += o.net;
    line.total += o.net;
  };
  for (const o of rows) {
    const gid = opts.by === 'team' ? (o.team ? o.team.id : 'none') : o.customerId;
    const glabel = opts.by === 'team' ? (o.team ? `Team ${o.team.code} (${o.team.name})` : 'No team') : o.customerName;
    const g = groups.get(gid) ?? { id: gid, label: glabel, values: zero(), total: 0, children: new Map() };
    put(g, o);
    if (opts.by === 'team') {
      const c = g.children.get(o.ownerId) ?? { id: o.ownerId, label: o.ownerName, values: zero(), total: 0 };
      put(c, o);
      g.children.set(o.ownerId, c);
    }
    groups.set(gid, g);
  }
  const total = zero();
  for (const o of rows) {
    const i = col.get(orderMonth(o.orderDate));
    if (i !== undefined) total[i] += o.net;
  }
  const sorted = [...groups.values()].sort((a, b) => b.total - a.total).slice(0, opts.by === 'customer' ? 15 : 100);
  const words = [opts.by === 'team' ? 'by sales team and personnel' : 'key customers'];
  if (opts.teamId === 'none') words.push('no team');
  else if (opts.teamId) {
    const t = await prisma.industry.findUnique({ where: { id: opts.teamId }, select: { code: true } });
    words.push(`team ${t?.code ?? 'not found'}`);
  }
  return {
    months,
    groups: sorted.map((g) => ({
      id: g.id,
      label: g.label,
      values: g.values.map(cents),
      total: cents(g.total),
      children: [...g.children.values()].sort((a, b) => b.total - a.total).map((c) => ({ ...c, values: c.values.map(cents), total: cents(c.total) })),
    })),
    total: total.map(cents),
    filterLine: words.join(' · '),
  };
}
