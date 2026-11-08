import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, downloadBlob, openPdf, qs } from '../lib/api';
import { ErrorBox, Loading, formatCompactMoney, formatMoney, useToast } from '../components/ui';
import { GroupedBars, Panel, Sankey, Stat, type BarGroup } from '../components/charts';

/**
 * The G-OPS dashboard's sales performance (2026-11-08, the owner's
 * `G-OPS_Dashboard_1.pdf`): booked sales orders BEFORE VAT, in pesos, read
 * from `GET /gops/sales` — the Sales Order report's own rows, so the two
 * agree. The month-by-month bars against last year, the top ten customers,
 * who booked (this month and the range), the Gruntech → team → person flow
 * with every node's amount and share, and page 2's monthly analysis matrix
 * (the `sales-matrix` kind of the sales reports, with its CSV and PDF).
 *
 * The section shows only to a reader of sales orders — the API answers
 * `null` to anyone else — and a View Own holder sees their own orders alone,
 * as on the list. Every customer, person and team opens the list on its
 * slice.
 */

interface Sales {
  from: string;
  to: string;
  year: number;
  previousYear: number;
  total: number;
  orders: number;
  months: { key: string; label: string; current: number; previous: number; currentOrders: number; state: 'done' | 'partial' | 'future' }[];
  customers: { id: string; name: string; orders: number; revenue: number; to: string }[];
  people: { id: string; name: string; team: string | null; month: number; range: number; orders: number; to: string }[];
  currentMonth: { key: string; label: string; from: string; to: string };
  sankey: {
    root: { label: string; value: number };
    teams: { id: string; label: string; name: string; value: number; pct: number; to: string }[];
    people: { id: string; label: string; value: number; pct: number; to: string }[];
    links: { team: string; person: string; value: number }[];
  };
}

export function OpsSales({ from, to }: { from: string; to: string }) {
  const [data, setData] = useState<Sales | null | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    setError(null);
    api
      .get<Sales | null>(`/gops/sales${qs({ from, to })}`)
      .then(setData)
      .catch(setError);
  }, [from, to]);

  if (error) return <ErrorBox error={error} />;
  if (data === undefined) return <Loading label="Adding up the sales orders…" />;
  if (data === null) return null;

  const groups: BarGroup[] = data.months.map((m) => ({
    label: m.label,
    values: [m.current, m.previous],
    mark: m.state === 'partial' ? '*' : undefined,
    faint: m.state !== 'done',
    note: m.state === 'partial' ? `* ${m.label} ${data.year} is still running` : undefined,
  }));
  // Like against like: this year's months so far against the SAME months of
  // last year — never a part-year against a whole one.
  const soFar = data.months.filter((m) => m.state !== 'future');
  const ytd = soFar.reduce((s, m) => s + m.current, 0);
  const prevSame = soFar.reduce((s, m) => s + m.previous, 0);
  const prevTotal = data.months.reduce((s, m) => s + m.previous, 0);
  const span = soFar.length ? `${soFar[0].label}–${soFar[soFar.length - 1].label}` : '';
  const change = prevSame > 0 ? ((ytd - prevSame) / prevSame) * 100 : null;

  return (
    <div className="stack">
      <Panel
        title={`Monthly sales performance — ${data.year} against ${data.previousYear}`}
        blurb="Booked sales orders before VAT, month by month, in pesos. A cancelled order books nothing."
        action={
          <Link to={`/g-ops/sales-orders/report?from=${data.from}&to=${data.to}`} className="btn btn-sm">
            Open the Sales Order report
          </Link>
        }
      >
        <div className="kpi-grid">
          <Stat label="Booked in the range" value={formatMoney(data.total)} figure sub={`${data.orders} order${data.orders === 1 ? '' : 's'}, ${data.from} to ${data.to}`} />
          <Stat label={`${data.year} so far`} value={formatMoney(ytd)} figure sub={`${span}, whole months`} />
          <Stat
            label={`${data.previousYear}, same months`}
            value={formatMoney(prevSame)}
            figure
            sub={change === null ? `${formatMoney(prevTotal)} over the whole of ${data.previousYear}` : `${change >= 0 ? '+' : ''}${change.toFixed(1)}% this year against ${span} ${data.previousYear}`}
          />
        </div>
        <GroupedBars
          groups={groups}
          series={[
            { label: `${data.year} (current year)`, tone: 'neon' },
            { label: `${data.previousYear} (previous year)`, tone: 'magenta' },
          ]}
          format={formatCompactMoney}
          caption="Jan – Dec, before VAT"
        />
      </Panel>

      <div className="grid grid-2">
        <Panel title="Top 10 customers" blurb={`${data.from} to ${data.to}, before VAT`}>
          {data.customers.length === 0 ? (
            <div className="chart-empty">Nothing booked in the range.</div>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Customer</th>
                  <th className="num">Orders</th>
                  <th className="num">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {data.customers.map((c, i) => (
                  <tr key={c.id}>
                    <td className="faint">{i + 1}</td>
                    <td>
                      <Link to={c.to}>{c.name}</Link>
                    </td>
                    <td className="num">{c.orders}</td>
                    <td className="num mono">{formatCompactMoney(c.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="Sales personnel — month vs range" blurb={`${data.currentMonth.label} beside ${data.from} to ${data.to}, before VAT`}>
          {data.people.length === 0 ? (
            <div className="chart-empty">Nobody has booked an order in the range.</div>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Sales personnel</th>
                  <th>Team</th>
                  <th className="num">{data.currentMonth.label}</th>
                  <th className="num">Range</th>
                </tr>
              </thead>
              <tbody>
                {data.people.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link to={p.to}>{p.name}</Link>
                    </td>
                    <td className="faint">{p.team ?? '—'}</td>
                    <td className="num mono">{formatCompactMoney(p.month)}</td>
                    <td className="num mono">{formatCompactMoney(p.range)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      <Panel
        title="Where the sales come from"
        blurb="Gruntech → team → the person who booked. Each node shows its revenue and its share of the whole; a person appears once whatever roles they hold."
      >
        <Sankey input={data.sankey} format={formatCompactMoney} caption={`${formatMoney(data.total)} before VAT, ${data.from} to ${data.to}`} />
      </Panel>

      <SalesMatrix year={data.year} />
    </div>
  );
}

// ── Page 2: the monthly analysis matrix ─────────────────────────────────────

interface MatrixReport {
  from: string;
  to: string;
  filterLine?: string;
  tables: { title: string; columns: { label: string; money?: boolean }[]; rows: (string | number | null)[][]; links?: (string | null)[] }[];
}

function SalesMatrix({ year: initialYear }: { year: number }) {
  const toast = useToast();
  const [year, setYear] = useState(initialYear);
  const [by, setBy] = useState<'team' | 'customer'>('team');
  const [teamId, setTeamId] = useState('');
  const [teams, setTeams] = useState<{ id: string; code: string; name: string }[]>([]);
  const [report, setReport] = useState<MatrixReport | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => setYear(initialYear), [initialYear]);
  useEffect(() => {
    api
      .get<{ id: string; code: string; name: string; isActive: boolean }[]>('/reference/industries')
      .then((rows) => setTeams(rows.filter((t) => t.isActive)))
      .catch(() => setTeams([]));
  }, []);
  const query = qs({ from: `${year}-01-01`, to: `${year}-12-31`, by, teamId: teamId || undefined });
  useEffect(() => {
    setReport(null);
    setError(null);
    api
      .get<MatrixReport>(`/sales-reports/sales-matrix${query}`)
      .then(setReport)
      .catch(setError);
  }, [query]);
  const years: number[] = [];
  for (let y = initialYear + 1; y >= initialYear - 4; y--) years.push(y);
  const table = report?.tables[0];

  return (
    <Panel
      title="Monthly sales performance analysis"
      blurb="The year's months across, the teams down with each person under their team — or the key customers. Before VAT, in pesos (M = millions, K = thousands)."
      action={
        <div className="row">
          <button className="btn btn-sm" onClick={() => void downloadBlob(`/sales-reports/sales-matrix.csv${query}`, `sales-${year}.csv`).catch(() => toast('error', 'That export is not available to you'))}>
            Export CSV
          </button>
          <button className="btn btn-sm" onClick={() => openPdf(`/api/sales-reports/sales-matrix.pdf${query}`, (m) => toast('error', m))}>
            Print
          </button>
        </div>
      }
    >
      <div className="row">
        <label className="row">
          <span className="rep-label">Year</span>
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
        <label className="row">
          <span className="rep-label">Grouping</span>
          <select value={by} onChange={(e) => setBy(e.target.value as 'team' | 'customer')}>
            <option value="team">By sales team &amp; personnel</option>
            <option value="customer">Key customers</option>
          </select>
        </label>
        <label className="row">
          <span className="rep-label">Team</span>
          <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
            <option value="">All teams</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.code} — {t.name}
              </option>
            ))}
            <option value="none">No team</option>
          </select>
        </label>
      </div>
      {error ? (
        <ErrorBox error={error} />
      ) : !report || !table ? (
        <Loading label="Building the matrix…" />
      ) : table.rows.length <= 1 ? (
        <div className="chart-empty">Nothing booked in {year}.</div>
      ) : (
        <div className="table-scroll">
          <table className="data matrix">
            <thead>
              <tr>
                {table.columns.map((c) => (
                  <th key={c.label} className={c.money ? 'num' : undefined}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((r, i) => {
                const first = String(r[0] ?? '');
                const child = first.startsWith('↳');
                const last = i === table.rows.length - 1;
                const link = table.links?.[i];
                return (
                  <tr key={i} className={`${child ? 'matrix-child' : 'matrix-group'}${last ? ' matrix-total' : ''}`}>
                    <td>{link ? <Link to={link}>{first}</Link> : first}</td>
                    {r.slice(1).map((v, j) => (
                      <td key={j} className="num mono">
                        {typeof v === 'number' ? (v === 0 ? <span className="faint">–</span> : formatCompactMoney(v).replace('₱', '')) : v}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
