import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import {
  statusTone,
  Checkbox,
  ErrorBox,
  Field,
  Loading,
  Modal,
  formatDate,
  formatMoney,
  useToast,
} from '../../components/ui';
import { todayLocal } from '../../lib/day';

/**
 * Overtime — two filings against one record.
 *
 * First a PRIOR filing, before the work: the estimate, and the supervisor's
 * authorisation. That is the employee's evidence that they were told to stay.
 * It moves no money.
 *
 * Then the ACTUAL filing, after the work: the real times, the variance against
 * the estimate, and an explanation if they differ. That one needs the
 * supervisor AND HR, and only when both have approved does the cost reach the
 * project's budget.
 */

const STAGES = [
  { value: 'PRIOR', label: 'Awaiting authorisation' },
  { value: 'PRIOR_APPROVED', label: 'Authorised — work it' },
  { value: 'ACTUAL_FILED', label: 'Actual filed, awaiting approval' },
  { value: 'APPROVED', label: 'Approved and charged' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

const STAGE_LABEL = Object.fromEntries(STAGES.map((s) => [s.value, s.label]));

/**
 * Overtime differs from the shared rules in one place: PRIOR_APPROVED is
 * informational, not a settled approval, because prior approval moves no money
 * - only the filing does. That is the reason for an override rather than a
 * tenth copy of the whole mapping.
 */
const tone = (stage: string) => statusTone(stage, { PRIOR_APPROVED: 'info' });

interface OtRow {
  id: string;
  number: string;
  stage: string;
  date: string;
  plannedStart: string;
  plannedEnd: string;
  estimatedHours: number;
  actualStart: string | null;
  actualEnd: string | null;
  actualHours: number | null;
  dinnerBreak: boolean;
  reason: string;
  varianceNote: string | null;
  hourlyRate: number | null;
  multiplier: number | null;
  amount: number | null;
  priorApprovedAt: string | null;
  postedAt: string | null;
  employee: { id: string; employeeNo: string; firstName: string; lastName: string; position?: string | null };
  job: { id: string; number: string; name: string } | null;
  costCategory: { id: string; name: string } | null;
}

export function Overtime() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [filing, setFiling] = useState(false);
  const [reload, setReload] = useState(0);

  const columns: Column<OtRow>[] = [
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
          <div className="faint">{r.reason}</div>
        </div>
      ),
    },
    {
      key: 'date',
      label: 'Date',
      sortKey: 'date',
      render: (r) => (
        <div>
          <div>{formatDate(r.date)}</div>
          <div className="faint mono">
            {r.actualStart ?? r.plannedStart}–{r.actualEnd ?? r.plannedEnd}
          </div>
        </div>
      ),
    },
    {
      key: 'hours',
      label: 'Hours',
      align: 'right',
      render: (r) => {
        const variance = r.actualHours != null ? r.actualHours - r.estimatedHours : 0;
        return (
          <div>
            <div className="mono">{r.actualHours ?? r.estimatedHours}</div>
            {r.actualHours != null && Math.abs(variance) > 0.01 && (
              <div className={`faint mono ${variance > 0 ? 'warn' : ''}`}>
                {variance > 0 ? '+' : ''}
                {variance.toFixed(2)} vs est.
              </div>
            )}
          </div>
        );
      },
    },
    {
      key: 'job',
      label: 'Charged to',
      render: (r) =>
        r.job ? (
          <div>
            <div className="mono">{r.job.number}</div>
            <div className="faint">{r.costCategory?.name ?? '—'}</div>
          </div>
        ) : (
          <span className="faint">no project</span>
        ),
    },
    {
      key: 'amount',
      label: 'Cost',
      align: 'right',
      render: (r) =>
        r.amount ? <span className="mono">{formatMoney(r.amount)}</span> : <span className="faint">—</span>,
    },
    {
      key: 'stage',
      label: 'Stage',
      render: (r) => <span className={`badge ${tone(r.stage)}`}>{STAGE_LABEL[r.stage] ?? r.stage}</span>,
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Overtime</h1>
          <p>
            File <strong>before</strong> the work so you have the authorisation in writing, then
            file the hours you actually worked afterwards. The project is charged only once the
            supervisor and HR have both approved the actual filing.
          </p>
        </div>
      </div>

      <DataList<OtRow>
        listKey="overtime"
        endpoint="/overtime"
        columns={columns}
        rowKey={(r) => r.id}
        scoped
        reloadToken={reload}
        searchPlaceholder="Search number, reason, employee…"
        emptyTitle="No overtime filed yet"
        onRowClick={(r) => navigate(`/g-hr/overtime/${r.id}`)}
        filters={[{ key: 'stage', label: 'Stage', options: STAGES }]}
        actions={
          can('ghr.overtime.create') ? (
            <button className="btn btn-primary btn-sm" onClick={() => setFiling(true)}>
              + File prior approval
            </button>
          ) : null
        }
      />

      {filing && (
        <PriorModal
          onClose={() => setFiling(false)}
          onFiled={(id) => {
            setFiling(false);
            setReload((r) => r + 1);
            navigate(`/g-hr/overtime/${id}`);
          }}
        />
      )}
    </div>
  );
}

// ── Filing before the work ───────────────────────────────────────────────────

interface Preview {
  hours: number;
  breakDeducted: boolean;
  rate: { hourlyRate: number; multiplier: number; missingRate: boolean } | null;
  amount: number | null;
  settings: { dinnerBreakStart: string; dinnerBreakEnd: string; overtimeMultiplier: number };
}

function usePreview(start: string, end: string, dinnerBreak: boolean) {
  const [preview, setPreview] = useState<Preview | null>(null);

  useEffect(() => {
    if (!start || !end) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    api
      .post<Preview>('/overtime/preview', { start, end, dinnerBreak })
      .then((p) => !cancelled && setPreview(p))
      .catch(() => !cancelled && setPreview(null));
    return () => {
      cancelled = true;
    };
  }, [start, end, dinnerBreak]);

  return preview;
}

function PriorModal({ onClose, onFiled }: { onClose: () => void; onFiled: (id: string) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [jobs, setJobs] = useState<{ id: string; number: string; name: string }[]>([]);
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);

  const [form, setForm] = useState({
    date: todayLocal(),
    plannedStart: '17:00',
    plannedEnd: '20:00',
    dinnerBreak: true,
    reason: '',
    jobId: '',
    costCategoryId: '',
  });

  useEffect(() => {
    api
      .get<{ jobs: typeof jobs; categories: typeof categories }>('/overtime/chargeable')
      .then((d) => {
        setJobs(d.jobs);
        setCategories(d.categories);
      })
      .catch(() => {});
  }, []);

  const preview = usePreview(form.plannedStart, form.plannedEnd, form.dinnerBreak);

  async function file() {
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<{ id: string }>('/overtime', {
        date: form.date,
        plannedStart: form.plannedStart,
        plannedEnd: form.plannedEnd,
        dinnerBreak: form.dinnerBreak,
        reason: form.reason,
        jobId: form.jobId || null,
        costCategoryId: form.jobId ? form.costCategoryId || null : null,
      });
      toast('ok', 'Sent to your supervisor for authorisation');
      onFiled(created.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="File overtime — prior approval"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={file}
            disabled={busy || form.reason.trim().length < 5 || !preview || preview.hours <= 0}
          >
            {busy ? 'Filing…' : 'Send for authorisation'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <div className="alert info">
        This is the authorisation to stay, not a claim. Nothing is charged to a project until you
        file the hours you actually worked and both approvals are in.
      </div>

      <Field label="Which day?">
        <input
          type="date"
          value={form.date}
          onChange={(e) => setForm({ ...form, date: e.target.value })}
        />
      </Field>

      <div className="grid grid-2">
        <Field label="From">
          <input
            type="time"
            value={form.plannedStart}
            onChange={(e) => setForm({ ...form, plannedStart: e.target.value })}
          />
        </Field>
        <Field label="Until">
          <input
            type="time"
            value={form.plannedEnd}
            onChange={(e) => setForm({ ...form, plannedEnd: e.target.value })}
          />
        </Field>
      </div>

      <Checkbox
        checked={form.dinnerBreak}
        onChange={(v) => setForm({ ...form, dinnerBreak: v })}
        label={`Taking the dinner break${
          preview ? ` (${preview.settings.dinnerBreakStart}–${preview.settings.dinnerBreakEnd})` : ''
        }`}
      />

      {preview && (
        <div className="alert info" style={{ marginTop: 10 }}>
          <strong>{preview.hours}</strong> hour{preview.hours === 1 ? '' : 's'}
          {preview.breakDeducted && preview.hours > 0 && ' after the break'}.
          {preview.rate?.missingRate ? (
            <> Your daily rate is not on file, so no project cost can be worked out — HR sets that.</>
          ) : (
            preview.amount != null && (
              <>
                {' '}
                At {preview.settings.overtimeMultiplier}× the burdened hourly rate that is{' '}
                <strong>{formatMoney(preview.amount)}</strong> against the project.
              </>
            )
          )}
        </div>
      )}

      <Field label="Why is the overtime needed?">
        <input
          value={form.reason}
          onChange={(e) => setForm({ ...form, reason: e.target.value })}
          placeholder="e.g. pressure test must finish before the hospital opens Monday"
        />
      </Field>

      <Field
        label="Charge which project?"
        hint="Leave empty for overtime that belongs to no job — it is still approved, but nothing is charged"
      >
        <select
          value={form.jobId}
          onChange={(e) => setForm({ ...form, jobId: e.target.value })}
        >
          <option value="">— no project —</option>
          {jobs.map((j) => (
            <option key={j.id} value={j.id}>
              {j.number} — {j.name}
            </option>
          ))}
        </select>
      </Field>

      {form.jobId && (
        <Field label="Against which budget line?">
          <select
            value={form.costCategoryId}
            onChange={(e) => setForm({ ...form, costCategoryId: e.target.value })}
          >
            <option value="">— choose —</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      )}
    </Modal>
  );
}

// ── The record ───────────────────────────────────────────────────────────────

export function OvertimeDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const [row, setRow] = useState<(OtRow & { rate: Preview['rate']; variance: number | null }) | null>(
    null,
  );
  const [error, setError] = useState<unknown>(null);
  const [filingActual, setFilingActual] = useState(false);

  const load = useCallback(async () => {
    try {
      setRow(await api.get(`/overtime/${id}`));
    } catch (err) {
      setError(err);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <ErrorBox error={error} />;
  if (!row) return <Loading />;

  const variance = row.actualHours != null ? row.actualHours - row.estimatedHours : null;

  async function cancel() {
    try {
      await api.post(`/overtime/${id}/cancel`);
      toast('ok', 'Cancelled');
      load();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div>
      <div className="breadcrumb">
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/g-hr/overtime')}>
          ← Overtime
        </button>
      </div>

      <div className="page-head">
        <div>
          <h1>
            <span className="mono">{row.number}</span>{' '}
            <span className={`badge ${tone(row.stage)}`}>{STAGE_LABEL[row.stage] ?? row.stage}</span>
          </h1>
          <p>
            {row.employee.firstName} {row.employee.lastName} · {formatDate(row.date)}
          </p>
        </div>
        <div className="row">
          {row.stage === 'PRIOR_APPROVED' && (
            <button className="btn btn-primary btn-sm" onClick={() => setFilingActual(true)}>
              File the actual hours
            </button>
          )}
          {row.stage !== 'APPROVED' && row.stage !== 'CANCELLED' && (
            <button className="btn btn-danger btn-sm" onClick={cancel}>
              Cancel
            </button>
          )}
        </div>
      </div>

      {row.stage === 'PRIOR' && (
        <div className="alert warn">
          Not authorised yet. Wait for your supervisor before working — the actual hours cannot be
          filed until this is granted.
        </div>
      )}
      {row.stage === 'PRIOR_APPROVED' && (
        <div className="alert ok">
          Authorised. This is your evidence that the overtime was directed. File the hours you
          actually worked once the work is done.
        </div>
      )}
      {row.stage === 'ACTUAL_FILED' && (
        <div className="alert info">
          With the approvers. The supervisor who directed the work signs first, then HR. The
          project is charged when — and only when — both have approved.
        </div>
      )}

      <div className="grid grid-2">
        <div className="card">
          <h3 className="card-title">Planned</h3>
          <dl className="kv">
            <dt>Times</dt>
            <dd className="mono">
              {row.plannedStart}–{row.plannedEnd}
            </dd>
            <dt>Estimated</dt>
            <dd className="mono">{row.estimatedHours} h</dd>
            <dt>Dinner break</dt>
            <dd>{row.dinnerBreak ? 'deducted' : 'worked through'}</dd>
            <dt>Reason</dt>
            <dd>{row.reason}</dd>
            <dt>Authorised</dt>
            <dd>{row.priorApprovedAt ? formatDate(row.priorApprovedAt) : <span className="faint">not yet</span>}</dd>
          </dl>
        </div>

        <div className="card">
          <h3 className="card-title">Actual</h3>
          {row.actualHours == null ? (
            <p className="muted" style={{ marginBottom: 0 }}>
              Not filed yet.
            </p>
          ) : (
            <dl className="kv">
              <dt>Times</dt>
              <dd className="mono">
                {row.actualStart}–{row.actualEnd}
              </dd>
              <dt>Worked</dt>
              <dd className="mono">{row.actualHours} h</dd>
              <dt>Variance</dt>
              <dd className={`mono ${variance && Math.abs(variance) > 0.01 ? 'warn' : ''}`}>
                {variance === null || Math.abs(variance) < 0.01
                  ? 'as estimated'
                  : `${variance > 0 ? '+' : ''}${variance.toFixed(2)} h`}
              </dd>
              {row.varianceNote && (
                <>
                  <dt>Explanation</dt>
                  <dd>{row.varianceNote}</dd>
                </>
              )}
            </dl>
          )}
        </div>
      </div>

      <div className="card">
        <h3 className="card-title">What it costs the project</h3>
        {row.job ? (
          <dl className="kv">
            <dt>Project</dt>
            <dd>
              <span className="mono">{row.job.number}</span> — {row.job.name}
            </dd>
            <dt>Budget line</dt>
            <dd>{row.costCategory?.name ?? '—'}</dd>
            <dt>Hourly rate</dt>
            <dd className="mono">
              {formatMoney(row.hourlyRate ?? row.rate?.hourlyRate ?? 0)}
              <span className="faint"> burdened</span>
            </dd>
            <dt>Premium</dt>
            <dd className="mono">{row.multiplier ?? row.rate?.multiplier ?? '—'}×</dd>
            <dt>Charged</dt>
            <dd className="mono">
              {row.amount != null ? (
                formatMoney(row.amount)
              ) : (
                <span className="faint">nothing yet — both approvals are needed</span>
              )}
            </dd>
            <dt>Posted</dt>
            <dd>{row.postedAt ? formatDate(row.postedAt) : <span className="faint">not posted</span>}</dd>
          </dl>
        ) : (
          <p className="muted" style={{ marginBottom: 0 }}>
            No project chosen, so nothing is charged to a budget. The hours are still approved for
            payroll.
          </p>
        )}
        {row.rate?.missingRate && (
          <div className="alert warn" style={{ marginTop: 12, marginBottom: 0 }}>
            {row.employee.firstName} has no daily rate on file, so the project cannot be charged.
            HR sets it on the employee record.
          </div>
        )}
      </div>

      {filingActual && (
        <ActualModal
          row={row}
          onClose={() => setFilingActual(false)}
          onFiled={() => {
            setFilingActual(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function ActualModal({
  row,
  onClose,
  onFiled,
}: {
  row: OtRow;
  onClose: () => void;
  onFiled: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({
    actualStart: row.plannedStart,
    actualEnd: row.plannedEnd,
    dinnerBreak: row.dinnerBreak,
    varianceNote: '',
  });

  const preview = usePreview(form.actualStart, form.actualEnd, form.dinnerBreak);
  const variance = preview ? preview.hours - row.estimatedHours : 0;
  const needsNote = Math.abs(variance) > 0.01;

  async function file() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/overtime/${row.id}/actual`, {
        actualStart: form.actualStart,
        actualEnd: form.actualEnd,
        dinnerBreak: form.dinnerBreak,
        varianceNote: form.varianceNote || null,
      });
      toast('ok', 'Filed — it now needs your supervisor and HR');
      onFiled();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="File the actual hours"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={file}
            disabled={busy || !preview || preview.hours <= 0 || (needsNote && !form.varianceNote.trim())}
          >
            {busy ? 'Filing…' : 'Send for approval'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <p className="muted">
        You were authorised for <strong>{row.estimatedHours} hours</strong> ({row.plannedStart}–
        {row.plannedEnd}). Put in what actually happened.
      </p>

      <div className="grid grid-2">
        <Field label="Started">
          <input
            type="time"
            value={form.actualStart}
            onChange={(e) => setForm({ ...form, actualStart: e.target.value })}
          />
        </Field>
        <Field label="Finished">
          <input
            type="time"
            value={form.actualEnd}
            onChange={(e) => setForm({ ...form, actualEnd: e.target.value })}
          />
        </Field>
      </div>

      <Checkbox
        checked={form.dinnerBreak}
        onChange={(v) => setForm({ ...form, dinnerBreak: v })}
        label="Took the dinner break"
      />

      {preview && (
        <div className={`alert ${needsNote ? 'warn' : 'info'}`} style={{ marginTop: 10 }}>
          <strong>{preview.hours}</strong> hours
          {needsNote ? (
            <>
              {' '}
              — {variance > 0 ? 'more' : 'less'} than the {row.estimatedHours} approved (
              {variance > 0 ? '+' : ''}
              {variance.toFixed(2)} h). The approver sees this.
            </>
          ) : (
            ', exactly as approved.'
          )}
          {preview.amount != null && <> Project cost {formatMoney(preview.amount)}.</>}
        </div>
      )}

      {needsNote && (
        <Field label="Explain the difference" hint="Required — it is what the approver is deciding on">
          <input
            value={form.varianceNote}
            onChange={(e) => setForm({ ...form, varianceNote: e.target.value })}
            placeholder="e.g. the leak test had to be repeated after a fitting failed"
          />
        </Field>
      )}
    </Modal>
  );
}
