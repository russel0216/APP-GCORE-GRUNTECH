import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, openPdf, qs } from '../../lib/api';
import { MiniBar, Stat } from '../../components/charts';
import { NumberInput } from '../../components/NumberInput';
import { Empty, ErrorBox, Loading, StatusBadge, formatDate, formatMoney, useToast } from '../../components/ui';
import { useUnsavedChanges } from '../../components/Navigation';

/**
 * G-FIN › Analysis › OPERATIONS BUDGET (2026-10-20, the owner's call: "a
 * separate budget monitoring for office operation, different from the
 * project budget"). The office's budget for a year, per cost category, set
 * here by finance with no approval route; what was spent is read by the API
 * off the expense claims and supplier bills that name NO project (a bill for
 * goods on a purchase order is stock or a project's). A category's row lists
 * the documents behind it.
 */

interface Line {
  costCategory: { id: string; code: string; name: string };
  budget: number;
  notes: string | null;
  spent: number;
  pending: number;
  left: number;
  usedPct: number | null;
  over: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}
interface Doc {
  kind: 'claim' | 'bill';
  id: string;
  number: string;
  date: string;
  party: string;
  what: string;
  category: string | null;
  status: string;
  pending: boolean;
  amount: number;
}
interface Position {
  year: number;
  years: number[];
  lines: Line[];
  uncategorised: { spent: number; pending: number };
  totals: { budget: number; spent: number; pending: number; left: number; usedPct: number | null };
  documents: Doc[];
  canEdit: boolean;
}

export function OperationsBudget() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const year = params.get('year') ?? '';
  const category = params.get('category') ?? '';
  const [data, setData] = useState<Position | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, { amount: string; notes: string }>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.get<Position>(`/operations-budget${qs({ year, costCategoryId: category })}`));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [year, category]);
  useEffect(() => {
    load();
  }, [load]);

  const startEdit = () => {
    if (!data) return;
    setDraft(Object.fromEntries(data.lines.map((l) => [l.costCategory.id, { amount: l.budget ? String(l.budget) : '', notes: l.notes ?? '' }])));
    setEditing(true);
  };
  const dirty =
    editing &&
    !!data &&
    data.lines.some((l) => (Number(draft[l.costCategory.id]?.amount) || 0) !== l.budget || (draft[l.costCategory.id]?.notes ?? '') !== (l.notes ?? ''));
  useUnsavedChanges(dirty && !busy);

  async function save() {
    if (!data) return;
    setBusy(true);
    try {
      await api.put(`/operations-budget/${data.year}`, {
        lines: data.lines.map((l) => ({
          costCategoryId: l.costCategory.id,
          amount: Number(draft[l.costCategory.id]?.amount) || 0,
          notes: draft[l.costCategory.id]?.notes.trim() || null,
        })),
      });
      toast('ok', `Operations budget ${data.year} saved`);
      setEditing(false);
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  if (error && !data) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const peak = Math.max(1, ...data.lines.map((l) => Math.max(l.budget, l.spent + l.pending)));
  const draftTotal = data.lines.reduce((t, l) => t + (Number(draft[l.costCategory.id]?.amount) || 0), 0);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Operations Budget</h1>
        </div>
        <div className="row">
          <select aria-label="Year" value={String(data.year)} disabled={editing} onChange={(e) => setParam('year', e.target.value)}>
            {data.years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          <button type="button" className="btn" onClick={() => openPdf(`/api/operations-budget/pdf${qs({ year: String(data.year) })}`, setError)}>
            Print
          </button>
          {data.canEdit &&
            (editing ? (
              <>
                <button type="button" className="btn" disabled={busy} onClick={() => setEditing(false)}>
                  Cancel
                </button>
                <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>
                  {busy ? 'Saving…' : 'Save'}
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-primary" onClick={startEdit}>
                Modify
              </button>
            ))}
        </div>
      </div>

      <ErrorBox error={error} />

      <div className="stack">
        <div className="kpi-grid">
          <Stat label={`Budget ${data.year}`} value={formatMoney(editing ? draftTotal : data.totals.budget)} figure sub={editing ? 'as typed, not yet saved' : 'office operations, all categories'} />
          <Stat label="Spent" value={formatMoney(data.totals.spent)} figure sub="approved claims and bills naming no project" />
          <Stat label="Pending approval" value={formatMoney(data.totals.pending)} figure accent={data.totals.pending > 0 ? 'warn' : undefined} />
          <Stat
            label="Left"
            value={formatMoney(data.totals.left)}
            figure
            accent={data.totals.left < 0 ? 'danger' : 'ok'}
            sub={data.totals.usedPct == null ? 'no budget set' : `${data.totals.usedPct.toFixed(1)}% used`}
          />
        </div>

        <div className="card">
          <div className="card-head">
            <h3 className="card-title">By cost category</h3>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Cost category</th>
                  <th className="right">Budget</th>
                  <th className="right">Spent</th>
                  <th className="right">Pending</th>
                  <th className="right">Left</th>
                  <th>Used</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((l) => (
                  <tr key={l.costCategory.id}>
                    <td>
                      {editing ? (
                        <>
                          <strong>{l.costCategory.name}</strong>
                          <input
                            aria-label={`Note — ${l.costCategory.name}`}
                            placeholder="What it covers (optional)"
                            value={draft[l.costCategory.id]?.notes ?? ''}
                            maxLength={500}
                            onChange={(e) => setDraft((d) => ({ ...d, [l.costCategory.id]: { ...d[l.costCategory.id], notes: e.target.value } }))}
                          />
                        </>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          aria-pressed={category === l.costCategory.id}
                          onClick={() => setParam('category', category === l.costCategory.id ? '' : l.costCategory.id)}
                        >
                          <strong>{l.costCategory.name}</strong>
                        </button>
                      )}
                      {!editing && l.notes && <div className="faint">{l.notes}</div>}
                    </td>
                    <td className="right mono">
                      {editing ? (
                        <NumberInput
                          kind="money"
                          min={0}
                          aria-label={`Budget — ${l.costCategory.name}`}
                          value={draft[l.costCategory.id]?.amount ?? ''}
                          onChange={(e) => setDraft((d) => ({ ...d, [l.costCategory.id]: { ...d[l.costCategory.id], amount: e.target.value } }))}
                        />
                      ) : l.budget ? (
                        formatMoney(l.budget)
                      ) : (
                        <span className="faint">none set</span>
                      )}
                    </td>
                    <td className="right mono">{formatMoney(l.spent)}</td>
                    <td className="right mono">{l.pending ? formatMoney(l.pending) : <span className="faint">—</span>}</td>
                    <td className="right mono" style={l.over ? { color: 'var(--danger)' } : undefined}>{l.budget ? formatMoney(l.left) : <span className="faint">—</span>}</td>
                    <td>
                      <MiniBar value={l.spent + l.pending} peak={peak} tone={l.over ? 'var(--danger)' : undefined} />
                      <span className="faint">{l.usedPct == null ? (l.spent + l.pending > 0 ? 'unbudgeted' : '') : `${l.usedPct.toFixed(1)}%`}</span>
                    </td>
                  </tr>
                ))}
                {(data.uncategorised.spent > 0 || data.uncategorised.pending > 0) && (
                  <tr>
                    <td>
                      <button type="button" className="btn btn-ghost btn-sm" aria-pressed={category === 'none'} onClick={() => setParam('category', category === 'none' ? '' : 'none')}>
                        <strong>Not categorised</strong>
                      </button>
                      <div className="faint">Claims and bills that name no cost category</div>
                    </td>
                    <td className="right faint">—</td>
                    <td className="right mono">{formatMoney(data.uncategorised.spent)}</td>
                    <td className="right mono">{data.uncategorised.pending ? formatMoney(data.uncategorised.pending) : '—'}</td>
                    <td className="right faint">—</td>
                    <td />
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h3 className="card-title">
              What was spent
              {category && (
                <>
                  {' '}
                  — {category === 'none' ? 'not categorised' : (data.lines.find((l) => l.costCategory.id === category)?.costCategory.name ?? '')}
                </>
              )}
            </h3>
            {category && (
              <button type="button" className="btn btn-sm" onClick={() => setParam('category', '')}>
                Show every category
              </button>
            )}
          </div>
          {data.documents.length === 0 ? (
            <Empty title="Nothing spent yet" hint="Approved expense claims and supplier bills that name no project count here." />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Number</th>
                    <th>From / by</th>
                    <th>Category</th>
                    <th>Status</th>
                    <th className="right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {data.documents.map((d) => (
                    <tr key={`${d.kind}-${d.id}`}>
                      <td>{formatDate(d.date)}</td>
                      <td>
                        <Link className="mono" to={d.kind === 'claim' ? `/g-fin/expenses/${d.id}` : `/g-fin/ap/${d.id}`}>
                          {d.number}
                        </Link>
                        <div className="faint">{d.what}</div>
                      </td>
                      <td>{d.party}</td>
                      <td>{d.category ?? <span className="faint">—</span>}</td>
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
        </div>
      </div>
    </div>
  );
}
