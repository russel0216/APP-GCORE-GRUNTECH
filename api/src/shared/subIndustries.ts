import { prisma } from '../prisma';

/**
 * Where a customer sits in the market (2026-10-08, the owner's call): the
 * eleven sub-industries, typed in by hand on the customer and optional —
 * "later they manually input which sub-industry the customer falls on". A
 * reference list like the cost categories: the seeded rows are system rows
 * (undeletable, renamable), an administrator may add more under Admin ›
 * Categories, and a customer may still have none ("Not stated").
 *
 * The customer's INDUSTRY (the sales team's list — KAT, HIT, UIT, GIB, SIT)
 * is no longer asked for on a customer; it is the person's team.
 */
export const SUB_INDUSTRIES = [
  'Enterprise',
  'Hospital',
  'Pharmaceutical',
  'Power and Water',
  'Laguna & Batangas Hubs',
  'Cavite Hubs',
  'Manufacturing',
  'Building',
  'EPC',
  'Infrastructure',
  'Government',
] as const;

/** Seeds the eleven; a row already on file keeps its name and order (an administrator's spelling is never overwritten). */
export async function seedSubIndustries(): Promise<number> {
  let created = 0;
  for (const [i, name] of SUB_INDUSTRIES.entries()) {
    const existing = await prisma.subIndustry.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
    if (existing) {
      if (!existing.isSystem) await prisma.subIndustry.update({ where: { id: existing.id }, data: { isSystem: true } });
      continue;
    }
    await prisma.subIndustry.create({ data: { name, sortOrder: i, isSystem: true } });
    created++;
  }
  return created;
}
