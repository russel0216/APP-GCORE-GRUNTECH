import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { ErrorBox, Field, Loading, formatMoney, useToast } from '../../components/ui';
import { NumberInput } from '../../components/NumberInput';
import { ApprovalStepper, allHeld, previewSteps } from '../../components/ApprovalStepper';
import { useBackLink, useUnsavedChanges } from '../../components/Navigation';
import { todayLocal } from '../../lib/day';
import type { Route } from '../chain/PurchaseRequisitionEditor';
import type { Claim } from './Expenses';

/**
 * The reimbursement as a PAGE (2026-10-19, the owner's call: "do the same for
 * reimbursement" — the budget request's full form, not a popup), in the
 * purchase requisition page's dress. One page for every way a claim is filed:
 *
 * - `/g-fin/expenses/new` — a reimbursement of money spent out of pocket;
 * - `/g-fin/expenses/new?advance=<id>` — liquidating a cash advance (one
 *   raised before advances became loans);
 * - `/g-fin/expenses/new?budgetRequest=<id>` — liquidating a budget request;
 * - `/g-fin/expenses/:id/edit` — modifying a draft.
 *
 * A liquidation takes its project and budget line from what it accounts for
 * and cannot change them: the cost lands where it was approved to land. Every
 * line needs a receipt number before the claim can be submitted, and the
 * receipts picked here are filed with the save, so the checker sees them from
 * the first step.
 */

/** What a liquidation accounts for — an advance or a budget request. */
interface Source {
  kind: 'advance' | 'budgetRequest';
  id: string;
  number: string;
  amountReleased: number;
  purpose: string;
  job: { id: string; number: string; name: string } | null;
  costCategory: { id: string; name: string } | null;
  to: string;
}

interface Line {
  key: string;
  spentOn: string;
  vendor: string;
  receiptNo: string;
  description: string;
  category: string;
  amount: string;
}

interface Header {
  claimDate: string;
  purpose: string;
  jobId: string;
  costCategoryId: string;
}

let nextKey = 0;
const newKey = () => `cl${++nextKey}`;
const blankLine = (spentOn: string): Line => ({ key: newKey(), spentOn, vendor: '', receiptNo: '', description: '', category: '', amount: '' });
const isBlank = (l: Line) => !l.description.trim() && !l.vendor.trim() && !l.receiptNo.trim() && !(Number(l.amount) > 0);
const cents = (l: Line) => Math.round((Number(l.amount) || 0) * 100);
const snapshot = (h: Header, lines: Line[]) =>
  JSON.stringify([h, lines.filter((l) => !isBlank(l)).map(({ key: _key, ...rest }) => rest)]);

export function ClaimEditor() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { me, can } = useAuth();
  const editing = Boolean(id);
  const advanceId = params.get('advance');
  const budgetRequestId = params.get('budgetRequest');
  const today = todayLocal();

  const [existing, setExisting] = useState<Claim | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [jobs, setJobs] = useState<{ id: string; number: string; name: string }[]>([]);
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [route, setRoute] = useState<Route | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [header, setHeader] = useState<Header>({ claimDate: today, purpose: '', jobId: '', costCategoryId: '' });
  const [lines, setLines] = useState<Line[]>(() => [blankLine(today)]);
  const [files, setFiles] = useState<File[]>([]);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        let h = header;
        let ls = lines;
        let src: Source | null = null;
        if (id) {
          const row = await api.get<Claim>(`/expense-claims/${id}`);
          if (!live) return;
          setExisting(row);
          const from = row.advance ?? row.budgetRequest;
          if (from) {
            src = {
              kind: row.advance ? 'advance' : 'budgetRequest',
              id: from.id,
              number: from.number,
              amountReleased: from.amountReleased,
              purpose: row.purpose,
              job: row.job,
              costCategory: row.costCategory,
              to: row.advance ? `/g-fin/cash-advances/${from.id}` : `/g-ops/budget-requests/${from.id}`,
            };
          }
          h = { claimDate: row.claimDate.slice(0, 10), purpose: row.purpose, jobId: row.job?.id ?? '', costCategoryId: row.costCategory?.id ?? '' };
          ls = row.lines.length
            ? row.lines.map((l) => ({
                key: newKey(),
                spentOn: l.spentOn.slice(0, 10),
                vendor: l.vendor ?? '',
                receiptNo: l.receiptNo ?? '',
                description: l.description,
                category: l.category ?? '',
                amount: String(l.amount),
              }))
            : [blankLine(today)];
        } else if (advanceId) {
          const a = await api.get<{
            id: string;
            number: string;
            amountReleased: number;
            purpose: string;
            job: Source['job'];
            costCategory: Source['costCategory'];
          }>(`/cash-advances/${advanceId}`);
          src = { kind: 'advance', ...a, to: `/g-fin/cash-advances/${a.id}` };
        } else if (budgetRequestId) {
          const b = await api.get<{
            id: string;
            number: string;
            amountReleased: number;
            reason: string;
            job: { id: string; number: string; name: string } | null;
            costCategory: Source['costCategory'];
          }>(`/budget-requests/${budgetRequestId}`);
          src = {
            kind: 'budgetRequest',
            id: b.id,
            number: b.number,
            amountReleased: b.amountReleased,
            purpose: b.reason,
            // A request on a sales order, quotation or costing names no project (2026-10-26).
            job: b.job ? { id: b.job.id, number: b.job.number, name: b.job.name } : null,
            costCategory: b.costCategory,
            to: `/g-ops/budget-requests/${b.id}`,
          };
        }
        if (src && !id) h = { ...h, purpose: `Liquidation of ${src.number} — ${src.purpose}` };
        if (!src) {
          // Not /jobs/lookup: naming the project you spent money on is not the
          // same right as project-management access, and the filing roles hold none.
          const c = await api
            .get<{ jobs: typeof jobs; categories: typeof categories }>('/expense-claims/chargeable')
            .catch(() => ({ jobs: [], categories: [] }));
          if (!live) return;
          setJobs(c.jobs);
          setCategories(c.categories);
        }
        if (!live) return;
        setSource(src);
        setHeader(h);
        setLines(ls);
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
  }, [id, advanceId, budgetRequestId]);

  const sent = lines.filter((l) => !isBlank(l));
  const totalCents = sent.reduce((s, l) => s + cents(l), 0);
  const total = totalCents / 100;
  const missingReceipts = sent.filter((l) => l.description.trim() && !l.receiptNo.trim()).length;
  const difference = source ? (totalCents - Math.round(source.amountReleased * 100)) / 100 : 0;
  const liquidating = !!source;
  const cashWord = source?.kind === 'advance' ? 'advance' : 'budget request';
  const kindWord = liquidating ? 'liquidation' : 'reimbursement';

  useEffect(() => {
    const timer = window.setTimeout(() => {
      api
        .get<{ route: Route | null }>(`/expense-claims/route${qs({ amount: String(total), claimId: id ?? '' })}`)
        .then((r) => setRoute(r.route))
        .catch(() => setRoute(null));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [total, id]);

  const dirty = (saved !== null && snapshot(header, lines) !== saved) || files.length > 0;
  useUnsavedChanges(dirty && !busy);
  useBackLink(
    existing ? `/g-fin/expenses/${existing.id}` : source ? source.to : null,
    existing ? existing.number : source ? source.number : null,
  );

  const setLine = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const removeLine = (key: string) =>
    setLines((ls) => {
      const rest = ls.filter((l) => l.key !== key);
      return rest.length ? rest : [blankLine(today)];
    });

  const lineProblem = (l: Line): string | null => {
    if (isBlank(l)) return null;
    if (!l.description.trim()) return 'Say what was bought, or what it was for';
    if (!(Number(l.amount) > 0)) return 'The amount must be more than zero';
    if (!l.spentOn) return 'Give the date on the receipt';
    return null;
  };
  const problems: string[] = [];
  if (header.purpose.trim().length < 3) problems.push('Say what it was for');
  if (!source && header.jobId && !header.costCategoryId) problems.push('Choose the budget line');
  if (!sent.length) problems.push('Add at least one receipt');
  sent.forEach((l, i) => {
    const p = lineProblem(l);
    if (p) problems.push(`Line ${i + 1}: ${p}`);
  });

  async function save(submit: boolean) {
    setAttempted(true);
    if (problems.length) return;
    if (submit && missingReceipts > 0) return;
    setBusy(true);
    setError(null);
    const body = {
      claimDate: header.claimDate,
      purpose: header.purpose.trim(),
      advanceId: source?.kind === 'advance' ? source.id : null,
      budgetRequestId: source?.kind === 'budgetRequest' ? source.id : null,
      jobId: source ? source.job?.id ?? null : header.jobId || null,
      costCategoryId: source ? source.costCategory?.id ?? null : header.jobId ? header.costCategoryId || null : null,
      lines: sent.map((l) => ({
        spentOn: l.spentOn,
        description: l.description.trim(),
        category: l.category.trim() || null,
        receiptNo: l.receiptNo.trim() || null,
        vendor: l.vendor.trim() || null,
        amount: cents(l) / 100,
      })),
    };
    try {
      const savedId = existing
        ? (await api.put<{ id: string }>(`/expense-claims/${existing.id}`, body)).id
        : (await api.post<{ id: string }>('/expense-claims', body)).id;
      setSaved(snapshot(header, lines));
      if (files.length) {
        const form = new FormData();
        for (const f of files) form.append('files', f);
        try {
          await api.post(`/attachments/expense_claim/${savedId}`, form);
          setFiles([]);
        } catch {
          toast('error', `Saved, but the attachments could not be filed — add them on the ${kindWord}`);
        }
      }
      if (submit) {
        try {
          await api.post(`/expense-claims/${savedId}/submit`);
          toast('ok', 'Saved and submitted for approval');
        } catch (err) {
          toast('error', `Saved as a draft — not submitted: ${err instanceof Error ? err.message : 'refused'}`);
        }
      } else toast('ok', existing ? `${existing.number} saved` : `${liquidating ? 'Liquidation' : 'Reimbursement'} saved as a draft`);
      navigate(`/g-fin/expenses/${savedId}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  if (!loaded) return error ? <ErrorBox error={error} /> : <Loading />;
  if (editing && !existing) return <ErrorBox error={error ?? new Error('Claim not found')} />;
  if ((advanceId || budgetRequestId) && !source) return <ErrorBox error={error ?? new Error('Nothing to liquidate')} />;
  const own = !existing || existing.claimedBy.id === me?.user.id;
  if (existing) {
    const editAll = !!me?.user.isSuperAdmin || can('gfin.expenses.edit_all');
    const mayEdit = (own && can('gfin.expenses.edit_own')) || editAll;
    if (existing.status !== 'DRAFT' || !mayEdit) {
      return (
        <div className="card">
          <p className="muted">
            {existing.status !== 'DRAFT'
              ? `${existing.number} is ${existing.status.toLowerCase().replace(/_/g, ' ')} and holds still. A pending claim is pulled back to a draft from its page.`
              : 'Only the person who filed this claim, or someone who may edit every claim, can change it.'}
          </p>
        </div>
      );
    }
  }
  // Only the claimant (or a super admin) submits; finance modifying somebody's draft only saves.
  const mine = own || !!me?.user.isSuperAdmin;

  const actions = (
    <>
      <button type="button" className={mine ? 'btn' : 'btn btn-primary'} onClick={() => void save(false)} disabled={busy}>
        {busy ? 'Saving…' : 'Save'}
      </button>
      {mine && (
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void save(true)}
          disabled={busy || missingReceipts > 0}
          title={missingReceipts > 0 ? 'Every line needs a receipt number first' : undefined}
        >
          Submit for approval
        </button>
      )}
    </>
  );
  const title = existing
    ? `Modify ${kindWord} ${existing.number}`
    : source
      ? `Liquidate ${source.number}`
      : 'New reimbursement';

  return (
    <div className="prq">
      <section className="card qe-card prq-head-card" aria-labelledby="cl-heading">
        <div className="qe-head">
          <div>
            <h1 id="cl-heading" className="qe-heading">
              {title}
            </h1>
            <p className="muted qe-lead">
              {source ? (
                <>
                  {formatMoney(source.amountReleased)} was released on <Link to={source.to}>{source.number}</Link>. List every receipt
                  against it — it is charged to{' '}
                  {source.job ? (
                    <>
                      <span className="mono">{source.job.number}</span> · {source.costCategory?.name ?? 'no budget line'}
                    </>
                  ) : (
                    'overheads'
                  )}
                  , the project the {cashWord} was approved for.
                </>
              ) : (
                'Money spent out of your own pocket, paid back by finance once approved. Every line needs the receipt it came from.'
              )}
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
          <section className="card" aria-labelledby="cl-details">
            <h2 id="cl-details" className="card-title">{liquidating ? 'Liquidation details' : 'Reimbursement details'}</h2>
            <div className="qe-header qe-rows prq-rows">
              <Field label="Number">
                <div className="qe-static">{existing ? <span className="mono">{existing.number}</span> : <span className="muted">Given on save</span>}</div>
              </Field>
              <Field label={liquidating ? 'Date of liquidation' : 'Date of claim'}>
                <input type="date" value={header.claimDate} onChange={(e) => setHeader((h) => ({ ...h, claimDate: e.target.value }))} />
              </Field>
              <Field label="What was it for?" required error={attempted && header.purpose.trim().length < 3 ? 'Say what it was for' : null}>
                <input
                  value={header.purpose}
                  maxLength={300}
                  autoFocus={!editing && !source}
                  placeholder="e.g. site visit to the Cebu plant"
                  onChange={(e) => setHeader((h) => ({ ...h, purpose: e.target.value }))}
                />
              </Field>
              {source ? (
                <Field label="Charged to">
                  <div className="qe-static">
                    {source.job ? `${source.job.number} — ${source.job.name} · ${source.costCategory?.name ?? 'no budget line'}` : 'Overheads'}
                  </div>
                </Field>
              ) : (
                <>
                  <Field label="Charge to project" hint="Leave empty if it belongs to overheads">
                    <select value={header.jobId} onChange={(e) => setHeader((h) => ({ ...h, jobId: e.target.value, costCategoryId: e.target.value ? h.costCategoryId : '' }))}>
                      <option value="">— none (overheads) —</option>
                      {existing?.job && !jobs.some((j) => j.id === existing.job?.id) && (
                        <option value={existing.job.id}>
                          {existing.job.number} — {existing.job.name}
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
                    <Field label="Budget line" required hint="Which part of the project's budget this spends" error={attempted && !header.costCategoryId ? 'Choose the budget line' : null}>
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
                </>
              )}
            </div>
          </section>

          <section className="card" aria-labelledby="cl-lines">
            <div className="card-head">
              <h2 id="cl-lines" className="card-title">What was spent</h2>
              <button type="button" className="btn btn-sm" onClick={() => setLines((ls) => [...ls.filter((l) => !isBlank(l)), blankLine(today)])}>
                + Add line
              </button>
            </div>
            <div className="table-wrap qe-table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Date</th>
                    <th>Company / receipt</th>
                    <th>Item / purpose</th>
                    <th className="right">Amount</th>
                    <th aria-label="Remove" />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => {
                    const problem = attempted ? lineProblem(l) : null;
                    const noReceipt = !isBlank(l) && l.description.trim() && !l.receiptNo.trim();
                    return (
                      <tr key={l.key}>
                        <td className="mono">{i + 1}</td>
                        <td>
                          <input type="date" aria-label={`Line ${i + 1} date`} value={l.spentOn} onChange={(e) => setLine(l.key, { spentOn: e.target.value })} />
                        </td>
                        <td>
                          <div className="fin-line-stack">
                            <input aria-label={`Line ${i + 1} company`} value={l.vendor} maxLength={200} placeholder="Company / store" onChange={(e) => setLine(l.key, { vendor: e.target.value })} />
                            <input
                              aria-label={`Line ${i + 1} receipt number`}
                              aria-invalid={(attempted && noReceipt) || undefined}
                              value={l.receiptNo}
                              maxLength={100}
                              placeholder="OR / SI no."
                              onChange={(e) => setLine(l.key, { receiptNo: e.target.value })}
                            />
                          </div>
                        </td>
                        <td>
                          <div className="fin-line-stack">
                            <input
                              aria-label={`Line ${i + 1} item or purpose`}
                              value={l.description}
                              maxLength={500}
                              placeholder="Item bought, or what it was for"
                              onChange={(e) => setLine(l.key, { description: e.target.value })}
                            />
                            <input aria-label={`Line ${i + 1} kind`} value={l.category} maxLength={100} placeholder="Kind: fare, meals, materials…" onChange={(e) => setLine(l.key, { category: e.target.value })} />
                          </div>
                          {problem && <div className="field-error">{problem}</div>}
                        </td>
                        <td>
                          <NumberInput kind="money" min={0} aria-label={`Line ${i + 1} amount`} value={l.amount} onChange={(e) => setLine(l.key, { amount: e.target.value })} />
                        </td>
                        <td>
                          <button type="button" className="btn btn-sm btn-icon" aria-label={`Remove line ${i + 1}`} title="Remove" onClick={() => removeLine(l.key)}>
                            ✕
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {missingReceipts > 0 && (
              <div className="alert warn">
                {missingReceipts} line{missingReceipts === 1 ? ' has' : 's have'} no receipt number. You can save this as a draft, but it cannot
                be submitted until every peso has an OR against it.
              </div>
            )}
          </section>

          <section className="card" aria-labelledby="cl-files">
            <h2 id="cl-files" className="card-title">Attachments</h2>
            <p className="prq-hint">
              The receipts and anything that supports them — photos or scans, PDF or images. They go with the {kindWord}, so whoever checks it
              sees them from the first step.
              {existing ? ' Files already on it stay; add more here or on its page.' : ''}
            </p>
            <input
              type="file"
              multiple
              accept="image/*,application/pdf"
              aria-label="Attach receipts"
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

          <section className="card" aria-labelledby="cl-summary">
            <h2 id="cl-summary" className="card-title">Summary</h2>
            <dl className="prq-total">
              <dt>No. of receipts</dt>
              <dd>{sent.length}</dd>
              {source && (
                <>
                  <dt>Released</dt>
                  <dd className="mono">{formatMoney(source.amountReleased)}</dd>
                </>
              )}
              <dt className="prq-total-big">Total spent</dt>
              <dd className="prq-total-big mono">{formatMoney(total)}</dd>
            </dl>
            {source && total > 0 && (
              <p className="prq-hint">
                {difference > 0.005
                  ? `You spent ${formatMoney(difference)} more than the ${cashWord} — once approved, finance reimburses the excess.`
                  : difference < -0.005
                    ? `${formatMoney(-difference)} of the ${cashWord} was not spent — once approved, return it to finance.`
                    : `The receipts match the ${cashWord} exactly — nothing will be owed either way.`}
              </p>
            )}
          </section>

          <section className="card" aria-labelledby="cl-approval">
            <h2 id="cl-approval" className="card-title">Approval</h2>
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
              <p className="muted">No approval route covers this {kindWord} — Submit for approval will say what is missing.</p>
            )}
            <p className="prq-hint">Filed by {existing?.claimedBy.name ?? 'you'}. Once approved, finance pays it out.</p>
          </section>

          <div className="row qe-foot">{actions}</div>
        </div>
      </div>
    </div>
  );
}
