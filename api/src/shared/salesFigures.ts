import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import type { ResolvedUser } from '../permissions/resolve';
import { inBase, rateOf, RATE_SELECT } from './exchangeRates';
import { OWNER_TEAM_SELECT, TEAM_REF_SELECT, orderTeamOf, salesOrdersReadable, type TeamRef } from './team';

/**
 * What a sales order is WORTH, decided once (2026-11-08).
 *
 * The Sales Order report (routes/salesReports.ts) and the G-OPS dashboard's
 * sales performance section (shared/gops.ts) both read booked revenue off
 * the sales orders, and two readers each doing the arithmetic is how a
 * dashboard comes to disagree with its report. So the rows and their money
 * come from here: orders DATED in the window, under the caller's own
 * visibility rule (`salesOrdersReadable` — a View Own holder reads only
 * their own), every figure in PESOS at the quotation's own rate.
 *
 *   total  the order's stored total, with VAT
 *   net    the total less its VAT — BEFORE VAT, what invoicing reads and
 *          what the owner chose as the dashboard's revenue figure
 *
 * A CANCELLED order books nothing: `live()` leaves it out, and a reader
 * that wants it (the report's By status) reads `orders` whole. The team is
 * the QUOTATION's team (the list's rule, `quotationTeamOf`): the tag at
 * import, else the owner's own team at the time. `ownerTeam` is the
 * person's own team today, for a table that lists people.
 */

export interface OrderRow {
  id: string;
  number: string;
  status: string;
  orderDate: Date;
  ownerId: string;
  ownerName: string;
  customerId: string;
  customerName: string;
  /** The quotation's team — the list's rule. */
  team: TeamRef;
  /** The owner's own team today. */
  ownerTeam: TeamRef;
  /** Pesos per unit of the quotation's currency; 1 for PHP. */
  rate: number;
  currency: string;
  /** With VAT, in pesos, to the centavo. */
  total: number;
  /** Before VAT, in pesos, to the centavo. */
  net: number;
  /** The stored figures, for a reader that needs them unconverted. */
  raw: { total: number; vatAmount: number; discountPct: Prisma.Decimal | number; vatRate: Prisma.Decimal | number; vatInclusive: boolean };
}

const num = (v: Prisma.Decimal | number | null | undefined) => (v == null ? 0 : Number(v));
const cents = (n: number) => Math.round(n * 100) / 100;

/** Every sales order dated in [from, to] the caller may read, with its money in pesos. */
export async function salesOrderRows(me: ResolvedUser, from: Date, to: Date, extra: Prisma.SalesOrderWhereInput[] = []): Promise<OrderRow[]> {
  const and: Prisma.SalesOrderWhereInput[] = [{ orderDate: { gte: from, lte: to } }, ...extra];
  const readable = salesOrdersReadable(me);
  if (readable) and.push(readable);
  const orders = await prisma.salesOrder.findMany({
    where: { AND: and },
    select: {
      id: true,
      number: true,
      status: true,
      orderDate: true,
      ownerId: true,
      customerId: true,
      total: true,
      vatAmount: true,
      discountPct: true,
      vatRate: true,
      vatInclusive: true,
      owner: { select: { name: true, ...OWNER_TEAM_SELECT.select } },
      customer: { select: { name: true } },
      team: TEAM_REF_SELECT,
      quotation: { select: { ...RATE_SELECT, team: TEAM_REF_SELECT, owner: OWNER_TEAM_SELECT } },
    },
    orderBy: { orderDate: 'asc' },
  });
  return orders.map((o) => {
    const rate = rateOf(o.quotation);
    return {
      id: o.id,
      number: o.number,
      status: o.status,
      orderDate: o.orderDate,
      ownerId: o.ownerId,
      ownerName: o.owner.name,
      customerId: o.customerId,
      customerName: o.customer.name,
      team: orderTeamOf(o),
      ownerTeam: o.owner.employee?.industry ?? null,
      rate,
      currency: o.quotation.currency ?? 'PHP',
      total: cents(inBase(num(o.total), o.quotation)),
      net: cents((num(o.total) - num(o.vatAmount)) * rate),
      raw: { total: num(o.total), vatAmount: num(o.vatAmount), discountPct: o.discountPct, vatRate: o.vatRate, vatInclusive: o.vatInclusive },
    };
  });
}

/** The orders that book something: everything but a cancelled one. */
export const live = (rows: OrderRow[]) => rows.filter((o) => o.status !== 'CANCELLED');

/** 'YYYY-MM' of a DATE column's value — the day as stored, never the host's zone. */
export const orderMonth = (d: Date) => d.toISOString().slice(0, 7);

/**
 * The Sales Order report's narrowing (2026-11-12, the owner's batch: "the
 * filter can be by personnel, by team, by customer and by product group"),
 * decided once for the report's pictures, its paper and the dashboard's
 * figures behind them.
 *
 * A PRODUCT GROUP narrows an order to that group's SHARE of it: each order
 * keeps the fraction of its net (and total) that its priced lines under the
 * group make of its subtotal, and an order with none of the group drops out.
 * An order with no priced lines stands whole under "No group".
 */
export interface RowFilter {
  /**
   * Several of each since 2026-11-13 (the owner's call: "combine filter —
   * My San Calamba and My San Cainta in one report; Ivan and Erica in one
   * report"): an order passes a box when it matches ANY value ticked in it,
   * and every box that has a tick must pass.
   */
  ownerIds?: string[];
  /** Team ids; `none` is an order with no team. */
  teamIds?: string[];
  customerIds?: string[];
  status?: string;
  /** Product group names (case- and space-blind); `none` is "No group". */
  groups?: string[];
}

/** `a,b` → ['a', 'b'], trimmed, each once; nothing → undefined. */
export function listParam(v: unknown, separator = ','): string[] | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const out = [...new Set(v.split(separator).map((x) => x.trim()).filter(Boolean))];
  return out.length ? out : undefined;
}
/** Product group names may hold a comma, so their list is split on `|`. */
export const GROUP_SEPARATOR = '|';

export const NO_GROUP = 'No group';
export const groupKeyOf = (name: string | null | undefined) => (name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const wantedGroup = (group: string) => (group === 'none' ? groupKeyOf(NO_GROUP) : groupKeyOf(group));

export const isNarrowed = (f: RowFilter) => !!(f.ownerIds?.length || f.teamIds?.length || f.customerIds?.length || f.status || f.groups?.length);

/** Each order's product groups as fractions of its subtotal (adding up to 1), named as its lines spell them. */
export async function groupSharesOf(orderIds: string[]): Promise<Map<string, { group: string; share: number }[]>> {
  const out = new Map<string, { group: string; share: number }[]>();
  if (!orderIds.length) return out;
  const lines = await prisma.salesOrderLine.findMany({ where: { orderId: { in: orderIds }, isHeading: false }, select: { orderId: true, group: true, amount: true } });
  const perOrder = new Map<string, Map<string, { group: string; amount: number }>>();
  for (const l of lines) {
    const name = l.group?.trim() || NO_GROUP;
    const m = perOrder.get(l.orderId) ?? new Map<string, { group: string; amount: number }>();
    const cur = m.get(groupKeyOf(name)) ?? { group: name, amount: 0 };
    m.set(groupKeyOf(name), { group: cur.group, amount: cur.amount + num(l.amount) });
    perOrder.set(l.orderId, m);
  }
  for (const id of orderIds) {
    const m = perOrder.get(id);
    const sum = m ? [...m.values()].reduce((s, g) => s + g.amount, 0) : 0;
    out.set(id, m && sum > 0 ? [...m.values()].map((g) => ({ group: g.group, share: g.amount / sum })) : [{ group: NO_GROUP, share: 1 }]);
  }
  return out;
}

/** The rows a filter admits; product groups leave each order its share of the ticked groups together. */
export async function narrowRows(rows: OrderRow[], f: RowFilter): Promise<OrderRow[]> {
  const owners = f.ownerIds?.length ? new Set(f.ownerIds) : null;
  const teams = f.teamIds?.length ? new Set(f.teamIds) : null;
  const customers = f.customerIds?.length ? new Set(f.customerIds) : null;
  let out = rows.filter(
    (o) =>
      (!owners || owners.has(o.ownerId)) &&
      (!teams || teams.has(o.team ? o.team.id : 'none')) &&
      (!customers || customers.has(o.customerId)) &&
      (!f.status || o.status === f.status),
  );
  if (f.groups?.length) {
    const want = new Set(f.groups.map(wantedGroup));
    const shares = await groupSharesOf(out.map((o) => o.id));
    out = out.flatMap((o) => {
      const share = (shares.get(o.id) ?? []).filter((g) => want.has(groupKeyOf(g.group))).reduce((s, g) => s + g.share, 0);
      return share > 0 ? [{ ...o, total: cents(o.total * share), net: cents(o.net * share) }] : [];
    });
  }
  return out;
}
