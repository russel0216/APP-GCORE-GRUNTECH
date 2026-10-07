import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { quotationTotals } from './quotation';
import { valueRevision } from './pipeline';

/**
 * Progress booking — SCORO's "100% of available" (2026-10-07, the owner's
 * Create invoice screenshot). A quotation line is booked by the sales order
 * lines that point at it (`SalesOrderLine.quotationItemId`), or by a
 * summarised line's `bookedItems`; what is left of it is its quantity less
 * what every LIVE order books — a cancelled order gives its booking back.
 * `bookingFor` is the one arithmetic: the Create Sales Order panel reads it
 * and the create route refuses to book more than it says is left.
 */

const num = (v: Prisma.Decimal | number | null | undefined) => (v == null ? 0 : Number(v));
const cents = (n: number) => Math.round(n * 100) / 100;
export const thou = (n: number) => Math.round(n * 1000) / 1000;


export interface BookingLine {
  id: string;
  group: string | null;
  title: string | null;
  description: string;
  isHeading: boolean;
  quantity: number;
  unit: string;
  unitPrice: number;
  amount: number;
  /** Quantity on live (not cancelled) orders already. */
  booked: number;
  /** What is left of the line: quantity − booked, never below 0. */
  available: number;
}

export interface Booking {
  revisionId: string;
  revision: number;
  revisionStatus: string;
  discountPct: number;
  vatRate: number;
  vatInclusive: boolean;
  /** The quotation's sum without tax (after discount) — SCORO's "quote total". */
  net: number;
  total: number;
  /** Net booked on live orders, and what is left of it. */
  bookedNet: number;
  availableNet: number;
  lines: BookingLine[];
}

type RevisionWithItems = { id: string; revision: number; status: string; discountPct: Prisma.Decimal; vatRate: Prisma.Decimal; vatInclusive: boolean; items: {
  id: string; group: string | null; title: string | null; description: string; isHeading: boolean; quantity: Prisma.Decimal; unit: string;
  unitPrice: Prisma.Decimal; amount: Prisma.Decimal; unitCost: Prisma.Decimal | null; costAmount: Prisma.Decimal | null;
  providerSupplierId: string | null; providerUserId: string | null; costNote: string | null; sortOrder: number;
}[] };

/**
 * SCORO's "100% of available": what is left of each line of the quotation's
 * value revision once every live order's lines are counted — a line's own
 * link (`quotationItemId`) or a summarised line's `bookedItems`. A cancelled
 * order gives its booking back. Read by the Create Sales Order panel and by
 * the create route, which refuses to book what is not there.
 */
export async function bookingFor(
  quotation: { id: string; revisions: RevisionWithItems[] },
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<Booking | null> {
  const revision = valueRevision(quotation.revisions);
  if (!revision) return null;
  const orders = await tx.salesOrder.findMany({
    where: { quotationId: quotation.id, status: { not: 'CANCELLED' } },
    select: { subtotal: true, discountAmount: true, lines: { select: { quotationItemId: true, quantity: true, bookedItems: true } } },
  });
  const booked = new Map<string, number>();
  const add = (itemId: string, qty: number) => booked.set(itemId, (booked.get(itemId) ?? 0) + qty);
  let bookedNet = 0;
  for (const o of orders) {
    bookedNet += num(o.subtotal) - num(o.discountAmount);
    for (const l of o.lines) {
      if (l.quotationItemId) add(l.quotationItemId, num(l.quantity));
      const extra = Array.isArray(l.bookedItems) ? (l.bookedItems as { quotationItemId?: unknown; quantity?: unknown }[]) : [];
      for (const b of extra) {
        if (typeof b.quotationItemId === 'string' && typeof b.quantity === 'number') add(b.quotationItemId, b.quantity);
      }
    }
  }
  const totals = quotationTotals({
    lines: revision.items,
    discountPct: revision.discountPct,
    vatRate: revision.vatRate,
    vatInclusive: revision.vatInclusive,
  });
  return {
    revisionId: revision.id,
    revision: revision.revision,
    revisionStatus: revision.status,
    discountPct: num(revision.discountPct),
    vatRate: num(revision.vatRate),
    vatInclusive: revision.vatInclusive,
    net: totals.net,
    total: totals.total,
    bookedNet: cents(bookedNet),
    availableNet: cents(Math.max(0, totals.net - bookedNet)),
    lines: revision.items.map((i) => {
      const qty = num(i.quantity);
      const b = thou(booked.get(i.id) ?? 0);
      return {
        id: i.id,
        group: i.group,
        title: i.title,
        description: i.description,
        isHeading: i.isHeading,
        quantity: qty,
        unit: i.unit,
        unitPrice: num(i.unitPrice),
        amount: num(i.amount),
        booked: b,
        available: i.isHeading ? 0 : thou(Math.max(0, qty - b)),
      };
    }),
  };
}


/**
 * Orders made before progress booking existed carry no link to the
 * quotation lines they book. Run by the seed on every deploy: a line that
 * matches a line of the quotation's value revision (same product, price and
 * unit) is linked to it; a summarised line (one lot titled as the quotation)
 * is marked as booking every line in full. Idempotent — only unlinked lines
 * are touched, and a line nothing matches is left as it is.
 */
export async function linkLegacyBookings(): Promise<{ linked: number; summarised: number }> {
  const orders = await prisma.salesOrder.findMany({
    where: { lines: { some: { isHeading: false, quotationItemId: null, bookedItems: { equals: Prisma.DbNull } } } },
    include: {
      lines: { where: { isHeading: false, quotationItemId: null, bookedItems: { equals: Prisma.DbNull } }, orderBy: { sortOrder: 'asc' } },
      quotation: { include: { revisions: { include: { items: { orderBy: { sortOrder: 'asc' } } } } } },
    },
  });
  let linked = 0;
  let summarised = 0;
  for (const order of orders) {
    const revision = valueRevision(order.quotation.revisions);
    if (!revision) continue;
    const items = revision.items.filter((i) => !i.isHeading);
    const taken = new Set<string>();
    for (const line of order.lines) {
      const match = items.find(
        (i) =>
          !taken.has(i.id) &&
          (i.title ?? '').trim() === (line.title ?? '').trim() &&
          i.unit === line.unit &&
          num(i.unitPrice) === num(line.unitPrice),
      );
      if (match) {
        taken.add(match.id);
        await prisma.salesOrderLine.update({ where: { id: line.id }, data: { quotationItemId: match.id } });
        linked++;
        continue;
      }
      const isSummary = order.lines.length === 1 && (line.title ?? '').trim() === order.quotation.subject.trim() && num(line.quantity) === 1;
      if (isSummary && items.length) {
        await prisma.salesOrderLine.update({
          where: { id: line.id },
          data: { bookedItems: items.map((i) => ({ quotationItemId: i.id, quantity: num(i.quantity) })) },
        });
        summarised++;
      }
    }
  }
  return { linked, summarised };
}
