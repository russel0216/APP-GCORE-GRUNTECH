import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, downloadBlob, openPdf, qs } from '../lib/api';
import { Empty, ErrorBox, Loading, formatDate, formatMoney, useToast } from './ui';
import { MiniBar, Stat } from './charts';
import { todayLocal } from '../lib/day';

/**
 * A division's Reports page (G-CHAIN's of 2026-10-15, then G-FIN's): one
 * report per menu (`?kind=`), over a chosen range (`?from=&to=`, the presets
 * below) — or as of one day, or looking ahead — with the division's own
 * narrowing controls (`controls`, their keys in `extraKeys`, all in the URL).
 * Summary cards, the series and the breakdowns the API builds for that kind
 * (`shared/reportKit.ts`), with Export CSV and Print. The Report button on
 * each list opens here with its kind preset.
 */

export interface ReportKind {
  key: string;
  label: string;
  /** The list it reports on — "Open the list". */
  list?: string;
  /**
   * `range` (the default): from–to. `asOf`: one day. `ahead`: a window from
   * today forward. `span`: either way — the past and the ahead presets, this
   * month and the next to start (a due-date report).
   */
  mode?: 'range' | 'asOf' | 'ahead' | 'span';
}

interface ReportColumn {
  label: string;
  money?: boolean;
  align?: 'left' | 'right';
}
interface Report {
  kind: string;
  title: string;
  from: string;
  to: string;
  filterLine?: string;
  cards: { label: string; value: number; money?: boolean; sub?: string }[];
  series: { title: string; head?: string; columns: ReportColumn[]; rows: { label: string; values: number[] }[] };
  tables: { title: string; columns: ReportColumn[]; rows: (string | number | null)[][] }[];
  notes?: string[];
}

function monthStart(offset: number): string {
  const t = todayLocal();
  const d = new Date(Date.UTC(Number(t.slice(0, 4)), Number(t.slice(5, 7)) - 1 + offset, 1));
  return d.toISOString().slice(0, 10);
}
function quarterStart(): string {
  const t = todayLocal();
  const m = Number(t.slice(5, 7)) - 1;
  return `${t.slice(0, 4)}-${String(Math.floor(m / 3) * 3 + 1).padStart(2, '0')}-01`;
}
function shift(key: string, days: number): string {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The range presets, on the local day: each answers from and to as 'YYYY-MM-DD'. */
const PAST: { key: string; label: string; range: () => [string, string] }[] = [
  { key: 'month', label: 'This month', range: () => [monthStart(0), todayLocal()] },
  { key: 'last-month', label: 'Last month', range: () => [monthStart(-1), shift(monthStart(0), -1)] },
  { key: 'quarter', label: 'This quarter', range: () => [quarterStart(), todayLocal()] },
  { key: 'ytd', label: 'Year to date', range: () => [`${todayLocal().slice(0, 4)}-01-01`, todayLocal()] },
  { key: '12m', label: 'Last 12 months', range: () => [monthStart(-11), todayLocal()] },
];
const AHEAD: { key: string; label: string; range: () => [string, string] }[] = [
  { key: '30d', label: 'Next 30 days', range: () => [todayLocal(), shift(todayLocal(), 29)] },
  { key: '90d', label: 'Next 90 days', range: () => [todayLocal(), shift(todayLocal(), 89)] },
  { key: '6m', label: 'Next 6 months', range: () => [todayLocal(), shift(monthStart(6), -1)] },
];
const SPAN: { key: string; label: string; range: () => [string, string] }[] = [
  { key: 'two-months', label: 'This & next month', range: () => [monthStart(0), shift(monthStart(2), -1)] },
  { key: 'month', label: 'This month', range: () => [monthStart(0), shift(monthStart(1), -1)] },
  { key: 'next-month', label: 'Next month', range: () => [monthStart(1), shift(monthStart(2), -1)] },
  { key: 'last-month', label: 'Last month', range: () => [monthStart(-1), shift(monthStart(0), -1)] },
  { key: '90d', label: 'Next 90 days', range: () => [todayLocal(), shift(todayLocal(), 89)] },
];
const qtyText = (n: number) => new Intl.NumberFormat('en-PH', { maximumFractionDigits: 3 }).format(n);
const cell = (v: string | number | null, money?: boolean) => (v === null || v === undefined ? '—' : typeof v === 'number' ? (money ? formatMoney(v) : qtyText(v)) : v);

export function ReportPage({
  title,
  endpoint,
  kinds,
  extraKeys = [],
  controls,
}: {
  title: string;
  /** The API base, e.g. `/chain-reports`. */
  endpoint: string;
  kinds: readonly ReportKind[];
  /** URL keys the controls set, passed to the API as they are. */
  extraKeys?: string[];
  controls?: (ctx: { kind: string; params: URLSearchParams; set: (patch: Record<string, string>) => void }) => ReactNode;
}) {
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const current = kinds.find((k) => k.key === params.get('kind')) ?? kinds[0];
  const kind = current.key;
  const mode = current.mode ?? 'range';
  const presets = mode === 'ahead' ? AHEAD : mode === 'span' ? SPAN : PAST;
  const [defFrom, defTo] = mode === 'ahead' ? AHEAD[1].range() : mode === 'span' ? SPAN[0].range() : PAST[3].range();
  const to = params.get('to') || (mode === 'asOf' ? todayLocal() : defTo);
  const from = mode === 'asOf' ? to : params.get('from') || defFrom;
  const extra = Object.fromEntries(extraKeys.map((k) => [k, params.get(k) || undefined]));
  const query = { from, to, ...extra };
  const extraKey = JSON.stringify(extra);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };

  useEffect(() => {
    let live = true;
    setLoading(true);
    api
      .get<Report>(`${endpoint}/${kind}${qs(query)}`)
      .then((r) => {
        if (!live) return;
        setReport(r);
        setError(null);
      })
      .catch((err) => live && setError(err))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, kind, from, to, extraKey]);

  const preset = useMemo(() => presets.find((p) => p.range().join() === [from, to].join())?.key ?? 'custom', [presets, from, to]);
  const peakOf = (i: number) => Math.max(0, ...(report?.series.rows.map((r) => Math.abs(r.values[i] ?? 0)) ?? []));
  const firstMoney = report ? report.series.columns.findIndex((c) => c.money) : -1;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{title}</h1>
        </div>
        <div className="row">
          <button
            type="button"
            className="btn"
            onClick={() =>
              downloadBlob(`${endpoint}/${kind}.csv${qs(query)}`, `${kind}-${from}-${to}.csv`).catch(() => toast('error', 'The CSV could not be downloaded'))
            }
          >
            Export CSV
          </button>
          <button type="button" className="btn" onClick={() => openPdf(`/api${endpoint}/${kind}.pdf${qs(query)}`, () => toast('error', 'The report could not be printed'))}>
            Print
          </button>
        </div>
      </div>

      <div className="card rep-controls">
        <div className="rep-row">
          <label className="rep-label" htmlFor="rep-kind">
            Report
          </label>
          <select id="rep-kind" value={kind} onChange={(e) => set({ kind: e.target.value, from: '', to: '' })}>
            {kinds.map((k) => (
              <option key={k.key} value={k.key}>
                {k.label}
              </option>
            ))}
          </select>
          {current.list && (
            <Link className="btn btn-sm" to={current.list}>
              Open the list
            </Link>
          )}
        </div>
        <div className="rep-row">
          <span className="rep-label">{mode === 'asOf' ? 'As of' : 'Period'}</span>
          {mode === 'asOf' ? (
            <label className="rep-date">
              <input type="date" aria-label="As of" value={to} max={todayLocal()} onChange={(e) => set({ to: e.target.value })} />
            </label>
          ) : (
            <>
              <div className="scope-switch" role="group" aria-label="Period">
                {presets.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    className={preset === p.key ? 'active' : ''}
                    aria-pressed={preset === p.key}
                    onClick={() => {
                      const [f, t] = p.range();
                      set({ from: f, to: t });
                    }}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <label className="rep-date">
                <span className="faint">From</span>
                <input type="date" value={from} max={to} onChange={(e) => set({ from: e.target.value })} />
              </label>
              <label className="rep-date">
                <span className="faint">To</span>
                <input type="date" value={to} min={from} onChange={(e) => set({ to: e.target.value })} />
              </label>
            </>
          )}
        </div>
        {controls && <div className="rep-row">{controls({ kind, params, set })}</div>}
      </div>

      <ErrorBox error={error} />
      {loading && !report ? (
        <Loading />
      ) : report ? (
        <>
          <div className="kpi-grid proc-stats">
            {report.cards.map((c) => (
              <Stat key={c.label} label={c.label} value={c.money ? formatMoney(c.value) : qtyText(c.value)} sub={c.sub} figure={c.money} />
            ))}
          </div>

          <div className="card">
            <h3 className="card-title">{report.series.title}</h3>
            <p className="faint">
              {report.from === report.to ? `As of ${formatDate(report.to)}` : `${formatDate(report.from)} – ${formatDate(report.to)}`}
              {report.filterLine && ` · ${report.filterLine}`}
            </p>
            {report.series.rows.length === 0 ? (
              <Empty title="Nothing in this period" />
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>{report.series.head ?? 'Period'}</th>
                      {report.series.columns.map((c) => (
                        <th key={c.label} className={c.align === 'left' ? undefined : 'right'}>
                          {c.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {report.series.rows.map((r) => (
                      <tr key={r.label}>
                        <td>{r.label}</td>
                        {r.values.map((v, i) => (
                          <td key={i} className={report.series.columns[i]?.align === 'left' ? undefined : 'right mono'}>
                            {i === firstMoney ? (
                              <div className="rep-bar-cell">
                                <MiniBar value={v} peak={peakOf(i)} />
                                <span>{formatMoney(v)}</span>
                              </div>
                            ) : (
                              cell(v, report.series.columns[i]?.money)
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="grid grid-2">
            {report.tables.map((t) => (
              <div className={`card${t.columns.length > 5 ? ' rep-wide' : ''}`} key={t.title}>
                <h3 className="card-title">{t.title}</h3>
                {t.rows.length === 0 ? (
                  <Empty title="Nothing yet" />
                ) : (
                  <div className="table-wrap">
                    <table className="data">
                      <thead>
                        <tr>
                          {t.columns.map((c) => (
                            <th key={c.label} className={c.align === 'right' || c.money ? 'right' : undefined}>
                              {c.label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {t.rows.map((row, n) => (
                          <tr key={n}>
                            {row.map((v, i) => (
                              <td key={i} className={t.columns[i]?.align === 'right' || t.columns[i]?.money ? 'right mono' : undefined}>
                                {cell(v, t.columns[i]?.money)}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}
          </div>
          {report.notes?.length ? <p className="faint">{report.notes.join(' ')}</p> : null}
        </>
      ) : null}
    </div>
  );
}
