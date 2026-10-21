import { useCallback, useEffect, useId, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import { RecordHeader } from '../../components/RecordHeader';
import { useConfirm } from '../../components/Confirm';
import { Attachments } from '../../components/Attachments';
import { NumberInput } from '../../components/NumberInput';
import { ApprovalStepper, DocumentApproval, DecisionNote, allHeld, previewSteps } from '../../components/ApprovalStepper';
import { ActiveBadge, Empty, ErrorBox, Field, Loading, Modal, ModalFoot, StatusBadge, formatDate, formatMoney, useToast, type Tone } from '../../components/ui';
import { MiniBar, Stat } from '../../components/charts';
import { NewPersonModal } from '../masters/Employees';

/**
 * G-HR › HIRING (2026-10-21, the owner's Hiring module): the Man Power
 * Request a hiring manager raises, the candidates gathered against it, the
 * entrance exams and their analytics, and the employment contract — routed
 * through the one engine, printed for the wet signature (no online link:
 * the hire has no G-CORE access yet), and closed by the hire, which makes
 * the employee record through the one employee form.
 */

const EMPLOYMENT_TYPES = [
  ['PROBATIONARY', 'Probationary'],
  ['REGULAR', 'Regular'],
  ['PROJECT_BASED', 'Project-based'],
  ['CONTRACTUAL', 'Contractual'],
  ['PART_TIME', 'Part-time'],
  ['TRAINEE', 'Trainee'],
] as const;

export const MPR_TONES: Record<string, Tone> = { DRAFT: '', PENDING_APPROVAL: 'warn', APPROVED: 'ok', FILLED: 'info', CANCELLED: '' };
const MPR_LABEL: Record<string, string> = { DRAFT: 'Draft', PENDING_APPROVAL: 'Pending approval', APPROVED: 'Open', FILLED: 'Filled', CANCELLED: 'Cancelled' };

export const CANDIDATE_TONES: Record<string, Tone> = {
  APPLIED: '',
  UNDER_SCREENING: 'info',
  EXAM_SCHEDULED: 'warn',
  EXAM_DONE: 'info',
  INTERVIEW_SCHEDULED: 'warn',
  INTERVIEW_PASSED: 'ok',
  INTERVIEW_FAILED: 'danger',
  CONTRACT_STAGE: 'ok',
  HIRED: 'ok',
  DECLINED: 'danger',
  WITHDRAWN: '',
};
export const CANDIDATE_LABEL: Record<string, string> = {
  APPLIED: 'Applied',
  UNDER_SCREENING: 'Under screening',
  EXAM_SCHEDULED: 'Exam scheduled',
  EXAM_DONE: 'Exam done',
  INTERVIEW_SCHEDULED: 'Interview scheduled',
  INTERVIEW_PASSED: 'Interview passed',
  INTERVIEW_FAILED: 'Interview failed',
  CONTRACT_STAGE: 'Contract stage',
  HIRED: 'Hired',
  DECLINED: 'Declined',
  WITHDRAWN: 'Withdrawn',
};

export const CONTRACT_TONES: Record<string, Tone> = { DRAFT: '', PENDING_APPROVAL: 'warn', APPROVED: 'info', SIGNED: 'ok', CANCELLED: '' };
const CONTRACT_LABEL: Record<string, string> = { DRAFT: 'Draft', PENDING_APPROVAL: 'Pending approval', APPROVED: 'Approved — to sign', SIGNED: 'Signed', CANCELLED: 'Cancelled' };

const candidateBadge = (s: string) => <StatusBadge status={s} extra={CANDIDATE_TONES} label={CANDIDATE_LABEL[s] ?? s} />;
const typeLabel = (t: string) => EMPLOYMENT_TYPES.find(([k]) => k === t)?.[1] ?? t;
const pct = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(1)}%`);

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

type Route = { name: string; steps: { name: string; held?: boolean; approvers: { id: string; name: string }[] }[] } | null;

function RoutePreview({ route }: { route: Route }) {
  if (!route || !route.steps.length) return null;
  return (
    <div className="qd-route">
      <span className="qd-route-label">{allHeld(route) ? 'No one else’s approval needed — you hold every step' : 'Submit for approval sends it to'}</span>
      <ApprovalStepper steps={previewSteps(route)} />
    </div>
  );
}

interface Option {
  id: string;
  code?: string;
  name?: string;
  title?: string;
  isActive?: boolean;
}

function useTeams() {
  const [rows, setRows] = useState<Option[]>([]);
  useEffect(() => {
    api.get<Option[]>('/reference/industries?active=true').then(setRows).catch(() => setRows([]));
  }, []);
  return rows;
}

function usePositions(enabled: boolean) {
  const [rows, setRows] = useState<Option[]>([]);
  useEffect(() => {
    if (!enabled) return;
    api.get<Option[]>('/positions/lookup').then(setRows).catch(() => setRows([]));
  }, [enabled]);
  return rows;
}

// ═════════════════════════════════════════════════════════════════════════════
// MAN POWER REQUEST
// ═════════════════════════════════════════════════════════════════════════════

interface MprRow {
  id: string;
  number: string;
  title: string;
  headcount: number;
  salaryMin: number | null;
  salaryMax: number | null;
  education: string | null;
  licenses: string | null;
  experience: string | null;
  justification: string | null;
  employmentType: string;
  neededBy: string | null;
  status: string;
  cancelReason: string | null;
  createdAt: string;
  position: { id: string; title: string; code: string } | null;
  team: { id: string; code: string; name: string } | null;
  requestedBy: { id: string; name: string; position: string | null };
  hired: number;
  active: number;
  applicants: number;
  openings: number;
  canEdit: boolean;
  canSubmit: boolean;
  canWithdraw: boolean;
  canCancel: boolean;
  canDelete: boolean;
  approvalRoute: Route;
}

interface MprDetail extends MprRow {
  currency: string;
  candidates: CandidateRow[];
}

const salaryRange = (r: { salaryMin: number | null; salaryMax: number | null }, currency?: string) => {
  const f = (v: number) => formatMoney(v, currency);
  if (r.salaryMin != null && r.salaryMax != null) return `${f(r.salaryMin)} – ${f(r.salaryMax)}`;
  if (r.salaryMin != null) return `from ${f(r.salaryMin)}`;
  if (r.salaryMax != null) return `up to ${f(r.salaryMax)}`;
  return '—';
};

const mprColumns: Column<MprRow>[] = [
  { key: 'number', label: 'Number', sortKey: 'number', render: (r) => <span className="mono">{r.number}</span> },
  {
    key: 'title',
    label: 'Position title requested',
    sortKey: 'title',
    render: (r) => (
      <div>
        <strong>{r.title}</strong>
        <div className="faint">{[r.team?.code, typeLabel(r.employmentType)].filter(Boolean).join(' · ')}</div>
      </div>
    ),
  },
  { key: 'salary', label: 'Proposed salary range', render: (r) => salaryRange(r) },
  { key: 'headcount', label: 'Hired', render: (r) => `${r.hired} of ${r.headcount}` },
  { key: 'applicants', label: 'Applicants', render: (r) => r.applicants },
  { key: 'neededBy', label: 'Needed by', sortKey: 'neededBy', render: (r) => (r.neededBy ? formatDate(r.neededBy) : <span className="faint">—</span>) },
  { key: 'requestedBy', label: 'Requested by', render: (r) => r.requestedBy.name },
  { key: 'status', label: 'Status', sortKey: 'status', render: (r) => <StatusBadge status={r.status} extra={MPR_TONES} label={MPR_LABEL[r.status]} /> },
];

export function ManpowerRequests() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const teams = useTeams();
  const [adding, setAdding] = useState(false);
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Man Power Request</h1>
        </div>
      </div>
      <DataList<MprRow>
        listKey="manpower-requests"
        endpoint="/hiring/mprs"
        printPath="/api/hiring/mprs/pdf"
        columns={mprColumns}
        rowKey={(r) => r.id}
        scoped
        defaultScope={can('ghr.manpower_requests.view_all') ? 'all' : 'mine'}
        selectable
        searchPlaceholder="Search number, position, requirements…"
        emptyTitle="No man power requests yet"
        emptyHint="A hiring manager asks for people here; approved, HR gathers candidates against it."
        onRowClick={(r) => navigate(`/g-hr/hiring/mpr/${r.id}`)}
        summary={(raw) => {
          const s = raw as unknown as { total: number; pending: number; open: number; openings: number; inPipeline: number } | undefined;
          return s ? (
            <>
              <Stat label="Requests" value={s.total} sub="Not cancelled" />
              <Stat label="Pending approval" value={s.pending} />
              <Stat label="Open requests" value={s.open} sub={`${s.openings} opening${s.openings === 1 ? '' : 's'} to fill`} />
              <Stat label="Candidates in the running" value={s.inPipeline} sub="On open requests" />
            </>
          ) : null;
        }}
        filters={[
          { key: 'status', label: 'Status', options: Object.entries(MPR_LABEL).map(([value, label]) => ({ value, label })) },
          { key: 'teamId', label: 'Team', options: [...teams.map((t) => ({ value: t.id, label: t.code ?? t.name ?? '' })), { value: 'none', label: 'No team' }] },
        ]}
        actions={
          can('ghr.manpower_requests.create') ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
              + New man power request
            </button>
          ) : null
        }
      />
      {adding && (
        <MprModal
          onClose={() => setAdding(false)}
          onSaved={(id) => {
            setAdding(false);
            navigate(`/g-hr/hiring/mpr/${id}`);
          }}
        />
      )}
    </div>
  );
}

function MprModal({ existing, onClose, onSaved }: { existing?: MprDetail; onClose: () => void; onSaved: (id: string) => void }) {
  const toast = useToast();
  const idBase = useId();
  const teams = useTeams();
  const positions = usePositions(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState(() => ({
    title: existing?.title ?? '',
    positionId: existing?.position?.id ?? '',
    headcount: String(existing?.headcount ?? 1),
    salaryMin: existing?.salaryMin != null ? String(existing.salaryMin) : '',
    salaryMax: existing?.salaryMax != null ? String(existing.salaryMax) : '',
    education: existing?.education ?? '',
    licenses: existing?.licenses ?? '',
    experience: existing?.experience ?? '',
    justification: existing?.justification ?? '',
    employmentType: existing?.employmentType ?? 'PROBATIONARY',
    neededBy: existing?.neededBy?.slice(0, 10) ?? '',
    teamId: existing ? (existing.team?.id ?? '') : '__mine__',
  }));
  const set = <K extends keyof typeof form>(k: K, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    setBusy(true);
    setError(null);
    const body = {
      title: form.title.trim(),
      positionId: form.positionId || null,
      headcount: Number(form.headcount) || 1,
      salaryMin: form.salaryMin ? Number(form.salaryMin) : null,
      salaryMax: form.salaryMax ? Number(form.salaryMax) : null,
      education: form.education.trim() || null,
      licenses: form.licenses.trim() || null,
      experience: form.experience.trim() || null,
      justification: form.justification.trim() || null,
      employmentType: form.employmentType,
      neededBy: form.neededBy || null,
      ...(form.teamId === '__mine__' ? {} : { teamId: form.teamId || null }),
    };
    try {
      if (existing) {
        await api.patch(`/hiring/mprs/${existing.id}`, body);
        toast('ok', 'Request saved');
        onSaved(existing.id);
      } else {
        const created = await api.post<{ id: string; number: string }>('/hiring/mprs', body);
        toast('ok', `${created.number} saved as a draft`);
        onSaved(created.id);
      }
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={existing ? `Modify ${existing.number}` : 'New man power request'}
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy || form.title.trim().length < 2}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      <div className="grid grid-2">
        <Field label="Position title requested" htmlFor={`${idBase}-title`}>
          <input id={`${idBase}-title`} value={form.title} placeholder="Sr. Mechanical Field Engineer (Pumps & Hydraulics)" onChange={(e) => set('title', e.target.value)} autoFocus />
        </Field>
        <Field label="Plantilla position" hint="The slot it fills, where there is one">
          <select value={form.positionId} onChange={(e) => set('positionId', e.target.value)}>
            <option value="">— a new position —</option>
            {positions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Proposed salary — from" hint="Per month">
          <NumberInput kind="money" value={form.salaryMin} onChange={(e) => set('salaryMin', e.target.value)} />
        </Field>
        <Field label="Proposed salary — to" hint="Per month">
          <NumberInput kind="money" value={form.salaryMax} onChange={(e) => set('salaryMax', e.target.value)} />
        </Field>
        <Field label="Headcount">
          <NumberInput kind="count" min={1} value={form.headcount} onChange={(e) => set('headcount', e.target.value)} />
        </Field>
        <Field label="Employment type">
          <select value={form.employmentType} onChange={(e) => set('employmentType', e.target.value)}>
            {EMPLOYMENT_TYPES.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Needed by">
          <input type="date" value={form.neededBy} onChange={(e) => set('neededBy', e.target.value)} />
        </Field>
        <Field label="Team" hint="Its Technical Manager and Team Leader approve the contract">
          <select value={form.teamId} onChange={(e) => set('teamId', e.target.value)}>
            {!existing && <option value="__mine__">— my team —</option>}
            <option value="">— no team —</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.code} — {t.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Required education">
          <input value={form.education} placeholder="BS Mechanical Engineering / Mechatronics" onChange={(e) => set('education', e.target.value)} />
        </Field>
        <Field label="Required licenses & certs">
          <input value={form.licenses} placeholder="PRC Registered Mechanical Engineer (RME)" onChange={(e) => set('licenses', e.target.value)} />
        </Field>
      </div>
      <Field label="Experience & required skill sets">
        <textarea rows={3} value={form.experience} onChange={(e) => set('experience', e.target.value)} />
      </Field>
      <Field label="Justification" hint="Why the position is needed — a replacement, a new project">
        <textarea rows={2} value={form.justification} onChange={(e) => set('justification', e.target.value)} />
      </Field>
    </Modal>
  );
}

export function ManpowerRequestPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const { can } = useAuth();
  const [row, setRow] = useState<MprDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const [modifying, setModifying] = useState(false);
  const [addingCandidate, setAddingCandidate] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setRow(await api.get<MprDetail>(`/hiring/mprs/${id}`));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  if (error && !row) return <ErrorBox error={error} />;
  if (!row) return <Loading />;
  const r = row;
  const done = () => {
    setReload((n) => n + 1);
    void load();
  };

  async function submit() {
    setError(null);
    try {
      await api.post(`/hiring/mprs/${r.id}/submit`);
      toast('ok', allHeld(r.approvalRoute) ? 'Approved — you hold every step' : 'Sent for approval');
      done();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div>
      <RecordHeader
        type="Man Power Request"
        code={r.number}
        title={`${r.headcount} × ${r.title}`}
        status={r.status}
        statusExtra={MPR_TONES}
        statusLabel={MPR_LABEL[r.status]}
        meta={
          <>
            Requested by {r.requestedBy.name} on {formatDate(r.createdAt)}
            {r.team && <> · {r.team.code}</>}
            {r.neededBy && <> · needed by {formatDate(r.neededBy)}</>}
          </>
        }
        actions={
          <>
            {r.canSubmit && (
              <button type="button" className="btn btn-primary" onClick={() => void submit()}>
                Submit for approval
              </button>
            )}
            {r.status === 'APPROVED' && can('ghr.candidates.create') && (
              <button type="button" className="btn btn-primary" onClick={() => setAddingCandidate(true)}>
                + Add new applicant
              </button>
            )}
          </>
        }
        print={`/api/hiring/mprs/${r.id}/pdf`}
        more={[
          r.canWithdraw && {
            label: 'Pull back to draft',
            confirm: {
              title: `Pull ${r.number} back?`,
              body: 'The approval request is withdrawn and its approvers are told.',
              confirmLabel: 'Pull it back',
              onConfirm: async () => {
                await api.post(`/hiring/mprs/${r.id}/withdraw`);
                toast('ok', 'Back to draft');
                done();
              },
            },
          },
          r.canCancel && {
            label: 'Cancel request',
            danger: true,
            confirm: {
              title: `Cancel ${r.number}?`,
              body: r.status === 'PENDING_APPROVAL' ? 'The approval request is withdrawn with it.' : 'No more candidates are gathered against it.',
              confirmLabel: 'Cancel request',
              reason: 'required' as const,
              minReason: 3,
              onConfirm: async (reason: string) => {
                await api.post(`/hiring/mprs/${r.id}/cancel`, { reason });
                toast('ok', 'Cancelled');
                done();
              },
            },
          },
          r.canDelete && {
            label: 'Delete',
            danger: true,
            confirm: {
              title: `Delete ${r.number}?`,
              body: 'It goes for good. Its number is not reused.',
              confirmLabel: 'Delete',
              onConfirm: async () => {
                await api.del(`/hiring/mprs/${r.id}`);
                toast('ok', 'Deleted');
                navigate('/g-hr/hiring/mpr');
              },
            },
          },
        ]}
        modify={r.canEdit ? () => setModifying(true) : undefined}
        confirm={confirm}
      />
      {r.status === 'DRAFT' && <RoutePreview route={r.approvalRoute} />}
      <DecisionNote documentType="manpower_request" documentId={r.id} reloadToken={reload} />
      {r.status !== 'DRAFT' && r.status !== 'CANCELLED' && <DocumentApproval documentType="manpower_request" documentId={r.id} reloadToken={reload} />}
      <ErrorBox error={error} />

      <div className="stack">
        <section className="card">
          <div className="card-head">
            <h3 className="card-title">Man Power Requisition (MPR) Form</h3>
            <span className="hiring-ref">Requisition Ref # {r.number}</span>
          </div>
          <div className="hiring-boxes">
            <div className="hiring-box">
              <span className="hiring-box-label">Position title requested</span>
              <strong>{r.title}</strong>
              {r.position && <span className="faint">Plantilla: {r.position.title}</span>}
            </div>
            <div className="hiring-box">
              <span className="hiring-box-label">Proposed salary range</span>
              <strong>{salaryRange(r, r.currency)} / month</strong>
            </div>
            <div className="hiring-box">
              <span className="hiring-box-label">Required education</span>
              <strong>{r.education ?? '—'}</strong>
            </div>
            <div className="hiring-box">
              <span className="hiring-box-label">Required licenses & certs</span>
              <strong>{r.licenses ?? '—'}</strong>
            </div>
            <div className="hiring-box hiring-box-wide">
              <span className="hiring-box-label">Experience & required skill sets</span>
              <strong>{r.experience ?? '—'}</strong>
            </div>
          </div>
          <dl className="kv">
            <dt>Headcount</dt>
            <dd>
              {r.headcount} · {r.hired} hired · {r.openings} open
            </dd>
            <dt>Employment type</dt>
            <dd>{typeLabel(r.employmentType)}</dd>
            {r.justification && (
              <>
                <dt>Justification</dt>
                <dd>{r.justification}</dd>
              </>
            )}
            {r.cancelReason && r.status === 'CANCELLED' && (
              <>
                <dt>Cancelled because</dt>
                <dd>{r.cancelReason}</dd>
              </>
            )}
          </dl>
        </section>

        <section className="card">
          <div className="card-head">
            <h3 className="card-title">Applicants & candidate pool</h3>
          </div>
          {r.candidates.length ? (
            <CandidateTable rows={r.candidates} />
          ) : (
            <Empty title="No applicants yet" hint={r.status === 'APPROVED' ? 'Add the applicants for this request.' : 'Applicants are added once the request is approved.'} />
          )}
        </section>
      </div>

      {modifying && (
        <MprModal
          existing={r}
          onClose={() => setModifying(false)}
          onSaved={() => {
            setModifying(false);
            void load();
          }}
        />
      )}
      {addingCandidate && (
        <CandidateModal
          mprId={r.id}
          onClose={() => setAddingCandidate(false)}
          onSaved={() => {
            setAddingCandidate(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// CANDIDATES
// ═════════════════════════════════════════════════════════════════════════════

interface CandidateRow {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  education: string | null;
  license: string | null;
  skills: string | null;
  yearsExperience: number | null;
  source: string | null;
  notes: string | null;
  status: string;
  examScore: number | null;
  createdAt: string;
  mpr: { id: string; number: string; title: string; status: string; team: { code: string } | null };
  createdBy: { id: string; name: string };
  employee: { id: string; employeeNo: string | null } | null;
  canEdit: boolean;
  moves: string[];
  canScore: boolean;
  canContract: boolean;
}

interface CandidateDetail extends CandidateRow {
  events: { id: string; fromStatus: string | null; toStatus: string; on: string; note: string | null; by: { name: string } }[];
  contracts: { id: string; number: string; status: string; startDate: string; monthlySalary: number }[];
  exams: { id: string; name: string; maxScore: number; weight: number; isActive: boolean; score: number | null; takenOn: string | null; pct: number | null; benchmark: number | null; benchmarkCount: number }[];
}

const experienceOf = (c: CandidateRow) => [c.skills, c.yearsExperience != null ? `${c.yearsExperience} yrs exp` : null].filter(Boolean).join(' · ');

const candidateColumns: Column<CandidateRow>[] = [
  { key: 'name', label: 'Applicant name', sortKey: 'lastName', render: (c) => <strong>{c.name}</strong> },
  { key: 'position', label: 'Position applied', render: (c) => c.mpr.title },
  { key: 'education', label: 'Education & school', render: (c) => c.education ?? <span className="faint">—</span> },
  { key: 'license', label: 'License / cert', render: (c) => c.license ?? <span className="faint">—</span> },
  { key: 'skills', label: 'Key skills & experience', render: (c) => experienceOf(c) || <span className="faint">—</span> },
  { key: 'score', label: 'Exam score', render: (c) => <strong>{pct(c.examScore)}</strong> },
  { key: 'status', label: 'Status', sortKey: 'status', render: (c) => candidateBadge(c.status) },
];

function CandidateTable({ rows }: { rows: CandidateRow[] }) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            {candidateColumns.map((c) => (
              <th key={c.key}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id}>
              <td>
                <Link to={`/g-hr/hiring/candidates/${c.id}`}>
                  <strong>{c.name}</strong>
                </Link>
              </td>
              {candidateColumns.slice(1).map((col) => (
                <td key={col.key}>{col.render(c)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Candidates() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Candidates</h1>
        </div>
      </div>
      <DataList<CandidateRow>
        listKey="candidates"
        endpoint="/hiring/candidates"
        printPath="/api/hiring/candidates/pdf"
        columns={candidateColumns}
        rowKey={(r) => r.id}
        scoped
        defaultScope={can('ghr.candidates.view_all') ? 'all' : 'mine'}
        selectable
        searchPlaceholder="Search name, school, licence, skills, position…"
        emptyTitle="No applicants yet"
        emptyHint="Add applicants against an approved man power request."
        onRowClick={(r) => navigate(`/g-hr/hiring/candidates/${r.id}`)}
        summary={(raw) => {
          const s = raw as unknown as { total: number; screening: number; exams: number; interviews: number; contract: number; hired: number } | undefined;
          return s ? (
            <>
              <Stat label="Applicants" value={s.total} />
              <Stat label="Screening" value={s.screening} />
              <Stat label="At the exam" value={s.exams} />
              <Stat label="At the interview" value={s.interviews} />
              <Stat label="Contract stage" value={s.contract} />
              <Stat label="Hired" value={s.hired} />
            </>
          ) : null;
        }}
        filters={[
          { key: 'status', label: 'Status', options: Object.entries(CANDIDATE_LABEL).map(([value, label]) => ({ value, label })) },
          { key: 'open', label: 'In the running', options: [{ value: 'true', label: 'Still in the running' }] },
        ]}
        actions={
          can('ghr.candidates.create') ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
              + Add new applicant
            </button>
          ) : null
        }
      />
      {adding && (
        <CandidateModal
          onClose={() => setAdding(false)}
          onSaved={(id) => {
            setAdding(false);
            navigate(`/g-hr/hiring/candidates/${id}`);
          }}
        />
      )}
    </div>
  );
}

interface OpenMpr {
  id: string;
  number: string;
  title: string;
  team: string | null;
  openings: number;
}

function CandidateModal({ mprId, existing, onClose, onSaved }: { mprId?: string; existing?: CandidateDetail; onClose: () => void; onSaved: (id: string) => void }) {
  const toast = useToast();
  const idBase = useId();
  const [mprs, setMprs] = useState<OpenMpr[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState(() => ({
    mprId: existing?.mpr.id ?? mprId ?? '',
    firstName: existing?.firstName ?? '',
    lastName: existing?.lastName ?? '',
    email: existing?.email ?? '',
    phone: existing?.phone ?? '',
    education: existing?.education ?? '',
    license: existing?.license ?? '',
    skills: existing?.skills ?? '',
    yearsExperience: existing?.yearsExperience != null ? String(existing.yearsExperience) : '',
    source: existing?.source ?? '',
    notes: existing?.notes ?? '',
  }));
  const set = <K extends keyof typeof form>(k: K, v: string) => setForm((f) => ({ ...f, [k]: v }));
  useEffect(() => {
    api
      .get<OpenMpr[]>('/hiring/mprs/open')
      .then((rows) => {
        setMprs(rows);
        setForm((f) => (f.mprId || !rows.length ? f : { ...f, mprId: rows[0].id }));
      })
      .catch(setError);
  }, []);

  async function save() {
    setBusy(true);
    setError(null);
    const body = {
      mprId: form.mprId,
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
      education: form.education.trim() || null,
      license: form.license.trim() || null,
      skills: form.skills.trim() || null,
      yearsExperience: form.yearsExperience ? Number(form.yearsExperience) : null,
      source: form.source.trim() || null,
      notes: form.notes.trim() || null,
    };
    try {
      if (existing) {
        await api.patch(`/hiring/candidates/${existing.id}`, body);
        toast('ok', 'Applicant saved');
        onSaved(existing.id);
      } else {
        const created = await api.post<{ id: string; name: string }>('/hiring/candidates', body);
        toast('ok', `${created.name} added`);
        onSaved(created.id);
      }
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={existing ? `Modify applicant ${existing.name}` : 'New applicant'}
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy || !form.mprId || !form.firstName.trim() || !form.lastName.trim()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      <Field label="Position applied" htmlFor={`${idBase}-mpr`} hint="An approved man power request">
        <select id={`${idBase}-mpr`} value={form.mprId} onChange={(e) => set('mprId', e.target.value)}>
          {existing && !mprs.some((m) => m.id === existing.mpr.id) && <option value={existing.mpr.id}>{`${existing.mpr.number} — ${existing.mpr.title}`}</option>}
          {!mprs.length && !existing && <option value="">— no approved request —</option>}
          {mprs.map((m) => (
            <option key={m.id} value={m.id}>
              {m.number} — {m.title}
              {m.team ? ` (${m.team})` : ''} · {m.openings} open
            </option>
          ))}
        </select>
      </Field>
      <div className="grid grid-2">
        <Field label="First name">
          <input value={form.firstName} onChange={(e) => set('firstName', e.target.value)} autoFocus />
        </Field>
        <Field label="Last name">
          <input value={form.lastName} onChange={(e) => set('lastName', e.target.value)} />
        </Field>
        <Field label="Email">
          <input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} />
        </Field>
        <Field label="Mobile">
          <input value={form.phone} onChange={(e) => set('phone', e.target.value)} />
        </Field>
        <Field label="Education & school">
          <input value={form.education} placeholder="BSME, Mapúa Univ." onChange={(e) => set('education', e.target.value)} />
        </Field>
        <Field label="License / cert">
          <input value={form.license} placeholder="PRC Licensed ME" onChange={(e) => set('license', e.target.value)} />
        </Field>
        <Field label="Years of experience">
          <NumberInput kind="count" value={form.yearsExperience} onChange={(e) => set('yearsExperience', e.target.value)} />
        </Field>
        <Field label="Source" hint="Referral, job board, walk-in">
          <input value={form.source} onChange={(e) => set('source', e.target.value)} />
        </Field>
      </div>
      <Field label="Key skills & experience">
        <textarea rows={2} value={form.skills} placeholder="Pump systems, hydraulics" onChange={(e) => set('skills', e.target.value)} />
      </Field>
      <Field label="Notes">
        <textarea rows={2} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
      </Field>
    </Modal>
  );
}

const DATED_AHEAD = ['EXAM_SCHEDULED', 'INTERVIEW_SCHEDULED'];
const NEEDS_REASON = ['DECLINED', 'WITHDRAWN', 'INTERVIEW_FAILED'];

function MoveModal({ candidate, to, onClose, onDone }: { candidate: CandidateDetail; to: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [on, setOn] = useState(today());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const needsReason = NEEDS_REASON.includes(to);
  async function move() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/hiring/candidates/${candidate.id}/move`, { to, on, note: note.trim() || null });
      toast('ok', `${candidate.name}: ${CANDIDATE_LABEL[to]}`);
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`${CANDIDATE_LABEL[to]} — ${candidate.name}`}
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button type="button" className="btn btn-primary" disabled={busy || (needsReason && note.trim().length < 3)} onClick={() => void move()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      <Field label={DATED_AHEAD.includes(to) ? 'Scheduled on' : 'Date'}>
        <input type="date" value={on} max={DATED_AHEAD.includes(to) ? undefined : today()} onChange={(e) => setOn(e.target.value)} />
      </Field>
      <Field label={needsReason ? 'Why' : 'Note'} hint="Kept on the candidate's trail">
        <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
      </Field>
    </Modal>
  );
}

function ScoresModal({ candidate, onClose, onDone }: { candidate: CandidateDetail; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const exams = candidate.exams.filter((e) => e.isActive || e.score != null);
  const [scores, setScores] = useState<Record<string, { score: string; takenOn: string }>>(() =>
    Object.fromEntries(exams.map((e) => [e.id, { score: e.score != null ? String(e.score) : '', takenOn: e.takenOn?.slice(0, 10) ?? today() }])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      const results = exams.filter((e) => scores[e.id]?.score !== '').map((e) => ({ examId: e.id, score: Number(scores[e.id].score), takenOn: scores[e.id].takenOn || undefined }));
      await api.put(`/hiring/candidates/${candidate.id}/exams`, { results });
      toast('ok', 'Scores saved');
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`Entrance exam scores — ${candidate.name}`}
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      <p className="faint">A blank score removes it. Each exam is scored out of its maximum.</p>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Exam</th>
              <th>Score</th>
              <th>Taken on</th>
            </tr>
          </thead>
          <tbody>
            {exams.map((e) => (
              <tr key={e.id}>
                <td>
                  <strong>{e.name}</strong>
                  <div className="faint">out of {e.maxScore}</div>
                </td>
                <td>
                  <NumberInput kind="decimal" value={scores[e.id]?.score ?? ''} onChange={(ev) => setScores((s) => ({ ...s, [e.id]: { ...s[e.id], score: ev.target.value } }))} />
                </td>
                <td>
                  <input type="date" max={today()} value={scores[e.id]?.takenOn ?? ''} onChange={(ev) => setScores((s) => ({ ...s, [e.id]: { ...s[e.id], takenOn: ev.target.value } }))} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

/** The PDF's analytics card: the candidate's score per exam beside the hired candidates' average. */
function ScoreComparison({ name, rows }: { name: string; rows: { name: string; candidate: number | null; benchmark: number | null; benchmarkCount: number }[] }) {
  if (!rows.length) return <Empty title="No exams on the catalogue" />;
  if (rows.every((r) => r.candidate == null)) return <Empty title="No scores recorded yet" />;
  return (
    <div className="table-wrap">
      <table className="data hiring-compare">
        <thead>
          <tr>
            <th>Exam</th>
            <th>{name}</th>
            <th>Hired average</th>
            <th>Difference</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const diff = r.candidate != null && r.benchmark != null ? r.candidate - r.benchmark : null;
            return (
              <tr key={r.name}>
                <td>
                  <strong>{r.name}</strong>
                </td>
                <td>
                  <div className="hiring-bar">
                    <MiniBar value={r.candidate ?? 0} peak={100} tone="var(--info)" />
                    <span>{pct(r.candidate)}</span>
                  </div>
                </td>
                <td>
                  <div className="hiring-bar">
                    <MiniBar value={r.benchmark ?? 0} peak={100} tone="var(--ok)" />
                    <span>{r.benchmark == null ? 'nobody hired has sat it' : `${pct(r.benchmark)} (${r.benchmarkCount})`}</span>
                  </div>
                </td>
                <td>{diff == null ? '—' : <span className={diff >= 0 ? 'hiring-up' : 'hiring-down'}>{`${diff >= 0 ? '+' : ''}${diff.toFixed(1)} pts`}</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function CandidatePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const [row, setRow] = useState<CandidateDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [modifying, setModifying] = useState(false);
  const [moveTo, setMoveTo] = useState<string | null>(null);
  const [scoring, setScoring] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setRow(await api.get<CandidateDetail>(`/hiring/candidates/${id}`));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  if (error && !row) return <ErrorBox error={error} />;
  if (!row) return <Loading />;
  const c = row;
  const forward = c.moves.filter((m) => !NEEDS_REASON.includes(m));
  const backward = c.moves.filter((m) => NEEDS_REASON.includes(m));
  const live = c.contracts.find((k) => k.status !== 'CANCELLED');

  return (
    <div>
      <RecordHeader
        type="Candidate"
        code={c.mpr.number}
        title={c.name}
        status={c.status}
        statusExtra={CANDIDATE_TONES}
        statusLabel={CANDIDATE_LABEL[c.status]}
        meta={
          <>
            For <Link to={`/g-hr/hiring/mpr/${c.mpr.id}`}>{c.mpr.title}</Link>
            {c.mpr.team && <> · {c.mpr.team.code}</>} · added by {c.createdBy.name} on {formatDate(c.createdAt)}
            {c.employee && (
              <>
                {' '}
                · hired as <Link to={`/g-hr/employees/${c.employee.id}`}>{c.employee.employeeNo ?? 'employee record'}</Link>
              </>
            )}
          </>
        }
        actions={
          <>
            {forward.map((m, i) => (
              <button key={m} type="button" className={i === 0 ? 'btn btn-primary' : 'btn'} onClick={() => setMoveTo(m)}>
                {CANDIDATE_LABEL[m]}
              </button>
            ))}
            {c.canContract && !live && (
              <button type="button" className="btn" onClick={() => navigate(`/g-hr/hiring/contracts?new=1&candidate=${c.id}`)}>
                Prepare contract
              </button>
            )}
          </>
        }
        more={[
          c.canScore && { label: 'Record exam scores', onSelect: () => setScoring(true) },
          ...backward.map((m) => ({ label: CANDIDATE_LABEL[m], danger: true, onSelect: () => setMoveTo(m) })),
        ]}
        modify={c.canEdit ? () => setModifying(true) : undefined}
        confirm={confirm}
      />
      <ErrorBox error={error} />

      <div className="stack">
        <div>
          <section className="card">
            <h3 className="card-title">The applicant</h3>
            <dl className="kv">
              <dt>Position applied</dt>
              <dd>
                <Link to={`/g-hr/hiring/mpr/${c.mpr.id}`}>{c.mpr.number}</Link> — {c.mpr.title}
              </dd>
              <dt>Education & school</dt>
              <dd>{c.education ?? '—'}</dd>
              <dt>License / cert</dt>
              <dd>{c.license ?? '—'}</dd>
              <dt>Key skills</dt>
              <dd>{experienceOf(c) || '—'}</dd>
              <dt>Email</dt>
              <dd>{c.email ?? '—'}</dd>
              <dt>Mobile</dt>
              <dd>{c.phone ?? '—'}</dd>
              <dt>Source</dt>
              <dd>{c.source ?? '—'}</dd>
              {c.notes && (
                <>
                  <dt>Notes</dt>
                  <dd>{c.notes}</dd>
                </>
              )}
            </dl>
          </section>
          <section className="card">
            <div className="card-head">
              <h3 className="card-title">Entrance exam — {pct(c.examScore)}</h3>
              {c.canScore && (
                <button type="button" className="btn btn-sm" onClick={() => setScoring(true)}>
                  Record scores
                </button>
              )}
            </div>
            <ScoreComparison name={c.firstName} rows={c.exams.filter((e) => e.isActive || e.score != null).map((e) => ({ name: e.name, candidate: e.pct, benchmark: e.benchmark, benchmarkCount: e.benchmarkCount }))} />
          </section>
        </div>

        {c.contracts.length > 0 && (
          <section className="card">
            <h3 className="card-title">Contracts</h3>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Number</th>
                    <th>Start date</th>
                    <th>Monthly salary</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {c.contracts.map((k) => (
                    <tr key={k.id}>
                      <td>
                        <Link to={`/g-hr/hiring/contracts/${k.id}`} className="mono">
                          {k.number}
                        </Link>
                      </td>
                      <td>{formatDate(k.startDate)}</td>
                      <td>{formatMoney(k.monthlySalary)}</td>
                      <td>
                        <StatusBadge status={k.status} extra={CONTRACT_TONES} label={CONTRACT_LABEL[k.status]} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <section className="card">
          <h3 className="card-title">Trail</h3>
          <ul className="hiring-trail">
            {c.events.map((e) => (
              <li key={e.id}>
                <span className="hiring-trail-date">{formatDate(e.on)}</span>
                {candidateBadge(e.toStatus)}
                <span>
                  {e.note && <>{e.note} · </>}
                  <span className="faint">{e.by.name}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>

        <Attachments entityType="candidate" entityId={c.id} title="Files" hint="CV, licence, IDs, the exam papers" canEdit={c.canEdit} />
      </div>

      {modifying && (
        <CandidateModal
          existing={c}
          onClose={() => setModifying(false)}
          onSaved={() => {
            setModifying(false);
            void load();
          }}
        />
      )}
      {moveTo && (
        <MoveModal
          candidate={c}
          to={moveTo}
          onClose={() => setMoveTo(null)}
          onDone={() => {
            setMoveTo(null);
            toast('ok', 'Saved');
            void load();
          }}
        />
      )}
      {scoring && (
        <ScoresModal
          candidate={c}
          onClose={() => setScoring(false)}
          onDone={() => {
            setScoring(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// ENTRANCE EXAMS
// ═════════════════════════════════════════════════════════════════════════════

interface ExamRow {
  id: string;
  name: string;
  description: string | null;
  maxScore: number;
  weight: number;
  sortOrder: number;
  isSystem: boolean;
  isActive: boolean;
  sat: number;
  benchmark: number | null;
  benchmarkCount: number;
}

interface Analytics {
  candidates: { id: string; name: string; position: string; status: string; examScore: number | null }[];
  candidate: { id: string; name: string; position: string; examScore: number | null } | null;
  rows: { examId: string; name: string; candidate: number | null; benchmark: number | null; benchmarkCount: number }[];
}

export function EntranceExams() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<{ canEdit: boolean; exams: ExamRow[] } | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<ExamRow | 'new' | null>(null);
  const candidateId = params.get('candidate') ?? '';

  const load = useCallback(async () => {
    try {
      setData(await api.get('/hiring/exams'));
    } catch (err) {
      setError(err);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    api
      .get<Analytics>(`/hiring/exams/analytics${candidateId ? `?candidateId=${encodeURIComponent(candidateId)}` : ''}`)
      .then(setAnalytics)
      .catch(setError);
  }, [candidateId]);

  async function remove(e: ExamRow) {
    await api.del(`/hiring/exams/${e.id}`);
    toast('ok', `${e.name} deleted`);
    setEditing(null);
    await load();
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Entrance Exam</h1>
        </div>
        {data?.canEdit && (
          <div className="page-actions">
            <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
              + New exam
            </button>
          </div>
        )}
      </div>
      <ErrorBox error={error} />
      <div className="stack">
        <section className="card">
          <div className="card-head">
            <h3 className="card-title">Entrance exam catalog & score analytics</h3>
            <span className="faint">Benchmark: the applicant’s score vs. the hired candidates’ average</span>
          </div>
          {analytics && analytics.candidates.length > 0 ? (
            <>
              <Field label="Applicant">
                <select
                  value={analytics.candidate?.id ?? ''}
                  onChange={(e) => {
                    const next = new URLSearchParams(params);
                    next.set('candidate', e.target.value);
                    setParams(next, { replace: true });
                  }}
                >
                  {analytics.candidates.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} — {c.position} ({pct(c.examScore)})
                    </option>
                  ))}
                </select>
              </Field>
              {analytics.candidate && <ScoreComparison name={analytics.candidate.name} rows={analytics.rows} />}
            </>
          ) : (
            <Empty title="No scores recorded yet" hint="Record an applicant’s scores on their page; they are compared here with the average of everyone hired." />
          )}
        </section>

        <section className="card">
          <h3 className="card-title">Catalog</h3>
          {!data ? (
            <Loading />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Exam</th>
                    <th>Scored out of</th>
                    <th>Weight</th>
                    <th>Sat</th>
                    <th>Hired average</th>
                    <th>Status</th>
                    {data.canEdit && <th />}
                  </tr>
                </thead>
                <tbody>
                  {data.exams.map((e) => (
                    <tr key={e.id}>
                      <td>
                        <strong>{e.name}</strong>
                        {e.description && <div className="faint">{e.description}</div>}
                      </td>
                      <td>{e.maxScore}</td>
                      <td>{e.weight}</td>
                      <td>{e.sat}</td>
                      <td>{e.benchmark == null ? '—' : `${pct(e.benchmark)} (${e.benchmarkCount})`}</td>
                      <td>
                        <ActiveBadge active={e.isActive} />
                      </td>
                      {data.canEdit && (
                        <td>
                          <button type="button" className="btn btn-sm" onClick={() => setEditing(e)}>
                            Modify
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
      {editing && <ExamModal existing={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onDelete={editing !== 'new' && !editing.isSystem && !editing.sat ? () => remove(editing) : undefined} onSaved={() => {
        setEditing(null);
        void load();
      }} />}
    </div>
  );
}

function ExamModal({ existing, onClose, onSaved, onDelete }: { existing?: ExamRow; onClose: () => void; onSaved: () => void; onDelete?: () => Promise<void> }) {
  const toast = useToast();
  const [form, setForm] = useState(() => ({
    name: existing?.name ?? '',
    description: existing?.description ?? '',
    maxScore: String(existing?.maxScore ?? 100),
    weight: String(existing?.weight ?? 1),
    isActive: existing?.isActive ?? true,
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function save() {
    setBusy(true);
    setError(null);
    const body = { name: form.name.trim(), description: form.description.trim() || null, maxScore: Number(form.maxScore) || 100, weight: Number(form.weight) || 1, isActive: form.isActive };
    try {
      if (existing) await api.patch(`/hiring/exams/${existing.id}`, body);
      else await api.post('/hiring/exams', body);
      toast('ok', 'Exam saved');
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }
  return (
    <Modal
      title={existing ? `Modify ${existing.name}` : 'New exam'}
      onClose={onClose}
      footer={
        <ModalFoot
          onCancel={onClose}
          busy={busy}
          danger={onDelete && existing ? { label: 'Delete', question: `Delete ${existing.name}? It was never scored.`, onConfirm: onDelete } : undefined}
        >
          <button type="button" className="btn btn-primary" disabled={busy || form.name.trim().length < 2} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      <Field label="Exam">
        <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} autoFocus />
      </Field>
      <Field label="What it covers">
        <textarea rows={2} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
      </Field>
      <div className="grid grid-2">
        <Field label="Scored out of" hint={existing?.sat ? 'Fixed once scored' : undefined}>
          <NumberInput kind="count" min={1} value={form.maxScore} disabled={!!existing?.sat} onChange={(e) => setForm((f) => ({ ...f, maxScore: e.target.value }))} />
        </Field>
        <Field label="Weight" hint="In the candidate's overall score">
          <NumberInput kind="decimal" value={form.weight} onChange={(e) => setForm((f) => ({ ...f, weight: e.target.value }))} />
        </Field>
      </div>
      <label className="check">
        <input type="checkbox" checked={form.isActive} onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))} /> Offered to new applicants
      </label>
    </Modal>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// CONTRACTS & APPROVALS
// ═════════════════════════════════════════════════════════════════════════════

interface ContractRow {
  id: string;
  number: string;
  title: string;
  monthlySalary: number;
  allowances: number;
  allowanceNote: string | null;
  employmentType: string;
  startDate: string;
  periodEndDate: string | null;
  workLocation: string | null;
  terms: string | null;
  status: string;
  cancelReason: string | null;
  signedOn: string | null;
  createdAt: string;
  candidateName: string;
  candidate: {
    id: string;
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string | null;
    status: string;
    employeeId: string | null;
    mpr: { id: string; number: string; title: string; teamId: string | null; team: { code: string; name: string } | null };
  };
  position: { id: string; title: string } | null;
  preparedBy: { id: string; name: string };
  canEdit: boolean;
  canSubmit: boolean;
  canWithdraw: boolean;
  canCancel: boolean;
  canDelete: boolean;
  canSign: boolean;
  canHire: boolean;
  approvalRoute: Route;
  currency?: string;
}

const contractColumns: Column<ContractRow>[] = [
  { key: 'number', label: 'Number', sortKey: 'number', render: (r) => <span className="mono">{r.number}</span> },
  { key: 'name', label: 'Employee name (hired)', render: (r) => <strong>{r.candidateName}</strong> },
  { key: 'title', label: 'Position title', sortKey: 'title', render: (r) => r.title },
  { key: 'salary', label: 'Agreed monthly salary', render: (r) => formatMoney(r.monthlySalary) },
  { key: 'start', label: 'Effective start date', sortKey: 'startDate', render: (r) => formatDate(r.startDate) },
  { key: 'by', label: 'Prepared by', render: (r) => r.preparedBy.name },
  { key: 'status', label: 'Status', sortKey: 'status', render: (r) => <StatusBadge status={r.status} extra={CONTRACT_TONES} label={CONTRACT_LABEL[r.status]} /> },
];

export function Contracts() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [adding, setAdding] = useState<string | null>(null);
  // The candidate page's "Prepare contract" lands here with ?new=1&candidate=…
  useEffect(() => {
    if (params.get('new') === '1') {
      setAdding(params.get('candidate') ?? '');
      const next = new URLSearchParams(params);
      next.delete('new');
      next.delete('candidate');
      setParams(next, { replace: true });
    }
  }, [params, setParams]);
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Contracts & Approvals</h1>
        </div>
      </div>
      <DataList<ContractRow>
        listKey="employment-contracts"
        endpoint="/hiring/contracts"
        printPath="/api/hiring/contracts/pdf"
        columns={contractColumns}
        rowKey={(r) => r.id}
        scoped
        defaultScope={can('ghr.employment_contracts.view_all') ? 'all' : 'mine'}
        selectable
        searchPlaceholder="Search number, employee, position…"
        emptyTitle="No contracts yet"
        emptyHint="Prepare a contract for a candidate who passed the interview."
        onRowClick={(r) => navigate(`/g-hr/hiring/contracts/${r.id}`)}
        summary={(raw) => {
          const s = raw as unknown as { drafts: number; pending: number; toSign: number; signed: number } | undefined;
          return s ? (
            <>
              <Stat label="Drafts" value={s.drafts} />
              <Stat label="Pending approval" value={s.pending} />
              <Stat label="Approved — to sign" value={s.toSign} sub="Print for the wet signature" />
              <Stat label="Signed" value={s.signed} />
            </>
          ) : null;
        }}
        filters={[{ key: 'status', label: 'Status', options: Object.entries(CONTRACT_LABEL).map(([value, label]) => ({ value, label })) }]}
        actions={
          can('ghr.employment_contracts.create') ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setAdding('')}>
              + New contract
            </button>
          ) : null
        }
      />
      {adding !== null && (
        <ContractModal
          candidateId={adding || undefined}
          onClose={() => setAdding(null)}
          onSaved={(id) => {
            setAdding(null);
            navigate(`/g-hr/hiring/contracts/${id}`);
          }}
        />
      )}
    </div>
  );
}

interface ContractCandidate {
  id: string;
  name: string;
  status: string;
  mpr: { id: string; number: string; title: string; positionId: string | null; employmentType: string; salaryMin: number | null; salaryMax: number | null; team: { code: string } | null };
}

function ContractModal({ candidateId, existing, onClose, onSaved }: { candidateId?: string; existing?: ContractRow; onClose: () => void; onSaved: (id: string) => void }) {
  const toast = useToast();
  const positions = usePositions(true);
  const [candidates, setCandidates] = useState<ContractCandidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState(() => ({
    candidateId: existing?.candidate.id ?? candidateId ?? '',
    title: existing?.title ?? '',
    positionId: existing?.position?.id ?? '',
    monthlySalary: existing ? String(existing.monthlySalary) : '',
    allowances: existing ? String(existing.allowances) : '',
    allowanceNote: existing?.allowanceNote ?? '',
    employmentType: existing?.employmentType ?? 'PROBATIONARY',
    startDate: existing?.startDate.slice(0, 10) ?? '',
    periodEndDate: existing?.periodEndDate?.slice(0, 10) ?? '',
    workLocation: existing?.workLocation ?? '',
    terms: existing?.terms ?? '',
  }));
  const set = <K extends keyof typeof form>(k: K, v: string) => setForm((f) => ({ ...f, [k]: v }));
  useEffect(() => {
    if (existing) return;
    api
      .get<ContractCandidate[]>('/hiring/contracts/candidates')
      .then((rows) => {
        setCandidates(rows);
        setForm((f) => {
          const pick = rows.find((c) => c.id === f.candidateId) ?? rows[0];
          return pick ? fillFrom(f, pick) : f;
        });
      })
      .catch(setError);
  }, [existing]);
  const fillFrom = (f: typeof form, c: ContractCandidate) => ({
    ...f,
    candidateId: c.id,
    title: c.mpr.title,
    positionId: c.mpr.positionId ?? '',
    employmentType: c.mpr.employmentType,
    monthlySalary: f.monthlySalary || (c.mpr.salaryMin != null ? String(c.mpr.salaryMin) : ''),
  });

  async function save() {
    setBusy(true);
    setError(null);
    const body = {
      title: form.title.trim() || undefined,
      positionId: form.positionId || null,
      monthlySalary: Number(form.monthlySalary),
      allowances: form.allowances ? Number(form.allowances) : 0,
      allowanceNote: form.allowanceNote.trim() || null,
      employmentType: form.employmentType,
      startDate: form.startDate,
      periodEndDate: form.periodEndDate || null,
      workLocation: form.workLocation.trim() || null,
      ...(existing ? { terms: form.terms.trim() || null } : {}),
    };
    try {
      if (existing) {
        await api.patch(`/hiring/contracts/${existing.id}`, body);
        toast('ok', 'Contract saved');
        onSaved(existing.id);
      } else {
        const created = await api.post<{ id: string; number: string }>('/hiring/contracts', { ...body, candidateId: form.candidateId });
        toast('ok', `${created.number} saved as a draft`);
        onSaved(created.id);
      }
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={existing ? `Modify ${existing.number}` : 'New contract'}
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button type="button" className="btn btn-primary" disabled={busy || !form.candidateId || !form.monthlySalary || !form.startDate} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      {!existing && (
        <Field label="Employee name (hired)" hint="A candidate who passed the interview">
          <select
            value={form.candidateId}
            onChange={(e) => {
              const pick = candidates.find((c) => c.id === e.target.value);
              if (pick) setForm((f) => fillFrom({ ...f, monthlySalary: '' }, pick));
            }}
          >
            {!candidates.length && <option value="">— nobody at the contract stage —</option>}
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} — {c.mpr.title} ({c.mpr.number})
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className="grid grid-2">
        <Field label="Position title">
          <input value={form.title} onChange={(e) => set('title', e.target.value)} />
        </Field>
        <Field label="Plantilla position">
          <select value={form.positionId} onChange={(e) => set('positionId', e.target.value)}>
            <option value="">— none —</option>
            {positions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Agreed monthly salary">
          <NumberInput kind="money" value={form.monthlySalary} onChange={(e) => set('monthlySalary', e.target.value)} />
        </Field>
        <Field label="Allowances" hint="Per month">
          <NumberInput kind="money" value={form.allowances} onChange={(e) => set('allowances', e.target.value)} />
        </Field>
        <Field label="Contract effective start date">
          <input type="date" value={form.startDate} onChange={(e) => set('startDate', e.target.value)} />
        </Field>
        <Field label="Employment type">
          <select value={form.employmentType} onChange={(e) => set('employmentType', e.target.value)}>
            {EMPLOYMENT_TYPES.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Probation ends">
          <input type="date" value={form.periodEndDate} onChange={(e) => set('periodEndDate', e.target.value)} />
        </Field>
        <Field label="Work location">
          <input value={form.workLocation} onChange={(e) => set('workLocation', e.target.value)} />
        </Field>
      </div>
      <Field label="Allowance note" hint="Transport, meal, communication">
        <input value={form.allowanceNote} onChange={(e) => set('allowanceNote', e.target.value)} />
      </Field>
      {existing ? (
        <Field label="Terms and conditions">
          <textarea rows={8} value={form.terms} onChange={(e) => set('terms', e.target.value)} />
        </Field>
      ) : (
        <p className="faint">The standard terms are filled in; change them on Modify while it is a draft.</p>
      )}
    </Modal>
  );
}

function SignedModal({ contract, onClose, onDone }: { contract: ContractRow; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [on, setOn] = useState(today());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/hiring/contracts/${contract.id}/signed`, { signedOn: on });
      toast('ok', 'Recorded as signed');
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`Signed — ${contract.number}`}
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      <p>Record the day {contract.candidateName} signed the printed contract. Attach the signed copy under Files.</p>
      <Field label="Signed on">
        <input type="date" max={today()} value={on} onChange={(e) => setOn(e.target.value)} />
      </Field>
    </Modal>
  );
}

export function ContractPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const [row, setRow] = useState<ContractRow | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const [modifying, setModifying] = useState(false);
  const [signing, setSigning] = useState(false);
  const [hiring, setHiring] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setRow(await api.get<ContractRow>(`/hiring/contracts/${id}`));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  if (error && !row) return <ErrorBox error={error} />;
  if (!row) return <Loading />;
  const k = row;
  const done = () => {
    setReload((n) => n + 1);
    void load();
  };

  async function submit() {
    setError(null);
    try {
      await api.post(`/hiring/contracts/${k.id}/submit`);
      toast('ok', 'Sent for approval');
      done();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div>
      <RecordHeader
        type="Employment Contract"
        code={k.number}
        title={`${k.candidateName} — ${k.title}`}
        status={k.status}
        statusExtra={CONTRACT_TONES}
        statusLabel={CONTRACT_LABEL[k.status]}
        amount={`${formatMoney(k.monthlySalary, k.currency)} / month`}
        amountLabel={k.allowances ? `+ ${formatMoney(k.allowances, k.currency)} allowances` : 'Agreed monthly salary'}
        meta={
          <>
            Prepared by {k.preparedBy.name} on {formatDate(k.createdAt)} · for <Link to={`/g-hr/hiring/candidates/${k.candidate.id}`}>{k.candidateName}</Link> on{' '}
            <Link to={`/g-hr/hiring/mpr/${k.candidate.mpr.id}`}>{k.candidate.mpr.number}</Link>
            {k.candidate.mpr.team && <> · {k.candidate.mpr.team.code}</>}
          </>
        }
        actions={
          <>
            {k.canSubmit && (
              <button type="button" className="btn btn-primary" onClick={() => void submit()}>
                Submit for approval
              </button>
            )}
            {k.canSign && (
              <button type="button" className="btn btn-primary" onClick={() => setSigning(true)}>
                Mark signed
              </button>
            )}
            {k.canHire && (
              <button type="button" className="btn btn-primary" onClick={() => setHiring(true)}>
                Hire — create employee record
              </button>
            )}
          </>
        }
        print={`/api/hiring/contracts/${k.id}/pdf`}
        more={[
          k.canWithdraw && {
            label: 'Pull back to draft',
            confirm: {
              title: `Pull ${k.number} back?`,
              body: 'The approval request is withdrawn and its approvers are told.',
              confirmLabel: 'Pull it back',
              onConfirm: async () => {
                await api.post(`/hiring/contracts/${k.id}/withdraw`);
                toast('ok', 'Back to draft');
                done();
              },
            },
          },
          k.canCancel && {
            label: 'Cancel contract',
            danger: true,
            confirm: {
              title: `Cancel ${k.number}?`,
              body: k.status === 'PENDING_APPROVAL' ? 'The approval request is withdrawn with it.' : 'The candidate stays at the contract stage; a new contract may be prepared.',
              confirmLabel: 'Cancel contract',
              reason: 'required' as const,
              minReason: 3,
              onConfirm: async (reason: string) => {
                await api.post(`/hiring/contracts/${k.id}/cancel`, { reason });
                toast('ok', 'Cancelled');
                done();
              },
            },
          },
          k.canDelete && {
            label: 'Delete',
            danger: true,
            confirm: {
              title: `Delete ${k.number}?`,
              body: 'It goes for good, with its files.',
              confirmLabel: 'Delete',
              onConfirm: async () => {
                await api.del(`/hiring/contracts/${k.id}`);
                toast('ok', 'Deleted');
                navigate('/g-hr/hiring/contracts');
              },
            },
          },
        ]}
        modify={k.canEdit ? () => setModifying(true) : undefined}
        confirm={confirm}
      />
      {k.status === 'DRAFT' && <RoutePreview route={k.approvalRoute} />}
      <DecisionNote documentType="employment_contract" documentId={k.id} reloadToken={reload} />
      {k.status !== 'DRAFT' && k.status !== 'CANCELLED' && <DocumentApproval documentType="employment_contract" documentId={k.id} reloadToken={reload} />}
      <ErrorBox error={error} />
      {k.status === 'APPROVED' && (
        <div className="alert info">Approved. Print it for the wet signature, then mark it signed and attach the signed copy under Files.</div>
      )}

      <div className="stack">
        <section className="card">
          <h3 className="card-title">Employment contract</h3>
          <div className="hiring-boxes">
            <div className="hiring-box">
              <span className="hiring-box-label">Employee name (hired)</span>
              <strong>{k.candidateName}</strong>
            </div>
            <div className="hiring-box">
              <span className="hiring-box-label">Position title</span>
              <strong>{k.title}</strong>
            </div>
            <div className="hiring-box">
              <span className="hiring-box-label">Agreed monthly salary</span>
              <strong>
                {formatMoney(k.monthlySalary, k.currency)} / month{k.allowances ? ` + ${formatMoney(k.allowances, k.currency)} allowances` : ''}
              </strong>
            </div>
            <div className="hiring-box">
              <span className="hiring-box-label">Contract effective start date</span>
              <strong>{formatDate(k.startDate)}</strong>
            </div>
          </div>
          <dl className="kv">
            <dt>Employment type</dt>
            <dd>{typeLabel(k.employmentType)}</dd>
            <dt>Probation ends</dt>
            <dd>{k.periodEndDate ? formatDate(k.periodEndDate) : '—'}</dd>
            <dt>Work location</dt>
            <dd>{k.workLocation ?? '—'}</dd>
            {k.allowanceNote && (
              <>
                <dt>Allowances</dt>
                <dd>{k.allowanceNote}</dd>
              </>
            )}
            {k.signedOn && (
              <>
                <dt>Signed on</dt>
                <dd>{formatDate(k.signedOn)}</dd>
              </>
            )}
            {k.candidate.employeeId && (
              <>
                <dt>Employee record</dt>
                <dd>
                  <Link to={`/g-hr/employees/${k.candidate.employeeId}`}>Open the employee record</Link>
                </dd>
              </>
            )}
            {k.cancelReason && k.status === 'CANCELLED' && (
              <>
                <dt>Cancelled because</dt>
                <dd>{k.cancelReason}</dd>
              </>
            )}
          </dl>
        </section>
        {k.terms && (
          <section className="card">
            <h3 className="card-title">Terms and conditions</h3>
            <p className="hiring-terms">{k.terms}</p>
          </section>
        )}
        <Attachments entityType="employment_contract" entityId={k.id} title="Files" hint="The signed copy, the offer, IDs" canEdit={k.canEdit || k.canSign || k.canHire} />
      </div>

      {modifying && (
        <ContractModal
          existing={k}
          onClose={() => setModifying(false)}
          onSaved={() => {
            setModifying(false);
            void load();
          }}
        />
      )}
      {signing && (
        <SignedModal
          contract={k}
          onClose={() => setSigning(false)}
          onDone={() => {
            setSigning(false);
            void load();
          }}
        />
      )}
      {hiring && (
        <NewPersonModal
          door="hr"
          prefill={{
            firstName: k.candidate.firstName,
            lastName: k.candidate.lastName,
            personalEmail: k.candidate.email ?? undefined,
            mobile: k.candidate.phone ?? undefined,
            industryId: k.candidate.mpr.teamId ?? undefined,
            position: k.title,
            employmentType: k.employmentType,
            dateHired: k.startDate.slice(0, 10),
            periodEndDate: k.periodEndDate?.slice(0, 10),
          }}
          onCreated={async (employeeId) => {
            await api.post(`/hiring/contracts/${k.id}/hire`, { employeeId });
            toast('ok', `${k.candidateName} hired`);
          }}
          onClose={() => setHiring(false)}
          onSaved={() => {
            setHiring(false);
            void load();
          }}
        />
      )}
    </div>
  );
}
