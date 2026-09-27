import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, getToken, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import {
  ErrorBox,
  Field,
  Loading,
  Modal,
  formatDateTime,
  useToast,
} from '../../components/ui';
import { Stat } from '../../components/charts';
import { todayLocal } from '../../lib/day';
import { PeopleTiles } from './dashboard/PeopleTiles';
import { ReadinessTile } from './dashboard/ReadinessTile';
import { EvaluationsDuePanel, EvaluationsDueStat } from './dashboard/EvaluationsDuePanel';

/**
 * The HR dashboard — "Attendance dashboard showing Present / Late / On Leave /
 * Absent counts, Pending approvals".
 *
 * Absent is worked out rather than stored: it is every active employee with no
 * attendance row and no approved leave covering the day. Writing an absence
 * row overnight would be wrong the moment somebody clocked in late.
 *
 * Below the day sit the people pieces — plantilla and separations, training
 * readiness, evaluations due. Each reads the endpoint its own screen reads and
 * renders nothing for somebody without the right to it, so this page mounts
 * them without checking permissions itself.
 */

const STATUS_TONE: Record<string, string> = {
  PRESENT: 'ok',
  LATE: 'warn',
  ON_LEAVE: 'info',
  ABSENT: 'danger',
  HALF_DAY: 'warn',
  REST_DAY: '',
};

function label(s: string) {
  return s.toLowerCase().replace(/_/g, ' ');
}

const today = todayLocal;

interface DashboardRow {
  employee: {
    id: string;
    employeeNo: string;
    firstName: string;
    lastName: string;
    position: string | null;
    department: { id: string; name: string } | null;
  };
  status: string;
  timeIn: string | null;
  timeOut: string | null;
  lateMinutes: number;
  workedHours: number;
  method: string | null;
  leaveType: string | null;
}

interface Dashboard {
  date: string;
  headcount: number;
  summary: {
    present: number;
    late: number;
    onLeave: number;
    absent: number;
    halfDay: number;
    pendingApprovals: number;
  };
  rows: DashboardRow[];
}

export function HrDashboard() {
  const { can } = useAuth();
  const openEmployee = can('ghr.employees.view_all');
  const [date, setDate] = useState(today());
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [exporting, setExporting] = useState(false);
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.get<Dashboard>(`/attendance/dashboard${qs({ date })}`));
    } catch (err) {
      setError(err);
    }
  }, [date]);

  useEffect(() => {
    load();
  }, [load]);

  async function exportCsv(from: string, to: string) {
    setExporting(true);
    try {
      const res = await fetch(`/api/attendance/export${qs({ from, to })}`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (!res.ok) throw new Error('The export was refused');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `attendance-${from}-to-${to}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      setRange(null);
      toast('ok', 'Export downloaded');
    } catch (err) {
      setError(err);
    } finally {
      setExporting(false);
    }
  }

  const tiles = data
    ? [
        // Each carries the context that makes the number mean something, and
        // an accent only where a non-zero wants attention. "Present: 12" on
        // its own is a fact; against a headcount it is a judgement.
        {
          label: 'Present',
          icon: 'check' as const,
          more: 'Open attendance',
          value: data.summary.present,
          sub: `of ${data.headcount} active`,
          accent: 'ok' as const,
          to: '/g-hr/attendance',
        },
        {
          label: 'Late',
          icon: 'clock' as const,
          more: 'Open attendance',
          value: data.summary.late,
          sub: data.summary.late > 0 ? 'arrived after the grace period' : 'nobody late today',
          accent: data.summary.late > 0 ? ('warn' as const) : ('quiet' as const),
          to: '/g-hr/attendance?status=LATE',
        },
        {
          label: 'On leave',
          icon: 'calendar' as const,
          more: 'Open leave',
          value: data.summary.onLeave,
          sub: 'approved and away',
          accent: 'info' as const,
          to: '/g-hr/leave?status=APPROVED',
        },
        {
          label: 'Absent',
          icon: 'alert' as const,
          more: 'Open attendance',
          value: data.summary.absent,
          sub: data.summary.absent > 0 ? 'no clock-in, no approved leave' : 'everybody accounted for',
          accent: data.summary.absent > 0 ? ('danger' as const) : ('quiet' as const),
          to: '/g-hr/attendance',
        },
        {
          label: 'Pending approvals',
          icon: 'document' as const,
          more: 'Open leave',
          value: data.summary.pendingApprovals,
          sub:
            data.summary.pendingApprovals > 0
              ? 'leave, overtime and evaluations waiting'
              : 'queue is clear',
          accent: data.summary.pendingApprovals > 0 ? ('warn' as const) : ('quiet' as const),
          to: '/g-hr/leave?status=PENDING_APPROVAL',
        },
      ]
    : [];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>HR Dashboard</h1>
          <p>
            Who is in, who is late, who is on leave and who has not appeared — for one day at a
            time. Absence is inferred from the other three, so it corrects itself the moment
            somebody clocks in. Below the day: the plantilla, who is due an evaluation, how
            ready the team is, and who is on the way out.
          </p>
        </div>
        <div className="row">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <button className="btn btn-sm" onClick={() => setDate(today())}>
            Today
          </button>
          <button
            className="btn btn-sm"
            onClick={() => setRange({ from: date, to: date })}
            disabled={exporting}
          >
            Extract CSV…
          </button>
        </div>
      </div>

      <ErrorBox error={error} />

      {!data ? (
        <Loading label="Counting heads…" />
      ) : (
        <>
          <div className="kpi-grid">
            {tiles.map((t) => (
              <Stat
                key={t.label}
                label={t.label}
                value={t.value}
                sub={t.sub}
                accent={t.accent}
                icon={t.icon}
                more={t.more}
                to={t.to}
              />
            ))}
          </div>

          <PeopleTiles />

          <div className="kpi-grid">
            <ReadinessTile />
            <EvaluationsDueStat />
          </div>

          <div className="card">
            <h3 className="card-title">
              {data.headcount} active employee{data.headcount === 1 ? '' : 's'}
            </h3>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Department</th>
                    <th>In</th>
                    <th>Out</th>
                    <th className="right">Late</th>
                    <th className="right">Hours</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.employee.id}>
                      <td>
                        <div>
                          {openEmployee ? (
                            <Link to={`/g-hr/employees/${r.employee.id}`}>
                              {r.employee.lastName}, {r.employee.firstName}
                            </Link>
                          ) : (
                            <>
                              {r.employee.lastName}, {r.employee.firstName}
                            </>
                          )}
                        </div>
                        <div className="faint">
                          {r.employee.employeeNo}
                          {r.employee.position ? ` · ${r.employee.position}` : ''}
                        </div>
                      </td>
                      <td className="faint">{r.employee.department?.name ?? '—'}</td>
                      <td className="mono">
                        {r.timeIn
                          ? new Date(r.timeIn).toLocaleTimeString('en-PH', {
                              hour12: false,
                              hour: '2-digit',
                              minute: '2-digit',
                            })
                          : '—'}
                        {r.method && r.method !== 'FACE' && (
                          <span className="faint"> ({r.method.toLowerCase()})</span>
                        )}
                      </td>
                      <td className="mono">
                        {r.timeOut
                          ? new Date(r.timeOut).toLocaleTimeString('en-PH', {
                              hour12: false,
                              hour: '2-digit',
                              minute: '2-digit',
                            })
                          : '—'}
                      </td>
                      <td className="right mono">
                        {r.lateMinutes > 0 ? <span className="warn">{r.lateMinutes}m</span> : '—'}
                      </td>
                      <td className="right mono">{r.workedHours ? r.workedHours.toFixed(2) : '—'}</td>
                      <td>
                        <span className={`badge ${STATUS_TONE[r.status] ?? ''}`}>
                          {r.leaveType ?? label(r.status)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <EvaluationsDuePanel />
        </>
      )}

      {range && (
        <Modal
          title="Extract attendance"
          onClose={() => setRange(null)}
          footer={
            <>
              <button className="btn" onClick={() => setRange(null)} disabled={exporting}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={() => exportCsv(range.from, range.to)}
                disabled={exporting || !range.from || !range.to || range.to < range.from}
              >
                {exporting ? 'Building…' : 'Download CSV'}
              </button>
            </>
          }
        >
          <p className="muted">
            One row per attendance record, with the method used and any fallback reason — the
            columns a payroll run needs.
          </p>
          <div className="grid grid-2">
            <Field label="From">
              <input
                type="date"
                value={range.from}
                onChange={(e) => setRange({ ...range, from: e.target.value })}
              />
            </Field>
            <Field label="To">
              <input
                type="date"
                value={range.to}
                onChange={(e) => setRange({ ...range, to: e.target.value })}
              />
            </Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── The attendance register ──────────────────────────────────────────────────

interface AttendanceRow {
  id: string;
  date: string;
  timeIn: string | null;
  timeOut: string | null;
  status: string;
  lateMinutes: number;
  workedHours: number;
  timeInMethod: string | null;
  notes: string | null;
  employee: {
    id: string;
    employeeNo: string;
    firstName: string;
    lastName: string;
    position: string | null;
    department: { name: string } | null;
  };
}

export function AttendanceRegister() {
  const { can } = useAuth();
  const [editing, setEditing] = useState<AttendanceRow | null>(null);
  const [reload, setReload] = useState(0);

  const columns: Column<AttendanceRow>[] = [
    {
      key: 'date',
      label: 'Date',
      sortKey: 'date',
      width: '120px',
      render: (r) => <span className="mono">{r.date.slice(0, 10)}</span>,
    },
    {
      key: 'employee',
      label: 'Employee',
      render: (r) => (
        <div>
          <div>
            {r.employee.lastName}, {r.employee.firstName}
          </div>
          <div className="faint">
            {r.employee.employeeNo}
            {r.employee.department ? ` · ${r.employee.department.name}` : ''}
          </div>
        </div>
      ),
    },
    {
      key: 'timeIn',
      label: 'In',
      sortKey: 'timeIn',
      render: (r) => <span className="mono">{formatDateTime(r.timeIn)}</span>,
    },
    { key: 'timeOut', label: 'Out', render: (r) => <span className="mono">{formatDateTime(r.timeOut)}</span> },
    {
      key: 'lateMinutes',
      label: 'Late',
      align: 'right',
      render: (r) => (r.lateMinutes > 0 ? <span className="mono warn">{r.lateMinutes}m</span> : <span className="faint">—</span>),
    },
    {
      key: 'workedHours',
      label: 'Hours',
      align: 'right',
      render: (r) => <span className="mono">{r.workedHours.toFixed(2)}</span>,
    },
    {
      key: 'method',
      label: 'Identified by',
      optional: true,
      render: (r) =>
        r.timeInMethod === 'FACE' ? (
          <span className="faint">face</span>
        ) : (
          <span className="badge warn" title={r.notes ?? undefined}>
            {r.timeInMethod?.toLowerCase() ?? '—'}
          </span>
        ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (r) => <span className={`badge ${STATUS_TONE[r.status] ?? ''}`}>{label(r.status)}</span>,
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Attendance</h1>
          <p>
            Every clock entry, with how the person was identified. A fallback entry carries its
            reason — hover the badge. Corrections are recorded as manual, against whoever made
            them.
          </p>
        </div>
      </div>

      <DataList<AttendanceRow>
        listKey="attendance"
        endpoint="/attendance"
        columns={columns}
        rowKey={(r) => r.id}
        reloadToken={reload}
        searchPlaceholder="Search employee name or number…"
        onRowClick={can('ghr.employees.edit_all') ? (r) => setEditing(r) : undefined}
        emptyTitle="No attendance recorded for this range"
        filters={[
          {
            key: 'status',
            label: 'Status',
            options: [
              { value: 'PRESENT', label: 'Present' },
              { value: 'LATE', label: 'Late' },
              { value: 'HALF_DAY', label: 'Half day' },
              { value: 'ON_LEAVE', label: 'On leave' },
              { value: 'ABSENT', label: 'Absent' },
              { value: 'REST_DAY', label: 'Rest day' },
            ],
          },
        ]}
      />

      {editing && (
        <CorrectionModal
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setReload((r) => r + 1);
          }}
        />
      )}
    </div>
  );
}

function CorrectionModal({
  row,
  onClose,
  onSaved,
}: {
  row: AttendanceRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  /** A datetime-local value for an ISO instant, in the browser's own zone. */
  const local = (iso: string | null) => {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const [form, setForm] = useState({
    timeIn: local(row.timeIn),
    timeOut: local(row.timeOut),
    status: row.status,
    notes: row.notes ?? '',
  });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/attendance/${row.id}`, {
        timeIn: form.timeIn ? new Date(form.timeIn).toISOString() : null,
        timeOut: form.timeOut ? new Date(form.timeOut).toISOString() : null,
        status: form.status,
        notes: form.notes || null,
      });
      toast('ok', 'Attendance corrected');
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Correct ${row.employee.firstName} ${row.employee.lastName} — ${row.date.slice(0, 10)}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save correction'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <div className="alert info">
        A correction is stamped as manual and recorded against you in the audit log. Lateness is
        recalculated from the new time in — unless you set a status yourself, which wins.
      </div>

      <div className="grid grid-2">
        <Field label="Time in">
          <input
            type="datetime-local"
            value={form.timeIn}
            onChange={(e) => setForm({ ...form, timeIn: e.target.value })}
          />
        </Field>
        <Field label="Time out">
          <input
            type="datetime-local"
            value={form.timeOut}
            onChange={(e) => setForm({ ...form, timeOut: e.target.value })}
          />
        </Field>
      </div>

      <Field label="Status">
        <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
          <option value="PRESENT">Present</option>
          <option value="LATE">Late</option>
          <option value="HALF_DAY">Half day</option>
          <option value="ON_LEAVE">On leave</option>
          <option value="ABSENT">Absent</option>
          <option value="REST_DAY">Rest day</option>
        </select>
      </Field>

      <Field label="Note" hint="Why the correction was needed — this is what an audit reads">
        <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </Field>
    </Modal>
  );
}
