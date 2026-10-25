import { Prisma } from '@prisma/client';
import { placeOnShelf } from '../../shared/catalogue';
import { prisma } from '../../prisma';
import { badRequest } from '../../http/kit';
import { SkipRow, type ImportSpec, type ImportActor } from '../../shared/csv';
import { reserveNumbers } from '../../shared/numbering';
import { manilaDate } from '../../shared/day';
import { formatMoney } from '../../shared/pdf';
import { mainWarehouse } from '../../shared/mainWarehouse';
import {
  GROUP_CODES,
  NO_BRAND_LABEL,
  ODOO_HEADERS,
  assetCategory,
  isTemplateCategory,
  matchHolder,
  mergeOdooRows,
  odooAssetType,
  odooKey,
  plateFrom,
  readOdooRow,
  tidy,
  type AssetCategory,
  type GroupCode,
  type OdooItem,
} from '../../shared/odooMigration';
import type { Registered } from '../imports';

/**
 * Odoo's product export, imported as it comes (2026-10-25, the owner's
 * migration). ONE file feeds two imports, each taking its own rows and
 * counting the rest as skipped:
 *
 * - `odoo_inventory` (G-CHAIN › Inventory ⋯) — every product as an item
 *   (G-CORE's own code; Odoo's Name kept whole as the part number; the brand
 *   read off the description; one of the eight product groups), rows sharing
 *   a Name merged, and what is on hand posted ONCE as the opening balance in
 *   the main-office warehouse at Odoo's cost — one ADJUSTMENT movement
 *   "Opening balance from Odoo" per item, never on an item that already has
 *   a stock movement there, so a second run posts nothing twice.
 * - `odoo_assets` (G-HR › Asset Management ⋯) — vehicles, office property
 *   and the tools categories, one asset per Odoo line (a lot when it holds
 *   several), issued to the employee a "<name> Tools" category names when
 *   exactly one active employee answers to it; a resigned holder's tools and
 *   the company's own stay Available for HR to place.
 *
 * Both write in ONE transaction (numbers reserved in a block), so a file of
 * six thousand rows lands whole or not at all within one request.
 */

/** Long enough for six thousand items on the shared server, and still one request. */
const WRITE_TRANSACTION = { maxWait: 20_000, timeout: 240_000 } as const;
const CHUNK = 1_000;

const cents = (n: number) => Math.round(n * 100) / 100;
const D = (n: number) => new Prisma.Decimal(n);

function chunks<T>(list: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * The part numbers on file, lower-cased → item, read once per run rather
 * than once per row (six thousand rows). Kept 30 seconds: the writer reads
 * the database again itself, so a stale answer only mislabels a row.
 */
let partCache: { at: number; map: Promise<Map<string, { id: string; code: string }>> } | null = null;
function partNumbers(): Promise<Map<string, { id: string; code: string }>> {
  if (!partCache || Date.now() - partCache.at > 30_000) {
    partCache = {
      at: Date.now(),
      map: prisma.item
        .findMany({ where: { partNumber: { not: null } }, select: { id: true, code: true, partNumber: true } })
        .then((rows) => new Map(rows.map((r) => [odooKey(r.partNumber!), { id: r.id, code: r.code }]))),
    };
  }
  return partCache.map;
}

const GROUP_NAMES: Record<GroupCode, string> = {
  PMP: 'Pumps & Motors',
  CTL: 'Industrial Controls',
  INS: 'Instruments',
  PRT: 'Parts & Hardware',
  CNS: 'Consumables',
  FLT: 'Filters & Separation',
  DRY: 'Dryers & Treatment',
  PIP: 'Piping & Valves',
};

const COLUMNS = [
  { header: ODOO_HEADERS.name, required: true, example: 'OOP - 213.53-E 100PSI/0-7BAR', hint: "Odoo's Name — kept whole as the part number" },
  { header: ODOO_HEADERS.reference, example: 'WIKA, BOURDON TUBE PRESSURE GAUGE', hint: 'The description; the brand is read off its start' },
  { header: ODOO_HEADERS.category, required: true, example: 'Other Product & Product for project', hint: 'Decides the product group, or that the row is an asset' },
  { header: ODOO_HEADERS.cost, example: '3080', hint: 'Pesos a unit — the opening cost' },
  { header: ODOO_HEADERS.onHand, example: '2', hint: 'Posted once as the opening balance' },
  { header: ODOO_HEADERS.price, example: '3080', hint: 'Not used' },
  { header: ODOO_HEADERS.unit, example: 'Units', hint: 'Every item comes in as pcs' },
];

// ── Inventory: items and the opening balance ─────────────────────────────────

export type OdooInventoryRecord = OdooItem;

export const odooInventorySpec: ImportSpec<OdooInventoryRecord> = {
  entity: 'odoo_inventory',
  label: 'Odoo inventory',
  columns: COLUMNS,
  groupBy: (row) => odooKey(row[ODOO_HEADERS.name] ?? ''),
  existing: async (row) => (await partNumbers()).get(odooKey(row[ODOO_HEADERS.name] ?? ''))?.id ?? null,
  build: async (row) => buildInventory([row]),
  buildGroup: async (rows) => buildInventory(rows),
  describe: (r) =>
    [
      GROUP_NAMES[r.group],
      r.brand ?? NO_BRAND_LABEL,
      r.quantity > 0 ? `${r.quantity} pcs on hand at ${formatMoney(r.unitCost)}` : 'no stock',
      r.rows > 1 ? `${r.rows} Odoo rows merged` : null,
      r.negativeRows ? `${r.negativeRows} negative row read as 0` : null,
    ]
      .filter(Boolean)
      .join(' · '),
  summarize: async (records) => {
    const warehouse = await mainWarehouse();
    const existing = await partNumbers();
    const matched = records.filter((r) => existing.has(r.key));
    const stocked = records.filter((r) => r.quantity > 0);
    // Items on file that already move stock at the warehouse take no opening balance.
    const moved = warehouse
      ? new Set(
          (
            await prisma.inventoryTransaction.findMany({
              where: { warehouseId: warehouse.id, itemId: { in: matched.map((r) => existing.get(r.key)!.id) } },
              select: { itemId: true },
              distinct: ['itemId'],
            })
          ).map((t) => t.itemId),
        )
      : new Set<string>();
    const blocked = stocked.filter((r) => existing.has(r.key) && moved.has(existing.get(r.key)!.id));
    const posting = stocked.filter((r) => !blocked.includes(r));
    const value = cents(posting.reduce((s, r) => s + r.quantity * r.unitCost, 0));
    const byGroup = new Map<string, number[]>();
    const byBrand = new Map<string, number[]>();
    for (const r of records) {
      const v = r.quantity * r.unitCost;
      const g = byGroup.get(r.group) ?? [0, 0, 0];
      byGroup.set(r.group, [g[0] + 1, g[1] + (r.quantity > 0 ? 1 : 0), g[2] + v]);
      const brand = r.brand ?? NO_BRAND_LABEL;
      const b = byBrand.get(brand) ?? [0, 0, 0];
      byBrand.set(brand, [b[0] + 1, b[1] + (r.quantity > 0 ? 1 : 0), b[2] + v]);
    }
    const sortValue = (m: Map<string, number[]>) => [...m.entries()].sort((a, b) => b[1][2] - a[1][2] || b[1][0] - a[1][0]);
    const brands = sortValue(byBrand);
    return {
      facts: [
        { label: 'Warehouse', value: warehouse ? `${warehouse.name} (${warehouse.code})` : 'None — add the main-office warehouse first' },
        { label: 'Items', value: `${records.length - matched.length} new · ${matched.length} already on file by part number (left as they are)` },
        { label: 'Opening balance', value: `${posting.length} items, ${formatMoney(value)} at Odoo cost` },
        ...(blocked.length ? [{ label: 'Not posted', value: `${blocked.length} items already move stock in G-CORE — their opening balance is left out` }] : []),
        { label: 'At zero cost', value: `${stocked.filter((r) => r.unitCost === 0).length} stocked items come in at ${formatMoney(0)} (the owner's call)` },
        { label: 'Merged', value: `${records.filter((r) => r.rows > 1).length} items from rows sharing a Name` },
      ],
      tables: [
        {
          title: 'By product group',
          head: ['Group', 'Items', 'Stocked', 'Value'],
          rows: sortValue(byGroup).map(([code, v]) => [GROUP_NAMES[code as GroupCode], v[0], v[1], formatMoney(cents(v[2]))]),
        },
        {
          title: `By brand (${brands.length})`,
          note: `The first 25 by value; "${NO_BRAND_LABEL}" is every item that declares no brand.`,
          head: ['Brand', 'Items', 'Stocked', 'Value'],
          rows: brands.slice(0, 25).map(([brand, v]) => [brand, v[0], v[1], formatMoney(cents(v[2]))]),
        },
      ],
    };
  },
};

function buildInventory(raw: Record<string, string>[]): OdooInventoryRecord {
  const rows = raw.map(readOdooRow);
  if (!rows[0].name) throw new Error('Name is required');
  if (rows.every((r) => isTemplateCategory(r.category))) throw new SkipRow('An Odoo template row — not a product');
  const products = rows.filter((r) => !assetCategory(r.category) && !isTemplateCategory(r.category));
  if (!products.length) throw new SkipRow('Company property or tools — imported in G-HR › Asset Management', true);
  return mergeOdooRows(products);
}

export async function odooInventoryWrite(
  records: { record: OdooInventoryRecord; existingId: string | null }[],
  actor?: ImportActor,
): Promise<void> {
  const warehouse = await mainWarehouse();
  if (!warehouse) throw badRequest('There is no main-office warehouse to put the opening balance in — add it under G-CHAIN › Warehouses first');
  const categories = await prisma.itemCategory.findMany({ where: { code: { in: [...GROUP_CODES] } }, select: { id: true, code: true } });
  const groupId = new Map(categories.map((c) => [c.code, c.id]));
  const missing = GROUP_CODES.filter((c) => !groupId.has(c));
  if (missing.length) throw badRequest(`The product groups ${missing.join(', ')} are missing — run the seed, or add them under Item categories`);
  const materials = await prisma.costCategory.findFirst({ where: { code: 'MAT' }, select: { id: true } });
  const now = new Date();

  const outcome = await prisma.$transaction(async (tx) => {
    // Read again inside the transaction: the dry run's answer may be minutes old.
    const onFile = new Map(
      (await tx.item.findMany({ where: { partNumber: { not: null } }, select: { id: true, partNumber: true, brand: true, categoryId: true } })).map((i) => [
        odooKey(i.partNumber!),
        i,
      ]),
    );
    const fresh = records.map((r) => r.record).filter((r) => !onFile.has(r.key));
    const known = records.map((r) => r.record).filter((r) => onFile.has(r.key));

    const codes = await reserveNumbers('item', fresh.length, tx, async (numbers) =>
      new Set((await tx.item.findMany({ where: { code: { in: numbers } }, select: { code: true } })).map((i) => i.code)),
    );
    const notes = (r: OdooItem) => `From Odoo${r.odooCategory ? ` — category: ${r.odooCategory}` : ''}${r.rows > 1 ? ` (${r.rows} rows merged)` : ''}`;
    for (const part of chunks(fresh.map((r, i) => ({ r, code: codes[i] })))) {
      await tx.item.createMany({
        data: part.map(({ r, code }) => ({
          code,
          name: r.name,
          partNumber: r.partNumber,
          brand: r.brand,
          categoryId: groupId.get(r.group)!,
          costCategoryId: materials?.id ?? null,
          unit: 'pcs',
          standardCost: D(r.unitCost),
          lastCost: r.quantity > 0 ? D(r.unitCost) : null,
          isStocked: true,
          isActive: true,
          notes: notes(r),
          createdById: actor?.id ?? null,
        })),
      });
    }
    const created = new Map(
      (await tx.item.findMany({ where: { code: { in: codes } }, select: { id: true, code: true } })).map((i) => [i.code, i.id]),
    );
    const idOf = new Map<string, string>();
    fresh.forEach((r, i) => idOf.set(r.key, created.get(codes[i])!));
    // An item already on file keeps everything it has; only a blank brand or group is filled.
    for (const r of known) {
      const item = onFile.get(r.key)!;
      idOf.set(r.key, item.id);
      const data: Prisma.ItemUncheckedUpdateInput = {};
      if (!item.brand && r.brand) data.brand = r.brand;
      if (!item.categoryId) data.categoryId = groupId.get(r.group)!;
      if (Object.keys(data).length) await tx.item.update({ where: { id: item.id }, data });
    }

    // The opening balance: once per item at the warehouse, never over a movement.
    const stocked = records.map((r) => r.record).filter((r) => r.quantity > 0);
    const ids = stocked.map((r) => idOf.get(r.key)!);
    const moved = new Set(
      (await tx.inventoryTransaction.findMany({ where: { warehouseId: warehouse.id, itemId: { in: ids } }, select: { itemId: true }, distinct: ['itemId'] })).map(
        (t) => t.itemId,
      ),
    );
    const balances = new Map(
      (await tx.inventoryBalance.findMany({ where: { warehouseId: warehouse.id, itemId: { in: ids } }, select: { id: true, itemId: true, quantity: true } })).map((b) => [
        b.itemId,
        b,
      ]),
    );
    const post = stocked.filter((r) => {
      const id = idOf.get(r.key)!;
      return !moved.has(id) && !(balances.get(id) && Number(balances.get(id)!.quantity) !== 0);
    });
    for (const part of chunks(post.filter((r) => !balances.has(idOf.get(r.key)!)))) {
      await tx.inventoryBalance.createMany({
        data: part.map((r) => ({ itemId: idOf.get(r.key)!, warehouseId: warehouse.id, quantity: D(r.quantity), averageCost: D(r.unitCost) })),
      });
    }
    for (const r of post.filter((r) => balances.has(idOf.get(r.key)!))) {
      await tx.inventoryBalance.update({ where: { id: balances.get(idOf.get(r.key)!)!.id }, data: { quantity: D(r.quantity), averageCost: D(r.unitCost) } });
    }
    for (const part of chunks(post)) {
      await tx.inventoryTransaction.createMany({
        data: part.map((r) => ({
          itemId: idOf.get(r.key)!,
          warehouseId: warehouse.id,
          type: 'ADJUSTMENT' as const,
          quantity: D(r.quantity),
          unitCost: D(r.unitCost),
          balanceAfter: D(r.quantity),
          sourceType: 'odoo_opening',
          sourceNumber: 'ODOO',
          notes: 'Opening balance from Odoo',
          createdById: actor?.id ?? null,
          occurredAt: now,
        })),
      });
    }
    // Every item is on the shelf list, stocked or not (2026-10-25): a placeholder line for the rest.
    await placeOnShelf(tx, [...idOf.values()]);
    const value = cents(post.reduce((s, r) => s + r.quantity * r.unitCost, 0));
    await tx.auditLog.create({
      data: {
        entityType: 'item',
        entityId: 'list',
        action: 'CREATED',
        summary: `Imported Odoo's inventory: ${fresh.length} items added, ${known.length} already on file; opening balance of ${post.length} items (${formatMoney(value)}) in ${warehouse.name}${
          stocked.length - post.length ? `; ${stocked.length - post.length} left out, already moving stock` : ''
        }`,
        actorId: actor?.id ?? null,
        actorName: actor?.name ?? null,
      },
    });
    return { fresh: fresh.length };
  }, WRITE_TRANSACTION);
  void outcome;
  partCache = null;
}

export const odooInventoryImport: Registered = {
  spec: odooInventorySpec as ImportSpec<never>,
  permission: 'gchain.items.create',
  write: odooInventoryWrite as unknown as Registered['write'],
};

// ── Assets: G-HR › Asset Management ──────────────────────────────────────────

export interface OdooAssetRecord {
  ref: string;
  category: string;
  holding: AssetCategory;
  name: string;
  brandModel: string;
  assetType: string;
  plateNo: string | null;
  quantity: number;
  unitCost: number;
}

function assetRef(category: string, name: string): string {
  return `odoo:${tidy(category).toUpperCase()}|${odooKey(name)}`;
}

export const odooAssetsSpec: ImportSpec<OdooAssetRecord> = {
  entity: 'odoo_assets',
  label: 'Odoo assets and tools',
  columns: COLUMNS,
  groupBy: (row) => {
    const cat = row[ODOO_HEADERS.category] ?? '';
    return assetCategory(cat) ? `${tidy(cat)} | ${tidy(row[ODOO_HEADERS.name])}` : odooKey(row[ODOO_HEADERS.name] ?? '');
  },
  existing: async (row) => {
    const cat = row[ODOO_HEADERS.category] ?? '';
    if (!assetCategory(cat)) return null;
    const found = await prisma.companyAsset.findFirst({ where: { importRef: assetRef(cat, row[ODOO_HEADERS.name] ?? '') }, select: { id: true } });
    return found?.id ?? null;
  },
  build: async (row) => buildAsset([row]),
  buildGroup: async (rows) => buildAsset(rows),
  describe: (r) =>
    [
      r.assetType,
      r.quantity > 1 ? `a lot of ${r.quantity}` : null,
      r.holding.holder ? `${r.holding.resigned ? 'last held by' : 'for'} ${r.holding.holder}${r.holding.resigned ? ' (resigned) — stays Available' : ''}` : 'Available',
      r.holding.site ? `at ${r.holding.site}` : null,
    ]
      .filter(Boolean)
      .join(' · '),
  summarize: async (records) => {
    const people = await activeEmployees();
    const holders = new Map<string, { units: number; lines: number; resigned: boolean }>();
    for (const r of records) {
      if (!r.holding.holder) continue;
      const h = holders.get(r.holding.holder) ?? { units: 0, lines: 0, resigned: r.holding.resigned };
      holders.set(r.holding.holder, { units: h.units + r.quantity, lines: h.lines + 1, resigned: h.resigned || r.holding.resigned });
    }
    const byType = new Map<string, number[]>();
    for (const r of records) {
      const t = byType.get(r.assetType) ?? [0, 0, 0];
      byType.set(r.assetType, [t[0] + 1, t[1] + r.quantity, t[2] + r.quantity * r.unitCost]);
    }
    const rows = [...holders.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    return {
      facts: [
        { label: 'Assets', value: `${records.length} records, ${records.reduce((s, r) => s + r.quantity, 0)} units — a line of several is one lot` },
        { label: 'Value', value: formatMoney(cents(records.reduce((s, r) => s + r.quantity * r.unitCost, 0))) },
      ],
      tables: [
        {
          title: 'By asset type',
          head: ['Type', 'Records', 'Units', 'Value'],
          rows: [...byType.entries()].sort((a, b) => b[1][2] - a[1][2]).map(([t, v]) => [t, v[0], v[1], formatMoney(cents(v[2]))]),
        },
        {
          title: 'Who holds them',
          note: 'Issued only where exactly one active employee answers to the name (a nickname read through the list of Odoo names); anyone else, and every resigned holder, leaves the tools Available. Add the missing employee record and run the import again: it issues what it left Available.',
          head: ['In Odoo', 'Records', 'Units', 'Issued to'],
          rows: rows.map(([holder, h]) => {
            const match = h.resigned ? null : matchHolder(holder, people);
            return [holder, h.lines, h.units, h.resigned ? 'Resigned — stays Available' : match ? `${match.firstName} ${match.lastName}` : 'No employee on file — stays Available until one is added'];
          }),
        },
      ],
    };
  },
};

function buildAsset(raw: Record<string, string>[]): OdooAssetRecord {
  const rows = raw.map(readOdooRow);
  const holding = assetCategory(rows[0].category);
  if (!holding) throw new SkipRow('A product — imported in G-CHAIN › Inventory', true);
  const quantity = rows.reduce((s, r) => s + Math.max(0, r.onHand), 0);
  if (quantity <= 0) throw new SkipRow('Nothing on hand in Odoo', true);
  if (!Number.isInteger(quantity)) throw new Error(`${quantity} on hand — an asset is counted in whole units`);
  const reference = rows.map((r) => r.reference).find(Boolean) ?? '';
  const name = rows[0].name;
  const stocked = rows.filter((r) => r.onHand > 0);
  const unitCost = cents(stocked.reduce((s, r) => s + r.onHand * r.cost, 0) / quantity);
  return {
    ref: assetRef(rows[0].category!, name),
    category: rows[0].category!,
    holding,
    name,
    brandModel: reference || name,
    assetType: odooAssetType(holding, `${name} ${reference}`),
    plateNo: holding.kind === 'vehicle' ? plateFrom(name) ?? plateFrom(reference) : null,
    quantity,
    unitCost,
  };
}

async function activeEmployees() {
  return prisma.employee.findMany({ where: { isActive: true }, select: { id: true, firstName: true, lastName: true } });
}

export async function odooAssetsWrite(records: { record: OdooAssetRecord; existingId: string | null }[], actor?: ImportActor): Promise<void> {
  if (!actor) throw badRequest('Who is importing is not known');
  const todo = records.filter((r) => !r.existingId).map((r) => r.record);
  const people = await activeEmployees();
  const types = await prisma.assetType.findMany({ select: { id: true, name: true } });
  const typeId = new Map(types.map((t) => [t.name.toLowerCase(), t.id]));
  const fallback = typeId.get('other');
  for (const r of todo) {
    if (!typeId.has(r.assetType.toLowerCase()) && !fallback) throw badRequest(`The asset type "${r.assetType}" is not on Admin › Categories › Asset types`);
  }
  const today = manilaDate(new Date());

  await prisma.$transaction(async (tx) => {
    // Read again inside the transaction: never a second asset for one Odoo line.
    const done = new Set(
      (await tx.companyAsset.findMany({ where: { importRef: { in: todo.map((r) => r.ref) } }, select: { importRef: true } })).map((a) => a.importRef),
    );
    const fresh = todo.filter((r) => !done.has(r.ref));
    const tags = await reserveNumbers('company_asset', fresh.length, tx, async (numbers) =>
      new Set((await tx.companyAsset.findMany({ where: { tag: { in: numbers } }, select: { tag: true } })).map((a) => a.tag)),
    );
    const holderOf = (r: OdooAssetRecord) => (r.holding.holder && !r.holding.resigned ? matchHolder(r.holding.holder, people) : null);
    const noteOf = (r: OdooAssetRecord) =>
      [
        `From Odoo — ${r.name} (category: ${r.category})`,
        r.holding.holder && r.holding.resigned ? `Last held by ${r.holding.holder} (resigned) — confirm where it is` : null,
        r.holding.holder && !r.holding.resigned && !holderOf(r) ? `Held by ${r.holding.holder} in Odoo — no employee matched; issue it from this page` : null,
        r.holding.site ? `At ${r.holding.site}` : null,
      ]
        .filter(Boolean)
        .join('\n');
    for (const part of chunks(fresh.map((r, i) => ({ r, tag: tags[i] })))) {
      await tx.companyAsset.createMany({
        data: part.map(({ r, tag }) => ({
          tag,
          assetTypeId: typeId.get(r.assetType.toLowerCase()) ?? fallback!,
          brandModel: r.brandModel,
          plateNo: r.plateNo,
          description: r.name !== r.brandModel ? r.name : null,
          cost: D(r.unitCost),
          quantity: r.quantity,
          status: holderOf(r) ? ('ISSUED' as const) : ('AVAILABLE' as const),
          notes: noteOf(r),
          importRef: r.ref,
          createdById: actor.id,
        })),
      });
    }
    const made = new Map((await tx.companyAsset.findMany({ where: { tag: { in: tags } }, select: { id: true, tag: true } })).map((a) => [a.tag, a.id]));
    const issued = fresh.map((r, i) => ({ r, id: made.get(tags[i])!, to: holderOf(r) })).filter((x) => x.to);
    for (const part of chunks(issued)) {
      await tx.assetIssuance.createMany({
        data: part.map(({ r, id, to }) => ({
          assetId: id,
          employeeId: to!.id,
          issuedOn: today,
          issuedById: actor.id,
          conditionOut: 'As recorded in Odoo',
          remarks: `From Odoo — ${r.category}`,
        })),
      });
    }
    // An asset an earlier run left Available because nobody answered to its
    // holder is issued now that somebody does — only while it was never issued
    // since, so HR's own issue or return is never undone.
    const waiting = records.filter((x) => x.existingId && holderOf(x.record));
    const left = new Set(
      (
        await tx.companyAsset.findMany({
          where: { id: { in: waiting.map((x) => x.existingId!) }, status: 'AVAILABLE', issuances: { none: {} } },
          select: { id: true },
        })
      ).map((a) => a.id),
    );
    let late = 0;
    for (const { record: r, existingId } of waiting) {
      if (!left.has(existingId!)) continue;
      const claimed = await tx.companyAsset.updateMany({
        where: { id: existingId!, status: 'AVAILABLE', issuances: { none: {} } },
        data: { status: 'ISSUED', notes: noteOf(r) },
      });
      if (!claimed.count) continue;
      await tx.assetIssuance.create({
        data: {
          assetId: existingId!,
          employeeId: holderOf(r)!.id,
          issuedOn: today,
          issuedById: actor.id,
          conditionOut: 'As recorded in Odoo',
          remarks: `From Odoo — ${r.category}`,
        },
      });
      late += 1;
    }
    await tx.auditLog.create({
      data: {
        entityType: 'company_asset',
        entityId: 'list',
        action: 'CREATED',
        summary: `Imported Odoo's assets and tools: ${fresh.length} assets (${fresh.reduce((s, r) => s + r.quantity, 0)} units), ${issued.length} issued to their holders${late ? `; ${late} left Available before issued now that their holder is on file` : ''}`,
        actorId: actor.id,
        actorName: actor.name,
      },
    });
  }, WRITE_TRANSACTION);
}

export const odooAssetsImport: Registered = {
  spec: odooAssetsSpec as ImportSpec<never>,
  permission: 'ghr.assets.create',
  write: odooAssetsWrite as unknown as Registered['write'],
};
