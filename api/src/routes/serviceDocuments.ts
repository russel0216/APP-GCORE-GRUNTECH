import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { handler, parseBody, listQuery, listResult, orderBy, notFound, badRequest, idsFilter, deleteOrRefuse } from '../http/kit';
import { deleteAttachmentsOf, registerAttachmentGuard } from '../shared/attachments';
import { authenticate, currentUser } from '../auth/middleware';
import { can, canEditRecord, type ResolvedUser } from '../permissions/resolve';
import { audit } from '../shared/audit';
import { renderDocument, formatShortDate } from '../shared/pdf';
import { registerSearch } from '../shared/search';
import { dayKey } from '../shared/aftermarket';
import { LIST_CAP, listReference, namedInFilter, sendListPdf, filterDay, dayOf, rangeNamed } from '../shared/listPaper';
import { requireView, requireEdit, ownOnly, assertCanView, assertCanEdit } from '../shared/ownScope';

/**
 * Service Documents — the technical documents of the Aftermarket side
 * (2026-10-20, the owner's revised Aftermarket UI: "Technical documents", the
 * fifth card and strip entry). A manual, an electrical drawing, a test report,
 * a datasheet, a certificate — each under a category from Admin › Categories
 * and filed against a MACHINE on the Installation Base or against a MODEL
 * (an item), either; a machine's page reads the documents on it AND on its
 * model. The file is an attachment on `service_document` (the CAD ceiling,
 * since a drawing is often a DWG). No approval, no money, no number: a
 * document is a record, not a document that routes.
 *
 * `gops.service_documents` (SHARED_KEPT): "own" is the documents one filed.
 */

export const serviceDocumentRoutes = Router();
serviceDocumentRoutes.use(authenticate);

const DOC = 'service_document';
const PATH = '/g-ops/service-documents';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const include = {
  category: { select: { id: true, name: true, isActive: true } },
  asset: { select: { id: true, code: true, name: true, model: true, serialNo: true, customer: { select: { id: true, name: true } } } },
  item: { select: { id: true, code: true, name: true, partNumber: true, brand: true } },
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.ServiceDocumentInclude;

type Row = Prisma.ServiceDocumentGetPayload<{ include: typeof include }>;

/** What a row is filed against, in words: the machine, else the model. */
const againstOf = (r: Row) =>
  r.asset ? `${r.asset.name}${r.asset.serialNo ? ` (${r.asset.serialNo})` : ''} — ${r.asset.customer.name}` : r.item ? `${r.item.name}${r.item.partNumber ? ` (${r.item.partNumber})` : ''}` : 'nothing yet';

async function filesOf(ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const counts = await prisma.attachment.groupBy({ by: ['entityId'], where: { entityType: DOC, entityId: { in: ids } }, _count: { _all: true } });
  return new Map(counts.map((c) => [c.entityId, c._count._all]));
}

function present(r: Row, files: number) {
  return { ...r, against: againstOf(r), files };
}

async function load(id: string): Promise<Row> {
  const row = await prisma.serviceDocument.findUnique({ where: { id }, include });
  if (!row) throw notFound('Service document not found');
  return row;
}

/** Which documents a list query means — the viewer's scope, the filters, the search; one rule for the rows, the cards and the paper. */
function listWhere(me: ResolvedUser, q: ReturnType<typeof listQuery>): { base: Prisma.ServiceDocumentWhereInput; where: Prisma.ServiceDocumentWhereInput } {
  const and: Prisma.ServiceDocumentWhereInput[] = [];
  const ids = idsFilter(q.filters.ids);
  if (ids) and.push({ id: { in: ids } });
  if (q.search) {
    and.push({
      OR: [
        { title: { contains: q.search, mode: 'insensitive' } },
        { description: { contains: q.search, mode: 'insensitive' } },
        { asset: { OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { serialNo: { contains: q.search, mode: 'insensitive' } }, { customer: { name: { contains: q.search, mode: 'insensitive' } } }] } },
        { item: { OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { partNumber: { contains: q.search, mode: 'insensitive' } }, { brand: { contains: q.search, mode: 'insensitive' } }] } },
      ],
    });
  }
  // Mine on the list is one's own (the lists' rule); View Own / Team narrow through the one rule.
  if (q.scope === 'mine') and.push({ createdById: me.id });
  const base = ownOnly<Prisma.ServiceDocumentWhereInput>(me, 'gops', 'service_documents', and.length ? { AND: and } : {}, (owners) => ({ createdById: { in: owners } }));
  const where: Prisma.ServiceDocumentWhereInput = { ...base };
  if (q.filters.categoryId) where.categoryId = q.filters.categoryId;
  if (q.filters.assetId) where.assetId = q.filters.assetId;
  if (q.filters.itemId) where.itemId = q.filters.itemId;
  if (q.filters.customerId) where.asset = { is: { customerId: q.filters.customerId } };
  if (q.filters.against === 'machine') where.assetId = { not: null };
  else if (q.filters.against === 'model') where.itemId = { not: null };
  else if (q.filters.against === 'none') where.AND = [...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []), { assetId: null, itemId: null }];
  else if (q.filters.against) throw badRequest('Filed against: machine, model or none');
  if (q.filters.active === 'false') where.isActive = false;
  else if (q.filters.active !== 'all') where.isActive = true;
  const from = filterDay(q.filters.from, 'Dated from');
  const to = filterDay(q.filters.to, 'Dated to');
  if (from || to) where.documentDate = { ...(from ? { gte: dayOf(from) } : {}), ...(to ? { lte: dayOf(to) } : {}) };
  return { base, where };
}

const SORTS = ['title', 'documentDate', 'createdAt', 'updatedAt'];

serviceDocumentRoutes.get(
  '/',
  requireView('gops', 'service_documents'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const { base, where } = listWhere(me, q);
    const [rows, total, all, machines, models, byCategory] = await Promise.all([
      prisma.serviceDocument.findMany({ where, include, orderBy: orderBy(q, SORTS, { updatedAt: 'desc' }), skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      prisma.serviceDocument.count({ where }),
      prisma.serviceDocument.count({ where: { ...base, isActive: true } }),
      prisma.serviceDocument.findMany({ where: { ...base, isActive: true, assetId: { not: null } }, distinct: ['assetId'], select: { assetId: true } }),
      prisma.serviceDocument.findMany({ where: { ...base, isActive: true, itemId: { not: null } }, distinct: ['itemId'], select: { itemId: true } }),
      prisma.serviceDocument.groupBy({ by: ['categoryId'], where: { ...base, isActive: true }, _count: { _all: true } }),
    ]);
    const categories = await prisma.serviceDocumentCategory.findMany({ where: { OR: [{ isActive: true }, { id: { in: byCategory.map((c) => c.categoryId) } }] }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { id: true, name: true } });
    const files = await filesOf(rows.map((r) => r.id));
    res.json({
      ...listResult(rows.map((r) => present(r, files.get(r.id) ?? 0)), total, q),
      summary: {
        documents: all,
        machines: machines.length,
        models: models.length,
        categories: categories.map((c) => ({ id: c.id, name: c.name, count: byCategory.find((b) => b.categoryId === c.id)?._count._all ?? 0 })),
      },
    });
  }),
);

/** The register on paper (A5): the list's own query, or the rows ticked. Declared above /:id. */
serviceDocumentRoutes.get(
  '/pdf',
  requireView('gops', 'service_documents'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const { where } = listWhere(me, q);
    const f = q.filters;
    const [rows, count, category, named, asset, item] = await Promise.all([
      prisma.serviceDocument.findMany({ where, include, orderBy: orderBy(q, SORTS, { updatedAt: 'desc' }), take: LIST_CAP }),
      prisma.serviceDocument.count({ where }),
      f.categoryId ? prisma.serviceDocumentCategory.findUnique({ where: { id: f.categoryId }, select: { name: true } }) : null,
      namedInFilter({ customerId: f.customerId }),
      f.assetId ? prisma.installedAsset.findUnique({ where: { id: f.assetId }, select: { name: true, serialNo: true } }) : null,
      f.itemId ? prisma.item.findUnique({ where: { id: f.itemId }, select: { name: true } }) : null,
    ]);
    const files = await filesOf(rows.map((r) => r.id));
    const reference = listReference(count, rows.length, ['service document', 'service documents'], [
      q.search ? `search "${q.search}"` : null,
      f.categoryId ? `category ${category?.name ?? 'not found'}` : null,
      f.against ? `filed against a ${f.against}` : null,
      named.customer ? `customer ${named.customer}` : null,
      asset ? `machine ${asset.name}${asset.serialNo ? ` (${asset.serialNo})` : ''}` : f.assetId ? 'machine not found' : null,
      item ? `model ${item.name}` : f.itemId ? 'model not found' : null,
      f.active === 'false' ? 'withdrawn' : f.active === 'all' ? 'withdrawn included' : null,
      rangeNamed('dated', f.from, f.to),
      q.scope === 'mine' ? 'filed by me' : null,
      f.ids ? 'the rows selected' : null,
    ]);
    const pdf = await renderDocument({
      title: 'Service Documents',
      date: new Date(),
      reference,
      sections: [
        {
          kind: 'table',
          head: ['Title', 'Category', 'Filed against', 'Version', 'Dated', 'Files', 'Filed by', 'Status'],
          align: ['left', 'left', 'left', 'left', 'left', 'right', 'left', 'left'],
          rows: rows.map((r) => [
            { title: r.title, body: r.description ?? '' },
            r.category.name,
            againstOf(r),
            r.version ?? '—',
            r.documentDate ? formatShortDate(r.documentDate) : '—',
            String(files.get(r.id) ?? 0),
            r.createdBy.name,
            r.isActive ? 'Current' : 'Withdrawn',
          ]),
        },
      ],
    });
    await audit({ entityType: DOC, entityId: 'list', action: 'EXPORTED', summary: `Exported the service documents list as PDF (${listReference(count, rows.length, ['service document', 'service documents'], [])})` }, req);
    sendListPdf(res, pdf, 'service-documents.pdf');
  }),
);

// ── Create and edit ─────────────────────────────────────────────────────────

const schema = z.object({
  title: z.string().trim().min(2, 'Name the document').max(300),
  description: z.string().trim().max(5000).optional().nullable(),
  categoryId: z.string().min(1, 'Which category?'),
  assetId: z.string().optional().nullable(),
  itemId: z.string().optional().nullable(),
  version: z.string().trim().max(60).optional().nullable(),
  documentDate: z.string().regex(DAY, 'Use a date').optional().nullable(),
  isActive: z.boolean().optional(),
});

/** The category is offered, and what it is filed against exists — a machine, a model, both, or (a document being filed) neither yet. */
async function checkLinks(body: { categoryId?: string; assetId?: string | null; itemId?: string | null }) {
  if (body.categoryId) {
    const category = await prisma.serviceDocumentCategory.findUnique({ where: { id: body.categoryId }, select: { isActive: true } });
    if (!category) throw badRequest('That category does not exist');
    if (!category.isActive) throw badRequest('That category is no longer offered');
  }
  if (body.assetId && !(await prisma.installedAsset.count({ where: { id: body.assetId } }))) throw badRequest('That machine is not on the Installation Base');
  if (body.itemId && !(await prisma.item.count({ where: { id: body.itemId } }))) throw badRequest('That model is not on the item master');
}

serviceDocumentRoutes.post(
  '/',
  requireEdit('gops', 'service_documents'),
  handler(async (req, res) => {
    const me = currentUser(req);
    if (!can(me, 'gops.service_documents.create')) throw badRequest('You may read service documents but not file one');
    const body = parseBody(schema, req.body);
    await checkLinks(body);
    const row = await prisma.serviceDocument.create({
      data: {
        title: body.title,
        description: body.description?.trim() || null,
        categoryId: body.categoryId,
        assetId: body.assetId || null,
        itemId: body.itemId || null,
        version: body.version?.trim() || null,
        documentDate: body.documentDate ? dayKey(new Date(body.documentDate)) : null,
        createdById: me.id,
      },
      include,
    });
    await audit({ entityType: DOC, entityId: row.id, action: 'CREATED', summary: `Filed ${row.category.name.toLowerCase()} "${row.title}" against ${againstOf(row)}` }, req);
    res.status(201).json(present(row, 0));
  }),
);

serviceDocumentRoutes.get(
  '/:id',
  requireView('gops', 'service_documents'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await load(req.params.id);
    assertCanView(me, 'gops', 'service_documents', row.createdById === me.id, row.createdById);
    const files = await filesOf([row.id]);
    res.json({ ...present(row, files.get(row.id) ?? 0), canEdit: canEditRecord(me, 'gops', 'service_documents', row.createdById) });
  }),
);

serviceDocumentRoutes.patch(
  '/:id',
  requireEdit('gops', 'service_documents'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(schema.partial(), req.body);
    const existing = await load(req.params.id);
    assertCanEdit(me, 'gops', 'service_documents', existing.createdById === me.id, existing.createdById);
    await checkLinks(body);
    const updated = await prisma.serviceDocument.update({
      where: { id: existing.id },
      data: {
        ...(body.title ? { title: body.title } : {}),
        ...(body.description !== undefined ? { description: body.description?.trim() || null } : {}),
        ...(body.categoryId ? { categoryId: body.categoryId } : {}),
        ...(body.assetId !== undefined ? { assetId: body.assetId || null } : {}),
        ...(body.itemId !== undefined ? { itemId: body.itemId || null } : {}),
        ...(body.version !== undefined ? { version: body.version?.trim() || null } : {}),
        ...(body.documentDate !== undefined ? { documentDate: body.documentDate ? dayKey(new Date(body.documentDate)) : null } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      },
      include,
    });
    const files = await filesOf([updated.id]);
    await audit({ entityType: DOC, entityId: updated.id, action: 'UPDATED', summary: `Updated "${updated.title}"${body.isActive === false ? ' — withdrawn' : body.isActive === true ? ' — current again' : ''}`, before: existing, after: updated }, req);
    res.json(present(updated, files.get(updated.id) ?? 0));
  }),
);

/** Deleted with its files — whoever may edit it. A document in a record is withdrawn (`isActive`) rather than deleted. */
serviceDocumentRoutes.delete(
  '/:id',
  requireEdit('gops', 'service_documents'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await load(req.params.id);
    assertCanEdit(me, 'gops', 'service_documents', row.createdById === me.id, row.createdById);
    await deleteOrRefuse(row.title, () => prisma.serviceDocument.delete({ where: { id: row.id } }));
    await deleteAttachmentsOf(DOC, [row.id]);
    await audit({ entityType: DOC, entityId: row.id, action: 'DELETED', summary: `Deleted ${row.category.name.toLowerCase()} "${row.title}" (${againstOf(row)})` }, req);
    res.json({ ok: true });
  }),
);

// ── The file's guard ─────────────────────────────────────────────────────────

/** The file is read as the document is, and added or removed by whoever may edit it. */
registerAttachmentGuard(
  DOC,
  async (user, id) => {
    const row = await prisma.serviceDocument.findUnique({ where: { id }, select: { createdById: true } });
    if (!row) return false;
    try {
      assertCanView(user, 'gops', 'service_documents', row.createdById === user.id, row.createdById);
      return true;
    } catch {
      return false;
    }
  },
  {
    write: async (user, id) => {
      const row = await prisma.serviceDocument.findUnique({ where: { id }, select: { createdById: true } });
      return !!row && canEditRecord(user, 'gops', 'service_documents', row.createdById);
    },
  },
);

/**
 * The documents a machine's page lists (2026-10-20): those filed against it
 * and those filed against its model, current ones first. Read by the asset
 * route, under the asset's own visibility.
 */
export async function documentsForAsset(asset: { id: string; itemId: string | null }) {
  const rows = await prisma.serviceDocument.findMany({
    where: { isActive: true, OR: [{ assetId: asset.id }, ...(asset.itemId ? [{ itemId: asset.itemId, assetId: null }] : [])] },
    include,
    orderBy: [{ category: { sortOrder: 'asc' } }, { documentDate: 'desc' }, { createdAt: 'desc' }],
    take: 100,
  });
  const files = await filesOf(rows.map((r) => r.id));
  return rows.map((r) => ({ ...present(r, files.get(r.id) ?? 0), onModel: r.assetId === null }));
}

// ── Ctrl+K ──────────────────────────────────────────────────────────────────

registerSearch({
  kind: DOC,
  label: 'Service documents',
  permission: ['gops.service_documents.view_all', 'gops.service_documents.view_own'],
  ownWhere: (user) => ({ createdById: user.id }),
  search: async (term, _user, limit, own) => {
    const rows = await prisma.serviceDocument.findMany({
      where: {
        isActive: true,
        AND: [
          own ?? {},
          {
            OR: [
              { title: { contains: term, mode: 'insensitive' } },
              { asset: { OR: [{ name: { contains: term, mode: 'insensitive' } }, { serialNo: { contains: term, mode: 'insensitive' } }] } },
              { item: { OR: [{ name: { contains: term, mode: 'insensitive' } }, { partNumber: { contains: term, mode: 'insensitive' } }] } },
            ],
          },
        ],
      },
      take: limit,
      orderBy: { updatedAt: 'desc' },
      include,
    });
    return rows.map((r) => ({ kind: DOC, id: r.id, title: r.title, subtitle: `${r.category.name} · ${againstOf(r)}`, link: `${PATH}/${r.id}` }));
  },
});
