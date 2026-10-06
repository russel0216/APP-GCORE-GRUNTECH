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
