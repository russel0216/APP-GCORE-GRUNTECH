import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, openPdf, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import { Meter, Stat } from '../../components/charts';
import { RecordHeader } from '../../components/RecordHeader';
import { DocumentApproval } from '../../components/ApprovalStepper';
import { Attachments } from '../../components/Attachments';
import {
  Empty,
  ErrorBox,
  Field,
  Loading,
  Modal,
  StatusBadge,
  formatDate,
  formatDateTime,
  humanise,
  useToast,
  type Tone,
} from '../../components/ui';

/**
 * Turnover & Clearance.
 *
 * What a leaver still holds — tools on borrow slips, unpaid claims, projects
 * and people assigned to them — cleared by the area that owns each item and
 * signed off by their supervisor, finance and HR through the approval engine.
 * An item that points at a record takes its status from that record; nobody
 * can tick "tools returned" while G-CHAIN still says the slip is out.
 *
 * The register opens with the twelve-month turnover figures so the menu
 * label is true; the full report is the Turnover tab of HR Reports.
 */

export const REASONS = [
  { value: 'RESIGNATION', label: 'Resignation' },
  { value: 'END_OF_CONTRACT', label: 'End of contract' },
  { value: 'END_OF_PROJECT', label: 'End of project' },
  { value: 'TERMINATION', label: 'Termination' },
  { value: 'RETIREMENT', label: 'Retirement' },
  { value: 'AWOL', label: 'AWOL' },
  { value: 'OTHER', label: 'Other' },
];

const STATUSES = [
  { value: 'OPEN', label: 'Open' },
  { value: 'PENDING_APPROVAL', label: 'Pending approval' },
  { value: 'CLEARED', label: 'Cleared' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

/** The document's own statuses — OPEN is work in hand, CLEARED is settled well. */
export const CLEARANCE_TONES: Record<string, Tone> = { OPEN: 'info', CLEARED: 'ok' };
const ITEM_TONES: Record<string, Tone> = { PENDING: 'warn', CLEARED: 'ok', WAIVED: 'info' };

const reasonLabel = (r: string) => REASONS.find((x) => x.value === r)?.label ?? humanise(r);

export interface ClearanceSummary {
  open: number;
  pendingApproval: number;
  separations12m: number;
  hires12m: number;
  turnover12mPct: number;
  annualisedPct: number;
  tooEarly: boolean;
}

interface ClearanceRow {
  id: string;
  number: string;
  status: string;
  reason: string;
  lastWorkingDay: string;
  submittedAt: string | null;
  clearedAt: string | null;
  createdAt: string;
  employee: {
    id: string;
    employeeNo: string;
    firstName: string;
    lastName: string;
    position: string | null;
    department: { id: string; name: string } | null;
  };
  raisedBy: { id: string; name: string };
  items: { total: number; cleared: number; waived: number; pending: number };
}

// ════════════════════════════════════════════════════════════════════
//  REGISTER
// ════════════════════════════════════════════════════════════════════

export function Clearances() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [raising, setRaising] = useState(false);
  const [departments, setDepartments] = useState<{ id: string; name: string }[]>([]);
  const [summary, setSummary] = useState<ClearanceSummary | null>(null);

  const seesAll = can('ghr.clearances.view_all');

  useEffect(() => {
    if (!seesAll) return;
    api.get<{ id: string; name: string }[]>('/departments').then(setDepartments).catch(() => {});
    api.get<ClearanceSummary>('/clearances/summary').then(setSummary).catch(() => {});
  }, [seesAll]);

  const columns: Column<ClearanceRow>[] = [
    {
      key: 'number',
      label: 'Number',
      sortKey: 'number',
      render: (c) => (
        <Link to={`/g-hr/clearances/${c.id}`} className="mono">
          {c.number}
        </Link>
      ),
    },
    {
      key: 'employee',
      label: 'Employee',
      render: (c) => (
        <div>
          <div>
            {c.employee.lastName}, {c.employee.firstName}
          </div>
          <div className="faint">
            <span className="mono">{c.employee.employeeNo}</span>
            {c.employee.position ? ` · ${c.employee.position}` : ''}
          </div>
        </div>
      ),
    },
    { key: 'department', label: 'Department', render: (c) => c.employee.department?.name ?? '—' },
    { key: 'reason', label: 'Reason', render: (c) => reasonLabel(c.reason) },
    {
      key: 'lastWorkingDay',
      label: 'Last day',
      sortKey: 'lastWorkingDay',
      render: (c) => formatDate(c.lastWorkingDay),
    },
    {
      key: 'progress',
      label: 'Progress',
      render: (c) => {
        const done = c.items.cleared + c.items.waived;
        return (
          <div className="clearance-progress">
            <Meter
              pct={c.items.total ? (done / c.items.total) * 100 : 0}
              tone={c.items.pending > 0 ? 'warn' : undefined}
            />
            <span className="mono">
              {done}/{c.items.total}
            </span>
          </div>
        );
      },
    },
    {
      key: 'createdAt',
      label: 'Raised',
      sortKey: 'createdAt',
      optional: true,
      render: (c) => (
        <div>
          {formatDate(c.createdAt)}
          <div className="faint">{c.raisedBy.name}</div>
        </div>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      sortKey: 'status',
      render: (c) => <StatusBadge status={c.status} extra={CLEARANCE_TONES} />,
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Turnover &amp; Clearance</h1>
          <p>
            What a leaver still holds — tools on borrow slips, unpaid claims, projects and people
            assigned to them — cleared by the area that owns each item and signed off by their
            supervisor, finance and HR. Items that point at a record take their status from that
            record.
          </p>
        </div>
      </div>

      {seesAll && summary && <TurnoverStrip summary={summary} />}

      <DataList<ClearanceRow>
        listKey="clearances"
        endpoint="/clearances"
        columns={columns}
        rowKey={(c) => c.id}
        scoped={seesAll}
        searchPlaceholder="Search number, name or employee number…"
        onRowClick={(c) => navigate(`/g-hr/clearances/${c.id}`)}
        emptyTitle="No clearances"
        emptyHint="A clearance is raised when someone is leaving — by them, for a resignation, or by HR."
        filters={[
          { key: 'status', label: 'Status', options: STATUSES },
          { key: 'reason', label: 'Reason', options: REASONS },
          ...(seesAll
            ? [
                {
                  key: 'departmentId',
                  label: 'Department',
                  options: departments.map((d) => ({ value: d.id, label: d.name })),
                },
              ]
            : []),
        ]}
        actions={
          can('ghr.clearances.create') && (
            <button className="btn btn-primary btn-sm" onClick={() => setRaising(true)}>
              + Raise clearance
            </button>
          )
        }
      />

      {raising && (
        <RaiseModal
          onClose={() => setRaising(false)}
          onRaised={(id) => {
            setRaising(false);
            navigate(`/g-hr/clearances/${id}`);
          }}
        />
      )}
    </div>
  );
}

/** Twelve months of hires and separations — why the label says Turnover. */
function TurnoverStrip({ summary }: { summary: ClearanceSummary }) {
  const { can } = useAuth();
  const report = can('ghr.reports.view_all') ? '/g-hr/reports?tab=turnover' : undefined;
  return (
    <div className="kpi-grid">
      <Stat
        label="Separations, 12 months"
        value={summary.separations12m}
        sub={`${summary.hires12m} hired in the same months`}
        icon="people"
        accent="quiet"
        to={report}
        more={report ? 'Turnover report' : undefined}
      />
      <Stat
        label="Turnover, 12 months"
        value={`${summary.turnover12mPct}%`}
        sub={
          summary.tooEarly
            ? 'average headcount under 5 — one leaver moves this a lot'
            : `separations ÷ average headcount · annualised ${summary.annualisedPct}%`
        }
        icon="chart"
        accent={summary.annualisedPct > 20 && !summary.tooEarly ? 'warn' : 'quiet'}
        to={report}
        more={report ? 'By month and reason' : undefined}
      />
      <Stat
        label="Clearances open"
        value={summary.open}
        sub={summary.open > 0 ? 'leavers with items outstanding' : 'nobody clearing out'}
        icon="document"
        accent={summary.open > 0 ? 'warn' : 'quiet'}
        to="/g-hr/clearances?status=OPEN"
        more="Open them"
      />
      <Stat
        label="Awaiting sign-off"
        value={summary.pendingApproval}
        sub="with the supervisor, finance or HR"
        icon="check"
        accent={summary.pendingApproval > 0 ? 'info' : 'quiet'}
        to="/g-hr/clearances?status=PENDING_APPROVAL"
        more="Show them"
      />
    </div>
  );
}

// ── Raise ────────────────────────────────────────────────────────────────────

interface EmployeeLookup {
  id: string;
  employeeNo: string;
  firstName: string;
  lastName: string;
  position: string | null;
  department: { id: string; name: string } | null;
  hasUser: boolean;
}

interface UserLookup {
  id: string;
  name: string;
  email: string;
  position: string | null;
  department: { id: string; name: string } | null;
}

function useUsers(): UserLookup[] {
  const [users, setUsers] = useState<UserLookup[]>([]);
  useEffect(() => {
    api.get<UserLookup[]>('/users/lookup').then(setUsers).catch(() => {});
  }, []);
  return users;
}

function RaiseModal({ onClose, onRaised }: { onClose: () => void; onRaised: (id: string) => void }) {
  const { can } = useAuth();
  const toast = useToast();
  // Someone who may only raise their own — a resignation — does not choose.
  const forSelf = !can('ghr.clearances.view_all') && !can('ghr.clearances.edit_all');
  const users = useUsers();

  const [term, setTerm] = useState('');
  const [found, setFound] = useState<EmployeeLookup[]>([]);
  const [self, setSelf] = useState<{ employee: EmployeeLookup | null; open: { id: string; number: string } | null } | null>(
    null,
  );
  const [form, setForm] = useState({
    employeeId: '',
    reason: 'RESIGNATION',
    lastWorkingDay: '',
    handedOverToId: '',
    notes: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!forSelf) return;
    api
      .get<{ employee: EmployeeLookup | null; open: { id: string; number: string } | null }>('/clearances/me')
      .then((r) => {
        setSelf(r);
        if (r.employee) setForm((f) => ({ ...f, employeeId: r.employee!.id }));
      })
      .catch(setError);
  }, [forSelf]);

  // The lookup returns fifty; typing narrows it on the server.
  useEffect(() => {
    if (forSelf) return;
    const t = setTimeout(() => {
      api
        .get<EmployeeLookup[]>(`/employees/lookup${qs({ q: term || undefined, active: 'true' })}`)
        .then(setFound)
        .catch(setError);
    }, 250);
    return () => clearTimeout(t);
  }, [term, forSelf]);

  async function raise() {
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<{ id: string; number: string }>('/clearances', {
        employeeId: form.employeeId,
        reason: form.reason,
        lastWorkingDay: form.lastWorkingDay,
        handedOverToId: form.handedOverToId || null,
        notes: form.notes.trim() || null,
      });
      toast('ok', `Clearance ${created.number} raised`);
      onRaised(created.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const chosen = found.find((e) => e.id === form.employeeId);

  return (
    <Modal
      title="Raise a clearance"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={raise}
            disabled={busy || !form.employeeId || !form.lastWorkingDay || Boolean(self?.open)}
          >
            {busy ? 'Raising…' : 'Raise clearance'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <p className="muted">
        The checklist is built for you: company property from HR Settings, plus everything the
        records still hold against this person — borrow slips, unpaid claims, pending filings,
        projects, and the people who report to them.
      </p>

      {forSelf ? (
        self === null ? (
          <Loading />
        ) : !self.employee ? (
          <div className="alert warn">
            Your login is not linked to an employee record, so there is nothing to clear. HR can
            raise it for you.
          </div>
        ) : self.open ? (
          <div className="alert info">
            You already have clearance{' '}
            <Link to={`/g-hr/clearances/${self.open.id}`} className="mono">
              {self.open.number}
            </Link>{' '}
            in progress.
          </div>
        ) : (
          <Field label="Employee">
            <input
              readOnly
              value={`${self.employee.firstName} ${self.employee.lastName} · ${self.employee.employeeNo}`}
            />
          </Field>
        )
      ) : (
        <div className="grid grid-2">
          <Field label="Find the employee" hint="Name or employee number">
            <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search…" />
          </Field>
          <Field label="Employee" required>
            <select value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })}>
              <option value="">— pick —</option>
              {found.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.lastName}, {e.firstName} · {e.employeeNo}
                  {e.department ? ` · ${e.department.name}` : ''}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}

      {chosen && !chosen.hasUser && (
        <div className="alert info">
          {chosen.firstName} has no login, so the sign-off routes from you: step one goes to your
          own supervisor. Borrow slips are matched by name.
        </div>
      )}

      <div className="grid grid-2">
        <Field label="Reason" required>
          <select value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })}>
            {REASONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Last working day" required>
          <input
            type="date"
            value={form.lastWorkingDay}
            onChange={(e) => setForm({ ...form, lastWorkingDay: e.target.value })}
          />
        </Field>
        <Field label="Hand over to" hint="Prints as “Received by” on the form">
          <select value={form.handedOverToId} onChange={(e) => setForm({ ...form, handedOverToId: e.target.value })}>
            <option value="">— nobody named —</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
                {u.position ? ` · ${u.position}` : ''}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="Notes">
        <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </Field>
    </Modal>
  );
}

// ════════════════════════════════════════════════════════════════════
//  DETAIL
// ════════════════════════════════════════════════════════════════════

type Area = 'SUPERVISOR' | 'WAREHOUSE' | 'FINANCE' | 'HR' | 'ADMIN';

interface AreaDef {
  key: Area;
  label: string;
  blurb: string;
}

interface Item {
  id: string;
  area: Area;
  sortOrder: number;
  description: string;
  sourceType: string | null;
  sourceId: string | null;
  link: string | null;
  status: 'PENDING' | 'CLEARED' | 'WAIVED';
  clearedBy: { id: string; name: string } | null;
  clearedAt: string | null;
  remarks: string | null;
  derived: boolean;
}

interface ClearanceDetailData {
  id: string;
  number: string;
  status: string;
  reason: string;
  reasonLabel: string;
  lastWorkingDay: string;
  notes: string | null;
  submittedAt: string | null;
  clearedAt: string | null;
  createdAt: string;
  raisedById: string;
  handedOverToId: string | null;
  employee: {
    id: string;
    employeeNo: string;
    firstName: string;
    lastName: string;
    position: string | null;
    employmentType: string;
    dateHired: string | null;
    userId: string | null;
    department: { id: string; name: string } | null;
    user: { id: string; name: string; isActive: boolean; supervisor: { id: string; name: string } | null } | null;
  };
  raisedBy: { id: string; name: string; position: string | null };
  handedOverTo: { id: string; name: string; position: string | null } | null;
  items: Item[];
  byArea: Record<Area, { total: number; pending: number; cleared: number; waived: number }>;
  canClear: Record<Area, boolean>;
  readyToSubmit: boolean;
  canEdit: boolean;
  canManageItems: boolean;
  canCancel: boolean;
  leaveRemaining: { type: string; remaining: number }[];
  tenure: string;
}

export function ClearanceDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const toast = useToast();
  const [data, setData] = useState<ClearanceDetailData | null>(null);
  const [areas, setAreas] = useState<AreaDef[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [waiving, setWaiving] = useState<Item | null>(null);
  const [adding, setAdding] = useState<Area | null>(null);
  const [editing, setEditing] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setData(await api.get<ClearanceDetailData>(`/clearances/${id}`));
      setReload((n) => n + 1);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api.get<AreaDef[]>('/clearances/areas').then(setAreas).catch(() => {});
  }, []);

  if (loading) return <Loading />;
  if (!data) return <ErrorBox error={error ?? new Error('Clearance not found')} />;

  const c = data;
  const done = c.items.filter((i) => i.status !== 'PENDING').length;
  const pending = c.items.length - done;
  const editable = c.status === 'OPEN' || c.status === 'REJECTED';

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      toast('ok', label);
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const name = `${c.employee.firstName} ${c.employee.lastName}`;

  return (
    <div>
      <div className="breadcrumb">
        <Link to="/g-hr/clearances">Turnover &amp; Clearance</Link>
        <span className="sep">›</span>
        <span className="mono">{c.number}</span>
      </div>

      <RecordHeader
        type="Employee Clearance"
        code={c.number}
        title={`${name} — ${c.reasonLabel}`}
        status={c.status}
        statusExtra={CLEARANCE_TONES}
        amount={`${done}/${c.items.length}`}
        amountLabel="Items cleared"
        actions={
          <>
            <button
              className="btn"
              onClick={() => openPdf(`/api/clearances/${c.id}/pdf`, () => toast('error', 'Could not print'))}
            >
              Print
            </button>
            {c.canEdit && (
              <button className="btn" onClick={() => setEditing(true)} disabled={busy}>
                Modify
              </button>
            )}
            {c.canEdit && (
              <button
                className="btn btn-ok"
                disabled={busy || !c.readyToSubmit}
                title={c.readyToSubmit ? undefined : `${pending} item(s) still pending`}
                onClick={() => run('Submitted for sign-off', () => api.post(`/clearances/${c.id}/submit`))}
              >
                Submit for sign-off
              </button>
            )}
            {c.canCancel && (
              <button className="btn btn-danger" onClick={() => setCancelling(true)} disabled={busy}>
                Cancel clearance
              </button>
            )}
          </>
        }
      />

      <p className="record-head-meta">
        Raised by {c.raisedBy.name} on {formatDate(c.createdAt)}
        {c.submittedAt ? ` · submitted ${formatDate(c.submittedAt)}` : ''}
        {c.clearedAt ? ` · cleared ${formatDate(c.clearedAt)}` : ''}
      </p>

      <DocumentApproval documentType="clearance" documentId={c.id} reloadToken={reload} />

      <ErrorBox error={error} />

      {c.status === 'PENDING_APPROVAL' && (
        <div className="alert info">
          With the sign-off chain — supervisor, finance, then HR. Nothing can be cleared or changed
          until they decide.
        </div>
      )}
      {c.status === 'REJECTED' && (
        <div className="alert warn">
          Sent back. Fix what the approver asked for, then submit it again.
        </div>
      )}
      {c.status === 'CLEARED' && (
        <div className="alert ok">
          Cleared — the separation is recorded for {formatDate(c.lastWorkingDay)}.
          {c.employee.user?.isActive === false ? ' The login is closed.' : ''}
        </div>
      )}
      {editable && pending > 0 && (
        <div className="alert warn">
          {pending} item(s) still pending. Items linked to a record clear themselves when the record
          settles; the rest are cleared by the area that owns them.
        </div>
      )}

      <div className="clearance-layout">
        <section className="card">
          <h3 className="card-title">Person</h3>
          <dl className="kv">
            <dt>Employee no.</dt>
            <dd className="mono">
              {can('ghr.employees.view_all') ? (
                <Link to={`/g-hr/employees/${c.employee.id}`}>{c.employee.employeeNo}</Link>
              ) : (
                c.employee.employeeNo
              )}
            </dd>
            <dt>Position</dt>
            <dd>{c.employee.position ?? '—'}</dd>
            <dt>Department</dt>
            <dd>{c.employee.department?.name ?? '—'}</dd>
            <dt>Employment</dt>
            <dd>{humanise(c.employee.employmentType)}</dd>
            <dt>Hired</dt>
            <dd>{formatDate(c.employee.dateHired)}</dd>
            <dt>Tenure</dt>
            <dd>{c.tenure}</dd>
            <dt>Last working day</dt>
            <dd>{formatDate(c.lastWorkingDay)}</dd>
            <dt>Supervisor</dt>
            <dd>
              {c.employee.user ? (
                (c.employee.user.supervisor?.name ?? <span className="faint">none — HR signs step one</span>)
              ) : (
                <span className="faint">no login — step one goes to the raiser&rsquo;s supervisor</span>
              )}
            </dd>
            <dt>Login</dt>
            <dd>
              {c.employee.user ? (
                c.employee.user.isActive ? (
                  'Active'
                ) : (
                  'Closed'
                )
              ) : (
                <span className="faint">no login</span>
              )}
            </dd>
            <dt>Handed over to</dt>
            <dd>{c.handedOverTo?.name ?? '—'}</dd>
            <dt>Unused leave</dt>
            <dd>
              {c.leaveRemaining.every((l) => l.remaining <= 0)
                ? 'none'
                : c.leaveRemaining
                    .filter((l) => l.remaining > 0)
                    .map((l) => `${l.type} ${l.remaining}`)
                    .join(' · ')}
            </dd>
          </dl>
          {c.notes && (
            <>
              <div className="section-label">Notes</div>
              <p className="clearance-notes">{c.notes}</p>
            </>
          )}
        </section>

        <div className="clearance-areas">
          {areas.map((area) => {
            const rows = c.items.filter((i) => i.area === area.key);
            const counts = c.byArea[area.key];
            const mayAct = editable && c.canClear[area.key];
            return (
              <section className="card" key={area.key}>
                <div className="panel-head">
                  <h3 className="card-title">
                    {area.label}{' '}
                    <span className="faint mono">
                      {counts ? counts.total - counts.pending : 0}/{counts?.total ?? 0}
                    </span>
                  </h3>
                  {c.canManageItems && (
                    <button className="btn btn-sm" onClick={() => setAdding(area.key)} disabled={busy}>
                      + Add item
                    </button>
                  )}
                </div>
                <p className="panel-blurb">{area.blurb}</p>
                {rows.length === 0 ? (
                  <Empty title="Nothing to clear here" />
                ) : (
                  <div className="table-wrap">
                    <table className="data">
                      <thead>
                        <tr>
                          <th>Item</th>
                          <th>Status</th>
                          <th>Cleared by</th>
                          <th>Remarks</th>
                          {(mayAct || c.canManageItems) && <th className="right">Action</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((item) => (
                          <tr key={item.id}>
                            <td>
                              {item.link ? <Link to={item.link}>{item.description}</Link> : item.description}
                              {item.derived && <div className="faint">cleared from the record</div>}
                            </td>
                            <td>
                              <StatusBadge status={item.status} extra={ITEM_TONES} />
                            </td>
                            <td>
                              {item.status === 'PENDING' ? (
                                '—'
                              ) : (
                                <>
                                  {item.clearedBy?.name ?? (item.derived ? 'The record' : '—')}
                                  <div className="faint">{formatDateTime(item.clearedAt)}</div>
                                </>
                              )}
                            </td>
                            <td>{item.remarks ?? ''}</td>
                            {(mayAct || c.canManageItems) && (
                              <td className="right">
                                <div className="clearance-actions">
                                  {mayAct && item.status === 'PENDING' && !item.derived && (
                                    <button
                                      className="btn btn-sm btn-ok"
                                      disabled={busy}
                                      onClick={() =>
                                        run('Cleared', () => api.post(`/clearances/${c.id}/items/${item.id}/clear`, {}))
                                      }
                                    >
                                      Clear
                                    </button>
                                  )}
                                  {mayAct && item.status !== 'WAIVED' && (
                                    <button className="btn btn-sm" disabled={busy} onClick={() => setWaiving(item)}>
                                      Waive…
                                    </button>
                                  )}
                                  {c.canManageItems && item.status !== 'PENDING' && (
                                    <button
                                      className="btn btn-sm"
                                      disabled={busy}
                                      onClick={() =>
                                        run('Reopened', () => api.post(`/clearances/${c.id}/items/${item.id}/reopen`, {}))
                                      }
                                    >
                                      Reopen
                                    </button>
                                  )}
                                  {c.canManageItems && item.status === 'PENDING' && !item.derived && (
                                    <button
                                      className="btn btn-sm btn-ghost"
                                      disabled={busy}
                                      aria-label={`Remove ${item.description}`}
                                      onClick={() =>
                                        run('Removed', () => api.del(`/clearances/${c.id}/items/${item.id}`))
                                      }
                                    >
                                      Remove
                                    </button>
                                  )}
                                </div>
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </div>

      <Attachments
        entityType="clearance"
        entityId={c.id}
        hint="The signed paper form, a resignation letter, a receipt for returned property."
      />

      {waiving && (
        <WaiveModal
          item={waiving}
          onClose={() => setWaiving(null)}
          onWaive={async (reason) => {
            await api.post(`/clearances/${c.id}/items/${waiving.id}/waive`, { reason });
            setWaiving(null);
            toast('ok', 'Waived');
            await load();
          }}
        />
      )}
      {adding && (
        <AddItemModal
          area={adding}
          areaLabel={areas.find((a) => a.key === adding)?.label ?? humanise(adding)}
          existing={c.items.filter((i) => i.area === adding).map((i) => i.description)}
          onClose={() => setAdding(null)}
          onAdd={async (description) => {
            await api.post(`/clearances/${c.id}/items`, { area: adding, description });
            setAdding(null);
            toast('ok', 'Item added');
            await load();
          }}
        />
      )}
      {editing && (
        <EditModal
          clearance={c}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            toast('ok', 'Saved');
            await load();
          }}
        />
      )}
      {cancelling && (
        <CancelModal
          number={c.number}
          onClose={() => setCancelling(false)}
          onCancel={async (reason) => {
            await api.post(`/clearances/${c.id}/cancel`, { reason: reason || null });
            setCancelling(false);
            toast('ok', 'Clearance cancelled');
            await load();
          }}
        />
      )}
    </div>
  );
}

/** A waiver is a written decision — the button stays off until there is one. */
function WaiveModal({
  item,
  onClose,
  onWaive,
}: {
  item: Item;
  onClose: () => void;
  onWaive: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const ok = reason.trim().length >= 5;
  return (
    <Modal
      title="Waive this item"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !ok}
            onClick={async () => {
              setBusy(true);
              try {
                await onWaive(reason.trim());
              } catch (err) {
                setError(err);
                setBusy(false);
              }
            }}
          >
            Waive
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <p>{item.description}</p>
      <Field
        label="Reason"
        required
        hint="Prints on the form beside the item — for example “Lost drill charged to final pay”."
      >
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Modal>
  );
}

function AddItemModal({
  areaLabel,
  existing,
  onClose,
  onAdd,
}: {
  area: Area;
  areaLabel: string;
  existing: string[];
  onClose: () => void;
  onAdd: (description: string) => Promise<void>;
}) {
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const text = description.trim();
  // The database treats two manual lines as distinct; the same line twice is a slip.
  const duplicate = existing.some((d) => d.toLowerCase() === text.toLowerCase());
  return (
    <Modal
      title={`Add to ${areaLabel}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || text.length < 3 || duplicate}
            onClick={async () => {
              setBusy(true);
              try {
                await onAdd(text);
              } catch (err) {
                setError(err);
                setBusy(false);
              }
            }}
          >
            Add item
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <Field
        label="What has to be returned or done"
        error={duplicate ? 'That line is already on this clearance' : null}
      >
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
    </Modal>
  );
}

function EditModal({
  clearance,
  onClose,
  onSaved,
}: {
  clearance: ClearanceDetailData;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const users = useUsers();
  const [form, setForm] = useState({
    reason: clearance.reason,
    lastWorkingDay: clearance.lastWorkingDay.slice(0, 10),
    handedOverToId: clearance.handedOverToId ?? '',
    notes: clearance.notes ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <Modal
      title={`Modify ${clearance.number}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !form.lastWorkingDay}
            onClick={async () => {
              setBusy(true);
              try {
                await api.patch(`/clearances/${clearance.id}`, {
                  reason: form.reason,
                  lastWorkingDay: form.lastWorkingDay,
                  handedOverToId: form.handedOverToId || null,
                  notes: form.notes.trim() || null,
                });
                await onSaved();
              } catch (err) {
                setError(err);
                setBusy(false);
              }
            }}
          >
            Save
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <div className="grid grid-2">
        <Field label="Reason">
          <select value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })}>
            {REASONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Last working day">
          <input
            type="date"
            value={form.lastWorkingDay}
            onChange={(e) => setForm({ ...form, lastWorkingDay: e.target.value })}
          />
        </Field>
        <Field label="Hand over to">
          <select value={form.handedOverToId} onChange={(e) => setForm({ ...form, handedOverToId: e.target.value })}>
            <option value="">— nobody named —</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
                {u.position ? ` · ${u.position}` : ''}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Notes">
        <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </Field>
    </Modal>
  );
}

function CancelModal({
  number,
  onClose,
  onCancel,
}: {
  number: string;
  onClose: () => void;
  onCancel: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <Modal
      title={`Cancel ${number}?`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Keep it
          </button>
          <button
            className="btn btn-danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onCancel(reason.trim());
              } catch (err) {
                setError(err);
                setBusy(false);
              }
            }}
          >
            Cancel clearance
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <p className="muted">
        For someone who is staying after all. Any sign-off in progress is withdrawn; nothing on the
        employee record changes.
      </p>
      <Field label="Why" hint="Optional — goes on the audit trail">
        <input value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Modal>
  );
}
