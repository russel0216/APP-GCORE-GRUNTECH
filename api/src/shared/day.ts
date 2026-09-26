/**
 * Calendar keys pinned to Asia/Manila — the company's day, whatever the
 * server happens to be set to. The same pinning `pdf.ts` uses for the dates a
 * document prints.
 *
 * A key is what a deep link or a forecast column buckets on. Deriving it from
 * the host clock would move an activity to the wrong day on a server set to
 * UTC, and there is no error to catch when that happens — the link just opens
 * yesterday.
 *
 * Not used by numbering: its {YYYY}/{MM} tokens keep the local-getter
 * behaviour every issued number already carries.
 */

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Manila',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** 'YYYY-MM-DD' in Manila. en-CA is the locale whose short date IS that shape. */
export function manilaDayKey(d: Date): string {
  return fmt.format(d);
}

/** 'YYYY-MM' in Manila. */
export function manilaMonthKey(d: Date): string {
  return manilaDayKey(d).slice(0, 7);
}
