/**
 * Memory in the editors' boxes (2026-10-12, the owner's call: "in all of the
 * input, even description, allow memory suggestion of previous input").
 *
 * The routes read what was typed before — values only, from documents the
 * caller may read — and this file decides what of it is offered: each text
 * once, whatever its case or spacing, in the order handed in (the routes
 * hand it newest first), at most `limit`.
 */

/** How many earlier texts a box is offered. */
export const MEMORY_LIMIT = 20;

/** How many rows a route reads to find `MEMORY_LIMIT` distinct texts. */
export const MEMORY_SCAN = 400;

/** The key two texts share when they say the same thing: trimmed, single-spaced, case-blind. */
export function memoryKey(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toUpperCase();
}

/**
 * Each text once, first spelling kept, blanks and the very text typed left
 * out (offering what is already in the box helps nobody), at most `limit`.
 */
export function distinctTexts(values: Iterable<string | null | undefined>, typed = '', limit = MEMORY_LIMIT): string[] {
  const seen = new Set<string>();
  const typedKey = memoryKey(typed);
  const out: string[] = [];
  for (const v of values) {
    if (!v) continue;
    const text = v.trim();
    const key = memoryKey(text);
    if (!key || seen.has(key) || key === typedKey) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

/** The term a route filters on: trimmed, at most 80 characters. */
export function memoryTerm(q: unknown): string {
  return String(q ?? '').trim().slice(0, 80);
}
