/**
 * The Forecast (2026-10-08, the owner's call): every open quotation by the
 * closing date its salesperson expects, consolidated into weeks, months,
 * quarters or years. A separate menu after the Sales Pipeline.
 *
 * No table. The rows are the quotations (and, when asked, the leads with no
 * quotation yet) the pipeline already carries; a quotation's value is
 * `quotationValue()` and its odds are its probability — the board's own
 * figures, so the Forecast, the board and the quotation list can never
 * disagree about what a deal is worth. verify-pipeline asserts a period's
 * total against the quotation list filtered to the same closing dates.
 *
 * Everything here is pure: the route fetches and this file buckets. The days
 * are 'YYYY-MM-DD' keys — a DATE column's own value, which is already the
 * Manila day — and the arithmetic runs in UTC on those keys, so the host
 * clock takes no part in which week a quotation closes in.
 */

export type ForecastPeriod = 'week' | 'month' | 'quarter' | 'year';
export const FORECAST_PERIODS: readonly ForecastPeriod[] = ['week', 'month', 'quarter', 'year'];

/** How many periods the default window shows, the current one included. */
export const DEFAULT_SPAN: Record<ForecastPeriod, number> = { week: 12, month: 12, quarter: 8, year: 3 };

/** The most periods one request may ask for: ten years of months, or of weeks. */
export const MAX_BUCKETS = 530;

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function isDayKey(value: string): boolean {
  return DAY_KEY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

const toDate = (key: string) => new Date(`${key}T00:00:00.000Z`);
const toKey = (d: Date) => d.toISOString().slice(0, 10);

/** `days` after a day key (negative for before). */
export function addDays(key: string, days: number): string {
  const d = toDate(key);
  d.setUTCDate(d.getUTCDate() + days);
  return toKey(d);
}

/** The first day of the period `day` falls in. Weeks start on Monday. */
export function periodStart(day: string, period: ForecastPeriod): string {
  const d = toDate(day);
  switch (period) {
    case 'week': {
      const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
      d.setUTCDate(d.getUTCDate() - dow);
      return toKey(d);
    }
    case 'month':
      return `${day.slice(0, 7)}-01`;
    case 'quarter': {
      const q = Math.floor(d.getUTCMonth() / 3);
      return `${day.slice(0, 4)}-${String(q * 3 + 1).padStart(2, '0')}-01`;
    }
    case 'year':
      return `${day.slice(0, 4)}-01-01`;
  }
}

/** The first day of the period after the one starting on `start`. */
export function periodNext(start: string, period: ForecastPeriod): string {
  const d = toDate(start);
  switch (period) {
    case 'week':
      d.setUTCDate(d.getUTCDate() + 7);
      break;
    case 'month':
      d.setUTCMonth(d.getUTCMonth() + 1);
      break;
    case 'quarter':
      d.setUTCMonth(d.getUTCMonth() + 3);
      break;
    case 'year':
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      break;
  }
  return toKey(d);
}

export interface PeriodBucket {
  /** '2026-W41', '2026-10', '2026-Q4', '2026'. */
  key: string;
  /** '5–11 Oct 2026', 'October 2026', 'Q4 2026 (Oct–Dec)', '2026'. */
  label: string;
  /** First day, 'YYYY-MM-DD'. */
  from: string;
  /** Last day, 'YYYY-MM-DD'. */
  to: string;
}

/** ISO 8601 week number of a day key (weeks start on Monday; week 1 holds 4 January). */
export function isoWeek(day: string): { year: number; week: number } {
  const d = toDate(day);
  // Thursday of this week decides the ISO year.
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow + 3);
  const year = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((d.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return { year, week };
}

const dayOf = (key: string) => Number(key.slice(8, 10));
const monthOf = (key: string) => Number(key.slice(5, 7)) - 1;
const yearOf = (key: string) => key.slice(0, 4);

/** A week's label: '5–11 Oct 2026', '28 Sep – 4 Oct 2026', '29 Dec 2025 – 4 Jan 2026'. */
function weekLabel(from: string, to: string): string {
  if (yearOf(from) !== yearOf(to)) {
    return `${dayOf(from)} ${MONTHS[monthOf(from)]} ${yearOf(from)} – ${dayOf(to)} ${MONTHS[monthOf(to)]} ${yearOf(to)}`;
  }
  if (monthOf(from) !== monthOf(to)) {
    return `${dayOf(from)} ${MONTHS[monthOf(from)]} – ${dayOf(to)} ${MONTHS[monthOf(to)]} ${yearOf(to)}`;
  }
  return `${dayOf(from)}–${dayOf(to)} ${MONTHS[monthOf(to)]} ${yearOf(to)}`;
}

/** The bucket a period starting on `start` makes. */
export function periodBucket(start: string, period: ForecastPeriod): PeriodBucket {
  const to = addDays(periodNext(start, period), -1);
  switch (period) {
    case 'week': {
      const { year, week } = isoWeek(start);
      return { key: `${year}-W${String(week).padStart(2, '0')}`, label: weekLabel(start, to), from: start, to };
    }
    case 'month':
      return { key: start.slice(0, 7), label: `${MONTHS_LONG[monthOf(start)]} ${yearOf(start)}`, from: start, to };
    case 'quarter': {
      const q = Math.floor(monthOf(start) / 3) + 1;
      return {
        key: `${yearOf(start)}-Q${q}`,
        label: `Q${q} ${yearOf(start)} (${MONTHS[monthOf(start)]}–${MONTHS[monthOf(to)]})`,
        from: start,
        to,
      };
    }
    case 'year':
      return { key: yearOf(start), label: yearOf(start), from: start, to };
  }
}

/** The bucket key a day falls in. */
export function bucketKeyOf(day: string, period: ForecastPeriod): string {
  return periodBucket(periodStart(day, period), period).key;
}

/**
 * Every period touching the days `from`..`to`, from the one `from` falls in
 * to the one `to` falls in. Throws when the window would hold more than
 * MAX_BUCKETS — the route turns that into a 400.
 */
export function periodsBetween(from: string, to: string, period: ForecastPeriod): PeriodBucket[] {
  const out: PeriodBucket[] = [];
  let start = periodStart(from, period);
  while (start <= to) {
    out.push(periodBucket(start, period));
    if (out.length > MAX_BUCKETS) throw new Error(`That window holds more than ${MAX_BUCKETS} ${period}s — narrow it`);
    start = periodNext(start, period);
  }
  return out;
}

/** The window the Forecast opens on: the current period and the next `DEFAULT_SPAN - 1`. */
export function defaultWindow(today: string, period: ForecastPeriod): { from: string; to: string } {
  const from = periodStart(today, period);
  let start = from;
  for (let i = 1; i < DEFAULT_SPAN[period]; i++) start = periodNext(start, period);
  return { from, to: addDays(periodNext(start, period), -1) };
}

// ── Rows and buckets ─────────────────────────────────────────────────────────

export interface ForecastRow {
  kind: 'quotation' | 'lead';
  id: string;
  number: string;
  /** The customer's name (a lead's company name when it has no customer on file). */
  title: string;
  subject: string | null;
  customer: { id: string; name: string } | null;
  owner: { id: string; name: string };
  /** The stage key and name (Admin › Pipeline Stages) the record stands in. */
  stage: string;
  stageLabel: string;
  /** The fine status: a quotation's outcome or a lead's status. */
  status: string;
  probability: number;
  /** 'YYYY-MM-DD', or null for a record with no closing date. */
  expectedClosing: string | null;
  value: number;
  weighted: number;
  /** Past its closing date and still open. */
  overdue: boolean;
  link: string;
}

export interface ForecastGroup {
  count: number;
  value: number;
  weighted: number;
  /** How many of the rows are past their closing date. */
  overdue: number;
  rows: ForecastRow[];
}

export interface ForecastBucket extends PeriodBucket, ForecastGroup {}

export interface ForecastOwner {
  id: string;
  name: string;
  count: number;
  value: number;
  weighted: number;
}

export interface Forecast {
  period: ForecastPeriod;
  from: string;
  to: string;
  today: string;
  /** One per period in the window, in order, empty ones included — the timeline reads whole. */
  buckets: ForecastBucket[];
  /** Closing before the window. */
  earlier: ForecastGroup;
  /** Closing after the window. */
  later: ForecastGroup;
  /** No closing date on the record. */
  undated: ForecastGroup;
  /** The buckets alone. */
  inWindow: { count: number; value: number; weighted: number; overdue: number };
  /** Everything open in scope: the buckets, earlier, later and undated. */
  totals: { count: number; value: number; weighted: number; overdue: number };
  /** Each owner's share of everything in scope, largest first. */
  owners: ForecastOwner[];
}

const cents = (n: number) => Math.round(n * 100);

/** A group's figures: value summed in cents, the weighted sum rounded ONCE at the end (the board's rule). */
function groupOf(rows: ForecastRow[]): ForecastGroup {
  let valueCents = 0;
  let weightedCents = 0;
  for (const r of rows) {
    valueCents += cents(r.value);
    weightedCents += (cents(r.value) * r.probability) / 100;
  }
  return {
    count: rows.length,
    value: valueCents / 100,
    weighted: Math.round(weightedCents) / 100,
    overdue: rows.filter((r) => r.overdue).length,
    rows,
  };
}

/** Σ value × probability for one row, to the centavo. */
export function weightedOf(value: number, probability: number): number {
  return Math.round((cents(value) * probability) / 100) / 100;
}

/**
 * The Forecast from rows already valued: each row lands in exactly one of
 * the window's buckets, `earlier`, `later` or `undated`, so the four add up
 * to everything in scope. Rows within a group are sorted by closing date,
 * then number.
 */
export function buildForecast(input: {
  period: ForecastPeriod;
  from: string;
  to: string;
  today: string;
  rows: ForecastRow[];
}): Forecast {
  const { period, from, to, today } = input;
  const rows = [...input.rows].sort((a, b) =>
    (a.expectedClosing ?? '9999').localeCompare(b.expectedClosing ?? '9999') || a.number.localeCompare(b.number),
  );
  const periods = periodsBetween(from, to, period);
  const byKey = new Map<string, ForecastRow[]>(periods.map((p) => [p.key, []]));
  const earlier: ForecastRow[] = [];
  const later: ForecastRow[] = [];
  const undated: ForecastRow[] = [];
  for (const r of rows) {
    if (!r.expectedClosing) undated.push(r);
    else if (r.expectedClosing < from) earlier.push(r);
    else if (r.expectedClosing > to) later.push(r);
    else byKey.get(bucketKeyOf(r.expectedClosing, period))!.push(r);
  }
  const buckets: ForecastBucket[] = periods.map((p) => ({ ...p, ...groupOf(byKey.get(p.key)!) }));
  const sum = (groups: ForecastGroup[]) => ({
    count: groups.reduce((t, g) => t + g.count, 0),
    value: groups.reduce((t, g) => t + cents(g.value), 0) / 100,
    weighted: groups.reduce((t, g) => t + cents(g.weighted), 0) / 100,
    overdue: groups.reduce((t, g) => t + g.overdue, 0),
  });
  const earlierGroup = groupOf(earlier);
  const laterGroup = groupOf(later);
  const undatedGroup = groupOf(undated);

  const perOwner = new Map<string, ForecastRow[]>();
  for (const r of rows) perOwner.set(r.owner.id, [...(perOwner.get(r.owner.id) ?? []), r]);
  const owners: ForecastOwner[] = [...perOwner.entries()]
    .map(([id, own]) => {
      const g = groupOf(own);
      return { id, name: own[0].owner.name, count: g.count, value: g.value, weighted: g.weighted };
    })
    .sort((a, b) => b.weighted - a.weighted || b.value - a.value || a.name.localeCompare(b.name));

  return {
    period,
    from,
    to,
    today,
    buckets,
    earlier: earlierGroup,
    later: laterGroup,
    undated: undatedGroup,
    inWindow: sum(buckets),
    totals: sum([...buckets, earlierGroup, laterGroup, undatedGroup]),
    owners,
  };
}
