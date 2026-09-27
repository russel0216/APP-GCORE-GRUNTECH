import { Router, type Request } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import multer from 'multer';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { env } from '../env';
import { handler, parseBody, listQuery, listResult, orderBy, notFound, badRequest, type ListQuery } from '../http/kit';
import { authenticate, require_, currentUser } from '../auth/middleware';
import { can, type ResolvedUser } from '../permissions/resolve';
import { audit } from '../shared/audit';
import { attachmentPath, registerAttachmentGuard } from '../shared/attachments';
import { toCsv } from '../shared/insights';
import { canSeeQuotationCost } from '../shared/quotation';
import {
  LEGACY_QUOTE_ENTITY,
  OPEN_STATUSES,
  CLOSED_STATUSES,
  isOpenStatus,
  importBundle,
  continueLegacyQuote,
} from '../shared/legacyQuotes';

/**
 * G-OPS › Sales › SCORO Archive — the read-only history of quotations raised
 * in SCORO before Gruntech moved to G-CORE (see LegacyQuote in schema.prisma
 * and shared/legacyQuotes.ts).
 *
 * Gated by gops.quote_archive.*: view_all to browse, export for the CSV,
 * create to run the SCORO import and to link a quote to a customer by hand.
 * Continuing an open SCORO quote as a live quotation is gated by
 * gops.quotations.create, not by anything here.
 *
 * Nothing here edits a SCORO quote's commercial content. The PDF is the record.
 */
export const quoteArchiveRoutes = Router();
quoteArchiveRoutes.use(authenticate);

// The stored SCORO PDFs are served through the generic attachment routes too;
// seeing one needs the same right as seeing the archive.
registerAttachmentGuard(LEGACY_QUOTE_ENTITY, async (user) => can(user, 'gops.quote_archive.view_all'));

/**
 * SCORO's cost is internal — the same rule as a live quotation's cost
 * (canSeeQuotationCost): the quote's own author, anyone who may edit every
 * quotation, or anyone who sees costings company-wide.
 */
const maySeeCost = (user: ResolvedUser, ownerUserId: string | null = null) => canSeeQuotationCost(user, ownerUserId);

function whereFor(q: ListQuery): Prisma.LegacyQuoteWhereInput {
  const where: Prisma.LegacyQuoteWhereInput = {};
  const and: Prisma.LegacyQuoteWhereInput[] = [];
  if (q.search) {
    and.push({
      OR: [
        { number: { contains: q.search, mode: 'insensitive' } },
        { customerName: { contains: q.search, mode: 'insensitive' } },
        { customer: { name: { contains: q.search, mode: 'insensitive' } } },
        { name: { contains: q.search, mode: 'insensitive' } },
        { projectName: { contains: q.search, mode: 'insensitive' } },
        { ownerName: { contains: q.search, mode: 'insensitive' } },
        { contactName: { contains: q.search, mode: 'insensitive' } },
        { prNumber: { contains: q.search, mode: 'insensitive' } },
      ],
    });
  }
  const f = q.filters;
  const anyOf = (list: string[]) => ({ OR: list.map((s) => ({ status: { equals: s, mode: 'insensitive' as const } })) });
  if (f.status === 'OPEN') and.push(anyOf(OPEN_STATUSES));
  else if (f.status === 'CLOSED') and.push(anyOf(CLOSED_STATUSES));
  else if (f.status) and.push({ status: { equals: f.status, mode: 'insensitive' } });
  if (f.owner) and.push({ ownerName: { equals: f.owner, mode: 'insensitive' } });
  if (f.customerId) and.push({ customerId: f.customerId });
  if (f.customer === 'unmatched') and.push({ customerId: null });
  if (f.year && /^\d{4}$/.test(f.year)) {
    const y = Number(f.year);
    and.push({ date: { gte: new Date(Date.UTC(y, 0, 1)), lt: new Date(Date.UTC(y + 1, 0, 1)) } });
  }
  if (f.continued === 'yes') and.push({ continuedQuotationId: { not: null } });
  if (f.continued === 'no') and.push({ continuedQuotationId: null });
  if (and.length) where.AND = and;
  return where;
}

const SORTABLE = ['number', 'date', 'total', 'customerName', 'status', 'ownerName'];

const listSelect = {
  id: true,
  number: true,
  date: true,
  customerName: true,
  customerId: true,
  customer: { select: { id: true, name: true } },
  contactName: true,
  name: true,
  projectName: true,
  ownerName: true,
  status: true,
  currency: true,
  total: true,
  linesReconcile: true,
  continuedQuotation: { select: { id: true, number: true } },
} satisfies Prisma.LegacyQuoteSelect;

function presentRow(r: Prisma.LegacyQuoteGetPayload<{ select: typeof listSelect }>) {
  return { ...r, total: Number(r.total), isOpen: isOpenStatus(r.status) };
}

// ── List ─────────────────────────────────────────────────────────────────────

quoteArchiveRoutes.get(
  '/',
  require_('gops.quote_archive.view_all'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const where = whereFor(q);
    const [rows, total] = await Promise.all([
      prisma.legacyQuote.findMany({
        where,
        select: listSelect,
        orderBy: [orderBy(q, SORTABLE, { date: 'desc' }), { number: 'desc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.legacyQuote.count({ where }),
    ]);
    res.json(listResult(rows.map(presentRow), total, q));
  }),
);

/** The filter options: who raised quotes, which years, which statuses. Above /:id. */
quoteArchiveRoutes.get(
  '/facets',
  require_('gops.quote_archive.view_all'),
  handler(async (_req, res) => {
    const [owners, statuses, dates, count, unmatched] = await Promise.all([
      prisma.legacyQuote.groupBy({ by: ['ownerName'], _count: { _all: true }, orderBy: { ownerName: 'asc' } }),
      prisma.legacyQuote.groupBy({ by: ['status'], _count: { _all: true }, orderBy: { status: 'asc' } }),
      prisma.legacyQuote.findMany({ where: { date: { not: null } }, select: { date: true }, distinct: ['date'] }),
      prisma.legacyQuote.count(),
      prisma.legacyQuote.count({ where: { customerId: null } }),
    ]);
    const years = [...new Set(dates.map((d) => d.date!.getUTCFullYear()))].sort((a, b) => b - a);
    res.json({
      total: count,
      unmatched,
      owners: owners.map((o) => ({ name: o.ownerName, count: o._count._all })),
      statuses: statuses.map((s) => ({ status: s.status, count: s._count._all, open: isOpenStatus(s.status) })),
      years,
      openStatuses: OPEN_STATUSES,
      closedStatuses: CLOSED_STATUSES,
    });
  }),
);

/** The archive as CSV, with the list's filters. Audited BEFORE the bytes go out. Above /:id. */
quoteArchiveRoutes.get(
  '/export.csv',
  require_('gops.quote_archive.export'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const where = whereFor(q);
    const withCost = maySeeCost(me);
    const rows = await prisma.legacyQuote.findMany({
      where,
      orderBy: [orderBy(q, SORTABLE, { date: 'desc' }), { number: 'desc' }],
      include: { continuedQuotation: { select: { number: true } }, customer: { select: { name: true } } },
    });

    const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '');
    const header = [
      'Number', 'Date', 'Customer', 'G-CORE customer', 'Contact', 'Quote name', 'Project', 'Owner', 'Status',
      'Currency', 'Discount %', 'Sum without tax', 'VAT', 'Total',
      ...(withCost ? ['Cost'] : []),
      'PR Number', 'Delivery', 'Payment Terms', 'Due date', 'Estimated closing', 'Confirmed', 'Invoices',
      'Lines reconcile', 'Continued as',
    ];
    const body = rows.map((r) => [
      r.number, day(r.date), r.customerName, r.customer?.name ?? '', r.contactName, r.name, r.projectName, r.ownerName,
      r.status, r.currency, Number(r.discountPct), Number(r.subtotal), Number(r.vat), Number(r.total),
      ...(withCost ? [Number(r.cost)] : []),
      r.prNumber, r.delivery, r.paymentTerms, day(r.dueDate), day(r.estimatedClosing),
      r.confirmedAt ? r.confirmedAt.toISOString() : '', r.invoiceNos, r.linesReconcile ? 'yes' : 'no',
      r.continuedQuotation?.number ?? '',
    ]);

    await audit(
      {
        entityType: LEGACY_QUOTE_ENTITY,
        entityId: 'export',
        action: 'EXPORTED',
        summary: `Exported ${rows.length} SCORO quotes to CSV`,
        after: { filters: q.filters, search: q.search || null, rows: rows.length, withCost },
      },
      req,
    );

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="scoro-quotes.csv"');
    res.send(toCsv(header, body));
  }),
);

// ── Import from the browser ─────────────────────────────────────────────────
// The same importBundle the console script runs, fed from a temporary folder
// shaped like the bundle: quotes.json at the top, the PDFs under pdf/.

type ImportRequest = Request & { scoroDir?: string };

const importUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const base = (req as ImportRequest).scoroDir!;
      const dir = file.fieldname === 'quotes' ? base : path.join(base, 'pdf');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      if (file.fieldname === 'quotes') return cb(null, 'quotes.json');
      // The bundle names each PDF after its quote number; keep that, safely.
      cb(null, path.basename(file.originalname).replace(/[^\w.\-]/g, '_'));
    },
  }),
  limits: { fileSize: env.maxUploadMb * 1024 * 1024, files: 2000 },
  fileFilter: (_req, file, cb) => {
    if (file.fieldname === 'quotes' && /\.json$/i.test(file.originalname)) return cb(null, true);
    if (file.fieldname === 'pdfs' && /\.pdf$/i.test(file.originalname)) return cb(null, true);
    cb(badRequest(`"${file.originalname}" is not part of a SCORO bundle — send quotes.json and the quotes' PDFs`));
  },
});

quoteArchiveRoutes.post(
  '/import',
  require_('gops.quote_archive.create'),
  (req, _res, next) => {
    (req as ImportRequest).scoroDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcore-scoro-'));
    next();
  },
  (req, res, next) => {
    importUpload.fields([
      { name: 'quotes', maxCount: 1 },
      { name: 'pdfs', maxCount: 1999 },
    ])(req, res, (err: unknown) => {
      if (err) {
        const dir = (req as ImportRequest).scoroDir;
        if (dir) fs.rmSync(dir, { recursive: true, force: true });
        return next(err instanceof multer.MulterError ? badRequest(err.message) : err);
      }
      next();
    });
  },
  handler(async (req, res) => {
    const dir = (req as ImportRequest).scoroDir!;
    try {
      const me = currentUser(req);
      if (!fs.existsSync(path.join(dir, 'quotes.json'))) throw badRequest('Choose the bundle\'s quotes.json');
      const report = await importBundle(dir, {
        commit: req.query.commit === 'true',
        actorId: me.id,
        actorName: me.name,
        req,
      });
      res.json(report);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }),
);

// ── One quote ────────────────────────────────────────────────────────────────

async function pdfOf(id: string) {
  return prisma.attachment.findFirst({
    where: { entityType: LEGACY_QUOTE_ENTITY, entityId: id },
    orderBy: { uploadedAt: 'desc' },
  });
}

quoteArchiveRoutes.get(
  '/:id',
  require_('gops.quote_archive.view_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const lq = await prisma.legacyQuote.findUnique({
      where: { id: req.params.id },
      include: {
        customer: { select: { id: true, name: true, code: true } },
        ownerUser: { select: { id: true, name: true } },
        importedBy: { select: { id: true, name: true } },
        continuedQuotation: { select: { id: true, number: true, outcome: true } },
      },
    });
    if (!lq) throw notFound('SCORO quote not found');
    const pdf = await pdfOf(lq.id);
    const withCost = maySeeCost(me, lq.ownerUserId);
    const lines = (Array.isArray(lq.lines) ? lq.lines : []) as Record<string, unknown>[];
    const n = (v: unknown) => {
      const x = Number(String(v ?? '').replace(/,/g, ''));
      return Number.isFinite(x) ? x : 0;
    };

    const { cost, ...rest } = lq;
    res.json({
      ...rest,
      ...(withCost ? { cost: Number(cost) } : {}),
      discountPct: Number(lq.discountPct),
      subtotal: Number(lq.subtotal),
      vat: Number(lq.vat),
      total: Number(lq.total),
      lines: lines.map((l) => ({
        title: String(l.title ?? ''),
        description: String(l.description ?? ''),
        quantity: n(l.quantity),
        unit: String(l.unit ?? ''),
        unitPrice: n(l.unitPrice),
        amount: n(l.amount),
      })),
      attachmentId: pdf?.id ?? null,
      isOpen: isOpenStatus(lq.status),
      canContinue:
        isOpenStatus(lq.status) && !lq.continuedQuotationId && can(me, 'gops.quotations.create'),
      canLink: can(me, 'gops.quote_archive.create'),
    });
  }),
);

quoteArchiveRoutes.get(
  '/:id/pdf',
  require_('gops.quote_archive.view_all'),
  handler(async (req, res) => {
    const lq = await prisma.legacyQuote.findUnique({ where: { id: req.params.id }, select: { id: true, number: true } });
    if (!lq) throw notFound('SCORO quote not found');
    const pdf = await pdfOf(lq.id);
    if (!pdf) throw notFound('No PDF was exported from SCORO for this quote');
    const full = attachmentPath(pdf.storedName);
    if (!fs.existsSync(full)) throw notFound('The stored PDF is missing from disk');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(`${lq.number}.pdf`)}"`);
    fs.createReadStream(full).pipe(res);
  }),
);

/** Continue an OPEN SCORO quote as a live G-CORE quotation under the same number. */
quoteArchiveRoutes.post(
  '/:id/continue',
  require_('gops.quotations.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const result = await continueLegacyQuote(req.params.id, { id: me.id, name: me.name }, req);
    res.status(201).json(result);
  }),
);

/** Link a quote the import could not match to the G-CORE customer it belongs to. */
quoteArchiveRoutes.patch(
  '/:id/customer',
  require_('gops.quote_archive.create'),
  handler(async (req, res) => {
    const body = parseBody(z.object({ customerId: z.string().min(1, 'Choose a customer') }), req.body);
    const lq = await prisma.legacyQuote.findUnique({
      where: { id: req.params.id },
      select: { id: true, number: true, customerId: true, customerName: true },
    });
    if (!lq) throw notFound('SCORO quote not found');
    const customer = await prisma.customer.findUnique({ where: { id: body.customerId }, select: { id: true, name: true } });
    if (!customer) throw badRequest('That customer does not exist');

    await prisma.legacyQuote.update({ where: { id: lq.id }, data: { customerId: customer.id } });
    await audit(
      {
        entityType: LEGACY_QUOTE_ENTITY,
        entityId: lq.id,
        action: 'UPDATED',
        summary: `SCORO quote ${lq.number} (${lq.customerName}) linked to customer ${customer.name}`,
        before: { customerId: lq.customerId },
        after: { customerId: customer.id },
      },
      req,
    );
    res.json({ ok: true, customer });
  }),
);
