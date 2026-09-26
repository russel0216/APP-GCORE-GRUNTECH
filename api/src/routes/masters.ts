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
import { audit } from '../shared/audit';
import { nextNumber } from '../shared/numbering';

// The employee routes live in ./employees; re-exported here so the mount in
// index.ts keeps resolving until it imports them from their own module.
export { employeeRoutes } from './employees';

// ════════════════════════════════════════════════════════════════════
//  SUPPLIERS
// ════════════════════════════════════════════════════════════════════

export const supplierRoutes = Router();
supplierRoutes.use(authenticate);

supplierRoutes.get(
  '/',
  require_('gchain.suppliers.view_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const where: Prisma.SupplierWhereInput = {};

    if (q.search) {
      where.OR = [
        { name: { contains: q.search, mode: 'insensitive' } },
        { code: { contains: q.search, mode: 'insensitive' } },
        { category: { contains: q.search, mode: 'insensitive' } },
        { tin: { contains: q.search, mode: 'insensitive' } },
        { contacts: { some: { name: { contains: q.search, mode: 'insensitive' } } } },
      ];
    }
    if (q.filters.isActive) where.isActive = q.filters.isActive === 'true';
    if (q.filters.category) where.category = q.filters.category;
    if (q.scope === 'mine') where.createdById = me.id;

    const [rows, total] = await Promise.all([
      prisma.supplier.findMany({
        where,
        include: { _count: { select: { contacts: true } } },
        orderBy: orderBy(q, ['code', 'name', 'createdAt'], { name: 'asc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.supplier.count({ where }),
    ]);

    res.json(
      listResult(rows.map((r) => ({ ...r, contactCount: r._count.contacts })), total, q),
    );
  }),
);

supplierRoutes.get(
  '/lookup',
  require_('gchain.suppliers.view_all'),
  handler(async (req, res) => {
    const term = String(req.query.q ?? '').trim();
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
        take: 25,
      }),
    );
  }),
);

supplierRoutes.get(
  '/:id',
  require_('gchain.suppliers.view_all'),
  handler(async (req, res) => {
    const supplier = await prisma.supplier.findUnique({
      where: { id: req.params.id },
      include: {
        contacts: { orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }] },
        createdBy: { select: { id: true, name: true } },
      },
    });
    if (!supplier) throw notFound('Supplier not found');
    res.json({
      ...supplier,
      // Filled by Phase 5 (POs, receiving) and Phase 7 (payables).
      purchaseOrders: [],
      receivings: [],
      bills: [],
    });
  }),
);

const supplierSchema = z.object({
  code: z.string().trim().optional(),
  name: z.string().trim().min(2, 'Supplier name is required'),
  legalName: z.string().trim().optional().nullable(),
  tin: z.string().trim().optional().nullable(),
  category: z.string().trim().optional().nullable(),
  paymentTerms: z.string().trim().optional().nullable(),
  address: z.string().trim().optional().nullable(),
  city: z.string().trim().optional().nullable(),
  phone: z.string().trim().optional().nullable(),
  email: z.string().trim().email('Enter a valid email').optional().nullable().or(z.literal('')),
  website: z.string().trim().optional().nullable(),
  notes: z.string().optional().nullable(),
  isActive: z.boolean().default(true),
});

supplierRoutes.post(
  '/',
  require_('gchain.suppliers.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(supplierSchema, req.body);

    const supplier = await prisma.$transaction(async (tx) => {
      const code = body.code || (await nextNumber('supplier', tx));
      if (await tx.supplier.findUnique({ where: { code } })) {
        throw conflict(`Supplier code "${code}" is already in use`);
      }
      return tx.supplier.create({
        data: {
          code,
          name: body.name,
          legalName: body.legalName || null,
          tin: body.tin || null,
          category: body.category || null,
          paymentTerms: body.paymentTerms || null,
          address: body.address || null,
          city: body.city || null,
          phone: body.phone || null,
          email: body.email || null,
          website: body.website || null,
          notes: body.notes || null,
          isActive: body.isActive,
          createdById: me.id,
        },
      });
    });

    await audit(
      {
        entityType: 'supplier',
        entityId: supplier.id,
        action: 'CREATED',
        summary: `Created supplier ${supplier.code} — ${supplier.name}`,
      },
      req,
    );
    res.status(201).json(supplier);
  }),
);

supplierRoutes.patch(
  '/:id',
  require_('gchain.suppliers.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(supplierSchema.partial(), req.body);
    const before = await prisma.supplier.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound('Supplier not found');

    if (body.code && body.code !== before.code) {
      if (await prisma.supplier.findUnique({ where: { code: body.code } })) {
        throw conflict(`Supplier code "${body.code}" is already in use`);
      }
    }

    const data: Prisma.SupplierUpdateInput = {};
    for (const key of [
      'code',
      'name',
      'legalName',
      'tin',
      'category',
      'paymentTerms',
      'address',
      'city',
      'phone',
      'email',
      'website',
      'notes',
    ] as const) {
      if (body[key] !== undefined) (data as Record<string, unknown>)[key] = body[key] || null;
    }
    if (body.isActive !== undefined) data.isActive = body.isActive;

    const supplier = await prisma.supplier.update({ where: { id: req.params.id }, data });
    await audit(
      {
        entityType: 'supplier',
        entityId: supplier.id,
        action: 'UPDATED',
        summary: `Updated supplier ${supplier.code} — ${supplier.name}`,
        before,
        after: supplier,
      },
      req,
    );
    res.json(supplier);
  }),
);

supplierRoutes.delete(
  '/:id',
  require_('gchain.suppliers.delete'),
  handler(async (req, res) => {
    const supplier = await prisma.supplier.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { preferredItems: true } } },
    });
    if (!supplier) throw notFound('Supplier not found');
    if (supplier._count.preferredItems > 0) {
      throw badRequest(
        `${supplier._count.preferredItems} item(s) name this as their preferred supplier — clear those first, or deactivate instead`,
      );
    }

    await prisma.supplier.delete({ where: { id: req.params.id } });
    await audit(
      {
        entityType: 'supplier',
        entityId: req.params.id,
        action: 'DELETED',
        summary: `Deleted supplier ${supplier.code} — ${supplier.name}`,
        before: supplier,
      },
      req,
    );
    res.json({ ok: true });
  }),
);

const supplierContactSchema = z.object({
  name: z.string().trim().min(2, 'Contact name is required'),
  position: z.string().trim().optional().nullable(),
  email: z.string().trim().email('Enter a valid email').optional().nullable().or(z.literal('')),
  phone: z.string().trim().optional().nullable(),
  mobile: z.string().trim().optional().nullable(),
  isPrimary: z.boolean().default(false),
  notes: z.string().optional().nullable(),
});

supplierRoutes.post(
  '/:id/contacts',
  require_('gchain.suppliers.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(supplierContactSchema, req.body);
    if (!(await prisma.supplier.findUnique({ where: { id: req.params.id } }))) {
      throw notFound('Supplier not found');
    }

    const contact = await prisma.$transaction(async (tx) => {
      if (body.isPrimary) {
        await tx.supplierContact.updateMany({
          where: { supplierId: req.params.id },
          data: { isPrimary: false },
        });
      }
      return tx.supplierContact.create({
        data: {
          supplierId: req.params.id,
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
    res.status(201).json(contact);
  }),
);

supplierRoutes.patch(
  '/:id/contacts/:contactId',
  require_('gchain.suppliers.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(supplierContactSchema.partial(), req.body);
    const contact = await prisma.$transaction(async (tx) => {
      const existing = await tx.supplierContact.findFirst({
        where: { id: req.params.contactId, supplierId: req.params.id },
      });
      if (!existing) throw notFound('Contact not found');
      if (body.isPrimary) {
        await tx.supplierContact.updateMany({
          where: { supplierId: req.params.id },
          data: { isPrimary: false },
        });
      }
      return tx.supplierContact.update({
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
    res.json(contact);
  }),
);

supplierRoutes.delete(
  '/:id/contacts/:contactId',
  require_('gchain.suppliers.edit_all'),
  handler(async (req, res) => {
    const contact = await prisma.supplierContact.findFirst({
      where: { id: req.params.contactId, supplierId: req.params.id },
    });
    if (!contact) throw notFound('Contact not found');
    await prisma.supplierContact.delete({ where: { id: req.params.contactId } });
    res.json({ ok: true });
  }),
);

// ════════════════════════════════════════════════════════════════════
//  ITEMS
// ════════════════════════════════════════════════════════════════════

export const itemRoutes = Router();
itemRoutes.use(authenticate);

function itemNumbers(row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  for (const f of ['standardCost', 'lastCost', 'minStock', 'reorderLevel']) {
    if (out[f] != null) out[f] = Number(out[f]);
  }
  return out;
}

itemRoutes.get(
  '/',
  require_('gchain.items.view_all'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const where: Prisma.ItemWhereInput = {};

    if (q.search) {
      where.OR = [
        { name: { contains: q.search, mode: 'insensitive' } },
        { code: { contains: q.search, mode: 'insensitive' } },
        { partNumber: { contains: q.search, mode: 'insensitive' } },
        { description: { contains: q.search, mode: 'insensitive' } },
      ];
    }
    if (q.filters.isActive) where.isActive = q.filters.isActive === 'true';
    if (q.filters.itemType) where.itemType = q.filters.itemType as Prisma.EnumItemTypeFilter['equals'];
    if (q.filters.categoryId) where.categoryId = q.filters.categoryId;
    if (q.filters.costCategoryId) where.costCategoryId = q.filters.costCategoryId;

    const [rows, total] = await Promise.all([
      prisma.item.findMany({
        where,
        include: {
          category: { select: { id: true, name: true } },
          costCategory: { select: { id: true, code: true, name: true } },
          preferredSupplier: { select: { id: true, name: true } },
        },
        orderBy: orderBy(q, ['code', 'name', 'createdAt'], { name: 'asc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.item.count({ where }),
    ]);

    res.json(listResult(rows.map((r) => itemNumbers(r) as typeof r), total, q));
  }),
);

itemRoutes.get(
  '/lookup',
  require_('gchain.items.view_all'),
  handler(async (req, res) => {
    const term = String(req.query.q ?? '').trim();
    res.json(
      await prisma.item.findMany({
        where: {
          isActive: true,
          ...(term
            ? {
                OR: [
                  { name: { contains: term, mode: 'insensitive' } },
                  { code: { contains: term, mode: 'insensitive' } },
                  { partNumber: { contains: term, mode: 'insensitive' } },
                ],
              }
            : {}),
        },
        select: { id: true, code: true, name: true, unit: true, standardCost: true },
        orderBy: { name: 'asc' },
        take: 25,
      }),
    );
  }),
);

itemRoutes.get(
  '/:id',
  require_('gchain.items.view_all'),
  handler(async (req, res) => {
    const item = await prisma.item.findUnique({
      where: { id: req.params.id },
      include: {
        category: { select: { id: true, name: true } },
        costCategory: { select: { id: true, code: true, name: true } },
        preferredSupplier: { select: { id: true, name: true } },
      },
    });
    if (!item) throw notFound('Item not found');
    res.json({ ...itemNumbers(item), stockBalances: [], movements: [] });
  }),
);

const ITEM_TYPES = ['MATERIAL', 'EQUIPMENT', 'CONSUMABLE', 'SERVICE', 'TOOL'] as const;

const itemSchema = z.object({
  code: z.string().trim().optional(),
  partNumber: z.string().trim().optional().nullable(),
  name: z.string().trim().min(2, 'Item name is required'),
  description: z.string().optional().nullable(),
  itemType: z.enum(ITEM_TYPES).default('MATERIAL'),
  categoryId: z.string().optional().nullable(),
  costCategoryId: z.string().optional().nullable(),
  unit: z.string().trim().min(1).default('pcs'),
  standardCost: z.number().nonnegative().optional().nullable(),
  isStocked: z.boolean().default(true),
  minStock: z.number().nonnegative().optional().nullable(),
  reorderLevel: z.number().nonnegative().optional().nullable(),
  preferredSupplierId: z.string().optional().nullable(),
  isActive: z.boolean().default(true),
  notes: z.string().optional().nullable(),
});

const dec = (v: number | null | undefined) => (v != null ? new Prisma.Decimal(v) : null);

itemRoutes.post(
  '/',
  require_('gchain.items.create'),
  handler(async (req, res) => {
    const body = parseBody(itemSchema, req.body);

    const item = await prisma.$transaction(async (tx) => {
      const code = body.code || (await nextNumber('item', tx));
      if (await tx.item.findUnique({ where: { code } })) {
        throw conflict(`Item code "${code}" is already in use`);
      }
      return tx.item.create({
        data: {
          code,
          partNumber: body.partNumber || null,
          name: body.name,
          description: body.description || null,
          itemType: body.itemType,
          categoryId: body.categoryId || null,
          costCategoryId: body.costCategoryId || null,
          unit: body.unit,
          standardCost: dec(body.standardCost),
          isStocked: body.isStocked,
          minStock: dec(body.minStock),
          reorderLevel: dec(body.reorderLevel),
          preferredSupplierId: body.preferredSupplierId || null,
          isActive: body.isActive,
          notes: body.notes || null,
        },
      });
    });

    await audit(
      {
        entityType: 'item',
        entityId: item.id,
        action: 'CREATED',
        summary: `Created item ${item.code} — ${item.name}`,
      },
      req,
    );
    res.status(201).json(itemNumbers(item));
  }),
);

itemRoutes.patch(
  '/:id',
  require_('gchain.items.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(itemSchema.partial(), req.body);
    const before = await prisma.item.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound('Item not found');

    if (body.code && body.code !== before.code) {
      if (await prisma.item.findUnique({ where: { code: body.code } })) {
        throw conflict(`Item code "${body.code}" is already in use`);
      }
    }

    const data: Record<string, unknown> = {};
    for (const f of ['code', 'partNumber', 'name', 'description', 'notes'] as const) {
      if (body[f] !== undefined) data[f] = body[f] || null;
    }
    for (const f of ['categoryId', 'costCategoryId', 'preferredSupplierId'] as const) {
      if (body[f] !== undefined) data[f] = body[f] || null;
    }
    if (body.itemType !== undefined) data.itemType = body.itemType;
    if (body.unit !== undefined) data.unit = body.unit;
    if (body.isStocked !== undefined) data.isStocked = body.isStocked;
    if (body.isActive !== undefined) data.isActive = body.isActive;
    for (const f of ['standardCost', 'minStock', 'reorderLevel'] as const) {
      if (body[f] !== undefined) data[f] = dec(body[f]);
    }

    const item = await prisma.item.update({ where: { id: req.params.id }, data });
    await audit(
      {
        entityType: 'item',
        entityId: item.id,
        action: 'UPDATED',
        summary: `Updated item ${item.code} — ${item.name}`,
        before,
        after: item,
      },
      req,
    );
    res.json(itemNumbers(item));
  }),
);

itemRoutes.delete(
  '/:id',
  require_('gchain.items.delete'),
  handler(async (req, res) => {
    const item = await prisma.item.findUnique({ where: { id: req.params.id } });
    if (!item) throw notFound('Item not found');
    await prisma.item.delete({ where: { id: req.params.id } });
    await audit(
      {
        entityType: 'item',
        entityId: req.params.id,
        action: 'DELETED',
        summary: `Deleted item ${item.code} — ${item.name}`,
      },
      req,
    );
    res.json({ ok: true });
  }),
);

// ════════════════════════════════════════════════════════════════════
//  REFERENCE DATA — cost categories, item categories, warehouses
// ════════════════════════════════════════════════════════════════════

export const referenceRoutes = Router();
referenceRoutes.use(authenticate);

referenceRoutes.get(
  '/cost-categories',
  handler(async (_req, res) => {
    res.json(await prisma.costCategory.findMany({ orderBy: { sortOrder: 'asc' } }));
  }),
);

const costCategorySchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(2),
  sortOrder: z.number().int().default(0),
  isActive: z.boolean().default(true),
});

referenceRoutes.post(
  '/cost-categories',
  require_('admin.categories.create'),
  handler(async (req, res) => {
    const body = parseBody(costCategorySchema, req.body);
    if (await prisma.costCategory.findUnique({ where: { code: body.code } })) {
      throw conflict(`Cost category "${body.code}" already exists`);
    }
    const created = await prisma.costCategory.create({ data: body });
    await audit(
      {
        entityType: 'cost_category',
        entityId: created.id,
        action: 'CREATED',
        summary: `Created cost category ${created.name}`,
      },
      req,
    );
    res.status(201).json(created);
  }),
);

referenceRoutes.patch(
  '/cost-categories/:id',
  require_('admin.categories.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(costCategorySchema.partial(), req.body);
    const before = await prisma.costCategory.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound('Cost category not found');
    // A system category's code is the key the cost ledger groups by; renaming
    // the label is fine, changing the code is not.
    if (before.isSystem && body.code && body.code !== before.code) {
      throw badRequest('A system cost category keeps its code — you can rename it instead');
    }
    const updated = await prisma.costCategory.update({ where: { id: req.params.id }, data: body });
    await audit(
      {
        entityType: 'cost_category',
        entityId: updated.id,
        action: 'UPDATED',
        summary: `Updated cost category ${updated.name}`,
      },
      req,
    );
    res.json(updated);
  }),
);

referenceRoutes.delete(
  '/cost-categories/:id',
  require_('admin.categories.delete'),
  handler(async (req, res) => {
    const category = await prisma.costCategory.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { items: true } } },
    });
    if (!category) throw notFound('Cost category not found');
    if (category.isSystem) {
      throw badRequest(
        'The five standard cost categories cannot be deleted — every costing, budget and cost-ledger row is grouped by them',
      );
    }
    if (category._count.items > 0) {
      throw badRequest(`${category._count.items} item(s) still use this category`);
    }
    await prisma.costCategory.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  }),
);

referenceRoutes.get(
  '/item-categories',
  handler(async (_req, res) => {
    res.json(
      await prisma.itemCategory.findMany({
        include: { _count: { select: { items: true } } },
        orderBy: { name: 'asc' },
      }),
    );
  }),
);

const itemCategorySchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(2),
  parentId: z.string().optional().nullable(),
});

referenceRoutes.post(
  '/item-categories',
  require_('admin.categories.create'),
  handler(async (req, res) => {
    const body = parseBody(itemCategorySchema, req.body);
    if (await prisma.itemCategory.findUnique({ where: { code: body.code } })) {
      throw conflict(`Item category "${body.code}" already exists`);
    }
    res.status(201).json(
      await prisma.itemCategory.create({
        data: { code: body.code, name: body.name, parentId: body.parentId || null },
      }),
    );
  }),
);

referenceRoutes.patch(
  '/item-categories/:id',
  require_('admin.categories.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(itemCategorySchema.partial(), req.body);
    if (body.parentId === req.params.id) {
      throw badRequest('A category cannot be its own parent');
    }
    res.json(
      await prisma.itemCategory.update({
        where: { id: req.params.id },
        data: {
          ...(body.code !== undefined ? { code: body.code } : {}),
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.parentId !== undefined ? { parentId: body.parentId || null } : {}),
        },
      }),
    );
  }),
);

referenceRoutes.delete(
  '/item-categories/:id',
  require_('admin.categories.delete'),
  handler(async (req, res) => {
    const category = await prisma.itemCategory.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { items: true, children: true } } },
    });
    if (!category) throw notFound('Item category not found');
    if (category._count.items > 0) {
      throw badRequest(`${category._count.items} item(s) still use this category`);
    }
    if (category._count.children > 0) {
      throw badRequest('Remove or move the sub-categories first');
    }
    await prisma.itemCategory.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  }),
);

// ── Warehouses ───────────────────────────────────────────────────────────────

export const warehouseRoutes = Router();
warehouseRoutes.use(authenticate);

warehouseRoutes.get(
  '/',
  require_('gchain.warehouses.view_all'),
  handler(async (_req, res) => {
    res.json(
      await prisma.warehouse.findMany({
        include: { locations: { orderBy: { code: 'asc' } } },
        orderBy: { name: 'asc' },
      }),
    );
  }),
);

const warehouseSchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(2),
  address: z.string().trim().optional().nullable(),
  city: z.string().trim().optional().nullable(),
  isActive: z.boolean().default(true),
});

warehouseRoutes.post(
  '/',
  require_('gchain.warehouses.create'),
  handler(async (req, res) => {
    const body = parseBody(warehouseSchema, req.body);
    if (await prisma.warehouse.findUnique({ where: { code: body.code } })) {
      throw conflict(`Warehouse "${body.code}" already exists`);
    }
    const created = await prisma.warehouse.create({
      data: { ...body, address: body.address || null, city: body.city || null },
    });
    await audit(
      {
        entityType: 'warehouse',
        entityId: created.id,
        action: 'CREATED',
        summary: `Created warehouse ${created.code} — ${created.name}`,
      },
      req,
    );
    res.status(201).json(created);
  }),
);

warehouseRoutes.patch(
  '/:id',
  require_('gchain.warehouses.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(warehouseSchema.partial(), req.body);
    res.json(
      await prisma.warehouse.update({
        where: { id: req.params.id },
        data: {
          ...(body.code !== undefined ? { code: body.code } : {}),
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.address !== undefined ? { address: body.address || null } : {}),
          ...(body.city !== undefined ? { city: body.city || null } : {}),
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        },
      }),
    );
  }),
);

warehouseRoutes.delete(
  '/:id',
  require_('gchain.warehouses.delete'),
  handler(async (req, res) => {
    const warehouse = await prisma.warehouse.findUnique({ where: { id: req.params.id } });
    if (!warehouse) throw notFound('Warehouse not found');
    await prisma.warehouse.delete({ where: { id: req.params.id } });
    await audit(
      {
        entityType: 'warehouse',
        entityId: req.params.id,
        action: 'DELETED',
        summary: `Deleted warehouse ${warehouse.code}`,
      },
      req,
    );
    res.json({ ok: true });
  }),
);

warehouseRoutes.post(
  '/:id/locations',
  require_('gchain.warehouses.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(
      z.object({ code: z.string().trim().min(1), name: z.string().trim().optional().nullable() }),
      req.body,
    );
    const clash = await prisma.location.findFirst({
      where: { warehouseId: req.params.id, code: body.code },
    });
    if (clash) throw conflict(`Location "${body.code}" already exists in this warehouse`);

    res.status(201).json(
      await prisma.location.create({
        data: { warehouseId: req.params.id, code: body.code, name: body.name || null },
      }),
    );
  }),
);

warehouseRoutes.delete(
  '/:id/locations/:locationId',
  require_('gchain.warehouses.edit_all'),
  handler(async (req, res) => {
    const location = await prisma.location.findFirst({
      where: { id: req.params.locationId, warehouseId: req.params.id },
    });
    if (!location) throw notFound('Location not found');
    await prisma.location.delete({ where: { id: req.params.locationId } });
    res.json({ ok: true });
  }),
);
