import { Fragment, useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { todayLocal } from '../../../lib/day';
import { Attachments } from '../../../components/Attachments';
import { RecordHeader } from '../../../components/RecordHeader';
import { useConfirm } from '../../../components/Confirm';
import { Meter, Stat } from '../../../components/charts';
import {
  Empty,
  ErrorBox,
  Field,
  Loading,
  Modal,
  ModalFoot,
  StatusBadge,
  formatDate,
  formatSpan,
  useToast,
  type Tone,
} from '../../../components/ui';
import { useCourseOptions } from './Sessions';

/**
 * The training passport — one person's required courses against what they
 * hold, and every certificate on file (item 13).
 *
 * Mounted twice: `/g-hr/academy/passport` is my own, and
 * `/g-hr/academy/passports/:employeeId` is HR's view of anybody's (and my own
 * again, when the link is to me). Nothing here is stored: the API derives the
 * lines from the course requirements and the verified records on every read.
 *
 * An employee files an external certificate here; HR verifies it through the
 * approval engine. HR can also record one directly for somebody else — never
 * for themselves, so somebody else always checks an HR officer's paperwork.
 */

export const LINE_TONES: Record<string, Tone> = {
  MISSING: 'danger',
  PENDING: 'info',
  CURRENT: 'ok',
  EXPIRING: 'warn',
  EXPIRED: 'danger',
};

const LINE_LABEL: Record<string, string> = {
  MISSING: 'Missing',
  PENDING: 'Awaiting HR',
  CURRENT: 'Current',
  EXPIRING: 'Expiring',
  EXPIRED: 'Expired',
};

export const RECORD_TONES: Record<string, Tone> = {
  PENDING_VERIFICATION: 'info',
  VERIFIED: 'ok',
  REJECTED: 'danger',
};

const RECORD_LABEL: Record<string, string> = {
  PENDING_VERIFICATION: 'Awaiting HR',
  VERIFIED: 'Verified',
  REJECTED: 'Rejected',
};

interface CourseRef {
  id: string;
  code: string;
  title: string;
  category: string | null;
  hours: number;
  validityMonths: number | null;
  requiresAssessment: boolean;
}

interface Line {
  course: CourseRef;
  state: string;
  daysRemaining: number | null;
  recordId: string | null;
  completedAt: string | null;
  expiresAt: string | null;
}

interface RecordRow {
  id: string;
  number: string | null;
  courseId: string;
  course: CourseRef;
  source: 'SESSION' | 'EXTERNAL';
  status: string;
  completedAt: string;
  expiresAt: string | null;
  provider: string | null;
  certificateNo: string | null;
  notes: string | null;
  verifiedAt: string | null;
  verifiedBy: { id: string; name: string } | null;
  createdBy: { id: string; name: string } | null;
  session: { id: string; number: string } | null;
  required: boolean;
  expiry: 'NONE' | 'ACTIVE' | 'EXPIRING' | 'EXPIRED' | null;
  daysRemaining: number | null;
  approvalRequestId: string | null;
  canDelete: boolean;
  canEdit: boolean;
}

export interface PassportData {
  employee: {
    id: string;
    employeeNo: string;
    name: string;
    position: string | null;
    department: { id: string; name: string } | null;
    isActive: boolean;
  };
  expiryWarningDays: number;
  readiness: {
    required: number;
    held: number;
    expiring: number;
    expired: number;
    missing: number;
    pending: number;
    pct: number | null;
  };
  lines: Line[];
  records: RecordRow[];
  upcoming: {
    id: string;
    number: string;
    startsAt: string;
    endsAt: string;
    venue: string | null;
    course: { id: string; code: string; title: string };
  }[];
  totalHours: number;
  own: boolean;
  canAddOwn: boolean;
  canRecord: boolean;
  canVerify: boolean;
}

function expiryText(expiresAt: string | null, days: number | null): string {
  if (!expiresAt) return 'Never expires';
  if (days == null) return formatDate(expiresAt);
  if (days < 0) return `${formatDate(expiresAt)} · lapsed ${-days} day${days === -1 ? '' : 's'} ago`;
  if (days === 0) return `${formatDate(expiresAt)} · today`;
  return `${formatDate(expiresAt)} · ${days} day${days === 1 ? '' : 's'} left`;
}

export function Passport() {
  const { employeeId } = useParams<{ employeeId?: string }>();
  const [data, setData] = useState<PassportData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setData(await api.get<PassportData>(employeeId ? `/passports/${employeeId}` : '/passports/me'));
      setError(null);
    } catch (err) {
      setError(err);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [employeeId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  if (loading) return <Loading />;
  if (!data) {
    return (
      <div>
        <div className="page-head">
          <div>
            <h1>{employeeId ? 'Training Passport' : 'My Training Passport'}</h1>
          </div>
        </div>
        <ErrorBox error={error ?? new Error('Passport not found')} />
      </div>
    );
  }
  return <PassportView data={data} onChange={setData} reload={load} />;
}

export function PassportView({
  data,
  onChange,
  reload,
}: {
  data: PassportData;
  onChange: (d: PassportData) => void;
  reload: () => Promise<void>;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [filing, setFiling] = useState<{ courseId?: string } | null>(null);
  const [editing, setEditing] = useState<RecordRow | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const p = data;
  const r = p.readiness;
  const canFile = p.canAddOwn || p.canRecord;

  /** The approval decision; a refusal is thrown so the caller can show it. */
  async function decide(rec: RecordRow, action: 'APPROVED' | 'REJECTED', comment?: string) {
    if (!rec.approvalRequestId) return;
    await api.post(`/approvals/${rec.approvalRequestId}/act`, { action, comment });
    toast('ok', action === 'APPROVED' ? 'Verified' : 'Rejected');
    await reload();
  }

  async function verify(rec: RecordRow) {
    setBusy(`decide:${rec.id}`);
    setError(null);
    try {
      await decide(rec, 'APPROVED');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  function askReject(rec: RecordRow) {
    confirm.ask({
      title: `Reject ${rec.number ?? rec.course.title}?`,
      body: 'It counts for nothing. The employee sees your reason.',
      confirmLabel: 'Reject',
      reason: 'required',
      reasonLabel: 'Why is this certificate rejected?',
      // The employee reads it: a few words at least, as before.
      minReason: 3,
      onConfirm: (reason) => decide(rec, 'REJECTED', reason),
    });
  }

  /** Asked first — through the confirm bar, or the Modify modal's foot. A refusal is thrown. */
  async function remove(rec: RecordRow) {
    await api.del(`/passports/records/${rec.id}`);
    toast('ok', 'Removed');
    await reload();
  }

  const fileLabel = '+ New certificate';
  const fileButton = canFile ? (
    <button type="button" className="btn btn-primary btn-sm" onClick={() => setFiling({})}>
      {fileLabel}
    </button>
  ) : null;

  return (
    <div className="academy-page">
      <RecordHeader
        type="Training Passport"
        code={p.employee.employeeNo}
        title={p.own ? 'My Training Passport' : p.employee.name}
        meta={
          <>
            {p.own ? `${p.employee.name} · ` : ''}
            {p.employee.position ?? 'no plantilla position'}
            {p.employee.department ? ` · ${p.employee.department.name}` : ''}
            {!p.employee.isActive ? ' · inactive' : ''}
          </>
        }
        actions={
          canFile && (
            <button type="button" className="btn btn-primary" onClick={() => setFiling({})}>
              {fileLabel}
            </button>
          )
        }
        confirm={confirm}
      />

      <ErrorBox error={error} />

      <div className="kpi-grid">
        <Stat
          label="Readiness"
          value={r.pct == null ? '—' : <Meter pct={r.pct} tone={r.pct >= 100 ? undefined : r.pct >= 75 ? 'warn' : 'danger'} />}
          sub={r.required ? `${r.held} of ${r.required} required courses held` : 'no course is required of this position'}
          accent={r.pct == null ? 'quiet' : r.pct >= 100 ? 'ok' : 'warn'}
          icon="book"
        />
        <Stat
          label="Expiring"
          value={r.expiring}
          sub={r.expiring ? `within ${p.expiryWarningDays} days — book a refresher` : `nothing lapses within ${p.expiryWarningDays} days`}
          accent={r.expiring ? 'warn' : 'quiet'}
          icon="clock"
        />
        <Stat
          label="Gaps"
          value={r.missing + r.expired}
          sub={`${r.missing} missing · ${r.expired} expired${r.pending ? ` · ${r.pending} awaiting HR` : ''}`}
          accent={r.missing + r.expired ? 'danger' : 'quiet'}
          icon="alert"
        />
        <Stat
          label="Training hours"
          value={p.totalHours}
          sub={`${p.records.filter((x) => x.status === 'VERIFIED').length} verified certificates`}
          accent="quiet"
          icon="check"
        />
      </div>

      <section className="card academy-section">
        <h3 className="card-title">Required courses</h3>
        {p.lines.length === 0 ? (
          <Empty
            title="Nothing required"
            hint="No course is required of this department or plantilla position yet. HR sets requirements on each course."
          />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Course</th>
                  <th>Standing</th>
                  <th>Completed</th>
                  <th>Expires</th>
                  {p.canAddOwn && <th aria-label="Action" />}
                </tr>
              </thead>
              <tbody>
                {p.lines.map((l) => (
                  <tr key={l.course.id}>
                    <td>
                      <div>{l.course.title}</div>
                      <div className="faint">
                        <span className="mono">{l.course.code}</span>
                        {l.course.category ? ` · ${l.course.category}` : ''}
                      </div>
                    </td>
                    <td>
                      <StatusBadge status={l.state} extra={LINE_TONES} label={LINE_LABEL[l.state]} />
                    </td>
                    <td>{l.completedAt ? formatDate(l.completedAt) : <span className="faint">—</span>}</td>
                    <td>
                      {l.state === 'MISSING' || l.state === 'PENDING' ? (
                        <span className="faint">—</span>
                      ) : (
                        expiryText(l.expiresAt, l.daysRemaining)
                      )}
                    </td>
                    {p.canAddOwn && (
                      <td>
                        {l.state !== 'CURRENT' && l.state !== 'PENDING' && (
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => setFiling({ courseId: l.course.id })}
                            aria-label={`New certificate for ${l.course.title}`}
                          >
                            + New certificate
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {p.upcoming.length > 0 && (
        <section className="card academy-section">
          <h3 className="card-title">Booked on</h3>
          <ul className="academy-list">
            {p.upcoming.map((s) => (
              <li key={s.id}>
                <Link to={`/g-hr/academy/sessions/${s.id}`}>{s.course.title}</Link>
                <span className="faint">
                  {' '}
                  · {formatSpan(s.startsAt, s.endsAt)}
                  {s.venue ? ` · ${s.venue}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card academy-section">
        <h3 className="card-title">Certificates on file</h3>
        {p.records.length === 0 ? (
          <Empty
            title="No training on file"
            hint={
              p.own
                ? 'Completed sessions appear here automatically. Add a certificate you earned elsewhere for HR to verify.'
                : 'Completed sessions and verified certificates appear here.'
            }
            action={fileButton}
          />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Course</th>
                  <th>From</th>
                  <th>Completed</th>
                  <th>Expires</th>
                  <th>Status</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {p.records.map((rec) => (
                  <Fragment key={rec.id}>
                    <tr>
                      <td>
                        <div>{rec.course.title}</div>
                        <div className="faint">
                          {rec.number ? <span className="mono">{rec.number}</span> : <span className="mono">{rec.course.code}</span>}
                          {rec.required ? '' : ' · not required'}
                        </div>
                      </td>
                      <td>
                        {rec.source === 'SESSION' && rec.session ? (
                          <Link to={`/g-hr/academy/sessions/${rec.session.id}`}>{rec.session.number}</Link>
                        ) : (
                          <div>
                            <div>{rec.provider ?? 'External'}</div>
                            {rec.certificateNo && <div className="faint">No. {rec.certificateNo}</div>}
                          </div>
                        )}
                      </td>
                      <td>{formatDate(rec.completedAt)}</td>
                      <td>{rec.status === 'VERIFIED' ? expiryText(rec.expiresAt, rec.daysRemaining) : rec.expiresAt ? formatDate(rec.expiresAt) : '—'}</td>
                      <td>
                        {rec.status === 'VERIFIED' && (rec.expiry === 'EXPIRED' || rec.expiry === 'EXPIRING') ? (
                          <StatusBadge status={rec.expiry} extra={LINE_TONES} label={LINE_LABEL[rec.expiry]} />
                        ) : (
                          <StatusBadge status={rec.status} extra={RECORD_TONES} label={RECORD_LABEL[rec.status]} />
                        )}
                        {rec.verifiedBy && rec.status === 'VERIFIED' && (
                          <div className="faint">by {rec.verifiedBy.name}</div>
                        )}
                      </td>
                      <td>
                        <div className="row academy-row-actions">
                          {p.canVerify && rec.approvalRequestId && (
                            <>
                              <button
                                type="button"
                                className="btn btn-sm"
                                disabled={busy !== null}
                                onClick={() => void verify(rec)}
                              >
                                Verify
                              </button>
                              <button
                                type="button"
                                className="btn btn-danger-ghost btn-sm"
                                disabled={busy !== null}
                                onClick={() => askReject(rec)}
                              >
                                Reject
                              </button>
                            </>
                          )}
                          {rec.source === 'EXTERNAL' && (
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              aria-expanded={open === rec.id}
                              onClick={() => setOpen(open === rec.id ? null : rec.id)}
                            >
                              {open === rec.id ? 'Hide scan' : 'Scan'}
                            </button>
                          )}
                          {rec.canEdit ? (
                            <button
                              type="button"
                              className="btn btn-sm"
                              aria-label={`Modify ${rec.number ?? rec.course.title}`}
                              onClick={() => setEditing(rec)}
                            >
                              Modify
                            </button>
                          ) : (
                            rec.canDelete && (
                              <button
                                type="button"
                                className="btn btn-sm"
                                aria-label={`Remove ${rec.number ?? rec.course.title}`}
                                disabled={busy !== null}
                                onClick={() =>
                                  confirm.ask({
                                    title: `Remove ${rec.number ?? 'this record'} from the passport?`,
                                    body: 'It cannot be undone.',
                                    confirmLabel: 'Remove',
                                    onConfirm: () => remove(rec),
                                  })
                                }
                              >
                                Remove
                              </button>
                            )
                          )}
                        </div>
                      </td>
                    </tr>
                    {open === rec.id && (
                      <tr className="academy-expand">
                        <td colSpan={6}>
                          {rec.notes && <p className="academy-prose">{rec.notes}</p>}
                          <Attachments
                            entityType="training_record"
                            entityId={rec.id}
                            title="Certificate scan"
                            hint="A photo or PDF of the certificate helps HR verify it. Encouraged, not required."
                            canEdit={p.own || can('ghr.passports.edit_all')}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {filing && (
        <ExternalCertModal
          employeeId={p.own ? null : p.employee.id}
          employeeName={p.employee.name}
          courseId={filing.courseId}
          onClose={() => setFiling(null)}
          onSaved={(next) => {
            setFiling(null);
            onChange(next);
            const fresh = next.records.find((x) => !p.records.some((o) => o.id === x.id));
            if (fresh) setOpen(fresh.id);
          }}
        />
      )}
      {editing && (
        <CorrectModal
          record={editing}
          onClose={() => setEditing(null)}
          onSaved={(next) => {
            setEditing(null);
            onChange(next);
          }}
          onRemove={
            editing.canDelete
              ? async () => {
                  await remove(editing);
                  setEditing(null);
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

/**
 * An external certificate. `employeeId` null = my own, filed for HR to
 * verify; otherwise HR recording it for somebody else, verified at once.
 */
export function ExternalCertModal({
  employeeId,
  employeeName,
  courseId,
  onClose,
  onSaved,
}: {
  employeeId: string | null;
  employeeName: string;
  courseId?: string;
  onClose: () => void;
  onSaved: (p: PassportData) => void;
}) {
  const toast = useToast();
  const courses = useCourseOptions();
  const [form, setForm] = useState({
    courseId: courseId ?? '',
    completedAt: '',
    expiresAt: '',
    provider: '',
    certificateNo: '',
    notes: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const course = courses.find((c) => c.id === form.courseId);
  // The local day: the UTC date would cap the picker at yesterday until 08:00.
  const today = todayLocal();
  const valid = form.courseId && form.completedAt && form.provider.trim().length >= 2;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        courseId: form.courseId,
        completedAt: form.completedAt,
        expiresAt: form.expiresAt || null,
        provider: form.provider.trim(),
        certificateNo: form.certificateNo.trim() || null,
        notes: form.notes.trim() || null,
      };
      const next = await api.post<PassportData>(
        employeeId ? `/passports/${employeeId}/records` : '/passports/me/records',
        payload,
      );
      toast('ok', employeeId ? 'Recorded and verified' : 'Filed — HR will verify it. Attach a scan if you have one.');
      onSaved(next);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={employeeId ? `New certificate — ${employeeName}` : 'New certificate'}
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !valid}>
            {busy ? 'Saving…' : employeeId ? 'Save' : 'Submit for approval'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      <p className="muted">
        {employeeId
          ? 'You are recording this on HR’s authority — it counts immediately.'
          : 'Training you completed outside a Gruntech session. It counts once HR has verified it.'}
      </p>
      <Field label="Course" required>
        <select value={form.courseId} onChange={(e) => setForm({ ...form, courseId: e.target.value })}>
          <option value="">Which course does it cover?</option>
          {courses.map((c) => (
            <option key={c.id} value={c.id}>
              {c.code} — {c.title}
            </option>
          ))}
        </select>
      </Field>
      <div className="grid grid-2">
        <Field label="Completed" required>
          <input type="date" max={today} value={form.completedAt} onChange={(e) => setForm({ ...form, completedAt: e.target.value })} />
        </Field>
        <Field
          label="Expires"
          hint={
            course
              ? course.validityMonths
                ? `Blank = ${course.validityMonths} months from completion`
                : 'Blank = never expires'
              : 'Blank = the course’s own validity'
          }
        >
          <input type="date" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />
        </Field>
      </div>
      <div className="grid grid-2">
        <Field label="Issued by" required>
          <input
            value={form.provider}
            onChange={(e) => setForm({ ...form, provider: e.target.value })}
            placeholder="Training provider or agency"
          />
        </Field>
        <Field label="Certificate no.">
          <input value={form.certificateNo} onChange={(e) => setForm({ ...form, certificateNo: e.target.value })} />
        </Field>
      </div>
      <Field label="Notes">
        <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </Field>
    </Modal>
  );
}

function CorrectModal({
  record,
  onClose,
  onSaved,
  onRemove,
}: {
  record: RecordRow;
  onClose: () => void;
  onSaved: (p: PassportData) => void;
  /** Present when the record may be removed: asked in the modal's foot. */
  onRemove?: () => Promise<void>;
}) {
  const toast = useToast();
  const [form, setForm] = useState({
    completedAt: record.completedAt.slice(0, 10),
    expiresAt: record.expiresAt ? record.expiresAt.slice(0, 10) : '',
    provider: record.provider ?? '',
    certificateNo: record.certificateNo ?? '',
    notes: record.notes ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const next = await api.patch<PassportData>(`/passports/records/${record.id}`, {
        completedAt: form.completedAt,
        expiresAt: form.expiresAt || null,
        provider: form.provider.trim(),
        certificateNo: form.certificateNo.trim() || null,
        notes: form.notes.trim() || null,
      });
      toast('ok', 'Corrected');
      onSaved(next);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Modify training record ${record.number ?? record.course.title}`}
      onClose={onClose}
      footer={
        <ModalFoot
          onCancel={onClose}
          busy={busy}
          danger={
            onRemove
              ? {
                  label: 'Remove',
                  question: `Remove ${record.number ?? 'this record'} from the passport? It cannot be undone.`,
                  onConfirm: onRemove,
                }
              : undefined
          }
        >
          <button
            type="button"
            className="btn btn-primary"
            onClick={save}
            disabled={busy || !form.completedAt || form.provider.trim().length < 2}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      <p className="muted">{record.course.title}. A new expiry date earns its own expiry notice.</p>
      <div className="grid grid-2">
        <Field label="Completed" required>
          <input type="date" value={form.completedAt} onChange={(e) => setForm({ ...form, completedAt: e.target.value })} />
        </Field>
        <Field label="Expires" hint="Blank = never expires">
          <input type="date" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />
        </Field>
      </div>
      <div className="grid grid-2">
        <Field label="Issued by" required>
          <input value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} />
        </Field>
        <Field label="Certificate no.">
          <input value={form.certificateNo} onChange={(e) => setForm({ ...form, certificateNo: e.target.value })} />
        </Field>
      </div>
      <Field label="Notes">
        <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </Field>
    </Modal>
  );
}
