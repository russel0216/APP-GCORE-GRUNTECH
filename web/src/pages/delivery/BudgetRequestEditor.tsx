import { useEffect, useMemo, useState } from 'react';
import { OfficeLineAdvice, OfficeLineSelect, useOfficeLines } from '../../components/OfficeLine';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
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
import { NO_CHARGE, chargeKey, type LineCharge } from '../../components/LineCharge';

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
export type SourceKind = 'project' | 'sales_order' | 'quotation' | 'costing' | 'office';

export const SOURCE_KEY: Record<SourceKind, 'jobId' | 'salesOrderId' | 'quotationId' | 'costingId' | 'officeBudgetLineId'> = {
  project: 'jobId',
  sales_order: 'salesOrderId',
  quotation: 'quotationId',
  costing: 'costingId',
  // An office expense (2026-11-10): the source IS the office budget line.
  office: 'officeBudgetLineId',
};

const SOURCE_CHOICES: { kind: SourceKind; label: string; hint: string }[] = [
  { kind: 'project', label: 'A project', hint: 'Checked against Budget Monitoring' },
  { kind: 'sales_order', label: 'A sales order', hint: 'An issued order — checked against its quoted cost' },
  { kind: 'quotation', label: 'A quotation', hint: 'Open or won — checked against its costing' },
  { kind: 'costing', label: 'A costing', hint: 'A final costing — checked against its budget lines' },
  { kind: 'office', label: 'An office budget', hint: 'An office expense — charged to a line of the Office Budget' },
];

interface Header {
  kind: SourceKind;
  sourceId: string;
  costCategoryId: string;
  reason: string;
  neededBy: string;
  notes: string;
  /** The journey of a TRAVEL request (2026-11-10). */
  travelMode: 'SHIPPING' | 'LAND' | 'AIR';
  travelFrom: string;
  travelTo: string;
  departOn: string;
  returnOn: string;
  travellers: string;
  carrier: string;
}

const NO_JOURNEY = { travelMode: 'AIR' as const, travelFrom: '', travelTo: '', departOn: '', returnOn: '', travellers: '', carrier: '' };
const TRAVEL_MODES: [Header['travelMode'], string][] = [
  ['AIR', 'Air flight'],
  ['SHIPPING', 'Shipping line'],
  ['LAND', 'Land transportation'],
];

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
  const [files, setFiles] = useState<File[]>([]);
  const [header, setHeader] = useState<Header>({ kind: presetKind ?? 'project', sourceId: presetId ?? '', costCategoryId: '', reason: '', neededBy: '', notes: '', ...NO_JOURNEY });
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
            kind: row.job ? 'project' : row.split ? 'project' : (raised?.kind ?? 'project'),
            sourceId: row.job?.id ?? raised?.id ?? '',
            costCategoryId: row.costCategory.id,
            reason: row.reason,
            neededBy: row.neededBy?.slice(0, 10) ?? '',
            notes: row.notes ?? '',
            travelMode: row.travelMode ?? 'AIR',
            travelFrom: row.travelFrom ?? '',
            travelTo: row.travelTo ?? '',
            departOn: row.departOn?.slice(0, 10) ?? '',
            returnOn: row.returnOn?.slice(0, 10) ?? '',
            travellers: row.travellers ?? '',
            carrier: row.carrier ?? '',
          };
          // A request raised before the breakdown: its amount as one line.
          ls = linesFromItems(row.items, row.reason, row.amount, !!row.split);
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

  const officeBudgets = useOfficeLines();
  // Where an item may be charged (2026-11-11): the running projects and every budget line.
  const [placeJobs, setPlaceJobs] = useState<{ id: string; number: string; name: string }[]>([]);
  const [placeCategories, setPlaceCategories] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    let live = true;
    api.get<typeof placeJobs>('/budget-requests/projects').then((j) => live && setPlaceJobs(j)).catch(() => {});
    api.get<typeof placeCategories>('/reference/cost-categories').then((c) => live && setPlaceCategories(c)).catch(() => {});
    return () => {
      live = false;
    };
  }, []);

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
    if (existing || preset || header.kind === 'office') return;
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

  // A travel request: opened as one (`?kind=travel`), or the draft is one.
  const onTravelPath = useLocation().pathname.includes('/travel-requests/');
  const travel = existing ? !!existing.isTravel : params.get('kind') === 'travel' || onTravelPath;
  const word = travel ? 'travel request' : 'budget request';
  const sent = lines.filter((l) => !isBlankLine(l));
  const total = useMemo(() => linesTotal(lines), [lines]);
  // Each item's place (2026-11-11): a project's or the office's request may
  // spread its items over several projects and office lines; the request's
  // own place is every item's default. A request on a record, and a travel
  // request, are charged whole.
  const perItem = !travel && (header.kind === 'project' || header.kind === 'office');
  const headerCharge: LineCharge =
    header.kind === 'project' && header.sourceId
      ? { jobId: header.sourceId, costCategoryId: header.costCategoryId, officeBudgetLineId: '' }
      : header.kind === 'office' && header.sourceId
        ? { jobId: '', costCategoryId: '', officeBudgetLineId: header.sourceId }
        : NO_CHARGE;
  const placeOf = (l: (typeof lines)[number]): LineCharge => l.charge ?? headerCharge;
  const itemPlaces = new Set(sent.map((l) => chargeKey(placeOf(l))));
  const chargedJobIds = perItem
    ? [...new Set(sent.map((l) => placeOf(l).jobId).filter(Boolean))]
    : header.kind === 'project' && header.sourceId
      ? [header.sourceId]
      : [];

  useEffect(() => {
    const timer = window.setTimeout(() => {
      api
        .get<{ route: Route | null }>(
          `/budget-requests/route${qs({ amount: String(total), jobId: header.kind === 'project' ? header.sourceId : '', jobIds: chargedJobIds.join(','), requestId: id ?? '', travel: travel ? '1' : '' })}`,
        )
        .then((r) => setRoute(r.route))
        .catch(() => setRoute(null));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [total, header.kind, header.sourceId, id, chargedJobIds.join(',')]);

  const dirty = saved !== null && (snapshot(header, lines) !== saved || files.length > 0);
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
  const office = header.kind === 'office';
  // Every item naming its own place, the request needs none of its own.
  const headerNeeded = !perItem || sent.some((l) => !l.charge);
  if (headerNeeded && !header.sourceId) problems.push(office ? 'Choose the office budget line' : `Choose the ${kindWord.label.replace(/^An? /, '')}`);
  if (headerNeeded && !office && !header.costCategoryId) problems.push('Choose the budget line');
  if (perItem) {
    sent.forEach((l, i) => {
      const c = placeOf(l);
      if (c.jobId && !c.costCategoryId) problems.push(`Line ${i + 1}: choose the project's budget line`);
    });
  }
  if (header.reason.trim().length < 3) problems.push(travel ? 'Say what the trip is for' : 'Say what the cash is for');
  if (travel) {
    if (header.travelFrom.trim().length < 2) problems.push('Say where the trip starts');
    if (header.travelTo.trim().length < 2) problems.push('Say where it goes');
    if (!header.departOn) problems.push('Give the departure date');
    if (header.returnOn && header.departOn && header.returnOn < header.departOn) problems.push('The return is before the departure');
  }
  problems.push(...linesProblems(lines));

  async function save(submit: boolean) {
    setAttempted(true);
    if (problems.length) return;
    setBusy(true);
    setError(null);
    const body = {
      [SOURCE_KEY[header.kind]]: header.sourceId || null,
      costCategoryId: office ? null : header.costCategoryId || null,
      reason: header.reason.trim(),
      neededBy: header.neededBy || null,
      notes: header.notes.trim() || null,
      items: linesPayload(lines, perItem ? placeOf : undefined),
      ...(travel
        ? {
            travel: {
              mode: header.travelMode,
              from: header.travelFrom.trim(),
              to: header.travelTo.trim(),
              departOn: header.departOn,
              returnOn: header.returnOn || null,
              travellers: header.travellers.trim() || null,
              carrier: header.carrier.trim() || null,
            },
          }
        : {}),
    };
    try {
      const savedId = existing
        ? (await api.put<{ id: string }>(`/budget-requests/${existing.id}`, body)).id
        : (await api.post<{ id: string }>('/budget-requests', body)).id;
      setSaved(snapshot(header, lines));
      // Filed before a submit, so the approvers see them from the first step.
      if (files.length) {
        const form = new FormData();
        for (const f of files) form.append('files', f);
        try {
          await api.post(`/attachments/budget_request/${savedId}`, form);
          setFiles([]);
        } catch {
          toast('error', 'Saved, but the attachments could not be filed — add them on the budget request');
        }
      }
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
  // An office request's line is its source; a record's is the cost category chosen.
  const lineKey = office ? header.sourceId : header.costCategoryId;
  const chosen = (perLine ? budget?.lines.find((b) => b.id === lineKey) : budget?.lines[0]) ?? null;
  const isChosenLine = (b: BudgetLine) => (perLine ? b.id === lineKey : true);
  // Over its office line: the lines of the same budget that could take it whole.
  const officeRoom =
    office && chosen && chosen.available - total < -0.004
      ? (budget?.lines ?? []).filter((b) => b.id !== chosen.id && b.available >= total).sort((a, b) => b.available - a.available).slice(0, 4)
      : [];
  const shownLines = office
    ? (budget?.lines ?? []).filter((b) => b.id === lineKey || officeRoom.some((r) => r.id === b.id))
    : (budget?.lines ?? []).filter((b) => !perLine || b.budgeted > 0 || b.id === header.costCategoryId);
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
              {existing ? `Modify ${word} ${existing.number}` : `New ${word}`}
            </h1>
            <p className="muted qe-lead">
              {source ? (
                <>
                  For <Link to={source.link}>{source.label}</Link>.{' '}
                </>
              ) : null}
              {travel
                ? 'A ticket, a fare or a shipping-line booking. Once approved, finance either books and pays it directly (the company card) — nothing to liquidate — or releases the cash to you, accounted for afterwards with receipts.'
                : 'Cash for the team to buy what it needs without a purchase requisition — released by finance in one voucher once approved, and accounted for afterwards with receipts.'}
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
            <h2 id="br-details" className="card-title">{travel ? 'Travel request details' : 'Budget request details'}</h2>
            <div className="qe-header qe-rows prq-rows">
              <Field label="Number">
                <div className="qe-static">{existing ? <span className="mono">{existing.number}</span> : <span className="muted">Given on save</span>}</div>
              </Field>
              {office && !preset ? (
                <>
                  <Field label="For" required={!existing} hint={kindWord.hint}>
                    {existing ? (
                      <div className="qe-static">An office budget</div>
                    ) : (
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
                    )}
                  </Field>
                  <Field
                    label="Office budget line"
                    required
                    hint={<OfficeLineAdvice budgets={officeBudgets} value={header.sourceId} amount={total} onPick={(lineId) => setHeader((h) => ({ ...h, sourceId: lineId }))} />}
                    error={attempted && !header.sourceId ? 'Choose the office budget line' : null}
                  >
                    <OfficeLineSelect
                      budgets={officeBudgets}
                      value={header.sourceId}
                      current={existing?.officeBudgetLine}
                      none="— choose —"
                      onChange={(lineId) => setHeader((h) => ({ ...h, sourceId: lineId }))}
                    />
                  </Field>
                </>
              ) : preset || existing ? (
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
              {!office && (
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
              )}
              {travel && (
                <>
                  <Field label="Travel by" required>
                    <select value={header.travelMode} onChange={(e) => setHeader((h) => ({ ...h, travelMode: e.target.value as Header['travelMode'] }))}>
                      {TRAVEL_MODES.map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="From" required error={attempted && header.travelFrom.trim().length < 2 ? 'Say where the trip starts' : null}>
                    <input value={header.travelFrom} maxLength={200} placeholder="e.g. Manila" onChange={(e) => setHeader((h) => ({ ...h, travelFrom: e.target.value }))} />
                  </Field>
                  <Field label="To" required error={attempted && header.travelTo.trim().length < 2 ? 'Say where it goes' : null}>
                    <input value={header.travelTo} maxLength={200} placeholder="e.g. Cebu" onChange={(e) => setHeader((h) => ({ ...h, travelTo: e.target.value }))} />
                  </Field>
                  <Field label="Departure" required error={attempted && !header.departOn ? 'Give the departure date' : null}>
                    <input type="date" value={header.departOn} onChange={(e) => setHeader((h) => ({ ...h, departOn: e.target.value }))} />
                  </Field>
                  <Field label="Return" hint="Blank for one way" error={attempted && header.returnOn && header.returnOn < header.departOn ? 'Before the departure' : null}>
                    <input type="date" value={header.returnOn} min={header.departOn || undefined} onChange={(e) => setHeader((h) => ({ ...h, returnOn: e.target.value }))} />
                  </Field>
                  <Field label="Carrier" hint="The airline, shipping line or bus / van operator, if known">
                    <input value={header.carrier} maxLength={200} onChange={(e) => setHeader((h) => ({ ...h, carrier: e.target.value }))} />
                  </Field>
                  <Field label="Travellers / cargo" hint="Who is travelling, or what is being shipped">
                    <input value={header.travellers} maxLength={1000} onChange={(e) => setHeader((h) => ({ ...h, travellers: e.target.value }))} />
                  </Field>
                </>
              )}
              <Field label="Needed by" hint={travel ? 'When the booking has to be made' : 'When the team needs the cash in hand'}>
                <input type="date" value={header.neededBy} onChange={(e) => setHeader((h) => ({ ...h, neededBy: e.target.value }))} />
              </Field>
              <Field label={travel ? 'What is the trip for?' : 'What is the cash for?'} required error={attempted && header.reason.trim().length < 3 ? (travel ? 'Say what the trip is for' : 'Say what the cash is for') : null}>
                <input
                  value={header.reason}
                  maxLength={300}
                  autoFocus={!editing}
                  placeholder={travel ? 'e.g. site survey at the Mactan plant' : 'e.g. consumables and fittings for the Batangas tie-in'}
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
            charging={
              perItem
                ? {
                    choices: {
                      jobs: placeJobs,
                      categories: placeCategories,
                      officeBudgets,
                      kept: (existing?.items ?? []).flatMap((x) => [
                        ...(x.job ? [{ value: `p:${x.job.id}`, label: `${x.job.number} — ${x.job.name}` }] : []),
                        ...(x.officeBudgetLine ? [{ value: `o:${x.officeBudgetLine.id}`, label: `${x.officeBudgetLine.code} ${x.officeBudgetLine.name} (closed)` }] : []),
                      ]),
                    },
                    placeOf,
                    isDefault: (l) => !l.charge && !!header.sourceId,
                    required: !header.sourceId,
                  }
                : undefined
            }
            hint={
              travel
                ? 'The fare, fees, baggage, freight — the amount requested is the sum of the lines.'
                : perItem
                  ? `The amount requested is the sum of the lines. Each line is charged to the request's own place unless you change it — one request can spread over several projects and office lines${itemPlaces.size > 1 ? ` (this one: ${itemPlaces.size} places)` : ''}. Receipts for what is actually spent are filed in the liquidation.`
                  : 'The amount requested is the sum of the lines. Receipts for what is actually spent are filed in the liquidation.'
            }
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

          <section className="card" aria-labelledby="br-files">
            <h2 id="br-files" className="card-title">Attachments</h2>
            <p className="prq-hint">
              Quotations, a breakdown or anything that supports the request — they go with it, so the approvers see them.
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
            <h2 id="br-budget" className="card-title">{header.kind === 'project' ? 'Project budget' : office ? 'Office budget' : 'Its cost'}</h2>
            <span className="muted prq-source">as it stands</span>
          </div>
          {!header.sourceId ? (
            <p className="muted">Choose what the cash is for to see its budget.</p>
          ) : !budget ? (
            <Loading />
          ) : (
            <>
              <p className="prq-hint">
                {office
                  ? 'What is left on the line: its budget less the cash out and the actual to date. Released, this request is cash out on the line; its liquidation turns what was spent into actual.'
                  : header.kind === 'project'
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
                      <span>
                        {isChosen ? (
                          `this request ${formatMoney(total)}`
                        ) : office ? (
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setHeader((h) => ({ ...h, sourceId: b.id }))}>
                            Charge this line instead
                          </button>
                        ) : (
                          'not touched'
                        )}
                      </span>
                      <span>{left < 0 ? 'over by ' + formatMoney(-left) : isChosen ? 'left once spent' : 'available'}</span>
                    </div>
                  </div>
                );
              })}
              {chosen && chosen.available - total < -0.004 && (
                <div className="alert warn">
                  More than is left on {chosen.name} — the approvers will see it.
                  {office && (officeRoom.length ? ' The lines above still have room for it.' : ' No other line of this budget has room for it.')}
                </div>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
