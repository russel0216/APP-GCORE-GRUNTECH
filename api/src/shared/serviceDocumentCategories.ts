import { prisma } from '../prisma';

/**
 * What a service document is (2026-10-20, the owner's revised Aftermarket
 * UI — "Technical documents", the fifth card and strip entry): Admin ›
 * Categories › Service document categories. The seeded rows are system rows
 * — renamable, undeletable, switched off rather than removed — and an
 * administrator may add more. A document points at a row, so a rename
 * reaches every document that carries it.
 */
export const SERVICE_DOCUMENT_CATEGORIES = [
  'Manual',
  'Electrical drawing',
  'Test report',
  'Drawing / datasheet',
  'Certificate',
  'Other',
] as const;

/** Seeds the list; a row already on file keeps its name and order (an administrator's spelling is never overwritten). */
export async function seedServiceDocumentCategories(): Promise<number> {
  let created = 0;
  for (const [i, name] of SERVICE_DOCUMENT_CATEGORIES.entries()) {
    const existing = await prisma.serviceDocumentCategory.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
    if (existing) {
      if (!existing.isSystem) await prisma.serviceDocumentCategory.update({ where: { id: existing.id }, data: { isSystem: true } });
      continue;
    }
    await prisma.serviceDocumentCategory.create({ data: { name, sortOrder: i, isSystem: true } });
    created++;
  }
  return created;
}
