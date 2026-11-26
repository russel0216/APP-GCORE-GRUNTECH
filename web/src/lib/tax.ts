/**
 * The Tax dropdown's keys and words, DOM-free (pinned to the API's
 * `taxOptionKey` / `taxRateText` in shared/quotation.ts by verify-sales).
 *
 * Two options may share a rate ("0% (zero-rated)" and "0% (DR sale only)",
 * 2026-11-26, help ticket GT-HT-2026-0042), so a select's value is the
 * option's KIND, else its rate to four decimals.
 */
export const taxKey = (rate: number, taxKind?: string | null): string => (taxKind ? taxKind : Number(rate).toFixed(4));

/** How a kind reads beside its rate — the API's `TAX_KINDS[kind].paper`. */
const TAX_KIND_WORDS: Record<string, string> = { DR_SALE: 'DR sale only' };

/** "0% — DR sale only" where a kind was picked, else "12%". */
export function taxText(rate: number, taxKind?: string | null): string {
  const pct = `${Number((rate * 100).toFixed(2))}%`;
  const words = taxKind ? TAX_KIND_WORDS[taxKind] : undefined;
  return words ? `${pct} — ${words}` : pct;
}
