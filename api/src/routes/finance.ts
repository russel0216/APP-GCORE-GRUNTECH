import { Router } from 'express';
import { z } from 'zod';
import {
  Prisma,
  InvoiceStatus,
  BillStatus,
  ExpenseStatus,
  PaymentKind,
  type ApprovalRequest,
} from '@prisma/client';
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
import { can, canEditRecord } from '../permissions/resolve';
import { registerAttachmentGuard } from '../shared/attachments';
import { audit } from '../shared/audit';
import { nextNumber } from '../shared/numbering';
import { notify } from '../shared/notifications';
import {
  submitForApproval,
  onApprovalSettled,
  approvalSignoffs,
  cancelOpenRequest,
  type ApprovalOutcome,
} from '../shared/approvals';
import { postJobCost } from '../shared/inventory';
import { renderDocument, formatMoney, formatDate, type PdfSection } from '../shared/pdf';
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
  refreshAdvance,
  refreshBudgetRequest,
  claimPayable,
  liquidatedReleased,
  financePosition,
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
  jobOrder: { select: { id: true, number: true } },
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
 * The customer-facing sales invoice.
 *
 * Prints the figures the invoice carries, never recomputed: gross, VAT,
 * the total, the EWT the customer will withhold and what will actually
 * arrive. "Received by" is left blank on purpose — the customer signs it.
 */
invoiceRoutes.get(
  '/:id/pdf',
  require_('gfin.ar.view_all'),
  handler(async (req, res) => {
    const inv = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      include: {
        ...invoiceInclude,
        customer: { select: { id: true, code: true, name: true, tin: true } },
        createdBy: { select: { name: true, position: true } },
      },
    });
    if (!inv) throw notFound('Invoice not found');

    const sections: PdfSection[] = [
      {
        kind: 'fields',
        columns: 3,
        fields: [
          { label: 'Customer', value: inv.customer.name },
          { label: 'TIN', value: inv.customer.tin ?? '—' },
          { label: 'Project', value: inv.job ? `${inv.job.number} — ${inv.job.name}` : '—' },
          { label: 'Customer P.O.', value: inv.poReference ?? '—' },
          { label: 'Terms', value: inv.terms ?? '—' },
          { label: 'Due date', value: formatDate(inv.dueDate) },
          inv.jobOrder
            ? { label: 'Job order', value: inv.jobOrder.number }
            : { label: 'Billing no.', value: inv.progressBilling ? `${inv.progressBilling.number} (#${inv.progressBilling.billingNo})` : '—' },
          { label: 'Status', value: inv.status.replace(/_/g, ' ') },
        ],
      },
      {
        kind: 'table',
        title: 'Particulars',
        head: ['#', 'Description', 'Amount'],
        widths: [6, 70, 24],
        align: ['right', 'left', 'right'],
        rows: inv.lines.map((l, n) => [
          String(n + 1),
          l.detail ? `${l.description} — ${l.detail}` : l.description,
          formatMoney(num(l.amount)),
        ]),
      },
      {
        kind: 'table',
        head: ['', ''],
        widths: [72, 28],
        align: ['right', 'right'],
        rows: [
          ['Gross', formatMoney(num(inv.grossAmount))],
          [`VAT (${(num(inv.vatRate) * 100).toFixed(0)}%)`, formatMoney(num(inv.vatAmount))],
          ['INVOICE TOTAL', formatMoney(num(inv.invoiceTotal))],
          [`Less EWT (${(num(inv.ewtRate) * 100).toFixed(0)}%)`, formatMoney(num(inv.ewtAmount))],
          ['NET COLLECTIBLE', formatMoney(num(inv.netCollectible))],
        ],
      },
    ];
    if (inv.notes) sections.push({ kind: 'text', title: 'Notes', body: inv.notes });

    const pdf = await renderDocument({
      title: 'Sales Invoice',
      documentNumber: inv.number,
      date: inv.invoiceDate,
      reference: inv.customer.name,
      sections,
      signatories: [
        { role: 'Prepared by', name: inv.createdBy.name, position: inv.createdBy.position ?? undefined, at: inv.createdAt },
        { role: 'Approved by', ...(inv.issuedAt ? { name: inv.createdBy.name, position: inv.createdBy.position ?? undefined, at: inv.issuedAt } : {}) },
        { role: 'Received by' },
      ],
    });

    await audit(
      { entityType: 'invoice', entityId: inv.id, action: 'EXPORTED', summary: `Printed ${inv.number}` },
      req,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${inv.number}.pdf"`);
    res.send(pdf);
  }),
);

/** An invoice's own header — what a billing's invoice may set, raised or modified. */
const invoiceHeaderSchema = z.object({
  invoiceDate: z.string().optional(),
  dueDate: z.string().optional(),
  terms: z.string().optional().nullable(),
  poReference: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

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
    const body = parseBody(invoiceHeaderSchema, req.body);

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
  customerId: z.string().optional().nullable(),
  jobId: z.string().optional().nullable(),
  /** A completed, chargeable job order — billed once, like a billing. */
  jobOrderId: z.string().optional().nullable(),
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

/**
 * A manual invoice's money, from its lines — the one rule for raising one and
 * for modifying a draft. Each line is taken to the centavo first, so the gross
 * is exactly the sum of the lines stored under it.
 */
function manualInvoiceMoney(
  lines: { description: string; detail?: string | null; amount: number }[],
  vatRate: number,
  ewtRate: number,
) {
  const rows = lines.map((l, i) => ({
    sortOrder: i,
    description: l.description,
    detail: l.detail || null,
    amount: cents(l.amount),
  }));
  const gross = cents(rows.reduce((s, l) => s + l.amount, 0));
  if (gross <= 0) throw badRequest('The invoice total must be more than zero');
  const tax = taxBreakdown(gross, vatRate, ewtRate);
  return {
    tax,
    figures: {
      grossAmount: D(tax.grossAmount),
      vatRate: D(tax.vatRate),
      vatAmount: D(tax.vatAmount),
      ewtRate: D(tax.ewtRate),
      ewtAmount: D(tax.ewtAmount),
      invoiceTotal: D(tax.invoiceTotal),
      netCollectible: D(tax.netCollectible),
    },
    lines: rows.map((l) => ({ ...l, amount: D(l.amount) })),
  };
}

invoiceRoutes.post(
  '/',
  require_('gfin.ar.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(manualInvoiceSchema, req.body);
    const settings = await financeSettings();
    const rates = await currentRates();

    // A job order is billed the way a billing is: once, after the work is
    // checked, and only when somebody decided it was chargeable. The customer,
    // project and PO reference come off the order unless the body says otherwise.
    let jobOrder: { id: string; number: string } | null = null;
    if (body.jobOrderId) {
      const jo = await prisma.jobOrder.findUnique({
        where: { id: body.jobOrderId },
        select: {
          id: true,
          number: true,
          status: true,
          chargeBasis: true,
          customerId: true,
          jobId: true,
          customerPoNumber: true,
          invoice: { select: { number: true } },
        },
      });
      if (!jo) throw notFound('Job order not found');
      if (jo.chargeBasis !== 'CHARGEABLE') {
        throw badRequest(
          `${jo.number} is covered by ${jo.chargeBasis === 'GOODWILL' ? 'goodwill' : jo.chargeBasis.toLowerCase()} — nothing to bill`,
        );
      }
      if (jo.status !== 'COMPLETED') throw badRequest('A job order is billed once its report is approved');
      if (jo.invoice) throw badRequest(`${jo.number} is already invoiced as ${jo.invoice.number}`);
      body.customerId ??= jo.customerId;
      body.jobId ??= jo.jobId;
      body.poReference ??= jo.customerPoNumber;
      jobOrder = { id: jo.id, number: jo.number };
    }
    if (!body.customerId) throw badRequest('Which customer?');
    const customerId = body.customerId;

    const money = manualInvoiceMoney(body.lines, body.vatRate ?? rates.vatRate, body.ewtRate ?? rates.ewtRate);
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
          customerId,
          jobId: body.jobId || null,
          jobOrderId: jobOrder?.id ?? null,
          invoiceDate,
          dueDate,
          terms: body.terms ?? `${settings.defaultTermsDays} days`,
          poReference: body.poReference || null,
          ...money.figures,
          notes: body.notes || null,
          createdById: me.id,
          lines: { create: money.lines },
        },
        include: invoiceInclude,
      });
    });

    await audit(
      {
        entityType: 'invoice',
        entityId: invoice.id,
        action: 'CREATED',
        summary: jobOrder ? `${invoice.number} raised from job order ${jobOrder.number}` : `${invoice.number} raised`,
      },
      req,
    );
    res.status(201).json(presentInvoice(invoice));
  }),
);

/** What a billing's invoice never takes on Modify: its figures and whom they bill. */
const BILLING_CARRIED = ['customerId', 'jobId', 'jobOrderId', 'vatRate', 'ewtRate', 'lines'] as const;

/**
 * Modifying a draft invoice (2026-10-09, Phase 2 of the button standard).
 *
 * Only while DRAFT: once issued it is a receivable the customer holds, and a
 * wrong one is cancelled and raised again. An invoice raised FROM a progress
 * billing carries the billing's figures (Phase 7: carried, never
 * recomputed), so only its dates, terms, PO reference and notes change here —
 * any figure in the body is a 400 naming the billing. A manual invoice (a job
 * order's, or a standalone one) is re-entered whole: lines replaced, tax
 * recomputed — at the rates it was raised with unless the body names others,
 * never today's Settings quietly. The job order it bills never changes, nor
 * does that invoice's customer. A field left out keeps what is stored.
 * Claimed on DRAFT, so an Issue that lands first wins.
 */
invoiceRoutes.put(
  '/:id',
  require_('gfin.ar.edit_all'),
  handler(async (req, res) => {
    const existing = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      include: {
        progressBilling: { select: { number: true } },
        jobOrder: { select: { number: true } },
      },
    });
    if (!existing) throw notFound('Invoice not found');
    if (existing.status !== 'DRAFT') {
      throw badRequest('Only a draft invoice can be modified — once issued, cancel it and raise another');
    }
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const fromBilling = !!existing.progressBillingId;
    if (fromBilling) {
      const carried = BILLING_CARRIED.filter((key) => raw[key] !== undefined);
      if (carried.length) {
        throw badRequest(
          `${existing.number} carries the figures of ${existing.progressBilling?.number ?? 'its billing'} — only its dates, terms, PO reference and notes change here (not ${carried.join(', ')})`,
        );
      }
    } else if (raw.jobOrderId !== undefined && raw.jobOrderId !== existing.jobOrderId) {
      throw badRequest('The job order an invoice bills does not change — cancel this one and raise another');
    }

    const header = parseBody(invoiceHeaderSchema, raw);
    const invoiceDate = header.invoiceDate ? asDate(header.invoiceDate, 'Invoice date') : existing.invoiceDate;
    const dueDate = header.dueDate ? asDate(header.dueDate, 'Due date') : existing.dueDate;
    if (dueDate < invoiceDate) throw badRequest('The due date is before the invoice date');
    const headerData = {
      invoiceDate,
      dueDate,
      terms: header.terms === undefined ? existing.terms : header.terms || null,
      poReference: header.poReference === undefined ? existing.poReference : header.poReference || null,
      notes: header.notes === undefined ? existing.notes : header.notes || null,
    };

    let manual: ReturnType<typeof manualInvoiceMoney> | null = null;
    let customerId = existing.customerId;
    let jobId = existing.jobId;
    if (!fromBilling) {
      const body = parseBody(manualInvoiceSchema.omit({ jobOrderId: true }), raw);
      customerId = body.customerId ?? existing.customerId;
      if (customerId !== existing.customerId) {
        if (existing.jobOrderId) {
          throw badRequest(`${existing.number} bills job order ${existing.jobOrder?.number} — it is that order's customer's`);
        }
        const known = await prisma.customer.findUnique({ where: { id: customerId }, select: { id: true } });
        if (!known) throw badRequest('That customer does not exist');
      }
      jobId = body.jobId === undefined ? existing.jobId : body.jobId || null;
      if (jobId && jobId !== existing.jobId) {
        const known = await prisma.job.findUnique({ where: { id: jobId }, select: { id: true } });
        if (!known) throw badRequest('That project does not exist');
      }
      manual = manualInvoiceMoney(body.lines, body.vatRate ?? num(existing.vatRate), body.ewtRate ?? num(existing.ewtRate));
    }

    const updated = await prisma.$transaction(async (tx) => {
      const claimed = await tx.invoice.updateMany({
        where: { id: existing.id, status: 'DRAFT' },
        data: { ...headerData, ...(manual ? { customerId, jobId, ...manual.figures } : {}) },
      });
      if (!claimed.count) throw badRequest('It was issued or cancelled a moment ago — reload to see where it stands');
      if (manual) {
        await tx.invoiceLine.deleteMany({ where: { invoiceId: existing.id } });
        await tx.invoiceLine.createMany({ data: manual.lines.map((l) => ({ ...l, invoiceId: existing.id })) });
      }
      return tx.invoice.findUniqueOrThrow({ where: { id: existing.id }, include: invoiceInclude });
    });

    await audit(
      {
        entityType: 'invoice',
        entityId: existing.id,
        action: 'UPDATED',
        summary: manual
          ? `${existing.number} modified — ${num(updated.netCollectible)} collectible (was ${num(existing.netCollectible)})`
          : `${existing.number} modified — dates, terms, PO reference or notes; the figures stay ${existing.progressBilling?.number ?? 'the billing'}'s`,
        before: {
          invoiceDate: existing.invoiceDate,
          dueDate: existing.dueDate,
          terms: existing.terms,
          poReference: existing.poReference,
          ...(manual ? { customerId: existing.customerId, jobId: existing.jobId, netCollectible: num(existing.netCollectible) } : {}),
        },
        after: {
          ...headerData,
          ...(manual ? { customerId, jobId, netCollectible: manual.tax.netCollectible } : {}),
        },
      },
      req,
    );
    res.json(presentInvoice(updated));
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
      // Claimed, so two cancels cannot both put the billing back.
      const claimed = await tx.invoice.updateMany({
        where: { id: invoice.id, status: { not: 'CANCELLED' } },
        data: {
          status: 'CANCELLED',
          voidedAt: new Date(),
          voidReason: body.reason,
          // The billing or job order it billed is let go, so either can be
          // invoiced again — the point of cancelling is usually that the
          // invoice was wrong, not the work. Both links are unique: kept, they
          // would block the corrected invoice for good.
          progressBillingId: null,
          jobOrderId: null,
        },
      });
      if (!claimed.count) throw badRequest('Already cancelled');
      if (invoice.progressBillingId) {
        await tx.progressBilling.update({
          where: { id: invoice.progressBillingId },
          data: { status: 'APPROVED' },
        });
      }
    });

    const jobOrder = invoice.jobOrderId
      ? await prisma.jobOrder.findUnique({ where: { id: invoice.jobOrderId }, select: { number: true } })
      : null;
    const billing = invoice.progressBillingId
      ? await prisma.progressBilling.findUnique({ where: { id: invoice.progressBillingId }, select: { number: true } })
      : null;
    await audit(
      {
        entityType: 'invoice',
        entityId: invoice.id,
        action: 'CANCELLED',
        summary:
          `${invoice.number} cancelled — ${body.reason}` +
          (billing ? `; billing ${billing.number} released to be invoiced again` : '') +
          (jobOrder ? `; job order ${jobOrder.number} released to be invoiced again` : ''),
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

type BillBody = z.infer<typeof billSchema>;

/**
 * A bill's money, from its lines — the one rule for entering a bill and for
 * modifying a draft one. Each line is taken to the centavo first, so the
 * figures are the sum of what is stored under them.
 */
function billMoney(body: Pick<BillBody, 'lines' | 'vatInclusive' | 'ewtRate'>, vatRate: number) {
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
  return {
    total,
    netPayable,
    figures: {
      subtotal: D(subtotal),
      vatRate: D(vatRate),
      vatAmount: D(vatAmount),
      total: D(total),
      ewtRate: D(body.ewtRate),
      ewtAmount: D(ewtAmount),
      netPayable: D(netPayable),
    },
    lines: lines.map((l) => ({ ...l, quantity: D(l.quantity), unitPrice: D(l.unitPrice), amount: D(l.amount) })),
  };
}

/**
 * Which supplier, order, receiving and project a bill belongs to — checked
 * the same way on entry and on Modify.
 *
 * The job comes from the order where none is given — the point of raising a
 * bill against an order is not retyping it. And the RECEIVING is what stops
 * the bill charging the project a second time at approval: an order with
 * goods received always lends the bill one, and a receiving named outright
 * must be of that order and that supplier.
 */
async function billLinks(input: {
  supplierId: string;
  orderId: string | null;
  receivingId: string | null;
  jobId: string | null;
}) {
  const supplier = await prisma.supplier.findUnique({ where: { id: input.supplierId }, select: { id: true } });
  if (!supplier) throw badRequest('That supplier does not exist');

  let jobId = input.jobId;
  let receivingId = input.receivingId;
  if (input.orderId) {
    const order = await prisma.purchaseOrder.findUnique({
      where: { id: input.orderId },
      include: { receivings: { select: { id: true }, orderBy: { receivedDate: 'desc' } } },
    });
    if (!order) throw notFound('Purchase order not found');
    if (order.supplierId !== input.supplierId) {
      throw badRequest('That order belongs to a different supplier');
    }
    if (!jobId) jobId = order.jobId;
    // If the goods have been received and nobody said which receiving, take
    // the latest: what matters is that a receiving EXISTS, because that is
    // what stops the bill posting cost a second time.
    if (!receivingId && order.receivings.length) receivingId = order.receivings[0].id;
  }
  if (receivingId) {
    const receiving = await prisma.receiving.findUnique({
      where: { id: receivingId },
      select: { orderId: true, order: { select: { supplierId: true } } },
    });
    if (!receiving) throw notFound('Receiving not found');
    if (input.orderId && receiving.orderId !== input.orderId) {
      throw badRequest('That receiving is against a different order');
    }
    if (receiving.order.supplierId !== input.supplierId) {
      throw badRequest('Those goods came from a different supplier');
    }
  }
  return { orderId: input.orderId, receivingId, jobId };
}

billRoutes.post(
  '/',
  require_('gfin.ap.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(billSchema, req.body);
    const settings = await financeSettings();
    const rates = await currentRates();

    const money = billMoney(body, body.vatRate ?? rates.vatRate);

    const billDate = body.billDate ? asDate(body.billDate, 'Bill date') : dayKey(new Date());
    const dueDate = body.dueDate
      ? asDate(body.dueDate, 'Due date')
      : addDays(billDate, settings.defaultTermsDays);
    if (dueDate < billDate) throw badRequest('The due date is before the bill date');

    const links = await billLinks({
      supplierId: body.supplierId,
      orderId: body.orderId || null,
      receivingId: body.receivingId || null,
      jobId: body.jobId || null,
    });

    const bill = await prisma.$transaction(async (tx) => {
      const number = await nextNumber('supplier_bill', tx);
      return tx.supplierBill.create({
        data: {
          number,
          supplierId: body.supplierId,
          ...links,
          costCategoryId: body.costCategoryId || null,
          supplierInvoiceNo: body.supplierInvoiceNo || null,
          billDate,
          dueDate,
          terms: body.terms ?? `${settings.defaultTermsDays} days`,
          ...money.figures,
          notes: body.notes || null,
          createdById: me.id,
          lines: { create: money.lines },
        },
        include: billInclude,
      });
    });

    await audit(
      {
        entityType: 'supplier_bill',
        entityId: bill.id,
        action: 'CREATED',
        summary: `${bill.number} from ${bill.supplier.name} — ${money.total} total, ${money.netPayable} payable`,
      },
      req,
    );
    res.status(201).json(presentBill(bill));
  }),
);

/**
 * What Modify takes for a bill: the entry form, with every field but the
 * lines optional — a field the body leaves out keeps what is stored, where
 * the entry form would default it (no withholding, VAT-exclusive prices).
 */
const billModifySchema = billSchema.extend({
  supplierId: z.string().min(1, 'Which supplier?').optional(),
  vatInclusive: z.boolean().optional(),
  ewtRate: z.number().min(0).max(1).optional(),
});

/**
 * Modifying a draft bill (2026-10-09, Phase 2 of the button standard).
 *
 * Only while DRAFT: submitting snapshots the amount the approval route was
 * picked by, so a bill with the approver is not edited under them. The lines
 * are always sent and replace the bill's; the money is recomputed by
 * `billMoney()` at the VAT rate the bill was entered with unless the body
 * names another. Every other field the body leaves out keeps what is stored
 * — the supplier, the withholding rate, whether the prices include VAT
 * (read off the stored subtotal against its lines), the project, the budget
 * line, the supplier's invoice number, dates, terms and notes; a null clears
 * it. The supplier, order and receiving are re-checked by `billLinks()`, so a
 * bill against received goods keeps a receiving and still charges nothing at
 * approval (a cleared receiving on an order with goods received is lent one
 * back). Claimed on DRAFT, so a submit that lands first wins.
 */
billRoutes.put(
  '/:id',
  require_('gfin.ap.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(billModifySchema, req.body);
    const existing = await prisma.supplierBill.findUnique({
      where: { id: req.params.id },
      include: { lines: { select: { amount: true } } },
    });
    if (!existing) throw notFound('Supplier bill not found');
    if (existing.status !== 'DRAFT') {
      throw badRequest(
        existing.status === 'PENDING_APPROVAL'
          ? 'Only a draft bill can be modified — this one is with the approver'
          : `Only a draft bill can be modified — this one is ${existing.status.toLowerCase().replace(/_/g, ' ')}`,
      );
    }

    // A bill entered VAT-inclusive stores its lines as typed and its subtotal
    // with the VAT backed out — so the two differ exactly when it was.
    const storedLineTotal = cents(existing.lines.reduce((s, l) => s + num(l.amount), 0));
    const storedInclusive = Math.abs(num(existing.subtotal) - storedLineTotal) > 0.005;
    const keep = <T,>(sent: T | null | undefined, stored: T | null): T | null =>
      sent === undefined ? stored : sent || null;

    const supplierId = body.supplierId ?? existing.supplierId;
    const money = billMoney(
      {
        lines: body.lines,
        vatInclusive: body.vatInclusive ?? storedInclusive,
        ewtRate: body.ewtRate ?? num(existing.ewtRate),
      },
      body.vatRate ?? num(existing.vatRate),
    );
    const billDate = body.billDate ? asDate(body.billDate, 'Bill date') : existing.billDate;
    const dueDate = body.dueDate ? asDate(body.dueDate, 'Due date') : existing.dueDate;
    if (dueDate < billDate) throw badRequest('The due date is before the bill date');

    const links = await billLinks({
      supplierId,
      orderId: keep(body.orderId, existing.orderId),
      receivingId: keep(body.receivingId, existing.receivingId),
      jobId: keep(body.jobId, existing.jobId),
    });

    const updated = await prisma.$transaction(async (tx) => {
      const claimed = await tx.supplierBill.updateMany({
        where: { id: existing.id, status: 'DRAFT' },
        data: {
          supplierId,
          ...links,
          costCategoryId: keep(body.costCategoryId, existing.costCategoryId),
          supplierInvoiceNo: keep(body.supplierInvoiceNo, existing.supplierInvoiceNo),
          billDate,
          dueDate,
          terms: keep(body.terms, existing.terms),
          ...money.figures,
          notes: keep(body.notes, existing.notes),
        },
      });
      if (!claimed.count) throw badRequest('It was submitted a moment ago — reload to see where it stands');
      await tx.supplierBillLine.deleteMany({ where: { billId: existing.id } });
      await tx.supplierBillLine.createMany({ data: money.lines.map((l) => ({ ...l, billId: existing.id })) });
      return tx.supplierBill.findUniqueOrThrow({ where: { id: existing.id }, include: billInclude });
    });

    await audit(
      {
        entityType: 'supplier_bill',
        entityId: existing.id,
        action: 'UPDATED',
        summary:
          `${existing.number} modified — ${money.total} total, ${money.netPayable} payable` +
          (updated.receiving ? `; matched to ${updated.receiving.number}, so approval charges nothing` : ''),
        before: {
          supplierId: existing.supplierId,
          orderId: existing.orderId,
          receivingId: existing.receivingId,
          jobId: existing.jobId,
          costCategoryId: existing.costCategoryId,
          total: num(existing.total),
          netPayable: num(existing.netPayable),
        },
        after: {
          supplierId: updated.supplierId,
          orderId: updated.orderId,
          receivingId: updated.receivingId,
          jobId: updated.jobId,
          costCategoryId: updated.costCategoryId,
          total: money.total,
          netPayable: money.netPayable,
        },
      },
      req,
    );
    res.json(presentBill(updated));
  }),
);

/**
 * Cancelling a draft bill — one entered in error, or that the supplier
 * withdrew. Only a draft: nothing has been decided, posted or paid on it. The
 * bill has no column of its own for the reason, so it is kept on its notes
 * and in the trail. Claimed on DRAFT, so a submit that lands first wins.
 */
billRoutes.post(
  '/:id/cancel',
  require_('gfin.ap.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(z.object({ reason: z.string().trim().min(3, 'Why?') }), req.body ?? {});
    const bill = await prisma.supplierBill.findUnique({ where: { id: req.params.id } });
    if (!bill) throw notFound('Supplier bill not found');
    if (bill.status !== 'DRAFT') {
      throw badRequest(
        bill.status === 'CANCELLED'
          ? 'Already cancelled'
          : 'Only a draft bill can be cancelled — this one has gone for approval',
      );
    }

    await prisma.$transaction(async (tx) => {
      const claimed = await tx.supplierBill.updateMany({
        where: { id: bill.id, status: 'DRAFT' },
        data: { status: 'CANCELLED', notes: `${bill.notes ? `${bill.notes}\n` : ''}Cancelled: ${body.reason}` },
      });
      if (!claimed.count) throw badRequest('It was submitted a moment ago — reload to see where it stands');
      // A draft has nothing open with an approver; one left behind by a
      // refused submit goes with it, through the engine.
      await cancelOpenRequest('supplier_bill', bill.id, tx, `cancelled by ${me.name}: ${body.reason}`, me.id);
    });

    await audit(
      { entityType: 'supplier_bill', entityId: bill.id, action: 'CANCELLED', summary: `${bill.number} cancelled — ${body.reason}` },
      req,
    );
    res.json({ ok: true });
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

    // Claimed on the bill exactly as read — still a draft, and not modified
    // since (`updatedAt`, which every write to a bill moves). The request
    // below snapshots this read's amount and subject, and the route is picked
    // by that amount, so a Modify or a cancel that lands between the read and
    // the claim refuses the submit rather than sending stale figures.
    const claimed = await prisma.supplierBill.updateMany({
      where: { id: bill.id, status: 'DRAFT', updatedAt: bill.updatedAt },
      data: { status: 'PENDING_APPROVAL' },
    });
    if (!claimed.count) throw badRequest('It changed a moment ago — reload to see where it stands');

    try {
      await submitForApproval({
        documentType: 'supplier_bill',
        documentId: bill.id,
        documentNumber: bill.number,
        subject: `${bill.supplier.name} — ${bill.supplierInvoiceNo ?? bill.number}`,
        amount: num(bill.total),
        link: `/g-fin/ap/${bill.id}`,
        requesterId: me.id,
      });
    } catch (err) {
      // The engine refused (no workflow, nobody to approve). The bill goes
      // back to DRAFT rather than sitting PENDING with no request behind it.
      await prisma.supplierBill.updateMany({
        where: { id: bill.id, status: 'PENDING_APPROVAL' },
        data: { status: 'DRAFT' },
      });
      throw err;
    }

    await audit(
      { entityType: 'supplier_bill', entityId: bill.id, action: 'SUBMITTED', summary: `${bill.number} sent for approval` },
      req,
    );
    res.json({ ok: true });
  }),
);

/**
 * A decision that finds the bill no longer pending changes nothing. A repeat
 * on a bill already settled says nothing; one on a bill that went back to
 * draft or was cancelled meanwhile is written down, so the trail explains
 * why the approval history and the bill disagree.
 */
async function billNotApplied(billId: string, outcome: ApprovalOutcome) {
  const bill = await prisma.supplierBill.findUnique({ where: { id: billId }, select: { number: true, status: true } });
  if (!bill || (bill.status !== 'DRAFT' && bill.status !== 'CANCELLED')) return;
  await audit({
    entityType: 'supplier_bill',
    entityId: billId,
    action: 'UPDATED',
    summary: `${bill.number} ${outcome === 'APPROVED' ? 'approved' : 'rejected'} after it was ${bill.status === 'DRAFT' ? 'put back to draft' : 'cancelled'} — not applied`,
  });
}

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
 *
 * The outcome is applied only while the bill is still PENDING_APPROVAL — a
 * conditional claim, so a repeated settlement posts nothing the second time.
 */
onApprovalSettled('supplier_bill', async (approval, outcome) => {
  const bill = await prisma.supplierBill.findUnique({
    where: { id: approval.documentId },
    include: { supplier: true, job: true, receiving: true },
  });
  if (!bill) return;
  if (bill.status !== 'PENDING_APPROVAL') return billNotApplied(bill.id, outcome);

  if (outcome !== 'APPROVED') {
    const claimed = await prisma.supplierBill.updateMany({
      where: { id: bill.id, status: 'PENDING_APPROVAL' },
      data: { status: 'CANCELLED' },
    });
    if (!claimed.count) return billNotApplied(bill.id, outcome);
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

  const applied = await prisma.$transaction(async (tx) => {
    const claimed = await tx.supplierBill.updateMany({
      where: { id: bill.id, status: 'PENDING_APPROVAL' },
      data: {
        status: 'APPROVED',
        approvedAt: new Date(),
        postedToJob: !!postable,
        postedAt: postable ? new Date() : null,
      },
    });
    if (!claimed.count) return false;

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
    return true;
  });
  if (!applied) return billNotApplied(bill.id, outcome);

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

/**
 * The receipts on a claim are the claim's. Reading them (listing, serving) is
 * the same door as GET /:id — the claimant, or whoever reads every claim
 * (super admins pass the engine's own check); knowing a file's id is not the
 * same right as seeing the claim. Changing them is Modify's door: a DRAFT, by
 * the claimant with `edit_own` or by `edit_all` — the receipts are what the
 * approver decides on, so they do not change under a submitted claim.
 *
 * The shared guard does not yet say which it is asked: it answers listing,
 * serving and uploading alike, and DELETE /attachments/:id asks only whether
 * the caller uploaded the file. Until `AttachmentGuard` passes the intent —
 * 'write' from `guardRecord` on POST and from that DELETE — every call reads
 * as 'read', and only the page holds uploads to a draft.
 */
registerAttachmentGuard('expense_claim', async (user, id, mode: 'read' | 'write' = 'read') => {
  const claim = await prisma.expenseClaim.findUnique({ where: { id }, select: { claimedById: true, status: true } });
  if (!claim) return false;
  if (mode === 'write') return claim.status === 'DRAFT' && canEditRecord(user, 'gfin', 'expenses', claim.claimedById);
  return claim.claimedById === user.id || can(user, 'gfin.expenses.view_all');
});

export const claimInclude = {
  claimedBy: { select: { id: true, name: true, email: true } },
  job: { select: { id: true, number: true, name: true } },
  costCategory: { select: { id: true, name: true } },
  advance: {
    select: { id: true, number: true, amountReleased: true, status: true, jobId: true, costCategoryId: true },
  },
  // Project cash liquidated the same way — a claim names one or the other.
  budgetRequest: {
    select: { id: true, number: true, amountReleased: true, status: true, jobId: true, costCategoryId: true },
  },
  lines: { orderBy: { sortOrder: 'asc' } },
} satisfies Prisma.ExpenseClaimInclude;

type ClaimRow = Prisma.ExpenseClaimGetPayload<{ include: typeof claimInclude }>;

/**
 * A claim as the screens read it.
 *
 * `payable` is what the person is still owed on this document — the total for
 * a reimbursement, the excess over the advance for a liquidation. `refundDue`
 * is the other direction: unspent cash the liquidation says must come back,
 * carried on the advance but shown here so the page can say so.
 */
export function presentClaim(row: ClaimRow) {
  const total = num(row.total);
  const paid = num(row.amountPaid);
  const payable = claimPayable(row);
  const released = liquidatedReleased(row);
  const liquidates = !!(row.advance || row.budgetRequest);
  return {
    ...row,
    total,
    amountPaid: paid,
    payable,
    outstanding: cents(payable - paid),
    refundDue: liquidates ? cents(Math.max(0, released - total)) : 0,
    kind: liquidates ? ('liquidation' as const) : ('reimbursement' as const),
    advance: row.advance ? { ...row.advance, amountReleased: num(row.advance.amountReleased) } : null,
    budgetRequest: row.budgetRequest ? { ...row.budgetRequest, amountReleased: num(row.budgetRequest.amountReleased) } : null,
    lines: row.lines.map((l) => ({ ...l, amount: num(l.amount) })),
  };
}

/**
 * What a claim or an advance may be charged to.
 *
 * Not `/jobs/lookup`: naming the project you spent money on is not the same
 * right as project-management access, and the filing roles hold none of it.
 * TURNED_OVER jobs are kept on purpose — a late receipt against a turned-over
 * job is legitimate, and refusing it would push the cost to overheads.
 */
expenseRoutes.get(
  '/chargeable',
  requireAny('gfin.expenses.create', 'gfin.cash_advances.create'),
  handler(async (_req, res) => {
    const [jobs, categories] = await Promise.all([
      prisma.job.findMany({
        where: { status: { notIn: ['CANCELLED'] } },
        select: { id: true, number: true, name: true },
        orderBy: { number: 'desc' },
        take: 300,
      }),
      prisma.costCategory.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
        orderBy: { sortOrder: 'asc' },
      }),
    ]);
    res.json({ jobs, categories });
  }),
);

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
    if (q.filters.advanceId) where.advanceId = q.filters.advanceId;
    if (q.filters.budgetRequestId) where.budgetRequestId = q.filters.budgetRequestId;
    // A liquidation is a claim that names an advance or a budget request; a
    // reimbursement is one that names neither. Same table, a column apart.
    if (q.filters.kind === 'liquidation') where.OR = [{ advanceId: { not: null } }, { budgetRequestId: { not: null } }];
    if (q.filters.kind === 'reimbursement') {
      where.advanceId = null;
      where.budgetRequestId = null;
    }
    if (q.search) {
      const terms: Prisma.ExpenseClaimWhereInput[] = [
        { number: { contains: q.search, mode: 'insensitive' } },
        { purpose: { contains: q.search, mode: 'insensitive' } },
        { claimedBy: { name: { contains: q.search, mode: 'insensitive' } } },
        { advance: { number: { contains: q.search, mode: 'insensitive' } } },
        { budgetRequest: { number: { contains: q.search, mode: 'insensitive' } } },
      ];
      // The kind filter already uses OR: the two conditions AND together.
      if (where.OR) {
        where.AND = [{ OR: where.OR }, { OR: terms }];
        delete where.OR;
      } else {
        where.OR = terms;
      }
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
  /** Set when this claim liquidates a cash advance. */
  advanceId: z.string().optional().nullable(),
  /** Set when this claim liquidates a budget request (project cash). Never both. */
  budgetRequestId: z.string().optional().nullable(),
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

/**
 * A claim's receipts and their total — the one rule for filing a claim and
 * for modifying a draft. Each line is taken to the centavo first, so the total
 * is exactly the sum of the lines stored under it.
 */
function claimLines(input: z.infer<typeof claimSchema>['lines']) {
  const rows = input.map((l, i) => ({
    sortOrder: i,
    spentOn: asDate(l.spentOn, 'Spent on'),
    description: l.description,
    category: l.category || null,
    receiptNo: l.receiptNo || null,
    amount: cents(l.amount),
  }));
  return {
    total: cents(rows.reduce((s, l) => s + l.amount, 0)),
    lines: rows.map((l) => ({ ...l, amount: D(l.amount) })),
  };
}

expenseRoutes.post(
  '/',
  require_('gfin.expenses.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(claimSchema, req.body);

    // A liquidation is the person who holds the cash accounting for it,
    // against the project and budget line the advance was approved for.
    // Changing either at liquidation time would let cost land somewhere
    // nobody approved.
    let jobId = body.jobId || null;
    let costCategoryId = body.costCategoryId || null;
    let advanceNumber: string | null = null;
    if (body.advanceId) {
      const advance = await prisma.cashAdvance.findUnique({
        where: { id: body.advanceId },
        include: {
          liquidations: {
            where: { status: { in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SETTLED', 'REIMBURSED'] } },
            select: { number: true },
          },
        },
      });
      if (!advance) throw notFound('Cash advance not found');
      if (advance.requestedById !== me.id && !me.isSuperAdmin) {
        throw forbidden('Only the person who received the advance can liquidate it');
      }
      if (advance.status !== 'RELEASED') {
        throw badRequest(
          advance.status === 'APPROVED'
            ? `${advance.number} has not been released yet — there is no cash to account for`
            : `${advance.number} is ${advance.status.toLowerCase().replace(/_/g, ' ')} and cannot be liquidated`,
        );
      }
      if (advance.liquidations.length) {
        throw badRequest(`${advance.number} is already being liquidated by ${advance.liquidations[0].number}`);
      }
      if (jobId && advance.jobId && jobId !== advance.jobId) {
        throw badRequest(`${advance.number} was approved against a different project — the liquidation charges that one`);
      }
      jobId = advance.jobId;
      costCategoryId = advance.costCategoryId;
      advanceNumber = advance.number;
    }
    if (body.advanceId && body.budgetRequestId) {
      throw badRequest('A liquidation accounts for one thing — a cash advance or a budget request, not both');
    }
    // Project cash: the same rules, on the request. Whoever raised the request
    // files the receipts, against the project and budget line it was
    // approved for.
    if (body.budgetRequestId) {
      const request = await prisma.budgetRequest.findUnique({
        where: { id: body.budgetRequestId },
        include: {
          liquidations: {
            where: { status: { in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SETTLED', 'REIMBURSED'] } },
            select: { number: true },
          },
        },
      });
      if (!request) throw notFound('Budget request not found');
      if (request.requestedById !== me.id && !me.isSuperAdmin) {
        throw forbidden('Only the person who raised the budget request can liquidate it');
      }
      if (request.status !== 'RELEASED') {
        throw badRequest(
          request.status === 'APPROVED'
            ? `${request.number} has not been released yet — there is no cash to account for`
            : `${request.number} is ${request.status.toLowerCase().replace(/_/g, ' ')} and cannot be liquidated`,
        );
      }
      if (request.liquidations.length) {
        throw badRequest(`${request.number} is already being liquidated by ${request.liquidations[0].number}`);
      }
      if (jobId && jobId !== request.jobId) {
        throw badRequest(`${request.number} was approved against a different project — the liquidation charges that one`);
      }
      jobId = request.jobId;
      costCategoryId = request.costCategoryId;
      advanceNumber = request.number;
    }

    const { total, lines } = claimLines(body.lines);
    const claim = await prisma.$transaction(async (tx) => {
      const number = await nextNumber('expense', tx);
      return tx.expenseClaim.create({
        data: {
          number,
          claimedById: me.id,
          jobId,
          costCategoryId,
          advanceId: body.advanceId || null,
          budgetRequestId: body.budgetRequestId || null,
          claimDate: body.claimDate ? asDate(body.claimDate, 'Claim date') : dayKey(new Date()),
          purpose: body.purpose,
          total: D(total),
          notes: body.notes || null,
          lines: { create: lines },
        },
        include: claimInclude,
      });
    });

    await audit(
      {
        entityType: 'expense_claim',
        entityId: claim.id,
        action: 'CREATED',
        summary: advanceNumber
          ? `${claim.number} — ${total} liquidated against ${advanceNumber} for ${body.purpose}`
          : `${claim.number} — ${total} claimed for ${body.purpose}`,
      },
      req,
    );
    res.status(201).json(presentClaim(claim));
  }),
);

/**
 * Modifying a draft claim (2026-10-09, Phase 2 of the button standard).
 *
 * The claimant's, or `edit_all`'s, and only while DRAFT — submitting
 * snapshots the amount the approval route was picked by, so a claim with the
 * approver is pulled back first (`/withdraw`). The body is the filing form's,
 * whole: the receipts are replaced and the total recomputed in one
 * transaction. A liquidation keeps the advance or budget request it accounts
 * for, and with it that source's project and budget line — the cost lands
 * where the cash was approved to land, exactly as when it was filed. Claimed
 * on DRAFT, so a submit that lands first wins.
 */
expenseRoutes.put(
  '/:id',
  requireAny('gfin.expenses.edit_own', 'gfin.expenses.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(claimSchema, req.body);
    const existing = await prisma.expenseClaim.findUnique({
      where: { id: req.params.id },
      include: {
        advance: { select: { number: true, jobId: true, costCategoryId: true } },
        budgetRequest: { select: { number: true, jobId: true, costCategoryId: true } },
      },
    });
    if (!existing) throw notFound('Expense claim not found');
    if (!canEditRecord(me, 'gfin', 'expenses', existing.claimedById)) {
      throw forbidden('Only the person who filed this claim can change it');
    }
    if (existing.status !== 'DRAFT') {
      throw badRequest(
        existing.status === 'PENDING_APPROVAL'
          ? 'Only a draft can be changed — this one is with the approver; pull it back to draft first'
          : `Only a draft can be changed — this one is ${existing.status.toLowerCase().replace(/_/g, ' ')}`,
      );
    }

    // What a liquidation accounts for was checked when it was filed (released,
    // the filer's own, one live liquidation), and Modify never re-points it.
    const source = existing.advance ?? existing.budgetRequest;
    if (
      (body.advanceId || existing.advanceId) !== existing.advanceId ||
      (body.budgetRequestId || existing.budgetRequestId) !== existing.budgetRequestId
    ) {
      throw badRequest(
        source
          ? `This liquidation accounts for ${source.number} — cancel it and file another to account for something else`
          : 'A claim does not become a liquidation on Modify — file the liquidation from the advance or budget request',
      );
    }

    let jobId: string | null;
    let costCategoryId: string | null;
    if (source) {
      if (body.jobId && source.jobId && body.jobId !== source.jobId) {
        throw badRequest(`${source.number} was approved against a different project — the liquidation charges that one`);
      }
      jobId = source.jobId;
      costCategoryId = source.costCategoryId;
    } else {
      jobId = body.jobId || null;
      costCategoryId = body.costCategoryId || null;
      if (jobId && jobId !== existing.jobId) {
        const job = await prisma.job.findUnique({ where: { id: jobId }, select: { status: true } });
        if (!job || job.status === 'CANCELLED') throw badRequest('That project cannot be charged');
      }
    }

    const { total, lines } = claimLines(body.lines);
    const claimDate = body.claimDate ? asDate(body.claimDate, 'Claim date') : existing.claimDate;
    const updated = await prisma.$transaction(async (tx) => {
      const claimed = await tx.expenseClaim.updateMany({
        where: { id: existing.id, status: 'DRAFT' },
        data: {
          jobId,
          costCategoryId,
          claimDate,
          purpose: body.purpose,
          total: D(total),
          notes: body.notes === undefined ? existing.notes : body.notes || null,
        },
      });
      if (!claimed.count) throw badRequest('It was submitted a moment ago — reload to see where it stands');
      await tx.expenseClaimLine.deleteMany({ where: { claimId: existing.id } });
      await tx.expenseClaimLine.createMany({ data: lines.map((l) => ({ ...l, claimId: existing.id })) });
      return tx.expenseClaim.findUniqueOrThrow({ where: { id: existing.id }, include: claimInclude });
    });

    await audit(
      {
        entityType: 'expense_claim',
        entityId: existing.id,
        action: 'UPDATED',
        summary: source
          ? `${existing.number} modified — ${total} liquidated against ${source.number} for ${body.purpose}`
          : `${existing.number} modified — ${total} claimed for ${body.purpose}`,
        before: { purpose: existing.purpose, total: num(existing.total), jobId: existing.jobId, costCategoryId: existing.costCategoryId },
        after: { purpose: body.purpose, total, jobId, costCategoryId },
      },
      req,
    );
    res.json(presentClaim(updated));
  }),
);

/**
 * Why a claim read PENDING_APPROVAL had no open request to withdraw. Either
 * the approver decided it a moment ago — its latest request closed APPROVED
 * or REJECTED, and the settlement is on its way — and then the decision
 * stands and the caller rolls back; or nothing has been decided: the claim is
 * still being submitted (its request not made yet), or a submit died
 * half-way. Then the caller may go ahead, and a submit still running
 * withdraws the request it makes once it finds the claim has moved on (see
 * `/submit`), so a claim that is not waiting never leaves one in a queue.
 */
async function claimDecided(tx: Prisma.TransactionClient, claimId: string): Promise<boolean> {
  const latest = await tx.approvalRequest.findFirst({
    where: { documentType: 'expense', documentId: claimId },
    orderBy: { createdAt: 'desc' },
    select: { status: true },
  });
  return latest?.status === 'APPROVED' || latest?.status === 'REJECTED';
}

/**
 * Pulling a claim back from the approver to change it — the sales order's
 * shape. The claim is claimed PENDING_APPROVAL → DRAFT and its request
 * withdrawn through the engine in the same transaction, which tells the
 * approvers. If nothing was open to withdraw because a decision landed a
 * moment before (`claimDecided`), the decision stands: the transaction rolls
 * back and the settlement it carries goes through.
 */
expenseRoutes.post(
  '/:id/withdraw',
  requireAny('gfin.expenses.edit_own', 'gfin.expenses.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const claim = await prisma.expenseClaim.findUnique({ where: { id: req.params.id } });
    if (!claim) throw notFound('Expense claim not found');
    if (!canEditRecord(me, 'gfin', 'expenses', claim.claimedById)) {
      throw forbidden('Only the person who filed this claim can pull it back');
    }
    if (claim.status !== 'PENDING_APPROVAL') throw badRequest('This claim is not with the approver — nothing to pull back');

    await prisma.$transaction(async (tx) => {
      const claimed = await tx.expenseClaim.updateMany({
        where: { id: claim.id, status: 'PENDING_APPROVAL' },
        data: { status: 'DRAFT' },
      });
      if (!claimed.count) throw badRequest('It was decided a moment ago — reload to see where it stands');
      const withdrawn = await cancelOpenRequest('expense', claim.id, tx, `pulled back to draft by ${me.name}`, me.id);
      if (!withdrawn.length && (await claimDecided(tx, claim.id))) {
        throw badRequest('The approver decided it a moment ago — reload to see where it stands');
      }
    });

    await audit(
      {
        entityType: 'expense_claim',
        entityId: claim.id,
        action: 'UPDATED',
        summary: `${claim.number} pulled back from approval to draft`,
      },
      req,
    );
    res.json({ ok: true, status: 'DRAFT' });
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

    // Claimed on the claim exactly as read — still a draft, and not modified
    // since (`updatedAt`, which every write to a claim moves; a Modify writes
    // its receipts in the same transaction as the header). The receipt check
    // above ran on this read, the request below snapshots its total and
    // purpose, and the route is picked by that total — so a Modify or a
    // cancel that lands between the read and the claim refuses the submit
    // rather than sending stale figures.
    const claimed = await prisma.expenseClaim.updateMany({
      where: { id: claim.id, status: 'DRAFT', updatedAt: claim.updatedAt },
      data: { status: 'PENDING_APPROVAL' },
    });
    if (!claimed.count) throw badRequest('It changed a moment ago — reload to see where it stands');

    try {
      await submitForApproval({
        documentType: 'expense',
        documentId: claim.id,
        documentNumber: claim.number,
        subject: `${me.name} — ${claim.purpose}`,
        amount: num(claim.total),
        link: `/g-fin/expenses/${claim.id}`,
        // The claimant, even when a super admin presses the button for them:
        // the self-approval rule has to see whose money this is.
        requesterId: claim.claimedById,
      });
    } catch (err) {
      // The engine refused (no workflow, a self-approval trap). The claim goes
      // back to DRAFT rather than sitting PENDING with no request behind it.
      await prisma.expenseClaim.updateMany({ where: { id: claim.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
      throw err;
    }

    // A cancel or a pull-back that landed while the request was being made
    // found nothing open to withdraw, and went ahead (`claimDecided`). Tested
    // under the claim's row lock, which either of them holds until it
    // commits: if the claim is no longer pending, the request just made is
    // withdrawn through the engine, so it never sits in a queue for a claim
    // that is not waiting on it.
    const movedOn = await prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ status: string }[]>`
        SELECT status::text AS status FROM "ExpenseClaim" WHERE id = ${claim.id} FOR UPDATE`;
      if (row?.status === 'PENDING_APPROVAL') return null;
      await cancelOpenRequest(
        'expense',
        claim.id,
        tx,
        `the claim was ${row?.status === 'DRAFT' ? 'pulled back to draft' : 'cancelled'} while it was being submitted`,
        me.id,
      );
      return row?.status ?? 'DELETED';
    });
    if (movedOn) {
      throw badRequest(
        `It was ${movedOn === 'DRAFT' ? 'pulled back to draft' : 'cancelled'} a moment ago — reload to see where it stands`,
      );
    }

    await audit(
      { entityType: 'expense_claim', entityId: claim.id, action: 'SUBMITTED', summary: `${claim.number} sent for approval` },
      req,
    );
    res.json({ ok: true });
  }),
);

/**
 * A decision that finds the claim no longer pending changes nothing. A repeat
 * on a claim already settled says nothing (the "settling twice" rule); one on
 * a claim pulled back to draft or cancelled meanwhile is written down, so the
 * trail explains why the approval history and the claim disagree.
 */
async function claimNotApplied(claimId: string, outcome: ApprovalOutcome) {
  const claim = await prisma.expenseClaim.findUnique({ where: { id: claimId }, select: { number: true, status: true } });
  if (!claim || (claim.status !== 'DRAFT' && claim.status !== 'CANCELLED')) return;
  await audit({
    entityType: 'expense_claim',
    entityId: claimId,
    action: 'UPDATED',
    summary: `${claim.number} ${outcome === 'APPROVED' ? 'approved' : 'rejected'} after it was ${claim.status === 'DRAFT' ? 'pulled back to draft' : 'cancelled'} — not applied`,
  });
}

/**
 * An approved claim is money owed to a person, and cost owed by a job.
 *
 * For a liquidation the cost is the same — INCURRED at what was actually
 * spent, the first and only time the advance reaches a ledger — but the money
 * runs the other way: the person already holds the cash. The claim settles at
 * the EXCESS over the advance (SETTLED outright when there is none), and the
 * advance is re-derived so unspent cash reads as REFUND_DUE.
 *
 * The outcome is applied only while the claim is still PENDING_APPROVAL, by a
 * conditional claim in the same transaction as the cost — so a decision that
 * lands after a pull-back or a cancel changes nothing, and a repeated
 * settlement posts nothing the second time.
 *
 * Exported so a test can call it twice: the status guard is what makes a
 * repeated settlement post nothing the second time.
 */
export const settleExpense = async (approval: ApprovalRequest, outcome: ApprovalOutcome) => {
  const claim = await prisma.expenseClaim.findUnique({
    where: { id: approval.documentId },
    include: { claimedBy: true, job: true, advance: true, budgetRequest: true },
  });
  if (!claim) return;
  if (claim.status !== 'PENDING_APPROVAL') return claimNotApplied(claim.id, outcome);
  // What this liquidation accounts for, if anything: the advance or the request.
  const source = claim.advance ?? claim.budgetRequest;

  if (outcome !== 'APPROVED') {
    const claimed = await prisma.expenseClaim.updateMany({
      where: { id: claim.id, status: 'PENDING_APPROVAL' },
      data: { status: 'REJECTED' },
    });
    if (!claimed.count) return claimNotApplied(claim.id, outcome);
    await audit({
      entityType: 'expense_claim',
      entityId: claim.id,
      action: 'REJECTED',
      summary: `${claim.number} rejected — nothing posted, nothing reimbursable`,
    });
    return;
  }

  const total = num(claim.total);
  const postable = claim.jobId && claim.costCategoryId && total > 0;
  const payable = claimPayable(claim);
  const released = source ? num(source.amountReleased) : 0;
  const refundDue = source ? cents(Math.max(0, released - total)) : 0;

  const applied = await prisma.$transaction(async (tx) => {
    const claimed = await tx.expenseClaim.updateMany({
      where: { id: claim.id, status: 'PENDING_APPROVAL' },
      data: {
        // A liquidation the cash fully covered owes the person nothing; it
        // is settled the moment it is approved.
        status: source && payable <= 0 ? 'SETTLED' : 'APPROVED',
        approvedAt: new Date(),
        postedToJob: !!postable,
        postedAt: postable ? new Date() : null,
      },
    });
    if (!claimed.count) return false;
    if (postable) {
      await postJobCost(tx, {
        jobId: claim.jobId!,
        costCategoryId: claim.costCategoryId!,
        state: 'INCURRED',
        amount: total,
        sourceType: 'expense_claim',
        sourceId: claim.id,
        sourceNumber: claim.number,
        description: source
          ? `${claim.claimedBy.name} — ${claim.purpose} (liquidation of ${source.number})`
          : `${claim.claimedBy.name} — ${claim.purpose}`,
      });
    }
    if (claim.advanceId) await refreshAdvance(tx, claim.advanceId);
    if (claim.budgetRequestId) await refreshBudgetRequest(tx, claim.budgetRequestId);
    return true;
  });
  if (!applied) return claimNotApplied(claim.id, outcome);

  const what = claim.advance ? 'advanced' : 'released';
  const body = !source
    ? `${total} is due back to you. Finance will reimburse it.`
    : payable > 0
      ? `You spent ${payable} more than the ${released} ${what}. Finance will reimburse the excess.`
      : refundDue > 0
        ? `${refundDue} of the ${released} ${what} was not spent. Return it to finance.`
        : `The cash covered it exactly. Nothing is owed either way.`;
  await notify({
    userId: claim.claimedById,
    type: 'approval.approved',
    title: `${claim.number} approved`,
    body,
    link: `/g-fin/expenses/${claim.id}`,
  });

  await audit({
    entityType: 'expense_claim',
    entityId: claim.id,
    action: 'APPROVED',
    summary: source
      ? `${claim.number} approved — ${total} spent against ${source.number}${postable ? `, charged to ${claim.job?.number}` : ''}; ${payable > 0 ? `${payable} owed to ${claim.claimedBy.name}` : refundDue > 0 ? `${refundDue} owed back` : 'settled exactly'}`
      : postable
        ? `${claim.number} approved — ${total} charged to ${claim.job?.number} and owed to ${claim.claimedBy.name}`
        : `${claim.number} approved — ${total} owed to ${claim.claimedBy.name}, no project charged`,
  });
};
onApprovalSettled('expense', settleExpense);

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
    // Cancelling is for a claim nobody has decided on yet. Once approved it has
    // charged a project, told a person they are owed money, or settled an
    // advance — every one of those is reversed through finance, on the record,
    // not by the author quietly withdrawing the document.
    if (claim.status !== 'DRAFT' && claim.status !== 'PENDING_APPROVAL') {
      throw badRequest(
        claim.status === 'CANCELLED' || claim.status === 'REJECTED'
          ? `This claim is already ${claim.status.toLowerCase()}`
          : 'This claim has been approved; reverse it through finance, not by cancelling',
      );
    }
    if (claim.allocations.length) throw badRequest('This claim has already been reimbursed');

    await prisma.$transaction(async (tx) => {
      // Claimed in the status it was read in, never simply written: a
      // decision the subscriber applied meanwhile (an approved claim has
      // posted its cost and refreshed its advance) or a submit that took the
      // draft refuses the cancel rather than being written over.
      const claimed = await tx.expenseClaim.updateMany({
        where: { id: claim.id, status: claim.status },
        data: { status: 'CANCELLED' },
      });
      if (!claimed.count) throw badRequest('It changed a moment ago — reload to see where it stands');
      // Still with the approver: withdrawn through the engine, so it leaves
      // their queue and they are told. Nothing open while it reads pending
      // means a decision landed a moment ago — it stands, and this rolls back
      // — or it is still being submitted, which that submit sorts out.
      const withdrawn = await cancelOpenRequest('expense', claim.id, tx, `cancelled by ${me.name}`, me.id);
      if (claim.status === 'PENDING_APPROVAL' && !withdrawn.length && (await claimDecided(tx, claim.id))) {
        throw badRequest('The approver decided it a moment ago — reload to see where it stands');
      }
    });
    await audit(
      { entityType: 'expense_claim', entityId: claim.id, action: 'CANCELLED', summary: `${claim.number} cancelled` },
      req,
    );
    res.json({ ok: true });
  }),
);

/**
 * The printed claim. A liquidation prints as a "Liquidation Report" — same
 * document, same number series; only the title and the settlement block
 * differ, because that is all that differs on paper.
 */
expenseRoutes.get(
  '/:id/pdf',
  requireAny('gfin.expenses.view_all', 'gfin.expenses.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const claim = await prisma.expenseClaim.findUnique({
      where: { id: req.params.id },
      include: { ...claimInclude, claimedBy: { select: { id: true, name: true, email: true, position: true } } },
    });
    if (!claim) throw notFound('Expense claim not found');
    if (claim.claimedById !== me.id && !me.isSuperAdmin && !me.permissions.has('gfin.expenses.view_all')) {
      throw forbidden('That is someone else’s claim');
    }

    const view = presentClaim(claim);
    const sections: PdfSection[] = [
      {
        kind: 'fields',
        columns: 3,
        fields: [
          { label: 'Claimed by', value: claim.claimedBy.name },
          { label: 'Date', value: formatDate(claim.claimDate) },
          { label: 'Purpose', value: claim.purpose },
          { label: 'Project', value: claim.job ? `${claim.job.number} — ${claim.job.name}` : 'Overheads' },
          { label: 'Budget line', value: claim.costCategory?.name ?? '—' },
          ...(claim.advance ? [{ label: 'Liquidates', value: claim.advance.number }] : []),
          ...(claim.budgetRequest ? [{ label: 'Liquidates', value: `Budget request ${claim.budgetRequest.number}` }] : []),
          { label: 'Status', value: claim.status.replace(/_/g, ' ') },
        ],
      },
      {
        kind: 'table',
        title: 'Receipts',
        head: ['#', 'Date', 'Description', 'Receipt no.', 'Amount'],
        widths: [6, 14, 44, 18, 18],
        align: ['right', 'left', 'left', 'left', 'right'],
        rows: [
          ...claim.lines.map((l, n) => [
            String(n + 1),
            formatDate(l.spentOn),
            l.category ? `${l.description} (${l.category})` : l.description,
            l.receiptNo ?? '—',
            formatMoney(num(l.amount)),
          ]),
          ['', '', '', 'TOTAL', formatMoney(view.total)],
        ],
      },
      {
        kind: 'fields',
        title: 'Settlement',
        columns: 3,
        fields: view.kind === 'liquidation'
          ? [
              { label: claim.advance ? 'Advance released' : 'Cash released', value: formatMoney(liquidatedReleased(claim)) },
              { label: 'Spent', value: formatMoney(view.total) },
              { label: view.payable > 0 ? 'Excess owed to claimant' : 'Unspent — owed back', value: formatMoney(view.payable > 0 ? view.payable : view.refundDue) },
            ]
          : [
              { label: 'Claimed', value: formatMoney(view.total) },
              { label: 'Reimbursed', value: formatMoney(view.amountPaid) },
              { label: 'Still owed', value: formatMoney(view.outstanding) },
            ],
      },
    ];
    if (claim.notes) sections.push({ kind: 'text', title: 'Notes', body: claim.notes });

    const signoffs = await approvalSignoffs('expense', claim.id);
    const liquidated = claim.advance ?? claim.budgetRequest;
    const pdf = await renderDocument({
      title: liquidated ? 'Liquidation Report' : 'Expense Claim',
      documentNumber: claim.number,
      date: claim.claimDate,
      reference: liquidated ? `Liquidation of ${liquidated.number}` : claim.purpose,
      sections,
      signatories: [
        { role: 'Prepared by', name: claim.claimedBy.name, position: claim.claimedBy.position ?? undefined, at: claim.createdAt },
        { role: 'Checked by', ...signoffs[0] },
        { role: 'Approved by', ...signoffs[1] },
      ],
    });

    await audit(
      { entityType: 'expense_claim', entityId: claim.id, action: 'EXPORTED', summary: `Printed ${claim.number}` },
      req,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${claim.number}.pdf"`);
    res.send(pdf);
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
      advance: { select: { id: true, number: true, amount: true } },
      budgetRequest: { select: { id: true, number: true, amount: true } },
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
      advance: a.advance ? { ...a.advance, amount: num(a.advance.amount) } : null,
      budgetRequest: a.budgetRequest ? { ...a.budgetRequest, amount: num(a.budgetRequest.amount) } : null,
    })),
  };
}

/** Which settleable an allocation row points at. Exactly one of the five is set. */
function allocationKind(a: {
  invoiceId: string | null;
  billId: string | null;
  claimId: string | null;
  advanceId: string | null;
  budgetRequestId: string | null;
}, paymentKind: PaymentKind): SettleableKind {
  if (a.invoiceId) return 'invoice';
  if (a.billId) return 'bill';
  if (a.claimId) return 'claim';
  // Direction decides what an advance or budget request allocation IS: money
  // out is the release, money in is unspent cash coming back.
  if (a.budgetRequestId) return paymentKind === 'RECEIPT' ? 'budget_request_refund' : 'budget_request';
  return paymentKind === 'RECEIPT' ? 'advance_refund' : 'advance';
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
    if (q.filters.payeeUserId) where.payeeUserId = q.filters.payeeUserId;
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
        // A person is a party too: reimbursements, releases and refunds.
        { payeeUser: { name: { contains: q.search, mode: 'insensitive' } } },
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
        kind: z.enum(['invoice', 'bill', 'claim', 'advance', 'advance_refund', 'budget_request', 'budget_request_refund']),
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

    // Money in settles what is owed TO us: a customer's invoice, or a person's
    // unspent advance coming back. Money out settles what we owe: a bill, a
    // claim, or the advance itself.
    const MONEY_IN = ['invoice', 'advance_refund', 'budget_request_refund'];
    if (body.kind === 'RECEIPT' && body.allocations.some((a) => !MONEY_IN.includes(a.kind))) {
      throw badRequest('A receipt settles customer invoices or returns unspent cash. Record money going out as a disbursement.');
    }
    if (body.kind === 'DISBURSEMENT' && body.allocations.some((a) => MONEY_IN.includes(a.kind))) {
      throw badRequest('A disbursement settles supplier bills, expense claims, cash advances or budget requests, not money coming in.');
    }

    const amount = cents(body.allocations.reduce((s, a) => s + a.amount, 0));
    if (amount <= 0) throw badRequest('The payment must be more than zero');

    // Every allocation is checked against what is actually still owed, before
    // anything is written. Over-applying is how a document ends up "more than
    // paid" and an aging report goes negative.
    const advances: { id: string; number: string }[] = [];
    const requests: { id: string; number: string }[] = [];
    for (const allocation of body.allocations) {
      const target = await settleable(allocation.kind as SettleableKind, allocation.id);
      if (!target) throw notFound(`That ${allocation.kind.replace(/_/g, ' ')} does not exist`);
      if (allocation.amount > target.outstanding + 0.005) {
        throw badRequest(
          `${target.number} has only ${target.outstanding} outstanding, but ${allocation.amount} is being applied to it.`,
        );
      }
      // An advance — and a budget request — is released in one voucher. Half
      // of one is a second document with its own liquidation, and the paper
      // form has no such thing.
      if (allocation.kind === 'advance' || allocation.kind === 'budget_request') {
        const what = allocation.kind === 'advance' ? 'An advance' : 'A budget request';
        if (target.outstanding <= 0.005) throw badRequest(`${target.number} is not waiting to be released`);
        if (Math.abs(allocation.amount - target.outstanding) > 0.005) {
          throw badRequest(`${what} is released in one voucher — release PHP ${target.outstanding} or cancel it`);
        }
        (allocation.kind === 'advance' ? advances : requests).push({ id: target.id, number: target.number });
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
              advanceId: a.kind === 'advance' || a.kind === 'advance_refund' ? a.id : null,
              budgetRequestId: a.kind === 'budget_request' || a.kind === 'budget_request_refund' ? a.id : null,
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

    // The person now holds the cash; the liquidation clock has started.
    for (const adv of advances) {
      const released = await prisma.cashAdvance.findUnique({
        where: { id: adv.id },
        select: { requestedById: true, liquidationDueDate: true, amountReleased: true },
      });
      if (!released) continue;
      const due = released.liquidationDueDate ? formatDate(released.liquidationDueDate) : 'the due date';
      await notify({
        userId: released.requestedById,
        type: 'system',
        title: `${adv.number} released — liquidate by ${due}`,
        body: `${num(released.amountReleased)} has been released to you. File the receipts as a liquidation before ${due}.`,
        link: `/g-fin/cash-advances/${adv.id}`,
      });
      await audit(
        {
          entityType: 'cash_advance',
          entityId: adv.id,
          action: 'UPDATED',
          summary: `${adv.number} released on ${payment.number} — liquidate by ${due}`,
        },
        req,
      );
    }
    // The team now holds the project's cash; its liquidation clock has started.
    for (const br of requests) {
      const released = await prisma.budgetRequest.findUnique({
        where: { id: br.id },
        select: { requestedById: true, liquidationDueDate: true, amountReleased: true, job: { select: { number: true } } },
      });
      if (!released) continue;
      const due = released.liquidationDueDate ? formatDate(released.liquidationDueDate) : 'the due date';
      await notify({
        userId: released.requestedById,
        type: 'system',
        title: `${br.number} released — liquidate by ${due}`,
        body: `${num(released.amountReleased)} has been released for ${released.job.number}. File the receipts as a liquidation in Expenses before ${due}.`,
        link: `/g-ops/budget-requests/${br.id}`,
      });
      await audit(
        {
          entityType: 'budget_request',
          entityId: br.id,
          action: 'UPDATED',
          summary: `${br.number} released on ${payment.number} — liquidate by ${due}`,
        },
        req,
      );
    }

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
      kind: allocationKind(a, payment.kind),
      id: (a.invoiceId ?? a.billId ?? a.claimId ?? a.advanceId ?? a.budgetRequestId)!,
    }));

    // Reversing a release while somebody is accounting for that cash would
    // leave a liquidation pointing at cash that was never handed over.
    for (const t of touched) {
      if (t.kind !== 'advance' && t.kind !== 'budget_request') continue;
      const live = await prisma.expenseClaim.findFirst({
        where: {
          ...(t.kind === 'advance' ? { advanceId: t.id } : { budgetRequestId: t.id }),
          status: { in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SETTLED', 'REIMBURSED'] },
        },
        select: { number: true },
      });
      if (live) {
        throw badRequest(`${live.number} is liquidating this ${t.kind === 'advance' ? 'advance' : 'budget request'}. Cancel the liquidation first.`);
      }
    }

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
    if (kind === 'advance' || kind === 'advance_refund') {
      const rows = await prisma.cashAdvance.findMany({
        where: {
          status: kind === 'advance' ? 'APPROVED' : 'REFUND_DUE',
          ...(partyId ? { requestedById: partyId } : {}),
        },
        include: { requestedBy: { select: { id: true, name: true } } },
        orderBy: { requestDate: 'asc' },
      });
      res.json(
        rows
          .map((r) => {
            const released = num(r.amountReleased);
            const outstanding =
              kind === 'advance'
                ? cents(num(r.amount) - released)
                : cents(Math.max(0, released - num(r.amountSpent)) - num(r.amountRefunded));
            return {
              id: r.id,
              number: r.number,
              purpose: r.purpose,
              status: r.status,
              requestedBy: r.requestedBy,
              amount: num(r.amount),
              outstanding,
            };
          })
          .filter((r) => r.outstanding > 0.005),
      );
      return;
    }
    if (kind === 'budget_request' || kind === 'budget_request_refund') {
      const rows = await prisma.budgetRequest.findMany({
        where: {
          status: kind === 'budget_request' ? 'APPROVED' : 'REFUND_DUE',
          ...(partyId ? { requestedById: partyId } : {}),
        },
        include: { requestedBy: { select: { id: true, name: true } }, job: { select: { number: true } } },
        orderBy: { createdAt: 'asc' },
      });
      res.json(
        rows
          .map((r) => {
            const released = num(r.amountReleased);
            const outstanding =
              kind === 'budget_request'
                ? cents(num(r.amount) - released)
                : cents(Math.max(0, released - num(r.amountSpent)) - num(r.amountRefunded));
            return {
              id: r.id,
              number: r.number,
              purpose: `${r.job.number} — ${r.reason}`,
              status: r.status,
              requestedBy: r.requestedBy,
              amount: num(r.amount),
              outstanding,
            };
          })
          .filter((r) => r.outstanding > 0.005),
      );
      return;
    }
    throw badRequest('Ask for invoice, bill, claim, advance, advance_refund, budget_request or budget_request_refund');
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

    const [claims, advances] = await Promise.all([
      prisma.expenseClaim.findMany({
        where: { status: 'APPROVED' },
        include: { claimedBy: { select: { id: true, name: true } }, advance: { select: { amountReleased: true } } },
      }),
      prisma.cashAdvance.findMany({
        where: { status: 'RELEASED' },
        include: { requestedBy: { select: { id: true, name: true } } },
        orderBy: { liquidationDueDate: 'asc' },
      }),
    ]);
    const unreimbursed = claims
      .map((c) => ({
        id: c.id,
        number: c.number,
        person: c.claimedBy.name,
        claimDate: c.claimDate,
        outstanding: cents(claimPayable(c) - num(c.amountPaid)),
      }))
      .filter((c) => c.outstanding > 0.005);
    // Cash out with people and not yet accounted for. Not a payable — the
    // company is the creditor here — but the aging screen is where finance
    // looks for money that has stopped moving.
    const unliquidated = advances.map((a) => ({
      id: a.id,
      number: a.number,
      person: a.requestedBy.name,
      releasedAt: a.releasedAt,
      liquidationDueDate: a.liquidationDueDate,
      daysOverdue: a.liquidationDueDate ? daysBetween(a.liquidationDueDate, asOf) : 0,
      amount: num(a.amountReleased),
    }));

    res.json({
      asOf,
      buckets: summarise(rows, settings.agingBuckets),
      rows,
      suppliers: [...bySupplier.values()].sort((a, b) => b.outstanding - a.outstanding),
      totalOutstanding: cents(rows.reduce((s, r) => s + r.outstanding, 0)),
      totalOverdue: cents(rows.filter((r) => r.daysOverdue > 0).reduce((s, r) => s + r.outstanding, 0)),
      unreimbursedClaims: unreimbursed,
      unreimbursedTotal: cents(unreimbursed.reduce((s, c) => s + c.outstanding, 0)),
      unliquidatedAdvances: unliquidated,
      unliquidatedTotal: cents(unliquidated.reduce((s, a) => s + a.amount, 0)),
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
    const [openInvoices, openBills, openClaims, openAdvances, openRequests, uncleared] = await Promise.all([
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
        select: {
          claimDate: true,
          total: true,
          amountPaid: true,
          advance: { select: { amountReleased: true } },
          budgetRequest: { select: { amountReleased: true } },
        },
      }),
      prisma.cashAdvance.findMany({
        where: { status: { in: ['APPROVED', 'REFUND_DUE'] } },
        select: {
          status: true,
          amount: true,
          amountReleased: true,
          amountSpent: true,
          amountRefunded: true,
          requestDate: true,
          neededBy: true,
          liquidationDueDate: true,
        },
      }),
      // Project cash: the same two movements, on the budget request.
      prisma.budgetRequest.findMany({
        where: { status: { in: ['APPROVED', 'REFUND_DUE'] } },
        select: {
          status: true,
          amount: true,
          amountReleased: true,
          amountSpent: true,
          amountRefunded: true,
          createdAt: true,
          neededBy: true,
          liquidationDueDate: true,
        },
      }),
      prisma.payment.findMany({
        where: { clearedAt: null },
        select: { id: true, kind: true, amount: true, paymentDate: true, number: true, method: true },
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
      place(claim.claimDate, cents(claimPayable(claim) - num(claim.amountPaid)), 'out');
    }
    // An approved advance goes out when the person needs it; unspent cash
    // comes back by the liquidation deadline, or today if it has passed.
    let advancesToRelease = 0;
    let refundsDue = 0;
    for (const adv of openAdvances) {
      if (adv.status === 'APPROVED') {
        const out = cents(num(adv.amount) - num(adv.amountReleased));
        advancesToRelease = cents(advancesToRelease + out);
        place(adv.neededBy ?? adv.requestDate, out, 'out');
      } else {
        const back = cents(Math.max(0, num(adv.amountReleased) - num(adv.amountSpent)) - num(adv.amountRefunded));
        refundsDue = cents(refundsDue + back);
        place(adv.liquidationDueDate ?? to, back, 'in');
      }
    }
    let budgetRequestsToRelease = 0;
    for (const br of openRequests) {
      if (br.status === 'APPROVED') {
        const out = cents(num(br.amount) - num(br.amountReleased));
        budgetRequestsToRelease = cents(budgetRequestsToRelease + out);
        place(br.neededBy ?? dayKey(br.createdAt), out, 'out');
      } else {
        const back = cents(Math.max(0, num(br.amountReleased) - num(br.amountSpent)) - num(br.amountRefunded));
        refundsDue = cents(refundsDue + back);
        place(br.liquidationDueDate ?? to, back, 'in');
      }
    }
    for (const f of forecast) f.net = cents(f.in - f.out);

    res.json({
      months: actual,
      forecast,
      advancesToRelease,
      budgetRequestsToRelease,
      refundsDue,
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

    // The position itself is decided in shared/finance.ts so that Insights'
    // company overview cannot print a different working position.
    const [
      position,
      receiptsThisMonth,
      receiptsThisYear,
      invoicedThisYear,
      uninvoicedBillings,
      unbilledReceivings,
      advancesAwaitingRelease,
      liquidationsOverdue,
      refundsAwaitingReceipt,
      activeJobs,
      budgetRequestsAwaitingRelease,
      budgetLiquidationsOverdue,
      budgetRefundsAwaitingReceipt,
    ] = await Promise.all([
      financePosition(today),
      // Customer receipts only. A person returning unspent advance money is
      // cash in, but it was never a collection.
      prisma.payment.aggregate({
        where: { kind: 'RECEIPT', customerId: { not: null }, clearedAt: { gte: monthStart } },
        _sum: { amount: true },
      }),
      prisma.payment.aggregate({
        where: { kind: 'RECEIPT', customerId: { not: null }, clearedAt: { gte: yearStart } },
        _sum: { amount: true },
      }),
      prisma.invoice.aggregate({
        where: { invoiceDate: { gte: yearStart }, status: { not: 'CANCELLED' } },
        _sum: { grossAmount: true },
      }),
      prisma.progressBilling.count({ where: { status: 'APPROVED', invoice: null } }),
      prisma.receiving.count({ where: { bills: { none: {} } } }),
      prisma.cashAdvance.count({ where: { status: 'APPROVED' } }),
      prisma.cashAdvance.count({ where: { status: 'RELEASED', liquidationDueDate: { lt: today } } }),
      prisma.cashAdvance.count({ where: { status: 'REFUND_DUE' } }),
      prisma.job.count({ where: { status: { in: ['PLANNING', 'IN_PROGRESS'] } } }),
      prisma.budgetRequest.count({ where: { status: 'APPROVED' } }),
      prisma.budgetRequest.count({ where: { status: 'RELEASED', liquidationDueDate: { lt: today } } }),
      prisma.budgetRequest.count({ where: { status: 'REFUND_DUE' } }),
    ]);

    res.json({
      asOf: today,
      receivable: position.receivable,
      receivableOverdue: position.receivableOverdue,
      payable: position.payable,
      payableOverdue: position.payableOverdue,
      reimbursable: position.reimbursable,
      advancesInHand: position.advancesInHand,
      advancesToRelease: position.advancesToRelease,
      budgetRequestsInHand: position.budgetRequestsInHand,
      budgetRequestsToRelease: position.budgetRequestsToRelease,
      workingPosition: position.workingPosition,
      collectedThisMonth: cents(num(receiptsThisMonth._sum.amount)),
      collectedThisYear: cents(num(receiptsThisYear._sum.amount)),
      invoicedThisYear: cents(num(invoicedThisYear._sum.grossAmount)),
      withheldAwaitingCertificate: position.withheldAwaitingCertificate,
      queue: {
        billingsAwaitingInvoice: uninvoicedBillings,
        receivingsAwaitingBill: unbilledReceivings,
        advancesAwaitingRelease,
        liquidationsOverdue,
        refundsAwaitingReceipt,
        budgetRequestsAwaitingRelease,
        budgetLiquidationsOverdue,
        budgetRefundsAwaitingReceipt,
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
        advanceLiquidationDays: z.number().int().min(1).max(365).optional(),
        blockAdvanceWhileUnliquidated: z.boolean().optional(),
        budgetRequestLiquidationDays: z.number().int().min(1).max(365).optional(),
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
