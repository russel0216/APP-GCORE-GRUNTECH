import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LandingBrand } from './Login';

/**
 * The applicant's Employment Examination (2026-11-13, the owner's call: "an
 * applicant can be issued a link or QR so they answer on their phone or a
 * separate device — they have no access to G-CORE"). Opened with no login:
 * the link's #t= token is the key, posted in the body of every call and never
 * sent as part of an address. One sitting, one countdown from Start; answers
 * save as they are given, so the time running out loses nothing; Submit (or
 * the clock reaching zero) closes it for good. Built for a phone.
 */

interface Question {
  id: string;
  kind: 'CHOICE' | 'WRITTEN';
  prompt: string;
  choices: string[];
  points: number;
}
interface Paper {
  exams: { id: string; name: string; description: string | null; questions: Question[] }[];
  answers: { questionId: string; choiceIndex: number | null; text: string | null }[];
}
interface View {
  company: string;
  name: string;
  position: string;
  status: 'ISSUED' | 'STARTED' | 'SUBMITTED' | 'SCORED' | 'EXPIRED' | 'CANCELLED';
  minutes: number;
  expiresAt: string;
  deadlineAt: string | null;
  now: string;
  exams: { name: string; questions: number }[];
  paper?: Paper;
}
type Answer = { choiceIndex: number | null; text: string };

async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`/api/public/exam/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error || 'Something went wrong — try again');
  return data as T;
}

const tokenFromHash = () => new URLSearchParams(window.location.hash.replace(/^#/, '')).get('t') ?? '';

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(sec).padStart(2, '0')}`;
};

export function PublicExam() {
  const token = useMemo(tokenFromHash, []);
  const [view, setView] = useState<View | null>(null);
  const [paper, setPaper] = useState<Paper | null>(null);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [deadline, setDeadline] = useState<number | null>(null);
  const [skew, setSkew] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [saved, setSaved] = useState<'saved' | 'saving' | 'failed' | null>(null);
  const dirty = useRef<Set<string>>(new Set());
  const submitting = useRef(false);

  const open = useCallback((p: Paper, deadlineAt: string | null, serverNow: string) => {
    setPaper(p);
    const a: Record<string, Answer> = {};
    for (const x of p.answers) a[x.questionId] = { choiceIndex: x.choiceIndex, text: x.text ?? '' };
    setAnswers(a);
    // The countdown runs on the server's clock: the phone's may be wrong.
    setSkew(Date.parse(serverNow) - Date.now());
    setDeadline(deadlineAt ? Date.parse(deadlineAt) : null);
  }, []);

  useEffect(() => {
    if (!token) {
      setError('This exam link is not complete — open the whole link HR sent you, or scan the QR again.');
      return;
    }
    call<View>('view', { token })
      .then((v) => {
        setView(v);
        if (v.paper) open(v.paper, v.deadlineAt, v.now);
      })
      .catch((e: Error) => setError(e.message));
  }, [token, open]);

  useEffect(() => {
    if (!paper || done) return undefined;
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, [paper, done]);

  const answerList = useCallback(
    (only?: Set<string>) =>
      Object.entries(answers)
        .filter(([id]) => !only || only.has(id))
        .map(([questionId, a]) => ({ questionId, choiceIndex: a.choiceIndex, text: a.text })),
    [answers],
  );

  // Save what changed, a moment after the last change.
  useEffect(() => {
    if (!paper || done || !dirty.current.size) return undefined;
    const t = window.setTimeout(() => {
      const ids = new Set(dirty.current);
      dirty.current.clear();
      setSaved('saving');
      call('answers', { token, answers: answerList(ids) })
        .then(() => setSaved('saved'))
        .catch(() => {
          ids.forEach((id) => dirty.current.add(id));
          setSaved('failed');
        });
    }, 800);
    return () => window.clearTimeout(t);
  }, [answers, paper, done, token, answerList]);

  const submit = useCallback(
    async (auto: boolean) => {
      if (submitting.current) return;
      submitting.current = true;
      setBusy(true);
      try {
        await call('submit', { token, answers: answerList() });
        setDone(auto ? 'The time is up — your answers were submitted.' : 'Submitted. Thank you — HR will be in touch.');
      } catch (e) {
        setError((e as Error).message);
        submitting.current = false;
      } finally {
        setBusy(false);
      }
    },
    [token, answerList],
  );

  const left = deadline ? deadline - (now + skew) : null;
  useEffect(() => {
    if (left != null && left <= 0 && paper && !done) void submit(true);
  }, [left, paper, done, submit]);

  async function start() {
    setBusy(true);
    setError('');
    try {
      const r = await call<{ deadlineAt: string; now: string; paper: Paper }>('start', { token });
      open(r.paper, r.deadlineAt, r.now);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const set = (id: string, a: Partial<Answer>) => {
    dirty.current.add(id);
    setAnswers((cur) => ({ ...cur, [id]: { ...(cur[id] ?? { choiceIndex: null, text: '' }), ...a } }));
  };

  const total = paper ? paper.exams.reduce((n, e) => n + e.questions.length, 0) : 0;
  const answered = paper
    ? paper.exams.flatMap((e) => e.questions).filter((q) => {
        const a = answers[q.id];
        return q.kind === 'CHOICE' ? a?.choiceIndex != null : !!a?.text.trim();
      }).length
    : 0;

  return (
    <div className="landing exam-public">
      <div className="login-wrap login-wrap-wide">
        <LandingBrand />
        <div className="panel">
          {error && !paper && <div className="alert error">{error}</div>}
          {!view && !error && <p className="muted">Opening the exam…</p>}

          {view && !paper && !done && (
            <>
              <h2>Employment Examination</h2>
              <p className="login-text">
                <strong>{view.name}</strong> — applying for {view.position} at {view.company}.
              </p>
              {view.status === 'ISSUED' ? (
                <>
                  <ul className="exam-list">
                    {view.exams.map((e) => (
                      <li key={e.name}>
                        {e.name} <span className="faint">· {e.questions} question{e.questions === 1 ? '' : 's'}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="alert info">
                    You have <strong>{view.minutes} minutes</strong> for all of it, from the moment you press Start. Your answers save as you go; when the time is up they are submitted
                    as they are. You can take it only once — start when you are ready, in a quiet place, with a steady connection.
                  </div>
                  <button type="button" className="btn btn-primary btn-block" onClick={() => void start()} disabled={busy}>
                    {busy ? 'Starting…' : 'Start the exam'}
                  </button>
                </>
              ) : (
                <div className="alert warn">
                  {view.status === 'SUBMITTED' || view.status === 'SCORED'
                    ? 'This exam has been submitted. Thank you — HR will be in touch.'
                    : view.status === 'EXPIRED'
                      ? 'This link has expired. Ask HR for a new one.'
                      : view.status === 'CANCELLED'
                        ? 'This link was cancelled. Ask HR if you need a new one.'
                        : 'This exam is closed.'}
                </div>
              )}
            </>
          )}

          {done && (
            <>
              <h2>Employment Examination</h2>
              <div className="alert ok">{done}</div>
            </>
          )}

          {paper && !done && (
            <>
              <div className="exam-bar" role="status" aria-live="polite">
                <span className={left != null && left < 60_000 ? 'exam-time is-low' : 'exam-time'}>{left != null ? clock(left) : '—'} left</span>
                <span className="faint">
                  {answered} of {total} answered{saved === 'saving' ? ' · saving…' : saved === 'saved' ? ' · saved' : saved === 'failed' ? ' · not saved — check the connection' : ''}
                </span>
              </div>
              {error && <div className="alert error">{error}</div>}
              {paper.exams.map((e) => (
                <section key={e.id} className="exam-section">
                  <h2>{e.name}</h2>
                  {e.description && <p className="faint">{e.description}</p>}
                  <ol className="exam-questions">
                    {e.questions.map((q) => (
                      <li key={q.id} className="exam-question">
                        <p className="exam-prompt">
                          {q.prompt} <span className="faint">({q.points} pt{q.points === 1 ? '' : 's'})</span>
                        </p>
                        {q.kind === 'CHOICE' ? (
                          <div role="radiogroup" aria-label={q.prompt} className="exam-choices">
                            {q.choices.map((c, i) => (
                              <label key={i} className="exam-choice">
                                <input type="radio" name={q.id} checked={answers[q.id]?.choiceIndex === i} onChange={() => set(q.id, { choiceIndex: i })} />
                                <span>{c}</span>
                              </label>
                            ))}
                          </div>
                        ) : (
                          <textarea rows={4} value={answers[q.id]?.text ?? ''} onChange={(ev) => set(q.id, { text: ev.target.value })} aria-label={`Your answer to: ${q.prompt}`} />
                        )}
                      </li>
                    ))}
                  </ol>
                </section>
              ))}
              <button type="button" className="btn btn-primary btn-block" disabled={busy} onClick={() => void submit(false)}>
                {busy ? 'Submitting…' : `Submit my answers (${answered} of ${total})`}
              </button>
              <p className="faint">Once submitted, the exam cannot be opened again.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
