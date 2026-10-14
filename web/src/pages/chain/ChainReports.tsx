import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, downloadBlob, openPdf, qs } from '../../lib/api';
import { Empty, ErrorBox, Loading, formatDate, formatMoney, useToast } from '../../components/ui';
import { MiniBar, Stat } from '../../components/charts';
import { todayLocal } from '../../lib/day';

/**
 * G-CHAIN › Reports (2026-10-15, the owner's call: "a Report button per
 * menu, any applicable in the list, selectable time range" — monthly
 * incoming goods by quantity and value, supplier monthly total cost, and the
 * like). One page, one report per procurement and warehouse menu
 * (`?kind=`), over a chosen range (`?from=&to=`, the presets below): summary
 * cards, a month-by-month series and the breakdowns the API builds for that
 * kind — the API is `routes/chainReports.ts`, and every report has a `.csv`
 * and a `.pdf` twin. The Report button on each list opens here with its
 * kind preset.
 */

/** The reports, in the strips' order; each names the list it reports on. */
export const REPORT_KINDS = [
  { key: 'overview', label: 'Overview', list: '/g-chain' },
  { key: 'purchase-requests', label: 'Purchase requests', list: '/g-chain/purchase-requests' },
  { key: 'rfq', label: 'RFQ', list: '/g-chain/rfqs' },
  { key: 'canvass', label: 'Canvass', list: '/g-chain/canvasses' },
  { key: 'purchase-orders', label: 'Purchase orders', list: '/g-chain/purchase-orders' },
  { key: 'incoming', label: 'Incoming', list: '/g-chain/incoming' },
  { key: 'inventory', label: 'Inventory', list: '/g-chain/inventory' },
  { key: 'outgoing', label: 'Outgoing', list: '/g-chain/outgoing' },
  { key: 'borrow', label: 'Borrow slips', list: '/g-chain/borrow-slips' },
  { key: 'pullout', label: 'Pull-out slips', list: '/g-chain/pullout-slips' },
] as const;
type Kind = (typeof REPORT_KINDS)[number]['key'];

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
  cards: { label: string; value: number; money?: boolean; sub?: string }[];
  series: { title: string; columns: ReportColumn[]; rows: { label: string; values: number[] }[] };
  tables: { title: string; columns: ReportColumn[]; rows: (string | number | null)[][] }[];
  notes?: string[];
}

/** The range presets, on the local day: each answers from and to as 'YYYY-MM-DD'. */
const PRESETS: { key: string; label: string; range: () => [string, string] }[] = [
  { key: 'month', label: 'This month', range: () => [monthStart(0), todayLocal()] },
  { key: 'last-month', label: 'Last month', range: () => [monthStart(-1), dayBefore(monthStart(0))] },
  { key: 'quarter', label: 'This quarter', range: () => [quarterStart(), todayLocal()] },
  { key: 'ytd', label: 'Year to date', range: () => [`${todayLocal().slice(0, 4)}-01-01`, todayLocal()] },
  { key: '12m', label: 'Last 12 months', range: () => [monthStart(-11), todayLocal()] },
];
function monthStart(offset: number): string {
  const t = todayLocal();
  const y = Number(t.slice(0, 4));
  const m = Number(t.slice(5, 7)) - 1 + offset;
  const d = new Date(Date.UTC(y, m, 1));
  return d.toISOString().slice(0, 10);
}
function quarterStart(): string {
  const t = todayLocal();
  const m = Number(t.slice(5, 7)) - 1;
  return `${t.slice(0, 4)}-${String(Math.floor(m / 3) * 3 + 1).padStart(2, '0')}-01`;
}
function dayBefore(key: string): string {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
const qtyText = (n: number) => new Intl.NumberFormat('en-PH', { maximumFractionDigits: 3 }).format(n);
const cell = (v: string | number | null, money?: boolean) => (v === null || v === undefined ? '—' : typeof v === 'number' ? (money ? formatMoney(v) : qtyText(v)) : v);

export function ChainReports() {
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const kind = (REPORT_KINDS.find((k) => k.key === params.get('kind'))?.key ?? 'overview') as Kind;
  const [defaultFrom, defaultTo] = PRESETS[3].range();
  const from = params.get('from') || defaultFrom;
  const to = params.get('to') || defaultTo;
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
      .get<Report>(`/chain-reports/${kind}${qs({ from, to })}`)
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
  }, [kind, from, to]);

  const preset = useMemo(() => PRESETS.find((p) => p.range().join() === [from, to].join())?.key ?? 'custom', [from, to]);
  const current = REPORT_KINDS.find((k) => k.key === kind)!;
  const peakOf = (i: number) => Math.max(0, ...(report?.series.rows.map((r) => Math.abs(r.values[i] ?? 0)) ?? []));
  const firstMoney = report ? report.series.columns.findIndex((c) => c.money) : -1;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Supply Chain Reports</h1>
        </div>
        <div className="row">
          <button
            type="button"
            className="btn"
            onClick={() =>
              downloadBlob(`/chain-reports/${kind}.csv${qs({ from, to })}`, `${kind}-${from}-${to}.csv`).catch(() => toast('error', 'The CSV could not be downloaded'))
            }
          >
            Export CSV
          </button>
          <button type="button" className="btn" onClick={() => openPdf(`/api/chain-reports/${kind}.pdf${qs({ from, to })}`, () => toast('error', 'The report could not be printed'))}>
            Print
          </button>
        </div>
      </div>

      <div className="card rep-controls">
        <div className="rep-row">
          <label className="rep-label" htmlFor="rep-kind">
            Report
          </label>
          <select id="rep-kind" value={kind} onChange={(e) => set({ kind: e.target.value })}>
            {REPORT_KINDS.map((k) => (
              <option key={k.key} value={k.key}>
                {k.label}
              </option>
            ))}
          </select>
          <Link className="btn btn-sm" to={current.list}>
            Open the list
          </Link>
        </div>
        <div className="rep-row">
          <span className="rep-label">Period</span>
          <div className="scope-switch" role="group" aria-label="Period">
            {PRESETS.map((p) => (
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
        </div>
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
              {formatDate(report.from)} – {formatDate(report.to)}
            </p>
            {report.series.rows.length === 0 ? (
              <Empty title="Nothing in this period" />
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Period</th>
                      {report.series.columns.map((c, i) => (
                        <th key={c.label} className={c.align === 'left' ? undefined : 'right'}>
                          {c.label}
                          {i === firstMoney ? '' : ''}
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
                                <MiniBar value={v} peak={peakOf(i)} tone="neon" />
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
              <div className="card" key={t.title}>
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
          {report.notes?.length ? (
            <p className="faint">{report.notes.join(' ')}</p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
