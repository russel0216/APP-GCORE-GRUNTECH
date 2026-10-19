import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { ErrorBox, Field, Loading, formatMoney, useToast } from '../../components/ui';
import {
  RequestLinesCard,
  blankRequestLine,
  isBlankLine,
  linesFromItems,
  linesPayload,
  linesProblems,
  linesSnapshot,
  linesTotal,
  type RequestLine,
} from '../../components/RequestLines';
import { ApprovalStepper, allHeld, previewSteps } from '../../components/ApprovalStepper';
import { Meter } from '../../components/charts';
import { useBackLink, useUnsavedChanges } from '../../components/Navigation';
import type { BudgetLine, Route } from '../chain/PurchaseRequisitionEditor';
import type { BudgetRequest } from './BudgetRequests';

/**
 * The budget request as a PAGE (2026-10-19, the owner's call: "budget request
 * should be complete form, not a popup window"), in the purchase
 * requisition page's dress. One page for New and Modify:
 * `/g-ops/budget-requests/new?jobId=` from a project's Budget Requests tab,
 * `/g-ops/budget-requests/new` from the registers (the project picked here),
 * and `/g-ops/budget-requests/:id/edit` on a draft.
 *
 * The cash is broken down into lines — what it buys, quantity, unit cost —
 * and the request is their sum. ONE budget line covers the whole request (the
 * owner's choice), because the liquidation charges exactly that line. Beside
 * the lines, the project's budget as it stands: a budget request commits
 * nothing (only its liquidation reaches the project), so the panel says what
 * is left, not what this would use up. Under them, the route submitting would
 * take, from the approval engine.
 */

interface Budget {
  job: { id: string; number: string; name: string };
  lines: BudgetLine[];
  total: { budgeted: number; committed: number; incurred: number; available: number };
}

interface Header {
  jobId: string;
  costCategoryId: string;
  reason: string;
  neededBy: string;
  notes: string;
}

const snapshot = (h: Header, lines: RequestLine[]) => JSON.stringify([h, linesSnapshot(lines)]);

export function BudgetRequestEditor() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const editing = Boolean(id);
  const presetJobId = params.get('jobId');

  const [existing, setExisting] = useState<BudgetRequest | null>(null);
  const [projects, setProjects] = useState<{ id: string; number: string; name: string }[]>([]);
  const [budget, setBudget] = useState<Budget | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [header, setHeader] = useState<Header>({ jobId: presetJobId ?? '', costCategoryId: '', reason: '', neededBy: '', notes: '' });
  const [lines, setLines] = useState<RequestLine[]>(() => [blankRequestLine()]);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        let h = header;
        let ls = lines;
        if (id) {
          const row = await api.get<BudgetRequest>(`/budget-requests/${id}`);
          if (!live) return;
          setExisting(row);
          h = {
            jobId: row.job.id,
            costCategoryId: row.costCategory.id,
            reason: row.reason,
            neededBy: row.neededBy?.slice(0, 10) ?? '',
            notes: row.notes ?? '',
          };
          // A request raised before the breakdown: its amount as one line.
          ls = linesFromItems(row.items, row.reason, row.amount);
          setHeader(h);
          setLines(ls);
        } else if (!presetJobId) {
          const list = await api.get<typeof projects>('/budget-requests/projects').catch(() => []);
          if (live) setProjects(list);
        }
        setSaved(snapshot(h, ls));
      } catch (err) {
        if (live) setError(err);
      } finally {
        if (live) setLoaded(true);
      }
    })();
    return () => {
      live = false;
    };
    // Loaded once per page; the header and lines are the page's from then on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // The project's budget lines — the Budget line select and the live panel.
  useEffect(() => {
    setBudget(null);
    if (!header.jobId) return;
    let live = true;
    api
      .get<Budget>(`/budget-requests/budget${qs({ jobId: header.jobId })}`)
      .then((b) => live && setBudget(b))
      .catch((err) => live && setError(err));
    return () => {
      live = false;
    };
  }, [header.jobId]);

  const sent = lines.filter((l) => !isBlankLine(l));
  const total = useMemo(() => linesTotal(lines), [lines]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      api
        .get<{ route: Route | null }>(`/budget-requests/route${qs({ amount: String(total), jobId: header.jobId, requestId: id ?? '' })}`)
        .then((r) => setRoute(r.route))
        .catch(() => setRoute(null));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [total, header.jobId, id]);

  const dirty = saved !== null && snapshot(header, lines) !== saved;
  useUnsavedChanges(dirty && !busy);

  const project = budget?.job ?? existing?.job ?? projects.find((p) => p.id === header.jobId) ?? null;
  useBackLink(
    existing ? `/g-ops/budget-requests/${existing.id}` : presetJobId ? `/g-ops/projects/${presetJobId}?tab=requests` : null,
    existing ? existing.number : project ? `${project.number} Budget Requests` : null,
  );

  const problems: string[] = [];
  if (!header.jobId) problems.push('Choose the project');
  if (!header.costCategoryId) problems.push('Choose the budget line');
  if (header.reason.trim().length < 3) problems.push('Say what the cash is for');
  problems.push(...linesProblems(lines));

  async function save(submit: boolean) {
    setAttempted(true);
    if (problems.length) return;
    setBusy(true);
    setError(null);
    const body = {
      jobId: header.jobId,
      costCategoryId: header.costCategoryId,
      reason: header.reason.trim(),
      neededBy: header.neededBy || null,
      notes: header.notes.trim() || null,
      items: linesPayload(lines),
    };
    try {
      const savedId = existing
        ? (await api.put<{ id: string }>(`/budget-requests/${existing.id}`, body)).id
        : (await api.post<{ id: string }>('/budget-requests', body)).id;
      setSaved(snapshot(header, lines));
      if (submit) {
        try {
          await api.post(`/budget-requests/${savedId}/submit`);
          toast('ok', 'Saved and submitted for approval');
        } catch (err) {
          toast('error', `Saved as a draft — not submitted: ${err instanceof Error ? err.message : 'refused'}`);
        }
      } else toast('ok', existing ? `${existing.number} saved` : 'Budget request saved as a draft');
      navigate(`/g-ops/budget-requests/${savedId}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  if (!loaded) return error ? <ErrorBox error={error} /> : <Loading />;
  if (editing && !existing) return <ErrorBox error={error ?? new Error('Budget request not found')} />;
  if (existing && !existing.canEdit) {
    return (
      <div className="card">
        <p className="muted">
          {existing.status !== 'DRAFT'
            ? `${existing.number} is ${existing.status.toLowerCase().replace(/_/g, ' ')} and holds still. A pending request is withdrawn, or an approved one pulled back, from its page.`
            : 'Only the person who raised this request, or someone who may edit every request, can change it.'}
        </p>
      </div>
    );
  }

  const chosen = budget?.lines.find((b) => b.id === header.costCategoryId) ?? null;
  const shownLines = (budget?.lines ?? []).filter((b) => b.budgeted > 0 || b.id === header.costCategoryId);
  const actions = (
    <>
      <button type="button" className="btn" onClick={() => void save(false)} disabled={busy}>
        {busy ? 'Saving…' : 'Save'}
      </button>
      {can('gops.budget_requests.create') && (
        <button type="button" className="btn btn-primary" onClick={() => void save(true)} disabled={busy}>
          Submit for approval
        </button>
      )}
    </>
  );

  return (
    <div className="prq">
      <section className="card qe-card prq-head-card" aria-labelledby="br-heading">
        <div className="qe-head">
          <div>
            <h1 id="br-heading" className="qe-heading">
              {existing ? `Modify budget request ${existing.number}` : 'New budget request'}
            </h1>
            <p className="muted qe-lead">
              {project ? (
                <>
                  For <Link to={`/g-ops/projects/${project.id}`}>{project.number} — {project.name}</Link>.{' '}
                </>
              ) : null}
              Cash for the project team to buy what it needs without a purchase requisition — released by finance in one
              voucher once approved, and accounted for afterwards with receipts.
            </p>
          </div>
          <div className="row qe-actions">{actions}</div>
        </div>
        <ErrorBox error={error} />
        {attempted && problems.length > 0 && (
          <div className="alert error" role="alert">
            Not saved yet — {problems.join('; ')}.
          </div>
        )}
      </section>

      <div className="prq-grid">
        <div className="prq-main">
          <section className="card" aria-labelledby="br-details">
            <h2 id="br-details" className="card-title">Budget request details</h2>
            <div className="qe-header qe-rows prq-rows">
              <Field label="Number">
                <div className="qe-static">{existing ? <span className="mono">{existing.number}</span> : <span className="muted">Given on save</span>}</div>
              </Field>
              {presetJobId || existing ? (
                <Field label="Project">
                  <div className="qe-static">{project ? `${project.number} — ${project.name}` : '…'}</div>
                </Field>
              ) : (
                <Field
                  label="Project"
                  required
                  hint="Every request names a project — office or operations cash goes against the operations budget's project"
                  error={attempted && !header.jobId ? 'Choose the project' : null}
                >
                  <select value={header.jobId} onChange={(e) => setHeader((h) => ({ ...h, jobId: e.target.value, costCategoryId: '' }))}>
                    <option value="">— choose —</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.number} — {p.name}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <Field
                label="Budget line"
                required
                hint="The liquidation charges exactly this line"
                error={attempted && !header.costCategoryId ? 'Choose the budget line' : null}
              >
                <select
                  value={header.costCategoryId}
                  disabled={!budget}
                  onChange={(e) => setHeader((h) => ({ ...h, costCategoryId: e.target.value }))}
                >
                  <option value="">{header.jobId ? '— choose —' : '— choose the project first —'}</option>
                  {(budget?.lines ?? []).map((c, n) => (
                    <option key={c.id} value={c.id}>
                      {n + 1} {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Needed by" hint="When the team needs the cash in hand">
                <input type="date" value={header.neededBy} onChange={(e) => setHeader((h) => ({ ...h, neededBy: e.target.value }))} />
              </Field>
              <Field label="What is the cash for?" required error={attempted && header.reason.trim().length < 3 ? 'Say what the cash is for' : null}>
                <input
                  value={header.reason}
                  maxLength={300}
                  autoFocus={!editing}
                  placeholder="e.g. consumables and fittings for the Batangas tie-in"
                  onChange={(e) => setHeader((h) => ({ ...h, reason: e.target.value }))}
                />
              </Field>
            </div>
            <div className="qe-rows">
              <Field label="Notes" hint="Printed on the request">
                <textarea rows={2} value={header.notes} onChange={(e) => setHeader((h) => ({ ...h, notes: e.target.value }))} />
              </Field>
            </div>
          </section>

          <RequestLinesCard
            id="br-lines"
            lines={lines}
            onChange={setLines}
            attempted={attempted}
            hint="The amount requested is the sum of the lines. Receipts for what is actually spent are filed in the liquidation."
          />

          <section className="card" aria-labelledby="br-summary">
            <h2 id="br-summary" className="card-title">Summary</h2>
            <dl className="prq-total">
              <dt>No. of lines</dt>
              <dd>{sent.length}</dd>
              <dt className="prq-total-big">Amount requested</dt>
              <dd className="prq-total-big mono">{formatMoney(total)}</dd>
            </dl>
          </section>

          <section className="card" aria-labelledby="br-approval">
            <h2 id="br-approval" className="card-title">Approval</h2>
            {route ? (
              allHeld(route) ? (
                <p className="muted">No one else's approval needed — you hold every step of the route.</p>
              ) : (
                <>
                  <p className="muted">Submit for approval sends it to:</p>
                  <ApprovalStepper steps={previewSteps(route)} />
                </>
              )
            ) : (
              <p className="muted">No approval route covers this request — Submit for approval will say what is missing.</p>
            )}
            <p className="prq-hint">
              Requested by {existing?.requestedBy.name ?? 'you'}. Once approved, finance releases the cash in one voucher.
            </p>
          </section>

          <div className="row qe-foot">{actions}</div>
        </div>

        <aside className="card prq-budget" aria-labelledby="br-budget">
          <div className="card-head">
            <h2 id="br-budget" className="card-title">Project budget</h2>
            <span className="muted prq-source">as it stands</span>
          </div>
          {!header.jobId ? (
            <p className="muted">Choose the project to see its budget.</p>
          ) : !budget ? (
            <Loading />
          ) : (
            <>
              <p className="prq-hint">A budget request commits nothing; only what its liquidation shows was spent reaches the project.</p>
              {shownLines.length === 0 && <p className="muted">This project has no budget lines yet.</p>}
              {shownLines.map((b) => {
                const isChosen = b.id === header.costCategoryId;
                const left = isChosen ? Math.round((b.available - total) * 100) / 100 : b.available;
                const used = b.budgeted > 0 ? ((b.budgeted - left) / b.budgeted) * 100 : 100;
                return (
                  <div key={b.id} className="prq-bud">
                    <div className="prq-bud-top">
                      <span>{isChosen ? <strong>{b.name}</strong> : b.name}</span>
                      <strong className={left < 0 ? 'prq-over' : undefined}>{formatMoney(left)}</strong>
                    </div>
                    <Meter pct={used} tone={left < 0 ? 'danger' : used > 85 ? 'warn' : undefined} />
                    <div className="prq-bud-sub">
                      <span>{isChosen ? `this request ${formatMoney(total)}` : 'not touched'}</span>
                      <span>{left < 0 ? 'over by ' + formatMoney(-left) : isChosen ? 'left once spent' : 'available'}</span>
                    </div>
                  </div>
                );
              })}
              {chosen && chosen.available - total < -0.004 && (
                <div className="alert warn">More than is left on {chosen.name} — the approvers will see it.</div>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
