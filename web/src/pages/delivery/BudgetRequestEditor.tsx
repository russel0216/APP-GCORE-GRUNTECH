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
import type { BudgetRequest, RequestSource } from './BudgetRequests';

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
  source: RequestSource;
  job: { id: string; number: string; name: string } | null;
  /** Every budget line a request may name. */
  categories: { id: string; name: string }[];
  /** False where the record carries no budget lines — one "whole cost" row. */
  perLine: boolean;
  lines: BudgetLine[];
  total: { budgeted: number; committed: number; incurred: number; available: number };
}

/** What the cash is for (2026-10-26): a project, a sales order, a quotation or a costing. */
export type SourceKind = 'project' | 'sales_order' | 'quotation' | 'costing';

export const SOURCE_KEY: Record<SourceKind, 'jobId' | 'salesOrderId' | 'quotationId' | 'costingId'> = {
  project: 'jobId',
  sales_order: 'salesOrderId',
  quotation: 'quotationId',
  costing: 'costingId',
};

const SOURCE_CHOICES: { kind: SourceKind; label: string; hint: string }[] = [
  { kind: 'project', label: 'A project', hint: 'Checked against Budget Monitoring' },
  { kind: 'sales_order', label: 'A sales order', hint: 'An issued order — checked against its quoted cost' },
  { kind: 'quotation', label: 'A quotation', hint: 'Open or won — checked against its costing' },
  { kind: 'costing', label: 'A costing', hint: 'A final costing — checked against its budget lines' },
];

interface Header {
  kind: SourceKind;
  sourceId: string;
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
  // Opened from a record: `?jobId=`, `?salesOrderId=`, `?quotationId=` or `?costingId=`.
  const preset = (Object.entries(SOURCE_KEY) as [SourceKind, string][]).find(([, key]) => params.get(key)) ?? null;
  const presetKind = preset?.[0] ?? null;
  const presetId = preset ? params.get(preset[1]) : null;

  const [existing, setExisting] = useState<BudgetRequest | null>(null);
  const [choices, setChoices] = useState<{ id: string; number: string; name: string; sub?: string }[]>([]);
  const [search, setSearch] = useState('');
  const [budget, setBudget] = useState<Budget | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [header, setHeader] = useState<Header>({ kind: presetKind ?? 'project', sourceId: presetId ?? '', costCategoryId: '', reason: '', neededBy: '', notes: '' });
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
          const raised = row.raisedOn ?? row.for;
          h = {
            kind: row.job ? 'project' : (raised?.kind ?? 'project'),
            sourceId: row.job?.id ?? raised?.id ?? '',
            costCategoryId: row.costCategory.id,
            reason: row.reason,
            neededBy: row.neededBy?.slice(0, 10) ?? '',
            notes: row.notes ?? '',
          };
          // A request raised before the breakdown: its amount as one line.
          ls = linesFromItems(row.items, row.reason, row.amount);
          setHeader(h);
          setLines(ls);
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
    if (!header.sourceId) return;
    let live = true;
    api
      .get<Budget>(`/budget-requests/budget${qs({ [SOURCE_KEY[header.kind]]: header.sourceId })}`)
      .then((b) => live && setBudget(b))
      .catch((err) => live && setError(err));
    return () => {
      live = false;
    };
  }, [header.kind, header.sourceId]);

  // What may be picked for the kind chosen (a new request only).
  useEffect(() => {
    if (existing || preset) return;
    let live = true;
    const timer = window.setTimeout(() => {
      const path = header.kind === 'project' ? '/budget-requests/projects' : `/budget-requests/sources${qs({ kind: header.kind, q: search.trim() || undefined })}`;
      api
        .get<typeof choices>(path)
        .then((list) => live && setChoices(list))
        .catch(() => live && setChoices([]));
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [header.kind, search, existing]);

  const sent = lines.filter((l) => !isBlankLine(l));
  const total = useMemo(() => linesTotal(lines), [lines]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      api
        .get<{ route: Route | null }>(
          `/budget-requests/route${qs({ amount: String(total), jobId: header.kind === 'project' ? header.sourceId : '', requestId: id ?? '' })}`,
        )
        .then((r) => setRoute(r.route))
        .catch(() => setRoute(null));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [total, header.kind, header.sourceId, id]);

  const dirty = saved !== null && snapshot(header, lines) !== saved;
  useUnsavedChanges(dirty && !busy);

  const source: RequestSource | null = budget?.source ?? existing?.for ?? null;
  const backTo =
    preset && presetKind === 'project'
      ? `/g-ops/projects/${presetId}?tab=requests`
      : preset && presetKind === 'sales_order'
        ? `/g-ops/sales-orders/${presetId}`
        : preset && presetKind === 'quotation'
          ? `/g-ops/quotations/${presetId}`
          : preset
            ? `/g-ops/costing/${presetId}`
            : null;
  useBackLink(existing ? `/g-ops/budget-requests/${existing.id}` : backTo, existing ? existing.number : source ? source.number : null);
  const kindWord = SOURCE_CHOICES.find((c) => c.kind === header.kind)!;

  const problems: string[] = [];
  if (!header.sourceId) problems.push(`Choose the ${kindWord.label.replace(/^An? /, '')}`);
  if (!header.costCategoryId) problems.push('Choose the budget line');
  if (header.reason.trim().length < 3) problems.push('Say what the cash is for');
  problems.push(...linesProblems(lines));

  async function save(submit: boolean) {
    setAttempted(true);
    if (problems.length) return;
    setBusy(true);
    setError(null);
    const body = {
      [SOURCE_KEY[header.kind]]: header.sourceId,
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

  const perLine = budget?.perLine ?? true;
  const chosen = (perLine ? budget?.lines.find((b) => b.id === header.costCategoryId) : budget?.lines[0]) ?? null;
  const shownLines = (budget?.lines ?? []).filter((b) => !perLine || b.budgeted > 0 || b.id === header.costCategoryId);
  const isChosenLine = (b: BudgetLine) => (perLine ? b.id === header.costCategoryId : true);
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
              {source ? (
                <>
                  For <Link to={source.link}>{source.label}</Link>.{' '}
                </>
              ) : null}
              Cash for the team to buy what it needs without a purchase requisition — released by finance in one voucher once
              approved, and accounted for afterwards with receipts.
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
              {preset || existing ? (
                <Field label="For">
                  <div className="qe-static">{source ? <Link to={source.link}>{source.label}</Link> : '…'}</div>
                </Field>
              ) : (
                <>
                  <Field label="For" required hint={kindWord.hint}>
                    <select
                      value={header.kind}
                      onChange={(e) => {
                        setSearch('');
                        setChoices([]);
                        setHeader((h) => ({ ...h, kind: e.target.value as SourceKind, sourceId: '', costCategoryId: '' }));
                      }}
                    >
                      {SOURCE_CHOICES.map((c) => (
                        <option key={c.kind} value={c.kind}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field
                    label={kindWord.label.replace(/^An? /, '').replace(/^./, (c) => c.toUpperCase())}
                    required
                    hint={header.kind === 'project' ? 'Running projects' : 'Type to search by number, name or customer'}
                    error={attempted && !header.sourceId ? problems[0] : null}
                  >
                    <div className="br-source-pick">
                      {header.kind !== 'project' && (
                        <input type="search" value={search} placeholder="Search…" aria-label="Search" onChange={(e) => setSearch(e.target.value)} />
                      )}
                      <select value={header.sourceId} onChange={(e) => setHeader((h) => ({ ...h, sourceId: e.target.value, costCategoryId: '' }))}>
                        <option value="">— choose —</option>
                        {choices.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.number} — {p.name}
                            {p.sub ? ` · ${p.sub}` : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  </Field>
                </>
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
                  <option value="">{header.sourceId ? '— choose —' : '— choose the record first —'}</option>
                  {(budget?.categories ?? []).map((c, n) => (
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
            <h2 id="br-budget" className="card-title">{header.kind === 'project' ? 'Project budget' : 'Its cost'}</h2>
            <span className="muted prq-source">as it stands</span>
          </div>
          {!header.sourceId ? (
            <p className="muted">Choose what the cash is for to see its budget.</p>
          ) : !budget ? (
            <Loading />
          ) : (
            <>
              <p className="prq-hint">
                {header.kind === 'project'
                  ? 'Released cash shows as committed on its budget line; the liquidation turns what was spent into incurred.'
                  : header.kind === 'sales_order'
                    ? "The order's quoted cost, less what its purchasing and other budget requests already hold."
                    : perLine
                      ? 'The costing\u2019s cost per budget line, less the cash other budget requests on it hold. A project built from it takes this request over.'
                      : 'The quotation has no costing — its lines\u2019 whole cost, less the cash other budget requests on it hold.'}
              </p>
              {shownLines.length === 0 && <p className="muted">No cost on its budget lines yet.</p>}
              {shownLines.map((b) => {
                const isChosen = isChosenLine(b);
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
