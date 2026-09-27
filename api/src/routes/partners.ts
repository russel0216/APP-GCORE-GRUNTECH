import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { handler, parseBody, listQuery, listResult, orderBy, notFound, badRequest } from '../http/kit';
import { authenticate, require_, currentUser } from '../auth/middleware';
import { audit } from '../shared/audit';
import { upload } from '../shared/attachments';
import {
  PARTNER_RESOURCE_ENTITY,
  makePartner,
  unflagPartner,
  partnerDetail,
  partnerPriceList,
  partnerSchema,
  resourceSchema,
  resourceWithFile,
  replaceResourceFile,
  removeResourceFile,
  safeHttpUrl,
  humanKind,
} from '../shared/partners';

/**
 * G-OPS › Sales › Partners — the principals whose equipment Gruntech sells and
 * services, seen from Sales. Every row here is a Supplier (shared/partners.ts
 * says why); these routes are gated by gops.partners.* so a salesperson who
 * holds no gchain.suppliers key can still open the catalogue.
 */

export const partnerRoutes = Router();
partnerRoutes.use(authenticate);

// ── List ─────────────────────────────────────────────────────────────────────

partnerRoutes.get(
  '/',
  require_('gops.partners.view_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const where: Prisma.SupplierWhereInput = { isPartner: true };

    if (q.search) {
      where.OR = [
        { name: { contains: q.search, mode: 'insensitive' } },
        { brand: { contains: q.search, mode: 'insensitive' } },
        { code: { contains: q.search, mode: 'insensitive' } },
        { category: { contains: q.search, mode: 'insensitive' } },
        { contacts: { some: { name: { contains: q.search, mode: 'insensitive' } } } },
      ];
    }
    if (q.filters.isActive) where.isActive = q.filters.isActive === 'true';
    if (q.scope === 'mine') where.createdById = me.id;

    const [rows, total] = await Promise.all([
      prisma.supplier.findMany({
        where,
        include: {
          contacts: { select: { id: true } },
          resources: { where: { isActive: true }, select: { kind: true } },
          _count: {
            select: { preferredItems: { where: { isActive: true, listPrice: { not: null } } } },
          },
        },
        orderBy: orderBy(q, ['code', 'name', 'brand', 'createdAt'], { name: 'asc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.supplier.count({ where }),
    ]);

    res.json(
      listResult(
        rows.map((r) => ({
          id: r.id,
          code: r.code,
          name: r.name,
          brand: r.brand,
          legalName: r.legalName,
          category: r.category,
          website: r.website,
          city: r.city,
          phone: r.phone,
          email: r.email,
          isActive: r.isActive,
          partnerSince: r.partnerSince,
          contactCount: r.contacts.length,
          catalogues: r.resources.filter((x) => x.kind === 'CATALOGUE').length,
          priceLists: r.resources.filter((x) => x.kind === 'PRICE_LIST').length,
          sizingApps: r.resources.filter((x) => x.kind === 'SIZING_APP').length,
          pricedItems: r._count.preferredItems,
          createdAt: r.createdAt,
        })),
        total,
        q,
      ),
    );
  }),
);

// ── Price list — declared above /:id so the literal segment wins ─────────────

partnerRoutes.get(
  '/:id/price-list',
  require_('gops.partners.view_all'),
  handler(async (req, res) => {
    const partner = await prisma.supplier.findFirst({
      where: { id: req.params.id, isPartner: true },
      select: { id: true },
    });
    if (!partner) throw notFound('Partner not found');
    const q = listQuery(req);
    const { rows, total } = await partnerPriceList(partner.id, q);
    res.json(listResult(rows, total, q));
  }),
);

// ── Detail ───────────────────────────────────────────────────────────────────

partnerRoutes.get(
  '/:id',
  require_('gops.partners.view_all'),
  handler(async (req, res) => {
    const detail = await partnerDetail(req.params.id);
    if (!detail) throw notFound('Partner not found');
    res.json(detail);
  }),
);

// ── Create / modify / remove ─────────────────────────────────────────────────

partnerRoutes.post(
  '/',
  require_('gops.partners.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(partnerSchema, req.body);
    const supplier = await prisma.$transaction((tx) => makePartner(body, me.id, tx));

    await audit(
      {
        entityType: 'supplier',
        entityId: supplier.id,
        action: body.supplierId ? 'UPDATED' : 'CREATED',
        summary: `Added partner ${supplier.code} — ${supplier.brand ?? supplier.name}`,
      },
      req,
    );
    res.status(201).json(await partnerDetail(supplier.id));
  }),
);

// Only the partner-facing fields. Legal name, TIN, address, terms and the
// contacts stay procurement's, through PATCH /suppliers/:id.
const partnerPatchSchema = z.object({
  name: z.string().trim().min(2).optional(),
  brand: z.string().trim().optional().nullable(),
  category: z.string().trim().optional().nullable(),
  website: z.string().trim().optional().nullable(),
  partnerSince: z.coerce.date().optional().nullable(),
  notes: z.string().optional().nullable(),
});

partnerRoutes.patch(
  '/:id',
  require_('gops.partners.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(partnerPatchSchema, req.body);
    const before = await prisma.supplier.findFirst({ where: { id: req.params.id, isPartner: true } });
    if (!before) throw notFound('Partner not found');

    const supplier = await prisma.supplier.update({
      where: { id: before.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.brand !== undefined ? { brand: body.brand || null } : {}),
        ...(body.category !== undefined ? { category: body.category || null } : {}),
        ...(body.website !== undefined ? { website: body.website || null } : {}),
        ...(body.partnerSince !== undefined ? { partnerSince: body.partnerSince ?? null } : {}),
        ...(body.notes !== undefined ? { notes: body.notes || null } : {}),
      },
    });

    await audit(
      {
        entityType: 'supplier',
        entityId: supplier.id,
        action: 'UPDATED',
        summary: `Updated partner ${supplier.code} — ${supplier.brand ?? supplier.name}`,
        before,
        after: supplier,
      },
      req,
    );
    res.json(await partnerDetail(supplier.id));
  }),
);

partnerRoutes.delete(
  '/:id',
  require_('gops.partners.delete'),
  handler(async (req, res) => {
    const before = await prisma.supplier.findFirst({ where: { id: req.params.id, isPartner: true } });
    if (!before) throw notFound('Partner not found');
    await unflagPartner(before.id);
    await audit(
      {
        entityType: 'supplier',
        entityId: before.id,
        action: 'UPDATED',
        summary: `Removed ${before.code} — ${before.brand ?? before.name} from partners — supplier record kept`,
      },
      req,
    );
    res.json({ ok: true });
  }),
);

// ── Resources ────────────────────────────────────────────────────────────────

async function partnerOr404(id: string) {
  const partner = await prisma.supplier.findFirst({
    where: { id, isPartner: true },
    select: { id: true, name: true, brand: true },
  });
  if (!partner) throw notFound('Partner not found');
  return partner;
}

partnerRoutes.post(
  '/:id/resources',
  require_('gops.partners.edit_all'),
  upload.single('file'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const partner = await partnerOr404(req.params.id);
    const body = parseBody(resourceSchema, req.body ?? {});

    const url = body.url ? safeHttpUrl(body.url) : null;
    if (!url && !req.file) throw badRequest('Attach a file or give a link');

    const resource = await prisma.partnerResource.create({
      data: {
        supplierId: partner.id,
        kind: body.kind,
        title: body.title,
        description: body.description ?? null,
        url,
        validFrom: body.validFrom ?? null,
        validUntil: body.validUntil ?? null,
        sortOrder: body.sortOrder ?? 0,
        isActive: body.isActive ?? true,
        createdById: me.id,
      },
    });
    if (req.file) await replaceResourceFile(resource.id, req.file, me.id);

    await audit(
      {
        entityType: PARTNER_RESOURCE_ENTITY,
        entityId: resource.id,
        action: 'CREATED',
        summary: `Added ${humanKind(resource.kind).toLowerCase()} "${resource.title}" to ${partner.brand ?? partner.name}`,
      },
      req,
    );
    res.status(201).json(await resourceWithFile(resource.id));
  }),
);

partnerRoutes.patch(
  '/:id/resources/:resourceId',
  require_('gops.partners.edit_all'),
  upload.single('file'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const partner = await partnerOr404(req.params.id);
    const before = await prisma.partnerResource.findFirst({
      where: { id: req.params.resourceId, supplierId: partner.id },
    });
    if (!before) throw notFound('Resource not found');

    const body = parseBody(resourceSchema.partial(), req.body ?? {});
    const removeFile = ['true', '1', 'yes', 'on'].includes(String(req.body?.removeFile ?? '').toLowerCase());

    const url = body.url === undefined ? before.url : body.url ? safeHttpUrl(body.url) : null;
    const hasFile = !!req.file || (!removeFile && (await resourceWithFile(before.id))?.attachment != null);
    if (!url && !hasFile) throw badRequest('Attach a file or give a link');

    const resource = await prisma.partnerResource.update({
      where: { id: before.id },
      data: {
        ...(body.kind !== undefined ? { kind: body.kind } : {}),
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.description !== undefined ? { description: body.description ?? null } : {}),
        ...(body.url !== undefined ? { url } : {}),
        ...(body.validFrom !== undefined ? { validFrom: body.validFrom ?? null } : {}),
        ...(body.validUntil !== undefined ? { validUntil: body.validUntil ?? null } : {}),
        ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder ?? 0 } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive ?? true } : {}),
      },
    });
    if (req.file) await replaceResourceFile(resource.id, req.file, me.id);
    else if (removeFile) await removeResourceFile(resource.id);

    await audit(
      {
        entityType: PARTNER_RESOURCE_ENTITY,
        entityId: resource.id,
        action: 'UPDATED',
        summary: `Updated ${humanKind(resource.kind).toLowerCase()} "${resource.title}" of ${partner.brand ?? partner.name}`,
        before,
        after: resource,
      },
      req,
    );
    res.json(await resourceWithFile(resource.id));
  }),
);

partnerRoutes.delete(
  '/:id/resources/:resourceId',
  require_('gops.partners.delete'),
  handler(async (req, res) => {
    const partner = await partnerOr404(req.params.id);
    const resource = await prisma.partnerResource.findFirst({
      where: { id: req.params.resourceId, supplierId: partner.id },
    });
    if (!resource) throw notFound('Resource not found');

    await removeResourceFile(resource.id);
    await prisma.partnerResource.delete({ where: { id: resource.id } });
    await audit(
      {
        entityType: PARTNER_RESOURCE_ENTITY,
        entityId: resource.id,
        action: 'DELETED',
        summary: `Removed ${humanKind(resource.kind).toLowerCase()} "${resource.title}" from ${partner.brand ?? partner.name}`,
        before: resource,
      },
      req,
    );
    res.json({ ok: true });
  }),
);
