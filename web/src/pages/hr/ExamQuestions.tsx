import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { qrDataUrl } from '../../lib/qrCode';
import { useUnsavedChanges } from '../../components/Navigation';
import { TickPicker } from '../../components/TickPicker';
import { NumberInput } from '../../components/NumberInput';
import { Empty, ErrorBox, Field, Loading, StatusBadge, formatDate, formatDateTime, useToast } from '../../components/ui';

/**
 * The Employment Examination's questions and the applicant's online sitting
 * (2026-11-13, the owner's call: "HR can add or modify questions; on an
 * applicant, issue a link or QR so they answer on a phone or another device").
 * The API is routes/employmentExams.ts.
 */

interface Question {
  id?: string;
  key: string;
  kind: 'CHOICE' | 'WRITTEN';
  prompt: string;
  choices: string[];
  correctIndex: number | null;
  points: string;
  answered?: number;
}
interface ExamDetail {
  id: string;
  name: string;
  description: string | null;
  maxScore: number;
  timeLimitMinutes: number;
  isActive: boolean;
  totalPoints: number;
  canEdit: boolean;
  questions: (Omit<Question, 'key' | 'points'> & { points: number; isActive: boolean; answered: number })[];
}

let seq = 0;
const newKey = () => `n${++seq}`;
const blankQuestion = (kind: Question['kind']): Question => ({ key: newKey(), kind, prompt: '', choices: kind === 'CHOICE' ? ['', ''] : [], correctIndex: kind === 'CHOICE' ? 0 : null, points: '1' });

/** G-HR › Hiring › Employment Examination › an exam: its questions, its time limit. */
export function ExamQuestionsPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const [exam, setExam] = useState<ExamDetail | null>(null);
  const [rows, setRows] = useState<Question[]>([]);
  const [minutes, setMinutes] = useState('30');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useUnsavedChanges(dirty);

  const load = useCallback(async () => {
    try {
      const e = await api.get<ExamDetail>(`/hiring/exams/${id}/questions`);
      setExam(e);
      setMinutes(String(e.timeLimitMinutes));
      setRows(e.questions.filter((q) => q.isActive).map((q) => ({ id: q.id, key: q.id!, kind: q.kind, prompt: q.prompt, choices: q.choices, correctIndex: q.correctIndex, points: String(q.points), answered: q.answered })));
      setDirty(false);
    } catch (err) {
      setError(err);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  if (error && !exam) return <ErrorBox error={error} />;
  if (!exam) return <Loading />;
  const editable = exam.canEdit;
  const change = (key: string, patch: Partial<Question>) => {
    setDirty(true);
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };
  const move = (key: string, by: -1 | 1) => {
    setDirty(true);
    setRows((rs) => {
      const i = rs.findIndex((r) => r.key === key);
      const j = i + by;
      if (j < 0 || j >= rs.length) return rs;
      const next = [...rs];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };
  const total = rows.reduce((s, r) => s + (Number(r.points) || 0), 0);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/hiring/exams/${id}/questions`, {
        timeLimitMinutes: Number(minutes) || 30,
        questions: rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          prompt: r.prompt,
          choices: r.kind === 'CHOICE' ? r.choices : [],
          correctIndex: r.kind === 'CHOICE' ? r.correctIndex : null,
          points: Number(r.points) || 1,
        })),
      });
      toast('ok', 'Questions saved');
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const saveButton = editable && (
    <button type="button" className="btn btn-primary" disabled={busy || !dirty} onClick={() => void save()}>
      {busy ? 'Saving…' : 'Save'}
    </button>
  );

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>{exam.name}</h1>
          <p className="faint">
            Employment Examination · scored out of {exam.maxScore} · {rows.length} question{rows.length === 1 ? '' : 's'}, {total} point{total === 1 ? '' : 's'}
          </p>
        </div>
        {saveButton}
      </div>
      <ErrorBox error={error} />
      <div className="card">
        <div className="grid grid-2">
          <Field label="Time limit (minutes)" hint="The applicant's countdown for this exam online; several exams on one link add up">
            <NumberInput kind="count" min={1} max={600} value={minutes} disabled={!editable} onChange={(e) => (setMinutes(e.target.value), setDirty(true))} />
          </Field>
          <div className="faint">
            A multiple-choice question is scored the moment the applicant submits; a written answer is scored by HR on the applicant's page. The exam's score is the points earned over
            the points possible, out of {exam.maxScore}.
          </div>
        </div>
      </div>
      {rows.length === 0 && <Empty title="No questions yet" hint="Add multiple-choice or written questions — an online link needs at least one." />}
      {rows.map((r, n) => (
        <section className="card" key={r.key}>
          <div className="card-head">
            <h3 className="card-title">
              Question {n + 1} · {r.kind === 'CHOICE' ? 'Multiple choice' : 'Written answer'}
              {r.answered ? <span className="faint"> · answered {r.answered} time{r.answered === 1 ? '' : 's'}</span> : null}
            </h3>
            {editable && (
              <div className="row">
                <button type="button" className="btn btn-sm btn-icon" aria-label={`Move question ${n + 1} up`} disabled={n === 0} onClick={() => move(r.key, -1)}>
                  ↑
                </button>
                <button type="button" className="btn btn-sm btn-icon" aria-label={`Move question ${n + 1} down`} disabled={n === rows.length - 1} onClick={() => move(r.key, 1)}>
                  ↓
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-icon"
                  title="Remove"
                  aria-label={`Remove question ${n + 1}`}
                  onClick={() => {
                    setDirty(true);
                    setRows((rs) => rs.filter((x) => x.key !== r.key));
                  }}
                >
                  ✕
                </button>
              </div>
            )}
          </div>
          <Field label="Question">
            <textarea rows={2} value={r.prompt} disabled={!editable} onChange={(e) => change(r.key, { prompt: e.target.value })} />
          </Field>
          {r.kind === 'CHOICE' && (
            <div className="stack">
              {r.choices.map((c, i) => (
                <div key={i} className="row">
                  <label className="checkbox" title="The correct answer">
                    <input type="radio" name={`correct-${r.key}`} checked={r.correctIndex === i} disabled={!editable} onChange={() => change(r.key, { correctIndex: i })} />
                    <span className="faint">correct</span>
                  </label>
                  <input
                    aria-label={`Choice ${i + 1}`}
                    value={c}
                    disabled={!editable}
                    placeholder={`Choice ${i + 1}`}
                    onChange={(e) => change(r.key, { choices: r.choices.map((x, j) => (j === i ? e.target.value : x)) })}
                  />
                  {editable && r.choices.length > 2 && (
                    <button
                      type="button"
                      className="btn btn-sm btn-icon"
                      title="Remove"
                      aria-label={`Remove choice ${i + 1}`}
                      onClick={() =>
                        change(r.key, {
                          choices: r.choices.filter((_, j) => j !== i),
                          correctIndex: r.correctIndex == null ? null : r.correctIndex === i ? 0 : r.correctIndex > i ? r.correctIndex - 1 : r.correctIndex,
                        })
                      }
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
              {editable && r.choices.length < 10 && (
                <div>
                  <button type="button" className="btn btn-sm" onClick={() => change(r.key, { choices: [...r.choices, ''] })}>
                    + Add choice
                  </button>
                </div>
              )}
            </div>
          )}
          <Field label="Points">
            <NumberInput kind="decimal" min={0.5} max={1000} value={r.points} disabled={!editable} onChange={(e) => change(r.key, { points: e.target.value })} />
          </Field>
        </section>
      ))}
      {editable && (
        <div className="row">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setDirty(true);
              setRows((rs) => [...rs, blankQuestion('CHOICE')]);
            }}
          >
            + Add multiple-choice question
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setDirty(true);
              setRows((rs) => [...rs, blankQuestion('WRITTEN')]);
            }}
          >
            + Add written question
          </button>
        </div>
      )}
      {saveButton && <div className="page-foot">{saveButton}</div>}
    </div>
  );
}

interface Sitting {
  id: string;
  status: string;
  statusLabel: string;
  exams: string[];
  minutes: number;
  issuedAt: string;
  issuedBy: string | null;
  expiresAt: string;
  startedAt: string | null;
  submittedAt: string | null;
  scoredAt: string | null;
  canCancel: boolean;
  canScore: boolean;
  answers: { id: string; exam: string; kind: 'CHOICE' | 'WRITTEN'; prompt: string; maxPoints: number; text: string | null; chosen: string | null; correct: string | null; points: number | null }[];
}

const SITTING_TONES = { ISSUED: 'info', STARTED: 'warn', SUBMITTED: 'warn', SCORED: 'ok', EXPIRED: '', CANCELLED: '' } as const;

/**
 * On the applicant's page: issue a link (and its QR) for the exams ticked,
 * follow each sitting, and score the written answers once submitted — the
 * scores then land on the applicant like scores typed by hand.
 */
export function OnlineExamCard({ candidateId, onScored }: { candidateId: string; onScored: () => void }) {
  const toast = useToast();
  const [data, setData] = useState<{ canIssue: boolean; rows: Sitting[] } | null>(null);
  const [exams, setExams] = useState<{ id: string; name: string; isActive: boolean }[]>([]);
  const [ticked, setTicked] = useState<string[]>([]);
  const [issued, setIssued] = useState<{ url: string; qr: string; expiresAt: string; minutes: number; exams: string[] } | null>(null);
  const [scoring, setScoring] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => {
    api
      .get<{ canIssue: boolean; rows: Sitting[] }>(`/hiring/candidates/${candidateId}/sittings`)
      .then(setData)
      .catch(setError);
  }, [candidateId]);
  useEffect(() => {
    load();
    api
      .get<{ exams: { id: string; name: string; isActive: boolean }[] }>('/hiring/exams')
      .then((r) => setExams(r.exams.filter((e) => e.isActive)))
      .catch(() => setExams([]));
  }, [load]);

  async function issue() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ url: string; expiresAt: string; minutes: number; exams: string[] }>(`/hiring/candidates/${candidateId}/exam-link`, { examIds: ticked });
      setIssued({ ...r, qr: await qrDataUrl(r.url).catch(() => '') });
      setTicked([]);
      load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  async function score(s: Sitting) {
    setBusy(true);
    setError(null);
    try {
      const written = s.answers.filter((a) => a.kind === 'WRITTEN' && a.points == null);
      const r = await api.post<{ scored: boolean }>(`/hiring/sittings/${s.id}/score`, {
        answers: written.map((a) => ({ id: a.id, points: Number(scoring[a.id]) || 0 })),
      });
      toast('ok', r.scored ? 'Scored — the exam scores are recorded on the applicant' : 'Saved');
      setScoring({});
      load();
      if (r.scored) onScored();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  async function cancel(s: Sitting) {
    try {
      await api.post(`/hiring/sittings/${s.id}/cancel`, {});
      toast('ok', 'Link cancelled');
      load();
    } catch (err) {
      setError(err);
    }
  }
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('ok', 'Link copied');
    } catch {
      toast('error', 'Copy it from the box instead');
    }
  };

  return (
    <section className="card">
      <h3 className="card-title">Online exam</h3>
      <ErrorBox error={error} />
      {data?.canIssue && (
        <div className="grid grid-2">
          <Field label="Exams on the link" hint="Taken one after another, on one countdown — their minutes added">
            <TickPicker search label="Exams" none="Tick the exams" noun="exams" choices={exams.map((e) => ({ value: e.id, label: e.name }))} value={ticked} onChange={setTicked} />
          </Field>
          <div>
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || !ticked.length} onClick={() => void issue()}>
              Issue exam link
            </button>
          </div>
        </div>
      )}
      {issued && (
        <div className="alert ok">
          <p>
            Send this to the applicant, or let them scan the QR with their phone. It opens for 7 days, runs {issued.minutes} minutes once started, and works once. It is shown only now —
            issue a new one if it is lost.
          </p>
          <div className="row">
            {issued.qr && <img className="exam-qr" src={issued.qr} alt="QR code of the exam link" />}
            <div className="stack">
              <input readOnly value={issued.url} aria-label="Exam link" onFocus={(e) => e.currentTarget.select()} />
              <div className="row">
                <button type="button" className="btn btn-sm" onClick={() => void copy(issued.url)}>
                  Copy link
                </button>
                <button type="button" className="btn btn-sm" onClick={() => setIssued(null)}>
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {!data ? (
        <Loading />
      ) : data.rows.length === 0 ? (
        <p className="muted hraud-flush">No exam link issued yet.</p>
      ) : (
        data.rows.map((s) => {
          const toScore = s.answers.filter((a) => a.kind === 'WRITTEN' && a.points == null);
          return (
            <div key={s.id} className="prq-panel stack">
              <div className="row">
                <StatusBadge status={s.status} extra={SITTING_TONES} label={s.statusLabel} />
                <span>{s.exams.join(', ')}</span>
                <span className="faint">
                  issued {formatDate(s.issuedAt)}
                  {s.issuedBy ? ` by ${s.issuedBy}` : ''} · {s.minutes} min
                  {s.status === 'ISSUED' ? ` · open until ${formatDate(s.expiresAt)}` : ''}
                  {s.submittedAt ? ` · submitted ${formatDateTime(s.submittedAt)}` : ''}
                </span>
                {s.canCancel && (
                  <button type="button" className="btn btn-sm" onClick={() => void cancel(s)}>
                    Cancel link
                  </button>
                )}
              </div>
              {s.canScore && toScore.length > 0 && (
                <>
                  <p className="faint">Score the written answers — the multiple-choice ones are scored already.</p>
                  {toScore.map((a) => (
                    <div key={a.id} className="card">
                      <p>
                        <strong>{a.exam}:</strong> {a.prompt} <span className="faint">(up to {a.maxPoints})</span>
                      </p>
                      <p className="memo-reply-text">{a.text}</p>
                      <Field label="Points">
                        <NumberInput kind="decimal" min={0} max={a.maxPoints} value={scoring[a.id] ?? ''} onChange={(e) => setScoring((m) => ({ ...m, [a.id]: e.target.value }))} />
                      </Field>
                    </div>
                  ))}
                  <div>
                    <button type="button" className="btn btn-primary btn-sm" disabled={busy || toScore.some((a) => scoring[a.id] === undefined || scoring[a.id] === '')} onClick={() => void score(s)}>
                      Save the scores
                    </button>
                  </div>
                </>
              )}
            </div>
          );
        })
      )}
    </section>
  );
}
