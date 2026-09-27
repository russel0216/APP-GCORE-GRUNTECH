import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import {
  handler,
  parseBody,
  listQuery,
  listResult,
  orderBy,
  notFound,
  conflict,
  badRequest,
} from '../http/kit';
import { authenticate, require_, currentUser } from '../auth/middleware';
import { can } from '../permissions/resolve';
import { audit } from '../shared/audit';
import { nextNumber, previewNext } from '../shared/numbering';

export const customerRoutes = Router();
customerRoutes.use(authenticate);

const SORTABLE = ['code', 'name', 'createdAt', 'updatedAt'];

// ── List ─────────────────────────────────────────────────────────────────────

customerRoutes.get(
  '/',
  require_('gops.customers.view_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const where: Prisma.CustomerWhereInput = {};

    if (q.search) {
      where.OR = [
        { name: { contains: q.search, mode: 'insensitive' } },
        { code: { contains: q.search, mode: 'insensitive' } },
        { legalName: { contains: q.search, mode: 'insensitive' } },
        { tin: { contains: q.search, mode: 'insensitive' } },
        // Searching a customer by their contact's name is what people
        // actually do — they remember the person, not the company.
        { contacts: { some: { name: { contains: q.search, mode: 'insensitive' } } } },
      ];
    }
    if (q.filters.isActive) where.isActive = q.filters.isActive === 'true';
    // Industry is a reference row; the filter takes its code, or 'none' for the
    // customers nobody has classified yet — the list filter is how those get found.
    if (q.filters.industry) {
      if (q.filters.industry === 'none') where.industryId = null;
      else where.industry = { code: String(q.filters.industry).toUpperCase() };
    }
    if (q.scope === 'mine') where.createdById = me.id;

    const [rows, total] = await Promise.all([
      prisma.customer.findMany({
        where,
        include: {
          createdBy: { select: { id: true, name: true } },
          industry: { select: { id: true, code: true, name: true } },
          _count: { select: { contacts: true, sites: true } },
        },
        orderBy: orderBy(q, SORTABLE, { name: 'asc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.customer.count({ where }),
    ]);

    res.json(
      listResult(
        rows.map((r) => ({
          ...r,
          creditLimit: r.creditLimit ? Number(r.creditLimit) : null,
          contactCount: r._count.contacts,
          siteCount: r._count.sites,
        })),
        total,
        q,
      ),
    );
  }),
);

/** Lightweight lookup for pickers in other modules. */
customerRoutes.get(
  '/lookup',
  require_('gops.customers.view_all'),
  handler(async (req, res) => {
    const term = String(req.query.q ?? '').trim();
    res.json(
      await prisma.customer.findMany({
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
        select: { id: true, code: true, name: true, industry: { select: { code: true } } },
        orderBy: { name: 'asc' },
        take: 25,
      }),
    );
  }),
);

/**
 * The next code, so the form can show it before anything is saved. The same
 * template and counter lookup nextNumber() uses, without the reservation —
 * a hand-rolled year key here once disagreed with a monthly template.
 */
customerRoutes.get(
  '/next-code',
  require_('gops.customers.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const preview = await previewNext('customer', { ownerId: me.id });
    res.json({ code: preview.number });
  }),
);

// ── Customer 360 ─────────────────────────────────────────────────────────────

/**
 * Everything about one customer in one payload (model §3).
 *
 * Every collection is behind the permission that guards the screen it comes
 * from, and arrives as an empty array when the caller cannot see it. That is
 * the point of the view — a customer's whole history in one place, not five
 * menus to visit — without becoming a way around those menus' permissions.
 */
customerRoutes.get(
  '/:id',
  require_('gops.customers.view_all'),
  handler(async (req, res) => {
    const customer = await prisma.customer.findUnique({
      where: { id: req.params.id },
      include: {
        createdBy: { select: { id: true, name: true } },
        industry: { select: { id: true, code: true, name: true } },
        contacts: { orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }] },
        sites: {
          orderBy: { name: 'asc' },
          include: { contact: { select: { id: true, name: true } } },
        },
      },
    });
    if (!customer) throw notFound('Customer not found');

    /*
      The commercial history, each collection behind the permission that guards
      the screen it comes from. Somebody who may see customers but not invoices
      sees the customer without them — the 360 view is a window onto those
      modules, never a way around their permissions.
    */
    const me = currentUser(req);
    const customerId = customer.id;

    // Leads ARE the opportunities (Phase 3 note: no Opportunity entity). A
    // salesperson with only view_own sees the ones assigned to them.
    const leadWhere: Prisma.LeadWhereInput | null = can(me, 'gops.leads.view_all')
      ? { customerId }
      : can(me, 'gops.leads.view_own')
        ? { customerId, assignedToId: me.id }
        : null;
    const anyReportView =
      can(me, 'gops.pm_reports.view_all') ||
      can(me, 'gops.commissioning_reports.view_all') ||
      can(me, 'gops.inspection_reports.view_all');

    const [
      quotations,
      projects,
      invoices,
      serviceContracts,
      leads,
      installedAssets,
      serviceReports,
      payments,
      jobOrders,
      legacyQuotes,
    ] = await Promise.all([
      can(me, 'gops.quotations.view_all')
        ? prisma.quotation.findMany({
            where: { customerId },
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              number: true,
              subject: true,
              outcome: true,
              createdAt: true,
              revisions: {
                orderBy: { revision: 'desc' },
                select: { revision: true, status: true, total: true },
              },
            },
          })
        : [],
      can(me, 'gops.projects.view_all')
        ? prisma.job.findMany({
            where: { customerId },
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              number: true,
              name: true,
              status: true,
              contractValue: true,
              type: true,
            },
          })
        : [],
      can(me, 'gfin.ar.view_all')
        ? prisma.invoice.findMany({
            where: { customerId },
            orderBy: { invoiceDate: 'desc' },
            select: {
              id: true,
              number: true,
              status: true,
              invoiceDate: true,
              dueDate: true,
              invoiceTotal: true,
              netCollectible: true,
              amountCollected: true,
            },
          })
        : [],
      can(me, 'gops.service_contracts.view_all')
        ? prisma.serviceContract.findMany({
            where: { job: { customerId } },
            orderBy: { endsAt: 'desc' },
            select: {
              id: true,
              number: true,
              status: true,
              startsAt: true,
              endsAt: true,
              frequencyMonths: true,
              job: { select: { id: true, number: true, name: true } },
            },
          })
        : [],
      leadWhere
        ? prisma.lead.findMany({
            where: leadWhere,
            orderBy: { createdAt: 'desc' },
            take: 50,
            select: {
              id: true,
              number: true,
              status: true,
              description: true,
              estimatedValue: true,
              expectedClosing: true,
              nextActionDate: true,
              createdAt: true,
              assignedTo: { select: { id: true, name: true } },
            },
          })
        : [],
      can(me, 'gops.installed_base.view_all')
        ? prisma.installedAsset.findMany({
            where: { customerId },
            orderBy: [{ status: 'asc' }, { name: 'asc' }],
            take: 50,
            select: {
              id: true,
              code: true,
              name: true,
              status: true,
              manufacturer: true,
              model: true,
              serialNo: true,
              warrantyEndsAt: true,
              site: { select: { id: true, name: true } },
            },
          })
        : [],
      anyReportView
        ? prisma.serviceReport.findMany({
            where: { customerId },
            orderBy: { performedAt: 'desc' },
            take: 50,
            select: {
              id: true,
              number: true,
              kind: true,
              status: true,
              performedAt: true,
              billable: true,
              underWarranty: true,
              asset: { select: { id: true, name: true } },
              performedBy: { select: { id: true, name: true } },
            },
          })
        : [],
      can(me, 'gfin.payments.view_all') || can(me, 'gfin.ar.view_all')
        ? prisma.payment.findMany({
            where: { customerId },
            orderBy: { paymentDate: 'desc' },
            take: 50,
            select: {
              id: true,
              number: true,
              kind: true,
              method: true,
              paymentDate: true,
              amount: true,
              reference: true,
              clearedAt: true,
            },
          })
        : [],
      can(me, 'gops.job_orders.view_all')
        ? prisma.jobOrder.findMany({
            where: { customerId },
            orderBy: { requestedFor: 'desc' },
            take: 50,
            select: {
              id: true,
              number: true,
              status: true,
              kind: true,
              title: true,
              urgent: true,
              chargeBasis: true,
              requestedFor: true,
              amount: true,
              assignedTo: { select: { id: true, name: true } },
            },
          })
        : [],
      // The SCORO history — read-only, behind the archive's own key.
      can(me, 'gops.quote_archive.view_all')
        ? prisma.legacyQuote.findMany({
            where: { customerId },
            orderBy: [{ date: 'desc' }, { number: 'desc' }],
            take: 50,
            select: {
              id: true,
              number: true,
              date: true,
              name: true,
              status: true,
              currency: true,
              total: true,
              continuedQuotation: { select: { id: true, number: true } },
            },
          })
        : [],
    ]);

    res.json({
      ...customer,
      creditLimit: customer.creditLimit ? Number(customer.creditLimit) : null,
      quotations: quotations.map((q) => {
        // What the quotation is worth: its latest approved revision, else its
        // latest — the same rule Insights uses, so the two cannot disagree.
        const best = q.revisions.find((r) => r.status === 'APPROVED') ?? q.revisions[0];
        return {
          id: q.id,
          number: q.number,
          subject: q.subject,
          outcome: q.outcome,
          createdAt: q.createdAt,
          revisionNo: best?.revision ?? null,
          revisionStatus: best?.status ?? null,
          total: best ? Number(best.total) : null,
        };
      }),
      projects: projects.map((j) => ({ ...j, contractValue: Number(j.contractValue) })),
      invoices: invoices.map((i) => ({
        ...i,
        invoiceTotal: Number(i.invoiceTotal),
        netCollectible: Number(i.netCollectible),
        amountCollected: Number(i.amountCollected),
        outstanding: Number(i.netCollectible) - Number(i.amountCollected),
      })),
      serviceContracts,
      leads: leads.map((l) => ({
        ...l,
        estimatedValue: l.estimatedValue == null ? null : Number(l.estimatedValue),
      })),
      installedAssets,
      serviceReports,
      payments: payments.map((p) => ({ ...p, amount: Number(p.amount) })),
      jobOrders: jobOrders.map((j) => ({ ...j, amount: j.amount == null ? null : Number(j.amount) })),
      legacyQuotes: legacyQuotes.map((l) => ({ ...l, total: Number(l.total) })),
    });
  }),
);

/** The industry a customer is filed under must exist and be in use. */
async function activeIndustry(tx: Prisma.TransactionClient, industryId: string) {
  const industry = await tx.industry.findUnique({ where: { id: industryId } });
  if (!industry || !industry.isActive) throw badRequest('Choose an active industry');
  return industry;
}

// ── Create / update / delete ─────────────────────────────────────────────────

const customerSchema = z.object({
  code: z.string().trim().optional(),
  name: z.string().trim().min(2, 'Company name is required'),
  legalName: z.string().trim().optional().nullable(),
  tin: z.string().trim().optional().nullable(),
  // Required on create; `.partial()` makes it optional on PATCH, and it is
  // deliberately not nullable, so a customer can never be unclassified again.
  industryId: z.string().min(1, 'Choose an industry'),
  paymentTerms: z.string().trim().optional().nullable(),
  creditLimit: z.number().nonnegative().optional().nullable(),
  phone: z.string().trim().optional().nullable(),
  email: z.string().trim().email('Enter a valid email').optional().nullable().or(z.literal('')),
  website: z.string().trim().optional().nullable(),
  notes: z.string().optional().nullable(),
  isActive: z.boolean().default(true),
});

customerRoutes.post(
  '/',
  require_('gops.customers.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(customerSchema, req.body);

    const { customer, industry } = await prisma.$transaction(async (tx) => {
      const industry = await activeIndustry(tx, body.industryId);
      // Only consume a number when none was supplied — an operator pasting
      // their own code should not silently burn a sequence value.
      const code = body.code || (await nextNumber('customer', tx, { ownerId: me.id }));
      if (await tx.customer.findUnique({ where: { code } })) {
        throw conflict(`Customer code "${code}" is already in use`);
      }
      const customer = await tx.customer.create({
        data: {
          code,
          name: body.name,
          legalName: body.legalName || null,
          tin: body.tin || null,
          industryId: industry.id,
          paymentTerms: body.paymentTerms || null,
          creditLimit: body.creditLimit != null ? new Prisma.Decimal(body.creditLimit) : null,
          phone: body.phone || null,
          email: body.email || null,
          website: body.website || null,
          notes: body.notes || null,
          isActive: body.isActive,
          createdById: me.id,
        },
      });
      return { customer, industry };
    });

    await audit(
      {
        entityType: 'customer',
        entityId: customer.id,
        action: 'CREATED',
        summary: `Created customer ${customer.code} — ${customer.name} (${industry.code})`,
      },
      req,
    );
    res.status(201).json(customer);
  }),
);

customerRoutes.patch(
  '/:id',
  require_('gops.customers.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(customerSchema.partial(), req.body);
    const before = await prisma.customer.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound('Customer not found');

    if (body.code && body.code !== before.code) {
      const clash = await prisma.customer.findUnique({ where: { code: body.code } });
      if (clash) throw conflict(`Customer code "${body.code}" is already in use`);
    }
    // Reclassifying never regenerates the code — identifiers do not move under
    // the quotations and invoices that carry them. The audit row records it.
    if (body.industryId !== undefined) await activeIndustry(prisma, body.industryId);

    const customer = await prisma.customer.update({
      where: { id: req.params.id },
      data: {
        ...(body.code !== undefined ? { code: body.code } : {}),
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.legalName !== undefined ? { legalName: body.legalName || null } : {}),
        ...(body.tin !== undefined ? { tin: body.tin || null } : {}),
        ...(body.industryId !== undefined ? { industryId: body.industryId } : {}),
        ...(body.paymentTerms !== undefined ? { paymentTerms: body.paymentTerms || null } : {}),
        ...(body.creditLimit !== undefined
          ? { creditLimit: body.creditLimit != null ? new Prisma.Decimal(body.creditLimit) : null }
          : {}),
        ...(body.phone !== undefined ? { phone: body.phone || null } : {}),
        ...(body.email !== undefined ? { email: body.email || null } : {}),
        ...(body.website !== undefined ? { website: body.website || null } : {}),
        ...(body.notes !== undefined ? { notes: body.notes || null } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      },
    });

    await audit(
      {
        entityType: 'customer',
        entityId: customer.id,
        action: 'UPDATED',
        summary: `Updated customer ${customer.code} — ${customer.name}`,
        before,
        after: customer,
      },
      req,
    );
    res.json(customer);
  }),
);

customerRoutes.delete(
  '/:id',
  require_('gops.customers.delete'),
  handler(async (req, res) => {
    const customer = await prisma.customer.findUnique({ where: { id: req.params.id } });
    if (!customer) throw notFound('Customer not found');

    // Nothing references a customer yet. From Phase 3 a customer with
    // quotations, projects or invoices must be deactivated, never deleted —
    // commercial history cannot be allowed to lose its counterparty.
    await prisma.customer.delete({ where: { id: req.params.id } });
    await audit(
      {
        entityType: 'customer',
        entityId: req.params.id,
        action: 'DELETED',
        summary: `Deleted customer ${customer.code} — ${customer.name}`,
        before: customer,
      },
      req,
    );
    res.json({ ok: true });
  }),
);

// ── Contacts ─────────────────────────────────────────────────────────────────

const contactSchema = z.object({
  name: z.string().trim().min(2, 'Contact name is required'),
  position: z.string().trim().optional().nullable(),
  email: z.string().trim().email('Enter a valid email').optional().nullable().or(z.literal('')),
  phone: z.string().trim().optional().nullable(),
  mobile: z.string().trim().optional().nullable(),
  isPrimary: z.boolean().default(false),
  notes: z.string().optional().nullable(),
});

customerRoutes.post(
  '/:id/contacts',
  require_('gops.customers.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(contactSchema, req.body);
    const customer = await prisma.customer.findUnique({ where: { id: req.params.id } });
    if (!customer) throw notFound('Customer not found');

    const contact = await prisma.$transaction(async (tx) => {
      if (body.isPrimary) {
        await tx.customerContact.updateMany({
          where: { customerId: req.params.id },
          data: { isPrimary: false },
        });
      }
      return tx.customerContact.create({
        data: {
          customerId: req.params.id,
          name: body.name,
          position: body.position || null,
          email: body.email || null,
          phone: body.phone || null,
          mobile: body.mobile || null,
          isPrimary: body.isPrimary,
          notes: body.notes || null,
        },
      });
    });

    await audit(
      {
        entityType: 'customer',
        entityId: req.params.id,
        action: 'UPDATED',
        summary: `Added contact ${contact.name}`,
      },
      req,
    );
    res.status(201).json(contact);
  }),
);

customerRoutes.patch(
  '/:id/contacts/:contactId',
  require_('gops.customers.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(contactSchema.partial(), req.body);

    const contact = await prisma.$transaction(async (tx) => {
      const existing = await tx.customerContact.findFirst({
        where: { id: req.params.contactId, customerId: req.params.id },
      });
      if (!existing) throw notFound('Contact not found');

      if (body.isPrimary) {
        await tx.customerContact.updateMany({
          where: { customerId: req.params.id },
          data: { isPrimary: false },
        });
      }
      return tx.customerContact.update({
        where: { id: req.params.contactId },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.position !== undefined ? { position: body.position || null } : {}),
          ...(body.email !== undefined ? { email: body.email || null } : {}),
          ...(body.phone !== undefined ? { phone: body.phone || null } : {}),
          ...(body.mobile !== undefined ? { mobile: body.mobile || null } : {}),
          ...(body.isPrimary !== undefined ? { isPrimary: body.isPrimary } : {}),
          ...(body.notes !== undefined ? { notes: body.notes || null } : {}),
        },
      });
    });

    await audit(
      {
        entityType: 'customer',
        entityId: req.params.id,
        action: 'UPDATED',
        summary: `Updated contact ${contact.name}`,
      },
      req,
    );
    res.json(contact);
  }),
);

customerRoutes.delete(
  '/:id/contacts/:contactId',
  require_('gops.customers.edit_all'),
  handler(async (req, res) => {
    const contact = await prisma.customerContact.findFirst({
      where: { id: req.params.contactId, customerId: req.params.id },
    });
    if (!contact) throw notFound('Contact not found');

    await prisma.customerContact.delete({ where: { id: req.params.contactId } });
    await audit(
      {
        entityType: 'customer',
        entityId: req.params.id,
        action: 'UPDATED',
        summary: `Removed contact ${contact.name}`,
      },
      req,
    );
    res.json({ ok: true });
  }),
);

// ── Sites ────────────────────────────────────────────────────────────────────

const siteSchema = z.object({
  name: z.string().trim().min(2, 'Site name is required'),
  address: z.string().trim().optional().nullable(),
  city: z.string().trim().optional().nullable(),
  region: z.string().trim().optional().nullable(),
  contactId: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  isActive: z.boolean().default(true),
});

customerRoutes.post(
  '/:id/sites',
  require_('gops.customers.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(siteSchema, req.body);
    const customer = await prisma.customer.findUnique({ where: { id: req.params.id } });
    if (!customer) throw notFound('Customer not found');

    if (body.contactId) {
      const belongs = await prisma.customerContact.findFirst({
        where: { id: body.contactId, customerId: req.params.id },
      });
      if (!belongs) throw badRequest('That contact belongs to a different customer');
    }

    const site = await prisma.customerSite.create({
      data: {
        customerId: req.params.id,
        name: body.name,
        address: body.address || null,
        city: body.city || null,
        region: body.region || null,
        contactId: body.contactId || null,
        notes: body.notes || null,
        isActive: body.isActive,
      },
    });

    await audit(
      {
        entityType: 'customer',
        entityId: req.params.id,
        action: 'UPDATED',
        summary: `Added site ${site.name}`,
      },
      req,
    );
    res.status(201).json(site);
  }),
);

customerRoutes.patch(
  '/:id/sites/:siteId',
  require_('gops.customers.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(siteSchema.partial(), req.body);
    const existing = await prisma.customerSite.findFirst({
      where: { id: req.params.siteId, customerId: req.params.id },
    });
    if (!existing) throw notFound('Site not found');

    if (body.contactId) {
      const belongs = await prisma.customerContact.findFirst({
        where: { id: body.contactId, customerId: req.params.id },
      });
      if (!belongs) throw badRequest('That contact belongs to a different customer');
    }

    const site = await prisma.customerSite.update({
      where: { id: req.params.siteId },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.address !== undefined ? { address: body.address || null } : {}),
        ...(body.city !== undefined ? { city: body.city || null } : {}),
        ...(body.region !== undefined ? { region: body.region || null } : {}),
        ...(body.contactId !== undefined ? { contactId: body.contactId || null } : {}),
        ...(body.notes !== undefined ? { notes: body.notes || null } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      },
    });

    await audit(
      { entityType: 'customer', entityId: req.params.id, action: 'UPDATED', summary: `Updated site ${site.name}` },
      req,
    );
    res.json(site);
  }),
);

customerRoutes.delete(
  '/:id/sites/:siteId',
  require_('gops.customers.edit_all'),
  handler(async (req, res) => {
    const site = await prisma.customerSite.findFirst({
      where: { id: req.params.siteId, customerId: req.params.id },
    });
    if (!site) throw notFound('Site not found');

    await prisma.customerSite.delete({ where: { id: req.params.siteId } });
    await audit(
      { entityType: 'customer', entityId: req.params.id, action: 'UPDATED', summary: `Removed site ${site.name}` },
      req,
    );
    res.json({ ok: true });
  }),
);
