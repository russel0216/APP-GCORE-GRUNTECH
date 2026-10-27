import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { handler, parseBody, listQuery, listResult, orderBy, notFound, badRequest, conflict, forbidden, idsFilter, type ListQuery } from '../http/kit';
import { authenticate, currentUser } from '../auth/middleware';
import { can, canEditRecord, type ResolvedUser } from '../permissions/resolve';
import { audit } from '../shared/audit';
import { renderDocument } from '../shared/pdf';
import { registerSearch } from '../shared/search';
import { nextNumber } from '../shared/numbering';
import { notify } from '../shared/notifications';
import { distinctTexts, memoryTerm, MEMORY_SCAN } from '../shared/memory';
import { LIST_CAP, listReference, sendListPdf } from '../shared/listPaper';
import { requireView, requireEdit, ownOnly, assertCanView, assertCanEdit } from '../shared/ownScope';
import { exhibitionDays, todaysDay, dateOfDay, splitProducts, QR_FIELDS, QR_SEPARATORS } from '../shared/marketing';
import { dayKey } from '../shared/day';

/**
 * Marketing — exhibition visitors (2026-10-27, the owner's call during PSECE
 * 2026: "G-CORE › Sales › Marketing; a bar graph; a QR scanner to save the
 * info of the visitor; the brands they are inquiring — several; every account
 * user can scan and input the specific product under the brand; I will input
 * the data of Day 1, today is Day 2"; and "even though the entry is saved,
 * make it editable").
 *
 * A visitor is one person at one exhibition: the badge's vCard read on the
 * phone (or typed), the day they came by, the brands ticked and the products
 * named under each. The same badge scanned again — by anybody, any day — is
 * the SAME visitor: the second scan adds its brands and products and a scan
 * row, never a second person. No approval, no number, no money.
 *
 * `gops.marketing` (SHARED): "own" is the visitors one added; every role was
 * given View All, Create and Edit All once (`seedMarketing`).
 */

export const marketingRoutes = Router();
marketingRoutes.use(authenticate);

const VISITOR = 'exhibition_visitor';
const PATH = '/g-ops/marketing';

const include = {
  exhibition: { select: { id: true, name: true, startDate: true, endDate: true } },
  interests: { include: { brand: { select: { id: true, name: true, isActive: true } } }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
  createdBy: { select: { id: true, name: true } },
  scans: { include: { user: { select: { id: true, name: true } } }, orderBy: { at: 'asc' } },
  lead: { select: { id: true, number: true, status: true } },
} satisfies Prisma.ExhibitionVisitorInclude;

type Row = Prisma.ExhibitionVisitorGetPayload<{ include: typeof include }>;

/** The brands a visitor asked about, each with its products: "Schneider Electric — UPS, PLC". */
function brandsOf(r: Pick<Row, 'interests'>) {
  const out: { brandId: string; brand: string; products: string[] }[] = [];
  for (const i of r.interests) {
    let b = out.find((x) => x.brandId === i.brandId);
    if (!b) out.push((b = { brandId: i.brandId, brand: i.brand.name, products: [] }));
    if (i.product) b.products.push(i.product);
  }
  return out;
}

const brandsLine = (r: Pick<Row, 'interests'>) =>
  brandsOf(r)
    .map((b) => (b.products.length ? `${b.brand} — ${b.products.join(', ')}` : b.brand))
    .join('; ');

function present(r: Row, me?: ResolvedUser) {
  const scanners = [...new Map(r.scans.map((s) => [s.user.id, s.user.name])).values()];
  return {
    ...r,
    brands: brandsOf(r),
    scanners,
    scanCount: r.scans.length,
    ...(me ? { canEdit: canEditRecord(me, 'gops', 'marketing', r.createdById), canDelete: can(me, 'gops.marketing.delete') && canEditRecord(me, 'gops', 'marketing', r.createdById) } : {}),
  };
}

async function load(id: string): Promise<Row> {
  const row = await prisma.exhibitionVisitor.findUnique({ where: { id }, include });
  if (!row) throw notFound('Visitor not found');
  return row;
}

/** The exhibition a request means: the one named, else the latest active one. */
async function exhibitionFor(id: string | undefined) {
  const e = id
    ? await prisma.exhibition.findUnique({ where: { id } })
    : ((await prisma.exhibition.findFirst({ where: { isActive: true }, orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }] })) ??
      (await prisma.exhibition.findFirst({ orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }] })));
  if (!e) throw notFound(id ? 'Exhibition not found' : 'No exhibition on file yet — add one first');
  return e;
}

function presentExhibition(e: { id: string; name: string; venue: string | null; startDate: Date; endDate: Date; isActive: boolean; notes: string | null; qrFormat: string; qrSeparator: string | null; qrFields: string[]; brandIds: string[] }) {
  const days = exhibitionDays(e);
  const today = dayKey(new Date()).getTime();
  return {
    ...e,
    days: Array.from({ length: days }, (_, i) => ({ day: i + 1, date: dateOfDay(e, i + 1).toISOString().slice(0, 10) })),
    today: todaysDay(e),
    /** Whether today falls inside it, on Manila's calendar: the scanner warns outside. */
    when: today < e.startDate.getTime() ? 'upcoming' : today > e.endDate.getTime() ? 'ended' : 'running',
  };
}

/** One rule for the list's rows, cards and paper: the exhibition, the viewer's scope, the search; then the filters. */
async function listWhere(me: ResolvedUser, q: ListQuery) {
  const f = q.filters;
  const exhibition = await exhibitionFor(f.exhibitionId);
  const and: Prisma.ExhibitionVisitorWhereInput[] = [{ exhibitionId: exhibition.id }];
  const ids = idsFilter(f.ids);
  if (ids) and.push({ id: { in: ids } });
  if (q.search) {
    const s = { contains: q.search, mode: 'insensitive' as const };
    and.push({ OR: [{ name: s }, { company: s }, { position: s }, { email: s }, { mobile: s }, { notes: s }, { interests: { some: { OR: [{ product: s }, { brand: { name: s } }] } } }] });
  }
  if (q.scope === 'mine') and.push({ OR: [{ createdById: me.id }, { scans: { some: { userId: me.id } } }] });
  const base = ownOnly<Prisma.ExhibitionVisitorWhereInput>(me, 'gops', 'marketing', { AND: and }, (owners) => ({ createdById: { in: owners } }));
  const extra: Prisma.ExhibitionVisitorWhereInput[] = [];
  if (f.day) {
    const day = Number(f.day);
    if (!Number.isInteger(day) || day < 1) throw badRequest('Day: a day of the exhibition');
    extra.push({ day });
  }
  if (f.brandId) extra.push({ interests: { some: { brandId: f.brandId } } });
  if (f.product) extra.push({ interests: { some: { product: { equals: f.product, mode: 'insensitive' }, ...(f.brandId ? { brandId: f.brandId } : {}) } } });
  if (f.scannedBy) extra.push({ OR: [{ createdById: f.scannedBy }, { scans: { some: { userId: f.scannedBy } } }] });
  if (f.lead === 'yes') extra.push({ leadId: { not: null } });
  else if (f.lead === 'no') extra.push({ leadId: null });
  else if (f.lead) throw badRequest('Lead: yes or no');
  if (f.noBrand === 'true') extra.push({ interests: { none: {} } });
  if (f.position) extra.push(f.position === 'none' ? { position: null } : { position: { equals: f.position, mode: 'insensitive' } });
  return { exhibition, base, where: extra.length ? { AND: [base, ...extra] } : base };
}

const SORTS = ['name', 'company', 'position', 'day', 'createdAt', 'updatedAt'];

// ── Exhibitions ─────────────────────────────────────────────────────────────

marketingRoutes.get(
  '/exhibitions',
  requireView('gops', 'marketing'),
  handler(async (_req, res) => {
    const rows = await prisma.exhibition.findMany({ orderBy: { startDate: 'desc' }, include: { _count: { select: { visitors: true } } } });
    res.json(rows.map((e) => ({ ...presentExhibition(e), visitors: e._count.visitors })));
  }),
);

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const exhibitionSchema = z
  .object({
    name: z.string().trim().min(2, 'Name the exhibition').max(160),
    venue: z.string().trim().max(300).optional().nullable(),
    startDate: z.string().regex(DAY, 'Day 1, as a date'),
    endDate: z.string().regex(DAY, 'The last day, as a date'),
    isActive: z.boolean().optional(),
    notes: z.string().trim().max(2000).optional().nullable(),
    qrFormat: z.enum(['AUTO', 'DELIMITED']).optional(),
    qrSeparator: z.enum(QR_SEPARATORS).optional().nullable(),
    qrFields: z.array(z.enum(QR_FIELDS)).max(20).optional(),
    brandIds: z.array(z.string()).max(200).optional(),
  })
  .refine((b) => b.qrFormat !== 'DELIMITED' || (b.qrFields ?? []).some((f) => f === 'name' || f === 'firstName' || f === 'lastName'), {
    message: 'Say which part of the badge is the name',
    path: ['qrFields'],
  })
  .refine((b) => b.endDate >= b.startDate, { message: 'The last day cannot come before Day 1', path: ['endDate'] })
  .refine((b) => (new Date(b.endDate).getTime() - new Date(b.startDate).getTime()) / 86_400_000 <= 30, { message: 'An exhibition runs 31 days at most', path: ['endDate'] });

/** The brands named are on the list; empty keeps "every active brand". */
async function checkBrandIds(ids: string[] | undefined) {
  if (!ids?.length) return [];
  const unique = [...new Set(ids)];
  const found = await prisma.exhibitionBrand.count({ where: { id: { in: unique } } });
  if (found !== unique.length) throw badRequest('One of the brands chosen is not on the list');
  return unique;
}

/** The QR settings as stored: the separator and the order only for a DELIMITED exhibition. */
const qrData = (b: { qrFormat?: string; qrSeparator?: string | null; qrFields?: string[] }) =>
  b.qrFormat === 'DELIMITED' ? { qrFormat: 'DELIMITED', qrSeparator: b.qrSeparator || '|', qrFields: b.qrFields ?? [] } : { qrFormat: 'AUTO', qrSeparator: null, qrFields: [] };

function mayRunExhibitions(me: ResolvedUser) {
  if (!can(me, 'gops.marketing.edit_all')) throw forbidden('You need "gops.marketing.edit_all" to set up an exhibition');
}

marketingRoutes.post(
  '/exhibitions',
  handler(async (req, res) => {
    const me = currentUser(req);
    mayRunExhibitions(me);
    const b = parseBody(exhibitionSchema, req.body);
    const brandIds = await checkBrandIds(b.brandIds);
    const row = await prisma.exhibition.create({
      data: { name: b.name, venue: b.venue || null, startDate: new Date(`${b.startDate}T00:00:00Z`), endDate: new Date(`${b.endDate}T00:00:00Z`), isActive: b.isActive ?? true, notes: b.notes || null, ...qrData(b), brandIds, createdById: me.id },
    });
    await audit({ entityType: 'exhibition', entityId: row.id, action: 'CREATED', summary: `Added the exhibition ${row.name}` }, req);
    res.status(201).json(presentExhibition(row));
  }),
);

marketingRoutes.patch(
  '/exhibitions/:id',
  handler(async (req, res) => {
    const me = currentUser(req);
    mayRunExhibitions(me);
    const before = await prisma.exhibition.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound('Exhibition not found');
    const b = parseBody(exhibitionSchema, {
      name: before.name,
      venue: before.venue,
      startDate: before.startDate.toISOString().slice(0, 10),
      endDate: before.endDate.toISOString().slice(0, 10),
      notes: before.notes,
      qrFormat: before.qrFormat,
      qrSeparator: before.qrSeparator,
      qrFields: before.qrFields,
      brandIds: before.brandIds,
      ...req.body,
    });
    const brandIds = await checkBrandIds(b.brandIds);
    const days = Math.round((new Date(b.endDate).getTime() - new Date(b.startDate).getTime()) / 86_400_000) + 1;
    const beyond = await prisma.exhibitionVisitor.count({ where: { exhibitionId: before.id, day: { gt: days } } });
    if (beyond) throw badRequest(`${beyond} visitor(s) are on a day after the new last day — move them first`);
    const row = await prisma.exhibition.update({
      where: { id: before.id },
      data: { name: b.name, venue: b.venue || null, startDate: new Date(`${b.startDate}T00:00:00Z`), endDate: new Date(`${b.endDate}T00:00:00Z`), ...(b.isActive !== undefined ? { isActive: b.isActive } : {}), notes: b.notes || null, ...qrData(b), brandIds },
    });
    await audit({ entityType: 'exhibition', entityId: row.id, action: 'UPDATED', summary: `Updated the exhibition ${row.name}`, before, after: row }, req);
    res.json(presentExhibition(row));
  }),
);

/** An exhibition nobody was recorded at may be deleted; one with visitors is closed (`isActive` off) instead. */
marketingRoutes.delete(
  '/exhibitions/:id',
  handler(async (req, res) => {
    const me = currentUser(req);
    mayRunExhibitions(me);
    const row = await prisma.exhibition.findUnique({ where: { id: req.params.id }, include: { _count: { select: { visitors: true } } } });
    if (!row) throw notFound('Exhibition not found');
    if (row._count.visitors) throw badRequest(`${row._count.visitors} visitor(s) are recorded at ${row.name} — close it instead (untick Running)`);
    await prisma.exhibition.delete({ where: { id: row.id } });
    await audit({ entityType: 'exhibition', entityId: row.id, action: 'DELETED', summary: `Deleted the exhibition ${row.name}`, before: row }, req);
    res.json({ ok: true });
  }),
);

// ── The bar graphs ──────────────────────────────────────────────────────────

/**
 * Everything the dashboard draws, off the visitors the viewer may read: per
 * brand (distinct visitors), per day (first visit) and scans per day, the
 * products under each brand, and who scanned how many. One query's rows,
 * counted here, so every bar adds up to the list it links to.
 */
marketingRoutes.get(
  '/dashboard',
  requireView('gops', 'marketing'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const { exhibition, base } = await listWhere(me, { ...q, filters: { exhibitionId: q.filters.exhibitionId ?? '' }, search: '', scope: 'all' });
    const [visitors, brands] = await Promise.all([
      prisma.exhibitionVisitor.findMany({
        where: base,
        select: { id: true, day: true, position: true, leadId: true, createdById: true, interests: { select: { brandId: true, product: true } }, scans: { select: { userId: true, day: true } } },
      }),
      prisma.exhibitionBrand.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { id: true, name: true, isActive: true } }),
    ]);
    const e = presentExhibition(exhibition);
    const byBrand = new Map<string, Set<string>>();
    const products = new Map<string, Map<string, { product: string; count: number }>>();
    for (const v of visitors) {
      for (const i of v.interests) {
        (byBrand.get(i.brandId) ?? byBrand.set(i.brandId, new Set()).get(i.brandId)!).add(v.id);
        if (i.product) {
          const m = products.get(i.brandId) ?? products.set(i.brandId, new Map()).get(i.brandId)!;
          const k = i.product.trim().replace(/\s+/g, ' ').toUpperCase();
          const p = m.get(k) ?? { product: i.product.trim(), count: 0 };
          p.count++;
          m.set(k, p);
        }
      }
    }
    const scannerIds = new Map<string, number>();
    for (const v of visitors) for (const s of v.scans) scannerIds.set(s.userId, (scannerIds.get(s.userId) ?? 0) + 1);
    const people = await prisma.user.findMany({ where: { id: { in: [...scannerIds.keys()] } }, select: { id: true, name: true } });
    // Positions as typed, counted case- and space-blind, the first spelling naming each.
    const positions = new Map<string, { position: string; visitors: number }>();
    let noPosition = 0;
    for (const v of visitors) {
      const p = v.position?.trim().replace(/\s+/g, ' ');
      if (!p) {
        noPosition++;
        continue;
      }
      const k = p.toUpperCase();
      const row = positions.get(k) ?? { position: p, visitors: 0 };
      row.visitors++;
      positions.set(k, row);
    }
    // The brands this exhibition features (all active ones when it names none), and any a visitor asked about.
    const featured = (b: { id: string; isActive: boolean }) => (e.brandIds.length ? e.brandIds.includes(b.id) : b.isActive);
    res.json({
      exhibition: e,
      totals: {
        visitors: visitors.length,
        today: visitors.filter((v) => v.day === e.today).length,
        scans: visitors.reduce((a, v) => a + v.scans.length, 0),
        withBrand: visitors.filter((v) => v.interests.length).length,
        leads: visitors.filter((v) => v.leadId).length,
      },
      byBrand: brands
        .filter((b) => featured(b) || byBrand.has(b.id))
        .map((b) => ({ brandId: b.id, brand: b.name, visitors: byBrand.get(b.id)?.size ?? 0 }))
        .sort((a, b) => b.visitors - a.visitors),
      byDay: e.days.map((d) => ({ ...d, visitors: visitors.filter((v) => v.day === d.day).length, scans: visitors.reduce((a, v) => a + v.scans.filter((s) => s.day === d.day).length, 0) })),
      products: brands
        .filter((b) => products.has(b.id))
        .map((b) => ({ brandId: b.id, brand: b.name, products: [...products.get(b.id)!.values()].sort((x, y) => y.count - x.count || x.product.localeCompare(y.product)) })),
      byPosition: [...positions.values()].sort((a, b) => b.visitors - a.visitors || a.position.localeCompare(b.position)),
      noPosition,
      byScanner: people.map((p) => ({ userId: p.id, name: p.name, scans: scannerIds.get(p.id) ?? 0 })).sort((a, b) => b.scans - a.scans),
    });
  }),
);

// ── The visitor list ────────────────────────────────────────────────────────

marketingRoutes.get(
  '/visitors',
  requireView('gops', 'marketing'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const { exhibition, base, where } = await listWhere(me, q);
    const e = presentExhibition(exhibition);
    const [rows, total, all, today, leads, byDay] = await Promise.all([
      prisma.exhibitionVisitor.findMany({ where, include, orderBy: orderBy(q, SORTS, { createdAt: 'desc' }), skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      prisma.exhibitionVisitor.count({ where }),
      prisma.exhibitionVisitor.count({ where: base }),
      prisma.exhibitionVisitor.count({ where: { AND: [base, { day: e.today }] } }),
      prisma.exhibitionVisitor.count({ where: { AND: [base, { leadId: { not: null } }] } }),
      prisma.exhibitionVisitor.groupBy({ by: ['day'], where: base, _count: { _all: true } }),
    ]);
    res.json({
      ...listResult(rows.map((r) => present(r)), total, q),
      summary: { exhibition: e, visitors: all, today, leads, byDay: e.days.map((d) => ({ ...d, visitors: byDay.find((b) => b.day === d.day)?._count._all ?? 0 })) },
    });
  }),
);

/** The list on paper: the list's own query, or the rows ticked. Declared above /:id. */
marketingRoutes.get(
  '/visitors/pdf',
  requireView('gops', 'marketing'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const { exhibition, where } = await listWhere(me, q);
    const f = q.filters;
    const [rows, count, brand, scanner] = await Promise.all([
      prisma.exhibitionVisitor.findMany({ where, include, orderBy: orderBy(q, SORTS, { createdAt: 'asc' }), take: LIST_CAP }),
      prisma.exhibitionVisitor.count({ where }),
      f.brandId ? prisma.exhibitionBrand.findUnique({ where: { id: f.brandId }, select: { name: true } }) : null,
      f.scannedBy ? prisma.user.findUnique({ where: { id: f.scannedBy }, select: { name: true } }) : null,
    ]);
    const noun = ['visitor', 'visitors'] as const;
    const reference = listReference(count, rows.length, noun, [
      exhibition.name,
      q.search ? `search "${q.search}"` : null,
      f.day ? `Day ${f.day}` : null,
      f.brandId ? `brand ${brand?.name ?? 'not found'}` : null,
      f.product ? `product ${f.product}` : null,
      f.scannedBy ? `scanned by ${scanner?.name ?? 'not found'}` : null,
      f.lead === 'yes' ? 'made a lead' : f.lead === 'no' ? 'no lead yet' : null,
      f.noBrand === 'true' ? 'no brand ticked' : null,
      f.position ? (f.position === 'none' ? 'no position given' : `position ${f.position}`) : null,
      q.scope === 'mine' ? 'mine' : null,
      f.ids ? 'the rows selected' : null,
    ]);
    const pdf = await renderDocument({
      title: 'Exhibition Visitors',
      date: new Date(),
      reference,
      landscape: true,
      sections: [
        {
          kind: 'table',
          head: ['Day', 'Visitor', 'Position', 'Company', 'Email', 'Mobile', 'Brands and products', 'Scanned by'],
          rows: rows.map((r) => [
            `Day ${r.day}`,
            r.name,
            r.position ?? '—',
            r.company ?? '—',
            r.email ?? '—',
            r.mobile ?? '—',
            brandsLine(r) || '—',
            [...new Set(r.scans.map((s) => s.user.name))].join(', ') || r.createdBy.name,
          ]),
        },
      ],
    });
    await audit({ entityType: VISITOR, entityId: 'list', action: 'EXPORTED', summary: `Exported the exhibition visitors list as PDF (${listReference(count, rows.length, noun, [])})` }, req);
    sendListPdf(res, pdf, 'exhibition-visitors.pdf');
  }),
);

/** Positions typed before, at any exhibition — the position box's memory and the list's filter. Declared above /:id. */
marketingRoutes.get(
  '/suggest/positions',
  requireView('gops', 'marketing'),
  handler(async (req, res) => {
    const term = memoryTerm(req.query.q);
    const rows = await prisma.exhibitionVisitor.findMany({
      where: { position: term ? { contains: term, mode: 'insensitive' } : { not: null } },
      select: { position: true },
      orderBy: { updatedAt: 'desc' },
      take: MEMORY_SCAN,
    });
    res.json(distinctTexts(rows.map((r) => r.position), term));
  }),
);

/** Products named before under a brand — the product box's memory. Declared above /:id. */
marketingRoutes.get(
  '/suggest/products',
  requireView('gops', 'marketing'),
  handler(async (req, res) => {
    const term = memoryTerm(req.query.q);
    const brandId = String(req.query.brandId ?? '');
    const rows = await prisma.exhibitionInterest.findMany({
      where: { product: term ? { contains: term, mode: 'insensitive' } : { not: null }, ...(brandId ? { brandId } : {}) },
      select: { product: true },
      orderBy: { id: 'desc' },
      take: MEMORY_SCAN,
    });
    res.json(distinctTexts(rows.map((r) => r.product), term));
  }),
);

/**
 * Whether the person scanned is already on file at this exhibition — the
 * scanner shows "already scanned by …" before saving. Declared above /:id.
 */
marketingRoutes.get(
  '/visitors/match',
  requireView('gops', 'marketing'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const exhibition = await exhibitionFor(String(req.query.exhibitionId ?? '') || undefined);
    const found = await findSame(exhibition.id, { email: str(req.query.email), qrText: str(req.query.qrText), name: str(req.query.name), company: str(req.query.company) });
    if (!found) return res.json({ visitor: null });
    const row = await load(found);
    try {
      assertCanView(me, 'gops', 'marketing', row.createdById === me.id, row.createdById);
    } catch {
      // Somebody else's visitor the viewer may not read: say it exists, not who.
      return res.json({ visitor: null, exists: true });
    }
    res.json({ visitor: present(row, me) });
  }),
);

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The same person at this exhibition: the same badge, else the same email, else (no email either side) the same name at the same company. */
async function findSame(exhibitionId: string, k: { email: string | null; qrText: string | null; name: string | null; company: string | null }, tx: Prisma.TransactionClient = prisma, exceptId?: string): Promise<string | null> {
  const not = exceptId ? { id: { not: exceptId } } : {};
  if (k.qrText) {
    const hit = await tx.exhibitionVisitor.findFirst({ where: { exhibitionId, qrText: k.qrText, ...not }, select: { id: true } });
    if (hit) return hit.id;
  }
  if (k.email) {
    const hit = await tx.exhibitionVisitor.findFirst({ where: { exhibitionId, email: { equals: k.email, mode: 'insensitive' }, ...not }, select: { id: true } });
    if (hit) return hit.id;
    return null;
  }
  if (k.name) {
    const hit = await tx.exhibitionVisitor.findFirst({
      where: { exhibitionId, email: null, name: { equals: k.name, mode: 'insensitive' }, company: k.company ? { equals: k.company, mode: 'insensitive' } : null, ...not },
      select: { id: true },
    });
    if (hit) return hit.id;
  }
  return null;
}

// ── Saving a visitor ────────────────────────────────────────────────────────

const interestSchema = z.object({
  brandId: z.string().min(1),
  /** Several products typed under the brand, comma-separated: "UPS, PLC". */
  products: z.string().max(1000).optional().nullable(),
});

const visitorSchema = z.object({
  exhibitionId: z.string().optional(),
  day: z.number().int().min(1).optional(),
  name: z.string().trim().min(2, 'The visitor’s name').max(200),
  company: z.string().trim().max(300).optional().nullable(),
  position: z.string().trim().max(200).optional().nullable(),
  email: z.string().trim().max(200).optional().nullable(),
  mobile: z.string().trim().max(60).optional().nullable(),
  notes: z.string().trim().max(5000).optional().nullable(),
  qrText: z.string().max(4000).optional().nullable(),
  source: z.enum(['SCAN', 'MANUAL']).optional(),
  interests: z.array(interestSchema).max(60).default([]),
});

type VisitorInput = z.infer<typeof visitorSchema>;

/** The interest rows a form means: one per brand and product, a brand with no product once; every brand on file. */
export async function interestRows(interests: { brandId: string; products?: string | null }[], tx: Prisma.TransactionClient = prisma) {
  const ids = [...new Set(interests.map((i) => i.brandId))];
  const brands = await tx.exhibitionBrand.findMany({ where: { id: { in: ids } }, select: { id: true, isActive: true, name: true } });
  for (const id of ids) if (!brands.some((b) => b.id === id)) throw badRequest('One of the brands ticked is not on the list');
  const rows: { brandId: string; product: string | null }[] = [];
  for (const i of interests) {
    const products = splitProducts(i.products);
    if (!products.length) {
      if (!rows.some((r) => r.brandId === i.brandId)) rows.push({ brandId: i.brandId, product: null });
      continue;
    }
    for (const p of products) {
      if (!rows.some((r) => r.brandId === i.brandId && r.product?.toLowerCase() === p.toLowerCase())) rows.push({ brandId: i.brandId, product: p });
    }
  }
  // A brand with products named drops its "no product" row.
  return rows.filter((r) => r.product !== null || !rows.some((x) => x.brandId === r.brandId && x.product !== null));
}

const clean = (v: string | null | undefined) => (v && v.trim() ? v.trim().replace(/\s+/g, ' ') : null);

/**
 * Records a visitor — or, when the same person is already on file at the
 * exhibition, ADDS to them: blanks filled, a different note appended, the
 * brands and products joined, and one more scan row. Shared with the import.
 */
export async function recordVisitor(
  tx: Prisma.TransactionClient,
  me: { id: string },
  exhibition: { id: string; startDate: Date; endDate: Date },
  b: Omit<VisitorInput, 'source'> & { source?: 'SCAN' | 'MANUAL' | 'IMPORT' },
): Promise<{ id: string; merged: boolean }> {
  const days = exhibitionDays(exhibition);
  const day = b.day ?? todaysDay(exhibition);
  if (day > days) throw badRequest(`This exhibition runs ${days} day(s) — there is no Day ${day}`);
  const source = b.source ?? (b.qrText ? 'SCAN' : 'MANUAL');
  const fields = { name: clean(b.name)!, company: clean(b.company), position: clean(b.position), email: clean(b.email)?.toLowerCase() ?? null, mobile: clean(b.mobile), notes: b.notes?.trim() || null, qrText: b.qrText?.trim() || null };
  const rows = await interestRows(b.interests, tx);
  const same = await findSame(exhibition.id, fields, tx);
  if (same) {
    const v = await tx.exhibitionVisitor.findUniqueOrThrow({ where: { id: same }, include: { interests: true } });
    const have = new Set(v.interests.map((i) => `${i.brandId}|${(i.product ?? '').toLowerCase()}`));
    const add = rows.filter((r) => !have.has(`${r.brandId}|${(r.product ?? '').toLowerCase()}`));
    // A product named under a brand that was ticked bare replaces the bare row.
    const bare = v.interests.filter((i) => i.product === null && add.some((r) => r.brandId === i.brandId && r.product));
    await tx.exhibitionVisitor.update({
      where: { id: v.id },
      data: {
        company: v.company ?? fields.company,
        position: v.position ?? fields.position,
        email: v.email ?? fields.email,
        mobile: v.mobile ?? fields.mobile,
        qrText: v.qrText ?? fields.qrText,
        notes: fields.notes && !(v.notes ?? '').includes(fields.notes) ? [v.notes, fields.notes].filter(Boolean).join('\n') : v.notes,
        day: Math.min(v.day, day),
      },
    });
    if (bare.length) await tx.exhibitionInterest.deleteMany({ where: { id: { in: bare.map((i) => i.id) } } });
    if (add.length) await tx.exhibitionInterest.createMany({ data: add.map((r, i) => ({ visitorId: v.id, brandId: r.brandId, product: r.product, sortOrder: v.interests.length + i })) });
    await tx.exhibitionScan.create({ data: { visitorId: v.id, userId: me.id, day, source } });
    return { id: v.id, merged: true };
  }
  const v = await tx.exhibitionVisitor.create({
    data: { exhibitionId: exhibition.id, day, ...fields, source, createdById: me.id, interests: { create: rows.map((r, i) => ({ brandId: r.brandId, product: r.product, sortOrder: i })) } },
  });
  await tx.exhibitionScan.create({ data: { visitorId: v.id, userId: me.id, day, source } });
  return { id: v.id, merged: false };
}

marketingRoutes.post(
  '/visitors',
  requireView('gops', 'marketing'),
  handler(async (req, res) => {
    const me = currentUser(req);
    if (!can(me, 'gops.marketing.create')) throw forbidden('You need "gops.marketing.create" to add a visitor');
    const b = parseBody(visitorSchema, req.body);
    const exhibition = await exhibitionFor(b.exhibitionId);
    const done = await prisma.$transaction((tx) => recordVisitor(tx, me, exhibition, b));
    const row = await load(done.id);
    await audit(
      {
        entityType: VISITOR,
        entityId: row.id,
        action: done.merged ? 'UPDATED' : 'CREATED',
        summary: done.merged ? `Scanned ${row.name} again at ${exhibition.name} (Day ${b.day ?? todaysDay(exhibition)}) — brands joined` : `Added ${row.name}${row.company ? ` (${row.company})` : ''} at ${exhibition.name}, Day ${row.day}`,
      },
      req,
    );
    res.status(done.merged ? 200 : 201).json({ ...present(row, me), merged: done.merged });
  }),
);

marketingRoutes.get(
  '/visitors/:id',
  requireView('gops', 'marketing'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await load(req.params.id);
    assertCanView(me, 'gops', 'marketing', row.createdById === me.id, row.createdById);
    res.json({ ...present(row, me), exhibition: presentExhibition(await exhibitionFor(row.exhibitionId)), canMakeLead: !row.leadId && can(me, 'gops.leads.create') });
  }),
);

/** Modify: every field, the day, and the brands and products (replaced whole when sent). */
marketingRoutes.patch(
  '/visitors/:id',
  requireEdit('gops', 'marketing'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const before = await load(req.params.id);
    assertCanEdit(me, 'gops', 'marketing', before.createdById === me.id, before.createdById);
    const b = parseBody(visitorSchema.partial().extend({ interests: z.array(interestSchema).max(60).optional() }), req.body);
    const exhibition = await exhibitionFor(before.exhibitionId);
    if (b.day !== undefined && b.day > exhibitionDays(exhibition)) throw badRequest(`This exhibition runs ${exhibitionDays(exhibition)} day(s)`);
    await prisma.$transaction(async (tx) => {
      const email = b.email !== undefined ? (clean(b.email)?.toLowerCase() ?? null) : before.email;
      if (email && email !== before.email) {
        const clash = await findSame(before.exhibitionId, { email, qrText: null, name: null, company: null }, tx, before.id);
        if (clash) throw conflict('Another visitor at this exhibition has that email — open that one instead');
      }
      await tx.exhibitionVisitor.update({
        where: { id: before.id },
        data: {
          ...(b.name ? { name: clean(b.name)! } : {}),
          ...(b.company !== undefined ? { company: clean(b.company) } : {}),
          ...(b.position !== undefined ? { position: clean(b.position) } : {}),
          ...(b.email !== undefined ? { email } : {}),
          ...(b.mobile !== undefined ? { mobile: clean(b.mobile) } : {}),
          ...(b.notes !== undefined ? { notes: b.notes?.trim() || null } : {}),
          ...(b.day !== undefined ? { day: b.day } : {}),
        },
      });
      if (b.interests) {
        const rows = await interestRows(b.interests, tx);
        await tx.exhibitionInterest.deleteMany({ where: { visitorId: before.id } });
        if (rows.length) await tx.exhibitionInterest.createMany({ data: rows.map((r, i) => ({ visitorId: before.id, brandId: r.brandId, product: r.product, sortOrder: i })) });
      }
    });
    const after = await load(before.id);
    await audit({ entityType: VISITOR, entityId: after.id, action: 'UPDATED', summary: `Updated visitor ${after.name}${brandsLine(after) ? ` — ${brandsLine(after)}` : ''}`, before: { ...before, scans: undefined }, after: { ...after, scans: undefined } }, req);
    res.json(present(after, me));
  }),
);

marketingRoutes.delete(
  '/visitors/:id',
  requireEdit('gops', 'marketing'),
  handler(async (req, res) => {
    const me = currentUser(req);
    if (!can(me, 'gops.marketing.delete')) throw forbidden('You need "gops.marketing.delete" to remove a visitor');
    const row = await load(req.params.id);
    assertCanEdit(me, 'gops', 'marketing', row.createdById === me.id, row.createdById);
    await prisma.exhibitionVisitor.delete({ where: { id: row.id } });
    await audit({ entityType: VISITOR, entityId: row.id, action: 'DELETED', summary: `Removed visitor ${row.name}${row.company ? ` (${row.company})` : ''} from ${row.exhibition.name}` }, req);
    res.json({ ok: true });
  }),
);

/**
 * Makes a lead of a visitor — the ordinary lead, numbered, assigned to the
 * person who makes it, its source the exhibition, its description what they
 * asked about. Once: a visitor with a lead names it.
 */
marketingRoutes.post(
  '/visitors/:id/lead',
  requireView('gops', 'marketing'),
  handler(async (req, res) => {
    const me = currentUser(req);
    if (!can(me, 'gops.leads.create')) throw forbidden('You need "gops.leads.create" to make a lead');
    const row = await load(req.params.id);
    assertCanView(me, 'gops', 'marketing', row.createdById === me.id, row.createdById);
    if (row.leadId) throw conflict(`${row.name} is already lead ${row.lead?.number ?? ''}`.trim());
    const lead = await prisma.$transaction(async (tx) => {
      const claimed = await tx.exhibitionVisitor.updateMany({ where: { id: row.id, leadId: null }, data: { updatedAt: new Date() } });
      if (!claimed.count) throw conflict('A lead was made from this visitor a moment ago — reload');
      const made = await tx.lead.create({
        data: {
          number: await nextNumber('lead', tx),
          companyName: row.company || row.name,
          contactPerson: [row.name, row.position].filter(Boolean).join(' — '),
          contactEmail: row.email,
          contactPhone: row.mobile,
          source: `Exhibition: ${row.exhibition.name}`,
          description: brandsLine(row) ? `Asked about ${brandsLine(row)}` : `Visited the booth at ${row.exhibition.name}`,
          notes: row.notes,
          assignedToId: me.id,
          createdById: me.id,
        },
      });
      await tx.exhibitionVisitor.update({ where: { id: row.id }, data: { leadId: made.id } });
      return made;
    });
    await audit({ entityType: 'lead', entityId: lead.id, action: 'CREATED', summary: `Created lead ${lead.number} — ${lead.companyName} (from the exhibition visitor ${row.name})` }, req);
    if (row.createdById !== me.id) {
      await notify({ userId: row.createdById, type: 'system', title: `Lead made from your visitor ${row.name}`, body: lead.number, link: `/g-ops/leads/${lead.id}` }).catch(() => undefined);
    }
    res.status(201).json({ id: lead.id, number: lead.number });
  }),
);

// ── Ctrl+K ──────────────────────────────────────────────────────────────────

registerSearch({
  kind: VISITOR,
  label: 'Exhibition visitors',
  permission: ['gops.marketing.view_all', 'gops.marketing.view_own'],
  ownWhere: (user) => ({ createdById: user.id }),
  search: async (term, _user, limit, own) => {
    const s = { contains: term, mode: 'insensitive' as const };
    const rows = await prisma.exhibitionVisitor.findMany({
      where: { AND: [own ?? {}, { OR: [{ name: s }, { company: s }, { email: s }] }] },
      take: limit,
      orderBy: { updatedAt: 'desc' },
      select: { id: true, name: true, company: true, day: true, exhibition: { select: { name: true } } },
    });
    return rows.map((r) => ({ kind: VISITOR, id: r.id, title: r.name, subtitle: [r.company, `${r.exhibition.name}, Day ${r.day}`].filter(Boolean).join(' · '), link: `${PATH}/visitors/${r.id}` }));
  },
});

