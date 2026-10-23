import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { todayLocal } from '../../lib/day';
import { DataList, type Column } from '../../components/DataList';
import { DocumentApproval, DecisionNote } from '../../components/ApprovalStepper';
import { RecordHeader } from '../../components/RecordHeader';
import { useConfirm } from '../../components/Confirm';
import { ErrorBox, Field, Loading, Modal, ModalFoot, StatusBadge, formatDate, formatDateTime, formatTime, useToast } from '../../components/ui';
import { APPROVER_FILTERS } from './approverFilters';
import { FilingRoute } from './FilingRoute';

/**
 * G-HR › Attendance Corrections (2026-10-23): an employee asks for a day's
 * time in and/or time out to be corrected; their supervisor, then HR, decide
 * it, and approval writes the times onto the day. A superior lists their
 * direct reports' requests and what waits on them (`waiting=me`).
 */

const BASE = '/g-hr/attendance-corrections';
const STATUSES = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'PENDING_APPROVAL', label: 'Pending approval' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

interface Row {
  id: string;
  number: string;
  date: string;
  timeIn: string | null;
  timeOut: string | null;
  reason: string;
  status: string;
  createdAt: string;
  employee: { id: string; name: string; employeeNo: string | null };
}

interface Detail extends Row {
  cancelReason: string | null;
  appliedAt: string | null;
  requestedBy: { id: string; name: string } | null;
  current: { timeIn: string | null; timeOut: string | null; status: string } | null;
  canEdit: boolean;
  canSubmit: boolean;
  canWithdraw: boolean;
  canCancel: boolean;
  canDelete: boolean;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : 'That did not go through.');
const clock = (iso: string | null | undefined) => (iso ? formatTime(iso) : '—');

export function AttendanceCorrections() {
  const { id } = useParams<{ id: string }>();
  return id ? <CorrectionRecord id={id} /> : <CorrectionList />;
}

function CorrectionList() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  // "Request correction" on My Records opens the form on that day.
  const [filing, setFiling] = useState<string | null>(params.get('new') ? params.get('date') ?? '' : null);
  useEffect(() => {
    if (params.get('new')) {
      const next = new URLSearchParams(params);
      next.delete('new');
      next.delete('date');
      setParams(next, { replace: true });
    }
  }, [params, setParams]);

  const columns: Column<Row>[] = [
    { key: 'number', label: 'Number', sortKey: 'number', render: (r) => <span className="mono">{r.number}</span> },
    { key: 'employee', label: 'Employee', render: (r) => r.employee.name },
    { key: 'date', label: 'Date', sortKey: 'date', render: (r) => formatDate(r.date) },
    { key: 'in', label: 'Time in', render: (r) => <span className="mono">{r.timeIn ?? '—'}</span> },
    { key: 'out', label: 'Time out', render: (r) => <span className="mono">{r.timeOut ?? '—'}</span> },
    { key: 'reason', label: 'Reason', render: (r) => r.reason },
    { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Attendance Corrections</h1>
        </div>
      </div>
      <DataList<Row>
        listKey="attendance-corrections"
        endpoint="/attendance-corrections"
        printPath="/api/attendance-corrections/pdf"
        columns={columns}
        rowKey={(r) => r.id}
        scoped
        searchPlaceholder="Search number, reason, employee…"
        emptyTitle="No corrections asked for yet"
        onRowClick={(r) => navigate(`${BASE}/${r.id}`)}
        filters={[{ key: 'status', label: 'Status', options: STATUSES }, ...APPROVER_FILTERS]}
        actions={
          can('ghr.attendance_corrections.create') ? (
            <button className="btn btn-primary btn-sm" onClick={() => setFiling('')}>
              + New attendance correction
            </button>
          ) : null
        }
      />
      {filing !== null && (
        <CorrectionModal
          date={filing}
          onClose={() => setFiling(null)}
          onSaved={(saved) => navigate(`${BASE}/${saved.id}`)}
        />
      )}
    </div>
  );
}

function CorrectionModal({ existing, date, onClose, onSaved }: { existing?: Detail; date?: string; onClose: () => void; onSaved: (row: Detail) => void }) {
  const toast = useToast();
  const [form, setForm] = useState({
    date: existing?.date ?? (date || todayLocal()),
    timeIn: existing?.timeIn ?? '',
    timeOut: existing?.timeOut ?? '',
    reason: existing?.reason ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const valid = !!form.date && (!!form.timeIn || !!form.timeOut) && form.reason.trim().length >= 5;

  async function save(send: boolean) {
    setBusy(true);
    setError(null);
    const payload = { date: form.date, timeIn: form.timeIn || null, timeOut: form.timeOut || null, reason: form.reason };
    try {
      let saved = existing
        ? await api.put<Detail>(`/attendance-corrections/${existing.id}`, payload)
        : await api.post<Detail>('/attendance-corrections', payload);
      if (send) {
        try {
          saved = await api.post<Detail>(`/attendance-corrections/${saved.id}/submit`);
          toast('ok', 'Sent for approval');
        } catch (err) {
          toast('error', `Saved as a draft, but not sent: ${messageOf(err)}`);
        }
      } else toast('ok', 'Saved');
      onSaved(saved);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={existing ? `Modify attendance correction ${existing.number}` : 'New attendance correction'}
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button className="btn" onClick={() => save(false)} disabled={busy || !valid}>
            {existing ? 'Save' : 'Save draft'}
          </button>
          <button className="btn btn-primary" onClick={() => save(true)} disabled={busy || !valid}>
            {busy ? 'Submitting…' : 'Submit for approval'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      <div className="grid-2">
        <Field label="Date" required>
          <input type="date" value={form.date} max={todayLocal()} onChange={(e) => setForm({ ...form, date: e.target.value })} />
        </Field>
        <div />
        <Field label="Time in" hint="Leave blank to keep the day's time in">
          <input type="time" value={form.timeIn} onChange={(e) => setForm({ ...form, timeIn: e.target.value })} />
        </Field>
        <Field label="Time out" hint="Before the time in means the next morning">
          <input type="time" value={form.timeOut} onChange={(e) => setForm({ ...form, timeOut: e.target.value })} />
        </Field>
      </div>
      <Field label="Reason" required hint="What happened — the clock refused you, you forgot to clock out…">
        <textarea rows={3} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
      </Field>
      <FilingRoute path={`/attendance-corrections/route${existing ? `?requestId=${existing.id}` : ''}`} />
    </Modal>
  );
}

function CorrectionRecord({ id }: { id: string }) {
  const toast = useToast();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [row, setRow] = useState<Detail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [modifying, setModifying] = useState(false);
  const [sending, setSending] = useState(false);
  const [reload, setReload] = useState(0);

  const load = useCallback(async () => {
    try {
      setRow(await api.get<Detail>(`/attendance-corrections/${id}`));
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

  async function submit() {
    if (!row) return;
    setSending(true);
    try {
      await api.post(`/attendance-corrections/${row.id}/submit`);
      toast('ok', 'Sent for approval');
    } catch (err) {
      toast('error', messageOf(err));
    } finally {
      setSending(false);
      await load();
    }
  }

  return (
    <div>
      <RecordHeader
        type="Attendance Correction"
        code={row.number}
        title={`${row.employee.name} · ${formatDate(row.date)}`}
        status={row.status}
        meta={<>Asked {formatDateTime(row.createdAt)}{row.requestedBy ? ` by ${row.requestedBy.name}` : ''}</>}
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
            confirm: {
              title: `Pull ${row.number} back to draft?`,
              body: 'It is withdrawn from the approver, who is told.',
              confirmLabel: 'Pull back',
              tone: 'primary',
              onConfirm: async () => {
                await api.post(`/attendance-corrections/${row.id}/withdraw`);
                toast('ok', 'Pulled back to draft');
                await load();
              },
            },
          },
          row.canCancel && {
            label: 'Cancel correction',
            danger: true,
            confirm: {
              title: `Cancel ${row.number}?`,
              body: 'The day stays as it is.',
              reason: 'required',
              minReason: 3,
              confirmLabel: 'Cancel correction',
              onConfirm: async (reason: string) => {
                await api.post(`/attendance-corrections/${row.id}/cancel`, { reason });
                toast('ok', 'Cancelled');
                await load();
              },
            },
          },
          row.canDelete && {
            label: 'Delete',
            danger: true,
            confirm: {
              title: `Delete ${row.number}?`,
              body: 'It is removed for good.',
              confirmLabel: 'Delete',
              onConfirm: async () => {
                await api.del(`/attendance-corrections/${row.id}`);
                toast('ok', 'Deleted');
                navigate(BASE);
              },
            },
          },
        ]}
        modify={row.canEdit ? () => setModifying(true) : undefined}
        confirm={confirm}
      />
      <ErrorBox error={error} />
      {row.status === 'APPROVED' && (
        <div className="alert ok">Approved — the day was corrected{row.appliedAt ? ` on ${formatDateTime(row.appliedAt)}` : ''}.</div>
      )}
      {row.status === 'PENDING_APPROVAL' && <div className="alert info">Awaiting a decision — the day changes only once every step has approved.</div>}
      <div className="card">
        <h3 className="card-title">Correction</h3>
        <dl className="kv">
          <dt>Employee</dt>
          <dd>
            {row.employee.name} <span className="faint mono">{row.employee.employeeNo}</span>
          </dd>
          <dt>Date</dt>
          <dd>{formatDate(row.date)}</dd>
          <dt>Time in</dt>
          <dd>
            <span className="mono">{row.timeIn ?? 'unchanged'}</span>
            {row.status !== 'APPROVED' && <span className="faint"> · on the register now: {clock(row.current?.timeIn)}</span>}
          </dd>
          <dt>Time out</dt>
          <dd>
            <span className="mono">{row.timeOut ?? 'unchanged'}</span>
            {row.status !== 'APPROVED' && <span className="faint"> · on the register now: {clock(row.current?.timeOut)}</span>}
          </dd>
          <dt>Reason</dt>
          <dd>{row.reason}</dd>
          {row.cancelReason && (
            <>
              <dt>Cancelled because</dt>
              <dd>{row.cancelReason}</dd>
            </>
          )}
        </dl>
      </div>
      <DecisionNote documentType="attendance_correction" documentId={row.id} reloadToken={reload} />
      {row.status !== 'DRAFT' && <DocumentApproval documentType="attendance_correction" documentId={row.id} reloadToken={reload} />}
      {modifying && (
        <CorrectionModal
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
