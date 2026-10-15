import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { addDays, dayKey, daysBetween } from './day';

/**
 * Accounts Payable per the owner's sample (2026-10-15): a supplier bill
 * carries its DATE OF DELIVERY (the receiving's, else typed), its TERMS in
 * days, and its PURCHASER / BUYER (the purchase order's author, else picked).
 * The terms run from the delivery — due = delivery (else the bill date) +
 * terms — as the sample's 2026-10-02 + 30 days = 2026-11-01.
 */

/** Statuses on which something is payable — `financePosition`'s rule. */
export const BILL_PAYABLE = ['APPROVED', 'PARTIALLY_PAID'] as const;

/** How many days ahead "Due in 7 days" looks. */
export const DUE_SOON_DAYS = 7;

/** The due date: the delivery (else the bill date) plus the terms. */
export function billDueDate(billDate: Date, deliveryDate: Date | null, termsDays: number): Date {
  return addDays(deliveryDate ?? billDate, termsDays);
}

/** "30 Days" — how a bill's terms print. */
export const billTermsLabel = (days: number | null | undefined, fallback?: string | null): string =>
  days === null || days === undefined ? fallback ?? '—' : days === 0 ? 'On delivery' : `${days} Day${days === 1 ? '' : 's'}`;

/** Payable, not paid in full, and due between today and a week from today (both included). */
export function dueSoonWhere(today: Date = dayKey(new Date())): Prisma.SupplierBillWhereInput {
  return { status: { in: [...BILL_PAYABLE] }, dueDate: { gte: today, lte: addDays(today, DUE_SOON_DAYS) } };
}

/**
 * Bills entered before delivery, terms and purchaser existed take them from
 * what is on file — the receiving's date, the terms their own dates say, the
 * order's author — every deploy, only where none is set, claimed on null.
 * The due date stored on each is left exactly as it was.
 */
export async function fillBillTerms(): Promise<number> {
  const rows = await prisma.supplierBill.findMany({
    where: { OR: [{ termsDays: null }, { deliveryDate: null, receivingId: { not: null } }, { purchaserId: null, orderId: { not: null } }] },
    select: {
      id: true,
      billDate: true,
      dueDate: true,
      termsDays: true,
      deliveryDate: true,
      purchaserId: true,
      receiving: { select: { receivedDate: true } },
      order: { select: { createdById: true } },
    },
  });
  let filled = 0;
  for (const r of rows) {
    const data: Prisma.SupplierBillUpdateManyMutationInput & { purchaserId?: string } = {};
    const delivery = r.deliveryDate ?? r.receiving?.receivedDate ?? null;
    if (!r.deliveryDate && r.receiving) data.deliveryDate = r.receiving.receivedDate;
    if (r.termsDays === null) data.termsDays = Math.max(0, daysBetween(delivery && delivery <= r.dueDate ? delivery : r.billDate, r.dueDate));
    if (!r.purchaserId && r.order) data.purchaserId = r.order.createdById;
    if (!Object.keys(data).length) continue;
    const done = await prisma.supplierBill.updateMany({
      where: {
        id: r.id,
        ...(data.termsDays !== undefined ? { termsDays: null } : {}),
        ...(data.deliveryDate !== undefined ? { deliveryDate: null } : {}),
        ...(data.purchaserId !== undefined ? { purchaserId: null } : {}),
      },
      data,
    });
    filled += done.count;
  }
  if (filled) {
    await prisma.auditLog.create({
      data: {
        entityType: 'supplier_bill',
        entityId: 'list',
        action: 'UPDATED',
        summary: `Gave ${filled} supplier bill(s) their delivery date, terms and purchaser from the receiving, their dates and the order`,
      },
    });
  }
  return filled;
}
