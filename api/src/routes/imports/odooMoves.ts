import { Prisma } from '@prisma/client';
import { prisma } from '../../prisma';
import { SkipRow, type ImportActor, type ImportSpec } from '../../shared/csv';
import { formatDate } from '../../shared/pdf';
import { reserveNumbers } from '../../shared/numbering';
import { odooBrand, odooKey } from '../../shared/odooMigration';
import { MOVE_HEADERS, MOVE_KIND_LABELS, moveProductParts, moveTotals, readMoves, type OdooMove, type OdooMoveSet } from '../../shared/odooMoves';
import type { Registered } from '../imports';
import { forgetPartNumbers, partNumbers } from './odoo';

/**
 * Odoo's "Product Moves" export, kept as HISTORY (2026-11-25, the owner's
 * call: "we just want to know where the product moved — don't create a
 * pull-out slip"). `odoo_moves` (G-CHAIN › Inventory ⋯). Nothing else happens —
 * no balance, no average cost, no slip, no report reads these rows.
 *
 * Where a product's moves go (the owner's call the same day: "keep them, but
 * the laptops, vehicles and tools go to Asset Management"):
 *
 * 1. the ITEM whose part number is Odoo's product Name — its stock card;
 * 2. else the G-HR ASSET the Odoo import made from that Name (`importRef`) —
 *    the asset's own page (`OdooAssetMove`);
 * 3. else a product G-CORE never held (archived in Odoo): it is filed as an
 *    INACTIVE item with no stock and no cost, so its history can be found.
 *
 * One result per PRODUCT (its rows grouped). The same line imported twice adds
 * nothing (`importKey`).
 */

const WRITE_TRANSACTION = { maxWait: 20_000, timeout: 240_000 } as const;
const CHUNK = 2_000;
const D = (n: number) => new Prisma.Decimal(n);

type ItemTarget = { kind: 'item'; itemId: string; label: string };
type AssetTarget = { kind: 'asset'; assetIds: string[]; label: string };
type NewTarget = { kind: 'new'; key: string; partNumber: string; name: string; label: string };
type Target = ItemTarget | AssetTarget | NewTarget;

export interface OdooMovesRecord extends OdooMoveSet {
  target: Target;
}

const COLUMNS = [
  { header: MOVE_HEADERS.date, required: true, example: '2026-11-19 14:21:20', hint: "Odoo's date and time, as exported" },
  { header: MOVE_HEADERS.reference, required: true, example: 'WH/OUT/04895', hint: "Odoo's transfer number" },
  { header: MOVE_HEADERS.product, required: true, example: '[Schneider, Miniature Relay] SRC - RXM4LB2P7', hint: 'The part after the brackets finds the item (or the G-HR asset) made from that Odoo Name' },
  { header: MOVE_HEADERS.from, required: true, example: 'WH/Stock' },
  { header: MOVE_HEADERS.to, required: true, example: 'Partner Locations/Customers' },
  { header: MOVE_HEADERS.contact, example: 'MONDE M.Y. SAN CORPORATION - CAINTA', hint: 'The customer or supplier, kept as written' },
  { header: MOVE_HEADERS.quantity, required: true, example: '12', hint: 'A row with 0 moved nothing and is left out' },
  { header: MOVE_HEADERS.unit, example: 'Units' },
  { header: MOVE_HEADERS.status, example: 'Done', hint: 'Only Done rows are kept' },
  { header: MOVE_HEADERS.by, example: 'Karen Gasiong' },
];

/**
 * The assets the Odoo import made, by Odoo's Name (`importRef` is
 * "odoo:<category>|<NAME>"), read once per run. A Name filed under two
 * categories is two assets, and its history is shown on each.
 */
let assetCache: { at: number; map: Promise<Map<string, { id: string; tag: string }[]>> } | null = null;
function odooAssets(): Promise<Map<string, { id: string; tag: string }[]>> {
  if (!assetCache || Date.now() - assetCache.at > 30_000) {
    assetCache = {
      at: Date.now(),
      map: prisma.companyAsset
        .findMany({ where: { importRef: { startsWith: 'odoo:' } }, select: { id: true, tag: true, importRef: true }, orderBy: { tag: 'asc' } })
        .then((rows) => {
          const map = new Map<string, { id: string; tag: string }[]>();
          for (const r of rows) {
            const cut = r.importRef!.indexOf('|');
            if (cut < 0) continue;
            const key = r.importRef!.slice(cut + 1);
            map.set(key, [...(map.get(key) ?? []), { id: r.id, tag: r.tag }]);
          }
          return map;
        }),
    };
  }
  return assetCache.map;
}

async function targetFor(set: OdooMoveSet): Promise<Target> {
  const parts = await partNumbers();
  for (const key of set.keys) {
    const item = parts.get(key);
    if (item) return { kind: 'item', itemId: item.id, label: item.code };
  }
  const assets = await odooAssets();
  for (const key of set.keys) {
    const found = assets.get(key);
    if (found?.length) return { kind: 'asset', assetIds: found.map((a) => a.id), label: `Asset ${found.map((a) => a.tag).join(', ')}` };
  }
  const { name, reference } = moveProductParts(set.product);
  return { kind: 'new', key: odooKey(name), partNumber: name, name: reference ?? name, label: 'New inactive item' };
}

async function build(rows: Record<string, string>[]): Promise<OdooMovesRecord> {
  const set = readMoves(rows);
  if (!set.moves.length) {
    throw new SkipRow(`Nothing to bring across — ${set.zeroRows} row(s) with quantity 0${set.notDone ? `, ${set.notDone} not done` : ''}`, true);
  }
  return { ...set, target: await targetFor(set) };
}

type Db = Prisma.TransactionClient | typeof prisma;

/** The keys already on file: `<itemId or assetId>|<importKey>`. */
async function onFile(itemIds: string[], assetIds: string[], db: Db = prisma): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < itemIds.length; i += 500) {
    const rows = await db.odooStockMove.findMany({ where: { itemId: { in: itemIds.slice(i, i + 500) } }, select: { itemId: true, importKey: true } });
    for (const r of rows) out.add(`${r.itemId}|${r.importKey}`);
  }
  for (let i = 0; i < assetIds.length; i += 500) {
    const rows = await db.odooAssetMove.findMany({ where: { assetId: { in: assetIds.slice(i, i + 500) } }, select: { assetId: true, importKey: true } });
    for (const r of rows) out.add(`${r.assetId}|${r.importKey}`);
  }
  return out;
}

const qty = (n: number) => n.toLocaleString('en-PH', { maximumFractionDigits: 3 });
const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-PH')} ${n === 1 ? one : many}`;

export const odooMovesSpec: ImportSpec<OdooMovesRecord> = {
  entity: 'odoo_moves',
  label: 'Odoo product moves',
  columns: COLUMNS,
  groupBy: (row) => odooKey(row[MOVE_HEADERS.product] ?? ''),
  // History is only ever added: a product reads as new work, never an update.
  existing: async () => null,
  build: async (row) => build([row]),
  buildGroup: async (rows) => build(rows),
  describe: (r) => {
    const t = moveTotals(r.moves);
    return [
      r.target.label,
      `${r.moves.length} move(s)`,
      t.in ? `${qty(t.in)} received` : null,
      t.out ? `${qty(t.out)} delivered` : null,
      r.zeroRows ? `${r.zeroRows} zero-quantity row(s) left out` : null,
      r.notDone ? `${r.notDone} not done, left out` : null,
    ]
      .filter(Boolean)
      .join(' · ');
  },
  summarize: async (records) => {
    const onItems = records.filter((r) => r.target.kind === 'item');
    const onAssets = records.filter((r) => r.target.kind === 'asset');
    const fresh = records.filter((r) => r.target.kind === 'new');
    const ids = [...new Set(onItems.map((r) => (r.target as ItemTarget).itemId))];
    const assetIds = [...new Set(onAssets.flatMap((r) => (r.target as AssetTarget).assetIds))];
    const have = await onFile(ids, assetIds);
    // A move counts once, however many assets of that Name show it.
    const firstId = (r: OdooMovesRecord) => (r.target.kind === 'item' ? r.target.itemId : r.target.kind === 'asset' ? r.target.assetIds[0] : null);
    const all: { r: OdooMovesRecord; m: OdooMove }[] = records.flatMap((r) => r.moves.map((m) => ({ r, m })));
    const added = all.filter(({ r, m }) => !firstId(r) || !have.has(`${firstId(r)}|${m.importKey}`));
    const totals = moveTotals(all.map((x) => x.m));
    const times = all.map((x) => x.m.occurredAt.getTime());
    const movesOf = (list: OdooMovesRecord[]) => list.reduce((s, r) => s + r.moves.length, 0);
    // What Odoo moved AFTER G-CORE took its opening balance: G-CORE's count
    // does not know these unless they were entered here too.
    const openings = await prisma.inventoryTransaction.findMany({
      where: { itemId: { in: ids }, sourceType: 'odoo_opening' },
      select: { itemId: true, occurredAt: true },
    });
    const openedAt = new Map<string, number>();
    for (const o of openings) openedAt.set(o.itemId, Math.min(openedAt.get(o.itemId) ?? Infinity, o.occurredAt.getTime()));
    const after = all
      .filter(({ r, m }) => r.target.kind === 'item' && m.direction !== 0 && openedAt.has(r.target.itemId) && m.occurredAt.getTime() > openedAt.get(r.target.itemId)!)
      .sort((a, b) => b.m.occurredAt.getTime() - a.m.occurredAt.getTime());
    const byKind = new Map<string, number[]>();
    for (const { m } of all) {
      const k = byKind.get(m.kind) ?? [0, 0];
      byKind.set(m.kind, [k[0] + 1, k[1] + m.quantity]);
    }
    let earliest = Infinity;
    let latest = -Infinity;
    for (const t of times) {
      if (t < earliest) earliest = t;
      if (t > latest) latest = t;
    }
    return {
      facts: [
        { label: 'What this does', value: 'Files the moves as history — on each item’s stock card, or on the asset’s page in G-HR. Stock on hand, costs and slips are not touched.' },
        { label: 'Items', value: `${count(onItems.length, 'product')} matched to an item by part number · ${count(movesOf(onItems), 'move')}` },
        { label: 'Assets (G-HR)', value: `${count(onAssets.length, 'product')} matched to a tool, laptop or vehicle in Asset Management · ${count(movesOf(onAssets), 'move')}` },
        {
          label: 'Not in G-CORE',
          value: fresh.length
            ? `${count(fresh.length, 'product')} (${count(movesOf(fresh), 'move')}) will be added to the Item Master as INACTIVE items with no stock, so their history can be found`
            : 'None — every product is an item or an asset already',
        },
        { label: 'Moves', value: `${added.length.toLocaleString('en-PH')} to add · ${(all.length - added.length).toLocaleString('en-PH')} already on file (left as they are)` },
        ...(times.length ? [{ label: 'From', value: `${formatDate(new Date(earliest))} to ${formatDate(new Date(latest))}` }] : []),
        { label: 'In and out', value: `${qty(totals.in)} received · ${qty(totals.out)} delivered` },
        { label: 'Left out', value: `${records.reduce((s, r) => s + r.zeroRows, 0).toLocaleString('en-PH')} zero-quantity rows · ${records.reduce((s, r) => s + r.notDone, 0)} not done` },
        ...(after.length
          ? [{ label: 'After the opening balance', value: `${after.length} move(s) are dated after G-CORE’s opening balance of their item — G-CORE’s stock does not include them unless they were also entered in G-CORE` }]
          : []),
      ],
      tables: [
        {
          title: 'By kind',
          head: ['Kind', 'Moves', 'Quantity'],
          rows: [...byKind.entries()].sort((a, b) => b[1][0] - a[1][0]).map(([k, v]) => [MOVE_KIND_LABELS[k as keyof typeof MOVE_KIND_LABELS], v[0], qty(v[1])]),
        },
        ...(fresh.length
          ? [
              {
                title: `Not in G-CORE — added as inactive items (${fresh.length})`,
                note: 'A tool, laptop or vehicle here? Stop: run G-HR › Asset Management › ⋯ › Import from Odoo with the product export first (it adds what Odoo no longer holds as Retired assets), then check this file again. The 60 with the most moves.',
                head: ['Part number', 'Description', 'Moves'],
                rows: [...fresh]
                  .sort((a, b) => b.moves.length - a.moves.length)
                  .slice(0, 60)
                  .map((r) => {
                    const t = r.target as NewTarget;
                    return [t.partNumber, t.name === t.partNumber ? '' : t.name, r.moves.length];
                  }),
              },
            ]
          : []),
        ...(after.length
          ? [
              {
                title: `Moved in Odoo after G-CORE’s opening balance (${after.length})`,
                note: 'Check these against the shelf: they changed the stock in Odoo after G-CORE started counting. The newest 50.',
                head: ['Item', 'Date', 'Reference', 'Kind', 'Quantity', 'Customer / supplier'],
                rows: after
                  .slice(0, 50)
                  .map(({ r, m }) => [r.target.label, formatDate(m.occurredAt), m.reference, MOVE_KIND_LABELS[m.kind], `${m.direction > 0 ? '+' : '−'}${qty(m.quantity)}`, m.contact ?? '']),
              },
            ]
          : []),
      ],
    };
  },
};

const rowOf = (m: OdooMove) => ({
  occurredAt: m.occurredAt,
  reference: m.reference,
  kind: m.kind,
  direction: m.direction,
  fromLocation: m.fromLocation,
  toLocation: m.toLocation,
  contact: m.contact,
  quantity: D(m.quantity),
  unit: m.unit,
  createdByName: m.createdByName,
  importKey: m.importKey,
});

export async function odooMovesWrite(records: { record: OdooMovesRecord; existingId: string | null }[], actor?: ImportActor): Promise<void> {
  const list = records.map((r) => r.record);
  await prisma.$transaction(async (tx) => {
    // A product G-CORE never held: an inactive item, once. Read again inside
    // the transaction — the check's answer may be minutes old.
    const wanted = list.filter((r) => r.target.kind === 'new').map((r) => r.target as NewTarget);
    const itemOf = new Map<string, string>();
    if (wanted.length) {
      const known = new Map(
        (await tx.item.findMany({ where: { partNumber: { not: null } }, select: { id: true, partNumber: true } })).map((i) => [odooKey(i.partNumber!), i.id]),
      );
      const fresh = [...new Map(wanted.filter((t) => !known.has(t.key)).map((t) => [t.key, t])).values()];
      const codes = await reserveNumbers('item', fresh.length, tx, async (numbers) =>
        new Set((await tx.item.findMany({ where: { code: { in: numbers } }, select: { code: true } })).map((i) => i.code)),
      );
      const materials = await tx.costCategory.findFirst({ where: { code: 'MAT' }, select: { id: true } });
      for (let i = 0; i < fresh.length; i += CHUNK) {
        await tx.item.createMany({
          data: fresh.slice(i, i + CHUNK).map((t, n) => ({
            code: codes[i + n],
            name: t.name,
            partNumber: t.partNumber,
            brand: odooBrand(t.name === t.partNumber ? '' : t.name, t.partNumber, null),
            costCategoryId: materials?.id ?? null,
            unit: 'pcs',
            isStocked: true,
            isActive: false,
            notes: 'From Odoo’s product moves — no longer a product in Odoo. Kept inactive for its movement history; it holds no stock.',
            createdById: actor?.id ?? null,
          })),
        });
      }
      const made = new Map((await tx.item.findMany({ where: { code: { in: codes } }, select: { id: true, code: true } })).map((i) => [i.code, i.id]));
      fresh.forEach((t, i) => known.set(t.key, made.get(codes[i])!));
      for (const t of wanted) itemOf.set(t.key, known.get(t.key)!);
      if (fresh.length) {
        await tx.auditLog.create({
          data: {
            entityType: 'item',
            entityId: 'list',
            action: 'CREATED',
            summary: `Added ${fresh.length} inactive item(s) for products in Odoo's move history that G-CORE did not hold — no stock, no cost`,
            actorId: actor?.id ?? null,
            actorName: actor?.name ?? null,
          },
        });
      }
    }

    const itemIdOf = (t: ItemTarget | NewTarget) => (t.kind === 'item' ? t.itemId : itemOf.get(t.key)!);
    const itemRows = list.flatMap((r) => (r.target.kind === 'asset' ? [] : r.moves.map((m) => ({ itemId: itemIdOf(r.target as ItemTarget | NewTarget), ...rowOf(m) }))));
    const assetRows = list.flatMap((r) => (r.target.kind === 'asset' ? r.target.assetIds.flatMap((assetId) => r.moves.map((m) => ({ assetId, ...rowOf(m) }))) : []));
    let added = 0;
    for (let i = 0; i < itemRows.length; i += CHUNK) {
      added += (await tx.odooStockMove.createMany({ data: itemRows.slice(i, i + CHUNK), skipDuplicates: true })).count;
    }
    let onAssets = 0;
    for (let i = 0; i < assetRows.length; i += CHUNK) {
      onAssets += (await tx.odooAssetMove.createMany({ data: assetRows.slice(i, i + CHUNK), skipDuplicates: true })).count;
    }
    await tx.auditLog.create({
      data: {
        entityType: 'item',
        entityId: 'list',
        action: 'CREATED',
        summary: `Imported Odoo's product moves as history: ${added} move(s) added on ${new Set(itemRows.map((r) => r.itemId)).size} item(s)${
          itemRows.length - added ? `, ${itemRows.length - added} already on file` : ''
        } — stock not touched`,
        actorId: actor?.id ?? null,
        actorName: actor?.name ?? null,
      },
    });
    if (assetRows.length) {
      await tx.auditLog.create({
        data: {
          entityType: 'company_asset',
          entityId: 'list',
          action: 'CREATED',
          summary: `Imported Odoo's product moves as history: ${onAssets} move(s) added on ${new Set(assetRows.map((r) => r.assetId)).size} asset(s)${
            assetRows.length - onAssets ? `, ${assetRows.length - onAssets} already on file` : ''
          } — nothing issued or returned`,
          actorId: actor?.id ?? null,
          actorName: actor?.name ?? null,
        },
      });
    }
  }, WRITE_TRANSACTION);
  forgetPartNumbers();
  assetCache = null;
}

export const odooMovesImport: Registered = {
  spec: odooMovesSpec as ImportSpec<never>,
  permission: 'gchain.items.create',
  write: odooMovesWrite as unknown as Registered['write'],
};
