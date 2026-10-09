import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column, type FilterDef } from '../../components/DataList';
import { DocumentApproval } from '../../components/ApprovalStepper';
import { RecordHeader } from '../../components/RecordHeader';
import { useConfirm } from '../../components/Confirm';
import { useBackLink } from '../../components/Navigation';
import {
  Checkbox,
  ErrorBox,
  Field,
  Loading,
  Modal,
  ModalFoot,
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
  /** Each mirrors its route, so a button is never offered that the route refuses. */
  canCancel: boolean;
  /** PUT /leave/:id — a DRAFT, the employee's own or edit_all. */
  canModify: boolean;
  /** POST /leave/:id/submit — a DRAFT, the employee (or a super admin). */
  canSubmit: boolean;
  /** POST /leave/:id/withdraw — PENDING_APPROVAL, whoever may modify it. */
  canWithdraw: boolean;
}

interface EmployeeOption {
  id: string;
  employeeNo: string;
  firstName: string;
  lastName: string;
}

const BASE = '/g-hr/leave';

const messageOf = (err: unknown) => (err instanceof Error ? err.message : 'That did not go through.');

/**
 * `/g-hr/leave` is the register; `/g-hr/leave/:id` is one request on a page of
 * its own, so an approval notification, a search hit and a row click all land
 * on the same thing — with the record's header, Modify and all.
 */
export function Leave() {
  const { id } = useParams<{ id: string }>();
  return id ? <LeaveRecord id={id} /> : <LeaveList />;
}

function LeaveList() {
  const { can } = useAuth();
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

  // The record's URL keeps the list's query string, so its Back line returns
  // to the same filtered, paged list rather than to page one.
  const open = (row: LeaveRow) => navigate(`${BASE}/${row.id}${location.search}`);

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
              + New leave request
            </button>
          ) : null
        }
      />

      {filing && (
        <FileLeaveModal
          onClose={() => setFiling(false)}
          onSaved={(savedId, openIt) => {
            setFiling(false);
            setReload((r) => r + 1);
            // A draft — saved as one, or sent and refused — opens, so it can
            // be submitted from its page.
            if (openIt) navigate(`${BASE}/${savedId}`);
          }}
        />
      )}
    </div>
  );
}

/**
 * "New leave request", and — handed `existing` — "Modify leave request …" on a
 * DRAFT (PUT /leave/:id). Either way it can be saved as a draft or sent: the
 * days are the server's arithmetic, the same rules as filing.
 */
function FileLeaveModal({
  existing,
  onClose,
  onSaved,
}: {
  existing?: LeaveDetail;
  onClose: () => void;
  /** `open`: the request should be opened — it is (still) a draft to send. */
  onSaved: (id: string, open: boolean) => void;
}) {
  const toast = useToast();
  const [types, setTypes] = useState<LeaveType[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [preview, setPreview] = useState<{
    days: number;
    balance: Balance | null;
    wouldExceed: boolean;
  } | null>(null);

  const [half, setHalf] = useState(!!(existing?.startTime || existing?.endTime));
  const [form, setForm] = useState({
    leaveTypeId: existing?.leaveType.id ?? '',
    startDate: existing?.startDate.slice(0, 10) ?? '',
    startTime: existing?.startTime ?? '',
    endDate: existing?.endDate.slice(0, 10) ?? '',
    endTime: existing?.endTime ?? '',
    reason: existing?.reason ?? '',
    proofNote: existing?.proofNote ?? '',
  });
  // The balance shown is the signed-in person's own, so it is shown only when
  // the request is theirs to send (HR modifying somebody's draft sees none).
  const ownBalance = !existing || existing.canSubmit;

  useEffect(() => {
    api
      .get<LeaveType[]>('/leave/types')
      .then((t) => {
        // A draft keeps its type even if that type has since been switched off.
        const active = t.filter((x) => x.isActive || x.id === existing?.leaveType.id);
        setTypes(active);
        if (active.length) setForm((f) => (f.leaveTypeId ? f : { ...f, leaveTypeId: active[0].id }));
      })
      .catch(() => {});
  }, [existing?.leaveType.id]);

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
  // Sending is offered where the route would take it: anyone filing their own,
  // and on a draft only whoever may submit it.
  const maySend = !existing || existing.canSubmit;

  async function save(send: boolean) {
    setBusy(true);
    setError(null);
    const body = {
      leaveTypeId: form.leaveTypeId,
      startDate: form.startDate,
      endDate: form.endDate,
      startTime: half ? form.startTime || null : null,
      endTime: half ? form.endTime || null : null,
      reason: form.reason,
      proofNote: form.proofNote || null,
    };
    let saved: { id: string };
    try {
      saved = existing
        ? await api.put<{ id: string }>(`/leave/${existing.id}`, body)
        : await api.post<{ id: string }>('/leave', body);
    } catch (err) {
      setError(err);
      setBusy(false);
      return;
    }
    if (!send) {
      toast('ok', existing ? 'Saved' : 'Saved as a draft');
      onSaved(saved.id, true);
      return;
    }
    try {
      await api.post(`/leave/${saved.id}/submit`);
      toast('ok', existing ? 'Saved and sent for approval' : 'Filed and sent for approval');
      onSaved(saved.id, false);
    } catch (err) {
      // Saved, but the approval engine refused it: it stays a draft, which
      // its page can send once the reason is fixed — never a second copy.
      toast('error', `Saved as a draft, but not sent: ${messageOf(err)}`);
      onSaved(saved.id, true);
    }
  }

  const valid =
    !!form.leaveTypeId &&
    !!form.startDate &&
    !!form.endDate &&
    form.reason.trim().length >= 3 &&
    !(type?.requiresProof && !form.proofNote.trim());

  return (
    <Modal
      title={existing ? `Modify leave request ${existing.number}` : 'New leave request'}
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button className={maySend ? 'btn' : 'btn btn-primary'} onClick={() => save(false)} disabled={busy || !valid}>
            {existing ? 'Save' : 'Save draft'}
          </button>
          {maySend && (
            <button className="btn btn-primary" onClick={() => save(true)} disabled={busy || !valid}>
              {busy ? 'Submitting…' : 'Submit for approval'}
            </button>
          )}
        </ModalFoot>
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
        <div className={`alert ${ownBalance && preview.wouldExceed ? 'warn' : 'info'}`}>
          <strong>{preview.days}</strong> working day{preview.days === 1 ? '' : 's'} — weekends are
          not counted.
          {ownBalance && preview.balance && (
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
 * Read from `GET /leave/:id` rather than from the list: the list may be
 * filtered or paged past the row, and only the record carries the proof note
 * an approver is deciding on, and what this viewer may do with it.
 *
 * A DRAFT is modified and submitted here — including one whose submission the
 * engine refused, which used to be stranded with no way to send it again. A
 * pending one is pulled back to draft first ("Pull back and edit").
 */
function LeaveRecord({ id }: { id: string }) {
  const toast = useToast();
  const { can } = useAuth();
  const location = useLocation();
  const confirm = useConfirm();
  const [row, setRow] = useState<LeaveDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [modifying, setModifying] = useState(false);
  const [sending, setSending] = useState(false);
  const [reload, setReload] = useState(0);

  // Opened from the register, the way back is the same filtered, paged list.
  useBackLink(location.search ? `${BASE}${location.search}` : null, 'Leave');

  const load = useCallback(async () => {
    try {
      setRow(await api.get<LeaveDetail>(`/leave/${id}`));
      setError(null);
      setReload((r) => r + 1);
    } catch (err) {
      setError(err);
    }
  }, [id]);

  useEffect(() => {
    setRow(null);
    load();
  }, [load]);

  if (error && !row) return <ErrorBox error={error} />;
  if (!row) return <Loading />;

  const employeeName = `${row.employee.firstName} ${row.employee.lastName}`;
  const daysLabel = `${row.days} day${row.days === 1 ? '' : 's'}`;

  async function submit() {
    if (!row) return;
    setSending(true);
    try {
      await api.post(`/leave/${row.id}/submit`);
      toast('ok', 'Sent for approval');
      await load();
    } catch (err) {
      // Refused — a clash with another request, no route, or a change saved
      // elsewhere a moment ago: it stays a draft, shown as it now stands.
      toast('error', messageOf(err));
      await load();
    } finally {
      setSending(false);
    }
  }

  /** Asked in the confirm bar first; a refusal is shown there, so these throw. */
  async function withdraw() {
    if (!row) return;
    await api.post(`/leave/${row.id}/withdraw`);
    toast('ok', 'Pulled back to draft');
    await load();
    setModifying(true);
  }

  async function cancel() {
    if (!row) return;
    await api.post(`/leave/${row.id}/cancel`);
    toast(
      'ok',
      row.status === 'APPROVED'
        ? 'Cancelled — the days have gone back on the balance'
        : 'Cancelled',
    );
    await load();
  }

  return (
    <div>
      <RecordHeader
        type="Leave Request"
        code={row.number}
        title={`${employeeName} · ${row.leaveType.name}`}
        status={row.status}
        amount={daysLabel}
        amountLabel="Working days"
        meta={
          <>
            {can('ghr.employees.view_all') ? (
              <Link to={`/g-hr/employees/${row.employee.id}`} className="mono">
                {row.employee.employeeNo}
              </Link>
            ) : (
              <span className="mono">{row.employee.employeeNo}</span>
            )}
            {' · '}
            {formatDate(row.startDate)}
            {row.startTime && <span className="mono"> {row.startTime}</span>} → {formatDate(row.endDate)}
            {row.endTime && <span className="mono"> {row.endTime}</span>}
            {' · filed '}
            {formatDateTime(row.createdAt)}
          </>
        }
        actions={
          row.canSubmit && (
            <button className="btn btn-primary" onClick={submit} disabled={sending}>
              {sending ? 'Submitting…' : 'Submit for approval'}
            </button>
          )
        }
        more={[
          row.canWithdraw && {
            label: 'Pull back and edit',
            hint: 'Withdraw it from the approver and return it to draft',
            confirm: {
              title: `Pull ${row.number} back to draft?`,
              body: 'It is withdrawn from the approver — they are told — and needs approval again once it is resubmitted.',
              confirmLabel: 'Pull back',
              tone: 'primary',
              onConfirm: withdraw,
            },
          },
          row.canCancel && {
            label: 'Cancel leave request',
            danger: true,
            confirm: {
              title: `Cancel ${row.number}?`,
              body:
                row.status === 'APPROVED'
                  ? `The ${daysLabel} go back on the balance.`
                  : row.status === 'PENDING_APPROVAL'
                    ? 'It is withdrawn from the approver, who is told.'
                    : 'Nothing has been taken off the balance.',
              confirmLabel: 'Cancel leave request',
              onConfirm: cancel,
            },
          },
        ]}
        modify={row.canModify ? () => setModifying(true) : undefined}
        confirm={confirm}
      />

      <ErrorBox error={error} />

      {row.status === 'DRAFT' && (
        <div className="alert info">
          A draft — not with anybody yet, and nothing is counted against the balance.
          {row.canSubmit && ' Submit it for approval when it is right.'}
        </div>
      )}
      {row.status === 'PENDING_APPROVAL' && (
        <div className="alert info">
          Awaiting a decision — the chain below shows who has it. Nothing has been taken off the
          balance yet.
        </div>
      )}
      {row.status === 'APPROVED' && (
        <div className="alert ok">
          Approved — {daysLabel} drawn from {row.leaveType.name}. Cancelling gives them back.
        </div>
      )}

      <div className="card">
        <h3 className="card-title">Request</h3>
        <dl className="kv">
          <dt>Employee</dt>
          <dd>
            {can('ghr.employees.view_all') ? (
              <Link to={`/g-hr/employees/${row.employee.id}`}>{employeeName}</Link>
            ) : (
              employeeName
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
        </dl>
      </div>

      <DocumentApproval documentType="leave_request" documentId={row.id} reloadToken={reload} />

      {modifying && (
        <FileLeaveModal
          existing={row}
          onClose={() => setModifying(false)}
          onSaved={() => {
            setModifying(false);
            load();
          }}
        />
      )}
    </div>
  );
}
