import type { Prisma } from '@prisma/client';

/**
 * Searching items, several at once (2026-11-25, the owner's call: "Contactor
 * (all contactor with description will appear), comma separate item, Wire").
 *
 * A comma separates searches: "Contactor, Wire" lists every item that
 * matches EITHER one. Each term is looked for in the name, the description,
 * the part number, the code, the brand and the product group, case-blind.
 * The one rule for the Inventory list (company, project and sales order
 * stock alike), the Item Master and their printed twins.
 */
export function searchTerms(search: string | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of (search ?? '').split(',')) {
    const term = raw.trim().replace(/\s+/g, ' ');
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length === 20) break;
  }
  return out;
}

const ITEM_FIELDS = ['name', 'description', 'partNumber', 'code', 'brand', 'productGroup'] as const;

/** One term against an item's own text. */
export function itemTermWhere(term: string): Prisma.ItemWhereInput[] {
  return ITEM_FIELDS.map((f) => ({ [f]: { contains: term, mode: 'insensitive' } }) as Prisma.ItemWhereInput);
}

/** Every term, any of them: null when nothing was typed. */
export function itemSearchWhere(search: string | null | undefined): Prisma.ItemWhereInput | null {
  const terms = searchTerms(search);
  if (!terms.length) return null;
  return { OR: terms.flatMap(itemTermWhere) };
}

/**
 * The product group filter: a group by name, case-blind, or `none` — an item
 * that names no group. Since 2026-11-25 the product group (the quotation's
 * list) is the inventory's one category.
 */
export function groupWhere(group: string | null | undefined): Prisma.ItemWhereInput | null {
  if (!group) return null;
  if (group === 'none') return { OR: [{ productGroup: null }, { productGroup: '' }] };
  return { productGroup: { equals: group, mode: 'insensitive' } };
}

/** How a product group is keyed on a tile: its name in capitals, `none` for none. */
export const groupTileKey = (name: string | null | undefined) => (name?.trim() ? name.trim().replace(/\s+/g, ' ').toUpperCase() : 'none');

export const NO_GROUP_LABEL = 'No group';
