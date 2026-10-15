import { Prisma } from '@prisma/client';
import { nextNumber } from './numbering';
import { cents, num, taxBreakdown, currentRates } from './finance';
import { termsLabel } from './receivables';
import { formatMoney, companyCurrency } from './pdf';
import { badRequest } from '../http/kit';

/**
 * Raising an invoice from an approved progress billing — the ONE way, used by
 * finance's direct door (`POST /invoices/from-billing/:billingId`) and by an
 * approved invoice request (2026-10-15).
 *
 * Everything is carried from the billing — gross, both rates, both tax
 * amounts, the line breakdown. Nothing is recomputed, because the billing
 * already snapshotted the rates it was issued under and an invoice raised
 * months later must not silently use today's VAT (model §4.6: finance
 * consumes, it does not re-key). The billing becomes INVOICED in the same
 * transaction; `progressBillingId` is unique, so a second invoice is
 * impossible rather than merely refused.
 */
export interface BillingInvoiceHeader {
  invoiceDate: Date;
  dueDate: Date;
  termsDays: number;
  terms?: string | null;
  poReference?: string | null;
  notes?: string | null;
  salespersonId: string | null;
  teamId: string | null;
  /** The sales order the invoice bills (an invoice request names one). */
  salesOrderId?: string | null;
  /** The printed sales invoice number, when it is already known. */
  siNumber?: string | null;
}

export const billingForInvoiceInclude = {
  job: { select: { id: true, number: true, name: true, customerId: true } },
  lines: { include: { scopeItem: true } },
  invoice: { select: { id: true, number: true } },
} satisfies Prisma.ProgressBillingInclude;

export type BillingForInvoice = Prisma.ProgressBillingGetPayload<{ include: typeof billingForInvoiceInclude }>;

export async function createInvoiceFromBilling(
  tx: Prisma.TransactionClient,
  billing: BillingForInvoice,
  header: BillingInvoiceHeader,
  actorId: string,
) {
  const number = await nextNumber('invoice', tx);
  const created = await tx.invoice.create({
    data: {
      number,
      customerId: billing.job.customerId,
      jobId: billing.jobId,
      progressBillingId: billing.id,
      salesOrderId: header.salesOrderId ?? null,
      invoiceDate: header.invoiceDate,
      dueDate: header.dueDate,
      termsDays: header.termsDays,
      salespersonId: header.salespersonId,
      teamId: header.teamId,
      terms: header.terms ?? termsLabel(header.termsDays),
      poReference: header.poReference || null,
      siNumber: header.siNumber || null,
      // Carried, not recomputed.
      grossAmount: billing.grossAmount,
      vatRate: billing.vatRate,
      vatAmount: billing.vatAmount,
      ewtRate: billing.ewtRate,
      ewtAmount: billing.ewtAmount,
      invoiceTotal: billing.invoiceTotal,
      netCollectible: billing.netCollectible,
      notes: header.notes || null,
      createdById: actorId,
      lines: {
        create: billing.lines.map((line, i) => ({
          sortOrder: i,
          description: line.scopeItem?.name ?? 'Progress billing',
          detail: `${num(line.toDatePct)}% complete to date (${num(line.previousPct)}% already billed)`,
          amount: line.thisPeriodAmount,
        })),
      },
    },
  });
  await tx.progressBilling.update({ where: { id: billing.id }, data: { status: 'INVOICED' } });
  return created;
}

/** A sales order's net — its total before VAT, what invoices may bill of it. */
export const orderNet = (order: { total: Prisma.Decimal; vatAmount: Prisma.Decimal }) => cents(num(order.total) - num(order.vatAmount));

/** What the live invoices already bill of an order (gross, before VAT). */
export async function orderInvoiced(tx: Prisma.TransactionClient, orderId: string, exceptInvoiceId?: string): Promise<number> {
  const billed = await tx.invoice.aggregate({
    where: { salesOrderId: orderId, status: { not: 'CANCELLED' }, ...(exceptInvoiceId ? { id: { not: exceptInvoiceId } } : {}) },
    _sum: { grossAmount: true },
  });
  return cents(num(billed._sum.grossAmount));
}

/**
 * A sales order is never invoiced past its net (its total before VAT): the
 * live invoices on it plus this one, checked under a lock on the order's row
 * so two invoices raised at once cannot both take the last of it.
 */
export async function assertOrderLeft(
  tx: Prisma.TransactionClient,
  order: { id: string; number: string; net: number },
  gross: number,
  exceptInvoiceId?: string,
) {
  await tx.$queryRaw`SELECT id FROM "SalesOrder" WHERE id = ${order.id} FOR UPDATE`;
  const left = cents(order.net - (await orderInvoiced(tx, order.id, exceptInvoiceId)));
  if (gross > left + 0.005) {
    throw badRequest(`Only ${formatMoney(Math.max(0, left), await companyCurrency())} of ${order.number} is left to invoice (before VAT)`);
  }
}

/**
 * Raising an invoice straight from an issued sales order — what an approved
 * invoice request with no progress billing behind it makes (2026-10-16, the
 * owner's call: "after Sales Order, route to invoice request"). One line, the
 * gross asked for; VAT at the ORDER's rate (the rate it was sold under), EWT
 * at the company's — the manual invoice's own arithmetic (`taxBreakdown`),
 * never past what is left of the order's net (checked under its lock).
 */
export async function createInvoiceFromOrder(
  tx: Prisma.TransactionClient,
  order: { id: string; number: string; customerId: string; vatRate: Prisma.Decimal; total: Prisma.Decimal; vatAmount: Prisma.Decimal },
  gross: number,
  description: string,
  header: BillingInvoiceHeader & { jobId?: string | null },
  actorId: string,
) {
  await assertOrderLeft(tx, { id: order.id, number: order.number, net: orderNet(order) }, gross);
  const rates = await currentRates(tx);
  const tax = taxBreakdown(gross, num(order.vatRate), rates.ewtRate);
  const D = (n: number) => new Prisma.Decimal(n);
  return tx.invoice.create({
    data: {
      number: await nextNumber('invoice', tx),
      customerId: order.customerId,
      jobId: header.jobId ?? null,
      salesOrderId: order.id,
      invoiceDate: header.invoiceDate,
      dueDate: header.dueDate,
      termsDays: header.termsDays,
      salespersonId: header.salespersonId,
      teamId: header.teamId,
      terms: header.terms ?? termsLabel(header.termsDays),
      poReference: header.poReference || null,
      siNumber: header.siNumber || null,
      grossAmount: D(tax.grossAmount),
      vatRate: D(tax.vatRate),
      vatAmount: D(tax.vatAmount),
      ewtRate: D(tax.ewtRate),
      ewtAmount: D(tax.ewtAmount),
      invoiceTotal: D(tax.invoiceTotal),
      netCollectible: D(tax.netCollectible),
      notes: header.notes || null,
      createdById: actorId,
      lines: { create: [{ sortOrder: 0, description, detail: `Sales order ${order.number}`, amount: D(tax.grossAmount) }] },
    },
  });
}
