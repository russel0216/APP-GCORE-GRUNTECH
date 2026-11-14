import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
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
  /** The withholding rate when it differs from the source's (editable, 2026-10-16). */
  ewtRate?: number | null;
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
  // The billing's figures are carried; only the withholding rate may differ,
  // and then EWT is withheld again on the same gross.
  const ewt =
    header.ewtRate != null && Math.abs(header.ewtRate - num(billing.ewtRate)) > 0.00005
      ? taxBreakdown(num(billing.grossAmount), num(billing.vatRate), header.ewtRate)
      : null;
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
      ewtRate: ewt ? new Prisma.Decimal(ewt.ewtRate) : billing.ewtRate,
      ewtAmount: ewt ? new Prisma.Decimal(ewt.ewtAmount) : billing.ewtAmount,
      invoiceTotal: billing.invoiceTotal,
      netCollectible: ewt ? new Prisma.Decimal(ewt.netCollectible) : billing.netCollectible,
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

/** An invoice as one of its orders sees it: the invoice, and the order's own share of it (before VAT). */
export interface OrderInvoice {
  salesOrderId: string;
  id: string;
  number: string;
  siNumber: string | null;
  status: string;
  invoiceDate: Date;
  importedFrom: string | null;
  /** The whole invoice, before VAT. */
  grossAmount: number;
  /** This order's share of it, before VAT — the whole of it where the invoice bills one order. */
  amount: number;
  /** This order's share of what was collected on it (the withheld EWT counted once it is paid). */
  collected: number;
  netCollectible: number;
}

const ORDER_INVOICE_SELECT = {
  id: true,
  number: true,
  siNumber: true,
  status: true,
  invoiceDate: true,
  importedFrom: true,
  grossAmount: true,
  ewtAmount: true,
  netCollectible: true,
  amountCollected: true,
} as const;

/**
 * The live invoices that bill these sales orders — ONE reading of both
 * shapes (2026-11-14): an invoice that bills several orders on one S.I.
 * (`InvoicePart` rows, each order its share), and an invoice that bills its
 * own `salesOrderId` whole (no parts). Every "invoiced of an order" figure —
 * what is left to invoice, the Sales Order report, a commission's "fully
 * collected", the sales order's own card — reads this.
 */
export async function orderInvoices(
  db: Prisma.TransactionClient | typeof prisma,
  orderIds: string[],
  opts: { exceptInvoiceId?: string; includeCancelled?: boolean } = {},
): Promise<OrderInvoice[]> {
  if (!orderIds.length) return [];
  const live = { ...(opts.includeCancelled ? {} : { status: { not: 'CANCELLED' as const } }), ...(opts.exceptInvoiceId ? { id: { not: opts.exceptInvoiceId } } : {}) };
  const [parts, whole] = await Promise.all([
    db.invoicePart.findMany({ where: { salesOrderId: { in: orderIds }, invoice: live }, select: { salesOrderId: true, amount: true, invoice: { select: ORDER_INVOICE_SELECT } } }),
    db.invoice.findMany({ where: { salesOrderId: { in: orderIds }, parts: { none: {} }, ...live }, select: { salesOrderId: true, ...ORDER_INVOICE_SELECT } }),
  ]);
  const row = (salesOrderId: string, i: (typeof whole)[number] | (typeof parts)[number]['invoice'], amount: number): OrderInvoice => {
    const gross = num(i.grossAmount);
    const settled = num(i.amountCollected) + (i.status === 'PAID' ? num(i.ewtAmount) : 0);
    return {
      salesOrderId,
      id: i.id,
      number: i.number,
      siNumber: i.siNumber,
      status: i.status,
      invoiceDate: i.invoiceDate,
      importedFrom: i.importedFrom,
      grossAmount: gross,
      amount: cents(amount),
      collected: cents(gross > 0 ? (settled * amount) / gross : 0),
      netCollectible: num(i.netCollectible),
    };
  };
  return [...parts.map((p) => row(p.salesOrderId, p.invoice, num(p.amount))), ...whole.map((i) => row(i.salesOrderId!, i, num(i.grossAmount)))].sort(
    (a, b) => a.invoiceDate.getTime() - b.invoiceDate.getTime(),
  );
}

/** What the live invoices already bill of each order (before VAT). */
export async function ordersInvoiced(db: Prisma.TransactionClient | typeof prisma, orderIds: string[], exceptInvoiceId?: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const i of await orderInvoices(db, orderIds, { exceptInvoiceId })) out.set(i.salesOrderId, cents((out.get(i.salesOrderId) ?? 0) + i.amount));
  return out;
}

/** What the live invoices already bill of an order (gross, before VAT). */
export async function orderInvoiced(tx: Prisma.TransactionClient, orderId: string, exceptInvoiceId?: string): Promise<number> {
  return (await ordersInvoiced(tx, [orderId], exceptInvoiceId)).get(orderId) ?? 0;
}

/**
 * ONE invoice for several sales orders (2026-11-14): a line and a part per
 * order, each checked against what is left of ITS order under a lock, one
 * S.I. number, VAT at the orders' rate (they share a quotation, so they
 * share it) and EWT on the whole gross. `salesOrderId` is the first order's,
 * which is what an invoice with one order always carried.
 */
export async function createInvoiceFromOrders(
  tx: Prisma.TransactionClient,
  parts: {
    order: { id: string; number: string; customerId: string; vatRate: Prisma.Decimal; total: Prisma.Decimal; vatAmount: Prisma.Decimal };
    gross: number;
    description: string;
    salespersonId: string | null;
    salespersonName: string | null;
    teamId: string | null;
    teamCode: string | null;
  }[],
  header: BillingInvoiceHeader & { jobId?: string | null },
  actorId: string,
) {
  if (!parts.length) throw badRequest('An invoice bills at least one sales order');
  // Locked in one order, so two batches naming the same orders cannot deadlock.
  for (const p of [...parts].sort((a, b) => a.order.id.localeCompare(b.order.id))) {
    await assertOrderLeft(tx, { id: p.order.id, number: p.order.number, net: orderNet(p.order) }, p.gross);
  }
  const rates = await currentRates(tx);
  const gross = cents(parts.reduce((s, p) => s + p.gross, 0));
  const tax = taxBreakdown(gross, num(parts[0].order.vatRate), header.ewtRate ?? rates.ewtRate);
  const D = (n: number) => new Prisma.Decimal(n);
  return tx.invoice.create({
    data: {
      number: await nextNumber('invoice', tx),
      customerId: parts[0].order.customerId,
      jobId: header.jobId ?? null,
      salesOrderId: parts[0].order.id,
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
      lines: {
        create: parts.map((p, i) => ({
          sortOrder: i,
          description: p.description,
          // Who booked it, under which team — the booking division of this S.I.
          detail: `Sales order ${p.order.number}${p.salespersonName ? ` — ${p.salespersonName}${p.teamCode ? ` (${p.teamCode})` : ''}` : ''}`,
          amount: D(cents(p.gross)),
        })),
      },
      parts: { create: parts.map((p, i) => ({ salesOrderId: p.order.id, amount: D(cents(p.gross)), salespersonId: p.salespersonId, teamId: p.teamId, sortOrder: i })) },
    },
  });
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
  const tax = taxBreakdown(gross, num(order.vatRate), header.ewtRate ?? rates.ewtRate);
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
