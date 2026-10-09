import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import { DocumentApproval } from '../../components/ApprovalStepper';
import {
  StatusBadge,
  type Tone,
  Checkbox,
  ErrorBox,
  Field,
  Loading,
  Modal,
  ModalFoot,
  formatDate,
  formatMoney,
  useToast,
} from '../../components/ui';
import { todayLocal } from '../../lib/day';
import { RecordHeader } from '../../components/RecordHeader';
import { useConfirm } from '../../components/Confirm';

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
const STAGE_TONES: Record<string, Tone> = { PRIOR_APPROVED: 'info' };

function StageBadge({ stage }: { stage: string }) {
  return <StatusBadge status={stage} extra={STAGE_TONES} label={STAGE_LABEL[stage]} />;
}

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
      render: (r) => <StageBadge stage={r.stage} />,
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Overtime</h1>
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
              + New overtime request
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
      .get<{
        jobs: typeof jobs;
        categories: typeof categories;
        defaults?: { jobId: string | null; costCategoryId: string | null };
      }>('/overtime/chargeable')
      .then((d) => {
        setJobs(d.jobs);
        setCategories(d.categories);
        // The job and budget line of this person's last filing, while that job
        // is still open — overtime runs in streaks on one job. Only filled in
        // if the person has not already picked something.
        setForm((f) => ({
          ...f,
          jobId: f.jobId || d.defaults?.jobId || '',
          costCategoryId: f.costCategoryId || d.defaults?.costCategoryId || '',
        }));
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
      title="New overtime request"
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button
            className="btn btn-primary"
            onClick={file}
            disabled={busy || form.reason.trim().length < 5 || !preview || preview.hours <= 0}
          >
            {busy ? 'Submitting…' : 'Submit for approval'}
          </button>
        </ModalFoot>
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
        <div className="alert info hraud-gap-above">
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

type OtDetail = OtRow & {
  rate: Preview['rate'];
  variance: number | null;
  canFileActual: boolean;
  canCancel: boolean;
};

/** Stages at which the actual filing has been made, so its chain exists. */
const ACTUAL_FILED_STAGES = ['ACTUAL_FILED', 'APPROVED'];

export function OvertimeDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [row, setRow] = useState<OtDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [filingActual, setFilingActual] = useState(false);
  const [reload, setReload] = useState(0);

  const load = useCallback(async () => {
    try {
      setRow(await api.get<OtDetail>(`/overtime/${id}`));
      setReload((r) => r + 1);
    } catch (err) {
      setError(err);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (error && !row) return <ErrorBox error={error} />;
  if (!row) return <Loading />;

  const variance = row.actualHours != null ? row.actualHours - row.estimatedHours : null;
  // A rejection can come at either stage; the actual chain exists only if the
  // hours were filed.
  const actualFiled = ACTUAL_FILED_STAGES.includes(row.stage) || row.actualHours != null;
  const employeeName = `${row.employee.firstName} ${row.employee.lastName}`;

  /** Asked in the confirm bar first; a refusal is shown there, so it throws. */
  async function cancel() {
    await api.post(`/overtime/${id}/cancel`);
    toast('ok', 'Cancelled');
    load();
  }

  return (
    <div>
      <RecordHeader
        type="Overtime"
        code={row.number}
        title={`${employeeName} · ${formatDate(row.date)}`}
        status={row.stage}
        statusLabel={STAGE_LABEL[row.stage]}
        statusExtra={STAGE_TONES}
        meta={
          <>
            {can('ghr.employees.view_all') ? (
              <Link to={`/g-hr/employees/${row.employee.id}`} className="mono">
                {row.employee.employeeNo}
              </Link>
            ) : (
              <span className="mono">{row.employee.employeeNo}</span>
            )}{' '}
            · <span className="mono">{row.actualStart ?? row.plannedStart}–{row.actualEnd ?? row.plannedEnd}</span>
            {row.job && (
              <>
                {' '}
                · charged to{' '}
                {can('gops.projects.view_all') || can('gops.projects.view_own') ? (
                  <Link to={`/g-ops/projects/${row.job.id}`}>{row.job.number}</Link>
                ) : (
                  row.job.number
                )}
              </>
            )}
          </>
        }
        actions={
          row.canFileActual && (
            <button className="btn btn-primary" onClick={() => setFilingActual(true)}>
              File the actual hours
            </button>
          )
        }
        more={[
          row.canCancel && {
            label: 'Cancel overtime',
            danger: true,
            confirm: {
              title: `Cancel ${row.number}?`,
              body:
                row.stage === 'PRIOR' || row.stage === 'ACTUAL_FILED'
                  ? 'It is withdrawn from the approvers, and nothing is charged to a project.'
                  : 'Nothing is charged to a project.',
              confirmLabel: 'Cancel overtime',
              onConfirm: cancel,
            },
          },
        ]}
        confirm={confirm}
      />

      <ErrorBox error={error} />

      {row.stage === 'PRIOR' && (
        <div className="alert warn">
          Not authorised yet. Wait for the approval below before working — the actual hours cannot
          be filed until this is granted.
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
          The project is charged when — and only when — every step of the actual filing's approval
          below has approved.
        </div>
      )}

      {/*
        Two approvals against one record, read from the engine rather than
        described: who authorised the work, and who is sitting on the hours.
        The route printed here used to be the workflow's configuration stated
        as fact — "the supervisor, then HR" — which stops being true the day
        somebody edits the workflow.
      */}
      <div className="grid grid-2 hraud-chains">
        <div>
          <h2 className="hraud-chain-label">Before the work — authorisation</h2>
          <DocumentApproval documentType="overtime_prior" documentId={row.id} reloadToken={reload} />
        </div>
        <div>
          <h2 className="hraud-chain-label">After the work — the hours</h2>
          {actualFiled ? (
            <DocumentApproval
              documentType="overtime_request"
              documentId={row.id}
              reloadToken={reload}
            />
          ) : (
            <p className="muted hraud-flush">
              Not filed yet — this approval starts when the actual hours are filed.
            </p>
          )}
        </div>
      </div>

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
            <p className="muted hraud-flush">Not filed yet.</p>
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
              {can('gops.projects.view_all') || can('gops.projects.view_own') ? (
                <Link to={`/g-ops/projects/${row.job.id}`}>
                  <span className="mono">{row.job.number}</span> — {row.job.name}
                </Link>
              ) : (
                <>
                  <span className="mono">{row.job.number}</span> — {row.job.name}
                </>
              )}
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
                <span className="faint">nothing yet — every approval step is needed</span>
              )}
            </dd>
            <dt>Posted</dt>
            <dd>{row.postedAt ? formatDate(row.postedAt) : <span className="faint">not posted</span>}</dd>
          </dl>
        ) : (
          <p className="muted hraud-flush">
            No project chosen, so nothing is charged to a budget. The hours are still approved for
            payroll.
          </p>
        )}
        {row.rate?.missingRate && (
          <div className="alert warn hraud-after hraud-flush">
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
        <ModalFoot onCancel={onClose} busy={busy}>
          <button
            className="btn btn-primary"
            onClick={file}
            disabled={busy || !preview || preview.hours <= 0 || (needsNote && !form.varianceNote.trim())}
          >
            {busy ? 'Submitting…' : 'Submit for approval'}
          </button>
        </ModalFoot>
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
        <div className={`alert ${needsNote ? 'warn' : 'info'} hraud-gap-above`}>
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
