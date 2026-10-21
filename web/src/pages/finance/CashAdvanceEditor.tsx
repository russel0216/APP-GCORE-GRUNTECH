import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { ErrorBox, Field, Loading, formatMoney, useToast } from '../../components/ui';
import { ApprovalStepper, allHeld, previewSteps } from '../../components/ApprovalStepper';
import { useBackLink, useUnsavedChanges } from '../../components/Navigation';
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
import { todayLocal } from '../../lib/day';
import type { Route } from '../chain/PurchaseRequisitionEditor';
import type { Advance } from './CashAdvances';

/**
 * The cash advance as a PAGE (2026-10-19, the owner's call: "do the same for
 * cash advance" — the budget request's full form, not a popup), in the
 * purchase requisition page's dress: `/g-fin/cash-advances/new` and
 * `/g-fin/cash-advances/:id/edit` on a draft.
 *
 * The cash is broken down into lines and the advance is their sum, as on the
 * budget request. A project is optional (an advance may belong to
 * overheads); naming one means naming a budget line. Under the lines, the
 * route submitting would take, from the approval engine.
 */

interface Header {
  requestDate: string;
  neededBy: string;
  purpose: string;
  jobId: string;
  costCategoryId: string;
  notes: string;
}

const snapshot = (h: Header, lines: RequestLine[]) => JSON.stringify([h, linesSnapshot(lines)]);

export function CashAdvanceEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { me, can } = useAuth();
  const editing = Boolean(id);

  const [existing, setExisting] = useState<Advance | null>(null);
  const [jobs, setJobs] = useState<{ id: string; number: string; name: string }[]>([]);
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [route, setRoute] = useState<Route | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  // Supporting papers for finance's check, filed with the save (2026-10-21).
  const [files, setFiles] = useState<File[]>([]);
  const [header, setHeader] = useState<Header>({ requestDate: todayLocal(), neededBy: '', purpose: '', jobId: '', costCategoryId: '', notes: '' });
  const [lines, setLines] = useState<RequestLine[]>(() => [blankRequestLine()]);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const chargeable = api
          .get<{ jobs: typeof jobs; categories: typeof categories }>('/expense-claims/chargeable')
          .catch(() => ({ jobs: [], categories: [] }));
        let h = header;
        let ls = lines;
        if (id) {
          const row = await api.get<Advance>(`/cash-advances/${id}`);
          if (!live) return;
          setExisting(row);
          h = {
            requestDate: row.requestDate.slice(0, 10),
            neededBy: row.neededBy?.slice(0, 10) ?? '',
            purpose: row.purpose,
            jobId: row.job?.id ?? '',
            costCategoryId: row.costCategory?.id ?? '',
            notes: row.notes ?? '',
          };
          // An advance asked for before the breakdown: its amount as one line.
          ls = linesFromItems(row.items, row.purpose, row.amount);
          setHeader(h);
          setLines(ls);
        }
        const c = await chargeable;
        if (!live) return;
        setJobs(c.jobs);
        setCategories(c.categories);
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

  const sent = lines.filter((l) => !isBlankLine(l));
  const total = useMemo(() => linesTotal(lines), [lines]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      api
        .get<{ route: Route | null }>(`/cash-advances/route${qs({ amount: String(total), advanceId: id ?? '' })}`)
        .then((r) => setRoute(r.route))
        .catch(() => setRoute(null));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [total, id]);

  const dirty = saved !== null && snapshot(header, lines) !== saved;
  useUnsavedChanges(dirty && !busy);
  useBackLink(existing ? `/g-fin/cash-advances/${existing.id}` : null, existing ? existing.number : null);

  const problems: string[] = [];
  if (header.purpose.trim().length < 3) problems.push('Say what the cash is for');
  if (header.jobId && !header.costCategoryId) problems.push('Choose the budget line');
  problems.push(...linesProblems(lines));

  async function save(submit: boolean) {
    setAttempted(true);
    if (problems.length) return;
    setBusy(true);
    setError(null);
    const body = {
      requestDate: header.requestDate,
      neededBy: header.neededBy || null,
      purpose: header.purpose.trim(),
      jobId: header.jobId || null,
      costCategoryId: header.jobId ? header.costCategoryId || null : null,
      notes: header.notes.trim() || null,
      items: linesPayload(lines),
    };
    try {
      const savedId = existing
        ? (await api.put<{ id: string }>(`/cash-advances/${existing.id}`, body)).id
        : (await api.post<{ id: string }>('/cash-advances', body)).id;
      setSaved(snapshot(header, lines));
      if (files.length) {
        const form = new FormData();
        for (const f of files) form.append('files', f);
        try {
          await api.post(`/attachments/cash_advance/${savedId}`, form);
          setFiles([]);
        } catch {
          toast('error', 'Saved, but the attachments could not be filed — add them on the cash advance');
        }
      }
      if (submit) {
        try {
          await api.post(`/cash-advances/${savedId}/submit`);
          toast('ok', 'Saved and submitted for approval');
        } catch (err) {
          toast('error', `Saved as a draft — not submitted: ${err instanceof Error ? err.message : 'refused'}`);
        }
      } else toast('ok', existing ? `${existing.number} saved` : 'Cash advance saved as a draft');
      navigate(`/g-fin/cash-advances/${savedId}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  if (!loaded) return error ? <ErrorBox error={error} /> : <Loading />;
  if (editing && !existing) return <ErrorBox error={error ?? new Error('Cash advance not found')} />;
  if (existing) {
    const own = existing.requestedBy.id === me?.user.id;
    const editAll = !!me?.user.isSuperAdmin || can('gfin.cash_advances.edit_all');
    const mayEdit = (own && can('gfin.cash_advances.edit_own')) || editAll;
    if (existing.status !== 'DRAFT' || !mayEdit) {
      return (
        <div className="card">
          <p className="muted">
            {existing.status !== 'DRAFT'
              ? `${existing.number} is ${existing.status.toLowerCase().replace(/_/g, ' ')} and holds still. A pending advance is cancelled, or an approved one pulled back, from its page.`
              : 'Only the person who asked for this advance, or someone who may edit every advance, can change it.'}
          </p>
        </div>
      );
    }
  }

  const mine = !existing || existing.requestedBy.id === me?.user.id || !!me?.user.isSuperAdmin;
  const actions = (
    <>
      <button type="button" className="btn" onClick={() => void save(false)} disabled={busy}>
        {busy ? 'Saving…' : 'Save'}
      </button>
      {mine && (
        <button type="button" className="btn btn-primary" onClick={() => void save(true)} disabled={busy}>
          Submit for approval
        </button>
      )}
    </>
  );
  const job = jobs.find((j) => j.id === header.jobId) ?? existing?.job ?? null;

  return (
    <div className="prq">
      <section className="card qe-card prq-head-card" aria-labelledby="ca-heading">
        <div className="qe-head">
          <div>
            <h1 id="ca-heading" className="qe-heading">
              {existing ? `Modify cash advance ${existing.number}` : 'New cash advance'}
            </h1>
            <p className="muted qe-lead">
              Money lent to {existing && existing.requestedBy.id !== me?.user.id ? existing.requestedBy.name : 'you'} — released by finance
              in one voucher once approved, then repaid in instalments or by salary deduction until the balance is nil.
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

      <div className="prq-grid prq-grid-solo">
        <div className="prq-main">
          <section className="card" aria-labelledby="ca-details">
            <h2 id="ca-details" className="card-title">Cash advance details</h2>
            <div className="qe-header qe-rows prq-rows">
              <Field label="Number">
                <div className="qe-static">{existing ? <span className="mono">{existing.number}</span> : <span className="muted">Given on save</span>}</div>
              </Field>
              <Field label="Date of request">
                <input type="date" value={header.requestDate} onChange={(e) => setHeader((h) => ({ ...h, requestDate: e.target.value }))} />
              </Field>
              <Field label="What is the cash for?" required error={attempted && header.purpose.trim().length < 3 ? 'Say what the cash is for' : null}>
                <input
                  value={header.purpose}
                  maxLength={300}
                  autoFocus={!editing}
                  placeholder="e.g. fuel and tolls for the Batangas commissioning"
                  onChange={(e) => setHeader((h) => ({ ...h, purpose: e.target.value }))}
                />
              </Field>
              <Field label="Needed by" hint="When you need the cash in hand">
                <input type="date" value={header.neededBy} onChange={(e) => setHeader((h) => ({ ...h, neededBy: e.target.value }))} />
              </Field>
              <Field label="Charge to project" hint="Leave empty if it belongs to overheads">
                <select value={header.jobId} onChange={(e) => setHeader((h) => ({ ...h, jobId: e.target.value, costCategoryId: e.target.value ? h.costCategoryId : '' }))}>
                  <option value="">— none (overheads) —</option>
                  {job && !jobs.some((j) => j.id === job.id) && (
                    <option value={job.id}>
                      {job.number} — {job.name}
                    </option>
                  )}
                  {jobs.map((j) => (
                    <option key={j.id} value={j.id}>
                      {j.number} — {j.name}
                    </option>
                  ))}
                </select>
              </Field>
              {header.jobId && (
                <Field label="Budget line" required hint="Charged exactly this line" error={attempted && !header.costCategoryId ? 'Choose the budget line' : null}>
                  <select value={header.costCategoryId} onChange={(e) => setHeader((h) => ({ ...h, costCategoryId: e.target.value }))}>
                    <option value="">— choose —</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </div>
            <div className="qe-rows">
              <Field label="Notes" hint="Printed on the advance">
                <textarea rows={2} value={header.notes} onChange={(e) => setHeader((h) => ({ ...h, notes: e.target.value }))} />
              </Field>
            </div>
            {job && (
              <p className="prq-hint">
                For <Link to={`/g-ops/projects/${job.id}`}>{job.number} — {job.name}</Link>.
              </p>
            )}
          </section>

          <RequestLinesCard
            id="ca-lines"
            lines={lines}
            onChange={setLines}
            attempted={attempted}
            hint="The advance is the sum of the lines — what the cash is meant to buy."
          />

          <section className="card" aria-labelledby="ca-summary">
            <h2 id="ca-summary" className="card-title">Summary</h2>
            <dl className="prq-total">
              <dt>No. of lines</dt>
              <dd>{sent.length}</dd>
              <dt className="prq-total-big">Amount requested</dt>
              <dd className="prq-total-big mono">{formatMoney(total)}</dd>
            </dl>
          </section>

          <section className="card" aria-labelledby="ca-files">
            <h2 id="ca-files" className="card-title">Attachments</h2>
            <p className="prq-hint">
              Quotations, a breakdown or anything that supports the request — they go with the advance, so finance sees them when checking it.
              {existing ? ' Files already on it stay; add more here or on its page.' : ''}
            </p>
            <input
              type="file"
              multiple
              accept="image/*,application/pdf,.xlsx,.xls,.csv,.docx,.doc"
              aria-label="Attach supporting papers"
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? []);
                setFiles((cur) => [...cur, ...picked]);
                e.target.value = '';
              }}
            />
            {files.length > 0 && (
              <ul className="fin-files">
                {files.map((f, i) => (
                  <li key={`${f.name}-${i}`}>
                    <span>{f.name}</span>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card" aria-labelledby="ca-approval">
            <h2 id="ca-approval" className="card-title">Approval</h2>
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
              <p className="muted">No approval route covers this advance — Submit for approval will say what is missing.</p>
            )}
            <p className="prq-hint">
              Requested by {existing?.requestedBy.name ?? 'you'}. Once approved, finance releases the cash in one voucher; it is then repaid in
              instalments or by salary deduction.
            </p>
          </section>

          <div className="row qe-foot">{actions}</div>
        </div>
      </div>
    </div>
  );
}
