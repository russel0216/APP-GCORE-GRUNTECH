import { prisma } from '../../prisma';
import { badRequest } from '../../http/kit';
import { SkipRow, type ImportSpec, type ImportActor } from '../../shared/csv';
import { setPhoto } from '../../shared/catalogue';
import { odooKey, tidy } from '../../shared/odooMigration';
import type { Registered } from '../imports';

/**
 * Odoo's product PICTURES (2026-10-25, the owner's export for the Inventory
 * cards): Odoo writes a product's image into the CSV as base64 in the
 * `image_1920` column, beside `id`, `name`, `default_code` and `uom_id` — the
 * technical names its "export for import" uses. The Name is the key, as in
 * the product import: it finds the ITEM whose part number it is, else the
 * G-HR ASSETS that import made from it (every asset of that name). Each
 * picture is decoded, turned upright, fitted inside 800 px and stored as a
 * JPEG (`setPhoto`) — a 1.7 MB upload keeps a few dozen KB.
 *
 * Once only: an item or asset that already has a photo keeps it and the row
 * is listed as skipped, so the file run again changes nothing; a picture is
 * replaced by hand on the item. A Name nobody in G-CORE answers to is listed
 * as skipped too (import the products first) — never an error, so one stray
 * row never holds back the rest. Rows sharing a Name (Odoo's duplicates,
 * merged into one item) give the first picture.
 *
 * A full export runs to a gigabyte, so it is taken in batches: the route
 * lets this import upload up to `PICTURE_UPLOAD_MB`.
 */

export const PICTURE_UPLOAD_MB = 95;

const NAME = 'name';
const IMAGE = 'image_1920';

interface PictureRecord {
  key: string;
  name: string;
  /** Base64 as Odoo wrote it. */
  image: string;
  /** Roughly how big the picture is, decoded. */
  bytes: number;
  itemId: string | null;
  assetIds: string[];
}

/** Who answers to each Name, read once a run (the dry run reads it again). */
let lookup: { at: number; items: Map<string, { id: string; code: string; photoId: string | null }>; assets: Map<string, { id: string; tag: string; photoId: string | null }[]> } | null = null;

async function targets() {
  if (lookup && Date.now() - lookup.at < 10_000) return lookup;
  const [items, assets] = await Promise.all([
    prisma.item.findMany({ where: { partNumber: { not: null } }, select: { id: true, code: true, partNumber: true, photoId: true } }),
    prisma.companyAsset.findMany({ where: { importRef: { startsWith: 'odoo:' } }, select: { id: true, tag: true, importRef: true, photoId: true } }),
  ]);
  const byItem = new Map(items.map((i) => [odooKey(i.partNumber!), { id: i.id, code: i.code, photoId: i.photoId }]));
  const byAsset = new Map<string, { id: string; tag: string; photoId: string | null }[]>();
  for (const a of assets) {
    const key = a.importRef!.slice(a.importRef!.indexOf('|') + 1);
    byAsset.set(key, [...(byAsset.get(key) ?? []), { id: a.id, tag: a.tag, photoId: a.photoId }]);
  }
  lookup = { at: Date.now(), items: byItem, assets: byAsset };
  return lookup;
}

async function buildPicture(rows: Record<string, string>[]): Promise<PictureRecord> {
  const name = tidy(rows[0][NAME]);
  if (!name) throw new Error('The name is empty');
  const row = rows.find((r) => tidy(r[IMAGE])) ?? null;
  if (!row) throw new SkipRow('No picture in Odoo', true);
  const image = row[IMAGE].replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=]+$/.test(image)) throw new Error('The picture is not base64 as Odoo writes it');
  const key = odooKey(name);
  const t = await targets();
  const item = t.items.get(key) ?? null;
  const assets = t.assets.get(key) ?? [];
  if (!item && !assets.length) throw new SkipRow('No item or asset of this name in G-CORE — import the products first (an asset with nothing on hand in Odoo was not imported)');
  const itemNeeds = item && !item.photoId ? item.id : null;
  const assetNeeds = assets.filter((a) => !a.photoId).map((a) => a.id);
  if (!itemNeeds && !assetNeeds.length) throw new SkipRow(`Already has a photo — kept (${item ? item.code : assets.map((a) => a.tag).join(', ')})`);
  return { key, name, image, bytes: Math.floor((image.length * 3) / 4), itemId: itemNeeds, assetIds: assetNeeds };
}

export const odooPicturesSpec: ImportSpec<PictureRecord> = {
  entity: 'odoo_pictures',
  label: 'Odoo product pictures',
  columns: [
    { header: NAME, required: true, example: 'OOP - 213.53-E 100PSI/0-7BAR', hint: "Odoo's Name — the item's part number" },
    { header: IMAGE, required: true, example: '/9j/4AAQSkZJRgABAQ…', hint: 'The picture, base64, as Odoo exports it' },
    { header: 'id', example: '__export__.product_template_5553_bb311379', hint: 'Not used' },
    { header: 'default_code', example: 'WIKA, BOURDON TUBE PRESSURE GAUGE', hint: 'Not used' },
  ],
  groupBy: (row) => odooKey(row[NAME] ?? ''),
  existing: async () => null,
  build: async (row) => buildPicture([row]),
  buildGroup: async (rows) => buildPicture(rows),
  describe: (r) =>
    [r.itemId ? 'the item' : null, r.assetIds.length ? (r.assetIds.length > 1 ? `${r.assetIds.length} assets` : 'the asset') : null]
      .filter(Boolean)
      .join(' and ') + ` · ${Math.max(1, Math.round(r.bytes / 1024))} KB as sent`,
  summarize: async (records) => {
    const sent = records.reduce((s, r) => s + r.bytes, 0);
    return {
      facts: [
        { label: 'Pictures', value: `${records.length} to file — ${records.filter((r) => r.itemId).length} on items, ${records.reduce((s, r) => s + r.assetIds.length, 0)} on G-HR assets` },
        { label: 'Size', value: `${(sent / 1024 / 1024).toFixed(1)} MB as sent; each is stored fitted inside 800 px as a JPEG, a small part of that` },
      ],
    };
  },
};

export async function odooPicturesWrite(records: { record: PictureRecord; existingId: string | null }[], actor?: ImportActor): Promise<void> {
  if (!actor) throw badRequest('Who is importing is not known');
  lookup = null;
  let items = 0;
  let assets = 0;
  const unreadable: string[] = [];
  for (const { record: r } of records) {
    const bytes = Buffer.from(r.image, 'base64');
    try {
      // Read again: a picture set by hand since the check is kept.
      if (r.itemId && !(await prisma.item.findUnique({ where: { id: r.itemId }, select: { photoId: true } }))?.photoId) {
        await setPhoto('item', r.itemId, bytes, actor.id, `From Odoo — ${r.name}`);
        items += 1;
      }
      for (const id of r.assetIds) {
        if ((await prisma.companyAsset.findUnique({ where: { id }, select: { photoId: true } }))?.photoId) continue;
        await setPhoto('asset', id, bytes, actor.id, `From Odoo — ${r.name}`);
        assets += 1;
      }
    } catch {
      unreadable.push(r.name);
    }
  }
  await prisma.auditLog.create({
    data: {
      entityType: 'item',
      entityId: 'list',
      action: 'UPDATED',
      summary: `Imported Odoo's product pictures: ${items} on items, ${assets} on G-HR assets${unreadable.length ? `; ${unreadable.length} could not be read as a picture (${unreadable.slice(0, 5).join(', ')}${unreadable.length > 5 ? ' …' : ''})` : ''}`,
      actorId: actor.id,
      actorName: actor.name,
    },
  });
}

export const odooPicturesImport: Registered = {
  spec: odooPicturesSpec as ImportSpec<never>,
  permission: 'gchain.items.create',
  write: odooPicturesWrite as unknown as Registered['write'],
};
