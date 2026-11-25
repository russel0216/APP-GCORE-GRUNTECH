/**
 * Filing items under product groups BY BRAND (2026-11-25, the owner's call
 * after the inventory audit: "map the old categories to product groups by
 * brand"). The Odoo items arrived with a brand and an inventory category but
 * no product group; the groups are the quotation's list, most of them a
 * brand's. Pure: the routes in masters.ts read the items and write the choice.
 *
 * A brand is SUGGESTED a group, never filed under one unasked — the person
 * sees every brand with its suggestion and decides (the SCORO import's
 * "Groups not on the list" question):
 *
 *   1. the group whose name or brand IS the brand, case- and space-blind
 *      (SCHNEIDER ELECTRIC, OMEGA AIR, PREVOST, SUTO-ITEC …);
 *   2. a brand the owner's principals sell under another name (`BRAND_ALIASES`:
 *      Control Techniques is Nidec's drive brand);
 *   3. the ONE group whose name or brand starts with the brand as a whole
 *      word (KSB → KSB PUMPS). Two such groups (GRUNTECH → GRUNTECH SERVICES,
 *      GRUNTECH INSTALLATION AND FABRICATION) suggest nothing: never a guess.
 *
 * Anything else has no suggestion; the person may leave it or pick a group
 * (OTHERS is the quotation's own catch-all).
 */
export interface BrandGroup {
  name: string;
  brand: string | null;
}

const key = (v: string) => v.trim().replace(/\s+/g, ' ').toUpperCase();

/** A brand sold under a principal's group though it is not the group's name. */
export const BRAND_ALIASES: Record<string, string> = {
  'CONTROL TECHNIQUES': 'NIDEC DRIVES',
  NIDEC: 'NIDEC DRIVES',
  'NIDEC DRIVES (JAPAN)': 'NIDEC DRIVES',
};

/** How a brand is keyed in a choice: its capitals, `none` for an item with no brand. */
export const brandChoiceKey = (brand: string | null | undefined) => (brand?.trim() ? key(brand) : 'none');

export function suggestGroup(brand: string | null | undefined, groups: BrandGroup[]): string | null {
  if (!brand?.trim()) return null;
  const b = key(brand);
  const exact = groups.find((g) => key(g.name) === b || (g.brand && key(g.brand) === b));
  if (exact) return exact.name;
  const alias = BRAND_ALIASES[b];
  if (alias) {
    const g = groups.find((x) => key(x.name) === key(alias));
    if (g) return g.name;
  }
  const starts = groups.filter((g) => key(g.name).startsWith(`${b} `) || (g.brand ? key(g.brand).startsWith(`${b} `) : false));
  return starts.length === 1 ? starts[0].name : null;
}
