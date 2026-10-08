import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

type Tx = Prisma.TransactionClient;

/** One group per spelling, case-blind: "Trading" and "trading " are one. */
export function groupKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Adds every group named here that the master does not have yet, inside the
 * caller's transaction — so a group typed on a quotation line becomes one the
 * editor suggests next time, with nobody having to file it in Admin first.
 * Existing rows are left exactly as they are (an administrator's spelling, or
 * a deactivated group, is not overwritten).
 */
export async function rememberGroups(tx: Tx, names: (string | null | undefined)[]): Promise<number> {
  const byKey = new Map<string, string>();
  for (const raw of names) {
    const name = (raw ?? '').trim().replace(/\s+/g, ' ');
    if (!name) continue;
    const key = groupKey(name);
    if (!byKey.has(key)) byKey.set(key, name.slice(0, 120));
  }
  if (!byKey.size) return 0;
  const made = await tx.quotationGroup.createMany({
    data: [...byKey].map(([key, name]) => ({ key, name })),
    skipDuplicates: true,
  });
  return made.count;
}

/**
 * The groups already in use, for the seed: every QuotationItem.group, and any
 * `group` a SCORO archive line carries. Idempotent — a second run adds none.
 * (The archive's PDF converter keeps no group today, so its lines add nothing
 * unless a later bundle carries one.)
 */
export async function seedQuotationGroups(): Promise<number> {
  const live = await prisma.quotationItem.findMany({
    where: { group: { not: null } },
    distinct: ['group'],
    select: { group: true },
  });
  const archived = await prisma.legacyQuote.findMany({ select: { lines: true } });
  const fromArchive: string[] = [];
  for (const q of archived) {
    for (const line of Array.isArray(q.lines) ? (q.lines as Record<string, unknown>[]) : []) {
      if (typeof line?.group === 'string') fromArchive.push(line.group);
    }
  }
  return prisma.$transaction((tx) => rememberGroups(tx, [...live.map((l) => l.group), ...fromArchive]));
}

/**
 * The owner's product groups (2026-10-08), in his order, each with what it
 * covers and the brand a line filed under it carries. The three house groups
 * carry no brand. Seeded by `seedOwnerGroups()`: a group that already exists
 * (by key) is kept as it is, and only what is BLANK on it is filled — an
 * administrator's description, brand or order is never overwritten.
 */
export const OWNER_GROUPS: { name: string; description: string | null; brand: string | null }[] = [
  { name: 'OMEGA AIR', description: 'Compressed Air & Gas Treatment and Separation', brand: 'OMEGA AIR' },
  { name: 'SCHNEIDER ELECTRIC', description: 'Automation, Motor Controls, Process and Energy Solutions', brand: 'SCHNEIDER ELECTRIC' },
  { name: 'PENTAIR', description: 'UL/FM Fire Pumps & Specialized Pump Systems', brand: 'PENTAIR' },
  { name: 'SUTO-ITEC', description: 'Compressed Air & Gas Instruments', brand: 'SUTO-ITEC' },
  { name: 'NIDEC DRIVES (JAPAN)', description: 'VFD, Motors & Soft Starter', brand: 'NIDEC DRIVES (JAPAN)' },
  { name: 'KSB PUMPS', description: 'Valves, Process Pumps and Systems', brand: 'KSB PUMPS' },
  { name: 'PREVOST', description: 'Quick-Connect Compressed Air Piping Technology', brand: 'PREVOST' },
  { name: 'SURE PURITY', description: 'CO2 Polishing & Gas Purification Systems', brand: 'SURE PURITY' },
  { name: 'HORIBA', description: 'Water analyzer, Energy & Environment Solutions', brand: 'HORIBA' },
  { name: 'GRUNTECHNOLOGY', description: null, brand: null },
  { name: 'GRUNTECH SERVICES', description: null, brand: null },
  { name: 'OTHERS', description: null, brand: null },
];

export async function seedOwnerGroups(): Promise<number> {
  let added = 0;
  for (const [i, g] of OWNER_GROUPS.entries()) {
    const key = groupKey(g.name);
    const existing = await prisma.quotationGroup.findUnique({ where: { key } });
    if (!existing) {
      await prisma.quotationGroup.create({ data: { key, name: g.name, description: g.description, brand: g.brand, sortOrder: i + 1 } });
      added++;
      continue;
    }
    const data: Prisma.QuotationGroupUpdateInput = {};
    if (!existing.description && g.description) data.description = g.description;
    if (!existing.brand && g.brand) data.brand = g.brand;
    if (existing.sortOrder === 0) data.sortOrder = i + 1;
    if (Object.keys(data).length) await prisma.quotationGroup.update({ where: { id: existing.id }, data });
  }
  return added;
}
