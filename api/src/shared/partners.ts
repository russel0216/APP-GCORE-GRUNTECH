import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { badRequest, conflict, orderBy, type ListQuery } from '../http/kit';
import { nextNumber } from './numbering';
import { saveAttachment, deleteAttachment } from './attachments';

/**
 * Partners (model §2.9, item 10).
 *
 * A partner IS a supplier with a flag. The principal whose catalogue a
 * salesperson reads is the company procurement orders the compressor from —
 * Item.preferredSupplierId, CanvassSupplier, PurchaseOrder, SupplierBill and
 * Payment all already point at Supplier, so a second "Partner" table would be
 * the same organisation twice, which is the defect this rebuild exists to
 * remove.
 *
 * What a partner has that a plain supplier does not: a brand, a date, and
 * RESOURCES — catalogues, price lists and sizing tools. A resource is metadata
 * (kind, title, validity) over EITHER one file in the attachment service OR
 * an external link, or both. The logic lives here so the verify script can
 * drive it without HTTP.
 */

export const PARTNER_RESOURCE_ENTITY = 'partner_resource';

export const RESOURCE_KINDS = ['CATALOGUE', 'PRICE_LIST', 'SIZING_APP', 'OTHER'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/**
 * A stored URL becomes an <a href> on the client. Only http(s) may pass —
 * this is what keeps `javascript:` out of a link a salesperson clicks.
 */
export function safeHttpUrl(v: string): string {
  const s = String(v ?? '').trim();
  let parsed: URL;
  try {
    parsed = new URL(s);
  } catch {
    throw badRequest('Links must start with http:// or https://');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw badRequest('Links must start with http:// or https://');
  }
  return s;
}

// The resource form arrives as multipart fields, so every value is a string
// (or absent). `z.coerce.boolean()` would turn the string "false" into true,
// hence the explicit preprocessors.
const formBool = (fallback: boolean) =>
  z.preprocess((v) => {
    if (v === undefined || v === null || v === '') return fallback;
    if (typeof v === 'string') return ['true', '1', 'yes', 'on'].includes(v.toLowerCase());
    return Boolean(v);
  }, z.boolean());

const formDate = z.preprocess(
  (v) => (v === '' || v === undefined || v === null ? null : v),
  z.coerce.date().nullable(),
);

const formInt = (fallback: number) =>
  z.preprocess((v) => (v === '' || v === undefined || v === null ? fallback : v), z.coerce.number().int());

const formText = z.preprocess(
  (v) => (v === '' || v === undefined || v === null ? null : v),
  z.string().trim().nullable(),
);

export const resourceSchema = z.object({
  kind: z.enum(RESOURCE_KINDS),
  title: z.string().trim().min(2, 'Give the resource a title'),
  description: formText.optional(),
  url: formText.optional(),
  validFrom: formDate.optional(),
  validUntil: formDate.optional(),
  sortOrder: formInt(0).optional(),
  isActive: formBool(true).optional(),
});

export type ResourceInput = z.infer<typeof resourceSchema>;

const contactSchema = z.object({
  name: z.string().trim().min(2),
  position: z.string().trim().optional().nullable(),
  email: z.string().trim().optional().nullable(),
  mobile: z.string().trim().optional().nullable(),
});

/**
 * Either flag an existing supplier, or create a new supplier row that is a
 * partner from the start. The refine is the "one or the other" rule.
 */
export const partnerSchema = z
  .object({
    supplierId: z.string().trim().optional().nullable(),
    name: z.string().trim().optional().nullable(),
    code: z.string().trim().optional().nullable(),
    brand: z.string().trim().optional().nullable(),
    legalName: z.string().trim().optional().nullable(),
    tin: z.string().trim().optional().nullable(),
    category: z.string().trim().optional().nullable(),
    website: z.string().trim().optional().nullable(),
    phone: z.string().trim().optional().nullable(),
    email: z.string().trim().optional().nullable(),
    address: z.string().trim().optional().nullable(),
    city: z.string().trim().optional().nullable(),
    partnerSince: z.coerce.date().optional().nullable(),
    notes: z.string().optional().nullable(),
    contact: contactSchema.optional().nullable(),
  })
  .refine((v) => Boolean(v.supplierId) || (v.name ?? '').length >= 2, {
    message: 'Pick an existing supplier or give the new partner a name',
    path: ['name'],
  });

export type PartnerInput = z.infer<typeof partnerSchema>;

/** Flags a supplier as a partner, or creates one. Returns the supplier row. */
export async function makePartner(
  input: PartnerInput,
  actorId: string | null,
  tx: Prisma.TransactionClient = prisma,
) {
  if (input.supplierId) {
    const existing = await tx.supplier.findUnique({ where: { id: input.supplierId } });
    if (!existing) throw badRequest('That supplier does not exist');
    return tx.supplier.update({
      where: { id: existing.id },
      data: {
        isPartner: true,
        ...(input.brand !== undefined ? { brand: input.brand || null } : {}),
        ...(input.partnerSince !== undefined ? { partnerSince: input.partnerSince ?? null } : {}),
      },
    });
  }

  // A partner takes a supplier code — it is a supplier. No numbering type of
  // its own.
  const code = input.code || (await nextNumber('supplier', tx));
  if (await tx.supplier.findUnique({ where: { code } })) {
    throw conflict(`Supplier code "${code}" is already in use`);
  }
  return tx.supplier.create({
    data: {
      code,
      name: input.name!,
      brand: input.brand || null,
      legalName: input.legalName || null,
      tin: input.tin || null,
      category: input.category || null,
      website: input.website || null,
      phone: input.phone || null,
      email: input.email || null,
      address: input.address || null,
      city: input.city || null,
      notes: input.notes || null,
      partnerSince: input.partnerSince ?? null,
      isPartner: true,
      isActive: true,
      createdById: actorId,
      contacts: input.contact?.name
        ? {
            create: [
              {
                name: input.contact.name,
                position: input.contact.position || null,
                email: input.contact.email || null,
                mobile: input.contact.mobile || null,
                isPrimary: true,
              },
            ],
          }
        : undefined,
    },
  });
}

/**
 * Removing a partner keeps the supplier, its purchase history and its
 * resources; re-flagging brings the resources back. Resource-level Delete is
 * the purge.
 */
export async function unflagPartner(id: string, tx: Prisma.TransactionClient = prisma) {
  return tx.supplier.update({ where: { id }, data: { isPartner: false } });
}

export interface ResourceAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  uploadedAt: Date;
}

/** The attachment (at most one) behind each resource id. */
async function attachmentsFor(resourceIds: string[]): Promise<Map<string, ResourceAttachment>> {
  const map = new Map<string, ResourceAttachment>();
  if (!resourceIds.length) return map;
  const rows = await prisma.attachment.findMany({
    where: { entityType: PARTNER_RESOURCE_ENTITY, entityId: { in: resourceIds } },
    select: { id: true, entityId: true, fileName: true, mimeType: true, size: true, uploadedAt: true },
    orderBy: { uploadedAt: 'desc' },
  });
  for (const r of rows) {
    if (!map.has(r.entityId)) {
      map.set(r.entityId, {
        id: r.id,
        fileName: r.fileName,
        mimeType: r.mimeType,
        size: r.size,
        uploadedAt: r.uploadedAt,
      });
    }
  }
  return map;
}

export async function resourceWithFile(resourceId: string) {
  const row = await prisma.partnerResource.findUnique({ where: { id: resourceId } });
  if (!row) return null;
  const files = await attachmentsFor([row.id]);
  return { ...row, attachment: files.get(row.id) ?? null };
}

/** Everything the Partner page shows. Null when the supplier is not a partner. */
export async function partnerDetail(id: string) {
  const supplier = await prisma.supplier.findFirst({
    where: { id, isPartner: true },
    include: {
      contacts: { orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }] },
      createdBy: { select: { id: true, name: true } },
      resources: {
        orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }, { title: 'asc' }],
        include: { createdBy: { select: { id: true, name: true } } },
      },
    },
  });
  if (!supplier) return null;

  const files = await attachmentsFor(supplier.resources.map((r) => r.id));
  const resources = supplier.resources.map((r) => ({ ...r, attachment: files.get(r.id) ?? null }));

  const pricedItems = await prisma.item.count({
    where: { preferredSupplierId: id, isActive: true, listPrice: { not: null } },
  });
  const active = resources.filter((r) => r.isActive);
  const counts = {
    catalogues: active.filter((r) => r.kind === 'CATALOGUE').length,
    priceLists: active.filter((r) => r.kind === 'PRICE_LIST').length,
    sizingApps: active.filter((r) => r.kind === 'SIZING_APP').length,
    pricedItems,
  };

  return { ...supplier, resources, counts };
}

/**
 * The partner's price list: items that name it as preferred supplier.
 *
 * A strict `select`, never `include`. standardCost and lastCost are COSTS,
 * gated by gchain.items which a salesperson does not hold; listPrice is a
 * PRICE, which is what this screen may show. Switching this to `include`
 * reintroduces the leak the verify case checks for.
 */
export async function partnerPriceList(id: string, q: ListQuery) {
  const where: Prisma.ItemWhereInput = { preferredSupplierId: id };
  if (q.filters.isActive) where.isActive = q.filters.isActive === 'true';
  if (q.filters.priced === 'true') where.listPrice = { not: null };
  if (q.search) {
    where.OR = [
      { code: { contains: q.search, mode: 'insensitive' } },
      { partNumber: { contains: q.search, mode: 'insensitive' } },
      { name: { contains: q.search, mode: 'insensitive' } },
      { description: { contains: q.search, mode: 'insensitive' } },
    ];
  }

  const [rows, total] = await Promise.all([
    prisma.item.findMany({
      where,
      select: {
        id: true,
        code: true,
        partNumber: true,
        name: true,
        description: true,
        unit: true,
        itemType: true,
        isActive: true,
        listPrice: true,
        listPriceCurrency: true,
        listPriceAsOf: true,
        category: { select: { name: true } },
      },
      orderBy: orderBy(q, ['code', 'name', 'listPrice', 'listPriceAsOf'], { name: 'asc' }),
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
    prisma.item.count({ where }),
  ]);

  return {
    rows: rows.map((r) => ({ ...r, listPrice: r.listPrice == null ? null : Number(r.listPrice) })),
    total,
  };
}

/** One file per resource: a new upload replaces whatever was there. */
export async function replaceResourceFile(
  resourceId: string,
  file: Express.Multer.File,
  uploadedById: string,
) {
  const existing = await prisma.attachment.findMany({
    where: { entityType: PARTNER_RESOURCE_ENTITY, entityId: resourceId },
    select: { id: true },
  });
  for (const a of existing) await deleteAttachment(a.id);
  return saveAttachment({ entityType: PARTNER_RESOURCE_ENTITY, entityId: resourceId, file, uploadedById });
}

export async function removeResourceFile(resourceId: string): Promise<void> {
  const existing = await prisma.attachment.findMany({
    where: { entityType: PARTNER_RESOURCE_ENTITY, entityId: resourceId },
    select: { id: true },
  });
  for (const a of existing) await deleteAttachment(a.id);
}

export function humanKind(kind: string): string {
  switch (kind) {
    case 'CATALOGUE':
      return 'Catalogue';
    case 'PRICE_LIST':
      return 'Price list';
    case 'SIZING_APP':
      return 'Sizing app';
    default:
      return 'Document';
  }
}
