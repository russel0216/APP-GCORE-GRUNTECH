import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { manilaDate } from './day';
import { recalcQuotationRevision } from './quotation';

/**
 * A sales order entered WITHOUT a quotation (2026-11-08, the owner's call:
 * "my team is adding sales orders from SCORO to G-CORE — a temporary access
 * to enter a sales order without a quotation for this year").
 *
 * Every sales order reads its customer, currency, team and booking through
 * its quotation, so a "direct" order still gets one: a STAND-IN quotation
 * (`Quotation.directOrder`), made with the order, WON on an APPROVED
 * revision 0 (the SCORO import's precedent — the deal was decided outside
 * G-CORE), numbered after the order ("Q-<order number>", so no salesperson's
 * quotation series is used). Its lines MIRROR the order's on every save
 * (`mirrorDirectQuotation`), each order line booking its own mirror line, so
 * the stand-in's value is the order's and nothing is left on it to book
 * twice. The order itself is an ordinary DRAFT: modified on the order
 * editor, submitted for approval on its own route as any other.
 *
 * TEMPORARY: offered until `DIRECT_ORDERS_UNTIL` (Manila's day). After that
 * the button goes and the route refuses; orders already made stay as they are.
 */

export const DIRECT_ORDERS_UNTIL = '2026-12-31';

/** Whether a sales order may still be entered without a quotation today. */
export function directOrdersOpen(now: Date = new Date()): boolean {
  return manilaDate(now).toISOString().slice(0, 10) <= DIRECT_ORDERS_UNTIL;
}

const d = (v: number | string | Prisma.Decimal) => new Prisma.Decimal(v);

/**
 * Brings a stand-in quotation in step with the orders on it: its revision 0
 * takes the lines of EVERY order booking it, in order number (a SCORO invoice
 * and its .1 progress bill share one stand-in since 2026-11-11), each order
 * line linked to its mirror (so the stand-in shows nothing left to book), the
 * first order's discount and tax, and the revision's totals worked out again.
 * Does nothing for an order on a real quotation. Inside the caller's
 * transaction.
 */
export async function mirrorDirectQuotation(tx: Prisma.TransactionClient, orderId: string) {
  const order = await tx.salesOrder.findUnique({
    where: { id: orderId },
    select: {
      quotation: { select: { id: true, directOrder: true, revisions: { where: { revision: 0 }, select: { id: true } } } },
    },
  });
  if (!order?.quotation.directOrder) return;
  const revisionId = order.quotation.revisions[0]?.id;
  if (!revisionId) return;
  const orders = await tx.salesOrder.findMany({
    where: { quotationId: order.quotation.id },
    orderBy: [{ number: 'asc' }],
    select: { id: true, discountPct: true, vatRate: true, vatInclusive: true, lines: { orderBy: { sortOrder: 'asc' } } },
  });
  const first = orders[0];

  await tx.salesOrderLine.updateMany({ where: { orderId: { in: orders.map((o) => o.id) } }, data: { quotationItemId: null } });
  await tx.quotationItem.deleteMany({ where: { revisionId } });
  for (const [i, l] of orders.flatMap((o) => o.lines).entries()) {
    const item = await tx.quotationItem.create({
      data: {
        revisionId,
        group: l.group,
        title: l.title,
        brand: l.brand,
        productType: l.productType,
        partNumber: l.partNumber,
        description: l.description,
        isHeading: l.isHeading,
        quantity: l.quantity,
        unit: l.unit,
        unitPrice: l.unitPrice,
        amount: l.amount,
        sortOrder: i,
        unitCost: l.unitCost,
        costAmount: l.costAmount,
        providerSupplierId: l.providerSupplierId,
        providerUserId: l.providerUserId,
        costNote: l.costNote,
      },
      select: { id: true },
    });
    if (!l.isHeading) await tx.salesOrderLine.update({ where: { id: l.id }, data: { quotationItemId: item.id } });
  }
  await tx.quotationRevision.update({
    where: { id: revisionId },
    data: { discountPct: d(first.discountPct), vatRate: d(first.vatRate), vatInclusive: first.vatInclusive },
  });
  await recalcQuotationRevision(revisionId, tx);
}

/** A direct order deleted takes its stand-in quotation with it, once nothing else books it. */
export async function dropStandIn(quotationId: string) {
  const q = await prisma.quotation.findUnique({ where: { id: quotationId }, select: { directOrder: true, _count: { select: { salesOrders: true } } } });
  if (!q?.directOrder || q._count.salesOrders > 0) return false;
  await prisma.quotation.delete({ where: { id: quotationId } });
  return true;
}
