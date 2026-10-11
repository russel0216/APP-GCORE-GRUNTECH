/**
 * Capital letters, as the owner asked for the quote name and a line's Brand,
 * Product type and Part number (2026-10-11). A character whose capital is not
 * one character inside Latin-1 is left as typed ('µ', 'ß'). DOM-free: the
 * server's copy is `upperText()` in api/src/shared/quotation.ts, pinned equal
 * by verify-sales.
 */
export function upperText(value: string): string {
  let out = '';
  for (const ch of value) {
    const up = ch.toUpperCase();
    out += up.length === 1 && up.charCodeAt(0) <= 0xff ? up : ch;
  }
  return out;
}
