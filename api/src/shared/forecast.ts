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

/**
 * `range` (2026-10-12, the owner's call: "I want to have a specified date
 * range") is the whole window as ONE period — a sales push or a quarter that
 * starts mid-month, which no calendar period names.
 */
export type ForecastPeriod = 'week' | 'month' | 'quarter' | 'year' | 'range';
export const FORECAST_PERIODS: readonly ForecastPeriod[] = ['week', 'month', 'quarter', 'year', 'range'];

/** How many periods the default window shows, the current one included (`range` opens on the months'). */
export const DEFAULT_SPAN: Record<ForecastPeriod, number> = { week: 12, month: 12, quarter: 8, year: 3, range: 12 };

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

/** The first day of the period `day` falls in. Weeks start on Monday. `range` has no calendar of its own. */
export function periodStart(day: string, period: ForecastPeriod): string {
  const d = toDate(day);
  switch (period) {
    case 'range':
      return day;
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
    case 'range':
      throw new Error('A whole range has no next period');
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

/** A span of days: '5–11 Oct 2026', '28 Sep – 4 Oct 2026', '29 Dec 2025 – 4 Jan 2026', '12 Oct 2026'. */
export function spanLabel(from: string, to: string): string {
  if (from === to) return `${dayOf(from)} ${MONTHS[monthOf(from)]} ${yearOf(from)}`;
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
      return { key: `${year}-W${String(week).padStart(2, '0')}`, label: spanLabel(start, to), from: start, to };
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
    case 'range':
      throw new Error('A whole range is made by periodsBetween');
  }
}

/** The bucket key a day falls in. */
export function bucketKeyOf(day: string, period: ForecastPeriod): string {
  if (period === 'range') return 'range';
  return periodBucket(periodStart(day, period), period).key;
}

/**
 * Every period touching the days `from`..`to`, from the one `from` falls in
 * to the one `to` falls in. Throws when the window would hold more than
 * MAX_BUCKETS — the route turns that into a 400.
 */
export function periodsBetween(from: string, to: string, period: ForecastPeriod): PeriodBucket[] {
  if (period === 'range') return [{ key: 'range', label: spanLabel(from, to), from, to }];
  const out: PeriodBucket[] = [];
  let start = periodStart(from, period);
  while (start <= to) {
    out.push(periodBucket(start, period));
    if (out.length > MAX_BUCKETS) throw new Error(`That window holds more than ${MAX_BUCKETS} ${period}s — narrow it`);
    start = periodNext(start, period);
  }
  // The window's edges are the range's (2026-10-12): a first or last period
  // the range only partly covers runs from `from` / to `to` and says so in
  // its label, so its figures, its name and the list it links to are the
  // same days. Its key stays the period's.
  const first = out[0];
  const last = out[out.length - 1];
  if (first && first.from < from) out[0] = { ...first, from, label: spanLabel(from, first.to < to ? first.to : to) };
  if (last && last.to > to) {
    const head = out[out.length - 1];
    out[out.length - 1] = { ...head, to, label: spanLabel(head.from, to) };
  }
  return out;
}

/** The ready-made ranges the page offers (2026-10-12). */
export const RANGE_PRESETS = ['this-month', 'this-quarter', 'this-year', 'next-30', 'next-90', 'next-12m'] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
export const RANGE_PRESET_LABELS: Record<RangePreset, string> = {
  'this-month': 'This month',
  'this-quarter': 'This quarter',
  'this-year': 'This year',
  'next-30': 'Next 30 days',
  'next-90': 'Next 90 days',
  'next-12m': 'Next 12 months',
};

/** A preset's days on `today` (a Manila day key): calendar periods whole, "next N" counted from today. */
export function rangePreset(preset: RangePreset, today: string): { from: string; to: string } {
  const whole = (period: 'month' | 'quarter' | 'year') => {
    const from = periodStart(today, period);
    return { from, to: addDays(periodNext(from, period), -1) };
  };
  switch (preset) {
    case 'this-month':
      return whole('month');
    case 'this-quarter':
      return whole('quarter');
    case 'this-year':
      return whole('year');
    case 'next-30':
      return { from: today, to: addDays(today, 29) };
    case 'next-90':
      return { from: today, to: addDays(today, 89) };
    case 'next-12m': {
      // Twelve months on, the day before: 12 Oct 2026 – 11 Oct 2027 (a 31st runs to the month's end).
      const y = Number(yearOf(today)) + 1;
      const m = monthOf(today);
      const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      const same = `${y}-${String(m + 1).padStart(2, '0')}-${String(Math.min(dayOf(today), last)).padStart(2, '0')}`;
      return { from: today, to: addDays(same, -1) };
    }
  }
}

/** The window the Forecast opens on: the current period and the next `DEFAULT_SPAN - 1`. */
export function defaultWindow(today: string, period: ForecastPeriod): { from: string; to: string } {
  if (period === 'range') return defaultWindow(today, 'month');
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
  /** The team it counts under: a quotation's tag, else its author's; a lead's assignee's. Null is "No team". */
  team: { id: string; code: string; name: string } | null;
  /**
   * Its value split across its product groups by line amount (`groupShares()`,
   * the rule Sales Analytics' "By group" uses), adding up to `value` to the
   * centavo; a lead, or a quotation with no priced line, is one "No group" share.
   */
  groups: { key: string; group: string; value: number }[];
}

/** One cell of a breakdown: how many records, their value, and the weighted sum (rounded once). */
export interface ForecastCell {
  count: number;
  value: number;
  weighted: number;
}

/**
 * One line of a breakdown (2026-10-12, the owner's call: "forecast of sales
 * person, by product group, by team"): its share of every period in the
 * window, of before / after / undated, and its total.
 */
export interface ForecastLine extends ForecastCell {
  id: string;
  name: string;
  /** The full name where `name` is a code (a team). */
  hint?: string;
  overdue: number;
  periods: Record<string, ForecastCell>;
  earlier: ForecastCell;
  later: ForecastCell;
  undated: ForecastCell;
}

export type ForecastBreakdown = 'owner' | 'team' | 'group';
export const FORECAST_BREAKDOWNS: readonly ForecastBreakdown[] = ['owner', 'team', 'group'];
/** The line a row without a team or a group stands under — always listed last. */
export const NO_TEAM_ID = 'none';
export const NO_GROUP_KEY = '';

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
  /** The three breakdowns, each line's cells adding up to the buckets' (value to the centavo). */
  byOwner: ForecastLine[];
  byTeam: ForecastLine[];
  byGroup: ForecastLine[];
}

/**
 * A breakdown from its contributions: each a share of one row under one
 * line. A row counts once per line it touches; the value is summed in cents,
 * the weighted sum rounded ONCE per cell (the board's rule). Lines are
 * sorted by weighted, the catch-all line (`lastId`) last.
 */
export function breakdownOf(
  items: { id: string; name: string; hint?: string; row: ForecastRow; value: number }[],
  place: (row: ForecastRow) => string,
  bucketKeys: string[],
  lastId: string | null = null,
): ForecastLine[] {
  type Acc = { count: number; value: number; weighted: number; ids: Set<string> };
  const acc = () => ({ count: 0, value: 0, weighted: 0, ids: new Set<string>() });
  const lines = new Map<string, { id: string; name: string; hint?: string; overdue: Set<string>; cells: Map<string, Acc>; all: Acc }>();
  for (const it of items) {
    let line = lines.get(it.id);
    if (!line) {
      line = { id: it.id, name: it.name, hint: it.hint, overdue: new Set(), cells: new Map(), all: acc() };
      lines.set(it.id, line);
    }
    const where = place(it.row);
    const cell = line.cells.get(where) ?? acc();
    line.cells.set(where, cell);
    for (const c of [cell, line.all]) {
      if (!c.ids.has(it.row.id)) {
        c.ids.add(it.row.id);
        c.count += 1;
      }
      c.value += cents(it.value);
      c.weighted += (cents(it.value) * it.row.probability) / 100;
    }
    if (it.row.overdue) line.overdue.add(it.row.id);
  }
  const out = (a: Acc | undefined): ForecastCell =>
    a ? { count: a.count, value: a.value / 100, weighted: Math.round(a.weighted) / 100 } : { count: 0, value: 0, weighted: 0 };
  return [...lines.values()]
    .map((l) => ({
      id: l.id,
      name: l.name,
      ...(l.hint ? { hint: l.hint } : {}),
      ...out(l.all),
      overdue: l.overdue.size,
      periods: Object.fromEntries(bucketKeys.map((k) => [k, out(l.cells.get(k))])),
      earlier: out(l.cells.get('earlier')),
      later: out(l.cells.get('later')),
      undated: out(l.cells.get('undated')),
    }))
    .sort((a, b) =>
      Number(a.id === lastId) - Number(b.id === lastId) || b.weighted - a.weighted || b.value - a.value || a.name.localeCompare(b.name),
    );
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

  const keys = periods.map((p) => p.key);
  const place = (r: ForecastRow) =>
    !r.expectedClosing ? 'undated' : r.expectedClosing < from ? 'earlier' : r.expectedClosing > to ? 'later' : bucketKeyOf(r.expectedClosing, period);
  const byOwner = breakdownOf(rows.map((r) => ({ id: r.owner.id, name: r.owner.name, row: r, value: r.value })), place, keys);
  const byTeam = breakdownOf(
    rows.map((r) => ({
      id: r.team?.id ?? NO_TEAM_ID,
      name: r.team?.code ?? 'No team',
      hint: r.team?.name,
      row: r,
      value: r.value,
    })),
    place,
    keys,
    NO_TEAM_ID,
  );
  const byGroup = breakdownOf(
    rows.flatMap((r) => r.groups.map((g) => ({ id: g.key, name: g.group, row: r, value: g.value }))),
    place,
    keys,
    NO_GROUP_KEY,
  );

  return {
    period,
    from,
    to,
    today,
    buckets,
    byOwner,
    byTeam,
    byGroup,
    earlier: earlierGroup,
    later: laterGroup,
    undated: undatedGroup,
    inWindow: sum(buckets),
    totals: sum([...buckets, earlierGroup, laterGroup, undatedGroup]),
    owners,
  };
}
