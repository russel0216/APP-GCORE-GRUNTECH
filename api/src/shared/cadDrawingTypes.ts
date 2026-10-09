import { prisma } from '../prisma';

/**
 * What kind of drawing a CAD job order asks for (2026-10-09): Admin ›
 * Categories › Drawing types. The seeded rows are system rows — renamable,
 * undeletable, switched off rather than removed — and an administrator may
 * add more. A request points at a row, so a rename reaches every request
 * that carries it. The output to the requestor is always a PDF, whatever the
 * type; the type says what is drawn, not how it is delivered.
 */
export const CAD_DRAWING_TYPES = [
  'Layout plan',
  'P&ID / schematic',
  'Single-line diagram',
  '3D model / rendering',
  'Shop drawing',
  'As-built',
  'Other',
] as const;

/** Seeds the list; a row already on file keeps its name and order (an administrator's spelling is never overwritten). */
export async function seedCadDrawingTypes(): Promise<number> {
  let created = 0;
  for (const [i, name] of CAD_DRAWING_TYPES.entries()) {
    const existing = await prisma.cadDrawingType.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
    if (existing) {
      if (!existing.isSystem) await prisma.cadDrawingType.update({ where: { id: existing.id }, data: { isSystem: true } });
      continue;
    }
    await prisma.cadDrawingType.create({ data: { name, sortOrder: i, isSystem: true } });
    created++;
  }
  return created;
}
