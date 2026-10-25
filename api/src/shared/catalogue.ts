import type { Prisma } from '@prisma/client';
import sharp from 'sharp';
import { prisma } from '../prisma';
import { mainWarehouse } from './mainWarehouse';
import { deleteAttachment, saveAttachmentBytes } from './attachments';

/**
 * Inventory lists the whole CATALOGUE (2026-10-25, the owner's call during
 * the Odoo migration: "every product, with or without stock"). The list is
 * stock lines — item × warehouse — so an item never stocked anywhere gets a
 * PLACEHOLDER line in the main warehouse: nothing on hand, nothing on loan, no
 * cost, no bin. It moves nothing and is worth nothing (`stockOnHand` counts
 * quantity above zero); the first receipt into the main warehouse fills it,
 * and a receipt into any other warehouse drops it (`dropPlaceholder`), so an
 * item is never listed twice for want of stock.
 */

type Tx = Prisma.TransactionClient;

/** The placeholder line for each active, stocked item with no line anywhere. */
export async function placeOnShelf(tx: Tx = prisma, itemIds?: string[]): Promise<number> {
  const main = await mainWarehouse(tx);
  if (!main) return 0;
  const missing = await tx.item.findMany({
    where: { isActive: true, isStocked: true, balances: { none: {} }, ...(itemIds ? { id: { in: itemIds } } : {}) },
    select: { id: true },
  });
  if (!missing.length) return 0;
  const made = await tx.inventoryBalance.createMany({
    data: missing.map((i) => ({ itemId: i.id, warehouseId: main.id })),
    skipDuplicates: true,
  });
  return made.count;
}

/**
 * A line just opened in a warehouse other than the main one takes the
 * item's placeholder away — only while it is still empty and never moved.
 */
export async function dropPlaceholder(tx: Tx, itemId: string, warehouseId: string): Promise<void> {
  const main = await mainWarehouse(tx);
  if (!main || main.id === warehouseId) return;
  const moved = await tx.inventoryTransaction.count({ where: { itemId, warehouseId: main.id } });
  if (moved) return;
  await tx.inventoryBalance.deleteMany({
    where: { itemId, warehouseId: main.id, quantity: 0, borrowedQty: 0, averageCost: 0, locationId: null },
  });
}

/** Every deploy: the catalogue placed, and a placeholder left beside real stock elsewhere taken away. */
export async function syncCatalogue(): Promise<{ placed: number; dropped: number }> {
  const placed = await placeOnShelf();
  const main = await mainWarehouse();
  let dropped = 0;
  if (main) {
    const stale = await prisma.inventoryBalance.findMany({
      where: {
        warehouseId: main.id,
        quantity: 0,
        borrowedQty: 0,
        averageCost: 0,
        locationId: null,
        item: { balances: { some: { warehouseId: { not: main.id } } } },
      },
      select: { id: true, itemId: true },
    });
    for (const s of stale) {
      if (await prisma.inventoryTransaction.count({ where: { itemId: s.itemId, warehouseId: main.id } })) continue;
      dropped += (await prisma.inventoryBalance.deleteMany({ where: { id: s.id } })).count;
    }
  }
  return { placed, dropped };
}

/** The widest side a stored product picture keeps — enough for a card and a stock card. */
export const PHOTO_MAX_PX = 800;

/**
 * A picture made fit to keep: turned upright, fitted inside 800 px (never
 * enlarged) and written as a JPEG, so a 1.7 MB upload is stored at a few
 * dozen KB. Throws when the bytes are not a picture.
 */
export async function photoBytes(input: Buffer): Promise<Buffer> {
  return sharp(input, { failOn: 'error' })
    .rotate()
    .resize({ width: PHOTO_MAX_PX, height: PHOTO_MAX_PX, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
}

/**
 * Files a picture as the item's (or the company asset's) photo, the old one
 * removed after the new one is in place. `kind` names the attachment type.
 */
export async function setPhoto(
  kind: 'item' | 'asset',
  id: string,
  image: Buffer,
  uploadedById: string,
  caption?: string,
): Promise<string> {
  const bytes = await photoBytes(image);
  const entityType = kind === 'item' ? 'item_photo' : 'asset_photo';
  const saved = await saveAttachmentBytes({
    entityType,
    entityId: id,
    bytes,
    fileName: `${kind}-${id}.jpg`,
    mimeType: 'image/jpeg',
    uploadedById,
    caption,
  });
  if (kind === 'item') await prisma.item.update({ where: { id }, data: { photoId: saved.id } });
  else await prisma.companyAsset.update({ where: { id }, data: { photoId: saved.id } });
  for (const old of await oldPhotos(entityType, id, saved.id)) await deleteAttachment(old);
  return saved.id;
}

/** Removes the photo: the attachment and the pointer. */
export async function clearPhoto(kind: 'item' | 'asset', id: string): Promise<void> {
  const entityType = kind === 'item' ? 'item_photo' : 'asset_photo';
  if (kind === 'item') await prisma.item.update({ where: { id }, data: { photoId: null } });
  else await prisma.companyAsset.update({ where: { id }, data: { photoId: null } });
  for (const old of await oldPhotos(entityType, id, null)) await deleteAttachment(old);
}

async function oldPhotos(entityType: string, entityId: string, keep: string | null): Promise<string[]> {
  const rows = await prisma.attachment.findMany({ where: { entityType, entityId, ...(keep ? { id: { not: keep } } : {}) }, select: { id: true } });
  return rows.map((r) => r.id);
}
