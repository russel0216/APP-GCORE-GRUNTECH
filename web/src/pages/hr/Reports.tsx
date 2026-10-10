import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { Empty, ErrorBox, Field, Loading, formatMoney } from '../../components/ui';
import { todayLocal } from '../../lib/day';
import { TurnoverReport } from './reports/TurnoverReport';
import { NumberInput } from '../../components/NumberInput';

/**
 * HR reports.
 *
 * Three questions worth asking every month: what is overtime costing each
 * project, how much leave is still owed, and who is leaving. All are read
 * straight off the records, so they cannot disagree with the ledger or the
 * employee file.
 *
 * The tab lives in `?tab=` so a dashboard tile can open the turnover report
 * directly.
 */

const TABS = ['overtime', 'leave', 'turnover'] as const;
type Tab = (typeof TABS)[number];

interface OvertimeByProject {
  from: string;
  to: string;
  jobs: {
    job: { id: string; number: string; name: string };
    hours: number;
    amount: number;
    entries: number;
  }[];
  totalHours: number;
  totalAmount: number;
}

interface LeaveBalances {
  year: number;
  types: { id: string; code: string; name: string }[];
  rows: {
    employee: { id: string; employeeNo: string; firstName: string; lastName: string };
    balances: { typeId: string; entitled: number; carriedOver: number; used: number; pending: number; remaining: number }[];
  }[];
}

const startOfYear = () => `${new Date().getFullYear()}-01-01`;
const today = todayLocal;

export function HrReports() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: Tab = TABS.includes(raw as Tab) ? (raw as Tab) : 'overtime';

  const pick = (next: Tab) => {
    const p = new URLSearchParams(params);
    if (next === 'overtime') p.delete('tab');
    else p.set('tab', next);
    setParams(p, { replace: true });
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>HR Reports</h1>
          <p>
            Overtime is a project cost as much as a payroll one — the first report shows it the way
            a project manager needs to see it. Turnover counts who joined and who left, from the
            dates on the employee record.
          </p>
        </div>
      </div>

      <div className="scope-switch" role="tablist" style={{ marginBottom: 'var(--block-gap)' }}>
        <button
          role="tab"
          aria-selected={tab === 'overtime'}
          className={tab === 'overtime' ? 'active' : ''}
          onClick={() => pick('overtime')}
        >
          Overtime by project
        </button>
        <button
          role="tab"
          aria-selected={tab === 'leave'}
          className={tab === 'leave' ? 'active' : ''}
          onClick={() => pick('leave')}
        >
          Leave balances
        </button>
        <button
          role="tab"
          aria-selected={tab === 'turnover'}
          className={tab === 'turnover' ? 'active' : ''}
          onClick={() => pick('turnover')}
        >
          Turnover
        </button>
      </div>

      {tab === 'overtime' ? <OvertimeReport /> : tab === 'leave' ? <LeaveReport /> : <TurnoverReport />}
    </div>
  );
}

function OvertimeReport() {
  const [from, setFrom] = useState(startOfYear());
  const [to, setTo] = useState(today());
  const [data, setData] = useState<OvertimeByProject | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.get<OvertimeByProject>(`/hr-reports/overtime-by-project${qs({ from, to })}`));
    } catch (err) {
      setError(err);
    }
  }, [from, to]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <div className="card">
        <div className="grid grid-2">
          <Field label="From">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
      </div>

      <ErrorBox error={error} />

      {!data ? (
        <Loading />
      ) : data.jobs.length === 0 ? (
        <Empty
          title="No approved overtime charged to a project in this range"
          hint="Overtime only reaches a project once the supervisor and HR have both approved the actual hours."
        />
      ) : (
        <div className="card">
          <h3 className="card-title">
            {data.totalHours} hours · {formatMoney(data.totalAmount)}
          </h3>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Project</th>
                  <th className="right">Filings</th>
                  <th className="right">Hours</th>
                  <th className="right">Charged</th>
                </tr>
              </thead>
              <tbody>
                {data.jobs.map((j) => (
                  <tr key={j.job.id}>
                    <td>
                      <Link to={`/g-ops/projects/${j.job.id}`} className="mono">
                        {j.job.number}
                      </Link>
                      <div className="faint">{j.job.name}</div>
                    </td>
                    <td className="right mono">{j.entries}</td>
                    <td className="right mono">{j.hours}</td>
                    <td className="right mono">{formatMoney(j.amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th>Total</th>
                  <th className="right mono">{data.jobs.reduce((s, j) => s + j.entries, 0)}</th>
                  <th className="right mono">{data.totalHours}</th>
                  <th className="right mono">{formatMoney(data.totalAmount)}</th>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function LeaveReport() {
  const [year, setYear] = useState(new Date().getFullYear());
  const [data, setData] = useState<LeaveBalances | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    setError(null);
    api
      .get<LeaveBalances>(`/hr-reports/leave-balances${qs({ year })}`)
      .then(setData)
      .catch(setError);
  }, [year]);

  return (
    <div>
      <div className="card">
        <Field label="Year">
          <NumberInput
            kind="plain"
            min={2000}
            max={2100}
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
          />
        </Field>
      </div>

      <ErrorBox error={error} />

      {!data ? (
        <Loading />
      ) : data.rows.length === 0 ? (
        <Empty title="No active employees" />
      ) : (
        <div className="card">
          <h3 className="card-title">Days remaining, {data.year}</h3>
          <p className="muted">
            Remaining is entitlement plus anything carried over, less what has been approved.
            Anything still awaiting a decision is shown separately — it has not been spent.
          </p>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Employee</th>
                  {data.types.map((t) => (
                    <th key={t.id} className="right">
                      {t.code}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.employee.id}>
                    <td>
                      {r.employee.lastName}, {r.employee.firstName}
                      <div className="faint mono">{r.employee.employeeNo}</div>
                    </td>
                    {data.types.map((t) => {
                      const b = r.balances.find((x) => x.typeId === t.id);
                      return (
                        <td key={t.id} className="right mono">
                          {b ? b.remaining : '—'}
                          {b && b.pending > 0 && (
                            <div className="section-label">
                              {b.pending} pending
                            </div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
