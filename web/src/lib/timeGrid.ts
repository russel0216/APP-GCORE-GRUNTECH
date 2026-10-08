/**
 * The time scale (2026-10-08, SCORO's calendar): where a block sits in a
 * day column, and how overlapping blocks share its width.
 *
 * Everything is minutes from the day's local midnight, so the page draws
 * with `calc(minutes / 60 * var(--cal-hour))` and never a pixel. DOM-free on
 * purpose: `api/scripts/verify-calendar.ts` imports this file through tsx
 * and pins the geometry and the lanes.
 */

export const DAY_MINUTES = 24 * 60;
/** The grid's slot: a click lands on the half hour. */
export const SLOT_MINUTES = 30;
/** The shortest a block is drawn, so a five-minute call is still a target. */
export const MIN_BLOCK_MINUTES = 20;

export interface Span {
  /** Minutes from the day's midnight. */
  top: number;
  height: number;
}

/**
 * The part of [startMs, endMs) that falls on the day starting at
 * `dayStartMs`, in minutes from that midnight; null when none does. An
 * activity across midnight is drawn on both days, each clipped to its own.
 */
export function blockSpan(startMs: number, endMs: number, dayStartMs: number): Span | null {
  if (!(endMs > startMs)) return null;
  const dayEndMs = dayStartMs + DAY_MINUTES * 60_000;
  const s = Math.max(startMs, dayStartMs);
  const e = Math.min(endMs, dayEndMs);
  if (e <= s) return null;
  const top = Math.round((s - dayStartMs) / 60_000);
  const height = Math.max(MIN_BLOCK_MINUTES, Math.round((e - s) / 60_000));
  return { top, height: Math.min(height, DAY_MINUTES - top) };
}

/**
 * Side-by-side lanes for blocks that overlap: a block takes the first lane
 * free at its start; every block in a run of overlapping blocks (a cluster)
 * is told how many lanes the cluster uses, so each is drawn at 1/lanes of
 * the column. Blocks are returned in start order.
 */
export function placeInLanes<T extends Span>(blocks: T[]): (T & { lane: number; lanes: number })[] {
  const sorted = [...blocks].sort((a, b) => a.top - b.top || b.height - a.height);
  const out: (T & { lane: number; lanes: number })[] = [];
  let cluster: (T & { lane: number; lanes: number })[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -1;
  const close = () => {
    const lanes = laneEnds.length || 1;
    for (const b of cluster) b.lanes = lanes;
    cluster = [];
    laneEnds = [];
  };
  for (const b of sorted) {
    if (cluster.length && b.top >= clusterEnd) close();
    let lane = laneEnds.findIndex((end) => end <= b.top);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = b.top + b.height;
    clusterEnd = Math.max(clusterEnd, b.top + b.height);
    const placed = { ...b, lane, lanes: 1 };
    cluster.push(placed);
    out.push(placed);
  }
  close();
  return out;
}

/** The slot a point in the column falls in: minutes from midnight, on the half hour, inside the day. */
export function slotAt(minutes: number, step = SLOT_MINUTES): number {
  const m = Math.floor(minutes / step) * step;
  return Math.max(0, Math.min(DAY_MINUTES - step, m));
}

/** "6:00 AM", "1:30 PM" — the hour gutter's labels, and a slot's aria-label. */
export function minutesLabel(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
