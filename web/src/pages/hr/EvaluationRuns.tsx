import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, downloadBlob, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { RecordHeader } from '../../components/RecordHeader';
import { useConfirm } from '../../components/Confirm';
import { useUnsavedChanges } from '../../components/Navigation';
import { PersonSelect, usePeople } from '../../components/People';
import { NumberInput } from '../../components/NumberInput';
import { Empty, ErrorBox, Field, Loading, Modal, ModalFoot, StatusBadge, formatDate, formatDateTime, useToast } from '../../components/ui';

/**
 * Evaluation runs (2026-11-13, the owner's call: "run an evaluation for
 * certain people, particularly trainees; HR adds the questions; after all
 * have answered there should be a report"). HR writes the run — questions,
 * the people, their evaluators — and opens it; each evaluator answers their
 * own on `/answer/:id` (no right needed); the report ranks the people by
 * their weighted average. API: routes/evaluationRuns.ts.
 */

type Status = 'DRAFT' | 'OPEN' | 'CLOSED';
interface RunSummary {
  id: string;
  number: string;
  title: string;
  dueOn: string | null;
  status: Status;
  releasedAt: string | null;
  progress: { answered: number; asked: number };
  people?: number;
  createdBy: { name: string };
}
interface Run extends RunSummary {
  description: string | null;
  openedAt: string | null;
  closedAt: string | null;
  remindedAt: string | null;
  questions: { id: string; kind: 'RATING' | 'COMMENT'; prompt: string; weight: number }[];
  targets: { id: string; employee: { id: string; name: string; employeeNo: string | null; position: string | null; team: string | null }; evaluators: { assignmentId: string; userId: string; name: string; role: string | null; submittedAt: string | null }[] }[];
  canEdit: boolean;
  canOpen: boolean;
  canRemind: boolean;
  canClose: boolean;
  canReopen: boolean;
  canRelease: boolean;
  canDelete: boolean;
}
interface Mine {
  toAnswer: { id: string; run: { id: string; number: string; title: string; status: string; dueOn: string | null }; person: string; position: string | null; role: string | null; submittedAt: string | null; open: boolean }[];
  results: { runId: string; number: string; title: string; releasedAt: string }[];
}
interface PersonReport {
  targetId: string;
  name: string;
  employeeNo: string | null;
  position: string | null;
  team: string | null;
  answered: number;
  asked: number;
  overall: number | null;
  perQuestion: { questionId: string; prompt: string; weight: number; average: number | null; count: number }[];
  comments: { prompt: string; answers: { by: string; text: string }[] }[];
  pending?: string[];
}

const STATUS_LABEL: Record<Status, string> = { DRAFT: 'Draft', OPEN: 'Open — evaluators answering', CLOSED: 'Closed' };
const STATUS_TONES = { DRAFT: '', OPEN: 'warn', CLOSED: 'ok' } as const;
const fmt = (v: number | null) => (v == null ? '—' : v.toFixed(2));

/** What the caller has to answer and their released results — shown to everyone. */
function MyEvaluations() {
  const [mine, setMine] = useState<Mine | null>(null);
  useEffect(() => {
    api.get<Mine>('/evaluation-runs/mine').then(setMine).catch(() => setMine(null));
  }, []);
  if (!mine || (!mine.toAnswer.length && !mine.results.length)) return null;
  return (
    <section className="card">
      <h3 className="card-title">My evaluations</h3>
      {mine.toAnswer.length > 0 && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Evaluate</th>
                <th>Evaluation</th>
                <th>Due</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {mine.toAnswer.map((a) => (
                <tr key={a.id}>
                  <td>
                    <strong>{a.person}</strong>
                    <div className="faint">{[a.position, a.role ? `you as ${a.role}` : null].filter(Boolean).join(' · ')}</div>
                  </td>
                  <td>
                    {a.run.title} <span className="faint mono">{a.run.number}</span>
                  </td>
                  <td>{a.run.dueOn ? formatDate(a.run.dueOn) : '—'}</td>
                  <td>
                    {a.submittedAt ? (
                      <StatusBadge status="DONE" extra={{ DONE: 'ok' }} label="Submitted" />
                    ) : a.open ? (
                      <Link className="btn btn-primary btn-sm" to={`/g-hr/evaluation-runs/answer/${a.id}`}>
                        Answer
                      </Link>
                    ) : (
                      <span className="faint">closed</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {mine.results.length > 0 && (
        <ul>
          {mine.results.map((r) => (
            <li key={r.runId}>
              <Link to={`/g-hr/evaluation-runs/result/${r.runId}`}>Your result — {r.title}</Link> <span className="faint">released {formatDate(r.releasedAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function EvaluationRuns() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [rows, setRows] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api
      .get<{ rows: RunSummary[] }>('/evaluation-runs')
      .then((r) => setRows(r.rows))
      .catch(setError);
  }, []);
  async function create() {
    setBusy(true);
    try {
      const run = await api.post<Run>('/evaluation-runs', { title });
      toast('ok', `${run.number} started`);
      navigate(`/g-hr/evaluation-runs/${run.id}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Evaluation Runs</h1>
        </div>
        {(can('ghr.evaluation_runs.create') || can('ghr.evaluation_runs.edit_all')) && (
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
            + New evaluation run
          </button>
        )}
      </div>
      <MyEvaluations />
      <ErrorBox error={error} />
      <section className="card">
        {!rows ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty title="No evaluation runs yet" hint="Start one for a batch of trainees: the questions, the people, and who evaluates each." />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Evaluation</th>
                  <th>People</th>
                  <th>Answered</th>
                  <th>Due</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} tabIndex={0} onClick={() => navigate(`/g-hr/evaluation-runs/${r.id}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/g-hr/evaluation-runs/${r.id}`)}>
                    <td>
                      <Link to={`/g-hr/evaluation-runs/${r.id}`} className="mono" onClick={(e) => e.stopPropagation()}>
                        {r.number}
                      </Link>
                    </td>
                    <td>
                      {r.title}
                      <div className="faint">by {r.createdBy.name}</div>
                    </td>
                    <td>{r.people ?? 0}</td>
                    <td>
                      {r.progress.answered} of {r.progress.asked}
                    </td>
                    <td>{r.dueOn ? formatDate(r.dueOn) : '—'}</td>
                    <td>
                      <StatusBadge status={r.status} extra={STATUS_TONES} label={r.releasedAt ? 'Closed — released' : STATUS_LABEL[r.status]} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {adding && (
        <Modal
          title="New evaluation run"
          onClose={() => setAdding(false)}
          footer={
            <ModalFoot onCancel={() => setAdding(false)} busy={busy}>
              <button type="button" className="btn btn-primary" disabled={busy || title.trim().length < 3} onClick={() => void create()}>
                {busy ? 'Saving…' : 'Save'}
              </button>
            </ModalFoot>
          }
        >
          <Field label="What is evaluated" hint="e.g. Trainee batch — first-month evaluation">
            <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          </Field>
        </Modal>
      )}
    </div>
  );
}

interface EmployeeHit {
  id: string;
  firstName: string;
  lastName: string;
  employeeNo: string | null;
  position: string | null;
  employmentType?: string | null;
}

type DraftTarget = { employeeId: string; name: string; sub: string; evaluators: { userId: string; role: string }[] };

/** The run: its draft editor, its progress, and the report. */
export function EvaluationRunPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const { people } = usePeople();
  const [run, setRun] = useState<Run | null>(null);
  const [report, setReport] = useState<{ ranked: PersonReport[]; questions: Run['questions']; progress: Run['progress'] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [draft, setDraft] = useState<{ title: string; description: string; dueOn: string; questions: { kind: 'RATING' | 'COMMENT'; prompt: string; weight: string }[]; targets: DraftTarget[] } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [term, setTerm] = useState('');
  const [hits, setHits] = useState<EmployeeHit[]>([]);
  const [busy, setBusy] = useState(false);
  useUnsavedChanges(dirty);

  const load = useCallback(async () => {
    try {
      const r = await api.get<Run>(`/evaluation-runs/${id}`);
      setRun(r);
      setDraft({
        title: r.title,
        description: r.description ?? '',
        dueOn: r.dueOn ? r.dueOn.slice(0, 10) : '',
        questions: r.questions.map((q) => ({ kind: q.kind, prompt: q.prompt, weight: String(q.weight) })),
        targets: r.targets.map((t) => ({ employeeId: t.employee.id, name: t.employee.name, sub: [t.employee.employeeNo, t.employee.position].filter(Boolean).join(' · '), evaluators: t.evaluators.map((e) => ({ userId: e.userId, role: e.role ?? '' })) })),
      });
      setDirty(false);
      if (r.status !== 'DRAFT') setReport(await api.get(`/evaluation-runs/${id}/report`));
    } catch (err) {
      setError(err);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!run?.canEdit || term.trim().length < 2) {
      setHits([]);
      return undefined;
    }
    const t = setTimeout(() => {
      api
        .get<EmployeeHit[]>(`/employees/lookup${qs({ q: term, active: 'true' })}`)
        .then(setHits)
        .catch(() => setHits([]));
    }, 250);
    return () => clearTimeout(t);
  }, [term, run?.canEdit]);

  if (error && !run) return <ErrorBox error={error} />;
  if (!run || !draft) return <Loading />;
  const change = (patch: Partial<NonNullable<typeof draft>>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
    setDirty(true);
  };

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      await api.put(`/evaluation-runs/${id}`, {
        title: draft.title,
        description: draft.description || null,
        dueOn: draft.dueOn || null,
        questions: draft.questions.map((q) => ({ kind: q.kind, prompt: q.prompt, weight: Number(q.weight) || 1 })),
        targets: draft.targets.map((t) => ({ employeeId: t.employeeId, evaluators: t.evaluators.filter((e) => e.userId).map((e) => ({ userId: e.userId, role: e.role || null })) })),
      });
      toast('ok', 'Saved');
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  const act = (path: string, words: string) => async () => {
    await api.post(`/evaluation-runs/${id}/${path}`, {});
    toast('ok', words);
    await load();
  };

  return (
    <div className="stack">
      <RecordHeader
        type="Evaluation run"
        code={run.number}
        title={run.title}
        status={run.status}
        statusLabel={run.releasedAt ? 'Closed — released' : STATUS_LABEL[run.status]}
        statusExtra={STATUS_TONES}
        meta={
          <>
            {run.progress.answered} of {run.progress.asked} answered{run.dueOn ? ` · due ${formatDate(run.dueOn)}` : ''}
            {run.remindedAt ? ` · reminded ${formatDateTime(run.remindedAt)}` : ''}
          </>
        }
        actions={
          <>
            {run.canOpen && (
              <button
                type="button"
                className="btn btn-primary"
                disabled={dirty}
                title={dirty ? 'Save first' : undefined}
                onClick={() =>
                  confirm.ask({
                    title: `Open ${run.number}?`,
                    body: 'Every evaluator is told and asked to answer. The questions and people are fixed from then on.',
                    confirmLabel: 'Open and tell the evaluators',
                    tone: 'primary',
                    onConfirm: act('open', 'Opened — the evaluators are told'),
                  })
                }
              >
                Open for answers
              </button>
            )}
            {run.canRemind && (
              <button type="button" className="btn" onClick={() => void act('remind', 'Reminded those still to answer')().catch(setError)}>
                Remind
              </button>
            )}
            {run.canRelease && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() =>
                  confirm.ask({
                    title: 'Release the results?',
                    body: 'Each person evaluated can then read their own averages and the comments — never who wrote what.',
                    confirmLabel: 'Release',
                    tone: 'primary',
                    onConfirm: act('release', 'Released to the people evaluated'),
                  })
                }
              >
                Release results
              </button>
            )}
          </>
        }
        print={run.status !== 'DRAFT' ? `/api/evaluation-runs/${run.id}/report.pdf` : undefined}
        more={[
          run.status !== 'DRAFT' && {
            label: 'Export CSV',
            onSelect: () => void downloadBlob(`/evaluation-runs/${run.id}/report.csv`, `${run.number} report.csv`).catch(setError),
          },
          run.canClose && {
            label: 'Close it',
            hint: 'No more answers; the report stands as it is',
            confirm: { title: `Close ${run.number}?`, body: 'Evaluators who have not answered can no longer.', confirmLabel: 'Close', tone: 'primary', onConfirm: act('close', 'Closed') },
          },
          run.canReopen && { label: 'Reopen', confirm: { title: `Reopen ${run.number}?`, body: 'Evaluators who have not answered can again.', confirmLabel: 'Reopen', tone: 'primary', onConfirm: act('reopen', 'Reopened') } },
          run.canDelete && {
            label: 'Delete',
            danger: true,
            confirm: {
              title: `Delete ${run.number}?`,
              body: 'The draft goes for good.',
              confirmLabel: 'Delete',
              onConfirm: async () => {
                await api.del(`/evaluation-runs/${run.id}`);
                navigate('/g-hr/evaluation-runs');
              },
            },
          },
        ]}
        confirm={confirm}
      />
      <ErrorBox error={error} />

      {run.canEdit && (
        <>
          <section className="card">
            <div className="card-head">
              <h3 className="card-title">The evaluation</h3>
              <button type="button" className="btn btn-primary btn-sm" disabled={busy || !dirty} onClick={() => void save()}>
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
            <div className="grid grid-2">
              <Field label="What is evaluated">
                <input value={draft.title} onChange={(e) => change({ title: e.target.value })} />
              </Field>
              <Field label="Answer by">
                <input type="date" value={draft.dueOn} onChange={(e) => change({ dueOn: e.target.value })} />
              </Field>
            </div>
            <Field label="Instructions for the evaluators">
              <textarea rows={2} value={draft.description} onChange={(e) => change({ description: e.target.value })} />
            </Field>
          </section>
          <section className="card">
            <h3 className="card-title">Questions</h3>
            <p className="faint">A rating question is answered 1 (poor) to 5 (excellent) and counts by its weight; a comment question is written.</p>
            {draft.questions.map((q, i) => (
              <div key={i} className="row">
                <span className="mono">Q{i + 1}</span>
                <select value={q.kind} aria-label={`Kind of question ${i + 1}`} onChange={(e) => change({ questions: draft.questions.map((x, j) => (j === i ? { ...x, kind: e.target.value as 'RATING' | 'COMMENT' } : x)) })}>
                  <option value="RATING">Rating 1–5</option>
                  <option value="COMMENT">Comment</option>
                </select>
                <input aria-label={`Question ${i + 1}`} value={q.prompt} placeholder="e.g. Follows safety procedures on site" onChange={(e) => change({ questions: draft.questions.map((x, j) => (j === i ? { ...x, prompt: e.target.value } : x)) })} />
                {q.kind === 'RATING' && (
                  <NumberInput kind="decimal" aria-label={`Weight of question ${i + 1}`} min={0.1} max={100} value={q.weight} onChange={(e) => change({ questions: draft.questions.map((x, j) => (j === i ? { ...x, weight: e.target.value } : x)) })} />
                )}
                <button type="button" className="btn btn-sm btn-icon" title="Remove" aria-label={`Remove question ${i + 1}`} onClick={() => change({ questions: draft.questions.filter((_, j) => j !== i) })}>
                  ✕
                </button>
              </div>
            ))}
            <div className="row">
              <button type="button" className="btn btn-sm" onClick={() => change({ questions: [...draft.questions, { kind: 'RATING', prompt: '', weight: '1' }] })}>
                + Add rating question
              </button>
              <button type="button" className="btn btn-sm" onClick={() => change({ questions: [...draft.questions, { kind: 'COMMENT', prompt: '', weight: '1' }] })}>
                + Add comment question
              </button>
            </div>
          </section>
          <section className="card">
            <h3 className="card-title">People evaluated and their evaluators</h3>
            <Field label="Add a person" hint="Type a name — trainees, or anyone">
              <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Type a name or employee no.…" />
            </Field>
            {hits.length > 0 && (
              <ul className="asset-hits">
                {hits
                  .filter((h) => !draft.targets.some((t) => t.employeeId === h.id))
                  .slice(0, 8)
                  .map((h) => (
                    <li key={h.id}>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => {
                          change({ targets: [...draft.targets, { employeeId: h.id, name: `${h.firstName} ${h.lastName}`, sub: [h.employeeNo, h.position].filter(Boolean).join(' · '), evaluators: [{ userId: '', role: 'Superior' }] }] });
                          setTerm('');
                        }}
                      >
                        {h.firstName} {h.lastName}
                        <span className="faint"> {[h.employeeNo, h.position].filter(Boolean).join(' · ')}</span>
                      </button>
                    </li>
                  ))}
              </ul>
            )}
            {draft.targets.length === 0 && <p className="muted">Nobody added yet.</p>}
            {draft.targets.map((t, ti) => (
              <div key={t.employeeId} className="prq-panel stack">
                <div className="row">
                  <strong>{t.name}</strong>
                  <span className="faint">{t.sub}</span>
                  <button type="button" className="btn btn-sm btn-icon" title="Remove" aria-label={`Remove ${t.name}`} onClick={() => change({ targets: draft.targets.filter((_, j) => j !== ti) })}>
                    ✕
                  </button>
                </div>
                {t.evaluators.map((e, ei) => (
                  <div key={ei} className="row">
                    <PersonSelect
                      people={people}
                      value={e.userId}
                      placeholder="— choose the evaluator —"
                      onChange={(v) => change({ targets: draft.targets.map((x, j) => (j === ti ? { ...x, evaluators: x.evaluators.map((y, k) => (k === ei ? { ...y, userId: v } : y)) } : x)) })}
                    />
                    <select
                      aria-label="As"
                      value={e.role}
                      onChange={(ev) => change({ targets: draft.targets.map((x, j) => (j === ti ? { ...x, evaluators: x.evaluators.map((y, k) => (k === ei ? { ...y, role: ev.target.value } : y)) } : x)) })}
                    >
                      {['Superior', 'Trainer', 'Peer', 'HR', 'Other'].map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn btn-sm btn-icon"
                      title="Remove"
                      aria-label="Remove this evaluator"
                      onClick={() => change({ targets: draft.targets.map((x, j) => (j === ti ? { ...x, evaluators: x.evaluators.filter((_, k) => k !== ei) } : x)) })}
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <div>
                  <button type="button" className="btn btn-sm" onClick={() => change({ targets: draft.targets.map((x, j) => (j === ti ? { ...x, evaluators: [...x.evaluators, { userId: '', role: 'Peer' }] } : x)) })}>
                    + Add evaluator
                  </button>
                </div>
              </div>
            ))}
          </section>
          <div className="page-foot">
            <button type="button" className="btn btn-primary" disabled={busy || !dirty} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </>
      )}

      {report && (
        <>
          <section className="card">
            <h3 className="card-title">Report — ranked by overall (1–5)</h3>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Rank</th>
                    <th>Person</th>
                    <th>Answered</th>
                    <th>Overall</th>
                    {report.questions
                      .filter((q) => q.kind === 'RATING')
                      .map((q, i) => (
                        <th key={q.id} title={q.prompt}>
                          Q{i + 1}
                        </th>
                      ))}
                  </tr>
                </thead>
                <tbody>
                  {report.ranked.map((p, i) => (
                    <tr key={p.targetId}>
                      <td>{i + 1}</td>
                      <td>
                        <strong>{p.name}</strong>
                        <div className="faint">{[p.employeeNo, p.position, p.team].filter(Boolean).join(' · ')}</div>
                        {p.pending && p.pending.length > 0 && <div className="faint">waiting on {p.pending.join(', ')}</div>}
                      </td>
                      <td>
                        {p.answered} of {p.asked}
                      </td>
                      <td className="mono">
                        <strong>{fmt(p.overall)}</strong>
                      </td>
                      {p.perQuestion.map((x) => (
                        <td key={x.questionId} className="mono">
                          {fmt(x.average)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ol className="faint">
              {report.questions
                .filter((q) => q.kind === 'RATING')
                .map((q) => (
                  <li key={q.id}>
                    {q.prompt} <span>(weight {q.weight})</span>
                  </li>
                ))}
            </ol>
          </section>
          {report.ranked
            .filter((p) => p.comments.some((c) => c.answers.length))
            .map((p) => (
              <section className="card" key={`c${p.targetId}`}>
                <h3 className="card-title">Comments — {p.name}</h3>
                {p.comments
                  .filter((c) => c.answers.length)
                  .map((c) => (
                    <div key={c.prompt}>
                      <p>
                        <strong>{c.prompt}</strong>
                      </p>
                      <ul>
                        {c.answers.map((a, i) => (
                          <li key={i}>
                            <span className="faint">{a.by}:</span> {a.text}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
              </section>
            ))}
        </>
      )}
    </div>
  );
}

/** The evaluator's page: one person, the questions, their answers — saved, then submitted once. */
export function EvaluationAnswerPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const [a, setA] = useState<{
    id: string;
    run: { id: string; number: string; title: string; description: string | null; dueOn: string | null; status: string };
    person: { name: string; employeeNo: string | null; position: string | null; team: string | null };
    role: string | null;
    submittedAt: string | null;
    canAnswer: boolean;
    questions: { id: string; kind: 'RATING' | 'COMMENT'; prompt: string }[];
    answers: { questionId: string; rating: number | null; comment: string | null }[];
  } | null>(null);
  const [answers, setAnswers] = useState<Record<string, { rating: number | null; comment: string }>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const r = await api.get<NonNullable<typeof a>>(`/evaluation-runs/assignments/${id}`);
      setA(r);
      setAnswers(Object.fromEntries(r.answers.map((x) => [x.questionId, { rating: x.rating, comment: x.comment ?? '' }])));
    } catch (err) {
      setError(err);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  if (error && !a) return <ErrorBox error={error} />;
  if (!a) return <Loading />;
  const rated = a.questions.filter((q) => q.kind === 'RATING').every((q) => answers[q.id]?.rating != null);
  async function send(submit: boolean) {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/evaluation-runs/assignments/${id}`, { submit, answers: Object.entries(answers).map(([questionId, x]) => ({ questionId, rating: x.rating, comment: x.comment })) });
      toast('ok', submit ? 'Submitted — thank you' : 'Saved');
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  const set = (qid: string, patch: Partial<{ rating: number | null; comment: string }>) => setAnswers((m) => ({ ...m, [qid]: { ...{ rating: null, comment: '' }, ...m[qid], ...patch } }));
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Evaluate {a.person.name}</h1>
          <p className="faint">
            {a.run.title} · {a.run.number}
            {a.role ? ` · you as ${a.role}` : ''}
            {a.run.dueOn ? ` · by ${formatDate(a.run.dueOn)}` : ''}
          </p>
        </div>
      </div>
      <ErrorBox error={error} />
      {a.submittedAt && <div className="alert ok">Submitted on {formatDateTime(a.submittedAt)}. Thank you.</div>}
      {!a.canAnswer && !a.submittedAt && <div className="alert warn">This evaluation is closed.</div>}
      {a.run.description && <div className="alert info">{a.run.description}</div>}
      <section className="card">
        <p className="faint">
          {[a.person.employeeNo, a.person.position, a.person.team].filter(Boolean).join(' · ')} — rate each from 1 (poor) to 5 (excellent).
        </p>
        <ol className="exam-questions">
          {a.questions.map((q) => (
            <li key={q.id} className="exam-question">
              <p className="exam-prompt">{q.prompt}</p>
              {q.kind === 'RATING' ? (
                <div className="scope-switch" role="radiogroup" aria-label={q.prompt}>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button key={n} type="button" role="radio" aria-checked={answers[q.id]?.rating === n} className={answers[q.id]?.rating === n ? 'active' : ''} disabled={!a.canAnswer} onClick={() => set(q.id, { rating: n })}>
                      {n}
                    </button>
                  ))}
                </div>
              ) : (
                <textarea rows={3} value={answers[q.id]?.comment ?? ''} disabled={!a.canAnswer} onChange={(e) => set(q.id, { comment: e.target.value })} aria-label={q.prompt} />
              )}
            </li>
          ))}
        </ol>
      </section>
      {a.canAnswer && (
        <div className="page-foot">
          <button type="button" className="btn" disabled={busy} onClick={() => void send(false)}>
            Save
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !rated} title={rated ? undefined : 'Rate every question first'} onClick={() => void send(true)}>
            Submit
          </button>
        </div>
      )}
    </div>
  );
}

/** The person evaluated reads their own released result: averages and comments, never names. */
export function EvaluationResultPage() {
  const { id } = useParams<{ id: string }>();
  const [r, setR] = useState<{ run: { number: string; title: string; releasedAt: string }; questions: Run['questions']; person: PersonReport } | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api.get<NonNullable<typeof r>>(`/evaluation-runs/${id}/my-result`).then(setR).catch(setError);
  }, [id]);
  if (error) return <ErrorBox error={error} />;
  if (!r) return <Loading />;
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Your evaluation — {r.run.title}</h1>
          <p className="faint">
            {r.run.number} · released {formatDate(r.run.releasedAt)} · {r.person.answered} evaluator{r.person.answered === 1 ? '' : 's'} answered
          </p>
        </div>
      </div>
      <section className="card">
        <h3 className="card-title">Overall — {fmt(r.person.overall)} out of 5</h3>
        <dl className="kv">
          {r.person.perQuestion.flatMap((q) => [
            <dt key={`t${q.questionId}`}>{q.prompt}</dt>,
            <dd key={`d${q.questionId}`} className="mono">
              {fmt(q.average)}
            </dd>,
          ])}
        </dl>
      </section>
      {r.person.comments.some((c) => c.answers.length) && (
        <section className="card">
          <h3 className="card-title">Comments</h3>
          {r.person.comments
            .filter((c) => c.answers.length)
            .map((c) => (
              <div key={c.prompt}>
                <p>
                  <strong>{c.prompt}</strong>
                </p>
                <ul>
                  {c.answers.map((x, i) => (
                    <li key={i}>
                      <span className="faint">{x.by}:</span> {x.text}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
        </section>
      )}
    </div>
  );
}
