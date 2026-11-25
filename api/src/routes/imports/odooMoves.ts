import { Prisma } from '@prisma/client';
import { prisma } from '../../prisma';
import { SkipRow, type ImportActor, type ImportSpec } from '../../shared/csv';
import { formatDate } from '../../shared/pdf';
import { odooKey } from '../../shared/odooMigration';
import { MOVE_HEADERS, MOVE_KIND_LABELS, moveProductLabel, moveTotals, readMoves, type OdooMove, type OdooMoveSet } from '../../shared/odooMoves';
import type { Registered } from '../imports';
import { partNumbers } from './odoo';

/**
 * Odoo's "Product Moves" export, kept as HISTORY (2026-11-25, the owner's
 * call: "we just want to know where the product moved — don't create a
 * pull-out slip"). `odoo_moves` (G-CHAIN › Inventory ⋯): each row is filed
 * against the item whose part number is Odoo's product Name, and shown on that
 * item's stock card. Nothing else happens — no balance, no average cost, no
 * slip, no report reads these rows.
 *
 * One result per PRODUCT (its rows grouped), so a file of every product stays
 * readable; a product G-CORE has no item for is listed as skipped. The same
 * line imported twice adds nothing (`importKey`).
 */

const WRITE_TRANSACTION = { maxWait: 20_000, timeout: 240_000 } as const;
const CHUNK = 2_000;
const D = (n: number) => new Prisma.Decimal(n);

export interface OdooMovesRecord extends OdooMoveSet {
  itemId: string;
  itemCode: string;
}

const COLUMNS = [
  { header: MOVE_HEADERS.date, required: true, example: '2026-11-19 14:21:20', hint: "Odoo's date and time, as exported" },
  { header: MOVE_HEADERS.reference, required: true, example: 'WH/OUT/04895', hint: "Odoo's transfer number" },
  { header: MOVE_HEADERS.product, required: true, example: '[Schneider, Miniature Relay] SRC - RXM4LB2P7', hint: 'The part after the brackets finds the item by its part number' },
  { header: MOVE_HEADERS.from, required: true, example: 'WH/Stock' },
  { header: MOVE_HEADERS.to, required: true, example: 'Partner Locations/Customers' },
  { header: MOVE_HEADERS.contact, example: 'MONDE M.Y. SAN CORPORATION - CAINTA', hint: 'The customer or supplier, kept as written' },
  { header: MOVE_HEADERS.quantity, required: true, example: '12', hint: 'A row with 0 moved nothing and is left out' },
  { header: MOVE_HEADERS.unit, example: 'Units' },
  { header: MOVE_HEADERS.status, example: 'Done', hint: 'Only Done rows are kept' },
  { header: MOVE_HEADERS.by, example: 'Karen Gasiong' },
];

async function itemFor(keys: string[]): Promise<{ id: string; code: string } | null> {
  const parts = await partNumbers();
  for (const key of keys) {
    const found = parts.get(key);
    if (found) return found;
  }
  return null;
}

async function build(rows: Record<string, string>[]): Promise<OdooMovesRecord> {
  const set = readMoves(rows);
  const item = await itemFor(set.keys);
  if (!item) throw new SkipRow(`No item in G-CORE has the part number "${moveProductLabel(set.product)}" — import the product first (a tool or vehicle kept in G-HR has no stock card)`);
  if (!set.moves.length) {
    throw new SkipRow(`Nothing to bring across — ${set.zeroRows} row(s) with quantity 0${set.notDone ? `, ${set.notDone} not done` : ''}`, true);
  }
  return { ...set, itemId: item.id, itemCode: item.code };
}

/** The keys already on file for these items: `<itemId>|<importKey>`. */
async function onFile(itemIds: string[], db: Prisma.TransactionClient | typeof prisma = prisma): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < itemIds.length; i += 500) {
    const rows = await db.odooStockMove.findMany({ where: { itemId: { in: itemIds.slice(i, i + 500) } }, select: { itemId: true, importKey: true } });
    for (const r of rows) out.add(`${r.itemId}|${r.importKey}`);
  }
  return out;
}

const qty = (n: number) => n.toLocaleString('en-PH', { maximumFractionDigits: 3 });

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
      `${r.itemCode}`,
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
    const ids = [...new Set(records.map((r) => r.itemId))];
    const have = await onFile(ids);
    const all: { r: OdooMovesRecord; m: OdooMove }[] = records.flatMap((r) => r.moves.map((m) => ({ r, m })));
    const fresh = all.filter(({ r, m }) => !have.has(`${r.itemId}|${m.importKey}`));
    const totals = moveTotals(all.map((x) => x.m));
    const times = all.map((x) => x.m.occurredAt.getTime());
    // What Odoo moved AFTER G-CORE took its opening balance: G-CORE's count
    // does not know these unless they were entered here too.
    const openings = await prisma.inventoryTransaction.findMany({
      where: { itemId: { in: ids }, sourceType: 'odoo_opening' },
      select: { itemId: true, occurredAt: true },
    });
    const openedAt = new Map<string, number>();
    for (const o of openings) openedAt.set(o.itemId, Math.min(openedAt.get(o.itemId) ?? Infinity, o.occurredAt.getTime()));
    const after = all
      .filter(({ r, m }) => m.direction !== 0 && openedAt.has(r.itemId) && m.occurredAt.getTime() > openedAt.get(r.itemId)!)
      .sort((a, b) => b.m.occurredAt.getTime() - a.m.occurredAt.getTime());
    const byKind = new Map<string, number[]>();
    for (const { m } of all) {
      const k = byKind.get(m.kind) ?? [0, 0];
      byKind.set(m.kind, [k[0] + 1, k[1] + m.quantity]);
    }
    return {
      facts: [
        { label: 'What this does', value: 'Files the moves as history on each item’s stock card. Stock on hand, costs and slips are not touched.' },
        { label: 'Products', value: `${records.length} matched to an item by part number` },
        { label: 'Moves', value: `${fresh.length} to add · ${all.length - fresh.length} already on file (left as they are)` },
        ...(times.length ? [{ label: 'From', value: `${formatDate(new Date(Math.min(...times)))} to ${formatDate(new Date(Math.max(...times)))}` }] : []),
        { label: 'In and out', value: `${qty(totals.in)} received · ${qty(totals.out)} delivered` },
        { label: 'Left out', value: `${records.reduce((s, r) => s + r.zeroRows, 0)} zero-quantity rows · ${records.reduce((s, r) => s + r.notDone, 0)} not done` },
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
        ...(after.length
          ? [
              {
                title: `Moved in Odoo after G-CORE’s opening balance (${after.length})`,
                note: 'Check these against the shelf: they changed the stock in Odoo after G-CORE started counting. The newest 50.',
                head: ['Item', 'Date', 'Reference', 'Kind', 'Quantity', 'Customer / supplier'],
                rows: after
                  .slice(0, 50)
                  .map(({ r, m }) => [r.itemCode, formatDate(m.occurredAt), m.reference, MOVE_KIND_LABELS[m.kind], `${m.direction > 0 ? '+' : '−'}${qty(m.quantity)}`, m.contact ?? '']),
              },
            ]
          : []),
      ],
    };
  },
};

export async function odooMovesWrite(records: { record: OdooMovesRecord; existingId: string | null }[], actor?: ImportActor): Promise<void> {
  const rows = records.flatMap(({ record: r }) =>
    r.moves.map((m) => ({
      itemId: r.itemId,
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
    })),
  );
  await prisma.$transaction(async (tx) => {
    let added = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      added += (await tx.odooStockMove.createMany({ data: rows.slice(i, i + CHUNK), skipDuplicates: true })).count;
    }
    await tx.auditLog.create({
      data: {
        entityType: 'item',
        entityId: 'list',
        action: 'CREATED',
        summary: `Imported Odoo's product moves as history: ${added} move(s) added on ${records.length} item(s)${rows.length - added ? `, ${rows.length - added} already on file` : ''} — stock not touched`,
        actorId: actor?.id ?? null,
        actorName: actor?.name ?? null,
      },
    });
  }, WRITE_TRANSACTION);
}

export const odooMovesImport: Registered = {
  spec: odooMovesSpec as ImportSpec<never>,
  permission: 'gchain.items.create',
  write: odooMovesWrite as unknown as Registered['write'],
};
