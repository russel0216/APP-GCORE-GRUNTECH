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
 * The groups already in use, for the seed: every QuotationItem.group.
 * Idempotent — a second run adds none.
 */
export async function seedQuotationGroups(): Promise<number> {
  const live = await prisma.quotationItem.findMany({
    where: { group: { not: null } },
    distinct: ['group'],
    select: { group: true },
  });
  return prisma.$transaction((tx) => rememberGroups(tx, live.map((l) => l.group)));
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
  // A group an administrator deleted stays deleted (OTHERS cannot be).
  const deleted = await deletedGroupKeys();
  for (const [i, g] of OWNER_GROUPS.entries()) {
    const key = groupKey(g.name);
    if (deleted.has(key) && key !== groupKey(FALLBACK_GROUP)) continue;
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

/** Where a deleted group's lines go, and the one group that cannot be deleted. */
export const FALLBACK_GROUP = 'OTHERS';

/**
 * The keys of groups an administrator deleted (2026-10-11, the owner's call:
 * "allow me to delete also the group"), so `seedOwnerGroups()` never brings
 * one of the owner's twelve back on the next deploy. Creating the group again
 * by name takes it off this list.
 */
export const DELETED_GROUPS_SETTING = 'quotationGroups.deleted';

export async function deletedGroupKeys(tx: Tx | typeof prisma = prisma): Promise<Set<string>> {
  const row = await tx.setting.findUnique({ where: { key: DELETED_GROUPS_SETTING } });
  const value = row?.value;
  return new Set(Array.isArray(value) ? value.filter((k): k is string => typeof k === 'string') : []);
}

export async function setDeletedGroupKeys(tx: Tx, keys: Set<string>): Promise<void> {
  const value = [...keys].sort();
  await tx.setting.upsert({ where: { key: DELETED_GROUPS_SETTING }, create: { key: DELETED_GROUPS_SETTING, value }, update: { value } });
}

/**
 * Deletes a group for good: every quotation and sales order line filed under
 * it (any spelling of its key) moves to OTHERS, the row goes, and its key is
 * remembered so no seed adds it back. Lines keep their group as text, so
 * moving them first is what keeps the group from returning the next time one
 * of those quotations is saved. OTHERS itself is never deleted.
 */
export async function deleteGroup(tx: Tx, group: { id: string; key: string; name: string }) {
  const spellings = async (rows: { group: string | null }[]) =>
    [...new Set(rows.map((r) => r.group).filter((g): g is string => !!g && groupKey(g) === group.key))];
  // Every spelling sharing its key ("Omega Air", "OMEGA  AIR"), read once each.
  const quoteNames = await spellings(await tx.quotationItem.findMany({ where: { group: { not: null } }, distinct: ['group'], select: { group: true } }));
  const allOrder = await spellings(await tx.salesOrderLine.findMany({ where: { group: { not: null } }, distinct: ['group'], select: { group: true } }));
  const quotationLines = quoteNames.length
    ? (await tx.quotationItem.updateMany({ where: { group: { in: quoteNames } }, data: { group: FALLBACK_GROUP } })).count
    : 0;
  const orderLines = allOrder.length
    ? (await tx.salesOrderLine.updateMany({ where: { group: { in: allOrder } }, data: { group: FALLBACK_GROUP } })).count
    : 0;
  await rememberGroups(tx, [FALLBACK_GROUP]);
  await tx.quotationGroup.delete({ where: { id: group.id } });
  const deleted = await deletedGroupKeys(tx);
  deleted.add(group.key);
  await setDeletedGroupKeys(tx, deleted);
  return { quotationLines, orderLines };
}
