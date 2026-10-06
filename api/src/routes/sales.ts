import { Router } from 'express';
import { z } from 'zod';
import { LeadStatus, Prisma } from '@prisma/client';
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
  conflict,
} from '../http/kit';
import { authenticate, require_, requireAny, currentUser } from '../auth/middleware';
import { can, canEditRecord, resolveUser, type ResolvedUser } from '../permissions/resolve';
import { audit } from '../shared/audit';
import { nextNumber, previewNext } from '../shared/numbering';
import { notify } from '../shared/notifications';
import { rememberGroups } from '../shared/quotationGroups';
import {
  submitForApproval,
  onApprovalSettled,
  approvalOptions,
  approvalSlots,
  cancelOpenRequest,
  contactPhone,
  routePreview,
} from '../shared/approvals';
import {
  formatAmount,
  formatDate,
  formatDateTime,
  formatShortDate,
  type PdfTotal,
  type Signatory,
} from '../shared/pdf';
import { renderDesigned, type DesignData, type DesignRow } from '../shared/pdfDesign';
import { quotationDesign } from '../shared/quotationTemplate';
import { activityWhere, type ActivityQuery } from '../shared/activities';
import { manilaDayKey } from '../shared/day';
import { toCsv } from '../shared/insights';
import {
  assertLeadStatusChange,
  assertOutcomeChange,
  buildBoard,
  columnByKey,
  outcomeChanges,
  outcomeStages,
  type BoardResponse,
} from '../shared/pipeline';
import {
  quotationTotals,
  lineAmount,
  recalcQuotationRevision,
  canSeeQuotationCost,
  stripLineCost,
  quotationLinesFromSections,
  costingScopeSections,
  quotationTaxOptions,
  QUOTATION_EXTRA_TAX_RATES,
} from '../shared/quotation';

const d = (v: number | string | null | undefined) =>
  v === null || v === undefined ? new Prisma.Decimal(0) : new Prisma.Decimal(v);
const num = (v: Prisma.Decimal | null | undefined) => (v == null ? 0 : Number(v));

// ════════════════════════════════════════════════════════════════════
//  LEADS
// ════════════════════════════════════════════════════════════════════

export const leadRoutes = Router();
leadRoutes.use(authenticate);

const LEAD_STATUSES = [
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'SITE_VISIT',
  'COSTING',
  'QUOTATION_CREATED',
  'QUOTATION_SUBMITTED',
  'NEGOTIATION',
  'WON',
  'LOST',
  'ON_HOLD',
] as const;

function presentLead(lead: Record<string, unknown>) {
  return { ...lead, estimatedValue: num(lead.estimatedValue as Prisma.Decimal) };
}

leadRoutes.get(
  '/',
  requireAny('gops.leads.view_all', 'gops.leads.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const where: Prisma.LeadWhereInput = {};

    const onlyOwn = !me.isSuperAdmin && !me.permissions.has('gops.leads.view_all');
    if (onlyOwn || q.scope === 'mine') where.assignedToId = me.id;

    if (q.search) {
      where.OR = [
        { companyName: { contains: q.search, mode: 'insensitive' } },
        { number: { contains: q.search, mode: 'insensitive' } },
        { contactPerson: { contains: q.search, mode: 'insensitive' } },
        { description: { contains: q.search, mode: 'insensitive' } },
      ];
    }
    if (q.filters.status) {
      // One status, or several comma-separated — the quotation editor asks for
      // every open one at once. An unknown value is a 400, not a Prisma 500.
      const asked = q.filters.status.split(',').map((s) => s.trim()).filter(Boolean);
      const unknown = asked.filter((s) => !(Object.values(LeadStatus) as string[]).includes(s));
      if (unknown.length) throw badRequest(`Unknown lead status: ${unknown.join(', ')}`);
      where.status = { in: asked as LeadStatus[] };
    }
    if (q.filters.assignedToId) where.assignedToId = q.filters.assignedToId;
    if (q.filters.createdById) where.createdById = q.filters.createdById;
    if (q.filters.source) where.source = q.filters.source;

    const [rows, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        include: {
          assignedTo: { select: { id: true, name: true } },
          // Who recorded the enquiry — not always who is chasing it.
          createdBy: { select: { id: true, name: true } },
          customer: { select: { id: true, name: true } },
          _count: { select: { quotations: true } },
        },
        orderBy: orderBy(q, ['number', 'companyName', 'estimatedValue', 'expectedClosing', 'createdAt'], {
          createdAt: 'desc',
        }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.lead.count({ where }),
    ]);

    res.json(
      listResult(
        rows.map((r) => ({ ...presentLead(r as unknown as Record<string, unknown>), quotationCount: r._count.quotations })),
        total,
        q,
      ),
    );
  }),
);

leadRoutes.get(
  '/:id',
  requireAny('gops.leads.view_all', 'gops.leads.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const lead = await prisma.lead.findUnique({
      where: { id: req.params.id },
      include: {
        assignedTo: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
        customer: { select: { id: true, name: true, code: true } },
        site: { select: { id: true, name: true } },
        quotations: {
          select: {
            id: true,
            number: true,
            subject: true,
            outcome: true,
            revisions: { select: { revision: true, status: true, total: true }, orderBy: { revision: 'desc' }, take: 1 },
          },
        },
        // What has been priced for this enquiry — the lead page's next action
        // is "start a costing" or "create the quotation", and it can only
        // offer the right one if it knows what already exists.
        costings: {
          select: {
            id: true,
            number: true,
            title: true,
            status: true,
            contractValue: true,
            createdAt: true,
            // "Assign costing": whose work it is, who handed it over, when, and why.
            owner: { select: { id: true, name: true } },
            assignedBy: { select: { id: true, name: true } },
            assignedAt: true,
            assignmentNote: true,
          },
          orderBy: { createdAt: 'desc' },
        },
        activities: { orderBy: { startsAt: 'asc' } },
      },
    });
    if (!lead) throw notFound('Lead not found');
    if (!me.isSuperAdmin && !me.permissions.has('gops.leads.view_all') && lead.assignedToId !== me.id) {
      throw forbidden('This lead is assigned to someone else');
    }

    res.json({
      ...presentLead(lead as unknown as Record<string, unknown>),
      quotations: lead.quotations.map((qt) => ({
        ...qt,
        latest: qt.revisions[0] ? { ...qt.revisions[0], total: num(qt.revisions[0].total) } : null,
      })),
      costings: lead.costings.map((c) => ({ ...c, contractValue: num(c.contractValue) })),
      canEdit: canEditRecord(me, 'gops', 'leads', lead.assignedToId),
    });
  }),
);

const leadSchema = z.object({
  companyName: z.string().trim().min(2, 'Company name is required'),
  customerId: z.string().optional().nullable(),
  siteId: z.string().optional().nullable(),
  contactPerson: z.string().trim().optional().nullable(),
  contactEmail: z.string().trim().email('Enter a valid email').optional().nullable().or(z.literal('')),
  contactPhone: z.string().trim().optional().nullable(),
  address: z.string().trim().optional().nullable(),
  source: z.string().trim().optional().nullable(),
  description: z.string().optional().nullable(),
  assignedToId: z.string().optional(),
  estimatedValue: z.number().min(0).optional().nullable(),
  probability: z.number().int().min(0).max(100).optional(),
  expectedClosing: z.string().optional().nullable(),
  nextAction: z.string().trim().optional().nullable(),
  nextActionDate: z.string().optional().nullable(),
  status: z.enum(LEAD_STATUSES).optional(),
  lostReason: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

function asDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const date = new Date(v);
  if (Number.isNaN(date.getTime())) throw badRequest(`"${v}" is not a valid date`);
  return date;
}

leadRoutes.post(
  '/',
  require_('gops.leads.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(leadSchema, req.body);
    const assignedToId = body.assignedToId || me.id;

    const lead = await prisma.$transaction(async (tx) => {
      const number = await nextNumber('lead', tx);
      return tx.lead.create({
        data: {
          number,
          companyName: body.companyName,
          customerId: body.customerId || null,
          siteId: body.siteId || null,
          contactPerson: body.contactPerson || null,
          contactEmail: body.contactEmail || null,
          contactPhone: body.contactPhone || null,
        address: body.address || null,
          source: body.source || null,
          description: body.description || null,
          assignedToId,
          createdById: me.id,
          estimatedValue: body.estimatedValue != null ? d(body.estimatedValue) : null,
          probability: body.probability ?? 0,
          expectedClosing: asDate(body.expectedClosing),
          nextAction: body.nextAction || null,
          nextActionDate: asDate(body.nextActionDate),
          notes: body.notes || null,
        },
      });
    });

    // Someone handed work to another person needs to hear about it.
    if (assignedToId !== me.id) {
      await notify({
        userId: assignedToId,
        type: 'system',
        title: `Lead assigned to you: ${lead.companyName}`,
        body: lead.number,
        link: `/g-ops/leads/${lead.id}`,
      });
    }

    await audit(
      {
        entityType: 'lead',
        entityId: lead.id,
        action: 'CREATED',
        summary: `Created lead ${lead.number} — ${lead.companyName}`,
      },
      req,
    );
    res.status(201).json(presentLead(lead as unknown as Record<string, unknown>));
  }),
);

leadRoutes.patch(
  '/:id',
  require_('gops.leads.edit_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(leadSchema.partial(), req.body);

    const before = await prisma.lead.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { quotations: true } } },
    });
    if (!before) throw notFound('Lead not found');
    if (!canEditRecord(me, 'gops', 'leads', before.assignedToId)) {
      throw forbidden('This lead is assigned to someone else');
    }

    // The move rules live in shared/pipeline.ts so the board and this page
    // refuse the same things for the same reasons.
    if (body.status !== undefined && body.status !== before.status) {
      assertLeadStatusChange(before.status, body.status, {
        lostReason: body.lostReason !== undefined ? body.lostReason : before.lostReason,
        hasQuotations: before._count.quotations > 0,
      });
    }

    const data: Prisma.LeadUpdateInput = {};
    for (const f of [
      'companyName',
      'contactPerson',
      'contactEmail',
      'contactPhone',
      'address',
      'source',
      'description',
      'nextAction',
      'lostReason',
      'notes',
    ] as const) {
      if (body[f] !== undefined) (data as Record<string, unknown>)[f] = body[f] || null;
    }
    if (body.probability !== undefined) data.probability = body.probability;
    if (body.status !== undefined) data.status = body.status;
    if (body.estimatedValue !== undefined) {
      data.estimatedValue = body.estimatedValue != null ? d(body.estimatedValue) : null;
    }
    if (body.expectedClosing !== undefined) data.expectedClosing = asDate(body.expectedClosing);
    if (body.nextActionDate !== undefined) data.nextActionDate = asDate(body.nextActionDate);
    if (body.customerId !== undefined) {
      data.customer = body.customerId ? { connect: { id: body.customerId } } : { disconnect: true };
    }
    if (body.siteId !== undefined) {
      data.site = body.siteId ? { connect: { id: body.siteId } } : { disconnect: true };
    }
    if (body.assignedToId !== undefined && body.assignedToId !== before.assignedToId) {
      data.assignedTo = { connect: { id: body.assignedToId } };
    }

    const lead = await prisma.lead.update({ where: { id: req.params.id }, data });

    if (body.assignedToId && body.assignedToId !== before.assignedToId) {
      await notify({
        userId: body.assignedToId,
        type: 'system',
        title: `Lead assigned to you: ${lead.companyName}`,
        body: lead.number,
        link: `/g-ops/leads/${lead.id}`,
      });
    }

    // A manager dragging a salesperson's card on the board tells them, the
    // same way reassignment does.
    if (body.status && body.status !== before.status && lead.assignedToId !== me.id) {
      await notify({
        userId: lead.assignedToId,
        type: 'system',
        title: `${lead.number} moved to ${columnByKey(body.status)?.label ?? body.status.toLowerCase().replace(/_/g, ' ')} by ${me.name}`,
        body: lead.companyName,
        link: `/g-ops/leads/${lead.id}`,
      });
    }

    const { _count: beforeCount, ...beforeRow } = before;
    void beforeCount;
    await audit(
      {
        entityType: 'lead',
        entityId: lead.id,
        action: 'UPDATED',
        summary:
          body.status && body.status !== before.status
            ? `Lead ${lead.number}: ${before.status} → ${body.status}`
            : `Updated lead ${lead.number}`,
        before: beforeRow,
        after: lead,
      },
      req,
    );
    res.json(presentLead(lead as unknown as Record<string, unknown>));
  }),
);

leadRoutes.delete(
  '/:id',
  require_('gops.leads.delete'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const lead = await prisma.lead.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { quotations: true } } },
    });
    if (!lead) throw notFound('Lead not found');
    if (!canEditRecord(me, 'gops', 'leads', lead.assignedToId)) {
      throw forbidden('This lead is assigned to someone else');
    }
    if (lead._count.quotations > 0) {
      throw badRequest(`${lead._count.quotations} quotation(s) came from this lead`);
    }

    await prisma.lead.delete({ where: { id: req.params.id } });
    await audit(
      { entityType: 'lead', entityId: req.params.id, action: 'DELETED', summary: `Deleted lead ${lead.number}` },
      req,
    );
    res.json({ ok: true });
  }),
);

// ════════════════════════════════════════════════════════════════════
//  QUOTATIONS
// ════════════════════════════════════════════════════════════════════

export const quotationRoutes = Router();
quotationRoutes.use(authenticate);

/**
 * A revision as the API returns it: Decimals as numbers, and — for a caller
 * allowed to see cost — the SCORO cost panel beside the lines. For everybody
 * else the line cost keys are removed HERE, on the server (see
 * `canSeeQuotationCost`), and the costing's cost goes with them.
 */
function presentRevision(rev: Record<string, unknown>, showCost: boolean) {
  const items = (rev.items ?? null) as Record<string, unknown>[] | null;
  const costing = rev.costing as Record<string, unknown> | null | undefined;
  const totals = items
    ? quotationTotals({
        lines: items as { amount: Prisma.Decimal }[],
        discountPct: rev.discountPct as Prisma.Decimal,
        vatRate: rev.vatRate as Prisma.Decimal,
        vatInclusive: rev.vatInclusive as boolean,
      })
    : null;

  const presented: Record<string, unknown> = {
    ...rev,
    subtotal: num(rev.subtotal as Prisma.Decimal),
    discountPct: num(rev.discountPct as Prisma.Decimal),
    discountAmount: num(rev.discountAmount as Prisma.Decimal),
    vatAmount: num(rev.vatAmount as Prisma.Decimal),
    total: num(rev.total as Prisma.Decimal),
    vatRate: num(rev.vatRate as Prisma.Decimal),
    // Derived, never stored: subtotal − discount, and the sum without tax.
    net: totals ? totals.net : num(rev.subtotal as Prisma.Decimal) - num(rev.discountAmount as Prisma.Decimal),
    netOfTax: totals?.netOfTax,
  };

  if (items) {
    presented.items = items.map((i, n) => {
      const line: Record<string, unknown> = {
        ...i,
        quantity: num(i.quantity as Prisma.Decimal),
        unitPrice: num(i.unitPrice as Prisma.Decimal),
        amount: num(i.amount as Prisma.Decimal),
      };
      if (!showCost) return stripLineCost(line);
      const m = totals!.lines[n];
      return {
        ...line,
        unitCost: i.unitCost == null ? null : num(i.unitCost as Prisma.Decimal),
        costAmount: m.costAmount,
        margin: m.margin,
        marginPct: m.marginPct,
      };
    });
  }
  if (showCost && totals) presented.costPanel = totals.cost;

  if (costing !== undefined) {
    presented.costing = costing
      ? showCost
        ? { ...costing, contractValue: num(costing.contractValue as Prisma.Decimal), totalCost: num(costing.totalCost as Prisma.Decimal) }
        : { id: costing.id, number: costing.number, title: costing.title, contractValue: num(costing.contractValue as Prisma.Decimal) }
      : null;
  }
  return presented;
}

/** The one arithmetic lives in shared/quotation.ts; this is only its name here. */
const recalcRevision = recalcQuotationRevision;

/**
 * Quote numbers may be typed by hand (SCORO allowed it, and a customer's own
 * reference sometimes has to be honoured), so a number is checked in ONE
 * place: its shape, and that no other quotation — and no quote in the SCORO
 * archive, whose numbers stay unissuable — already carries it. Case-blind,
 * because "q-12" and "Q-12" on two letters to one customer is the same number.
 */
const QUOTE_NUMBER = /^[A-Za-z0-9][A-Za-z0-9\-/_.]{0,39}$/;

async function numberTakenBy(
  number: string,
  excludeId?: string | null,
  tx: Prisma.TransactionClient = prisma,
): Promise<string | null> {
  const live = await tx.quotation.findFirst({
    where: { number: { equals: number, mode: 'insensitive' }, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { number: true, subject: true },
  });
  if (live) return `already used by another quotation (${live.subject})`;
  const archived = await tx.legacyQuote.findFirst({
    where: { number: { equals: number, mode: 'insensitive' } },
    select: { number: true, continuedQuotationId: true },
  });
  // The quotation that continues an archived SCORO quote keeps its number.
  if (archived && (!excludeId || archived.continuedQuotationId !== excludeId)) {
    return `a SCORO quote in the archive (${archived.number}) — archive numbers are never reissued`;
  }
  return null;
}

async function checkQuoteNumber(number: string, excludeId?: string | null, tx: Prisma.TransactionClient = prisma) {
  if (!QUOTE_NUMBER.test(number)) {
    throw badRequest('A quote number is letters and digits, with - / _ or . — up to 40 characters', [
      { field: 'number', message: 'Letters, digits and - / _ . only' },
    ]);
  }
  const taken = await numberTakenBy(number, excludeId, tx);
  if (taken) throw conflict(`${number} is ${taken}. Choose another number.`);
}

/**
 * The next number in the author's series that nobody has taken — a number
 * typed by hand ahead of the counter is stepped over, not issued twice. Inside
 * the caller's transaction, so a rollback burns nothing.
 */
async function nextFreeQuoteNumber(tx: Prisma.TransactionClient, ownerId: string): Promise<string> {
  let number = await nextNumber('quotation', tx, { ownerId });
  for (let tries = 0; tries < 200 && (await numberTakenBy(number, null, tx)); tries++) {
    number = await nextNumber('quotation', tx, { ownerId });
  }
  return number;
}

/** A revision re-read with its lines, for the line routes to answer with. */
async function revisionWithItems(revisionId: string) {
  return prisma.quotationRevision.findUnique({
    where: { id: revisionId },
    include: { items: { orderBy: { sortOrder: 'asc' }, include: LINE_PROVIDERS } },
  });
}

/** Who carries a line's cost, by name — only ever sent to a caller who may see cost. */
const LINE_PROVIDERS = {
  providerSupplier: { select: { id: true, code: true, name: true } },
  providerUser: { select: { id: true, name: true, position: true } },
} as const;

async function loadQuotation(id: string) {
  return prisma.quotation.findUnique({
    where: { id },
    include: {
      // A customer has no address of its own — addresses belong to its sites.
      customer: {
        select: {
          id: true,
          code: true,
          name: true,
          legalName: true,
          phone: true,
          email: true,
          website: true,
          paymentTerms: true,
          // The client block on the PDF prints an address; a customer keeps
          // its addresses on its sites, so the first active one stands in
          // when the quotation names none.
          sites: {
            where: { isActive: true },
            select: { address: true, city: true },
            orderBy: { createdAt: 'asc' },
            take: 1,
          },
        },
      },
      contact: { select: { id: true, name: true, position: true, email: true, phone: true, mobile: true } },
      site: { select: { id: true, name: true, address: true, city: true } },
      lead: { select: { id: true, number: true, companyName: true } },
      owner: { select: { id: true, name: true, position: true, email: true, phone: true } },
      // Set when this quotation carries on a SCORO quote under the same number.
      legacyQuote: { select: { id: true, number: true, status: true } },
      revisions: {
        orderBy: { revision: 'desc' },
        include: {
          items: { orderBy: { sortOrder: 'asc' }, include: LINE_PROVIDERS },
          costing: { select: { id: true, number: true, title: true, contractValue: true, totalCost: true } },
          approvedBy: { select: { id: true, name: true } },
          // The project a revision became. Without it a WON quotation still
          // waiting to be a project looks the same as one already delivered.
          jobs: { select: { id: true, number: true, name: true, status: true } },
        },
      },
    },
  });
}

quotationRoutes.get(
  '/',
  requireAny('gops.quotations.view_all', 'gops.quotations.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const where: Prisma.QuotationWhereInput = {};

    const onlyOwn = !me.isSuperAdmin && !me.permissions.has('gops.quotations.view_all');
    if (onlyOwn || q.scope === 'mine') where.ownerId = me.id;

    if (q.search) {
      where.OR = [
        { number: { contains: q.search, mode: 'insensitive' } },
        { subject: { contains: q.search, mode: 'insensitive' } },
        { customer: { name: { contains: q.search, mode: 'insensitive' } } },
      ];
    }
    if (q.filters.outcome) where.outcome = q.filters.outcome as Prisma.EnumQuotationOutcomeFilter['equals'];
    if (q.filters.customerId) where.customerId = q.filters.customerId;
    if (q.filters.ownerId) where.ownerId = q.filters.ownerId;

    const [rows, total] = await Promise.all([
      prisma.quotation.findMany({
        where,
        include: {
          customer: { select: { id: true, name: true } },
          owner: { select: { id: true, name: true } },
          legacyQuote: { select: { id: true, number: true, status: true } },
          revisions: {
            orderBy: { revision: 'desc' },
            take: 1,
            select: { revision: true, status: true, total: true, updatedAt: true },
          },
        },
        orderBy: orderBy(q, ['number', 'subject', 'createdAt', 'updatedAt'], { createdAt: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.quotation.count({ where }),
    ]);

    res.json(
      listResult(
        rows.map((r) => ({
          id: r.id,
          number: r.number,
          subject: r.subject,
          outcome: r.outcome,
          probability: r.probability,
          customer: r.customer,
          owner: r.owner,
          createdAt: r.createdAt,
          legacyQuote: r.legacyQuote,
          latest: r.revisions[0]
            ? { ...r.revisions[0], total: num(r.revisions[0].total) }
            : null,
        })),
        total,
        q,
      ),
    );
  }),
);

/**
 * The number the next quotation WOULD get, so the form can show it before
 * saving. Declared above `/:id` or that route swallows it. Read-only —
 * nothing is consumed; the same contract as `/customers/next-code`.
 *
 * The author's own digits: the seeded pattern is `{EMP}{YY}{MM}{SEQ}` counted
 * per employee per month, so two salespeople previewing at once see different
 * numbers, and an account with no employee record sees 000 and is told so.
 */
quotationRoutes.get(
  '/next-number',
  require_('gops.quotations.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    // `?ownerId=` previews another author's number — honoured only for the
    // same people POST / lets name another author, ignored for everyone else.
    const asked = typeof req.query.ownerId === 'string' ? req.query.ownerId.trim() : '';
    const ownerId = asked && mayAuthorForOthers(me) ? asked : me.id;
    const [preview, template, company, last] = await Promise.all([
      previewNext('quotation', { ownerId }, prisma, async (n) => (await numberTakenBy(n)) !== null),
      prisma.numberSequence.findFirst({ where: { documentType: 'quotation', periodKey: '' }, select: { pattern: true } }),
      prisma.company.findUnique({ where: { id: 'company' }, select: { vatRate: true, currency: true } }),
      // "Your last quotation": what the suggestion continues from.
      prisma.quotation.findFirst({ where: { ownerId }, orderBy: { createdAt: 'desc' }, select: { number: true } }),
    ]);
    res.json({
      number: preview.number,
      lastNumber: last?.number ?? null,
      employeeNo: preview.employeeNo,
      linked: preview.linked,
      // Whether the pattern prints the author's digits at all — an unlinked
      // account only matters when it does.
      usesEmployeeDigits: (template?.pattern ?? '').includes('{EMP}'),
      // What the new revision will snapshot (the same fallbacks POST / uses),
      // so the editor's live tax line is the one the saved quotation stores.
      vatRate: company ? Number(company.vatRate) : 0.12,
      currency: company?.currency ?? 'PHP',
      taxOptions: quotationTaxOptions(company ? Number(company.vatRate) : 0.12),
    });
  }),
);

/**
 * Whether a quote number is free — the editor asks as the number is typed, so
 * a duplicate is said beside the box rather than after Save. The same check
 * POST and PATCH make. Declared above `/:id` or that route swallows it.
 */
quotationRoutes.get(
  '/number-available',
  requireAny('gops.quotations.create', 'gops.quotations.edit_own', 'gops.quotations.edit_all'),
  handler(async (req, res) => {
    const number = String(req.query.number ?? '').trim();
    const excludeId = typeof req.query.excludeId === 'string' ? req.query.excludeId : null;
    if (!QUOTE_NUMBER.test(number)) {
      res.json({ available: false, message: 'Letters, digits and - / _ . only — up to 40 characters' });
      return;
    }
    const taken = await numberTakenBy(number, excludeId);
    res.json({ available: !taken, message: taken ? `${number} is ${taken}` : null });
  }),
);

/**
 * What was quoted before, as a product is typed: past lines (their latest
 * price, unit and description, and how often) and items from the item master.
 * Only from quotations the caller may read; a line's cost only where they may
 * see that quotation's cost; an item's standard cost only with a right that
 * shows cost. Declared above `/:id` or that route swallows it.
 */
quotationRoutes.get(
  '/suggest',
  requireAny('gops.quotations.create', 'gops.quotations.edit_own', 'gops.quotations.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = String(req.query.q ?? '').trim().slice(0, 100);
    if (q.length < 2) {
      res.json([]);
      return;
    }
    const onlyOwn = !me.isSuperAdmin && !me.permissions.has('gops.quotations.view_all');
    const past = await prisma.quotationItem.findMany({
      where: {
        isHeading: false,
        OR: [{ title: { contains: q, mode: 'insensitive' } }, { description: { contains: q, mode: 'insensitive' } }],
        revision: { quotation: onlyOwn ? { ownerId: me.id } : {} },
      },
      select: {
        title: true,
        description: true,
        unit: true,
        unitPrice: true,
        unitCost: true,
        revision: { select: { createdAt: true, quotation: { select: { number: true, ownerId: true } } } },
      },
      orderBy: { revision: { createdAt: 'desc' } },
      take: 400,
    });
    const byName = new Map<
      string,
      { title: string; description: string; unit: string; unitPrice: number; unitCost?: number | null; source: 'history'; uses: number; lastNumber: string }
    >();
    for (const l of past) {
      const title = (l.title || l.description.split('\n')[0]).trim();
      if (!title) continue;
      const key = title.toUpperCase();
      const seen = byName.get(key);
      if (seen) {
        seen.uses++;
        continue;
      }
      const mayCost = canSeeQuotationCost(me, l.revision.quotation.ownerId);
      byName.set(key, {
        title,
        description: l.title ? l.description : '',
        unit: l.unit,
        unitPrice: num(l.unitPrice),
        ...(mayCost ? { unitCost: l.unitCost == null ? null : num(l.unitCost) } : {}),
        source: 'history',
        uses: 1,
        lastNumber: l.revision.quotation.number,
      });
    }
    const starts = (t: string) => t.toUpperCase().startsWith(q.toUpperCase());
    const history = [...byName.values()].sort((a, b) => Number(starts(b.title)) - Number(starts(a.title)) || b.uses - a.uses).slice(0, 10);

    const seeItemCost = can(me, 'gops.costing.view_all') || can(me, 'gchain.items.view_all');
    const items = await prisma.item.findMany({
      where: { isActive: true, OR: [{ name: { contains: q, mode: 'insensitive' } }, { code: { contains: q, mode: 'insensitive' } }] },
      select: { id: true, code: true, name: true, description: true, unit: true, listPrice: true, standardCost: seeItemCost },
      orderBy: { name: 'asc' },
      take: 6,
    });
    const named = new Set(history.map((h) => h.title.toUpperCase()));
    res.json([
      ...history,
      ...items
        .filter((i) => !named.has(i.name.toUpperCase()))
        .map((i) => ({
          title: i.name,
          description: i.description ?? '',
          unit: i.unit,
          unitPrice: i.listPrice == null ? null : num(i.listPrice),
          ...(seeItemCost ? { unitCost: i.standardCost == null ? null : num(i.standardCost) } : {}),
          source: 'item' as const,
          itemCode: i.code,
          uses: 0,
        })),
    ]);
  }),
);

/**
 * The lines a costing's scope of work would give a quotation — the editor's
 * preview before anything is saved. The same mapping `from-costing` writes
 * (`quotationLinesFromSections`), so what the page shows is what is stored.
 * Prices only: a section's value is its share of the contract, not a cost.
 * Declared above `/:id` or that route swallows it.
 */
quotationRoutes.get(
  '/costing-lines',
  // The create form and the edit page both preview it.
  requireAny('gops.quotations.create', 'gops.quotations.edit_own', 'gops.quotations.edit_all'),
  handler(async (req, res) => {
    const costingId = typeof req.query.costingId === 'string' ? req.query.costingId.trim() : '';
    if (!costingId) throw badRequest('Say which costing — ?costingId=');
    const costing = await prisma.costing.findUnique({ where: { id: costingId }, select: { id: true } });
    if (!costing) throw notFound('Costing not found');
    const lines = quotationLinesFromSections(await costingScopeSections(costingId));
    res.json(
      lines.map((l) => ({
        title: l.title,
        description: l.description,
        quantity: num(l.quantity),
        unit: l.unit,
        unitPrice: num(l.unitPrice),
        amount: num(l.amount),
        sortOrder: l.sortOrder,
      })),
    );
  }),
);

/**
 * Who can carry a line's cost: suppliers (outsourced) or our own people
 * (in-house). Names only.
 *
 * Its own route rather than `/suppliers/lookup`, because that one is gated by
 * `gchain.suppliers.view_all`, which the sales role does not hold — naming who
 * supplies a line is not the same right as browsing the supplier master. The
 * same reasoning as overtime's `/overtime/chargeable`. Declared above `/:id`
 * or that route swallows it.
 */
quotationRoutes.get(
  '/providers',
  requireAny('gops.quotations.create', 'gops.quotations.edit_own', 'gops.quotations.edit_all'),
  handler(async (req, res) => {
    const kind = String(req.query.kind ?? 'supplier');
    const term = String(req.query.q ?? '').trim();
    if (kind === 'user') {
      res.json(
        await prisma.user.findMany({
          where: {
            isActive: true,
            ...(term
              ? {
                  OR: [
                    { name: { contains: term, mode: 'insensitive' } },
                    { position: { contains: term, mode: 'insensitive' } },
                  ],
                }
              : {}),
          },
          select: { id: true, name: true, position: true },
          orderBy: { name: 'asc' },
          take: 50,
        }),
      );
      return;
    }
    res.json(
      await prisma.supplier.findMany({
        where: {
          isActive: true,
          ...(term
            ? {
                OR: [
                  { name: { contains: term, mode: 'insensitive' } },
                  { code: { contains: term, mode: 'insensitive' } },
                ],
              }
            : {}),
        },
        select: { id: true, code: true, name: true },
        orderBy: { name: 'asc' },
        take: 50,
      }),
    );
  }),
);

quotationRoutes.get(
  '/:id',
  requireAny('gops.quotations.view_all', 'gops.quotations.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const quotation = await loadQuotation(req.params.id);
    if (!quotation) throw notFound('Quotation not found');
    if (
      !me.isSuperAdmin &&
      !me.permissions.has('gops.quotations.view_all') &&
      quotation.ownerId !== me.id
    ) {
      throw forbidden('This quotation belongs to someone else');
    }

    const showCost = canSeeQuotationCost(me, quotation.ownerId);
    const { customer, ...rest } = quotation;
    const { sites, ...customerRest } = customer;

    // SCORO's status block: the previous status, who moved it and when, and
    // how long it sat in each — read off the audit rows every move writes.
    const statusHistory = outcomeChanges(
      await prisma.auditLog.findMany({
        where: { entityType: 'quotation', entityId: quotation.id },
        select: { summary: true, before: true, after: true, at: true, actorId: true, actorName: true },
      }),
    );
    const { stages, closedInDays } = outcomeStages(
      quotation.createdAt,
      quotation.outcome,
      statusHistory,
      quotation.decidedAt,
      new Date(),
    );
    // The editor's Tax dropdown (see checkVatRate).
    const company = await prisma.company.findUnique({ where: { id: 'company' }, select: { vatRate: true } });
    const companyRate = company ? Number(company.vatRate) : 0.12;
    // The routes a submitter may opt into for the draft, at its total — e.g.
    // "Add the CEO as approver" once it is over ₱1,000,000.
    const draft = quotation.revisions.find((r) => r.status === 'DRAFT');
    const options = draft ? await approvalOptions('quotation', Number(draft.total)) : [];
    // Where "Submit for approval" goes from here, and who decides each step —
    // the standard route and each option's — named before anybody presses it.
    // The caller is the requester the submit would record; names only.
    const brief = (route: Awaited<ReturnType<typeof routePreview>>) =>
      route && {
        name: route.name,
        steps: route.steps.map((st) => ({ name: st.name, approvers: st.approvers.map((p) => ({ id: p.id, name: p.name })) })),
      };
    const approvalRoutes = draft
      ? {
          standard: brief(await routePreview('quotation', Number(draft.total), me.id)),
          options: await Promise.all(
            options.map(async (o) => ({ id: o.id, route: brief(await routePreview('quotation', Number(draft.total), me.id, o.id)) })),
          ),
        }
      : null;

    res.json({
      ...rest,
      statusHistory,
      stages,
      closedInDays,
      companyVatRate: companyRate,
      taxOptions: quotationTaxOptions(companyRate),
      approvalOptions: options,
      approvalRoutes,
      customer: { ...customerRest, address: sites[0] ? [sites[0].address, sites[0].city].filter(Boolean).join(', ') : null },
      revisions: quotation.revisions.map((r) =>
        presentRevision(r as unknown as Record<string, unknown>, showCost),
      ),
      canEdit: canEditRecord(me, 'gops', 'quotations', quotation.ownerId),
      // Tells the screen whether to draw the cost columns — the keys are
      // already absent when it is false; this only saves it guessing.
      canSeeCost: showCost,
    });
  }),
);

/**
 * A SCORO line: group, title and description; quantity, unit and price; and,
 * internally, what it costs and who carries that cost. Amount and cost amount
 * are computed here and never accepted from the client.
 */
const itemFields = {
  group: z.string().trim().max(120).optional().nullable(),
  /** A subheading: its title is the heading; it carries no quantity, price or cost. */
  isHeading: z.boolean().optional(),
  title: z.string().trim().max(300).optional().nullable(),
  description: z.string().optional().nullable(),
  quantity: z.number().min(0),
  unit: z.string().trim().min(1).default('lot'),
  unitPrice: z.number().min(0),
  unitCost: z.number().min(0).optional().nullable(),
  providerSupplierId: z.string().optional().nullable(),
  providerUserId: z.string().optional().nullable(),
  costNote: z.string().optional().nullable(),
  sortOrder: z.number().int().optional(),
};
const itemSchema = z.object(itemFields);
const itemPatchSchema = z.object(itemFields).partial();

/**
 * Checks the parts of a line that span fields: it says what it is, and one
 * provider at most. A provider named must exist — a bad id would otherwise
 * surface as a foreign-key 500.
 *
 * `tx` so a whole-quotation save checks its lines inside the transaction that
 * writes them; `where` ("Line 3: ") so a refusal among twenty lines says which.
 */
async function checkLine(
  line: {
    isHeading?: boolean | null;
    title?: string | null;
    description?: string | null;
    providerSupplierId?: string | null;
    providerUserId?: string | null;
  },
  tx: Prisma.TransactionClient = prisma,
  where = '',
) {
  if (line.isHeading) {
    if (!(line.title ?? '').trim()) throw badRequest(`${where}Give the subheading its text`);
    return;
  }
  if (!(line.title ?? '').trim() && !(line.description ?? '').trim()) {
    throw badRequest(`${where}Give the line a product title or a description`);
  }
  if (line.providerSupplierId && line.providerUserId) {
    throw badRequest(`${where}A line’s cost is carried by a supplier OR by one of our people, not both`);
  }
  if (line.providerSupplierId) {
    const found = await tx.supplier.findUnique({ where: { id: line.providerSupplierId }, select: { id: true } });
    if (!found) throw badRequest(`${where}That supplier does not exist`);
  }
  if (line.providerUserId) {
    const found = await tx.user.findUnique({ where: { id: line.providerUserId }, select: { id: true } });
    if (!found) throw badRequest(`${where}That person does not exist`);
  }
}

/**
 * A line as stored: amount and cost amount computed here from quantity and
 * the two unit figures (never accepted from the client), and the order given.
 * The single-line POST, the whole-quotation create and the replace-all PUT all
 * write through this, so a line cannot be stored three slightly different ways.
 */
function lineData(line: z.infer<typeof itemSchema>, sortOrder: number) {
  // A subheading is words only: nothing to sell, nothing to cost.
  if (line.isHeading) {
    return {
      group: null,
      isHeading: true,
      title: (line.title ?? '').trim(),
      description: '',
      quantity: d(0),
      unit: line.unit || 'lot',
      unitPrice: d(0),
      amount: d(0),
      sortOrder,
      unitCost: null,
      costAmount: null,
      providerSupplierId: null,
      providerUserId: null,
      costNote: null,
    };
  }
  const hasCost = line.unitCost !== undefined && line.unitCost !== null;
  return {
    isHeading: false,
    group: line.group || null,
    title: line.title || null,
    description: line.description ?? '',
    quantity: d(line.quantity),
    unit: line.unit,
    unitPrice: d(line.unitPrice),
    amount: lineAmount(line.quantity, line.unitPrice),
    sortOrder,
    unitCost: hasCost ? d(line.unitCost!) : null,
    costAmount: hasCost ? lineAmount(line.quantity, line.unitCost!) : null,
    providerSupplierId: line.providerSupplierId || null,
    providerUserId: line.providerUserId || null,
    costNote: line.costNote || null,
  };
}

/** The most lines one save may carry — a quotation, not a bill of materials. */
const MAX_LINES = 500;

/**
 * Whether this caller may raise or preview a quotation under somebody else's
 * name (and so under their `{EMP}` digits). The same right as editing every
 * quotation — a sales manager entering one for a salesperson on site.
 */
const mayAuthorForOthers = (me: ResolvedUser) => can(me, 'gops.quotations.edit_all');

const quotationSchema = z.object({
  // Optional because a quotation raised FROM a lead takes the lead's customer.
  // A quotation with neither is refused below, with a message that says what
  // to do about it.
  customerId: z.string().optional().nullable(),
  contactId: z.string().optional().nullable(),
  siteId: z.string().optional().nullable(),
  leadId: z.string().optional().nullable(),
  subject: z.string().trim().min(2, 'Give the quotation a subject'),
  /** Typed by hand. Omitted, the next free number in the author's series is issued. */
  number: z.string().trim().min(1).max(40).optional(),
  /** No longer asked for on the page; a quotation takes its lead's, else 50. */
  probability: z.number().int().min(0).max(100).optional(),
  costingId: z.string().optional().nullable(),
  terms: z.string().optional().nullable(),
  validityDays: z.number().int().min(1).optional(),
  expectedClosing: z.string().optional().nullable(),
  // SCORO's header fields. Payment terms default to the customer's own.
  prNumber: z.string().trim().max(120).optional().nullable(),
  delivery: z.string().trim().max(500).optional().nullable(),
  paymentTerms: z.string().trim().max(500).optional().nullable(),
});

/**
 * What the full-page editor sends on "Save": the header, the SCORO revision
 * fields and — optionally — every line. Without `lines` and `ownerId` this is
 * exactly the old create, so the older callers are unaffected.
 */
const createQuotationSchema = quotationSchema.extend({
  notes: z.string().optional().nullable(),
  discountPct: z.number().min(0, 'A discount cannot be negative').max(100, 'A discount cannot exceed 100%').optional(),
  vatInclusive: z.boolean().optional(),
  /** SCORO's Tax dropdown — see `checkVatRate`. Defaults to the company's rate. */
  vatRate: z.number().min(0).max(1).optional(),
  hideTotal: z.boolean().optional(),
  /** The author. Honoured only for edit_all (see `mayAuthorForOthers`). */
  ownerId: z.string().optional().nullable(),
  lines: z.array(itemSchema).max(MAX_LINES, `A quotation takes at most ${MAX_LINES} lines`).optional(),
});

quotationRoutes.post(
  '/',
  require_('gops.quotations.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(createQuotationSchema, req.body);
    const company = await prisma.company.findUnique({ where: { id: 'company' } });

    /*
      The author. Their employee digits go into the number, and "only the
      author can edit the quotation" makes them its owner — so naming somebody
      else is refused outright for anyone without edit_all, rather than quietly
      filed under the caller while the form said otherwise. The person named
      must be able to author quotations themselves.
    */
    let ownerId = me.id;
    let ownerName = me.name;
    if (body.ownerId && body.ownerId !== me.id) {
      if (!mayAuthorForOthers(me)) {
        throw forbidden('Only someone who may edit every quotation can raise one in another person’s name');
      }
      const owner = await resolveUser(body.ownerId);
      if (!owner || !can(owner, 'gops.quotations.create')) {
        throw badRequest('That person cannot author quotations — they do not hold gops.quotations.create');
      }
      ownerId = owner.id;
      ownerName = owner.name;
    }

    const lead = body.leadId
      ? await prisma.lead.findUnique({
          where: { id: body.leadId },
          select: { id: true, customerId: true, siteId: true, expectedClosing: true, probability: true },
        })
      : null;
    if (body.leadId && !lead) throw notFound('Lead not found');

    // "Nothing is retyped": the customer, site and expected close come off the
    // lead unless the form said otherwise.
    const customerId = body.customerId || lead?.customerId || null;
    if (!customerId) {
      throw badRequest(
        lead
          ? 'Link the lead to a customer first — open the lead, Modify, and pick or add the company'
          : 'Choose a customer',
      );
    }
    // The lead's site only makes sense for the lead's customer.
    const siteId = body.siteId || (lead && customerId === lead.customerId ? lead.siteId : null) || null;
    const expectedClosing =
      body.expectedClosing !== undefined && body.expectedClosing !== null
        ? asDate(body.expectedClosing)
        : (lead?.expectedClosing ?? null);
    const customerTerms = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { paymentTerms: true },
    });
    const lines = body.lines ?? [];
    // Before the transaction, so a refused rate or number burns no number.
    await checkVatRate(body.vatRate);
    if (body.number) await checkQuoteNumber(body.number);

    /*
      One transaction: the number, the quotation, its lines and their totals,
      and the lead's move. A line refused half-way rolls back everything —
      including the number, which is why nextNumber is handed `tx`.
    */
    const quotation = await prisma.$transaction(async (tx) => {
      // A number typed on the page is used as it is (checked again here, in the
      // transaction, against a race); otherwise the next free one in the
      // author's series — their employee digits, {EMP}{YY}{MM}{SEQ}.
      if (body.number) await checkQuoteNumber(body.number, null, tx);
      const number = body.number || (await nextFreeQuoteNumber(tx, ownerId));
      const created = await tx.quotation.create({
        data: {
          number,
          customerId,
          contactId: body.contactId || null,
          siteId,
          leadId: body.leadId || null,
          ownerId,
          subject: body.subject,
          // The page no longer asks: the lead's own read, else even odds. The
          // weighted pipeline multiplies by it.
          probability: body.probability ?? (lead?.probability ? lead.probability : 50),
          expectedClosing,
          revisions: {
            create: [
              {
                revision: 0,
                status: 'DRAFT',
                costingId: body.costingId || null,
                validityDays: body.validityDays ?? 30,
                terms: body.terms || null,
                notes: body.notes || null,
                vatRate: body.vatRate !== undefined ? d(body.vatRate) : (company?.vatRate ?? d(0.12)),
                vatInclusive: body.vatInclusive ?? false,
                hideTotal: body.hideTotal ?? false,
                discountPct: d(body.discountPct ?? 0),
                prNumber: body.prNumber || null,
                delivery: body.delivery || null,
                paymentTerms: body.paymentTerms || customerTerms?.paymentTerms || null,
              },
            ],
          },
        },
        include: { revisions: true },
      });

      if (lines.length) {
        const revisionId = created.revisions[0].id;
        for (const [i, line] of lines.entries()) await checkLine(line, tx, `Line ${i + 1}: `);
        await tx.quotationItem.createMany({
          data: lines.map((line, i) => ({ revisionId, ...lineData(line, i) })),
        });
        await rememberGroups(tx, lines.map((l) => l.group));
        await recalcRevision(revisionId, tx);
      }

      // Creating a quotation from a lead moves the lead on — "Button will
      // direct to quotation and have a status as quotation created".
      if (body.leadId) {
        await tx.lead.update({
          where: { id: body.leadId },
          data: { status: 'QUOTATION_CREATED' },
        });
      }
      // Re-read so the answer carries the totals the lines just produced.
      return lines.length
        ? tx.quotation.findUniqueOrThrow({ where: { id: created.id }, include: { revisions: true } })
        : created;
    });

    await audit(
      {
        entityType: 'quotation',
        entityId: quotation.id,
        action: 'CREATED',
        summary:
          `Created quotation ${quotation.number} — ${quotation.subject}` +
          (body.number ? ' (number typed by hand)' : '') +
          (lines.length ? ` (${lines.length} line${lines.length === 1 ? '' : 's'})` : '') +
          (ownerId !== me.id ? `, authored for ${ownerName}` : ''),
      },
      req,
    );
    res.status(201).json(quotation);
  }),
);

/** Loads a quotation and its editable revision, refusing otherwise. */
async function revisionForEdit(req: Parameters<typeof currentUser>[0], quotationId: string, revisionId: string) {
  const me = currentUser(req);
  const quotation = await prisma.quotation.findUnique({ where: { id: quotationId } });
  if (!quotation) throw notFound('Quotation not found');
  if (!canEditRecord(me, 'gops', 'quotations', quotation.ownerId)) {
    throw forbidden('Only the author can edit this quotation');
  }

  const revision = await prisma.quotationRevision.findFirst({
    where: { id: revisionId, quotationId },
  });
  if (!revision) throw notFound('Revision not found');

  // An approved or superseded revision is a commercial record. Changing it
  // would rewrite what was actually sent to the customer, which is exactly what
  // revision control exists to prevent — raise a new revision instead.
  if (revision.status !== 'DRAFT') {
    throw badRequest(
      `Revision ${revision.revision} is ${revision.status.toLowerCase().replace('_', ' ')} and cannot be changed. Create a new revision.`,
    );
  }
  return { quotation, revision };
}

quotationRoutes.patch(
  '/:id',
  require_('gops.quotations.edit_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(quotationSchema.partial().extend({
      outcome: z.enum(['OPEN', 'SUBMITTED', 'NEGOTIATION', 'WON', 'LOST']).optional(),
      lostReason: z.string().optional().nullable(),
    }), req.body);

    const before = await prisma.quotation.findUnique({
      where: { id: req.params.id },
      include: {
        revisions: {
          select: { status: true, jobs: { select: { id: true, number: true }, take: 1 } },
        },
      },
    });
    if (!before) throw notFound('Quotation not found');
    if (!canEditRecord(me, 'gops', 'quotations', before.ownerId)) {
      throw forbidden('Only the author can edit this quotation');
    }

    // One set of move rules for the detail page and the board (shared/pipeline).
    if (body.outcome !== undefined && body.outcome !== before.outcome) {
      const job = before.revisions.flatMap((r) => r.jobs)[0] ?? null;
      assertOutcomeChange(before.outcome, body.outcome, {
        lostReason: body.lostReason !== undefined ? body.lostReason : before.lostReason,
        hasApprovedRevision: before.revisions.some((r) => r.status === 'APPROVED'),
        hasJob: job !== null,
        jobNumber: job?.number ?? null,
      });
    }

    const renumber = body.number !== undefined && body.number !== before.number;
    if (renumber) await checkQuoteNumber(body.number!, before.id);

    const data: Prisma.QuotationUpdateInput = {};
    if (renumber) data.number = body.number;
    if (body.subject !== undefined) data.subject = body.subject;
    if (body.probability !== undefined) data.probability = body.probability;
    if (body.lostReason !== undefined) data.lostReason = body.lostReason || null;
    if (body.expectedClosing !== undefined) data.expectedClosing = asDate(body.expectedClosing);
    if (body.contactId !== undefined) {
      data.contact = body.contactId ? { connect: { id: body.contactId } } : { disconnect: true };
    }
    if (body.siteId !== undefined) {
      data.site = body.siteId ? { connect: { id: body.siteId } } : { disconnect: true };
    }
    if (body.outcome !== undefined) {
      data.outcome = body.outcome;
      if (body.outcome === 'SUBMITTED') data.submittedAt = new Date();
      if (body.outcome === 'WON' || body.outcome === 'LOST') data.decidedAt = new Date();
    }

    const quotation = await prisma.quotation.update({ where: { id: req.params.id }, data });

    // The lead follows the quotation's outcome, so the pipeline stays honest
    // without anyone maintaining two statuses.
    if (body.outcome && before.leadId) {
      const leadStatus =
        body.outcome === 'WON'
          ? 'WON'
          : body.outcome === 'LOST'
            ? 'LOST'
            : body.outcome === 'SUBMITTED'
              ? 'QUOTATION_SUBMITTED'
              : body.outcome === 'NEGOTIATION'
                ? 'NEGOTIATION'
                : body.outcome === 'OPEN'
                  ? 'QUOTATION_CREATED' // pulled back to a draft
                  : null;
      if (leadStatus) {
        await prisma.lead.update({
          where: { id: before.leadId },
          data: {
            status: leadStatus,
            ...(body.outcome === 'LOST' && body.lostReason ? { lostReason: body.lostReason } : {}),
          },
        });
      }
    }

    // A manager moving somebody else's quotation on the board tells them.
    if (body.outcome && body.outcome !== before.outcome && quotation.ownerId !== me.id) {
      const column = body.outcome === 'OPEN' ? 'QUOTED' : body.outcome;
      await notify({
        userId: quotation.ownerId,
        type: 'system',
        title: `${quotation.number} moved to ${columnByKey(column)?.label ?? body.outcome.toLowerCase()} by ${me.name}`,
        body: quotation.subject,
        link: `/g-ops/quotations/${quotation.id}`,
      });
    }

    const moved = !!body.outcome && body.outcome !== before.outcome;
    await audit(
      {
        entityType: 'quotation',
        entityId: quotation.id,
        action: body.outcome === 'WON' ? 'COMPLETED' : 'UPDATED',
        summary: moved
          ? `Quotation ${quotation.number}: ${before.outcome} → ${body.outcome}`
          : renumber
            ? `Renumbered quotation ${before.number} → ${quotation.number}`
            : `Updated quotation ${quotation.number}`,
        // The move itself, which is what the quotation page's status history
        // reads (outcomeChanges in shared/pipeline.ts).
        ...(moved ? { before: { outcome: before.outcome }, after: { outcome: body.outcome } } : {}),
      },
      req,
    );
    res.json(quotation);
  }),
);

/**
 * Deletes a quotation — the author's, or anyone's for edit_all, and only with
 * gops.quotations.delete. Refused while it is a commercial fact somebody built
 * on: won, made into a project or a job order, or with the approver (decide
 * first). Its revisions and lines go with it; a SCORO quote it continued can
 * be continued again; calendar activities keep their place without it.
 *
 * Its lead: when this was the lead's last quotation, the lead steps back to
 * Costing (it has one) or Qualified, rather than sitting at "quotation created"
 * with no quotation — the board would show a quote that no longer exists.
 */
quotationRoutes.delete(
  '/:id',
  require_('gops.quotations.delete'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const quotation = await prisma.quotation.findUnique({
      where: { id: req.params.id },
      include: {
        revisions: { select: { status: true, jobs: { select: { number: true }, take: 1 } } },
        _count: { select: { jobOrders: true } },
      },
    });
    if (!quotation) throw notFound('Quotation not found');
    if (!canEditRecord(me, 'gops', 'quotations', quotation.ownerId)) {
      throw forbidden('Only the author can delete this quotation');
    }
    const job = quotation.revisions.flatMap((r) => r.jobs)[0];
    if (job) throw badRequest(`${quotation.number} became project ${job.number} — it stays as that project's record`);
    if (quotation._count.jobOrders) throw badRequest(`A job order was raised from ${quotation.number} — it stays as that order's record`);
    if (quotation.outcome === 'WON') throw badRequest(`${quotation.number} is won — reopen it before deleting it`);
    if (quotation.revisions.some((r) => r.status === 'PENDING_APPROVAL')) {
      throw badRequest(`${quotation.number} is with the approver — let them decide before deleting it`);
    }

    const leadMoved = await prisma.$transaction(async (tx) => {
      await tx.quotation.delete({ where: { id: quotation.id } });
      if (!quotation.leadId) return null;
      const lead = await tx.lead.findUnique({
        where: { id: quotation.leadId },
        select: { id: true, number: true, status: true, _count: { select: { quotations: true, costings: true } } },
      });
      if (!lead || lead._count.quotations > 0) return null;
      if (!['QUOTATION_CREATED', 'QUOTATION_SUBMITTED', 'NEGOTIATION'].includes(lead.status)) return null;
      const status = lead._count.costings > 0 ? 'COSTING' : 'QUALIFIED';
      await tx.lead.update({ where: { id: lead.id }, data: { status } });
      return { ...lead, to: status };
    });

    await audit(
      {
        entityType: 'quotation',
        entityId: quotation.id,
        action: 'DELETED',
        summary: `Deleted quotation ${quotation.number} — ${quotation.subject}`,
      },
      req,
    );
    if (leadMoved) {
      await audit(
        {
          entityType: 'lead',
          entityId: leadMoved.id,
          action: 'UPDATED',
          summary: `Lead ${leadMoved.number} back to ${leadMoved.to} — its quotation ${quotation.number} was deleted`,
        },
        req,
      );
    }
    res.json({ ok: true });
  }),
);

// ── Revisions ────────────────────────────────────────────────────────────────

/**
 * Raises a new revision by copying the latest one.
 *
 * Copying rather than editing is the whole point: R0 is what the customer was
 * sent, and it stays readable after R1 changes the price.
 *
 * Raising one while the latest waits on the approver is how a pending
 * quotation is changed, and the superseded revision's approval request is
 * withdrawn in the same transaction. Left open, it sat in the approver's queue
 * for good — and approving it would have offered an outdated revision as the
 * one a project is built from.
 */
quotationRoutes.post(
  '/:id/revisions',
  require_('gops.quotations.edit_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const quotation = await prisma.quotation.findUnique({
      where: { id: req.params.id },
      include: { revisions: { orderBy: { revision: 'desc' }, take: 1, include: { items: true } } },
    });
    if (!quotation) throw notFound('Quotation not found');
    if (!canEditRecord(me, 'gops', 'quotations', quotation.ownerId)) {
      throw forbidden('Only the author can edit this quotation');
    }

    const latest = quotation.revisions[0];
    if (latest?.status === 'DRAFT') {
      throw badRequest(
        `Revision ${latest.revision} is still a draft — finish or submit it before raising another.`,
      );
    }
    const nextRevision = (latest?.revision ?? -1) + 1;

    const { created, withdrawn } = await prisma.$transaction(async (tx) => {
      let withdrawn = false;
      if (latest) {
        await tx.quotationRevision.update({
          where: { id: latest.id },
          data: { status: 'SUPERSEDED' },
        });
        // Whatever it was read as above: a request still open on it goes with it.
        withdrawn = (await cancelOpenRequest('quotation', latest.id, tx, `superseded by R${nextRevision}`, me.id)).length > 0;
      }
      const created = await tx.quotationRevision.create({
        data: {
          quotationId: req.params.id,
          revision: nextRevision,
          status: 'DRAFT',
          costingId: latest?.costingId ?? null,
          validityDays: latest?.validityDays ?? 30,
          terms: latest?.terms ?? null,
          notes: latest?.notes ?? null,
          vatRate: latest?.vatRate ?? d(0.12),
          vatInclusive: latest?.vatInclusive ?? false,
          hideTotal: latest?.hideTotal ?? false,
          discountPct: latest?.discountPct ?? d(0),
          prNumber: latest?.prNumber ?? null,
          delivery: latest?.delivery ?? null,
          paymentTerms: latest?.paymentTerms ?? null,
          items: latest
            ? {
                create: latest.items.map((i) => ({
                  group: i.group,
                  isHeading: i.isHeading,
                  title: i.title,
                  description: i.description,
                  quantity: i.quantity,
                  unit: i.unit,
                  unitPrice: i.unitPrice,
                  amount: i.amount,
                  sortOrder: i.sortOrder,
                  unitCost: i.unitCost,
                  costAmount: i.costAmount,
                  providerSupplierId: i.providerSupplierId,
                  providerUserId: i.providerUserId,
                  costNote: i.costNote,
                })),
              }
            : undefined,
        },
      });
      return { created, withdrawn };
    });

    await recalcRevision(created.id);
    const fresh = await revisionWithItems(created.id);
    await audit(
      {
        entityType: 'quotation',
        entityId: req.params.id,
        action: 'CREATED',
        summary: `Raised revision ${created.revision} of ${quotation.number}${
          withdrawn ? ` — R${latest!.revision} withdrawn from approval` : ''
        }`,
      },
      req,
    );
    res.status(201).json(presentRevision(fresh as unknown as Record<string, unknown>, true));
  }),
);

const revisionSchema = z.object({
  costingId: z.string().optional().nullable(),
  validityDays: z.number().int().min(1).optional(),
  terms: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  vatInclusive: z.boolean().optional(),
  discountPct: z.number().min(0, 'A discount cannot be negative').max(100, 'A discount cannot exceed 100%').optional(),
  prNumber: z.string().trim().max(120).optional().nullable(),
  delivery: z.string().trim().max(500).optional().nullable(),
  paymentTerms: z.string().trim().max(500).optional().nullable(),
  vatRate: z.number().min(0).max(1).optional(),
  hideTotal: z.boolean().optional(),
});

/**
 * SCORO's Tax dropdown: a quotation carries the company's VAT rate, or 0% for
 * a zero-rated sale (a PEZA or BOI-registered customer, an export). Nothing in
 * between — a rate typed by hand is how a quote goes out at 1.2%. A draft may
 * also keep the rate it was snapshotted with, so a Settings change never
 * forces an old draft to move. Checked before anything is written, so a
 * refused rate burns no number.
 */
async function checkVatRate(rate: number | undefined, keep?: Prisma.Decimal | null) {
  if (rate === undefined) return;
  const company = await prisma.company.findUnique({ where: { id: 'company' }, select: { vatRate: true } });
  const companyRate = company?.vatRate ?? d(0.12);
  const allowed = [d(0), companyRate, ...QUOTATION_EXTRA_TAX_RATES.map((o) => d(o.rate)), ...(keep ? [keep] : [])];
  if (!allowed.some((r) => r.equals(d(rate)))) {
    throw badRequest(
      `VAT on a quotation is the company rate (${Number(companyRate.mul(100).toFixed(2))}%), 8%, 6% for a government client, or 0% for a zero-rated sale`,
    );
  }
}

quotationRoutes.patch(
  '/:id/revisions/:revisionId',
  require_('gops.quotations.edit_own'),
  handler(async (req, res) => {
    const { revision } = await revisionForEdit(req, req.params.id, req.params.revisionId);
    const body = parseBody(revisionSchema, req.body);
    await checkVatRate(body.vatRate, revision.vatRate);

    await prisma.quotationRevision.update({
      where: { id: req.params.revisionId },
      data: {
        ...(body.costingId !== undefined ? { costingId: body.costingId || null } : {}),
        ...(body.validityDays !== undefined ? { validityDays: body.validityDays } : {}),
        ...(body.terms !== undefined ? { terms: body.terms || null } : {}),
        ...(body.notes !== undefined ? { notes: body.notes || null } : {}),
        ...(body.vatInclusive !== undefined ? { vatInclusive: body.vatInclusive } : {}),
        ...(body.vatRate !== undefined ? { vatRate: d(body.vatRate) } : {}),
        ...(body.hideTotal !== undefined ? { hideTotal: body.hideTotal } : {}),
        ...(body.discountPct !== undefined ? { discountPct: d(body.discountPct) } : {}),
        ...(body.prNumber !== undefined ? { prNumber: body.prNumber || null } : {}),
        ...(body.delivery !== undefined ? { delivery: body.delivery || null } : {}),
        ...(body.paymentTerms !== undefined ? { paymentTerms: body.paymentTerms || null } : {}),
      },
    });
    await recalcRevision(req.params.revisionId);
    const discountChanged = body.discountPct !== undefined && !d(body.discountPct).equals(revision.discountPct);
    const vatChanged = body.vatRate !== undefined && !d(body.vatRate).equals(revision.vatRate);
    const pctOf = (rate: Prisma.Decimal) => `${Number(rate.mul(100).toFixed(2))}%`;
    const changes = [
      discountChanged ? `discount ${Number(revision.discountPct)}% -> ${body.discountPct}%` : '',
      vatChanged ? `VAT ${pctOf(revision.vatRate)} -> ${pctOf(d(body.vatRate!))}` : '',
    ].filter(Boolean);
    await audit(
      {
        entityType: 'quotation',
        entityId: req.params.id,
        action: 'UPDATED',
        summary: changes.length
          ? `Revision ${revision.revision}: ${changes.join(', ')}`
          : `Updated the terms of revision ${revision.revision}`,
      },
      req,
    );
    res.json(presentRevision((await revisionWithItems(req.params.revisionId)) as unknown as Record<string, unknown>, true));
  }),
);

/**
 * Fills the revision's lines from its costing's scope of work.
 *
 * This is the integration the requirements ask for — "Costing includes also how
 * it came up with the contract amount ... so that it will also reflect on
 * progress billing". Quote what you scoped, and the same sections carry through
 * to the Schedule of Values in Phase 4.
 */
quotationRoutes.post(
  '/:id/revisions/:revisionId/from-costing',
  require_('gops.quotations.edit_own'),
  handler(async (req, res) => {
    const { revision } = await revisionForEdit(req, req.params.id, req.params.revisionId);
    if (!revision.costingId) throw badRequest('Link a costing to this revision first');

    const sections = await costingScopeSections(revision.costingId);
    if (!sections.length) {
      throw badRequest('That costing has no scope of work yet — add sections to it first');
    }

    await prisma.$transaction(async (tx) => {
      await tx.quotationItem.deleteMany({ where: { revisionId: req.params.revisionId } });
      await tx.quotationItem.createMany({
        // The one mapping (shared/quotation.ts) — the editor previews the same.
        data: quotationLinesFromSections(sections).map((line) => ({
          revisionId: req.params.revisionId,
          ...line,
        })),
      });
      await recalcRevision(req.params.revisionId, tx);
    });

    await audit(
      {
        entityType: 'quotation',
        entityId: req.params.id,
        action: 'UPDATED',
        summary: `Filled revision ${revision.revision} from the costing's scope of work (${sections.length} lines)`,
      },
      req,
    );
    res.json(presentRevision((await revisionWithItems(req.params.revisionId)) as unknown as Record<string, unknown>, true));
  }),
);

/**
 * Replaces every line of a DRAFT revision at once — the full-page editor's
 * save. One transaction: the lines are checked, the old ones deleted, the new
 * ones written in the order given (sortOrder = position) and the totals
 * recomputed, so a refused line leaves the revision exactly as it was.
 */
quotationRoutes.put(
  '/:id/revisions/:revisionId/lines',
  require_('gops.quotations.edit_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const { quotation, revision } = await revisionForEdit(req, req.params.id, req.params.revisionId);
    const body = parseBody(
      z.object({ lines: z.array(itemSchema).max(MAX_LINES, `A quotation takes at most ${MAX_LINES} lines`) }),
      req.body,
    );
    const revisionId = revision.id;

    const before = await prisma.$transaction(async (tx) => {
      // Re-read inside the transaction: a submit between revisionForEdit and
      // here must not let the lines of a revision under approval change.
      const current = await tx.quotationRevision.findUnique({ where: { id: revisionId }, select: { status: true } });
      if (current?.status !== 'DRAFT') {
        throw badRequest(`Revision ${revision.revision} is no longer a draft and cannot be changed. Create a new revision.`);
      }
      for (const [i, line] of body.lines.entries()) await checkLine(line, tx, `Line ${i + 1}: `);
      const removed = await tx.quotationItem.deleteMany({ where: { revisionId } });
      if (body.lines.length) {
        await tx.quotationItem.createMany({
          data: body.lines.map((line, i) => ({ revisionId, ...lineData(line, i) })),
        });
        await rememberGroups(tx, body.lines.map((l) => l.group));
      }
      await recalcRevision(revisionId, tx);
      return removed.count;
    });

    await audit(
      {
        entityType: 'quotation',
        entityId: quotation.id,
        action: 'UPDATED',
        summary: `Replaced the lines of ${quotation.number} R${revision.revision}: ${before} → ${body.lines.length} line${body.lines.length === 1 ? '' : 's'}`,
      },
      req,
    );
    res.json(
      presentRevision(
        (await revisionWithItems(revisionId)) as unknown as Record<string, unknown>,
        canSeeQuotationCost(me, quotation.ownerId),
      ),
    );
  }),
);

quotationRoutes.post(
  '/:id/revisions/:revisionId/items',
  require_('gops.quotations.edit_own'),
  handler(async (req, res) => {
    const { quotation, revision } = await revisionForEdit(req, req.params.id, req.params.revisionId);
    const body = parseBody(itemSchema, req.body);
    await checkLine(body);

    const item = await prisma.$transaction(async (tx) => {
      const last = body.sortOrder === undefined
        ? await tx.quotationItem.findFirst({
            where: { revisionId: req.params.revisionId },
            orderBy: { sortOrder: 'desc' },
            select: { sortOrder: true },
          })
        : null;
      const created = await tx.quotationItem.create({
        data: {
          revisionId: req.params.revisionId,
          // A new line goes to the bottom, as it does in SCORO.
          ...lineData(body, body.sortOrder ?? (last ? last.sortOrder + 1 : 0)),
        },
      });
      await rememberGroups(tx, [body.group]);
      await recalcRevision(req.params.revisionId, tx);
      return created;
    });

    await audit(
      {
        entityType: 'quotation',
        entityId: quotation.id,
        action: 'UPDATED',
        summary: `Added a line to ${quotation.number} R${revision.revision}: ${item.title || item.description.slice(0, 60)}`,
      },
      req,
    );
    res.status(201).json(presentRevision((await revisionWithItems(req.params.revisionId)) as unknown as Record<string, unknown>, true));
  }),
);

quotationRoutes.patch(
  '/:id/revisions/:revisionId/items/:itemId',
  require_('gops.quotations.edit_own'),
  handler(async (req, res) => {
    const { quotation, revision } = await revisionForEdit(req, req.params.id, req.params.revisionId);
    const body = parseBody(itemPatchSchema, req.body);

    const existing = await prisma.quotationItem.findFirst({
      where: { id: req.params.itemId, revisionId: req.params.revisionId },
    });
    if (!existing) throw notFound('Line not found');

    const heading = body.isHeading ?? existing.isHeading;
    const quantity = heading ? 0 : (body.quantity ?? Number(existing.quantity));
    const unitPrice = heading ? 0 : (body.unitPrice ?? Number(existing.unitPrice));
    // undefined keeps the stored cost; null clears it.
    const unitCost = heading
      ? null
      : body.unitCost === undefined
        ? existing.unitCost == null
          ? null
          : Number(existing.unitCost)
        : body.unitCost;
    const merged = {
      isHeading: heading,
      title: body.title !== undefined ? body.title : existing.title,
      description: body.description !== undefined ? body.description : existing.description,
      providerSupplierId: body.providerSupplierId !== undefined ? body.providerSupplierId || null : existing.providerSupplierId,
      providerUserId: body.providerUserId !== undefined ? body.providerUserId || null : existing.providerUserId,
    };
    // Choosing one kind of provider clears the other, so switching a line
    // from outsourced to in-house is one edit rather than two.
    if (body.providerUserId && body.providerSupplierId === undefined) merged.providerSupplierId = null;
    if (body.providerSupplierId && body.providerUserId === undefined) merged.providerUserId = null;
    await checkLine(merged);

    await prisma.$transaction(async (tx) => {
      if (body.group) await rememberGroups(tx, [body.group]);
      await tx.quotationItem.update({
        where: { id: req.params.itemId },
        data: {
          ...(body.group !== undefined ? { group: body.group || null } : {}),
          ...(body.title !== undefined ? { title: body.title || null } : {}),
          ...(body.description !== undefined ? { description: body.description ?? '' } : {}),
          ...(body.unit !== undefined ? { unit: body.unit } : {}),
          ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
          ...(body.costNote !== undefined ? { costNote: body.costNote || null } : {}),
          isHeading: heading,
          providerSupplierId: heading ? null : merged.providerSupplierId,
          providerUserId: heading ? null : merged.providerUserId,
          quantity: d(quantity),
          unitPrice: d(unitPrice),
          amount: lineAmount(quantity, unitPrice),
          unitCost: unitCost == null ? null : d(unitCost),
          costAmount: unitCost == null ? null : lineAmount(quantity, unitCost),
        },
      });
      await recalcRevision(req.params.revisionId, tx);
    });

    await audit(
      {
        entityType: 'quotation',
        entityId: quotation.id,
        action: 'UPDATED',
        summary: `Changed a line on ${quotation.number} R${revision.revision}: ${merged.title || (merged.description ?? '').slice(0, 60)}`,
      },
      req,
    );
    res.json(presentRevision((await revisionWithItems(req.params.revisionId)) as unknown as Record<string, unknown>, true));
  }),
);

quotationRoutes.delete(
  '/:id/revisions/:revisionId/items/:itemId',
  require_('gops.quotations.edit_own'),
  handler(async (req, res) => {
    const { quotation, revision } = await revisionForEdit(req, req.params.id, req.params.revisionId);
    const existing = await prisma.quotationItem.findFirst({
      where: { id: req.params.itemId, revisionId: req.params.revisionId },
    });
    if (!existing) throw notFound('Line not found');

    await prisma.$transaction(async (tx) => {
      await tx.quotationItem.delete({ where: { id: req.params.itemId } });
      await recalcRevision(req.params.revisionId, tx);
    });
    await audit(
      {
        entityType: 'quotation',
        entityId: quotation.id,
        action: 'UPDATED',
        summary: `Removed a line from ${quotation.number} R${revision.revision}: ${existing.title || existing.description.slice(0, 60)}`,
      },
      req,
    );
    res.json(presentRevision((await revisionWithItems(req.params.revisionId)) as unknown as Record<string, unknown>, true));
  }),
);

// ── Approval ─────────────────────────────────────────────────────────────────

quotationRoutes.post(
  '/:id/revisions/:revisionId/submit',
  require_('gops.quotations.edit_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const { quotation, revision } = await revisionForEdit(req, req.params.id, req.params.revisionId);
    // An optional route the submitter ticked — "Add the CEO as approver".
    const { optionId } = parseBody(z.object({ optionId: z.string().optional().nullable() }), req.body ?? {});

    const withItems = await prisma.quotationRevision.findUnique({
      where: { id: revision.id },
      include: { items: true },
    });
    if (!withItems?.items.some((i) => !i.isHeading)) {
      throw badRequest('Add at least one line before submitting for approval');
    }

    await prisma.quotationRevision.update({
      where: { id: revision.id },
      data: { status: 'PENDING_APPROVAL' },
    });

    try {
      await submitForApproval({
        documentType: 'quotation',
        documentId: revision.id,
        documentNumber: `${quotation.number} R${revision.revision}`,
        subject: `${quotation.subject}`,
        amount: Number(withItems.total),
        link: `/g-ops/quotations/${quotation.id}`,
        requesterId: me.id,
        optionId: optionId || null,
      });
    } catch (err) {
      // Refused (no route, nobody to approve, an option that does not apply):
      // back to a draft, never pending with no approval behind it.
      await prisma.quotationRevision.update({ where: { id: revision.id }, data: { status: 'DRAFT' } });
      throw err;
    }

    res.json({ ok: true });
  }),
);

/**
 * When the approval engine settles a quotation, the revision follows.
 *
 * The module subscribes rather than the engine knowing about quotations — see
 * `api/src/shared/approvals.ts`.
 *
 * Only a revision still PENDING_APPROVAL takes the outcome, claimed with a
 * conditional update. A decision on one that has moved on — superseded while
 * its request was still open — changes nothing: approving it must never bring
 * an outdated revision back as the approved one, nor supersede the revision
 * that really is.
 */
onApprovalSettled('quotation', async (request, outcome) => {
  const revision = await prisma.quotationRevision.findUnique({
    where: { id: request.documentId },
    include: { quotation: { select: { id: true, number: true, ownerId: true } } },
  });
  if (!revision) return;

  // The status the revision had moved on to, or null once it took the outcome.
  const movedOn = await prisma.$transaction(async (tx) => {
    const claimed = await tx.quotationRevision.updateMany({
      where: { id: revision.id, status: 'PENDING_APPROVAL' },
      data: outcome === 'APPROVED' ? { status: 'APPROVED', approvedAt: new Date() } : { status: 'REJECTED' },
    });
    if (!claimed.count) {
      return (await tx.quotationRevision.findUnique({ where: { id: revision.id }, select: { status: true } }))?.status ?? revision.status;
    }
    if (outcome === 'APPROVED') {
      // Only one revision of a quotation may be APPROVED (model §10).
      await tx.quotationRevision.updateMany({
        where: {
          quotationId: revision.quotationId,
          status: 'APPROVED',
          id: { not: revision.id },
        },
        data: { status: 'SUPERSEDED' },
      });
    }
    return null;
  });

  if (movedOn) {
    // The engine has recorded the decision — it is the record of fact — and
    // the trail says why the revision did not follow it.
    await audit({
      entityType: 'quotation',
      entityId: revision.quotationId,
      action: 'UPDATED',
      summary: `Revision ${revision.revision} of ${revision.quotation.number} was ${outcome.toLowerCase()} after it was ${movedOn.toLowerCase().replace(/_/g, ' ')} — not applied`,
    });
    return;
  }

  await audit({
    entityType: 'quotation',
    entityId: revision.quotationId,
    action: outcome === 'APPROVED' ? 'APPROVED' : 'REJECTED',
    summary: `Revision ${revision.revision} of ${revision.quotation.number} ${outcome.toLowerCase()}`,
  });
});

// ── Quotation PDF ────────────────────────────────────────────────────────────

type LoadedQuotation = NonNullable<Awaited<ReturnType<typeof loadQuotation>>>;

/**
 * A quotation the caller may print: anyone with `view_all`, else its author.
 * The PDF route and the template editor's preview both come through here.
 */
export async function printableQuotation(me: ResolvedUser, id: string): Promise<LoadedQuotation> {
  const quotation = await loadQuotation(id);
  if (!quotation) throw notFound('Quotation not found');
  if (!me.isSuperAdmin && !me.permissions.has('gops.quotations.view_all') && quotation.ownerId !== me.id) {
    throw forbidden('This quotation belongs to someone else');
  }
  return quotation;
}

/**
 * What a quotation prints — its fields, its lines, its totals and who signs
 * it — for the layout in Admin › PDF Templates to place. Cost is never read
 * here, so no layout can print it. `optionId` is an optional route the page
 * has ticked but not yet submitted ("Add the CEO as approver"), so a draft's
 * PDF shows the sign-offs that submitting it would bring.
 */
export async function quotationPrintData(
  quotation: LoadedQuotation,
  revision: LoadedQuotation['revisions'][number],
  opts: { optionId?: string | null } = {},
): Promise<DesignData> {
  const company = await prisma.company.findUnique({ where: { id: 'company' }, select: { currency: true } });
  const currency = company?.currency ?? 'PHP';
  // The table's figures carry no currency; it is named once, in the head and
  // in "Total Price (PHP):".
  const amount = (v: Prisma.Decimal | number) => formatAmount(Number(v));
  const ratePct = `${Number((Number(revision.vatRate) * 100).toFixed(2))}%`;
  const discountPct = Number(revision.discountPct);
  const discountAmount = Number(revision.discountAmount);
  const net = Number(revision.subtotal) - discountAmount;
  // "Hide total" hides the money everywhere on the paper — a layout that
  // prints {{quotation.total}} in a box of its own included.
  const money = (v: string) => (revision.hideTotal ? '' : v);

  const place = quotation.site?.address
    ? [quotation.site.address, quotation.site.city]
    : quotation.customer.sites[0]
      ? [quotation.customer.sites[0].address, quotation.customer.sites[0].city]
      : [];
  const contact = quotation.contact;
  const owner = quotation.owner;
  const validUntil = new Date(revision.createdAt.getTime() + revision.validityDays * 86_400_000);
  const number = revision.revision > 0 ? `${quotation.number} R${revision.revision}` : quotation.number;

  const fields: Record<string, string> = {
    'quotation.number': number,
    'quotation.baseNumber': quotation.number,
    'quotation.revision': String(revision.revision),
    'quotation.date': formatShortDate(revision.createdAt),
    'quotation.dateLong': formatDate(revision.createdAt),
    'quotation.subject': quotation.subject,
    'quotation.validity': `${revision.validityDays} days`,
    'quotation.validUntil': formatShortDate(validUntil),
    'quotation.paymentTerms': revision.paymentTerms ?? '',
    'quotation.prNumber': revision.prNumber ?? '',
    'quotation.delivery': revision.delivery ?? '',
    'quotation.terms': revision.terms ?? '',
    'quotation.notes': revision.notes ?? '',
    'quotation.currency': currency,
    'quotation.vatRate': ratePct,
    'quotation.subtotal': money(amount(revision.subtotal)),
    'quotation.discount': discountAmount > 0 ? money(amount(discountAmount)) : '',
    'quotation.vat': money(amount(revision.vatAmount)),
    'quotation.total': money(amount(revision.total)),
    'customer.name': quotation.customer.legalName || quotation.customer.name,
    'customer.tradeName': quotation.customer.name,
    'customer.code': quotation.customer.code,
    'customer.address': place.filter(Boolean).join(', '),
    'customer.phone': quotation.customer.phone ?? '',
    'customer.email': quotation.customer.email ?? '',
    'contact.name': contact?.name ?? '',
    'contact.position': contact?.position ?? '',
    'contact.nameAndPosition': contact ? `${contact.name}${contact.position ? `, ${contact.position}` : ''}` : '',
    'contact.email': contact?.email ?? '',
    'contact.phone': contact?.phone || contact?.mobile || '',
    'site.name': quotation.site?.name ?? '',
    'site.address': [quotation.site?.address, quotation.site?.city].filter(Boolean).join(', '),
    'owner.name': owner.name,
    'owner.position': owner.position ?? '',
    'owner.email': owner.email ?? '',
    'owner.phone': owner.phone ?? '',
  };

  // A subheading is a heading row. A group is NOT (2026-10-06, the owner's
  // call): it is the salesperson's filing, not the customer's reading, so it
  // prints only where the layout gives the table a Group column of its own.
  // A product prints its name in bold, and its description under it.
  const rows: DesignRow[] = [];
  let n = 0;
  for (const i of revision.items) {
    if (i.isHeading) {
      rows.push({ heading: (i.title ?? '').trim() });
      continue;
    }
    const qty = Number(i.quantity);
    const qtyText = Number.isInteger(qty) ? String(qty) : qty.toString();
    const title = (i.title ?? '').trim();
    const description = (i.description ?? '').trim();
    rows.push({
      cells: {
        no: String(++n),
        product: title ? (description ? { title, body: description } : { title }) : description,
        qtyUnit: `${qtyText} ${i.unit}`,
        qty: qtyText,
        unit: i.unit,
        unitPrice: amount(i.unitPrice),
        amount: amount(i.amount),
        group: i.group ?? '',
      },
    });
  }

  const totals: PdfTotal[] = [{ label: 'Sub Total:', value: amount(revision.subtotal) }];
  if (discountAmount > 0) {
    totals.push({ label: `Discount (${discountPct.toFixed(discountPct % 1 ? 2 : 0)}%):`, value: `-${amount(discountAmount)}` });
    // On an inclusive quote the net still carries the VAT, so it is not a sum without tax.
    if (!revision.vatInclusive) totals.push({ label: 'Sum without tax:', value: amount(net) });
  }
  totals.push({
    label: revision.vatInclusive ? `VAT included (${ratePct}):` : `VAT (${ratePct}):`,
    value: amount(revision.vatAmount),
  });
  totals.push({ label: `Total Price (${currency}):`, value: amount(revision.total), bold: true });

  // Prepared by the author; then every step of the approval route, dated
  // once it has approved and "Pending" until then — the CEO's too, when the
  // submitter added them. A step still open names who will decide it; a draft
  // shows the route submitting it would take. Each with how to reach them,
  // read here for the paper only: the quotation's own response never carries
  // a mobile.
  const slots = await approvalSlots(
    'quotation',
    revision.id,
    revision.status === 'DRAFT' ? { amount: Number(revision.total), requesterId: owner.id, optionId: opts.optionId } : undefined,
  );
  const author = await prisma.user.findUnique({
    where: { id: owner.id },
    select: { phone: true, employee: { select: { mobile: true } } },
  });
  const signatories: Signatory[] = [
    {
      role: 'Prepared by',
      name: owner.name,
      position: owner.position ?? undefined,
      phone: author ? contactPhone(author) : undefined,
      email: owner.email ?? undefined,
      at: revision.createdAt,
    },
    ...(slots.length
      ? slots.map((sl): Signatory => {
          const role = slots.length > 1 ? `Approved by — ${sl.step}` : 'Approved by';
          if (sl.name) return { role, name: sl.name, position: sl.position, phone: sl.phone, email: sl.email, at: sl.at };
          // Not yet signed: who will sign it, with "Pending" in place of the
          // date. One person is named with how to reach them; where any of
          // several may sign, all their names, and no contact to guess between.
          const who = sl.assigned ?? [];
          if (who.length === 1) {
            return { role, name: who[0].name, position: who[0].position, phone: who[0].phone, email: who[0].email };
          }
          return who.length > 1 ? { role, name: who.map((p) => p.name).join(' or ') } : { role };
        })
      : [{ role: 'Approved by' }]),
  ];

  return {
    title: `${number} — Quotation`,
    fields,
    rows,
    // "Hide total": the lines and their prices, no sum — a rate-sheet quote.
    totals: revision.hideTotal ? null : totals,
    signatories,
  };
}

quotationRoutes.get(
  '/:id/revisions/:revisionId/pdf',
  requireAny('gops.quotations.view_all', 'gops.quotations.view_own'),
  handler(async (req, res) => {
    const quotation = await printableQuotation(currentUser(req), req.params.id);
    const revision = quotation.revisions.find((r) => r.id === req.params.revisionId);
    if (!revision) throw notFound('Revision not found');

    // The layout is the administrator's (Admin › PDF Templates), else the
    // standard one; the engine draws it either way. `?option=` is a route the
    // page has ticked on a draft but not yet submitted — the CEO — so its PDF
    // shows the sign-offs submitting would bring; one that does not apply is
    // ignored.
    const { design } = await quotationDesign();
    const optionId = typeof req.query.option === 'string' && req.query.option ? req.query.option : null;
    const pdf = await renderDesigned(design, await quotationPrintData(quotation, revision, { optionId }));

    await audit(
      {
        entityType: 'quotation',
        entityId: quotation.id,
        action: 'EXPORTED',
        summary: `Printed ${quotation.number} R${revision.revision}`,
      },
      req,
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${quotation.number}-R${revision.revision}.pdf"`);
    res.send(pdf);
  }),
);

// ════════════════════════════════════════════════════════════════════
//  SALES CALENDAR
// ════════════════════════════════════════════════════════════════════

export const activityRoutes = Router();
activityRoutes.use(authenticate);

activityRoutes.get(
  '/',
  require_('gops.calendar.view_all'),
  handler(async (req, res) => {
    // Window or record — the one rule lives in shared/activities.ts so the
    // calendar's verification reads exactly what this route reads.
    const q = req.query as Record<string, unknown>;
    const query: ActivityQuery = {};
    for (const key of ['from', 'to', 'leadId', 'quotationId', 'customerId', 'assignedToId'] as const) {
      if (q[key] !== undefined && q[key] !== '') query[key] = String(q[key]);
    }
    const rows = await prisma.salesActivity.findMany({
      ...activityWhere(query),
      include: ACTIVITY_INCLUDE,
    });
    res.json(rows);
  }),
);

const ACTIVITY_INCLUDE = {
  assignedTo: { select: { id: true, name: true } },
  lead: { select: { id: true, number: true, companyName: true } },
  quotation: { select: { id: true, number: true } },
  customer: { select: { id: true, name: true } },
} as const;

/** One activity, for a deep link (`/g-ops/calendar?activity=<id>`). */
activityRoutes.get(
  '/:id',
  require_('gops.calendar.view_all'),
  handler(async (req, res) => {
    const row = await prisma.salesActivity.findUnique({
      where: { id: req.params.id },
      include: ACTIVITY_INCLUDE,
    });
    if (!row) throw notFound('Activity not found');
    res.json(row);
  }),
);

const activitySchema = z.object({
  type: z.enum(['CALL', 'SITE_VISIT', 'MEETING', 'FOLLOW_UP', 'SUBMISSION', 'OTHER']).default('FOLLOW_UP'),
  subject: z.string().trim().min(2, 'What is happening?'),
  notes: z.string().optional().nullable(),
  location: z.string().trim().optional().nullable(),
  assignedToId: z.string().optional(),
  leadId: z.string().optional().nullable(),
  quotationId: z.string().optional().nullable(),
  customerId: z.string().optional().nullable(),
  startsAt: z.string().min(1, 'When?'),
  durationMinutes: z.number().int().min(5).max(1440).default(60),
  status: z.enum(['PLANNED', 'DONE', 'CANCELLED']).optional(),
});

activityRoutes.post(
  '/',
  require_('gops.calendar.view_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(activitySchema, req.body);
    const assignedToId = body.assignedToId || me.id;

    const activity = await prisma.salesActivity.create({
      data: {
        type: body.type,
        subject: body.subject,
        notes: body.notes || null,
        location: body.location || null,
        assignedToId,
        leadId: body.leadId || null,
        quotationId: body.quotationId || null,
        customerId: body.customerId || null,
        startsAt: new Date(body.startsAt),
        durationMinutes: body.durationMinutes,
        /*
          The schema has accepted a status since this was written and the
          create never wrote one, so everything came back PLANNED. Nothing
          noticed while the only caller was the calendar, which books things
          that have not happened — logging a call you have just made is the
          first use that says DONE, and it was silently recorded as still
          owed. `completedAt` is set here the same way the patch sets it.
        */
        status: body.status ?? 'PLANNED',
        completedAt: body.status === 'DONE' ? new Date() : null,
      },
    });

    if (assignedToId !== me.id) {
      await notify({
        userId: assignedToId,
        type: 'system',
        title: `Scheduled for you: ${activity.subject}`,
        // Manila-pinned, like every timestamp a document prints; the link
        // lands on the activity itself, on the day it falls in Manila.
        body: formatDateTime(activity.startsAt),
        link: `/g-ops/calendar?activity=${activity.id}&date=${manilaDayKey(activity.startsAt)}`,
      });
    }
    await audit(
      {
        entityType: 'sales_activity',
        entityId: activity.id,
        action: 'CREATED',
        summary: `${activity.status === 'DONE' ? 'Logged' : 'Scheduled'} ${activity.type.toLowerCase().replace(/_/g, ' ')}: ${activity.subject}`,
        after: activity,
      },
      req,
    );
    res.status(201).json(activity);
  }),
);

activityRoutes.patch(
  '/:id',
  require_('gops.calendar.view_all'),
  handler(async (req, res) => {
    const body = parseBody(activitySchema.partial(), req.body);
    const existing = await prisma.salesActivity.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('Activity not found');

    const updated = await prisma.salesActivity.update({
        where: { id: req.params.id },
        data: {
          ...(body.type !== undefined ? { type: body.type } : {}),
          ...(body.subject !== undefined ? { subject: body.subject } : {}),
          ...(body.notes !== undefined ? { notes: body.notes || null } : {}),
          ...(body.location !== undefined ? { location: body.location || null } : {}),
          ...(body.assignedToId !== undefined ? { assignedToId: body.assignedToId } : {}),
          // The modal sends all three links on Modify; without these a
          // re-linked activity silently kept its old lead, quotation or customer.
          ...(body.leadId !== undefined ? { leadId: body.leadId || null } : {}),
          ...(body.quotationId !== undefined ? { quotationId: body.quotationId || null } : {}),
          ...(body.customerId !== undefined ? { customerId: body.customerId || null } : {}),
          ...(body.startsAt !== undefined ? { startsAt: new Date(body.startsAt) } : {}),
          ...(body.durationMinutes !== undefined ? { durationMinutes: body.durationMinutes } : {}),
          ...(body.status !== undefined
            ? { status: body.status, completedAt: body.status === 'DONE' ? new Date() : null }
            : {}),
        },
    });
    await audit(
      {
        entityType: 'sales_activity',
        entityId: updated.id,
        action: 'UPDATED',
        summary:
          body.status && body.status !== existing.status
            ? `${updated.subject}: ${existing.status} → ${body.status}`
            : `Updated activity: ${updated.subject}`,
        before: existing,
        after: updated,
      },
      req,
    );
    res.json(updated);
  }),
);

activityRoutes.delete(
  '/:id',
  require_('gops.calendar.view_all'),
  handler(async (req, res) => {
    const existing = await prisma.salesActivity.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('Activity not found');
    await prisma.salesActivity.delete({ where: { id: req.params.id } });
    await audit(
      {
        entityType: 'sales_activity',
        entityId: existing.id,
        action: 'DELETED',
        summary: `Deleted activity: ${existing.subject}`,
        before: existing,
      },
      req,
    );
    res.json({ ok: true });
  }),
);

// ════════════════════════════════════════════════════════════════════
//  PIPELINE
// ════════════════════════════════════════════════════════════════════

export const pipelineRoutes = Router();
pipelineRoutes.use(authenticate);

/**
 * The pipeline is a VIEW over leads and quotations, not a third record.
 *
 * The route only fetches; `buildBoard()` in shared/pipeline.ts decides what
 * is a card, which column it stands in, what it is worth and where it may be
 * dropped. Moves write through PATCH /leads and PATCH /quotations — there is
 * no board-only write path.
 *
 * Won and Lost are bounded to `decidedWithinDays` (default 90) so the two
 * terminal columns stop growing without limit.
 */
async function loadBoard(req: Parameters<typeof currentUser>[0]): Promise<BoardResponse> {
  const me = currentUser(req);
  const ownerId = req.query.ownerId ? String(req.query.ownerId) : undefined;
  const search = req.query.search ? String(req.query.search).trim().toLowerCase() : '';
  const requestedDays = Number(req.query.decidedWithinDays);
  const decidedWithinDays = Number.isFinite(requestedDays)
    ? Math.min(730, Math.max(30, Math.round(requestedDays)))
    : 90;
  const now = new Date();
  const decidedFrom = new Date(now.getTime() - decidedWithinDays * 86_400_000);

  const nextPlanned = {
    where: { status: 'PLANNED' as const, startsAt: { gte: now } },
    orderBy: { startsAt: 'asc' as const },
    take: 1,
    select: { subject: true, startsAt: true },
  };

  const [leads, quotations] = await Promise.all([
    prisma.lead.findMany({
      where: {
        // A lead with a quotation is never a card; its quotation is.
        quotations: { none: {} },
        OR: [
          { status: { in: ['NEW', 'CONTACTED', 'QUALIFIED', 'SITE_VISIT', 'COSTING', 'ON_HOLD'] } },
          { status: 'LOST', updatedAt: { gte: decidedFrom } },
        ],
        ...(ownerId ? { assignedToId: ownerId } : {}),
      },
      include: {
        assignedTo: { select: { id: true, name: true, photoPath: true } },
        customer: { select: { id: true, name: true } },
        activities: nextPlanned,
        _count: { select: { quotations: true } },
      },
    }),
    prisma.quotation.findMany({
      where: {
        OR: [
          { outcome: { in: ['OPEN', 'SUBMITTED', 'NEGOTIATION'] } },
          { outcome: { in: ['WON', 'LOST'] }, decidedAt: { gte: decidedFrom } },
        ],
        ...(ownerId ? { ownerId } : {}),
      },
      include: {
        owner: { select: { id: true, name: true, photoPath: true } },
        customer: { select: { id: true, name: true } },
        lead: { select: { expectedClosing: true, nextAction: true, nextActionDate: true } },
        revisions: {
          orderBy: { revision: 'desc' },
          select: {
            id: true,
            revision: true,
            status: true,
            total: true,
            validityDays: true,
            createdAt: true,
            costing: { select: { contractValue: true, totalCost: true, markupPct: true, discountAmount: true } },
            jobs: { select: { id: true, number: true }, take: 1 },
          },
        },
        activities: nextPlanned,
      },
    }),
  ]);

  const matches = (...fields: (string | null | undefined)[]) =>
    !search || fields.some((f) => (f ?? '').toLowerCase().includes(search));

  return buildBoard({
    leads: leads
      .filter((l) => matches(l.number, l.companyName, l.customer?.name, l.description))
      .map((l) => ({ ...l, quotationCount: l._count.quotations })),
    quotations: quotations.filter((q) => matches(q.number, q.subject, q.customer.name)),
    now,
    decidedWithinDays,
    me,
  });
}

pipelineRoutes.get(
  '/',
  require_('gops.pipeline.view_all'),
  handler(async (req, res) => {
    res.json(await loadBoard(req));
  }),
);

/**
 * The board's CSV twin: one row per card. Audited BEFORE the bytes go out.
 *
 * Served at /api/pipeline/board.csv: the router is mounted at /api/pipeline,
 * and Express only hands it paths that continue with a slash, so a
 * /api/pipeline.csv could never reach it.
 */
pipelineRoutes.get(
  '/board.csv',
  require_('gops.pipeline.export'),
  handler(async (req, res) => {
    const board = await loadBoard(req);
    const cards = [...board.columns.flatMap((c) => c.cards), ...board.forecast.cards.map((c) => ({ ...c, column: 'FORECAST' }))];
    const label = (key: string) => (key === 'FORECAST' ? board.forecast.label : (columnByKey(key)?.label ?? key));
    const rows = cards.map((c) => [
      label(c.column),
      c.kind,
      c.number,
      c.title,
      c.customer?.name ?? '',
      c.owner.name,
      c.value.toFixed(2),
      c.probability,
      c.weighted.toFixed(2),
      c.ageDays,
      c.expectedClosing ?? '',
      c.overdue ? 'yes' : 'no',
      c.nextStep ? `${c.nextStep.label}${c.nextStep.at ? ` · ${c.nextStep.at.slice(0, 10)}` : ''}` : '',
      c.revision ? `R${c.revision.n} ${c.revision.status}` : '',
      c.job?.number ?? '',
    ]);

    await audit(
      {
        entityType: 'pipeline',
        entityId: 'sales-pipeline-board',
        action: 'EXPORTED',
        summary: `Sales pipeline board exported (${rows.length} rows)`,
      },
      req,
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="sales-pipeline.csv"');
    res.send(
      toCsv(
        [
          'Column',
          'Kind',
          'Number',
          'Title',
          'Customer',
          'Salesperson',
          'Value',
          'Probability %',
          'Weighted',
          'Age days',
          'Expected closing',
          'Overdue',
          'Next step',
          'Revision',
          'Job',
        ],
        rows,
      ),
    );
  }),
);
