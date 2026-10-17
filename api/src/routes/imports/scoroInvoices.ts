import { Prisma, type SalesOrderStatus } from '@prisma/client';
import { prisma } from '../../prisma';
import { required, optional, type ImportSpec, type ImportActor } from '../../shared/csv';
import { setCounter, type CounterMove } from '../../shared/numbering';
import { FALLBACK_GROUP, rememberGroups } from '../../shared/quotationGroups';
import { linkOrderBookings } from '../../shared/salesOrderBooking';
import { HttpError } from '../../http/kit';
import { audit } from '../../shared/audit';
import { lineData, type QuotationLineInput } from '../sales';
import { recalcOrder } from '../salesOrders';
import { nextNumber } from '../../shared/numbering';
import { cents, num, refreshSettlement } from '../../shared/finance';
import { invoiceCredit, termsLabel } from '../../shared/receivables';
import { addDays } from '../../shared/day';
import type { Registered } from '../imports';
import {
  ROW_TRANSACTION,
  collapse,
  daysApart,
  findContact,
  groupResolver,
  hasLineContent,
  listedGroups,
  rowFailure,
  sameName,
  scoroDate,
  scoroDecimal,
  scoroLines,
  unlistedScoroGroups,
} from './scoroQuotes';

/**
 * SCORO's "invoices export", as SCORO writes it (2026-10-17, the owner's
 * file; 2026-10-10: "the invoices from SCORO which will become a Sales Order
 * in G-CORE"). Each SCORO invoice becomes a REAL sales order booking the
 * quotation it names (`quote_no`) — the sales order is raised from a
 * quotation only, so the quotation must already be in G-CORE (the SCORO
 * quotes import first). SCORO numbered its invoices on the progress-booking
 * pattern G-CORE's orders follow (4622, 4622.1), so `doc_no` is the order's
 * number.
 *
 * The quotes import's rules hold: the columns are SCORO's own headers, the
 * file is UTF-16 and TAB-separated as it comes, one row per line grouped by
 * `doc_no`; `build` RESOLVES and `write` CREATES; an order whose number is
 * already in G-CORE is left as it is, so a re-run changes nothing. The lines
 * are read by the quotes import's own `scoroLines`, and a group not on the
 * list is the importer's call, else OTHERS.
 *
 * An invoice SCORO issued is an ISSUED order here, needing no approval —
 * SCORO's paper was already out — and its paper says "Issued by" its owner
 * (the COMPLETED audit row `unroutedOrderSignoff` reads). A cancelled one is
 * CANCELLED with SCORO's status as its reason, a draft a DRAFT.
 *
 * An issued one is also a real INVOICE in A/R (2026-10-17, the owner's call):
 * G-CORE's number, SCORO's `doc_no` as the invoice no., dated and countered
 * on `doc_date`, due on `doc_deadline`, the order's money — and what SCORO
 * says was paid (`paid_sum`, on `latest_receipt_date`) is a collection
 * marked `importedFrom: 'SCORO'`: it settles the invoice, and no collection
 * total, cash-flow actual or dashboard counts it ("keep them out as
 * history"). A fully paid invoice withholds what SCORO's payment left short
 * (up to 15% of the gross), so it closes exactly; otherwise the company's
 * EWT. An order imported before this step gets its invoice on the next run
 * of the same file, once — never a second one (`writeReceivable`). Each order's lines are
 * linked to the quotation lines they book (`linkOrderBookings`), so the
 * quotation's Booked and Outstanding read right.
 */

type Tx = Prisma.TransactionClient;

const SOURCE = 'the SCORO invoices import';

/** SCORO's invoice statuses → the order's. Case-blind; an unknown one is an error naming it. */
const STATUS_ORDER: Record<string, SalesOrderStatus> = {
  draft: 'DRAFT',
  unpaid: 'ISSUED',
  sent: 'ISSUED',
  overdue: 'ISSUED',
  'partially paid': 'ISSUED',
  'partly paid': 'ISSUED',
  paid: 'ISSUED',
  cancelled: 'CANCELLED',
  canceled: 'CANCELLED',
  void: 'CANCELLED',
  credited: 'CANCELLED',
};

/** SCORO's `payment_type` keys in words, as the order's Payment method prints them. */
const PAYMENT_WORDS: Record<string, string> = {
  banktransfer: 'Bank transfer',
  cash: 'Cash',
  card: 'Card',
  cheque: 'Cheque',
  check: 'Cheque',
};

/** "Purchase Order No.: 2600012384" → "2600012384"; anything else as written. */
export function scoroPoNumber(value: string | null): string | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  const stripped = v.replace(/^(customer\s+)?(purchase\s+order|p\.?\s*o\.?)\s*(no\.?|number|#)?\s*[:#-]?\s*/i, '').trim();
  return stripped || v;
}

interface ScoroInvoiceRecord {
  scoroId: string | null;
  number: string;
  quotation: { id: string; number: string; customerId: string; contactId: string | null; ownerId: string; currency: string };
  ownerId: string;
  /** SCORO's owner_name where no login carries it; the quotation's owner is used. */
  ownerNote: string | null;
  contact: { id: string | null; name: string } | null;
  status: SalesOrderStatus;
  scoroStatus: string;
  orderDate: Date;
  termsDays: number;
  paymentMethod: string | null;
  referenceNo: string | null;
  poNumber: string | null;
  comment: string | null;
  discountPct: Prisma.Decimal;
  vatRate: Prisma.Decimal;
  payer: string;
  paidSum: string | null;
  /** SCORO's due date, the invoice's. */
  deadline: Date | null;
  /** When SCORO last recorded money in — the collection's date. */
  receivedOn: Date | null;
  /** SCORO's payment_type, as the collection's method. */
  paymentType: string | null;
  lines: QuotationLineInput[];
}

const scoroInvoiceSpec: ImportSpec<ScoroInvoiceRecord> = {
  entity: 'scoro_invoices',
  label: 'SCORO invoices (as sales orders)',
  columns: [
    {
      header: 'doc_no',
      required: true,
      example: '4899',
      hint: 'The invoice number in SCORO — the sales order’s number here. One row per line groups by it. A number already in G-CORE is left as it is',
    },
    {
      header: 'quote_no',
      required: true,
      example: '0022605106',
      hint: 'The quotation the invoice books — it must already be in G-CORE (import SCORO’s quotes first). The order takes its customer and team',
    },
    { header: 'doc_date', example: '2026-09-30', hint: 'The order date' },
    { header: 'doc_deadline', example: '2026-10-30', hint: 'With doc_date, the payment terms in days; 30 when either is missing' },
    { header: 'owner_name', example: 'Carter Gasiong', hint: 'Who booked it — a G-CORE login of that name, else the quotation’s owner (and the name is kept in the trail)' },
    { header: 'payer', example: 'MONDE M.Y SAN CORPORATION - CALAMBA', hint: 'Kept in the trail; the order’s customer is the quotation’s' },
    { header: 'contact_person', example: 'Ms. Cynthia E. Zenarosa', hint: 'One of the customer’s contacts by name, else the quotation’s contact' },
    {
      header: 'status_name',
      example: 'unpaid',
      hint: 'Unpaid, Sent, Overdue, Partially paid, Paid → Issued, with its invoice in A/R; Draft → Draft; Cancelled, Void, Credited → Cancelled',
    },
    { header: 'c_purchaseordernumber', example: 'Purchase Order No.: 2600012384', hint: 'The customer’s PO — "Purchase Order No.:" is taken off' },
    { header: 'reference_no', example: '', hint: 'Reference' },
    { header: 'doc_description', example: 'Warranty : 12 Months', hint: 'The order’s comment' },
    { header: 'payment_type', example: 'banktransfer', hint: 'The payment method' },
    { header: 'currency', example: 'PHP', hint: 'Must be the quotation’s currency' },
    { header: 'discount', example: '0.000000', hint: 'The order discount, a percentage' },
    { header: 'total_sum', example: '94000.00', hint: 'Not stored: the order’s totals are recomputed from its lines' },
    { header: 'total_vat', example: '11280.00', hint: 'With total_sum, the VAT rate where the lines name none' },
    { header: 'paid_sum', example: '0.00', hint: 'What was paid in SCORO — a collection kept as history on the invoice, never counted in this year’s collections' },
    { header: 'latest_receipt_date', example: '', hint: 'The collection’s date; the invoice date when empty' },
    { header: 'id', example: '4587', hint: 'SCORO’s invoice id, kept in the audit row' },
    { header: 'product_group', example: 'Schneider Electric', hint: 'The line’s group — one not on the list is filed under the group you choose, else OTHERS' },
    { header: 'product_name', example: 'SCHNEIDER ELECTRIC, VARIABLE FREQUENCY DRIVE, ATV320U75N4C', hint: 'The line’s title' },
    { header: 'line_comment', example: 'VFD', hint: 'The line’s description' },
    { header: 'amount', example: '1.000000000000', hint: 'The quantity' },
    { header: 'unit', example: 'unit', hint: 'The unit; blank is "lot"' },
    { header: 'price', example: '84000.000000', hint: 'The unit price' },
    { header: 'line_cost', example: '37256.8300', hint: 'The LINE’s total cost; stored as a unit cost (÷ amount)' },
    { header: 'line_vat_percent', example: '12.000', hint: 'The first priced line’s rate is the order’s VAT rate' },
    { header: 'is_subheading', example: '0', hint: '1 makes the row a subheading' },
    { header: 'supplier_name', example: 'SCHNEIDER ELECTRIC PHILIPPINES', hint: 'Who carries the cost — matched by name, never created; otherwise kept in the cost note' },
    { header: 'doer_name', example: '', hint: 'With is_internal 1, one of our people carrying the cost' },
    { header: 'is_internal', example: '0', hint: '1 when the cost is carried in-house' },
    { header: 'cost_comment', example: '', hint: 'The line’s cost note' },
    { header: 'line_id', example: '17564', hint: 'SCORO’s line id — a row with one is a line' },
  ],
  groupBy: (row) => (row['doc_no'] ?? '').trim(),
  buildGroup: async (rows, firstRowNumber) => {
    const header = await scoroInvoiceSpec.build(rows[0], firstRowNumber);
    if (!rows.some(hasLineContent)) throw new Error(`invoice ${header.number} has no lines — the export must carry the line columns`);
    const lines = await scoroLines(rows, firstRowNumber);
    const firstPriced = rows.find((r) => hasLineContent(r) && (r['is_subheading'] ?? '').trim() !== '1' && (r['line_vat_percent'] ?? '').trim());
    const lineRate = firstPriced ? scoroDecimal(firstPriced, 'line_vat_percent') : null;
    return { ...header, lines, vatRate: lineRate ? lineRate.div(100).toDecimalPlaces(4) : header.vatRate };
  },
  existing: async (row) => {
    const number = (row['doc_no'] ?? '').trim();
    if (!number) return null;
    const found = await prisma.salesOrder.findFirst({ where: { number: { equals: number, mode: 'insensitive' } }, select: { id: true } });
    return found?.id ?? null;
  },
  build: async (row) => {
    const number = required(row, 'doc_no').trim();
    if (!/^[A-Za-z0-9./_-]{1,40}$/.test(number)) throw new Error(`doc_no "${number}" is not an order number — letters, digits and - / _ . only, up to 40 characters`);

    // The quotation it books: a sales order is raised from a quotation only.
    const quoteNo = (optional(row, 'quote_no') ?? '').trim();
    if (!quoteNo) throw new Error(`invoice ${number} names no quote_no — a sales order books a quotation`);
    const quotation = await prisma.quotation.findFirst({
      where: { number: { equals: quoteNo, mode: 'insensitive' } },
      select: { id: true, number: true, customerId: true, contactId: true, ownerId: true, currency: true },
    });
    if (!quotation) throw new Error(`Quotation ${quoteNo} is not in G-CORE — import SCORO’s quotes first`);

    const currency = (optional(row, 'currency') ?? '').toUpperCase() || quotation.currency;
    if (currency !== quotation.currency) throw new Error(`currency ${currency} is not quotation ${quotation.number}’s (${quotation.currency})`);

    // Who booked it: the login SCORO names, else the quotation's own owner.
    const ownerName = optional(row, 'owner_name');
    let ownerId = quotation.ownerId;
    let ownerNote: string | null = null;
    if (ownerName) {
      const users = await prisma.user.findMany({ select: { id: true, name: true, isActive: true } });
      const named = users.filter((u) => sameName(u.name, ownerName));
      const owner = named.find((u) => u.isActive) ?? named[0];
      if (owner) ownerId = owner.id;
      else ownerNote = collapse(ownerName);
    }

    const contactName = optional(row, 'contact_person');
    const contact = contactName
      ? { id: (await findContact(prisma, quotation.customerId, contactName))?.id ?? null, name: collapse(contactName) }
      : null;

    const statusName = collapse(optional(row, 'status_name') ?? 'unpaid');
    const status = STATUS_ORDER[statusName.toLowerCase()];
    if (!status) throw new Error(`status_name "${statusName}" is not a SCORO invoice status this import knows (${Object.keys(STATUS_ORDER).join(', ')})`);

    const docDate = scoroDate(row, 'doc_date');
    const deadline = scoroDate(row, 'doc_deadline');
    const orderDate = docDate ?? new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
    const termsDays = docDate && deadline && daysApart(docDate, deadline) >= 0 && daysApart(docDate, deadline) <= 365 ? daysApart(docDate, deadline) : 30;

    const discount = scoroDecimal(row, 'discount') ?? new Prisma.Decimal(0);
    if (discount.lt(0) || discount.gte(100)) throw new Error(`discount "${row['discount']}" is not a percentage under 100`);
    const totalSum = scoroDecimal(row, 'total_sum') ?? new Prisma.Decimal(0);
    const totalVat = scoroDecimal(row, 'total_vat') ?? new Prisma.Decimal(0);
    const company = await prisma.company.findUniqueOrThrow({ where: { id: 'company' }, select: { vatRate: true } });
    const vatRate = totalSum.gt(0) ? totalVat.div(totalSum).toDecimalPlaces(4) : company.vatRate;

    const paymentType = (optional(row, 'payment_type') ?? '').trim();
    return {
      scoroId: optional(row, 'id'),
      number,
      quotation,
      ownerId,
      ownerNote,
      contact,
      status,
      scoroStatus: statusName,
      orderDate,
      termsDays,
      paymentMethod: paymentType ? (PAYMENT_WORDS[paymentType.toLowerCase()] ?? paymentType) : null,
      referenceNo: optional(row, 'reference_no'),
      poNumber: scoroPoNumber(optional(row, 'c_purchaseordernumber')),
      comment: optional(row, 'doc_description'),
      discountPct: discount,
      vatRate,
      payer: collapse(optional(row, 'payer') ?? ''),
      paidSum: optional(row, 'paid_sum'),
      deadline,
      receivedOn: scoroDate(row, 'latest_receipt_date'),
      paymentType: paymentType || null,
      lines: [],
    };
  },
  summarize: async (records) => {
    const unlisted = await unlistedScoroGroups(records);
    return unlisted.length ? { groups: { unlisted, choices: (await listedGroups()).map((g) => g.name), fallback: FALLBACK_GROUP } } : {};
  },
};

async function writeScoroInvoices(
  records: { record: ScoroInvoiceRecord; existingId: string | null }[],
  actor?: ImportActor,
  options?: Record<string, unknown>,
): Promise<void> {
  const by = { actorId: actor?.id ?? null, actorName: actor?.name ?? null };
  const groupOf = await groupResolver(options);

  let written = 0;
  for (const { record, existingId } of records) {
    try {
      if (existingId) {
        // An order already in G-CORE is G-CORE's: a re-run changes nothing —
        // but one this import made before invoices came across takes its
        // invoice and SCORO's collection now, once.
        await prisma.$transaction((tx) => catchUp(tx, existingId, record), ROW_TRANSACTION);
        continue;
      }
      await prisma.$transaction((tx) => writeOne(tx, record), ROW_TRANSACTION);
      written++;
    } catch (err) {
      console.error(`SCORO invoices import stopped at ${record.number}:`, err);
      throw new HttpError(
        400,
        `Stopped at invoice ${record.number}: ${rowFailure(err)}. ` +
          (written
            ? `The ${written} invoice${written === 1 ? '' : 's'} before it ${written === 1 ? 'was' : 'were'} imported — run the import again to continue; ${written === 1 ? 'it is' : 'they are'} skipped.`
            : 'Nothing was imported.'),
      );
    }
  }

  async function writeOne(tx: Tx, record: ScoroInvoiceRecord) {
    const contactId = record.contact?.id ?? (record.contact ? (await findContact(tx, record.quotation.customerId, record.contact.name))?.id : null) ?? record.quotation.contactId;
    const lines = record.lines.map((l, i) => {
      const data = lineData(l.isHeading ? l : { ...l, group: groupOf(l.group) }, i);
      return {
        group: data.group,
        title: data.title,
        brand: data.brand,
        productType: data.productType,
        partNumber: data.partNumber,
        description: data.description,
        isHeading: data.isHeading,
        quantity: data.quantity,
        unit: data.unit,
        unitPrice: data.unitPrice,
        amount: data.amount,
        sortOrder: data.sortOrder,
        unitCost: data.unitCost,
        costAmount: data.costAmount,
        providerSupplierId: data.providerSupplierId,
        providerUserId: data.providerUserId,
        costNote: data.costNote,
      };
    });
    const order = await tx.salesOrder.create({
      data: {
        number: record.number,
        status: record.status,
        quotationId: record.quotation.id,
        customerId: record.quotation.customerId,
        contactId,
        ownerId: record.ownerId,
        orderDate: record.orderDate,
        termsDays: record.termsDays,
        paymentMethod: record.paymentMethod,
        referenceNo: record.referenceNo,
        poNumber: record.poNumber,
        comment: record.comment,
        cancelReason: record.status === 'CANCELLED' ? `SCORO status: ${record.scoroStatus}` : null,
        discountPct: record.discountPct,
        vatRate: record.vatRate,
        createdAt: record.orderDate,
        lines: { create: lines },
      },
      select: { id: true },
    });
    await rememberGroups(tx, [FALLBACK_GROUP]);
    await recalcOrder(order.id, tx);
    const booked = await linkOrderBookings(tx, order.id);
    // SCORO's numbers follow the series where they fit its shape; never lowered.
    const counter: CounterMove | null = await setCounter('sales_order', record.number.split('.')[0], tx, { mode: 'raise' });

    const owner = await tx.user.findUnique({ where: { id: record.ownerId }, select: { name: true } });
    await audit(
      {
        entityType: 'sales_order',
        entityId: order.id,
        action: 'CREATED',
        summary: `Imported from SCORO invoice ${record.number} (SCORO id ${record.scoroId ?? '—'}) on quotation ${record.quotation.number}`,
        after: {
          scoroId: record.scoroId,
          number: record.number,
          scoroStatus: record.scoroStatus,
          paidSum: record.paidSum,
          payer: record.payer,
          lines: lines.length,
          linkedToQuotation: booked.linked,
          ...(record.ownerNote ? { scoroOwner: record.ownerNote } : {}),
          ...(counter ? { counter } : {}),
        },
        ...by,
      },
      undefined,
      tx,
    );
    // An issued SCORO invoice was out already: its paper says who issued it
    // (the row `unroutedOrderSignoff` reads), never an approval nobody gave.
    if (record.status === 'ISSUED') {
      await audit(
        {
          entityType: 'sales_order',
          entityId: order.id,
          action: 'COMPLETED',
          summary: `Issued in SCORO — imported by ${SOURCE}`,
          actorId: record.ownerId,
          actorName: owner?.name ?? null,
        },
        undefined,
        tx,
      );
      await writeReceivable(tx, order.id, record, by);
    }
  }

  async function catchUp(tx: Tx, orderId: string, record: ScoroInvoiceRecord) {
    if (record.status !== 'ISSUED') return;
    const order = await tx.salesOrder.findUnique({ where: { id: orderId }, select: { status: true } });
    if (order?.status !== 'ISSUED') return;
    const ours = await tx.auditLog.findFirst({
      where: { entityType: 'sales_order', entityId: orderId, action: 'CREATED', summary: { startsWith: 'Imported from SCORO invoice' } },
      select: { id: true },
    });
    if (!ours) return;
    await writeReceivable(tx, orderId, record, by);
  }
}

/** SCORO's payment_type → the collection's method. */
function methodOf(type: string | null): 'CASH' | 'CHECK' | 'BANK_TRANSFER' | 'ONLINE' {
  const t = (type ?? '').toLowerCase();
  if (t === 'cash') return 'CASH';
  if (t === 'cheque' || t === 'check') return 'CHECK';
  if (t === 'card' || t === 'online' || t === 'paypal') return 'ONLINE';
  return 'BANK_TRANSFER';
}

/**
 * An issued SCORO invoice as A/R holds it: the invoice, and what SCORO says
 * was paid as a collection kept as history. Once per order — an order with a
 * live invoice already is left alone, so a re-run raises nothing twice.
 */
async function writeReceivable(
  tx: Tx,
  orderId: string,
  record: ScoroInvoiceRecord,
  by: { actorId: string | null; actorName: string | null },
): Promise<void> {
  const live = await tx.invoice.count({ where: { salesOrderId: orderId, status: { not: 'CANCELLED' } } });
  if (live) return;
  const order = await tx.salesOrder.findUniqueOrThrow({
    where: { id: orderId },
    select: { id: true, number: true, customerId: true, ownerId: true, poNumber: true, orderDate: true, total: true, vatAmount: true, vatRate: true, termsDays: true },
  });
  const company = await tx.company.findUniqueOrThrow({ where: { id: 'company' }, select: { ewtRate: true } });

  const invoiceTotal = num(order.total);
  const vatAmount = num(order.vatAmount);
  const gross = cents(invoiceTotal - vatAmount);
  const paid = Math.max(0, cents(num(scoroAmount(record.paidSum))));

  // A fully paid invoice withholds what the payment left short — the
  // customer's 2307 — so it closes exactly; anything else takes the
  // company's rate, as an invoice raised here would.
  let ewtAmount = cents(gross * num(company.ewtRate));
  let ewtRate = num(company.ewtRate);
  const shortfall = cents(invoiceTotal - paid);
  if (record.scoroStatus.toLowerCase() === 'paid' && paid > 0 && shortfall >= 0 && shortfall <= cents(gross * 0.15)) {
    ewtAmount = shortfall;
    ewtRate = gross > 0 ? Math.round((shortfall / gross) * 10000) / 10000 : 0;
  }
  const netCollectible = cents(invoiceTotal - ewtAmount);

  // SCORO's number is the invoice no. unless another live invoice carries it.
  const siTaken = await tx.invoice.count({ where: { siNumber: { equals: record.number, mode: 'insensitive' }, status: { not: 'CANCELLED' } } });
  const credit = await invoiceCredit({ salesOrderId: order.id }, tx);
  const termsDays = order.termsDays ?? record.termsDays;
  const D = (n: number) => new Prisma.Decimal(n);
  const actorId = by.actorId ?? order.ownerId;

  const invoice = await tx.invoice.create({
    data: {
      number: await nextNumber('invoice', tx),
      status: 'ISSUED',
      issuedAt: order.orderDate,
      customerId: order.customerId,
      salesOrderId: order.id,
      invoiceDate: order.orderDate,
      counteredDate: order.orderDate,
      termsDays,
      dueDate: record.deadline ?? addDays(order.orderDate, termsDays),
      terms: termsLabel(termsDays),
      poReference: order.poNumber,
      siNumber: siTaken ? null : record.number,
      salespersonId: credit.salespersonId,
      teamId: credit.teamId,
      grossAmount: D(gross),
      vatRate: order.vatRate,
      vatAmount: D(vatAmount),
      ewtRate: D(ewtRate),
      ewtAmount: D(ewtAmount),
      invoiceTotal: D(invoiceTotal),
      netCollectible: D(netCollectible),
      notes: `Imported from SCORO invoice ${record.number} — SCORO status: ${record.scoroStatus}`,
      importedFrom: 'SCORO',
      createdById: actorId,
      lines: { create: [{ sortOrder: 0, description: `As invoiced in SCORO (${record.number})`, detail: `Sales order ${order.number}`, amount: D(gross) }] },
    },
    select: { id: true, number: true },
  });

  const applied = Math.min(paid, netCollectible);
  let payment: { id: string; number: string } | null = null;
  if (applied > 0) {
    const on = record.receivedOn ?? order.orderDate;
    payment = await tx.payment.create({
      data: {
        number: await nextNumber('payment', tx),
        kind: 'RECEIPT',
        method: methodOf(record.paymentType),
        paymentDate: on,
        clearedAt: on,
        customerId: order.customerId,
        amount: D(applied),
        reference: `SCORO invoice ${record.number}`,
        notes: 'Collected in SCORO — imported as history, not counted in collections',
        importedFrom: 'SCORO',
        recordedById: actorId,
        allocations: { create: [{ invoiceId: invoice.id, amount: D(applied) }] },
      },
      select: { id: true, number: true },
    });
  }
  const settled = await refreshSettlement(tx, 'invoice', invoice.id);

  await audit(
    {
      entityType: 'invoice',
      entityId: invoice.id,
      action: 'CREATED',
      summary: `Imported from SCORO invoice ${record.number} on sales order ${order.number} — ${settled.status === 'PAID' ? 'paid in SCORO' : applied > 0 ? 'part paid in SCORO' : 'unpaid'}`,
      after: { scoroStatus: record.scoroStatus, paidSum: record.paidSum, ewtRate, applied, collection: payment?.number ?? null },
      ...by,
    },
    undefined,
    tx,
  );
  if (payment) {
    await audit(
      {
        entityType: 'payment',
        entityId: payment.id,
        action: 'CREATED',
        summary: `SCORO's collection on invoice ${record.number}, kept as history — not counted in collections`,
        ...by,
      },
      undefined,
      tx,
    );
  }
}

/** A SCORO money cell, "1,234.50" or "1234.50"; empty is 0. */
function scoroAmount(value: string | null): Prisma.Decimal {
  const v = (value ?? '').replace(/,/g, '').trim();
  return v && !Number.isNaN(Number(v)) ? new Prisma.Decimal(v) : new Prisma.Decimal(0);
}

export const scoroInvoicesImport: Registered = {
  spec: scoroInvoiceSpec as unknown as ImportSpec<never>,
  permission: 'gops.sales_orders.create',
  write: writeScoroInvoices as unknown as Registered['write'],
};

/** The spec and the writer by their own names, so verify-sales drives exactly what the route runs. */
export { scoroInvoiceSpec, writeScoroInvoices };
