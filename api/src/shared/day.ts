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

/**
 * A calendar date (the @db.Date columns) for the Manila day an instant falls
 * on: midnight UTC of that date. This is "today" for anything compared with,
 * or written into, a DATE column. The UTC date of the same instant is still
 * yesterday's until 08:00 in Manila, and a bare `new Date()` written into a
 * DATE column is stored as that UTC date.
 */
export function manilaDate(at: Date): Date {
  return new Date(`${manilaDayKey(at)}T00:00:00.000Z`);
}

/**
 * The first and last instants of a Manila day ('YYYY-MM-DD'): the edges of a
 * range over a TIMESTAMP column (`createdAt`, `decidedAt`). UTC midnight is
 * 08:00 here, and a range that started there left out the night before it.
 *
 * Never for a DATE column: Prisma binds a DATE parameter as its UTC date, and
 * Manila midnight is 16:00Z the day before — it would read as the previous
 * day. The end works for both: 23:59 in Manila is still that day in UTC.
 *
 * Manila keeps UTC+8 all year, with no daylight saving, so the offset is fixed.
 */
export function manilaDayStart(key: string): Date {
  return new Date(`${key}T00:00:00.000+08:00`);
}

export function manilaDayEnd(key: string): Date {
  return new Date(`${key}T23:59:59.999+08:00`);
}

/**
 * The calendar date of working day `day` (Mon–Fri, day 1 = the first) counted
 * from `start` — a costing's scope of work, planned in working days, put on a
 * project's real dates. A start on a weekend counts from the Monday after it.
 * Returns a DATE (UTC midnight) like every @db.Date value.
 */
/** Working days (Mon–Fri) from one DATE to another, both days counted; 0 when `to` is before `from`. */
export function workingDaysBetween(from: Date, to: Date): number {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  let days = 0;
  while (d.getTime() <= end) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) days++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

export function workingDayDate(start: Date, day: number): Date {
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  let left = Math.max(1, Math.floor(day));
  for (;;) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      left--;
      if (left === 0) return d;
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

/**
 * The business day of a DATE column, as UTC midnight: `manilaDate` under the
 * name every module used for it (finance, aftermarket, insights and HR each
 * carried a copy; HR's read the server's clock, which is not the business's
 * day — CLAUDE.md, "Today, for a DATE column").
 */
export const dayKey = (at: Date): Date => manilaDate(at);

/** Whole days between two dates' business days; negative means the later one has not arrived. */
export function daysBetween(from: Date, to: Date): number {
  return Math.floor((dayKey(to).getTime() - dayKey(from).getTime()) / 86_400_000);
}

/** `days` after a date, on the UTC calendar a DATE column lives on (negative for before). */
export function addDays(date: Date, days: number): Date {
  const out = new Date(date);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}
