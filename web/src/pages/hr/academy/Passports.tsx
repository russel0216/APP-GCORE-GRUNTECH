import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../../lib/api';
import { DataList, type Column } from '../../../components/DataList';
import { Meter, Panel, Stat } from '../../../components/charts';
import { formatDate } from '../../../components/ui';

/**
 * Training Passports — every employee's readiness, for HR (item 13).
 *
 * The figure on this page, the dashboard tile and each passport are the same
 * arithmetic (`readinessFor` / `teamReadiness` in shared/academy.ts), so the
 * register cannot disagree with the passport a row opens. Filters come from
 * DataList and live in the URL, which is what makes the tile's
 * `?state=gaps` link land on the filtered register.
 */

export interface TeamReadiness {
  employees: number;
  ready: number;
  required: number;
  held: number;
  pct: number | null;
  expiring: number;
  expired: number;
  missing: number;
  pendingVerification: number;
  upcomingSessions: number;
}

interface PassportRow {
  id: string;
  employeeNo: string;
  name: string;
  position: string | null;
  department: { id: string; name: string } | null;
  isActive: boolean;
  required: number;
  held: number;
  expiring: number;
  expired: number;
  missing: number;
  pending: number;
  pct: number | null;
}

interface QueueRow {
  id: string;
  number: string | null;
  completedAt: string;
  provider: string | null;
  certificateNo: string | null;
  createdAt: string;
  course: { id: string; code: string; title: string };
  employee: { id: string; employeeNo: string; name: string };
  approvalRequestId: string | null;
}

export function Passports() {
  const navigate = useNavigate();
  const [summary, setSummary] = useState<TeamReadiness | null>(null);
  const [queue, setQueue] = useState<QueueRow[] | null>(null);
  const [departments, setDepartments] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    api.get<TeamReadiness>('/passports/summary').then(setSummary).catch(() => {});
    api.get<QueueRow[]>('/passports/records?status=PENDING_VERIFICATION').then(setQueue).catch(() => setQueue([]));
    api.get<{ id: string; name: string }[]>('/departments').then(setDepartments).catch(() => {});
  }, []);

  const columns: Column<PassportRow>[] = [
    {
      key: 'name',
      label: 'Employee',
      sortKey: 'name',
      render: (r) => (
        <div>
          <div>{r.name}</div>
          <div className="faint">
            <span className="mono">{r.employeeNo}</span>
            {r.isActive ? '' : ' · inactive'}
          </div>
        </div>
      ),
    },
    {
      key: 'position',
      label: 'Position',
      render: (r) => (
        <div>
          <div>{r.position ?? <span className="faint">Unclassified</span>}</div>
          <div className="faint">{r.department?.name ?? 'No department'}</div>
        </div>
      ),
    },
    {
      key: 'pct',
      label: 'Readiness',
      sortKey: 'pct',
      width: '180px',
      render: (r) =>
        r.pct == null ? (
          <span className="faint">Nothing required</span>
        ) : (
          <Meter pct={r.pct} tone={r.pct >= 100 ? undefined : r.pct >= 75 ? 'warn' : 'danger'} />
        ),
    },
    {
      key: 'held',
      label: 'Held',
      sortKey: 'required',
      align: 'right',
      render: (r) => (r.required ? <span className="mono">{r.held}/{r.required}</span> : <span className="faint">—</span>),
    },
    {
      key: 'expiring',
      label: 'Expiring',
      align: 'right',
      render: (r) => (r.expiring ? <span className="mono">{r.expiring}</span> : <span className="faint">0</span>),
    },
    {
      key: 'gaps',
      label: 'Gaps',
      align: 'right',
      render: (r) =>
        r.missing + r.expired ? (
          <span className="mono">
            {r.missing + r.expired}
            <span className="faint"> ({r.missing} missing, {r.expired} expired)</span>
          </span>
        ) : (
          <span className="faint">0</span>
        ),
    },
    {
      key: 'pending',
      label: 'Awaiting HR',
      align: 'right',
      optional: true,
      render: (r) => <span className="mono">{r.pending}</span>,
    },
  ];

  return (
    <div>
      <div className="page-head">
        <h1>Training Passports</h1>
      </div>

      {summary && (
        <div className="kpi-grid">
          <Stat
            label="Company readiness"
            value={summary.pct == null ? '—' : `${summary.pct}%`}
            sub={
              summary.employees
                ? `${summary.held} of ${summary.required} required certificates held`
                : 'no course has a requirement yet'
            }
            accent={summary.pct == null ? 'quiet' : summary.pct >= 100 ? 'ok' : summary.pct >= 75 ? 'warn' : 'danger'}
            icon="book"
          />
          <Stat
            label="Fully ready"
            value={`${summary.ready}/${summary.employees}`}
            sub="people holding every course they need"
            accent="quiet"
            icon="people"
            to="/g-hr/academy/passports?state=ready"
            more="Show them"
          />
          <Stat
            label="Gaps"
            value={summary.missing + summary.expired}
            sub={`${summary.missing} missing · ${summary.expired} expired`}
            accent={summary.missing + summary.expired ? 'danger' : 'quiet'}
            icon="alert"
            to="/g-hr/academy/passports?state=gaps"
            more="Who has gaps"
          />
          <Stat
            label="Expiring"
            value={summary.expiring}
            sub={`${summary.upcomingSessions} session(s) in the next 30 days`}
            accent={summary.expiring ? 'warn' : 'quiet'}
            icon="clock"
            to="/g-hr/academy/passports?state=expiring"
            more="Who needs a refresher"
          />
        </div>
      )}

      {queue && queue.length > 0 && (
        <Panel
          title={`Awaiting verification (${queue.length})`}
          blurb="External certificates employees have filed. Open the passport to see the scan and verify or reject it."
        >
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Course</th>
                  <th>Issued by</th>
                  <th>Completed</th>
                  <th>Filed</th>
                </tr>
              </thead>
              <tbody>
                {queue.map((q) => (
                  <tr key={q.id}>
                    <td>
                      <Link to={`/g-hr/academy/passports/${q.employee.id}`}>{q.employee.name}</Link>
                      <div className="faint mono">{q.number}</div>
                    </td>
                    <td>
                      {q.course.title} <span className="faint mono">{q.course.code}</span>
                    </td>
                    <td>
                      {q.provider ?? '—'}
                      {q.certificateNo && <div className="faint">No. {q.certificateNo}</div>}
                    </td>
                    <td>{formatDate(q.completedAt)}</td>
                    <td>{formatDate(q.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      <DataList<PassportRow>
        listKey="hr-training-passports"
        endpoint="/passports"
        printPath="/api/passports/pdf"
        columns={columns}
        rowKey={(r) => r.id}
        searchPlaceholder="Search name, employee no., position…"
        emptyTitle="Nobody matches"
        emptyHint="Change the filters, or check that employees are linked to departments and plantilla positions."
        onRowClick={(r) => navigate(`/g-hr/academy/passports/${r.id}`)}
        filters={[
          {
            key: 'state',
            label: 'Standing',
            options: [
              { value: 'gaps', label: 'Has gaps' },
              { value: 'expiring', label: 'Something expiring' },
              { value: 'pending', label: 'Awaiting HR' },
              { value: 'ready', label: 'Fully ready' },
              { value: 'none', label: 'Nothing required' },
            ],
          },
          {
            key: 'departmentId',
            label: 'Department',
            options: [{ value: 'none', label: 'No department' }, ...departments.map((d) => ({ value: d.id, label: d.name }))],
          },
          {
            key: 'active',
            label: 'Employees',
            options: [
              { value: 'false', label: 'Inactive' },
              { value: 'all', label: 'Everyone' },
            ],
          },
        ]}
      />
    </div>
  );
}
