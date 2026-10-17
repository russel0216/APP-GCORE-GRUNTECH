import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { setHolidayKeys } from './day';

/**
 * Holidays (2026-10-17, the owner's call: "prefill PH holidays"). Days off
 * besides Sunday for every working-day count — a costing's plan, a project's
 * dates, a job order's working days. One Setting, `calendar.holidays`, a
 * list of `{ date, name, kind }` edited on Company Settings › Holidays; the
 * API holds it as keys in `shared/day.ts` (`loadHolidays()` at boot, after a
 * save and every few minutes), the web is sent it by `GET /holidays`.
 *
 * The seed prefills the Philippine holidays for this year and next
 * (`prefillHolidays()`), ONCE per year (`seed.holidaysPrefilled`), so a
 * holiday an administrator removed is never put back. Fixed dates, Holy Week
 * from Easter and National Heroes Day (last Monday of August) are worked out;
 * Chinese New Year and the two Eids follow the moon and are proclaimed each
 * year, so they come from a short table and say "check the proclamation".
 */
export const HOLIDAYS_KEY = 'calendar.holidays';
const PREFILLED_KEY = 'seed.holidaysPrefilled';

export type HolidayKind = 'REGULAR' | 'SPECIAL';
export interface Holiday {
  date: string;
  name: string;
  kind: HolidayKind;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function clean(raw: unknown): Holiday[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Holiday[] = [];
  for (const r of raw as Partial<Holiday>[]) {
    if (!r || typeof r.date !== 'string' || !DAY.test(r.date) || seen.has(r.date)) continue;
    seen.add(r.date);
    out.push({ date: r.date, name: String(r.name ?? '').trim() || 'Holiday', kind: r.kind === 'SPECIAL' ? 'SPECIAL' : 'REGULAR' });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export async function holidays(db: Prisma.TransactionClient | typeof prisma = prisma): Promise<Holiday[]> {
  const row = await db.setting.findUnique({ where: { key: HOLIDAYS_KEY } });
  return clean(row?.value);
}

export async function saveHolidays(list: Holiday[], db: Prisma.TransactionClient | typeof prisma = prisma): Promise<Holiday[]> {
  const value = clean(list);
  await db.setting.upsert({
    where: { key: HOLIDAYS_KEY },
    create: { key: HOLIDAYS_KEY, value: value as unknown as Prisma.InputJsonValue },
    update: { value: value as unknown as Prisma.InputJsonValue },
  });
  return value;
}

/** Puts the stored holidays into the working-day rule (`shared/day.ts`). */
export async function loadHolidays(): Promise<Holiday[]> {
  const list = await holidays();
  setHolidayKeys(list.map((h) => h.date));
  return list;
}

// ── The Philippine calendar ──────────────────────────────────────────────────

const key = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** Easter Sunday (the Gregorian computus), as [month, day]. */
export function easter(y: number): [number, number] {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  return [Math.floor((h + l - 7 * m + 114) / 31), ((h + l - 7 * m + 114) % 31) + 1];
}

const shift = (y: number, [m, d]: [number, number], by: number) => {
  const t = new Date(Date.UTC(y, m - 1, d + by));
  return t.toISOString().slice(0, 10);
};

function lastMondayOfAugust(y: number): string {
  const d = new Date(Date.UTC(y, 7, 31));
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Proclaimed each year (the moon decides): the dates as expected — check the proclamation. */
const LUNAR: Record<number, Holiday[]> = {
  2026: [
    { date: '2026-02-17', name: 'Chinese New Year (check the proclamation)', kind: 'SPECIAL' },
    { date: '2026-03-20', name: "Eid'l Fitr (check the proclamation)", kind: 'REGULAR' },
    { date: '2026-05-27', name: "Eid'l Adha (check the proclamation)", kind: 'REGULAR' },
  ],
  2027: [
    { date: '2027-02-06', name: 'Chinese New Year (check the proclamation)', kind: 'SPECIAL' },
    { date: '2027-03-10', name: "Eid'l Fitr (check the proclamation)", kind: 'REGULAR' },
    { date: '2027-05-17', name: "Eid'l Adha (check the proclamation)", kind: 'REGULAR' },
  ],
  2028: [
    { date: '2028-01-26', name: 'Chinese New Year (check the proclamation)', kind: 'SPECIAL' },
    { date: '2028-02-27', name: "Eid'l Fitr (check the proclamation)", kind: 'REGULAR' },
    { date: '2028-05-05', name: "Eid'l Adha (check the proclamation)", kind: 'REGULAR' },
  ],
};

/** The Philippine regular holidays and special non-working days of a year. */
export function phHolidays(y: number): Holiday[] {
  const e = easter(y);
  const list: Holiday[] = [
    { date: key(y, 1, 1), name: "New Year's Day", kind: 'REGULAR' },
    { date: shift(y, e, -3), name: 'Maundy Thursday', kind: 'REGULAR' },
    { date: shift(y, e, -2), name: 'Good Friday', kind: 'REGULAR' },
    { date: shift(y, e, -1), name: 'Black Saturday', kind: 'SPECIAL' },
    { date: key(y, 4, 9), name: 'Araw ng Kagitingan', kind: 'REGULAR' },
    { date: key(y, 5, 1), name: 'Labor Day', kind: 'REGULAR' },
    { date: key(y, 6, 12), name: 'Independence Day', kind: 'REGULAR' },
    { date: key(y, 8, 21), name: 'Ninoy Aquino Day', kind: 'SPECIAL' },
    { date: lastMondayOfAugust(y), name: 'National Heroes Day', kind: 'REGULAR' },
    { date: key(y, 11, 1), name: "All Saints' Day", kind: 'SPECIAL' },
    { date: key(y, 11, 2), name: "All Souls' Day", kind: 'SPECIAL' },
    { date: key(y, 11, 30), name: 'Bonifacio Day', kind: 'REGULAR' },
    { date: key(y, 12, 8), name: 'Feast of the Immaculate Conception', kind: 'SPECIAL' },
    { date: key(y, 12, 24), name: 'Christmas Eve', kind: 'SPECIAL' },
    { date: key(y, 12, 25), name: 'Christmas Day', kind: 'REGULAR' },
    { date: key(y, 12, 30), name: 'Rizal Day', kind: 'REGULAR' },
    { date: key(y, 12, 31), name: "New Year's Eve", kind: 'SPECIAL' },
    ...(LUNAR[y] ?? []),
  ];
  return clean(list);
}

/**
 * The seed: this year's and next year's Philippine holidays join the list,
 * once per year — a date already listed is left as the administrator has it.
 * Returns the years filled.
 */
export async function prefillHolidays(today = new Date()): Promise<number[]> {
  const y = Number(today.toISOString().slice(0, 4));
  const marked = await prisma.setting.findUnique({ where: { key: PREFILLED_KEY } });
  const done = new Set<number>(Array.isArray(marked?.value) ? (marked!.value as number[]) : []);
  const years = [y, y + 1].filter((yr) => !done.has(yr));
  if (!years.length) return [];
  const list = await holidays();
  const have = new Set(list.map((h) => h.date));
  for (const yr of years) for (const h of phHolidays(yr)) if (!have.has(h.date)) list.push(h);
  await saveHolidays(list);
  const value = [...done, ...years].sort();
  await prisma.setting.upsert({
    where: { key: PREFILLED_KEY },
    create: { key: PREFILLED_KEY, value },
    update: { value },
  });
  return years;
}
