import { Router } from 'express';
import { z } from 'zod';
import { Prisma, JobOrderStatus, ServiceKind, ChargeBasis } from '@prisma/client';
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
import { can, canEditRecord, type ResolvedUser } from '../permissions/resolve';
import { audit } from '../shared/audit';
import { nextNumber } from '../shared/numbering';
import { notify } from '../shared/notifications';
import { submitForApproval, onApprovalSettled, approvalSignoffs, type ApprovalOutcome } from '../shared/approvals';
import { renderDocument, formatDate, formatMoney, type PdfSection } from '../shared/pdf';
import { registerSearch } from '../shared/search';
import { coverageFor, dayKey, type Coverage } from '../shared/aftermarket';
import { KIND_LABEL } from './aftermarket';

/**
 * Job orders — a request for service work, usually from sales (model §4.5).
 *
 * The AUTHORISATION document of the aftermarket chain:
 *
 *   job order (asked, approved) → one visit (attended) → one report (evidence)
 *     → the order completes → a chargeable one is invoiced once.
 *
 * It carries no cost of its own. Labour, parts and out-of-pocket reach its
 * `jobId` through overtime, PRs, stock issues and expense claims that quote
 * that job — warranty work on the project that sold the machine, contract
 * work on the contract's job. Posting an estimate here as well would count
 * the same work twice.
 */

export { coverageFor };
export type { Coverage };

export const jobOrderRoutes = Router();
jobOrderRoutes.use(authenticate);

const num = (v: Prisma.Decimal | null | undefined) => (v == null ? null : Number(v));

function asEnum<T extends Record<string, string>>(e: T, value: string | undefined): T[keyof T] | undefined {
  return value && value in e ? (value as T[keyof T]) : undefined;
}

function asDate(value: string, label: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw badRequest(`${label} is not a valid date`);
  return dayKey(date);
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

const jobOrderInclude = {
  customer: { select: { id: true, code: true, name: true } },
  site: { select: { id: true, name: true, city: true } },
  contact: { select: { id: true, name: true, phone: true } },
  asset: {
    select: { id: true, code: true, name: true, model: true, serialNo: true, warrantyEndsAt: true },
  },
  contract: { select: { id: true, number: true, endsAt: true } },
  job: { select: { id: true, number: true, name: true } },
  quotation: { select: { id: true, number: true, subject: true } },
  requestedBy: { select: { id: true, name: true, position: true } },
  assignedTo: { select: { id: true, name: true } },
  visit: {
    select: {
      id: true,
      number: true,
      status: true,
      dueDate: true,
      report: { select: { id: true, number: true, status: true } },
    },
  },
  invoice: { select: { id: true, number: true, status: true } },
} satisfies Prisma.JobOrderInclude;

type JobOrderRow = Prisma.JobOrderGetPayload<{ include: typeof jobOrderInclude }>;

function present(row: JobOrderRow) {
  return {
    ...row,
    amount: num(row.amount),
    billable: row.chargeBasis === 'CHARGEABLE',
  };
}

/** Somebody with only view_own sees the orders they raised or were sent to. */
function onlyOwn(me: ResolvedUser): boolean {
  return !can(me, 'gops.job_orders.view_all');
}

function mayOpen(me: ResolvedUser, row: { requestedById: string; assignedToId: string | null }): boolean {
  return !onlyOwn(me) || row.requestedById === me.id || row.assignedToId === me.id;
}

async function load(id: string): Promise<JobOrderRow> {
  const row = await prisma.jobOrder.findUnique({ where: { id }, include: jobOrderInclude });
  if (!row) throw notFound('Job order not found');
  return row;
}

const subjectOf = (row: {
  kind: string;
  urgent: boolean;
  customer: { name: string };
  asset: { name: string } | null;
}) =>
  `${KIND_LABEL[row.kind]} — ${row.customer.name}${row.asset ? ` — ${row.asset.name}` : ''}${row.urgent ? ' (URGENT)' : ''}`;

// ── List ────────────────────────────────────────────────────────────────────

jobOrderRoutes.get(
  '/',
  requireAny('gops.job_orders.view_all', 'gops.job_orders.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const where: Prisma.JobOrderWhereInput = {};
    const and: Prisma.JobOrderWhereInput[] = [];

    // An engineer's "mine" is what is dispatched to them, as well as what
    // they raised themselves.
    if (onlyOwn(me) || q.scope === 'mine') {
      and.push({ OR: [{ requestedById: me.id }, { assignedToId: me.id }] });
    }

    const status = asEnum(JobOrderStatus, q.filters.status);
    if (status) where.status = status;
    if (q.filters.open === 'true') where.status = 'APPROVED';
    const kind = asEnum(ServiceKind, q.filters.kind);
    if (kind) where.kind = kind;
    const basis = asEnum(ChargeBasis, q.filters.chargeBasis);
    if (basis) where.chargeBasis = basis;
    // The unbilled-service queue finance works from.
    if (q.filters.unbilled === 'true') {
      where.chargeBasis = 'CHARGEABLE';
      where.status = 'COMPLETED';
      where.invoice = { is: null };
    }
    for (const key of ['customerId', 'assetId', 'assignedToId', 'contractId', 'jobId', 'quotationId'] as const) {
      if (q.filters[key]) where[key] = q.filters[key];
    }
    if (q.filters.from || q.filters.to) {
      where.requestedFor = {};
      if (q.filters.from) where.requestedFor.gte = asDate(q.filters.from, 'From');
      if (q.filters.to) where.requestedFor.lte = asDate(q.filters.to, 'To');
    }
    if (q.search) {
      and.push({
        OR: [
          { number: { contains: q.search, mode: 'insensitive' } },
          { title: { contains: q.search, mode: 'insensitive' } },
          { customer: { name: { contains: q.search, mode: 'insensitive' } } },
          { asset: { serialNo: { contains: q.search, mode: 'insensitive' } } },
        ],
      });
    }
    if (and.length) where.AND = and;

    const [rows, total] = await Promise.all([
      prisma.jobOrder.findMany({
        where,
        include: jobOrderInclude,
        orderBy: orderBy(q, ['number', 'requestedFor', 'createdAt'], { requestedFor: 'asc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.jobOrder.count({ where }),
    ]);

    res.json(listResult(rows.map(present), total, q));
  }),
);

// ── Lookups for the form (above /:id — route order) ─────────────────────────

/**
 * What covers this machine on this day — so the form can explain the charge
 * basis before anything is saved.
 */
jobOrderRoutes.get(
  '/coverage',
  requireAny('gops.job_orders.view_all', 'gops.job_orders.view_own', 'gops.job_orders.create'),
  handler(async (req, res) => {
    const assetId = typeof req.query.assetId === 'string' && req.query.assetId ? req.query.assetId : null;
    const date = typeof req.query.date === 'string' && req.query.date ? asDate(req.query.date, 'Date') : dayKey(new Date());
    res.json(await coverageFor(assetId, date));
  }),
);

/**
 * The pickers the form needs, behind the form's own permission.
 *
 * A salesperson raising a breakdown call holds no Installed Base permission,
 * so the asset list cannot come from `/installed-assets`; and handing out the
 * whole customer master through a lookup would be wider than the form needs.
 * This returns the customer names, then — for one customer — its sites,
 * contacts, machines, quotations and jobs. Names and numbers only.
 */
jobOrderRoutes.get(
  '/options',
  requireAny('gops.job_orders.create', 'gops.job_orders.edit_own', 'gops.job_orders.edit_all'),
  handler(async (req, res) => {
    const customerId = typeof req.query.customerId === 'string' ? req.query.customerId : '';
    if (!customerId) {
      const customers = await prisma.customer.findMany({
        where: { isActive: true },
        select: { id: true, code: true, name: true },
        orderBy: { name: 'asc' },
        take: 1000,
      });
      res.json({ customers });
      return;
    }
    const [sites, contacts, assets, quotations, jobs] = await Promise.all([
      prisma.customerSite.findMany({
        where: { customerId },
        select: { id: true, name: true, city: true },
        orderBy: { name: 'asc' },
      }),
      prisma.customerContact.findMany({
        where: { customerId },
        select: { id: true, name: true, phone: true },
        orderBy: { name: 'asc' },
      }),
      prisma.installedAsset.findMany({
        where: { customerId, status: { not: 'DECOMMISSIONED' } },
        select: { id: true, code: true, name: true, serialNo: true, siteId: true, warrantyEndsAt: true },
        orderBy: { name: 'asc' },
        take: 500,
      }),
      prisma.quotation.findMany({
        where: { customerId },
        select: { id: true, number: true, subject: true, outcome: true },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      prisma.job.findMany({
        where: { customerId, status: { not: 'CANCELLED' } },
        select: { id: true, number: true, name: true, type: true, status: true },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    ]);
    res.json({ sites, contacts, assets, quotations, jobs });
  }),
);

// ── Create and edit ─────────────────────────────────────────────────────────

const jobOrderSchema = z.object({
  customerId: z.string().min(1, 'Which customer?'),
  siteId: z.string().optional().nullable(),
  contactId: z.string().optional().nullable(),
  assetId: z.string().optional().nullable(),
  kind: z.enum(['COMMISSIONING', 'PREVENTIVE_MAINTENANCE', 'INSPECTION', 'CORRECTIVE']).default('CORRECTIVE'),
  urgent: z.boolean().optional(),
  title: z.string().trim().min(3, 'Say in a line what the job is'),
  description: z.string().trim().min(5, 'What did the customer report or ask for?'),
  scope: z.string().optional().nullable(),
  requestedFor: z.string().min(1, 'When does the customer want it?'),
  assignedToId: z.string().optional().nullable(),
  chargeBasis: z.enum(['WARRANTY', 'CONTRACT', 'CHARGEABLE', 'GOODWILL']).optional(),
  quotationId: z.string().optional().nullable(),
  customerPoNumber: z.string().trim().optional().nullable(),
  amount: z.number().min(0).optional().nullable(),
  jobId: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

/**
 * Cover, contract and charge-to job, decided together from the facts.
 *
 * CONTRACT needs an active contract that covers the machine on the day —
 * choosing it without one would charge the work to nothing. The job follows
 * the basis: the contract's job, the installing project, or the requester's
 * choice for chargeable and goodwill work.
 */
export async function decideCover(input: {
  assetId: string | null;
  requestedFor: Date;
  chargeBasis?: ChargeBasis;
  jobId?: string | null;
}) {
  const coverage = await coverageFor(input.assetId, input.requestedFor);
  const chargeBasis = input.chargeBasis ?? coverage.suggested;
  if (chargeBasis === 'CONTRACT' && !coverage.contract) {
    throw badRequest(
      'No active service contract covers this machine on that date. Choose another basis, or put the machine under contract first.',
    );
  }
  const contractId = chargeBasis === 'CONTRACT' ? coverage.contract!.id : null;
  const jobId =
    chargeBasis === 'CONTRACT'
      ? coverage.contract!.jobId
      : chargeBasis === 'WARRANTY'
        ? (coverage.installingJob?.id ?? input.jobId ?? null)
        : (input.jobId ?? null);
  return { coverage, chargeBasis, contractId, jobId, underWarranty: coverage.underWarranty };
}

/** Checks that everything a body names belongs to the order's customer. */
async function checkBelongs(customerId: string, body: {
  siteId?: string | null;
  contactId?: string | null;
  assetId?: string | null;
  quotationId?: string | null;
  jobId?: string | null;
}) {
  const [asset, site, contact, quotation, job] = await Promise.all([
    body.assetId ? prisma.installedAsset.findUnique({ where: { id: body.assetId }, select: { customerId: true } }) : null,
    body.siteId ? prisma.customerSite.findUnique({ where: { id: body.siteId }, select: { customerId: true } }) : null,
    body.contactId ? prisma.customerContact.findUnique({ where: { id: body.contactId }, select: { customerId: true } }) : null,
    body.quotationId ? prisma.quotation.findUnique({ where: { id: body.quotationId }, select: { customerId: true } }) : null,
    body.jobId ? prisma.job.findUnique({ where: { id: body.jobId }, select: { customerId: true } }) : null,
  ]);
  if (body.assetId && asset?.customerId !== customerId) throw badRequest('That machine is not at this customer');
  if (body.siteId && site?.customerId !== customerId) throw badRequest('That site is not this customer’s');
  if (body.contactId && contact?.customerId !== customerId) throw badRequest('That contact is not at this customer');
  if (body.quotationId && quotation?.customerId !== customerId) throw badRequest('That quotation is for another customer');
  if (body.jobId && job?.customerId !== customerId) throw badRequest('That project is for another customer');
}

/**
 * The agreed price when a quotation is named and nobody typed one: its latest
 * APPROVED revision, else its latest — the same rule Insights and Customer 360
 * use. The SUBTOTAL, because the invoice adds VAT itself; the total would tax
 * the work twice.
 */
async function quotedAmount(quotationId: string): Promise<number | null> {
  const revisions = await prisma.quotationRevision.findMany({
    where: { quotationId },
    select: { status: true, subtotal: true, revision: true },
    orderBy: { revision: 'desc' },
  });
  const chosen = revisions.find((r) => r.status === 'APPROVED') ?? revisions[0];
  return chosen ? Number(chosen.subtotal) : null;
}

jobOrderRoutes.post(
  '/',
  require_('gops.job_orders.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(jobOrderSchema, req.body);
    await checkBelongs(body.customerId, body);

    const requestedFor = asDate(body.requestedFor, 'Requested for');
    const cover = await decideCover({
      assetId: body.assetId || null,
      requestedFor,
      chargeBasis: body.chargeBasis,
      jobId: body.jobId || null,
    });
    const amount =
      body.amount ?? (cover.chargeBasis === 'CHARGEABLE' && body.quotationId ? await quotedAmount(body.quotationId) : null);

    const row = await prisma.$transaction(async (tx) => {
      const number = await nextNumber('job_order', tx);
      return tx.jobOrder.create({
        data: {
          number,
          kind: body.kind,
          urgent: body.urgent ?? false,
          customerId: body.customerId,
          siteId: body.siteId || null,
          contactId: body.contactId || null,
          assetId: body.assetId || null,
          title: body.title,
          description: body.description,
          scope: body.scope || null,
          requestedFor,
          chargeBasis: cover.chargeBasis,
          underWarranty: cover.underWarranty,
          contractId: cover.contractId,
          jobId: cover.jobId,
          quotationId: body.quotationId || null,
          customerPoNumber: body.customerPoNumber || null,
          amount: amount == null ? null : new Prisma.Decimal(amount),
          requestedById: me.id,
          assignedToId: body.assignedToId || null,
          notes: body.notes || null,
        },
        include: jobOrderInclude,
      });
    });

    await audit(
      {
        entityType: 'job_order',
        entityId: row.id,
        action: 'CREATED',
        summary: `${row.number} — ${KIND_LABEL[row.kind]} at ${row.customer.name} (${row.chargeBasis.toLowerCase()})`,
      },
      req,
    );
    res.status(201).json(present(row));
  }),
);

jobOrderRoutes.get(
  '/:id',
  requireAny('gops.job_orders.view_all', 'gops.job_orders.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await load(req.params.id);
    if (!mayOpen(me, row)) throw forbidden('That is someone else’s job order');
    const coverage = await coverageFor(row.assetId, row.requestedFor).catch(() => null);
    const owner = canEditRecord(me, 'gops', 'job_orders', row.requestedById);
    res.json({
      ...present(row),
      coverage,
      canEdit: owner && (row.status === 'DRAFT' || row.status === 'REJECTED'),
      canCancel: owner && ['DRAFT', 'REJECTED', 'APPROVED'].includes(row.status),
      canAcknowledge:
        (owner || row.assignedToId === me.id) && row.status !== 'DRAFT' && row.status !== 'CANCELLED',
    });
  }),
);

/**
 * Editing, while nobody has decided on it. A returned order is corrected and
 * resubmitted — the approval history keeps both attempts, and the printed
 * sign-offs read the latest.
 */
jobOrderRoutes.patch(
  '/:id',
  requireAny('gops.job_orders.edit_own', 'gops.job_orders.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(jobOrderSchema.omit({ customerId: true }).partial(), req.body);
    const existing = await load(req.params.id);
    if (!canEditRecord(me, 'gops', 'job_orders', existing.requestedById)) {
      throw forbidden('Only whoever raised this job order can change it');
    }
    if (existing.status !== 'DRAFT' && existing.status !== 'REJECTED') {
      throw badRequest('This job order has gone for approval. Its content is what was decided on.');
    }
    await checkBelongs(existing.customerId, body);

    const assetId = body.assetId !== undefined ? body.assetId || null : existing.assetId;
    const requestedFor = body.requestedFor ? asDate(body.requestedFor, 'Requested for') : existing.requestedFor;
    const recover =
      body.assetId !== undefined || body.requestedFor !== undefined || body.chargeBasis !== undefined || body.jobId !== undefined;
    const cover = recover
      ? await decideCover({
          assetId,
          requestedFor,
          chargeBasis: body.chargeBasis ?? (body.assetId !== undefined || body.requestedFor !== undefined ? undefined : existing.chargeBasis),
          jobId: body.jobId !== undefined ? body.jobId || null : existing.jobId,
        })
      : null;

    const updated = await prisma.jobOrder.update({
      where: { id: existing.id },
      data: {
        ...(body.kind ? { kind: body.kind } : {}),
        ...(body.urgent !== undefined ? { urgent: body.urgent } : {}),
        ...(body.siteId !== undefined ? { siteId: body.siteId || null } : {}),
        ...(body.contactId !== undefined ? { contactId: body.contactId || null } : {}),
        ...(body.assetId !== undefined ? { assetId } : {}),
        ...(body.title ? { title: body.title } : {}),
        ...(body.description ? { description: body.description } : {}),
        ...(body.scope !== undefined ? { scope: body.scope || null } : {}),
        ...(body.requestedFor ? { requestedFor } : {}),
        ...(body.assignedToId !== undefined ? { assignedToId: body.assignedToId || null } : {}),
        ...(body.quotationId !== undefined ? { quotationId: body.quotationId || null } : {}),
        ...(body.customerPoNumber !== undefined ? { customerPoNumber: body.customerPoNumber || null } : {}),
        ...(body.amount !== undefined ? { amount: body.amount == null ? null : new Prisma.Decimal(body.amount) } : {}),
        ...(body.notes !== undefined ? { notes: body.notes || null } : {}),
        ...(cover
          ? {
              chargeBasis: cover.chargeBasis,
              underWarranty: cover.underWarranty,
              contractId: cover.contractId,
              jobId: cover.jobId,
            }
          : {}),
      },
      include: jobOrderInclude,
    });

    await audit(
      {
        entityType: 'job_order',
        entityId: updated.id,
        action: 'UPDATED',
        summary: `${updated.number} updated`,
        before: { ...existing, amount: num(existing.amount) },
        after: present(updated),
      },
      req,
    );
    res.json(present(updated));
  }),
);

// ── The lifecycle ───────────────────────────────────────────────────────────

/**
 * Submitting. Deliberately NOT gated on a price: a breakdown call is often
 * time-and-materials, the PDF then prints "To be billed on completion", and
 * the invoice step is where an amount becomes compulsory.
 */
jobOrderRoutes.post(
  '/:id/submit',
  requireAny('gops.job_orders.create', 'gops.job_orders.edit_own', 'gops.job_orders.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await load(req.params.id);
    if (!canEditRecord(me, 'gops', 'job_orders', row.requestedById)) {
      throw forbidden('Only whoever raised this job order can submit it');
    }
    if (row.status !== 'DRAFT' && row.status !== 'REJECTED') {
      throw badRequest('Only a draft or a returned job order can be submitted');
    }

    const before = row.status;
    await prisma.jobOrder.update({ where: { id: row.id }, data: { status: 'PENDING_APPROVAL' } });
    try {
      await submitForApproval({
        documentType: 'job_order',
        documentId: row.id,
        documentNumber: row.number,
        subject: subjectOf(row),
        amount: row.chargeBasis === 'CHARGEABLE' ? num(row.amount) : null,
        link: `/g-ops/job-orders/${row.id}`,
        requesterId: me.id,
      });
    } catch (err) {
      // No workflow, or a workflow that routes only to the requester: put the
      // document back where it was, so it is not stranded as "pending" with
      // no request behind it.
      await prisma.jobOrder.update({ where: { id: row.id }, data: { status: before } });
      throw err;
    }

    await audit(
      { entityType: 'job_order', entityId: row.id, action: 'SUBMITTED', summary: `${row.number} submitted` },
      req,
    );
    res.json({ ok: true });
  }),
);

/**
 * Cancelling. A pending order is withdrawn by its approver returning it — the
 * engine has no requester withdrawal, and this is not the place to invent
 * one. A completed order is a record of what happened.
 */
jobOrderRoutes.post(
  '/:id/cancel',
  requireAny('gops.job_orders.create', 'gops.job_orders.edit_own', 'gops.job_orders.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(z.object({ reason: z.string().trim().min(3, 'Say why it is cancelled') }), req.body);
    const row = await load(req.params.id);
    if (!canEditRecord(me, 'gops', 'job_orders', row.requestedById)) {
      throw forbidden('Only whoever raised this job order can cancel it');
    }
    if (row.status === 'COMPLETED') {
      throw badRequest('This job order was completed and reported; its record is what happened.');
    }
    if (row.status === 'PENDING_APPROVAL') {
      throw badRequest('It is with the approver. Ask them to return it, then cancel it.');
    }
    if (row.status === 'CANCELLED') throw badRequest('This job order is already cancelled');

    await prisma.$transaction(async (tx) => {
      if (row.visit && row.visit.status === 'SCHEDULED') {
        await tx.serviceVisit.update({
          where: { id: row.visit.id },
          data: { status: 'CANCELLED' },
        });
      }
      await tx.jobOrder.update({
        where: { id: row.id },
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: body.reason },
      });
    });

    if (row.assignedToId && row.assignedToId !== me.id && row.status === 'APPROVED') {
      await notify({
        userId: row.assignedToId,
        type: 'pm.due',
        title: 'Job order cancelled',
        body: `${row.number} — ${row.customer.name}: ${body.reason}`,
        link: `/g-ops/job-orders/${row.id}`,
      });
    }
    await audit(
      {
        entityType: 'job_order',
        entityId: row.id,
        action: 'CANCELLED',
        summary: `${row.number} cancelled — ${body.reason}${row.visit?.status === 'SCHEDULED' ? ` (visit ${row.visit.number} cancelled)` : ''}`,
      },
      req,
    );
    res.json({ ok: true });
  }),
);

/** The customer's signature slot on the printed order. */
jobOrderRoutes.patch(
  '/:id/acknowledge',
  requireAny('gops.job_orders.view_all', 'gops.job_orders.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(
      z.object({ customerAcknowledgedBy: z.string().trim().min(2, 'Who signed for it?') }),
      req.body,
    );
    const row = await load(req.params.id);
    const owner = canEditRecord(me, 'gops', 'job_orders', row.requestedById);
    if (!owner && row.assignedToId !== me.id) {
      throw forbidden('Only whoever raised the order or the engineer sent can record this');
    }
    if (row.status === 'DRAFT' || row.status === 'CANCELLED') {
      throw badRequest('A draft or cancelled order has nothing for the customer to acknowledge');
    }
    const updated = await prisma.jobOrder.update({
      where: { id: row.id },
      data: { customerAcknowledgedBy: body.customerAcknowledgedBy, customerAcknowledgedAt: new Date() },
      include: jobOrderInclude,
    });
    await audit(
      {
        entityType: 'job_order',
        entityId: row.id,
        action: 'UPDATED',
        summary: `${row.number} acknowledged by ${body.customerAcknowledgedBy}`,
      },
      req,
    );
    res.json(present(updated));
  }),
);

const BASIS_PRINT: Record<string, (row: JobOrderRow) => string> = {
  WARRANTY: () => 'Warranty — no charge',
  CONTRACT: (r) => `Under contract ${r.contract?.number ?? ''} — no charge`.replace('  ', ' '),
  CHARGEABLE: () => 'Chargeable',
  GOODWILL: () => 'Goodwill — no charge',
};

jobOrderRoutes.get(
  '/:id/pdf',
  requireAny('gops.job_orders.view_all', 'gops.job_orders.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await load(req.params.id);
    if (!mayOpen(me, row)) throw forbidden('That is someone else’s job order');

    const today = dayKey(new Date());
    const warranty = row.asset?.warrantyEndsAt
      ? row.asset.warrantyEndsAt >= today
        ? `to ${formatDate(row.asset.warrantyEndsAt)}`
        : `Expired ${formatDate(row.asset.warrantyEndsAt)}`
      : row.asset
        ? 'None recorded'
        : '—';

    const sections: PdfSection[] = [
      {
        kind: 'fields',
        title: 'Request',
        columns: 2,
        fields: [
          { label: 'Kind', value: KIND_LABEL[row.kind] },
          { label: 'Priority', value: row.urgent ? 'Urgent' : 'Routine' },
          { label: 'Requested for', value: formatDate(row.requestedFor) },
          { label: 'Requested by', value: row.requestedBy.name },
          {
            label: 'Contact',
            value: row.contact ? [row.contact.name, row.contact.phone].filter(Boolean).join(' · ') : '—',
          },
          {
            label: 'Equipment',
            value: row.asset ? [row.asset.name, row.asset.model].filter(Boolean).join(' · ') : '—',
          },
          { label: 'Warranty', value: warranty },
          {
            label: 'Contract',
            value: row.contract ? `${row.contract.number} · to ${formatDate(row.contract.endsAt)}` : '—',
          },
        ],
      },
      { kind: 'text', title: 'Reported problem / request', body: row.description },
    ];
    if (row.scope) sections.push({ kind: 'text', title: 'Scope of work', body: row.scope });
    sections.push(
      {
        kind: 'fields',
        title: 'Charging',
        columns: 2,
        fields: [
          { label: 'Basis', value: BASIS_PRINT[row.chargeBasis](row) },
          { label: 'Quotation', value: row.quotation?.number ?? '—' },
          { label: 'Customer PO', value: row.customerPoNumber ?? '—' },
          {
            label: 'Amount',
            value:
              row.chargeBasis === 'CHARGEABLE'
                ? row.amount != null
                  ? formatMoney(Number(row.amount))
                  : 'To be billed on completion'
                : '—',
          },
          { label: 'Charge to', value: row.job ? `${row.job.number} · ${row.job.name}` : '—' },
        ],
      },
      {
        kind: 'fields',
        title: 'Dispatch',
        columns: 3,
        fields: [
          { label: 'Engineer', value: row.assignedTo?.name ?? 'Not yet assigned' },
          { label: 'Visit no.', value: row.visit?.number ?? '—' },
          { label: 'Scheduled', value: row.visit ? formatDate(row.visit.dueDate) : '—' },
        ],
      },
    );
    if (row.status === 'CANCELLED' && row.cancelReason) {
      sections.push({ kind: 'text', title: 'Cancelled', body: row.cancelReason });
    }

    const signoffs = await approvalSignoffs('job_order', row.id);
    const pdf = await renderDocument({
      title: 'Job Order',
      documentNumber: row.number,
      date: row.createdAt,
      reference: `${row.customer.name}${row.site ? ` · ${row.site.name}` : ''}${
        row.asset ? ` · ${row.asset.name}${row.asset.serialNo ? ` (S/N ${row.asset.serialNo})` : ''}` : ''
      }`,
      sections,
      signatories: [
        {
          role: 'Requested by',
          name: row.requestedBy.name,
          position: row.requestedBy.position ?? undefined,
          at: row.createdAt,
        },
        { role: 'Approved by', ...(signoffs[0] ?? {}) },
        {
          role: 'Acknowledged by (customer)',
          name: row.customerAcknowledgedBy ?? undefined,
          at: row.customerAcknowledgedAt,
        },
      ],
      footerNote: row.chargeBasis !== 'CHARGEABLE' ? 'No charge to the customer for this work.' : undefined,
    });

    await audit(
      { entityType: 'job_order', entityId: row.id, action: 'EXPORTED', summary: `Printed ${row.number}` },
      req,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${row.number}.pdf"`);
    res.send(pdf);
  }),
);

// ── Approval ────────────────────────────────────────────────────────────────

/**
 * The service manager's decision. Approval schedules exactly one visit — the
 * attendance record — numbered in the same transaction as the status change,
 * so a rollback burns no number. The visit has no `sequence`: it is not part
 * of any contract's generated plan, and regenerating a contract's schedule
 * leaves it alone.
 *
 * Guarded on status, so a settle that arrives twice schedules nothing twice.
 */
export async function settleJobOrder(
  approval: { documentId: string },
  outcome: ApprovalOutcome,
): Promise<void> {
  const jo = await prisma.jobOrder.findUnique({
    where: { id: approval.documentId },
    include: { customer: { select: { name: true } }, visit: { select: { id: true } } },
  });
  if (!jo || jo.status !== 'PENDING_APPROVAL') return;

  if (outcome === 'REJECTED') {
    await prisma.jobOrder.update({ where: { id: jo.id }, data: { status: 'REJECTED' } });
    await audit({
      entityType: 'job_order',
      entityId: jo.id,
      action: 'REJECTED',
      summary: `${jo.number} returned — no visit was scheduled`,
    });
    return;
  }

  const visit = await prisma.$transaction(async (tx) => {
    const claimed = await tx.jobOrder.updateMany({
      where: { id: jo.id, status: 'PENDING_APPROVAL' },
      data: { status: 'APPROVED', approvedAt: new Date() },
    });
    if (claimed.count === 0 || jo.visit) return null;
    return tx.serviceVisit.create({
      data: {
        number: await nextNumber('service_visit', tx),
        kind: jo.kind,
        status: 'SCHEDULED',
        customerId: jo.customerId,
        siteId: jo.siteId,
        assetId: jo.assetId,
        contractId: jo.chargeBasis === 'CONTRACT' ? jo.contractId : null,
        sequence: null,
        dueDate: jo.requestedFor,
        assignedToId: jo.assignedToId,
        notes: `${jo.number} — ${jo.title}`,
        jobOrderId: jo.id,
      },
    });
  });
  if (!visit) return;

  // The requester already hears from the engine; the engineer is the one
  // person who would otherwise find out from the schedule.
  if (jo.assignedToId) {
    await notify({
      userId: jo.assignedToId,
      type: 'pm.due',
      title: `${KIND_LABEL[jo.kind]} call assigned${jo.urgent ? ' — URGENT' : ''}`,
      body: `${jo.customer.name} — ${jo.number}, due ${isoDay(jo.requestedFor)}`,
      link: `/g-ops/job-orders/${jo.id}`,
    });
  }
  await audit({
    entityType: 'job_order',
    entityId: jo.id,
    action: 'EXECUTED',
    summary: `${jo.number} accepted — visit ${visit.number} scheduled for ${isoDay(jo.requestedFor)}`,
  });
}

onApprovalSettled('job_order', settleJobOrder);

// ── Ctrl+K ──────────────────────────────────────────────────────────────────

registerSearch({
  kind: 'job_order',
  label: 'Job orders',
  permission: ['gops.job_orders.view_all', 'gops.job_orders.view_own'],
  ownWhere: (user) => ({ OR: [{ requestedById: user.id }, { assignedToId: user.id }] }),
  search: async (term, _user, limit, own) => {
    const rows = await prisma.jobOrder.findMany({
      where: {
        AND: [
          own ?? {},
          {
            OR: [
              { number: { contains: term, mode: 'insensitive' } },
              { title: { contains: term, mode: 'insensitive' } },
              { customer: { name: { contains: term, mode: 'insensitive' } } },
              { asset: { serialNo: { contains: term, mode: 'insensitive' } } },
            ],
          },
        ],
      },
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: { id: true, number: true, title: true, status: true, customer: { select: { name: true } } },
    });
    return rows.map((r) => ({
      kind: 'job_order',
      id: r.id,
      title: `${r.number} — ${r.title}`,
      subtitle: `${r.customer.name} · ${r.status.toLowerCase().replace(/_/g, ' ')}`,
      link: `/g-ops/job-orders/${r.id}`,
    }));
  },
});
