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
