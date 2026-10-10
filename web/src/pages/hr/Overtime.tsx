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

/** The printed list says these same words (`OT_STAGE_LABEL` in api/src/routes/hr.ts) — change both. */
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
        printPath="/api/overtime/pdf"
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

/**
 * "New overtime request", and — handed `existing`, a filing still awaiting
 * authorisation — "Modify overtime request …" (PUT /overtime/:id). Saving a
 * change withdraws the request the supervisor has and sends the changed one
 * again, so the act is still "Submit for approval".
 */
function PriorModal({
  existing,
  onClose,
  onFiled,
}: {
  existing?: OtDetail;
  onClose: () => void;
  onFiled: (id: string) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [jobs, setJobs] = useState<{ id: string; number: string; name: string }[]>([]);
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);

  const [form, setForm] = useState({
    date: existing?.date.slice(0, 10) ?? todayLocal(),
    plannedStart: existing?.plannedStart ?? '17:00',
    plannedEnd: existing?.plannedEnd ?? '20:00',
    dinnerBreak: existing?.dinnerBreak ?? true,
    reason: existing?.reason ?? '',
    jobId: existing?.job?.id ?? '',
    costCategoryId: existing?.costCategory?.id ?? '',
  });

  useEffect(() => {
    api
      .get<{
        jobs: typeof jobs;
        categories: typeof categories;
        defaults?: { jobId: string | null; costCategoryId: string | null };
      }>('/overtime/chargeable')
      .then((d) => {
        // A filing being modified keeps the project and budget line it names,
        // even one no longer offered to a new filing.
        const keepJob = existing?.job && !d.jobs.some((j) => j.id === existing.job?.id) ? [existing.job] : [];
        const keepCategory =
          existing?.costCategory && !d.categories.some((c) => c.id === existing.costCategory?.id)
            ? [existing.costCategory]
            : [];
        setJobs([...keepJob, ...d.jobs]);
        setCategories([...keepCategory, ...d.categories]);
        // The job and budget line of this person's last filing, while that job
        // is still open — overtime runs in streaks on one job. Only filled in
        // on a new filing, and only if the person has not already picked one.
        if (existing) return;
        setForm((f) => ({
          ...f,
          jobId: f.jobId || d.defaults?.jobId || '',
          costCategoryId: f.costCategoryId || d.defaults?.costCategoryId || '',
        }));
      })
      .catch(() => {
        // Somebody modifying a filing without the right to file one (HR, say)
        // cannot read the chargeable list: the filing's own still show.
        if (!existing) return;
        setJobs(existing.job ? [existing.job] : []);
        setCategories(existing.costCategory ? [existing.costCategory] : []);
      });
  }, [existing]);

  const preview = usePreview(form.plannedStart, form.plannedEnd, form.dinnerBreak);
  // The preview prices at the VIEWER's rate. A filing being modified is priced
  // at its employee's, which the record carries — the same for one's own, and
  // the only right figure when HR changes somebody else's.
  const ownFiling = !existing || existing.own;
  const rate = existing ? existing.rate : (preview?.rate ?? null);
  const amount = !preview
    ? null
    : !existing
      ? preview.amount
      : rate && !rate.missingRate
        ? Math.round(preview.hours * rate.hourlyRate * rate.multiplier * 100) / 100
        : null;

  async function file() {
    setBusy(true);
    setError(null);
    const body = {
      date: form.date,
      plannedStart: form.plannedStart,
      plannedEnd: form.plannedEnd,
      dinnerBreak: form.dinnerBreak,
      reason: form.reason,
      jobId: form.jobId || null,
      costCategoryId: form.jobId ? form.costCategoryId || null : null,
    };
    try {
      const saved = existing
        ? await api.put<{ id: string }>(`/overtime/${existing.id}`, body)
        : await api.post<{ id: string }>('/overtime', body);
      toast('ok', existing ? 'Changed and sent again for authorisation' : 'Sent to your supervisor for authorisation');
      onFiled(saved.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={existing ? `Modify overtime request ${existing.number}` : 'New overtime request'}
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
        {existing
          ? 'Not authorised yet, so the plan can still change. Saving withdraws the request with the supervisor — they are told — and sends the changed one in its place.'
          : 'This is the authorisation to stay, not a claim. Nothing is charged to a project until you file the hours you actually worked and both approvals are in.'}
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
          {rate?.missingRate ? (
            <>
              {' '}
              {ownFiling ? 'Your' : `${existing?.employee.firstName}’s`} daily rate is not on file, so no
              project cost can be worked out — HR sets that.
            </>
          ) : (
            amount != null && (
              <>
                {' '}
                At {rate?.multiplier ?? preview.settings.overtimeMultiplier}×{' '}
                {ownFiling ? 'the' : `${existing?.employee.firstName}’s`} burdened hourly rate that is{' '}
                <strong>{formatMoney(amount)}</strong> against the project.
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
  /** Each mirrors its route, so a button is never offered that the route refuses. */
  canFileActual: boolean;
  canCancel: boolean;
  /** PUT /overtime/:id — awaiting authorisation (PRIOR), the employee's own or edit_all. */
  canModify: boolean;
  /** POST /overtime/:id/withdraw — actual hours awaiting approval, whoever may file them again. */
  canWithdraw: boolean;
  /** The viewer's own filing; `rate` is always the employee's, whoever reads it. */
  own: boolean;
};

/** What the actual-hours form starts on: the hours just pulled back, to change. */
type ActualPrefill = Pick<OtRow, 'actualStart' | 'actualEnd' | 'dinnerBreak' | 'varianceNote'>;

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
  const [prefill, setPrefill] = useState<ActualPrefill | null>(null);
  const [modifying, setModifying] = useState(false);
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

  /** Asked in the confirm bar first; a refusal is shown there, so these throw. */
  async function cancel() {
    await api.post(`/overtime/${id}/cancel`);
    toast('ok', 'Cancelled');
    load();
  }

  /** The hours come back off the approvers' desks; the form opens on them, to change. */
  async function withdraw() {
    if (!row) return;
    const filed: ActualPrefill = {
      actualStart: row.actualStart,
      actualEnd: row.actualEnd,
      dinnerBreak: row.dinnerBreak,
      varianceNote: row.varianceNote,
    };
    await api.post(`/overtime/${id}/withdraw`);
    toast('ok', 'Pulled back — change the hours and file them again');
    await load();
    setPrefill(filed);
    setFilingActual(true);
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
            <button
              className="btn btn-primary"
              onClick={() => {
                setPrefill(null);
                setFilingActual(true);
              }}
            >
              File the actual hours
            </button>
          )
        }
        more={[
          row.canWithdraw && {
            label: 'Pull back and edit',
            hint: 'Withdraw the actual hours from the approvers, to change and file them again',
            confirm: {
              title: `Pull the hours on ${row.number} back?`,
              body: 'They are withdrawn from the approvers — who are told — and nothing is charged until you file them again and every step approves.',
              confirmLabel: 'Pull back',
              tone: 'primary',
              onConfirm: withdraw,
            },
          },
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
        modify={row.canModify ? () => setModifying(true) : undefined}
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
          actually worked once the work is done. The plan is what was approved: to change it, cancel
          this one and file again.
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
          prefill={prefill}
          onClose={() => setFilingActual(false)}
          onFiled={() => {
            setFilingActual(false);
            setPrefill(null);
            load();
          }}
        />
      )}

      {modifying && (
        <PriorModal
          existing={row}
          onClose={() => setModifying(false)}
          onFiled={() => {
            setModifying(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function ActualModal({
  row,
  prefill,
  onClose,
  onFiled,
}: {
  row: OtRow;
  /** The hours just pulled back: the form is then the modify of them. */
  prefill?: ActualPrefill | null;
  onClose: () => void;
  onFiled: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({
    actualStart: prefill?.actualStart ?? row.plannedStart,
    actualEnd: prefill?.actualEnd ?? row.plannedEnd,
    dinnerBreak: prefill?.dinnerBreak ?? row.dinnerBreak,
    varianceNote: prefill?.varianceNote ?? '',
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
      title={prefill ? `Modify actual hours ${row.number}` : 'File the actual hours'}
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
