import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, openPdf, qs } from '../../lib/api';
import { MiniBar, Stat } from '../../components/charts';
import { NumberInput } from '../../components/NumberInput';
import { useConfirm } from '../../components/Confirm';
import { Empty, ErrorBox, Field, Loading, Modal, ModalFoot, StatusBadge, formatDate, formatMoney, useToast } from '../../components/ui';
import { useUnsavedChanges } from '../../components/Navigation';

/**
 * G-FIN › Analysis › OFFICE BUDGET (2026-11-10, the owner's call, his two
 * Builk monitors as the sample; it replaced the Operations Budget). A year
 * holds any number of named budgets, each a list of coded lines.
 * Reimbursements, budget requests, cash advances and supplier bills with no
 * purchase order charge a line; the monitor reads them — requested, cash
 * out, actual, remaining — and never stores a figure but the budget and the
 * opening actual. Whoever may edit the page creates, copies and changes
 * budgets.
 */

interface Totals {
  budget: number;
  requested: number;
  released: number;
  actual: number;
  remaining: number;
  usedPct?: number | null;
  over?: number;
}
interface BudgetRow {
  id: string;
  year: number;
  name: string;
  isActive: boolean;
  lineCount: number;
  total: Totals;
}
interface YearView {
  year: number;
  years: number[];
  budgets: BudgetRow[];
  total: Totals;
  canEdit: boolean;
}
interface Line {
  id: string;
  code: string;
  name: string;
  notes: string | null;
  isActive: boolean;
  budget: number;
  openingActual: number;
  requested: number;
  released: number;
  actual: number;
  remaining: number;
  usedPct: number | null;
  over: boolean;
  documents: number;
}
interface Doc {
  kind: 'reimbursement' | 'liquidation' | 'bill' | 'budget_request' | 'cash_advance';
  id: string;
  number: string;
  status: string;
  amount: number;
  date: string;
  what: string;
  who: string;
  line: string;
  link: string;
}
interface BudgetView {
  budget: { id: string; year: number; name: string; notes: string | null; isActive: boolean };
  lines: Line[];
  total: Totals;
  documents: Doc[];
  documentCount: number;
  canEdit: boolean;
}

const KIND_WORDS: Record<Doc['kind'], string> = {
  reimbursement: 'Reimbursement',
  liquidation: 'Liquidation',
  bill: 'Supplier bill',
  budget_request: 'Budget request',
  cash_advance: 'Cash advance',
};

interface DraftLine {
  id?: string;
  key: string;
  code: string;
  name: string;
  amount: string;
  openingActual: string;
  notes: string;
  isActive: boolean;
  documents: number;
}
interface Draft {
  name: string;
  notes: string;
  isActive: boolean;
  lines: DraftLine[];
}

let fresh = 0;
const newKey = () => `new-${++fresh}`;

export function OfficeBudgets() {
  const toast = useToast();
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();
  const year = params.get('year') ?? '';
  const budgetId = params.get('budget') ?? '';
  const lineId = params.get('line') ?? '';
  const [list, setList] = useState<YearView | null>(null);
  const [view, setView] = useState<BudgetView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  const setParam = useCallback(
    (changes: Record<string, string>) => {
      const next = new URLSearchParams(params);
      for (const [k, v] of Object.entries(changes)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  const loadList = useCallback(async () => {
    try {
      setList(await api.get<YearView>(`/office-budgets${qs({ year })}`));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [year]);
  useEffect(() => {
    loadList();
  }, [loadList]);

  // The budget shown: the one the URL names (whatever its year), else the year's first.
  const shownId = budgetId || list?.budgets[0]?.id || '';
  const loadView = useCallback(async () => {
    if (!shownId) {
      setView(null);
      return;
    }
    try {
      setView(await api.get<BudgetView>(`/office-budgets/${shownId}${qs({ lineId })}`));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [shownId, lineId]);
  useEffect(() => {
    loadView();
  }, [loadView]);

  const editing = !!draft;
  const dirty = editing && JSON.stringify(draft) !== saved;
  useUnsavedChanges(dirty && !busy);

  function startEdit() {
    if (!view) return;
    const d: Draft = {
      name: view.budget.name,
      notes: view.budget.notes ?? '',
      isActive: view.budget.isActive,
      lines: view.lines
        .filter((l) => l.isActive || l.documents === 0)
        .map((l) => ({
          id: l.id,
          key: l.id,
          code: l.code,
          name: l.name,
          amount: l.budget ? String(l.budget) : '',
          openingActual: l.openingActual ? String(l.openingActual) : '',
          notes: l.notes ?? '',
          isActive: l.isActive,
          documents: l.documents,
        })),
    };
    setDraft(d);
    setSaved(JSON.stringify(d));
  }
  const setLine = (key: string, patch: Partial<DraftLine>) => setDraft((d) => (d ? { ...d, lines: d.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) } : d));

  async function save() {
    if (!view || !draft) return;
    setBusy(true);
    try {
      const res = await api.put<{ closed: string[] }>(`/office-budgets/${view.budget.id}`, {
        name: draft.name,
        notes: draft.notes.trim() || null,
        isActive: draft.isActive,
        lines: draft.lines.map((l) => ({
          id: l.id,
          code: l.code.trim(),
          name: l.name.trim(),
          amount: Number(l.amount) || 0,
          openingActual: Number(l.openingActual) || 0,
          notes: l.notes.trim() || null,
          isActive: l.isActive,
        })),
      });
      toast('ok', res.closed.length ? `Saved — ${res.closed.join(', ')} closed, not removed: documents charge them` : `${draft.name} saved`);
      setDraft(null);
      await Promise.all([loadList(), loadView()]);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  function remove() {
    if (!view) return;
    confirm.ask({
      title: `Delete ${view.budget.name}?`,
      body: 'Only a budget nothing was charged to can be deleted. One in use is closed instead (untick “Open for charging” on Modify).',
      confirmLabel: 'Delete',
      tone: 'danger',
      onConfirm: async () => {
        await api.del(`/office-budgets/${view.budget.id}`);
        toast('ok', `${view.budget.name} deleted`);
        setDraft(null);
        setParam({ budget: '', line: '' });
        await loadList();
      },
    });
  }

  if (error && !list) return <ErrorBox error={error} />;
  if (!list) return <Loading />;
  const lines = view?.lines ?? [];
  const draftTotal = draft ? draft.lines.reduce((t, l) => t + (l.isActive ? Number(l.amount) || 0 : 0), 0) : 0;
  const pickedLine = lines.find((l) => l.id === lineId) ?? null;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Office Budget</h1>
        </div>
        <div className="row">
          <select aria-label="Year" value={String(list.year)} disabled={editing} onChange={(e) => setParam({ year: e.target.value, budget: '', line: '' })}>
            {list.years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          {list.canEdit && !editing && (
            <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
              + New budget
            </button>
          )}
        </div>
      </div>

      <ErrorBox error={error} />
      {confirm.bar}

      <div className="stack">
        {list.budgets.length === 0 ? (
          <div className="card">
            <Empty
              title={`No office budget for ${list.year} yet`}
              hint={list.canEdit ? 'Start one with “+ New budget” — blank, or copied from another year’s lines.' : 'Whoever maintains the office budgets has not set one up for this year.'}
            />
          </div>
        ) : (
          <div className="card">
            <div className="card-head">
              <h3 className="card-title">Budgets of {list.year}</h3>
            </div>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Budget</th>
                    <th className="right">Budget</th>
                    <th className="right">Requested</th>
                    <th className="right">Cash out</th>
                    <th className="right">Actual</th>
                    <th className="right">Remaining</th>
                    <th>Used</th>
                  </tr>
                </thead>
                <tbody>
                  {list.budgets.map((b) => (
                    <tr key={b.id}>
                      <td>
                        <button type="button" className="btn btn-ghost btn-sm" aria-pressed={b.id === shownId} disabled={editing} onClick={() => setParam({ budget: b.id, line: '' })}>
                          <strong>{b.name}</strong>
                        </button>
                        <div className="faint">
                          {b.lineCount} line{b.lineCount === 1 ? '' : 's'}
                          {!b.isActive && ' · closed'}
                          {b.total.over ? ` · ${b.total.over} over budget` : ''}
                        </div>
                      </td>
                      <td className="right mono">{formatMoney(b.total.budget)}</td>
                      <td className="right mono faint">{b.total.requested ? formatMoney(b.total.requested) : '—'}</td>
                      <td className="right mono">{b.total.released ? formatMoney(b.total.released) : '—'}</td>
                      <td className="right mono">{formatMoney(b.total.actual)}</td>
                      <td className={`right mono${b.total.remaining < 0 ? ' del-danger' : ''}`}>
                        <strong>{formatMoney(b.total.remaining)}</strong>
                      </td>
                      <td>{b.total.usedPct == null ? <span className="faint">—</span> : `${b.total.usedPct.toFixed(1)}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {view && (
          <>
            <div className="kpi-grid">
              <Stat
                label="Budget"
                value={formatMoney(editing ? draftTotal : view.total.budget)}
                figure
                sub={editing ? 'as typed, not yet saved' : view.budget.name}
              />
              <Stat label="Actual" value={formatMoney(view.total.actual)} figure sub="opening actual and approved documents" />
              <Stat
                label="Cash out"
                value={formatMoney(view.total.released)}
                figure
                sub={view.total.requested ? `${formatMoney(view.total.requested)} more waiting for approval` : 'released, not yet accounted for'}
                accent={view.total.released > 0 ? 'warn' : undefined}
              />
              <Stat
                label="Remaining"
                value={formatMoney(view.total.remaining)}
                figure
                accent={view.total.remaining < 0 ? 'danger' : 'ok'}
                sub={`${view.total.usedPct == null ? 'no budget set' : `${view.total.usedPct.toFixed(1)}% used`}${view.total.over ? ` · ${view.total.over} line${view.total.over === 1 ? '' : 's'} over` : ''}`}
              />
            </div>

            <div className="card">
              <div className="card-head">
                <h3 className="card-title">
                  {view.budget.name}
                  {!view.budget.isActive && ' — closed'}
                </h3>
                <div className="row">
                  {!editing && (
                    <button type="button" className="btn btn-sm" onClick={() => openPdf(`/api/office-budgets/${view.budget.id}/pdf`, setError)}>
                      Print
                    </button>
                  )}
                  {view.canEdit &&
                    (editing ? (
                      <>
                        <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={remove}>
                          Delete
                        </button>
                        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setDraft(null)}>
                          Cancel
                        </button>
                        <button type="button" className="btn btn-sm btn-primary" disabled={busy || !dirty} onClick={save}>
                          {busy ? 'Saving…' : 'Save'}
                        </button>
                      </>
                    ) : (
                      <button type="button" className="btn btn-sm btn-primary" onClick={startEdit}>
                        Modify
                      </button>
                    ))}
                </div>
              </div>

              {editing && draft ? (
                <>
                  <div className="grid-2">
                    <Field label="Budget name" required>
                      <input value={draft.name} maxLength={120} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                    </Field>
                    <Field label="Notes">
                      <input value={draft.notes} maxLength={1000} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
                    </Field>
                  </div>
                  <label className="row">
                    <input type="checkbox" checked={draft.isActive} onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })} />
                    Open for charging — untick to close the whole budget (its figures stay)
                  </label>
                  <div className="table-wrap">
                    <table className="data">
                      <thead>
                        <tr>
                          <th>Code</th>
                          <th>Budget line</th>
                          <th className="right">Budget</th>
                          <th className="right">Opening actual</th>
                          <th>Note</th>
                          <th>Open</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {draft.lines.map((l) => (
                          <tr key={l.key}>
                            <td>
                              <input className="ob-code" aria-label="Code" value={l.code} maxLength={20} onChange={(e) => setLine(l.key, { code: e.target.value })} />
                            </td>
                            <td>
                              <input aria-label={`Name — ${l.code}`} value={l.name} maxLength={200} onChange={(e) => setLine(l.key, { name: e.target.value })} />
                            </td>
                            <td className="right">
                              <NumberInput kind="money" min={0} aria-label={`Budget — ${l.code}`} value={l.amount} onChange={(e) => setLine(l.key, { amount: e.target.value })} />
                            </td>
                            <td className="right">
                              <NumberInput
                                kind="money"
                                min={0}
                                aria-label={`Opening actual — ${l.code}`}
                                value={l.openingActual}
                                onChange={(e) => setLine(l.key, { openingActual: e.target.value })}
                              />
                            </td>
                            <td>
                              <input aria-label={`Note — ${l.code}`} value={l.notes} maxLength={500} onChange={(e) => setLine(l.key, { notes: e.target.value })} />
                            </td>
                            <td>
                              <input type="checkbox" aria-label={`Open — ${l.code}`} checked={l.isActive} onChange={(e) => setLine(l.key, { isActive: e.target.checked })} />
                            </td>
                            <td>
                              <button
                                type="button"
                                className="btn btn-sm"
                                title={l.documents ? 'Documents charge this line — it is closed, not removed' : undefined}
                                onClick={() => setDraft({ ...draft, lines: draft.lines.filter((x) => x.key !== l.key) })}
                              >
                                {l.documents ? 'Close' : 'Remove'}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="card-foot">
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() =>
                        setDraft({ ...draft, lines: [...draft.lines, { key: newKey(), code: '', name: '', amount: '', openingActual: '', notes: '', isActive: true, documents: 0 }] })
                      }
                    >
                      + Add line
                    </button>
                    <span className="muted">Opening actual is what was already spent before G-CORE kept the documents; it is added to the line’s actual.</span>
                  </div>
                </>
              ) : (
                <>
                  {view.budget.notes && <p className="muted">{view.budget.notes}</p>}
                  <div className="table-wrap">
                    <table className="data">
                      <thead>
                        <tr>
                          <th>Code</th>
                          <th>Budget line</th>
                          <th className="right">Budget</th>
                          <th className="right">Requested</th>
                          <th className="right">Cash out</th>
                          <th className="right">Actual</th>
                          <th className="right">Remaining</th>
                          <th>Used</th>
                        </tr>
                      </thead>
                      <tbody>
                        {lines.map((l) => (
                          <tr key={l.id}>
                            <td className="mono">{l.code}</td>
                            <td>
                              <button type="button" className="btn btn-ghost btn-sm" aria-pressed={lineId === l.id} onClick={() => setParam({ budget: view.budget.id, line: lineId === l.id ? '' : l.id })}>
                                <strong>{l.name}</strong>
                              </button>
                              {(l.notes || !l.isActive) && <div className="faint">{[!l.isActive && 'closed', l.notes].filter(Boolean).join(' — ')}</div>}
                            </td>
                            <td className="right mono">{l.budget ? formatMoney(l.budget) : <span className="faint">none set</span>}</td>
                            <td className="right mono faint">{l.requested ? formatMoney(l.requested) : '—'}</td>
                            <td className="right mono">{l.released ? formatMoney(l.released) : <span className="faint">—</span>}</td>
                            <td className="right mono">{formatMoney(l.actual)}</td>
                            <td className={`right mono${l.over ? ' del-danger' : ''}`}>
                              <strong>{formatMoney(l.remaining)}</strong>
                            </td>
                            <td>
                              <MiniBar value={l.actual + l.released} peak={Math.max(l.budget, l.actual + l.released, 1)} tone={l.over ? 'var(--danger)' : undefined} />
                              <span className="faint">{l.usedPct == null ? (l.actual + l.released > 0 ? 'unbudgeted' : '') : `${l.usedPct.toFixed(1)}%`}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="muted">
                    Remaining = budget − cash out − actual. Requested is still waiting for approval or release — shown, not subtracted. Actual is the opening actual plus approved
                    reimbursements, liquidations and supplier bills (before VAT).
                  </p>
                </>
              )}
            </div>

            {!editing && (
              <div className="card">
                <div className="card-head">
                  <h3 className="card-title">Charged to {pickedLine ? `${pickedLine.code} ${pickedLine.name}` : 'this budget'}</h3>
                  {pickedLine && (
                    <button type="button" className="btn btn-sm" onClick={() => setParam({ line: '' })}>
                      Show every line
                    </button>
                  )}
                </div>
                {view.documents.length === 0 ? (
                  <Empty title="Nothing charged yet" hint="A reimbursement, budget request, cash advance or supplier bill that names a line of this budget is listed here once submitted." />
                ) : (
                  <div className="table-wrap">
                    <table className="data">
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Number</th>
                          <th>Kind</th>
                          <th>From / by</th>
                          <th>Budget line</th>
                          <th>Status</th>
                          <th className="right">Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {view.documents.map((d) => (
                          <tr key={`${d.kind}-${d.id}`}>
                            <td>{formatDate(d.date)}</td>
                            <td>
                              <Link className="mono" to={d.link}>
                                {d.number}
                              </Link>
                              <div className="faint">{d.what}</div>
                            </td>
                            <td>{KIND_WORDS[d.kind]}</td>
                            <td>{d.who}</td>
                            <td>{d.line}</td>
                            <td>
                              <StatusBadge status={d.status} />
                            </td>
                            <td className="right mono">{formatMoney(d.amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {view.documentCount > view.documents.length && <p className="muted">The newest {view.documents.length} of {view.documentCount} shown — pick a line to narrow them.</p>}
              </div>
            )}
          </>
        )}
      </div>

      {adding && (
        <NewBudgetModal
          year={list.year}
          years={list.years}
          onClose={() => setAdding(false)}
          onCreated={async (id, y) => {
            setAdding(false);
            setParam({ year: String(y), budget: id, line: '' });
            await loadList();
          }}
        />
      )}
    </div>
  );
}

/** "+ New budget": a name and a year, blank or copied from another budget's lines (the amounts kept, the actuals at zero). */
function NewBudgetModal({ year, years, onClose, onCreated }: { year: number; years: number[]; onClose: () => void; onCreated: (id: string, year: number) => void }) {
  const [name, setName] = useState('');
  const [forYear, setForYear] = useState(String(year));
  const [copyFrom, setCopyFrom] = useState('');
  const [sources, setSources] = useState<BudgetRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // What may be copied: every budget of the years on file.
  useEffect(() => {
    let live = true;
    Promise.all(years.map((y) => api.get<YearView>(`/office-budgets${qs({ year: String(y) })}`).catch(() => null))).then((all) => {
      if (live) setSources(all.flatMap((v) => v?.budgets ?? []));
    });
    return () => {
      live = false;
    };
  }, [years]);

  async function create() {
    setBusy(true);
    try {
      const made = await api.post<{ id: string }>('/office-budgets', { year: Number(forYear), name: name.trim(), copyFromId: copyFrom || null });
      onCreated(made.id, Number(forYear));
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New office budget"
      onClose={onClose}
      dirty={!!name}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button type="button" className="btn btn-primary" disabled={busy || name.trim().length < 2} onClick={create}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      <Field label="Budget name" required hint="As it is called — “2027 GRUNTECH YEARLY BUDGET”.">
        <input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
      </Field>
      <div className="grid-2">
        <Field label="Year" required>
          <select value={forYear} onChange={(e) => setForYear(e.target.value)}>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Start from" hint="Copying takes the lines and their amounts; the actuals start at zero.">
          <select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
            <option value="">A blank budget</option>
            {sources.map((b) => (
              <option key={b.id} value={b.id}>
                {b.year} — {b.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </Modal>
  );
}
