import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

/**
 * "What they supply" as tabs — one rule for the supplier list and the
 * partner list, which are two views of the one supplier record.
 *
 * A category is free text on the supplier, so a tab is a category trimmed
 * and case-blind: exactly what the tab's filter (`equals`, insensitive) can
 * match, so a tab's count is always what clicking it shows. Inner spaces are
 * NOT folded — the database cannot fold them, and a tab that counted
 * "Steel  pipes" with "Steel pipes" would list fewer rows than it said.
 * `none` is the suppliers with nothing stated.
 */

const categoryKey = (c: string) => c.trim().toLowerCase();

/** The rows one tab means. */
export function categoryTabWhere(value: string): Prisma.SupplierWhereInput {
  return value === 'none'
    ? { OR: [{ category: null }, { category: '' }] }
    : { category: { equals: value.trim(), mode: 'insensitive' } };
}

/**
 * Every category on file under `base`, the first spelling naming it,
 * alphabetical, and "Not stated" last while any supplier has none — with
 * their counts ('' is All).
 */
export async function categoryTabs(base: Prisma.SupplierWhereInput) {
  const perCategory = await prisma.supplier.groupBy({
    by: ['category'],
    where: base,
    _count: { _all: true },
    orderBy: { category: 'asc' },
  });
  const tabCounts: Record<string, number> = { '': 0 };
  const byKey = new Map<string, { value: string; label: string }>();
  let none = 0;
  for (const r of perCategory) {
    tabCounts[''] += r._count._all;
    const name = (r.category ?? '').trim();
    if (!name) {
      none += r._count._all;
      continue;
    }
    const key = categoryKey(name);
    if (!byKey.has(key)) byKey.set(key, { value: name, label: name });
    const tab = byKey.get(key)!;
    tabCounts[tab.value] = (tabCounts[tab.value] ?? 0) + r._count._all;
  }
  const tabs = [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
  if (none > 0) {
    tabs.push({ value: 'none', label: 'Not stated' });
    tabCounts.none = none;
  }
  return { tabs, tabCounts };
}
