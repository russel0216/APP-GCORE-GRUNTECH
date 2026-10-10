import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, downloadBlob, qs } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { addMonthsKey, firstOfMonth, monthOf, todayLocal } from '../../../lib/day';
import { BarList, Donut, Panel, Stat, type Tone } from '../../../components/charts';
import { Empty, ErrorBox, Field, Loading, formatDate, humanise, useToast } from '../../../components/ui';

/**
 * Turnover — hires and separations over a range, read straight off the
 * employee dates. Nothing is stored: the same `turnover()` on the server feeds
 * this tab, its CSV, the clearance register's strip and the dashboard tiles,
 * so none of them can disagree.
 *
 * Rate = separations ÷ the average of opening and closing headcount. A company
 * of four that loses one person has lost 25%, which is true and no signal —
 * `tooEarly` says so rather than letting the figure shout.
 */

interface Figures {
  hires: number;
  separations: number;
  averageHeadcount: number;
  ratePct: number;
  annualisedPct: number;
  tooEarly: boolean;
}

interface Turnover extends Figures {
  from: string;
  to: string;
  months: {
    month: string;
    label: string;
    opening: number;
    hires: number;
    separations: number;
    closing: number;
    ratePct: number;
    tooEarly: boolean;
  }[];
  regularOnly: Figures;
  byReason: { reason: string; count: number }[];
  byDepartment: {
    department: { id: string; name: string } | null;
    separations: number;
    averageHeadcount: number;
    ratePct: number;
  }[];
  leavers: {
    id: string;
    employeeNo: string;
    name: string;
    department: { id: string; name: string } | null;
    position: string | null;
    employmentType: string;
    dateHired: string | null;
    dateSeparated: string;
    tenureMonths: number;
    reason: string;
    clearance: { id: string; number: string } | null;
  }[];
  averageTenureMonths: number;
}

const REASON_TONE: Record<string, Tone> = {
  RESIGNATION: 'neon',
  END_OF_CONTRACT: 'info',
  END_OF_PROJECT: 'info',
  TERMINATION: 'danger',
  RETIREMENT: 'magenta',
  AWOL: 'warn',
  OTHER: 'muted',
  UNRECORDED: 'muted',
};

const reasonLabel = (r: string) => (r === 'UNRECORDED' ? 'No clearance on file' : r === 'AWOL' ? 'AWOL' : humanise(r));

/** A plain threshold, stated in the card so nobody mistakes it for policy. */
const WARN_ABOVE = 20;

export function TurnoverReport() {
  const { can } = useAuth();
  const toast = useToast();
  const [from, setFrom] = useState(() => firstOfMonth(addMonthsKey(monthOf(todayLocal()), -11)));
  const [to, setTo] = useState(todayLocal);
  const [data, setData] = useState<Turnover | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!from || !to) return;
    let live = true;
    setError(null);
    api
      .get<Turnover>(`/hr-reports/turnover${qs({ from, to })}`)
      .then((d) => live && setData(d))
      .catch((err) => live && setError(err));
    return () => {
      live = false;
    };
  }, [from, to]);

  async function download() {
    setBusy(true);
    try {
      await downloadBlob(`/hr-reports/turnover.csv${qs({ from, to })}`, `turnover-${from}-to-${to}.csv`);
    } catch {
      toast('error', 'Could not download the CSV');
    } finally {
      setBusy(false);
    }
  }

  const empty = data && data.hires === 0 && data.separations === 0 && data.averageHeadcount === 0;

  return (
    <div>
      <div className="card">
        <div className="turnover-range">
          <Field label="From">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          {can('ghr.reports.export') && (
            <button className="btn btn-sm" onClick={download} disabled={busy || !data}>
              {busy ? 'Preparing…' : 'Download CSV'}
            </button>
          )}
        </div>
      </div>

      <ErrorBox error={error} />

      {!data ? (
        !error && <Loading />
      ) : empty ? (
        <Empty
          title="No hires or separations in this range"
          hint="Turnover is counted from Date hired and Date separated on the employee record."
        />
      ) : (
        <>
          <div className="kpi-grid">
            <Stat
              label="Average headcount"
              value={data.averageHeadcount}
              sub={`${data.months.length} month(s)`}
              icon="people"
            />
            <Stat label="Hires" value={data.hires} sub="by Date hired" accent="ok" />
            <Stat
              label="Separations"
              value={data.separations}
              sub={
                data.leavers.length
                  ? `average tenure ${data.averageTenureMonths} months`
                  : 'nobody left in this range'
              }
              accent="quiet"
            />
            <Stat
              label="Turnover"
              value={`${data.ratePct}%`}
              sub={`annualised ${data.annualisedPct}% · regular staff ${data.regularOnly.ratePct}%${
                data.annualisedPct > WARN_ABOVE && !data.tooEarly ? ` · above ${WARN_ABOVE}% a year` : ''
              }`}
              accent={data.annualisedPct > WARN_ABOVE && !data.tooEarly ? 'warn' : 'quiet'}
              icon="chart"
            />
          </div>

          {data.tooEarly && (
            <div className="alert info">
              The average headcount is under five, so a single leaver moves the rate by a large
              step. Read the counts, not the percentage.
            </div>
          )}

          <div className="turnover-charts">
            <Panel title="Separations by month" blurb="Each month's own rate, against its average headcount.">
              <BarList
                slices={data.months.map((m) => ({
                  label: m.label,
                  value: m.separations,
                  display: `${m.separations} · ${m.ratePct}%`,
                  tone: m.separations > 0 ? 'magenta' : 'muted',
                }))}
                caption="Leavers per month, with that month's rate"
              />
            </Panel>
            <Panel
              title="Why people left"
              blurb="From the leaver's approved clearance. A separation typed on the employee record has none."
            >
              <Donut
                slices={data.byReason.map((r) => ({
                  label: reasonLabel(r.reason),
                  value: r.count,
                  tone: REASON_TONE[r.reason] ?? 'muted',
                }))}
                caption="Separations by reason"
                centreLabel="leavers"
              />
            </Panel>
            <Panel title="By department" blurb="Rate over the whole range; separations out of average headcount.">
              <BarList
                slices={data.byDepartment.map((d) => ({
                  label: d.department?.name ?? 'No department',
                  value: d.ratePct,
                  display: `${d.ratePct}% · ${d.separations}/${d.averageHeadcount}`,
                  tone: 'info',
                }))}
                caption="Turnover rate per department"
              />
            </Panel>
          </div>

          <div className="card">
            <h3 className="card-title">Leavers</h3>
            {data.leavers.length === 0 ? (
              <Empty title="Nobody left in this range" />
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Employee</th>
                      <th>Department</th>
                      <th>Position</th>
                      <th>Hired</th>
                      <th>Separated</th>
                      <th className="right">Tenure (mo)</th>
                      <th>Reason</th>
                      <th>Clearance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.leavers.map((l) => (
                      <tr key={l.id}>
                        <td>
                          {can('ghr.employees.view_all') ? (
                            <Link to={`/g-hr/employees/${l.id}`}>{l.name}</Link>
                          ) : (
                            l.name
                          )}
                          <div className="faint mono">{l.employeeNo}</div>
                        </td>
                        <td>{l.department?.name ?? '—'}</td>
                        <td>{l.position ?? '—'}</td>
                        <td>{formatDate(l.dateHired)}</td>
                        <td>{formatDate(l.dateSeparated)}</td>
                        <td className="right mono">{l.tenureMonths}</td>
                        <td>{reasonLabel(l.reason)}</td>
                        <td>
                          {l.clearance ? (
                            <Link to={`/g-hr/clearances/${l.clearance.id}`} className="mono">
                              {l.clearance.number}
                            </Link>
                          ) : (
                            <span className="faint">none</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="faint turnover-footnote">
              Headcount on a day counts everyone hired on or before it and not yet separated. An
              employee with no Date hired counts from the day their record was created, so an
              import without hire dates looks like a hiring spike — fill the dates in.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
