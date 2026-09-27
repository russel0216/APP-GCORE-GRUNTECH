import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, openPdf, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import { RecordHeader } from '../../components/RecordHeader';
import { DocumentApproval } from '../../components/ApprovalStepper';
import { Attachments } from '../../components/Attachments';
import { Panel } from '../../components/charts';
import {
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
 * Evaluations — G-HR › People (item 12).
 *
 * Probationary and trainee reviews. The supervisor writes and submits; HR
 * reviews; management approves; the person evaluated reads it once approved
 * and acknowledges it. The employee record changes — regularised, extended,
 * absorbed — only when the last approval lands, on the server, never here.
 *
 * Who is due is derived on read from the hire date, the configured months and
 * the period end (`GET /evaluations/due`); nothing on this screen stores it.
 */

// ── Shapes ───────────────────────────────────────────────────────────────────

/** The module's own statuses, forwarded to statusTone (rule 12). */
export const EVALUATION_TONES: Record<string, Tone> = {
  SCHEDULED: 'info',
  PENDING_APPROVAL: 'warn',
};

export const STATUS_OPTIONS = [
  { value: 'SCHEDULED', label: 'Scheduled' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'PENDING_APPROVAL', label: 'Pending approval' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

const KIND_OPTIONS = [
  { value: 'PROBATIONARY', label: 'Probationary' },
  { value: 'TRAINEE', label: 'Trainee' },
];

export const RECOMMENDATION: Record<string, { label: string; blurb: string }> = {
  REGULARIZE: {
    label: 'Regularise',
    blurb: 'The employee becomes regular from the effective date.',
  },
  EXTEND: {
    label: 'Extend the period',
    blurb: 'Probation continues to a later date, and an end-of-period evaluation falls due again then.',
  },
  END: {
    label: 'End the engagement',
    blurb: 'Nothing changes on the record by itself — HR is told to process the separation through a clearance.',
  },
  ABSORB: {
    label: 'Absorb into probation',
    blurb: 'The trainee becomes probationary from the effective date, with a fresh period. The hire date stays.',
  },
};

interface PersonRef {
  id: string;
  name: string;
  position?: string | null;
}

interface EmployeeRef {
  id: string;
  employeeNo: string;
  firstName: string;
  lastName: string;
  position: string | null;
  employmentType: string;
  department: { id: string; name: string } | null;
}

export interface EvaluationRow {
  id: string;
  number: string;
  kind: string;
  status: string;
  milestone: string;
  milestoneLabel: string;
  dueDate: string | null;
  score: number | null;
  recommendation: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  employee: EmployeeRef;
  evaluator: PersonRef;
}

interface Line {
  id: string;
  criterionKey: string;
  sortOrder: number;
  name: string;
  weight: number;
  rating: number | null;
  remarks: string | null;
}

interface Evaluation {
  id: string;
  number: string;
  kind: string;
  status: string;
  milestone: string;
  milestoneLabel: string;
  dueDate: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  strengths: string | null;
  improvements: string | null;
  comments: string | null;
  recommendation: string | null;
  effectiveDate: string | null;
  extendedTo: string | null;
  score: number | null;
  submittedAt: string | null;
  approvedAt: string | null;
  createdAt: string;
  employeeAcknowledgedAt: string | null;
  employeeAcknowledgementNote: string | null;
  employee: EmployeeRef & { dateHired: string | null; dateRegularized: string | null; periodEndDate: string | null; hasUser: boolean };
  evaluator: PersonRef;
  scheduledBy: PersonRef | null;
  lines: Line[];
  allowedRecommendations: string[];
  canEdit: boolean;
  canCancel: boolean;
  isSubject: boolean;
  ratingScale: number;
  ratingLabels: string[];
}

export interface DueRow {
  employee: EmployeeRef & { dateHired: string | null };
  kind: string;
  milestone: string;
  milestoneLabel: string;
  dueDate: string;
  daysLeft: number;
  overdue: boolean;
  periodEnd: string | null;
  evaluation: { id: string; number: string; status: string } | null;
}

export interface DueResponse {
  asOf: string;
  due: number;
  overdue: number;
  uncovered: number;
  rows: DueRow[];
}

/** What a Schedule button hands the modal. */
export interface SchedulePreset {
  employeeId?: string;
  employeeName?: string;
  milestone?: string;
  dueDate?: string;
}

const fullName = (e: { firstName: string; lastName: string }) => `${e.firstName} ${e.lastName}`;
const dateOnly = (v: string | null | undefined) => (v ? v.slice(0, 10) : '');

/** "in 5 days", "today", "3 days overdue" — the number is the point, so it is always there. */
export function dueText(daysLeft: number): string {
  if (daysLeft === 0) return 'due today';
  if (daysLeft > 0) return `in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
  const late = -daysLeft;
  return `${late} day${late === 1 ? '' : 's'} overdue`;
}

/** The weighted mean the server computes, shown live while the form is edited. */
function liveScore(lines: { weight: number; rating: number | null }[]): number | null {
  let weighted = 0;
  let weights = 0;
  for (const l of lines) {
    if (l.rating == null) continue;
    weighted += l.weight * l.rating;
    weights += l.weight;
  }
  return weights === 0 ? null : Math.round((weighted / weights) * 100) / 100;
}

// ── Who is due ───────────────────────────────────────────────────────────────

/**
 * The due list as a table. Used by the Evaluations page and the HR dashboard
 * panel, so the two cannot show different people.
 */
export function DueTable({
  rows,
  onSchedule,
  scheduleHref,
  limit,
}: {
  rows: DueRow[];
  /** Opens the schedule modal in place (the Evaluations page). */
  onSchedule?: (row: DueRow) => void;
  /** Or links to the Evaluations page with the modal preset (the dashboard). */
  scheduleHref?: (row: DueRow) => string;
  limit?: number;
}) {
  const { can } = useAuth();
  const canCreate = can('ghr.evaluations.create');
  const shown = limit ? rows.slice(0, limit) : rows;

  if (rows.length === 0) {
    return <p className="collection-empty">Nobody is due an evaluation inside the notice window.</p>;
  }

  return (
    <div className="table-wrap">
      <table className="data eval-due">
        <thead>
          <tr>
            <th>Employee</th>
            <th>Evaluation</th>
            <th>Due</th>
            <th className="eval-col-action">
              <span className="visually-hidden">Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={`${r.employee.id}-${r.milestone}-${r.dueDate}`}>
              <td>
                <div>
                  {r.employee.lastName}, {r.employee.firstName}
                </div>
                <div className="faint">
                  <span className="mono">{r.employee.employeeNo}</span>
                  {r.employee.position ? ` · ${r.employee.position}` : ''}
                  {r.employee.department ? ` · ${r.employee.department.name}` : ''}
                </div>
              </td>
              <td>
                <div>{r.milestoneLabel}</div>
                <div className="faint">{humanise(r.kind)}</div>
              </td>
              <td>
                <div className="mono">{formatDate(r.dueDate)}</div>
                <div className={r.overdue ? 'eval-overdue' : 'faint'}>{dueText(r.daysLeft)}</div>
              </td>
              <td className="eval-col-action">
                {r.evaluation ? (
                  <Link to={`/g-hr/evaluations/${r.evaluation.id}`} className="mono">
                    {r.evaluation.number}
                  </Link>
                ) : canCreate && onSchedule ? (
                  <button type="button" className="btn btn-sm" onClick={() => onSchedule(r)}>
                    Schedule
                  </button>
                ) : canCreate && scheduleHref ? (
                  <Link to={scheduleHref(r)} className="btn btn-sm">
                    Schedule
                  </Link>
                ) : (
                  <span className="faint">not scheduled</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {limit && rows.length > limit && (
        <p className="faint eval-more">
          and {rows.length - limit} more — <Link to="/g-hr/evaluations">see them all</Link>
        </p>
      )}
    </div>
  );
}

/** The link a dashboard or notification uses to open the schedule modal preset. */
export function scheduleLink(r: Pick<DueRow, 'employee' | 'milestone' | 'dueDate'>): string {
  return `/g-hr/evaluations${qs({ employeeId: r.employee.id, milestone: r.milestone, due: dateOnly(r.dueDate) })}`;
}

// ── The list ─────────────────────────────────────────────────────────────────

export function Evaluations() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [reload, setReload] = useState(0);
  const [due, setDue] = useState<DueResponse | null>(null);
  const [dueError, setDueError] = useState<unknown>(null);
  const [preset, setPreset] = useState<SchedulePreset | null>(null);

  const viewAll = can('ghr.evaluations.view_all');
  const canCreate = can('ghr.evaluations.create');

  useEffect(() => {
    if (!viewAll) return;
    let live = true;
    api
      .get<DueResponse>('/evaluations/due')
      .then((d) => live && setDue(d))
      .catch((err) => live && setDueError(err));
    return () => {
      live = false;
    };
  }, [viewAll, reload]);

  // A notification or the dashboard links here with the milestone to schedule.
  useEffect(() => {
    const employeeId = params.get('employeeId');
    const milestone = params.get('milestone');
    if (!employeeId || !milestone || !canCreate) return;
    setPreset({ employeeId, milestone, dueDate: params.get('due') ?? undefined });
    const next = new URLSearchParams(params);
    next.delete('employeeId');
    next.delete('milestone');
    next.delete('due');
    setParams(next, { replace: true });
    // Read once on arrival; the params are consumed above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const columns: Column<EvaluationRow>[] = [
    {
      key: 'number',
      label: 'Number',
      sortKey: 'number',
      width: '150px',
      render: (r) => (
        <Link to={`/g-hr/evaluations/${r.id}`} className="mono" onClick={(e) => e.stopPropagation()}>
          {r.number}
        </Link>
      ),
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
            {r.employee.position ?? humanise(r.employee.employmentType)}
            {r.employee.department ? ` · ${r.employee.department.name}` : ''}
          </div>
        </div>
      ),
    },
    {
      key: 'milestone',
      label: 'Evaluation',
      render: (r) => (
        <div>
          <div>{r.milestoneLabel}</div>
          <div className="faint">{humanise(r.kind)}</div>
        </div>
      ),
    },
    {
      key: 'dueDate',
      label: 'Due',
      sortKey: 'dueDate',
      render: (r) => <span className="mono">{formatDate(r.dueDate)}</span>,
    },
    {
      key: 'evaluator',
      label: 'Evaluator',
      render: (r) => r.evaluator.name,
    },
    {
      key: 'score',
      label: 'Score',
      align: 'right',
      render: (r) => (r.score == null ? <span className="faint">—</span> : <span className="mono">{r.score.toFixed(2)}</span>),
    },
    {
      key: 'recommendation',
      label: 'Recommendation',
      optional: true,
      render: (r) => (r.recommendation ? RECOMMENDATION[r.recommendation]?.label ?? humanise(r.recommendation) : <span className="faint">—</span>),
    },
    {
      key: 'status',
      label: 'Status',
      sortKey: 'status',
      render: (r) => <StatusBadge status={r.status} extra={EVALUATION_TONES} />,
    },
  ];

  const newButton = canCreate ? (
    <button type="button" className="btn btn-primary btn-sm" onClick={() => setPreset({})}>
      + New evaluation
    </button>
  ) : null;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Evaluations</h1>
          <p>
            Probationary and trainee reviews. The supervisor rates and recommends, HR reviews, and
            management approves — regularisation, an extension or an absorption happens only when
            the last approval lands. The person evaluated reads it once it is approved.
          </p>
        </div>
      </div>

      {viewAll && (
        <div className="eval-due-block">
        <Panel
          title="Due for evaluation"
          blurb={
            due
              ? `${due.due} milestone${due.due === 1 ? '' : 's'} inside the notice window or past it${
                  due.overdue ? `, ${due.overdue} overdue` : ''
                }. Worked out from each hire date and period end every time this page opens.`
              : undefined
          }
        >
          <ErrorBox error={dueError} />
          {!due && !dueError ? (
            <Loading label="Working out who is due…" />
          ) : due ? (
            <DueTable
              rows={due.rows}
              onSchedule={(r) =>
                setPreset({
                  employeeId: r.employee.id,
                  employeeName: `${fullName(r.employee)} (${r.employee.employeeNo})`,
                  milestone: r.milestone,
                  dueDate: dateOnly(r.dueDate),
                })
              }
            />
          ) : null}
        </Panel>
        </div>
      )}

      <DataList<EvaluationRow>
        listKey="evaluations"
        endpoint="/evaluations"
        columns={columns}
        rowKey={(r) => r.id}
        scoped
        reloadToken={reload}
        searchPlaceholder="Search number or employee…"
        emptyTitle="No evaluations yet"
        emptyHint={
          viewAll
            ? 'Schedule one from the due list above, or open one for anybody on probation or training.'
            : 'Evaluations you write, and your own once approved, appear here.'
        }
        emptyAction={newButton}
        onRowClick={(r) => navigate(`/g-hr/evaluations/${r.id}`)}
        filters={[
          { key: 'status', label: 'Status', options: STATUS_OPTIONS },
          { key: 'kind', label: 'Kind', options: KIND_OPTIONS },
        ]}
        actions={newButton}
      />

      {preset && (
        <ScheduleModal
          preset={preset}
          onClose={() => setPreset(null)}
          onCreated={(id) => {
            setPreset(null);
            setReload((n) => n + 1);
            navigate(`/g-hr/evaluations/${id}`);
          }}
        />
      )}
    </div>
  );
}

// ── Open or schedule ─────────────────────────────────────────────────────────

interface EmployeeLookup {
  id: string;
  employeeNo: string;
  firstName: string;
  lastName: string;
  position: string | null;
  employmentType: string;
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

interface MilestonePicture {
  kind: string | null;
  anchor: string | null;
  periodEnd: string | null;
  milestones: {
    milestone: string;
    label: string;
    dueDate: string;
    daysLeft: number;
    evaluation: { id: string; number: string; status: string; recommendation: string | null } | null;
  }[];
}

const FALLBACK_MILESTONES = [
  { value: 'MONTH_3', label: 'Month 3' },
  { value: 'MONTH_5', label: 'Month 5' },
  { value: 'END', label: 'End of period' },
];

/**
 * Opens an evaluation. Evaluating yourself-as-the-writer is a plain create;
 * naming somebody else as the evaluator schedules it for them and tells them.
 * Only HR (view_all) chooses an evaluator; a supervisor writes their own.
 */
export function ScheduleModal({
  preset,
  onClose,
  onCreated,
}: {
  preset: SchedulePreset;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { me, can } = useAuth();
  const toast = useToast();
  const viewAll = can('ghr.evaluations.view_all');

  const [search, setSearch] = useState('');
  const [people, setPeople] = useState<EmployeeLookup[]>([]);
  const [evaluators, setEvaluators] = useState<UserLookup[]>([]);
  const [picture, setPicture] = useState<MilestonePicture | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({
    employeeId: preset.employeeId ?? '',
    milestone: preset.milestone ?? '',
    evaluatorId: me?.user.id ?? '',
    dueDate: preset.dueDate ?? '',
  });

  // Only people an evaluation is for: probationary and trainee staff.
  useEffect(() => {
    if (preset.employeeId) return;
    let live = true;
    const t = window.setTimeout(() => {
      api
        .get<EmployeeLookup[]>(`/employees/lookup${qs({ q: search, active: 'true' })}`)
        .then((rows) => live && setPeople(rows.filter((r) => r.employmentType === 'PROBATIONARY' || r.employmentType === 'TRAINEE')))
        .catch(() => live && setPeople([]));
    }, 200);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [search, preset.employeeId]);

  useEffect(() => {
    if (!viewAll) return;
    api
      .get<UserLookup[]>(`/users/lookup${qs({ holding: 'ghr.evaluations.create' })}`)
      .then(setEvaluators)
      .catch(() => setEvaluators([]));
  }, [viewAll]);

  // The milestones this person's period calls for — HR can read them; a
  // supervisor picks from the usual three.
  useEffect(() => {
    setPicture(null);
    if (!form.employeeId || !viewAll) return;
    let live = true;
    api
      .get<MilestonePicture>(`/evaluations/milestones/${form.employeeId}`)
      .then((p) => live && setPicture(p))
      .catch(() => live && setPicture(null));
    return () => {
      live = false;
    };
  }, [form.employeeId, viewAll]);

  const milestoneOptions = useMemo(() => {
    const base = picture
      ? picture.milestones.map((m) => ({
          value: m.milestone,
          label: `${m.label} — ${formatDate(m.dueDate)}${m.evaluation ? ` (${m.evaluation.number}, ${humanise(m.evaluation.status).toLowerCase()})` : ''}`,
        }))
      : FALLBACK_MILESTONES;
    return [...base, { value: 'ADHOC', label: 'Ad hoc — outside the schedule' }];
  }, [picture]);

  const chosen = people.find((p) => p.id === form.employeeId);
  const valid = !!form.employeeId && !!form.milestone && !!form.evaluatorId;
  const mine = form.evaluatorId === me?.user.id;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body = {
        employeeId: form.employeeId,
        milestone: form.milestone,
        evaluatorId: form.evaluatorId,
        dueDate: form.dueDate || null,
      };
      const created = await api.post<{ id: string; number: string }>(mine ? '/evaluations' : '/evaluations/schedule', body);
      toast('ok', mine ? `${created.number} opened` : `${created.number} scheduled — the evaluator has been told`);
      onCreated(created.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={preset.milestone ? 'Schedule an evaluation' : 'New evaluation'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !valid}>
            {busy ? 'Opening…' : mine ? 'Open and start writing' : 'Schedule and tell the evaluator'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />

      {preset.employeeId ? (
        <Field label="Employee">
          <input value={preset.employeeName ?? chosen?.employeeNo ?? 'Selected employee'} readOnly />
        </Field>
      ) : (
        <>
          <Field label="Find the employee" hint="Probationary and trainee staff only — nobody else is evaluated here">
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name or employee number" />
          </Field>
          <Field label="Employee" required>
            <select value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value, milestone: '' })}>
              <option value="">— choose —</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.lastName}, {p.firstName} · {p.employeeNo} · {humanise(p.employmentType)}
                  {p.department ? ` · ${p.department.name}` : ''}
                </option>
              ))}
            </select>
          </Field>
        </>
      )}

      <Field label="Milestone" required hint={picture?.periodEnd ? `The current period ends ${formatDate(picture.periodEnd)}` : undefined}>
        <select
          value={form.milestone}
          onChange={(e) => {
            const m = picture?.milestones.find((x) => x.milestone === e.target.value);
            setForm({ ...form, milestone: e.target.value, dueDate: m ? dateOnly(m.dueDate) : form.dueDate });
          }}
          disabled={!form.employeeId}
        >
          <option value="">— choose —</option>
          {milestoneOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>

      {viewAll && (
        <Field label="Evaluator" required hint="Usually the person they report to. Somebody else is told it is theirs to write.">
          <select value={form.evaluatorId} onChange={(e) => setForm({ ...form, evaluatorId: e.target.value })}>
            {me && !evaluators.some((u) => u.id === me.user.id) && <option value={me.user.id}>{me.user.name} (you)</option>}
            {evaluators.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
                {u.id === me?.user.id ? ' (you)' : ''}
                {u.position ? ` · ${u.position}` : ''}
                {u.department ? ` · ${u.department.name}` : ''}
              </option>
            ))}
          </select>
        </Field>
      )}

      <Field label="Due" hint="Leave blank to use the milestone's own date, so the due list recognises it">
        <input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
      </Field>
    </Modal>
  );
}

// ── The evaluation ───────────────────────────────────────────────────────────

interface Draft {
  lines: Record<string, { rating: number | null; remarks: string }>;
  strengths: string;
  improvements: string;
  comments: string;
  recommendation: string;
  effectiveDate: string;
  extendedTo: string;
}

function draftOf(ev: Evaluation): Draft {
  return {
    lines: Object.fromEntries(ev.lines.map((l) => [l.id, { rating: l.rating, remarks: l.remarks ?? '' }])),
    strengths: ev.strengths ?? '',
    improvements: ev.improvements ?? '',
    comments: ev.comments ?? '',
    recommendation: ev.recommendation ?? '',
    effectiveDate: dateOnly(ev.effectiveDate),
    extendedTo: dateOnly(ev.extendedTo),
  };
}

function outcomeText(ev: Evaluation): string {
  switch (ev.recommendation) {
    case 'REGULARIZE':
      return `Regularised${ev.effectiveDate ? ` effective ${formatDate(ev.effectiveDate)}` : ''}.`;
    case 'EXTEND':
      return `Probation extended to ${formatDate(ev.extendedTo)}.`;
    case 'ABSORB':
      return `Absorbed into probation${ev.effectiveDate ? ` from ${formatDate(ev.effectiveDate)}` : ''}.`;
    case 'END':
      return 'The engagement is to end — HR processes the separation through a clearance.';
    default:
      return 'Approved.';
  }
}

export function EvaluationDetail() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();

  const [ev, setEv] = useState<Evaluation | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [approvalToken, setApprovalToken] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const [acknowledging, setAcknowledging] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const data = await api.get<Evaluation>(`/evaluations/${id}`);
      setEv(data);
      setDraft(draftOf(data));
      setDirty(false);
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

  if (loading) return <Loading label="Opening the evaluation…" />;
  if (!ev || !draft) {
    return (
      <div>
        <div className="breadcrumb">
          <Link to="/g-hr/evaluations">Evaluations</Link>
        </div>
        <ErrorBox error={error ?? new Error('Evaluation not found')} />
      </div>
    );
  }

  const editing = ev.canEdit;
  const name = fullName(ev.employee);
  const scale = Array.from({ length: ev.ratingScale }, (_, i) => i + 1);
  const shownLines = ev.lines.map((l) => ({ ...l, rating: editing ? draft.lines[l.id]?.rating ?? null : l.rating }));
  const score = editing ? liveScore(shownLines) : ev.score;
  const rated = shownLines.filter((l) => l.rating != null).length;
  const rec = editing ? draft.recommendation : ev.recommendation ?? '';

  const edit = (patch: Partial<Draft>) => {
    setDraft({ ...draft, ...patch });
    setDirty(true);
  };
  const editLine = (lineId: string, patch: Partial<Draft['lines'][string]>) => {
    setDraft({ ...draft, lines: { ...draft.lines, [lineId]: { ...draft.lines[lineId], ...patch } } });
    setDirty(true);
  };

  function payload() {
    return {
      lines: ev!.lines.map((l) => ({
        id: l.id,
        rating: draft!.lines[l.id]?.rating ?? null,
        remarks: draft!.lines[l.id]?.remarks || null,
      })),
      strengths: draft!.strengths || null,
      improvements: draft!.improvements || null,
      comments: draft!.comments || null,
      recommendation: draft!.recommendation || null,
      effectiveDate: draft!.effectiveDate || null,
      extendedTo: draft!.recommendation === 'EXTEND' ? draft!.extendedTo || null : null,
    };
  }

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await load();
      setApprovalToken((n) => n + 1);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  const saveDraft = () =>
    run('save', async () => {
      await api.patch(`/evaluations/${ev.id}`, payload());
      toast('ok', 'Saved');
    });

  const submit = () =>
    run('submit', async () => {
      if (dirty || ev.status === 'SCHEDULED') await api.patch(`/evaluations/${ev.id}`, payload());
      await api.post(`/evaluations/${ev.id}/submit`);
      toast('ok', 'Submitted — HR reviews it next');
    });

  const printIt = () => openPdf(`/api/evaluations/${ev.id}/pdf`, () => toast('error', 'Could not open the PDF'));

  const ready = rated === ev.lines.length && !!rec && (rec !== 'EXTEND' || !!draft.extendedTo);

  return (
    <div className="eval-page">
      <div className="breadcrumb">
        <Link to="/g-hr/evaluations">Evaluations</Link>
        <span className="sep">›</span>
        <span className="mono">{ev.number}</span>
      </div>

      <RecordHeader
        type="Employee Evaluation"
        code={ev.number}
        title={`${name} — ${ev.milestoneLabel}`}
        status={ev.status}
        statusExtra={EVALUATION_TONES}
        amount={score == null ? undefined : `${score.toFixed(2)} / ${ev.ratingScale}`}
        amountLabel="Weighted score"
        actions={
          <>
            {editing && (
              <button type="button" className="btn" onClick={saveDraft} disabled={busy !== null || !dirty}>
                {busy === 'save' ? 'Saving…' : 'Save draft'}
              </button>
            )}
            {editing && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={submit}
                disabled={busy !== null || !ready}
                title={ready ? undefined : 'Rate every criterion and choose a recommendation first'}
              >
                {busy === 'submit' ? 'Submitting…' : 'Submit for approval'}
              </button>
            )}
            {ev.isSubject && ev.status === 'APPROVED' && !ev.employeeAcknowledgedAt && (
              <button type="button" className="btn btn-primary" onClick={() => setAcknowledging(true)}>
                Acknowledge
              </button>
            )}
            <button type="button" className="btn" onClick={printIt}>
              Print
            </button>
            {ev.canCancel && (
              <button type="button" className="btn btn-danger" onClick={() => setCancelling(true)} disabled={busy !== null}>
                Cancel evaluation
              </button>
            )}
          </>
        }
      />

      <p className="record-head-meta eval-meta">
        <strong>{humanise(ev.kind)}</strong> evaluation · <span className="mono">{ev.employee.employeeNo}</span>
        {ev.employee.position ? ` · ${ev.employee.position}` : ''}
        {ev.employee.department ? ` · ${ev.employee.department.name}` : ''} · hired {formatDate(ev.employee.dateHired)} · due{' '}
        {formatDate(ev.dueDate)} · evaluator <strong>{ev.evaluator.name}</strong>
        {ev.scheduledBy && ev.scheduledBy.id !== ev.evaluator.id ? ` · scheduled by ${ev.scheduledBy.name}` : ''}
      </p>

      <ErrorBox error={error} />

      {ev.status === 'SCHEDULED' && editing && (
        <div className="alert info">
          Assigned to you{ev.scheduledBy ? ` by ${ev.scheduledBy.name}` : ''}. Rate each criterion, choose a
          recommendation and submit — HR reviews it, then management approves.
        </div>
      )}
      {ev.status === 'PENDING_APPROVAL' && (
        <div className="alert warn">
          With HR, then management. Nothing changes on {name}'s record until the last step approves.
        </div>
      )}
      {ev.status === 'APPROVED' && (
        <div className="alert ok">
          Approved {formatDateTime(ev.approvedAt)}. {outcomeText(ev)}
          {ev.employeeAcknowledgedAt
            ? ` ${name} acknowledged it ${formatDateTime(ev.employeeAcknowledgedAt)}.`
            : ev.employee.hasUser
              ? ` ${ev.isSubject ? 'Please read it and acknowledge it.' : `${name} has not acknowledged it yet.`}`
              : ` ${name} has no login — print it for them to sign.`}
        </div>
      )}
      {ev.status === 'REJECTED' && (
        <div className="alert error">Rejected — nothing changed on the employee record. The milestone falls due again for a fresh evaluation.</div>
      )}
      {ev.status === 'CANCELLED' && <div className="alert">Cancelled. It covers nothing, and the milestone is due again.</div>}

      <div className="eval-body">
        <section className="card eval-ratings" aria-label="Ratings">
          <div className="panel-head eval-ratings-head">
            <h3 className="card-title">Ratings</h3>
            <span className="faint">
              {rated} of {ev.lines.length} rated · 1 is {ev.ratingLabels[0]?.toLowerCase()}, {ev.ratingScale} is{' '}
              {ev.ratingLabels[ev.ratingScale - 1]?.toLowerCase()}
            </span>
          </div>

          <ol className="eval-lines">
            {shownLines.map((l) => (
              <li key={l.id} className="eval-line">
                <fieldset className="eval-scale" disabled={!editing}>
                  <legend>
                    <span className="eval-line-name">{l.name}</span>
                    {l.weight !== 1 && <span className="faint"> · weight {l.weight}</span>}
                  </legend>
                  {editing ? (
                    <div className="eval-scale-options" role="radiogroup" aria-label={l.name}>
                      {scale.map((n) => (
                        <label key={n} className={`eval-scale-option${l.rating === n ? ' on' : ''}`} title={ev.ratingLabels[n - 1]}>
                          <input
                            type="radio"
                            name={`rating-${l.id}`}
                            value={n}
                            checked={l.rating === n}
                            onChange={() => editLine(l.id, { rating: n })}
                          />
                          <span className="eval-scale-num">{n}</span>
                          <span className="eval-scale-label">{ev.ratingLabels[n - 1]}</span>
                        </label>
                      ))}
                    </div>
                  ) : (
                    <div className="eval-rated">
                      {l.rating == null ? (
                        <span className="faint">Not rated</span>
                      ) : (
                        <>
                          <span className="mono eval-rated-num">
                            {l.rating} / {ev.ratingScale}
                          </span>{' '}
                          {ev.ratingLabels[l.rating - 1]}
                        </>
                      )}
                    </div>
                  )}
                </fieldset>
                {editing ? (
                  <Field label={`Remarks on ${l.name.toLowerCase()}`}>
                    <input
                      value={draft.lines[l.id]?.remarks ?? ''}
                      onChange={(e) => editLine(l.id, { remarks: e.target.value })}
                      placeholder="Optional — what you saw"
                    />
                  </Field>
                ) : (
                  l.remarks && <p className="eval-remarks">{l.remarks}</p>
                )}
              </li>
            ))}
          </ol>
        </section>

        <div className="stack eval-side">
          <section className="card" aria-label="Recommendation">
            <h3 className="card-title">Recommendation</h3>
            {editing ? (
              <fieldset className="eval-recs">
                <legend className="visually-hidden">Recommendation</legend>
                {ev.allowedRecommendations.map((r) => (
                  <label key={r} className={`eval-rec${draft.recommendation === r ? ' on' : ''}`}>
                    <input
                      type="radio"
                      name="recommendation"
                      value={r}
                      checked={draft.recommendation === r}
                      onChange={() => edit({ recommendation: r })}
                    />
                    <span>
                      <strong>{RECOMMENDATION[r]?.label ?? humanise(r)}</strong>
                      <span className="faint eval-rec-blurb">{RECOMMENDATION[r]?.blurb}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
            ) : rec ? (
              <p className="eval-rec-read">
                <strong>{RECOMMENDATION[rec]?.label ?? humanise(rec)}</strong>
                <span className="faint eval-rec-blurb">{RECOMMENDATION[rec]?.blurb}</span>
              </p>
            ) : (
              <p className="collection-empty">No recommendation yet.</p>
            )}

            {editing && rec === 'EXTEND' && (
              <Field label="Extend the period to" required hint={ev.employee.periodEndDate ? `It currently ends ${formatDate(ev.employee.periodEndDate)}` : undefined}>
                <input type="date" value={draft.extendedTo} onChange={(e) => edit({ extendedTo: e.target.value })} />
              </Field>
            )}
            {editing && rec && rec !== 'EXTEND' && (
              <Field label="Effective" hint="Leave blank to take effect on the day it is approved">
                <input type="date" value={draft.effectiveDate} onChange={(e) => edit({ effectiveDate: e.target.value })} />
              </Field>
            )}
            {!editing && ev.recommendation === 'EXTEND' && (
              <dl className="kv">
                <dt>Extended to</dt>
                <dd>{formatDate(ev.extendedTo)}</dd>
              </dl>
            )}
            {!editing && ev.recommendation && ev.recommendation !== 'EXTEND' && ev.effectiveDate && (
              <dl className="kv">
                <dt>Effective</dt>
                <dd>{formatDate(ev.effectiveDate)}</dd>
              </dl>
            )}
          </section>

          <section className="card" aria-label="Written feedback">
            <h3 className="card-title">Written feedback</h3>
            {editing ? (
              <>
                <Field label="Strengths">
                  <textarea rows={3} value={draft.strengths} onChange={(e) => edit({ strengths: e.target.value })} />
                </Field>
                <Field label="Areas for improvement">
                  <textarea rows={3} value={draft.improvements} onChange={(e) => edit({ improvements: e.target.value })} />
                </Field>
                <Field label="Comments">
                  <textarea rows={3} value={draft.comments} onChange={(e) => edit({ comments: e.target.value })} />
                </Field>
              </>
            ) : ev.strengths || ev.improvements || ev.comments ? (
              <dl className="eval-feedback">
                {ev.strengths && (
                  <>
                    <dt>Strengths</dt>
                    <dd>{ev.strengths}</dd>
                  </>
                )}
                {ev.improvements && (
                  <>
                    <dt>Areas for improvement</dt>
                    <dd>{ev.improvements}</dd>
                  </>
                )}
                {ev.comments && (
                  <>
                    <dt>Comments</dt>
                    <dd>{ev.comments}</dd>
                  </>
                )}
              </dl>
            ) : (
              <p className="collection-empty">Nothing written.</p>
            )}
          </section>

          {ev.employeeAcknowledgedAt && (
            <section className="card" aria-label="Acknowledgement">
              <h3 className="card-title">Acknowledged</h3>
              <p className="eval-flush">
                {name}, {formatDateTime(ev.employeeAcknowledgedAt)}
              </p>
              {ev.employeeAcknowledgementNote && <p className="eval-remarks">{ev.employeeAcknowledgementNote}</p>}
            </section>
          )}
        </div>
      </div>

      <DocumentApproval documentType="evaluation" documentId={ev.id} reloadToken={approvalToken} />

      <div className="eval-attachments">
        <Attachments
          entityType="evaluation"
          entityId={ev.id}
          title="Supporting documents"
          hint="Anything the rating rests on — a training record, an incident report, a signed copy."
          canEdit={editing}
        />
      </div>

      {cancelling && (
        <ConfirmModal
          title={`Cancel ${ev.number}?`}
          body={
            ev.status === 'PENDING_APPROVAL'
              ? 'It is withdrawn from the approval chain. Nothing changes on the employee record, and the milestone falls due again.'
              : 'Nothing changes on the employee record, and the milestone falls due again.'
          }
          confirm="Cancel evaluation"
          danger
          onClose={() => setCancelling(false)}
          onConfirm={async () => {
            await api.post(`/evaluations/${ev.id}/cancel`);
            toast('ok', `${ev.number} cancelled`);
            setCancelling(false);
            await load();
            setApprovalToken((n) => n + 1);
          }}
        />
      )}

      {acknowledging && (
        <AcknowledgeModal
          evaluation={ev}
          onClose={() => setAcknowledging(false)}
          onDone={async () => {
            setAcknowledging(false);
            toast('ok', 'Acknowledged');
            await load();
          }}
        />
      )}
    </div>
  );
}

function ConfirmModal({
  title,
  body,
  confirm,
  danger,
  onClose,
  onConfirm,
}: {
  title: string;
  body: string;
  confirm: string;
  danger?: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Keep it
          </button>
          <button
            type="button"
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onConfirm();
              } catch (err) {
                setError(err);
                setBusy(false);
              }
            }}
          >
            {busy ? 'Working…' : confirm}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <p className="muted">{body}</p>
    </Modal>
  );
}

/** Receipt, not agreement — the note is where somebody who disagrees says so. */
function AcknowledgeModal({
  evaluation,
  onClose,
  onDone,
}: {
  evaluation: Evaluation;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function acknowledge() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/evaluations/${evaluation.id}/acknowledge`, { note: note.trim() || null });
      await onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Acknowledge ${evaluation.number}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Not now
          </button>
          <button type="button" className="btn btn-primary" onClick={acknowledge} disabled={busy}>
            {busy ? 'Recording…' : 'I have read it'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <p className="muted">
        Acknowledging says you have read this evaluation. It does not say you agree with it — if you
        do not, say so in the note, and it prints with the evaluation.
      </p>
      <Field label="Your note" hint="Optional">
        <textarea rows={4} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Modal>
  );
}
