import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { handler, parseBody, listQuery, listResult, orderBy, notFound, badRequest, idsFilter } from '../http/kit';
import { formatShortDate, renderDocument } from '../shared/pdf';
import { LIST_CAP, listReference, rangeNamed, sendListPdf } from './finance';
import { authenticate, require_, currentUser } from '../auth/middleware';
import { audit } from '../shared/audit';
import { categoryTabWhere, categoryTabs } from '../shared/supplierCategories';
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
  checkResourceSource,
} from '../shared/partners';

/**
 * G-OPS › Sales › Partners — the principals whose equipment Gruntech sells and
 * services, seen from Sales. Every row here is a Supplier (shared/partners.ts
 * says why); these routes are gated by gops.partners.* so a salesperson who
 * holds no gchain.suppliers key can still open the catalogue.
 */

export const partnerRoutes = Router();
partnerRoutes.use(authenticate);

// ── List (the quotation list's layout, 2026-10-08) ───────────────────────────

const PUBLISHES = ['CATALOGUE', 'PRICE_LIST', 'SIZING_APP', 'LINK'] as const;
const PARTNER_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** An item with a list price on it, still sold — what "priced items" counts. */
const PRICED_ITEM: Prisma.ItemWhereInput = { isActive: true, listPrice: { not: null } };

function partnerDay(value: string | undefined, label: string): string | null {
  if (!value) return null;
  if (!PARTNER_DAY.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw badRequest(`${label} is a date written YYYY-MM-DD`);
  return value;
}

/**
 * Which partners a list query means — ONE rule for the list, its summary
 * (the "What they supply" tabs) and its PDF. `base` is everything but the
 * category tab, which is `categoryTabWhere()` — the supplier list's own rule.
 */
export function partnerListWhere(
  me: ReturnType<typeof currentUser>,
  q: ReturnType<typeof listQuery>,
): { base: Prisma.SupplierWhereInput; where: Prisma.SupplierWhereInput } {
  const and: Prisma.SupplierWhereInput[] = [{ isPartner: true }];
  if (q.search) {
    and.push({
      OR: [
        { name: { contains: q.search, mode: 'insensitive' } },
        { brand: { contains: q.search, mode: 'insensitive' } },
        { code: { contains: q.search, mode: 'insensitive' } },
        { category: { contains: q.search, mode: 'insensitive' } },
        { contacts: { some: { name: { contains: q.search, mode: 'insensitive' } } } },
      ],
    });
  }
  const f = q.filters;
  if (f.isActive) {
    if (f.isActive !== 'true' && f.isActive !== 'false') throw badRequest('Status is true or false');
    and.push({ isActive: f.isActive === 'true' });
  }
  if (q.scope === 'mine') and.push({ createdById: me.id });
  if (f.publishes) {
    if (!(PUBLISHES as readonly string[]).includes(f.publishes)) throw badRequest(`Unknown resource kind: ${f.publishes}`);
    and.push({ resources: { some: { kind: f.publishes as (typeof PUBLISHES)[number], isActive: true } } });
  }
  if (f.priced === 'yes') and.push({ preferredItems: { some: PRICED_ITEM } });
  else if (f.priced === 'no') and.push({ preferredItems: { none: PRICED_ITEM } });
  else if (f.priced) throw badRequest('Priced items is yes or no');
  const from = partnerDay(f.sinceFrom, 'Partner since, from');
  const to = partnerDay(f.sinceTo, 'Partner since, to');
  if (from || to) {
    and.push({
      partnerSince: {
        ...(from ? { gte: new Date(`${from}T00:00:00.000Z`) } : {}),
        ...(to ? { lte: new Date(`${to}T23:59:59.999Z`) } : {}),
      },
    });
  }
  const ids = idsFilter(f.ids);
  if (ids) and.push({ id: { in: ids } });

  const base: Prisma.SupplierWhereInput = { AND: and };
  if (!f.category) return { base, where: base };
  return { base, where: { AND: [...and, categoryTabWhere(f.category)] } };
}

/**
 * The tabs — `categoryTabs()`, the supplier list's own rule — and the count,
 * how many publish a price list and how many priced items there are under
 * `where`.
 */
export async function partnerListSummary(base: Prisma.SupplierWhereInput, where: Prisma.SupplierWhereInput) {
  const [{ tabs, tabCounts }, count, withPriceList, pricedItems] = await Promise.all([
    categoryTabs(base),
    prisma.supplier.count({ where }),
    prisma.supplier.count({ where: { AND: [where, { resources: { some: { kind: 'PRICE_LIST', isActive: true } } }] } }),
    prisma.item.count({ where: { ...PRICED_ITEM, preferredSupplier: where } }),
  ]);
  return { tabs, tabCounts, count, withPriceList, pricedItems };
}

const PARTNER_SORTS = ['code', 'name', 'brand', 'createdAt', 'partnerSince'];

partnerRoutes.get(
  '/',
  require_('gops.partners.view_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const { base, where } = partnerListWhere(me, q);

    const [rows, total, summary] = await Promise.all([
      prisma.supplier.findMany({
        where,
        include: {
          contacts: { select: { id: true } },
          resources: { where: { isActive: true }, select: { kind: true } },
          _count: { select: { preferredItems: { where: PRICED_ITEM } } },
        },
        orderBy: orderBy(q, PARTNER_SORTS, { name: 'asc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.supplier.count({ where }),
      partnerListSummary(base, where),
    ]);

    res.json({
      ...listResult(
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
          links: r.resources.filter((x) => x.kind === 'LINK').length,
          pricedItems: r._count.preferredItems,
          createdAt: r.createdAt,
        })),
        total,
        q,
      ),
      summary,
    });
  }),
);

/**
 * The partner list on paper — the list as filtered (or the rows ticked,
 * `?ids=`), through `partnerListWhere`. Counts only, never a price or a
 * cost. Above `/:id`; audited; capped at 1,000 rows.
 */
partnerRoutes.get(
  '/pdf',
  require_('gops.partners.view_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const { base, where } = partnerListWhere(me, q);
    const [rows, summary] = await Promise.all([
      prisma.supplier.findMany({
        where,
        include: {
          resources: { where: { isActive: true }, select: { kind: true } },
          _count: { select: { preferredItems: { where: PRICED_ITEM } } },
        },
        orderBy: orderBy(q, PARTNER_SORTS, { name: 'asc' }),
        take: LIST_CAP,
      }),
      partnerListSummary(base, where),
    ]);
    const f = q.filters;
    // "12 partners", or "first 1,000 of 1,234 partners printed" when the cap
    // bit — then every filter `partnerListWhere` applied, by name.
    const reference = listReference(summary.count, rows.length, ['partner', 'partners'], [
      q.search ? `search "${q.search}"` : null,
      f.category ? `supplies ${f.category === 'none' ? 'not stated' : f.category}` : null,
      f.isActive === 'true' ? 'active' : f.isActive === 'false' ? 'inactive' : null,
      f.publishes ? `publishes a ${humanKind(f.publishes as (typeof PUBLISHES)[number]).toLowerCase()}` : null,
      f.priced === 'yes' ? 'with priced items' : f.priced === 'no' ? 'no priced items' : null,
      rangeNamed('partner since', f.sinceFrom, f.sinceTo),
      q.scope === 'mine' ? 'added by me' : null,
      f.ids ? 'the rows selected' : null,
    ]);
    const kinds = (r: (typeof rows)[number], k: string) => String(r.resources.filter((x) => x.kind === k).length);

    // Ten columns: landscape, each sized from what it holds (rule 6), so a
    // head is never broken mid-word and a code never split over two lines.
    // The code heads its column as the screen heads it (a partner's code is
    // its identifier, not a document number). Counts only, never a price.
    const pdf = await renderDocument({
      title: 'Partners',
      date: new Date(),
      reference,
      landscape: true,
      sections: [
        {
          kind: 'table',
          head: ['Code', 'Brand and name', 'Supplies', 'Catalogues', 'Price lists', 'Software', 'Links', 'Priced items', 'Since', 'Status'],
          align: ['left', 'left', 'left', 'right', 'right', 'right', 'right', 'right', 'left', 'left'],
          rows: rows.map((r) => [
            r.code,
            { title: r.brand ?? r.name, body: r.brand && r.brand !== r.name ? r.name : undefined },
            r.category ?? '',
            kinds(r, 'CATALOGUE'),
            kinds(r, 'PRICE_LIST'),
            kinds(r, 'SIZING_APP'),
            kinds(r, 'LINK'),
            String(r._count.preferredItems),
            r.partnerSince ? formatShortDate(r.partnerSince) : '',
            r.isActive ? 'Active' : 'Inactive',
          ]),
        },
      ],
    });
    await audit(
      { entityType: 'supplier', entityId: 'list', action: 'EXPORTED', summary: `Exported the partner list as PDF (${rows.length} partner(s))` },
      req,
    );
    sendListPdf(res, pdf, 'partners.pdf');
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
    checkResourceSource(body.kind, url, !!req.file);

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
    checkResourceSource(body.kind ?? before.kind, url, hasFile);

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
