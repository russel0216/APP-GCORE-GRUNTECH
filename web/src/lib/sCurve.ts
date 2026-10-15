/**
 * The S-curve's date scale (2026-10-13, the owner's report: the labels
 * overlapped and could not be read). Ticks are placed by TIME across the
 * chart's span, never by picking points — progress reports cluster (four in
 * one week of January), and labelling them by index stacked "Jan 6", "Jan 7",
 * "Jan 8" on one spot. The first and the last date are always labelled; up to
 * `maxTicks − 2` evenly spaced dates fall between; and a label closer than
 * `minGap` (in the chart's own units) to one already drawn is dropped, the
 * last date winning over an interior one.
 *
 * DOM-free and timezone-free: dates are 'YYYY-MM-DD' keys (or ISO strings,
 * read by their date part), formatted from their own parts, so the verify
 * script can pin it.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = 86_400_000;

export interface CurveTick {
  /** Where the label sits, in the chart's units (`left` … `left + width`). */
  x: number;
  label: string;
}

const dayMs = (key: string) => Date.parse(`${key.slice(0, 10)}T00:00:00Z`);

function labelOf(ms: number, withYear: boolean): string {
  const d = new Date(ms);
  const text = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return withYear ? `${text} '${String(d.getUTCFullYear()).slice(2)}` : text;
}

export function curveTicks(
  firstDate: string,
  lastDate: string,
  geometry: { left: number; width: number },
  options: { maxTicks?: number; minGap?: number } = {},
): CurveTick[] {
  const maxTicks = Math.max(2, options.maxTicks ?? 6);
  const minGap = options.minGap ?? 56;
  const t0 = dayMs(firstDate);
  const t1 = dayMs(lastDate);
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return [];
  const span = Math.max(DAY, t1 - t0);
  const withYear = new Date(t0).getUTCFullYear() !== new Date(t1).getUTCFullYear();
  const xOf = (ms: number) => geometry.left + ((ms - t0) / span) * geometry.width;

  // Evenly spaced dates between the ends, rounded to whole days.
  const between: number[] = [];
  for (let i = 1; i < maxTicks - 1; i++) {
    const ms = t0 + Math.round(((t1 - t0) * i) / (maxTicks - 1) / DAY) * DAY;
    if (ms > t0 && ms < t1 && !between.includes(ms)) between.push(ms);
  }

  const first: CurveTick = { x: xOf(t0), label: labelOf(t0, withYear) };
  if (t1 <= t0) return [first];
  const last: CurveTick = { x: xOf(t1), label: labelOf(t1, withYear) };
  const ticks: CurveTick[] = [first];
  for (const ms of between) {
    const x = xOf(ms);
    // Clear of the one before it and of the last date, which always prints.
    if (x - ticks[ticks.length - 1].x >= minGap && last.x - x >= minGap) ticks.push({ x, label: labelOf(ms, withYear) });
  }
  // The last date beats an interior label; it never sits on the first.
  if (last.x - first.x >= minGap) ticks.push(last);
  return ticks;
}
