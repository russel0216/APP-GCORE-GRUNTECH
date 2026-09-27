import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column, type FilterDef } from '../../components/DataList';
import { DocumentApproval } from '../../components/ApprovalStepper';
import {
  Checkbox,
  ErrorBox,
  Field,
  Loading,
  Modal,
  StatusBadge,
  formatDate,
  formatDateTime,
  useToast,
} from '../../components/ui';

/**
 * Leave — filing, balances and the approval that spends them.
 *
 * A filed request is shown against the balance but does not spend it. Only an
 * approval draws days down, and cancelling an approved request gives them
 * back. Filing cannot cost somebody an entitlement.
 */

const STATUSES = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'PENDING_APPROVAL', label: 'Pending approval' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

export interface LeaveType {
  id: string;
  code: string;
  name: string;
  daysPerYear: number;
  isPaid: boolean;
  requiresProof: boolean;
  sortOrder: number;
  isActive: boolean;
}

interface Balance {
  leaveType: { id: string; code: string; name: string; isPaid: boolean };
  year: number;
  entitled: number;
  carriedOver: number;
  used: number;
  pending: number;
  remaining: number;
  remainingAfterPending: number;
}

interface LeaveRow {
  id: string;
  number: string;
  status: string;
  startDate: string;
  startTime: string | null;
  endDate: string;
  endTime: string | null;
  days: number;
  reason: string;
  employee: { id: string; employeeNo: string; firstName: string; lastName: string };
  leaveType: { id: string; name: string; isPaid: boolean };
}

/** `GET /leave/:id` — a list row, plus what only the single record carries. */
interface LeaveDetail extends LeaveRow {
  proofNote: string | null;
  decidedAt: string | null;
  createdAt: string;
  canCancel: boolean;
}

interface EmployeeOption {
  id: string;
  employeeNo: string;
  firstName: string;
  lastName: string;
}

const BASE = '/g-hr/leave';

export function Leave() {
  const { can } = useAuth();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [filing, setFiling] = useState(false);
  const [reload, setReload] = useState(0);
  const [balances, setBalances] = useState<Balance[] | null>(null);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const seesEveryone = can('ghr.leave.view_all');

  const loadBalances = useCallback(async () => {
    try {
      const data = await api.get<{ balances: Balance[] }>('/leave/balances');
      setBalances(data.balances);
    } catch {
      setBalances([]);
    }
  }, []);

  useEffect(() => {
    loadBalances();
  }, [loadBalances, reload]);

  // Former employees included: leave history outlives the employment.
  useEffect(() => {
    if (!seesEveryone) return;
    api
      .get<EmployeeOption[]>('/employees/lookup')
      .then(setEmployees)
      .catch(() => setEmployees([]));
  }, [seesEveryone]);

  // The record's URL keeps the list's query string, so closing it returns to
  // the same filtered, paged list rather than to page one.
  const open = (row: LeaveRow) => navigate(`${BASE}/${row.id}${location.search}`);
  const close = () => navigate(`${BASE}${location.search}`);

  const columns: Column<LeaveRow>[] = [
    {
      key: 'number',
      label: 'Number',
      sortKey: 'number',
      width: '150px',
      render: (r) => <span className="mono">{r.number}</span>,
    },
    {
      key: 'employee',
      label: 'Employee',
      render: (r) => (
        <div>
          <div>
            {r.employee.lastName}, {r.employee.firstName}
          </div>
          <div className="faint">{r.leaveType.name}</div>
        </div>
      ),
    },
    {
      key: 'dates',
      label: 'Dates',
      sortKey: 'startDate',
      render: (r) => (
        <div>
          <div>
            {formatDate(r.startDate)}
            {r.startTime ? ` ${r.startTime}` : ''} → {formatDate(r.endDate)}
            {r.endTime ? ` ${r.endTime}` : ''}
          </div>
          <div className="faint">{r.reason}</div>
        </div>
      ),
    },
    {
      key: 'days',
      label: 'Days',
      align: 'right',
      render: (r) => <span className="mono">{r.days}</span>,
    },
    {
      key: 'paid',
      label: 'Paid',
      optional: true,
      render: (r) => (r.leaveType.isPaid ? 'yes' : <span className="faint">unpaid</span>),
    },
    {
      key: 'status',
      label: 'Status',
      render: (r) => <StatusBadge status={r.status} />,
    },
  ];

  // The Employee filter is declared even before its options arrive, so a
  // `?employeeId=` in the URL (a dashboard link, say) is honoured on the first
  // fetch rather than dropped.
  const filters: FilterDef[] = [{ key: 'status', label: 'Status', options: STATUSES }];
  if (seesEveryone) {
    filters.push({
      key: 'employeeId',
      label: 'Employee',
      options: employees.map((e) => ({
        value: e.id,
        label: `${e.lastName}, ${e.firstName} (${e.employeeNo})`,
      })),
    });
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Leave</h1>
          <p>
            File with a start and end date, and a time on either if it is a half day. Approval
            routes to whoever you report to, and falls back to HR if nobody is set.
          </p>
        </div>
      </div>

      {balances && balances.length > 0 && (
        <div className="grid grid-4 hraud-balances">
          {balances.map((b) => (
            <div key={b.leaveType.id} className="card">
              <div className="faint hraud-eyebrow">
                {b.leaveType.name.toUpperCase()}
                {!b.leaveType.isPaid && ' · UNPAID'}
              </div>
              <div className="hraud-balance-figure">
                {b.remainingAfterPending}
                <span className="faint hraud-balance-of"> / {b.entitled + b.carriedOver}</span>
              </div>
              <div className="faint hraud-balance-note">
                {b.used} used
                {b.pending > 0 && ` · ${b.pending} awaiting a decision`}
              </div>
            </div>
          ))}
        </div>
      )}

      <DataList<LeaveRow>
        listKey="leave"
        endpoint="/leave"
        columns={columns}
        rowKey={(r) => r.id}
        scoped
        reloadToken={reload}
        searchPlaceholder="Search number, reason, employee…"
        emptyTitle="No leave filed yet"
        onRowClick={open}
        filters={filters}
        actions={
          can('ghr.leave.create') ? (
            <button className="btn btn-primary btn-sm" onClick={() => setFiling(true)}>
              + File leave
            </button>
          ) : null
        }
      />

      {filing && (
        <FileLeaveModal
          onClose={() => setFiling(false)}
          onFiled={() => {
            setFiling(false);
            setReload((r) => r + 1);
          }}
        />
      )}

      {id && (
        <LeaveDetailModal
          id={id}
          onClose={close}
          onChanged={() => {
            setReload((r) => r + 1);
            close();
          }}
        />
      )}
    </div>
  );
}

function FileLeaveModal({ onClose, onFiled }: { onClose: () => void; onFiled: () => void }) {
  const toast = useToast();
  const [types, setTypes] = useState<LeaveType[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [preview, setPreview] = useState<{
    days: number;
    balance: Balance | null;
    wouldExceed: boolean;
  } | null>(null);

  const [half, setHalf] = useState(false);
  const [form, setForm] = useState({
    leaveTypeId: '',
    startDate: '',
    startTime: '',
    endDate: '',
    endTime: '',
    reason: '',
    proofNote: '',
  });

  useEffect(() => {
    api
      .get<LeaveType[]>('/leave/types')
      .then((t) => {
        const active = t.filter((x) => x.isActive);
        setTypes(active);
        if (active.length) setForm((f) => ({ ...f, leaveTypeId: active[0].id }));
      })
      .catch(() => {});
  }, []);

  // The day count is the server's arithmetic, not a guess made here — the same
  // function that will decide it on submission.
  useEffect(() => {
    if (!form.leaveTypeId || !form.startDate || !form.endDate) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    api
      .post<typeof preview>('/leave/preview', {
        leaveTypeId: form.leaveTypeId,
        startDate: form.startDate,
        endDate: form.endDate,
        startTime: half ? form.startTime || null : null,
        endTime: half ? form.endTime || null : null,
      })
      .then((p) => !cancelled && setPreview(p))
      .catch(() => !cancelled && setPreview(null));
    return () => {
      cancelled = true;
    };
  }, [form.leaveTypeId, form.startDate, form.endDate, form.startTime, form.endTime, half]);

  const type = types.find((t) => t.id === form.leaveTypeId);

  async function file() {
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<{ id: string }>('/leave', {
        leaveTypeId: form.leaveTypeId,
        startDate: form.startDate,
        endDate: form.endDate,
        startTime: half ? form.startTime || null : null,
        endTime: half ? form.endTime || null : null,
        reason: form.reason,
        proofNote: form.proofNote || null,
      });
      await api.post(`/leave/${created.id}/submit`);
      toast('ok', 'Filed and sent for approval');
      onFiled();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="File leave"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={file}
            disabled={
              busy ||
              !form.leaveTypeId ||
              !form.startDate ||
              !form.endDate ||
              form.reason.trim().length < 3 ||
              (type?.requiresProof && !form.proofNote.trim())
            }
          >
            {busy ? 'Filing…' : 'File and send for approval'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />

      <Field label="Type of leave">
        <select
          value={form.leaveTypeId}
          onChange={(e) => setForm({ ...form, leaveTypeId: e.target.value })}
        >
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.isPaid ? '' : ' (unpaid)'}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid grid-2">
        <Field label="From">
          <input
            type="date"
            value={form.startDate}
            onChange={(e) =>
              setForm({
                ...form,
                startDate: e.target.value,
                endDate: form.endDate && form.endDate >= e.target.value ? form.endDate : e.target.value,
              })
            }
          />
        </Field>
        <Field label="To">
          <input
            type="date"
            value={form.endDate}
            min={form.startDate || undefined}
            onChange={(e) => setForm({ ...form, endDate: e.target.value })}
          />
        </Field>
      </div>

      <Checkbox checked={half} onChange={setHalf} label="Part of a day" />

      {half && (
        <div className="grid grid-2 hraud-gap-above">
          <Field label="Leaving from" hint="An afternoon start means the morning was worked">
            <input
              type="time"
              value={form.startTime}
              onChange={(e) => setForm({ ...form, startTime: e.target.value })}
            />
          </Field>
          <Field label="Back at" hint="A midday finish means the afternoon is worked">
            <input
              type="time"
              value={form.endTime}
              onChange={(e) => setForm({ ...form, endTime: e.target.value })}
            />
          </Field>
        </div>
      )}

      {preview && (
        <div className={`alert ${preview.wouldExceed ? 'warn' : 'info'}`}>
          <strong>{preview.days}</strong> working day{preview.days === 1 ? '' : 's'} — weekends are
          not counted.
          {preview.balance && (
            <>
              {' '}
              You have <strong>{preview.balance.remainingAfterPending}</strong> left after anything
              already awaiting a decision.
              {preview.wouldExceed && ' This request would take you past that.'}
            </>
          )}
        </div>
      )}

      <Field label="Reason">
        <input
          value={form.reason}
          onChange={(e) => setForm({ ...form, reason: e.target.value })}
          placeholder="e.g. family matter in the province"
        />
      </Field>

      {type?.requiresProof && (
        <Field
          label="Supporting documentation"
          hint={`${type.name} needs proof — note what you are providing, and bring it to HR`}
        >
          <input
            value={form.proofNote}
            onChange={(e) => setForm({ ...form, proofNote: e.target.value })}
            placeholder="e.g. medical certificate from Dr Santos, 21 Sept"
          />
        </Field>
      )}
    </Modal>
  );
}

// ── The single request ───────────────────────────────────────────────────────

/**
 * Opened by URL — `/g-hr/leave/:id` — so an approval notification, a search
 * hit and a row click all land on the same thing. Read from `GET /leave/:id`
 * rather than from the list: the list may be filtered or paged past the row,
 * and only the record carries the proof note an approver is deciding on.
 */
function LeaveDetailModal({
  id,
  onClose,
  onChanged,
}: {
  id: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const { can } = useAuth();
  const [row, setRow] = useState<LeaveDetail | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let live = true;
    setRow(null);
    setLoadError(null);
    api
      .get<LeaveDetail>(`/leave/${id}`)
      .then((r) => live && setRow(r))
      .catch((err) => live && setLoadError(err));
    return () => {
      live = false;
    };
  }, [id]);

  async function cancel() {
    if (!row) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/leave/${row.id}/cancel`);
      toast(
        'ok',
        row.status === 'APPROVED'
          ? 'Cancelled — the days have gone back on the balance'
          : 'Cancelled',
      );
      onChanged();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={row?.number ?? 'Leave request'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Close
          </button>
          {row?.canCancel && (
            <button className="btn btn-danger" onClick={cancel} disabled={busy}>
              {busy ? 'Cancelling…' : 'Cancel this request'}
            </button>
          )}
        </>
      }
    >
      <ErrorBox error={error ?? loadError} />
      {!row ? (
        !loadError && <Loading />
      ) : (
        <>
          <dl className="kv">
            <dt>Employee</dt>
            <dd>
              {can('ghr.employees.view_all') ? (
                <Link to={`/g-hr/employees/${row.employee.id}`}>
                  {row.employee.firstName} {row.employee.lastName}
                </Link>
              ) : (
                <>
                  {row.employee.firstName} {row.employee.lastName}
                </>
              )}{' '}
              <span className="faint mono">{row.employee.employeeNo}</span>
            </dd>
            <dt>Type</dt>
            <dd>
              {row.leaveType.name}
              {!row.leaveType.isPaid && <span className="faint"> · unpaid</span>}
            </dd>
            <dt>From</dt>
            <dd>
              {formatDate(row.startDate)}
              {row.startTime && <span className="mono"> {row.startTime}</span>}
            </dd>
            <dt>To</dt>
            <dd>
              {formatDate(row.endDate)}
              {row.endTime && <span className="mono"> {row.endTime}</span>}
            </dd>
            <dt>Working days</dt>
            <dd className="mono">{row.days}</dd>
            <dt>Reason</dt>
            <dd>{row.reason}</dd>
            <dt>Supporting documentation</dt>
            <dd>{row.proofNote ?? <span className="faint">none noted</span>}</dd>
            <dt>Filed</dt>
            <dd>{formatDateTime(row.createdAt)}</dd>
            <dt>Status</dt>
            <dd>
              <StatusBadge status={row.status} />
            </dd>
          </dl>

          {row.status === 'PENDING_APPROVAL' && (
            <div className="alert info hraud-after">
              Awaiting a decision — the chain below shows who has it. Nothing has been taken off
              the balance yet.
            </div>
          )}
          {row.status === 'APPROVED' && (
            <div className="alert ok hraud-after">
              Approved — {row.days} day{row.days === 1 ? '' : 's'} drawn from {row.leaveType.name}.
              Cancelling gives them back.
            </div>
          )}

          <div className="hraud-after">
            <DocumentApproval documentType="leave_request" documentId={row.id} />
          </div>
        </>
      )}
    </Modal>
  );
}
