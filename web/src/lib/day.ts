/**
 * Calendar days as the browser sees them — local, never UTC.
 *
 * `new Date().toISOString().slice(0, 10)` is the obvious way to write today
 * and it is wrong: it gives the UTC date. The server keys attendance on the
 * LOCAL day (`dayKey()` in `api/src/shared/hr.ts`), so between midnight and
 * 08:00 in Manila the two disagree — the HR dashboard opened at 07:00 on the
 * 20th asked for the 19th, showed everybody absent, and the CSV extract pulled
 * the wrong day's attendance out with it. An attendance record is evidence;
 * handing HR yesterday's and labelling it today is not a cosmetic fault.
 *
 * The same trap has a second form: `new Date('2026-09-21')` parses as UTC
 * midnight, which is 08:00 Manila — right day here, wrong day anywhere west
 * of Greenwich, and off by one on either side of a DST change. `parseDay`
 * builds local midnight with the three-argument constructor instead, and
 * every helper below goes through it.
 *
 * A "day key" is 'YYYY-MM-DD'; a "month key" is 'YYYY-MM'; a week is named
 * by its Monday's day key. All string in, string out, so React state and URL
 * parameters carry them unchanged. DOM-free on purpose:
 * `api/scripts/verify-calendar.ts` imports this file through tsx and pins
 * the month-grid edge cases.
 */

export type CalendarViewKey = 'day' | 'week' | 'month';

const pad = (n: number) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' of a Date in local time. */
export function dayKeyOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local midnight of a day key. Never `new Date('YYYY-MM-DD')` — that is UTC. */
export function parseDay(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

export function isDayKey(s: string | null | undefined): s is string {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = parseDay(s);
  return !Number.isNaN(d.getTime()) && dayKeyOf(d) === s;
}

export function isMonthKey(s: string | null | undefined): s is string {
  if (!s || !/^\d{4}-\d{2}$/.test(s)) return false;
  const m = Number(s.slice(5, 7));
  return m >= 1 && m <= 12;
}

export function addDays(key: string, n: number): string {
  const d = parseDay(key);
  d.setDate(d.getDate() + n);
  return dayKeyOf(d);
}

/** The Monday on or before the day — the working week people plan around. */
export function mondayOf(key: string): string {
  const d = parseDay(key);
  const back = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - back);
  return dayKeyOf(d);
}

/** 'YYYY-MM' of a day key. */
export function monthOf(key: string): string {
  return key.slice(0, 7);
}

/** Month arithmetic on keys, so December + 1 is January of the next year. */
export function addMonthsKey(month: string, n: number): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + n;
  const d = new Date(y, m, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

export function firstOfMonth(month: string): string {
  return `${month}-01`;
}

export function lastOfMonth(month: string): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  // Day 0 of the next month is the last day of this one.
  return dayKeyOf(new Date(y, m, 0));
}

/**
 * The 42 day keys of a month view: six Monday-first rows, always six, so the
 * grid never changes height between months. Leading days belong to the
 * previous month and trailing ones to the next; both are real days, just
 * outside the month named.
 */
export function monthGrid(month: string): string[] {
  const start = mondayOf(firstOfMonth(month));
  const out: string[] = [];
  for (let i = 0; i < 42; i++) out.push(addDays(start, i));
  return out;
}

/** The seven day keys of the week that starts on this Monday. */
export function weekDays(monday: string): string[] {
  const start = mondayOf(monday);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/**
 * The fetch window for a view: local midnight of the first grid day to the
 * last instant of the last grid day. `to` is 23:59:59.999, not the next
 * midnight — the API's `lte` is inclusive, and a window that ended on
 * midnight would count that instant twice, once here and once in the window
 * that starts there.
 */
export function windowFor(view: CalendarViewKey, key: string): { from: Date; to: Date } {
  // A day view's window is the one day; its key is the day itself.
  const days = view === 'month' ? monthGrid(key) : view === 'week' ? weekDays(key) : [key];
  const from = parseDay(days[0]);
  const to = parseDay(days[days.length - 1]);
  to.setHours(23, 59, 59, 999);
  return { from, to };
}

/** Today, as the calendar sees it here. Anything sending a bare date to the API uses this. */
export function todayLocal(): string {
  return dayKeyOf(new Date());
}

/**
 * Whole days from `a` to `b` (b − a), both day keys. Local midnights, so a
 * DST change between them does not shave the count to 0.96 of a day. The
 * Gantt chart's columns and a quotation's validity both count this way.
 */
export function daysBetween(a: string, b: string): number {
  return Math.round((parseDay(b).getTime() - parseDay(a).getTime()) / 86_400_000);
}

/**
 * The value a `<input type="datetime-local">` takes for an instant: the LOCAL
 * wall clock as 'YYYY-MM-DDTHH:MM'. `toISOString()` alone would give UTC —
 * 08:00 Manila would come back as 00:00 — so the offset is folded in first.
 */
export function toLocalInput(d: Date): string {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
