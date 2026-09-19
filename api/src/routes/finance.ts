import { Router } from 'express';
import { z } from 'zod';
import { Prisma, InvoiceStatus, BillStatus, ExpenseStatus, PaymentKind } from '@prisma/client';
import { prisma } from '../prisma';
import {
  handler,
  parseBody,
  listQuery,
  listResult,
  orderBy,
  notFound,
  badRequest,
  forbidden,
} from '../http/kit';
import { authenticate, require_, requireAny, currentUser } from '../auth/middleware';
import { audit } from '../shared/audit';
import { nextNumber } from '../shared/numbering';
import { notify } from '../shared/notifications';
import { submitForApproval, onApprovalSettled } from '../shared/approvals';
import { postJobCost } from '../shared/inventory';
import {
  cents,
  D,
  num,
  taxBreakdown,
  currentRates,
  financeSettings,
  saveFinanceSettings,
  addDays,
  dayKey,
  daysBetween,
  settleable,
  refreshSettlement,
  bucketFor,
  summarise,
  type AgedRow,
  type SettleableKind,
} from '../shared/finance';

function asEnum<T extends Record<string, string>>(e: T, value: string | undefined): T[keyof T] | undefined {
  return value && value in e ? (value as T[keyof T]) : undefined;
}

function asDate(value: string, label: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw badRequest(`${label} is not a valid date`);
  return dayKey(date);
}

// ════════════════════════════════════════════════════════════════════
//  ACCOUNTS RECEIVABLE — invoices
// ════════════════════════════════════════════════════════════════════

export const invoiceRoutes = Router();
invoiceRoutes.use(authenticate);

const invoiceInclude = {
  customer: { select: { id: true, code: true, name: true } },
  job: { select: { id: true, number: true, name: true } },
  progressBilling: { select: { id: true, number: true, billingNo: true } },
  lines: { orderBy: { sortOrder: 'asc' } },
} satisfies Prisma.InvoiceInclude;

type InvoiceRow = Prisma.InvoiceGetPayload<{ include: typeof invoiceInclude }>;

function presentInvoice(row: InvoiceRow) {
  const netCollectible = num(row.netCollectible);
  const collected = num(row.amountCollected);
  return {
    ...row,
    grossAmount: num(row.grossAmount),
    vatRate: num(row.vatRate),
    vatAmount: num(row.vatAmount),
    ewtRate: num(row.ewtRate),
    ewtAmount: num(row.ewtAmount),
    invoiceTotal: num(row.invoiceTotal),
    netCollectible,
    amountCollected: collected,
    // The number every A/R screen actually needs. Measured against net
    // collectible, because the withheld EWT is never going to arrive as cash.
    outstanding: cents(netCollectible - collected),
    daysOverdue: daysBetween(row.dueDate, new Date()),
    lines: row.lines.map((l) => ({ ...l, amount: num(l.amount) })),
  };
}

invoiceRoutes.get(
  '/',
  require_('gfin.ar.view_all'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const where: Prisma.InvoiceWhereInput = {};

    const status = asEnum(InvoiceStatus, q.filters.status);
    if (status) where.status = status;
    if (q.filters.customerId) where.customerId = q.filters.customerId;
    if (q.filters.jobId) where.jobId = q.filters.jobId;
    if (q.filters.from || q.filters.to) {
      where.invoiceDate = {};
      if (q.filters.from) where.invoiceDate.gte = new Date(q.filters.from);
      if (q.filters.to) where.invoiceDate.lte = new Date(q.filters.to);
    }
    // "Outstanding" is not a status — a partially paid invoice and an issued
    // one are both outstanding, and a paid one never is.
    if (q.filters.outstanding === 'true') {
      where.status = { in: ['ISSUED', 'PARTIALLY_PAID'] };
    }
    if (q.filters.overdue === 'true') {
      where.status = { in: ['ISSUED', 'PARTIALLY_PAID'] };
      where.dueDate = { lt: dayKey(new Date()) };
    }
    if (q.search) {
      where.OR = [
        { number: { contains: q.search, mode: 'insensitive' } },
        { poReference: { contains: q.search, mode: 'insensitive' } },
        { customer: { name: { contains: q.search, mode: 'insensitive' } } },
        { job: { number: { contains: q.search, mode: 'insensitive' } } },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.invoice.findMany({
        where,
        include: invoiceInclude,
        orderBy: orderBy(q, ['number', 'invoiceDate', 'dueDate', 'createdAt'], { invoiceDate: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.invoice.count({ where }),
    ]);

    res.json(listResult(rows.map(presentInvoice), total, q));
  }),
);

invoiceRoutes.get(
  '/:id',
  require_('gfin.ar.view_all'),
  handler(async (req, res) => {
    const row = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      include: {
        ...invoiceInclude,
        allocations: {
          include: {
            payment: {
              select: {
                id: true,
                number: true,
                paymentDate: true,
                method: true,
                reference: true,
                clearedAt: true,
              },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!row) throw notFound('Invoice not found');

    res.json({
      ...presentInvoice(row),
      allocations: row.allocations.map((a) => ({ ...a, amount: num(a.amount) })),
    });
  }),
);

/**
 * Raising an invoice from an approved progress billing.
 *
 * Everything is carried from the billing — gross, both rates, both tax amounts,
 * the line breakdown. Nothing is recomputed, because the billing already
 * snapshotted the rates it was issued under and an invoice raised months later
 * must not silently use today's VAT (model §4.6: finance consumes, it does not
 * re-key).
 */
invoiceRoutes.post(
  '/from-billing/:billingId',
  require_('gfin.ar.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(
      z.object({
        invoiceDate: z.string().optional(),
        dueDate: z.string().optional(),
        terms: z.string().optional().nullable(),
        poReference: z.string().optional().nullable(),
        notes: z.string().optional().nullable(),
      }),
      req.body,
    );

    const billing = await prisma.progressBilling.findUnique({
      where: { id: req.params.billingId },
      include: {
        job: { select: { id: true, number: true, name: true, customerId: true } },
        lines: { include: { scopeItem: true } },
        invoice: { select: { id: true, number: true } },
      },
    });
    if (!billing) throw notFound('Progress billing not found');
    if (billing.status !== 'APPROVED' && billing.status !== 'INVOICED') {
      throw badRequest(
        `${billing.number} is ${billing.status.toLowerCase().replace(/_/g, ' ')}. Only an approved billing can be invoiced.`,
      );
    }
    if (billing.invoice) {
      throw badRequest(
        `${billing.number} has already been invoiced as ${billing.invoice.number}. Raise a credit note against that instead of a second invoice.`,
      );
    }

    const settings = await financeSettings();
    const invoiceDate = body.invoiceDate ? asDate(body.invoiceDate, 'Invoice date') : dayKey(new Date());
    const dueDate = body.dueDate
      ? asDate(body.dueDate, 'Due date')
      : addDays(invoiceDate, settings.defaultTermsDays);
    if (dueDate < invoiceDate) throw badRequest('The due date is before the invoice date');

    const invoice = await prisma.$transaction(async (tx) => {
      const number = await nextNumber('invoice', tx);
      const created = await tx.invoice.create({
        data: {
          number,
          customerId: billing.job.customerId,
          jobId: billing.jobId,
          progressBillingId: billing.id,
          invoiceDate,
          dueDate,
          terms: body.terms ?? `${settings.defaultTermsDays} days`,
          poReference: body.poReference || null,
          // Carried, not recomputed.
          grossAmount: billing.grossAmount,
          vatRate: billing.vatRate,
          vatAmount: billing.vatAmount,
          ewtRate: billing.ewtRate,
          ewtAmount: billing.ewtAmount,
          invoiceTotal: billing.invoiceTotal,
          netCollectible: billing.netCollectible,
          notes: body.notes || null,
          createdById: me.id,
          lines: {
            create: billing.lines.map((line, i) => ({
              sortOrder: i,
              description: line.scopeItem?.name ?? 'Progress billing',
              detail: `${num(line.toDatePct)}% complete to date (${num(line.previousPct)}% already billed)`,
              amount: line.thisPeriodAmount,
            })),
          },
        },
        include: invoiceInclude,
      });

      await tx.progressBilling.update({ where: { id: billing.id }, data: { status: 'INVOICED' } });
      return created;
    });

    await audit(
      {
        entityType: 'invoice',
        entityId: invoice.id,
        action: 'CREATED',
        summary: `${invoice.number} raised from ${billing.number} — ${num(invoice.invoiceTotal)} invoiced, ${num(invoice.netCollectible)} collectible`,
      },
      req,
    );
    res.status(201).json(presentInvoice(invoice));
  }),
);

/** A standalone invoice, for work with no progress billing behind it. */
const manualInvoiceSchema = z.object({
  customerId: z.string().min(1, 'Which customer?'),
  jobId: z.string().optional().nullable(),
  invoiceDate: z.string().optional(),
  dueDate: z.string().optional(),
  terms: z.string().optional().nullable(),
  poReference: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  vatRate: z.number().min(0).max(1).optional(),
  ewtRate: z.number().min(0).max(1).optional(),
  lines: z
    .array(
      z.object({
        description: z.string().trim().min(1, 'Every line needs a description'),
        detail: z.string().optional().nullable(),
        amount: z.number(),
      }),
    )
    .min(1, 'An invoice needs at least one line'),
});

invoiceRoutes.post(
  '/',
  require_('gfin.ar.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(manualInvoiceSchema, req.body);
    const settings = await financeSettings();
    const rates = await currentRates();

    const gross = cents(body.lines.reduce((s, l) => s + l.amount, 0));
    if (gross <= 0) throw badRequest('The invoice total must be more than zero');

    const tax = taxBreakdown(gross, body.vatRate ?? rates.vatRate, body.ewtRate ?? rates.ewtRate);
    const invoiceDate = body.invoiceDate ? asDate(body.invoiceDate, 'Invoice date') : dayKey(new Date());
    const dueDate = body.dueDate
      ? asDate(body.dueDate, 'Due date')
      : addDays(invoiceDate, settings.defaultTermsDays);
    if (dueDate < invoiceDate) throw badRequest('The due date is before the invoice date');

    const invoice = await prisma.$transaction(async (tx) => {
      const number = await nextNumber('invoice', tx);
      return tx.invoice.create({
        data: {
          number,
          customerId: body.customerId,
          jobId: body.jobId || null,
          invoiceDate,
          dueDate,
          terms: body.terms ?? `${settings.defaultTermsDays} days`,
          poReference: body.poReference || null,
          grossAmount: D(tax.grossAmount),
          vatRate: D(tax.vatRate),
          vatAmount: D(tax.vatAmount),
          ewtRate: D(tax.ewtRate),
          ewtAmount: D(tax.ewtAmount),
          invoiceTotal: D(tax.invoiceTotal),
          netCollectible: D(tax.netCollectible),
          notes: body.notes || null,
          createdById: me.id,
          lines: {
            create: body.lines.map((l, i) => ({
              sortOrder: i,
              description: l.description,
              detail: l.detail || null,
              amount: D(l.amount),
            })),
          },
        },
        include: invoiceInclude,
      });
    });

    await audit(
      { entityType: 'invoice', entityId: invoice.id, action: 'CREATED', summary: `${invoice.number} raised` },
      req,
    );
    res.status(201).json(presentInvoice(invoice));
  }),
);

/** Issuing is the act of sending it. Until then it is a draft nobody owes. */
invoiceRoutes.post(
  '/:id/issue',
  require_('gfin.ar.edit_all'),
  handler(async (req, res) => {
    const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!invoice) throw notFound('Invoice not found');
    if (invoice.status !== 'DRAFT') throw badRequest('This invoice has already been issued');

    const updated = await prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: 'ISSUED', issuedAt: new Date() },
      include: invoiceInclude,
    });

    await audit(
      {
        entityType: 'invoice',
        entityId: invoice.id,
        action: 'SUBMITTED',
        summary: `${invoice.number} issued — ${num(invoice.netCollectible)} collectible, due ${invoice.dueDate.toISOString().slice(0, 10)}`,
      },
      req,
    );
    res.json(presentInvoice(updated));
  }),
);

/** Recording the BIR 2307 that makes the withheld tax creditable. */
invoiceRoutes.patch(
  '/:id/certificate',
  require_('gfin.ar.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(
      z.object({
        ewtCertificateNo: z.string().trim().min(1).nullable(),
        ewtCertificateAt: z.string().optional().nullable(),
      }),
      req.body,
    );
    const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!invoice) throw notFound('Invoice not found');
    if (num(invoice.ewtAmount) <= 0) {
      throw badRequest('Nothing was withheld on this invoice, so there is no certificate to record');
    }

    const updated = await prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        ewtCertificateNo: body.ewtCertificateNo,
        ewtCertificateAt: body.ewtCertificateAt ? asDate(body.ewtCertificateAt, 'Certificate date') : null,
      },
      include: invoiceInclude,
    });

    await audit(
      {
        entityType: 'invoice',
        entityId: invoice.id,
        action: 'UPDATED',
        summary: body.ewtCertificateNo
          ? `BIR 2307 ${body.ewtCertificateNo} recorded for ${invoice.number} — ${num(invoice.ewtAmount)} creditable`
          : `BIR 2307 cleared on ${invoice.number}`,
      },
      req,
    );
    res.json(presentInvoice(updated));
  }),
);

invoiceRoutes.post(
  '/:id/cancel',
  require_('gfin.ar.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(z.object({ reason: z.string().trim().min(3, 'Why?') }), req.body);
    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      include: { allocations: true },
    });
    if (!invoice) throw notFound('Invoice not found');
    if (invoice.allocations.length) {
      throw badRequest(
        'Payments have been applied to this invoice. Remove the allocations first — cancelling it would leave money pointing at nothing.',
      );
    }
    if (invoice.status === 'CANCELLED') throw badRequest('Already cancelled');

    await prisma.$transaction(async (tx) => {
      await tx.invoice.update({
        where: { id: invoice.id },
        data: { status: 'CANCELLED', voidedAt: new Date(), voidReason: body.reason },
      });
      // The billing goes back to approved so it can be invoiced again — the
      // point of cancelling is usually that the invoice was wrong, not the work.
      if (invoice.progressBillingId) {
        await tx.invoice.update({ where: { id: invoice.id }, data: { progressBillingId: null } });
        await tx.progressBilling.update({
          where: { id: invoice.progressBillingId },
          data: { status: 'APPROVED' },
        });
      }
    });

    await audit(
      {
        entityType: 'invoice',
        entityId: invoice.id,
        action: 'CANCELLED',
        summary: `${invoice.number} cancelled — ${body.reason}`,
      },
      req,
    );
    res.json({ ok: true });
  }),
);

/** Approved billings with no invoice yet — the A/R work queue. */
invoiceRoutes.get(
  '/queue/uninvoiced',
  require_('gfin.ar.view_all'),
  handler(async (_req, res) => {
    const billings = await prisma.progressBilling.findMany({
      where: { status: 'APPROVED', invoice: null },
      include: {
        job: {
          select: {
            id: true,
            number: true,
            name: true,
            customer: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { billingDate: 'asc' },
    });

    res.json(
      billings.map((b) => ({
        id: b.id,
        number: b.number,
        billingNo: b.billingNo,
        billingDate: b.billingDate,
        job: b.job,
        grossAmount: num(b.grossAmount),
        invoiceTotal: num(b.invoiceTotal),
        netCollectible: num(b.netCollectible),
        waitingDays: daysBetween(b.billingDate, new Date()),
      })),
    );
  }),
);

// ════════════════════════════════════════════════════════════════════
//  ACCOUNTS PAYABLE — supplier bills
// ════════════════════════════════════════════════════════════════════

export const billRoutes = Router();
billRoutes.use(authenticate);

const billInclude = {
  supplier: { select: { id: true, code: true, name: true } },
  order: { select: { id: true, number: true, kind: true } },
  receiving: { select: { id: true, number: true, receivedDate: true } },
  job: { select: { id: true, number: true, name: true } },
  costCategory: { select: { id: true, name: true } },
  lines: { orderBy: { sortOrder: 'asc' } },
} satisfies Prisma.SupplierBillInclude;

type BillRow = Prisma.SupplierBillGetPayload<{ include: typeof billInclude }>;

function presentBill(row: BillRow) {
  const netPayable = num(row.netPayable);
  const paid = num(row.amountPaid);
  return {
    ...row,
    subtotal: num(row.subtotal),
    vatRate: num(row.vatRate),
    vatAmount: num(row.vatAmount),
    total: num(row.total),
    ewtRate: num(row.ewtRate),
    ewtAmount: num(row.ewtAmount),
    netPayable,
    amountPaid: paid,
    outstanding: cents(netPayable - paid),
    daysOverdue: daysBetween(row.dueDate, new Date()),
    lines: row.lines.map((l) => ({
      ...l,
      quantity: num(l.quantity),
      unitPrice: num(l.unitPrice),
      amount: num(l.amount),
    })),
  };
}

billRoutes.get(
  '/',
  require_('gfin.ap.view_all'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const where: Prisma.SupplierBillWhereInput = {};

    const status = asEnum(BillStatus, q.filters.status);
    if (status) where.status = status;
    if (q.filters.supplierId) where.supplierId = q.filters.supplierId;
    if (q.filters.jobId) where.jobId = q.filters.jobId;
    if (q.filters.outstanding === 'true') where.status = { in: ['APPROVED', 'PARTIALLY_PAID'] };
    if (q.filters.overdue === 'true') {
      where.status = { in: ['APPROVED', 'PARTIALLY_PAID'] };
      where.dueDate = { lt: dayKey(new Date()) };
    }
    if (q.search) {
      where.OR = [
        { number: { contains: q.search, mode: 'insensitive' } },
        { supplierInvoiceNo: { contains: q.search, mode: 'insensitive' } },
        { supplier: { name: { contains: q.search, mode: 'insensitive' } } },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.supplierBill.findMany({
        where,
        include: billInclude,
        orderBy: orderBy(q, ['number', 'billDate', 'dueDate', 'createdAt'], { billDate: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.supplierBill.count({ where }),
    ]);

    res.json(listResult(rows.map(presentBill), total, q));
  }),
);

billRoutes.get(
  '/:id',
  require_('gfin.ap.view_all'),
  handler(async (req, res) => {
    const row = await prisma.supplierBill.findUnique({
      where: { id: req.params.id },
      include: {
        ...billInclude,
        allocations: {
          include: {
            payment: {
              select: { id: true, number: true, paymentDate: true, method: true, reference: true },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!row) throw notFound('Supplier bill not found');
    res.json({
      ...presentBill(row),
      allocations: row.allocations.map((a) => ({ ...a, amount: num(a.amount) })),
    });
  }),
);

const billSchema = z.object({
  supplierId: z.string().min(1, 'Which supplier?'),
  orderId: z.string().optional().nullable(),
  receivingId: z.string().optional().nullable(),
  jobId: z.string().optional().nullable(),
  costCategoryId: z.string().optional().nullable(),
  supplierInvoiceNo: z.string().optional().nullable(),
  billDate: z.string().optional(),
  dueDate: z.string().optional(),
  terms: z.string().optional().nullable(),
  vatRate: z.number().min(0).max(1).optional(),
  vatInclusive: z.boolean().default(false),
  ewtRate: z.number().min(0).max(1).default(0),
  notes: z.string().optional().nullable(),
  lines: z
    .array(
      z.object({
        description: z.string().trim().min(1, 'Every line needs a description'),
        quantity: z.number().default(1),
        unitPrice: z.number(),
      }),
    )
    .min(1, 'A bill needs at least one line'),
});

billRoutes.post(
  '/',
  require_('gfin.ap.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(billSchema, req.body);
    const settings = await financeSettings();
    const rates = await currentRates();

    const vatRate = body.vatRate ?? rates.vatRate;
    const lines = body.lines.map((l, i) => ({
      sortOrder: i,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      amount: cents(l.quantity * l.unitPrice),
    }));
    const lineTotal = cents(lines.reduce((s, l) => s + l.amount, 0));
    if (lineTotal <= 0) throw badRequest('The bill total must be more than zero');

    // A supplier's invoice may quote VAT-inclusive prices. Back it out rather
    // than adding VAT on top of VAT.
    const subtotal = body.vatInclusive ? cents(lineTotal / (1 + vatRate)) : lineTotal;
    const vatAmount = cents(subtotal * vatRate);
    const total = cents(subtotal + vatAmount);
    // Withheld on the subtotal, never on the VAT — the same rule as the
    // receivable side, in the other direction.
    const ewtAmount = cents(subtotal * body.ewtRate);
    const netPayable = cents(total - ewtAmount);

    const billDate = body.billDate ? asDate(body.billDate, 'Bill date') : dayKey(new Date());
    const dueDate = body.dueDate
      ? asDate(body.dueDate, 'Due date')
      : addDays(billDate, settings.defaultTermsDays);
    if (dueDate < billDate) throw badRequest('The due date is before the bill date');

    // Inherit the job and category from the order where they are not given —
    // the point of raising a bill against an order is not retyping it.
    let jobId = body.jobId ?? null;
    let receivingId = body.receivingId ?? null;
    if (body.orderId) {
      const order = await prisma.purchaseOrder.findUnique({
        where: { id: body.orderId },
        include: { receivings: { select: { id: true }, orderBy: { receivedDate: 'desc' } } },
      });
      if (!order) throw notFound('Purchase order not found');
      if (order.supplierId !== body.supplierId) {
        throw badRequest('That order belongs to a different supplier');
      }
      if (!jobId) jobId = order.jobId;
      // If the goods have been received and nobody said which receiving, take
      // the latest: what matters is that a receiving EXISTS, because that is
      // what stops the bill posting cost a second time.
      if (!receivingId && order.receivings.length) receivingId = order.receivings[0].id;
    }

    const bill = await prisma.$transaction(async (tx) => {
      const number = await nextNumber('supplier_bill', tx);
      return tx.supplierBill.create({
        data: {
          number,
          supplierId: body.supplierId,
          orderId: body.orderId || null,
          receivingId,
          jobId,
          costCategoryId: body.costCategoryId || null,
          supplierInvoiceNo: body.supplierInvoiceNo || null,
          billDate,
          dueDate,
          terms: body.terms ?? `${settings.defaultTermsDays} days`,
          subtotal: D(subtotal),
          vatRate: D(vatRate),
          vatAmount: D(vatAmount),
          total: D(total),
          ewtRate: D(body.ewtRate),
          ewtAmount: D(ewtAmount),
          netPayable: D(netPayable),
          notes: body.notes || null,
          createdById: me.id,
          lines: { create: lines.map((l) => ({ ...l, quantity: D(l.quantity), unitPrice: D(l.unitPrice), amount: D(l.amount) })) },
        },
        include: billInclude,
      });
    });

    await audit(
      {
        entityType: 'supplier_bill',
        entityId: bill.id,
        action: 'CREATED',
        summary: `${bill.number} from ${bill.supplier.name} — ${total} total, ${netPayable} payable`,
      },
      req,
    );
    res.status(201).json(presentBill(bill));
  }),
);

billRoutes.post(
  '/:id/submit',
  require_('gfin.ap.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const bill = await prisma.supplierBill.findUnique({
      where: { id: req.params.id },
      include: { supplier: true },
    });
    if (!bill) throw notFound('Supplier bill not found');
    if (bill.status !== 'DRAFT') throw badRequest('This bill has already been submitted');

    await prisma.supplierBill.update({ where: { id: bill.id }, data: { status: 'PENDING_APPROVAL' } });

    await submitForApproval({
      documentType: 'supplier_bill',
      documentId: bill.id,
      documentNumber: bill.number,
      subject: `${bill.supplier.name} — ${bill.supplierInvoiceNo ?? bill.number}`,
      amount: num(bill.total),
      link: `/g-fin/ap/${bill.id}`,
      requesterId: me.id,
    });

    res.json({ ok: true });
  }),
);

/**
 * An approved bill posts job cost ONLY when nothing has already incurred it.
 *
 * Receiving posts INCURRED at the moment the goods arrive (Phase 5). A bill for
 * those same goods is the paperwork catching up, not a second cost. But a bill
 * with no receiving behind it — a subcontractor's certificate, a service call,
 * a hauling charge — is the first and only time that cost appears, so it must
 * post.
 *
 * Getting this wrong charges a project twice for the same peso, which is the
 * single most common defect in this codebase's problem space.
 */
onApprovalSettled('supplier_bill', async (approval, outcome) => {
  const bill = await prisma.supplierBill.findUnique({
    where: { id: approval.documentId },
    include: { supplier: true, job: true, receiving: true },
  });
  if (!bill) return;

  if (outcome !== 'APPROVED') {
    await prisma.supplierBill.update({ where: { id: bill.id }, data: { status: 'CANCELLED' } });
    await audit({
      entityType: 'supplier_bill',
      entityId: bill.id,
      action: 'REJECTED',
      summary: `${bill.number} rejected — nothing posted, nothing payable`,
    });
    return;
  }

  const alreadyIncurred = bill.receivingId !== null;
  const postable = !alreadyIncurred && bill.jobId && bill.costCategoryId && num(bill.subtotal) > 0;

  await prisma.$transaction(async (tx) => {
    await tx.supplierBill.update({
      where: { id: bill.id },
      data: {
        status: 'APPROVED',
        approvedAt: new Date(),
        postedToJob: !!postable,
        postedAt: postable ? new Date() : null,
      },
    });

    if (postable) {
      // Net of VAT: input VAT is recoverable, so the project bears the
      // subtotal. The same basis Phase 5's receiving uses.
      await postJobCost(tx, {
        jobId: bill.jobId!,
        costCategoryId: bill.costCategoryId!,
        state: 'INCURRED',
        amount: num(bill.subtotal),
        sourceType: 'supplier_bill',
        sourceId: bill.id,
        sourceNumber: bill.number,
        description: `${bill.supplier.name} — ${bill.supplierInvoiceNo ?? 'bill'}`,
      });
    }
  });

  await audit({
    entityType: 'supplier_bill',
    entityId: bill.id,
    action: 'APPROVED',
    summary: postable
      ? `${bill.number} approved — ${num(bill.subtotal)} charged to ${bill.job?.number}`
      : alreadyIncurred
        ? `${bill.number} approved — no cost posted, ${bill.receiving?.number} already incurred it`
        : `${bill.number} approved — no project or category, so nothing was charged`,
  });
});

/** Purchase orders with goods received and no bill yet — the A/P work queue. */
billRoutes.get(
  '/queue/unbilled',
  require_('gfin.ap.view_all'),
  handler(async (_req, res) => {
    const receivings = await prisma.receiving.findMany({
      where: { bills: { none: {} } },
      include: {
        order: {
          select: {
            id: true,
            number: true,
            total: true,
            supplier: { select: { id: true, name: true } },
            job: { select: { id: true, number: true, name: true } },
          },
        },
        items: { select: { quantity: true, unitCost: true } },
      },
      orderBy: { receivedDate: 'asc' },
      take: 100,
    });

    res.json(
      receivings.map((r) => ({
        id: r.id,
        number: r.number,
        receivedDate: r.receivedDate,
        invoiceRefNo: r.invoiceRefNo,
        order: { ...r.order, total: num(r.order.total) },
        receivedValue: cents(r.items.reduce((s, i) => s + num(i.quantity) * num(i.unitCost), 0)),
        waitingDays: daysBetween(r.receivedDate, new Date()),
      })),
    );
  }),
);

// ════════════════════════════════════════════════════════════════════
//  EXPENSE CLAIMS
// ════════════════════════════════════════════════════════════════════

export const expenseRoutes = Router();
expenseRoutes.use(authenticate);

const claimInclude = {
  claimedBy: { select: { id: true, name: true, email: true } },
  job: { select: { id: true, number: true, name: true } },
  costCategory: { select: { id: true, name: true } },
  lines: { orderBy: { sortOrder: 'asc' } },
} satisfies Prisma.ExpenseClaimInclude;

type ClaimRow = Prisma.ExpenseClaimGetPayload<{ include: typeof claimInclude }>;

function presentClaim(row: ClaimRow) {
  const total = num(row.total);
  const paid = num(row.amountPaid);
  return {
    ...row,
    total,
    amountPaid: paid,
    outstanding: cents(total - paid),
    lines: row.lines.map((l) => ({ ...l, amount: num(l.amount) })),
  };
}

expenseRoutes.get(
  '/',
  requireAny('gfin.expenses.view_all', 'gfin.expenses.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const where: Prisma.ExpenseClaimWhereInput = {};

    const onlyOwn = !me.isSuperAdmin && !me.permissions.has('gfin.expenses.view_all');
    if (onlyOwn || q.scope === 'mine') where.claimedById = me.id;

    const status = asEnum(ExpenseStatus, q.filters.status);
    if (status) where.status = status;
    if (q.filters.jobId) where.jobId = q.filters.jobId;
    if (q.search) {
      where.OR = [
        { number: { contains: q.search, mode: 'insensitive' } },
        { purpose: { contains: q.search, mode: 'insensitive' } },
        { claimedBy: { name: { contains: q.search, mode: 'insensitive' } } },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.expenseClaim.findMany({
        where,
        include: claimInclude,
        orderBy: orderBy(q, ['number', 'claimDate', 'createdAt'], { claimDate: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.expenseClaim.count({ where }),
    ]);

    res.json(listResult(rows.map(presentClaim), total, q));
  }),
);

expenseRoutes.get(
  '/:id',
  requireAny('gfin.expenses.view_all', 'gfin.expenses.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await prisma.expenseClaim.findUnique({
      where: { id: req.params.id },
      include: {
        ...claimInclude,
        allocations: {
          include: { payment: { select: { id: true, number: true, paymentDate: true, method: true } } },
        },
      },
    });
    if (!row) throw notFound('Expense claim not found');
    if (
      row.claimedById !== me.id &&
      !me.isSuperAdmin &&
      !me.permissions.has('gfin.expenses.view_all')
    ) {
      throw forbidden('That is someone else’s claim');
    }
    res.json({
      ...presentClaim(row),
      allocations: row.allocations.map((a) => ({ ...a, amount: num(a.amount) })),
    });
  }),
);

const claimSchema = z.object({
  claimDate: z.string().optional(),
  purpose: z.string().trim().min(3, 'What was the expense for?'),
  jobId: z.string().optional().nullable(),
  costCategoryId: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  lines: z
    .array(
      z.object({
        spentOn: z.string().min(1, 'When was it spent?'),
        description: z.string().trim().min(1, 'Every line needs a description'),
        category: z.string().optional().nullable(),
        receiptNo: z.string().optional().nullable(),
        amount: z.number().positive('Every line must be more than zero'),
      }),
    )
    .min(1, 'A claim needs at least one line'),
});

expenseRoutes.post(
  '/',
  require_('gfin.expenses.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(claimSchema, req.body);

    const total = cents(body.lines.reduce((s, l) => s + l.amount, 0));
    const claim = await prisma.$transaction(async (tx) => {
      const number = await nextNumber('expense', tx);
      return tx.expenseClaim.create({
        data: {
          number,
          claimedById: me.id,
          jobId: body.jobId || null,
          costCategoryId: body.costCategoryId || null,
          claimDate: body.claimDate ? asDate(body.claimDate, 'Claim date') : dayKey(new Date()),
          purpose: body.purpose,
          total: D(total),
          notes: body.notes || null,
          lines: {
            create: body.lines.map((l, i) => ({
              sortOrder: i,
              spentOn: asDate(l.spentOn, 'Spent on'),
              description: l.description,
              category: l.category || null,
              receiptNo: l.receiptNo || null,
              amount: D(l.amount),
            })),
          },
        },
        include: claimInclude,
      });
    });

    await audit(
      {
        entityType: 'expense_claim',
        entityId: claim.id,
        action: 'CREATED',
        summary: `${claim.number} — ${total} claimed for ${body.purpose}`,
      },
      req,
    );
    res.status(201).json(presentClaim(claim));
  }),
);

expenseRoutes.post(
  '/:id/submit',
  require_('gfin.expenses.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const claim = await prisma.expenseClaim.findUnique({
      where: { id: req.params.id },
      include: { lines: true },
    });
    if (!claim) throw notFound('Expense claim not found');
    if (claim.claimedById !== me.id && !me.isSuperAdmin) throw forbidden('That is someone else’s claim');
    if (claim.status !== 'DRAFT') throw badRequest('This claim has already been submitted');

    // A claim without receipt numbers is not claimable, and finding that out at
    // approval time wastes the approver's round trip.
    const missing = claim.lines.filter((l) => !l.receiptNo).length;
    if (missing > 0) {
      throw badRequest(
        `${missing} line${missing === 1 ? ' has' : 's have'} no receipt number. Finance needs an OR against every peso.`,
      );
    }

    await prisma.expenseClaim.update({ where: { id: claim.id }, data: { status: 'PENDING_APPROVAL' } });

    await submitForApproval({
      documentType: 'expense',
      documentId: claim.id,
      documentNumber: claim.number,
      subject: `${me.name} — ${claim.purpose}`,
      amount: num(claim.total),
      link: `/g-fin/expenses/${claim.id}`,
      requesterId: me.id,
    });

    res.json({ ok: true });
  }),
);

/** An approved claim is money owed to a person, and cost owed by a job. */
onApprovalSettled('expense', async (approval, outcome) => {
  const claim = await prisma.expenseClaim.findUnique({
    where: { id: approval.documentId },
    include: { claimedBy: true, job: true },
  });
  if (!claim) return;

  if (outcome !== 'APPROVED') {
    await prisma.expenseClaim.update({ where: { id: claim.id }, data: { status: 'REJECTED' } });
    await audit({
      entityType: 'expense_claim',
      entityId: claim.id,
      action: 'REJECTED',
      summary: `${claim.number} rejected — nothing posted, nothing reimbursable`,
    });
    return;
  }

  const postable = claim.jobId && claim.costCategoryId && num(claim.total) > 0;

  await prisma.$transaction(async (tx) => {
    await tx.expenseClaim.update({
      where: { id: claim.id },
      data: {
        status: 'APPROVED',
        approvedAt: new Date(),
        postedToJob: !!postable,
        postedAt: postable ? new Date() : null,
      },
    });
    if (postable) {
      await postJobCost(tx, {
        jobId: claim.jobId!,
        costCategoryId: claim.costCategoryId!,
        state: 'INCURRED',
        amount: num(claim.total),
        sourceType: 'expense_claim',
        sourceId: claim.id,
        sourceNumber: claim.number,
        description: `${claim.claimedBy.name} — ${claim.purpose}`,
      });
    }
  });

  await notify({
    userId: claim.claimedById,
    type: 'approval.approved',
    title: `${claim.number} approved`,
    body: `${num(claim.total)} is due back to you. Finance will reimburse it.`,
    link: `/g-fin/expenses/${claim.id}`,
  });

  await audit({
    entityType: 'expense_claim',
    entityId: claim.id,
    action: 'APPROVED',
    summary: postable
      ? `${claim.number} approved — ${num(claim.total)} charged to ${claim.job?.number} and owed to ${claim.claimedBy.name}`
      : `${claim.number} approved — ${num(claim.total)} owed to ${claim.claimedBy.name}, no project charged`,
  });
});

expenseRoutes.post(
  '/:id/cancel',
  handler(async (req, res) => {
    const me = currentUser(req);
    const claim = await prisma.expenseClaim.findUnique({
      where: { id: req.params.id },
      include: { allocations: true },
    });
    if (!claim) throw notFound('Expense claim not found');
    if (claim.claimedById !== me.id && !me.isSuperAdmin && !me.permissions.has('gfin.expenses.edit_all')) {
      throw forbidden('That is someone else’s claim');
    }
    if (claim.allocations.length) throw badRequest('This claim has already been reimbursed');
    if (claim.postedToJob) {
      throw badRequest(
        'This claim has already been charged to a project. Reverse it in the project ledger rather than cancelling the claim.',
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.expenseClaim.update({ where: { id: claim.id }, data: { status: 'CANCELLED' } });
      await tx.approvalRequest.updateMany({
        where: { documentType: 'expense', documentId: claim.id, status: 'PENDING' },
        data: { status: 'CANCELLED', closedAt: new Date() },
      });
    });
    res.json({ ok: true });
  }),
);

// ════════════════════════════════════════════════════════════════════
//  PAYMENTS
// ════════════════════════════════════════════════════════════════════

export const paymentRoutes = Router();
paymentRoutes.use(authenticate);

const paymentInclude = {
  customer: { select: { id: true, name: true } },
  supplier: { select: { id: true, name: true } },
  payeeUser: { select: { id: true, name: true } },
  recordedBy: { select: { id: true, name: true } },
  allocations: {
    include: {
      invoice: { select: { id: true, number: true, netCollectible: true } },
      bill: { select: { id: true, number: true, netPayable: true } },
      claim: { select: { id: true, number: true, total: true } },
    },
  },
} satisfies Prisma.PaymentInclude;

type PaymentRow = Prisma.PaymentGetPayload<{ include: typeof paymentInclude }>;

function presentPayment(row: PaymentRow) {
  return {
    ...row,
    amount: num(row.amount),
    allocations: row.allocations.map((a) => ({
      ...a,
      amount: num(a.amount),
      invoice: a.invoice ? { ...a.invoice, netCollectible: num(a.invoice.netCollectible) } : null,
      bill: a.bill ? { ...a.bill, netPayable: num(a.bill.netPayable) } : null,
      claim: a.claim ? { ...a.claim, total: num(a.claim.total) } : null,
    })),
  };
}

paymentRoutes.get(
  '/',
  requireAny('gfin.payments.view_all', 'gfin.ar.view_all', 'gfin.ap.view_all'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const where: Prisma.PaymentWhereInput = {};

    const kind = asEnum(PaymentKind, q.filters.kind);
    if (kind) where.kind = kind;
    if (q.filters.customerId) where.customerId = q.filters.customerId;
    if (q.filters.supplierId) where.supplierId = q.filters.supplierId;
    if (q.filters.from || q.filters.to) {
      where.paymentDate = {};
      if (q.filters.from) where.paymentDate.gte = new Date(q.filters.from);
      if (q.filters.to) where.paymentDate.lte = new Date(q.filters.to);
    }
    if (q.filters.uncleared === 'true') where.clearedAt = null;
    if (q.search) {
      where.OR = [
        { number: { contains: q.search, mode: 'insensitive' } },
        { reference: { contains: q.search, mode: 'insensitive' } },
        { customer: { name: { contains: q.search, mode: 'insensitive' } } },
        { supplier: { name: { contains: q.search, mode: 'insensitive' } } },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        include: paymentInclude,
        orderBy: orderBy(q, ['number', 'paymentDate', 'amount', 'createdAt'], { paymentDate: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.payment.count({ where }),
    ]);

    res.json(listResult(rows.map(presentPayment), total, q));
  }),
);

paymentRoutes.get(
  '/:id',
  requireAny('gfin.payments.view_all', 'gfin.ar.view_all', 'gfin.ap.view_all'),
  handler(async (req, res) => {
    const row = await prisma.payment.findUnique({
      where: { id: req.params.id },
      include: paymentInclude,
    });
    if (!row) throw notFound('Payment not found');
    res.json(presentPayment(row));
  }),
);

const paymentSchema = z.object({
  kind: z.enum(['RECEIPT', 'DISBURSEMENT']),
  method: z.enum(['CASH', 'CHECK', 'BANK_TRANSFER', 'ONLINE', 'OFFSET']).default('BANK_TRANSFER'),
  paymentDate: z.string().optional(),
  customerId: z.string().optional().nullable(),
  supplierId: z.string().optional().nullable(),
  payeeUserId: z.string().optional().nullable(),
  reference: z.string().optional().nullable(),
  bank: z.string().optional().nullable(),
  clearedAt: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  allocations: z
    .array(
      z.object({
        kind: z.enum(['invoice', 'bill', 'claim']),
        id: z.string().min(1),
        amount: z.number().positive('An allocation must be more than zero'),
      }),
    )
    .min(1, 'Say which documents this payment settles'),
});

/**
 * Recording money, and saying what it settles.
 *
 * A payment must be fully allocated. A cheque sitting against no invoice is
 * cash the aging report cannot see, and "we were paid but A/R still shows it
 * outstanding" is the complaint that follows.
 */
paymentRoutes.post(
  '/',
  requireAny('gfin.ar.create', 'gfin.ap.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(paymentSchema, req.body);

    // Recording money in and recording money out are different rights.
    const needed = body.kind === 'RECEIPT' ? 'gfin.ar.create' : 'gfin.ap.create';
    if (!me.isSuperAdmin && !me.permissions.has(needed)) {
      throw forbidden(`Recording a ${body.kind.toLowerCase()} needs "${needed}"`);
    }

    if (body.kind === 'RECEIPT' && body.allocations.some((a) => a.kind !== 'invoice')) {
      throw badRequest('A receipt settles customer invoices. Record money going out as a disbursement.');
    }
    if (body.kind === 'DISBURSEMENT' && body.allocations.some((a) => a.kind === 'invoice')) {
      throw badRequest('A disbursement settles supplier bills or expense claims, not customer invoices.');
    }

    const amount = cents(body.allocations.reduce((s, a) => s + a.amount, 0));
    if (amount <= 0) throw badRequest('The payment must be more than zero');

    // Every allocation is checked against what is actually still owed, before
    // anything is written. Over-applying is how a document ends up "more than
    // paid" and an aging report goes negative.
    for (const allocation of body.allocations) {
      const target = await settleable(allocation.kind as SettleableKind, allocation.id);
      if (!target) throw notFound(`That ${allocation.kind} does not exist`);
      if (allocation.amount > target.outstanding + 0.005) {
        throw badRequest(
          `${target.number} has only ${target.outstanding} outstanding, but ${allocation.amount} is being applied to it.`,
        );
      }
    }

    const payment = await prisma.$transaction(async (tx) => {
      const number = await nextNumber(body.kind === 'RECEIPT' ? 'payment' : 'disbursement', tx);
      const created = await tx.payment.create({
        data: {
          number,
          kind: body.kind,
          method: body.method,
          paymentDate: body.paymentDate ? asDate(body.paymentDate, 'Payment date') : dayKey(new Date()),
          customerId: body.customerId || null,
          supplierId: body.supplierId || null,
          payeeUserId: body.payeeUserId || null,
          amount: D(amount),
          reference: body.reference || null,
          bank: body.bank || null,
          // A cheque is a promise until it clears; a transfer is cash on the day.
          clearedAt: body.clearedAt
            ? asDate(body.clearedAt, 'Cleared date')
            : body.method === 'CHECK'
              ? null
              : body.paymentDate
                ? asDate(body.paymentDate, 'Payment date')
                : dayKey(new Date()),
          notes: body.notes || null,
          recordedById: me.id,
          allocations: {
            create: body.allocations.map((a) => ({
              invoiceId: a.kind === 'invoice' ? a.id : null,
              billId: a.kind === 'bill' ? a.id : null,
              claimId: a.kind === 'claim' ? a.id : null,
              amount: D(a.amount),
            })),
          },
        },
        include: paymentInclude,
      });

      for (const allocation of body.allocations) {
        await refreshSettlement(tx, allocation.kind as SettleableKind, allocation.id);
      }
      return created;
    });

    await audit(
      {
        entityType: 'payment',
        entityId: payment.id,
        action: 'CREATED',
        summary: `${payment.number} — ${amount} ${body.kind === 'RECEIPT' ? 'received' : 'paid'} across ${body.allocations.length} document(s)`,
      },
      req,
    );
    res.status(201).json(presentPayment(payment));
  }),
);

/** Marking a cheque cleared. Until then it is a promise, not cash. */
paymentRoutes.post(
  '/:id/clear',
  requireAny('gfin.ar.edit_all', 'gfin.ap.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(z.object({ clearedAt: z.string().optional() }), req.body);
    const payment = await prisma.payment.findUnique({ where: { id: req.params.id } });
    if (!payment) throw notFound('Payment not found');
    if (payment.clearedAt) throw badRequest('This payment has already cleared');

    const updated = await prisma.payment.update({
      where: { id: payment.id },
      data: { clearedAt: body.clearedAt ? asDate(body.clearedAt, 'Cleared date') : dayKey(new Date()) },
      include: paymentInclude,
    });
    await audit(
      { entityType: 'payment', entityId: payment.id, action: 'UPDATED', summary: `${payment.number} cleared` },
      req,
    );
    res.json(presentPayment(updated));
  }),
);

/**
 * Reversing a payment.
 *
 * Deleting the allocations and re-deriving each document is deliberate: the
 * settled totals are recomputed from the rows that remain, so nothing can be
 * left behind pointing at money that is no longer there.
 */
paymentRoutes.delete(
  '/:id',
  requireAny('gfin.ar.delete', 'gfin.ap.delete'),
  handler(async (req, res) => {
    const payment = await prisma.payment.findUnique({
      where: { id: req.params.id },
      include: { allocations: true },
    });
    if (!payment) throw notFound('Payment not found');

    const touched = payment.allocations.map((a) => ({
      kind: (a.invoiceId ? 'invoice' : a.billId ? 'bill' : 'claim') as SettleableKind,
      id: (a.invoiceId ?? a.billId ?? a.claimId)!,
    }));

    await prisma.$transaction(async (tx) => {
      await tx.payment.delete({ where: { id: payment.id } });
      for (const t of touched) await refreshSettlement(tx, t.kind, t.id);
    });

    await audit(
      {
        entityType: 'payment',
        entityId: payment.id,
        action: 'DELETED',
        summary: `${payment.number} reversed — ${num(payment.amount)} unapplied from ${touched.length} document(s)`,
      },
      req,
    );
    res.json({ ok: true });
  }),
);

/** What a customer or supplier still owes, ready to allocate against. */
paymentRoutes.get(
  '/open/:kind',
  requireAny('gfin.ar.view_all', 'gfin.ap.view_all'),
  handler(async (req, res) => {
    const kind = req.params.kind;
    const partyId = req.query.partyId ? String(req.query.partyId) : undefined;

    if (kind === 'invoice') {
      const rows = await prisma.invoice.findMany({
        where: {
          status: { in: ['ISSUED', 'PARTIALLY_PAID'] },
          ...(partyId ? { customerId: partyId } : {}),
        },
        include: invoiceInclude,
        orderBy: { dueDate: 'asc' },
      });
      res.json(rows.map(presentInvoice).filter((r) => r.outstanding > 0.005));
      return;
    }
    if (kind === 'bill') {
      const rows = await prisma.supplierBill.findMany({
        where: {
          status: { in: ['APPROVED', 'PARTIALLY_PAID'] },
          ...(partyId ? { supplierId: partyId } : {}),
        },
        include: billInclude,
        orderBy: { dueDate: 'asc' },
      });
      res.json(rows.map(presentBill).filter((r) => r.outstanding > 0.005));
      return;
    }
    if (kind === 'claim') {
      const rows = await prisma.expenseClaim.findMany({
        where: { status: 'APPROVED', ...(partyId ? { claimedById: partyId } : {}) },
        include: claimInclude,
        orderBy: { claimDate: 'asc' },
      });
      res.json(rows.map(presentClaim).filter((r) => r.outstanding > 0.005));
      return;
    }
    throw badRequest('Ask for invoice, bill or claim');
  }),
);

// ════════════════════════════════════════════════════════════════════
//  REPORTS — aging, cash flow, budget vs actual, the dashboard
// ════════════════════════════════════════════════════════════════════

export const financeReportRoutes = Router();
financeReportRoutes.use(authenticate);

/**
 * A/R aging.
 *
 * Outstanding is `netCollectible − collected`. The withheld EWT is reported in
 * its own column so it can be chased as a 2307 certificate, but it is NEVER
 * part of the overdue balance — that is the whole point (model §5.4).
 */
financeReportRoutes.get(
  '/ar-aging',
  require_('gfin.ar.view_all'),
  handler(async (req, res) => {
    const asOf = req.query.asOf ? asDate(String(req.query.asOf), 'As of') : dayKey(new Date());
    const settings = await financeSettings();

    const invoices = await prisma.invoice.findMany({
      where: { status: { in: ['ISSUED', 'PARTIALLY_PAID'] } },
      include: {
        customer: { select: { id: true, name: true } },
        job: { select: { number: true } },
      },
      orderBy: { dueDate: 'asc' },
    });

    const rows: AgedRow[] = invoices
      .map((inv) => {
        const payable = num(inv.netCollectible);
        const paid = num(inv.amountCollected);
        const outstanding = cents(payable - paid);
        const daysOverdue = daysBetween(inv.dueDate, asOf);
        return {
          id: inv.id,
          number: inv.number,
          party: inv.customer.name,
          partyId: inv.customerId,
          date: inv.invoiceDate,
          dueDate: inv.dueDate,
          daysOverdue,
          payable,
          paid,
          outstanding,
          bucket: bucketFor(daysOverdue, settings.agingBuckets),
          jobNumber: inv.job?.number ?? null,
          withheld: inv.ewtCertificateNo ? 0 : num(inv.ewtAmount),
        };
      })
      .filter((r) => r.outstanding > 0.005);

    // Per customer, so the collections call has one number per conversation.
    const byCustomer = new Map<string, { id: string; name: string; outstanding: number; overdue: number; invoices: number }>();
    for (const r of rows) {
      const entry = byCustomer.get(r.partyId) ?? {
        id: r.partyId,
        name: r.party,
        outstanding: 0,
        overdue: 0,
        invoices: 0,
      };
      entry.outstanding = cents(entry.outstanding + r.outstanding);
      if (r.daysOverdue > 0) entry.overdue = cents(entry.overdue + r.outstanding);
      entry.invoices += 1;
      byCustomer.set(r.partyId, entry);
    }

    res.json({
      asOf,
      buckets: summarise(rows, settings.agingBuckets),
      rows,
      customers: [...byCustomer.values()].sort((a, b) => b.outstanding - a.outstanding),
      totalOutstanding: cents(rows.reduce((s, r) => s + r.outstanding, 0)),
      totalOverdue: cents(rows.filter((r) => r.daysOverdue > 0).reduce((s, r) => s + r.outstanding, 0)),
      // Withheld at source and not yet certificated. Real money, but it comes
      // back as a tax credit — never chase it as an unpaid invoice.
      withheldAwaitingCertificate: cents(rows.reduce((s, r) => s + (r.withheld ?? 0), 0)),
    });
  }),
);

financeReportRoutes.get(
  '/ap-aging',
  require_('gfin.ap.view_all'),
  handler(async (req, res) => {
    const asOf = req.query.asOf ? asDate(String(req.query.asOf), 'As of') : dayKey(new Date());
    const settings = await financeSettings();

    const bills = await prisma.supplierBill.findMany({
      where: { status: { in: ['APPROVED', 'PARTIALLY_PAID'] } },
      include: {
        supplier: { select: { id: true, name: true } },
        job: { select: { number: true } },
      },
      orderBy: { dueDate: 'asc' },
    });

    const rows: AgedRow[] = bills
      .map((bill) => {
        const payable = num(bill.netPayable);
        const paid = num(bill.amountPaid);
        const daysOverdue = daysBetween(bill.dueDate, asOf);
        return {
          id: bill.id,
          number: bill.number,
          party: bill.supplier.name,
          partyId: bill.supplierId,
          date: bill.billDate,
          dueDate: bill.dueDate,
          daysOverdue,
          payable,
          paid,
          outstanding: cents(payable - paid),
          bucket: bucketFor(daysOverdue, settings.agingBuckets),
          jobNumber: bill.job?.number ?? null,
        };
      })
      .filter((r) => r.outstanding > 0.005);

    const bySupplier = new Map<string, { id: string; name: string; outstanding: number; overdue: number; bills: number }>();
    for (const r of rows) {
      const entry = bySupplier.get(r.partyId) ?? {
        id: r.partyId,
        name: r.party,
        outstanding: 0,
        overdue: 0,
        bills: 0,
      };
      entry.outstanding = cents(entry.outstanding + r.outstanding);
      if (r.daysOverdue > 0) entry.overdue = cents(entry.overdue + r.outstanding);
      entry.bills += 1;
      bySupplier.set(r.partyId, entry);
    }

    const claims = await prisma.expenseClaim.findMany({
      where: { status: 'APPROVED' },
      include: { claimedBy: { select: { id: true, name: true } } },
    });
    const unreimbursed = claims
      .map((c) => ({
        id: c.id,
        number: c.number,
        person: c.claimedBy.name,
        claimDate: c.claimDate,
        outstanding: cents(num(c.total) - num(c.amountPaid)),
      }))
      .filter((c) => c.outstanding > 0.005);

    res.json({
      asOf,
      buckets: summarise(rows, settings.agingBuckets),
      rows,
      suppliers: [...bySupplier.values()].sort((a, b) => b.outstanding - a.outstanding),
      totalOutstanding: cents(rows.reduce((s, r) => s + r.outstanding, 0)),
      totalOverdue: cents(rows.filter((r) => r.daysOverdue > 0).reduce((s, r) => s + r.outstanding, 0)),
      unreimbursedClaims: unreimbursed,
      unreimbursedTotal: cents(unreimbursed.reduce((s, c) => s + c.outstanding, 0)),
    });
  }),
);

/**
 * Cash flow — what moved, and what is due to move.
 *
 * Actuals come from cleared payments only: an uncleared cheque is a promise,
 * and a cash position that counts promises is the one that bounces. The
 * forecast comes from what is still owed, bucketed by due date.
 */
financeReportRoutes.get(
  '/cash-flow',
  require_('gfin.cashflow.view_all'),
  handler(async (req, res) => {
    const months = Math.min(24, Math.max(1, Number(req.query.months ?? 6)));
    const to = dayKey(new Date());
    const from = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - months + 1, 1));

    const payments = await prisma.payment.findMany({
      where: { clearedAt: { not: null, gte: from } },
      select: { kind: true, amount: true, clearedAt: true },
    });

    const key = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const buckets = new Map<string, { month: string; in: number; out: number }>();
    for (let i = 0; i < months; i++) {
      const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + i, 1));
      buckets.set(key(d), { month: key(d), in: 0, out: 0 });
    }
    for (const p of payments) {
      const bucket = buckets.get(key(p.clearedAt!));
      if (!bucket) continue;
      if (p.kind === 'RECEIPT') bucket.in = cents(bucket.in + num(p.amount));
      else bucket.out = cents(bucket.out + num(p.amount));
    }

    const actual = [...buckets.values()].map((b) => ({ ...b, net: cents(b.in - b.out) }));

    // Forecast: everything still owed, in or out, by when it falls due.
    const [openInvoices, openBills, openClaims, uncleared] = await Promise.all([
      prisma.invoice.findMany({
        where: { status: { in: ['ISSUED', 'PARTIALLY_PAID'] } },
        select: { dueDate: true, netCollectible: true, amountCollected: true },
      }),
      prisma.supplierBill.findMany({
        where: { status: { in: ['APPROVED', 'PARTIALLY_PAID'] } },
        select: { dueDate: true, netPayable: true, amountPaid: true },
      }),
      prisma.expenseClaim.findMany({
        where: { status: 'APPROVED' },
        select: { claimDate: true, total: true, amountPaid: true },
      }),
      prisma.payment.findMany({
        where: { clearedAt: null },
        select: { kind: true, amount: true, paymentDate: true, number: true, method: true },
      }),
    ]);

    const horizon = [
      { label: 'Overdue', from: Number.NEGATIVE_INFINITY, to: -1 },
      { label: 'Next 7 days', from: 0, to: 7 },
      { label: '8–30 days', from: 8, to: 30 },
      { label: '31–60 days', from: 31, to: 60 },
      { label: 'Beyond 60 days', from: 61, to: Number.POSITIVE_INFINITY },
    ];
    const forecast = horizon.map((h) => ({ label: h.label, in: 0, out: 0, net: 0 }));
    const place = (dueDate: Date, amount: number, direction: 'in' | 'out') => {
      if (amount <= 0.005) return;
      const days = daysBetween(to, dueDate);
      const i = horizon.findIndex((h) => days >= h.from && days <= h.to);
      if (i < 0) return;
      forecast[i][direction] = cents(forecast[i][direction] + amount);
    };

    for (const inv of openInvoices) {
      place(inv.dueDate, cents(num(inv.netCollectible) - num(inv.amountCollected)), 'in');
    }
    for (const bill of openBills) {
      place(bill.dueDate, cents(num(bill.netPayable) - num(bill.amountPaid)), 'out');
    }
    for (const claim of openClaims) {
      place(claim.claimDate, cents(num(claim.total) - num(claim.amountPaid)), 'out');
    }
    for (const f of forecast) f.net = cents(f.in - f.out);

    res.json({
      months: actual,
      forecast,
      // Cheques written or received that have not cleared. Neither in the
      // actuals nor in the forecast, and worth seeing for exactly that reason.
      uncleared: uncleared.map((p) => ({ ...p, amount: num(p.amount) })),
      unclearedIn: cents(
        uncleared.filter((p) => p.kind === 'RECEIPT').reduce((s, p) => s + num(p.amount), 0),
      ),
      unclearedOut: cents(
        uncleared.filter((p) => p.kind === 'DISBURSEMENT').reduce((s, p) => s + num(p.amount), 0),
      ),
      netMovement: cents(actual.reduce((s, m) => s + m.net, 0)),
    });
  }),
);

/**
 * Budget vs actual, per job.
 *
 * Five columns that have to be read together: what was budgeted, what is
 * committed, what has been incurred, what has been billed, and what has been
 * collected. A job can be profitable on paper and still be the reason there is
 * no cash — that is what the last two columns are for.
 */
financeReportRoutes.get(
  '/budget-vs-actual',
  require_('gfin.budget_vs_actual.view_all'),
  handler(async (req, res) => {
    const where: Prisma.JobWhereInput = { status: { notIn: ['CANCELLED'] } };
    if (req.query.jobId) where.id = String(req.query.jobId);

    const jobs = await prisma.job.findMany({
      where,
      select: {
        id: true,
        number: true,
        name: true,
        status: true,
        contractValue: true,
        customer: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const jobIds = jobs.map((j) => j.id);
    if (!jobIds.length) {
      res.json({ jobs: [], totals: null });
      return;
    }

    const [ledger, billings, invoices] = await Promise.all([
      prisma.jobCostEntry.groupBy({
        by: ['jobId', 'state'],
        where: { jobId: { in: jobIds } },
        _sum: { amount: true },
      }),
      prisma.progressBilling.groupBy({
        by: ['jobId'],
        where: { jobId: { in: jobIds }, status: { in: ['APPROVED', 'INVOICED'] } },
        _sum: { grossAmount: true },
      }),
      prisma.invoice.groupBy({
        by: ['jobId'],
        where: { jobId: { in: jobIds }, status: { not: 'CANCELLED' } },
        _sum: { netCollectible: true, amountCollected: true },
      }),
    ]);

    const state = (jobId: string, s: string) =>
      num(ledger.find((l) => l.jobId === jobId && l.state === s)?._sum.amount);

    const rows = jobs.map((job) => {
      const contractValue = num(job.contractValue);
      const budgeted = state(job.id, 'BUDGETED');
      const committed = state(job.id, 'COMMITTED');
      const incurred = state(job.id, 'INCURRED');
      const consumed = state(job.id, 'CONSUMED');
      const billed = num(billings.find((b) => b.jobId === job.id)?._sum.grossAmount);
      const inv = invoices.find((i) => i.jobId === job.id);
      const invoiced = num(inv?._sum.netCollectible);
      const collected = num(inv?._sum.amountCollected);

      return {
        job: { id: job.id, number: job.number, name: job.name, status: job.status },
        customer: job.customer,
        contractValue,
        budgeted,
        committed,
        incurred,
        consumed,
        // Available = budgeted − committed − incurred. CONSUMED is reported
        // but never subtracted: it was already incurred when it was received.
        available: cents(budgeted - committed - incurred),
        billed,
        invoiced,
        collected,
        uncollected: cents(invoiced - collected),
        // Work done but not yet billed — the commonest reason a profitable job
        // runs out of cash.
        unbilled: cents(contractValue - billed),
        expectedProfit: cents(contractValue - budgeted),
        expectedMarginPct: contractValue > 0 ? cents(((contractValue - budgeted) / contractValue) * 100) : 0,
      };
    });

    const sum = (pick: (r: (typeof rows)[number]) => number) => cents(rows.reduce((s, r) => s + pick(r), 0));

    res.json({
      jobs: rows,
      totals: {
        contractValue: sum((r) => r.contractValue),
        budgeted: sum((r) => r.budgeted),
        committed: sum((r) => r.committed),
        incurred: sum((r) => r.incurred),
        available: sum((r) => r.available),
        billed: sum((r) => r.billed),
        invoiced: sum((r) => r.invoiced),
        collected: sum((r) => r.collected),
        uncollected: sum((r) => r.uncollected),
        unbilled: sum((r) => r.unbilled),
      },
    });
  }),
);

/** The executive view: one screen, the numbers a director asks for. */
financeReportRoutes.get(
  '/dashboard',
  require_('gfin.dashboard.view_all'),
  handler(async (_req, res) => {
    const today = dayKey(new Date());
    const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    const yearStart = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));

    const [
      openInvoices,
      openBills,
      openClaims,
      receiptsThisMonth,
      receiptsThisYear,
      invoicedThisYear,
      uninvoicedBillings,
      unbilledReceivings,
      activeJobs,
    ] = await Promise.all([
      prisma.invoice.findMany({
        where: { status: { in: ['ISSUED', 'PARTIALLY_PAID'] } },
        select: { dueDate: true, netCollectible: true, amountCollected: true, ewtAmount: true, ewtCertificateNo: true },
      }),
      prisma.supplierBill.findMany({
        where: { status: { in: ['APPROVED', 'PARTIALLY_PAID'] } },
        select: { dueDate: true, netPayable: true, amountPaid: true },
      }),
      prisma.expenseClaim.aggregate({
        where: { status: 'APPROVED' },
        _sum: { total: true, amountPaid: true },
      }),
      prisma.payment.aggregate({
        where: { kind: 'RECEIPT', clearedAt: { gte: monthStart } },
        _sum: { amount: true },
      }),
      prisma.payment.aggregate({
        where: { kind: 'RECEIPT', clearedAt: { gte: yearStart } },
        _sum: { amount: true },
      }),
      prisma.invoice.aggregate({
        where: { invoiceDate: { gte: yearStart }, status: { not: 'CANCELLED' } },
        _sum: { grossAmount: true },
      }),
      prisma.progressBilling.count({ where: { status: 'APPROVED', invoice: null } }),
      prisma.receiving.count({ where: { bills: { none: {} } } }),
      prisma.job.count({ where: { status: { in: ['PLANNING', 'IN_PROGRESS'] } } }),
    ]);

    const receivable = cents(
      openInvoices.reduce((s, i) => s + (num(i.netCollectible) - num(i.amountCollected)), 0),
    );
    const receivableOverdue = cents(
      openInvoices
        .filter((i) => i.dueDate < today)
        .reduce((s, i) => s + (num(i.netCollectible) - num(i.amountCollected)), 0),
    );
    const payable = cents(openBills.reduce((s, b) => s + (num(b.netPayable) - num(b.amountPaid)), 0));
    const payableOverdue = cents(
      openBills.filter((b) => b.dueDate < today).reduce((s, b) => s + (num(b.netPayable) - num(b.amountPaid)), 0),
    );
    const reimbursable = cents(num(openClaims._sum.total) - num(openClaims._sum.amountPaid));

    res.json({
      asOf: today,
      receivable,
      receivableOverdue,
      payable,
      payableOverdue,
      reimbursable,
      // Receivable minus everything owed. Not a bank balance — G-Core does not
      // hold one — but the number that says whether collections are keeping up.
      workingPosition: cents(receivable - payable - reimbursable),
      collectedThisMonth: cents(num(receiptsThisMonth._sum.amount)),
      collectedThisYear: cents(num(receiptsThisYear._sum.amount)),
      invoicedThisYear: cents(num(invoicedThisYear._sum.grossAmount)),
      withheldAwaitingCertificate: cents(
        openInvoices.filter((i) => !i.ewtCertificateNo).reduce((s, i) => s + num(i.ewtAmount), 0),
      ),
      queue: {
        billingsAwaitingInvoice: uninvoicedBillings,
        receivingsAwaitingBill: unbilledReceivings,
      },
      activeJobs,
    });
  }),
);

// ── Settings ─────────────────────────────────────────────────────────────────

export const financeSettingsRoutes = Router();
financeSettingsRoutes.use(authenticate);

financeSettingsRoutes.get(
  '/',
  requireAny('gfin.settings.view_all', 'gfin.ar.view_all', 'gfin.ap.view_all'),
  handler(async (_req, res) => {
    const [settings, rates] = await Promise.all([financeSettings(), currentRates()]);
    res.json({ ...settings, ...rates });
  }),
);

financeSettingsRoutes.put(
  '/',
  require_('gfin.settings.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(
      z.object({
        defaultTermsDays: z.number().int().min(0).max(365).optional(),
        supplierEwtGoods: z.number().min(0).max(1).optional(),
        supplierEwtServices: z.number().min(0).max(1).optional(),
        agingBuckets: z.array(z.number().int().positive()).min(1).max(6).optional(),
      }),
      req.body,
    );

    if (body.agingBuckets) {
      const sorted = [...body.agingBuckets].sort((a, b) => a - b);
      if (sorted.join(',') !== body.agingBuckets.join(',')) {
        throw badRequest('Aging buckets must be in increasing order');
      }
    }

    const saved = await saveFinanceSettings(body);
    await audit(
      { entityType: 'setting', entityId: 'finance.rules', action: 'UPDATED', summary: 'Updated finance rules' },
      req,
    );
    res.json(saved);
  }),
);
