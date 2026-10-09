import { prisma } from '../prisma';

/**
 * Where a customer sits in the market: the owner's list of sub-industries
 * (2026-10-09 — twenty-six, replacing the eleven of 2026-10-08), typed in by
 * hand on the customer and optional — "later they manually input which
 * sub-industry the customer falls on". A reference list like the cost
 * categories: the seeded rows are system rows (undeletable, renamable), an
 * administrator may add more under Admin › Categories, and a customer may
 * still have none ("Not stated").
 *
 * The customer's TEAM (KAT, HIT, UIT, GIB, SIT — the Industry master) is a
 * separate, optional field on the customer: who handles them. Left open on
 * every customer until somebody sets it (the owner's call).
 */
export const SUB_INDUSTRIES = [
  'Commercial Building and Land Development',
  'Aerospace',
  'Agriculture',
  'Amusement and Parks',
  'Building Materials (Stone, Clay, Glass, Cement)',
  'Chemical',
  'Electronics and Semiconductor',
  'Food and Beverage',
  'Furniture and Fixture',
  'Government',
  'Healthcare',
  'Heavy Industry',
  'Industrial and Commercial Machinery',
  'Lumber and Wood',
  'Metal',
  'Mining',
  'Paper, Printing, Publishing, and Allied Industry',
  'Petrochemical and Oil',
  'Pharmaceutical',
  'Power Utilities',
  'Rubber and Plastic',
  'Shipping and Marine',
  'Textile, Leather and Apparel',
  'Tobacco Industry',
  'Transportation Equipment and Automotive Industry',
  'Water Utilities',
] as const;

/**
 * The eleven of 2026-10-08 that the owner's list renamed outright: the row
 * keeps its id (and its customers) under the new name. The rest of the
 * eleven that the list does not carry are switched off, never deleted — a
 * customer filed under one keeps it, shown as inactive, until somebody
 * refiles them.
 */
const RENAMED: Record<string, string> = {
  Hospital: 'Healthcare',
  Building: 'Commercial Building and Land Development',
};

const RETIRED = ['Enterprise', 'Power and Water', 'Laguna & Batangas Hubs', 'Cavite Hubs', 'Manufacturing', 'EPC', 'Infrastructure'];

/** Seeds the list; a row already on file keeps its name and order (an administrator's spelling is never overwritten). */
export async function seedSubIndustries(): Promise<number> {
  for (const [from, to] of Object.entries(RENAMED)) {
    const old = await prisma.subIndustry.findFirst({ where: { name: { equals: from, mode: 'insensitive' } } });
    const taken = await prisma.subIndustry.findFirst({ where: { name: { equals: to, mode: 'insensitive' } } });
    if (old && !taken) await prisma.subIndustry.update({ where: { id: old.id }, data: { name: to } });
  }
  for (const name of RETIRED) {
    await prisma.subIndustry.updateMany({ where: { name: { equals: name, mode: 'insensitive' }, isSystem: true, isActive: true }, data: { isActive: false } });
  }

  let created = 0;
  for (const [i, name] of SUB_INDUSTRIES.entries()) {
    const existing = await prisma.subIndustry.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
    if (existing) {
      if (!existing.isSystem || existing.sortOrder !== i) {
        await prisma.subIndustry.update({ where: { id: existing.id }, data: { isSystem: true, sortOrder: i } });
      }
      continue;
    }
    await prisma.subIndustry.create({ data: { name, sortOrder: i, isSystem: true } });
    created++;
  }
  return created;
}
