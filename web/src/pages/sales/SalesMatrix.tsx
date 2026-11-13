import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, downloadBlob, openPdf, qs } from '../../lib/api';
import { ErrorBox, Loading, formatCompactMoney, useToast } from '../../components/ui';
import { Panel } from '../../components/charts';

/**
 * The month-by-month grid of the year's sales (2026-11-08) — the teams down
 * with each person under their team, or the key customers; the `sales-matrix`
 * kind of the sales reports, with its own CSV and paper. It sat on the G-OPS
 * dashboard until 2026-11-13, when the dashboard became a summary and the
 * Sales Order report the one place for the detail.
 */

interface MatrixReport {
  from: string;
  to: string;
  filterLine?: string;
  tables: { title: string; columns: { label: string; money?: boolean }[]; rows: (string | number | null)[][]; links?: (string | null)[] }[];
}

export function SalesMatrix({ year: initialYear }: { year: number }) {
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
