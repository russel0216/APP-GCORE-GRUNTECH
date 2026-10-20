import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { parseDay } from '../../lib/day';
import { Stat } from '../../components/charts';
import { Empty, ErrorBox, Loading, StatusBadge, durationLabel, formatDate, formatTime, type Tone } from '../../components/ui';
import { PriorModal } from './Overtime';

/**
 * G-HR › MY RECORDS (2026-10-20, the owner's G-HR Records spec): the signed-in
 * employee's own records on one page — Attendance (leave balances, the
 * cutoff's daily time record, their overtime), the Employee 201 File and
 * their place on the Plantilla. Everything is read by `GET /my-records`,
 * which only ever answers for the caller.
 */

type DtrStatus = 'NOT_EMPLOYED' | 'PRESENT' | 'LATE' | 'HALF_DAY' | 'OPEN' | 'ON_LEAVE' | 'REST_DAY' | 'HOLIDAY' | 'ABSENT' | 'UPCOMING';
interface DtrDay {
  date: string;
  weekday: string;
  status: DtrStatus;
  note: string | null;
  timeIn: string | null;
  timeOut: string | null;
  lateMinutes: number;
  undertimeMinutes: number;
  workedMinutes: number;
  open: boolean;
}
interface Cutoff {
  key: string;
  from: string;
  to: string;
  label: string;
  current: boolean;
  previous: string;
  next: string | null;
  mode: 'SEMI_MONTHLY' | 'MONTHLY';
}
interface Balance {
  leaveType: { id: string; code: string; name: string; isPaid: boolean };
  entitled: number;
  carriedOver: number;
  used: number;
  pending: number;
  remaining: number;
}
interface OtRow {
  id: string;
  number: string;
  date: string;
  hours: number;
  actual: boolean;
  window: string;
  reason: string;
  project: string | null;
  stage: string;
  stageLabel: string;
  approver: string | null;
}
interface Records {
  cutoff: Cutoff;
  employee?: null;
  dtr: {
    days: DtrDay[];
    today: string;
    totals: { present: number; late: number; lateMinutes: number; undertimeMinutes: number; workedMinutes: number; absent: number; onLeave: number };
  };
  balances: Balance[];
  year: number;
  overtime: OtRow[];
  file: {
    employeeNo: string | null;
    name: string;
    title: string | null;
    team: { code: string; name: string } | null;
    employmentTypeLabel: string;
    dateHired: string | null;
    dateRegularized: string | null;
    service: { years: number; months: number } | null;
    sssNo: string | null;
    pagibigNo: string | null;
    philhealthNo: string | null;
    tin: string | null;
    taxStatusLabel: string | null;
    emergencyContactName: string | null;
    emergencyContactPhone: string | null;
    mobile: string | null;
    address: string | null;
    birthDate: string | null;
  };
  plantilla: {
    title: string | null;
    position: { code: string; title: string; role: string | null } | null;
    alsoHolds: { code: string; title: string }[];
    roles: { name: string; rank: number | null }[];
    team: { code: string; name: string } | null;
    reportsTo: { name: string; position: string | null } | null;
    directReports: number;
  };
}

const TABS = ['attendance', 'file', 'plantilla'] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = { attendance: 'Attendance', file: 'Employee 201 File', plantilla: 'Plantilla' };

const DTR_LABEL: Record<DtrStatus, string> = {
  NOT_EMPLOYED: 'Not yet hired',
  PRESENT: 'Present',
  LATE: 'Late',
  HALF_DAY: 'Half day',
  OPEN: 'In progress',
  ON_LEAVE: 'On leave',
  REST_DAY: 'Rest day',
  HOLIDAY: 'Holiday',
  ABSENT: 'Absent',
  UPCOMING: 'Upcoming',
};
const DTR_TONES: Record<string, Tone> = {
  NOT_EMPLOYED: '',
  PRESENT: 'ok',
  LATE: 'warn',
  HALF_DAY: 'warn',
  OPEN: 'info',
  ON_LEAVE: 'info',
  REST_DAY: '',
  HOLIDAY: 'info',
  ABSENT: 'danger',
  UPCOMING: '',
};

const minutes = (m: number) => (m > 0 ? durationLabel(m) : '—');
const dash = (v: string | null | undefined) => v || <span className="faint">—</span>;

export function MyRecords() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'attendance';
  const cutoff = params.get('cutoff') ?? '';
  const [data, setData] = useState<Records | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get<Records>(`/my-records${qs({ cutoff })}`));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [cutoff]);
  useEffect(() => {
    load();
  }, [load]);

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  if (error && !data) return <ErrorBox error={error} />;
  if (!data) return <Loading />;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>My Records</h1>
        </div>
      </div>
      <ErrorBox error={error} />
      {data.employee === null ? (
        <Empty title="No employee record on your login" hint="Ask HR to link your login to your employee record — your attendance, leave and 201 file live there." />
      ) : (
        <div className="stack">
          <div className="scope-switch" role="tablist" aria-label="My records">
            {TABS.map((key) => (
              <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => set('tab', key === 'attendance' ? '' : key)}>
                {TAB_LABEL[key]}
              </button>
            ))}
          </div>
          {tab === 'attendance' && <AttendanceTab data={data} onCutoff={(k) => set('cutoff', k)} onFiled={load} />}
          {tab === 'file' && <FileTab file={data.file} />}
          {tab === 'plantilla' && <PlantillaTab p={data.plantilla} />}
        </div>
      )}
    </div>
  );
}

function AttendanceTab({ data, onCutoff, onFiled }: { data: Records; onCutoff: (key: string) => void; onFiled: () => void }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [filing, setFiling] = useState(false);
  // An open day's total runs on while the page is open.
  const [, setTick] = useState(0);
  const anyOpen = data.dtr.days.some((d) => d.open);
  useEffect(() => {
    if (!anyOpen) return undefined;
    const t = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, [anyOpen]);
  const worked = (d: DtrDay) => (d.open && d.timeIn ? Math.max(0, Math.floor((Date.now() - Date.parse(d.timeIn)) / 60_000)) : d.workedMinutes);
  const totalWorked = data.dtr.days.reduce((t, d) => t + worked(d), 0);
  const { cutoff, dtr } = data;

  return (
    <>
      {data.balances.length > 0 && (
        <div className="kpi-grid">
          {data.balances.map((b) => (
            <Stat
              key={b.leaveType.id}
              label={`${b.leaveType.name}${b.leaveType.isPaid ? '' : ' (unpaid)'}`}
              value={`${b.remaining} left`}
              figure
              accent={b.remaining <= 0 ? 'danger' : b.remaining <= 2 ? 'warn' : 'ok'}
              sub={`${b.used} of ${b.entitled + b.carriedOver} days consumed in ${data.year}${b.pending ? ` · ${b.pending} awaiting a decision` : ''}`}
            />
          ))}
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h3 className="card-title">
            Daily time record — {cutoff.label}
            {cutoff.current && <span className="faint"> · current cutoff</span>}
          </h3>
          <div className="row">
            <button type="button" className="btn btn-sm" onClick={() => onCutoff(cutoff.previous)}>
              ← Previous cutoff
            </button>
            {cutoff.next && (
              <button type="button" className="btn btn-sm" onClick={() => onCutoff(cutoff.next ?? '')}>
                Next cutoff →
              </button>
            )}
          </div>
        </div>
        <div className="kpi-grid list-summary">
          <Stat label="Days present" value={dtr.totals.present} />
          <Stat label="Total rendered" value={durationLabel(totalWorked)} figure />
          <Stat label="Late" value={dtr.totals.late} sub={dtr.totals.lateMinutes ? `${durationLabel(dtr.totals.lateMinutes)} in all` : 'never late'} accent={dtr.totals.late ? 'warn' : undefined} />
          <Stat label="Undertime" value={minutes(dtr.totals.undertimeMinutes)} figure />
          <Stat label="Absent" value={dtr.totals.absent} accent={dtr.totals.absent ? 'danger' : undefined} sub={dtr.totals.onLeave ? `${dtr.totals.onLeave} on leave` : undefined} />
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Date</th>
                <th>Time in</th>
                <th>Time out</th>
                <th className="right">Late</th>
                <th className="right">Undertime</th>
                <th className="right">Total rendered</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {dtr.days.map((d) => (
                <tr key={d.date}>
                  <td>
                    <strong>{formatDate(parseDay(d.date))}</strong>
                    <div className="faint">{d.weekday}</div>
                  </td>
                  <td className="mono">{d.timeIn ? formatTime(d.timeIn) : <span className="faint">– : –</span>}</td>
                  <td className="mono">{d.timeOut ? formatTime(d.timeOut) : <span className="faint">– : –</span>}</td>
                  <td className="right mono">{d.lateMinutes ? `${d.lateMinutes} min` : <span className="faint">—</span>}</td>
                  <td className="right mono">{d.undertimeMinutes ? `${d.undertimeMinutes} min` : <span className="faint">—</span>}</td>
                  <td className="right mono">
                    {minutes(worked(d))}
                    {d.open && <div className="faint">so far</div>}
                  </td>
                  <td>
                    <StatusBadge status={d.status} extra={DTR_TONES} label={d.status === 'OPEN' && !d.open ? 'No clock-out' : DTR_LABEL[d.status]} />
                    {d.note && <div className="faint">{d.note}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3 className="card-title">My overtime — {cutoff.label}</h3>
          {can('ghr.overtime.create') && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setFiling(true)}>
              + File overtime
            </button>
          )}
        </div>
        {data.overtime.length === 0 ? (
          <Empty title="No overtime in this cutoff" />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Date</th>
                  <th className="right">Hours</th>
                  <th>Reason / activity</th>
                  <th>Approver</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.overtime.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <Link to={`/g-hr/overtime/${o.id}`}>{formatDate(parseDay(o.date))}</Link>
                      <div className="faint mono">{o.number}</div>
                    </td>
                    <td className="right mono">
                      {o.hours}
                      <div className="faint">{o.actual ? 'actual' : 'planned'} · {o.window}</div>
                    </td>
                    <td>
                      {o.reason}
                      {o.project && <div className="faint">{o.project}</div>}
                    </td>
                    <td>{dash(o.approver)}</td>
                    <td>
                      <StatusBadge status={o.stage} label={o.stageLabel} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {filing && (
        <PriorModal
          onClose={() => setFiling(false)}
          onFiled={(id) => {
            setFiling(false);
            onFiled();
            navigate(`/g-hr/overtime/${id}`);
          }}
        />
      )}
    </>
  );
}

function FileTab({ file }: { file: Records['file'] }) {
  const service = file.service
    ? [file.service.years ? `${file.service.years} year${file.service.years === 1 ? '' : 's'}` : null, `${file.service.months} month${file.service.months === 1 ? '' : 's'}`].filter(Boolean).join(', ')
    : null;
  return (
    <div className="grid grid-2">
      <div className="card">
        <h3 className="card-title">Employment</h3>
        <dl className="kv">
          <dt>Employee no.</dt>
          <dd className="mono">{dash(file.employeeNo)}</dd>
          <dt>Name</dt>
          <dd>{file.name}</dd>
          <dt>Title</dt>
          <dd>{dash(file.title)}</dd>
          <dt>Team</dt>
          <dd>{file.team ? `${file.team.code} — ${file.team.name}` : <span className="faint">—</span>}</dd>
          <dt>Employment</dt>
          <dd>{file.employmentTypeLabel}</dd>
          <dt>Date started</dt>
          <dd>{file.dateHired ? formatDate(parseDay(file.dateHired)) : <span className="faint">—</span>}</dd>
          {file.dateRegularized && (
            <>
              <dt>Regularized</dt>
              <dd>{formatDate(parseDay(file.dateRegularized))}</dd>
            </>
          )}
          <dt>Years in service</dt>
          <dd>{dash(service)}</dd>
        </dl>
      </div>
      <div className="card">
        <h3 className="card-title">Government numbers and tax</h3>
        <dl className="kv">
          <dt>SSS no.</dt>
          <dd className="mono">{dash(file.sssNo)}</dd>
          <dt>Pag-IBIG no.</dt>
          <dd className="mono">{dash(file.pagibigNo)}</dd>
          <dt>PhilHealth no.</dt>
          <dd className="mono">{dash(file.philhealthNo)}</dd>
          <dt>TIN</dt>
          <dd className="mono">{dash(file.tin)}</dd>
          <dt>Tax status</dt>
          <dd>{dash(file.taxStatusLabel)}</dd>
        </dl>
        <p className="faint">Only you and HR see these numbers. A mistake? Tell HR — they keep your 201 file.</p>
      </div>
      <div className="card">
        <h3 className="card-title">Contact and emergency</h3>
        <dl className="kv">
          <dt>Mobile</dt>
          <dd>{dash(file.mobile)}</dd>
          <dt>Address</dt>
          <dd>{dash(file.address)}</dd>
          <dt>Birthday</dt>
          <dd>{file.birthDate ? formatDate(parseDay(file.birthDate)) : <span className="faint">—</span>}</dd>
          <dt>Emergency contact</dt>
          <dd>
            {dash(file.emergencyContactName)}
            {file.emergencyContactPhone && <div className="faint">{file.emergencyContactPhone}</div>}
          </dd>
        </dl>
        <p className="faint">
          Your mobile, address, birthday and emergency contact are yours to keep up to date on <Link to="/account">My Account</Link>.
        </p>
      </div>
    </div>
  );
}

function PlantillaTab({ p }: { p: Records['plantilla'] }) {
  const { can } = useAuth();
  const mayOpen = ['ghr.plantilla.view_all', 'ghr.plantilla.view_team', 'ghr.plantilla.view_own'].some((k) => can(k));
  return (
    <div className="card">
      <div className="card-head">
        <h3 className="card-title">My place on the Plantilla</h3>
        {mayOpen && (
          <Link className="btn btn-sm" to="/g-hr/plantilla">
            View Plantilla →
          </Link>
        )}
      </div>
      <dl className="kv">
        <dt>Title</dt>
        <dd>{dash(p.title)}</dd>
        <dt>Plantilla position</dt>
        <dd>
          {p.position ? (
            <>
              <span className="mono">{p.position.code}</span> {p.position.title}
              {p.position.role && <div className="faint">counts the role {p.position.role}</div>}
            </>
          ) : (
            <span className="faint">not placed on the Plantilla yet</span>
          )}
        </dd>
        {p.alsoHolds.length > 0 && (
          <>
            <dt>Also holds</dt>
            <dd>{p.alsoHolds.map((x) => x.title).join(', ')}</dd>
          </>
        )}
        <dt>Roles</dt>
        <dd>{p.roles.length ? p.roles.map((r) => (r.rank ? `${r.name} (level ${r.rank})` : r.name)).join(', ') : <span className="faint">—</span>}</dd>
        <dt>Team</dt>
        <dd>{p.team ? `${p.team.code} — ${p.team.name}` : <span className="faint">—</span>}</dd>
        <dt>Reports to</dt>
        <dd>
          {p.reportsTo ? p.reportsTo.name : <span className="faint">—</span>}
          {p.reportsTo?.position && <div className="faint">{p.reportsTo.position}</div>}
        </dd>
        <dt>Direct reports</dt>
        <dd>{p.directReports || <span className="faint">none</span>}</dd>
      </dl>
    </div>
  );
}
