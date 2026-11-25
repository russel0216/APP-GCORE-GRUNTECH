import { Router } from 'express';
import { Prisma, StockMoveType } from '@prisma/client';
import { prisma } from '../prisma';
import { handler, listQuery, listResult, idsFilter, type ListQuery } from '../http/kit';
import { authenticate, require_ } from '../auth/middleware';
import { audit } from '../shared/audit';
import { manilaDayEnd, manilaDayStart } from '../shared/day';
import { LIST_CAP, choice, filterDay, listReference, rangeNamed, sendListPdf } from '../shared/listPaper';
import { MOVE_KIND_LABELS, ODOO_MOVE_KINDS, type OdooMoveKind } from '../shared/odooMoves';
import { formatQuantity, formatShortDate, renderDocument, statusLabel } from '../shared/pdf';
import { withDocuments } from '../shared/stockCardHistory';

/**
 * G-CHAIN › Warehouse › Stock Movements (2026-11-25, the owner's call:
 * "remove the recent stock movement below Inventory; a separate menu between
 * Inventory and Pull-out Slips to view all the stock movement, with filters
 * by item, by date or other details; column selection").
 *
 * READ ONLY — a view over the movements G-CORE already records
 * (`InventoryTransaction`: the company's stock, a project's, a sales order's
 * and a quotation's own) and, as a second view never mixed with the first
 * (`?view=odoo`), the history brought across from Odoo (`OdooStockMove`).
 * One where-builder per view feeds the rows, the summary cards and the paper.
 */
export const stockMovementRoutes = Router();
stockMovementRoutes.use(authenticate, require_('gchain.stock_movements.view_all'));

const num = (v: unknown) => Number(v ?? 0);
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const cents = (n: number) => Math.round(n * 100) / 100;

/** The documents a movement comes from, as the Document filter names them. */
const DOCUMENTS = {
  receiving: 'Incoming',
  stock_issue: 'Outgoing',
  pullout_slip: 'Pull-out slip',
  borrow_slip: 'Borrow slip',
  odoo_opening: 'Opening balance from Odoo',
  other: 'Anything else',
} as const;
type DocumentKind = keyof typeof DOCUMENTS;
const DOCUMENT_KINDS = Object.keys(DOCUMENTS) as DocumentKind[];
const NAMED_DOCUMENTS = DOCUMENT_KINDS.filter((k) => k !== 'other');

const OWNERS = { company: 'company', project: 'project', order: 'order', quotation: 'quotation' } as const;
const OWNER_WORDS: Record<keyof typeof OWNERS, string> = {
  company: "the company's stock",
  project: "a project's own stock",
  order: "a sales order's own stock",
  quotation: 'goods held for a quotation',
};
const DIRECTIONS = { in: 'in', out: 'out' } as const;

/** An item narrowed by the text typed, its product group and its brand — shared by both views. */
function itemWhere(q: ListQuery): Prisma.ItemWhereInput | null {
  const and: Prisma.ItemWhereInput[] = [];
  const f = q.filters;
  if (f.group) and.push(f.group === 'none' ? { productGroup: null } : { productGroup: { equals: f.group, mode: 'insensitive' } });
  if (f.brand) and.push(f.brand === 'none' ? { OR: [{ brand: null }, { brand: '' }] } : { brand: { equals: f.brand, mode: 'insensitive' } });
  return and.length ? { AND: and } : null;
}

const itemSearch = (term: string): Prisma.ItemWhereInput => ({
  OR: [
    { name: { contains: term, mode: 'insensitive' } },
    { code: { contains: term, mode: 'insensitive' } },
    { partNumber: { contains: term, mode: 'insensitive' } },
  ],
});

/** The Manila days a date range names, as edges on the movement's timestamp. */
function dayRange(q: ListQuery): { gte?: Date; lte?: Date } | null {
  const from = filterDay(q.filters.from, 'From');
  const to = filterDay(q.filters.to, 'To');
  if (!from && !to) return null;
  return { ...(from ? { gte: manilaDayStart(from) } : {}), ...(to ? { lte: manilaDayEnd(to) } : {}) };
}

function movementWhere(q: ListQuery): Prisma.InventoryTransactionWhereInput {
  const f = q.filters;
  const and: Prisma.InventoryTransactionWhereInput[] = [];
  const ids = idsFilter(f.ids);
  if (ids) and.push({ id: { in: ids } });
  if (q.search) and.push({ OR: [{ item: itemSearch(q.search) }, { sourceNumber: { contains: q.search, mode: 'insensitive' } }, { notes: { contains: q.search, mode: 'insensitive' } }] });
  if (f.itemId) and.push({ itemId: f.itemId });
  const item = itemWhere(q);
  if (item) and.push({ item });
  const range = dayRange(q);
  if (range) and.push({ occurredAt: range });
  const type = choice(f.type, StockMoveType, 'Type');
  if (type) and.push({ type });
  const direction = choice(f.direction, DIRECTIONS, 'Direction', (v) => (v === 'in' ? 'In' : 'Out'));
  if (direction) and.push({ quantity: direction === 'in' ? { gt: 0 } : { lt: 0 } });
  const doc = choice(f.document, DOCUMENT_KINDS, 'Document', (v) => DOCUMENTS[v]);
  if (doc) and.push(doc === 'other' ? { sourceType: { notIn: NAMED_DOCUMENTS } } : { sourceType: doc });
  if (f.warehouseId) and.push({ warehouseId: f.warehouseId });
  if (f.userId) and.push({ createdById: f.userId === 'none' ? null : f.userId });
  const owner = choice(f.stock, OWNERS, 'Stock', (v) => OWNER_WORDS[v]);
  if (owner === 'company') and.push({ jobId: null, salesOrderId: null, quotationId: null });
  if (owner === 'project') and.push({ jobId: { not: null } });
  if (owner === 'order') and.push({ salesOrderId: { not: null } });
  if (owner === 'quotation') and.push({ quotationId: { not: null } });
  return and.length ? { AND: and } : {};
}

function odooWhere(q: ListQuery): Prisma.OdooStockMoveWhereInput {
  const f = q.filters;
  const and: Prisma.OdooStockMoveWhereInput[] = [];
  const ids = idsFilter(f.ids);
  if (ids) and.push({ id: { in: ids } });
  if (q.search) {
    and.push({
      OR: [{ item: itemSearch(q.search) }, { reference: { contains: q.search, mode: 'insensitive' } }, { contact: { contains: q.search, mode: 'insensitive' } }],
    });
  }
  if (f.itemId) and.push({ itemId: f.itemId });
  const item = itemWhere(q);
  if (item) and.push({ item });
  const range = dayRange(q);
  if (range) and.push({ occurredAt: range });
  const kind = choice(f.kind, ODOO_MOVE_KINDS, 'Type', (v) => MOVE_KIND_LABELS[v]);
  if (kind) and.push({ kind });
  const direction = choice(f.direction, DIRECTIONS, 'Direction', (v) => (v === 'in' ? 'In' : 'Out'));
  if (direction) and.push({ direction: direction === 'in' ? { gt: 0 } : { lt: 0 } });
  return and.length ? { AND: and } : {};
}

const VIEWS = { gcore: 'gcore', odoo: 'odoo' } as const;
const viewOf = (q: ListQuery) => choice(q.filters.view, VIEWS, 'View', (v) => (v === 'odoo' ? 'Odoo history' : 'G-CORE')) ?? 'gcore';

const ITEM_SELECT = { id: true, code: true, name: true, unit: true, partNumber: true, brand: true, productGroup: true } as const;

async function movementRows(where: Prisma.InventoryTransactionWhereInput, q: ListQuery, take: number, skip: number) {
  const rows = await prisma.inventoryTransaction.findMany({
    where,
    orderBy: [{ occurredAt: q.sort === 'occurredAt' ? q.dir : 'desc' }, { id: 'desc' }],
    take,
    skip,
    include: {
      item: { select: ITEM_SELECT },
      warehouse: { select: { id: true, name: true } },
      createdBy: { select: { id: true, name: true } },
      job: { select: { id: true, number: true } },
      salesOrder: { select: { id: true, number: true } },
      quotation: { select: { id: true, number: true } },
    },
  });
  return (await withDocuments(rows)).map((r) => {
    const quantity = num(r.quantity);
    const after = num(r.balanceAfter);
    const unitCost = num(r.unitCost);
    return {
      id: r.id,
      occurredAt: r.occurredAt,
      type: r.type,
      item: r.item,
      quantity,
      // What that shelf held before and after — the movement's own record.
      balanceBefore: round3(after - quantity),
      balanceAfter: after,
      unitCost,
      value: cents(Math.abs(quantity) * unitCost),
      sourceType: r.sourceType,
      sourceNumber: r.sourceNumber,
      document: (NAMED_DOCUMENTS as string[]).includes(r.sourceType) ? DOCUMENTS[r.sourceType as DocumentKind] : statusLabel(r.sourceType),
      link: r.link,
      from: r.from,
      to: r.to,
      warehouse: r.warehouse,
      // Whose stock moved: a project's, a sales order's, a quotation's — else the company's.
      owner: r.job ? { kind: 'project', number: r.job.number } : r.salesOrder ? { kind: 'order', number: r.salesOrder.number } : r.quotation ? { kind: 'quotation', number: r.quotation.number } : null,
      createdBy: r.createdBy,
      notes: r.notes,
    };
  });
}

async function odooRows(where: Prisma.OdooStockMoveWhereInput, q: ListQuery, take: number, skip: number) {
  const rows = await prisma.odooStockMove.findMany({
    where,
    orderBy: [{ occurredAt: q.sort === 'occurredAt' ? q.dir : 'desc' }, { id: 'desc' }],
    take,
    skip,
    include: { item: { select: ITEM_SELECT } },
  });
  return rows.map((r) => ({
    id: r.id,
    occurredAt: r.occurredAt,
    item: r.item,
    kind: r.kind,
    kindLabel: MOVE_KIND_LABELS[r.kind as OdooMoveKind] ?? r.kind,
    direction: r.direction,
    reference: r.reference,
    from: r.fromLocation,
    to: r.toLocation,
    contact: r.contact,
    quantity: num(r.quantity),
    unit: r.unit,
    by: r.createdByName,
  }));
}

/** The cards: what the filtered set adds up to. Quantities are not summed — the items' units differ. */
async function summaryOf(view: 'gcore' | 'odoo', q: ListQuery) {
  if (view === 'odoo') {
    const where = odooWhere(q);
    const [items, into, out] = await Promise.all([
      prisma.odooStockMove.groupBy({ by: ['itemId'], where }),
      prisma.odooStockMove.count({ where: { AND: [where, { direction: { gt: 0 } }] } }),
      prisma.odooStockMove.count({ where: { AND: [where, { direction: { lt: 0 } }] } }),
    ]);
    return { view, items: items.length, in: into, out };
  }
  const where = movementWhere(q);
  const [items, into, out] = await Promise.all([
    prisma.inventoryTransaction.groupBy({ by: ['itemId'], where }),
    prisma.inventoryTransaction.count({ where: { AND: [where, { quantity: { gt: 0 } }] } }),
    prisma.inventoryTransaction.count({ where: { AND: [where, { quantity: { lt: 0 } }] } }),
  ]);
  return { view, items: items.length, in: into, out };
}

/** What the filters offer: who moved stock, the warehouses, and the brands and product groups of the items on file. */
stockMovementRoutes.get(
  '/options',
  handler(async (_req, res) => {
    const [by, warehouses, brands, groups, odoo] = await Promise.all([
      prisma.inventoryTransaction.groupBy({ by: ['createdById'], _count: { _all: true } }),
      prisma.warehouse.findMany({ where: { OR: [{ isActive: true }, { stockMoves: { some: {} } }] }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      prisma.item.findMany({ where: { brand: { not: null } }, distinct: ['brand'], select: { brand: true }, orderBy: { brand: 'asc' } }),
      prisma.item.findMany({ where: { productGroup: { not: null } }, distinct: ['productGroup'], select: { productGroup: true }, orderBy: { productGroup: 'asc' } }),
      prisma.odooStockMove.count(),
    ]);
    const ids = by.map((b) => b.createdById).filter((v): v is string => !!v);
    const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
    const name = new Map(users.map((u) => [u.id, u.name]));
    res.json({
      people: by
        .filter((b) => b.createdById && name.has(b.createdById))
        .map((b) => ({ id: b.createdById!, name: name.get(b.createdById!)!, movements: b._count._all }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      warehouses,
      brands: brands.map((b) => b.brand!).filter((b) => b.trim()),
      groups: groups.map((g) => g.productGroup!).filter((g) => g.trim()),
      // Whether there is any Odoo history to switch to.
      odooMoves: odoo,
    });
  }),
);

/** The item filter's pick-as-you-type, and the name behind an id that arrived in the address. */
stockMovementRoutes.get(
  '/items',
  handler(async (req, res) => {
    const label = (i: { code: string; name: string; partNumber: string | null }) => `${i.name}${i.partNumber ? ` — ${i.partNumber}` : ''} (${i.code})`;
    if (typeof req.query.id === 'string' && req.query.id) {
      const item = await prisma.item.findUnique({ where: { id: req.query.id }, select: { id: true, code: true, name: true, partNumber: true } });
      res.json(item ? [{ value: item.id, label: label(item) }] : []);
      return;
    }
    const term = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const items = await prisma.item.findMany({
      where: term ? itemSearch(term) : {},
      select: { id: true, code: true, name: true, partNumber: true },
      orderBy: { name: 'asc' },
      take: 20,
    });
    res.json(items.map((i) => ({ value: i.id, label: label(i) })));
  }),
);

/** The list on paper, as the screen filters it (or the rows ticked). Above nothing else: this router has no `/:id`. */
stockMovementRoutes.get(
  '/pdf',
  handler(async (req, res) => {
    const q = listQuery(req);
    const f = q.filters;
    const view = viewOf(q);
    const [item, warehouse, person] = await Promise.all([
      f.itemId ? prisma.item.findUnique({ where: { id: f.itemId }, select: { name: true, code: true } }) : null,
      f.warehouseId ? prisma.warehouse.findUnique({ where: { id: f.warehouseId }, select: { name: true } }) : null,
      f.userId && f.userId !== 'none' ? prisma.user.findUnique({ where: { id: f.userId }, select: { name: true } }) : null,
    ]);
    const said = [
      q.search ? `search "${q.search}"` : null,
      f.itemId ? `item ${item ? `${item.name} (${item.code})` : 'not found'}` : null,
      rangeNamed('moved', f.from, f.to),
      f.direction ? (f.direction === 'in' ? 'in only' : 'out only') : null,
      f.group ? (f.group === 'none' ? 'no product group' : `product group ${f.group}`) : null,
      f.brand ? (f.brand === 'none' ? 'no brand' : `brand ${f.brand}`) : null,
      f.ids ? 'the rows selected' : null,
    ];
    const when = (at: Date) => `${formatShortDate(at)} ${at.toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit' })}`;
    const sign = (n: number) => `${n > 0 ? '+' : n < 0 ? '-' : ''}${formatQuantity(Math.abs(n))}`;
    let pdf: Buffer;
    let reference: string;
    if (view === 'odoo') {
      const where = odooWhere(q);
      const [rows, count] = await Promise.all([odooRows(where, q, LIST_CAP, 0), prisma.odooStockMove.count({ where })]);
      reference = listReference(count, rows.length, ['Odoo move', 'Odoo moves'], [...said, f.kind ? `type ${MOVE_KIND_LABELS[f.kind as OdooMoveKind]}` : null]);
      pdf = await renderDocument({
        title: 'Stock Movements — Odoo History',
        date: new Date(),
        reference,
        landscape: true,
        sections: [
          {
            kind: 'table',
            head: ['When', 'Item', 'Type', 'Reference', 'From / to', 'Customer / supplier', 'Quantity', 'By'],
            align: ['left', 'left', 'left', 'left', 'left', 'left', 'right', 'left'],
            rows: rows.map((r) => [
              when(r.occurredAt),
              { title: r.item.name, body: [r.item.partNumber, r.item.code].filter(Boolean).join(' · ') },
              r.kindLabel,
              r.reference,
              `${r.from} to ${r.to}`,
              r.contact ?? '—',
              `${sign(r.direction * r.quantity || r.quantity)} ${r.unit ?? r.item.unit}`,
              r.by ?? '—',
            ]),
          },
          { kind: 'text', body: 'History brought across from Odoo. It is a record only: not part of the stock on hand, and no slip stands behind it in G-CORE.' },
        ],
      });
    } else {
      const where = movementWhere(q);
      const [rows, count] = await Promise.all([movementRows(where, q, LIST_CAP, 0), prisma.inventoryTransaction.count({ where })]);
      reference = listReference(count, rows.length, ['stock movement', 'stock movements'], [
        ...said,
        f.type ? `type ${statusLabel(f.type)}` : null,
        f.document ? `document ${DOCUMENTS[f.document as DocumentKind]}` : null,
        f.warehouseId ? `warehouse ${warehouse?.name ?? 'not found'}` : null,
        f.userId ? (f.userId === 'none' ? 'no person on record' : `moved by ${person?.name ?? 'not found'}`) : null,
        f.stock ? OWNER_WORDS[f.stock as keyof typeof OWNERS] : null,
      ]);
      pdf = await renderDocument({
        title: 'Stock Movements',
        date: new Date(),
        reference,
        landscape: true,
        sections: [
          {
            kind: 'table',
            head: ['When', 'Item', 'Type', 'Document', 'From / to', 'In / out', 'Before', 'After', 'By'],
            align: ['left', 'left', 'left', 'left', 'left', 'right', 'right', 'right', 'left'],
            rows: rows.map((r) => [
              when(r.occurredAt),
              { title: r.item.name, body: [r.item.partNumber, r.item.code, r.owner ? `${r.owner.number}'s stock` : null].filter(Boolean).join(' · ') },
              statusLabel(r.type),
              r.sourceNumber ?? r.document,
              `${r.from ?? '—'} to ${r.to ?? '—'}`,
              `${sign(r.quantity)} ${r.item.unit}`,
              formatQuantity(r.balanceBefore),
              formatQuantity(r.balanceAfter),
              r.createdBy?.name ?? '—',
            ]),
          },
        ],
      });
    }
    await audit({ entityType: 'stock_movement', entityId: 'list', action: 'EXPORTED', summary: `Exported the stock movements as PDF (${reference})` }, req);
    sendListPdf(res, pdf, view === 'odoo' ? 'stock-movements-odoo-history.pdf' : 'stock-movements.pdf');
  }),
);

/** The movements, newest first — G-CORE's own, or (`?view=odoo`) the history brought across from Odoo. */
stockMovementRoutes.get(
  '/',
  handler(async (req, res) => {
    const q = listQuery(req);
    const view = viewOf(q);
    const skip = (q.page - 1) * q.pageSize;
    if (view === 'odoo') {
      const where = odooWhere(q);
      const [rows, total, summary] = await Promise.all([odooRows(where, q, q.pageSize, skip), prisma.odooStockMove.count({ where }), summaryOf(view, q)]);
      res.json({ ...listResult(rows, total, q), summary });
      return;
    }
    const where = movementWhere(q);
    const [rows, total, summary] = await Promise.all([
      movementRows(where, q, q.pageSize, skip),
      prisma.inventoryTransaction.count({ where }),
      summaryOf(view, q),
    ]);
    res.json({ ...listResult(rows, total, q), summary });
  }),
);
