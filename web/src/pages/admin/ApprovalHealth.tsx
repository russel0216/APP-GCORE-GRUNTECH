import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { ErrorBox, Loading } from '../../components/ui';
import { Stat } from '../../components/charts';
import { PersonSelect, usePeople } from '../../components/People';
import { useConfirm } from '../../components/Confirm';
import { useAuth } from '../../lib/auth';

/*
 * Admin › Approval Health (2026-11-26, the owner's call: "a better
 * visualization of work flow and access so I can easily pin point the
 * problem"). Read-only: every figure comes from GET /approval-health, which
 * asks the approval engine itself who may decide each step.
 */

type Problem = 'nobody' | 'inactive' | 'no_route' | 'step_missing' | 'engine_error' | 'slow' | null;
interface WaitingRow {
  requestId: string; documentType: string; typeLabel: string; number: string; subject: string; link: string | null;
  requester: { id: string; name: string };
  steps: { sequence: number; name: string; state: 'done' | 'current' | 'next' }[];
  stepName: string; waitingOn: { id: string; name: string }[]; days: number;
  workflowName: string | null; retiredRoute: boolean; problem: Problem; problemText: string | null; fix: string | null; canResume: boolean;
}
interface RouteStep { sequence: number; name: string; rule: string; holders: { id: string; name: string; team: string | null }[]; waiting: number; problem: string | null }
interface RouteCard {
  id: string; documentType: string; typeLabel: string; name: string; band: string | null; optionLabel: string | null;
  preparerRole: string | null; preparerSigns: boolean; standIns: boolean; moneyRule: boolean; steps: RouteStep[]; waiting: number;
}
interface PeopleIssue { key: string; title: string; why: string; people: { id: string; name: string; email: string; roles: string[] }[] }
interface RoleRow { key: string; name: string; holders: number; rights: number; steps: number; problem: string | null }
interface Overview {
  summary: { waiting: number; blocked: number; slow: number; brokenSteps: number; peopleIssues: number; roleIssues: number };
  waiting: WaitingRow[]; routes: RouteCard[]; setup: { people: PeopleIssue[]; roles: RoleRow[] };
}
interface PersonOut {
  person: { id: string; name: string; email: string; team: string | null; isSuperAdmin: boolean; roles: string[]; reportsTo: { id: string; name: string; isActive: boolean } | null };
  checks: { ok: boolean; text: string }[];
  routes: { documentType: string; typeLabel: string; name: string; band: string | null; steps: { name: string; rule: string; people: string[]; note: string | null }[] }[];
  access: { module: string; screens: { key: string; label: string; view: string; manage: string; viewLabel: string; manageLabel: string }[] }[];
  waitingOnThem: WaitingRow[];
  theirsWaiting: WaitingRow[];
}

type View = 'waiting' | 'routes' | 'people' | 'person';
const VIEWS: { key: View; label: string }[] = [
  { key: 'waiting', label: 'Waiting documents' },
  { key: 'routes', label: 'Routes' },
  { key: 'people', label: 'People & roles' },
  { key: 'person', label: 'Check one person' },
];

const PROBLEM_WORDS: Record<Exclude<Problem, null>, string> = {
  nobody: 'Cannot move',
  inactive: 'Cannot move',
  no_route: 'Route deleted',
  step_missing: 'Step missing',
  engine_error: 'Error',
  slow: 'Slow',
};

export function ApprovalHealth() {
  const [params, setParams] = useSearchParams();
  const view = (VIEWS.some((v) => v.key === params.get('view')) ? params.get('view') : 'waiting') as View;
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.get<Overview>('/approval-health'));
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const go = (v: View, extra: Record<string, string> = {}) => {
    const next = new URLSearchParams(params);
    next.set('view', v);
    for (const [k, val] of Object.entries(extra)) next.set(k, val);
    setParams(next, { replace: true });
  };

  return (
    <div className="stack ah">
      <div className="page-head">
        <h1>Approval Health</h1>
        <button type="button" className="btn" onClick={() => void load()} disabled={loading}>
          Refresh
        </button>
      </div>
      <ErrorBox error={error} />
      {loading && !data && <Loading />}
      {data && (
        <>
          <div className="kpi-grid">
            <Stat label="Waiting for approval" value={data.summary.waiting} to="?view=waiting" more="See them" />
            <Stat label="Cannot move" value={data.summary.blocked} accent={data.summary.blocked ? 'danger' : 'ok'} hint="nobody can decide the step" to="?view=waiting&show=blocked" more="See them" />
            <Stat label={`Waiting 7+ days`} value={data.summary.slow} accent={data.summary.slow ? 'warn' : 'ok'} to="?view=waiting&show=slow" more="See them" />
            <Stat label="Route steps with nobody" value={data.summary.brokenSteps} accent={data.summary.brokenSteps ? 'danger' : 'ok'} to="?view=routes&show=broken" more="See routes" />
            <Stat label="People set-up gaps" value={data.summary.peopleIssues} accent={data.summary.peopleIssues ? 'warn' : 'ok'} hint={`${data.summary.roleIssues} role${data.summary.roleIssues === 1 ? '' : 's'} flagged`} to="?view=people" more="See them" />
          </div>

          <div className="row">
            <div className="scope-switch" role="group" aria-label="What to show">
              {VIEWS.map((v) => (
                <button key={v.key} type="button" className={v.key === view ? 'active' : ''} aria-pressed={v.key === view} onClick={() => go(v.key)}>
                  {v.label}
                </button>
              ))}
            </div>
          </div>

          {view === 'waiting' && <WaitingView rows={data.waiting} onPerson={(id) => go('person', { person: id })} onChanged={() => void load()} />}
          {view === 'routes' && <RoutesView routes={data.routes} onPerson={(id) => go('person', { person: id })} />}
          {view === 'people' && <PeopleView setup={data.setup} onPerson={(id) => go('person', { person: id })} />}
          {view === 'person' && <PersonView />}
        </>
      )}
    </div>
  );
}

// ── Waiting documents ──────────────────────────────────────────────────────

function StepTrack({ steps }: { steps: WaitingRow['steps'] }) {
  if (!steps.length) return <span className="faint">—</span>;
  return (
    <ol className="ah-track" aria-label="Approval steps">
      {steps.map((s) => (
        <li key={s.sequence} className={`ah-dot is-${s.state}`} title={`${s.sequence}. ${s.name}`}>
          <span className="ah-dot-mark" aria-hidden="true">{s.state === 'done' ? '✓' : s.sequence}</span>
          <span className="ah-dot-name">{s.name}</span>
        </li>
      ))}
    </ol>
  );
}

function ProblemBadge({ problem }: { problem: Problem }) {
  if (!problem) return <span className="badge ok">Moving</span>;
  return <span className={`badge ${problem === 'slow' ? 'warn' : 'danger'}`}>{PROBLEM_WORDS[problem]}</span>;
}

function WaitingView({ rows, onPerson, onChanged }: { rows: WaitingRow[]; onPerson: (id: string) => void; onChanged: () => void }) {
  const { me } = useAuth();
  const isSuper = me?.user.isSuperAdmin ?? false;
  const confirm = useConfirm();
  const resume = (r: WaitingRow) =>
    confirm.ask({
      title: `Resume ${r.number}?`,
      body: `Its route no longer has the step it was waiting at. It moves to the first step not yet signed and those approvers are told — or, if every step is signed, it is approved and goes on as if the last approver had signed. Recorded on its history.`,
      confirmLabel: 'Resume',
      tone: 'primary',
      onConfirm: async () => {
        await api.post(`/approval-health/resume/${encodeURIComponent(r.requestId)}`, {});
        onChanged();
      },
    });
  const [params, setParams] = useSearchParams();
  const show = params.get('show') ?? 'all';
  const type = params.get('type') ?? '';
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const types = useMemo(() => [...new Map(rows.map((r) => [r.documentType, r.typeLabel])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [rows]);
  const shown = rows
    .filter((r) => (show === 'blocked' ? r.problem && r.problem !== 'slow' : show === 'slow' ? r.problem === 'slow' : true))
    .filter((r) => !type || r.documentType === type)
    .sort((a, b) => rank(a) - rank(b) || b.days - a.days);

  return (
    <div className="stack">
    {confirm.bar}
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Waiting documents</h2>
        <div className="row">
          <div className="scope-switch" role="group" aria-label="Which">
            {[['all', 'All'], ['blocked', 'Cannot move'], ['slow', '7+ days']].map(([k, l]) => (
              <button key={k} type="button" className={show === k ? 'active' : ''} aria-pressed={show === k} onClick={() => set('show', k === 'all' ? '' : k)}>
                {l}
              </button>
            ))}
          </div>
          <select aria-label="Document type" value={type} onChange={(e) => set('type', e.target.value)}>
            <option value="">Every document type</option>
            {types.map(([t, l]) => (
              <option key={t} value={t}>{l}</option>
            ))}
          </select>
        </div>
      </div>
      {!shown.length ? (
        <p className="faint">Nothing here — every document in this view is moving.</p>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>State</th>
                <th>Document</th>
                <th>Where it is</th>
                <th>Waiting on</th>
                <th className="right">Days</th>
                <th>What to do</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.requestId} className={r.problem && r.problem !== 'slow' ? 'ah-row-bad' : undefined}>
                  <td><ProblemBadge problem={r.problem} /></td>
                  <td>
                    {r.link ? <Link to={r.link}><strong>{r.number}</strong></Link> : <strong>{r.number}</strong>}
                    <div className="faint">{r.typeLabel} · by{' '}
                      <button type="button" className="ah-link" onClick={() => onPerson(r.requester.id)}>{r.requester.name}</button>
                    </div>
                    <div className="ah-subject">{r.subject}</div>
                  </td>
                  <td>
                    <StepTrack steps={r.steps} />
                    {r.retiredRoute && <div className="faint">on a retired route</div>}
                  </td>
                  <td>
                    {r.waitingOn.length ? (
                      r.waitingOn.map((p, i) => (
                        <Fragment key={p.id}>
                          {i > 0 && ', '}
                          <button type="button" className="ah-link" onClick={() => onPerson(p.id)}>{p.name}</button>
                        </Fragment>
                      ))
                    ) : (
                      <strong className="ah-bad-text">Nobody</strong>
                    )}
                  </td>
                  <td className="right">{r.days}</td>
                  <td>
                    {r.problemText && <div>{r.problemText}</div>}
                    {r.fix && <div className="ah-fix">{r.fix}</div>}
                    {r.canResume && isSuper && (
                      <button type="button" className="btn btn-sm btn-primary" onClick={() => resume(r)}>
                        Resume
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
    </div>
  );
}
const rank = (r: WaitingRow) => (r.problem && r.problem !== 'slow' ? 0 : r.problem === 'slow' ? 1 : 2);

// ── Routes ─────────────────────────────────────────────────────────────────

function Names({ people, onPerson, max = 4 }: { people: { id: string; name: string; team?: string | null }[]; onPerson: (id: string) => void; max?: number }) {
  const [open, setOpen] = useState(false);
  const list = open ? people : people.slice(0, max);
  return (
    <div className="ah-names">
      {list.map((p) => (
        <button key={p.id} type="button" className="ah-name" onClick={() => onPerson(p.id)}>
          {p.name}{p.team ? <span className="faint"> · {p.team}</span> : null}
        </button>
      ))}
      {people.length > max && (
        <button type="button" className="ah-link" onClick={() => setOpen((o) => !o)}>
          {open ? 'fewer' : `+${people.length - max} more`}
        </button>
      )}
    </div>
  );
}

function RoutesView({ routes, onPerson }: { routes: RouteCard[]; onPerson: (id: string) => void }) {
  const [params, setParams] = useSearchParams();
  const type = params.get('type') ?? '';
  const brokenOnly = params.get('show') === 'broken';
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const types = useMemo(() => [...new Map(routes.map((r) => [r.documentType, r.typeLabel])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [routes]);
  const shown = routes.filter((r) => (!type || r.documentType === type) && (!brokenOnly || r.steps.some((s) => s.problem)));

  return (
    <div className="stack">
      <div className="row">
        <select aria-label="Document type" value={type} onChange={(e) => set('type', e.target.value)}>
          <option value="">Every document type</option>
          {types.map(([t, l]) => (
            <option key={t} value={t}>{l}</option>
          ))}
        </select>
        <label className="row">
          <input type="checkbox" checked={brokenOnly} onChange={(e) => set('show', e.target.checked ? 'broken' : '')} /> Only routes with a step nobody holds
        </label>
      </div>
      <p className="faint">
        Each box is one approval step, in order. The names are who holds that step today. Red means the step reaches nobody.
        Steps that depend on the preparer (their “Reports to”, their team) are checked per person under “Check one person”.
      </p>
      {!shown.length && <p className="faint">No route matches.</p>}
      {shown.map((r) => (
        <section key={r.id} className="card">
          <div className="card-head">
            <div>
              <h2 className="card-title">{r.typeLabel}</h2>
              <div className="faint">
                {r.name}
                {r.band && ` · ${r.band}`}
                {r.optionLabel && ` · optional: “${r.optionLabel}”`}
                {r.preparerRole && ` · only when prepared by ${r.preparerRole}`}
              </div>
            </div>
            <div className="ah-flags">
              {r.waiting > 0 && <span className="badge info">{r.waiting} waiting</span>}
              {r.preparerSigns && !r.moneyRule && <span className="badge">Preparer signs own steps</span>}
              {r.moneyRule && <span className="badge">Own steps go up to their boss</span>}
              {r.standIns && <span className="badge">Boss may stand in</span>}
            </div>
          </div>
          <ol className="ah-flow">
            <li className="ah-box ah-start">
              <div className="ah-box-head">Prepared</div>
              <div className="faint">{r.preparerRole ?? 'Whoever raises it'}</div>
            </li>
            {r.steps.map((s) => (
              <li key={s.sequence} className={`ah-box${s.problem ? ' is-bad' : ''}`}>
                <div className="ah-box-head">
                  <span className="ah-num">{s.sequence}</span> {s.name}
                  {s.waiting > 0 && <span className="badge info ah-wait">{s.waiting}</span>}
                </div>
                <div className="ah-rule">{s.rule}</div>
                {s.holders.length ? <Names people={s.holders} onPerson={onPerson} /> : !s.problem ? <div className="faint">Depends on the preparer</div> : null}
                {s.problem && <div className="ah-bad-text">{s.problem}</div>}
              </li>
            ))}
            <li className="ah-box ah-end">
              <div className="ah-box-head">Approved</div>
            </li>
          </ol>
        </section>
      ))}
    </div>
  );
}

// ── People & roles ─────────────────────────────────────────────────────────

function PeopleView({ setup, onPerson }: { setup: Overview['setup']; onPerson: (id: string) => void }) {
  return (
    <div className="stack">
      <div className="grid grid-2">
        {setup.people.map((g) => (
          <section key={g.key} className="card">
            <div className="card-head">
              <h2 className="card-title">{g.title}</h2>
              <span className={`badge ${g.people.length ? 'warn' : 'ok'}`}>{g.people.length}</span>
            </div>
            <p className="faint">{g.why}</p>
            {g.people.length ? (
              <ul className="ah-list">
                {g.people.map((p) => (
                  <li key={p.id}>
                    <button type="button" className="ah-link" onClick={() => onPerson(p.id)}>{p.name}</button>
                    <span className="faint"> · {p.roles.join(', ') || 'no role'}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p>Nobody — fine.</p>
            )}
          </section>
        ))}
      </div>
      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Roles</h2>
          <Link to="/admin/roles" className="btn btn-sm">Open Roles &amp; Permissions</Link>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Role</th>
                <th className="right">People</th>
                <th className="right">Rights</th>
                <th className="right">Route steps</th>
                <th>Problem</th>
              </tr>
            </thead>
            <tbody>
              {setup.roles.map((r) => (
                <tr key={r.key} className={r.problem ? 'ah-row-bad' : undefined}>
                  <td>{r.name}</td>
                  <td className="right">{r.holders}</td>
                  <td className="right">{r.rights}</td>
                  <td className="right">{r.steps}</td>
                  <td>{r.problem ? <span className="ah-bad-text">{r.problem}</span> : <span className="faint">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

// ── One person ─────────────────────────────────────────────────────────────

function PersonView() {
  const [params, setParams] = useSearchParams();
  const personId = params.get('person') ?? '';
  const { people } = usePeople();
  const [data, setData] = useState<PersonOut | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [openOnly, setOpenOnly] = useState(true);

  useEffect(() => {
    if (!personId) {
      setData(null);
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    api
      .get<PersonOut>(`/approval-health/person/${encodeURIComponent(personId)}`)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [personId]);

  const pick = (id: string) => {
    const next = new URLSearchParams(params);
    if (id) next.set('person', id);
    else next.delete('person');
    setParams(next, { replace: true });
  };

  return (
    <div className="stack">
      <section className="card">
        <div className="field">
          <label htmlFor="ah-person">Person to check</label>
          <PersonSelect id="ah-person" value={personId} onChange={pick} people={people} placeholder="— pick someone —" />
        </div>
      </section>
      <ErrorBox error={error} />
      {loading && <Loading />}
      {data && !loading && (
        <>
          <section className="card">
            <div className="card-head">
              <div>
                <h2 className="card-title">{data.person.name}</h2>
                <div className="faint">{data.person.email}{data.person.isSuperAdmin ? ' · System Administrator (opens everything)' : ''}</div>
              </div>
              <Link to="/admin/users" className="btn btn-sm">Open Admin › Users</Link>
            </div>
            <ul className="ah-checks">
              {data.checks.map((c) => (
                <li key={c.text} className={c.ok ? 'is-ok' : 'is-bad'}>
                  <span aria-hidden="true">{c.ok ? '✓' : '✕'}</span> {c.text}
                </li>
              ))}
            </ul>
            <dl className="kv">
              <dt>Roles</dt>
              <dd>{data.person.roles.join(', ') || 'None'}</dd>
            </dl>
          </section>

          {(data.waitingOnThem.length > 0 || data.theirsWaiting.length > 0) && (
            <div className="grid grid-2">
              <MiniWaiting title={`Waiting on ${data.person.name}`} rows={data.waitingOnThem} />
              <MiniWaiting title={`${data.person.name}’s documents waiting`} rows={data.theirsWaiting} />
            </div>
          )}

          <section className="card">
            <div className="card-head">
              <h2 className="card-title">Where their documents go</h2>
            </div>
            <p className="faint">If {data.person.name} raises each document today, these are the people at each step (the standard route, smallest amount).</p>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Document</th>
                    <th>Steps, in order</th>
                  </tr>
                </thead>
                <tbody>
                  {data.routes.map((r) => (
                    <tr key={`${r.documentType}-${r.name}`}>
                      <td>
                        <strong>{r.typeLabel}</strong>
                        {r.band && <div className="faint">{r.band}</div>}
                      </td>
                      <td>
                        <ol className="ah-chain">
                          {r.steps.map((s, i) => {
                            const bad = !s.people.length && !!s.note && s.note.startsWith('NOBODY');
                            return (
                              <li key={i} className={bad ? 'is-bad' : s.people.length ? '' : 'is-quiet'}>
                                <div className="ah-chain-step">{s.name}</div>
                                <div>{s.people.length ? s.people.join(', ') : <span className={bad ? 'ah-bad-text' : 'faint'}>{s.note ?? '—'}</span>}</div>
                              </li>
                            );
                          })}
                        </ol>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2 className="card-title">What they can open</h2>
              <label className="row">
                <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} /> Only screens they can open
              </label>
            </div>
            <div className="grid grid-3">
              {data.access.map((m) => {
                const screens = m.screens.filter((s) => !openOnly || s.view !== 'none' || s.manage !== 'none');
                return (
                  <div key={m.module} className="ah-module">
                    <h3 className="section-label">{m.module}</h3>
                    {!screens.length ? (
                      <p className="faint">Nothing</p>
                    ) : (
                      <table className="data ah-access">
                        <thead>
                          <tr>
                            <th>Screen</th>
                            <th>View</th>
                            <th>Manage</th>
                          </tr>
                        </thead>
                        <tbody>
                          {screens.map((s) => (
                            <tr key={s.key}>
                              <td>{s.label}</td>
                              <td className={s.view === 'none' ? 'faint' : undefined}>{s.viewLabel}</td>
                              <td className={s.manage === 'none' ? 'faint' : undefined}>{s.manageLabel}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function MiniWaiting({ title, rows }: { title: string; rows: WaitingRow[] }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">{title}</h2>
        <span className="badge info">{rows.length}</span>
      </div>
      {!rows.length ? (
        <p className="faint">Nothing.</p>
      ) : (
        <ul className="ah-list">
          {rows.map((r) => (
            <li key={r.requestId}>
              {r.link ? <Link to={r.link}>{r.number}</Link> : r.number} <span className="faint">· {r.typeLabel} · {r.stepName} · {r.days}d</span>{' '}
              {r.problem && <ProblemBadge problem={r.problem} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
