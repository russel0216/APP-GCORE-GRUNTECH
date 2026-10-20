/**
 * G-HR › Records (2026-10-20, the owner's `G-HR_Records_Module_UI_
 * Specification`): the rules My Records reads — the payroll CUTOFF a daily
 * time record covers, one day's row of that record, and the BIR tax status
 * codes. Pure, on 'YYYY-MM-DD' keys (a DATE column's own value, the Manila
 * day) in UTC arithmetic, so the host clock takes no part. verify-hr pins
 * them.
 */

// ── Tax status ──────────────────────────────────────────────────────────────

/** The BIR tax status codes, in the order a form lists them, with their words. */
export const TAX_STATUSES: { code: string; label: string }[] = [
  { code: 'S', label: 'Single' },
  { code: 'S1', label: 'Single, 1 qualified dependent' },
  { code: 'S2', label: 'Single, 2 qualified dependents' },
  { code: 'S3', label: 'Single, 3 qualified dependents' },
  { code: 'S4', label: 'Single, 4 qualified dependents' },
  { code: 'M', label: 'Married' },
  { code: 'M1', label: 'Married, 1 qualified dependent' },
  { code: 'M2', label: 'Married, 2 qualified dependents' },
  { code: 'M3', label: 'Married, 3 qualified dependents' },
  { code: 'M4', label: 'Married, 4 qualified dependents' },
  { code: 'Z', label: 'Zero exemption' },
];
export const TAX_STATUS_CODES = TAX_STATUSES.map((t) => t.code) as [string, ...string[]];

/** "S1 — Single, 1 qualified dependent"; null for none, the code as stored for an unknown one. */
export function taxStatusLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  const t = TAX_STATUSES.find((x) => x.code === code);
  return t ? `${t.code} — ${t.label}` : code;
}

// ── The cutoff ──────────────────────────────────────────────────────────────

export type CutoffMode = 'SEMI_MONTHLY' | 'MONTHLY';
export interface CutoffRule {
  mode: CutoffMode;
  /** Semi-monthly: the last day of the first period (15 by default). */
  firstEnds: number;
}
export const CUTOFF_DEFAULT: CutoffRule = { mode: 'SEMI_MONTHLY', firstEnds: 15 };

export interface Cutoff {
  /** '2026-10-A' (first half), '2026-10-B' (second half) or '2026-10' (monthly). */
  key: string;
  from: string;
  to: string;
  /** "Oct 1–15, 2026". */
  label: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function make(y: number, m: number, half: 'A' | 'B' | null, rule: CutoffRule): Cutoff {
  const end = lastDay(y, m);
  const split = Math.min(Math.max(1, Math.trunc(rule.firstEnds)), end - 1);
  const [a, b] = half === 'A' ? [1, split] : half === 'B' ? [split + 1, end] : [1, end];
  const ym = `${y}-${pad(m)}`;
  return {
    key: half ? `${ym}-${half}` : ym,
    from: `${ym}-${pad(a)}`,
    to: `${ym}-${pad(b)}`,
    label: `${MONTHS[m - 1]} ${a}–${b}, ${y}`,
  };
}

/** The cutoff a day falls in. */
export function cutoffFor(day: string, rule: CutoffRule = CUTOFF_DEFAULT): Cutoff {
  const [y, m, d] = day.split('-').map(Number);
  if (rule.mode === 'MONTHLY') return make(y, m, null, rule);
  const split = Math.min(Math.max(1, Math.trunc(rule.firstEnds)), lastDay(y, m) - 1);
  return make(y, m, d <= split ? 'A' : 'B', rule);
}

/** A cutoff by its key, under the rule; null when the key is not one. */
export function cutoffByKey(key: string, rule: CutoffRule = CUTOFF_DEFAULT): Cutoff | null {
  const match = /^(\d{4})-(\d{2})(?:-([AB]))?$/.exec(key);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  if (m < 1 || m > 12) return null;
  const half = (match[3] as 'A' | 'B' | undefined) ?? null;
  if ((rule.mode === 'MONTHLY') !== (half === null)) return null;
  return make(y, m, half, rule);
}

/** The cutoff `n` periods before (negative) or after (positive) this one. */
export function shiftCutoff(c: Cutoff, n: number, rule: CutoffRule = CUTOFF_DEFAULT): Cutoff {
  let cur = c;
  const step = n < 0 ? -1 : 1;
  for (let i = 0; i < Math.abs(n); i++) {
    const [y, m, d] = (step < 0 ? cur.from : cur.to).split('-').map(Number);
    const next = new Date(Date.UTC(y, m - 1, d + step));
    cur = cutoffFor(next.toISOString().slice(0, 10), rule);
  }
  return cur;
}

/** Every day key from `from` to `to`, both ends. */
export function daysOf(from: string, to: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end && out.length < 62; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

// ── One day of the daily time record ─────────────────────────────────────────

/** What a day of the record says, in the spec's pills. */
export type DtrStatus = 'NOT_EMPLOYED' | 'PRESENT' | 'LATE' | 'HALF_DAY' | 'OPEN' | 'ON_LEAVE' | 'REST_DAY' | 'HOLIDAY' | 'ABSENT' | 'UPCOMING';

export interface DtrPunch {
  timeIn: Date | null;
  timeOut: Date | null;
  status: string;
  lateMinutes: number;
  workedMinutes: number;
  undertimeMinutes: number;
}

export interface DtrDay {
  date: string;
  weekday: string;
  status: DtrStatus;
  /** A holiday's or a leave's name, said beside the pill. */
  note: string | null;
  timeIn: string | null;
  timeOut: string | null;
  lateMinutes: number;
  undertimeMinutes: number;
  /** Minutes rendered — for an open day, so far. */
  workedMinutes: number;
  /** Still clocked in: the total is live. */
  open: boolean;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * One calendar day of the record. A punch always wins — someone who worked a
 * Sunday or a holiday shows what they worked. Without one: a holiday or a
 * Sunday is a rest day, an approved leave is On leave, a past working day is
 * Absent, today and later are still to come, and a day before the hire
 * date is no one's absence.
 */
export function dtrDay(input: {
  date: string;
  today: string;
  now: Date;
  punch: DtrPunch | null;
  holiday: string | null;
  leave: string | null;
  /** The hire date: an empty day before it is no absence. */
  hired?: string | null;
}): DtrDay {
  const { date, today, now, punch, holiday, leave, hired } = input;
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  const base = {
    date,
    weekday: WEEKDAYS[dow],
    note: holiday ?? leave,
    timeIn: punch?.timeIn ? punch.timeIn.toISOString() : null,
    timeOut: punch?.timeOut ? punch.timeOut.toISOString() : null,
    lateMinutes: punch?.lateMinutes ?? 0,
    undertimeMinutes: punch?.undertimeMinutes ?? 0,
    workedMinutes: punch?.workedMinutes ?? 0,
    open: false,
  };
  if (punch?.timeIn) {
    if (!punch.timeOut) {
      const so = Math.max(0, Math.floor((now.getTime() - punch.timeIn.getTime()) / 60_000));
      // Only today's open day is live; an older one is a missing clock-out.
      return { ...base, status: 'OPEN', open: date === today, workedMinutes: date === today ? so : 0 };
    }
    const status: DtrStatus = punch.status === 'LATE' ? 'LATE' : punch.status === 'HALF_DAY' ? 'HALF_DAY' : 'PRESENT';
    return { ...base, status };
  }
  if (hired && date < hired) return { ...base, status: 'NOT_EMPLOYED' };
  if (punch?.status === 'ON_LEAVE' || leave) return { ...base, status: 'ON_LEAVE' };
  if (holiday) return { ...base, status: 'HOLIDAY' };
  if (dow === 0 || punch?.status === 'REST_DAY') return { ...base, status: 'REST_DAY' };
  if (date >= today) return { ...base, status: 'UPCOMING' };
  return { ...base, status: 'ABSENT' };
}

/** Whole years and months since a day, as of another: { years, months }. */
export function serviceLength(from: string, asOf: string): { years: number; months: number } {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = asOf.split('-').map(Number);
  let months = (ty - fy) * 12 + (tm - fm) - (td < fd ? 1 : 0);
  if (months < 0) months = 0;
  return { years: Math.floor(months / 12), months: months % 12 };
}
