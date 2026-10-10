import { Router } from 'express';
import { z } from 'zod';
import { Prisma, ItemType } from '@prisma/client';
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
  forbidden,
  idsFilter,
  type ListQuery,
} from '../http/kit';
import { authenticate, require_, currentUser } from '../auth/middleware';
import { can } from '../permissions/resolve';
import { audit } from '../shared/audit';
import { groupKey } from '../shared/quotationGroups';
import { activityTypeKey } from '../shared/activityTypes';
import { nextNumber } from '../shared/numbering';
import { manilaDayEnd, manilaDayStart } from '../shared/day';
import { companyCurrency, formatAmount, formatMoney, formatShortDate, renderDocument, statusLabel } from '../shared/pdf';
import { categoryTabWhere, categoryTabs } from '../shared/supplierCategories';

// The employee routes live in ./employees; re-exported here so the mount in
// index.ts keeps resolving until it imports them from their own module.
export { employeeRoutes } from './employees';

// ════════════════════════════════════════════════════════════════════
//  SUPPLIERS
// ════════════════════════════════════════════════════════════════════

export const supplierRoutes = Router();
supplierRoutes.use(authenticate);

// ── List (the quotation list's layout, 2026-10-08) ───────────────────────────

const SUPPLIER_SORTS = ['code', 'name', 'createdAt'];
const SUPPLIER_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** An order actually placed with the supplier — "Ordered from" and the Orders column. */
const PLACED_PO: Prisma.PurchaseOrderWhereInput = { status: { in: ['ISSUED', 'PARTIALLY_RECEIVED', 'RECEIVED'] } };
/** Placed and not yet delivered in full — the purchase order list's `?awaiting=true`. */
const AWAITING_PO: Prisma.PurchaseOrderWhereInput = { status: { in: ['ISSUED', 'PARTIALLY_RECEIVED'] } };
const ORDER_FILTERS = ['awaiting', 'placed', 'never'] as const;

function supplierDay(value: string | undefined, label: string): string | null {
  if (!value) return null;
  if (!SUPPLIER_DAY.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw badRequest(`${label} is a date written YYYY-MM-DD`);
  return value;
}

/** The most rows a printed list carries; the reference says when it was cut. */
const LIST_CAP = 1000;

/**
 * A printed list's reference: "12 suppliers", or, cut at the cap, "first
 * 1,000 of 1,234 suppliers printed" — then every filter that narrowed it.
 */
function listReference(count: number, printed: number, noun: readonly [string, string], filters: (string | null | false | undefined)[]): string {
  const n = (v: number) => v.toLocaleString('en-PH');
  const head = count > printed ? `first ${n(printed)} of ${n(count)} ${noun[1]} printed` : `${n(count)} ${count === 1 ? noun[0] : noun[1]}`;
  const named = filters.filter(Boolean);
  return named.length ? `${head} — ${named.join(' · ')}` : head;
}

/**
 * Which suppliers a list query means — ONE rule for the list, its summary
 * (the "What they supply" tabs) and its PDF. `base` is everything but the
 * category tab, which is `categoryTabWhere()`, the partner list's rule too.
 * The purchase-order filter is Supplier 360's window: only for a caller who
 * may open purchase orders (`mayOrders`), a 403 otherwise.
 */
export function supplierListWhere(
  me: ReturnType<typeof currentUser>,
  q: ReturnType<typeof listQuery>,
  mayOrders: boolean,
): { base: Prisma.SupplierWhereInput; where: Prisma.SupplierWhereInput } {
  const and: Prisma.SupplierWhereInput[] = [];
  if (q.search) {
    and.push({
      OR: [
        { name: { contains: q.search, mode: 'insensitive' } },
        { code: { contains: q.search, mode: 'insensitive' } },
        { legalName: { contains: q.search, mode: 'insensitive' } },
        { brand: { contains: q.search, mode: 'insensitive' } },
        { category: { contains: q.search, mode: 'insensitive' } },
        { tin: { contains: q.search, mode: 'insensitive' } },
        { contacts: { some: { name: { contains: q.search, mode: 'insensitive' } } } },
      ],
    });
  }
  const f = q.filters;
  if (f.isActive) {
    if (f.isActive !== 'true' && f.isActive !== 'false') throw badRequest('Status is true or false');
    and.push({ isActive: f.isActive === 'true' });
  }
  if (f.partner) {
    if (f.partner !== 'yes' && f.partner !== 'no') throw badRequest('Partner is yes or no');
    and.push({ isPartner: f.partner === 'yes' });
  }
  if (q.scope === 'mine') and.push({ createdById: me.id });
  if (f.createdById) and.push({ createdById: f.createdById });
  const from = supplierDay(f.createdFrom, 'Added from');
  const to = supplierDay(f.createdTo, 'Added to');
  if (from || to) {
    and.push({ createdAt: { ...(from ? { gte: manilaDayStart(from) } : {}), ...(to ? { lte: manilaDayEnd(to) } : {}) } });
  }
  if (f.orders) {
    if (!(ORDER_FILTERS as readonly string[]).includes(f.orders)) throw badRequest('Purchase orders is awaiting, placed or never');
    if (!mayOrders) throw forbidden('Filtering by purchase orders needs the right to open purchase orders');
    and.push(
      f.orders === 'awaiting'
        ? { purchaseOrders: { some: AWAITING_PO } }
        : f.orders === 'placed'
          ? { purchaseOrders: { some: PLACED_PO } }
          : { purchaseOrders: { none: PLACED_PO } },
    );
  }
  const ids = idsFilter(f.ids);
  if (ids) and.push({ id: { in: ids } });

  const base: Prisma.SupplierWhereInput = and.length ? { AND: and } : {};
  if (!f.category) return { base, where: base };
  return { base, where: { AND: [...and, categoryTabWhere(f.category)] } };
}

/**
 * The "What they supply" tabs with their counts under `base`, and the count,
 * partners and inactive under `where` — plus, for a caller who may open
 * purchase orders, how many have an order awaiting delivery (left out, never
 * sent as 0, for anybody else).
 */
export async function supplierListSummary(
  base: Prisma.SupplierWhereInput,
  where: Prisma.SupplierWhereInput,
  mayOrders: boolean,
) {
  const [{ tabs, tabCounts }, count, partners, inactive, awaiting] = await Promise.all([
    categoryTabs(base),
    prisma.supplier.count({ where }),
    prisma.supplier.count({ where: { AND: [where, { isPartner: true }] } }),
    prisma.supplier.count({ where: { AND: [where, { isActive: false }] } }),
    mayOrders ? prisma.supplier.count({ where: { AND: [where, { purchaseOrders: { some: AWAITING_PO } }] } }) : null,
  ]);
  return { tabs, tabCounts, count, partners, inactive, ...(awaiting === null ? {} : { awaiting }) };
}

/** The counts a list row carries — the order counts only where they may be seen. */
function supplierCounts(mayOrders: boolean) {
  return {
    _count: {
      select: {
        contacts: true,
        ...(mayOrders ? { purchaseOrders: { where: PLACED_PO } } : {}),
      },
    },
    ...(mayOrders ? { purchaseOrders: { where: AWAITING_PO, select: { id: true } } } : {}),
  } satisfies Prisma.SupplierInclude;
}

supplierRoutes.get(
  '/',
  require_('gchain.suppliers.view_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const mayOrders = can(me, 'gchain.purchase_orders.view_all');
    const { base, where } = supplierListWhere(me, q, mayOrders);

    const [rows, total, summary] = await Promise.all([
      prisma.supplier.findMany({
        where,
        include: { createdBy: { select: { id: true, name: true } }, ...supplierCounts(mayOrders) },
        orderBy: orderBy(q, SUPPLIER_SORTS, { name: 'asc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.supplier.count({ where }),
      supplierListSummary(base, where, mayOrders),
    ]);

    res.json({
      ...listResult(
        rows.map(({ _count, purchaseOrders, ...r }) => ({
          ...r,
          contactCount: _count.contacts,
          orderCount: mayOrders ? (_count as { purchaseOrders?: number }).purchaseOrders ?? 0 : null,
          awaitingCount: mayOrders ? (purchaseOrders ?? []).length : null,
        })),
        total,
        q,
      ),
      summary,
    });
  }),
);

/**
 * The supplier list on paper — the list as filtered (or the rows ticked,
 * `?ids=`), through `supplierListWhere`, so the paper is the screen. Above
 * `/:id`; audited as an export; capped at 1,000 rows. No TIN: a list leaves
 * the building more easily than a supplier record does. Order counts print
 * only for a caller who may open purchase orders.
 */
supplierRoutes.get(
  '/pdf',
  require_('gchain.suppliers.view_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const mayOrders = can(me, 'gchain.purchase_orders.view_all');
    const { base, where } = supplierListWhere(me, q, mayOrders);
    const [rows, summary] = await Promise.all([
      prisma.supplier.findMany({
        where,
        include: supplierCounts(mayOrders),
        orderBy: orderBy(q, SUPPLIER_SORTS, { name: 'asc' }),
        take: LIST_CAP,
      }),
      supplierListSummary(base, where, mayOrders),
    ]);
    const f = q.filters;
    // A Manila day the filter names ('YYYY-MM-DD'), as a list prints a date (MM/DD/YYYY).
    const listDay = (key: unknown) =>
      typeof key === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(key) ? formatShortDate(new Date(`${key}T00:00:00Z`)) : '…';
    const tabName = f.category === 'none' ? 'not stated' : summary.tabs.find((t) => t.value.toLowerCase() === String(f.category ?? '').trim().toLowerCase())?.label;
    const addedBy = f.createdById ? await prisma.user.findUnique({ where: { id: f.createdById }, select: { name: true } }) : null;
    const reference = listReference(summary.count, rows.length, ['supplier', 'suppliers'], [
      q.search && `search "${q.search}"`,
      f.category && `supplies ${tabName ?? f.category}`,
      f.isActive === 'true' ? 'active' : f.isActive === 'false' && 'inactive',
      f.partner === 'yes' ? 'partners' : f.partner === 'no' && 'not partners',
      f.createdById && `added by ${addedBy?.name ?? 'one person'}`,
      (f.createdFrom || f.createdTo) && `added ${listDay(f.createdFrom)} to ${listDay(f.createdTo)}`,
      f.orders === 'awaiting' ? 'with an order awaiting delivery' : f.orders === 'placed' ? 'ordered from' : f.orders === 'never' && 'never ordered from',
      q.scope === 'mine' && 'added by me',
      f.ids && 'the rows selected',
    ]);
    const placed = (r: (typeof rows)[number]) => String((r._count as { purchaseOrders?: number }).purchaseOrders ?? 0);
    const awaiting = (r: (typeof rows)[number]) => String(((r as { purchaseOrders?: unknown[] }).purchaseOrders ?? []).length);

    // Ten columns: landscape, each sized from what it holds (rule 6), so a
    // head is never broken mid-word and a code never split over two lines.
    const pdf = await renderDocument({
      title: 'Suppliers',
      date: new Date(),
      reference,
      landscape: true,
      sections: [
        {
          kind: 'table',
          head: ['Code', 'Supplier', 'Supplies', 'City', 'Terms', 'Contacts', ...(mayOrders ? ['Orders', 'Awaiting'] : []), 'Added', 'Status'],
          align: ['left', 'left', 'left', 'left', 'left', 'right', ...(mayOrders ? (['right', 'right'] as const) : []), 'left', 'left'],
          rows: rows.map((s) => [
            s.code,
            { title: s.name, body: s.legalName && s.legalName !== s.name ? s.legalName : undefined },
            s.category ?? '',
            s.city ?? '',
            s.paymentTerms ?? '',
            String(s._count.contacts),
            ...(mayOrders ? [placed(s), awaiting(s)] : []),
            formatShortDate(s.createdAt),
            s.isActive ? 'Active' : 'Inactive',
          ]),
        },
      ],
      signatories: [],
    });
    await audit(
      { entityType: 'supplier', entityId: 'list', action: 'EXPORTED', summary: `Exported the supplier list as PDF (${rows.length} supplier(s))` },
      req,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="suppliers.pdf"');
    res.send(pdf);
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

    /*
      Supplier 360 — the same rule as the customer page: each collection sits
      behind the permission of the screen it comes from and arrives empty when
      the caller cannot open that screen. A window onto those modules, never a
      way around them.
    */
    const me = currentUser(req);
    const supplierId = supplier.id;
    const [purchaseOrders, receivings, bills, payments] = await Promise.all([
      can(me, 'gchain.purchase_orders.view_all')
        ? prisma.purchaseOrder.findMany({
            where: { supplierId },
            orderBy: { orderDate: 'desc' },
            take: 50,
            select: {
              id: true,
              number: true,
              status: true,
              kind: true,
              orderDate: true,
              deliveryDate: true,
              total: true,
              job: { select: { id: true, number: true, name: true } },
            },
          })
        : [],
      can(me, 'gchain.receiving.view_all')
        ? prisma.receiving.findMany({
            where: { order: { supplierId } },
            orderBy: { receivedDate: 'desc' },
            take: 50,
            select: {
              id: true,
              number: true,
              receivedDate: true,
              deliveryRefNo: true,
              order: { select: { id: true, number: true } },
              receivedBy: { select: { id: true, name: true } },
              _count: { select: { items: true } },
            },
          })
        : [],
      can(me, 'gfin.ap.view_all')
        ? prisma.supplierBill.findMany({
            where: { supplierId },
            orderBy: { billDate: 'desc' },
            take: 50,
            select: {
              id: true,
              number: true,
              status: true,
              billDate: true,
              dueDate: true,
              supplierInvoiceNo: true,
              total: true,
              netPayable: true,
              amountPaid: true,
            },
          })
        : [],
      can(me, 'gfin.payments.view_all') || can(me, 'gfin.ap.view_all')
        ? prisma.payment.findMany({
            where: { supplierId },
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
    ]);

    res.json({
      ...supplier,
      purchaseOrders: purchaseOrders.map((o) => ({ ...o, total: Number(o.total) })),
      receivings: receivings.map((r) => ({ ...r, lineCount: r._count.items })),
      bills: bills.map((b) => ({
        ...b,
        total: Number(b.total),
        netPayable: Number(b.netPayable),
        amountPaid: Number(b.amountPaid),
        outstanding: Number(b.netPayable) - Number(b.amountPaid),
      })),
      payments: payments.map((p) => ({ ...p, amount: Number(p.amount) })),
    });
  }),
);

const supplierSchema = z.object({
  code: z.string().trim().optional(),
  name: z.string().trim().min(2, 'Supplier name is required'),
  legalName: z.string().trim().optional().nullable(),
  tin: z.string().trim().optional().nullable(),
  // Partner fields procurement may correct. `isPartner` itself is NOT
  // accepted here — the flag has one owner, /api/partners, so "who made this
  // a partner" is auditable in one place.
  brand: z.string().trim().optional().nullable(),
  partnerSince: z.coerce.date().optional().nullable(),
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
          brand: body.brand || null,
          partnerSince: body.partnerSince ?? null,
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
      'brand',
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
    if (body.partnerSince !== undefined) data.partnerSince = body.partnerSince ?? null;
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
    // Deleting cascades its catalogues and price lists, which G-CHAIN never
    // shows — refuse while Sales still lists it as a partner.
    if (supplier.isPartner) {
      throw badRequest(
        'This supplier is a Sales partner — remove it from G-OPS › Partners first, or deactivate it',
      );
    }
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
  for (const f of ['standardCost', 'lastCost', 'listPrice', 'minStock', 'reorderLevel']) {
    if (out[f] != null) out[f] = Number(out[f]);
  }
  return out;
}

const ITEM_SORTS = ['code', 'name', 'createdAt'];

/** Which items a list query means — one rule for the list and its printed twin. */
export function itemListWhere(q: ListQuery): Prisma.ItemWhereInput {
  const and: Prisma.ItemWhereInput[] = [];
  const f = q.filters;
  if (q.search) {
    and.push({
      OR: [
        { name: { contains: q.search, mode: 'insensitive' } },
        { code: { contains: q.search, mode: 'insensitive' } },
        { partNumber: { contains: q.search, mode: 'insensitive' } },
        { description: { contains: q.search, mode: 'insensitive' } },
      ],
    });
  }
  if (f.isActive) {
    if (f.isActive !== 'true' && f.isActive !== 'false') throw badRequest('Status is true or false');
    and.push({ isActive: f.isActive === 'true' });
  }
  if (f.itemType) {
    const types = Object.values(ItemType) as string[];
    if (!types.includes(f.itemType)) throw badRequest(`Type is one of ${types.join(', ')}`);
    and.push({ itemType: f.itemType as ItemType });
  }
  if (f.categoryId) and.push({ categoryId: f.categoryId });
  if (f.costCategoryId) and.push({ costCategoryId: f.costCategoryId });
  const ids = idsFilter(f.ids);
  if (ids) and.push({ id: { in: ids } });
  return and.length ? { AND: and } : {};
}

itemRoutes.get(
  '/',
  require_('gchain.items.view_all'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const where = itemListWhere(q);

    const [rows, total] = await Promise.all([
      prisma.item.findMany({
        where,
        include: {
          category: { select: { id: true, name: true } },
          costCategory: { select: { id: true, code: true, name: true } },
          preferredSupplier: { select: { id: true, name: true } },
        },
        orderBy: orderBy(q, ITEM_SORTS, { name: 'asc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.item.count({ where }),
    ]);

    res.json(listResult(rows.map((r) => itemNumbers(r) as typeof r), total, q));
  }),
);

/**
 * The item master on paper, through `itemListWhere` (or the rows ticked,
 * `?ids=`): the columns the screen shows to the same `gchain.items.view_all`
 * holder — the standard cost among them, never the last cost the screen does
 * not show. A list price is in its own currency, so it names it on each row.
 * Above `/:id`.
 */
itemRoutes.get(
  '/pdf',
  require_('gchain.items.view_all'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const where = itemListWhere(q);
    const f = q.filters;
    const [rows, count, currency, category, costCategory] = await Promise.all([
      prisma.item.findMany({
        where,
        select: {
          code: true,
          partNumber: true,
          name: true,
          itemType: true,
          unit: true,
          standardCost: true,
          listPrice: true,
          listPriceCurrency: true,
          reorderLevel: true,
          isActive: true,
          category: { select: { name: true } },
          costCategory: { select: { name: true } },
        },
        orderBy: orderBy(q, ITEM_SORTS, { name: 'asc' }),
        take: LIST_CAP,
      }),
      prisma.item.count({ where }),
      companyCurrency(),
      f.categoryId ? prisma.itemCategory.findUnique({ where: { id: f.categoryId }, select: { name: true } }) : null,
      f.costCategoryId ? prisma.costCategory.findUnique({ where: { id: f.costCategoryId }, select: { name: true } }) : null,
    ]);
    const reference = listReference(count, rows.length, ['item', 'items'], [
      q.search && `search "${q.search}"`,
      f.itemType && `type ${statusLabel(f.itemType)}`,
      f.categoryId && `category ${category?.name ?? 'not found'}`,
      f.costCategoryId && `cost bucket ${costCategory?.name ?? 'not found'}`,
      f.isActive === 'true' ? 'active' : f.isActive === 'false' && 'inactive',
      f.ids && 'the rows selected',
    ]);
    const quantity = (v: Prisma.Decimal) => new Intl.NumberFormat('en-PH', { maximumFractionDigits: 3 }).format(Number(v));

    // Ten columns: landscape, each sized from what it holds (rule 6).
    const pdf = await renderDocument({
      title: 'Item Master',
      date: new Date(),
      reference,
      landscape: true,
      sections: [
        {
          kind: 'table',
          head: ['Code', 'Item', 'Type', 'Category', 'Cost bucket', 'Unit', `Standard cost (${currency})`, 'List price', 'Reorder at', 'Status'],
          align: ['left', 'left', 'left', 'left', 'left', 'left', 'right', 'right', 'right', 'left'],
          rows: rows.map((i) => [
            i.code,
            { title: i.name, body: i.partNumber ?? undefined },
            statusLabel(i.itemType),
            i.category?.name ?? '',
            i.costCategory?.name ?? '',
            i.unit,
            i.standardCost == null ? '' : formatAmount(Number(i.standardCost)),
            i.listPrice == null ? '' : formatMoney(Number(i.listPrice), i.listPriceCurrency?.trim() || currency),
            i.reorderLevel == null ? '' : quantity(i.reorderLevel),
            i.isActive ? 'Active' : 'Inactive',
          ]),
        },
      ],
    });
    await audit(
      { entityType: 'item', entityId: 'list', action: 'EXPORTED', summary: `Exported the item master as PDF (${rows.length} item(s))` },
      req,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="items.pdf"');
    res.send(pdf);
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
        select: { id: true, code: true, name: true, unit: true, standardCost: true, listPrice: true },
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
  // The partner's published list price — a PRICE, shown to Sales, never a cost.
  listPrice: z.number().nonnegative().optional().nullable(),
  listPriceCurrency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, 'Currency is a three-letter code, e.g. USD')
    .optional()
    .nullable()
    .or(z.literal('')),
  listPriceAsOf: z.coerce.date().optional().nullable(),
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
          listPrice: dec(body.listPrice),
          listPriceCurrency: body.listPriceCurrency || null,
          listPriceAsOf: body.listPriceAsOf ?? null,
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
    for (const f of ['standardCost', 'listPrice', 'minStock', 'reorderLevel'] as const) {
      if (body[f] !== undefined) data[f] = dec(body[f]);
    }
    if (body.listPriceCurrency !== undefined) data.listPriceCurrency = body.listPriceCurrency || null;
    if (body.listPriceAsOf !== undefined) data.listPriceAsOf = body.listPriceAsOf ?? null;

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

// ── Industries: the sales TEAMS ──────────────────────────────────────────────
// The owner's five teams (2026-10-08: KAT, HIT, UIT, GIB, SIT) — a person's
// team is the Industry row on their employee record (shared/team.ts). Same
// shape as cost categories: seeded, system rows undeletable, labels editable.
// Any authenticated user may read them — the employee form and the quotation
// list's "Quotes by team" need the list under their own permissions alone.

referenceRoutes.get(
  '/industries',
  handler(async (req, res) => {
    const activeOnly = String(req.query.active ?? '') === 'true';
    res.json(
      await prisma.industry.findMany({
        where: activeOnly ? { isActive: true } : {},
        include: { _count: { select: { customers: true, employees: true } } },
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      }),
    );
  }),
);

const industrySchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2,4}$/, 'Two to four letters'),
  name: z.string().trim().min(2),
  sortOrder: z.number().int().default(0),
  isActive: z.boolean().default(true),
});

referenceRoutes.post(
  '/industries',
  require_('admin.categories.create'),
  handler(async (req, res) => {
    const body = parseBody(industrySchema, req.body);
    if (await prisma.industry.findUnique({ where: { code: body.code } })) {
      throw conflict(`Industry "${body.code}" already exists`);
    }
    const created = await prisma.industry.create({ data: body });
    await audit(
      {
        entityType: 'industry',
        entityId: created.id,
        action: 'CREATED',
        summary: `Created industry ${created.code} — ${created.name}`,
      },
      req,
    );
    res.status(201).json(created);
  }),
);

referenceRoutes.patch(
  '/industries/:id',
  require_('admin.categories.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(industrySchema.partial(), req.body);
    const before = await prisma.industry.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound('Industry not found');
    // Reports group by the code and the owner may put it in customer codes one
    // day; the label is free to change, the code of a standard row is not.
    if (before.isSystem && body.code && body.code !== before.code) {
      throw badRequest('A standard team keeps its code — you can rename it instead');
    }
    if (body.code && body.code !== before.code) {
      if (await prisma.industry.findUnique({ where: { code: body.code } })) {
        throw conflict(`Industry "${body.code}" already exists`);
      }
    }
    const updated = await prisma.industry.update({ where: { id: before.id }, data: body });
    await audit(
      {
        entityType: 'industry',
        entityId: updated.id,
        action: 'UPDATED',
        summary: `Updated industry ${updated.code} — ${updated.name}`,
        before,
        after: updated,
      },
      req,
    );
    res.json(updated);
  }),
);

referenceRoutes.delete(
  '/industries/:id',
  require_('admin.categories.delete'),
  handler(async (req, res) => {
    const industry = await prisma.industry.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { customers: true, employees: true } } },
    });
    if (!industry) throw notFound('Industry not found');
    if (industry.isSystem) {
      throw badRequest('The standard teams cannot be deleted — deactivate one instead');
    }
    if (industry._count.customers > 0) {
      throw badRequest(`${industry._count.customers} customer(s) still carry this industry`);
    }
    if (industry._count.employees > 0) {
      throw badRequest(`${industry._count.employees} employee(s) are on this team — move them first, or deactivate it`);
    }
    await prisma.industry.delete({ where: { id: industry.id } });
    await audit(
      {
        entityType: 'industry',
        entityId: industry.id,
        action: 'DELETED',
        summary: `Deleted industry ${industry.code} — ${industry.name}`,
        before: industry,
      },
      req,
    );
    res.json({ ok: true });
  }),
);

// ── Sub-industries ───────────────────────────────────────────────────────────
// Where a customer sits in the market (2026-10-08, the owner's eleven), typed
// in by hand on the customer and optional. Same contract as the teams: seeded
// system rows undeletable, names editable, and anyone signed in may read them
// — the customer form needs the list under gops.customers.* alone.

referenceRoutes.get(
  '/sub-industries',
  handler(async (req, res) => {
    const activeOnly = String(req.query.active ?? '') === 'true';
    res.json(
      await prisma.subIndustry.findMany({
        where: activeOnly ? { isActive: true } : {},
        include: { _count: { select: { customers: true } } },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
    );
  }),
);

const subIndustrySchema = z.object({
  name: z.string().trim().min(2, 'Give it a name'),
  sortOrder: z.number().int().default(0),
  isActive: z.boolean().default(true),
});

/** One sub-industry per spelling, case-blind — "hospital" and "Hospital" are one. */
async function subIndustryNameTaken(name: string, exceptId?: string): Promise<boolean> {
  const clash = await prisma.subIndustry.findFirst({
    where: { name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  return !!clash;
}

referenceRoutes.post(
  '/sub-industries',
  require_('admin.categories.create'),
  handler(async (req, res) => {
    const body = parseBody(subIndustrySchema, req.body);
    if (await subIndustryNameTaken(body.name)) throw conflict(`Sub-industry "${body.name}" already exists`);
    const created = await prisma.subIndustry.create({ data: body });
    await audit(
      { entityType: 'sub_industry', entityId: created.id, action: 'CREATED', summary: `Created sub-industry ${created.name}` },
      req,
    );
    res.status(201).json(created);
  }),
);

referenceRoutes.patch(
  '/sub-industries/:id',
  require_('admin.categories.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(subIndustrySchema.partial(), req.body);
    const before = await prisma.subIndustry.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound('Sub-industry not found');
    if (body.name && body.name !== before.name && (await subIndustryNameTaken(body.name, before.id))) {
      throw conflict(`Sub-industry "${body.name}" already exists`);
    }
    const updated = await prisma.subIndustry.update({ where: { id: before.id }, data: body });
    await audit(
      {
        entityType: 'sub_industry',
        entityId: updated.id,
        action: 'UPDATED',
        summary: `Updated sub-industry ${updated.name}`,
        before,
        after: updated,
      },
      req,
    );
    res.json(updated);
  }),
);

referenceRoutes.delete(
  '/sub-industries/:id',
  require_('admin.categories.delete'),
  handler(async (req, res) => {
    const row = await prisma.subIndustry.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { customers: true } } },
    });
    if (!row) throw notFound('Sub-industry not found');
    if (row.isSystem) throw badRequest('The standard sub-industries cannot be deleted — deactivate one instead');
    if (row._count.customers > 0) throw badRequest(`${row._count.customers} customer(s) still carry this sub-industry`);
    await prisma.subIndustry.delete({ where: { id: row.id } });
    await audit(
      { entityType: 'sub_industry', entityId: row.id, action: 'DELETED', summary: `Deleted sub-industry ${row.name}`, before: row },
      req,
    );
    res.json({ ok: true });
  }),
);

// ── Quotation groups ─────────────────────────────────────────────────────────
// SCORO's Group column as a list: what the quotation editor suggests and what
// Sales Analytics' "By group" names. A line keeps its group as text, so a
// group is never a reference a line points at — see shared/quotationGroups.ts.
// Any authenticated user may read the list: the quotation editor needs it.

referenceRoutes.get(
  '/quotation-groups',
  handler(async (req, res) => {
    const activeOnly = String(req.query.active ?? '') === 'true';
    const [groups, used] = await Promise.all([
      prisma.quotationGroup.findMany({
        where: activeOnly ? { isActive: true } : {},
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      prisma.quotationItem.groupBy({ by: ['group'], where: { group: { not: null } }, _count: { _all: true } }),
    ]);
    const lines = new Map<string, number>();
    for (const u of used) {
      const key = groupKey(u.group!);
      lines.set(key, (lines.get(key) ?? 0) + u._count._all);
    }
    res.json(groups.map((g) => ({ ...g, lineCount: lines.get(g.key) ?? 0 })));
  }),
);

const quotationGroupSchema = z.object({
  name: z.string().trim().min(1, 'Name the group').max(120),
  /** What the group covers — the dropdown's hint. */
  description: z.string().trim().max(200).optional().nullable(),
  /** The brand a line filed under it carries (pre-filled into the line's Brand box). */
  brand: z.string().trim().max(120).optional().nullable(),
  sortOrder: z.number().int().default(0),
  isActive: z.boolean().default(true),
});

referenceRoutes.post(
  '/quotation-groups',
  require_('admin.categories.create'),
  handler(async (req, res) => {
    const body = parseBody(quotationGroupSchema, req.body);
    const key = groupKey(body.name);
    if (await prisma.quotationGroup.findUnique({ where: { key } })) {
      throw conflict(`There is already a group "${body.name}"`);
    }
    const created = await prisma.quotationGroup.create({ data: { ...body, name: body.name.replace(/\s+/g, ' '), key } });
    await audit(
      { entityType: 'quotation_group', entityId: created.id, action: 'CREATED', summary: `Created quotation group "${created.name}"` },
      req,
    );
    res.status(201).json(created);
  }),
);

referenceRoutes.patch(
  '/quotation-groups/:id',
  require_('admin.categories.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(quotationGroupSchema.partial(), req.body);
    const before = await prisma.quotationGroup.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound('Quotation group not found');
    const data: Prisma.QuotationGroupUpdateInput = { ...body };
    if (body.name !== undefined) {
      const key = groupKey(body.name);
      if (key !== before.key && (await prisma.quotationGroup.findUnique({ where: { key } }))) {
        throw conflict(`There is already a group "${body.name}"`);
      }
      data.name = body.name.replace(/\s+/g, ' ');
      data.key = key;
    }
    const updated = await prisma.quotationGroup.update({ where: { id: before.id }, data });
    await audit(
      {
        entityType: 'quotation_group',
        entityId: updated.id,
        action: 'UPDATED',
        summary:
          before.name !== updated.name ? `Renamed quotation group "${before.name}" to "${updated.name}"` : `Updated quotation group "${updated.name}"`,
        before,
        after: updated,
      },
      req,
    );
    res.json(updated);
  }),
);

referenceRoutes.delete(
  '/quotation-groups/:id',
  require_('admin.categories.delete'),
  handler(async (req, res) => {
    const group = await prisma.quotationGroup.findUnique({ where: { id: req.params.id } });
    if (!group) throw notFound('Quotation group not found');
    // Lines keep the text, so deleting a used group would only see it added
    // back the next time one of those quotations is saved.
    const used = await prisma.quotationItem.count({ where: { group: { equals: group.name, mode: 'insensitive' } } });
    if (used > 0) throw badRequest(`${used} quotation line(s) are filed under "${group.name}" — deactivate it instead`);
    await prisma.quotationGroup.delete({ where: { id: group.id } });
    await audit(
      { entityType: 'quotation_group', entityId: group.id, action: 'DELETED', summary: `Deleted quotation group "${group.name}"`, before: group },
      req,
    );
    res.json({ ok: true });
  }),
);

// ── Activity types (2026-10-08, SCORO's customisable activity types) ─────────
// The sales calendar's Type list as data: Admin › Categories › Activity
// types. An activity carries the type's KEY (shared/activityTypes.ts), so a
// rename never rewrites one. Anyone signed in may read the list: the
// calendar's form needs it.

referenceRoutes.get(
  '/activity-types',
  handler(async (req, res) => {
    const activeOnly = String(req.query.active ?? '') === 'true';
    const [types, used] = await Promise.all([
      prisma.salesActivityType.findMany({ where: activeOnly ? { isActive: true } : {}, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      prisma.salesActivity.groupBy({ by: ['typeKey'], where: { typeKey: { not: null } }, _count: { _all: true } }),
    ]);
    const counts = new Map(used.map((u) => [u.typeKey!, u._count._all]));
    res.json(types.map((t) => ({ ...t, activityCount: counts.get(t.key) ?? 0 })));
  }),
);

const activityTypeSchema = z.object({
  name: z.string().trim().min(1, 'Name the type').max(60),
  /** #RRGGBB — the chip's edge on the calendar. */
  color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'A colour is #RRGGBB').optional().nullable(),
  sortOrder: z.number().int().default(0),
  isActive: z.boolean().default(true),
});

referenceRoutes.post(
  '/activity-types',
  require_('admin.categories.create'),
  handler(async (req, res) => {
    const body = parseBody(activityTypeSchema, req.body);
    const name = body.name.replace(/\s+/g, ' ');
    const key = activityTypeKey(name);
    if (await prisma.salesActivityType.findUnique({ where: { key } })) throw conflict(`There is already an activity type "${name}" (${key})`);
    const created = await prisma.salesActivityType.create({ data: { ...body, name, key } });
    await audit({ entityType: 'activity_type', entityId: created.id, action: 'CREATED', summary: `Created activity type "${created.name}"` }, req);
    res.status(201).json(created);
  }),
);

referenceRoutes.patch(
  '/activity-types/:id',
  require_('admin.categories.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(activityTypeSchema.partial(), req.body);
    const before = await prisma.salesActivityType.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound('Activity type not found');
    // OTHER is where a custom type lands in the enum column, and the form's
    // fallback — it stays on offer.
    if (body.isActive === false && before.key === 'OTHER') throw badRequest('"Other" is the fallback type and stays active');
    const data: Prisma.SalesActivityTypeUpdateInput = { ...body };
    if (body.name !== undefined) data.name = body.name.replace(/\s+/g, ' ');
    const updated = await prisma.salesActivityType.update({ where: { id: before.id }, data });
    await audit(
      {
        entityType: 'activity_type',
        entityId: updated.id,
        action: 'UPDATED',
        summary: before.name !== updated.name ? `Renamed activity type "${before.name}" to "${updated.name}"` : `Updated activity type "${updated.name}"`,
        before,
        after: updated,
      },
      req,
    );
    res.json(updated);
  }),
);

referenceRoutes.delete(
  '/activity-types/:id',
  require_('admin.categories.delete'),
  handler(async (req, res) => {
    const type = await prisma.salesActivityType.findUnique({ where: { id: req.params.id } });
    if (!type) throw notFound('Activity type not found');
    if (type.isSystem) throw badRequest(`"${type.name}" is a built-in type — rename or deactivate it instead`);
    const used = await prisma.salesActivity.count({ where: { typeKey: type.key } });
    if (used > 0) throw badRequest(`${used} activit${used === 1 ? 'y is' : 'ies are'} of type "${type.name}" — deactivate it instead`);
    await prisma.salesActivityType.delete({ where: { id: type.id } });
    await audit({ entityType: 'activity_type', entityId: type.id, action: 'DELETED', summary: `Deleted activity type "${type.name}"`, before: type }, req);
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

// ── CAD drawing types ────────────────────────────────────────────────────────
// What a CAD job order asks for (2026-10-09): Admin › Categories › Drawing
// types. Same contract as the sub-industries: the seeded rows are system rows
// (renamable, undeletable), and anyone signed in may read the list — the
// request form needs it under gops.cad_job_orders.* alone.

referenceRoutes.get(
  '/cad-drawing-types',
  handler(async (req, res) => {
    const activeOnly = String(req.query.active ?? '') === 'true';
    res.json(
      await prisma.cadDrawingType.findMany({
        where: activeOnly ? { isActive: true } : {},
        include: { _count: { select: { requests: true } } },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
    );
  }),
);

const drawingTypeSchema = z.object({
  name: z.string().trim().min(2, 'Give it a name').max(80),
  sortOrder: z.number().int().default(0),
  isActive: z.boolean().default(true),
});

async function drawingTypeNameTaken(name: string, exceptId?: string): Promise<boolean> {
  const clash = await prisma.cadDrawingType.findFirst({
    where: { name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  return !!clash;
}

referenceRoutes.post(
  '/cad-drawing-types',
  require_('admin.categories.create'),
  handler(async (req, res) => {
    const body = parseBody(drawingTypeSchema, req.body);
    if (await drawingTypeNameTaken(body.name)) throw conflict(`Drawing type "${body.name}" already exists`);
    const created = await prisma.cadDrawingType.create({ data: body });
    await audit(
      { entityType: 'cad_drawing_type', entityId: created.id, action: 'CREATED', summary: `Created drawing type ${created.name}` },
      req,
    );
    res.status(201).json(created);
  }),
);

referenceRoutes.patch(
  '/cad-drawing-types/:id',
  require_('admin.categories.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(drawingTypeSchema.partial(), req.body);
    const before = await prisma.cadDrawingType.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound('Drawing type not found');
    if (body.name && body.name !== before.name && (await drawingTypeNameTaken(body.name, before.id))) {
      throw conflict(`Drawing type "${body.name}" already exists`);
    }
    const updated = await prisma.cadDrawingType.update({ where: { id: before.id }, data: body });
    await audit(
      { entityType: 'cad_drawing_type', entityId: updated.id, action: 'UPDATED', summary: `Updated drawing type ${updated.name}`, before, after: updated },
      req,
    );
    res.json(updated);
  }),
);

referenceRoutes.delete(
  '/cad-drawing-types/:id',
  require_('admin.categories.delete'),
  handler(async (req, res) => {
    const row = await prisma.cadDrawingType.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { requests: true } } },
    });
    if (!row) throw notFound('Drawing type not found');
    if (row.isSystem) throw badRequest('The standard drawing types cannot be deleted — deactivate one instead');
    if (row._count.requests > 0) throw badRequest(`${row._count.requests} CAD job order(s) still carry this drawing type`);
    await prisma.cadDrawingType.delete({ where: { id: row.id } });
    await audit(
      { entityType: 'cad_drawing_type', entityId: row.id, action: 'DELETED', summary: `Deleted drawing type ${row.name}`, before: row },
      req,
    );
    res.json({ ok: true });
  }),
);
