import { type Request, type Response, type Router } from 'express';
import { Prisma } from '@prisma/client';
import { handler, badRequest, forbidden } from '../http/kit';
import { require_, currentUser } from '../auth/middleware';
import { can } from '../permissions/resolve';
import { audit } from './audit';
import { parseRange, toCsv, type Range } from './insights';
import { manilaMonthKey } from './day';
import { renderDocument, formatDate, formatAmount, formatMoney, companyCurrency, type PdfSection } from './pdf';
import { contentDisposition, paperFileName } from './paperName';

/**
 * The report engine a division's Report button opens (2026-10-15): G-CHAIN's
 * first, then G-FIN's. A report is one shape — summary cards, a series (a row
 * per month of the range by default, every one listed at zero when empty; a
 * report may draw its own rows, the aging's buckets or the forecast's weeks,
 * naming its first column in `head`) and the breakdowns its menu's reader
 * asks for. `mountReports()` gives every kind a JSON route, a `.csv` and a
 * `.pdf` twin, each audited before the bytes go out (Insights' rule). No
 * report keeps a table of its own: every figure is read off the documents.
 */

export type Cell = string | number | null;
export interface Col {
  label: string;
  money?: boolean;
  align?: 'left' | 'right';
}
export interface Table {
  title: string;
  columns: Col[];
  rows: Cell[][];
}
export interface Report {
  kind: string;
  title: string;
  from: string;
  to: string;
  /** The filters that narrowed it, in words — printed under the title. */
  filterLine?: string;
  cards: { label: string; value: number; money?: boolean; sub?: string }[];
  series: { title: string; head?: string; columns: Col[]; rows: { label: string; values: number[] }[] };
  tables: Table[];
  notes?: string[];
}

export const num = (v: Prisma.Decimal | number | null | undefined) => (v == null ? 0 : Number(v));
export const cents = (n: number) => Math.round(n * 100) / 100;
export const round3 = (n: number) => Math.round(n * 1000) / 1000;
export const dayOf = (d: Date) => d.toISOString().slice(0, 10);

/** The months of a range, oldest first, as 'YYYY-MM' keys with their labels. */
export function monthsOf(range: Range): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  const first = new Date(Date.UTC(range.from.getUTCFullYear(), range.from.getUTCMonth(), 1));
  const lastKey = dayOf(range.to).slice(0, 7);
  for (let d = first; dayOf(d).slice(0, 7) <= lastKey && out.length < 120; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    out.push({ key: dayOf(d).slice(0, 7), label: d.toLocaleDateString('en-PH', { month: 'short', year: 'numeric', timeZone: 'UTC' }) });
  }
  return out;
}

/** A tally by period: one row per period, every column at zero until something lands in it. */
export class Series {
  private readonly rows = new Map<string, number[]>();
  constructor(
    readonly title: string,
    readonly columns: Col[],
    readonly periods: { key: string; label: string }[],
    /** Which period a date falls in — the Manila month unless told otherwise. */
    private readonly keyOf: (at: Date) => string = manilaMonthKey,
    readonly head?: string,
  ) {
    for (const m of periods) this.rows.set(m.key, columns.map(() => 0));
  }
  add(at: Date | null | undefined, col: number, v: number) {
    if (!at) return;
    this.addTo(this.keyOf(at), col, v);
  }
  addTo(key: string, col: number, v: number) {
    const row = this.rows.get(key);
    if (row) row[col] = col === 0 || Number.isInteger(row[col] + v) ? row[col] + v : round3(row[col] + v);
  }
  done() {
    return {
      title: this.title,
      ...(this.head ? { head: this.head } : {}),
      columns: this.columns,
      rows: this.periods.map((m) => ({ label: m.label, values: (this.rows.get(m.key) ?? []).map((v, i) => (this.columns[i].money ? cents(v) : round3(v))) })),
    };
  }
}

/** Groups rows under a key, summing the figures each gives, for a "By …" table. */
export function tally<T>(rows: T[], keyOf: (r: T) => string, figuresOf: (r: T) => number[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const r of rows) {
    const key = keyOf(r);
    const fig = figuresOf(r);
    const cur = out.get(key) ?? fig.map(() => 0);
    out.set(key, cur.map((v, i) => v + fig[i]));
  }
  return out;
}
export const byValue = (m: Map<string, number[]>, col: number, top = 10) => [...m.entries()].sort((a, b) => b[1][col] - a[1][col]).slice(0, top);
export const table = (title: string, columns: Col[], rows: Cell[][]): Table => ({ title, columns, rows });
export const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

/** What a report builder is handed: the range of Manila days, the query, and who asked. */
export interface ReportContext {
  range: Range;
  query: Record<string, string | undefined>;
  req: Request;
}

const fmt = (v: Cell, money?: boolean) =>
  v === null || v === undefined ? '' : typeof v === 'number' ? (money ? formatAmount(v) : new Intl.NumberFormat('en-PH', { maximumFractionDigits: 3 }).format(v)) : v;

/**
 * The three routes of a division's reports on its router: `/:kind.csv`,
 * `/:kind.pdf` (both above `/:kind`) and `/:kind`. `view` is the menu's read
 * right; `rights` names, per kind, the further right its figures need (A/R's
 * for receivables, A/P's for payables) — a 403 without it.
 */
export function mountReports(
  router: Router,
  opts: {
    view: string;
    auditType: string;
    kinds: Record<string, (range: Range, ctx: ReportContext) => Promise<Report>>;
    rights?: Record<string, string>;
  },
): void {
  const names = Object.keys(opts.kinds);
  async function build(req: Request): Promise<Report> {
    const kind = String(req.params.kind ?? '');
    const builder = opts.kinds[kind];
    if (!builder) throw badRequest(`No such report — one of ${names.join(', ')}`);
    const need = opts.rights?.[kind];
    if (need && !can(currentUser(req), need)) throw forbidden(`This report needs "${need}"`);
    const q = Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, typeof v === 'string' ? v : undefined]));
    const range = parseRange(q.from, q.to);
    return builder(range, { range, query: q, req });
  }

  router.get(
    '/:kind.csv',
    require_(opts.view),
    handler(async (req, res: Response) => {
      const r = await build(req);
      const rows: Cell[][] = r.series.rows.map((x) => [x.label, ...x.values]);
      for (const t of r.tables) {
        rows.push([], [t.title], t.columns.map((c) => c.label));
        for (const row of t.rows) rows.push(row);
      }
      await audit({ entityType: opts.auditType, entityId: r.kind, action: 'EXPORTED', summary: `${r.title} exported as CSV (${r.from} to ${r.to})` }, req);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${r.kind}-${r.from}-${r.to}.csv"`);
      res.send(toCsv([r.series.head ?? 'Period', ...r.series.columns.map((c) => c.label)], rows));
    }),
  );

  router.get(
    '/:kind.pdf',
    require_(opts.view),
    handler(async (req, res: Response) => {
      const r = await build(req);
      const currency = await companyCurrency();
      const head = (cols: Col[]) => cols.map((c) => (c.money ? `${c.label} (${currency})` : c.label));
      const align = (cols: Col[]) => cols.map((c) => (c.money || c.align === 'right' ? ('right' as const) : ('left' as const)));
      const sections: PdfSection[] = [
        {
          kind: 'fields',
          columns: 2,
          fields: r.cards.map((c) => ({ label: c.label, value: `${c.money ? formatMoney(c.value, currency) : fmt(c.value)}${c.sub ? ` — ${c.sub}` : ''}` })),
        },
        {
          kind: 'table',
          title: r.series.title,
          head: [r.series.head ?? 'Period', ...head(r.series.columns)],
          align: ['left', ...align(r.series.columns)],
          rows: r.series.rows.map((x) => [x.label, ...x.values.map((v, i) => fmt(v, r.series.columns[i].money))]),
        },
        ...r.tables.map(
          (t): PdfSection => ({
            kind: 'table',
            title: t.title,
            head: head(t.columns),
            align: align(t.columns),
            rows: t.rows.map((row) => row.map((v, i) => fmt(v, t.columns[i]?.money))),
          }),
        ),
      ];
      if (r.notes?.length) sections.push({ kind: 'text', title: 'Notes', body: r.notes.join('\n') });
      const widest = Math.max(r.series.columns.length + 1, ...r.tables.map((t) => t.columns.length));
      const span = r.from === r.to ? `As of ${formatDate(new Date(`${r.to}T00:00:00Z`))}` : `${formatDate(new Date(`${r.from}T00:00:00Z`))} – ${formatDate(new Date(`${r.to}T00:00:00Z`))}`;
      const pdf = await renderDocument({
        title: r.title,
        date: new Date(),
        reference: r.filterLine ? `${span} · ${r.filterLine}` : span,
        landscape: widest > 7,
        sections,
      });
      await audit({ entityType: opts.auditType, entityId: r.kind, action: 'EXPORTED', summary: `${r.title} printed (${r.from} to ${r.to})` }, req);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', contentDisposition(paperFileName({ kind: r.title, number: `${r.from} to ${r.to}`, author: req.user?.name ?? '', date: new Date() })));
      res.send(pdf);
    }),
  );

  router.get(
    '/:kind',
    require_(opts.view),
    handler(async (req, res: Response) => {
      res.json(await build(req));
    }),
  );
}
